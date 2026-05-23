/**
 * Path-comparison helpers shared between setup-vault.mjs and its tests.
 *
 * Extracted to a module of its own because setup-vault.mjs is a CLI
 * script with top-level `process.argv` parsing — importing it directly
 * would execute the CLI as a side-effect. These helpers are pure (no
 * I/O beyond `fs.realpathSync.native`) so unit tests can hit them
 * directly without spawning a subprocess.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve a path to its canonical form, accounting for filesystem
 * case-sensitivity. Used by `samePath` below — see its doc for the
 * full rationale.
 *
 * @param {string} p
 * @returns {string}
 */
export function canonicalPath(p) {
  const resolved = path.resolve(p);
  try {
    // realpathSync.native() returns the real on-disk casing on Windows
    // NTFS (so a lowercased registry entry resolves to whatever the
    // actual directory was created as) and resolves symlinks on POSIX.
    // Throws ENOENT (or EACCES / EBUSY / network errors on UNC) when the
    // path is unreachable — fall through to the heuristic.
    return fs.realpathSync.native(resolved);
  } catch {
    // Path doesn't exist (or is unreadable). Apply a per-platform
    // heuristic that matches each OS's filesystem semantics:
    //   - win32: NTFS is case-insensitive by default. ReFS / FAT* too.
    //   - darwin: APFS volumes are case-insensitive by default (the
    //     case-sensitive APFS variant is rare and used mostly by devs).
    //   - linux: ext4 / btrfs / xfs are case-sensitive.
    // We accept that case-sensitive APFS users will get a too-permissive
    // compare here as long as both sides are non-existent — but if the
    // paths exist, realpathSync.native preserves true semantics above.
    return process.platform === 'win32' || process.platform === 'darwin'
      ? resolved.toLowerCase()
      : resolved;
  }
}

/**
 * Robust same-path comparison: returns true if `a` and `b` point to
 * the same physical directory, accounting for casing and symlinks.
 *
 * Why not just `path.resolve(a) === path.resolve(b)`:
 *   - path.resolve preserves casing, so "C:\VAULTS\.template" and
 *     "c:\vaults\.template" compare unequal even though NTFS treats
 *     them as the same physical directory.
 *   - On POSIX, two different paths can resolve to the same inode via
 *     symlinks; only realpath catches that.
 *
 * Why not just `realpath(a).toLowerCase() === realpath(b).toLowerCase()`:
 *   - On case-sensitive filesystems (Linux ext4/btrfs/xfs, case-sensitive
 *     APFS volumes, Windows directories with per-dir case sensitivity
 *     enabled via `fsutil`), two distinct existing dirs can differ only
 *     by case. Lowercasing both would treat them as identical → false
 *     positive that makes `--sync-all` skip a valid target or makes
 *     `--sync-plugins` refuse it as if it were the reference. Codex P3
 *     pass 2 of the v0.11.2 review.
 *
 * Strategy:
 *   - If realpath succeeds on BOTH inputs: compare the realpath outputs
 *     directly (case-sensitive). The OS-level realpath already folded
 *     the casing on case-insensitive filesystems (so a lowercased input
 *     resolves to the true on-disk casing), and on case-sensitive
 *     filesystems the two distinct dirs come back as distinct strings
 *     — which is what we want.
 *   - If realpath fails on either side (non-existent path, EACCES,
 *     etc.): fall back to the platform's default case-sensitivity
 *     heuristic. Imperfect on case-sensitive APFS / Windows with
 *     per-dir case-sensitivity, but those are dev-only opt-ins and
 *     the alternative (refusing to compare at all) is worse for the
 *     common case of a stale registry entry pointing at a deleted
 *     vault.
 *
 * This bug bit setup-vault.mjs's `--sync-all` self-skip historically:
 * a target in `portRegistry` written with different casing than
 * `referenceVault` would slip past the skip, and `--force` would then
 * `rm -rf` the source's own plugin folder mid-copy. Tests in
 * tests/setup-vault-safety.test.mjs cover the regression.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function samePath(a, b) {
  if (!a || !b) return false;

  const ra = path.resolve(a);
  const rb = path.resolve(b);

  let realA = null;
  let realB = null;
  try { realA = fs.realpathSync.native(ra); } catch { /* path missing/unreadable */ }
  try { realB = fs.realpathSync.native(rb); } catch { /* same */ }

  // Both sides resolved on disk — trust the OS's casing. This correctly
  // distinguishes two case-different existing dirs on case-sensitive
  // volumes (they come back as distinct strings) while still matching
  // case-different inputs that point at the same physical dir on
  // case-insensitive volumes (realpath returns the same canonical
  // casing for both inputs).
  if (realA && realB) {
    return realA === realB;
  }

  // At least one side doesn't exist on disk. Fall back to a per-platform
  // heuristic based on filesystem default case-sensitivity.
  const fallback = (s) =>
    process.platform === 'win32' || process.platform === 'darwin'
      ? s.toLowerCase()
      : s;
  return fallback(realA || ra) === fallback(realB || rb);
}
