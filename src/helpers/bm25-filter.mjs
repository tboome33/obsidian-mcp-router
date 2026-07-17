/**
 * BM25 second-pass relevance filter over already-acquired markdown.
 *
 * Borrowing #1 from Crawl4AI (workflow W-A of the "emprunts externes" roadmap):
 * crawl4ai runs a cheap `PruningContentFilter` then a `BM25ContentFilter` on the
 * same fetched HTML. The router's first pass (chrome stripping) is already done
 * by defuddle / MarkItDown; THIS is the second pass — a topical-relevance filter
 * applied to markdown the caller already holds, with NO re-fetch.
 *
 * When an ingestion knows WHY it is ingesting a page (a targeted user request, an
 * autoresearch question), most blocks of a defuddled article are off-topic
 * (lifestyle intro, author bio, newsletter callout, digressions). This filter
 * keeps only the blocks that score above a relevance threshold, so downstream
 * synthesis works on denser, cheaper, less noisy content.
 *
 * Zero LLM calls, zero network, zero new npm dependency, fully deterministic.
 * Reuses the repo's `tokenise` (Unicode-aware, ≥3-char tokens) and `computeIdf`
 * (smoothed IDF) from `./idf-score.mjs` — import, not copy.
 *
 * -------------------------------------------------------------------------
 * FROZEN SPEC (W-A, 2026-07-17) — see the vault page
 * [[bm25-filter-implementation-roadmap]] §4 for the full rationale.
 *
 * Segmentation (`segmentBlocks`):
 *   1. Leading YAML frontmatter (`---…---` at position 0) → kept verbatim, never
 *      scored.
 *   2. Fenced code blocks (``` / ~~~, info-string included) → ONE block each,
 *      internal blank lines included; a fence is never split.
 *   3. Everything else → blocks separated by ≥1 blank line.
 *   4. ATX headings (`#`…`######` + space) → their own block, ALWAYS kept (a
 *      heading whose whole section is filtered stays visible — it signals to the
 *      reader that content lived there).
 *   5. Scored blocks = prose + code (paragraphs, lists, tables, quotes, code).
 *   6. A code block inherits the score of the NEAREST PRECEDING scored prose
 *      block WITHIN THE SAME SECTION (a code sample belongs to the paragraph that
 *      introduces it); a heading RESETS that anchor, so a code block never
 *      inherits relevance across a heading boundary. If no prose precedes it in
 *      the section, it keeps its own BM25 score. (Refinement over the original
 *      W-A spec after the /review+ gate flagged cross-heading inheritance as a
 *      relevance leak — 2026-07-17.)
 *   7. Reassembly: kept blocks, ORIGINAL order, joined by `\n\n`.
 *
 * Scoring (`bm25FilterBlocks`):
 *   - Standard BM25 with k1=1.2, b=0.75 (textbook defaults; overridable in the
 *     helper, NOT exposed on the tool schema).
 *   - Tokenisation: `tokenise()` for both the query and the blocks.
 *   - IDF: `computeIdf()` over the scored blocks of THIS document (block = doc).
 *     NOTE — deliberate deviation from textbook BM25: the repo's smoothed IDF
 *     `log(1 + N/(1+df))` is ALWAYS ≥ 0, whereas classic BM25 IDF goes negative
 *     for a term present in >50% of blocks (undesirable here). Repo consistency
 *     wins over academic purity.
 *   - avgdl: mean token count over the scored blocks.
 *   - Threshold: a block is kept when `finalScore / max(finalScore) ≥ threshold`
 *     (default 0.2, clamped to [0,1]).
 *   - Guards, IN THIS ORDER:
 *       1. query has no usable token (≥3 chars) → strict no-op, reason
 *          `empty-query`, output byte-identical to input.
 *       2. fewer than MIN_SCORED_BLOCKS (4) scored blocks → no-op, reason
 *          `too-few-blocks` (document too small for filtering to make sense).
 *       3. scoring would drop > MAX_DROP_FRACTION (70%) of scored blocks — or the
 *          query matches nothing (max score 0) → return the ORIGINAL intact,
 *          `usedFallback: true`, reason `over-filter-guard` (same philosophy as
 *          defuddle-extract's `usedFallback`).
 *   - If scoring runs but drops nothing → return the ORIGINAL intact,
 *     `filtered: false`, reason `nothing-dropped` (avoids whitespace churn; keeps
 *     the invariant "filtered: true ⇒ real content was removed").
 *
 * v1 limitation (assumed): exact-token matching, no stemming / synonyms —
 * `équations` does not match `équation`. That is the price of zero-dependency;
 * semantic search lives in the Kiviri stack (decision D5), not here.
 * -------------------------------------------------------------------------
 */

