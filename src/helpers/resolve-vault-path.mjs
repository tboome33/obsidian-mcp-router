/**
 * resolve-vault-path — verify/repair a vault-relative path against the LOCAL
 * vault on disk, so build_open_link never emits a URL for a file that isn't
 * there.
 *
 * The click-to-open URL builder (`buildClickToOpenUrl`) URL-encodes whatever
 * path it's handed — garbage in, garbage out. That let a wrong path (e.g. an
 * invented sub-folder) produce a well-formed URL that 404s at the bridge. This
 * helper closes that gap deterministically: build_open_link calls it first and
 * either gets a verified path, an auto-corrected one (unique basename match),
 * or a clear miss it can surface as an error — but never a dead URL.
 *
 * Local vaults only. A remote vault has no local disk to stat, so we return
 * `unverifiable` and the caller falls back to its pre-existing behaviour (which
 * already yields a null URL for remote vaults anyway). Filesystem-only (no REST
 * call), mirroring how click-to-open.mjs reads data.json off disk — fast, works
 * offline, no new network dependency.
 *
 * Verdicts:
 *   { status: 'ok',                   path }         exact path exists
 *   { status: 'corrected',            path, from }   exact miss, UNIQUE basename match
 *   { status: 'ambiguous',            matches }      exact miss, >1 basename match
 *   { status: 'not_found' }                          exact miss, PROVEN absent
 *   { status: 'resolution_incomplete' }              scan hit its budget before
 *                                                    uniqueness could be proven
 *   { status: 'unverifiable' }                       remote vault / no path → skip
 *
 * `resolution_incomplete` matters for correctness: if the basename walk is
 * truncated (huge vault), a "0 matches so far" is NOT proof of absence and a
 * "1 match so far" is NOT proof of uniqueness — so we must not claim not_found
 * or corrected. Only a DEFINITIVE ≥2 match (ambiguity settled early) or a
 * COMPLETE scan yields those verdicts.
 */

import fs from 'node:fs';
import path from 'node:path';

// Directories never worth walking for a user-facing note basename. `.`-prefixed
// dirs (`.obsidian`, `.git`, `.trash`) are skipped wholesale.
const EXCLUDED_DIRS = new Set(['node_modules']);
// Hard cap on files scanned during a basename walk — a runaway-vault backstop.
// A miss is already the slow path (rare); this bounds worst case.
const MAX_SCAN = 20000;

/**
 * Pick the path library (win32 vs posix) matching the STYLE of the stored
 * vault path, not the runtime's. The registry stores Windows paths verbatim
 * even on a POSIX runtime (CI matrix) — same structural detection as
 * click-to-open.mjs::readInsecurePortConfig.
 */
function libFor(vaultPath) {
  const isWindowsStyle = /^[A-Za-z]:[\\/]/.test(vaultPath) || /^\\\\/.test(vaultPath);
  return isWindowsStyle ? path.win32 : path.posix;
}

function toAbs(lib, root, relPosix) {
  // relPosix uses '/'; convert to the target lib's separator before joining.
  return lib.join(root, relPosix.split('/').join(lib.sep));
}

/**
 * @param {object} vault - registry vault descriptor (needs type:'local' + path).
 * @param {string} relPath - vault-relative path (slashes `/` or `\`).
 * @returns {{status:string, path?:string, from?:string, matches?:string[]}}
 */
export function resolveVaultPathOnDisk(vault, relPath) {
  if (!vault || vault.type !== 'local' || !vault.path || !relPath || typeof relPath !== 'string') {
    return { status: 'unverifiable' };
  }
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return { status: 'unverifiable' };

  const lib = libFor(vault.path);

  // 1. Exact path (file OR folder — folders are openable too).
  try {
    if (fs.existsSync(toAbs(lib, vault.path, rel))) {
      return { status: 'ok', path: rel };
    }
  } catch {
    // stat error (permissions, bad path) → treat as a miss, try basename.
  }

  // 2. Basename fallback — find files sharing the leaf name anywhere in the vault.
  const slash = rel.lastIndexOf('/');
  const basename = slash === -1 ? rel : rel.slice(slash + 1);
  if (!basename) return { status: 'not_found' };

  let matches;
  let truncated;
  try {
    ({ matches, truncated } = findByBasename(vault.path, lib, basename));
  } catch {
    return { status: 'resolution_incomplete' };
  }
  // ≥2 is definitive ambiguity regardless of truncation. Otherwise a truncated
  // scan can't prove uniqueness (1) or absence (0) → resolution_incomplete.
  if (matches.length >= 2) return { status: 'ambiguous', matches };
  if (truncated) return { status: 'resolution_incomplete' };
  if (matches.length === 1) return { status: 'corrected', path: matches[0], from: rel };
  return { status: 'not_found' };
}

/**
 * Iterative DFS over the vault, collecting vault-relative paths of files whose
 * basename === `basename`. Skips dot-dirs and node_modules; does not follow
 * symlinked directories (readdirSync withFileTypes reports symlinks as
 * symlinks, not directories, so they're never recursed into). Stops early once
 * a second match is found (ambiguity is decided) or MAX_SCAN is hit.
 *
 * @returns {{ matches: string[], truncated: boolean }} `truncated` is true when
 *   the MAX_SCAN budget was exhausted before the walk finished — the caller
 *   must then treat a <2-match result as `resolution_incomplete`, not proof.
 */
function findByBasename(root, lib, basename) {
  const out = [];
  const stack = ['']; // vault-relative directories to visit
  let scanned = 0;
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = relDir ? toAbs(lib, root, relDir) : root;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++scanned > MAX_SCAN) return { matches: out, truncated: true };
      const name = e.name;
      const relChild = relDir ? `${relDir}/${name}` : name;
      if (e.isDirectory()) {
        if (!name.startsWith('.') && !EXCLUDED_DIRS.has(name)) stack.push(relChild);
      } else if (name === basename) {
        out.push(relChild);
        if (out.length >= 2) return { matches: out, truncated: false }; // ambiguity settled
      }
    }
  }
  return { matches: out, truncated: false };
}
