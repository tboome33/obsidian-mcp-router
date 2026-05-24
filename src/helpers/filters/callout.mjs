/**
 * Wrap content in an Obsidian callout block `> [!type] title\n> body`.
 * Direct port of `obsidian-clipper/src/utils/filters/callout.ts` (MIT).
 *
 * Param format (positional, comma-separated, quotes stripped):
 *   `type`            (default `'info'`)
 *   `title`           (optional)
 *   `fold`            (`'true'` → folded `-`, `'false'` → unfolded `+`,
 *                     omit → no fold marker)
 *
 * Example: `callout('Body text', 'warning,Important,true')` →
 *   ```
 *   > [!warning]- Important
 *   > Body text
 *   ```
 *
 * @param {string} str — body content (will be prefixed with `> ` per line)
 * @param {string} [param]
 * @returns {string}
 */
export function callout(str, param) {
  let type = 'info';
  let title = '';
  let foldState = null;

  if (param != null) {
    let p = String(param);
    p = p.replace(/^\((.*)\)$/, '$1');
    const params = p
      .split(/,(?=(?:(?:[^"']*["'][^"']*["'])*[^"']*$))/)
      .map((x) => x.trim().replace(/^(['"])([\s\S]*)\1$/, '$2'));
    if (params.length > 0 && params[0]) type = params[0];
    if (params.length > 1 && params[1]) title = params[1];
    if (params.length > 2) {
      const f = params[2].toLowerCase();
      if (f === 'true') foldState = '-';
      else if (f === 'false') foldState = '+';
    }
  }

  let header = `> [!${type}]`;
  if (foldState) header += foldState;
  if (title) header += ` ${title}`;

  const body = String(str)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  return `${header}\n${body}`;
}
