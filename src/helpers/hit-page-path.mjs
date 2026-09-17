/**
 * The page a search hit belongs to (roadmap phase 4c.3).
 *
 * THE SEMANTIC TIER DOES NOT RETURN PAGES, IT RETURNS BLOCKS. Smart Connections
 * addresses a chunk, and its `path` is the file path with the chunk's position
 * appended after a `#`:
 *
 *   Indicators/analyse-technique-pro/Modules.md#Modules — comment …#L'idée…#{1}
 *
 * Handed to `getNote` that string is a 404, because it is not a file. Measured
 * on the TradingView vault on 2026-09-15 — the one vault of the fleet whose
 * `/search/smart` actually answers — where ten of twenty annotated hits came
 * back unreadable for this reason alone and every one of them was reported
 * `validityUnverified`. Nothing was hidden (invariant 2 held), but the window
 * was never established for a page that declares one perfectly well, so the
 * filter was inert on half the semantic tier.
 *
 * THE SPLIT IS SOMETIMES UNDECIDABLE, AND THEN IT IS REFUSED. `#` is legal in a
 * filename and `.md` is legal in a heading, so one string can be read two ways:
 *
 *   a.md#b.md   →  the file `a.md#b.md`, or the heading `b.md` inside `a.md`
 *
 * No cut rule settles that. Cutting at the FIRST `.md#` picks `a.md`; cutting at
 * the LAST picks `a.md#b.md`; probing the literal spelling first picks whichever
 * happens to exist, and when BOTH exist it picks the wrong one half the time.
 * The adversarial review of 2026-09-16 built both counter-examples and showed
 * the consequence is not a miscount but a WRONG WINDOW — and therefore, under a
 * filter, a page excluded for a date that belongs to a different file.
 *
 * So an ambiguous path names no page. The entry is marked `validityUnverified`,
 * which is exactly true — we could not establish which page it speaks of — and
 * it is never excluded, because an unverified entry never is. That costs the
 * annotation on a hit whose heading contains `.md`, and it is the only reading
 * consistent with the batch: "I could not tell" is an answer this code is
 * allowed to give, "probably this one" is not.
 *
 * The real repair is upstream — the bridge knows the file it chunked and could
 * say so — and it is not in this phase's scope.
 */

/** What every Obsidian note's path ends in, and nothing else does. */
const NOTE_EXTENSION = '.md';

/**
 * Every prefix of `path` that is a plausible note path, shortest first.
 *
 * A prefix qualifies when it ends in `.md` AND the path either stops there or
 * continues with `#`. The second condition is what keeps `a.mdx#H` from being
 * read as the note `a.md`: `.md` followed by `x` is part of a longer extension,
 * not the end of a filename. The first index is excluded, because a path that
 * opens on `.md` has no filename before the extension.
 */
function notePrefixes(path) {
  const found = [];
  for (let i = 1; i + NOTE_EXTENSION.length <= path.length; i += 1) {
    if (!path.startsWith(NOTE_EXTENSION, i)) continue;
    const after = i + NOTE_EXTENSION.length;
    if (after === path.length || path[after] === '#') found.push(path.slice(0, after));
  }
  return found;
}

/**
 * The page path a hit path points into.
 *
 * @param {unknown} rawPath
 * @returns {string} the page path, or `''` when the hit names no page — either
 *   because it names nothing at all, or because which page it names cannot be
 *   decided. Both leave the entry unverified, and neither is ever a guess.
 */
export function hitPagePath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (trimmed === '') return '';
  const prefixes = notePrefixes(trimmed);
  // NO `.md` AT ALL: the hit does not name a note, and there is nothing to cut.
  // The path is handed back as it came — an image or an attachment addresses
  // itself, and the reader will say what it thinks of it.
  if (prefixes.length === 0) return trimmed;
  // EXACTLY ONE READING: that is the page, whether the path stopped at the file
  // or carried a block anchor after it.
  if (prefixes.length === 1) return prefixes[0];
  // TWO OR MORE: undecidable. See the header.
  return '';
}

/**
 * The `pathsOf` a `pageOf` implies — the ONE place that derivation is written.
 *
 * Every consumer of the annotator needs both: the page identity, and the list
 * of spellings to read it through. Writing the two independently is how a wrong
 * `pageOf` became invisible in `search_smart` — the reads went through
 * `pathsOf`, which was still right, so the identity (and the counting) could be
 * wrong with every witness green. A caller that computes its own `pageOf` —
 * `search_smart` uses a different one per tier — passes the result here rather
 * than restating the rule.
 *
 * At most ONE spelling, which is the point: a candidate list was how the first
 * version of this module hedged between readings, and hedging is what let a
 * wrong window through.
 *
 * @param {string} page  a page path, or `''` when none could be named
 * @returns {string[]} one spelling, or none
 */
export function candidatesFor(page) {
  return typeof page === 'string' && page !== '' ? [page] : [];
}

/**
 * The spellings to try for a hit, straight from its raw path.
 *
 * @param {unknown} rawPath
 * @returns {string[]} one spelling, or none
 */
export function hitPathCandidates(rawPath) {
  return candidatesFor(hitPagePath(rawPath));
}

/**
 * Whether a hit path can be read two ways — told apart from "names nothing" so
 * a caller can say WHICH kind of silence it is. Nothing in the router branches
 * on it today; the tests do, because a property that holds for two different
 * reasons is a property that proves neither.
 */
export function isAmbiguousHitPath(rawPath) {
  if (typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (trimmed === '') return false;
  return notePrefixes(trimmed).length > 1;
}
