/**
 * CONTACT — the router repairs a drifted vault the first time a session touches
 * it, without ever failing the call that triggered it, and without condemning
 * the session when one attempt fails.
 *
 * Driven end to end over an in-memory vault (same harness shape as
 * tests/refresh-okf-projections.test.mjs): the gate is wired to the REAL
 * projection-refresh core and the REAL index builder, so "the index comes back"
 * means the bytes came back, not that a spy was called.
 *
 * The gate's own state machine (in-flight sharing, retry after failure, the
 * coalesced rerun) and the shared per-vault lock are exercised separately with
 * injected spies.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createConformanceGate,
  createMaintenancePass,
  MAX_CONFORMANCE_ATTEMPTS,
} from '../src/helpers/vault-conformance.mjs';
import { withVaultLock, isVaultLockHeld, lockedVaults } from '../src/helpers/vault-maintenance-lock.mjs';
import { createProjectionsScheduler } from '../src/helpers/projections-refresh.mjs';
import { refreshProjectionsForVault } from '../src/tools/refresh-okf-projections.mjs';
import { buildIndexForVault } from '../src/tools/build-search-index.mjs';
import { buildProjections } from '../src/helpers/okf-projections.mjs';
import { indexProblem, SEARCH_INDEX_PATH, INDEX_VERSION } from '../src/helpers/bm25-index.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';

/** Unique vault name per test — the lock is a process-wide singleton. */
let vaultSeq = 0;
const nextVault = () => ({ name: `test-vault-${++vaultSeq}` });

const PAGE = (title) =>
  `---\ntype: note\ntitle: "${title}"\ndescription: "Desc ${title}"\ncreated: 2026-07-01\n---\n\nCorps de ${title}, avec des mots discriminants.\n`;

/** The scaffold whose presence marks a vault as router-managed. */
const SCAFFOLD = { 'wiki-meta/catalog.md': '---\ntype: index\ntitle: "Wiki Catalog"\n---\n\n# Wiki Catalog\n' };

/** In-memory vault: Map path → content, with rest-shaped deps + write log. */
function makeVaultFs(files = {}) {
  const store = new Map(Object.entries(files));
  const writes = [];
  const deletes = [];
  const failingDirs = new Set(); // directories whose LISTING errors (not 404)
  const deps = {
    listFilesIn: async (_v, dir) => {
      if (failingDirs.has(dir)) throw Object.assign(new Error('500'), { kind: 'server_error' });
      const prefix = dir ? `${dir}/` : '';
      const names = new Set();
      for (const p of store.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
      }
      if (names.size === 0 && dir !== '') throw Object.assign(new Error('404'), { kind: 'not_found' });
      return { files: [...names].sort() };
    },
    getFileContent: async (_v, p) => {
      if (!store.has(p)) throw Object.assign(new Error('404'), { kind: 'not_found' });
      return store.get(p);
    },
    writeFile: async (_v, p, content, opts = {}) => {
      if (opts.applyIfContentPreexists === false && store.has(p)) {
        throw Object.assign(new Error('409'), { kind: 'conflict', status: 409 });
      }
      store.set(p, content);
      writes.push(p);
    },
    deleteFile: async (_v, p) => { store.delete(p); deletes.push(p); },
    // A REAL cooperative-CAS over the store — mirrors the bridge, so the
    // automatic conditional-write path behaves as it does in production.
    attemptAtomicCas: async (_v, p, content, expectedSha) => {
      const current = store.has(p) ? store.get(p) : null;
      if (current === null) throw Object.assign(new Error('target-missing'), { kind: 'conflict', status: 409 });
      if (contentSha256(current) !== expectedSha) {
        throw Object.assign(new Error('content-changed'), { kind: 'conflict', status: 409 });
      }
      store.set(p, content);
      writes.push(p);
      return { ok: true };
    },
  };
  return { store, writes, deletes, failingDirs, deps };
}

/**
 * A CONFORMANT starting vault: the wiki-meta scaffold, content pages, the
 * projections they imply, and a current search index. Built with the real
 * generators so the fixture cannot drift away from what the code produces.
 */
