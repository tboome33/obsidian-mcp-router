/**
 * twin-pages — C11 of [[roadmap-emprunts]] §2.17. DETERMINISTIC detection of
 * QUASI-TWIN pages: the pairs a vault grows when the same subject is written
 * twice, in two sessions, and neither copy ends up complete.
 *
 * Pure module — no I/O, no clock, no randomness. The same `pages` input always
 * yields byte-identical output. `find_twin_pages` is only the I/O shell around
 * it, the same deterministic-core / thin-tool split as `boundary-score.mjs`.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PAIR CLAIMS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * A reported pair PROPOSES A READING. It does not establish duplication, and
 * it never proposes a merge. Two pages can be near-identical in an embedding
 * space and be exactly right as they stand — a per-grade course sheet, a
 * decision and its ADR, a page and its deliberately-split "gotchas" companion.
 * Merging is a judgement about MEANING that this module has no access to, so
 * nothing it emits is phrased as an instruction and no field names an action.
 *
 * ---------------------------------------------------------------------------
 * THE THRESHOLD IS DERIVED PER VAULT — AND THAT IS NOT A PREFERENCE
 * ---------------------------------------------------------------------------
 * Measured on eight real vaults, all indexed with the same model
 * (`TaylorAI/bge-micro-v2`, 384 dims), a FIXED cosine cut is provably wrong:
 *
 *   vault              median pair cosine   pairs at cos ≥ 0.95
 *   router's own vault        0.746                 93 / 14 535
 *   SchoolMouv                0.845                398 / 13 366
 *
 * The two medians differ by 0.10 because one vault is a heterogeneous project
 * log and the other a homogeneous course catalogue. A 0.95 cut that selects 93
 * pairs on the first selects 398 on the second — and against a 5-word-shingle
 * content oracle those 398 were 12% true near-duplicates against the first
 * set's 98%. There is no single number: the SAME cut is a good filter and a
 * flood, depending only on which vault it meets.
 *
 * So the cut is computed FROM THE VAULT'S OWN PAIR DISTRIBUTION. The obvious
 * way — `median + k·MAD` on the cosines — DOES NOT WORK, and the failure is
 * structural rather than a matter of tuning: cosine is bounded above by 1, and
 * on 5 of 6 measured vaults `k = 4` already put the cut past 1.0, where nothing
 * can ever match. A bounded variable has no room for a linear outlier rule.
 *
 * The fix is to do the robust statistics in the space where the variable is not
 * bounded. Let `d = 1 − cos` (a distance: twins have d near 0) and work on
 * `L = ln d`, whose left tail is unbounded:
 *
 *   cut       = median(L) − k · 1.4826 · MAD(L)
 *   threshold = 1 − exp(cut)
 *
 * `1.4826` is the standard normal-consistency factor, so `k` reads in the usual
 * sigma-equivalents. The MEDIAN and the MAD are used rather than the mean and
 * the standard deviation for one concrete reason: the twins are themselves in
 * the sample, and a vault with many of them inflates a standard deviation until
 * it hides the very pairs being looked for. A MAD tolerates up to half the
 * sample being contaminated.
 *
 * `k` IS A STATED CONVENTION, not a calibration — nothing was fitted. It is
 * exported, reported in every result, and overridable per call. The default of
 * 5 was chosen by reading the selections it produces on real vaults: it keeps
 * the lists short enough to actually be read (2–23 pairs across the measured
 * vaults) while still catching the archetypal case — three overlapping roadmap
 * pages in one folder of the KIVIRI vault, which it returns as exactly 3 pairs.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMBINATORIAL BOUND IS OFFERED BUT NOT APPLIED BY DEFAULT
 * ---------------------------------------------------------------------------
 * §2.17 bounds the N² by "same folder or common links". It is implemented here
 * (`restrictTo`) because it is the right instrument on a corpus large enough to
 * need one. It is NOT the default, for two measured reasons.
 *
 *   1. IT COSTS MORE THAN IT SAVES. "Common links" cannot be known without
 *      reading every page body — which is MORE work than the dot products it
 *      would skip. Measured on the router's vault: 19 900 dot products = 7 ms;
 *      reading the 125 bodies the link sets need = 11 ms. The two curves cross
 *      near N ≈ 500 pages, and even past it the saving is bounded by how much
 *      the filter actually removes.
 *   2. IT REMOVES REAL PAIRS, UNEVENLY. Over 347 above-threshold candidate
 *      pairs on four vaults, "same folder OR common links" kept 338 (97.4%) —
 *      but the 2.6% loss is not spread: 9 of 70 on the router's vault (12.9%)
 *      and 0 of 220 on SchoolMouv, where every page links the same hubs so the
 *      clause is true of everything and filters nothing at all. A filter that
 *      is a no-op on one vault and a 13% recall cut on another cannot be a
 *      silent default. Worse, the loss lands exactly where §2.17 warns it will:
 *      two genuine twins born in two sessions are precisely the pair that
 *      shares neither folder nor link.
 *
 * What the folder and link signals ARE good for is TRIAGE, so they travel as
 * EVIDENCE on every reported row instead of as a filter in front of it — and
 * when `restrictTo` is used, the count it removed is always reported.
 *
 * ---------------------------------------------------------------------------
 * THE ASSUMED LIMITATIONS
 * ---------------------------------------------------------------------------
 *  - WHOLE-PAGE VECTORS, AND THE MODEL'S 512-TOKEN WINDOW. A long page cannot
 *    fit, so its vector reflects mostly its head. Observed consequence, on
 *    SchoolMouv: two course sheets sharing a template scored cosine 0.9914 with
 *    a 5-word-shingle overlap of 0.064 — near-identical vectors over almost
 *    entirely different text. TEMPLATED SERIES ARE THIS CHECK'S DOMINANT FALSE
 *    POSITIVE, which is why `sameBasename` is on every row: it makes the
 *    pattern visible at a glance.
 *  - SIMILARITY IS NOT REDUNDANCY. The vector cannot tell "written twice" from
 *    "two facets of one subject, deliberately".
 *  - THE STORE IS A SNAPSHOT. Vectors are only as fresh as the last indexing
 *    pass, and a page edited since carries its old vector. The caller reports
 *    how many indexed paths no longer exist on disk (measured: 108 of 279 on
 *    the router's own vault, 161 of 325 on SchoolMouv) — a stale store is the
 *    normal condition, not an anomaly.
 */

