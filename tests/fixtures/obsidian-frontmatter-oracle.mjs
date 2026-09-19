/**
 * What OBSIDIAN'S OWN YAML parser returns for each case of the conformance
 * corpus — MEASURED, not declared.
 *
 * `temporal-validity-cases.mjs` carries two expectations per case: `expect`,
 * what the router's line-oriented parser must produce, and `expectYaml`, what a
 * spec-conformant YAML parser produces instead on the two shapes where they
 * disagree. Both are things we WROTE DOWN. The file that holds them says so:
 *
 *   "Comparing the two parsers for real needs Obsidian's, which arrives with
 *    the annotator phase — the fixture exists precisely so that comparison has
 *    something to run against."
 *
 * This is that comparison, run. Every case below was written to a scratch
 * folder of the `.template` vault, read back through Local REST API's
 * `application/vnd.olrapi.note+json` view, and the pages deleted. Captured
 * 2026-09-19 from `C:\VAULTS\.template`.
 *
 * WHY OBSIDIAN IS THE ORACLE AND A SPEC PARSER IS NOT. The invariant this lot
 * defends is about what the router reports versus what the reader sees — and
 * what the reader sees is Obsidian's parse. The two are not interchangeable:
 * Obsidian hands back a bare ISO date as a plain STRING (re-confirmed by the
 * positive control of this capture), where a YAML 1.1 loader hands back a Date
 * object — which `classifyValidity` would judge `not-a-string` and report
 * unreadable. An oracle that disagrees with the consumer manufactures findings.
 *
 * HOW TO RE-CAPTURE. Rewrite the corpus into a scratch folder of any vault and
 * read each page back with the note+json Accept header. Run a POSITIVE CONTROL
 * first — a page with an obviously valid window — because an empty
 * `frontmatter` means either "the parse failed" or "Obsidian has not indexed
 * this yet", and only the control tells them apart. Settle each read against
 * the CONTENT the response carries, so a stale index entry cannot be mistaken
 * for a verdict.
 *
 * `undefined` means the key was ABSENT from Obsidian's object; `null` means it
 * was present and null. Those are different facts and the corpus depends on
 * the difference.
 */

/** @typedef {{valid_from?: unknown, valid_through?: unknown}} ObsidianFrontmatter */

/** The day the capture ran, so a stale fixture is visible rather than assumed. */
export const ORACLE_CAPTURED_ON = '2026-09-19';

/** @type {Record<string, ObsidianFrontmatter>} */
export const OBSIDIAN_ORACLE = {
  'no-window-at-all': {},
  'in-force-closed-window': { valid_from: '2026-01-01', valid_through: '2026-12-31' },
  'not-yet-in-force': { valid_from: '2027-01-01' },
  'no-longer-in-force': { valid_through: '2025-12-31' },
  'open-ended-from-the-past': { valid_from: '2020-03-01' },
  'single-day-window-on-its-day': { valid_from: '2026-06-15', valid_through: '2026-06-15' },
  'single-day-window-the-day-after': { valid_from: '2026-06-15', valid_through: '2026-06-15' },
  'last-day-is-included': { valid_from: '2026-01-01', valid_through: '2026-12-31' },
  'day-after-the-last-day': { valid_from: '2026-01-01', valid_through: '2026-12-31' },
  'first-day-is-included': { valid_from: '2026-01-01', valid_through: '2026-12-31' },
  'day-before-the-first-day': { valid_from: '2026-01-01', valid_through: '2026-12-31' },
  // Quoting changes nothing on Obsidian's side either — the point of the case.
  'quoted-dates-read-the-same': { valid_from: '2026-01-01', valid_through: '2026-12-31' },
  'unreadable-typo-french-order': { valid_through: '01/01/2026' },
  'unreadable-day-that-does-not-exist': { valid_from: '2026-02-30' },
  'unreadable-inverted-window': { valid_from: '2026-12-31', valid_through: '2026-01-01' },
  // A valueless key comes back PRESENT AND NULL, not absent. `normalizeBound`
  // turns that into absence; the distinction is why it is recorded here.
  'empty-key-is-absent-not-unreadable': { valid_from: null },
  'literal-null-is-absent': { valid_from: null, valid_through: null },
  'null-alongside-a-real-bound': { valid_from: null, valid_through: '2025-12-31' },
  'not-a-date-at-all': { valid_from: 'soon' },
  'datetime-is-refused': { valid_from: '2026-01-01T10:00:00' },
  'both-bounds-unreadable': { valid_from: 'hier', valid_through: 'demain' },
  // THE ONE THAT SETTLES A DECLARED DIVERGENCE. A bound holding a block is an
  // OBJECT here — which is `not-a-string`, so the window is unreadable. The
  // line parser flattens it to the empty string and reports a confident
  // `in-force`. `expectYaml` predicted this; the prediction is now measured.
  'object-as-a-bound-loses-its-error': { valid_from: { date: '2026-01-01' }, valid_through: '2026-12-31' },
  // AND THE OTHER ONE. A key nested under a parent stays nested: Obsidian's
  // top level holds neither bound, so the page declares nothing. The line
  // parser lifts it and invents a window.
  'nested-object-hides-the-window': {},
};
