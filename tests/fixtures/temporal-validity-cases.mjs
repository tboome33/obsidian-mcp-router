/**
 * The shared conformance corpus for temporal validity.
 *
 * Each case is a COMPLETE MARKDOWN DOCUMENT, not a pre-parsed object, and that
 * is the whole point. Four consumers will read these fields through four
 * different doors — the router's line-oriented frontmatter parser (linter,
 * hooks, index), Obsidian's YAML parser through `getNote`, and whatever a
 * future surface uses — and a corpus of objects would prove only that the
 * helper agrees with itself. Feeding the same bytes through each consumer's
 * own parser is what proves they agree with each other.
 *
 * `expect` is what the ROUTER'S LINE PARSER must produce. `expectYaml`, when
 * present, is what a spec-conformant YAML parser must produce instead — the
 * two genuinely disagree on one shape, and this corpus documents that
 * divergence rather than hiding it (see `nested-object-hides-the-window`).
 *
 * `state: null` means the page declares no window at all, which is not a state
 * and must stay silent.
 */

/** @typedef {{id: string, markdown: string, asOf: string, expect: object, expectYaml?: object, note?: string}} ValidityCase */

const body = '\n# A page\n\nSome prose so the document is not frontmatter alone.\n';

function doc(frontmatterLines) {
  return `---\n${frontmatterLines.join('\n')}\n---\n${body}`;
}