import { tokenise, computeIdf } from './idf-score.mjs';

// ---------------------------------------------------------------------------
// Frozen constants (W-A spec §4)
// ---------------------------------------------------------------------------

export const DEFAULT_THRESHOLD = 0.2;
export const MAX_DROP_FRACTION = 0.7;
export const MIN_SCORED_BLOCKS = 4;
export const DEFAULT_K1 = 1.2;
export const DEFAULT_B = 0.75;

// ATX heading: 1–6 leading '#' then a space. `#tag` (Obsidian tag) and 7+ hashes
// are intentionally NOT headings (CommonMark).
const HEADING_RE = /^#{1,6}\s/;
// Opening fence: optional indent, then 3+ backticks or 3+ tildes, info string
// allowed after. A CLOSING fence is bare (marker + optional trailing space).
const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^(\s*)(`{3,}|~{3,})\s*$/;

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

/**
 * Split markdown into typed blocks. Deterministic, no I/O.
 *
 * @param {string} markdown
 * @returns {Array<{ type: 'frontmatter'|'heading'|'prose'|'code', text: string }>}
 */
export function segmentBlocks(markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  if (text === '') return [];
  // Split on both LF and CRLF so CRLF-served pages don't leave a trailing `\r`
  // on every line (which would then interleave with the `\n\n` block joins on
  // the reassembly path). No-op returns in `bm25FilterBlocks` use the raw
  // `original`, so this normalization never affects byte-identity.
  const lines = text.split(/\r?\n/);
  const n = lines.length;
  const blocks = [];
  let i = 0;

  // 1. Leading YAML frontmatter — only when the very first line is exactly '---'.
  if (n > 0 && lines[0].trim() === '---') {
    let end = -1;
    for (let j = 1; j < n; j += 1) {
      if (lines[j].trim() === '---') {
        end = j;
        break;
      }
    }
    if (end !== -1) {
      blocks.push({ type: 'frontmatter', text: lines.slice(0, end + 1).join('\n') });
      i = end + 1;
    }
  }

  // 2. Main walk: accumulate prose into `buffer`, split on blank lines, pull
  //    fenced code and headings out as their own blocks.
  let buffer = [];
  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const raw = buffer.join('\n');
    buffer = [];
    if (raw.trim() === '') return;
    blocks.push({ type: 'prose', text: raw });
  };

  while (i < n) {
    const line = lines[i];

    if (line.trim() === '') {
      flushBuffer();
      i += 1;
      continue;
    }

    const fenceOpen = line.match(FENCE_OPEN_RE);
    if (fenceOpen) {
      flushBuffer();
      const marker = fenceOpen[2][0]; // '`' or '~'
      const markerLen = fenceOpen[2].length;
      const codeLines = [line];
      i += 1;
      while (i < n) {
        const cl = lines[i];
        codeLines.push(cl);
        i += 1;
        const close = cl.match(FENCE_CLOSE_RE);
        if (close && close[2][0] === marker && close[2].length >= markerLen) break;
      }
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    if (HEADING_RE.test(line)) {
      flushBuffer();
      blocks.push({ type: 'heading', text: line });
      i += 1;
      continue;
    }

    buffer.push(line);
    i += 1;
  }
  flushBuffer();

  return blocks;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Raw BM25 score of one block's tokens against the (deduped) query tokens.
 * A query term absent from the block contributes nothing; the IDF fallback of 0
 * is unreachable in practice (an absent term has tf 0 and is skipped) but kept
 * defensively.
 */
