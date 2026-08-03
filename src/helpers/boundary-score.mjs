/**
 * boundary-score — DETERMINISTIC ranking of "frontier" pages: the crossroads
 * everybody links to that stay thin inside.
 *
 * Borrowing C10 of [[roadmap-emprunts]] §2.17. Pure module — no I/O, no clock,
 * no randomness: the same graph object always yields byte-identical output,
 * regardless of the order its nodes/edges were enumerated. The MCP tool
 * (`find_boundary_pages`) is only the I/O shell around this, the same
 * deterministic-core / thin-tool split as `graph-neighbors.mjs`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCORE CLAIMS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * The score PROPOSES ATTENTION. It does not establish importance, quality, or
 * priority. A high score says one thing only: "many pages point here, and there
 * is not much here when you arrive." That is a reason to LOOK, never a verdict.
 *
 * ---------------------------------------------------------------------------
 * THE FORMULA, AND ITS THREE STATED CONSTANTS
 * ---------------------------------------------------------------------------
 *   linkPressure = inbound / (1 + substanceWords / 100)
 *   staleness    = clamp(daysSince(updated), 0, 365) / 365      // unknown → 0
 *   score        = linkPressure × (1 + staleness)
 *
 * `linkPressure` is inbound links DAMPED BY LENGTH — not, despite the tempting
 * shorthand, "inbound links per 100 words": the `1 +` in the denominator means
 * an empty page keeps its full inbound count instead of dividing by zero, and a
 * 100-word page is halved rather than left unchanged. 7 inbound links on an
 * 89-word page = 3.70; the same 7 links on a 900-word page = 0.70. Recency then
 * multiplies by ×1 (edited on the build date, or date unknown) up to ×2 (a year
 * or more untouched).
 *
 * The three numbers — 100 words, 365 days, ×2 ceiling — are CONVENTIONS, not
 * calibrations. Nothing was fitted to any corpus. They are exported, reported
 * in every result, and chosen so that the recency term can never do more than
 * DOUBLE a score: a page cannot climb past another on staleness alone unless
 * their link pressures are already within a factor of two. That bound is what
 * keeps "plus la récence" a nudge rather than a second, hidden ranking.
 *
 * ---------------------------------------------------------------------------
 * WHAT "THIN" MEANS HERE — THE ASSUMED LIMITATION
 * ---------------------------------------------------------------------------
 * Substance is a PROSE WORD COUNT (`measureSubstanceWords`), and that is a
 * genuinely weak proxy. It rewards verbosity and punishes density; it cannot
 * tell 89 words of real definition from 89 words of redirect boilerplate; and
 * on a bilingual vault (FR + EN by convention) it counts pages written twice as
 * twice as substantial as pages written once.
 *
 * We ship it anyway, deliberately, rather than a five-coefficient formula that
 * would look scientific and that nobody could tune. Two things make the weak
 * measure workable:
 *
 *   1. The BIAS IS CHOSEN. Over-counting substance (code blocks, link lists and
 *      tables all count as words) produces false NEGATIVES — a thin page we
 *      fail to mention. Under-counting would produce false POSITIVES — a fine
 *      page we tell you to go research. For a list of suggestions, silence is
 *      the cheaper error, so the measure errs toward "not thin".
 *   2. The EXEMPTION POLICY carries more weight than the formula. Measured on
 *      the router's own vault: without exemptions, 12 of the top 20 were
 *      `type: redirect` migration stubs — all exactly 89 words of identical
 *      boilerplate, thin BY DESIGN. No word-count refinement can separate those
 *      from real content; only the page's declared type can. See
 *      DEFAULT_EXEMPT_TYPES.
 *
 * ---------------------------------------------------------------------------
 * WHERE "INBOUND" COMES FROM — AND WHY IT IS NOT LINT'S NOTION
 * ---------------------------------------------------------------------------
 * Inbound = the graph's `related` article→article edges. The builder's resolver
 * already handles path-qualified links, basename collisions, embeds, and
 * refuses ambiguous targets — none of which a `[[wikilink]]` regex can do.
 *
 * `wiki-lint` Check A (orphans) independently re-parses every page instead, and
 * the two do NOT agree edge-for-edge. Measured on the router's vault (140
 * articles): they agree on 117 pages; on the 23 that differ the graph always
 * counts FEWER, and the cause is exactly one thing — wikilinks that live in
 * FRONTMATTER (`related:`, `superseded_by:`), which the builder never sees
 * because it parses the body only.
 *
 * That divergence is documented rather than unified, for two reasons. The graph
 * is the substrate §2.17 names; and teaching the builder to index frontmatter
 * links would have moved 53 edges on that vault, perturbing `get_page_neighbors`,
 * `wiki_path`, `build_wiki_tour` and the Louvain layers for every consumer — a
 * change that needs its own justification, not a side-effect of C10.
 *
 * Crucially, the divergence is SAFE IN THE DIRECTION THAT MATTERS: the graph's
 * inbound set is a strict SUBSET of lint's (verified, 0 violations), so a page
 * this module credits with inbound links can never be reported as an orphan by
 * Check A. The two can appear in one lint report without contradicting.
 */

