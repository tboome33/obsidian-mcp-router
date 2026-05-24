/**
 * Parse and format a date. Simplified port of obsidian-clipper's
 * `src/utils/filters/date.ts` (MIT) without the `dayjs` dependency —
 * uses native `Date` + `Intl.DateTimeFormat`. Sufficient for the
 * router's ingestion needs (parse ISO 8601 published dates, format to
 * `YYYY-MM-DD` or other common patterns).
 *
 * Supported output format tokens (compatible subset of dayjs):
 *   YYYY  4-digit year         MM  2-digit month     DD  2-digit day
 *   YY    2-digit year         M   1-2 digit month   D   1-2 digit day
 *   HH    2-digit hour (24h)   mm  2-digit minute    ss  2-digit second
 *   H     1-2 digit hour       m   1-2 digit minute  s   1-2 digit second
 *
 * If `dayjs` becomes a runtime dep later, swap in the full filter from
 * Clipper for richer format strings (week-of-year, ordinals, custom
 * parse formats, …).
 *
 *   date("2026-05-24")                  → "2026-05-24"
 *   date("2026-05-24", "DD/MM/YYYY")    → "24/05/2026"
 *   date("now")                          → today's YYYY-MM-DD
 *   date("not a date")                  → original string (parse failed)
 *
 * @param {string} str — date input ISO string, RFC2822, or `'now'`
 * @param {string} [format] — output format (default `'YYYY-MM-DD'`)
 * @returns {string} — formatted date, or original `str` if parse fails
 */
export function date(str, format) {
  const input = String(str);
  if (input === '') return input;

  // Timezone-correctness for date-only ISO inputs (review+ pass 1 finding
  // B#A, codex, proven by exec: `TZ=America/New_York date("2026-05-24")`
  // was returning `'2026-05-23'` because `new Date("2026-05-24")` parses
  // as midnight UTC but the formatter below read local fields).
  //
  // Rule: if the input is purely `YYYY-MM-DD` (no time component), treat
  // it as a local-calendar date — published metadata is typically "this
  // day in the publisher's mind", not "an instant in UTC". For everything
  // else (full ISO with time, RFC2822, etc.) keep the prior behavior:
  // parse as instant, format in local TZ.
  const dateOnlyMatch = input !== 'now' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  let source;
  if (input === 'now') {
    source = new Date();
  } else if (dateOnlyMatch) {
    // Local-calendar construction avoids the UTC-midnight shift, BUT
    // `new Date(y, m-1, d)` silently rolls over invalid components
    // (`date('2026-13-01')` → 2027-01-01, `date('2026-02-31')` → 2026-03-03).
    // The documented contract is "unparseable inputs return unchanged",
    // so validate components against real calendar ranges before
    // constructing the Date. Review+ pass 4 finding J (codex P2).
    const y = Number.parseInt(dateOnlyMatch[1], 10);
    const m = Number.parseInt(dateOnlyMatch[2], 10);
    const d = Number.parseInt(dateOnlyMatch[3], 10);
    // Days-per-month with leap-year handling (Feb 29 in a leap year is OK,
    // Feb 29 in a non-leap year is NOT).
    const leap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
    const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (m < 1 || m > 12 || d < 1 || d > dim[m - 1]) {
      return input; // structurally well-formed but calendar-invalid
    }
    source = new Date(y, m - 1, d);
  } else {
    source = new Date(input);
  }
  if (isNaN(source.getTime())) return input;

  const fmt = format ? stripParenAndQuotes(format) : 'YYYY-MM-DD';

  const pad2 = (n) => String(n).padStart(2, '0');
  const replacements = {
    YYYY: String(source.getFullYear()),
    YY: String(source.getFullYear()).slice(-2),
    MM: pad2(source.getMonth() + 1),
    M: String(source.getMonth() + 1),
    DD: pad2(source.getDate()),
    D: String(source.getDate()),
    HH: pad2(source.getHours()),
    H: String(source.getHours()),
    mm: pad2(source.getMinutes()),
    m: String(source.getMinutes()),
    ss: pad2(source.getSeconds()),
    s: String(source.getSeconds()),
  };

  // Sort tokens by length descending so YYYY beats YY, MM beats M, etc.
  const tokens = Object.keys(replacements).sort((a, b) => b.length - a.length);
  const re = new RegExp(tokens.join('|'), 'g');
  return fmt.replace(re, (t) => replacements[t]);
}

function stripParenAndQuotes(s) {
  let out = String(s);
  out = out.replace(/^\((.*)\)$/, '$1');
  out = out.replace(/^(['"])([\s\S]*)\1$/, '$2');
  return out;
}
