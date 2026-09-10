/**
 * Tests for the refresh_okf_projections tool core + the debounced scheduler
 * (volet ② — v0.59.0).
 *
 * The core is exercised through injected deps over an in-memory vault; the
 * scheduler through mock timers. The last suite pins the cross-module marker
 * contract: the bundle exporter carries an INLINED copy of the projection
 * marker (import cycle), so a behavioural test — not a comment — is what
 * keeps the two copies from drifting.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  refreshProjectionsForVault,
  refreshOkfProjectionsTool,
  TOOL_DEFINITION,
} from '../src/tools/refresh-okf-projections.mjs';
import {
  createProjectionsScheduler,
  pathsTouchedByWrite,
  DEFAULT_DEBOUNCE_MS,
} from '../src/helpers/projections-refresh.mjs';
import {
  buildProjections,
  projectionMarkerLine,
  PROJECTION_MARKER,
} from '../src/helpers/okf-projections.mjs';
import { buildOkfBundle } from '../src/helpers/okf-bundle-exporter.mjs';

import fs2 from 'node:fs';
// C9 (v0.68.0): buildOkfBundle requires the export-gate inputs — they are not
// optional, so the OKF exit can never run without the gate. See
// tests/okf-bundle-exporter.test.mjs for the full reasoning.
const GATE = {
  gateContract: JSON.parse(fs2.readFileSync(new URL('../contracts/export-allowlist.json', import.meta.url), 'utf8')),
  gatePrivatePathRoots: [],
};

const VAULT = { name: 'test-vault' };

/** In-memory vault: Map path → content, with rest-shaped deps + write log. */
function makeVaultFs(files = {}) {
  const store = new Map(Object.entries(files));
  const writes = [];
  const deletes = [];
  const deps = {
    listFilesIn: async (_v, dir) => {
      const prefix = dir ? `${dir}/` : '';
      const names = new Set();
      for (const p of store.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
      }
      if (names.size === 0 && dir !== '') throw new Error('404');
      return { files: [...names].sort() };
    },
    getFileContent: async (_v, p) => {
      if (!store.has(p)) throw Object.assign(new Error('404'), { kind: 'not_found' });
      return store.get(p);
    },
    writeFile: async (_v, p, content) => { store.set(p, content); writes.push(p); },
    deleteFile: async (_v, p) => { store.delete(p); deletes.push(p); },
  };
  return { store, writes, deletes, deps };
}

const PAGE = (title, extra = '') =>
  `---\ntype: note\ntitle: "${title}"\ndescription: "Desc ${title}"\ncreated: 2026-07-01\n${extra}---\n\nCorps.\n`;