import { parseFrontmatter } from './llms-txt-exporter.mjs';
import { validateGraph } from './wiki-graph-schema.mjs';
import { sanitizeLabel } from './sanitize.mjs';

/** The damping unit: a page of N words halves its inbound count. */
export const SUBSTANCE_UNIT_WORDS = 100;
/** Age at which the staleness multiplier saturates. */
export const STALENESS_HORIZON_DAYS = 365;
/** Hard ceiling of the recency multiplier — staleness can at most double a score. */
export const MAX_RECENCY_MULTIPLIER = 2;
/** Identifier of the substance measure, recorded in the graph and every result. */
export const SUBSTANCE_MEASURE = 'prose-words-v1';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;
export const DEFAULT_MIN_INBOUND = 1;
export const DEFAULT_EDGE_TYPES = Object.freeze(['related']);

/**
 * Page types held out of the ranking by default, because being thin is their
 * job, not a defect:
 *   - `redirect` — a migration stub; its whole content is "this moved there".
 *   - `source`   — a capture record. Cited by many pages by construction.
 *   - `answer`   — a Q&A record, reachable through the index.
 * `source` and `answer` mirror `wiki-lint` Check A's own exemptions verbatim,
 * so the two checks hold the same pages harmless.
 */
export const DEFAULT_EXEMPT_TYPES = Object.freeze(['redirect', 'source', 'answer']);

// ---------------------------------------------------------------------------
// The substance measure
// ---------------------------------------------------------------------------

/**
 * Count the prose words of a page. Deliberately, almost naively simple — see
 * the "assumed limitation" note above.
 *
 * Two normalisations, and no more. Both remove MARKUP, never content:
 *   - frontmatter is dropped (it is metadata, not prose);
 *   - `[[target|alias]]` becomes `alias` and `[[target]]` becomes `target`, so a
 *     link contributes the words a reader actually sees rather than its bracket
 *     syntax.
 * Everything else — headings, code fences, tables, callouts — counts as written.
 * These are normalisations, not tunable weights: there is no coefficient here to
 * get wrong.
 *
 * @param {string} content Raw page content, frontmatter included.
 * @returns {number} Whitespace-separated token count of the body.
 */
export function measureSubstanceWords(content) {
  if (typeof content !== 'string' || !content) return 0;
  let body;
  try {
    ({ body } = parseFrontmatter(content));
  } catch {
    body = content;
  }
  return countProseWords(body);
}

/**
 * The same measure, for a caller that has ALREADY split off the frontmatter —
 * the graph builder, which parses each page exactly once. Keeping both entry
 * points on one implementation is what guarantees the number the builder
 * records is the number this module would have computed.
 *
 * @param {string} body Page body, frontmatter already removed.
 * @returns {number}
 */