import { cmp } from './total-order.mjs';

/** Sensitivity, in sigma-equivalents of the log-distance MAD. A CONVENTION. */
export const SENSITIVITY_K = 5;
/** Normal-consistency factor turning a MAD into a sigma-equivalent. */
export const MAD_TO_SIGMA = 1.4826;
/**
 * Below this many pairs a median and a MAD describe nothing — a single value
 * moves them — so no threshold is derived and the check reports itself
 * unavailable rather than inventing a cut. 30 pairs ⇔ 9 comparable pages.
 */
export const MIN_PAIRS_FOR_THRESHOLD = 30;
/** Floor on `1 − cos`, so identical vectors (and float overshoot past 1) stay in ln's domain. */
export const MIN_DISTANCE = 1e-12;

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;
/**
 * Refusal ceiling on comparable pages: the most this check may spend without
 * being asked. Past it the caller scopes with `folders` or raises the cap
 * knowingly — it is never silently truncated, because dropping pages would make
 * "no pairs found" a statement about the cap rather than about the vault.
 *
 * MEASURED AT THE CEILING, not extrapolated. One `findTwinPages` call, 384-dim
 * vectors (the fleet's real dimensionality), Node 23 on Windows, peak sampled
 * every 20 ms across the call:
 *
 *     pages   pairs        wall clock   peak heapUsed   peak RSS
 *      1000     499 500        546 ms         96 MB       163 MB
 *      3000   4 498 500      5 777 ms        737 MB       838 MB   ← MAX_PAGES
 *      4000   7 998 000     10 888 ms      1 050 MB     1 190 MB
 *      5000  12 497 500     17 801 ms      2 024 MB     2 209 MB
 *
 * An earlier version of this comment claimed "~4.5M pairs ≈ 1.6 s" from the
 * measured 2.8M dot-products/s. That was wrong by 3.6× and silent about memory,
 * for one reason worth keeping written down: IT COUNTED ONLY THE DOT PRODUCTS.
 * `deriveThreshold` then makes five more full-length JS copies of the pair array
 * (the `Array.from`, the logs, the sorted logs, the deviations, the sorted
 * similarities) and sorts two of them, and that — not the arithmetic — is where
 * both the seconds and the hundreds of megabytes go. Cost is superlinear in
 * pages twice over: pairs grow as N², and every byte of them is copied.
 *
 * The work is also UNCONDITIONAL: the 3000-page run above spent 5.8 s and
 * 737 MB to report 4 pairs. Nothing about a quiet vault makes it cheaper.
 */
