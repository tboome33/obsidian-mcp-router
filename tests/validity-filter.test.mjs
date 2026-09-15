/**
 * The temporal-validity FILTER — the truth table of roadmap 4b.1.
 *
 * This is the first place in the batch where a page can be removed from an
 * answer, so the interesting assertions are all about what is NOT removed. A
 * filter that hides slightly more than it was asked to is indistinguishable
 * from a correct one until someone misses the page that mattered.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALIDITY_STATES,
  applyValidityFilter,
  keepsUnderValidity,
  normalizeValidityStates,
} from '../src/helpers/validity-filter.mjs';
import {
  STATE_IN_FORCE,
  STATE_NOT_YET,
  STATE_NO_LONGER,
  STATE_UNREADABLE,
} from '../src/helpers/temporal-validity.mjs';

/** An entry as the annotator leaves it. */
const inForce = () => ({ path: 'a.md', validity: { state: STATE_IN_FORCE, from: null, through: null, asOf: '2026-06-15' } });
const expired = () => ({ path: 'b.md', validity: { state: STATE_NO_LONGER, from: null, through: '2025-12-31', asOf: '2026-06-15' } });
const future = () => ({ path: 'c.md', validity: { state: STATE_NOT_YET, from: '2027-01-01', through: null, asOf: '2026-06-15' } });
const broken = () => ({ path: 'd.md', validity: { state: STATE_UNREADABLE, from: null, through: null, asOf: '2026-06-15', problems: ['valid_from:not-iso'] } });
const silent = () => ({ path: 'e.md' });
const unverified = () => ({ path: 'f.md', validityUnverified: true });

// ---------------------------------------------------------------------------
describe('the vocabulary', () => {
  test('exactly the four states the helper can produce', () => {
    assert.deepEqual([...VALIDITY_STATES].sort(), [
      STATE_IN_FORCE, STATE_NOT_YET, STATE_NO_LONGER, STATE_UNREADABLE,
    ].sort());
  });

  test('and it is frozen — a caller cannot widen it by mutating the export', () => {
    assert.throws(() => { VALIDITY_STATES.push('whatever'); }, TypeError);
  });
});

// ---------------------------------------------------------------------------
describe('normalizing what the caller asked for', () => {
  test('omitted means no filter', () => {
    assert.equal(normalizeValidityStates(undefined), null);
    assert.equal(normalizeValidityStates(null), null);
  });

  test('EMPTY means the same as omitted, and that is deliberate', () => {
    // An empty variable in a caller's script must not silently become "keep
    // nothing". `exemptStatuses` reads `[]` the same way elsewhere in this
    // codebase, and two list parameters disagreeing on `[]` is a trap.
    assert.equal(normalizeValidityStates([]), null);
  });

  test('a real list becomes a keep-set', () => {
    const states = normalizeValidityStates([STATE_IN_FORCE]);
    assert.ok(states instanceof Set);
    assert.equal(states.has(STATE_IN_FORCE), true);
    assert.equal(states.size, 1);
  });

  test('AN UNKNOWN STATE FAILS THE CALL, and the message names it', () => {
    // A typo in a filter hides a different set than the caller asked for while
    // looking like it worked. That is the one failure mode a filter may not have.
    assert.throws(
      () => normalizeValidityStates(['in-force', 'expired']),
      (err) => {
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /"expired"/, 'the offending value is quoted back');
        assert.match(err.message, /in-force/, 'and the valid vocabulary is listed');
        return true;
      },
    );
  });

  test('several unknown values are all named, not just the first', () => {
    assert.throws(
      () => normalizeValidityStates(['nope', 'also-nope']),
      (err) => {
        assert.match(err.message, /"nope"/);
        assert.match(err.message, /"also-nope"/);
        return true;
      },
    );
  });

  test('a non-array is refused with a usable message', () => {
    assert.throws(() => normalizeValidityStates('in-force'), /must be an array/);
    assert.throws(() => normalizeValidityStates({ state: 'in-force' }), /must be an array/);
  });

  test('a near-miss of a real state is still unknown — no fuzzy matching', () => {
    assert.throws(() => normalizeValidityStates(['in_force']), /"in_force"/);
    assert.throws(() => normalizeValidityStates(['In-Force']), /"In-Force"/);
  });
});