export function countProseWords(body) {
  if (typeof body !== 'string' || !body) return 0;
  // The `[` excluded from both character classes is load-bearing, not cosmetic:
  // without it, a page containing a long run of `[[` makes each run position
  // rescan the whole tail, and the pass goes quadratic — `'[['.repeat(40000)`
  // measured at 3.8 SECONDS, and this runs inside the graph builder on every
  // page. Forbidding `[` inside a link target/alias makes a malformed run fail
  // at its second character (same input: 0.1 ms). The only inputs that parse
  // differently are already-malformed nested forms like `[[a[b]]`, which yield
  // the same whitespace-token count either way.
  const text = body
    .replace(/!?\[\[([^\]|\n[]+)\|([^\]\n[]+)\]\]/g, '$2')
    .replace(/!?\[\[([^\]\n[]+)\]\]/g, '$1');
  const tokens = text.match(/\S+/g);
  return tokens ? tokens.length : 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Parse a frontmatter `updated:` value to a UTC day number. Accepts an ISO
 * date string (`2026-08-03`, or a full timestamp — the day part is used) and a
 * Date instance (some YAML parsers hydrate dates). Anything else → null, which
 * the caller treats as "recency unknown", NOT as "fresh" and NOT as "ancient".
 *
 * @param {unknown} value
 * @returns {number|null} Whole days since the epoch, or null.
 */
function toEpochDay(value, { allowAnnotated = true } = {}) {
  // A Date instance is already an instant — take its UTC day.
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : Math.floor(t / 86400000);
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();

  // A date must be TERMINATED — by end-of-string, by `T`, or by whitespace.
  // The old rule was a bare prefix match with no terminator at all, so
  // `2026-08-0399` (a typo: four digits in the day) parsed as 2026-08-03 and
  // `2026-08-03banana` was accepted as a valid `asOf`.
  //
  // The terminator is a space rather than end-of-string because the real vault
  // decides it: three pages carry values like
  // `updated: 2026-05-25 (v0.14.7 — Phase E.2 hardening)`. That IS a date, with
  // a human annotation after it, and rejecting it would silently strip those
  // pages of their recency signal — trading a false "ancient" for a false
  // "unknown". So the line drawn is: a date followed by a SEPARATOR is an
  // annotated date and is honoured; a date followed immediately by another
  // character is a typo and is refused.
  // `allowAnnotated` is false for a CALLER-supplied `asOf`, whose documented
  // contract is `YYYY-MM-DD`. Tolerating a trailing note is a concession to
  // pages a human wrote; an API argument gets no such latitude.
  const dateOnly = s.match(allowAnnotated ? /^(\d{4}-\d{2}-\d{2})(?:\s|$)/ : /^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return calendarDay(dateOnly[1]);

  // Full ISO timestamp (the shape of `project.analyzedAt`). Reduced to its UTC
  // day — the SAME rule as the Date branch, so a timestamp string and the Date
  // built from it cannot disagree when an offset crosses midnight.
  //
  // Gated on `allowAnnotated` so a CALLER's `asOf` really is the `YYYY-MM-DD`
  // its contract promises: the strict date-only regex above rejected the
  // timestamp *shape*, but execution then fell through to here and accepted it
  // anyway, which left the documented contract unenforced.
  if (allowAnnotated && /^\d{4}-\d{2}-\d{2}T/.test(s)) {
    // An OFFSET IS MANDATORY. Per ECMA-262, a date-time with no designator is
    // interpreted as LOCAL time — so `2026-08-03T00:30:00` resolves to instants
    // 19 hours apart on a Honolulu machine and a Tokyo one (measured). Feeding
    // that into the score would make the ranking depend on the ambient
    // timezone, falsifying this module's headline promise that the same graph
    // yields the same bytes anywhere. A value we cannot place on the timeline
    // reads as UNKNOWN (×1), which is the conservative direction everywhere
    // else here. The builder always writes `toISOString()`, so real graphs are
    // unaffected.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
    // The calendar date is validated SEPARATELY and FIRST. Without this, the
    // timestamp branch re-admitted exactly the rollover the date-only branch
    // exists to stop: `2026-02-29` was refused, while `2026-02-29T00:00:00Z`
    // sailed through as 1 March and earned a real staleness score. A typo must
    // read as unknown whether or not somebody appended a time to it.
    if (calendarDay(s.slice(0, 10)) === null) return null;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : Math.floor(ms / 86400000);
  }
  return null;
}

/**
 * `YYYY-MM-DD` → whole days since the epoch, or null when that calendar date
 * does not exist. The round-trip is the check: `Date.parse` happily rolls
 * `2026-02-31` into March, so a value that does not come back identical is a
 * typo, not a date.
 */
function calendarDay(iso) {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== iso) return null;
  return Math.floor(ms / 86400000);
}

/** Whole days since the epoch → `YYYY-MM-DD`. */
function dayToIso(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

/** Coerce an arg into a non-empty string[], else the fallback. */
function coerceList(value, fallback) {
  if (Array.isArray(value)) {
    const clean = value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
    if (clean.length > 0) return clean;
  }
  return [...fallback];
}

function frontmatterOf(node) {
  const fm = node && node.knowledgeMeta && node.knowledgeMeta.frontmatter;
  return fm && typeof fm === 'object' && !Array.isArray(fm) ? fm : {};
}

/**
 * Read the substance a build recorded on an article node.
 *
 * The `measure` tag is checked, not just the number. Without that check a node
 * carrying `{ words: 0, measure: 'bytes-v1' }` — a hypothetical future or
 * third-party measurement in a different unit — was accepted and scored as an
 * EMPTY page, and a whole graph of them sailed past the "no measurements at
 * all" refusal below. A count in an unknown unit is not a count we can use; it
 * reads as absent, which is what makes the refusal mean something.
 *
 * @returns {number|null} word count, or null when this node carries no usable one.
 */
function substanceOf(node) {
  const s = node && node.knowledgeMeta && node.knowledgeMeta.substance;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (s.measure !== SUBSTANCE_MEASURE) return null;
  const w = s.words;
  // A word count is a non-negative INTEGER. `0.5` words is not a small page,
  // it is a corrupt record.
  if (!Number.isSafeInteger(w) || w < 0) return null;
  return w;
}

// ---------------------------------------------------------------------------
// The scorer
// ---------------------------------------------------------------------------

/**
 * Rank the "frontier" pages of a knowledge graph.
 *
 * @param {object} graph A UA-schema KnowledgeGraph (nodes[]/edges[]).
 * @param {object} [opts]
 * @param {number} [opts.limit=10] How many pages to return (ceiling MAX_LIMIT).
 * @param {number} [opts.minInbound=1] Ignore pages with fewer inbound links.
 * @param {string[]} [opts.exemptTypes] Frontmatter `type:` values to hold out.
 *   Defaults to DEFAULT_EXEMPT_TYPES; pass `[]` to score everything.
 * @param {string[]} [opts.edgeTypes] Edge types that count as a link.
 * @param {string} [opts.asOf] The date recency is measured against (`YYYY-MM-DD`).
 *   Defaults to the graph's own `project.analyzedAt`, which makes the result a
 *   PURE FUNCTION OF THE GRAPH FILE — the same graph scores the same forever,
 *   with no clock involved.
 * @returns {object} The ranking plus everything needed to audit it.
 */
export function scoreBoundaryPages(graph, opts = {}) {
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError('boundary-score: graph must be a KnowledgeGraph object with nodes[]/edges[]');
  }

  // Shape-checking `nodes`/`edges` is not enough, and the gap was not academic.
  // DUPLICATE article ids resolved last-wins in the node map, so reversing the
  // node array changed which page was scored (999 words vs 1) — an
  // order-dependence no amount of careful sorting downstream can undo. An edge
  // whose endpoint does not exist was silently dropped, quietly costing its
  // target an inbound link. `validateGraph` already rejects both; reusing it
  // beats re-deriving a weaker check that would drift from the writer's rules.
  const report = validateGraph(graph);
  if (!report.valid) {
    // The validator quotes offending node ids, and those come from vault paths
    // — untrusted content. The SUCCESS path is sanitised by the tool; this
    // error path is not, so a node id carrying an ANSI escape or an
    // injection-shaped tag would reach the reader raw. Neutralise here, at the
    // point the string is built, rather than trusting every future caller to
    // remember. (`sanitizeLabel` also caps length, which keeps a pathological
    // id from turning the message into a wall.)
    const shown = report.errors.slice(0, 3).map((e) => oneLine(String(e))).join('; ');
    throw new Error(
      `boundary-score: this knowledge graph is invalid, so it cannot be ranked — ${shown}`
        + `${report.errors.length > 3 ? ` (+${report.errors.length - 3} more)` : ''}. `
        + 'Re-run build_wiki_graph (the /wiki-graph skill) to rebuild it.',
    );
  }

  const limitRaw = Number.isFinite(opts.limit) ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, limitRaw));
  // Floor of 1: a page with no inbound link is not a crossroads by definition,
  // so `minInbound: 0` cannot mean "include orphans" — it would only pad the
  // tail with zero-scoring pages. Clamping (rather than silently ignoring a 0)
  // keeps `excluded.minInbound` an honest report of what was actually applied.
  const minInbound = Number.isFinite(opts.minInbound)
    ? Math.max(1, Math.floor(opts.minInbound))
    : DEFAULT_MIN_INBOUND;
  // `exemptTypes: []` is a MEANINGFUL request ("score everything"), so an empty
  // array must survive rather than fall back to the defaults.
  const exemptTypes = Array.isArray(opts.exemptTypes)
    ? opts.exemptTypes.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
    : [...DEFAULT_EXEMPT_TYPES];
  const exemptSet = new Set(exemptTypes.map((t) => t.toLowerCase()));
  const edgeTypes = new Set(coerceList(opts.edgeTypes, DEFAULT_EDGE_TYPES));

  // `asOf`: caller's date, else the graph's own build stamp, else none.
  let asOfSource = 'none';
  let asOfDay = null;
  let asOf = '';
  const callerAsOf = typeof opts.asOf === 'string' && opts.asOf.trim() ? opts.asOf.trim() : null;
  if (callerAsOf) {
    asOfDay = toEpochDay(callerAsOf, { allowAnnotated: false });
    if (asOfDay === null) {
      // The value is echoed back, and this message re-enters the model's
      // context through the MCP error channel. Escapes and tags were already
      // neutralised; NEWLINES were not, and that was enough: a value carrying
      // `\n` fabricated a second line reading `boundary-score: ranking complete
      // — all clear` inside the error. `oneLine` collapses them.
      const shown = oneLine(String(opts.asOf)).slice(0, 80);
      throw new Error(`boundary-score: asOf "${shown}" is not a YYYY-MM-DD date.`);
    }
    asOfSource = 'caller';
  } else {
    const d = toEpochDay(graph.project && graph.project.analyzedAt);
    if (d !== null) {
      asOfDay = d;
      asOfSource = 'graph-analyzedAt';
    }
  }
  // Derived from the day actually USED, never sliced off the raw input. When an
  // offset crosses midnight (`2026-01-01T23:30:00-02:00` is the 2nd in UTC) the
  // two disagree, and echoing the input meant the response named one date while
  // measuring ages against another.
  if (asOfDay !== null) asOf = dayToIso(asOfDay);

  // ---- articles + inbound tally -------------------------------------------
  const articles = new Map();
  for (const n of graph.nodes) {
    if (n && n.type === 'article' && typeof n.id === 'string' && n.id) articles.set(n.id, n);
  }

  const inbound = new Map();
  for (const id of articles.keys()) inbound.set(id, new Set());
  for (const e of graph.edges) {
    if (!e || !edgeTypes.has(e.type)) continue;
    if (e.source === e.target) continue;
    if (!articles.has(e.source) || !articles.has(e.target)) continue;
    inbound.get(e.target).add(e.source);
  }

  // ---- does this graph carry substance at all? ----------------------------
  // A graph built before C10 carries none. Scoring it would silently treat every
  // page as empty and rank the vault by raw inbound links — a confident, wrong
  // answer. Refuse instead. (A graph where only SOME nodes lack the measure is a
  // different case: those pages are excluded and counted, never assumed empty.)
  let measured = 0;
  for (const node of articles.values()) if (substanceOf(node) !== null) measured += 1;
  if (articles.size > 0 && measured === 0) {
    throw new Error(
      'This knowledge graph carries no substance measurements, so "thin" cannot be evaluated '
        + '— it was built before boundary scoring existed. Re-run build_wiki_graph (the /wiki-graph '
        + 'skill) to rebuild it, then ask again.',
    );
  }

  // ---- score ---------------------------------------------------------------
  // A Map, not a plain object: a page declaring `type: toString` turned the
  // tally into the string "function toString() { [native code] }1", and
  // `type: __proto__` incremented nothing at all while still counting toward
  // the total. An audit line that silently corrupts itself is worse than none.
  const exemptedByType = new Map();
  let exemptedTotal = 0;
  let withoutSubstance = 0;
  let withoutRecency = 0;
  let belowMinInbound = 0;
  const rows = [];

  for (const [id, node] of articles) {
    const fm = frontmatterOf(node);
    const type = typeof fm.type === 'string' ? fm.type.trim() : '';
    if (type && exemptSet.has(type.toLowerCase())) {
      exemptedTotal += 1;
      exemptedByType.set(type, (exemptedByType.get(type) || 0) + 1);
      continue;
    }
    const words = substanceOf(node);
    if (words === null) { withoutSubstance += 1; continue; }

    const inboundCount = inbound.get(id).size;
    if (inboundCount < minInbound) { belowMinInbound += 1; continue; }

    const updatedDay = toEpochDay(fm.updated);
    let ageDays = null;
    if (updatedDay !== null && asOfDay !== null) ageDays = Math.max(0, asOfDay - updatedDay);
    if (ageDays === null) withoutRecency += 1;

    const staleness = ageDays === null
      ? 0
      : Math.min(ageDays, STALENESS_HORIZON_DAYS) / STALENESS_HORIZON_DAYS;
    const recencyMultiplier = 1 + staleness * (MAX_RECENCY_MULTIPLIER - 1);
    const linkPressure = inboundCount / (1 + words / SUBSTANCE_UNIT_WORDS);
    const score = linkPressure * recencyMultiplier;

    rows.push({
      id,
      path: typeof node.filePath === 'string' ? node.filePath : '',
      name: typeof node.name === 'string' ? node.name : '',
      type: type || null,
      inbound: inboundCount,
      substanceWords: words,
      ageDays,
      // Reported at FULL precision, deliberately. Rounding to 4 decimals read
      // as harmless tidiness and was not: two pages 1 word apart (2000 vs 2001)
      // collapsed to the same 0.0476 and the path tiebreak then put the THICKER
      // one first — an inversion of the one thing this module exists to do. It
      // also made the stated ×2 ceiling false in the reported numbers, where a
      // linkPressure rounding to 0 sat beside a score of 0.0001. IEEE-754
      // arithmetic and JS number serialisation are both fully specified, so raw
      // values are exactly as byte-stable as rounded ones — rounding bought
      // nothing and cost correctness. Formatting is the caller's business.
      recencyMultiplier,
      linkPressure,
      score,
    });
  }

  // Deterministic order: score desc, then path asc, then id asc — compared by
  // UTF-16 CODE UNIT (JS `<`/`>`), not `localeCompare`. Note the precision: this
  // is code-UNIT order, so an astral character sorts before U+E000 where Unicode
  // scalar order would put it after. That is fine — what is required here is a
  // TOTAL, machine-independent order, not a linguistically meaningful one.
  // Locale collation is neither: it is not a total order, since it
  // returns 0 for distinct strings (`"é"` vs `"é"`, a soft hyphen, a
  // zero-width space), and when every key ties the sort falls back to insertion
  // order — reintroducing exactly the node-order dependence this tiebreak
  // exists to remove. It is also ICU-version dependent, so two machines could
  // disagree. `<`/`>` is exact, total, and identical everywhere.
  rows.sort((a, b) => b.score - a.score || cmp(a.path, b.path) || cmp(a.id, b.id));

  return {
    measure: {
      substance: SUBSTANCE_MEASURE,
      unitWords: SUBSTANCE_UNIT_WORDS,
      stalenessHorizonDays: STALENESS_HORIZON_DAYS,
      maxRecencyMultiplier: MAX_RECENCY_MULTIPLIER,
      formula: 'score = inbound / (1 + words/100) * (1 + min(ageDays,365)/365)',
    },
    asOf,
    asOfSource,
    articles: articles.size,
    ranked: rows.length,
    // `byType` keys are emitted in sorted order, NOT in the order the types
    // happened to be encountered while walking the nodes. Object key order is
    // part of the JSON bytes: without this, reversing the node array produced
    // {"redirect":29,"source":2} instead of {"source":2,"redirect":29} — the
    // same data, a different response. Caught by the real vault, not by the
    // fixture (which only ever had one exempt type present).
    exempted: {
      total: exemptedTotal,
      byType: Object.fromEntries([...exemptedByType.entries()].sort((a, b) => cmp(a[0], b[0]))),
      types: [...exemptTypes].sort(cmp),
    },
    excluded: {
      withoutSubstance,
      withoutInboundLinks: belowMinInbound,
      minInbound,
    },
    withoutRecency,
    truncated: rows.length > limit,
    pages: rows.slice(0, limit),
  };
}

