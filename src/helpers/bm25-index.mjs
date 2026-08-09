/**
 * Local deterministic BM25 search tier — C4, with C5's contextual chunk headers
 * folded in (borrowings from claude-obsidian v2, §2.17).
 *
 * THE GAP THIS FILLS. The router had two search tiers and a hole between them:
 *   - `search` (plain substring) — dumb but always available;
 *   - `search_smart` (semantic) — good, but it needs the Smart Connections
 *     plugin installed AND indexed, which most of the fleet does not have.
 * Missing was the search-engine classic: **BM25**, which ranks by how much each
 * query term discriminates — no model, no plugin, no network, no egress, and
 * the same question always yields the same ranking. This module is that tier.
 *
 * RELATIONSHIP TO `bm25-filter.mjs` (Crawl4AI W-A, v0.47.0). That module scores
 * blocks WITHIN ONE document to prune an already-fetched page. This one indexes
 * chunks ACROSS A WHOLE VAULT to answer a query. Different corpus, different
 * lifetime (persisted vs one-shot), same arithmetic — so the segmentation
 * (`segmentBlocks`) and the token/IDF primitives are IMPORTED, never copied.
 * There is one BM25 in this repo; this is its corpus-level use.
 *
 * C5 — CONTEXTUAL CHUNK HEADERS. A chunk torn out of its page loses its meaning
 * ("it refuses on the first call" — which page? which tool?). Before indexing,
 * every chunk is prefixed with a one-line header built by COPYING existing
 * metadata — the page title, its frontmatter `description` (mandatory across the
 * fleet since v0.59.3 — a free convergence), and the heading path of the section
 * it came from. No LLM, no egress, purely derived. The header is part of the
 * indexed text, so a query matching a page's title or description surfaces that
 * page's chunks, and every hit can explain WHERE it came from.
 *
 * DETERMINISM IS THE PRODUCT. Same corpus + same query ⇒ same ranking, always:
 * no clock in the scored payload, ties broken on (path, chunk ordinal), and the
 * corpus `fingerprint` is a byte-exact content hash so an unchanged vault
 * rebuilds to a byte-identical index — which is what lets the builder skip the
 * write instead of churning the file. The index also carries an `integrity`
 * digest of its own scored payload, so a corrupted or hand-edited index is
 * refused instead of silently answering wrong.
 *
 * HONEST FALLBACK, NEVER MIXED (C4's other half). Semantic scores and BM25
 * scores are different scales; interleaving them produces a ranking that means
 * nothing. So a search resolves to EXACTLY ONE tier and says which one. The
 * consumer of that rule is `search_smart` (see src/tools/search-smart.mjs): when
 * the semantic tier is UNUSABLE it falls back wholly to BM25 and labels the
 * result — it never blends, and it never silently returns fewer results.
 *
 * v1 limitation (inherited, deliberate): exact-token matching, no stemming or
 * synonyms — `équations` does not match `équation`. That is the price of
 * zero-dependency determinism.
 */

import { createHash } from 'node:crypto';
import { tokenise, computeIdf } from './idf-score.mjs';
import { segmentBlocks } from './bm25-filter.mjs';
import { parseFrontmatter } from './llms-txt-exporter.mjs';

/**
 * EXACT content hash — deliberately NOT C1's `contentSha256`.
 *
 * C1 strips a leading BOM so that two READ PATHS (core `GET /vault` via
 * `res.text()`, which drops it, and the bridge's `adapter.read()`, which keeps
 * it) agree on a file's fingerprint. That normalization is wrong HERE: a BOM
 * changes how the frontmatter and first block parse, so two contents that differ
 * only by a BOM produce DIFFERENT indexes. Hashing them identically made the
 * builder report "current" and skip rewriting a genuinely stale index
 * (Codex verification, v0.63.0). The corpus fingerprint must be byte-exact.
 */
function exactSha256(text) {
  return createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
}

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** Where the index lives inside the vault (written through the REST API, like the graph). */
export const SEARCH_INDEX_PATH = 'wiki-meta/search-index.json';

/**
 * Index schema version. Bump on any change to the persisted shape or to the
 * scoring inputs; a reader that sees a foreign version refuses the index and
 * asks for a rebuild rather than scoring against a shape it misunderstands.
 */
export const INDEX_VERSION = 2;

/** BM25 parameters — textbook defaults, same as the filter module. */
export const DEFAULT_K1 = 1.2;
export const DEFAULT_B = 0.75;

