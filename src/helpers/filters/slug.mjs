/**
 * Generate a URL-friendly slug suitable for filenames like
 * `wiki/sources/<slug>.md`. NOT a port from obsidian-clipper — Clipper
 * has no `slug` filter; it relies on `safe_name | kebab` chained in
 * templates. Since the router consumes slugs programmatically (no template
 * engine), we expose a single `slug()` that does the canonical pipeline:
 *
 *   1. Unicode-normalize (NFKD) then strip combining marks → ASCII fold
 *      ("Éléonore" → "Eleonore")
 *   2. Strip Obsidian markup that breaks wikilinks (`# | ^ [ ]`)
 *   3. Replace any run of non-alphanumeric chars with `-`
 *   4. Collapse repeated `-`, trim leading/trailing `-`
 *   5. Lowercase
 *   6. Cap at `maxLen` (default 80 chars — short enough to leave room for
 *      date prefixes / collision suffixes within filesystem limits)
 *
 * Empty results fall back to `'untitled'` (lowercase variant of
 * `safe_name`'s `'Untitled'` to keep slugs lowercase-only).
 *
 *   slug("Bonjour à toi")             → "bonjour-a-toi"
 *   slug("Some Title — With ¡chars!") → "some-title-with-chars"
 *   slug("")                           → "untitled"
 *
 * @param {string} str
 * @param {object} [opts]
 * @param {number} [opts.maxLen=80]
 * @returns {string}
 */
export function slug(str, opts = {}) {
  const { maxLen = 80 } = opts;
  let s = String(str);

  // ASCII fold via NFKD decomposition + strip combining marks. The range
  // U+0300–U+036F is "Combining Diacritical Marks" (the post-decomposition
  // accents that NFKD detaches from base letters). Written as explicit
  // Unicode escapes so an editor that re-saves this file in NFC (which
  // would attach the marks to the surrounding `[`) can't silently break
  // the regex. Review+ pass 1 finding A#3.
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

  // Strip Obsidian markup characters.
  s = s.replace(/[#|\^\[\]]/g, '');

  // Replace any non-alphanumeric run with a single `-`.
  s = s.replace(/[^a-zA-Z0-9]+/g, '-');

  // Collapse repeated `-`, trim edge `-`.
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');

  s = s.toLowerCase().slice(0, maxLen);
  // Re-trim trailing `-` after truncation — `slice(0, maxLen)` can land on
  // a separator if maxLen falls on a `-` boundary (e.g. 79-char word +
  // ` b` at maxLen=80 → `…word-`). Without this re-trim, the slug
  // violates the "no leading/trailing hyphen" contract documented in the
  // JSDoc. Review+ pass 2 finding G (codex, P3).
  s = s.replace(/^-+|-+$/g, '');
  if (s.length === 0) s = 'untitled';

  return s;
}