export const MAX_PAGES = 3000;
/**
 * Hard ceiling on what `maxPages` may be RAISED to. Without one, `maxPages`
 * was unbounded above and the failure past ~66 000 pages was a raw
 * `RangeError: Invalid array length` from the `Float64Array` allocation —
 * unclassified, with no `kind`, so the router filed a caller mistake under
 * `unknown`. Unreachable on any real vault (the largest of 16 measured holds
 * 180 comparable pages), which is exactly why it must be a stated refusal
 * rather than a crash nobody will ever see coming.
 *
 * 5000 is THE LARGEST SIZE ACTUALLY RUN TO COMPLETION (see the table on
 * MAX_PAGES: 17.8 s, 2.0 GB peak heap, 2.2 GB RSS — at or past the default
 * old-space limit of many Node builds). Nothing above it has been measured, so
 * nothing above it is permitted: a ceiling justified by extrapolation is the
 * error this constant was rewritten to stop repeating.
 */
export const MAX_PAGES_CEILING = 5000;
/**
 * `sensitivity` must be a finite number ≥ 0.
 *
 * The lower bound is not taste, it is the domain. `threshold = 1 − exp(median −
 * k·madσ)`, and `median = median(ln(1−cos)) ≤ ln 2` because `1−cos ≤ 2`. With
 * `k ≥ 0` the exponent can only move DOWN from there, so `exp(...) ≤ 2` and the
 * threshold stays in `[−1, 1]`. A NEGATIVE k walks the exponent up out of that
 * range and the answer stops being a cosine: measured, `k = −10` produced a
 * threshold of −3.42 (every pair matches) and `k = −1e308` produced −Infinity,
 * which `JSON.stringify` writes as `null` — the reader loses the threshold
 * entirely, which is the one number that makes the answer auditable.
 */
export const MIN_SENSITIVITY = 0;

/** How the combinatorics may be bounded. `none` is the default — see the header. */
export const RESTRICT_MODES = Object.freeze(['none', 'folder', 'folder-or-links']);

/**
 * Reasons the check can fail to produce a ranking. NONE of them means "zero
 * pairs".
 *
 * Two SHAPES, and a consumer must not confuse them:
 *   - the first three arrive as a RESPONSE with `available: false`;
 *   - `TOO_MANY_PAGES` arrives as a THROWN refusal (`err.kind === 'validation'`,
 *     `err.reason === 'too-many-pages'`) — there is no response at all, because
 *     the work was never done. It is listed here so that every enumeration of
 *     "ways this check declines to answer" is complete; a list that omitted it
 *     would let a caller believe the ceiling produces an empty ranking.
 *
 * THE DISCRIMINATOR IS `available`. Read that field, not `pairs`. The structural
 * absence of the `pairs` key on an unavailable response is DEFENCE IN DEPTH — it
 * exists so `result.pairs?.length ?? 0` cannot silently report 0 — but a
 * consumer should branch on `available` explicitly rather than infer it.
 */