/** Chunking bounds. A section longer than this is split into several chunks. */
export const MAX_CHUNK_TOKENS = 180;
/** Characters of chunk text kept for the result excerpt (the index is not a content store). */
export const PREVIEW_CHARS = 240;

/** Query bounds (C4: "bornes de requête"). */
export const MAX_QUERY_CHARS = 1000;
/**
 * Longest token worth indexing or querying. A 10k-character alphanumeric run
 * (minified blob, base64 payload) would become a giant postings key that no
 * bounded query can ever match — pure index bloat with zero recall value
 * (post-release Codex verification, v0.63.1). Applied on BOTH sides (chunk
 * tokens and query tokens), so the two vocabularies stay aligned.
 */
export const MAX_TOKEN_CHARS = 200;

/** `tokenise` with the token-length cap applied. The shared tokeniser stays
 * untouched (other call sites have different needs). */
function boundedTokens(text) {
  return tokenise(text).filter((t) => t.length <= MAX_TOKEN_CHARS);
}
export const MAX_QUERY_TOKENS = 32;
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 10;

/** Corpus bounds — an index is a cache, not an archive. Truncation is REPORTED, never silent. */
export const MAX_INDEXED_CHUNKS = 20000;

// ---------------------------------------------------------------------------
// C5 — chunking with contextual headers
// ---------------------------------------------------------------------------

/**
 * Split text into pieces of at most `maxTokens` indexable tokens.
 *
 * Three levels, because all three shapes occur: a block of many lines (a list,
 * a table) splits on line boundaries to preserve structure; a single
 * wall-of-text paragraph — no newlines, the common real case — breaks inside
 * the line on whitespace; and a whitespace-free run of punctuation-separated
 * terms (`a1,b2,c3,…` — 500 tokens, zero spaces) breaks on TOKEN-RUN
 * boundaries. Without the third level, one comma-separated line blew straight
 * through the advertised bound as a single "word" (post-release Codex
 * verification, v0.63.1).
 */
function splitByTokenBudget(text, maxTokens) {
  const pieces = [];
  let current = [];
  let currentTokens = 0;

  const flushCurrent = () => {
    if (current.length === 0) return;
    pieces.push(current.join('\n'));
    current = [];
    currentTokens = 0;
  };

  // Level 3 — a single whitespace-free unit over budget: cut on alternating
  // runs of token / non-token characters (the same alphabet `tokenise` splits
  // on), so each emitted segment carries at most `maxTokens` indexable tokens.
  const splitOversizedWord = (word) => {
    const runs = word.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu) || [word];
    const segments = [];
    let seg = [];
    let segTokens = 0;
    for (const run of runs) {
      const t = boundedTokens(run).length;
      if (segTokens > 0 && segTokens + t > maxTokens) {
        segments.push(seg.join(''));
        seg = [];
        segTokens = 0;
      }
      seg.push(run);
      segTokens += t;
    }
    if (seg.length) segments.push(seg.join(''));
    return segments;
  };

  for (const line of String(text).split('\n')) {
    const lineTokens = boundedTokens(line).length;
    if (lineTokens <= maxTokens) {
      if (currentTokens > 0 && currentTokens + lineTokens > maxTokens) flushCurrent();
      current.push(line);
      currentTokens += lineTokens;
      continue;
    }
    // Level 2 — the line is over budget: break it on whitespace boundaries,
    // delegating any single over-budget "word" to level 3.
    flushCurrent();
    let words = [];
    let wordTokens = 0;
    const emitWordsPiece = () => {
      if (!words.length) return;
      pieces.push(words.join('').trimEnd());
      words = [];
      wordTokens = 0;
    };
    for (const word of line.split(/(?<=\s)/)) {
      const t = boundedTokens(word).length;
      if (t > maxTokens) {
        emitWordsPiece();
        const segments = splitOversizedWord(word);
        for (let i = 0; i < segments.length - 1; i += 1) pieces.push(segments[i]);
        const last = segments[segments.length - 1];
        words.push(last);
        wordTokens = boundedTokens(last).length;
        continue;
      }
      if (wordTokens > 0 && wordTokens + t > maxTokens) emitWordsPiece();
      words.push(word);
      wordTokens += t;
    }
    if (words.length) {
      current.push(words.join('').trimEnd());
      currentTokens = wordTokens;
    }
  }
  flushCurrent();
  return pieces.filter((p) => p.trim() !== '');
}