async function makeConformantVault(vault, pages) {
  const fs = makeVaultFs({ ...SCAFFOLD, ...pages });
  const parsed = Object.entries(pages).map(([p, content]) => {
    const body = content.split('---\n')[2] ?? '';
    const fm = {};
    for (const line of content.split('\n')) {
      const m = /^(\w+):\s*"?([^"]*)"?$/.exec(line);
      if (m) fm[m[1]] = m[2];
    }
    return { path: p, frontmatter: fm, body };
  });
  const { files } = buildProjections({ pages: parsed, vaultName: vault.name, now: '2026-08-08' });
  for (const f of files) fs.store.set(f.path, f.content);
  await buildIndexForVault(vault, fs.deps);
  fs.writes.length = 0;
  fs.deletes.length = 0;
  return fs;
}

/** Wire the real maintenance pass over an in-memory vault. */
function passOver(deps, { withProjections = true } = {}) {
  return createMaintenancePass({
    // Same opts the production automatic wiring uses (index.mjs): conditional
    // writes + deferred deletes.
    refreshProjections: withProjections
      ? (vault) => refreshProjectionsForVault(vault, deps, {
        requireScaffold: true, now: '2026-08-08', conditionalWrites: true, deferDeletes: true,
      })
      : null,
    ensureSearchIndex: (vault) => buildIndexForVault(vault, deps, {
      automatic: true, requireScaffold: true, conditionalWrites: true,
    }),
    logInfo: () => {},
  });
}

function gateOver(deps, opts) {
  return createConformanceGate({ maintain: passOver(deps, opts), logError: () => {} });
}

/** Like gateOver, but captures the gate's stderr so exhaustion can be observed. */
function gateOverCapturing(deps, opts) {
  const errors = [];
  const gate = createConformanceGate({ maintain: passOver(deps, opts), logError: (m) => errors.push(m) });
  return { gate, errors };
}

// ---------------------------------------------------------------------------
// The repair itself
// ---------------------------------------------------------------------------