export const UNAVAILABLE_REASONS = Object.freeze({
  NO_EMBEDDINGS: 'no-embeddings',
  CORPUS_TOO_SMALL: 'corpus-too-small',
  NO_SPREAD: 'no-spread',
  TOO_MANY_PAGES: 'too-many-pages',
});

/** The subset delivered as a response body (the rest are thrown). */
export const UNAVAILABLE_RESPONSE_REASONS = Object.freeze([
  UNAVAILABLE_REASONS.NO_EMBEDDINGS,
  UNAVAILABLE_REASONS.CORPUS_TOO_SMALL,
  UNAVAILABLE_REASONS.NO_SPREAD,
]);

/**
 * The one sentence every caller must carry through to the reader. Exported so
 * the tool, the skill and the tests all quote the SAME words — a note that can
 * drift between layers is a note that stops being a contract.
 */
export const SIGNAL_NOT_ORDER =
  'A pair proposes a reading, not a merge. High similarity means two pages sit close together in the '
  + 'embedding space — it does not establish that either is redundant, and pages that look alike are '
  + 'very often right as they stand (a templated series, a decision and its record, a subject '
  + 'deliberately split in two). Read both before doing anything, and do nothing on this signal alone.';

// ---------------------------------------------------------------------------
// Small numeric primitives
// ---------------------------------------------------------------------------

/**
 * Cosine similarity of two equal-length vectors.
 *
 * The vectors are normalised by the caller (`normalise`), so this is a plain
 * dot product; the length check stays because a truncated dot over mismatched
 * lengths is silently wrong rather than loudly broken.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function dot(a, b) {
  if (a.length !== b.length) {
    throw new TypeError(`twin-pages: cannot compare vectors of length ${a.length} and ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** Unit-length copy of a vector. A zero vector is returned unchanged (its cosine is 0 with everything). */
export function normalise(vec) {
  let sq = 0;
  for (const x of vec) sq += x * x;
  const len = Math.sqrt(sq);
  if (!(len > 0) || !Number.isFinite(len)) return vec.slice();
  return vec.map((x) => x / len);
}

/** Median of a numeric sample. Standard definition (mean of the two middles when even). */
function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const mid = n >> 1;
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

// ---------------------------------------------------------------------------
// The threshold
// ---------------------------------------------------------------------------

/**
 * Derive this corpus's similarity cut from its OWN pair distribution.
 *
 * See the header for why the statistics are done on `ln(1 − cos)` rather than
 * on the cosines themselves.
 *
 * @param {number[]} similarities Every pairwise cosine of the corpus.
 * @param {object} [opts]
 * @param {number} [opts.sensitivity=SENSITIVITY_K] `k`, in sigma-equivalents.
 * @returns {{ok: true, similarity: number, method: string, sensitivity: number,
 *            medianSimilarity: number, logDistanceMedian: number,
 *            logDistanceMadSigma: number, pairsSampled: number, formula: string}
 *          | {ok: false, reason: string, detail: string, pairsSampled: number}}
 */
