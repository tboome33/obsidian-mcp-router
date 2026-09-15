/**
 * Check R — the temporal-validity lint, and the first proof of DEPENDENCE.
 *
 * The conformance corpus shared with the helper is replayed here through the
 * LINTER's own door: pages whose frontmatter came out of the router's line
 * parser, exactly as `wiki-lint` collects them. That proves the two agree on
 * the states.
 *
 * What it does NOT prove, and what the last block of this file exists for: that
 * the linter actually CALLS the helper. Two implementations can satisfy one
 * corpus. The witness is a page whose `valid_through` IS the reference day —
 * in force, therefore silent. Break the helper's bound comparison and that
 * page starts producing an `expired` finding, here, without this file being
 * touched. A consumer that stayed green under that mutation would have its own
 * copy of the rule, and the lot would have failed at the thing it was built to
 * avoid.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULE_EXPIRED,
  RULE_INVERTED,
  RULE_NOT_YET,
  RULE_UNREADABLE,
  lintTemporalValidity,
} from '../src/helpers/temporal-validity-lint.mjs';
import { parseFrontmatter } from '../src/helpers/llms-txt-exporter.mjs';
import { TEMPORAL_VALIDITY_CASES } from './fixtures/temporal-validity-cases.mjs';

const TODAY = '2026-06-15';

/** One page, spelled the way `wiki-lint` hands them over. */
function page(path, frontmatter) {
  return { path, frontmatter };
}

function rules(findings) {
  return findings.map((f) => f.rule);
}

describe('Check R — what it reports, and what it stays silent about', () => {
  test('a page with no window produces nothing at all', () => {
    const findings = lintTemporalValidity([
      page('wiki/a.md', { type: 'concept', title: 'Untouched by time' }),
      page('wiki/b.md', {}),
      page('wiki/c.md', { valid_from: null }),
    ], { today: TODAY });
    assert.deepEqual(findings, [],
      'the check never asks for a window — it cannot know a page is regulatory');
  });

  test('a window in force is silent too', () => {
    const findings = lintTemporalValidity(
      [page('wiki/a.md', { valid_from: '2026-01-01', valid_through: '2026-12-31' })],
      { today: TODAY },
    );
    assert.deepEqual(findings, []);
  });

  test('an unreadable bound is a WARNING that names every bad bound', () => {
    const findings = lintTemporalValidity(
      [page('wiki/a.md', { valid_from: 'soon', valid_through: '01/01/2026' })],
      { today: TODAY },
    );
    assert.deepEqual(rules(findings), [RULE_UNREADABLE]);
    assert.equal(findings[0].severity, 'warning');
    assert.match(findings[0].detail, /valid_from:not-iso/);
    assert.match(findings[0].detail, /valid_through:not-iso/,
      'naming one bad bound and hiding the other sends the author back twice');
  });

  test('an inverted window is an ERROR, and a different one from an unreadable bound', () => {
    const findings = lintTemporalValidity(
      [page('wiki/a.md', { valid_from: '2026-12-31', valid_through: '2026-01-01' })],
      { today: TODAY },
    );
    assert.deepEqual(rules(findings), [RULE_INVERTED]);
    assert.equal(findings[0].severity, 'error');
    assert.match(findings[0].detail, /2026-12-31/);
    assert.match(findings[0].detail, /2026-01-01/, 'both bounds are quoted back');
  });

  test('not-yet and expired are INFO — a page describing another period is not a defect', () => {
    const findings = lintTemporalValidity([
      page('wiki/future.md', { valid_from: '2027-01-01' }),
      page('wiki/past.md', { valid_through: '2025-12-31' }),
    ], { today: TODAY });
    assert.deepEqual(rules(findings), [RULE_NOT_YET, RULE_EXPIRED]);
    assert.deepEqual(findings.map((f) => f.severity), ['info', 'info']);
    assert.match(findings[1].detail, /still knowledge/,
      'the detail must say why this is not something to delete');
  });

  test('the reference day appears in the message, so a reader can tell what it was judged against', () => {
    const findings = lintTemporalValidity(
      [page('wiki/past.md', { valid_through: '2025-12-31' })],
      { today: TODAY },
    );
    assert.match(findings[0].detail, new RegExp(TODAY));
  });

  test('every type is checked — a window is not a decision-page concept', () => {
    // Narrowing this to a list of types is the silent way to stop checking the
    // pages the feature was built for: `concept`, `fact`, `reference`.
    const types = ['concept', 'fact', 'reference', 'decision', 'decision-input', 'runbook', undefined];
    for (const type of types) {
      const findings = lintTemporalValidity(
        [page('wiki/a.md', { ...(type ? { type } : {}), valid_through: '2025-12-31' })],
        { today: TODAY },
      );
      assert.deepEqual(rules(findings), [RULE_EXPIRED], `type ${String(type)} must be checked`);
    }
  });
});

