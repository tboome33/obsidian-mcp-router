/**
 * F3-b at the INTEGRATION level — the reserved-path conditional write driven
 * through the real projection/index cores, not the helper in isolation.
 *
 * The exit criterion under test is NON-DESTRUCTION on the automatic path:
 * foreign content on a reserved path is never lost without a recoverable copy.
 * Plus the supporting codex findings: deferred deletes (H3), post-apply results
 * (H1), explicit-apply protection (H4), and the `.bak` never polluting the
 * corpus or the projections.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { refreshProjectionsForVault, refreshOkfProjectionsTool } from '../src/tools/refresh-okf-projections.mjs';
import { buildIndexForVault } from '../src/tools/build-search-index.mjs';
import { buildProjections, projectionMarkerLine } from '../src/helpers/okf-projections.mjs';
import { isReservedBackupPath } from '../src/helpers/reserved-path-write.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';
import { SEARCH_INDEX_PATH } from '../src/helpers/bm25-index.mjs';

const SCAFFOLD = { 'wiki-meta/catalog.md': '# Wiki Catalog\n' };
const PAGE = (t) => `---\ntype: note\ntitle: "${t}"\ndescription: "Desc ${t}"\ncreated: 2026-07-01\n---\n\nCorps ${t} discriminant.\n`;

/**
 * In-memory vault. `casRouteUnusable` forces the reduced path (no bridge). The
 * fake CAS mirrors the bridge (compare-and-write on hash match).
 */
function makeVaultFs(files = {}, { casRouteUnusable = false } = {}) {
  const store = new Map(Object.entries(files));
  const writes = [];
  const deletes = [];
  // Window-injection knobs. `swapOnRead` models a foreign file replacing OUR
  // content between the snapshot read and the late read: the FIRST read of the
  // path returns the original bytes (so the plan is computed from ours), then
  // the store is swapped to the foreign bytes so the late read sees them.
  // `appearOnCreate` models a foreign file materialising just before a
  // create-if-absent PUT lands on a path the snapshot saw as absent.
  const swapOnRead = new Map();
  const swapped = new Set();
  const appearOnCreate = new Map();
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
      if (names.size === 0 && dir !== '') throw Object.assign(new Error('404'), { kind: 'not_found' });
      return { files: [...names].sort() };
    },
    getFileContent: async (_v, p) => {
      if (!store.has(p)) throw Object.assign(new Error('404'), { kind: 'not_found' });
      const val = store.get(p);
      if (swapOnRead.has(p) && !swapped.has(p)) {
        swapped.add(p);
        store.set(p, swapOnRead.get(p)); // foreign lands AFTER this read returns
      }
      return val;
    },
    writeFile: async (_v, p, content, opts = {}) => {
      if (opts.applyIfContentPreexists === false) {
        if (appearOnCreate.has(p)) {
          store.set(p, appearOnCreate.get(p)); // a foreign file appeared in the window
          throw Object.assign(new Error('409'), { kind: 'conflict', status: 409 });
        }
        if (store.has(p)) throw Object.assign(new Error('409'), { kind: 'conflict', status: 409 });
      }
      store.set(p, content);
      writes.push(p);
    },
    deleteFile: async (_v, p) => { store.delete(p); deletes.push(p); },
    attemptAtomicCas: async (_v, p, content, expectedSha) => {
      if (casRouteUnusable) return { routeUnusable: true, status: 404 };
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
  return { store, writes, deletes, deps, swapOnRead, appearOnCreate };
}

/** A conformant vault (scaffold + one content page + its projections). */
function conformant(pages, opts) {
  const fs = makeVaultFs({ ...SCAFFOLD, ...pages }, opts);
  const parsed = Object.entries(pages).map(([p]) => ({
    path: p, frontmatter: { type: 'note', title: p, description: 'd', created: '2026-07-01' }, body: 'x',
  }));
  const { files } = buildProjections({ pages: parsed, vaultName: 'v', now: '2026-08-08' });
  for (const f of files) fs.store.set(f.path, f.content);
  return fs;
}

