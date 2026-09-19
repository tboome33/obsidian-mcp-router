/**
 * Temporal validity — the pure helper, and the shared conformance corpus.
 *
 * WHAT THESE TESTS ARE FOR. `src/helpers/temporal-validity.mjs` is meant to be
 * the ONE place that decides whether what a page says applies on a given day.
 * Three consumers will import it (the lint check, the recall hook, the search
 * annotator), and the discipline that keeps them honest is a mutation: break
 * the bound comparison here, and a witness in EACH consumer must go red. This
 * file owns the helper's own half of that — the table below is what the
 * mutation has to break — and the corpus in `fixtures/temporal-validity-cases`
 * is what the consumers will each replay through their own parser.
 *
 * TWO THINGS DELIBERATELY NOT ASSERTED HERE. First, that the three consumers
 * agree: none exists yet, and a corpus run against a single caller proves only
 * that the caller agrees with itself. Second, what Obsidian's own parser hands
 * back for these fields — that is a MEASUREMENT on a live vault, prescribed as
 * a stop-gate before the annotator phase, and no fixture can stand in for it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankStringsAndComments } from './_source-scan.mjs';

import {
  PROBLEM_INVERTED,
  PROBLEM_NOT_A_CALENDAR_DATE,
  PROBLEM_NOT_A_STRING,
  PROBLEM_NOT_ISO,
  STATE_IN_FORCE,
  STATE_NOT_YET,
  STATE_NO_LONGER,
  STATE_UNREADABLE,
  classifyValidity,
  normalizeBound,
  readWindow,
  resolveAsOf,
  windowFieldsFromFrontmatterText,
} from '../src/helpers/temporal-validity.mjs';
import { parseFrontmatter } from '../src/helpers/llms-txt-exporter.mjs';
import { TEMPORAL_VALIDITY_CASES, DIVERGENT_CASE_IDS } from './fixtures/temporal-validity-cases.mjs';
import { OBSIDIAN_ORACLE, ORACLE_CAPTURED_ON } from './fixtures/obsidian-frontmatter-oracle.mjs';

describe('normalizeBound — absent, readable, or unreadable, never a fourth thing', () => {
  test('absence has several spellings and one meaning', () => {
    const absent = [
      ['undefined', undefined],
      ['null', null],
      ['empty string (the line parser\'s answer for a valueless key)', ''],
      ['whitespace only', '   '],
      ['the string "null" (the line parser\'s answer for a literal null)', 'null'],
      ['the string "Null"', 'Null'],
      ['the string "NULL"', 'NULL'],
      ['the string "~"', '~'],
    ];
    for (const [label, value] of absent) {
      assert.deepEqual(normalizeBound(value), { absent: true }, `${label} must read as absent`);
    }
  });

  test('a four-letter word that is not YAML null is unreadable, not absent', () => {
    // `nUlL` is a string in YAML, and a string that is not a date is a typo we
    // must show. Exactly why the null spellings are matched, not lowercased.
    assert.deepEqual(normalizeBound('nUlL'), { problem: PROBLEM_NOT_ISO });
  });

  test('a readable bound comes back trimmed and unchanged', () => {
    assert.deepEqual(normalizeBound('2026-01-01'), { value: '2026-01-01' });
    assert.deepEqual(normalizeBound('  2026-01-01  '), { value: '2026-01-01' });
  });

  test('anything that is not a string is refused rather than converted', () => {
    const refused = [
      ['a Date, midnight UTC — the conversion that would shift a bound by a day', new Date('2026-01-01')],
      ['an Invalid Date, whose every accessor answers NaN', new Date('nonsense')],
      ['a number', 2026],
      ['a boolean', true],
      ['a list', ['2026-01-01']],
      ['an object', { from: '2026-01-01' }],
    ];
    for (const [label, value] of refused) {
      assert.deepEqual(normalizeBound(value), { problem: PROBLEM_NOT_A_STRING }, label);
    }
  });

  test('a string of the right shape must also be a day that exists', () => {
    assert.deepEqual(normalizeBound('2026-02-30'), { problem: PROBLEM_NOT_A_CALENDAR_DATE });
    assert.deepEqual(normalizeBound('2026-13-01'), { problem: PROBLEM_NOT_A_CALENDAR_DATE });
    assert.deepEqual(normalizeBound('2026-00-10'), { problem: PROBLEM_NOT_A_CALENDAR_DATE });
    assert.deepEqual(normalizeBound('2026-01-00'), { problem: PROBLEM_NOT_A_CALENDAR_DATE });
    assert.deepEqual(normalizeBound('2026-01-32'), { problem: PROBLEM_NOT_A_CALENDAR_DATE });
  });

  test('leap years are computed on the year written, not on a year Date.UTC invents', () => {
    assert.deepEqual(normalizeBound('2024-02-29'), { value: '2024-02-29' }, '2024 is a leap year');
    assert.deepEqual(normalizeBound('2026-02-29'), { problem: PROBLEM_NOT_A_CALENDAR_DATE });
    assert.deepEqual(normalizeBound('2000-02-29'), { value: '2000-02-29' }, 'divisible by 400');
    assert.deepEqual(normalizeBound('1900-02-29'), { problem: PROBLEM_NOT_A_CALENDAR_DATE }, 'divisible by 100, not 400');
    // Date.UTC maps a two-digit year onto the 1900s. `0026` and 1926 share the
    // same February, so those two agree BY LUCK and discriminate nothing —
    // review's point. Year 0000 is where the two calendars part: divisible by
    // 400, so it HAS a 29 February, while the 1900 it would be mapped onto does
    // not. This pair is the witness; the 0026 pair is only company.
    assert.deepEqual(normalizeBound('0000-02-29'), { value: '0000-02-29' },
      'year 0 is divisible by 400 — a check delegated to Date.UTC would map it to 1900 and refuse it');
    assert.deepEqual(normalizeBound('0100-02-29'), { problem: PROBLEM_NOT_A_CALENDAR_DATE },
      'and year 100 is not, which the same mapping would have got right for the wrong reason');
    assert.deepEqual(normalizeBound('0026-02-28'), { value: '0026-02-28' });
    assert.deepEqual(normalizeBound('0026-02-29'), { problem: PROBLEM_NOT_A_CALENDAR_DATE });
  });

  test('a malformed shape is reported as malformed, never as a wrong day', () => {
    for (const value of ['01/01/2026', '2026-1-1', '26-01-01', '2026-01-01T10:00:00', 'soon', '20260101']) {
      assert.deepEqual(normalizeBound(value), { problem: PROBLEM_NOT_ISO }, value);
    }
  });
});

describe('readWindow — a window exists, or the page said nothing', () => {
  test('no fields at all is no window', () => {
    assert.equal(readWindow({ type: 'concept' }), null);
    assert.equal(readWindow({}), null);
    assert.equal(readWindow(null), null);
    assert.equal(readWindow(undefined), null);
  });

  test('a bound that normalises to absent is still no window', () => {
    // The trap this closes: `{valid_from: null}` becoming a half-open window
    // and classifying as in-force. The window is defined on the NORMALISED
    // bounds, not on which keys happen to be present.
    assert.equal(readWindow({ valid_from: null }), null);
    assert.equal(readWindow({ valid_from: null, valid_through: null }), null);
    assert.equal(readWindow({ valid_from: '', valid_through: '~' }), null);
  });

  test('a null bound next to a real one leaves the real one standing', () => {
    assert.deepEqual(readWindow({ valid_from: null, valid_through: '2025-12-31' }), {
      from: null,
      through: '2025-12-31',
      problems: [],
    });
  });

  test('problems name the field that carried them', () => {
    assert.deepEqual(readWindow({ valid_from: 'soon' }).problems, ['valid_from:not-iso']);
    assert.deepEqual(readWindow({ valid_through: 2026 }).problems, ['valid_through:not-a-string']);
    assert.deepEqual(readWindow({ valid_from: 'soon', valid_through: 'demain' }).problems, [
      'valid_from:not-iso',
      'valid_through:not-iso',
    ], 'both are reported; naming one hides the other');
  });

  test('inversion belongs to the pair, so it carries no field prefix', () => {
    const window = readWindow({ valid_from: '2026-12-31', valid_through: '2026-01-01' });
    assert.deepEqual(window.problems, [PROBLEM_INVERTED]);
    assert.equal(window.from, '2026-12-31', 'both bounds are kept — they are readable, just incoherent');
    assert.equal(window.through, '2026-01-01');
  });

  test('equal bounds are a one-day window, not an inversion', () => {
    assert.deepEqual(readWindow({ valid_from: '2026-06-15', valid_through: '2026-06-15' }).problems, []);
  });

  test('inversion is not claimed when a bound could not be read', () => {
    // Nothing can be said about the order of a pair with one unreadable half.
    const window = readWindow({ valid_from: 'soon', valid_through: '2026-01-01' });
    assert.deepEqual(window.problems, ['valid_from:not-iso']);
  });

  test('an inherited property is not a declaration', () => {
    const hostile = Object.create({ valid_from: '2026-01-01' });
    assert.equal(readWindow(hostile), null, 'own properties only — vault JSON can carry a prototype');
  });
});

describe('classifyValidity — the four states and the silence', () => {
  const asOf = '2026-06-15';

  test('no window means no state at all', () => {
    assert.equal(classifyValidity({ type: 'fact' }, { asOf }), null);
  });

  test('a bad asOf is refused on EVERY page, window or not', () => {
    // Found by review. Resolving the day after reading the window made the
    // same mistyped argument throw on a page that declares one and pass
    // silently on a page that does not — so whether a caller learned about
    // their own typo depended on which page came first in the corpus.
    assert.throws(() => classifyValidity({ valid_from: '2026-01-01' }, { asOf: 'garbage' }), /asOf/);
    assert.throws(() => classifyValidity({ type: 'concept' }, { asOf: 'garbage' }), /asOf/,
      'a page with no window must refuse the same argument, not return null');
    assert.throws(() => classifyValidity({}, { asOf: '' }), /asOf is empty/);
  });

  test('each state has its witness', () => {
    assert.equal(classifyValidity({ valid_from: '2027-01-01' }, { asOf }).state, STATE_NOT_YET);
    assert.equal(classifyValidity({ valid_from: '2020-01-01' }, { asOf }).state, STATE_IN_FORCE);
    assert.equal(classifyValidity({ valid_through: '2025-12-31' }, { asOf }).state, STATE_NO_LONGER);
    assert.equal(classifyValidity({ valid_from: 'soon' }, { asOf }).state, STATE_UNREADABLE);
  });

  test('an absent bound leaves its side open', () => {
    assert.equal(classifyValidity({ valid_from: '2020-01-01' }, { asOf: '2999-01-01' }).state, STATE_IN_FORCE);
    assert.equal(classifyValidity({ valid_through: '2999-01-01' }, { asOf: '1900-01-01' }).state, STATE_IN_FORCE);
  });

  describe('the bounds are INCLUDED — the four witnesses a mutation must break', () => {
    const window = { valid_from: '2026-01-01', valid_through: '2026-12-31' };

    test('the last day is still in force', () => {
      assert.equal(classifyValidity(window, { asOf: '2026-12-31' }).state, STATE_IN_FORCE);
    });
    test('the day after the last day is not', () => {
      assert.equal(classifyValidity(window, { asOf: '2027-01-01' }).state, STATE_NO_LONGER);
    });
    test('the first day is already in force', () => {
      assert.equal(classifyValidity(window, { asOf: '2026-01-01' }).state, STATE_IN_FORCE);
    });
    test('the day before the first day is not yet', () => {
      assert.equal(classifyValidity(window, { asOf: '2025-12-31' }).state, STATE_NOT_YET);
    });
  });

  test('unreadable outranks the dates, and says why', () => {
    // A window that cannot be read must never be reported as in force, however
    // the readable half happens to fall around the reference day.
    const result = classifyValidity({ valid_from: '2020-01-01', valid_through: 'demain' }, { asOf });
    assert.equal(result.state, STATE_UNREADABLE);
    assert.deepEqual(result.problems, ['valid_through:not-iso']);
  });

  test('an inverted window is unreadable, not a state derived from its bounds', () => {
    const result = classifyValidity({ valid_from: '2026-12-31', valid_through: '2026-01-01' }, { asOf });
    assert.equal(result.state, STATE_UNREADABLE);
    assert.deepEqual(result.problems, [PROBLEM_INVERTED]);
  });

  test('the reference day travels in the result', () => {
    assert.equal(classifyValidity({ valid_from: '2020-01-01' }, { asOf }).asOf, asOf);
  });

  test('a clean window carries an empty problems list, not an absent one', () => {
    assert.deepEqual(classifyValidity({ valid_from: '2020-01-01' }, { asOf }).problems, []);
  });
});

describe('resolveAsOf — one day per operation, in UTC, and never a silent fallback', () => {
  test('an explicit day is taken as given', () => {
    assert.equal(resolveAsOf('2026-03-01'), '2026-03-01');
    assert.equal(resolveAsOf('  2026-03-01 '), '2026-03-01');
  });

  test('absence means the UTC day of the instant, hand-computed', () => {
    assert.equal(resolveAsOf(undefined, new Date('2026-01-01T23:30:00Z')), '2026-01-01');
    assert.equal(resolveAsOf(null, new Date('2026-01-02T00:30:00Z')), '2026-01-02');
  });

  test('an unreadable asOf throws — a mistyped historical question is not answered with today', () => {
    for (const bad of ['01/03/2026', 'yesterday', '2026-02-30', 2026, new Date()]) {
      assert.throws(() => resolveAsOf(bad), /asOf/, JSON.stringify(String(bad)));
    }
  });

  test('an explicitly EMPTY asOf throws too, rather than meaning today', () => {
    // `asOf: ""` reaching a tool is a caller defect. Treating it as "today"
    // would answer a question nobody asked and say nothing about it.
    assert.throws(() => resolveAsOf(''), /asOf is empty/);
    assert.throws(() => resolveAsOf('   '), /asOf is empty/);
  });

  test('an unusable clock is refused rather than producing a NaN day', () => {
    assert.throws(() => resolveAsOf(undefined, new Date('nonsense')), /valid Date/);
    assert.throws(() => resolveAsOf(undefined, '2026-01-01'), /valid Date/);
  });

  test('a clock outside the four-digit years is refused, not truncated', () => {
    // Found by review: `toISOString` widens to `+010000-01-01T…`, so slicing
    // ten characters returns `+010000-01` — a string of the wrong width that
    // every downstream comparison would treat as a day.
    assert.throws(() => resolveAsOf(undefined, new Date('+010000-01-01T00:00:00Z')), /not a YYYY-MM-DD day/);
    assert.throws(() => resolveAsOf(undefined, new Date('-000001-01-01T00:00:00Z')), /not a YYYY-MM-DD day/);
  });

  /**
   * The witness that makes "UTC, not the host's local day" OBSERVABLE.
   *
   * On a host running in UTC the two readings are identical, so no instant can
   * tell them apart — which is exactly the case on the CI runners. The day is
   * therefore computed in a CHILD PROCESS with TZ forced to a zone far from
   * UTC, at an instant where the local day and the UTC day differ.
   *
   * MEASURED, not assumed: Node honours TZ here, but the bash `TZ=x node`
   * prefix does NOT reach the process on this Windows host (`process.env.TZ`
   * came back undefined). Passing an explicit `env` is what works, on every
   * platform.
   */
  const tzCases = [
    ['Pacific/Kiritimati', 'UTC+14', '2026-01-01T22:30:00Z', '2026-01-01', 2],
    ['Pacific/Honolulu', 'UTC-10', '2026-01-02T02:30:00Z', '2026-01-02', 1],
  ];
  for (const [tz, label, instant, expectedUtcDay, expectedLocalDay] of tzCases) {
    test(`in ${tz} (${label}) the day is UTC's, not the host's`, () => {
      const code = `
        import { resolveAsOf } from ${JSON.stringify(new URL('../src/helpers/temporal-validity.mjs', import.meta.url).href)};
        const now = new Date(${JSON.stringify(instant)});
        process.stdout.write(JSON.stringify({
          resolved: resolveAsOf(undefined, now),
          localDay: now.getDate(),
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }));
      `;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      const out = JSON.parse(run.stdout);

      // The denominator: if the child did not actually adopt the zone, the two
      // readings coincide and this test would pass without measuring anything.
      assert.equal(out.zone, tz, 'the child process must have adopted the forced timezone');
      assert.equal(out.localDay, expectedLocalDay,
        'the instant must be one where the local day and the UTC day differ');
      assert.equal(out.resolved, expectedUtcDay);
    });
  }
});

