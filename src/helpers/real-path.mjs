/**
 * real-path.mjs — the path AS THE FILESYSTEM KNOWS IT, even when the tail does
 * not exist yet.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NOT `realpathSync` WITH A try/catch
 * ---------------------------------------------------------------------------
 * Three guards in this repository ask the same question — "which real directory
 * is this string actually pointing at?" — and all must keep answering it for a
 * path that has not been created yet:
 *
 *   - the ASSET CONTAINMENT check (`helpers/vault-reach.mjs`), deciding whether
 *     an `outputDir` a tool is about to create lands inside a vault;
 *   - the DOTENV LOCK KEY (`helpers/dotenv-writer.mjs`), so two spellings of
 *     one file take one lock;
 *   - the MD_ALLOWED_PATHS sandbox (`markdownify/utils.mjs`
 *     `assertPathAllowed`), which had the same lexical fallback and let an
 *     output directory created under a symlink escape the sandbox.
 *
 * Both used a `realpathSync` with a fallback to the LEXICAL `path.resolve` when
 * it threw. That fallback is where the hole was: a junction `alias` pointing at
 * a protected vault, plus a child `alias/new-assets` that does not exist yet,
 * makes `realpathSync` throw on the child — and the lexical answer keeps the
 * word `alias`, which does not start with the vault's own spelling. The
 * containment check therefore said "this belongs to no vault", the write tier
 * and the shared-vault precondition never ran, and the very first
 * `download_page_assets` call wrote inside a vault the workspace had declared
 * read-only STRICT. The SECOND call was refused, because by then the directory
 * existed and `realpathSync` succeeded — a gate that lets the first write
 * through and stops the rest is the worst of both worlds: it looks enforced.
 * (Codex, whole-lot review of the six phases, 2026-09-06.)
 *
 * So: walk UP to the nearest ancestor that does exist, resolve THAT with the
 * filesystem, and re-append the segments that do not exist yet. A junction
 * anywhere along the existing part is then folded, whatever the tail is.
 *
 * The dotenv writer had a one-level version of this idea (resolve the file,
 * else its parent). One level is enough for a `.env` whose directory exists and
 * not enough for anything deeper, and two implementations of one question is
 * the shape this repository keeps paying for — hence one definition, imported
 * by both.
 *
 * Node builtins plus the pure prefix folder: this module is on the start-up
 * path through the dotenv writer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stripExtendedPathPrefix } from './vault-path-identity.mjs';

/**
 * The real path of `p`, resolving symlinks and junctions as far as the
 * filesystem can, and keeping whatever tail does not exist yet.
 *
 * Never throws: a path whose every ancestor is unreadable comes back
 * lexically resolved, which is what the callers had before and is still the
 * only answer available then.
 *
 * @param {string} p
 * @returns {string} an absolute path
 */
export function realPathWithMissingTail(p) {
  // The extended-length prefix is FOLDED, never stripped blindly: `\\?\UNC\
  // server\share\x` has to become `\\server\share\x`, and a four-character
  // strip makes it the RELATIVE `UNC\server\share\x`, which `path.resolve`
  // then anchors in the current directory.
  let current = path.resolve(stripExtendedPathPrefix(String(p)));
  const missing = [];

  // Bounded by the path's own depth: `path.dirname` of a root returns the root
  // itself, which is the loop's stop condition.
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length ? path.join(real, ...missing) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Not even the root resolved — an unmounted drive, or a permission
        // error all the way up. The lexical answer is all there is.
        return path.resolve(stripExtendedPathPrefix(String(p)));
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Is `real` the directory `root` or below it — both ALREADY real paths (from
 * realPathWithMissingTail, or a pin's handle), compared EXACTLY, case included.
 *
 * Not `path.relative`: on Windows it lowercases both sides before comparing,
 * and an NTFS directory can have case sensitivity turned on, where `Root` and
 * `root` are two distinct siblings — a target under `root` then passed as
 * being inside the known root `Root` (Codex review, round 4, on
 * provision_vault). On Windows both sides come from the same resolution,
 * which returns the on-disk spelling of every existing component and keeps a
 * missing tail as written, so the exact comparison refuses nothing NTFS does
 * not also distinguish — except a missing tail written in another case than
 * the root that contains it. Elsewhere the realpath does NOT recover the
 * stored spelling: on a Linux case-folding directory (ext4 casefold) glibc
 * copies components as given, so `root/child` under a configured `Root` is
 * refused although the filesystem names one directory (Codex review,
 * round 5 — as the POSIX `path.relative` did before). Every such case is a
 * REFUSAL, never an escape: the comparison only ever says "inside" for a
 * string that starts with the root's exact spelling. A plain prefix on the
 * separator boundary also keeps a child named `..cache` inside, where
 * `rel.startsWith('..')` threw it out.
 *
 * @param {string} real
 * @param {string} root
 * @returns {boolean}
 */
export function isInsideRealPath(real, root) {
  if (typeof real !== 'string' || typeof root !== 'string' || real === '' || root === '') return false;
  const t = path.resolve(real);
  const r = path.resolve(root);
  if (t === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(prefix);
}
