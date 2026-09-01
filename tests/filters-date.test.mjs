import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { date } from '../src/helpers/filters/date.mjs';

describe('date — default format YYYY-MM-DD', () => {
  test('parses ISO 8601 and reformats', () => {
    assert.equal(date('2026-05-24'), '2026-05-24');
  });

  test('parses ISO with time and outputs YYYY-MM-DD', () => {
    assert.equal(date('2026-05-24T15:30:00Z').slice(0, 4), '2026');
    // Day depends on the runner's timezone — assert prefix only.
  });

  test('"now" returns today in YYYY-MM-DD', () => {
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // Read the clock on BOTH sides of the call. `date('now')` takes its own
    // reading, so a single `expected` computed beforehand fails whenever
    // midnight lands between the two — rejecting a date that was correct when
    // it was produced.
    const before = ymd(new Date());
    const actual = date('now');
    const after = ymd(new Date());
    assert.ok(actual === before || actual === after,
      `expected "${actual}" to be today (${before}${after === before ? '' : ` or ${after}`})`);
  });

  test('empty string returns empty', () => {
    assert.equal(date(''), '');
  });

  test('unparseable input returns the input unchanged', () => {
    assert.equal(date('not a date'), 'not a date');
  });
});

describe('date — REGRESSION (review+ pass 1 / codex B#A): TZ-independence on date-only input', () => {
  test('YYYY-MM-DD input does NOT shift by timezone of the runner', () => {
    // Before fix: `new Date("2026-05-24")` parsed as midnight UTC, then
    // the formatter read local fields → returned "2026-05-23" when run
    // under TZ=America/New_York (UTC-4). Fix: special-case YYYY-MM-DD as
    // a local-calendar construction so the day component is preserved.
    //
    // This test runs under the current process TZ. To exercise the bug
    // explicitly, run: `TZ=America/New_York npm test` (without the fix,
    // this test should fail). The behavior contract: a published-date
    // string in YYYY-MM-DD form survives the round-trip regardless of TZ.
    assert.equal(date('2026-05-24'), '2026-05-24');
    assert.equal(date('2026-01-01'), '2026-01-01');
    assert.equal(date('2026-12-31'), '2026-12-31');
  });
});

describe('date — REGRESSION (review+ pass 4 / codex J): calendar-invalid date-only inputs are returned unchanged', () => {
  test('rejects month > 12 (was silently rolling over to next year)', () => {
    // Pre-pass-5: `new Date(2026, 13-1, 1)` → 2027-01-01.
    // Now: structurally well-formed but calendar-invalid → return input.
    assert.equal(date('2026-13-01'), '2026-13-01');
    assert.equal(date('2026-99-01'), '2026-99-01');
  });

  test('rejects day > days-in-month (was rolling forward)', () => {
    // Pre-pass-5: `new Date(2026, 1, 31)` → March 3 (Feb 28 + 3).
    assert.equal(date('2026-02-31'), '2026-02-31');
    // April has 30 days, not 31.
    assert.equal(date('2026-04-31'), '2026-04-31');
  });

  test('rejects month=0 or day=0', () => {
    assert.equal(date('2026-00-15'), '2026-00-15');
    assert.equal(date('2026-05-00'), '2026-05-00');
  });

  test('accepts Feb 29 in a leap year', () => {
    assert.equal(date('2024-02-29'), '2024-02-29');
  });

  test('rejects Feb 29 in a non-leap year', () => {
    assert.equal(date('2026-02-29'), '2026-02-29');
    assert.equal(date('2100-02-29'), '2100-02-29'); // 2100 is NOT leap (divisible by 100, not 400)
  });

  test('accepts Feb 29 in century leap years (divisible by 400)', () => {
    assert.equal(date('2000-02-29'), '2000-02-29');
  });

  test('REGRESSION (v0.13.1 / codex post-commit P): ISO datetime with invalid day is rejected too', () => {
    // Pre-v0.13.1 the date-only branch validated, but full ISO datetimes
    // fell through to `new Date(input)` which V8 silently rolled forward.
    // `date('2026-02-31T00:00:00Z')` was returning `'2026-03-03'`.
    assert.equal(date('2026-02-31T00:00:00Z'), '2026-02-31T00:00:00Z');
    assert.equal(date('2026-13-15T10:00:00Z'), '2026-13-15T10:00:00Z');
    assert.equal(date('2026-04-31T12:30:45.123Z'), '2026-04-31T12:30:45.123Z');
  });

  test('REGRESSION (v0.13.1): valid ISO datetimes still pass through correctly', () => {
    // Sanity check that the new ISO-prefix-validation doesn't reject valid
    // inputs. Format depends on local TZ for the day component; we just
    // assert the year-month part is preserved.
    assert.match(date('2026-02-28T00:00:00Z'), /^2026-02-2[78]$/);
    assert.match(date('2024-02-29T12:00:00Z'), /^2024-02-29$/);
  });
});

describe('date — custom format tokens', () => {
  test('DD/MM/YYYY', () => {
    assert.equal(date('2026-05-24', 'DD/MM/YYYY'), '24/05/2026');
  });

  test('YYYY/MM/DD HH:mm', () => {
    // Use a UTC parse + assert structure since local TZ shifts the hour.
    const out = date('2026-05-24T15:30:00Z', 'YYYY/MM/DD HH:mm');
    assert.match(out, /^2026\/05\/\d{2} \d{2}:\d{2}$/);
  });

  test('YY shorthand year', () => {
    assert.equal(date('2026-05-24', 'YY'), '26');
  });

  test('M and D single-digit tokens', () => {
    assert.equal(date('2026-01-05', 'M/D'), '1/5');
  });

  test('strips outer parens from format param', () => {
    assert.equal(date('2026-05-24', '(DD/MM/YYYY)'), '24/05/2026');
  });

  test('strips outer double quotes from format param', () => {
    assert.equal(date('2026-05-24', '"DD/MM/YYYY"'), '24/05/2026');
  });
});