// ---------------------------------------------------------------------------
describe('THE THREE THINGS THAT ARE NEVER EXCLUDED', () => {
  // Each has its own reason, so each has its own test: a single "non-certain
  // entries survive" assertion would pass with two of the three branches gone.
  const strict = normalizeValidityStates([STATE_IN_FORCE]);

  test('a page that declares NO window — it takes no temporal position', () => {
    assert.equal(keepsUnderValidity(silent(), strict), true);
  });

  test('a page whose window is UNREADABLE — invariant 2, hiding it makes the defect permanent', () => {
    assert.equal(keepsUnderValidity(broken(), strict), true);
  });

  test('an entry that could not be VERIFIED — absence of knowledge, not a verdict', () => {
    assert.equal(keepsUnderValidity(unverified(), strict), true);
  });

  test('and the unverified flag WINS over a window that is somehow still attached', () => {
    // THE WITNESS THAT WAS MISSING, found by mutation: deleting the unverified
    // branch changed nothing, because an entry the annotator marked has no
    // `validity` left and the next branch caught it anyway. Two overlapping
    // checks, and no test separating them.
    //
    // They stop overlapping exactly here. The annotator never produces this
    // shape — `markUnverified` deletes the window — but a caller assembling
    // entries by hand can, and "we could not verify this" must outrank a stale
    // verdict rather than letting it decide.
    const both = { path: 'g.md', validityUnverified: true, validity: { state: STATE_NO_LONGER, from: null, through: '2025-12-31', asOf: '2026-06-15' } };
    assert.equal(keepsUnderValidity(both, strict), true,
      'if this is false, the unverified branch is gone and a stale window is deciding');
  });

  test('and an unreadable page is kept even when the caller asked for the OPPOSITE', () => {
    // `['no-longer-in-force']` excludes in-force and not-yet. It must still not
    // reach the unreadable one.
    const other = normalizeValidityStates([STATE_NO_LONGER]);
    assert.equal(keepsUnderValidity(broken(), other), true);
  });
});

// ---------------------------------------------------------------------------
describe('what a certain state does', () => {
  const onlyCurrent = normalizeValidityStates([STATE_IN_FORCE]);

  test('in the list: kept', () => {
    assert.equal(keepsUnderValidity(inForce(), onlyCurrent), true);
  });

  test('outside the list: excluded', () => {
    assert.equal(keepsUnderValidity(expired(), onlyCurrent), false);
    assert.equal(keepsUnderValidity(future(), onlyCurrent), false);
  });

  test('no filter at all: everything is kept, certain or not', () => {
    for (const entry of [inForce(), expired(), future(), broken(), silent(), unverified()]) {
      assert.equal(keepsUnderValidity(entry, null), true);
    }
  });

  test('asking ONLY for unreadable windows is a legitimate audit', () => {
    // It excludes all three certain states and keeps the malformed ones — which
    // is exactly what a caller auditing the corpus wants.
    const audit = normalizeValidityStates([STATE_UNREADABLE]);
    assert.equal(keepsUnderValidity(broken(), audit), true);
    assert.equal(keepsUnderValidity(inForce(), audit), false);
    assert.equal(keepsUnderValidity(expired(), audit), false);
    assert.equal(keepsUnderValidity(future(), audit), false);
    assert.equal(keepsUnderValidity(silent(), audit), true, 'still no position, still kept');
  });

  test('a malformed annotation is treated as no window, not as a certain state', () => {
    // Defence in depth: whatever put a non-string state there, it is not
    // grounds to hide a page.
    assert.equal(keepsUnderValidity({ path: 'x', validity: {} }, onlyCurrent), true);
    assert.equal(keepsUnderValidity({ path: 'x', validity: { state: 42 } }, onlyCurrent), true);
    assert.equal(keepsUnderValidity({ path: 'x', validity: null }, onlyCurrent), true);
  });
});

// ---------------------------------------------------------------------------
describe('partitioning, and what excludedHits counts', () => {
  test('only the entries a certain state pushed out', () => {
    // Untouched entries folded into this count would make a filter that removed
    // nothing look like it removed plenty.
    const entries = [inForce(), expired(), future(), broken(), silent(), unverified()];
    const { kept, excludedHits } = applyValidityFilter(entries, normalizeValidityStates([STATE_IN_FORCE]));
    assert.equal(excludedHits, 2, 'the expired and the future one');
    assert.deepEqual(kept.map((e) => e.path), ['a.md', 'd.md', 'e.md', 'f.md']);
  });

  test('no filter: the SAME array reference comes back, and nothing is counted', () => {
    const entries = [inForce(), expired()];
    const result = applyValidityFilter(entries, null);
    assert.equal(result.kept, entries, 'no copy, no reordering');
    assert.equal(result.excludedHits, 0);
  });

  test('order is preserved — the filter never reranks', () => {
    const entries = [expired(), inForce(), future(), inForce()];
    entries[1].path = 'first-current';
    entries[3].path = 'second-current';
    const { kept } = applyValidityFilter(entries, normalizeValidityStates([STATE_IN_FORCE]));
    assert.deepEqual(kept.map((e) => e.path), ['first-current', 'second-current']);
  });

  test('everything excluded gives an EMPTY result that still carries its count', () => {
    // A response that filtered five hits away and reports zero of everything is
    // indistinguishable from a query that matched nothing.
    const entries = [expired(), expired(), expired(), expired(), expired()];
    const { kept, excludedHits } = applyValidityFilter(entries, normalizeValidityStates([STATE_IN_FORCE]));
    assert.deepEqual(kept, []);
    assert.equal(excludedHits, 5);
  });

  test('a non-array is an empty partition, not a crash', () => {
    assert.deepEqual(applyValidityFilter(null, null), { kept: [], excludedHits: 0 });
    assert.deepEqual(applyValidityFilter(undefined, normalizeValidityStates([STATE_IN_FORCE])), { kept: [], excludedHits: 0 });
  });
});