describe('the shared conformance corpus, replayed through the router line parser', () => {
  test('the corpus is not empty and every case is distinctly named', () => {
    assert.ok(TEMPORAL_VALIDITY_CASES.length >= 20,
      `the corpus must cover the contract, has ${TEMPORAL_VALIDITY_CASES.length} cases`);
    const ids = TEMPORAL_VALIDITY_CASES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every state, including the silence, is represented', () => {
    const states = new Set(TEMPORAL_VALIDITY_CASES.map((c) => c.expect.state));
    for (const state of [null, STATE_IN_FORCE, STATE_NOT_YET, STATE_NO_LONGER, STATE_UNREADABLE]) {
      assert.ok(states.has(state), `the corpus must exercise ${state === null ? 'no-window' : state}`);
    }
  });

  for (const testCase of TEMPORAL_VALIDITY_CASES) {
    test(`case: ${testCase.id}`, () => {
      const { frontmatter } = parseFrontmatter(testCase.markdown);
      const result = classifyValidity(frontmatter, { asOf: testCase.asOf });

      if (testCase.expect.state === null) {
        assert.equal(result, null, testCase.note ?? 'expected no window');
        return;
      }

      assert.notEqual(result, null, 'expected a window');
      assert.equal(result.state, testCase.expect.state, testCase.note ?? testCase.id);
      if ('from' in testCase.expect) assert.equal(result.from, testCase.expect.from);
      if ('through' in testCase.expect) assert.equal(result.through, testCase.expect.through);
      if ('problems' in testCase.expect) assert.deepEqual(result.problems, testCase.expect.problems);
      assert.equal(result.asOf, testCase.asOf);
    });
  }

  test('the DECLARED divergences are the two flattening traps, and no others', () => {
    // Honest about what this asserts, after review pointed out the first
    // version claimed more than it measured: `DIVERGENT_CASE_IDS` is derived
    // from the fixture's own `expectYaml`, so this pins the set we DECLARED,
    // not the set that genuinely diverges. Comparing the two parsers for real
    // needs Obsidian's, which arrives with the annotator phase — the fixture
    // exists precisely so that comparison has something to run against. What
    // this does catch is the realistic mistake: adding a divergent case and
    // forgetting to say so, or removing one silently.
    assert.deepEqual(DIVERGENT_CASE_IDS, [
      'object-as-a-bound-loses-its-error',
      'nested-object-hides-the-window',
    ]);
  });

  test('both divergences are real ON THIS SIDE — the line parser flattens, and it is measurable', () => {
    // The YAML half of each pair is a declared expectation. The LINE PARSER
    // half is measured right here, which is what makes the pair worth writing.
    const nested = TEMPORAL_VALIDITY_CASES.find((c) => c.id === 'nested-object-hides-the-window');
    const nestedFm = parseFrontmatter(nested.markdown).frontmatter;
    assert.equal(nestedFm.valid_from, '2026-01-01',
      'the nested key is LIFTED to the top level, so a window appears where YAML sees none');
    assert.equal(classifyValidity(nestedFm, { asOf: nested.asOf }).state, nested.expect.state);

    const objectBound = TEMPORAL_VALIDITY_CASES.find((c) => c.id === 'object-as-a-bound-loses-its-error');
    const objectFm = parseFrontmatter(objectBound.markdown).frontmatter;
    assert.equal(objectFm.valid_from, '',
      'a bound holding a block becomes the EMPTY STRING, which normalises to absent');
    assert.equal(classifyValidity(objectFm, { asOf: objectBound.asOf }).state, 'in-force');
    // And the same page, as a spec parser would hand it over: an object bound
    // is not a string, so the window is unreadable. Same helper, same page,
    // opposite verdicts — the loss happens before the helper, and the
    // annotator phase is where it has to be stopped.
    assert.equal(
      classifyValidity({ valid_from: { date: '2026-01-01' }, valid_through: '2026-12-31' }, { asOf: objectBound.asOf }).state,
      'unreadable',
    );
  });
});