describe('Check R — the input contract, and what must never take the lint down', () => {
  test('a malformed entry is skipped, not thrown on', () => {
    const findings = lintTemporalValidity([
      null,
      'not an entry',
      { frontmatter: { valid_through: '2025-12-31' } },                    // no path
      { path: Object.create(null), frontmatter: { valid_through: '2025-12-31' } }, // path with no toString
      page('wiki/good.md', { valid_through: '2025-12-31' }),
    ], { today: TODAY });
    assert.deepEqual(findings.map((f) => f.path), ['wiki/good.md'],
      'one malformed entry must never abort a whole-vault lint');
  });

  test('pages inside a frozen copy are excluded, whole segments only', () => {
    const findings = lintTemporalValidity([
      page('.trash/old.md', { valid_through: '2025-12-31' }),
      page('wiki/.okf-rename-backup/old.md', { valid_through: '2025-12-31' }),
      page('wiki/.trash-notes/live.md', { valid_through: '2025-12-31' }),
    ], { today: TODAY });
    assert.deepEqual(findings.map((f) => f.path), ['wiki/.trash-notes/live.md'],
      'a folder merely CONTAINING a marker is a normal folder');
  });

  test('an entry with an empty path is skipped — a finding pointing at no file', () => {
    // Quieter than a crash and worse in a report: the row looks ordinary and
    // names nothing. Found in review.
    const findings = lintTemporalValidity([
      page('', { valid_through: '2025-12-31' }),
      page('   ', { valid_through: '2025-12-31' }),
      page('wiki/good.md', { valid_through: '2025-12-31' }),
    ], { today: TODAY });
    assert.deepEqual(findings.map((f) => f.path), ['wiki/good.md']);
  });

  test('a bad `today` fails the pass before any page is read', () => {
    // Same defect class the helper had: validating the argument late makes the
    // failure depend on the corpus. Here it must fail even for an empty one.
    assert.throws(() => lintTemporalValidity([], { today: 'hier' }), /asOf/);
    assert.throws(() => lintTemporalValidity([page('wiki/a.md', {})], { today: '' }), /asOf is empty/);
  });

  test('and it fails BEFORE touching the first page, not after walking them', () => {
    // Asserting only that it throws would still pass if the pages were walked
    // first and the argument validated at the end — the pages would have been
    // read for nothing, and on a large vault that is a slow failure instead of
    // an immediate one. A page whose frontmatter EXPLODES when touched turns
    // "was it read?" into something observable.
    let reads = 0;
    const booby = {
      path: 'wiki/booby-trap.md',
      get frontmatter() { reads += 1; throw new Error('this page must never be read'); },
    };
    assert.throws(() => lintTemporalValidity([booby], { today: 'hier' }), /asOf/);
    assert.equal(reads, 0, 'the argument is refused on its own terms, before any page is touched');
  });

  test('the reference day is read from the clock ONCE per pass, not once per page', () => {
    // The witness for invariant 8. A clock that advances past UTC midnight
    // between calls: read once, every page gets the same day; read per page,
    // the pages straddle two days and one report would carry two answers to
    // the same question. Nothing else in these tests could see the difference,
    // because they all pass `today` explicitly.
    const instants = [
      new Date('2026-06-15T23:59:59.000Z'),
      new Date('2026-06-16T00:00:01.000Z'),
      new Date('2026-06-16T00:00:02.000Z'),
    ];
    let call = 0;
    const clock = () => instants[Math.min(call++, instants.length - 1)];

    // Three pages that all END on 2026-06-15: in force on the 15th, expired on
    // the 16th. So the day actually used is legible in the output.
    const pages = ['a', 'b', 'c'].map((n) => page(`wiki/${n}.md`, { valid_through: '2026-06-15' }));
    const findings = lintTemporalValidity(pages, { clock });

    assert.equal(call, 1, `the clock must be read exactly once per pass, was read ${call} times`);
    assert.deepEqual(findings, [], 'on 2026-06-15 UTC every one of them is still in force');
  });

  test('an explicit `today` wins over the clock, and the clock is not consulted for a verdict', () => {
    let call = 0;
    const clock = () => { call += 1; return new Date('2030-01-01T00:00:00Z'); };
    const findings = lintTemporalValidity(
      [page('wiki/a.md', { valid_through: '2026-06-14' })],
      { today: TODAY, clock },
    );
    assert.deepEqual(rules(findings), [RULE_EXPIRED]);
    assert.match(findings[0].detail, new RegExp(TODAY), 'the day in the message is the one passed in');
  });

  test('a non-array is an empty lint, not a crash', () => {
    assert.deepEqual(lintTemporalValidity(null, { today: TODAY }), []);
    assert.deepEqual(lintTemporalValidity(undefined, { today: TODAY }), []);
  });
});

