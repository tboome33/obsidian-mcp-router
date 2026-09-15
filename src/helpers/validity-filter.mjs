/**
 * Temporal validity — the FILTER (roadmap phase 4b.1).
 *
 * This is the first place in the whole batch where a page can be REMOVED from
 * an answer. Everything before it annotates: the linter reports, the recall
 * hook marks, the context pack labels, and none of them ever shortens a result.
 * So this module is where invariant 3 stops being a slogan and becomes code.
 *
 * THREE THINGS ARE NEVER EXCLUDED, and each for its own reason.
 *
 *   - A page that declares NO window makes no temporal claim. Excluding it
 *     would answer a question it never took a position on, and it is not even
 *     counted as excluded, because nothing about it was refused.
 *   - A page whose window is UNREADABLE is a page nobody could classify. It
 *     carries a defect its author should see, and hiding it is how a malformed
 *     window becomes permanent. Invariant 2, stated in a predicate.
 *   - An entry that could not be VERIFIED — the page vanished, the budget ran
 *     out — is an absence of knowledge, not a verdict. It stays, marked.
 *
 * Only a CERTAIN state can put an entry outside the caller's list: in force,
 * not yet, no longer. That is the whole rule, and the rest is bookkeeping.
 *
 * OMITTED AND EMPTY MEAN THE SAME THING, deliberately, because they do for
 * `exemptStatuses` elsewhere in this codebase and a reader should not have to
 * remember which list treats `[]` as "none" and which as "all".
 */

import {
  STATE_IN_FORCE,
  STATE_NOT_YET,
  STATE_NO_LONGER,
  STATE_UNREADABLE,
} from './temporal-validity.mjs';
import { UNVERIFIED_KEY, VALIDITY_KEY } from './validity-annotator.mjs';

/**
 * Every value the caller may name. `unreadable` is accepted so a caller can ask
 * to see ONLY the malformed windows — a useful audit — even though naming it or
 * not never causes an exclusion.
 */
export const VALIDITY_STATES = Object.freeze([
  STATE_IN_FORCE,
  STATE_NOT_YET,
  STATE_NO_LONGER,
  STATE_UNREADABLE,
]);

/** The states that can place an entry outside the caller's list. */
const CERTAIN_STATES = new Set([STATE_IN_FORCE, STATE_NOT_YET, STATE_NO_LONGER]);

function filterError(message) {
  const err = new Error(message);
  err.kind = 'validation';
  return err;
}

/**
 * Turn the caller's `validityStates` into a keep-set, or `null` for "no filter".
 *
 * An unknown value FAILS THE CALL. A filter is a request to hide things, and a
 * typo in it would hide a different set than the caller asked for while looking
 * like it worked — the one failure mode a filter must never have.
 *
 * @returns {Set<string>|null} `null` means every entry is kept.
 */
export function normalizeValidityStates(input) {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) {
    throw filterError(
      `validityStates must be an array of states to KEEP, got ${typeof input}. `
      + `Valid states: ${VALIDITY_STATES.join(', ')}. Omit it, or pass [], to keep everything.`,
    );
  }
  // OMITTED AND EMPTY ARE THE SAME ANSWER. Reading `[]` as "keep nothing" would
  // turn an empty variable in a caller's script into a silently empty result.
  if (input.length === 0) return null;

  const unknown = input.filter((s) => !VALIDITY_STATES.includes(s));
  if (unknown.length > 0) {
    throw filterError(
      `validityStates contains ${unknown.length === 1 ? 'an unknown state' : 'unknown states'}: `
      + `${unknown.map((s) => JSON.stringify(s)).join(', ')}. `
      + `Valid states: ${VALIDITY_STATES.join(', ')}.`,
    );
  }
  return new Set(input);
}

/**
 * Does this entry survive the filter?
 *
 * Exported because the reason an entry is kept is worth reading on its own, and
 * because the truth table is easier to test against a predicate than against a
 * partitioned array.
 */
export function keepsUnderValidity(entry, states) {
  if (states === null) return true;
  // Unverified: an absence of knowledge, never a verdict.
  if (entry && entry[UNVERIFIED_KEY]) return true;
  const validity = entry ? entry[VALIDITY_KEY] : undefined;
  // No window declared: the page takes no temporal position.
  if (!validity || typeof validity.state !== 'string') return true;
  // Unreadable: a defect to surface, never something to hide (invariant 2).
  if (!CERTAIN_STATES.has(validity.state)) return true;
  return states.has(validity.state);
}

/**
 * Partition annotated entries.
 *
 * `excludedHits` counts ONLY entries a certain state put outside the list — the
 * count answers "what did this filter cost me", and folding untouched entries
 * into it would make a filter that removed nothing look like it removed plenty.
 *
 * @returns {{kept: object[], excludedHits: number}}
 */
export function applyValidityFilter(entries, states) {
  const list = Array.isArray(entries) ? entries : [];
  if (states === null) return { kept: list, excludedHits: 0 };
  const kept = [];
  let excludedHits = 0;
  for (const entry of list) {
    if (keepsUnderValidity(entry, states)) kept.push(entry);
    else excludedHits += 1;
  }
  return { kept, excludedHits };
}
