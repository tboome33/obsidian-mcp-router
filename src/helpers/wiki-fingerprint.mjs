/**
 * Deterministic fingerprinting for wiki-state-equality checks.
 *
 * Two distinct use cases ship together because they share the canonical
 * hashing primitives:
 *
 * 1. **`canonicalHash(text)`** — for wiki-fold (skill side): hash the
 *    rendered fold body after canonicalisation. If the existing on-disk
 *    fold matches the new hash, skip the write (and the downstream
 *    auto-commit). Implements graphify's `_canonical_topology_for_compare`
 *    pattern for our markdown rollups.
 *
 * 2. **`computeFingerprint(cwd, paths)`** — for the hot-cache hook:
 *    hash a SET of files into one fingerprint. Lets the hook ask "did
 *    anything I care about change since the previous prompt?" with one
 *    string comparison.
 *
 * Both are deterministic (sorted, stable serialisation, fixed hash) so
 * re-running on unchanged input yields the same output every time. That's
 * the contract that makes the "skip write / skip re-prompt" branches
 * trustworthy.
 *
 * Hash choice: SHA-256, truncated to 32 hex chars (128 bits). Plenty for
 * collision-resistance at our scale and short enough to be greppable in
 * logs / sidecar files.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HASH_HEX_LEN = 32; // first 128 bits of SHA-256

/**
 * Canonicalise a string for content-equality comparison.
 *
 * The transformations are deliberately narrow: we want byte-equality on
 * the "meaning" of the content, not pixel-equality. Differences we ignore:
 *   - Trailing whitespace per line
 *   - Trailing blank lines at EOF
 *   - CRLF vs LF line endings (Windows / Unix interop)
 *
 * Differences we PRESERVE:
 *   - Leading whitespace (markdown list indentation matters)
 *   - Blank lines between sections (markdown rendering depends on them)
 *   - Internal whitespace, tab vs space inside a line (rarely benign)
 *
 * If you want a looser comparison (e.g. ignore reorderable list items),
 * canonicalise upstream before calling this — keep the primitive narrow.
 *
 * @param {string} text
 * @returns {string}
 */
export function canonicalise(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '') + '\n';
}

/**
 * Hash a string after canonicalisation.
 *
 * Use for content-equality checks where you have the new content in
 * memory and the old content on disk. Compute `canonicalHash(newContent)`,
 * compare with `canonicalHash(diskContent)`, skip the write if equal.
 *
 * @param {string} text
 * @returns {string} 32-hex-char fingerprint.
 */
export function canonicalHash(text) {
  const canon = canonicalise(text);
  return crypto
    .createHash('sha256')
    .update(canon, 'utf8')
    .digest('hex')
    .slice(0, HASH_HEX_LEN);
}

/**
 * Return true if `newContent` is byte-equivalent (after canonicalisation)
 * to whatever currently exists at `filePath`. Returns false if the file
 * doesn't exist or can't be read — the caller should treat that as
 * "definitely needs writing".
 *
 * Convenience wrapper for the common pattern: "should I skip this write?".
 *
 * @param {string} filePath - Absolute path.
 * @param {string} newContent
 * @returns {boolean}
 */
export function contentIsUnchanged(filePath, newContent) {
  let existing;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  return canonicalHash(existing) === canonicalHash(newContent);
}

/**
 * Compute a single fingerprint for a SET of file paths.
 *
 * The fingerprint is deterministic in:
 *   - The set of paths (sorted lexicographically before hashing)
 *   - The canonicalised content of each path
 *   - The presence-or-absence of each path (empty file ≠ missing file —
 *     deleting an already-empty file STILL changes the fingerprint, so the
 *     hot-cache hook re-fires correctly when an empty wiki note is removed)
 *
 * @param {string} cwd - Project root; paths are resolved relative to this.
 * @param {string[]} relativePaths
 * @returns {string} 32-hex-char fingerprint.
 */
export function computeFingerprint(cwd, relativePaths) {
  const sorted = [...new Set(relativePaths)].sort();
  const hasher = crypto.createHash('sha256');
  for (const rel of sorted) {
    let content = '';
    let presenceMarker = '1'; // present
    try {
      content = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      // File missing → fingerprinted with presenceMarker='0'. Pre-IMP-7
      // (v0.8.11 and earlier) we hashed only the canonical content, which
      // meant deleting an already-empty file produced the SAME hash as not
      // changing it (canonicalise('') === '\n', same as canonicalise of an
      // absent file). The explicit marker breaks that collision.
      presenceMarker = '0';
    }
    hasher.update(rel);
    hasher.update('\0');
    hasher.update(presenceMarker);
    hasher.update('\0');
    hasher.update(canonicalise(content));
    hasher.update('\0');
  }
  return hasher.digest('hex').slice(0, HASH_HEX_LEN);
}

/**
 * Read a fingerprint from a sidecar file. Returns null if the file
 * doesn't exist or is malformed (caller treats both as "no prior state").
 *
 * @param {string} filePath - Absolute path to the fingerprint file.
 * @returns {string|null}
 */
export function readFingerprint(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    // Must look like a 32-hex string. Reject anything else (corrupted file).
    if (/^[0-9a-f]{32}$/.test(content)) return content;
    return null;
  } catch {
    return null;
  }
}

/**
 * Write a fingerprint to a sidecar file. Creates parent directory if
 * missing. Failures are logged to stderr but not thrown — the next call
 * will just re-emit the prompt, which is acceptable degradation.
 *
 * NIT-3 (v0.8.12): pre-v0.8.12 the catch was fully silent, which made
 * "why does the hook re-prompt at every turn for 3 days" hard to
 * diagnose. Now we surface the failure once to stderr so the cause
 * (disk full, permission denied, ENOSPC, etc.) is visible.
 *
 * @param {string} filePath - Absolute path.
 * @param {string} fingerprint
 */
export function writeFingerprint(filePath, fingerprint) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, fingerprint + '\n', 'utf8');
  } catch (err) {
    // Surface the cause to stderr but keep the call non-throwing. The
    // deduplication is a nice-to-have; if it fails, we degrade to
    // "re-prompt every time" which is the pre-v0.8.10 behaviour anyway.
    console.error(
      `[obsidian-mcp-router] writeFingerprint failed for ${filePath}: ${err.code || ''} ${err.message}`.trim(),
    );
  }
}

export const _internals = {
  HASH_HEX_LEN,
};
