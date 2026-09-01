/**
 * A1 wiring — the two surfaces that carry the freshness verdict, and the
 * invariants that keep it from doing harm:
 *   - the SEMANTIC tier gets it; the BM25 tier keeps its own `index.freshness`
 *     and must never be given a second field meaning something else
 *   - a freshness failure must never fail a search
 *   - additive only: every pre-existing field keeps its shape
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { searchSmartTool } from '../src/tools/search-smart.mjs';
import { getWikiContextPack } from '../src/tools/get-wiki-context-pack.mjs';
import { TIER_SEMANTIC, TIER_LOCAL } from '../src/helpers/local-search.mjs';
import { buildSearchIndex } from '../src/helpers/bm25-index.mjs';
import { storeFileNameFor } from '../src/helpers/embedding-staleness.mjs';

const INDEXED_AT = 1_700_000_000_000;

function sourceLine(pagePath, { mtime, size } = {}) {
  return `"smart_sources:${pagePath}": ${JSON.stringify({
    last_embed: { hash: 'h', at: INDEXED_AT + 13_000 },
    last_import: { mtime: mtime ?? INDEXED_AT, size: size ?? 100, at: INDEXED_AT + 1, hash: 'h' },
  })},`;
}

/** A filesystem holding a store for `pages` and notes with the given stats. */
function fsFor(pages) {
  const files = {};
  const notes = {};
  for (const [p, spec] of Object.entries(pages)) {
    files[storeFileNameFor(p)] = sourceLine(p, spec.indexed);
    if (spec.note) notes[p] = spec.note;
  }
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    readdirSync: () => Object.keys(files),
    readFileSync: (fp) => {
      const name = String(fp).split(/[\\/]/).pop();
      if (!(name in files)) throw enoent();
      return files[name];
    },
    statSync: (fp) => {
      const norm = String(fp).replace(/\\/g, '/');
      // Store files are statted first for the byte cap.
      if (/\.smart-env\/multi\//.test(norm)) {
        const name = norm.split('/').pop();
        if (!(name in files)) throw enoent();
        return { size: files[name].length };
      }
      const rel = norm.replace(/^.*?vault\//, '');
      if (!(rel in notes)) throw enoent();
      return notes[rel];
    },
  };
}

const LOCAL = { name: 'v', type: 'local', path: '/vault' };
const REMOTE = { name: 'r', type: 'remote' };
const registryFor = (vault) => ({ resolveVault: () => vault, vaults: [vault], lockedVault: null });

/** A REAL index, built by the real builder — a hand-rolled one is refused. */
const INDEX = () => buildSearchIndex({
  pages: [{ path: 'wiki/x.md', content: '# X\n\nUn plugin REST pour la recherche.\n' }],
  vaultName: 'v',
});