const VAULT = { name: 'v' };
const AUTO = { requireScaffold: true, now: '2026-08-08', conditionalWrites: true, deferDeletes: true, nowMs: 1700000000000 };

// ---------------------------------------------------------------------------
// H3 — automatic deletes are NEVER executed
// ---------------------------------------------------------------------------

describe('H3 — the automatic path never deletes', () => {
  test('a stale marked projection is reported as pendingDeletes, not deleted', async () => {
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') });
    // A stale marked projection whose directory has no pages → the planner wants
    // it gone.
    fs.store.set('wiki/gone/index.md', `# Gone\n\n${projectionMarkerLine()}\n`);

    const r = await refreshProjectionsForVault(VAULT, fs.deps, AUTO);

    assert.deepEqual(fs.deletes, [], 'NO DELETE may be emitted automatically');
    assert.ok(r.pendingDeletes.includes('wiki/gone/index.md'), 'the stale file is reported as pending');
    assert.deepEqual(r.deleted, [], 'nothing was actually deleted');
    assert.ok(fs.store.has('wiki/gone/index.md'), 'the file is still on disk');
    assert.equal(r.conformant, false, 'a vault with pending cleanup is not conformant');
  });

  test('the EXPLICIT path (deferDeletes off) still deletes', async () => {
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') });
    fs.store.set('wiki/gone/index.md', `# Gone\n\n${projectionMarkerLine()}\n`);
    const r = await refreshProjectionsForVault(VAULT, fs.deps, {
      requireScaffold: true, now: '2026-08-08', conditionalWrites: true, deferDeletes: false,
    });
    assert.deepEqual(fs.deletes, ['wiki/gone/index.md'], 'an explicit refresh deletes');
    assert.deepEqual(r.pendingDeletes, []);
  });
});

// ---------------------------------------------------------------------------
// H1 — results are POST-APPLY
// ---------------------------------------------------------------------------

describe('H1 — written/conformant reflect the APPLY, not the plan', () => {
  test('a create that conflicts at apply → NOT in written, IS in conflicts, conformant false', async () => {
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') });
    // Drop the directory index so it is PLANNED as a create (absent at snapshot)...
    fs.store.delete('wiki/a/index.md');
    // ...then a foreign file materialises on that exact path IN THE WINDOW, so
    // the create-if-absent PUT is refused (409).
    fs.appearOnCreate.set('wiki/a/index.md', '# human note\n');

    const r = await refreshProjectionsForVault(VAULT, fs.deps, AUTO);

    assert.ok(r.plannedWrites.includes('wiki/a/index.md'), 'the plan intended to (re)create it');
    assert.equal(r.written.includes('wiki/a/index.md'), false, 'but the apply did NOT write it');
    assert.ok(r.conflicts.includes('wiki/a/index.md'), 'it is reported as a runtime conflict');
    assert.equal(r.conformant, false);
    assert.equal(fs.store.get('wiki/a/index.md'), '# human note\n', 'the foreign file is byte-intact');
  });
});

// ---------------------------------------------------------------------------
// NON-DESTRUCTION — a foreign OVERWRITE target is backed up, never lost
// ---------------------------------------------------------------------------