/** ATX heading level + text, or null. */
function parseHeading(line) {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: m[2].trim() };
}

/**
 * Human title for a page: frontmatter `title`, else the H1, else the basename.
 * Copying, never guessing — C5 forbids invention.
 */
function derivePageTitle(path, frontmatter, blocks) {
  const fmTitle = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : '';
  if (fmTitle) return fmTitle;
  for (const b of blocks) {
    if (b.type !== 'heading') continue;
    const h = parseHeading(b.text);
    if (h && h.level === 1 && h.text) return h.text;
    break;
  }
  const base = String(path).split('/').pop() || String(path);
  return base.replace(/\.md$/i, '');
}

/**
 * A bare YAML block-scalar INDICATOR (`|`, `>`, `|-`, `|2-`, `>- # note`, …)
 * where real text was expected.
 *
 * Since v0.63.2 the SHARED `parseFrontmatter` consumes block scalars properly,
 * so this should never fire — the block's text arrives instead of its header.
 * The guard stays as a cheap regression net: if that parser ever loses the
 * capability again, C5 degrades to `title · section` (honest) rather than
 * indexing a stray `|` and presenting an empty description as populated.
 */
const BLOCK_SCALAR_RE = /^[|>](?:\d+[-+]?|[-+]?\d*)(?:\s+#.*)?$/;

function isBlockScalarIndicator(value) {
  return BLOCK_SCALAR_RE.test(value);
}


/**
 * Build the C5 header line for a chunk. Pure concatenation of metadata that
 * already exists — title, description, section path — joined so the tokens are
 * searchable and a hit can say where it came from.
 */
export function buildChunkHeader({ title, description, section }) {
  const parts = [];
  if (title) parts.push(title);
  if (description) parts.push(description);
  if (section) parts.push(section);
  return parts.join(' · ');
}

/**
 * Split ONE page into indexable chunks, each carrying its C5 header.
 *
 * Segmentation is delegated to `segmentBlocks` (frontmatter isolated, fences
 * never split, headings standalone). Blocks are then grouped by section: a
 * heading opens a new section and updates the heading stack, so `section`
 * reads like `Parent::Child`. A section longer than `maxChunkTokens` is split
 * into consecutive chunks rather than truncated — nothing is dropped.
 *
 * @param {object} params
 * @param {string} params.path      vault-relative path (identity of the page)
 * @param {string} params.content   raw file content (frontmatter included)
 * @param {number} [params.maxChunkTokens]
 * @returns {Array<{path,title,description,section,header,text,tokens:string[]}>}
 */
export function chunkPage({ path: pagePath, content, maxChunkTokens = MAX_CHUNK_TOKENS }) {
  const raw = typeof content === 'string' ? content : '';
  const { frontmatter } = parseFrontmatter(raw);
  const blocks = segmentBlocks(raw);
  const title = derivePageTitle(pagePath, frontmatter, blocks);
  const rawDescription =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  // A block-scalar indicator means the real text sits in the indented block the
  // line-oriented parser skipped — recover it rather than losing the description.
  // `parseFrontmatter` already expands block scalars (v0.63.2); the guard only
  // catches a regression there — see isBlockScalarIndicator.
  const description = isBlockScalarIndicator(rawDescription) ? '' : rawDescription;

  const chunks = [];
  /** Heading stack → the `Parent::Child` section path. */
  const stack = [];
  let buffer = [];
  let bufferTokens = 0;

  const sectionPath = () => stack.map((h) => h.text).join('::');

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n\n');
    buffer = [];
    bufferTokens = 0;
    if (text.trim() === '') return;
    const section = sectionPath();
    const header = buildChunkHeader({ title, description, section });
    chunks.push({
      path: pagePath,
      title,
      description,
      section,
      header,
      text,
      // The header is indexed WITH the body (C5): a query matching the page
      // title or its description reaches this chunk.
      tokens: boundedTokens(`${header}\n${text}`),
    });
  };

  for (const block of blocks) {
    if (block.type === 'frontmatter') continue; // metadata, not prose — already mined above
    if (block.type === 'heading') {
      flush();
      const h = parseHeading(block.text);
      if (h) {
        while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
        stack.push(h);
      }
      continue;
    }
    const blockTokens = boundedTokens(block.text).length;
    // Split an over-long section rather than truncate it.
    if (bufferTokens > 0 && bufferTokens + blockTokens > maxChunkTokens) flush();

    // A SINGLE block bigger than the budget (a wall-of-text paragraph, a long
    // table) used to sail through whole, so the advertised bound was a lie and
    // one chunk could dwarf avgdl (Codex verification, v0.63.0). Subdivide it on
    // line boundaries. Fenced code is the deliberate exception — splitting a
    // fence would index two fragments that are each invalid, so it stays atomic
    // even when oversized.
    if (blockTokens > maxChunkTokens && block.type !== 'code') {
      const parts = splitByTokenBudget(block.text, maxChunkTokens);
      for (let i = 0; i < parts.length; i += 1) {
        buffer.push(parts[i]);
        bufferTokens += boundedTokens(parts[i]).length;
        // Every piece but the last closes a chunk; the last stays open so a
        // short following block can share it.
        if (i < parts.length - 1) flush();
      }
      continue;
    }

    buffer.push(block.text);
    bufferTokens += blockTokens;
  }
  flush();

  // A page with a title/description but no body still deserves to be findable.
  if (chunks.length === 0) {
    const header = buildChunkHeader({ title, description, section: '' });
    if (header.trim() !== '') {
      chunks.push({
        path: pagePath,
        title,
        description,
        section: '',
        header,
        text: '',
        tokens: boundedTokens(header),
      });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

/**
 * Fingerprint of the corpus: a content hash over the sorted (path, contentHash)
 * pairs. Two builds of an unchanged vault produce the same fingerprint, so the
 * builder can skip the write; any edit anywhere changes it. Reuses C1's hash so
 * the repo keeps ONE hashing core.
 */
export function corpusFingerprint(pages) {
  const rows = pages
    .map((p) => `${p.path}\t${exactSha256(typeof p.content === 'string' ? p.content : '')}`)
    .sort();
  return exactSha256(rows.join('\n'));
}

/**
 * Digest over the SCORED payload — the parts a query actually reads.
 *
 * Why the corpus fingerprint is not enough: the index file is vault content. A
 * hand-edit, a sync conflict, or a truncated write can leave a file that still
 * LOOKS like an index while its postings no longer correspond to its chunks. The
 * corpus fingerprint cannot detect that (the corpus is unchanged), so the builder
 * reports `current` and never repairs it. Reproduced by Codex: reversing
 * `chunks` without touching `postings` made queries return unrelated pages,
 * permanently. This self-digest turns any such corruption into an actionable
 * refusal instead of a confident wrong answer.
 */
export function indexIntegrityDigest({ version, fingerprint, stats, chunks, postings, idf, avgdl }) {
  // The digest covers the METADATA too, not just the scored payload: a stale
  // index whose `fingerprint` was hand-set to the current corpus value passed
  // as `current` forever, and a fabricated `stats.truncated: false` silenced
  // the incompleteness warning (post-release Codex verification, v0.63.1).
  //
  // Threat model, stated honestly: this is a CORRUPTION check (sync conflicts,
  // truncated writes, casual hand-edits). An unkeyed hash cannot authenticate
  // against an active editor who recomputes it — that would need a key the
  // router holds and the vault file does not, which is not this feature.
  return exactSha256(JSON.stringify({ version, fingerprint, stats, chunks, postings, idf, avgdl }));
}

/**
 * Build the persisted BM25 index from the vault's pages.
 *
 * Shape: chunk metadata (for display and C5 provenance) + an inverted index
 * (token → [[chunkOrdinal, termFrequency], …]). The inverted form is what makes
 * a query cheap: only the postings of the query's own tokens are touched.
 * Document frequencies are derivable from the postings, but IDF is stored so a
 * reader never has to recompute the whole corpus statistic to answer one query.
 *
 * No clock anywhere in the scored payload — see the module header.
 *
 * @param {object} params
 * @param {Array<{path:string, content:string}>} params.pages
 * @param {string} params.vaultName
 * @param {number} [params.maxChunks]
 * @returns {object} the index (JSON-serializable)
 */
export function buildSearchIndex({ pages, vaultName, maxChunks = MAX_INDEXED_CHUNKS }) {
  const list = Array.isArray(pages) ? pages : [];
  // Sort by path so chunk ordinals — and therefore the whole serialized index —
  // do not depend on the order the walker happened to enumerate files in.
  const sorted = [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const chunks = [];
  let truncated = false;
  let pagesIndexed = 0;
  for (const page of sorted) {
    if (chunks.length >= maxChunks) {
      truncated = true;
      break;
    }
    const pageChunks = chunkPage({ path: page.path, content: page.content });
    if (pageChunks.length === 0) continue;
    pagesIndexed += 1;
    for (const ch of pageChunks) {
      if (chunks.length >= maxChunks) {
        truncated = true;
        break;
      }
      chunks.push(ch);
    }
  }

  const idfMap = computeIdf(chunks.map((c) => c.tokens));
  const postings = Object.create(null);
  let totalLen = 0;
  chunks.forEach((chunk, ordinal) => {
    const tf = new Map();
    for (const t of chunk.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    totalLen += chunk.tokens.length;
    for (const [token, count] of tf) {
      if (!postings[token]) postings[token] = [];
      postings[token].push([ordinal, count]);
    }
  });

  // Deterministic key order in the serialized JSON.
  const orderedPostings = Object.create(null);
  for (const token of Object.keys(postings).sort()) orderedPostings[token] = postings[token];
  const idf = Object.create(null);
  for (const token of [...idfMap.keys()].sort()) idf[token] = idfMap.get(token);

  // Metadata only — the index is not a content store. `preview` exists so a hit
  // is readable without a second fetch; the full page is one get_file away.
  const chunkMeta = chunks.map((c) => ({
    path: c.path,
    title: c.title,
    ...(c.description ? { description: c.description } : {}),
    ...(c.section ? { section: c.section } : {}),
    len: c.tokens.length,
    preview: c.text.slice(0, PREVIEW_CHARS),
  }));
  const avgdl = chunks.length > 0 ? totalLen / chunks.length : 0;

  const fingerprint = corpusFingerprint(sorted);
  const stats = {
    pages: pagesIndexed,
    chunks: chunks.length,
    tokens: totalLen,
    truncated,
    ...(truncated ? { maxChunks } : {}),
  };

  return {
    version: INDEX_VERSION,
    vault: vaultName ?? null,
    fingerprint,
    // Self-check over metadata + scored payload — see indexIntegrityDigest.
    integrity: indexIntegrityDigest({
      version: INDEX_VERSION,
      fingerprint,
      stats,
      chunks: chunkMeta,
      postings: orderedPostings,
      idf,
      avgdl,
    }),
    stats,
    avgdl,
    chunks: chunkMeta,
    idf,
    postings: orderedPostings,
  };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Validate a query against the C4 bounds. Returns `{ ok: true, tokens }` or
 * `{ ok: false, reason, message }` — an actionable refusal, never a silent
 * empty result set (an empty answer and a rejected query mean different things
 * and the caller must be able to tell them apart).
 */
export function validateQuery(query) {
  const q = typeof query === 'string' ? query : '';
  if (q.trim() === '') {
    return { ok: false, reason: 'empty-query', message: 'Query is empty. Pass some search terms.' };
  }
  if (q.length > MAX_QUERY_CHARS) {
    return {
      ok: false,
      reason: 'query-too-long',
      message: `Query is ${q.length} characters; the limit is ${MAX_QUERY_CHARS}. Shorten it to the discriminating terms.`,
    };
  }
  // boundedTokens on the query too: a token longer than MAX_TOKEN_CHARS cannot
  // exist in the index, so keeping it here would only distort the bounds count.
  const tokens = [...new Set(boundedTokens(q))];
  if (tokens.length === 0) {
    return {
      ok: false,
      reason: 'no-usable-tokens',
      message: `Query has no usable term: tokens shorter than 3 characters are dropped. Use longer words.`,
    };
  }
  if (tokens.length > MAX_QUERY_TOKENS) {
    return {
      ok: false,
      reason: 'too-many-tokens',
      message: `Query has ${tokens.length} distinct terms; the limit is ${MAX_QUERY_TOKENS}. Keep the discriminating ones.`,
    };
  }
  return { ok: true, tokens };
}

/** Clamp a caller-supplied limit into [1, MAX_LIMIT]. */
export function clampLimit(limit) {
  const n = typeof limit === 'string' ? Number(limit) : limit;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

/**
 * Classify what is wrong with a stored index — or null when it is usable.
 *
 * The distinction matters for the DIAGNOSTIC (post-release Codex verification,
 * v0.63.1: a same-version corrupted index was reported as "foreign-version",
 * pointing the operator at an upgrade that does not exist):
 *   - 'malformed'        — not an index at all / broken shape.
 *   - 'foreign-version'  — a real index from another router generation.
 *   - 'integrity-failed' — right version, right shape, but the self-digest does
 *     not match: corruption (sync conflict, truncated write, hand edit).
 *
 * The index file is VAULT CONTENT — hand-editable, attacker-influenced on a
 * shared vault. A shape that merely looks plausible must not be scored: an
 * index missing `idf` would weight every term 0 and answer "nothing matches"
 * for every query (a silent lie), and a non-object `postings` would throw a raw
 * TypeError instead of an actionable refusal. (Fable 5 review, v0.63.0.)
 *
 * @returns {'malformed'|'foreign-version'|'integrity-failed'|null}
 */
export function indexProblem(index) {
  if (!index || typeof index !== 'object') return 'malformed';
  if (index.version !== INDEX_VERSION) return 'foreign-version';
  const shapeOk =
    Array.isArray(index.chunks) &&
    index.postings &&
    typeof index.postings === 'object' &&
    index.idf &&
    typeof index.idf === 'object' &&
    typeof index.avgdl === 'number' &&
    Number.isFinite(index.avgdl);
  if (!shapeOk) return 'malformed';
  // A non-empty index MUST have postings and IDF: a chunk list with an empty
  // postings map is accepted arithmetic-wise but answers "nothing matches" for
  // every query — a silent lie about the vault's contents.
  if (
    index.chunks.length > 0 &&
    (Object.keys(index.postings).length === 0 || Object.keys(index.idf).length === 0)
  ) {
    return 'integrity-failed';
  }
  // Self-digest over metadata + scored payload: catches postings/chunks
  // desynchronisation and metadata tampering that no corpus fingerprint can see.
  const digestOk =
    typeof index.integrity === 'string' &&
    index.integrity ===
      indexIntegrityDigest({
        version: index.version,
        fingerprint: index.fingerprint,
        stats: index.stats,
        chunks: index.chunks,
        postings: index.postings,
        idf: index.idf,
        avgdl: index.avgdl,
      });
  if (!digestOk) return 'integrity-failed';
  return null;
}

/**
 * True when `index` is a usable index of the expected shape and version.
 * A foreign version is REFUSED rather than scored — see INDEX_VERSION.
 */
export function isUsableIndex(index) {
  return indexProblem(index) === null;
}

/**
 * Does this parsed JSON CLAIM to be one of our search indexes?
 *
 * A much weaker question than `isUsableIndex`, and deliberately so. It answers
 * "is this file ours to rewrite" — not "can it be scored". The two are
 * different and conflating them costs data:
 *
 *   - a v2 index whose postings were corrupted by a sync conflict is NOT
 *     scorable, but it IS ours, and rebuilding it is the repair;
 *   - a hand-written `{"notes": [...]}` a user parked at that path is perfectly
 *     valid JSON, is NOT ours, and rebuilding over it destroys their file.
 *
 * `indexProblem` calls both of those 'malformed', so an automatic repair path
 * cannot use it to tell them apart. This predicate is the one it uses instead:
 * a numeric `version` PLUS at least one structural field this builder always
 * emits. A file that carries neither never came out of `buildSearchIndex`.
 *
 * Own-property lookups throughout: `{"__proto__": {...}}` parsed from vault
 * JSON must not answer for a field it does not carry.
 */
export function looksLikeSearchIndex(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const own = (key) => Object.prototype.hasOwnProperty.call(parsed, key);
  if (!own('version') || typeof parsed.version !== 'number') return false;
  return own('postings') || own('chunks') || own('fingerprint');
}

/**
 * What may an AUTOMATIC rebuild do about the file currently at the index path?
 *
 * THE FAILURE THIS PREVENTS. Two router generations sharing a synced vault, each
 * with a different `INDEX_VERSION`. Both consider the other's index unusable —
 * correctly. If both then rebuild, every session on machine A rewrites the file,
 * every session on machine B rewrites it back, and the vault's sync history
 * fills with an index that is never right for whoever reads it next. Neither
 * side is wrong on its own; the loop only exists because the rebuild is
 * automatic. So an automatic path REFUSES a foreign version and says so. A
 * version migration is an explicit act, performed once, by a human calling
 * `build_search_index`.
 *
 * The other three answers follow the same rule — an unattended path may repair
 * what is unambiguously ours, and must not touch anything else:
 *
 *   absent            → 'build'     nothing to lose.
 *   ours + stale      → 'rebuild'   the corpus moved; that is the job.
 *   ours + corrupt    → 'rebuild'   integrity or shape broken at OUR version.
 *   ours + current    → 'skip'
 *   numeric foreign   → 'incompatible'  another generation's index. Preserve.
 *   anything else     → 'foreign'   unparseable, or not claiming to be an index
 *                                   at all: somebody's file. Preserve.
 *
 * Pure: no I/O, no clock. `stored` is the PARSED file, or `null` for absent, or
 * the sentinel `{__unparseable: true}` the readers use for "it is there but it
 * is not JSON".
 *
 * @param {object|null} stored
 * @param {string} corpusFingerprint the fingerprint of the CURRENT corpus
 * @returns {{action:'build'|'rebuild'|'skip'|'incompatible'|'foreign', state:string}}
 */
export function automaticIndexAction(stored, corpusFingerprint) {
  if (stored === null || stored === undefined) return { action: 'build', state: 'absent' };
  if (stored.__unparseable === true) return { action: 'foreign', state: 'unparseable' };
  if (!looksLikeSearchIndex(stored)) return { action: 'foreign', state: 'foreign-file' };
  // A numeric version that is not ours: a real index from another generation.
  if (stored.version !== INDEX_VERSION) return { action: 'incompatible', state: 'foreign-version' };

  const problem = indexProblem(stored);
  if (problem !== null) {
    // Same version, so this IS ours — repairing it is the point. ('malformed'
    // here means a broken shape at our own version, not a stranger's file:
    // `looksLikeSearchIndex` already ruled that out above.)
    return { action: 'rebuild', state: problem === 'malformed' ? 'shape-broken' : problem };
  }
  if (stored.fingerprint === corpusFingerprint) return { action: 'skip', state: 'current' };
  return { action: 'rebuild', state: 'stale' };
}

/** Message for "another router generation owns this file; we will not fight it". */
export function incompatibleIndexMessage(vaultName, found) {
  const v = found && typeof found.version !== 'undefined' ? String(found.version) : 'unknown';
  return (
    `The local search index for vault "${vaultName}" is version ${v}; this router speaks version ` +
    `${INDEX_VERSION}. It was LEFT UNTOUCHED — two router generations rebuilding each other's index ` +
    `on every session would churn the file forever. Migrate deliberately: ${rebuildHint(vaultName)}`
  );
}

/** Own-property lookup — never inherit from Object.prototype (a token like
 * "constructor" must not resolve to a function on parsed JSON). */
function ownLookup(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * Rank the index's chunks against `query` with BM25.
 *
 * Only the postings of the query's own tokens are visited, so cost scales with
 * the query, not the corpus. Ties are broken deterministically on (path,
 * ordinal) so equal scores never reorder between runs.
 *
 * `keep` filters DURING ranking, before the limit is applied. Post-filtering a
 * capped page could return an empty result while matches existed further down
 * (an archive-heavy corpus pushing every eligible hit past the cap) — a silent
 * empty answer, the failure mode this tier exists to avoid. Filtering here means
 * the caller always receives up to `limit` ELIGIBLE hits. (Fable 5 review.)
 *
 * @param {(chunk:object)=>boolean} [params.keep] eligibility predicate.
 * @returns {{hits: Array, scored: number, rejected: number, tokens: string[]}}
 */
export function queryIndex({ index, query, limit = DEFAULT_LIMIT, k1 = DEFAULT_K1, b = DEFAULT_B, keep = null }) {
  const validation = validateQuery(query);
  if (!validation.ok) {
    const err = new Error(validation.message);
    err.kind = 'validation';
    err.reason = validation.reason;
    throw err;
  }
  const max = clampLimit(limit);
  const chunks = index.chunks || [];
  const avgdl = typeof index.avgdl === 'number' && index.avgdl > 0 ? index.avgdl : 1;

  const scores = new Map();
  for (const token of validation.tokens) {
    const postings = ownLookup(index.postings, token);
    // Vault-authored JSON: a posting list must BE a list, and each entry a
    // [ordinal, tf] pair — anything else is skipped rather than thrown on.
    if (!Array.isArray(postings)) continue;
    const idfRaw = ownLookup(index.idf, token);
    const idfW = typeof idfRaw === 'number' && Number.isFinite(idfRaw) ? idfRaw : 0;
    if (idfW <= 0) continue;
    for (const entry of postings) {
      if (!Array.isArray(entry)) continue;
      const [ordinal, tf] = entry;
      if (!Number.isInteger(ordinal) || typeof tf !== 'number' || !Number.isFinite(tf) || tf <= 0) continue;
      const chunk = chunks[ordinal];
      if (!chunk) continue;
      const dl = typeof chunk.len === 'number' && Number.isFinite(chunk.len) ? chunk.len : 0;
      const lenNorm = 1 - b + b * (dl / avgdl);
      const add = idfW * ((tf * (k1 + 1)) / (tf + k1 * lenNorm));
      if (!Number.isFinite(add)) continue;
      scores.set(ordinal, (scores.get(ordinal) || 0) + add);
    }
  }

  const ranked = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b2) => {
      if (b2[1] !== a[1]) return b2[1] - a[1];
      // Deterministic tie-break: path, then ordinal.
      const ca = chunks[a[0]];
      const cb = chunks[b2[0]];
      if (ca.path !== cb.path) return ca.path < cb.path ? -1 : 1;
      return a[0] - b2[0];
    });

  const hits = [];
  let rejected = 0;
  for (const [ordinal, score] of ranked) {
    const c = chunks[ordinal];
    if (keep && !keep(c)) {
      rejected += 1;
      continue;
    }
    if (hits.length >= max) continue; // keep counting rejections for an honest total
    hits.push({
      path: c.path,
      title: c.title,
      ...(c.description ? { description: c.description } : {}),
      ...(c.section ? { section: c.section } : {}),
      score,
      excerpt: c.preview ?? '',
    });
  }

  return { hits, scored: ranked.length, rejected, tokens: validation.tokens };
}

// ---------------------------------------------------------------------------
// Actionable diagnostics (C4: an absent/stale index must say what to do)
// ---------------------------------------------------------------------------

/**
 * The exact command that (re)builds the index — quoted verbatim in every
 * absent/stale/foreign-version message so the reader never has to go hunting.
 */
export function rebuildHint(vaultName) {
  const target = vaultName ? ` with vault: "${vaultName}"` : '';
  return `Build it by calling the \`build_search_index\` tool${target} (deterministic, local, no plugin required).`;
}

/** Message for "no index at all". */
export function absentIndexMessage(vaultName) {
  return (
    `No local search index for vault "${vaultName}" (expected at ${SEARCH_INDEX_PATH}). ` +
    rebuildHint(vaultName)
  );
}

/** Message for "index exists but this router cannot read its shape/version". */
export function unusableIndexMessage(vaultName, found, problem = null) {
  const p = problem ?? indexProblem(found);
  // Name the ACTUAL problem: a same-version corrupted index reported as a
  // version mismatch pointed the operator at an upgrade that does not exist
  // (post-release Codex verification, v0.63.1).
  if (p === 'integrity-failed') {
    return (
      `The local search index for vault "${vaultName}" is CORRUPT — its integrity self-check failed ` +
      `(a hand edit, a sync conflict, or an interrupted write left the file inconsistent with itself), ` +
      `so this router refuses to score against it. ${rebuildHint(vaultName)}`
    );
  }
  if (p === 'foreign-version') {
    const v = found && typeof found.version !== 'undefined' ? String(found.version) : 'unknown';
    return (
      `The local search index for vault "${vaultName}" is version ${v}; this router speaks version ` +
      `${INDEX_VERSION}, so it refuses to score against a shape it may misread. ${rebuildHint(vaultName)}`
    );
  }
  return (
    `The file at ${SEARCH_INDEX_PATH} in vault "${vaultName}" is not a readable search index, ` +
    `so this router refuses to score against it. ${rebuildHint(vaultName)}`
  );
}

/**
 * Message for "the index exists and is well-formed, but indexes NOTHING".
 * Usually a layout problem (no `wiki/` directory, or the content lives
 * elsewhere) — never something to answer with an empty result set.
 */
export function emptyIndexMessage(vaultName) {
  return (
    `The local search index for vault "${vaultName}" is EMPTY — it indexes 0 chunks, so it can never ` +
    `match anything. This usually means the vault has no \`wiki/\` directory or its content lives ` +
    `elsewhere; it is NOT the same as "nothing matches your query". Check the vault layout, then ` +
    rebuildHint(vaultName)
  );
}

/** Message for "index is readable but the vault moved since it was built". */
export function staleIndexMessage(vaultName) {
  return (
    `The local search index for vault "${vaultName}" is STALE — the vault changed since it was built, ` +
    `so recent edits are missing from these results. ${rebuildHint(vaultName)}`
  );
}

export const _internals = { parseHeading, derivePageTitle };