describe('first contact repairs a drifted vault', () => {
  test('a deleted search index and a deleted directory index BOTH come back', async () => {
    const VAULT = nextVault();
    const { store, deps } = await makeConformantVault(VAULT, {
      'wiki/notes/alpha.md': PAGE('Alpha'),
      'wiki/notes/beta.md': PAGE('Beta'),
    });

    store.delete(SEARCH_INDEX_PATH);
    store.delete('wiki/notes/index.md');

    const report = await gateOver(deps).ensure(VAULT);

    assert.ok(report, 'first contact must run');
    assert.equal(report.ok, true);
    assert.ok(store.has('wiki/notes/index.md'), 'the directory index must be regenerated');
    assert.ok(store.has(SEARCH_INDEX_PATH), 'the search index must be rebuilt');
    const index = JSON.parse(store.get(SEARCH_INDEX_PATH));
    assert.equal(indexProblem(index), null, 'the rebuilt index must be usable');
    assert.ok(index.stats.chunks > 0, 'it must index the actual content');
  });

  test('a MISSING ROOT projection is repaired — the bridge promises exactly this', async () => {
    // The contradiction the reviewers caught: gating on a marked `wiki/index.md`
    // meant refusing to repair a missing `wiki/index.md`, while the bridge's
    // Notice told the user the router would.
    const VAULT = nextVault();
    const { store, deps } = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    store.delete('wiki/index.md');
    store.delete('wiki/log.md');

    const report = await gateOver(deps).ensure(VAULT);

    assert.ok(store.has('wiki/index.md'), 'the root index must come back');
    assert.ok(store.has('wiki/log.md'), 'the log must come back');
    assert.equal(report.projections.skipped, undefined, 'the refresh must not have been skipped');
  });

  test('a vault that is already conformant is left byte-identical', async () => {
    const VAULT = nextVault();
    const { store, writes, deps } = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    const before = new Map(store);

    const report = await gateOver(deps).ensure(VAULT);

    assert.deepEqual(writes, [], 'a conformant vault must produce zero writes');
    assert.equal(report.projections.conformant, true);
    assert.deepEqual([...store.entries()].sort(), [...before.entries()].sort());
  });

  test('a stale search index is rebuilt, a stale projection is rewritten', async () => {
    const VAULT = nextVault();
    const { store, deps } = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    // A page created by hand in Obsidian — the router never saw the write.
    store.set('wiki/notes/gamma.md', PAGE('Gamma'));

    await gateOver(deps).ensure(VAULT);

    assert.match(store.get('wiki/notes/index.md'), /Gamma/, 'the directory index must list the new page');
    const index = JSON.parse(store.get(SEARCH_INDEX_PATH));
    assert.ok(
      index.chunks.some((c) => c.path === 'wiki/notes/gamma.md'),
      'the rebuilt index must cover the hand-created page',
    );
  });

  test('an UNMARKED squatter on a reserved projection path is reported, never overwritten', async () => {
    const VAULT = nextVault();
    const { store, deps } = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    const mine = '# My own index\n\nHand-written, not yours.\n';
    store.set('wiki/notes/index.md', mine);

    const report = await gateOver(deps).ensure(VAULT);

    assert.equal(store.get('wiki/notes/index.md'), mine, 'the squatter must be byte-intact');
    assert.ok(report.conflicts.includes('wiki/notes/index.md'), 'the conflict must be reported');
    assert.equal(report.projections.conformant, false, 'a conflict is not conformance…');
    assert.equal(report.projections.upToDate, true, '…even though there is no work left to do');
  });

  test('a squatter at the search-index path is reported, never overwritten', async () => {
    const VAULT = nextVault();
    const { store, deps } = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    const mine = JSON.stringify({ mine: true, keep: 'this' });
    store.set(SEARCH_INDEX_PATH, mine);

    const report = await gateOver(deps).ensure(VAULT);

    assert.equal(store.get(SEARCH_INDEX_PATH), mine, 'the squatter must be byte-intact');
    assert.ok(report.conflicts.includes(SEARCH_INDEX_PATH));
  });

  test('an index from ANOTHER router generation is preserved, not re-written (no ping-pong)', async () => {
    const VAULT = nextVault();
    const { store, deps } = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    const foreign = JSON.stringify({ version: INDEX_VERSION + 7, postings: {}, chunks: [], fingerprint: 'x' });
    store.set(SEARCH_INDEX_PATH, foreign);

    const report = await gateOver(deps).ensure(VAULT);

    assert.equal(store.get(SEARCH_INDEX_PATH), foreign, 'the other generation’s index must be byte-intact');
    assert.equal(report.searchIndex.indexState, 'foreign-version');
    assert.ok(report.conflicts.includes(SEARCH_INDEX_PATH));
  });

  test('a vault with NO wiki-meta scaffold is left completely alone', async () => {
    const VAULT = nextVault();
    // Content under wiki/, but nobody ever provisioned this vault.
    const { store, writes, deps } = makeVaultFs({ 'wiki/notes/alpha.md': PAGE('Alpha') });

    const report = await gateOver(deps).ensure(VAULT);

    assert.equal(report.projections.skipped, 'no-wiki-meta-scaffold');
    assert.equal(report.searchIndex.skipped, 'no-wiki-meta-scaffold');
    assert.equal(store.has('wiki/index.md'), false, 'no projection may be created');
    assert.equal(store.has(SEARCH_INDEX_PATH), false, 'no wiki-meta/ may be created either');
    assert.deepEqual(writes, [], 'a vault the router does not manage gets NO writes at all');
  });

  test('a repair with the projections half disabled still builds the index', async () => {
    const VAULT = nextVault();
    const { store, deps } = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    store.delete(SEARCH_INDEX_PATH);

    const report = await gateOver(deps, { withProjections: false }).ensure(VAULT);

    assert.equal(report.projections, null);
    assert.ok(store.has(SEARCH_INDEX_PATH));
  });
});

// ---------------------------------------------------------------------------
// A6 — fail-closed on a directory that failed to LIST
// ---------------------------------------------------------------------------

