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
    assert.match(errors[0], /okf-projections refresh failed/);
  });

  test('pathsTouchedByWrite maps every write tool to its path args', () => {
    assert.deepEqual(pathsTouchedByWrite('write_file', { path: 'wiki/a.md' }), ['wiki/a.md']);
    assert.deepEqual(pathsTouchedByWrite('delete_file', { path: 'wiki/a.md' }), ['wiki/a.md']);
    assert.deepEqual(
      pathsTouchedByWrite('move_file', { from: 'wiki/a.md', to: 'archives/a.md' }),
      ['wiki/a.md', 'archives/a.md'],
    );
    assert.deepEqual(pathsTouchedByWrite('execute_template', { targetPath: 'wiki/t.md' }), ['wiki/t.md']);
    assert.deepEqual(pathsTouchedByWrite('build_wiki_graph', {}), []);
    assert.deepEqual(pathsTouchedByWrite('write_file', {}), []);
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