describe('the shared conformance corpus, replayed through the LINTER', () => {
  /** What each corpus state must produce here. `null` means silence. */
  const RULE_FOR_STATE = {
    null: null,
    'in-force': null,
    'not-yet-in-force': RULE_NOT_YET,
    'no-longer-in-force': RULE_EXPIRED,
    unreadable: null, // resolved case by case below: inverted vs malformed
  };

  for (const testCase of TEMPORAL_VALIDITY_CASES) {
    test(`case: ${testCase.id}`, () => {
      // NOTE ON WHAT THIS MEASURES. The corpus is replayed through the router's
      // LINE parser, which is not what feeds Check R in production — `wiki-lint`
      // collects frontmatter through a real YAML parse. For the two cases where
      // the parsers disagree, the assertion below therefore pins the line
      // parser's answer, and the block after this loop pins the one that
      // actually matters. Keeping both is the point: the divergence is a
      // property of the input pipeline, and it is written down rather than
      // averaged away.
      const { frontmatter } = parseFrontmatter(testCase.markdown);
      const findings = lintTemporalValidity([page(`wiki/${testCase.id}.md`, frontmatter)], {
        today: testCase.asOf,
      });

      const state = testCase.expect.state;
      let expected;
      if (state === 'unreadable') {
        expected = (testCase.expect.problems ?? []).includes('inverted') ? [RULE_INVERTED] : [RULE_UNREADABLE];
      } else {
        const rule = RULE_FOR_STATE[String(state)];
        expected = rule ? [rule] : [];
      }
      assert.deepEqual(rules(findings), expected, testCase.note ?? testCase.id);
    });
  }

  test('the corpus exercises all four rules AND the silence, through this consumer', () => {
    // A corpus that never reaches a rule proves nothing about it. This is the
    // denominator for the loop above.
    const seen = new Set();
    let silent = 0;
    for (const testCase of TEMPORAL_VALIDITY_CASES) {
      const { frontmatter } = parseFrontmatter(testCase.markdown);
      const findings = lintTemporalValidity([page(`wiki/${testCase.id}.md`, frontmatter)], {
        today: testCase.asOf,
      });
      if (findings.length === 0) silent += 1;
      for (const f of findings) seen.add(f.rule);
    }
    assert.deepEqual([...seen].sort(), [RULE_EXPIRED, RULE_INVERTED, RULE_NOT_YET, RULE_UNREADABLE].sort());
    assert.ok(silent >= 3, `the corpus must also exercise silence, got ${silent} silent cases`);
  });
});

describe('fed a REAL YAML parse, the two divergent pages behave correctly', () => {
  // The input contract, witnessed. `wiki-lint` collects frontmatter through
  // `get_frontmatter` / `getNote`, which parse YAML properly; the line parser
  // above is the search index's, and feeding ITS output to Check R would be a
  // defect of the caller. Review found both consequences, and both are pinned
  // here as the behaviour production must show.

  test('a bound holding a block is UNREADABLE, not a silent clean window', () => {
    // Line parser: `valid_from` collapses to '' → absent → the page reads as a
    // tidy open-ended window and Check R says nothing. A real parse hands over
    // an object, which is not a string, so the window cannot be read — and
    // invariant 2 says that must be visible.
    const findings = lintTemporalValidity(
      [page('wiki/object-bound.md', { valid_from: { date: '2026-01-01' }, valid_through: '2026-12-31' })],
      { today: TODAY },
    );
    assert.deepEqual(rules(findings), [RULE_UNREADABLE]);
    assert.match(findings[0].detail, /valid_from:not-a-string/);
  });

  test('a window nested under a parent key declares NOTHING, and is silent', () => {
    // Line parser: the nested key surfaces at the top level, so a page that
    // declared nothing would be reported as not-yet-in-force — a FALSE finding
    // on a page nobody dated. A real parse keeps it nested, where the contract
    // says nothing looks.
    const findings = lintTemporalValidity(
      [page('wiki/nested.md', { validity: { valid_from: '2027-01-01' } })],
      { today: TODAY },
    );
    assert.deepEqual(findings, [],
      'top-level only — a nested key is not a declaration, and must not produce a finding');
  });
});

describe('the dependence on the helper is OBSERVABLE from here', () => {
  test('a page whose window ENDS today is in force, therefore silent', () => {
    // THE MUTATION WITNESS. Under the helper's contract the last day is
    // included, so this page is in force and Check R says nothing. Make the
    // helper's end bound exclusive and this page becomes `no-longer-in-force`,
    // so an `expired` finding appears and this assertion fails — in the
    // consumer, without the consumer being edited. That is what "one helper,
    // and every consumer really uses it" means in practice.
    const findings = lintTemporalValidity(
      [page('wiki/ends-today.md', { valid_from: '2026-01-01', valid_through: TODAY })],
      { today: TODAY },
    );
    assert.deepEqual(findings, [],
      'the last day is included — if this fails, the helper\'s bound comparison changed under us');
  });

  test('and the mirror: the day after that window is expired', () => {
    const findings = lintTemporalValidity(
      [page('wiki/ended-yesterday.md', { valid_from: '2026-01-01', valid_through: '2026-06-14' })],
      { today: TODAY },
    );
    assert.deepEqual(rules(findings), [RULE_EXPIRED]);
  });

  test('a page STARTING today is in force, not "not yet"', () => {
    const findings = lintTemporalValidity(
      [page('wiki/starts-today.md', { valid_from: TODAY })],
      { today: TODAY },
    );
    assert.deepEqual(findings, [], 'the first day is included too');
  });
});
