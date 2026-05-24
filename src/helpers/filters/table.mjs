/**
 * Format JSON (object, array of objects, array of arrays, or flat
 * array) as a markdown table. Direct port of
 * `obsidian-clipper/src/utils/filters/table.ts` (MIT).
 *
 * Cases handled:
 *   - Single object: 2-column key/value table
 *   - Array of objects: columns = union of keys (or custom headers)
 *   - Array of arrays: columns sized to longest row
 *   - Flat array + custom headers: rows of N columns
 *   - Flat array no headers: single-column "Value" table
 *
 * @param {string} str — JSON string
 * @param {string} [params] — comma-separated custom headers, optionally
 *                            wrapped in `(...)` and per-header quotes
 * @returns {string}
 */
export function table(str, params) {
  const input = String(str);
  if (!input || input === 'undefined' || input === 'null') return input;

  try {
    const data = JSON.parse(input);
    let customHeaders = [];

    if (params) {
      try {
        const headerStr = String(params).replace(/^\((.*)\)$/, '$1');
        customHeaders = headerStr
          .split(',')
          .map((h) => h.trim().replace(/^["'](.*)["']$/, '$1'));
      } catch { /* fallthrough with empty headers */ }
    }

    const esc = (cell) => String(cell).replace(/\|/g, '\\|');

    // Single object → 2-column key/value
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const entries = Object.entries(data);
      if (entries.length === 0) return input;
      const [[firstKey, firstValue], ...rest] = entries;
      let out = `| ${esc(firstKey)} | ${esc(String(firstValue))} |\n| - | - |\n`;
      for (const [k, v] of rest) {
        out += `| ${esc(k)} | ${esc(String(v))} |\n`;
      }
      return out.trim();
    }

    // Array of objects
    if (
      Array.isArray(data) &&
      data.length > 0 &&
      typeof data[0] === 'object' &&
      data[0] !== null &&
      !Array.isArray(data[0])
    ) {
      const headers = customHeaders.length > 0 ? customHeaders : Object.keys(data[0]);
      let out = `| ${headers.join(' | ')} |\n| ${headers.map(() => '-').join(' | ')} |\n`;
      for (const row of data) {
        out += `| ${headers.map((h) => esc(String(row[h] ?? ''))).join(' | ')} |\n`;
      }
      return out.trim();
    }

    // Array of arrays
    if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
      const maxCols = Math.max(...data.map((r) => r.length));
      const headers = customHeaders.length > 0 ? customHeaders : Array(maxCols).fill('');
      let out = `| ${headers.join(' | ')} |\n| ${headers.map(() => '-').join(' | ')} |\n`;
      for (const row of data) {
        const padded = [...row, ...Array(maxCols - row.length).fill('')];
        out += `| ${padded.map((c) => esc(String(c))).join(' | ')} |\n`;
      }
      return out.trim();
    }

    // Flat array
    if (Array.isArray(data)) {
      if (customHeaders.length > 0) {
        const n = customHeaders.length;
        let out = `| ${customHeaders.join(' | ')} |\n| ${customHeaders.map(() => '-').join(' | ')} |\n`;
        for (let i = 0; i < data.length; i += n) {
          const row = data.slice(i, i + n);
          const padded = [...row, ...Array(n - row.length).fill('')];
          out += `| ${padded.map((c) => esc(String(c))).join(' | ')} |\n`;
        }
        return out.trim();
      }
      let out = '| Value |\n| - |\n';
      for (const item of data) {
        out += `| ${esc(String(item))} |\n`;
      }
      return out.trim();
    }

    return input;
  } catch {
    return input;
  }
}
