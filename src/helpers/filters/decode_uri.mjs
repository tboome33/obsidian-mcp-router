/**
 * URL-decode a string. Wraps `decodeURIComponent` with a safe fallback:
 * on malformed input (lone `%` not followed by 2 hex digits, etc.) the
 * original string is returned instead of throwing. Direct port of
 * `obsidian-clipper/src/utils/filters/decode_uri.ts` (MIT).
 *
 * @param {string} str
 * @returns {string}
 */
export function decode_uri(str) {
  try {
    return decodeURIComponent(String(str));
  } catch {
    return String(str);
  }
}
