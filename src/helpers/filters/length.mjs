/**
 * Return the length of a string. If the input parses as JSON, count
 * array items or object keys instead. Direct port of
 * `obsidian-clipper/src/utils/filters/length.ts` (MIT).
 *
 * Returns a STRING (not a number) to match Clipper's behavior — its
 * filter output is always coerced to a string in the template pipeline.
 *
 * @param {string} str
 * @returns {string}
 */
export function length(str) {
  const input = String(str);
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) return parsed.length.toString();
    if (typeof parsed === 'object' && parsed !== null) {
      return Object.keys(parsed).length.toString();
    }
  } catch {
    /* not JSON — fall through to string length */
  }
  return input.length.toString();
}