describe('search_smart — the freshness block', () => {
  test('a semantic hit from an EDITED page is named, with counts', async () => {
    const out = await searchSmartTool(registryFor(LOCAL), { query: 'plugin REST' }, {
      searchSmart: async () => ({ results: [{ path: 'wiki/a.md', score: 0.9 }] }),
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: fsFor({
        'wiki/a.md': { indexed: { size: 100 }, note: { mtimeMs: INDEXED_AT + 86_400_000, size: 900 } },
      }),
    });
    assert.equal(out.tier, TIER_SEMANTIC);
    assert.equal(out.freshness.checkable, true);
    assert.equal(out.freshness.summary.changed, 1);
    assert.equal(out.freshness.summary.doubtful, 1);
    assert.match(out.freshness.note, /modified since indexing/);
  });

  test('everything current → a freshness block with no note (silence is a result)', async () => {
    const out = await searchSmartTool(registryFor(LOCAL), { query: 'plugin REST' }, {
      searchSmart: async () => ({ results: [{ path: 'wiki/a.md', score: 0.9 }] }),
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: fsFor({ 'wiki/a.md': { indexed: {}, note: { mtimeMs: INDEXED_AT, size: 100 } } }),
    });
    assert.equal(out.freshness.summary.doubtful, 0);
    assert.equal(out.freshness.note, undefined);
  });

  test('THE LOCAL BM25 TIER NEVER GETS THIS FIELD — it has its own `index.freshness`', async () => {
    // Two tiers sharing one field name for two different measurements is how a
    // reader ends up comparing incomparable things — the doctrine C4 is built on.
    const out = await searchSmartTool(registryFor(LOCAL), { query: 'plugin REST' }, {
      searchSmart: async () => {
        throw Object.assign(new Error('Smart Connections plugin is not available'), { status: 503 });
      },
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: fsFor({ 'wiki/x.md': { indexed: {}, note: { mtimeMs: INDEXED_AT + 999_999, size: 900 } } }),
    });
    assert.equal(out.tier, TIER_LOCAL);
    assert.equal(out.freshness, undefined, 'no top-level freshness on the BM25 tier');
    assert.ok(out.index.freshness, 'the BM25 tier keeps its own, differently-meant, freshness line');
  });

  test('an explicit tier:local carries no freshness block either', async () => {
    const out = await searchSmartTool(registryFor(LOCAL), { query: 'plugin REST', tier: 'local' }, {
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: fsFor({ 'wiki/x.md': { indexed: {}, note: { mtimeMs: INDEXED_AT, size: 100 } } }),
    });
    assert.equal(out.freshness, undefined);
  });

  test('a vault with no local disk DECLINES — no warning, and no silent implication of freshness', async () => {
    const out = await searchSmartTool(registryFor(REMOTE), { query: 'plugin REST' }, {
      searchSmart: async () => ({ results: [{ path: 'wiki/a.md', score: 0.9 }] }),
      getFileContent: async () => JSON.stringify(INDEX()),
    });
    assert.equal(out.freshness.checkable, false);
    assert.equal(out.freshness.reason, 'no-local-disk');
    assert.match(out.freshness.detail, /NOT evidence that the results are current/);
    assert.equal(out.freshness.pages, undefined);
  });

  test('a freshness failure NEVER fails the search', async () => {
    const hostile = {
      readdirSync() { throw new TypeError('boom'); },
      readFileSync() { throw new TypeError('boom'); },
      statSync() { throw new TypeError('boom'); },
    };
    const out = await searchSmartTool(registryFor(LOCAL), { query: 'plugin REST' }, {
      searchSmart: async () => ({ results: [{ path: 'wiki/a.md', score: 0.9 }] }),
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: hostile,
    });
    assert.equal(out.results.length, 1, 'the results survive');
  });

  test('results, tier and scoreScale keep their shape — the addition is additive', async () => {
    const out = await searchSmartTool(registryFor(LOCAL), { query: 'plugin REST' }, {
      searchSmart: async () => ({ results: [{ path: 'wiki/a.md', score: 0.9 }] }),
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: fsFor({ 'wiki/a.md': { indexed: {}, note: { mtimeMs: INDEXED_AT, size: 100 } } }),
    });
    assert.equal(out.scoreScale, 'cosine');
    assert.deepEqual(out.results, [{ path: 'wiki/a.md', score: 0.9 }]);
  });

  test('a bridge payload with no results array does not fabricate an assessment', async () => {
    const out = await searchSmartTool(registryFor(LOCAL), { query: 'plugin REST' }, {
      searchSmart: async () => ({ notResults: true }),
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: fsFor({ 'wiki/a.md': { indexed: {}, note: { mtimeMs: INDEXED_AT, size: 100 } } }),
    });
    assert.equal(out.freshness, undefined, 'nothing to assess → the key is simply absent');
  });
});