export function deriveThreshold(similarities, opts = {}) {
  // THE GUARD LIVES HERE, at the exported boundary, not only in `findTwinPages`.
  // With it only upstream, this function — which is exported and callable on its
  // own — still honoured `sensitivity: -10` and returned a threshold of -3.42,
  // outside the cosine domain entirely. `findTwinPages` keeps its own copy
  // because it must refuse BEFORE spending the N², but the primitive has to be
  // safe for anyone who reaches it directly.
  const sensitivity = validateSensitivity(opts.sensitivity);
  const pairsSampled = similarities.length;

  if (pairsSampled < MIN_PAIRS_FOR_THRESHOLD) {
    return {
      ok: false,
      reason: UNAVAILABLE_REASONS.CORPUS_TOO_SMALL,
      detail:
        `Only ${pairsSampled} comparable pair(s); a median and a MAD need at least `
        + `${MIN_PAIRS_FOR_THRESHOLD} (≈ 9 pages) before they describe anything. `
        + 'No threshold was derived, so this is NOT a finding of "no twins" — the question was not answered.',
      pairsSampled,
    };
  }

  const logs = similarities.map((s) => Math.log(Math.max(MIN_DISTANCE, 1 - s)));
  const logsSorted = [...logs].sort((a, b) => a - b);
  const logMedian = median(logsSorted);
  const deviations = logs.map((l) => Math.abs(l - logMedian)).sort((a, b) => a - b);
  const madSigma = median(deviations) * MAD_TO_SIGMA;

  if (!(madSigma > 0)) {
    return {
      ok: false,
      reason: UNAVAILABLE_REASONS.NO_SPREAD,
      detail:
        'At least half of the pairs share one similarity, so the corpus has no measurable spread to '
        + 'derive an outlier cut from. No threshold was derived — this is NOT a finding of "no twins".',
      pairsSampled,
    };
  }

  const cut = logMedian - sensitivity * madSigma;
  const simSorted = [...similarities].sort((a, b) => a - b);
  return {
    ok: true,
    similarity: 1 - Math.exp(cut),
    method: 'log-distance-robust-z',
    sensitivity,
    medianSimilarity: median(simSorted),
    logDistanceMedian: logMedian,
    logDistanceMadSigma: madSigma,
    pairsSampled,
    formula: 'threshold = 1 - exp( median(ln(1-cos)) - k * 1.4826 * MAD(ln(1-cos)) )',
  };
}

// ---------------------------------------------------------------------------
// Page-level helpers
// ---------------------------------------------------------------------------

/** Vault-relative folder of a page path (`''` for a root-level page). */
function folderOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** Lowercased basename without the `.md` extension — the form a wikilink uses. */
function basenameOf(p) {
  const i = p.lastIndexOf('/');
  return (i === -1 ? p : p.slice(i + 1)).replace(/\.md$/i, '').toLowerCase();
}

