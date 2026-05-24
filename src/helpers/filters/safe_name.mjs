/**
 * Sanitize a string for use as a filesystem filename, defensive against
 * the union of all major OS forbidden-character rules. Ported from
 * obsidian-clipper's `src/utils/filters/safe_name.ts` (MIT, kepano/Obsidian).
 *
 * The default mode applies the most conservative ruleset (intersection of
 * Windows + macOS + Linux restrictions + Obsidian-specific characters).
 * Pass `'windows'` / `'mac'` / `'linux'` to target a single OS only.
 *
 * Always-stripped (any OS):
 *   - Obsidian markup that breaks wikilink parsing: `# | ^ [ ]`
 *   - Control characters 0x00-0x1F
 *
 * Windows-specific:
 *   - Forbidden chars: `< > : " / \ | ? *`
 *   - Reserved device names (CON, PRN, AUX, NUL, COM0-9, LPT0-9) get `_` prefix
 *   - Trailing spaces and dots stripped (Windows quirk)
 *
 * macOS / Linux:
 *   - `/` always forbidden (path separator)
 *   - Leading `.` becomes `_` (hidden-file convention)
 *
 * @param {string} str — input filename candidate
 * @param {string} [os] — `'windows'` | `'mac'` | `'linux'` | undefined for default
 * @returns {string} — sanitized filename, capped at 245 chars (leaves room
 *                    for ` 1.md` collision suffix), `'Untitled'` if empty.
 */
export function safe_name(str, os) {
  const mode = os ? String(os).toLowerCase().trim() : 'default';
  let sanitized = String(str);

  // Always strip Obsidian-breaking chars first.
  sanitized = sanitized.replace(/[#|\^\[\]]/g, '');

  switch (mode) {
    case 'windows':
      sanitized = sanitized
        .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '')
        .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '_$1$2')
        .replace(/[\s.]+$/, '');
      break;
    case 'mac':
      sanitized = sanitized.replace(/[\/:\x00-\x1F]/g, '').replace(/^\./, '_');
      break;
    case 'linux':
      sanitized = sanitized.replace(/[\/\x00-\x1F]/g, '').replace(/^\./, '_');
      break;
    default:
      // Conservative union of all rules.
      sanitized = sanitized
        .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '')
        .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '_$1$2')
        .replace(/[\s.]+$/, '')
        .replace(/^\./, '_');
      break;
  }

  sanitized = sanitized.replace(/^\.+/, '').slice(0, 245);

  // Re-apply the Windows-specific guards AFTER trimming/slicing so inputs
  // like `'CON '` (whose trailing space initially bypassed the reserved-
  // name regex, then got stripped by the trailing-dot/space pass — leaving
  // a bare `'CON'`) and post-truncate strings that end on `.` or whitespace
  // are still rejected. Without this re-pass, the cross-OS safety contract
  // returns names Windows actually rejects. Review+ pass 1 finding B#B
  // (codex, proven by exec: `safe_name('CON ')` was returning `'CON'`).
  if (mode === 'windows' || mode === 'default') {
    sanitized = sanitized.replace(/[\s.]+$/, '');
    sanitized = sanitized.replace(
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i,
      '_$1$2',
    );
  }

  if (sanitized.length === 0) sanitized = 'Untitled';
  return sanitized;
}
