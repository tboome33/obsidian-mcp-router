/**
 * Add or subtract a duration from a date. Port of
 * `obsidian-clipper/src/utils/filters/date_modify.ts` (MIT), reimplemented
 * WITHOUT `dayjs` — uses native `Date` arithmetic. Sufficient for the
 * router's ingestion needs.
 *
 * Param format: `'+N unit'` or `'-N unit'` where unit ∈ {year[s],
 * month[s], week[s], day[s], hour[s], minute[s], second[s]}. Outer
 * parens/quotes tolerated (Clipper template-arg convention).
 *
 *   date_modify("2026-05-24", "+1 day")    → "2026-05-25"
 *   date_modify("2026-05-24", "-2 weeks")  → "2026-05-10"
 *   date_modify("2026-05-24", "+1 month")  → "2026-06-24"
 *
 * Calendar-validated input (same as `date.mjs`): a date-only `YYYY-MM-DD`
 * with an impossible day (`2026-02-31`) is returned unchanged.
 *
 * @param {string} str — input ISO date
 * @param {string} param — modifier expression
 * @returns {string} — `YYYY-MM-DD` result, or `str` on invalid input
 */
export function date_modify(str, param) {
  if (!param) return str;
  const input = String(str);
  if (input === '') return input;

  let p = String(param);
  p = p.replace(/^\((.*)\)$/, '$1');
  p = p.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();

  const re = /^([+-])\s*(\d+)\s*(\w+)s?$/;
  const match = re.exec(p);
  if (!match) return input;

  const [, op, amount, unitRaw] = match;
  const n = parseInt(amount, 10);
  const unit = unitRaw.toLowerCase().replace(/s$/, '');

  // Parse the input date (same validation strategy as date.mjs).
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (!isoMatch) return input;
  const y = Number.parseInt(isoMatch[1], 10);
  const m = Number.parseInt(isoMatch[2], 10);
  const d = Number.parseInt(isoMatch[3], 10);
  const leap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > dim[m - 1]) return input;

  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return input;

  const sign = op === '+' ? 1 : -1;
  switch (unit) {
    case 'year':
      // Clamp day to last-of-target-month so `Feb 29 leap + 1 year`
      // doesn't roll over to `Mar 1` of a non-leap year.
      // v0.13.6 hardening (Reviewer A finding F1b).
      shiftMonthClamped(date, sign * n * 12);
      break;
    case 'month':
      // Clamp day to last-of-target-month so `Jan 31 + 1 month` doesn't
      // roll over to `Mar 3` (JS Date.setMonth's silent normalization
      // behavior). v0.13.6 hardening (Reviewer A finding F1a).
      shiftMonthClamped(date, sign * n);
      break;
    case 'week': date.setDate(date.getDate() + sign * n * 7); break;
    case 'day': date.setDate(date.getDate() + sign * n); break;
    case 'hour': date.setHours(date.getHours() + sign * n); break;
    case 'minute': date.setMinutes(date.getMinutes() + sign * n); break;
    case 'second': date.setSeconds(date.getSeconds() + sign * n); break;
    default: return input;
  }

  const pad2 = (x) => String(x).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Shift `date` by `monthDelta` months, clamping the day to the last
 * valid day of the target month. Avoids JS Date.setMonth's silent
 * roll-over to the following month when the source day doesn't exist
 * in the target (`Jan 31 + 1 month` → not `Feb 31` → ends up `Mar 3`,
 * or `Feb 29 leap + 1 year` → not `Feb 29 non-leap` → ends up `Mar 1`).
 *
 * Algorithm: set day=1 first (always valid), then set month, then
 * compute last day of new month, then clamp.
 */
function shiftMonthClamped(date, monthDelta) {
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + monthDelta);
  // Last day of the new month = day 0 of (month+1).
  const lastDayOfNewMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDayOfNewMonth));
}
