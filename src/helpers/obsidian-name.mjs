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

/**
 * True when `v` can be a vault label: a non-blank string of at most 255
 * UTF-16 units, with no control character and no path separator — an
 * Obsidian vault is a folder, and a folder name holds neither `/` nor `\`.
 * @param {unknown} v
 * @returns {boolean}
 */
export function isValidObsidianName(v) {
  if (typeof v !== 'string') return false;
  if (v.trim().length === 0) return false;
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
