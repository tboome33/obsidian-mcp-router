/**
 * Convert a JSON array or object into a list of markdown footnote
 * definitions. Direct port of `obsidian-clipper/src/utils/filters/footnote.ts` (MIT).
 *
 *   `["one", "two"]` → `[^1]: one\n\n[^2]: two`
 *   `{"abbr": "explanation"}` → `[^abbr]: explanation`
 *   `{"camelKey": "v"}` → `[^camel-key]: v` (kebab-cased)
 *
 * Non-JSON input is returned unchanged.
 *
 * @param {string} str — JSON string of array or object
 * @returns {string}
 */
export function footnote(str) {
  const input = String(str);
  if (input === '') return input;
  try {
    const data = JSON.parse(input);
    if (Array.isArray(data)) {
      return data.map((item, i) => `[^${i + 1}]: ${item}`).join('\n\n');
    }
    if (typeof data === 'object' && data !== null) {
      return Object.entries(data)
        .map(([key, value]) => {
          const id = key
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[\s_]+/g, '-')
            .toLowerCase();
          return `[^${id}]: ${value}`;
        })
        .join('\n\n');
    }
  } catch {
    /* not JSON, return as-is */
  }
  return input;
}