describe('a directory listing that FAILS never becomes a deletion', () => {
  test('one failed subtree listing → no writes, no deletes, skipped', async () => {
    const VAULT = nextVault();
    const fs = await makeConformantVault(VAULT, {
      'wiki/notes/alpha.md': PAGE('Alpha'),
      'wiki/refs/beta.md': PAGE('Beta'),
    });
    const before = new Map(fs.store);
    // `wiki/refs/` answers 500 rather than 404: its pages become invisible, and
    // a planner that trusted the enumeration would DELETE wiki/refs/index.md.
    fs.failingDirs.add('wiki/refs');

    const report = await gateOver(fs.deps).ensure(VAULT);

    // THE LOAD-BEARING ASSERTIONS, and they are about CONTENT LOSS rather than
    // about a status field. Without the guard the planner treats the invisible
    // subtree as absent and rewrites the vault-level projections WITHOUT it:
    // measured, `wiki/log.md` loses every `refs/` entry and `wiki/index.md`
    // loses the whole subdirectory — silently, permanently, because one
    // directory listing returned 500.
    assert.match(fs.store.get('wiki/log.md'), /Beta/, 'the log must not lose the unreadable subtree');
    assert.match(fs.store.get('wiki/index.md'), /refs/, 'the root index must not lose the subdirectory');
    assert.equal(
      fs.store.get('wiki/refs/index.md'),
      before.get('wiki/refs/index.md'),
      'the index of the unreadable directory must survive byte-intact',
    );
    assert.deepEqual(fs.writes, [], 'a tree we could not read in full produces NO writes');
    assert.deepEqual(fs.deletes, [], 'and no deletes');
    assert.equal(report.projections.skipped, 'enumeration-failed');
    assert.ok(report.projections.warnings.join(' ').includes('listing(s) failed'));
  });

  test('an ABSENT directory (404) is not a failure — the normal empty case still plans', async () => {
    const VAULT = nextVault();
    const fs = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    const report = await gateOver(fs.deps).ensure(VAULT);
    assert.equal(report.projections.skipped, undefined);
  });
});

// ---------------------------------------------------------------------------
// F1 — an INCOMPLETE VIEW of the vault is a failure, not a silent success
//
// A transient REST outage on a LISTING makes the cores RETURN a skip
// (`enumeration-failed` / `enumeration-truncated` / `page-reads-failed`)
// rather than throw. Before the fix the pass treated a return as a success:
// `report.ok` stayed true, the gate marked the vault `succeeded` (terminal),
// the retry budget was never spent, and stderr said nothing — search_smart
// stayed broken for the whole session. That is the exact incident the feature
// exists to remove, and the pass's own comment promised otherwise.
// ---------------------------------------------------------------------------

