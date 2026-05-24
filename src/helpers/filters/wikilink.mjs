/**
 * Format a string as an Obsidian wikilink `[[basename]]` or
 * `[[basename|alias]]`. Simplified port of obsidian-clipper's
 * `src/utils/filters/wikilink.ts` (MIT) — the JSON-input branch from
 * Clipper (used by their template engine to wrap arrays of links) is
 * dropped because the router has no template engine consumer for it yet.
 * Add it back when Phase G ships the rest of the filter library.
 *
 *   wikilink("foo")          → "[[foo]]"
 *   wikilink("foo", "bar")   → "[[foo|bar]]"
 *   wikilink("")             → ""              (empty stays empty)
 *   wikilink("  ")           → "  "            (whitespace-only stays as-is)
 *
 * The alias param may be wrapped in `("...")` or `('...')` — both forms are
 * unwrapped (matches Clipper's template-arg convention).
 *
 * @param {string} str — basename (no `.md` extension expected)
 * @param {string} [alias] — optional display alias
 * @returns {string} — formatted wikilink, or input unchanged if blank
 */
export function wikilink(str, alias) {
  const input = String(str);
  if (!input.trim()) return input;

  let resolvedAlias = '';
  if (alias != null) {
    let a = String(alias);
    // Strip outer parens then surrounding quotes (matches Clipper).
    a = a.replace(/^\((.*)\)$/, '$1');
    a = a.replace(/^(['"])([\s\S]*)\1$/, '$2');
    resolvedAlias = a;
  }

  return resolvedAlias ? `[[${input}|${resolvedAlias}]]` : `[[${input}]]`;
}
