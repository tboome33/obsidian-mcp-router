/**
 * A vault's name INSIDE Obsidian — the label `obsidian://open?vault=` expects.
 *
 * It is not the router's canonical name: the router slugs `Roland` to `roland`
 * and may register a remote vault under any name at all (`router` for the
 * desktop vault called « opsidian-mcp-router et bridge »). For a local vault
 * the label is the folder's basename, on-disk casing kept. For a remote vault
 * nothing on this side can know it, so the config says it (`obsidianName`).
 *
 * Two consumers, one rule: the registry validates a declared `obsidianName`
 * when it loads the config, and the view-link transport validates whatever it
 * is about to send as `obsidian_name` — including a basename it derived
 * itself — so a value the loader never saw cannot reach the wire unchecked.
 */
import path from 'node:path';
import { isWindowsPath } from './vault-path-identity.mjs';

export const OBSIDIAN_NAME_MAX_LENGTH = 255;

// C0 controls, DEL and C1 controls. Built from code points so the source file
// carries no raw control byte (and no escape a shell could eat).
const CONTROL_RE = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f)
    + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f) + ']',
);

// What Python's `str.strip()` removes — the view-agent's test is
// `name == name.strip()`. Measured on CPython 3.12 (every code point for which
// `chr(i).isspace()`), not taken from JS `trim()`: that one also strips U+FEFF,
// which Python keeps, so borrowing it would refuse a label the agent accepts.
const PYTHON_STRIP = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/**
 * True when `v` can be a vault label: a non-blank string of at most 255
 * UTF-16 units, with no control character and no path separator — an
 * Obsidian vault is a folder, and a folder name holds neither `/` nor `\`.
 *
 * Never looser than the view-agent, which refuses the whole `/view` request
 * with a 400 when `obsidian_name` fails ITS rule — and it validates the hints
 * before it classifies the vault, so one bad label also costs the `rest` hint
 * that would have found a container vault. Two gaps closed against its
 * `normalize_hints`: a label with surrounding whitespace (the agent requires
 * `name == name.strip()` — see PYTHON_STRIP), and a lone surrogate, which is
 * not text — `URLSearchParams` would put U+FFFD on the wire in its place, i.e.
 * a name other than the one configured.
 * @param {unknown} v
 * @returns {boolean}
 */
export function isValidObsidianName(v) {
  if (typeof v !== 'string') return false;
  // Empty only: a whitespace-only label is refused by the edge check below,
  // with Python's notion of whitespace (JS trim() would also refuse U+FEFF).
  if (v.length === 0) return false;
  if (PYTHON_STRIP.has(v.charCodeAt(0)) || PYTHON_STRIP.has(v.charCodeAt(v.length - 1))) return false;
  if (!v.isWellFormed()) return false;
  if (v.length > OBSIDIAN_NAME_MAX_LENGTH) return false;
  if (CONTROL_RE.test(v)) return false;
  if (v.includes('/') || v.includes('\\')) return false;
  return true;
}

/**
 * Path basename with EXACT case preserved — used to derive `obsidianName`
 * for `obsidian://open?vault=<name>` URIs.
 *
 * Why a separate helper from `defaultNameFromPath` (registry.mjs):
 *  - `defaultNameFromPath` lowercases + strips leading dot to produce a
 *    router slug (`.template` → `template`, `Roland` → `roland`). Slugs
 *    are stable identifiers across portRegistry/vaultNames maps.
 *  - `pathBasename` preserves the on-disk casing because Obsidian's URI
 *    handler is case-sensitive about the vault label: `obsidian://open?vault=Roland`
 *    works, `obsidian://open?vault=roland` may not match the registered
 *    vault title in the Obsidian config (depends on platform / how the
 *    vault was first opened).
 *
 * Returns the empty string for falsy input — matches `defaultNameFromPath`.
 *
 * Cross-platform detection identical to `defaultNameFromPath`: Windows-style
 * paths route to `path.win32.basename` regardless of runtime, so a CI matrix
 * on Linux reading a Windows-paths config still produces the right result.
 */
export function pathBasename(p) {
  if (!p || typeof p !== 'string') return '';
  return (isWindowsPath(p) ? path.win32 : path.posix).basename(p);
}

/**
 * The Obsidian label for a resolved vault descriptor, or null when none is
 * known. A declared `obsidianName` wins; otherwise a vault with a local `path`
 * uses that folder's basename. The result is validated either way.
 * @param {object} vault   a registry descriptor
 * @returns {string|null}
 */
export function obsidianNameFor(vault) {
  if (!vault || typeof vault !== 'object') return null;
  if (vault.obsidianName !== undefined && vault.obsidianName !== null) {
    return isValidObsidianName(vault.obsidianName) ? vault.obsidianName : null;
  }
  const base = pathBasename(vault.path);
  return isValidObsidianName(base) ? base : null;
}
