/**
 * Format an ISO 8601 duration string (or a raw number of seconds) as a
 * human-readable time. Port of `obsidian-clipper/src/utils/filters/duration.ts`
 * (MIT), reimplemented WITHOUT `dayjs/plugin/duration` — uses native
 * arithmetic. Sufficient for the router's needs.
 *
 * Supported input:
 *   - ISO 8601 duration: `'P1Y2M3DT4H5M6S'` (years, months, days,
 *     hours, minutes, seconds — any subset)
 *   - Bare seconds number: `'1868'`
 *
 * Supported format tokens (Clipper subset):
 *   `HH` 2-digit hours    `H` 1-2 digit hours
 *   `mm` 2-digit minutes  `m` 1-2 digit minutes
 *   `ss` 2-digit seconds  `s` 1-2 digit seconds
 *
 * Default format: `'HH:mm:ss'` if hours > 0, else `'mm:ss'`.
 *
 *   duration("PT5M30S")            → "05:30"
 *   duration("PT1H30M")            → "01:30:00"
 *   duration("90")                 → "01:30" (90 seconds)
 *   duration("PT1H30M", "H:mm")    → "1:30"
 *
 * Note: months and years are normalized as 30 days and 365 days
 * respectively (matches Clipper). This is approximate — fine for
 * reading-time and video-length displays, NOT for precise calendar math.
 *
 * @param {string} str
 * @param {string} [param] — format string
 * @returns {string}
 */
export function duration(str, param) {
  const input = String(str || '');
  if (!input) return input;

  try {
    let s = input.replace(/^["'](.*)["']$/, '$1');
    const matches = s.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);

    let totalSeconds;
    if (matches) {
      const [, years, months, days, hours, minutes, seconds] = matches;
      totalSeconds =
        (years ? parseInt(years, 10) * 365 * 24 * 3600 : 0) +
        (months ? parseInt(months, 10) * 30 * 24 * 3600 : 0) +
        (days ? parseInt(days, 10) * 24 * 3600 : 0) +
        (hours ? parseInt(hours, 10) * 3600 : 0) +
        (minutes ? parseInt(minutes, 10) * 60 : 0) +
        (seconds ? parseInt(seconds, 10) : 0);
    } else {
      // Try bare seconds
      const n = parseInt(s, 10);
      if (Number.isNaN(n)) return input;
      totalSeconds = n;
    }

    return formatDuration(totalSeconds, param);
  } catch {
    return input;
  }
}

function formatDuration(totalSeconds, format) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let fmt = format;
  if (fmt != null) {
    fmt = String(fmt).replace(/^["'(](.*)["')]$/, '$1');
  } else {
    fmt = hours >= 1 ? 'HH:mm:ss' : 'mm:ss';
  }

  const pad2 = (n) => n.toString().padStart(2, '0');
  const replacements = {
    HH: pad2(hours),
    H: hours.toString(),
    mm: pad2(minutes),
    m: minutes.toString(),
    ss: pad2(seconds),
    s: seconds.toString(),
  };
  // Match longest tokens first.
  return fmt.replace(/HH|H|mm|m|ss|s/g, (m) => replacements[m]);
}