// ---------------------------------------------------------------------------
describe('THE THIRD DOOR, against Obsidian — the comparison this corpus was built for', () => {
  // The corpus pins `parseFrontmatter` (`expect`) and declares what a spec YAML
  // parser would say on two shapes (`expectYaml`). It never ran
  // `windowFieldsFromFrontmatterText` — the raw-text reader the recall hook
  // uses — against any of it, and the neighbouring test says why: "comparing
  // the two parsers for real needs Obsidian's".
  //
  // `obsidian-frontmatter-oracle.mjs` is that capture, measured from a live
  // vault. These tests are what it was captured for.

  /** What Obsidian saw, judged by the same helper every door is judged by. */
  const obsidianVerdict = (testCase) => {
    const fm = OBSIDIAN_ORACLE[testCase.id];
    assert.ok(fm !== undefined, `no oracle entry for ${testCase.id} — re-capture the fixture`);
    return classifyValidity(fm, { asOf: testCase.asOf });
  };

  /**
   * What the raw reader says, with its third outcome kept distinct.
   *
   * `classifyValidity` answers `null` for "this page declares no window", so a
   * verdict is `null | {state,…} | {refused:[…]}` — three shapes, and the null
   * is why every reader of this value has to check it before touching a field.
   */
  const rawVerdict = (testCase) => {
    const { fields, undetermined } = windowFieldsFromFrontmatterText(testCase.markdown);
    if (undetermined.length > 0) return { refused: undetermined };
    return classifyValidity(fields, { asOf: testCase.asOf });
  };
  const isRefusal = (verdict) => verdict !== null && Array.isArray(verdict.refused);

  test('the oracle covers the corpus exactly — no case unmeasured, no entry orphaned', () => {
    const corpusIds = TEMPORAL_VALIDITY_CASES.map((c) => c.id).sort();
    const oracleIds = Object.keys(OBSIDIAN_ORACLE).sort();
    assert.deepEqual(oracleIds, corpusIds,
      'add a case and the oracle must be re-captured, or the comparison below silently skips it');
    assert.match(ORACLE_CAPTURED_ON, /^\d{4}-\d{2}-\d{2}$/);
  });

  for (const testCase of TEMPORAL_VALIDITY_CASES) {
    test(`raw reader vs Obsidian: ${testCase.id}`, () => {
      const obsidian = obsidianVerdict(testCase);
      const raw = rawVerdict(testCase);

      // REFUSING IS ALWAYS ALLOWED. The reader's third outcome exists so it can
      // decline a shape it does not decode, and a declined field is reported,
      // never silently dropped. That is the safe direction and it is the ONLY
      // disagreement this test accepts.
      if (isRefusal(raw)) return;

      if (obsidian === null) {
        assert.equal(raw, null,
          `${testCase.id}: Obsidian sees no window here, so claiming one would be a window nobody declared (invariant 1)`);
        return;
      }

      assert.notEqual(raw, null,
        `${testCase.id}: Obsidian sees a bound and the reader is SILENT — an unreadable window reported as absent is invariant 2`);
      assert.equal(raw.state, obsidian.state, `${testCase.id}: state`);
      assert.equal(raw.from, obsidian.from, `${testCase.id}: from`);
      assert.equal(raw.through, obsidian.through, `${testCase.id}: through`);
    });
  }

  test('and the reader refuses at most where it has to — a refusal is a cost, not a free pass', () => {
    // Without this, "refusing is always allowed" would let a reader that
    // refuses EVERYTHING pass every case above. The corpus is 23 ordinary
    // shapes; one of them is genuinely undecidable for a line reader.
    const refused = TEMPORAL_VALIDITY_CASES.filter((c) => isRefusal(rawVerdict(c)));
    assert.deepEqual(refused.map((c) => c.id), ['object-as-a-bound-loses-its-error'],
      'the raw reader declines exactly one corpus shape; a change here is a behaviour change to argue for');
  });

  test('the DECLARED divergences are the ones Obsidian actually produces', () => {
    // `expectYaml` was a prediction — the corpus said so. Measured against a
    // live Obsidian, it holds on both cases, and the line parser is the door
    // that is wrong on both.
    const disagreeing = TEMPORAL_VALIDITY_CASES.filter((c) => {
      const line = classifyValidity(parseFrontmatter(c.markdown).frontmatter, { asOf: c.asOf });
      const obsidian = obsidianVerdict(c);
      if (line === null || obsidian === null) return line !== obsidian;
      return line.state !== obsidian.state || line.from !== obsidian.from || line.through !== obsidian.through;
    }).map((c) => c.id);

    assert.deepEqual(disagreeing, DIVERGENT_CASE_IDS,
      'the line parser disagrees with Obsidian on exactly the shapes the corpus declared, and no others');
  });

  test('on both of those, the RAW reader is the one that does not mislead', () => {
    // The point of the whole comparison, stated once: where the line parser
    // reports a confident wrong state, the raw reader either declines or stays
    // silent — and Obsidian says it is right to.
    const objectBound = TEMPORAL_VALIDITY_CASES.find((c) => c.id === 'object-as-a-bound-loses-its-error');
    assert.equal(classifyValidity(parseFrontmatter(objectBound.markdown).frontmatter, { asOf: objectBound.asOf }).state,
      'in-force', 'the line parser is confidently wrong here');
    assert.equal(obsidianVerdict(objectBound).state, 'unreadable', 'Obsidian calls it unreadable');
    assert.deepEqual(rawVerdict(objectBound).refused, ['valid_from'], 'and the raw reader declines it by name');

    const nested = TEMPORAL_VALIDITY_CASES.find((c) => c.id === 'nested-object-hides-the-window');
    assert.equal(classifyValidity(parseFrontmatter(nested.markdown).frontmatter, { asOf: nested.asOf }).state,
      'in-force', 'the line parser invents a window from a nested key');
    assert.equal(obsidianVerdict(nested), null, 'Obsidian sees nothing at the top level');
    assert.equal(rawVerdict(nested), null, 'and neither does the raw reader');
  });
});

