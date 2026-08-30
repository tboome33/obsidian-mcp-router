/**
 * "Are these two strings the same vault?" — the PURE answer.
 *
 * Extracted from `src/registry.mjs` (where both functions lived, module-private)
 * so `src/helpers/port-registry.mjs` can answer the same question without
 * importing the registry — which imports it, and would close a cycle. Nothing
 * about the logic changed in the move; the registry keeps exporting
 * `normalizePathForCompare` through its `_internals` so existing tests still
 * reach it by the same name.
 *
 * WHY A THIRD COPY WAS NOT WRITTEN. `scripts/path-helpers.mjs` already answers
 * this question too, with `samePath` / `canonicalPath` — but it answers it by
 * asking the FILESYSTEM (`fs.realpathSync.native`), which is strictly better
 * when the paths exist and is the right tool inside the CLI. It is the wrong
 * tool here: this module must stay pure so the port helpers can run against
 * fixtures, on a machine where none of the fleet's drives are mounted. Two
 * implementations, two justified domains, one shared definition each — rather
 * than the fourth inline `toLowerCase()` that a hurried edit would have added.
 *
 * WHAT IT PREVENTS, concretely. `C:\VAULTS\Kiviri Stack` and
 * `C:\VAULTS\KIVIRI STACK` are ONE directory on NTFS. A config that spells the
 * reference vault one way and its registry key the other would otherwise look
 * like two vaults fighting over one port — a false collision alarm, reported at
 * router startup, about a fleet that is perfectly healthy. Measured on the real
 * 27-vault fleet on 2026-08-30: exactly this pair showed up as a phantom
 * duplicate on 27141 before the paths were folded.
 */
import path from 'node:path';

/**
 * True when the string LOOKS like a Windows path, whatever the runtime is.
 *
 * Detection is structural on purpose: `portRegistry` stores Windows paths
 * verbatim, and a CI runner on Linux loading that config must still treat `\`
 * as a separator rather than a literal character.
 *
 * Recognized:
 *   - Drive-letter:           `C:\VAULTS\X`, `C:/VAULTS/X`
 *   - UNC (network share):    `\\server\share\Vault`
 *   - Extended-length prefix: `\\?\C:\path`, `\\?\UNC\server\share\path`
 */
export function isWindowsPath(p) {
  if (!p || typeof p !== 'string') return false;
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

/**
 * Normalize a path for equality comparison, robust across OSes.
 *
 * Windows paths are normalized via `path.win32` and lowercased
 * (NTFS / SMB are case-insensitive). POSIX paths are normalized via
 * `path.posix` and case is preserved (POSIX file systems are
 * case-sensitive).
 */
export function normalizePathForCompare(p) {
  if (!p) return p;
  const isWindowsStyle = isWindowsPath(p);
  const lib = isWindowsStyle ? path.win32 : path.posix;
  let n = lib.normalize(p);
  // Strip a trailing separator except for the root marker itself. For UNC
  // the "root" is `\\server\share`, longer than 3 chars, so the >3 guard is
  // safe but a UNC of just `\\s\s` (5 chars) would still be trimmed past
  // the separator — acceptable since we only use this for vault paths,
  // which are always deeper than the share root.
  const sep = isWindowsStyle ? '\\' : '/';
  while (n.length > 3 && (n.endsWith(sep) || n.endsWith('/'))) {
    n = n.slice(0, -1);
  }
  if (isWindowsStyle) n = n.toLowerCase();
  return n;
}

/** True when two strings denote the same vault, without touching the disk. */
export function sameVaultPath(a, b) {
  if (!a || !b) return false;
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}
