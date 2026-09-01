/**
 * C4 (local deterministic BM25 tier) + C5 (contextual chunk headers).
 *
 * The four properties the §2.17 spec demands, proven here:
 *   1. DETERMINISM — same corpus + same query ⇒ same ranking, and an unchanged
 *      vault rebuilds to a byte-identical index.
 *   2. NEVER-MIXED FALLBACK — a search resolves to exactly ONE tier, which it
 *      names; the degrade fires only on a capability gap, never on an empty
 *      semantic answer or a transport/auth failure.
 *   3. ACTIONABLE DIAGNOSTICS — an absent/foreign index is a refusal naming the
 *      rebuild command, never a bare empty list.
 *   4. QUERY BOUNDS — over-long / tokenless / over-tokenised queries are
 *      refused with a reason.
 * Plus C5: every chunk carries title · description · section path, and a query
 * matching only the page's metadata still reaches its chunks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  chunkPage,
  buildChunkHeader,
  buildSearchIndex,
  corpusFingerprint,
  queryIndex,
  validateQuery,
  clampLimit,
  isUsableIndex,
  absentIndexMessage,
  unusableIndexMessage,
  rebuildHint,
  INDEX_VERSION,
  SEARCH_INDEX_PATH,
  MAX_QUERY_TOKENS,
  MAX_CHUNK_TOKENS,
} from '../src/helpers/bm25-index.mjs';
import {
  searchLocalIndex,
  isSemanticTierUnusable,
  TIER_SEMANTIC,
  TIER_LOCAL,
} from '../src/helpers/local-search.mjs';
import { buildIndexForVault } from '../src/tools/build-search-index.mjs';
import { searchSmartTool } from '../src/tools/search-smart.mjs';
import { MAX_OVERFETCH } from '../src/helpers/search-exclusions.mjs';

// --- fixtures ---------------------------------------------------------------

const PAGE = (title, description, body) =>
  `---\ntype: note\ntitle: "${title}"\ndescription: "${description}"\n---\n\n${body}`;

const CORPUS = [
  {
    path: 'wiki/moteur/bm25.md',
    content: PAGE(
      'Recherche BM25',
      'Le classement par pertinence des moteurs de recherche',
      '# Recherche BM25\n\nBM25 classe les documents selon le poids discriminant des termes.\n\n## Formule\n\nLa saturation utilise le paramètre k1 et la normalisation utilise le paramètre b.\n\n```js\nconst k1 = 1.2;\n```\n',
    ),
  },
  {
    path: 'wiki/outils/obsidian.md',
    content: PAGE('Obsidian', 'Notes markdown stockées en local', '# Obsidian\n\nObsidian stocke des notes markdown sur le disque.\n\n## Plugins\n\nLe plugin Local REST API expose le vault aux outils externes.\n'),
  },
  {
    path: 'wiki/moteur/concurrence.md',
    content: PAGE('Concurrence optimiste', 'Refuser une écriture si le fichier a changé', '# Concurrence\n\nUne empreinte refuse une écriture concurrente sur un fichier modifié entre-temps.\n'),
  },
  {
    path: 'wiki/moteur/archives/vieux-debat.md',
    content: PAGE('Vieux débat BM25', 'Chronique archivée', '# Débat\n\nLongue délibération archivée à propos de BM25 et du classement.\n'),
  },
];

const index = () => buildSearchIndex({ pages: CORPUS, vaultName: 'v' });

// --- C5: contextual chunk headers -------------------------------------------

describe('C5 — contextual chunk headers', () => {
  test('every chunk carries title, description and its heading path', () => {
    const chunks = chunkPage({ path: CORPUS[0].path, content: CORPUS[0].content });
    assert.ok(chunks.length >= 2, 'the page has at least two sections');
    for (const c of chunks) {
      assert.equal(c.title, 'Recherche BM25');
      assert.equal(c.description, 'Le classement par pertinence des moteurs de recherche');
      assert.match(c.header, /^Recherche BM25 · Le classement/);
    }
    const sections = chunks.map((c) => c.section);
    assert.ok(sections.includes('Recherche BM25'), 'top section present');
    assert.ok(sections.includes('Recherche BM25::Formule'), 'nested section path uses ::');
  });

  test('the header is INDEXED: a query matching only the description reaches the page', () => {
    // "pertinence" appears in the frontmatter description only — never in the body.
    assert.ok(!CORPUS[0].content.split('---')[2].includes('pertinence'));
    const hits = queryIndex({ index: index(), query: 'pertinence moteurs', limit: 5 }).hits;
    assert.ok(hits.length > 0, 'metadata-only query must still hit');
    assert.ok(hits.every((h) => h.path === 'wiki/moteur/bm25.md'));
  });

  test('a fenced code block is never split across chunks', () => {
    const chunks = chunkPage({ path: CORPUS[0].path, content: CORPUS[0].content });
    const withCode = chunks.filter((c) => c.text.includes('```'));
    assert.equal(withCode.length, 1, 'the fence lives in exactly one chunk');
    const fenceCount = (withCode[0].text.match(/```/g) || []).length;
    assert.equal(fenceCount, 2, 'both fence markers stay together');
  });

  test('a page with metadata but no body is still findable', () => {
    const chunks = chunkPage({ path: 'wiki/vide.md', content: PAGE('Page vide', 'Une description seule', '') });
    assert.equal(chunks.length, 1);
    assert.match(chunks[0].header, /Page vide · Une description seule/);
  });

  test('a YAML block-scalar description is RECOVERED, not dropped and never indexed as "|"', () => {
    // `description: |` + an indented block: the shared line-oriented parser
    // returns the indicator, not the text. Dropping it would put no stray pipe
    // in the header but would silently lose the description — a page becomes
    // unfindable by its own summary, breaking C5's contract.
    const withBlock = '---\nname: x\ndescription: |\n  Un résumé pédagogique du sujet.\n  Deuxième ligne du résumé.\n---\n\n# Titre\n\nDu corps.\n';
    const [chunk] = chunkPage({ path: 'wiki/x.md', content: withBlock });
    assert.ok(!chunk.header.includes('|'), `header must not carry a block indicator: ${chunk.header}`);
    assert.match(chunk.description, /Un résumé pédagogique du sujet/);
    assert.match(chunk.description, /Deuxième ligne/);
    // …and the recovered text is genuinely searchable (the point of C5).
    const idx = buildSearchIndex({ pages: [{ path: 'wiki/x.md', content: withBlock }], vaultName: 'v' });
    const hits = queryIndex({ index: idx, query: 'résumé pédagogique', limit: 3 }).hits;
    assert.equal(hits.length > 0, true, 'the recovered description must be searchable');
  });

  test('block-scalar VARIANTS are recovered: |2- (digit+chomping) and >- with a comment', () => {
    // Post-release Codex, v0.63.1: these two legal YAML forms leaked their
    // indicator into the header as a literal description.
    const digitChomp = '---\ndescription: |2-\n  Texte du bloc indenté.\n---\n\n# T\n\nCorps.\n';
    const c1 = chunkPage({ path: 'wiki/v1.md', content: digitChomp })[0];
    assert.equal(c1.description, 'Texte du bloc indenté.');
    const foldedComment = '---\ndescription: >- # commentaire\n  ligne un\n  ligne deux\n---\n\n# T\n\nCorps.\n';
    const c2 = chunkPage({ path: 'wiki/v2.md', content: foldedComment })[0];
    assert.equal(c2.description, 'ligne un ligne deux');
    for (const c of [c1, c2]) assert.ok(!/[|>]/.test(c.header), `no indicator may leak into the header: ${c.header}`);
  });

  test('a folded (>) block scalar joins on spaces; an absent description stays absent', () => {
    const folded = '---\ndescription: >\n  ligne un\n  ligne deux\n---\n\n# T\n\nCorps.\n';
    assert.equal(chunkPage({ path: 'wiki/f.md', content: folded })[0].description, 'ligne un ligne deux');
    const none = '---\ntype: note\n---\n\n# T\n\nCorps.\n';
    const c = chunkPage({ path: 'wiki/n.md', content: none })[0];
    assert.equal(c.description, '');
    assert.equal(c.header, 'T · T');
  });

  test('the folded multi-line quoted description (the fleet house style) is kept whole', () => {
    const folded = '---\ntype: roadmap\ndescription: "Première ligne du résumé,\n  suite du résumé sur une deuxième ligne."\n---\n\n# Titre\n\nCorps.\n';
    const [chunk] = chunkPage({ path: 'wiki/y.md', content: folded });
    assert.match(chunk.description, /Première ligne du résumé, suite du résumé/);
    assert.match(chunk.header, /Première ligne/);
  });

  test('buildChunkHeader omits absent parts (no dangling separators)', () => {
    assert.equal(buildChunkHeader({ title: 'T', description: '', section: '' }), 'T');
    assert.equal(buildChunkHeader({ title: 'T', description: 'D', section: 'S' }), 'T · D · S');
  });
});

// --- C4: determinism --------------------------------------------------------

describe('C4 — determinism', () => {
  test('the same corpus builds a byte-identical index regardless of walk order', () => {
    const a = buildSearchIndex({ pages: CORPUS, vaultName: 'v' });
    const b = buildSearchIndex({ pages: [...CORPUS].reverse(), vaultName: 'v' });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('the same query returns the same ranking every time', () => {
    const idx = index();
    const once = queryIndex({ index: idx, query: 'classement des termes', limit: 5 }).hits;
    const twice = queryIndex({ index: idx, query: 'classement des termes', limit: 5 }).hits;
    assert.deepEqual(once, twice);
  });

  test('the fingerprint changes iff the corpus changes', () => {
    const same = corpusFingerprint([...CORPUS].reverse());
    assert.equal(corpusFingerprint(CORPUS), same, 'order-independent');
    const edited = CORPUS.map((p, i) => (i === 0 ? { ...p, content: `${p.content}\nune phrase de plus.\n` } : p));
    assert.notEqual(corpusFingerprint(CORPUS), corpusFingerprint(edited));
  });

  test('no clock leaks into the index (a rebuild is idempotent)', () => {
    const json = JSON.stringify(index());
    assert.ok(!/\b20\d{2}-\d{2}-\d{2}T/.test(json), 'no ISO timestamp in the payload');
  });
});

// --- C4: ranking sanity + query bounds --------------------------------------

describe('C4 — ranking and bounds', () => {
  test('a discriminating term ranks its own page first', () => {
    const hits = queryIndex({ index: index(), query: 'saturation paramètre', limit: 3 }).hits;
    assert.equal(hits[0].path, 'wiki/moteur/bm25.md');
    assert.equal(hits[0].section, 'Recherche BM25::Formule');
  });

  test('a query matching nothing returns an empty ranking (not an error)', () => {
    const r = queryIndex({ index: index(), query: 'zzzunmatchable', limit: 5 });
    assert.deepEqual(r.hits, []);
    assert.equal(r.scored, 0);
  });

  test('bounds: empty / tokenless / over-long / over-tokenised queries are refused with a reason', () => {
    assert.equal(validateQuery('   ').reason, 'empty-query');
    assert.equal(validateQuery('a b').reason, 'no-usable-tokens');
    assert.equal(validateQuery('x'.repeat(1001)).reason, 'query-too-long');
    const many = Array.from({ length: MAX_QUERY_TOKENS + 1 }, (_, i) => `terme${i}`).join(' ');
    assert.equal(validateQuery(many).reason, 'too-many-tokens');
    assert.equal(validateQuery('recherche bm25').ok, true);
  });

  test('queryIndex throws (never silently empties) on an out-of-bounds query', () => {
    assert.throws(() => queryIndex({ index: index(), query: 'a' }), /no usable term/i);
  });

  test('limit is clamped into [1, 100]', () => {
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(1e6), 100);
    assert.equal(clampLimit(undefined), 10);
    assert.equal(clampLimit('5'), 5);
  });

  test('a foreign index version is refused rather than scored', () => {
    assert.equal(isUsableIndex({ ...index(), version: INDEX_VERSION + 1 }), false);
    assert.equal(isUsableIndex(index()), true);
  });

  test('a desynchronised index (chunks reordered, postings untouched) is REFUSED', () => {
    // No corpus fingerprint can catch this — the corpus never changed — so
    // without a self-digest the builder reports "current" and queries return
    // unrelated pages forever (Codex verification).
    const tampered = { ...index() };
    tampered.chunks = [...tampered.chunks].reverse();
    assert.equal(isUsableIndex(tampered), false);
  });

  test('a non-empty index with emptied postings/idf is REFUSED, not silently barren', () => {
    const idx = index();
    assert.equal(isUsableIndex({ ...idx, postings: {} }), false);
    assert.equal(isUsableIndex({ ...idx, idf: {} }), false);
  });

  test('the chunk-token bound is actually enforced on an oversized single block', () => {
    // One wall-of-text paragraph used to sail through whole, so the advertised
    // MAX_CHUNK_TOKENS was a lie and one chunk could dwarf avgdl (Codex).
    const huge = Array.from({ length: 600 }, (_, i) => `terme${i % 97}`).join(' ');
    const chunks = chunkPage({ path: 'wiki/gros.md', content: PAGE('Gros', 'Un pavé', `# Gros\n\n${huge}\n`) });
    assert.ok(chunks.length > 1, 'the oversized block must be subdivided');
    for (const c of chunks) {
      assert.ok(c.tokens.length <= MAX_CHUNK_TOKENS * 1.5, `chunk of ${c.tokens.length} tokens exceeds the bound`);
    }
  });

  test('a fenced code block stays atomic even when oversized', () => {
    const bigCode = Array.from({ length: 400 }, (_, i) => `const variable${i} = ${i};`).join('\n');
    const chunks = chunkPage({ path: 'wiki/code.md', content: PAGE('Code', 'Du code', `# Code\n\n\`\`\`js\n${bigCode}\n\`\`\`\n`) });
    const fenced = chunks.filter((c) => c.text.includes('```'));
    assert.equal(fenced.length, 1, 'the fence is never split into invalid fragments');
  });

  test('METADATA is inside the digest: a copied fingerprint or a flipped truncated flag is refused', () => {
    // Post-release Codex, v0.63.1: with only the scored payload digested, a
    // STALE index whose `fingerprint` was hand-set to the current corpus value
    // passed as `current` forever, and `stats.truncated: false` silenced the
    // incompleteness warning. Both are now integrity failures.
    const idx = index();
    const fpTampered = JSON.parse(JSON.stringify(idx));
    fpTampered.fingerprint = 'f'.repeat(64);
    assert.equal(isUsableIndex(fpTampered), false, 'fingerprint tamper must be refused');
    const statsTampered = JSON.parse(JSON.stringify(idx));
    statsTampered.stats = { ...statsTampered.stats, truncated: !statsTampered.stats.truncated };
    assert.equal(isUsableIndex(statsTampered), false, 'stats tamper must be refused');
  });

  test('punctuation-separated monster line respects the chunk-token bound', () => {
    // 500 comma-separated terms, ZERO whitespace — one "word" for the
    // whitespace-level splitter, which sailed through as a 501-token chunk
    // (post-release Codex, v0.63.1). Level-3 token-run splitting bounds it.
    const monster = Array.from({ length: 500 }, (_, i) => `terme${i}`).join(',');
    const chunks = chunkPage({ path: 'wiki/m.md', content: PAGE('M', 'd', `# M\n\n${monster}\n`) });
    assert.ok(chunks.length > 1, 'the comma monster must be subdivided');
    for (const c of chunks) {
      assert.ok(c.tokens.length <= MAX_CHUNK_TOKENS * 1.5, `chunk of ${c.tokens.length} tokens exceeds the bound`);
    }
  });

  test('a giant single token is dropped from the vocabulary, not indexed as a 10k key', () => {
    // A 10k-char alphanumeric run can never be matched by a bounded query —
    // indexing it is pure bloat (post-release Codex, v0.63.1).
    const giant = 'x'.repeat(10000);
    const idx = buildSearchIndex({ pages: [{ path: 'wiki/g.md', content: PAGE('G', 'd', `# G\n\nmot normal ${giant} autre contenu\n`) }], vaultName: 'v' });
    assert.ok(Object.keys(idx.postings).every((k) => k.length <= 200), 'no oversized postings key');
    const hits = queryIndex({ index: idx, query: 'autre contenu normal', limit: 3 }).hits;
    assert.ok(hits.length > 0, 'the surrounding real content stays findable');
  });

  test('a BOM-only change is a REAL change: the fingerprint must not collide', () => {
    // C1's contentSha256 strips a leading BOM (so two read paths agree); reusing
    // it here made a BOM-added file hash "unchanged" while parsing differently,
    // so the builder skipped rewriting a genuinely stale index (Codex).
    const plain = [{ path: 'wiki/a.md', content: PAGE('A', 'D', '# A\n\nCorps.\n') }];
    const bommed = [{ path: 'wiki/a.md', content: `﻿${plain[0].content}` }];
    assert.notEqual(corpusFingerprint(plain), corpusFingerprint(bommed));
  });
});

// --- C4: actionable diagnostics ---------------------------------------------

describe('C4 — actionable diagnostics', () => {
  test('absent / foreign-version messages name the rebuild tool and the index path', () => {
    const absent = absentIndexMessage('monvault');
    assert.match(absent, /build_search_index/);
    assert.match(absent, new RegExp(SEARCH_INDEX_PATH.replace('/', '\\/')));
    assert.match(unusableIndexMessage('monvault', { version: 99 }), /build_search_index/);
    assert.match(rebuildHint('monvault'), /build_search_index/);
  });

  test('searchLocalIndex REFUSES (not empty list) when no index exists', async () => {
    const deps = { getFileContent: async () => { throw Object.assign(new Error('404'), { kind: 'not_found' }); } };
    await assert.rejects(
      () => searchLocalIndex({ name: 'monvault' }, deps, { query: 'recherche' }),
      (e) => /No local search index/.test(e.message) && /build_search_index/.test(e.message),
    );
  });

  test('searchLocalIndex refuses an unparseable index instead of scoring garbage', async () => {
    const deps = { getFileContent: async () => 'not json{' };
    await assert.rejects(
      () => searchLocalIndex({ name: 'v' }, deps, { query: 'recherche' }),
      /refuses to score|version/i,
    );
  });

  test('an EMPTY (0-chunk) index REFUSES — it is a layout problem, not "nothing matches"', async () => {
    // A vault with no `wiki/` builds a well-formed but empty index; serving []
    // from it is indistinguishable from a genuine no-match (Fable 5 review).
    const empty = buildSearchIndex({ pages: [], vaultName: 'v' });
    assert.equal(empty.chunks.length, 0);
    await assert.rejects(
      () => searchLocalIndex({ name: 'v' }, { getFileContent: async () => JSON.stringify(empty) }, { query: 'recherche' }),
      (e) => /EMPTY/.test(e.message) && /build_search_index/.test(e.message) && e.reason === 'index-empty',
    );
  });

  test('a structurally-plausible but broken index is refused, never scored into a silent []', async () => {
    // Vault-authored JSON: `idf` stripped would weight every term 0 and answer
    // "nothing matches" for every query — a silent lie.
    const noIdf = { ...index() };
    delete noIdf.idf;
    assert.equal(isUsableIndex(noIdf), false);
    await assert.rejects(
      () => searchLocalIndex({ name: 'v' }, { getFileContent: async () => JSON.stringify(noIdf) }, { query: 'recherche' }),
      /version|refuses to score/i,
    );
  });

  test('malformed postings do not throw a raw TypeError (hostile/hand-edited index)', () => {
    const idx = index();
    const hostile = { ...idx, postings: { ...idx.postings, recherche: 42, autre: [null, [0], ['x', 1]] } };
    // Non-list and malformed entries are skipped, not crashed on.
    assert.doesNotThrow(() => queryIndex({ index: hostile, query: 'recherche autre', limit: 5 }));
  });

  test('a query token named like an Object.prototype key cannot inherit a value', () => {
    // `postings.constructor` resolves to a function on parsed JSON without an
    // own-property check — iterating it would throw.
    assert.doesNotThrow(() => queryIndex({ index: index(), query: 'constructor prototype valueOf', limit: 5 }));
  });
});

// --- C4: the local tier end-to-end ------------------------------------------

describe('C4 — searchLocalIndex', () => {
  const depsWith = (idx) => ({ getFileContent: async () => JSON.stringify(idx) });

  test('returns labelled BM25 results with C5 provenance', async () => {
    const out = await searchLocalIndex({ name: 'v' }, depsWith(index()), { query: 'plugin REST', limit: 5 });
    assert.equal(out.tier, TIER_LOCAL);
    assert.equal(out.scoreScale, 'bm25');
    assert.ok(out.results.length > 0);
    assert.equal(out.results[0].path, 'wiki/outils/obsidian.md');
    assert.equal(out.results[0].section, 'Obsidian::Plugins');
    assert.ok(out.results[0].title);
  });

  test('archive hits are excluded by default and counted, restorable with includeArchives', async () => {
    const excluded = await searchLocalIndex({ name: 'v' }, depsWith(index()), { query: 'délibération archivée' });
    assert.ok(excluded.results.every((h) => !h.path.includes('/archives/')));
    assert.ok((excluded.archivesExcluded ?? 0) > 0, 'the cut is reported, never silent');
    const included = await searchLocalIndex({ name: 'v' }, depsWith(index()), { query: 'délibération archivée', includeArchives: true });
    assert.ok(included.results.some((h) => h.path.includes('/archives/')));
  });

  test('folder filters restrict and exclude by path prefix', async () => {
    const only = await searchLocalIndex({ name: 'v' }, depsWith(index()), { query: 'markdown notes disque', folders: ['wiki/outils'] });
    assert.ok(only.results.every((h) => h.path.startsWith('wiki/outils/')));
    const without = await searchLocalIndex({ name: 'v' }, depsWith(index()), { query: 'markdown notes disque', excludeFolders: ['wiki/outils'] });
    assert.ok(without.results.every((h) => !h.path.startsWith('wiki/outils/')));
  });

  test('archive-dominated ranking still fills the page (filtering happens during ranking)', async () => {
    // 200 archived pages outrank 50 eligible ones. With post-filtering of a
    // capped page this returned ZERO results while 50 matches existed just past
    // the cap — a silent empty answer (Fable 5 review).
    const many = [];
    for (let i = 0; i < 200; i += 1) {
      many.push({ path: `wiki/deliberation/archives/vieux-${i}.md`, content: PAGE(`Archive ${i}`, 'Chronique', '# A\n\nUne délibération archivée sur le classement documentaire.\n') });
    }
    for (let i = 0; i < 50; i += 1) {
      many.push({ path: `wiki/actuel/page-${i}.md`, content: PAGE(`Actuel ${i}`, 'Page vivante', '# B\n\nUne délibération vivante sur le classement documentaire.\n') });
    }
    const big = buildSearchIndex({ pages: many, vaultName: 'v' });
    const out = await searchLocalIndex({ name: 'v' }, { getFileContent: async () => JSON.stringify(big) }, {
      query: 'délibération classement documentaire',
      limit: 30,
    });
    assert.equal(out.results.length, 30, 'the caller asked for 30 eligible hits and must get 30');
    assert.ok(out.results.every((h) => !h.path.includes('/archives/')));
    assert.ok(out.archivesExcluded >= 200, 'the archive cut is fully counted');
  });

  test('a non-positive or absurd limit is clamped, never turned into an empty page', async () => {
    const deps = { getFileContent: async () => JSON.stringify(index()) };
    for (const limit of [0, -5]) {
      const out = await searchLocalIndex({ name: 'v' }, deps, { query: 'plugin REST', limit });
      assert.ok(out.results.length >= 1, `limit ${limit} must not empty the page`);
    }
    const huge = await searchLocalIndex({ name: 'v' }, deps, { query: 'plugin REST', limit: 1e9 });
    assert.ok(huge.results.length <= 100);
  });

  test('freshness is declared as unverified rather than implied', async () => {
    const out = await searchLocalIndex({ name: 'v' }, depsWith(index()), { query: 'recherche' });
    assert.match(out.index.freshness, /not verified/i);
    assert.match(out.index.freshness, /build_search_index/);
  });
});

// --- C4: the never-mixed fallback doctrine ----------------------------------

describe('C4 — fallback doctrine (never mixed)', () => {
  test('capability gaps trigger the fallback; auth/transport/real-answers do not', () => {
    assert.equal(isSemanticTierUnusable({ kind: 'not_found' }), true);
    assert.equal(isSemanticTierUnusable({ status: 404 }), true);
    assert.equal(isSemanticTierUnusable({ status: 503, message: 'Smart Connections plugin is not available' }), true);
    assert.equal(isSemanticTierUnusable({ message: 'smart-connections is not installed' }), true);
    // NOT capability gaps:
    assert.equal(isSemanticTierUnusable({ status: 401, kind: 'unauthorized' }), false);
    assert.equal(isSemanticTierUnusable({ status: 403, kind: 'forbidden' }), false);
    assert.equal(isSemanticTierUnusable({ kind: 'unreachable' }), false);
    assert.equal(isSemanticTierUnusable({ kind: 'timeout' }), false);
    assert.equal(isSemanticTierUnusable({ status: 500, kind: 'server_error' }), false);
    assert.equal(isSemanticTierUnusable(null), false);
  });

  test('a GENERIC bridge 503 is a malfunction, not a capability gap — it must surface', async () => {
    // The bridge wraps every runtime exception from its search handler in a
    // generic 503. Demoting that to a labelled BM25 degrade would hide a broken
    // Smart Connections from the operator forever (Fable 5 review).
    assert.equal(
      isSemanticTierUnusable({ status: 503, message: 'An error occurred while processing the search request' }),
      false,
    );
    await assert.rejects(
      () => searchSmartTool(
        { resolveVault: () => ({ name: 'v' }), vaults: [], lockedVault: null },
        { query: 'plugin REST' },
        {
          searchSmart: async () => { throw Object.assign(new Error('An error occurred while processing the search request'), { status: 503 }); },
          getFileContent: async () => JSON.stringify(index()),
        },
      ),
      /error occurred while processing/,
    );
  });

  const registry = { resolveVault: () => ({ name: 'v' }), vaults: [], lockedVault: null };
  const localDeps = { getFileContent: async () => JSON.stringify(index()) };

  test("tier auto: semantic serves → results are semantic, no fallback marker", async () => {
    const out = await searchSmartTool(registry, { query: 'recherche bm25' }, {
      searchSmart: async () => ({ results: [{ path: 'wiki/x.md', score: 0.9 }] }),
      ...localDeps,
    });
    assert.equal(out.tier, TIER_SEMANTIC);
    assert.equal(out.fallback, undefined);
    assert.equal(out.results.length, 1);
  });

  test('tier auto: semantic UNUSABLE → results come wholly from BM25, clearly labelled', async () => {
    const out = await searchSmartTool(registry, { query: 'plugin REST' }, {
      searchSmart: async () => { throw Object.assign(new Error('Smart Connections plugin is not available'), { status: 503 }); },
      ...localDeps,
    });
    assert.equal(out.tier, TIER_LOCAL);
    assert.equal(out.fallback.from, TIER_SEMANTIC);
    assert.equal(out.fallback.reason, 'semantic-tier-unavailable');
    assert.match(out.fallback.note, /no semantic result is blended/i);
    assert.equal(out.scoreScale, 'bm25');
    assert.ok(out.results.length > 0);
    // Never mixed: every hit carries the BM25 shape (path+section from the index).
    assert.ok(out.results.every((h) => typeof h.score === 'number' && h.path));
  });

  test('tier auto: an EMPTY semantic answer is a real answer — no fallback', async () => {
    let localCalled = false;
    const out = await searchSmartTool(registry, { query: 'plugin REST' }, {
      searchSmart: async () => ({ results: [] }),
      getFileContent: async () => { localCalled = true; return JSON.stringify(index()); },
    });
    assert.equal(out.tier, TIER_SEMANTIC);
    assert.deepEqual(out.results, []);
    assert.equal(localCalled, false, 'the local index must not even be read');
  });

  test('tier auto: an AUTH failure surfaces — it is not a capability gap', async () => {
    await assert.rejects(
      () => searchSmartTool(registry, { query: 'recherche' }, {
        searchSmart: async () => { throw Object.assign(new Error('401 unauthorized'), { status: 401, kind: 'unauthorized' }); },
        ...localDeps,
      }),
      /unauthorized/i,
    );
  });

  test("tier 'semantic' forbids the fallback (errors instead of degrading)", async () => {
    await assert.rejects(
      () => searchSmartTool(registry, { query: 'recherche', tier: 'semantic' }, {
        searchSmart: async () => { throw Object.assign(new Error('Smart Connections plugin is not available'), { status: 503 }); },
        ...localDeps,
      }),
      /Smart Connections/,
    );
  });

  test("tier 'local' never touches the semantic tier", async () => {
    let semanticCalled = false;
    const out = await searchSmartTool(registry, { query: 'plugin REST', tier: 'local' }, {
      searchSmart: async () => { semanticCalled = true; return { results: [] }; },
      ...localDeps,
    });
    assert.equal(semanticCalled, false);
    assert.equal(out.tier, TIER_LOCAL);
    assert.ok(out.results.length > 0);
  });

  test('an invalid tier is rejected with the valid options', async () => {
    await assert.rejects(
      () => searchSmartTool(registry, { query: 'x', tier: 'hybrid' }),
      /Invalid tier.*auto.*semantic.*local/s,
    );
  });

  test('query bounds are TIER-INDEPENDENT — the semantic path cannot bypass them', async () => {
    // Bounds enforced only inside the local tier made acceptance depend on which
    // engine happened to be available (Codex verification).
    let semanticCalled = false;
    const spy = { searchSmart: async () => { semanticCalled = true; return { results: [] }; }, ...localDeps };
    for (const tier of ['auto', 'semantic', 'local']) {
      semanticCalled = false;
      await assert.rejects(
        () => searchSmartTool(registry, { query: 'x'.repeat(1001), tier }, spy),
        /limit is 1000|characters/i,
        `tier ${tier} must refuse an over-long query`,
      );
      assert.equal(semanticCalled, false, `tier ${tier}: nothing may be dispatched`);
    }
  });

  test('an absurd limit is clamped before it reaches either tier', async () => {
    let sentLimit = null;
    await searchSmartTool(registry, { query: 'recherche bm25', limit: 1e9 }, {
      searchSmart: async (_v, _q, f) => { sentLimit = f.limit; return { results: [] }; },
      ...localDeps,
    });
    // Bound taken from the EXPORTED constant rather than written out: this
    // assertion used to hard-code `100 + 10`, the archive filter's flat margin,
    // and broke when the C4 over-fetch started scaling with the limit. The
    // intent — an absurd limit never reaches a backend — is what is pinned.
    assert.ok(
      sentLimit <= MAX_OVERFETCH,
      `forwarded limit ${sentLimit} must be clamped to at most ${MAX_OVERFETCH}`,
    );
  });

  test('a crash message that merely QUOTES a Smart-Connections-ish page title is NOT a gap', async () => {
    // Post-release Codex, v0.63.1: this exact message triggered the fallback
    // and hid the crash. The predicate now requires the verbal assertion.
    const msg = 'Semantic query crashed while reading page "Smart Connections not available guide"';
    assert.equal(isSemanticTierUnusable({ status: 503, message: msg }), false);
    await assert.rejects(
      () => searchSmartTool(registry, { query: 'recherche locale' }, {
        searchSmart: async () => { throw Object.assign(new Error(msg), { status: 503 }); },
        ...localDeps,
      }),
      /crashed while reading/,
    );
  });

  test('short queries ("C1") reach the semantic tier; tier local still refuses them', async () => {
    // Post-release Fable 5, v0.63.1: v0.63.0 refused "C1" before even trying
    // Smart Connections — a regression vs v0.62.0. no-usable-tokens is a BM25
    // prerequisite, not a semantic one.
    const out = await searchSmartTool(registry, { query: 'C1' }, {
      searchSmart: async () => ({ results: [{ path: 'wiki/c1.md', score: 0.9 }] }),
      ...localDeps,
    });
    assert.equal(out.tier, TIER_SEMANTIC);
    assert.equal(out.results.length, 1);
    // The local tier keeps its honest refusal — BM25 genuinely cannot score it.
    await assert.rejects(
      () => searchSmartTool(registry, { query: 'C1', tier: 'local' }, {
        searchSmart: async () => ({ results: [] }),
        ...localDeps,
      }),
      /no usable term/i,
    );
    // And the auto path on a semantic-less vault surfaces the local refusal.
    await assert.rejects(
      () => searchSmartTool(registry, { query: 'C1' }, {
        searchSmart: async () => { throw Object.assign(new Error('Smart Connections plugin is not available'), { status: 503 }); },
        ...localDeps,
      }),
      /no usable term/i,
    );
  });

  test('a truncated index announces its incompleteness on every response', async () => {
    // The flag lived only inside the index file, invisible to searchers — a
    // partial index served as if it were a complete fallback (Codex).
    const small = buildSearchIndex({ pages: CORPUS, vaultName: 'v', maxChunks: 2 });
    assert.equal(small.stats.truncated, true);
    const out = await searchLocalIndex({ name: 'v' }, { getFileContent: async () => JSON.stringify(small) }, { query: 'classement' });
    assert.equal(out.incomplete.reason, 'index-truncated');
    assert.match(out.incomplete.detail, /does NOT cover the whole vault/);
    assert.equal(out.index.truncated, true);
  });
});

// --- build_search_index tool ------------------------------------------------

describe('build_search_index', () => {
  function makeVaultFs(files = {}) {
    const store = new Map(Object.entries(files));
    const writes = [];
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
        // Mirror the real REST client: an absent directory is a typed 404, NOT
        // an anonymous throw — the walker must be able to tell "not there" from
        // "could not be read" (the fail-closed distinction).
        if (names.size === 0 && dir !== '') throw Object.assign(new Error('404'), { kind: 'not_found' });
        return { files: [...names].sort() };
      },
      getFileContent: async (_v, p) => {
        if (!store.has(p)) throw Object.assign(new Error('404'), { kind: 'not_found' });
        return store.get(p);
      },
      writeFile: async (_v, p, content) => { store.set(p, content); writes.push(p); },
    };
    return { store, writes, deps };
  }
  const VAULT = { name: 'v' };
  const files = Object.fromEntries(CORPUS.map((p) => [p.path, p.content]));

  test('builds and writes the index, reporting stats', async () => {
    const { deps, writes, store } = makeVaultFs(files);
    const r = await buildIndexForVault(VAULT, deps);
    assert.equal(r.written, true);
    assert.equal(r.indexState, 'absent');
    assert.deepEqual(writes, [SEARCH_INDEX_PATH]);
    assert.ok(r.stats.chunks > 0 && r.stats.pages > 0);
    assert.ok(isUsableIndex(JSON.parse(store.get(SEARCH_INDEX_PATH))));
  });

  test('a second build over an unchanged vault SKIPS the write (idempotent)', async () => {
    const { deps, writes } = makeVaultFs(files);
    await buildIndexForVault(VAULT, deps);
    const r = await buildIndexForVault(VAULT, deps);
    assert.equal(r.upToDate, true);
    assert.equal(r.written, false);
    assert.equal(r.indexState, 'current');
    assert.equal(writes.length, 1, 'no churn on the second run');
  });

  test('an edited vault is detected as stale and rewritten', async () => {
    const { deps, store, writes } = makeVaultFs(files);
    await buildIndexForVault(VAULT, deps);
    store.set('wiki/moteur/nouveau.md', PAGE('Nouveau', 'Une page neuve', '# Nouveau\n\nDu contenu neuf.\n'));
    const r = await buildIndexForVault(VAULT, deps);
    assert.equal(r.indexState, 'stale');
    assert.equal(r.written, true);
    assert.equal(writes.length, 2);
  });

  test('check: true reports the plan and writes nothing', async () => {
    const { deps, writes } = makeVaultFs(files);
    const r = await buildIndexForVault(VAULT, deps, { check: true });
    assert.equal(r.mode, 'check');
    assert.equal(r.written, false);
    assert.equal(r.indexState, 'absent');
    assert.deepEqual(writes, []);
  });

  test('FAIL CLOSED: a directory that fails to LIST aborts the build', async () => {
    // A subtree that errors on listing is invisible, not empty — the walker used
    // to swallow it and the builder wrote a partial index reporting success
    // (Codex verification). A true 404 stays a normal "absent", not a failure.
    const { deps, writes } = makeVaultFs(files);
    const realList = deps.listFilesIn;
    deps.listFilesIn = async (v, dir) => {
      if (dir === 'wiki/moteur') throw new Error('EBUSY');
      return realList(v, dir);
    };
    const r = await buildIndexForVault(VAULT, deps);
    assert.equal(r.skipped, 'enumeration-failed');
    assert.deepEqual(writes, [], 'a vault that cannot be fully enumerated is never indexed');
  });

  test('FAIL CLOSED: a page read failure aborts the build (never a partial index)', async () => {
    const { deps, writes } = makeVaultFs(files);
    const real = deps.getFileContent;
    deps.getFileContent = async (v, p) => {
      if (p === 'wiki/outils/obsidian.md') throw new Error('EBUSY');
      return real(v, p);
    };
    const r = await buildIndexForVault(VAULT, deps);
    assert.equal(r.skipped, 'page-reads-failed');
    assert.deepEqual(writes, [], 'a partial corpus must never be indexed');
  });

  test('generated OKF projections are excluded — but a user page named log.md is NOT', async () => {
    const { deps, store } = makeVaultFs({
      ...files,
      'wiki/index.md': '# Index généré\n\n* [Recherche BM25](moteur/bm25.md)\n',
      'wiki/log.md': '# Log généré\n\n## 2026-01-01\n',
      'wiki/moteur/index.md': '# Index de dossier\n\n* [BM25](bm25.md)\n',
      // Only `wiki/log.md` at the ROOT is a projection; a nested log.md is a
      // real user page and must stay findable (Fable 5 review — a hand-rolled
      // regex swallowed it, creating a silent tier-coverage asymmetry).
      'wiki/trading/log.md': PAGE('Journal de trading', 'Mes trades', '# Journal\n\nUne entrée de journal de trading sur les positions.\n'),
    });
    await buildIndexForVault(VAULT, deps);
    const idx = JSON.parse(store.get(SEARCH_INDEX_PATH));
    const paths = new Set(idx.chunks.map((c) => c.path));
    assert.ok(!paths.has('wiki/index.md'), 'root projection excluded');
    assert.ok(!paths.has('wiki/log.md'), 'root log projection excluded');
    assert.ok(!paths.has('wiki/moteur/index.md'), 'per-directory projection excluded');
    assert.ok(paths.has('wiki/trading/log.md'), "a user's own nested log.md stays indexed");
  });

  test('an empty corpus builds but WARNS — it never reports a clean success', async () => {
    const { deps } = makeVaultFs({});
    const r = await buildIndexForVault(VAULT, deps);
    assert.equal(r.stats.chunks, 0);
    assert.ok(Array.isArray(r.warnings) && r.warnings.some((w) => /EMPTY/.test(w)));
  });

  test('same-version corruption is named integrity-failed, never foreign-version', async () => {
    // Post-release Codex, v0.63.1: a corrupted same-version index reported
    // indexState 'foreign-version', pointing at an upgrade that does not exist.
    const { deps, store } = makeVaultFs(files);
    await buildIndexForVault(VAULT, deps);
    const corrupt = JSON.parse(store.get(SEARCH_INDEX_PATH));
    corrupt.chunks = [...corrupt.chunks].reverse(); // digest now mismatches
    store.set(SEARCH_INDEX_PATH, JSON.stringify(corrupt));
    const r = await buildIndexForVault(VAULT, deps, { check: true });
    assert.equal(r.indexState, 'integrity-failed');
    assert.ok(r.warnings.some((w) => /CORRUPT/.test(w) && /build_search_index/.test(w)), 'corruption diagnostic present');
    // And the query path names it too, with a machine-readable reason.
    await assert.rejects(
      () => searchLocalIndex({ name: 'v' }, { getFileContent: async () => JSON.stringify(corrupt) }, { query: 'recherche' }),
      (e) => /CORRUPT/.test(e.message) && e.reason === 'index-integrity-failed',
    );
  });

  test('check: true on a drifted vault spells out the staleness', async () => {
    const { deps, store } = makeVaultFs(files);
    await buildIndexForVault(VAULT, deps);
    store.set('wiki/moteur/neuf.md', PAGE('Neuf', 'Page neuve', '# Neuf\n\nContenu neuf.\n'));
    const r = await buildIndexForVault(VAULT, deps, { check: true });
    assert.equal(r.indexState, 'stale');
    assert.ok(r.warnings.some((w) => /STALE/.test(w) && /build_search_index/.test(w)));
  });
});