describe('windowFieldsFromFrontmatterText — three outcomes, and it says which', () => {
  const BOM = String.fromCharCode(0xfeff);
  const BACKSLASH = String.fromCharCode(92);

  /**
   * What the reader concluded, in one word:
   *   'undetermined' — it met a shape it will not interpret
   *   null           — the page declares no window, and it is sure
   *   a state        — it read a window, classified at the reference day
   */
  function verdict(text) {
    const { fields, undetermined } = windowFieldsFromFrontmatterText(text);
    if (undetermined.length > 0) return 'undetermined';
    const result = classifyValidity(fields, { asOf: '2026-06-15' });
    return result === null ? null : result.state;
  }

  describe('the one shape it does read', () => {
    test('a plain scalar on the key\'s own line', () => {
      assert.equal(verdict('---\nvalid_from: 2026-01-01\nvalid_through: 2026-12-31\n---\nbody'), STATE_IN_FORCE);
      assert.equal(verdict('---\nvalid_through: 2025-12-31\n---\nbody'), STATE_NO_LONGER);
      assert.equal(verdict('---\nvalid_from: 2027-01-01\n---\nbody'), STATE_NOT_YET);
    });

    test('quoted, either style, with an optional trailing comment', () => {
      assert.equal(verdict('---\nvalid_through: "2025-12-31"\n---\nbody'), STATE_NO_LONGER);
      assert.equal(verdict("---\nvalid_through: '2025-12-31'\n---\nbody"), STATE_NO_LONGER);
      assert.equal(verdict('---\nvalid_from: 2026-01-01 # entrée en vigueur\n---\nbody'), STATE_IN_FORCE);
      assert.equal(verdict('---\nvalid_through: "2025-12-31" # fin de grille\n---\nbody'), STATE_NO_LONGER);
    });

    test('and a date the AUTHOR got wrong is still the author\'s mistake, not ours', () => {
      // The distinction `undetermined` must never swallow: this shape IS read,
      // and what it contains is not a date.
      assert.equal(verdict('---\nvalid_from: 01/01/2026\n---\nbody'), STATE_UNREADABLE);
      assert.equal(verdict('---\nvalid_from: 2026-02-30\n---\nbody'), STATE_UNREADABLE);
      assert.equal(verdict('---\nvalid_from: 2026-01-01#x\n---\nbody'), STATE_UNREADABLE,
        'a hash with no space before it is part of the value, as YAML says');
    });
  });

  describe('what it is SURE declares nothing', () => {
    test('no such key', () => {
      assert.equal(verdict('---\ntype: fact\n---\nbody'), null);
      assert.equal(verdict('# Just a page\n\nBody.\n'), null);
    });

    test('a key nested under a parent — the flattening trap, in the safe direction', () => {
      assert.equal(verdict('---\nvalidity:\n  valid_from: 2027-01-01\n---\nbody'), null);
    });

    test('an empty key, with or without a comment', () => {
      assert.equal(verdict('---\nvalid_from:\n---\nbody'), null);
      assert.equal(verdict('---\nvalid_from: # à définir\n---\nbody'), null);
      assert.equal(verdict('---\nvalid_from:\ntype: fact\n---\nbody'), null);
    });

    test('a field name in the BODY is not a declaration', () => {
      assert.equal(verdict('---\ntype: fact\n---\n\nvalid_through: 2025-12-31 in the prose\n'), null);
    });
  });

  describe('what it REFUSES to interpret — the six shapes review found, and their kin', () => {
    // Each of these was a wrong verdict before the reader stopped guessing.
    // Undetermined is not a lesser answer here: it is the only true one.
    const refused = [
      ['a bound holding a block', '---\nvalid_from:\n  date: 2026-01-01\n---\nbody'],
      ['a bound holding an indented list', '---\nvalid_from:\n  - 2026-01-01\n---\nbody'],
      ['a bound holding a list at the key\'s own column', '---\nvalid_from:\n- 2026-01-01\n---\nbody'],
      ['a block scalar', '---\nvalid_from: |-\n  2027-01-01\n---\nbody'],
      ['a folded continuation line', '---\nvalid_from: 2027-01-01\n  suffixe\n---\nbody'],
      // (`a quoted key` used to live here. It was moved out, not silently
      //  dropped — see "quoting a key does not change which key it is" below.)
      ['an unterminated quote on the bound itself', '---\nvalid_from: "2026-01-01\n---\nbody'],
      ['an escape inside a double-quoted scalar', `---\nvalid_from: "2027${BACKSLASH}u002D01-01"\n---\nbody`],
      ['a repeated key', '---\nvalid_from: illisible\nvalid_from:\n---\nbody'],
      ['a frontmatter that never closes', '---\nvalid_from: 2027-01-01'],
    ];
    for (const [label, text] of refused) {
      test(label, () => {
        assert.equal(verdict(text), 'undetermined');
      });
    }

    test('quoting a key does not change which key it is', () => {
      // A DELIBERATE BEHAVIOUR CHANGE, and the measurement is why. This shape
      // was in the refused list above until the shape grid put 225 assemblies
      // through Obsidian and showed that `"valid_from": 2026-01-01` produces
      // exactly the frontmatter the plain spelling does. Refusing it raised
      // "this window cannot be read" on a page that is perfectly well formed —
      // a false alarm on the one signal this lot exists to make trustworthy.
      const dq = String.fromCharCode(34);
      const sq = String.fromCharCode(39);
      assert.equal(verdict(`---\n${dq}valid_from${dq}: 2027-01-01\n---\nbody`), STATE_NOT_YET);
      assert.equal(verdict(`---\n${sq}valid_from${sq}: 2027-01-01\n---\nbody`), STATE_NOT_YET);
      assert.equal(verdict(`---\n${dq}valid_through${dq}: 2025-12-31\n---\nbody`), STATE_NO_LONGER);
    });

    test('but an ESCAPED key is still refused, and that is what makes the decode safe', () => {
      // `"valid_from"` names `valid_from` without spelling it. The quotes
      // can only be dropped because this case is declined FIRST — otherwise a
      // reader that unquoted blindly would file it as a foreign property and
      // let a declared bound disappear.
      const dq = String.fromCharCode(34);
      const bs = String.fromCharCode(92);
      assert.equal(verdict(`---\n${dq}valid_${bs}u0066rom${dq}: 2027-01-01\n---\nbody`), 'undetermined');
    });

    test('and a quoted key still counts for the REPEATED-key rule', () => {
      // Two spellings of one key is a document a YAML loader rejects. Decoding
      // the quoted form would have been a way to smuggle a duplicate past the
      // check that exists to catch it.
      const dq = String.fromCharCode(34);
      assert.equal(
        verdict(`---\nvalid_from: 2026-01-01\n${dq}valid_from${dq}: 2027-01-01\n---\nbody`),
        'undetermined',
      );
    });

    test('and the field is absent from `fields`, so a caller cannot mistake it for a silent page', () => {
      const { fields, undetermined } = windowFieldsFromFrontmatterText('---\nvalid_from: |-\n  2027-01-01\n---\nbody');
      assert.deepEqual(undetermined, ['valid_from']);
      assert.equal(Object.prototype.hasOwnProperty.call(fields, 'valid_from'), false);
    });

    // A COMMENT IS NOT A VALUE, AND DOES NOT END ONE. The reader looked at the
    // very next line and stopped there, so anything standing between a key and
    // its real value hid that value — and a window nobody can read became a
    // page that had said nothing, which is the exact confusion invariant 2
    // forbids. Found by the adversarial review of 2026-09-16.
    const interposed = [
      ['a comment between a key and its block', '---\nvalid_from:\n# commentaire\n  - 2026-01-01\n---\nbody'],
      ['a comment between a key and its indented value', '---\nvalid_from:\n# commentaire\n  2026-01-01\n---\nbody'],
      ['a blank line between a key and its block', '---\nvalid_from:\n\n  - 2026-01-01\n---\nbody'],
      ['a comment AND a blank line', '---\nvalid_from:\n\n# commentaire\n\n  - 2026-01-01\n---\nbody'],
      // An INDENTED comment reaches the same verdict without the skip rule,
      // because an indented `#` is indistinguishable from an indented value to
      // the continuation test. Kept as a behaviour case, declared in the
      // mutation harness as one that cannot witness the skip — a green test
      // that cannot see the rule it sits next to is worse than no test, unless
      // it says so.
      ['an indented comment', '---\nvalid_from:\n  # commentaire\n  - 2026-01-01\n---\nbody'],
      ['a blank line before a folded continuation', '---\nvalid_from: 2026-01-01\n\n  suite\n---\nbody'],
      ['a comment before a folded continuation', '---\nvalid_from: 2026-01-01\n# commentaire\n  suite\n---\nbody'],
    ];
    for (const [label, text] of interposed) {
      test(label, () => {
        assert.equal(verdict(text), 'undetermined');
      });
    }

    // YAML SHAPES THE SCAN CANNOT SEE. Both are valid YAML carrying a bound,
    // and both used to yield `{fields: {}, undetermined: []}` — "no window, and
    // I am sure", about a page that declares one. Found by the round-2 review.
    const invisible = [
      ['an explicit key', '---\n? valid_from\n: pas-une-date\n---\nbody'],
      ['an explicit key carrying a real date', '---\n? valid_from\n: 2020-01-01\n---\nbody'],
      ['a document-level flow mapping', '---\n{"valid_from": "pas-une-date"}\n---\nbody'],
      ['a flow mapping with a real date', '---\n{valid_from: 2020-01-01}\n---\nbody'],
      ['a plain key AND an explicit one — the duplicate that went unreported',
        '---\nvalid_from: 2020-01-01\n? valid_from\n: pas-une-date\n---\nbody'],
    ];
    for (const [label, text] of invisible) {
      test(label, () => {
        assert.equal(verdict(text), 'undetermined');
      });
    }

    // ROUND 3: the first version of this guard was a SEPARATE pre-scan, with its
    // own idea of what a line is. It missed every shape that was not at column
    // zero, and it flagged text that was plainly inside a scalar. The detection
    // now rides in the main loop, which already knows where scalars begin and
    // end, so both directions are fixed by the same move.
    const escaped = [
      ['an INDENTED flow mapping', '---\n  {valid_from: pas-une-date}\n---\nbody'],
      ['a flow mapping behind an anchor', '---\n&window {valid_from: pas-une-date}\n---\nbody'],
      ['a flow sequence', '---\n  [valid_from, pas-une-date]\n---\nbody'],
      ['an indented explicit key', '---\n  ? valid_from\n  : pas-une-date\n---\nbody'],
    ];
    for (const [label, text] of escaped) {
      test(label, () => {
        assert.equal(verdict(text), 'undetermined');
      });
    }

    test('but a `?` inside a BLOCK SCALAR is text, and the real bound survives', () => {
      // The other direction, and it cost a readable bound: the pre-scan saw the
      // `?` in the title's block and refused the whole document, losing a plain
      // `valid_through` two lines down.
      assert.equal(
        verdict('---\ntitle: |\n  ? valid_from est expliqué ici\nvalid_through: 2025-12-31\n---\nbody'),
        STATE_NO_LONGER,
      );
    });

    test('and a page with only that block, and no bound, still declares nothing', () => {
      assert.equal(verdict('---\ntitle: |\n  ? valid_from est expliqué ici\n---\nbody'), null);
    });

    test('a flow mapping inside a block scalar is text too', () => {
      assert.equal(
        verdict('---\nexemple: |\n  {valid_from: 2020-01-01}\nvalid_through: 2025-12-31\n---\nbody'),
        STATE_NO_LONGER,
      );
    });

    test('and the refusal names BOTH fields, because neither was understood', () => {
      const { fields, undetermined } = windowFieldsFromFrontmatterText(
        '---\nvalid_from: 2020-01-01\n? valid_through\n: pas-une-date\n---\nbody',
      );
      assert.deepEqual(undetermined, ['valid_from', 'valid_through']);
      assert.deepEqual(fields, {}, 'the plain key is not kept either — the document was not read');
    });

    // ROUND 4 RETIRED THE TEXT TEST. Round 3 only refused these shapes when the
    // block literally contained `valid_from` or `valid_through`, and that was
    // wrong in BOTH directions: a JSON-escaped key declares a bound without
    // spelling it, and a page whose title happens to BE that string declares
    // nothing. A root shape this reader cannot decode means it cannot conclude,
    // whatever the characters say — which retires the whole class.
    test('a JSON-escaped key declares a bound without spelling it', () => {
      const escapedKey = `{"valid_${String.fromCharCode(92)}u0066rom": "pas-une-date"}`;
      assert.equal(JSON.parse(escapedKey).valid_from, 'pas-une-date', 'the fixture really is that key');
      assert.equal(verdict(`---\n${escapedKey}\n---\nbody`), 'undetermined');
    });

    test('and a root shape we cannot read is refused even with no bound in sight', () => {
      // The cost of dropping the text test, stated rather than hidden: a root
      // flow mapping or explicit key is now always undetermined. It is the
      // honest answer — we did not read the document — and Obsidian writes
      // block style, so no page of the fleet is in this shape.
      assert.equal(verdict('---\n{"autre": "valeur"}\n---\nbody'), 'undetermined');
      assert.equal(verdict('---\n? autre_cle\n: valeur\ntype: decision\n---\nbody'), 'undetermined');
    });

    test('`:` is only a separator when something follows it', () => {
      // Round 6. `valid_from:2020-01-01` is a plain SCALAR in YAML — one
      // string, no mapping, no key — and reading it as a declaration invented a
      // window on a page that declares none. Invariant 1.
      assert.equal(verdict('---\nvalid_from:2020-01-01\n---\nbody'), 'undetermined');
    });

    test('and a colon that is NOT a separator belongs to the key', () => {
      // `valid_from:prefix: valeur` is a mapping whose key is
      // `valid_from:prefix` — a foreign property. The page declares no bound,
      // and saying so is correct: the refusal above must not spill onto keys
      // that merely start with the same letters.
      assert.equal(verdict('---\nvalid_from:prefix: valeur\ntitle: X\n---\nbody'), null);
    });

    test('a NON-BREAKING space does not open a comment', () => {
      // Round 6. YAML's white space is the ASCII space and the tab; JavaScript's
      // `\s` also matches U+00A0 and a dozen others. The value was cut at the
      // NBSP and announced as the certain date `2025-12-31`, when the real
      // value is a string that is not a date — an unreadable bound reported as
      // an expiry. Invariant 2.
      const nbsp = String.fromCharCode(160);
      assert.equal(
        verdict(`---\nvalid_through: 2025-12-31${nbsp}#citation\n---\nbody`),
        STATE_UNREADABLE,
      );
    });

    test('but an ordinary space still does', () => {
      // The control: cutting at ` #` is the rule, and narrowing the character
      // class must not have removed it.
      assert.equal(verdict('---\nvalid_through: 2025-12-31 # note\n---\nbody'), STATE_NO_LONGER);
      assert.equal(verdict('---\nvalid_through: 2025-12-31\t# note\n---\nbody'), STATE_NO_LONGER);
      // And a `#` with nothing before it is part of the value, as it always was.
      assert.equal(verdict('---\nvalid_through: 2025-12-31#note\n---\nbody'), STATE_UNREADABLE);
    });

    test('a doubled apostrophe is an escape, not the end of the key', () => {
      // Round 6. `'l''exemple':` is one ordinary key. Treating the second quote
      // as a terminator made the line unrecognisable, so the document was
      // refused and a perfectly readable bound below it went with it.
      const sq = String.fromCharCode(39);
      assert.equal(
        verdict(`---\n${sq}l${sq}${sq}exemple${sq}: documentation\nvalid_through: 2025-12-31\n---\nbody`),
        STATE_NO_LONGER,
      );
    });

    test('a sequence at column zero is still the value of the key above it', () => {
      // Round 6. YAML lets a block sequence sit at its parent's indentation, so
      // `tags:` followed by `- documentation` is an ordinary mapping. The
      // positive contract refused it as a foreign root node and threw away the
      // bound two lines down.
      assert.equal(
        verdict('---\ntags:\n- documentation\n- autre\nvalid_through: 2025-12-31\n---\nbody'),
        STATE_NO_LONGER,
      );
    });

    test('a NON-BREAKING space is not trimmed away either', () => {
      // Round 7, and it is the other half of round 6's repair. Narrowing the
      // COMMENT separator to `[ \t]#` while `trim()` right beside it went on
      // eating U+00A0 meant `valid_from: <NBSP>#citation` came back as an EMPTY
      // value — the page reported as declaring nothing, about a bound nobody
      // can read. Half a repair is how a defect survives its own fix.
      const nbsp = String.fromCharCode(160);
      assert.equal(
        verdict(`---\nvalid_from: ${nbsp}#citation\nvalid_through: 2025-12-31\n---\nbody`),
        STATE_UNREADABLE,
      );
      // And a continuation made of one non-breaking space is CONTENT, so the
      // date above it is not whole.
      assert.equal(
        verdict(`---\nvalid_through: 2025-12-31\n  ${nbsp}#citation\ntitle: x\n---\nbody`),
        'undetermined',
      );
    });

    test('a sequence after a key that ALREADY has a value is not its value', () => {
      // Round 7. `sawRootKey` said "some key came before", which is not the
      // same claim as "the key above is still waiting": after
      // `valid_through: 2025-12-31`, a `- documentation` line cannot be a second
      // value for it. That document mixes a mapping entry and a sequence entry
      // at one level, and it was answered with a certain expiry.
      assert.equal(
        verdict('---\nvalid_through: 2025-12-31\n- documentation\n---\nbody'),
        'undetermined',
      );
    });

    test('an UNTERMINATED block is unreadable whatever its keys look like', () => {
      // Round 7. This branch kept the text predicate that round 4 retired from
      // the main scan: a bound written with a quoted, escaped or flow key
      // inside a block that never closes was answered with "no window, and I am
      // sure". An opening with no closing is unreadable, full stop.
      const dq = String.fromCharCode(34);
      assert.equal(verdict('---\nvalid_from: 2020-01-01'), 'undetermined');
      assert.equal(verdict(`---\n${dq}valid_from${dq}: 2020-01-01`), 'undetermined');
      assert.equal(verdict('---\n{valid_from: 2020-01-01}'), 'undetermined');
      assert.equal(verdict('---\ntitle: X\n'), 'undetermined', 'even with no bound in sight');
    });

    test('but text that never opens a fence simply has no frontmatter', () => {
      // The control, and the line the repair must not cross: widening the
      // unterminated case to every document would mark every plain note
      // unreadable.
      assert.equal(verdict('du texte sans frontmatter\n'), null);
      assert.equal(verdict(''), null);
    });

    test('a ROOT SEQUENCE is refused, not mistaken for a key named `- valid_from`', () => {
      // The indicator exclusions in the plain-key pattern earn their keep here:
      // without them `- valid_from: 2020-01-01` matches as a key literally
      // called `- valid_from`, which is not a bound, so the page would be
      // reported as declaring nothing while it declares one.
      assert.equal(verdict('---\n- valid_from: 2020-01-01\n---\nbody'), 'undetermined');
      assert.equal(verdict('---\n- a\n- b\n---\nbody'), 'undetermined');
    });

    test('an indented ROOT mapping is refused, not read as a page without a window', () => {
      // Round 5. A column-zero scan sees NOTHING in an indented document, and
      // answered "no window, and I am sure" about a page whose first line is
      // `  valid_from: …`. There is no parent here — an indented document is
      // still the document.
      assert.equal(verdict('---\n  valid_from: pas-une-date\n---\nbody'), 'undetermined');
      assert.equal(verdict('---\n  valid_from: 2020-01-01\n  title: X\n---\nbody'), 'undetermined');
    });

    test('an escaped key in BLOCK style is refused, not skipped as a foreign one', () => {
      // The flow-mapping repair of round 4 closed one representation of this;
      // the same key written as an ordinary block property escaped it, and the
      // reader handed back the OTHER bound as if the page were fully read.
      const bs = String.fromCharCode(92);
      const dq = String.fromCharCode(34);
      const escaped = `${dq}valid_${bs}u0066rom${dq}`;
      const { fields, undetermined } = windowFieldsFromFrontmatterText(
        `---\n${escaped}: pas-une-date\nvalid_through: 2025-12-31\n---\nbody`,
      );
      assert.deepEqual(undetermined, ['valid_from', 'valid_through']);
      assert.deepEqual(fields, {}, 'the readable bound is not handed back either');
    });

    test('a quoted key containing the other quote is an ordinary key', () => {
      // `"l'exemple":` is a perfectly normal key. A character class that banned
      // both quote characters made it invisible — so its block scalar went
      // untracked, the text inside was read as structure, and the page's real
      // bound was thrown away.
      const dq = String.fromCharCode(34);
      const sq = String.fromCharCode(39);
      assert.equal(
        verdict(`---\n${dq}l${sq}exemple${dq}: | # doc\n  ? ceci est du texte\nvalid_through: 2025-12-31\n---\nbody`),
        STATE_NO_LONGER,
      );
    });

    test('a Unicode parent key still makes its child a child', () => {
      // Recognising a line AS a key is structural; interpreting the key is not.
      // Tying the two together meant `métadonnées:` did not register as a
      // parent, so its indented child looked like a root node and the document
      // was refused over a property that declares nothing.
      for (const parent of ['métadonnées', 'my metadata', 'a.b', 'Clé-Composée']) {
        assert.equal(
          verdict(`---\n${parent}:\n  {owner: Alice}\nvalid_through: 2025-12-31\n---\nbody`),
          STATE_NO_LONGER,
          parent,
        );
      }
    });

    test('a flow mapping belonging to ANOTHER key is not a root shape', () => {
      // Round 4, MINEUR. `^\s*` caught a child value, and the document was
      // refused over a property that cannot carry a root bound — losing a
      // window declared plainly two lines below it.
      assert.equal(
        verdict('---\nmetadata:\n  {owner: Alice}\nvalid_through: 2025-12-31\n---\nbody'),
        STATE_NO_LONGER,
      );
      // And the same content written inline, which always worked.
      assert.equal(
        verdict('---\nmetadata: {owner: Alice}\nvalid_through: 2025-12-31\n---\nbody'),
        STATE_NO_LONGER,
      );
    });

    // ROUND 4: a block scalar header is more than `|`. Where that RECOGNITION
    // decides something is narrower than it looks, and finding it took a
    // measurement rather than an assumption: with an indented body under it,
    // the folded-continuation rule already refuses the field whether or not the
    // header was recognised. The difference shows on a header with NO body —
    // there the unrecognised form is read as a plain scalar, so the reader
    // hands back `valid_from: "|"` and the answer becomes `unreadable`, the
    // classifier's verdict on a value it was given, instead of `undetermined`,
    // this reader saying it refused the shape. The contract promises the
    // second, and the two are different claims about the page.
    const blockHeaders = [
      ['a comment after the indicator', '| # exemple'],
      ['an anchor before the indicator', '&example |'],
      ['a tag before the indicator', '!!str |'],
      ['a folded scalar with a comment', '> # exemple'],
      ['a chomping indicator', '|-'],
      ['an explicit indent', '|2'],
    ];
    for (const [label, header] of blockHeaders) {
      test(`${label} is a block scalar, so the bound is REFUSED, not read`, () => {
        const { fields, undetermined } = windowFieldsFromFrontmatterText(
          `---\nvalid_from: ${header}\ntype: decision\n---\nbody`,
        );
        assert.deepEqual(undetermined, ['valid_from']);
        assert.deepEqual(fields, {}, 'and no fragment of the header was read as a date');
      });
    }

    test('and with a BODY under it, the continuation rule refuses it too', () => {
      // Stated so the narrowness above is not mistaken for a gap: the two rules
      // overlap on the common shape, which is why the witnesses had to use the
      // uncommon one to see either.
      for (const header of ['| # exemple', '|', '&example |']) {
        assert.equal(
          verdict(`---\nvalid_from: ${header}\n  2020-01-01\n---\nbody`),
          'undetermined',
          header,
        );
      }
    });

    test('a QUOTED key opens whatever its value opens', () => {
      // `'title': "…` starts a scalar that runs over the lines below it, so a
      // `valid_from:` written inside is TEXT. Not tracking quoted keys meant
      // the reader picked it up as a real field and reported a window the page
      // does not declare — the same trap the plain-key path was fixed for.
      const dq = String.fromCharCode(34);
      const sq = String.fromCharCode(39);
      assert.equal(
        verdict(`---\n${sq}title${sq}: ${dq}commence ici\nvalid_from: 2020-01-01\n${dq}\n---\nbody`),
        null,
      );
    });

    test('but a `?` inside a block opened by a QUOTED key is still text', () => {
      const sq = String.fromCharCode(39);
      assert.equal(
        verdict(`---\n${sq}title${sq}: |\n  ? valid_from est expliqué ici\nvalid_through: 2025-12-31\n---\nbody`),
        STATE_NO_LONGER,
      );
    });

    test('a `?` that is part of a VALUE is not an explicit key', () => {
      // `? ` at the start of a line is the indicator; a question mark inside a
      // scalar is a character. Confusing them would refuse ordinary pages.
      assert.equal(verdict('---\ntitre: pourquoi ?\nvalid_through: 2025-12-31\n---\nbody'), STATE_NO_LONGER);
    });

    test('but a comment after a GENUINELY empty key leaves it absent, not undetermined', () => {
      // The control. Skipping comments must not turn every empty key into a
      // doubt: `valid_from:` with nothing under it really does declare nothing,
      // and saying otherwise would mark half the vault unreadable.
      assert.equal(verdict('---\nvalid_from:\n# commentaire\ntype: decision\n---\nbody'), null);
      assert.equal(verdict('---\nvalid_from:\n\ntype: decision\n---\nbody'), null);
    });
  });

  describe('the envelope', () => {
    test('a byte-order mark does not swallow the window', () => {
      assert.equal(verdict(`${BOM}---\nvalid_through: 2025-12-31\n---\nbody`), STATE_NO_LONGER);
    });

    test('CRLF reads like LF', () => {
      assert.equal(verdict('---\r\nvalid_through: 2025-12-31\r\n---\r\nbody'), STATE_NO_LONGER);
    });

    test('a key that merely STARTS with the fence characters is not the fence', () => {
      // `---meta: x` closed the block in the first version, hiding every field
      // under it.
      assert.equal(verdict('---\ntype: decision\n---meta: x\nvalid_through: 2025-12-31\n---\nbody'), STATE_NO_LONGER);
    });

    test('an unterminated quote on ANOTHER key swallows the lines below it, as YAML does', () => {
      // The line under an unterminated scalar is CONTENT, not a key. Reading it
      // as a field asserted a window the document never declared.
      assert.equal(verdict('---\nsummary: "inachevé\nvalid_from: 2027-01-01\n---\nbody'), null);
    });

    test('a key at column 0 after a nested block is still read', () => {
      assert.equal(verdict('---\nvalidity:\n  x: 1\nvalid_through: 2025-12-31\n---\nbody'), STATE_NO_LONGER);
    });
  });
});

