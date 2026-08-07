/**
 * The comparator every canonical ordering in this repo must use.
 *
 * `String.prototype.localeCompare` is NOT A TOTAL ORDER, and that is not a
 * pedantic objection — it breaks determinism in a way that is invisible until
 * someone diffs two runs:
 *
 *   - It returns 0 for DISTINCT strings. `café.md` written NFC and the same
 *     name written NFD compare equal, as do two strings differing only by a
 *     soft hyphen (U+00AD). `Array.prototype.sort` then leaves them in
 *     insertion order — so the caller's enumeration order leaks straight into
 *     the output bytes, which is precisely what a canonical sort exists to
 *     prevent. A vault synced between macOS and Linux routinely contains both
 *     normalisations of the same name.
 *   - It is ICU-version and locale dependent, so the same input sorts
 *     differently on two machines (`sv` orders `ä` after `z`; `fr` does not).
 *
 * `boundary-score.mjs` and `louvain.mjs` each carried a long comment saying
 * exactly this — and `wiki-graph-builder.mjs`, which feeds them both, used
 * localeCompare anyway. A pen test then produced two different graph hashes
 * for one vault. The comments were right and unread; a shared module plus a
 * capability test in `tests/security-invariants.test.mjs` is what makes the
 * rule actually hold.
 *
 * Use this for any ordering whose OUTPUT IS PERSISTED, HASHED, DIFFED OR
 * COMPARED. For a human-facing display list where locale collation genuinely
 * reads better, add an explicit exception to that test — the friction is the
 * point, not an obstacle.
 *
 * ONE KNOWN EXCEPTION, deliberate and left alone: `okf-bundle-exporter.mjs`
 * sorts with its own `compareByBytes` (UTF-8 byte order) in seven places. That
 * is ALSO a total order — it has none of the `localeCompare` defect, returns 0
 * only for equal strings, and does not depend on ICU — so the guard correctly
 * lets it pass. It merely disagrees with `cmp` across the surrogate range,
 * where UTF-8 byte order and UTF-16 code-unit order diverge (`😀a` vs `Ａa`:
 * cmp says -1, bytes say +1). Both orderings are stable; only their choice
 * differs. Converging them would change OKF bundle bytes for any vault with
 * astral characters — a gratuitous output change inside a security release —
 * so it is a follow-up, and this comment exists so "one definition" is not
 * read as a claim that no other total order exists in the tree.
 */

/**
 * Code-unit comparison — a true total order over strings.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1|0|1}
 */
export function cmp(a, b) {
  const x = String(a);
  const y = String(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}
