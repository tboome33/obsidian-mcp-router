/**
 * C4 — the default folder exclusion on semantic search.
 *
 * The default is measured, not guessed: the roadmap proposed `.trash` and
 * `Templates`, neither of which exists on this fleet, while `wiki-meta/Sessions`
 * accounts for 1212 of 2915 indexed pages (41.6%). A cut that large is never
 * applied silently — every response says what was excluded, who chose it, and
 * what it cost.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXCLUDE_FOLDERS,
  EXCLUDE_ENV,
  resolveExcludeFolders,
  partitionByFolders,
  underAnyFolder,
  exclusionReport,
} from '../src/helpers/search-exclusions.mjs';
import { searchSmartTool } from '../src/tools/search-smart.mjs';
import { getWikiContextPack } from '../src/tools/get-wiki-context-pack.mjs';
import { buildSearchIndex } from '../src/helpers/bm25-index.mjs';
import { TIER_SEMANTIC, TIER_LOCAL } from '../src/helpers/local-search.mjs';

describe('resolveExcludeFolders — who decided, and what', () => {
  test('omitted → the measured default, marked as chosen by default', () => {
    const r = resolveExcludeFolders(undefined, {});
    assert.deepEqual(r.folders, [...DEFAULT_EXCLUDE_FOLDERS]);
    assert.equal(r.source, 'default');
  });

  test('the default is ONE folder — the three no-op candidates are not shipped', () => {
    // A default that excludes nothing is worse than no default: it reads as
    // protection. `wiki-meta/graph`, `wiki-meta/digests` and `wiki-meta/presence`
    // measured zero indexed pages on zero vaults, so they are absent.
    assert.deepEqual([...DEFAULT_EXCLUDE_FOLDERS], ['wiki-meta/Sessions']);
    for (const guessed of ['.trash', 'Templates', 'wiki-meta/graph', 'wiki-meta/digests']) {
      assert.equal(DEFAULT_EXCLUDE_FOLDERS.includes(guessed), false, `${guessed} was never measured`);
    }
  });

  test('an explicit array WINS over the default', () => {
    const r = resolveExcludeFolders(['Drafts'], {});
    assert.deepEqual(r.folders, ['Drafts']);
    assert.equal(r.source, 'caller');
  });

  test('an EXPLICIT EMPTY ARRAY means "exclude nothing" — not "unset"', () => {
    // Treating [] as absent would make opting out of the default impossible.
    const r = resolveExcludeFolders([], {});
    assert.deepEqual(r.folders, []);
    assert.equal(r.source, 'none');
  });

  test('the env override replaces the default, and an empty value disables it', () => {
    const set = resolveExcludeFolders(undefined, { [EXCLUDE_ENV]: 'Logs, Scratch/tmp ' });
    assert.deepEqual(set.folders, ['Logs', 'Scratch/tmp']);
    assert.equal(set.source, 'default');
    const off = resolveExcludeFolders(undefined, { [EXCLUDE_ENV]: '' });
    assert.deepEqual(off.folders, []);
    assert.equal(off.source, 'none');
  });

  test('folders are normalised — separators and stray slashes do not create misses', () => {
    const r = resolveExcludeFolders(['/a/b/', 'c\\d'], {});
    assert.deepEqual(r.folders, ['a/b', 'c/d']);
  });

  test('a non-array, non-string argument falls through to the default', () => {
    assert.equal(resolveExcludeFolders(null, {}).source, 'default');
    assert.equal(resolveExcludeFolders('Drafts', {}).source, 'default');
  });
});

describe('underAnyFolder / partitionByFolders', () => {
  test('a folder prefix matches the folder and its descendants, not a lookalike', () => {
    assert.equal(underAnyFolder('wiki-meta/Sessions/a.md', ['wiki-meta/Sessions']), true);
    assert.equal(underAnyFolder('wiki-meta/Sessions', ['wiki-meta/Sessions']), true);
    assert.equal(underAnyFolder('wiki-meta/SessionsArchive/a.md', ['wiki-meta/Sessions']), false);
    assert.equal(underAnyFolder('wiki/Sessions/a.md', ['wiki-meta/Sessions']), false);
  });

  test('a result with NO path is KEPT — "I cannot tell" is not "it is excluded"', () => {
    const { kept, excluded } = partitionByFolders(
      [{ text: 'no path here' }, { path: 'wiki-meta/Sessions/x.md' }],
      ['wiki-meta/Sessions'],
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].text, 'no path here');
    assert.equal(excluded, 1);
  });

  test('no folders → the array is returned untouched and nothing is counted', () => {
    const results = [{ path: 'a.md' }];
    const out = partitionByFolders(results, []);
    assert.equal(out.kept, results);
    assert.equal(out.excluded, 0);
  });
});

describe('exclusionReport — the cut is legible or it does not happen', () => {
  test('names the folders, who chose them, and what it cost', () => {
    const r = exclusionReport({ folders: ['wiki-meta/Sessions'], source: 'default', excluded: 4 });
    assert.deepEqual(r.folders, ['wiki-meta/Sessions']);
    assert.equal(r.chosenBy, 'default');
    assert.equal(r.excludedHits, 4);
    assert.match(r.note, /excludeFolders: \[\]/);
  });

  test('a caller-chosen exclusion is not presented as the tool\'s own default', () => {
    const r = exclusionReport({ folders: ['X'], source: 'caller', excluded: 0 });
    assert.equal(r.chosenBy, 'caller');
    assert.match(r.note, /Chosen by the caller/);
  });

  test('nothing excluded and no default in force → nothing to report', () => {
    assert.equal(exclusionReport({ folders: [], source: 'none', excluded: 0 }), null);
  });
});

// --------------------------------------------------------------------------

const VAULT = { name: 'v', type: 'local', path: '/vault' };
const registry = { resolveVault: () => VAULT, vaults: [VAULT], lockedVault: null };
const noStore = { readdirSync: () => { throw new Error('ENOENT'); }, readFileSync: () => '', statSync: () => ({ size: 0 }) };

const HITS = () => ({
  results: [
    { path: 'wiki/real.md', score: 0.9 },
    { path: 'wiki-meta/Sessions/2026-01-01.md', score: 0.88 },
    { path: 'wiki-meta/Sessions/2026-01-02.md', score: 0.87 },
  ],
});

const INDEX = () => buildSearchIndex({
  pages: [
    { path: 'wiki/real.md', content: '# Real\n\nUn plugin REST pour la recherche.\n' },
    { path: 'wiki-meta/Sessions/s1.md', content: '# S1\n\nUn plugin REST, notes de session.\n' },
  ],
  vaultName: 'v',
});

describe('search_smart — the default applied for real', () => {
  test('session logs are dropped by default, and the response says so', async () => {
    const out = await searchSmartTool(registry, { query: 'plugin REST' }, {
      searchSmart: async () => HITS(),
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: noStore,
      env: {},
    });
    assert.equal(out.tier, TIER_SEMANTIC);
    assert.deepEqual(out.results.map((r) => r.path), ['wiki/real.md']);
    assert.equal(out.folderExclusion.chosenBy, 'default');
    assert.equal(out.folderExclusion.excludedHits, 2);
  });

  test('`excludeFolders: []` restores them — the opt-out actually opts out', async () => {
    const out = await searchSmartTool(registry, { query: 'plugin REST', excludeFolders: [] }, {
      searchSmart: async () => HITS(),
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: noStore,
      env: {},
    });
    assert.equal(out.results.length, 3);
    assert.equal(out.folderExclusion, undefined, 'nothing excluded → nothing to report');
  });

  test('an explicit exclusion replaces the default rather than adding to it', async () => {
    const out = await searchSmartTool(registry, { query: 'plugin REST', excludeFolders: ['wiki'] }, {
      searchSmart: async () => HITS(),
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: noStore,
      env: {},
    });
    assert.deepEqual(
      out.results.map((r) => r.path),
      ['wiki-meta/Sessions/2026-01-01.md', 'wiki-meta/Sessions/2026-01-02.md'],
    );
    assert.equal(out.folderExclusion.chosenBy, 'caller');
  });

  test('THE FILTER IS ROUTER-SIDE — a bridge that ignores the parameter cannot defeat it', async () => {
    // Whether Smart Connections honours `excludeFolders` could not be verified
    // (the plugin was offline). A default whose effect depends on an unverified
    // remote behaviour is not a default.
    let sawFilter = null;
    const out = await searchSmartTool(registry, { query: 'plugin REST' }, {
      searchSmart: async (_v, _q, filter) => { sawFilter = filter; return HITS(); },
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: noStore,
      env: {},
    });
    assert.deepEqual(sawFilter.excludeFolders, ['wiki-meta/Sessions'], 'forwarded as a hint');
    assert.deepEqual(out.results.map((r) => r.path), ['wiki/real.md'], 'and enforced here');
  });

  test('the overfetch SCALES with the limit, not a flat +10', async () => {
    // A constant margin was sized for the archive filter, which removes a
    // handful of pages. This default removes 41.6% of the corpus: with limit 5
    // and eleven excluded hits at the top, a +10 margin returned four results
    // while eligible matches sat just past the window (found in review).
    let asked = null;
    await searchSmartTool(registry, { query: 'plugin REST', limit: 5 }, {
      searchSmart: async (_v, _q, filter) => { asked = filter.limit; return HITS(); },
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: noStore,
      env: {},
    });
    assert.ok(asked >= 20, `asked the bridge for ${asked}, which must scale past the flat +10`);
  });

  test('a page still short after the overfetch SAYS it is short — it never looks full', async () => {
    // The over-fetch makes the common case whole; it cannot guarantee it, and no
    // backend here takes an offset to refill from. So the response admits it.
    const many = { results: Array.from({ length: 30 }, (_, i) => ({ path: `wiki-meta/Sessions/s${i}.md`, score: 0.9 })) };
    many.results.push({ path: 'wiki/real.md', score: 0.5 });
    const out = await searchSmartTool(registry, { query: 'plugin REST', limit: 5 }, {
      searchSmart: async () => many,
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: noStore,
      env: {},
    });
    assert.ok(out.results.length < 5);
    assert.equal(out.folderExclusion.shortPage, true);
    assert.match(out.folderExclusion.shortPageNote, /cannot be refilled/);
  });

  test('a `filename`-shaped hit is excluded too — the bridge cannot slip past the router', async () => {
    // Found in review: only `path` was read, so a hit shaped
    // `{filename: 'wiki-meta/Sessions/a.md'}` — a shape the click-to-open walker
    // and the context pack both already recognise — defeated the enforcement.
    const out = await searchSmartTool(registry, { query: 'plugin REST' }, {
      searchSmart: async () => ({
        results: [{ filename: 'wiki-meta/Sessions/a.md', score: 0.9 }, { path: 'wiki/real.md', score: 0.5 }],
      }),
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: noStore,
      env: {},
    });
    assert.deepEqual(out.results.map((r) => r.path ?? r.filename), ['wiki/real.md']);
    assert.equal(out.folderExclusion.excludedHits, 1);
  });

  test('THE BM25 TIER GETS THE SAME EXCLUSION — a fallback must not surface what the tier it replaced hid', async () => {
    const out = await searchSmartTool(registry, { query: 'plugin REST' }, {
      searchSmart: async () => {
        throw Object.assign(new Error('Smart Connections plugin is not available'), { status: 503 });
      },
      getFileContent: async () => JSON.stringify(INDEX()),
      fs: noStore,
      env: {},
    });
    assert.equal(out.tier, TIER_LOCAL);
    assert.equal(out.results.some((r) => r.path.startsWith('wiki-meta/Sessions/')), false);
    assert.equal(out.folderExclusion.chosenBy, 'default');
    assert.equal(out.folderExclusion.excludedHits, 1);
  });
});

describe('get_wiki_context_pack — the same default, so the two tools agree', () => {
  const deps = (extra = {}) => ({
    getFileContent: async () => '# Catalog\n\n- [[plugins]] — the plugins page\n',
    getNote: async () => ({ content: 'about plugins', frontmatter: {} }),
    searchSmart: async () => HITS(),
    fs: noStore,
    env: {},
    ...extra,
  });

  test('the pack drops session logs too — it calls the REST helper directly, so it needs its own cut', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    assert.deepEqual(out.semanticChunks.map((c) => c.path), ['wiki/real.md']);
    assert.equal(out.folderExclusion.chosenBy, 'default');
    assert.equal(out.folderExclusion.excludedHits, 2);
  });

  test('`excludeFolders: []` opts out here as well', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins', excludeFolders: [] }, deps());
    assert.equal(out.semanticChunks.length, 3);
    assert.equal(out.folderExclusion, undefined);
  });

  test('the pack OVER-FETCHES too — asking for exactly the cap returned a short pack', async () => {
    let asked = null;
    await getWikiContextPack(registry, { query: 'plugins', maxSemanticChunks: 5 }, deps({
      searchSmart: async (_v, _q, a) => { asked = a.limit; return HITS(); },
    }));
    assert.ok(asked > 5, `asked for ${asked}, more than the cap of 5`);
  });

  test('the pack drops ARCHIVED deliberation as well — the two tools stop disagreeing', async () => {
    // `search_smart` has excluded `archives/` since v0.54.0; this path calls the
    // REST helper directly and never did, so the same vault answered differently
    // through the two tools (found in review).
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps({
      searchSmart: async () => ({
        results: [
          { path: 'wiki/decisions/archives/old-debate.md', score: 0.95 },
          { path: 'wiki/real.md', score: 0.5 },
        ],
      }),
    }));
    assert.deepEqual(out.semanticChunks.map((c) => c.path), ['wiki/real.md']);
    assert.equal(out.archivesExcluded, 1);
  });

  test('maxSemanticChunks: 0 reports no exclusion — nothing was queried, so nothing was cut', async () => {
    const out = await getWikiContextPack(registry, { query: 'plugins', maxSemanticChunks: 0 }, deps());
    assert.equal(out.folderExclusion, undefined);
  });

  test('the exclusion does NOT raise the unrecognised-payload warning', async () => {
    // Excluded hits are removed on purpose; they are not malformed entries.
    const out = await getWikiContextPack(registry, { query: 'plugins' }, deps());
    assert.equal(out.warnings.includes('semantic-payload-unrecognised'), false);
  });
});