describe('F1 — an incomplete enumeration is NOT a success', () => {
  test('an enumeration-failed skip from a half makes the pass non-ok', async () => {
    // Unit level, on the classification itself: this is the mutation target.
    const maintain = createMaintenancePass({
      refreshProjections: async () => ({ skipped: 'enumeration-failed', warnings: ['1 listing failed'] }),
      ensureSearchIndex: async () => ({ skipped: 'enumeration-failed' }),
      logInfo: () => {},
    });
    const report = await maintain(nextVault());
    assert.equal(report.ok, false, 'a vault we could not read in full is not repaired, so the pass did not succeed');
    assert.ok(report.errors.length > 0, 'and the failure is recorded so stderr says something');
  });

  test('enumeration-truncated (tree deeper than the walker) is treated the same way', async () => {
    const maintain = createMaintenancePass({
      refreshProjections: async () => ({ skipped: 'enumeration-truncated', warnings: ['enumeration-truncated'] }),
      logInfo: () => {},
    });
    const report = await maintain(nextVault());
    assert.equal(report.ok, false);
  });

  test('a page-reads-failed skip is also a non-success', async () => {
    const maintain = createMaintenancePass({
      ensureSearchIndex: async () => ({ skipped: 'page-reads-failed' }),
      logInfo: () => {},
    });
    const report = await maintain(nextVault());
    assert.equal(report.ok, false);
  });

  test('a LEGITIMATE "nothing to do" skip stays a success (no over-correction)', async () => {
    // A vault the router does not manage must NOT be retried on every tool call.
    const maintain = createMaintenancePass({
      refreshProjections: async () => ({ skipped: 'no-wiki-meta-scaffold' }),
      ensureSearchIndex: async () => ({ vault: 'v', skipped: 'no-wiki-meta-scaffold' }),
      logInfo: () => {},
    });
    const report = await maintain(nextVault());
    assert.equal(report.ok, true, 'not-a-router-vault is legitimately nothing to do, not a failure');
  });

  test('THE FOUNDING INCIDENT: a transient listing outage, then a later contact REPAIRS', async () => {
    const VAULT = nextVault();
    const fs = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    fs.store.delete(SEARCH_INDEX_PATH); // there is real repair work waiting

    // The whole `wiki/` tree fails to list for the first contact — a 3-second
    // REST blip, the founding scenario. The scaffold read (catalog.md) still
    // succeeds, so the cores SKIP rather than throw.
    fs.failingDirs.add('wiki');

    const gate = gateOver(fs.deps);
    const first = await gate.ensure(VAULT);

    assert.equal(first.ok, false, 'the pass could not see the vault, so it did not succeed');
    assert.equal(gate.stateOf(VAULT.name), 'failed-retryable', 'the vault must stay open for a retry, not be condemned');
    assert.equal(fs.store.has(SEARCH_INDEX_PATH), false, 'nothing was repaired while the vault was unreadable');

    // The outage clears. The next qualifying contact must retry AND repair.
    fs.failingDirs.delete('wiki');
    const second = await gate.ensure(VAULT);

    assert.ok(second, 'the retry ran — the session was not condemned');
    assert.equal(gate.stateOf(VAULT.name), 'succeeded');
    assert.ok(fs.store.has(SEARCH_INDEX_PATH), 'and the index came back');
    assert.equal(indexProblem(JSON.parse(fs.store.get(SEARCH_INDEX_PATH))), null);
  });

  test('a vault that stays unreadable → EXHAUSTED after the budget, loudly, with no writes', async () => {
    const VAULT = nextVault();
    const fs = await makeConformantVault(VAULT, { 'wiki/notes/alpha.md': PAGE('Alpha') });
    fs.failingDirs.add('wiki'); // never heals
    const { gate, errors } = gateOverCapturing(fs.deps);

    for (let i = 0; i < 5; i += 1) await gate.ensure(VAULT);

    assert.equal(gate.attemptsFor(VAULT.name), 3, 'exactly the attempt budget, not one pass per tool call');
    assert.equal(gate.stateOf(VAULT.name), 'exhausted');
    assert.ok(errors.length > 0, 'exhaustion must be LOUD on stderr, not a silent terminal success');
    assert.match(errors.join('\n'), /exhausted|could not be read|incomplete/i);
    assert.deepEqual(fs.writes, [], 'a vault we could not read in full is never written to');
    assert.equal(await gate.ensure(VAULT), null, 'and it is terminal — no fourth attempt');
  });

  test('GUARD-RAIL: the THROW path (catalog.md 500) still recovers as before', async () => {
    // requireScaffold re-throws a non-404 error reading the scaffold, so the
    // pass CATCHES rather than skips. This path already worked; it must keep
    // working after the skip fix.
    const VAULT = nextVault();
    const deps = {
      listFilesIn: async () => ({ files: [] }),
      getFileContent: async (_v, p) => {
        if (p === 'wiki-meta/catalog.md') throw Object.assign(new Error('500'), { kind: 'server_error' });
        throw Object.assign(new Error('404'), { kind: 'not_found' });
      },
      writeFile: async () => {},
      deleteFile: async () => {},
    };
    const gate = gateOver(deps);
    const report = await gate.ensure(VAULT);
    assert.equal(report.ok, false, 'a throwing scaffold read is a failure');
    assert.equal(gate.stateOf(VAULT.name), 'failed-retryable', 'and it too keeps the vault retryable');
  });
});

// ---------------------------------------------------------------------------
// A1 — the gate's state machine
// ---------------------------------------------------------------------------

