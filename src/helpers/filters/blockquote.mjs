/**
 * Prefix each line with `> ` to produce a markdown blockquote.
 * Accepts a string OR a JSON array (nested arrays → nested depth) OR
 * an object (stringified pretty before quoting). Port of
 * `obsidian-clipper/src/utils/filters/blockquote.ts` (MIT).
 *
 * @param {string|string[]} input
 * @returns {string}
 */
export function blockquote(input) {
  const processBlockquote = (str, depth = 1) => {
    const prefix = '> '.repeat(depth);
    return String(str)
      .split('\n')
      .map((line) => `${prefix}${line}`)
      .join('\n');
  };

  const processArray = (arr, depth = 1) =>
    arr
      .map((item) =>
        Array.isArray(item)
          ? processArray(item, depth + 1)
          : processBlockquote(String(item), depth),
      )
      .join('\n');

  try {
    const parsed = JSON.parse(String(input));
    if (Array.isArray(parsed)) return processArray(parsed);
    if (typeof parsed === 'object' && parsed !== null) {
      return processBlockquote(JSON.stringify(parsed, null, 2));
    }
    return processBlockquote(String(parsed));
  } catch {
    if (Array.isArray(input)) return processArray(input);
    return processBlockquote(String(input));
  }
}
