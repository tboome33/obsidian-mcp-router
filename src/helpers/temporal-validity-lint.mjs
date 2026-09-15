/**
 * temporal-validity-lint — Check R of `wiki-lint`.
 *
 * The first CONSUMER of `temporal-validity.mjs`, and the shape of every one
 * that follows: it decides nothing about dates itself. It calls the helper and
 * turns the state into findings. Break the bound comparison in the helper and
 * a witness in this module's tests must go red — that mutation, not a shared
 * fixture, is what proves the dependency is real rather than parallel.
 *
 * WHAT IT NEVER DOES: ask for a window. Nothing here can know that a page is
 * regulatory, so a page with no `valid_from` / `valid_through` produces no
 * finding at all — not even an informational one. The check exists for a
 * window that WAS declared and cannot be trusted, or that no longer covers
 * today. Silence is the normal answer.
 *
 * SEVERITIES, and why they are not all the same:
 *
 *   valid-window-inverted    ERROR    — `valid_from` is after `valid_through`.
 *                                       Both dates read fine and the pair
 *                                       cannot be true, so the page misleads
 *                                       whichever way a reader takes it.
 *   valid-window-unreadable  WARNING  — a bound that is not a calendar date.
 *                                       The page still says something; what it
 *                                       says about time cannot be established.
 *   valid-window-not-yet     INFO     — declared, readable, starts later.
 *   valid-window-expired     INFO     — declared, readable, already ended.
 *
 * The last two are INFORMATION, not defects, and that is the whole posture of
 * the feature: a repealed rule is a legitimate page. It explains the past and
 * it explains the rule that replaced it. Reporting it as a problem would push
 * an author to delete knowledge in order to silence a linter.
 *
 * NOTHING HERE IS AUTO-FIXABLE. A wrong date is corrected by reading the
 * source, and a linter that guesses one invents history — the same refusal
 * `prompt-lint` makes about an absent status.
 *
 * ⚠️ Check R, not Check Q. The plan said Q; Q was taken by the conventions
 * drift check while this lot sat unstarted (two sessions, one repo, one day).
 */

import { classifyValidity, resolveAsOf, PROBLEM_INVERTED, STATE_NOT_YET, STATE_NO_LONGER, STATE_UNREADABLE } from './temporal-validity.mjs';

/** Frozen copies of a vault: a finding there is one nobody can act on. */
const BACKUP_SEGMENTS = ['.okf-rename-backup', '.trash', '.obsidian-backup'];

/** The four rules, exported so callers and tests name them. */
export const RULE_UNREADABLE = 'valid-window-unreadable';
export const RULE_INVERTED = 'valid-window-inverted';
export const RULE_NOT_YET = 'valid-window-not-yet';
export const RULE_EXPIRED = 'valid-window-expired';

/**
 * True when a vault-relative path sits inside a frozen copy. Whole SEGMENTS
 * only — `.trash-notes/` is a normal folder whose pages must still be linted.
 */
function isBackupPath(path) {
  return path.split(/[/\\]+/).some((s) => BACKUP_SEGMENTS.includes(s));
}

/** Render a window for a human, with the open side spelled out. */
function describeWindow(from, through) {
  if (from && through) return `${from} to ${through}`;
  if (from) return `from ${from}, with no end declared`;
  return `until ${through}, with no start declared`;
}

