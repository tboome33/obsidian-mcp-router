/**
 * Strip HTML tags and decode common entities. Optionally keep a
 * comma-separated allow-list of tags. Port of
 * `obsidian-clipper/src/utils/filters/strip_tags.ts` (MIT).
 *
 * Decoded entities (Clipper's set, unchanged):
 *   &nbsp; &amp; &lt; &gt; &quot; &#39;
 *   &ldquo; &rdquo; &lsquo; &rsquo;
 *   &mdash; &ndash; &hellip;
 *   &#NNN; (decimal)  &#xHH; (hex)
 *
 * @param {string} html
 * @param {string} [keepTags] — comma-separated tag names to preserve,
 *                             e.g. `'a,img,strong'`. Outer parens/quotes
 *                             tolerated (Clipper template-arg convention).
 * @returns {string}
 */
export function strip_tags(html, keepTags = '') {
  let keep = String(keepTags || '');
  keep = keep.replace(/^\((.*)\)$/, '$1');
  keep = keep.replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/\\(['"])/g, '$1');
  const keepList = keep.split(',').map((t) => t.trim()).filter(Boolean);

  let out = String(html);
  if (keepList.length === 0) {
    out = out.replace(/<\/?[^>]+(>|$)/g, '');
  } else {
    const escaped = keepList.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const re = new RegExp(`<(?!\\/?(?:${escaped})\\b)[^>]+>`, 'gi');
    out = out.replace(re, '');
  }

  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}