/**
 * Make a vault-derived string safe to interpolate into a ONE-LINE error.
 *
 * Three jobs, and each closes a hole a previous round left open:
 *  - neutralise ANSI escapes and injection-shaped tags (`sanitizeLabel`);
 *  - collapse newlines and tabs. `sanitizeLabel` keeps them by design — it is
 *    written for markdown — but these messages are single-line, and a value
 *    containing `\n` could FABRICATE a second line that reads exactly like a
 *    legitimate status line inside the MCP error channel;
 *  - cap the QUOTED IDENTIFIER rather than the whole message. Capping the
 *    message truncated from the right, and the validator writes the id BEFORE
 *    the reason (`nodes[1].id "…" is duplicated`), so a long enough id ate the
 *    reason — leaving an error that no longer said what was wrong. Shortening
 *    the quoted part instead makes the reason structurally untruncatable.
 */
function oneLine(text) {
  const capped = String(text).replace(/"([^"]{80,})"/g, (_m, id) => `"${id.slice(0, 77)}…"`);
  return sanitizeLabel(capped, { neutralizeInjection: true, maxLen: 500 })
    .replace(/[\r\n\t]+/g, ' ');
}

/**
 * Total, locale-independent string order by UTF-16 code unit. See the sort
 * comment above for why `localeCompare` cannot be used where exactness is the
 * point, and why code-unit (rather than code-point) order is sufficient.
 */
function cmp(a, b) {
  const x = String(a);
  const y = String(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

export const _internals = { toEpochDay, cmp, substanceOf, frontmatterOf };