function bm25Raw(blockTokens, queryTokens, idf, avgdl, k1, b) {
  const tf = new Map();
  for (const t of blockTokens) tf.set(t, (tf.get(t) || 0) + 1);
  const dl = blockTokens.length;
  const lenNorm = 1 - b + b * (avgdl > 0 ? dl / avgdl : 0);
  let score = 0;
  for (const qt of queryTokens) {
    const f = tf.get(qt);
    if (!f) continue;
    const idfW = idf.has(qt) ? idf.get(qt) : 0;
    score += idfW * ((f * (k1 + 1)) / (f + k1 * lenNorm));
  }
  return score;
}

function clampThreshold(value) {
  // Coerce a numeric string (a lax MCP client may send "0.2") before validating,
  // so an out-of-shape-but-parseable value isn't silently swapped for the default.
  // null / undefined / boolean fall through to the default (not Number()-coerced).
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.max(0, Math.min(1, n));
}

/**
 * Filter markdown blocks by BM25 relevance to `query`.
 *
 * @param {object} params
 * @param {string} params.markdown        markdown already in hand (no fetch).
 * @param {string} params.query           relevance topic (ingestion keywords).
 * @param {number} [params.threshold=0.2] normalized cutoff in [0,1].
 * @param {number} [params.k1=1.2]        BM25 term-frequency saturation.
 * @param {number} [params.b=0.75]        BM25 length normalization.
 * @param {boolean} [params.includeScores=false] attach a per-scored-block `scores` array.
 * @returns {{ markdown: string, filtered: boolean, stats: object, scores?: Array }}
 */
