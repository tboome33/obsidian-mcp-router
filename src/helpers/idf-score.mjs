/**
 * IDF-weighted candidate scoring with dynamic seed selection.
 *
 * Port of graphify's `_compute_idf` + `_score_nodes` + `_pick_seeds`
 * (`graphify/serve.py:300-325`). The trio solves the canonical "user
 * asks a free-text question, we have N candidate pages — pick the most
 * relevant 1-3 to drill into" problem cheaply and robustly.
 *
 * Why all three together:
 *   - **IDF** suppresses noise terms (`user`, `error`, `create`, `the`)
 *     that appear in half the wiki. Without IDF, a 4-word query
 *     ["user", "trade", "stop", "loss"] gives `user` and `trade` equal
 *     weight, but `trade` is probably the discriminating term.
 *   - **Three-tier scoring** (exact ×1000 / prefix ×100 / substring ×1)
 *     captures the intuition that an exact title match crushes a
 *     substring hit. With IDF, a rare-term substring still beats a
 *     common-term exact, which is usually right.
 *   - **Dominant-match seed pruning** (top > 5× runner-up → single
 *     seed) is graphify's fix for issue #897 — multi-weak-seed
 *     traversal produces incoherent multi-page synthesis.
 *
 * Future use sites:
 *   - `wiki-query` drill step (instructs Claude to apply this scoring
 *     when ranking candidate pages from the index).
 *   - T2.A `wiki-neighbors` — endpoint lookup (target page resolution).
 *   - T2.B `wiki-path` — endpoint disambiguation.
 *   - T2.C `wiki-explain` — backlink ranking by query relevance.
 *   - T3.A `wiki-export-graph` — search bar in the HTML viz.
 */

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

// Min token length — graphify drops everything ≤2 chars from the query.
// Same rationale: 1- and 2-letter tokens are almost always stopwords or
// junk fragments after splitting on punctuation.
const MIN_TOKEN_LEN = 3;

// Split on anything that isn't a Unicode letter or number. Lowercase
// preserves Unicode (Turkish dotted I, French ç) better than .toLowerCase()
// on raw bytes; the Unicode-aware regex matches accented characters.
const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;

/**
 * Tokenise a free-text string into a normalised array of tokens.
 *
 * Steps:
 *   1. Lowercase (locale-insensitive — we don't want en-US Turkish-I).
 *   2. Split on non-letter/number runs.
 *   3. Drop empty tokens.
 *   4. Drop tokens shorter than `MIN_TOKEN_LEN` (graphify's noise filter).
 *
 * Stable, deterministic, no I/O.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenise(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

// ---------------------------------------------------------------------------
// IDF computation
// ---------------------------------------------------------------------------

/**
 * Compute inverse-document-frequency weights over a corpus.
 *
 * Formula (graphify-compatible): `idf(t) = log(1 + N / (1 + df(t)))`
 *   - N = total number of documents
 *   - df(t) = number of documents containing token t at least once
 *   - +1 in denominator avoids divide-by-zero for novel terms
 *   - log smooths so a single rare term doesn't drown out the others
 *
 * @param {Iterable<Iterable<string>>} documents
 *   Each document is an iterable of pre-tokenised strings (use `tokenise()`).
 * @returns {Map<string, number>}
 *   token → IDF weight. A token absent from the map should be assigned
 *   `log(1 + N / 1) = log(1 + N)` by callers (the max possible weight,
 *   reflecting that we have no evidence the term is common).
 */
export function computeIdf(documents) {
  const df = new Map();
  let n = 0;
  for (const doc of documents) {
    n += 1;
    const seen = new Set();
    for (const token of doc) {
      if (seen.has(token)) continue;
      seen.add(token);
      df.set(token, (df.get(token) || 0) + 1);
    }
  }
  const idf = new Map();
  if (n === 0) return idf;
  for (const [token, count] of df) {
    idf.set(token, Math.log(1 + n / (1 + count)));
  }
  return idf;
}

