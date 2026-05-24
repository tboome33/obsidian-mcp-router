/**
 * Convert a string to kebab-case. Ported from obsidian-clipper's
 * `src/utils/filters/kebab.ts` (MIT). Handles camelCase boundaries,
 * underscores, and whitespace runs.
 *
 *   "FooBar baz_qux" → "foo-bar-baz-qux"
 *   "alreadyKebab"   → "already-kebab"
 *   "HTTPRequest"    → "httprequest"  (consecutive caps treated as one word —
 *                                       matches Clipper behavior)
 *
 * @param {string} str
 * @returns {string}
 */
export function kebab(str) {
  return String(str)
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}