// ---------------------------------------------------------------------------
// The source sweep — a PARTIAL guard, and honest about it
// ---------------------------------------------------------------------------

/**
 * The rule it enforces is narrower and stronger than "nobody re-implements the
 * comparison": **only the helper TOUCHES these two fields**. Any legitimate
 * consumer gets the window through `classifyValidity` / `readWindow`; a file
 * that reaches into `frontmatter.valid_through` itself is either duplicating
 * the calendar rules or about to.
 *
 * "Touches", not "reads", after review: the detector also flags an assignment
 * (`fm.valid_through = x`), and the choice is to keep that and widen the rule
 * rather than narrow the detector. Nothing in `src/` writes these fields, and
 * a module that started to would be minting windows — worth a look either way.
 *
 * It is a guard, not the proof. The proof is the mutation: break the helper's
 * bound comparison and a witness inside EACH consumer goes red (see
 * `tests/temporal-validity-lint.test.mjs`). This sweep catches the mistake
 * before it gets that far, and it has a stated blind spot: a computed access
 * (`fm[key]` where `key` was built at runtime) is invisible to any textual
 * scan, and no amount of widening would change that.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP_DIRS = ['src', 'hooks', 'scripts'];
/** The one module allowed to read the fields: it is what everyone else calls. */
const FIELD_OWNER = 'src/helpers/temporal-validity.mjs';

