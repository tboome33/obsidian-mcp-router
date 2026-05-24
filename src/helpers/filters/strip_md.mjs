/**
 * Strip markdown formatting and return plain text. Direct port of
 * `obsidian-clipper/src/utils/filters/strip_md.ts` (MIT).
 *
 * Handles: images, links (kept text), URLs, bold/italic, highlights,
 * headers, inline code, code blocks, strikethrough, task lists, list
 * items, horizontal rules, blockquotes, tables, sub/superscript, emoji
 * shortcodes, raw HTML, footnote refs, abbreviations, wikilinks.
 *
 * @param {string} str
 * @returns {string}
 */
export function strip_md(str) {
  let s = String(str);

  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');           // images
  s = s.replace(/!\[\[([^\]]+)\]\]/g, '');                // embed wikilinks
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');          // links → keep text
  s = s.replace(/https?:\/\/\S+/g, '');                   // bare URLs
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');               // bold
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');                  // italic
  s = s.replace(/==(.*?)==/g, '$1');                      // highlights
  s = s.replace(/^#+\s+/gm, '');                          // headers
  s = s.replace(/`([^`]+)`/g, '$1');                      // inline code
  s = s.replace(/```[\s\S]*?```/g, '');                   // code blocks
  s = s.replace(/~~(.*?)~~/g, '$1');                      // strikethrough
  s = s.replace(/^[-*+] (\[[x ]\] )?/gm, '');             // task lists / list items
  s = s.replace(/^([-*_]){3,}\s*$/gm, '');                // horizontal rules
  s = s.replace(/^>\s+/gm, '');                           // blockquotes
  // Tables: anchor the regex to full lines so a paragraph containing
  // pipes (math `P(A|B)`, regex `[a|b]`, CLI `cmd | grep`) doesn't
  // get its middle segment silently erased. Pre-v0.13.6 the unanchored
  // pattern was a port-of-Clipper-bug that we now diverge from.
  // Reviewer A finding F3. v0.13.7 hardening (codex finding H): allow
  // 0-3 leading spaces (or a tab) per the markdown spec, which permits
  // up to 3 spaces before block-level syntax — so `  | a | b |` IS a
  // valid (indented) table row that should be stripped.
  s = s.replace(/^[ \t]{0,3}\|.*\|\s*$/gm, '');           // tables (indented up to 3 spaces / 1 tab)
  s = s.replace(/([~^])(\w+)\1/g, '$2');                  // sub/superscript
  s = s.replace(/:[a-z_]+:/g, '');                        // emoji shortcodes
  s = s.replace(/<[^>]+>/g, '');                          // raw HTML
  s = s.replace(/\[\s*\]/g, '');                          // empty []
  s = s.replace(/\[\^[^\]]+\]/g, '');                     // footnote refs
  s = s.replace(/^\*\[[^\]]+\]:.+$/gm, '');               // abbreviations
  s = s.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, p1, p2) => p2 || p1); // wikilinks

  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