describe('NON-DESTRUCTION — foreign content on an overwrite path is preserved', () => {
  test('reduced mode (no CAS): foreign file backed up before the projection regenerates', async () => {
    // Force a projection to be STALE so it is planned as an overwrite: add a
    // second page so wiki/a/index.md must list it.
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') }, { casRouteUnusable: true });
    fs.store.set('wiki/a/q.md', PAGE('Q')); // now wiki/a/index.md is stale → overwrite
    const foreign = '# I hand-wrote this index\n';
    // Ours at the snapshot read (so the plan is an overwrite of our projection),
    // foreign at the late read (so non-destruction must back it up).
    fs.swapOnRead.set('wiki/a/index.md', foreign);

    const r = await refreshProjectionsForVault(VAULT, fs.deps, AUTO);

    assert.ok(r.backups.length >= 1, 'a backup must have been made');
    const bak = r.backups.find((b) => b.path === 'wiki/a/index.md');
    assert.ok(bak, 'the foreign overwrite is backed up');
    assert.equal(fs.store.get(bak.backupPath), foreign, 'the foreign bytes are recoverable');
    assert.ok(isReservedBackupPath(bak.backupPath));
    assert.match(fs.store.get('wiki/a/index.md'), /Generated by obsidian-mcp-router/, 'projection regenerated');
    assert.equal(r.conformant, false, 'a clobber-with-backup is surfaced, not silent');
    assert.ok(r.warnings.some((w) => w.includes('foreign content')));
    assert.ok(['reduced-getcompare'].includes(r.protectionMode), `protectionMode=${r.protectionMode}`);
  });

  test('the search index gets the same protection', async () => {
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') }, { casRouteUnusable: true });
    // Build a real index so the store has one, then make it stale, and have a
    // foreign file swap in between the snapshot read and the late read.
    await buildIndexForVault(VAULT, fs.deps); // writes a real index (unconditional)
    fs.store.set('wiki/a/r.md', PAGE('R')); // corpus changed → index stale → overwrite
    const foreignIndex = '{"not":"our index"}';
    fs.swapOnRead.set(SEARCH_INDEX_PATH, foreignIndex);

    const r = await buildIndexForVault(VAULT, fs.deps, { automatic: true, requireScaffold: true, conditionalWrites: true, nowMs: 1700000000000 });

    assert.ok(r.backups && r.backups.length >= 1, 'the foreign index is backed up');
    assert.equal(fs.store.get(r.backups[0].backupPath), foreignIndex, 'foreign index recoverable');
  });
});

// ---------------------------------------------------------------------------
// FINDING #1 — a CLEAN index rebuild must NOT back itself up.
//
// The bug: build-search-index's own `isOurs` closure calls looksLikeSearchIndex,
// which was not imported → a ReferenceError swallowed by the closure's catch →
// isOurs ALWAYS false → on the reduced path our own index is judged "foreign"
// and copied to a sidecar before every regeneration (unbounded .bak growth).
//
// This drives the REAL wired closure inside buildIndexForVault (NOT an injected
// isOurs — that is exactly why the helper tests, which inject a correct one,
// never caught it) on a clean rebuild with no injection and no CAS route.
// ---------------------------------------------------------------------------