/**
 * Ways a file can reach the raw fields.
 *
 * Dot access, constant-keyed access and destructuring all survive the
 * string/comment blanking, so they are matched on the blanked text. The quoted
 * bracket form cannot be: blanking erases the key. It is therefore matched on
 * the RAW text and then filtered by POSITION — `blankStringsAndComments`
 * preserves offsets, so if the `[` that opens the match was itself blanked, the
 * whole expression was sitting inside a comment or a string and is prose, not
 * code.
 *
 * Both halves of that were review findings: the first version missed
 * `const { valid_through } = fm` entirely, and flagged a comment that merely
 * quoted `fm['valid_through']` as if it were a read.
 */
function directFieldReads(source) {
  const code = blankStringsAndComments(source);
  const hits = [];
  const inCode = [
    [/\.\s*valid_(from|through)\b/g, 'property access'],
    [/\[\s*VALID_(FROM|THROUGH)\s*\]/g, 'constant-keyed access'],
    // `const { valid_through } = fm` — the closing brace followed by `=` is
    // what separates a destructuring pattern from an object literal that
    // merely mentions the key.
    [/\{[^{}]*\bvalid_(from|through)\b[^{}]*\}\s*=/g, 'destructuring'],
  ];
  for (const [re, label] of inCode) {
    for (const m of code.matchAll(re)) hits.push(`${label} ${m[0].trim()}`);
  }
  // Backtick included: a template literal is a perfectly ordinary way to write
  // a constant key, and leaving it out was a hole review walked straight
  // through.
  for (const m of source.matchAll(/\[\s*(['"`])valid_(from|through)\1\s*\]/g)) {
    // The opening bracket survives blanking when it is code; it becomes a
    // space when the whole expression was quoted inside a comment or a string.
    if (code[m.index] !== '[') continue;
    hits.push(`quoted-key access ${m[0].trim()}`);
  }
  return hits;
}

function listSources(dir) {
  const root = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    // `.js` as well as `.mjs`: a consumer written as CommonJS would otherwise
    // be invisible to the guard meant to find it.
    .filter((f) => /\.(mjs|js)$/.test(f))
    .map((f) => `${dir}/${f}`);
}

describe('only the helper reads valid_from / valid_through', () => {
  test('the detector catches every shape it exists for, and none of the safe ones', () => {
    // Validated by INJECTION, not by trusting it: a guard is worth exactly what
    // its own witnesses are worth, and this one is easy to write in a way that
    // finds nothing.
    const offenders = [
      ['dot access', 'const end = fm.valid_through;'],
      ['dot access with spacing', 'if (page . valid_from) return;'],
      ['quoted-key access', "const end = fm['valid_through'];"],
      ['double-quoted key', 'const start = fm["valid_from"];'],
      ['constant-keyed access', 'const end = fm[VALID_THROUGH];'],
      ['the realistic re-implementation', 'if (fm.valid_through && fm.valid_through < today) expire();'],
    ];
    for (const [label, src] of offenders) {
      assert.ok(directFieldReads(src).length > 0, `must flag: ${label}`);
    }

    // Every one of these was a hole or a false alarm found in review; each is
    // the shape a real violator would actually write.
    const foundInReview = [
      ['destructuring, the realistic re-implementation', 'const { valid_through: end } = fm;\nif (end < today) expire();'],
      ['destructuring with a default', 'const { valid_from = null } = fm;'],
      ['a template-literal key', 'const end = fm[`valid_through`];'],
      ['an assignment — minting a window outside the helper', 'fm.valid_through = suppliedDate;'],
    ];
    for (const [label, src] of foundInReview) {
      assert.ok(directFieldReads(src).length > 0, `must flag: ${label}`);
    }

    const safe = [
      ['a mention in a line comment', '// valid_from and valid_through live in the helper'],
      ['a mention in a block comment', '/* fm.valid_through is off limits here */'],
      ['a BRACKET access quoted inside a comment', "// never write fm['valid_through'] — call the helper"],
      ['a bracket access quoted inside a string', 'const msg = "do not use fm[\'valid_through\']";'],
      ['a field name inside a message', "detail = `valid_from:${code} is not a date`;"],
      ['a field name in a plain string', "const label = 'valid_through';"],
      ['an object literal that merely carries the key', "const page = { valid_from: '2026-01-01' };"],
      ['calling the helper, which is the point', 'const v = classifyValidity(fm, { asOf: today });'],
      ['an unrelated comparison', 'if (a.updated < today) stale();'],
      ['an arrow function, whose > must not read as a comparison', 'const f = (x) => x.other;'],
    ];
    for (const [label, src] of safe) {
      assert.deepEqual(directFieldReads(src), [], `must NOT flag: ${label}`);
    }
  });

  test('no file outside the helper touches the fields directly', () => {
    const perDir = {};
    const inventory = [];
    const offenders = [];
    for (const dir of SWEEP_DIRS) {
      const files = listSources(dir);
      perDir[dir] = files.length;
      for (const rel of files) {
        inventory.push(rel);
        if (rel === FIELD_OWNER) continue;
        const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        for (const hit of directFieldReads(source)) offenders.push(`${rel}: ${hit}`);
      }
    }
    // The denominator, per directory rather than in total: review pointed out
    // that `scanned >= 100` stays satisfied if a whole directory drops out of
    // the sweep, which is exactly how a guard goes quiet without failing.
    for (const dir of SWEEP_DIRS) {
      assert.ok(perDir[dir] >= 1, `the sweep must actually enter ${dir}/, entered ${perDir[dir]} files`);
    }
    assert.ok(perDir.src >= 100, `expected the whole src tree, scanned ${perDir.src}`);
    // And the consumers by name: a guard that silently stopped covering the one
    // module most likely to duplicate the rules would still be green.
    for (const expected of ['src/helpers/temporal-validity-lint.mjs', FIELD_OWNER]) {
      assert.ok(inventory.includes(expected), `${expected} must be inside the sweep`);
    }
    assert.deepEqual(offenders, [],
      'these files touch the raw fields instead of calling the helper — the calendar rules live in ONE place');
  });

  test('and the owner really does read them, so the exemption is not decorative', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, FIELD_OWNER), 'utf8');
    assert.ok(directFieldReads(source).length > 0,
      `${FIELD_OWNER} is exempted from the sweep; if it stopped reading the fields, the exemption `
      + 'would be hiding nothing and the sweep would be testing an empty rule');
  });
});