function linkSetOf(page) {
  if (!Array.isArray(page.links)) return null;
  const out = new Set();
  for (const l of page.links) {
    if (typeof l !== 'string') continue;
    const t = l.split('#')[0].trim().replace(/\.md$/i, '').toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Find the quasi-twin pairs of a corpus.
 *
 * THE RETURN IS DISCRIMINATED, AND DELIBERATELY SO. When the check cannot run
 * there is NO `pairs` KEY AT ALL — not an empty one. "I could not look" and "I
 * looked and found none" are different answers, and a consumer that reads
 * `result.pairs.length` must not be able to read the first as the second. The
 * absence is structural, so no discipline is required of the reader.
 *
 * @param {object} input
 * @param {Array<{path: string, vector: number[], links?: string[]}>} input.pages
 *   Comparable pages only — the caller has already dropped what should not be
 *   compared and reports those counts itself.
 * @param {object} [opts]
 * @param {number} [opts.sensitivity=SENSITIVITY_K]
 * @param {number} [opts.limit=DEFAULT_LIMIT] Rows returned (ceiling MAX_LIMIT).
 * @param {string} [opts.restrictTo='none'] One of RESTRICT_MODES.
 * @param {number} [opts.maxPages=MAX_PAGES]
 * @returns {object} See the discriminated shapes above.
 */
export function findTwinPages(input, opts = {}) {
  const pages = input && Array.isArray(input.pages) ? input.pages : null;
  if (!pages) throw new TypeError('twin-pages: input.pages must be an array');

  const limitRaw = Number.isFinite(opts.limit) ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, limitRaw));
  // A MISUNDERSTOOD `restrictTo` IS REFUSED, NOT COERCED. Falling back to
  // 'none' on an unrecognised value looked forgiving and was not: a caller who
  // typed `restrictTo: 'folders'` got the UNBOUNDED answer and no indication
  // that the bound they asked for had been dropped — silence about a
  // misunderstood argument, which `boundary-score` refuses for `asOf` on
  // exactly this reasoning. `undefined`/`null` still mean "not asked for".
  let restrictTo = 'none';
  if (opts.restrictTo != null) {
    if (typeof opts.restrictTo !== 'string' || !RESTRICT_MODES.includes(opts.restrictTo)) {
      throw refusal(
        `twin-pages: restrictTo must be one of ${RESTRICT_MODES.map((m) => `"${m}"`).join(', ')} `
        + `(got ${typeof opts.restrictTo === 'string' ? JSON.stringify(opts.restrictTo) : typeof opts.restrictTo}).`,
      );
    }
    restrictTo = opts.restrictTo;
  }
  // THE SAME RULE AS `restrictTo`, applied where it was missing. `sensitivity`
  // used to be coerced: a non-number fell back to k=5 without a word, and a
  // negative one was honoured all the way to a threshold outside the cosine
  // domain. The module said "A MISUNDERSTOOD ARGUMENT IS REFUSED, NOT COERCED"
  // eight lines above and then did the opposite here.
  // Refused BEFORE the N², so a bad argument never costs the corpus a pass.
  // The same function guards `deriveThreshold` itself — one rule, two doors.
  const sensitivity = validateSensitivity(opts.sensitivity);

  let maxPages = MAX_PAGES;
  if (opts.maxPages != null) {
    if (typeof opts.maxPages !== 'number' || !Number.isFinite(opts.maxPages)
        || !Number.isInteger(opts.maxPages) || opts.maxPages < 2 || opts.maxPages > MAX_PAGES_CEILING) {
      throw refusal(
        `twin-pages: maxPages must be an integer between 2 and ${MAX_PAGES_CEILING} (got `
        + `${typeof opts.maxPages === 'number' ? opts.maxPages : typeof opts.maxPages}).`,
      );
    }
    maxPages = opts.maxPages;
  }

  // Sorted by path: the pair order, the tie-breaks and therefore the emitted
  // bytes must not depend on the order the caller happened to enumerate files.
  // A ZERO-NORM vector is dropped HERE too, not only by the store reader: this
  // module is callable on its own, and a page whose cosine with everything —
  // including its own byte-identical twin — is 0 must never be counted as
  // "compared". The store reader classifies its own (`incompatible`), so this
  // guard normally fires on nothing.
  let zeroNormDropped = 0;
  const usable = pages
    .filter((p) => p && typeof p.path === 'string' && p.path && Array.isArray(p.vector) && p.vector.length)
    .filter((p) => {
      let sq = 0;
      for (const x of p.vector) sq += x * x;
      if (Math.sqrt(sq) > 0) return true;
      zeroNormDropped += 1;
      return false;
    })
    .sort((a, b) => cmp(a.path, b.path));

  if (usable.length > maxPages) {
    throw refusal(
      `twin-pages: ${usable.length} comparable pages exceeds the ${maxPages}-page ceiling `
      + `(${Math.floor((usable.length * (usable.length - 1)) / 2)} pairs). Narrow the corpus with `
      + '`folders`, or raise `maxPages` knowingly — pages are never dropped silently, because then '
      + '"no pairs found" would be a statement about the ceiling rather than about the vault.',
      UNAVAILABLE_REASONS.TOO_MANY_PAGES,
    );
  }

  const corpus = {
    pages: usable.length,
    pairs: Math.floor((usable.length * (usable.length - 1)) / 2),
    // Always present, normally 0 — a page that cannot participate must be
    // visible as such rather than absorbed into the page count.
    zeroNormDropped,
  };

  if (usable.length < 2) {
    return {
      available: false,
      reason: UNAVAILABLE_REASONS.CORPUS_TOO_SMALL,
      detail:
        `Only ${usable.length} comparable page(s) carry a vector — there is nothing to compare. `
        + 'This is NOT a finding of "no twins": the question was not answered.',
      corpus,
      restrictTo,
      note: SIGNAL_NOT_ORDER,
    };
  }

  const dims = usable[0].vector.length;
  const mismatched = usable.filter((p) => p.vector.length !== dims);
  if (mismatched.length) {
    throw refusal(
      `twin-pages: vectors of mixed dimensionality (${dims} vs ${mismatched[0].vector.length}) cannot be `
      + 'compared — a cosine across two embedding spaces is a number without a meaning.',
    );
  }

  const unit = usable.map((p) => normalise(p.vector));
  const links = usable.map(linkSetOf);
  const folders = usable.map((p) => folderOf(p.path));
  const basenames = usable.map((p) => basenameOf(p.path));

  // ---- every pair, once ----------------------------------------------------
  const sims = new Float64Array(corpus.pairs);
  let at = 0;
  for (let i = 0; i < unit.length; i += 1) {
    for (let j = i + 1; j < unit.length; j += 1) {
      sims[at] = dot(unit[i], unit[j]);
      at += 1;
    }
  }

  // ---- the cut, from THIS corpus ------------------------------------------
  // The threshold is derived over EVERY pair of the corpus it was HANDED,
  // including the ones `restrictTo` will remove. And the asymmetry between the
  // two narrowing controls is deliberate, not an oversight:
  //
  //   `restrictTo` filters PAIRS, AFTER the cut is derived. The corpus is the
  //     same, so the cut is the same, so a given pair keeps the same verdict —
  //     it is only shown or hidden. Deriving over the restricted subset would
  //     have made the cut depend on the filter.
  //   `folders` (the tool's argument) filters PAGES, BEFORE this function is
  //     ever called. That is a DIFFERENT CORPUS with a different median, hence
  //     a different cut — SO THE SAME PAIR CAN CHANGE VERDICT between a scoped
  //     and an unscoped call. Measured on the router's own vault: whole wiki →
  //     median 0.7431, cut 0.932559, 4 pairs; `folders:['wiki/obsidian-mcp-
  //     router/Features']` → median 0.8757, cut 0.961266, 0 pairs — and the
  //     0.9338 pair reported by the first call is absent from the second.
  //
  // That is the intended reading of a scoped run: "is this pair unusual FOR
  // THIS SECTION?" is a different question from "is it unusual for this vault?",
  // and both are legitimate. The answer always carries the cut it used, so which
  // question was asked is never in doubt.
  // The VALIDATED sensitivity, not the raw option: passing `opts.sensitivity`
  // straight through meant the refusal above could be bypassed by the coercion
  // inside deriveThreshold, which is the very thing it exists to remove.
  const threshold = deriveThreshold(Array.from(sims), { sensitivity });
  if (!threshold.ok) {
    return {
      available: false,
      reason: threshold.reason,
      detail: threshold.detail,
      corpus,
      restrictTo,
      note: SIGNAL_NOT_ORDER,
    };
  }

  // ---- select, with the evidence -------------------------------------------
  const rows = [];
  let removedByRestriction = 0;
  at = 0;
  for (let i = 0; i < unit.length; i += 1) {
    for (let j = i + 1; j < unit.length; j += 1) {
      const similarity = sims[at];
      at += 1;
      if (!(similarity >= threshold.similarity)) continue;

      const sameFolder = folders[i] === folders[j];
      const la = links[i];
      const lb = links[j];
      // null, not 0 or false, when the caller supplied no links for a page:
      // absence must read as UNKNOWN, never as "no shared links" — the same
      // rule `boundary-score` applies to an absent `status`.
      let sharedLinks = null;
      let linked = null;
      if (la && lb) {
        let shared = 0;
        for (const t of la) if (lb.has(t)) shared += 1;
        sharedLinks = shared;
        linked = la.has(basenames[j]) || lb.has(basenames[i]);
      }

      if (restrictTo !== 'none') {
        const keep = restrictTo === 'folder'
          ? sameFolder
          : sameFolder || (sharedLinks !== null && sharedLinks > 0);
        if (!keep) { removedByRestriction += 1; continue; }
      }

      rows.push({
        a: usable[i].path,
        b: usable[j].path,
        similarity,
        sameFolder,
        sameBasename: basenames[i] === basenames[j],
        sharedLinks,
        linked,
      });
    }
  }

  // Similarity desc, then both paths asc — a TOTAL order by UTF-16 code unit
  // (`cmp`), so two machines cannot disagree.
  //
  // HONEST NOTE ON THE TIEBREAK: it is UNFALSIFIABLE as the code stands, and
  // deleting it breaks no test — verified by mutation. `usable` is path-sorted
  // above, the double loop emits pairs in (i<j) order, and `Array#sort` is
  // stable per ES2019 — so tied rows already come out in exactly the order the
  // tiebreak would impose. What actually carries the determinism is the PRE-SORT
  // (removing THAT does fail the enumeration-order test). The tiebreak is kept
  // as insurance against a future change to how pairs are enumerated, and is
  // labelled here so nobody reads it as a tested guarantee.
  rows.sort((x, y) => y.similarity - x.similarity || cmp(x.a, y.a) || cmp(x.b, y.b));

  return {
    available: true,
    threshold: {
      method: threshold.method,
      sensitivity: threshold.sensitivity,
      similarity: threshold.similarity,
      medianSimilarity: threshold.medianSimilarity,
      logDistanceMedian: threshold.logDistanceMedian,
      logDistanceMadSigma: threshold.logDistanceMadSigma,
      pairsSampled: threshold.pairsSampled,
      formula: threshold.formula,
      derivedFrom: 'this vault only — a threshold from another vault does not transfer',
    },
    corpus,
    restrictTo,
    // Always reported, including the 0 of the default `none`: a filter nobody
    // can see is a filter nobody can question.
    removedByRestriction,
    found: rows.length,
    truncated: rows.length > limit,
    pairs: rows.slice(0, limit),
    note: SIGNAL_NOT_ORDER,
  };
}