describe('FINDING #1 — a clean index rebuild never sidecars our own index', () => {
  test('reduced rebuild of OUR OWN v2 index → ZERO backup created', async () => {
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') }, { casRouteUnusable: true });
    // A real, current index of ours on disk.
    await buildIndexForVault(VAULT, fs.deps); // unconditional build → our v2 index
    assert.ok(fs.store.has(SEARCH_INDEX_PATH), 'our index is on disk');

    // The corpus changes so the index is STALE → planned as an overwrite. NO
    // injection: the content to overwrite is our own index throughout.
    fs.store.set('wiki/a/q.md', PAGE('Q'));

    const before = [...fs.store.keys()].filter(isReservedBackupPath).length;
    const r = await buildIndexForVault(VAULT, fs.deps, {
      automatic: true, requireScaffold: true, conditionalWrites: true, nowMs: 1700000000000,
    });
    const after = [...fs.store.keys()].filter(isReservedBackupPath).length;

    assert.equal(r.written, true, 'the rebuild wrote');
    assert.equal(after - before, 0, 'regenerating OUR OWN index must create NO sidecar');
    assert.equal(r.backups === undefined || r.backups.length === 0, true, 'and report no backup');
  });

  test('repeated clean rebuilds do NOT accumulate sidecars', async () => {
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') }, { casRouteUnusable: true });
    for (let i = 0; i < 4; i += 1) {
      fs.store.set(`wiki/a/page-${i}.md`, PAGE(`P${i}`)); // corpus drifts each round → stale
      await buildIndexForVault(VAULT, fs.deps, {
        automatic: true, requireScaffold: true, conditionalWrites: true, nowMs: 1700000000000 + i,
      });
    }
    const sidecars = [...fs.store.keys()].filter(isReservedBackupPath);
    assert.deepEqual(sidecars, [], 'four clean rebuilds must leave ZERO sidecars, not [1,2,3,4]');
  });

  test('the EXPLICIT build_search_index tool does not pollute either', async () => {
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') }, { casRouteUnusable: true });
    await buildIndexForVault(VAULT, fs.deps);
    fs.store.set('wiki/a/q.md', PAGE('Q'));
    const registry = { resolveVault: () => VAULT };
    const { buildSearchIndexTool } = await import('../src/tools/build-search-index.mjs');
    await buildSearchIndexTool(registry, {}, fs.deps);
    assert.deepEqual([...fs.store.keys()].filter(isReservedBackupPath), [], 'the explicit tool must not sidecar our own index');
  });

  test('indexContentIsOurs — tight catch (only parse errors are "not ours")', async () => {
    const { indexContentIsOurs } = await import('../src/tools/build-search-index.mjs');
    // A valid index of ours → ours.
    const ours = JSON.stringify({ version: 2, postings: {}, chunks: [], fingerprint: 'x' });
    assert.equal(indexContentIsOurs(ours), true);
    // Not JSON → a parse error IS swallowed → not ours.
    assert.equal(indexContentIsOurs('not json at all'), false);
    // Valid JSON that is not an index → not ours (no throw).
    assert.equal(indexContentIsOurs(JSON.stringify({ notAnIndex: 1 })), false);
    // A non-SyntaxError from the predicate must RE-THROW, never be swallowed —
    // this is the renforcement that would have exposed the missing import.
    const boom = new TypeError('simulated broken import');
    const orig = JSON.parse;
    JSON.parse = () => { throw boom; };
    try {
      assert.throws(() => indexContentIsOurs('anything'), (e) => e === boom);
    } finally {
      JSON.parse = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// H4 — the EXPLICIT apply is protected too
// ---------------------------------------------------------------------------

describe('H4 — an explicit refresh does not blindly clobber a file that appeared', () => {
  test('reduced explicit apply on a foreign overwrite path → backup, not blind overwrite', async () => {
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') }, { casRouteUnusable: true });
    fs.store.set('wiki/a/q.md', PAGE('Q')); // stale → overwrite planned
    const foreign = '# human\n';
    fs.swapOnRead.set('wiki/a/index.md', foreign); // ours at snapshot, foreign at late read

    const registry = { resolveVault: () => VAULT };
    const r = await refreshOkfProjectionsTool(registry, {}, { ...fs.deps, nowMs: 1700000000000 });

    // The explicit tool uses conditionalWrites → the foreign file is preserved.
    assert.ok(r.backups && r.backups.length >= 1, 'even an explicit refresh backs up a foreign file');
    assert.equal(fs.store.get(r.backups[0].backupPath), foreign);
  });
});

// ---------------------------------------------------------------------------
// (d) — the backup never becomes a projection or a corpus page
// ---------------------------------------------------------------------------

describe('the backup pollutes neither the projections nor the BM25 index', () => {
  test('a .bak sidecar is ignored by both walkers', async () => {
    const fs = conformant({ 'wiki/a/p.md': PAGE('P') });
    // Plant a backup sidecar next to a projection.
    fs.store.set('wiki/a/index.md.bak-2026-08-09T00-00-00-000Z', '# old foreign content\n');

    // Projections: a fresh refresh must not plan/delete/conflict on the .bak.
    const proj = await refreshProjectionsForVault(VAULT, fs.deps, { requireScaffold: true, now: '2026-08-08' });
    assert.equal(proj.plannedWrites.some(isReservedBackupPath), false);
    assert.equal(proj.plannedDeletes.some(isReservedBackupPath), false);
    assert.equal(proj.conflicts.some(isReservedBackupPath), false);

    // BM25: the index must not contain a chunk from the .bak.
    const idx = await buildIndexForVault(VAULT, fs.deps, { automatic: false });
    const raw = fs.store.get(SEARCH_INDEX_PATH);
    if (raw) {
      const parsed = JSON.parse(raw);
      assert.equal((parsed.chunks || []).some((c) => isReservedBackupPath(c.path)), false, 'no .bak chunk indexed');
    }
  });
});
