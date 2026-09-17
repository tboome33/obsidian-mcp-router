/**
 * Temporal validity across a fan-out (roadmap phase 4c.2).
 *
 * A cross-vault search answers with one entry per vault, some of which failed.
 * The top level then has to say something about the whole, and the interesting
 * part is not the addition — it is what a FAILED vault does to each number.
 *
 * THE SUMS ARE OVER THE VAULTS THAT ANSWERED, and the response says how many
 * those were. A total whose scope is not stated reads as a total over the
 * fleet, and a fleet where a third of the vaults were unreachable would then
 * report a third less of everything while looking complete.
 *
 * `moreCandidates` IS NOT A SUM, it is an existential question: "is there an
 * eligible chunk nobody looked at?" So it merges by PRIORITY, and a vault that
 * errored counts as `'unknown'` — we did not look at it, so we cannot say we
 * looked everywhere. That gives two distinct witnesses the roadmap names:
 *
 *   true  + error -> true       one positive answer settles an existential
 *   false + error -> 'unknown'  everything we SAW was exhausted, but not all
 *                               of it was seen
 */

import { REVISION_COHERENCE } from './validity-annotator.mjs';

/** The answer when nothing can be said about what was not returned. */
export const MORE_CANDIDATES_UNKNOWN = 'unknown';

/**
 * Merge existential answers by priority: `true` beats `'unknown'` beats `false`.
 *
 * Over an EMPTY list the answer is `false`: there were no candidates at all, so
 * there is none that went unexamined. That is different from `'unknown'`, which
 * would claim a doubt nothing supports.
 */
export function mergeMoreCandidates(values) {
  let sawUnknown = false;
  for (const v of values) {
    if (v === true) return true;
    if (v !== false) sawUnknown = true;
  }
  return sawUnknown ? MORE_CANDIDATES_UNKNOWN : false;
}

function numberOr0(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Build the top-level validity blocks for a fan-out response.
 *
 * @param {object[]} perVault  the per-vault entries, successes and `{vault,error}` alike
 * @param {object} options
 * @param {string} options.asOf            the ONE day resolved for the whole call
 * @param {boolean} options.filterRequested whether the caller passed `validityStates`
 * @param {string[]} options.states        the normalised keep-list (may be empty)
 * @returns {{validitySummary: object, validityFilter?: object}}
 */
export function mergeFanoutValidity(perVault, { asOf, filterRequested, states = [] } = {}) {
  const entries = Array.isArray(perVault) ? perVault : [];
  // AN ENTRY IS "IN ERROR" WHEN IT CARRIES ONE, not when it lacks a summary.
  // Those are different: a vault can answer successfully and be summarised, and
  // a future shape could answer without a summary. Keying on `error` keeps
  // `vaultsInError` meaning what its name says.
  const failed = entries.filter((e) => e && e.error !== undefined);
  const answered = entries.filter((e) => e && e.error === undefined && e.validitySummary);
  // THE THIRD CATEGORY, WHICH USED TO FALL BETWEEN THE TWO. An entry that
  // carries no error and no summary was in neither list: it contributed nothing
  // to the sums, nothing to `coverage`, and — worse — no answer at all to
  // `moreCandidates`, so a fan-out over one such vault reported `false`, which
  // reads as "there is nothing more anywhere". Saying nothing is not saying no.
  // (Adversarial review, 2026-09-16.)
  const unsummarized = entries.filter((e) => e && e.error === undefined && !e.validitySummary);

  const summary = {
    asOf,
    annotatedEntries: 0,
    inspectedPages: 0,
    unverifiedPages: 0,
    budgetExhausted: false,
    revisionCoherence: REVISION_COHERENCE,
    // THE SCOPE OF THE SUMS, stated rather than left to be inferred. Without
    // it, a fleet with three unreachable vaults reports three vaults' less of
    // everything and looks like a complete answer.
    coverage: {
      vaultsSummarized: answered.length,
      vaultsInError: failed.length,
      vaultsUnsummarized: unsummarized.length,
    },
  };

  for (const entry of answered) {
    const s = entry.validitySummary;
    summary.annotatedEntries += numberOr0(s.annotatedEntries);
    summary.inspectedPages += numberOr0(s.inspectedPages);
    summary.unverifiedPages += numberOr0(s.unverifiedPages);
    if (s.budgetExhausted === true) summary.budgetExhausted = true;
  }

  if (!filterRequested) return { validitySummary: summary };

  let excludedHits = 0;
  let cutByLimit = 0;
  const candidateAnswers = [];
  for (const entry of answered) {
    const f = entry.validityFilter;
    // A VAULT THAT ANSWERED WITHOUT SAYING WHAT IT FILTERED has not told us it
    // filtered nothing — it has told us nothing. Skipping it left the merge
    // with one fewer voice and let the remaining `false`s carry the answer.
    if (!f) { candidateAnswers.push(MORE_CANDIDATES_UNKNOWN); continue; }
    excludedHits += numberOr0(f.excludedHits);
    cutByLimit += numberOr0(f.cutByLimit);
    candidateAnswers.push(f.moreCandidates);
  }
  // A VAULT WE COULD NOT REACH IS AN UNEXAMINED CORPUS. Leaving it out would
  // let a fleet answer `false` — "nothing more anywhere" — while an entire
  // vault went unread. A vault that answered without a summary is the same
  // silence wearing a different shape.
  const unheard = failed.length + unsummarized.length;
  for (let i = 0; i < unheard; i += 1) candidateAnswers.push(MORE_CANDIDATES_UNKNOWN);

  return {
    validitySummary: summary,
    validityFilter: {
      states: [...states],
      excludedHits,
      cutByLimit,
      moreCandidates: mergeMoreCandidates(candidateAnswers),
    },
  };
}
