/**
 * semver-compare.mjs
 *
 * Tiny semver comparison helper. Used by hooks/check-router-update.mjs
 * to decide whether the version reported by GitHub is newer than the
 * locally installed one. Intentionally narrow — handles `X.Y.Z` and
 * `X.Y.Z-prerelease` only (no build metadata, no complex prerelease
 * ordering beyond "X.Y.Z-anything is older than X.Y.Z").
 */

/**
 * Parse a semver string into `{ major, minor, patch, prerelease }`.
 * Returns `null` for unparseable input.
 *
 * Examples:
 *   parseSemver("0.10.2")        → { major: 0, minor: 10, patch: 2, prerelease: '' }
 *   parseSemver("1.0.0-alpha.1") → { major: 1, minor: 0,  patch: 0, prerelease: 'alpha.1' }
 *   parseSemver("v0.10.2")       → { major: 0, minor: 10, patch: 2, prerelease: '' }
 *   parseSemver("not-semver")    → null
 */
export function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().replace(/^v/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] || '',
  };
}

/**
 * Compare two semver strings. Returns:
 *   - negative number if a < b
 *   - 0 if a == b
 *   - positive number if a > b
 *
 * If either is unparseable, returns 0 (caller should fall back to "up
 * to date" behavior so a bad version doesn't surface a fake update
 * notice).
 *
 * Prerelease rule (narrow on purpose): any prerelease suffix makes a
 * version OLDER than the same X.Y.Z without suffix. We don't sort
 * across multiple prereleases of the same X.Y.Z (e.g., alpha.1 vs
 * alpha.2 returns 0). Use a real semver library if you need that.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // Both have the same X.Y.Z. Prerelease handling:
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  return 0;
}
