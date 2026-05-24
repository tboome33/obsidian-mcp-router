/**
 * Format a URL (or JSON of URLs) as markdown image syntax `![alt](url)`.
 * Port of `obsidian-clipper/src/utils/filters/image.ts` (MIT), without
 * the upstream `escapeMarkdown` dep — replaced with a minimal inline
 * escape of the 4 characters that break the markdown image syntax
 * (`[`, `]`, `(`, `)`).
 *
 * Param: optional alt text. Outer parens/quotes tolerated.
 *
 *   image("http://example.com/x.png")              → "![](http://example.com/x.png)"
 *   image("http://example.com/x.png", "logo")      → "![logo](http://example.com/x.png)"
 *   image('["a.png","b.png"]')                     → ["![](a.png)", "![](b.png)"]  (array)
 *   image('{"a.png": "alt A"}')                    → ["![alt A](a.png)"]            (object: key=url, value=alt)
 *
 * @param {string} str — URL or JSON of URLs
 * @param {string} [param] — alt text
 * @returns {string|string[]}
 */
export function image(str, param) {
  if (!String(str).trim()) return str;

  let altText = '';
  if (param != null) {
    let p = String(param);
    p = p.replace(/^\((.*)\)$/, '$1');
    altText = p.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }

  try {
    const data = JSON.parse(String(str));

    const processObject = (obj) =>
      Object.entries(obj)
        .flatMap(([key, value]) => {
          if (typeof value === 'object' && value !== null) {
            return processObject(value);
          }
          return `![${escapeMd(String(value))}](${escapeMd(key)})`;
        });

    if (Array.isArray(data)) {
      return data.flatMap((item) => {
        if (typeof item === 'object' && item !== null) {
          return processObject(item);
        }
        return item ? `![${altText}](${escapeMd(String(item))})` : '';
      });
    }
    if (typeof data === 'object' && data !== null) {
      return processObject(data);
    }
  } catch {
    return `![${altText}](${escapeMd(String(str))})`;
  }
  return str;
}

/**
 * Escape the 4 characters that break the markdown image syntax. NOT
 * a full markdown escape — only the syntactic delimiters.
 */
function escapeMd(s) {
  return String(s).replace(/[\[\]()]/g, (c) => '\\' + c);
}