/**
 * An ACTIONABLE refusal — `kind: 'validation'` is the router's convention for a
 * router-side refusal that never reached the network, so `error-classify.mjs`
 * does not file it under `unknown`. Same twin as `boundary-score.mjs`.
 */
/**
 * `sensitivity`, validated once for both entry points. `undefined`/`null` mean
 * "not asked for" and yield the default; anything else must be a finite number
 * ≥ MIN_SENSITIVITY, or it is REFUSED rather than coerced.
 */
function validateSensitivity(value) {
  if (value == null) return SENSITIVITY_K;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_SENSITIVITY) {
    throw refusal(
      `twin-pages: sensitivity must be a finite number ≥ ${MIN_SENSITIVITY} (got `
      + `${typeof value === 'number' ? value : typeof value}). `
      + 'Higher is stricter. A negative value walks the cut outside the cosine domain — measured, '
      + 'k = -10 gives a threshold of -3.42 (every pair matches) and k = -1e308 gives -Infinity, '
      + 'which serialises to null and leaves the answer with no threshold at all.',
    );
  }
  return value;
}

function refusal(message, reason) {
  const err = new Error(message);
  err.kind = 'validation';
  // A MACHINE-READABLE name on the throw, so "the ways this check declines to
  // answer" is one enumerable set (UNAVAILABLE_REASONS) whether the decline
  // arrives as a response body or as an exception.
  if (reason) err.reason = reason;
  return err;
}

export const _internals = { median, folderOf, basenameOf, linkSetOf, refusal };