describe('get_wiki_context_pack — the freshness warning', () => {
  // The catalogue entry MATCHES the query on purpose: these tests are about
  // freshness, and a pack with no navigational anchor legitimately raises A3's
  // `answer-relies-on-semantic-only`, which would be noise here.
  const packDeps = (extra = {}) => ({
    getFileContent: async () => '# Catalog\n\n- [[plugins]] — the plugins page\n',
    getNote: async () => ({ content: 'body about plugins', frontmatter: {} }),
    searchSmart: async () => ({ results: [{ path: 'wiki/a.md', text: 'chunk', score: 0.8 }] }),
    ...extra,
  });

  test('a stale chunk raises the warning, annotates the chunk, and suggests an action', async () => {
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({
      fs: fsFor({
        'wiki/a.md': { indexed: { size: 100 }, note: { mtimeMs: INDEXED_AT + 86_400_000, size: 900 } },
      }),
    }));
    assert.ok(out.warnings.includes('semantic-results-possibly-stale'));
    assert.equal(out.semanticChunks[0].freshness, 'changed');
    assert.equal(out.suggestedActions.length, 1);
    assert.match(out.suggestedActions[0], /re-index/i);
    assert.equal(out.semanticFreshness.summary.changed, 1);
  });

  test('a current chunk raises nothing and is still annotated', async () => {
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({
      fs: fsFor({ 'wiki/a.md': { indexed: {}, note: { mtimeMs: INDEXED_AT, size: 100 } } }),
    }));
    assert.equal(out.warnings.includes('semantic-results-possibly-stale'), false);
    assert.equal(out.semanticChunks[0].freshness, 'fresh');
    assert.deepEqual(out.suggestedActions, []);
  });

  test('a chunk pointing at a DELETED page gets its own warning, not the stale one', async () => {
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({
      fs: fsFor({ 'wiki/a.md': { indexed: {} } }), // record present, note absent
    }));
    assert.ok(out.warnings.includes('semantic-hit-page-missing'));
    assert.equal(out.warnings.includes('semantic-results-possibly-stale'), false);
  });

  test('a remote vault emits NO freshness warning at all', async () => {
    const out = await getWikiContextPack(registryFor(REMOTE), { query: 'plugins' }, packDeps());
    assert.equal(out.warnings.includes('semantic-results-possibly-stale'), false);
    assert.equal(out.semanticChunks[0].freshness, undefined);
    assert.equal(out.semanticFreshness.checkable, false);
  });

  test('a freshness fault is NOT reported as a semantic-search failure', async () => {
    // Inside the try/catch it would have been — a wrong diagnosis written into
    // the envelope is exactly what this item exists to remove.
    const hostile = {
      readdirSync() { throw new TypeError('boom'); },
      readFileSync() { throw new TypeError('boom'); },
      statSync() { throw new TypeError('boom'); },
    };
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({ fs: hostile }));
    assert.equal(out.warnings.includes('semantic-search-failed'), false);
    assert.equal(out.semanticChunks.length, 1);
  });

  test('a successful-but-unreadable semantic payload is FLAGGED, not read as "found nothing"', async () => {
    // Found in adversarial review: a 200 the router cannot parse was coerced to
    // an empty chunk list and reported as a search that ran and found nothing.
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({
      searchSmart: async () => ({ error: 'index still loading' }),
      fs: fsFor({}),
    }));
    assert.ok(out.warnings.includes('semantic-payload-unrecognised'));
    assert.deepEqual(out.semanticChunks, []);
  });

  test('an ENTRY that is neither a path nor text is flagged too, not turned into a chunk', async () => {
    // Round 2: the container was checked, its members were not — so
    // `{results: [{unexpected: true}]}` became a fabricated empty chunk.
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({
      searchSmart: async () => ({ results: [{ unexpected: true }] }),
      fs: fsFor({}),
    }));
    assert.ok(out.warnings.includes('semantic-payload-unrecognised'));
    assert.deepEqual(out.semanticChunks, []);
  });

  test('an ANCHORED chunk is annotated — the row is keyed by page, the chunk by section', async () => {
    // Round 2: rows collapse to the page, chunks keep their `#Heading`, so the
    // join by exact path silently dropped the annotation while the top-level
    // warning still fired.
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({
      searchSmart: async () => ({ results: [{ path: 'wiki/a.md#Some heading', text: 'c', score: 0.8 }] }),
      fs: fsFor({
        'wiki/a.md': { indexed: { size: 100 }, note: { mtimeMs: INDEXED_AT + 86_400_000, size: 900 } },
      }),
    }));
    assert.ok(out.warnings.includes('semantic-results-possibly-stale'));
    assert.equal(out.semanticChunks[0].freshness, 'changed', 'the chunk that caused the warning carries it');
  });

  test('a chunk whose path needed NORMALISING still gets its annotation', async () => {
    // Found in the A3 review: the assessor canonicalises `wiki//a.md` to
    // `wiki/a.md` and keyed its row by the canonical spelling, so the join —
    // which holds the raw one — found nothing. The warning fired while the
    // chunk that caused it carried no `freshness` at all.
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({
      searchSmart: async () => ({ results: [{ path: 'wiki//a.md', text: 'c', score: 0.8 }] }),
      fs: fsFor({
        'wiki/a.md': { indexed: { size: 100 }, note: { mtimeMs: INDEXED_AT + 86_400_000, size: 900 } },
      }),
    }));
    assert.ok(out.warnings.includes('semantic-results-possibly-stale'));
    assert.equal(out.semanticChunks[0].freshness, 'changed');
  });

  test('a well-formed EMPTY result is NOT flagged — it is a real answer', async () => {
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({
      searchSmart: async () => ({ results: [] }),
      fs: fsFor({}),
    }));
    assert.equal(out.warnings.includes('semantic-payload-unrecognised'), false);
  });

  test('no semantic chunks → no freshness key, and the v1 envelope is otherwise intact', async () => {
    const out = await getWikiContextPack(registryFor(LOCAL), { query: 'plugins' }, packDeps({
      searchSmart: async () => ({ results: [] }),
      fs: fsFor({}),
    }));
    assert.equal(out.semanticFreshness, undefined);
    for (const k of ['version', 'query', 'vault', 'primaryPages', 'semanticChunks',
      'graphNeighbors', 'citations', 'warnings', 'suggestedActions']) {
      assert.ok(k in out, `v1 mandatory field ${k} still present`);
    }
  });
});