describe('refreshProjectionsForVault', () => {
  test('virgin wiki → writes root index, per-dir indexes, log', async () => {
    const { deps, writes, store } = makeVaultFs({
      'wiki/a/page-un.md': PAGE('Page un'),
      'wiki/a/b/page-deux.md': PAGE('Page deux'),
      'wiki/racine.md': PAGE('Racine'),
    });
    const r = await refreshProjectionsForVault(VAULT, deps, { now: '2026-07-30' });
    assert.equal(r.upToDate, false);
    assert.deepEqual([...writes].sort(), [
      'wiki/a/b/index.md', 'wiki/a/index.md', 'wiki/index.md', 'wiki/log.md',
    ]);
    assert.match(store.get('wiki/index.md'), /okf_version: '0\.1'/);
    assert.match(store.get('wiki/a/index.md'), /\[Page un\]\(page-un\.md\)/);
    assert.match(store.get('wiki/log.md'), /## 2026-07-01/);
    assert.deepEqual(r.conflicts, []);
  });

  test('second run over the same tree is a no-op (upToDate)', async () => {
    const { deps, writes } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    await refreshProjectionsForVault(VAULT, deps, { now: '2026-07-30' });
    const before = writes.length;
    const r = await refreshProjectionsForVault(VAULT, deps, { now: '2026-07-30' });
    assert.equal(r.upToDate, true);
    assert.equal(writes.length, before, 'no rewrite of identical content');
    assert.equal(r.unchanged, 3);
  });

  test('check mode reports the plan and writes nothing', async () => {
    const { deps, writes } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const r = await refreshProjectionsForVault(VAULT, deps, { check: true, now: '2026-07-30' });
    assert.equal(r.mode, 'check');
    assert.equal(r.written.length, 3);
    assert.deepEqual(writes, []);
  });

  test('a stale MARKED index (directory emptied) is deleted', async () => {
    const { deps, deletes } = makeVaultFs({
      'wiki/a/p.md': PAGE('P'),
      'wiki/vieux/index.md': `# Vieux\n\n${projectionMarkerLine()}\n`,
    });
    const r = await refreshProjectionsForVault(VAULT, deps, { now: '2026-07-30' });
    assert.deepEqual(r.deleted, ['wiki/vieux/index.md']);
    assert.deepEqual(deletes, ['wiki/vieux/index.md']);
  });

  test('an UNMARKED homonym is a conflict — never overwritten, never deleted', async () => {
    const handWritten = '# Mon index\n\nÉcrit main.\n';
    const { deps, store } = makeVaultFs({
      'wiki/a/p.md': PAGE('P'),
      'wiki/a/index.md': handWritten,
    });
    const r = await refreshProjectionsForVault(VAULT, deps, { now: '2026-07-30' });
    assert.deepEqual(r.conflicts, ['wiki/a/index.md']);
    assert.equal(store.get('wiki/a/index.md'), handWritten);
  });

  test('requireInitialized: absent root (true 404) → skipped, untouched', async () => {
    const { deps, writes } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const r = await refreshProjectionsForVault(VAULT, deps, {
      requireInitialized: true, now: '2026-07-30',
    });
    assert.equal(r.skipped, 'not-initialized');
    assert.deepEqual(writes, []);
  });

  test('requireInitialized: an OFFLINE vault throws instead of masquerading as not-initialized', async () => {
    // review v0.59.0 N2: mapping ECONNREFUSED onto 'not-initialized' made the
    // skip perfectly silent; it must reach the scheduler's logError instead.
    const { deps } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    deps.getFileContent = async () => {
      throw Object.assign(new Error('ECONNREFUSED'), { kind: 'unreachable' });
    };
    await assert.rejects(
      () => refreshProjectionsForVault(VAULT, deps, { requireInitialized: true, now: '2026-07-30' }),
      /ECONNREFUSED/,
    );
  });

  test('requireInitialized: UNMARKED root → skipped (conflict state, no churn)', async () => {
    const { deps, writes } = makeVaultFs({
      'wiki/index.md': '# Index écrit main\n',
      'wiki/a/p.md': PAGE('P'),
    });
    const r = await refreshProjectionsForVault(VAULT, deps, {
      requireInitialized: true, now: '2026-07-30',
    });
    assert.equal(r.skipped, 'root-index-unmarked');
    assert.deepEqual(writes, []);
  });

  test('requireInitialized: MARKED root → refresh proceeds', async () => {
    const { deps, writes } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    await refreshProjectionsForVault(VAULT, deps, { now: '2026-07-30' }); // init
    // Add a page → the gated refresh (the middleware path) must now act.
    await deps.writeFile(VAULT, 'wiki/a/nouvelle.md', PAGE('Nouvelle'));
    const before = writes.length;
    const r = await refreshProjectionsForVault(VAULT, deps, {
      requireInitialized: true, now: '2026-07-30',
    });
    assert.equal(r.skipped, undefined);
    assert.ok(writes.length > before, 'the gated refresh rewrote the changed indexes');
  });

  test('FAIL CLOSED: a content-page read failure aborts the refresh entirely', async () => {
    // codex review P2: a partial `pages` array would silently drop entries
    // from every index and the log. A transient REST failure must mean
    // "no refresh", never "wrong refresh".
    const { deps, writes } = makeVaultFs({
      'wiki/a/ok.md': PAGE('OK'),
      'wiki/a/cassee.md': PAGE('Cassée'),
    });
    const realGet = deps.getFileContent;
    deps.getFileContent = async (v, p) => {
      if (p === 'wiki/a/cassee.md') throw new Error('EBUSY');
      return realGet(v, p);
    };
    const r = await refreshProjectionsForVault(VAULT, deps, { now: '2026-07-30' });
    assert.equal(r.skipped, 'page-reads-failed');
    assert.deepEqual(writes, [], 'nothing may be written from a partial tree');
  });

  test('FAIL CLOSED: an unreadable file AT a projection path aborts (conflict shield)', async () => {
    // codex review P1: unreadable → absent from `current` → planned as a
    // fresh write → an unreadable UNMARKED homonym would be destroyed.
    const { deps, writes } = makeVaultFs({
      'wiki/a/p.md': PAGE('P'),
      'wiki/a/index.md': '# écrit main, illisible au moment T\n',
    });
    const realGet = deps.getFileContent;
    deps.getFileContent = async (v, p) => {
      if (p === 'wiki/a/index.md') throw new Error('EBUSY');
      return realGet(v, p);
    };
    const r = await refreshProjectionsForVault(VAULT, deps, { now: '2026-07-30' });
    assert.equal(r.skipped, 'projection-reads-failed');
    assert.deepEqual(writes, []);
  });

  // ---------------------------------------------------------------------------
  // Check O — two folders named "Sessions" — through the tool (v0.92.0).
  //
  // The rule is `helpers/session-folder-collision.mjs`'s and has its own tests;
  // what is tested HERE is the wiring: the wiki/ half comes from the refresh's
  // own snapshot (so the marker verdict is the planner's), the wiki-meta/ half
  // from one extra listing, the scan is fail-closed, it never touches the C3
  // seal, and the automatic callers never pay for it.
  // ---------------------------------------------------------------------------

  const META = { 'wiki-meta/catalog.md': '# Catalog\n' };

  test('Check O: content on both sides → session-folder-collision in check mode', async () => {
    const { deps, writes } = makeVaultFs({
      ...META,
      'wiki/Sessions/2026-09-07-recap.md': PAGE('Recap'),
      'wiki-meta/Sessions/2026-09-07-0930-x.md': '---\ntype: session\n---\n# S\n',
    });
    const r = await refreshProjectionsForVault(VAULT, deps, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.equal(r.sessions.skipped, null);
    assert.equal(r.sessions.findings.length, 1);
    const [f] = r.sessions.findings;
    assert.equal(f.rule, 'session-folder-collision');
    assert.equal(f.severity, 'error');
    assert.deepEqual(f.wikiFiles, ['wiki/Sessions/2026-09-07-recap.md']);
    assert.deepEqual(f.metaFiles, ['wiki-meta/Sessions/2026-09-07-0930-x.md']);
    assert.deepEqual(r.sessions.metaDirs, ['wiki-meta/Sessions']);
    assert.deepEqual(writes, [], 'check mode still writes nothing');
  });

  test('Check O: a MARKED wiki/Sessions/index.md is excluded — the verdict is the planner\'s bytes', async () => {
    const { deps } = makeVaultFs({
      ...META,
      'wiki/Sessions/index.md': `# Sessions\n\n${projectionMarkerLine()}\n`,
      'wiki-meta/Sessions/x.md': '# S\n',
    });
    const r = await refreshProjectionsForVault(VAULT, deps, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.deepEqual(r.sessions.findings, []);
  });

  test('Check O: an UNMARKED wiki/Sessions/index.md is BOTH a conflict and session content', async () => {
    // A conflict needs a generated index to collide WITH, so the directory
    // must hold a content page; with the page there, the planner wants to write
    // `wiki/Sessions/index.md`, finds a hand-written one, and reports it —
    // while the scan counts that same file as session content. Same bytes,
    // two verdicts, both right.
    const { deps } = makeVaultFs({
      ...META,
      'wiki/a/p.md': PAGE('P'),
      'wiki/Sessions/recap.md': PAGE('Recap'),
      'wiki/Sessions/index.md': '# Mes sessions\n\nÉcrit main.\n',
      'wiki-meta/Sessions/x.md': '# S\n',
    });
    const r = await refreshProjectionsForVault(VAULT, deps, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.ok(r.conflicts.includes('wiki/Sessions/index.md'), `the planner's word: ${JSON.stringify(r.conflicts)}`);
    assert.equal(r.sessions.findings[0]?.rule, 'session-folder-collision', 'and the scan\'s');
    assert.deepEqual(r.sessions.findings[0].wikiFiles, ['wiki/Sessions/index.md', 'wiki/Sessions/recap.md']);
  });

  test('Check O: an UNMARKED index.md in a dir with NO content pages is still session content', async () => {
    // No generated index is planned for an empty directory, so there is no
    // conflict to report — but the hand-written file is content all the same,
    // and the scan must not inherit the planner's silence.
    const { deps } = makeVaultFs({
      ...META,
      'wiki/a/p.md': PAGE('P'),
      'wiki/Sessions/index.md': '# Mes sessions\n\nÉcrit main.\n',
      'wiki-meta/Sessions/x.md': '# S\n',
    });
    const r = await refreshProjectionsForVault(VAULT, deps, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.deepEqual(r.conflicts, [], 'nothing generated for that dir → nothing to conflict with');
    assert.equal(r.sessions.findings[0]?.rule, 'session-folder-collision');
    assert.deepEqual(r.sessions.findings[0].wikiFiles, ['wiki/Sessions/index.md']);
  });

  test('Check O: wiki/ side only → stray; wiki-meta/ side only → nothing', async () => {
    const stray = makeVaultFs({ ...META, 'wiki/sessions/old.md': PAGE('Old') });
    const rs = await refreshProjectionsForVault(VAULT, stray.deps, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.equal(rs.sessions.findings[0]?.rule, 'session-folder-stray');
    assert.equal(rs.sessions.findings[0]?.severity, 'warning');

    const clean = makeVaultFs({ ...META, 'wiki/a/p.md': PAGE('P'), 'wiki-meta/Sessions/x.md': '# S\n' });
    const rc = await refreshProjectionsForVault(VAULT, clean.deps, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.deepEqual(rc.sessions.findings, []);
    assert.deepEqual(rc.sessions.metaDirs, ['wiki-meta/Sessions']);
  });

  test('Check O: a vault with no wiki-meta/ at all is clean, not skipped', async () => {
    const { deps } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const listFilesIn = async (v, dir) => {
      if (dir === 'wiki-meta') throw Object.assign(new Error('404'), { kind: 'not_found' });
      return deps.listFilesIn(v, dir);
    };
    const r = await refreshProjectionsForVault(VAULT, { ...deps, listFilesIn }, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.deepEqual(r.sessions, { findings: [], skipped: null, metaDirs: [] });
  });

  test('Check O: FAIL CLOSED — a wiki-meta/ listing that ERRORS is skipped, never "no collision"', async () => {
    const { deps } = makeVaultFs({
      ...META,
      'wiki/Sessions/recap.md': PAGE('Recap'),
      'wiki-meta/Sessions/x.md': '# S\n',
    });
    const listFilesIn = async (v, dir) => {
      if (dir === 'wiki-meta') throw new Error('500 upstream');
      return deps.listFilesIn(v, dir);
    };
    const r = await refreshProjectionsForVault(VAULT, { ...deps, listFilesIn }, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.equal(r.sessions.skipped, 'enumeration-failed');
    assert.deepEqual(r.sessions.findings, [], 'a stray verdict here would be a lie: the wiki-meta side was never seen');
    // And the projections part of the call is unaffected.
    assert.equal(r.mode, 'check');
  });

  test('Check O: a failing walk INSIDE wiki-meta/Sessions/ is skipped too', async () => {
    const { deps } = makeVaultFs({
      ...META,
      'wiki/Sessions/recap.md': PAGE('Recap'),
      'wiki-meta/Sessions/x.md': '# S\n',
    });
    const listFilesIn = async (v, dir) => {
      if (dir === 'wiki-meta/Sessions') throw new Error('timeout');
      return deps.listFilesIn(v, dir);
    };
    const r = await refreshProjectionsForVault(VAULT, { ...deps, listFilesIn }, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.equal(r.sessions.skipped, 'enumeration-failed');
  });

  test('Check O: OFF by default — the automatic callers see no sessions block and no extra listing', async () => {
    const { deps } = makeVaultFs({ ...META, 'wiki/Sessions/recap.md': PAGE('Recap'), 'wiki-meta/Sessions/x.md': '# S\n' });
    const dirs = [];
    const listFilesIn = async (v, dir) => { dirs.push(dir); return deps.listFilesIn(v, dir); };
    const r = await refreshProjectionsForVault(VAULT, { ...deps, listFilesIn }, { check: true, now: '2026-09-07' });
    assert.equal('sessions' in r, false);
    assert.ok(!dirs.includes('wiki-meta'), `wiki-meta was listed: ${dirs.join(', ')}`);
  });

  test('Check O: the scan never enters the C3 seal — a check seal still verifies on apply', async () => {
    const { deps } = makeVaultFs({
      ...META,
      'wiki/a/p.md': PAGE('P'),
      'wiki/Sessions/recap.md': PAGE('Recap'),
      'wiki-meta/Sessions/x.md': '# S\n',
    });
    const checked = await refreshProjectionsForVault(VAULT, deps, { check: true, sessionScan: true, now: '2026-07-30' });
    assert.equal(checked.sessions.findings.length, 1);
    const applied = await refreshProjectionsForVault(VAULT, deps, {
      approvedPlanSha256: checked.approvedPlanSha256, sessionScan: true, now: '2026-07-30',
    });
    assert.equal(applied.mode, 'apply');
    assert.equal(applied.sessions.findings.length, 1, 'apply reports it too');
    // The seal is identical with and without the scan.
    const unscanned = await refreshProjectionsForVault(VAULT, makeVaultFs({
      ...META, 'wiki/a/p.md': PAGE('P'), 'wiki/Sessions/recap.md': PAGE('Recap'), 'wiki-meta/Sessions/x.md': '# S\n',
    }).deps, { check: true, now: '2026-07-30' });
    assert.equal(unscanned.approvedPlanSha256, checked.approvedPlanSha256);
  });

  test('Check O: the tool wrapper turns the scan ON', async () => {
    const { deps } = makeVaultFs({ ...META, 'wiki/Sessions/recap.md': PAGE('Recap'), 'wiki-meta/Sessions/x.md': '# S\n' });
    const registry = { resolveVault: () => VAULT };
    const r = await refreshOkfProjectionsTool(registry, { check: true }, { ...deps, now: '2026-09-07' });
    assert.equal(r.sessions?.findings?.[0]?.rule, 'session-folder-collision');
  });

  // ---------------------------------------------------------------------------
  // Check O, the CATALOGUE half — the signpost, not the misplaced file.
  //
  // A `## Sessions` area in the catalogue is what SENT the agent to the wrong
  // folder. It is reportable in vaults where the folder scan finds nothing at
  // all, which is precisely the state that reads as clean today.
  // ---------------------------------------------------------------------------

  const CATALOG_WITH_AREA = '---\ntype: wiki-index\n---\n\n# Catalog\n\n## Sessions\n\n_(none yet)_\n';

  test('Check O: a ## Sessions AREA is reported even when no file is misfiled', async () => {
    const { deps } = makeVaultFs({
      'wiki-meta/catalog.md': CATALOG_WITH_AREA,
      'wiki/a/p.md': PAGE('P'),
      'wiki-meta/Sessions/x.md': '# S\n',
    });
    const r = await refreshProjectionsForVault(VAULT, deps, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.equal(r.sessions.skipped, null);
    assert.equal(r.sessions.findings.length, 1, 'the folder scan alone would call this vault clean');
    const [f] = r.sessions.findings;
    assert.equal(f.rule, 'catalog-sessions-heading');
    assert.equal(f.severity, 'warning');
    assert.equal(f.area, 'Sessions');
    assert.equal(f.line, 7);
    assert.equal(f.file, 'wiki-meta/catalog.md', 'the finding names the file it was read from');
  });

  test('Check O: the catalogue is read under its LEGACY name when catalog.md is a 404', async () => {
    const { deps } = makeVaultFs({
      'wiki-meta/index.md': CATALOG_WITH_AREA,
      'wiki/a/p.md': PAGE('P'),
    });
    const r = await refreshProjectionsForVault(VAULT, deps, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.equal(r.sessions.findings[0]?.rule, 'catalog-sessions-heading');
    assert.equal(r.sessions.findings[0]?.file, 'wiki-meta/index.md');
  });

  test('Check O: a vault with no catalogue at all says nothing about headings', async () => {
    // The wiki-meta/ LISTING is made to 404 properly (`kind: 'not_found'`) so
    // this test isolates the catalogue read: without that, the harness's bare
    // `new Error('404')` would trip the enumeration branch instead and the test
    // would pass for a reason that has nothing to do with the catalogue.
    const { deps } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const listFilesIn = async (v, dir) => {
      if (dir === 'wiki-meta') throw Object.assign(new Error('404'), { kind: 'not_found' });
      return deps.listFilesIn(v, dir);
    };
    const r = await refreshProjectionsForVault(VAULT, { ...deps, listFilesIn }, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.deepEqual(r.sessions.findings, []);
    assert.equal(r.sessions.skipped, null, 'a 404 on both names is a fact about the vault, not a failure');
  });

  test('Check O: FAIL CLOSED — a catalogue read that ERRORS is skipped, and the folder verdict survives', async () => {
    // The two halves answer different questions, so an unread catalogue must not
    // erase a collision that WAS established. `skipped` says the heading half is
    // unanswered; the findings say what the folder half found.
    const { deps } = makeVaultFs({
      'wiki-meta/catalog.md': CATALOG_WITH_AREA,
      'wiki/Sessions/recap.md': PAGE('Recap'),
      'wiki-meta/Sessions/x.md': '# S\n',
    });
    const getFileContent = async (v, p) => {
      if (p === 'wiki-meta/catalog.md') throw new Error('500 upstream');
      return deps.getFileContent(v, p);
    };
    const r = await refreshProjectionsForVault(VAULT, { ...deps, getFileContent }, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.equal(r.sessions.skipped, 'catalog-read-failed');
    assert.equal(r.sessions.findings.length, 1, 'the collision was seen and must still be reported');
    assert.equal(r.sessions.findings[0].rule, 'session-folder-collision');
  });

  test('Check O: a non-404 on catalog.md does NOT fall through to the legacy name', async () => {
    // Same rule `shouldTryLegacyScaffold` states: only "not under this name"
    // tries the next candidate. An unreachable vault must not be re-asked under
    // the old name and reported clean because the old name happens to be absent.
    const { deps } = makeVaultFs({
      'wiki-meta/catalog.md': CATALOG_WITH_AREA,
      'wiki-meta/index.md': '# Catalog\n',
      'wiki/a/p.md': PAGE('P'),
    });
    const asked = [];
    const getFileContent = async (v, p) => {
      if (p === 'wiki-meta/catalog.md') throw new Error('timeout');
      asked.push(p);
      return deps.getFileContent(v, p);
    };
    const r = await refreshProjectionsForVault(VAULT, { ...deps, getFileContent }, { check: true, sessionScan: true, now: '2026-09-07' });
    assert.equal(r.sessions.skipped, 'catalog-read-failed');
    assert.ok(!asked.includes('wiki-meta/index.md'), 'the legacy name was asked after a non-404');
  });

  test('Check O: OFF by default — the catalogue is never READ for the automatic callers', async () => {
    const { deps } = makeVaultFs({ 'wiki-meta/catalog.md': CATALOG_WITH_AREA, 'wiki/a/p.md': PAGE('P') });
    const asked = [];
    const getFileContent = async (v, p) => { asked.push(p); return deps.getFileContent(v, p); };
    const r = await refreshProjectionsForVault(VAULT, { ...deps, getFileContent }, { check: true, now: '2026-09-07' });
    assert.equal('sessions' in r, false);
    assert.ok(!asked.includes('wiki-meta/catalog.md'), `the catalogue was read: ${asked.join(', ')}`);
  });

  // These two were ONE test with an "and" in its name, and the mutation harness
  // said so: dropping the block in apply and leaking the finding into the seal
  // produced the SAME red set, so nothing separated the two questions. Split, so
  // each mutation has a witness only it can kill.
  const HEADING_VAULT = {
    'wiki-meta/catalog.md': CATALOG_WITH_AREA,
    'wiki/a/p.md': PAGE('P'),
  };

  test('Check O: apply mode reports the heading too, not only check', async () => {
    const { deps } = makeVaultFs({ ...HEADING_VAULT });
    const checked = await refreshProjectionsForVault(VAULT, deps, { check: true, sessionScan: true, now: '2026-07-30' });
    assert.equal(checked.sessions.findings.length, 1);
    const applied = await refreshProjectionsForVault(VAULT, deps, {
      approvedPlanSha256: checked.approvedPlanSha256, sessionScan: true, now: '2026-07-30',
    });
    assert.equal(applied.mode, 'apply');
    assert.equal(applied.sessions?.findings?.[0]?.rule, 'catalog-sessions-heading');
  });

  test('Check O: a heading finding never enters the C3 seal', async () => {
    // A catalogue WITH the area and one WITHOUT must seal identically: the
    // finding changes no write, so a check taken on either must verify on the
    // apply that follows.
    const withArea = await refreshProjectionsForVault(VAULT, makeVaultFs({ ...HEADING_VAULT }).deps, { check: true, sessionScan: true, now: '2026-07-30' });
    const without = await refreshProjectionsForVault(VAULT, makeVaultFs({ ...HEADING_VAULT, 'wiki-meta/catalog.md': '# Catalog\n' }).deps, { check: true, sessionScan: true, now: '2026-07-30' });
    assert.equal(withArea.sessions.findings.length, 1, 'control: the area really is seen');
    assert.equal(without.sessions.findings.length, 0, 'control: the clean catalogue really is clean');
    // Assert the seals EXIST before comparing them: an implementation that
    // stopped returning `approvedPlanSha256` would otherwise satisfy this test
    // with `undefined === undefined`, a witness proving nothing. `typeof` is
    // checked directly rather than through `String(seal)`, which review round 2
    // pointed out would also accept a BigInt. (Rounds 1 and 2.)
    for (const [label, seal] of [['withArea', withArea.approvedPlanSha256], ['without', without.approvedPlanSha256]]) {
      assert.equal(typeof seal, 'string', `${label} must carry a plan seal`);
      assert.match(seal, /^[0-9a-f]{64}$/, `${label}'s seal must be a sha256`);
    }
    assert.equal(withArea.approvedPlanSha256, without.approvedPlanSha256);

    // ...and a CONTROL proving the seal is sensitive to the plan at all — the
    // equality above is satisfied by any constant, so without this a seal hard-
    // coded to 64 zeroes would pass the whole test. A vault with a different
    // page set must seal differently.
    const otherPlan = await refreshProjectionsForVault(VAULT, makeVaultFs({
      ...HEADING_VAULT, 'wiki/a/q.md': PAGE('Q'),
    }).deps, { check: true, sessionScan: true, now: '2026-07-30' });
    assert.notEqual(otherPlan.approvedPlanSha256, withArea.approvedPlanSha256, 'the seal must track the plan');
  });

  test('tool wrapper resolves the vault through the registry', async () => {
    const { deps } = makeVaultFs({ 'wiki/a/p.md': PAGE('P') });
    const registry = { resolveVault: (n) => ({ name: n ?? 'default-vault' }) };
    const r = await refreshOkfProjectionsTool(registry, { check: true }, { ...deps, now: '2026-07-30' });
    assert.equal(r.vault, 'default-vault');
    assert.equal(r.mode, 'check');
  });

  test('tool definition: registered name + check arg + no required args', () => {
    assert.equal(TOOL_DEFINITION.name, 'refresh_okf_projections');
    assert.deepEqual(TOOL_DEFINITION.inputSchema.required, []);
    assert.ok(TOOL_DEFINITION.inputSchema.properties.check);
  });
});

describe('projections scheduler (debounce)', () => {
  let calls;
  let timers;
  const fakeTimers = () => {
    const pending = [];
    return {
      pending,
      set: (fn, ms) => { const t = { fn, ms, cleared: false }; pending.push(t); return t; },
      clear: (t) => { if (t) t.cleared = true; },
      fire: async () => {
        for (const t of pending.splice(0)) if (!t.cleared) await t.fn();
      },
    };
  };

  beforeEach(() => { calls = []; timers = fakeTimers(); });

  const makeScheduler = (over = {}) => createProjectionsScheduler({
    refresh: async (vault) => { calls.push(vault.name); },
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    logError: () => {},
    ...over,
  });

  test('a wiki content write schedules ONE refresh; a burst coalesces', async () => {
    const s = makeScheduler();
    assert.equal(s.noteWrite(VAULT, 'write_file', { path: 'wiki/a/p1.md' }), true);
    assert.equal(s.noteWrite(VAULT, 'write_file', { path: 'wiki/a/p2.md' }), true);
    assert.equal(s.noteWrite(VAULT, 'patch_file', { path: 'wiki/a/p3.md' }), true);
    await timers.fire();
    assert.deepEqual(calls, ['test-vault'], 'three writes → one refresh');
  });

  test('non-wiki writes and projection writes never schedule', () => {
    const s = makeScheduler();
    assert.equal(s.noteWrite(VAULT, 'write_file', { path: 'wiki-meta/hot.md' }), false);
    assert.equal(s.noteWrite(VAULT, 'write_file', { path: 'notes/x.md' }), false);
    assert.equal(s.noteWrite(VAULT, 'write_file', { path: 'wiki/index.md' }), false);
    assert.equal(s.noteWrite(VAULT, 'write_file', { path: 'wiki/a/index.md' }), false);
    assert.equal(s.noteWrite(VAULT, 'refresh_okf_projections', {}), false);
    assert.deepEqual(s.pending(), []);
  });

  test('two vaults debounce independently', async () => {
    const s = makeScheduler();
    s.noteWrite({ name: 'v1' }, 'write_file', { path: 'wiki/a.md' });
    s.noteWrite({ name: 'v2' }, 'write_file', { path: 'wiki/b.md' });
    assert.deepEqual(s.pending().sort(), ['v1', 'v2']);
    await timers.fire();
    assert.deepEqual(calls.sort(), ['v1', 'v2']);
  });

  test('a refresh that throws is swallowed and logged, never rethrown', async () => {
    const errors = [];
    const s = createProjectionsScheduler({
      refresh: async () => { throw new Error('boom'); },
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
      logError: (m) => errors.push(m),
    });
    s.noteWrite(VAULT, 'write_file', { path: 'wiki/a.md' });
    await timers.fire();
    await new Promise((r) => setImmediate(r)); // let the .catch run
    assert.equal(errors.length, 1);
    // The flush now runs the whole maintenance pass (projections + BM25 index),
    // so the message names the pass rather than one half of it.
    assert.match(errors[0], /vault maintenance failed/);
  });

  test('pathsTouchedByWrite maps every write tool to its path args', () => {
    // ORDER IS NOT MEANINGFUL to a debounced scheduler — the list is a set of
    // things to notice, and every entry coalesces into the same per-vault
    // timer. It is compared as a set here because the ordering now comes from
    // the shared `writeTargets` rule, which orders by AUDIT priority
    // (`move_file` is audited at its destination).
    const touched = (t, a) => pathsTouchedByWrite(t, a).slice().sort();
    assert.deepEqual(touched('write_file', { path: 'wiki/a.md' }), ['wiki/a.md']);
    assert.deepEqual(touched('delete_file', { path: 'wiki/a.md' }), ['wiki/a.md']);
    assert.deepEqual(
      touched('move_file', { from: 'wiki/a.md', to: 'archives/a.md' }),
      ['archives/a.md', 'wiki/a.md'],
    );
    assert.deepEqual(pathsTouchedByWrite('build_wiki_graph', {}), []);
    assert.deepEqual(pathsTouchedByWrite('write_file', {}), []);
  });

  // THE RULE THE SECOND CONSUMER NEVER RECEIVED.
  //
  // `pickAuditPath` learned all three of these two rounds before this function
  // did, and this function kept its own older copy of the rule. Factored onto
  // `helpers/write-targets.mjs` rather than fixed again in place — a copy is
  // how it drifted the first time.
  test('a bundle write schedules a refresh, and two non-writes no longer do', () => {
    // 1. THE FUNCTIONAL BUG. `write_bundle` carries its targets in `steps[]`,
    //    which the raw-argument reader never looked at — so a bundle write
    //    scheduled NO projection refresh at all, for the one tool that writes
    //    the most pages at once.
    assert.deepEqual(
      pathsTouchedByWrite('write_bundle', {
        steps: [{ op: 'write', path: 'wiki/a.md' }, { op: 'write', path: 'wiki/b.md' }],
      }),
      ['wiki/a.md', 'wiki/b.md'],
    );
    // A recovery replays a journal; it applies no `steps[]`. And the truth test
    // is the DISPATCHER's — `normalizeRecoverArg` reads these four strings as an
    // ordinary bundle, so they must still report their real steps.
    assert.deepEqual(pathsTouchedByWrite('write_bundle', { recover: true, steps: [{ path: 'wiki/a.md' }] }), []);
    for (const falsy of ['false', '0', 'no', 'off', '']) {
      assert.deepEqual(
        pathsTouchedByWrite('write_bundle', { recover: falsy, steps: [{ op: 'write', path: 'wiki/a.md' }] }),
        ['wiki/a.md'],
        `recover: ${JSON.stringify(falsy)} is an ordinary bundle to the handler`,
      );
    }

    // 2. A RENDER-ONLY `execute_template` writes nothing, so it must not
    //    schedule. `createFile === true` strictly, the same gate the handler
    //    and the bridge use.
    assert.deepEqual(pathsTouchedByWrite('execute_template', { targetPath: 'wiki/t.md' }), []);
    assert.deepEqual(pathsTouchedByWrite('execute_template', { createFile: 'true', targetPath: 'wiki/t.md' }), []);
    assert.deepEqual(
      pathsTouchedByWrite('execute_template', { createFile: true, targetPath: 'wiki/t.md' }),
      ['wiki/t.md'],
    );

    // 3. AN UNDECLARED `path` names nothing. These tools write a fixed target
    //    (`wiki-meta/…`), and `request.params.arguments` is an OPEN record at
    //    runtime, so an appended field is not an argument.
    for (const tool of ['build_search_index', 'record_source', 'refresh_okf_projections', 'build_wiki_graph']) {
      assert.deepEqual(pathsTouchedByWrite(tool, { path: 'wiki/forged.md' }), [], tool);
    }
  });

  test('default debounce is a quiet-period, not a hair trigger', () => {
    assert.ok(DEFAULT_DEBOUNCE_MS >= 5_000);
  });
});

describe('marker contract across modules (anti-drift pin)', () => {
  test('the bundle exporter refuses to export an at-rest projection as a document', () => {
    // The exporter carries an INLINED marker copy (cycle). If either copy
    // drifts, this test fails: projections would be exported as documents and
    // collide with the bundle's own reserved index/log set.
    const { files } = buildProjections({
      pages: [{ path: 'wiki/a/p.md', frontmatter: { type: 'note', title: 'P' }, body: 'x' }],
      vaultName: 'v',
      now: '2026-07-30',
    });
    const bundle = buildOkfBundle({
      ...GATE,
      vaultName: 'v',
      now: '2026-07-30',
      pages: [
        { path: 'wiki/a/p.md', content: '---\ntype: note\ntitle: "P"\n---\n\nx\n' },
        ...files.map((f) => ({ path: f.path, content: f.content })),
      ],
    });
    assert.equal(bundle.report.documentCount, 1, 'only the real page is a document');
    const exportedPaths = bundle.files.map((f) => f.path);
    assert.ok(!exportedPaths.includes('a/index-2.md'), 'no reserved-name collision rename happened');
  });

  test('an UNMARKED page reusing a reserved name still exports (as a renamed doc)', () => {
    const bundle = buildOkfBundle({
      ...GATE,
      vaultName: 'v',
      now: '2026-07-30',
      pages: [
        { path: 'wiki/a/index.md', content: '---\ntype: note\ntitle: "Homonyme"\n---\n\nContenu réel.\n' },
      ],
    });
    assert.equal(bundle.report.documentCount, 1, 'hand-written content is still content');
  });

  test('the marker string itself is pinned', () => {
    assert.equal(PROJECTION_MARKER, 'Generated by obsidian-mcp-router');
  });
});