/** @type {ValidityCase[]} */
export const TEMPORAL_VALIDITY_CASES = [
  {
    id: 'no-window-at-all',
    markdown: doc(['type: concept', 'title: "Untouched by time"']),
    asOf: '2026-06-15',
    expect: { state: null },
    note: 'The normal case for nearly every page: no fields, no state, no annotation.',
  },
  {
    id: 'in-force-closed-window',
    markdown: doc(['type: fact', 'valid_from: 2026-01-01', 'valid_through: 2026-12-31']),
    asOf: '2026-06-15',
    expect: { state: 'in-force', from: '2026-01-01', through: '2026-12-31' },
  },
  {
    id: 'not-yet-in-force',
    markdown: doc(['type: fact', 'valid_from: 2027-01-01']),
    asOf: '2026-06-15',
    expect: { state: 'not-yet-in-force', from: '2027-01-01', through: null },
    note: 'A reform announced for next year. The dangerous one: applying it early.',
  },
  {
    id: 'no-longer-in-force',
    markdown: doc(['type: fact', 'valid_through: 2025-12-31']),
    asOf: '2026-06-15',
    expect: { state: 'no-longer-in-force', from: null, through: '2025-12-31' },
  },
  {
    id: 'open-ended-from-the-past',
    markdown: doc(['type: fact', 'valid_from: 2020-03-01']),
    asOf: '2026-06-15',
    expect: { state: 'in-force', from: '2020-03-01', through: null },
    note: 'One bound alone is a legitimate window: applies since, no known end.',
  },
  {
    id: 'single-day-window-on-its-day',
    markdown: doc(['type: fact', 'valid_from: 2026-06-15', 'valid_through: 2026-06-15']),
    asOf: '2026-06-15',
    expect: { state: 'in-force', from: '2026-06-15', through: '2026-06-15' },
  },
  {
    id: 'single-day-window-the-day-after',
    markdown: doc(['type: fact', 'valid_from: 2026-06-15', 'valid_through: 2026-06-15']),
    asOf: '2026-06-16',
    expect: { state: 'no-longer-in-force', from: '2026-06-15', through: '2026-06-15' },
  },
  {
    id: 'last-day-is-included',
    markdown: doc(['type: fact', 'valid_from: 2026-01-01', 'valid_through: 2026-12-31']),
    asOf: '2026-12-31',
    expect: { state: 'in-force', from: '2026-01-01', through: '2026-12-31' },
    note: 'The witness the whole "through means included" choice rests on.',
  },
  {
    id: 'day-after-the-last-day',
    markdown: doc(['type: fact', 'valid_from: 2026-01-01', 'valid_through: 2026-12-31']),
    asOf: '2027-01-01',
    expect: { state: 'no-longer-in-force', from: '2026-01-01', through: '2026-12-31' },
  },
  {
    id: 'first-day-is-included',
    markdown: doc(['type: fact', 'valid_from: 2026-01-01', 'valid_through: 2026-12-31']),
    asOf: '2026-01-01',
    expect: { state: 'in-force', from: '2026-01-01', through: '2026-12-31' },
  },
  {
    id: 'day-before-the-first-day',
    markdown: doc(['type: fact', 'valid_from: 2026-01-01', 'valid_through: 2026-12-31']),
    asOf: '2025-12-31',
    expect: { state: 'not-yet-in-force', from: '2026-01-01', through: '2026-12-31' },
  },
  {
    id: 'quoted-dates-read-the-same',
    markdown: doc(['type: fact', 'valid_from: "2026-01-01"', 'valid_through: "2026-12-31"']),
    asOf: '2026-06-15',
    expect: { state: 'in-force', from: '2026-01-01', through: '2026-12-31' },
    note: 'Quoting is an authoring habit, not a meaning. Both spellings agree.',
  },
  {
    id: 'unreadable-typo-french-order',
    markdown: doc(['type: fact', 'valid_through: 01/01/2026']),
    asOf: '2026-06-15',
    expect: { state: 'unreadable', from: null, through: null, problems: ['valid_through:not-iso'] },
    note: 'The exact shape that made a review_after silently permanent.',
  },
  {
    id: 'unreadable-day-that-does-not-exist',
    markdown: doc(['type: fact', 'valid_from: 2026-02-30']),
    asOf: '2026-06-15',
    expect: { state: 'unreadable', from: null, through: null, problems: ['valid_from:not-a-calendar-date'] },
    note: 'Well-formed and impossible. review_after accepts this one; this field does not.',
  },
  {
    id: 'unreadable-inverted-window',
    markdown: doc(['type: fact', 'valid_from: 2026-12-31', 'valid_through: 2026-01-01']),
    asOf: '2026-06-15',
    expect: { state: 'unreadable', from: '2026-12-31', through: '2026-01-01', problems: ['inverted'] },
    note: 'Both bounds read fine; the pair cannot be true. The page lies either way.',
  },
  {
    id: 'empty-key-is-absent-not-unreadable',
    markdown: doc(['type: fact', 'valid_from:']),
    asOf: '2026-06-15',
    expect: { state: null },
    note: 'A key with no value IS null in YAML. Both parsers must land here.',
  },
  {
    id: 'literal-null-is-absent',
    markdown: doc(['type: fact', 'valid_from: null', 'valid_through: ~']),
    asOf: '2026-06-15',
    expect: { state: null },
    note: 'The line parser hands back the strings "null" and "~"; Obsidian hands back null. Same answer.',
  },
  {
    id: 'null-alongside-a-real-bound',
    markdown: doc(['type: fact', 'valid_from: null', 'valid_through: 2025-12-31']),
    asOf: '2026-06-15',
    expect: { state: 'no-longer-in-force', from: null, through: '2025-12-31' },
    note: 'The null bound must not become a window of its own, nor void the real one.',
  },
  {
    id: 'not-a-date-at-all',
    markdown: doc(['type: fact', 'valid_from: soon']),
    asOf: '2026-06-15',
    expect: { state: 'unreadable', from: null, through: null, problems: ['valid_from:not-iso'] },
  },
  {
    id: 'datetime-is-refused',
    markdown: doc(['type: fact', 'valid_from: 2026-01-01T10:00:00']),
    asOf: '2026-06-15',
    expect: { state: 'unreadable', from: null, through: null, problems: ['valid_from:not-iso'] },
    note: 'The granularity is the day. An instant invites timezone arithmetic nothing here does.',
  },
  {
    id: 'both-bounds-unreadable',
    markdown: doc(['type: fact', 'valid_from: hier', 'valid_through: demain']),
    asOf: '2026-06-15',
    expect: {
      state: 'unreadable',
      from: null,
      through: null,
      problems: ['valid_from:not-iso', 'valid_through:not-iso'],
    },
    note: 'Both problems are reported, in field order — a report that names one defect hides the other.',
  },
  {
    id: 'object-as-a-bound-loses-its-error',
    markdown: doc(['type: fact', 'valid_from:', '  date: 2026-01-01', 'valid_through: 2026-12-31']),
    asOf: '2026-06-15',
    expect: { state: 'in-force', from: null, through: '2026-12-31', problems: [] },
    expectYaml: { state: 'unreadable', from: null, through: '2026-12-31', problems: ['valid_from:not-a-string'] },
    note:
      'THE WORST OF THE TWO DIVERGENCES, and the reason it is written down. `valid_from` is at the '
      + 'top level here, so the convention\'s "top level only" rule does not catch it. The line parser '
      + 'turns the key into the empty string, which normalises to ABSENT, so the page reads as a clean '
      + 'open-ended window IN FORCE. A spec YAML parser hands over an object, which is `not-a-string`, '
      + 'so the same page reads as UNREADABLE. One parser produces a confident wrong state where the '
      + 'other produces an honest refusal. The helper is right both times; what is lost happens before '
      + 'it. The annotator phase must therefore preserve a non-scalar bound as non-scalar instead of '
      + 'accepting whatever the line parser flattened it into.',
  },
  {
    id: 'nested-object-hides-the-window',
    markdown: doc(['type: fact', 'validity:', '  valid_from: 2026-01-01']),
    asOf: '2026-06-15',
    expect: { state: 'in-force', from: '2026-01-01', through: null },
    expectYaml: { state: null },
    note:
      'A KNOWN DIVERGENCE, pinned rather than papered over. The router line parser flattens a '
      + 'nested block, so `valid_from` surfaces at the top level and counts; a spec YAML parser '
      + 'keeps it nested, where nothing looks. This is why the convention says "top level only", '
      + 'and why no linter can catch the mistake.',
  },
];

/** Cases where the two parsers disagree — enumerated so a test can assert the
 *  divergence is exactly the one we documented, and no wider. */
export const DIVERGENT_CASE_IDS = TEMPORAL_VALIDITY_CASES
  .filter((c) => c.expectYaml !== undefined)
  .map((c) => c.id);
