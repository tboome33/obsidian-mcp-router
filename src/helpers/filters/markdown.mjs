/**
 * Convert HTML to markdown. Clipper's `markdown.ts` delegates to
 * `createMarkdownContent` from the `defuddle/full` package, which the
 * router does NOT bundle (defuddle is invoked separately via `WebFetch`
 * in the `defuddle` skill — see `skills/defuddle/SKILL.md`).
 *
 * To keep the filter library dep-free, this implementation is a
 * **simplified HTML→md converter** covering the most common cases. It
 * is NOT a full-fidelity port of Clipper's defuddle-backed behavior.
 *
 * Covered:
 *   - `<h1>` to `<h6>` → `#` through `######`
 *   - `<p>` → paragraph (double newline)
 *   - `<br>` → soft break (newline)
 *   - `<strong>` / `<b>` → `**bold**`
 *   - `<em>` / `<i>` → `*italic*`
 *   - `<code>` (inline) → `` `code` ``
 *   - `<pre><code>...</code></pre>` → fenced block
 *   - `<a href="...">text</a>` → `[text](url)`
 *   - `<img src="..." alt="...">` → `![alt](src)`
 *   - `<ul><li>` → `- item`
 *   - `<ol><li>` → `1. item` (rough — doesn't preserve start attribute)
 *   - `<blockquote>` → `> body`
 *   - HTML entities decoded (`&amp; &lt; &gt; &quot; &#39; &nbsp;` + numeric)
 *   - All other tags stripped
 *
 * NOT covered (require a real HTML parser):
 *   - Nested lists with proper indentation
 *   - `<table>` (use the `table` filter on parsed JSON instead)
 *   - Definition lists (`<dl>`)
 *   - Inline style preservation (`<span style>`)
 *
 * For high-fidelity webpage→markdown conversion, the wiki-ingest skill
 * uses defuddle via WebFetch directly — that's the canonical path.
 *
 * @param {string} str — HTML
 * @returns {string} — markdown
 */
export function markdown(str) {
  let s = String(str);

  // Code blocks first (preserve inner content verbatim).
  s = s.replace(
    /<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (_m, code) => '\n\n```\n' + decodeEntitiesPreserveWhitespace(code) + '\n```\n\n',
  );

  // Headings
  for (let i = 6; i >= 1; i--) {
    const re = new RegExp(`<h${i}\\b[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
    s = s.replace(re, (_m, inner) => '\n\n' + '#'.repeat(i) + ' ' + stripInner(inner) + '\n\n');
  }

  // Inline elements
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `**${stripInner(inner)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `*${stripInner(inner)}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => '`' + stripInner(inner) + '`');

  // Links + images (attribute-aware regex copied from link-extractor pattern)
  s = s.replace(
    /<a\b(?:[^>"']|"[^"]*"|'[^']*'){0,1024}>([\s\S]*?)<\/a>/gi,
    (m, inner) => {
      const hrefMatch = /(?:^|\s)href\s*=\s*(["'])((?:(?!\1).)*)\1/i.exec(m);
      const href = hrefMatch ? hrefMatch[2] : '';
      return `[${stripInner(inner)}](${href})`;
    },
  );
  s = s.replace(
    /<img\b(?:[^>"']|"[^"]*"|'[^']*'){0,1024}\/?>/gi,
    (m) => {
      const srcMatch = /(?:^|\s)src\s*=\s*(["'])((?:(?!\1).)*)\1/i.exec(m);
      const altMatch = /(?:^|\s)alt\s*=\s*(["'])((?:(?!\1).)*)\1/i.exec(m);
      const src = srcMatch ? srcMatch[2] : '';
      const alt = altMatch ? altMatch[2] : '';
      return `![${alt}](${src})`;
    },
  );

  // Lists. Naive — doesn't handle nesting properly.
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) => {
    const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
    return '\n' + items.map((i) => `- ${stripInner(i[1])}`).join('\n') + '\n';
  });
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
    const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
    return '\n' + items.map((it, i) => `${i + 1}. ${stripInner(it[1])}`).join('\n') + '\n';
  });

  // Blockquote
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => {
    const stripped = stripInner(inner);
    return '\n' + stripped.split('\n').map((l) => `> ${l}`).join('\n') + '\n';
  });

  // Paragraphs + breaks
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner) => '\n\n' + stripInner(inner) + '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, '');

  // Decode entities + collapse whitespace
  s = decodeEntities(s);
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s;
}

function stripInner(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeEntitiesPreserveWhitespace(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}