describe('createConformanceGate — the state machine', () => {
  let calls;
  let gate;
  let outcome;

  beforeEach(() => {
    calls = [];
    outcome = { ok: true };
    gate = createConformanceGate({
      maintain: async (v) => { calls.push(v.name); return { vault: v.name, conflicts: [], errors: [], ...outcome }; },
      logError: () => {},
    });
  });

  test('a successful pass is terminal — the second contact is a no-op', async () => {
    const first = await gate.ensure({ name: 'v1' });
    const second = await gate.ensure({ name: 'v1' });
    assert.ok(first, 'the first contact runs');
    assert.equal(second, null, 'the second returns null');
    assert.deepEqual(calls, ['v1'], 'the work happens exactly once');
    assert.equal(gate.stateOf('v1'), 'succeeded');
  });

  test('each vault gets its own first contact', async () => {
    await gate.ensure({ name: 'v1' });
    await gate.ensure({ name: 'v2' });
    assert.deepEqual(calls, ['v1', 'v2']);
    assert.deepEqual(gate.seen().sort(), ['v1', 'v2']);
  });

  test('concurrent contacts AWAIT THE SAME promise — no chained rescan', async () => {
    let release;
    const slow = new Promise((r) => { release = r; });
    const g = createConformanceGate({
      maintain: async (v) => { calls.push(v.name); await slow; return { ok: true, conflicts: [], errors: [] }; },
      logError: () => {},
    });
    const a = g.ensure({ name: 'v1' });
    const b = g.ensure({ name: 'v1' });
    const c = g.ensure({ name: 'v1' });
    assert.equal(g.stateOf('v1'), 'in-flight');
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.deepEqual(calls, ['v1'], 'three callers, ONE pass');
    assert.equal(ra, rb, 'the same promise resolved for every caller');
    assert.equal(rb, rc);
  });

  test('A FAILED PASS DOES NOT CONDEMN THE SESSION — the next trigger retries', async () => {
    // The founding incident: search_smart fails because there is no index, the
    // failure is what should trigger the repair, and a `Set`-based gate would
    // mark the vault handled on that first failing attempt — every later call
    // failing identically, forever.
    outcome = { ok: false, errors: ['vault offline'] };
    const first = await gate.ensure({ name: 'v1' });
    assert.equal(first.ok, false);
    assert.equal(gate.stateOf('v1'), 'failed-retryable');

    outcome = { ok: true, errors: [] };
    const second = await gate.ensure({ name: 'v1' });
    assert.ok(second, 'the retry ran');
    assert.equal(second.ok, true);
    assert.deepEqual(calls, ['v1', 'v1']);
    assert.equal(gate.stateOf('v1'), 'succeeded');
  });

  test('retries are BOUNDED — a permanently broken vault stops costing passes', async () => {
    outcome = { ok: false, errors: ['always broken'] };
    for (let i = 0; i < MAX_CONFORMANCE_ATTEMPTS + 4; i += 1) await gate.ensure({ name: 'v1' });
    assert.equal(calls.length, MAX_CONFORMANCE_ATTEMPTS, 'at most the attempt budget');
    assert.equal(gate.stateOf('v1'), 'exhausted');
    assert.equal(await gate.ensure({ name: 'v1' }), null);
  });

  test('a trigger arriving MID-PASS coalesces into exactly ONE rerun', async () => {
    let release;
    const slow = new Promise((r) => { release = r; });
    let n = 0;
    const g = createConformanceGate({
      maintain: async () => {
        n += 1;
        if (n === 1) await slow;
        return { ok: true, conflicts: [], errors: [] };
      },
      logError: () => {},
    });
    const first = g.ensure({ name: 'v1' });
    // Five triggers land while the pass runs. They must not become five reruns.
    g.ensure({ name: 'v1' });
    g.ensure({ name: 'v1' });
    g.ensure({ name: 'v1' });
    g.ensure({ name: 'v1' });
    g.ensure({ name: 'v1' });
    release();
    await first;
    assert.equal(g.stateOf('v1'), 'failed-retryable', 'the dirty flag re-opens the vault for ONE rerun');
    await g.ensure({ name: 'v1' });
    assert.equal(n, 2, 'exactly one rerun, not five');
    assert.equal(g.stateOf('v1'), 'succeeded');
  });

  test('a non-vault argument is ignored', async () => {
    assert.equal(await gate.ensure(null), null);
    assert.equal(await gate.ensure({}), null);
    assert.deepEqual(calls, []);
  });

  test('reset() forgets the session', async () => {
    await gate.ensure({ name: 'v1' });
    gate.reset();
    assert.deepEqual(gate.seen(), []);
    await gate.ensure({ name: 'v1' });
    assert.deepEqual(calls, ['v1', 'v1']);
  });

  test('a pass that THROWS is caught, recorded as retryable, and never rethrown', async () => {
    const g = createConformanceGate({
      maintain: async () => { throw new Error('defect in the pass'); },
      logError: () => {},
    });
    const report = await g.ensure({ name: 'v1' });
    assert.equal(report.ok, false);
    assert.equal(g.stateOf('v1'), 'failed-retryable');
  });
});