/**
 * Check the temporal-validity contract over a set of pages.
 *
 * INPUT CONTRACT: `frontmatter` must come from a REAL YAML parse — the
 * router's `get_frontmatter` / `getNote`, which is what `wiki-lint` collects.
 * It must NOT be the output of the line-oriented parser used by the search
 * index, which flattens a nested block: under that parser a key nested beneath
 * a parent surfaces at the top level (so a page that declares nothing would be
 * reported as not-yet-in-force) and a bound holding a block collapses to the
 * empty string (so a malformed window would pass unreported). Both were found
 * in review, and neither is something this module can detect after the fact —
 * by the time it sees an object, the shape is already gone.
 *
 * @param {Array<{path: string, frontmatter: object}>} pages
 * @param {{today?: string, clock?: () => Date}} [options] `today` is an ISO
 *   calendar day and is the linter's historical name for the reference day
 *   (`decision-lint` uses it for `review_after`), kept rather than renamed so
 *   one lint pass reads with one vocabulary. Omitted or `null`, the day comes
 *   from `clock` — read ONCE — which defaults to the real clock; any other
 *   unreadable value is refused.
 * @returns {Array<{rule: string, path: string, severity: string, detail: string}>}
 * @throws {Error} when `today` is present but unreadable — BEFORE any page is
 *   examined, so a mistyped argument fails on its own terms rather than
 *   depending on whether the corpus happens to contain a dated page.
 */
export function lintTemporalValidity(pages, options = {}) {
  // ONCE per pass, never per page: a vault large enough to take a second to
  // walk is a vault that can cross midnight halfway through, and two pages of
  // one report classified against two different days is a defect nobody would
  // ever reproduce. The `clock` seam exists so that claim has a witness —
  // without it, moving this line into the loop below would change nothing any
  // test could see.
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const today = resolveAsOf(options.today, clock());

  const findings = [];

  for (const entry of Array.isArray(pages) ? pages : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { path, frontmatter } = entry;
    // Validated before anything coerces it: `String(value)` throws on an object
    // with a null `toString`, and one malformed entry must not abort the lint.
    // An EMPTY path is malformed too, and the failure it causes is quieter: the
    // finding is emitted, looks ordinary in the report, and points at no file
    // (found in review).
    if (typeof path !== 'string' || path.trim() === '') continue;
    if (isBackupPath(path)) continue;

    // No `type` test on purpose. Any page may declare when it applies — a
    // `concept`, a `fact`, a `reference`, a `decision-input`. Narrowing this to
    // a list of types would silently stop checking the pages the feature was
    // built for.
    const validity = classifyValidity(frontmatter, { asOf: today });
    if (validity === null) continue;

    const { state, from, through, problems } = validity;

    if (state === STATE_UNREADABLE) {
      // `inverted` and a malformed bound are mutually exclusive: inversion is
      // only computed when BOTH bounds read cleanly. They are still separated
      // here rather than collapsed, because they are different requests to the
      // author — one says "this is not a date", the other says "these two dates
      // are in the wrong order".
      if (problems.includes(PROBLEM_INVERTED)) {
        findings.push({
          rule: RULE_INVERTED,
          path,
          severity: 'error',
          detail:
            `\`valid_from: ${from}\` is after \`valid_through: ${through}\` — no day satisfies `
            + 'this window, so the page is wrong whichever bound a reader believes',
        });
      } else {
        // Every unreadable bound is named. A report that mentions one and hides
        // the other sends the author back twice.
        findings.push({
          rule: RULE_UNREADABLE,
          path,
          severity: 'warning',
          detail:
            `${problems.join(', ')} — a bound must be a calendar date written \`YYYY-MM-DD\`; `
            + 'until it is, what this page says about time cannot be established',
        });
      }
      continue;
    }

    if (state === STATE_NOT_YET) {
      findings.push({
        rule: RULE_NOT_YET,
        path,
        severity: 'info',
        detail: `not yet in force on ${today} — declared ${describeWindow(from, through)}`,
      });
      continue;
    }

    if (state === STATE_NO_LONGER) {
      findings.push({
        rule: RULE_EXPIRED,
        path,
        severity: 'info',
        detail:
          `no longer in force on ${today} — declared ${describeWindow(from, through)}. `
          + 'This is information, not a defect: a page that describes a period now past is '
          + 'still knowledge, and deleting it to silence a linter loses it',
      });
    }
  }

  return findings;
}