export function bm25FilterBlocks(params = {}) {
  // `params || {}` also absorbs an explicit `null` (the `= {}` default only
  // covers `undefined`) — the helper degrades to a no-op on ANY input, never
  // throws (codex /review+ finding, 2026-07-17).
  const {
    markdown,
    query,
    threshold = DEFAULT_THRESHOLD,
    k1 = DEFAULT_K1,
    b = DEFAULT_B,
    includeScores = false,
  } = params || {};
  const original = typeof markdown === 'string' ? markdown : '';
  const thr = clampThreshold(threshold);
  const blocks = segmentBlocks(original);

  const scoredIndices = [];
  for (let idx = 0; idx < blocks.length; idx += 1) {
    const t = blocks[idx].type;
    if (t === 'prose' || t === 'code') scoredIndices.push(idx);
  }

  // `stats` always describes the SCORING decision (kept/dropped count SCORED
  // blocks); `filtered` / `usedFallback` say whether that decision was applied to
  // the returned markdown. Frontmatter + headings are never scored and are always
  // present in the output, so they are excluded from these counts.
  const baseStats = () => ({
    totalBlocks: blocks.length,
    scoredBlocks: scoredIndices.length,
    kept: scoredIndices.length,
    dropped: 0,
    dropFraction: 0,
    threshold: thr,
    usedFallback: false,
    reason: null,
  });

  const noop = (reason, extra = {}) => {
    const result = {
      markdown: original,
      filtered: false,
      stats: { ...baseStats(), reason, ...extra },
    };
    if (includeScores) result.scores = [];
    return result;
  };

  // Guard 1 — query with no usable token.
  const queryTokens = [...new Set(tokenise(typeof query === 'string' ? query : ''))];
  if (queryTokens.length === 0) return noop('empty-query');

  // Guard 2 — document too small to filter meaningfully.
  if (scoredIndices.length < MIN_SCORED_BLOCKS) return noop('too-few-blocks');

  // Score every scored block.
  const tokenArrays = scoredIndices.map((idx) => tokenise(blocks[idx].text));
  const idf = computeIdf(tokenArrays);
  const totalTokens = tokenArrays.reduce((s, arr) => s + arr.length, 0);
  const avgdl = totalTokens / scoredIndices.length;

  const rawByIdx = new Map();
  scoredIndices.forEach((idx, k) => {
    rawByIdx.set(idx, bm25Raw(tokenArrays[k], queryTokens, idf, avgdl, k1, b));
  });

  // Inheritance: a code block takes the nearest preceding scored-prose block's
  // raw score WITHIN THE SAME SECTION; if none precedes it in the section, it
  // keeps its own. A heading opens a new section and RESETS the anchor, so a code
  // block never inherits relevance across a heading boundary (which would keep an
  // off-topic snippet just because on-topic prose sat above an unrelated
  // heading). Walk ALL blocks so headings are visible to the reset.
  const finalByIdx = new Map();
  let lastProseRaw = null;
  for (let idx = 0; idx < blocks.length; idx += 1) {
    const type = blocks[idx].type;
    if (type === 'heading') {
      lastProseRaw = null;
      continue;
    }
    if (type === 'frontmatter') continue;
    if (type === 'code') {
      finalByIdx.set(idx, lastProseRaw !== null ? lastProseRaw : rawByIdx.get(idx));
    } else {
      const r = rawByIdx.get(idx);
      finalByIdx.set(idx, r);
      lastProseRaw = r;
    }
  }

  let maxScore = 0;
  for (const idx of scoredIndices) {
    const s = finalByIdx.get(idx);
    if (s > maxScore) maxScore = s;
  }

  const buildScores = () =>
    scoredIndices.map((idx) => {
      const final = finalByIdx.get(idx);
      return {
        index: idx,
        type: blocks[idx].type,
        raw: rawByIdx.get(idx),
        final,
        normalized: maxScore > 0 ? final / maxScore : 0,
        kept: maxScore > 0 && final / maxScore >= thr,
      };
    });

  // Guard 3a — query matched nothing anywhere (max score 0 → would drop all).
  if (maxScore <= 0) {
    const result = {
      markdown: original,
      filtered: false,
      stats: {
        ...baseStats(),
        kept: 0,
        dropped: scoredIndices.length,
        dropFraction: 1,
        usedFallback: true,
        reason: 'over-filter-guard',
      },
    };
    if (includeScores) result.scores = buildScores();
    return result;
  }

  const keepScored = new Set();
  for (const idx of scoredIndices) {
    if (finalByIdx.get(idx) / maxScore >= thr) keepScored.add(idx);
  }
  const droppedCount = scoredIndices.length - keepScored.size;
  const dropFraction = droppedCount / scoredIndices.length;

  // Guard 3b — would drop too much of the document.
  if (dropFraction > MAX_DROP_FRACTION) {
    const result = {
      markdown: original,
      filtered: false,
      stats: {
        ...baseStats(),
        kept: scoredIndices.length - droppedCount,
        dropped: droppedCount,
        dropFraction,
        usedFallback: true,
        reason: 'over-filter-guard',
      },
    };
    if (includeScores) result.scores = buildScores();
    return result;
  }

  // Nothing dropped — return the original untouched (no whitespace churn).
  if (droppedCount === 0) {
    const result = {
      markdown: original,
      filtered: false,
      stats: { ...baseStats(), reason: 'nothing-dropped' },
    };
    if (includeScores) result.scores = buildScores();
    return result;
  }

  // Reassemble: frontmatter + headings always kept, scored blocks by decision.
  const outParts = [];
  for (let idx = 0; idx < blocks.length; idx += 1) {
    const blk = blocks[idx];
    if (blk.type === 'frontmatter' || blk.type === 'heading') {
      outParts.push(blk.text);
    } else if (keepScored.has(idx)) {
      outParts.push(blk.text);
    }
  }
  const outMarkdown = outParts.join('\n\n');

  const result = {
    markdown: outMarkdown,
    filtered: true,
    stats: {
      ...baseStats(),
      kept: scoredIndices.length - droppedCount,
      dropped: droppedCount,
      dropFraction,
      reason: null,
    },
  };
  if (includeScores) result.scores = buildScores();
  return result;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _internals = {
  HEADING_RE,
  FENCE_OPEN_RE,
  FENCE_CLOSE_RE,
  bm25Raw,
  clampThreshold,
};