describe('createMaintenancePass — failures never reach the caller', () => {
  test('a throwing projections refresh is recorded, not propagated', async () => {
    const maintain = createMaintenancePass({
      refreshProjections: async () => { throw new Error('vault offline'); },
      ensureSearchIndex: async () => ({ written: true, stats: { chunks: 3 } }),
      logInfo: () => {},
    });
    const report = await maintain(nextVault());
    assert.ok(report.errors.some((e) => e.includes('vault offline')));
    assert.equal(report.ok, false, 'a pass with errors is NOT a success');
    assert.equal(report.searchIndex.written, true, 'the index half still runs');
  });

  test('a throwing index build is recorded, not propagated', async () => {
    const maintain = createMaintenancePass({
      refreshProjections: async () => ({ written: [], deleted: [], conflicts: [] }),
      ensureSearchIndex: async () => { throw new Error('enumeration failed'); },
      logInfo: () => {},
    });
    const report = await maintain(nextVault());
    assert.ok(report.errors.some((e) => e.includes('enumeration failed')));
    assert.equal(report.ok, false);
  });

  test('projections run BEFORE the index (the index must see the refreshed tree)', async () => {
    const order = [];
    const maintain = createMaintenancePass({
      refreshProjections: async () => { order.push('projections'); return {}; },
      ensureSearchIndex: async () => { order.push('index'); return {}; },
      logInfo: () => {},
    });
    await maintain(nextVault());
    assert.deepEqual(order, ['projections', 'index']);
  });

  test('with no halves wired at all it is a silent no-op', async () => {
    const v = nextVault();
    const report = await createMaintenancePass({ logInfo: () => {} })(v);
    assert.deepEqual(report, { vault: v.name, projections: null, searchIndex: null, conflicts: [], errors: [], ok: true });
  });
});

// ---------------------------------------------------------------------------
// A7 — ONE lock, shared by every rebuild path
// ---------------------------------------------------------------------------

describe('the per-vault maintenance lock', () => {
  test('two sections on one vault never overlap', async () => {
    const v = nextVault();
    let inside = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const job = async () => {
      inside += 1;
      runs += 1;
      maxConcurrent = Math.max(maxConcurrent, inside);
      await new Promise((r) => setTimeout(r, 10));
      inside -= 1;
    };
    await Promise.all([withVaultLock(v.name, job), withVaultLock(v.name, job), withVaultLock(v.name, job)]);
    assert.equal(maxConcurrent, 1, 'the lock must serialize');
    assert.equal(runs, 3, 'every queued job still runs');
    assert.equal(isVaultLockHeld(v.name), false, 'the lock must be released');
  });

  test('different vaults do not wait on each other', async () => {
    const a = nextVault();
    const b = nextVault();
    let bothInside = false;
    let aIn = false;
    const jobA = async () => { aIn = true; await new Promise((r) => setTimeout(r, 20)); aIn = false; };
    const jobB = async () => { await new Promise((r) => setTimeout(r, 5)); if (aIn) bothInside = true; };
    await Promise.all([withVaultLock(a.name, jobA), withVaultLock(b.name, jobB)]);
    assert.equal(bothInside, true, 'two vaults must be able to run at once');
  });

  test('a failing job does not poison the queue', async () => {
    const v = nextVault();
    let ran = false;
    const bad = withVaultLock(v.name, async () => { throw new Error('boom'); });
    const good = withVaultLock(v.name, async () => { ran = true; return 'ok'; });
    await assert.rejects(bad, /boom/);
    assert.equal(await good, 'ok');
    assert.equal(ran, true);
    // The queue entry is dropped one microtask after the tail settles.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lockedVaults().filter((n) => n === v.name), [], 'the drained queue must not leak an entry');
  });

  test('the caller sees its OWN result, not the predecessor’s', async () => {
    const v = nextVault();
    const [a, b] = await Promise.all([
      withVaultLock(v.name, async () => 'first'),
      withVaultLock(v.name, async () => 'second'),
    ]);
    assert.equal(a, 'first');
    assert.equal(b, 'second');
  });

  test('the maintenance pass holds the lock while it runs', async () => {
    const v = nextVault();
    let heldInside = null;
    const maintain = createMaintenancePass({
      refreshProjections: async () => { heldInside = isVaultLockHeld(v.name); return {}; },
      logInfo: () => {},
    });
    await maintain(v);
    assert.equal(heldInside, true, 'the pass must run inside the lock, not beside it');
    assert.equal(isVaultLockHeld(v.name), false);
  });

  test('the debounced flush and a contact repair queue behind one another', async () => {
    const v = nextVault();
    let inside = 0;
    let maxConcurrent = 0;
    const maintain = createMaintenancePass({
      refreshProjections: async () => {
        inside += 1;
        maxConcurrent = Math.max(maxConcurrent, inside);
        await new Promise((r) => setTimeout(r, 10));
        inside -= 1;
        return {};
      },
      logInfo: () => {},
    });
    const scheduler = createProjectionsScheduler({ refresh: maintain, delayMs: 1, logError: () => {} });
    const gate = createConformanceGate({ maintain, logError: () => {} });

    await Promise.all([scheduler.runNow(v), gate.ensure(v), scheduler.runNow(v)]);
    assert.equal(maxConcurrent, 1, 'flush and contact must not run at the same time');
  });
});