// IDF weight assumed for tokens not present in the corpus map — full
// weight, since we have no evidence the term is common.
export function defaultIdf(corpusSize) {
  return Math.log(1 + corpusSize);
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

const EXACT_WEIGHT = 1000;
const PREFIX_WEIGHT = 100;
const SUBSTRING_WEIGHT = 1;
const SECONDARY_MULTIPLIER = 0.5;

/**
 * Score one candidate string against one query token.
 * Returns the unweighted match strength.
 *
 *   - exact match (case-insensitive equality) → EXACT_WEIGHT
 *   - prefix match (string starts with token) → PREFIX_WEIGHT
 *   - substring match (string contains token) → SUBSTRING_WEIGHT
 *   - no match → 0
 *
 * Inputs are expected lowercased by the caller (avoid per-call .toLowerCase
 * inside a hot loop).
 */
function tokenMatchStrength(lowerCandidate, lowerToken) {
  if (lowerCandidate === lowerToken) return EXACT_WEIGHT;
  if (lowerCandidate.startsWith(lowerToken)) return PREFIX_WEIGHT;
  if (lowerCandidate.includes(lowerToken)) return SUBSTRING_WEIGHT;
  return 0;
}

/**
 * Score a list of candidates against a query.
 *
 * Each candidate must have at least a `label` field. Optional:
 *   - `aliases: string[]` — additional strings matched at full weight
 *     (use for "also known as", H1 vs title-frontmatter mismatch, etc.).
 *   - `secondaryLabel: string` — matched with SECONDARY_MULTIPLIER weight
 *     (use for folder paths, breadcrumbs — they should boost but not
 *     dominate a real label match).
 *
 * Tokens with zero IDF entry get `defaultIdf(corpusSize)`. Pass `corpusSize`
 * to control that floor; defaults to a finite value so the algorithm still
 * runs when called without a prebuilt IDF map.
 *
 * Returns the candidates wrapped with their scores, sorted by score desc.
 * Ties broken by the original order (stable sort in modern V8).
 *
 * @param {object} params
 * @param {string} params.query
 * @param {Array<{label: string, aliases?: string[], secondaryLabel?: string}>} params.candidates
 * @param {Map<string, number>} [params.idf]
 * @param {number} [params.corpusSize]
 * @returns {Array<{candidate: object, score: number}>}
 */
export function scoreCandidates({
  query,
  candidates,
  idf = new Map(),
  corpusSize = candidates.length,
}) {
  const queryTokens = tokenise(query);
  if (queryTokens.length === 0 || candidates.length === 0) {
    return candidates.map((c) => ({ candidate: c, score: 0 }));
  }

  const fallback = defaultIdf(corpusSize);

  const scored = candidates.map((candidate) => {
    if (!candidate || typeof candidate.label !== 'string') {
      return { candidate, score: 0 };
    }
    const primary = candidate.label.toLowerCase();
    const aliases = Array.isArray(candidate.aliases)
      ? candidate.aliases.map((a) => (typeof a === 'string' ? a.toLowerCase() : ''))
      : [];
    const secondary =
      typeof candidate.secondaryLabel === 'string'
        ? candidate.secondaryLabel.toLowerCase()
        : null;

    let total = 0;
    for (const token of queryTokens) {
      const weight = idf.has(token) ? idf.get(token) : fallback;

      // Primary label + aliases (full weight).
      let strength = tokenMatchStrength(primary, token);
      for (const alias of aliases) {
        const altStrength = tokenMatchStrength(alias, token);
        if (altStrength > strength) strength = altStrength;
      }
      total += weight * strength;

      // Secondary label (half weight).
      if (secondary !== null) {
        const secStrength = tokenMatchStrength(secondary, token);
        total += weight * secStrength * SECONDARY_MULTIPLIER;
      }
    }
    return { candidate, score: total };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---------------------------------------------------------------------------
// Dynamic seed picking
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SEEDS = 3;
const DEFAULT_DOMINANCE_RATIO = 5;

/**
 * Pick up to N seeds from a ranked-and-scored list.
 *
 * Dominant-match rule: if the top score is more than `dominanceRatio` times
 * the second-best score, return only the top one. This is graphify's fix
 * for issue #897 — a dominant match is unambiguous, so multi-seed traversal
 * would only dilute the answer with weak candidates.
 *
 * Edge cases:
 *   - Empty input → []
 *   - Single candidate → that candidate (no runner-up to compare).
 *   - All zeros → first `maxSeeds` candidates (the caller passed something
 *     useless; return something rather than nothing).
 *   - Second-best is zero → top is automatically dominant (n / 0 = infinity).
 *
 * @param {Array<{score: number, candidate: object}>} scored
 *   Must be sorted by score desc (output shape of `scoreCandidates`).
 * @param {object} [opts]
 * @param {number} [opts.maxSeeds=3]
 * @param {number} [opts.dominanceRatio=5]
 * @returns {object[]} The candidate objects (unwrapped).
 */
export function pickSeeds(scored, opts = {}) {
  const { maxSeeds = DEFAULT_MAX_SEEDS, dominanceRatio = DEFAULT_DOMINANCE_RATIO } = opts;
  if (!Array.isArray(scored) || scored.length === 0) return [];
  if (scored.length === 1) return [scored[0].candidate];

  const top = scored[0];
  const second = scored[1];

  // All-zero scores: caller didn't get useful matches; return up to
  // maxSeeds candidates anyway so the calling skill has something to
  // fall back on rather than an empty list.
  if (top.score === 0) {
    return scored.slice(0, maxSeeds).map((s) => s.candidate);
  }

  // Dominant top: skip the rest entirely.
  // Special-case second.score === 0 (top is uniquely matching) — treat as
  // dominant without doing a div-by-zero.
  if (second.score === 0 || top.score > dominanceRatio * second.score) {
    return [top.candidate];
  }

  return scored.slice(0, maxSeeds).map((s) => s.candidate);
}

// ---------------------------------------------------------------------------
// One-shot convenience
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: tokenise → score → pickSeeds in one call.
 * Most callers want this — the three-step API is exposed for use sites
 * that need to inspect or cache intermediate state.
 *
 * @param {object} params
 * @param {string} params.query
 * @param {Array<object>} params.candidates
 * @param {Map<string, number>} [params.idf]
 * @param {object} [params.seedOpts]
 * @returns {object[]}
 */
export function rankAndPick({ query, candidates, idf, seedOpts }) {
  const scored = scoreCandidates({ query, candidates, idf });
  return pickSeeds(scored, seedOpts);
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _internals = {
  MIN_TOKEN_LEN,
  TOKEN_SPLIT,
  EXACT_WEIGHT,
  PREFIX_WEIGHT,
  SUBSTRING_WEIGHT,
  SECONDARY_MULTIPLIER,
  DEFAULT_MAX_SEEDS,
  DEFAULT_DOMINANCE_RATIO,
  tokenMatchStrength,
};