describe('scheduler.runNow — the shared entry point', () => {
  test('runNow cancels a pending debounced refresh instead of racing it', async () => {
    const v = nextVault();
    let runs = 0;
    const timers = [];
    const scheduler = createProjectionsScheduler({
      refresh: async () => { runs += 1; return {}; },
      delayMs: 5,
      setTimeoutFn: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; },
      logError: () => {},
    });

    scheduler.noteWrite(v, 'write_file', { path: 'wiki/a.md' });
    assert.deepEqual(scheduler.pending(), [v.name]);

    await scheduler.runNow(v);
    assert.deepEqual(scheduler.pending(), [], 'the pending timer must be cancelled');

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runs, 1, 'the cancelled timer must not fire a second rebuild');
    for (const t of timers) clearTimeout(t);
  });

  test('a throwing refresh is swallowed and logged', async () => {
    const v = nextVault();
    const errors = [];
    const scheduler = createProjectionsScheduler({
      refresh: async () => { throw new Error('boom'); },
      logError: (m) => errors.push(m),
    });
    assert.equal(await scheduler.runNow(v), null);
    assert.equal(errors.length, 1);
  });

  test('runNow ignores a non-vault argument', async () => {
    const scheduler = createProjectionsScheduler({ refresh: async () => { throw new Error('never'); }, logError: () => {} });
    assert.equal(await scheduler.runNow(null), null);
    assert.equal(await scheduler.runNow({}), null);
  });
});

// ---------------------------------------------------------------------------
// shouldSkip — Phase 3 fix (portee-ergonomie-refus-roadmap): a QUEUED
// refresh must be re-checked against LIVE state at fire time, not the state
// that was true when it was scheduled. Found by Codex review: a vault turned
// `alsoLocked` mid-debounce (config hot-reloaded before the timer fired)
// still received the queued write, defeating the hard tier's own "no
// exceptions, ever" promise.
// ---------------------------------------------------------------------------

describe('createProjectionsScheduler — shouldSkip re-checks at fire time, not at noteWrite time', () => {
  test('default (no shouldSkip) preserves the original unconditional behaviour', async () => {
    const v = nextVault();
    let runs = 0;
    const scheduler = createProjectionsScheduler({ refresh: async () => { runs += 1; return {}; }, logError: () => {} });
    await scheduler.runNow(v);
    assert.equal(runs, 1);
  });

  test('shouldSkip TRUE at fire time cancels the refresh — runNow', async () => {
    const v = nextVault();
    let runs = 0;
    const scheduler = createProjectionsScheduler({
      refresh: async () => { runs += 1; return {}; },
      logError: () => {},
      shouldSkip: () => true,
    });
    const result = await scheduler.runNow(v);
    assert.equal(result, null);
    assert.equal(runs, 0, 'a vault shouldSkip refuses must never reach the refresh core');
  });

  test('shouldSkip is evaluated AGAIN at fire time — a vault locked AFTER noteWrite is still caught by a debounced flush', async () => {
    const v = nextVault();
    let runs = 0;
    let locked = false; // false when noteWrite runs; flipped to true before the timer fires
    const scheduler = createProjectionsScheduler({
      refresh: async () => { runs += 1; return {}; },
      delayMs: 5,
      logError: () => {},
      shouldSkip: () => locked,
    });

    scheduler.noteWrite(v, 'write_file', { path: 'wiki/a.md' });
    assert.deepEqual(scheduler.pending(), [v.name], 'fixture sanity: a refresh must be queued');

    // Simulate a config hot-reload landing DURING the debounce window —
    // exactly the race Codex review found.
    locked = true;

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runs, 0, 'the queued refresh must consult LIVE state, not state captured at noteWrite time');
  });

  test('shouldSkip receives the SAME vault object the refresh core would have received', async () => {
    const v = nextVault();
    let seen = null;
    const scheduler = createProjectionsScheduler({
      refresh: async () => ({}),
      logError: () => {},
      shouldSkip: (vault) => { seen = vault; return false; },
    });
    await scheduler.runNow(v);
    assert.equal(seen, v);
  });
});
