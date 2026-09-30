/**
 * Which build of the router is ACTUALLY running — beyond "0.95.0".
 *
 * The marketplace installs the plugin from `main`, not from a tag, and the
 * version string only moves on a release. So "0.95.0" named, on 2026-09-26,
 * any of 64 commits: the copy loaded on the Hermes VM held a script added after
 * the tag and lacked a doc added nine days later — neither the tag nor `main`.
 * The install record could not settle it either: `installed_plugins.json`
 * recorded commit 50ae7bd for files that match a56fd2f.
 *
 * What CAN settle it is the code itself. The fingerprint below hashes the files
 * that define the SERVER's and the HOOKS' behaviour (bin/, src/, hooks/,
 * package.json, .claude-plugin/plugin.json — not skills/ or commands/, whose
 * text two copies can differ in without the fingerprint moving) — git blob
 * ids, line endings normalised —
 * so the same bytes give the same fingerprint on every machine, whether the
 * copy came from a git clone, a zip, or a remote-session sync.
 * `scripts/identify-build.mjs <fingerprint>` walks the repository history and
 * names the commit whose tree produces it, without checking anything out.
 *
 * When the running copy IS a git checkout, its HEAD is reported too — but as a
 * second fact, never instead of the fingerprint: a checkout can carry
 * uncommitted edits, which the fingerprint sees and HEAD does not.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Roots whose files make up the fingerprint (directories walked recursively). */
export const FINGERPRINT_ROOTS = Object.freeze(['bin', 'src', 'hooks', 'package.json', '.claude-plugin/plugin.json']);

/** Line endings folded to LF: a Windows checkout with autocrlf must not change the answer. */
export function normaliseEol(buf) {
  return Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary');
}

/** git's blob id for these bytes. */
export function gitBlobId(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * The fingerprint of a list of `{path, blob}` pairs (posix paths, git blob ids).
 * Order-independent. Exposed so the identify script can compute it from
 * `git ls-tree` output without touching the working tree.
 */
export function fingerprintFromEntries(entries) {
  const lines = entries
    .filter((e) => e && typeof e.path === 'string' && typeof e.blob === 'string')
    .map((e) => `${e.path}\t${e.blob}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/**
 * True when a posix path is part of the fingerprint: under one of the roots,
 * and with no segment the disk walk skips. The SAME rule on both sides —
 * otherwise a tracked file named like clutter would be counted by the tree
 * and skipped on disk, and no checkout could ever match its commit.
 */
export function underFingerprintRoots(p) {
  if (!FINGERPRINT_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) return false;
  return !p.split('/').some((seg) => NEVER_BUILD.test(seg));
}

/**
 * Names that are never part of a build: OS and editor clutter that appears in
 * a copy without anyone committing it. One `Thumbs.db` under `src/` changed the
 * fingerprint and matched no commit (review, measured). `.git` itself (a
 * directory, or a FILE inside a git worktree) is metadata, not code; a tracked
 * `.gitkeep` or `.gitignore` IS a file of the tree and is kept.
 */
const NEVER_BUILD = /^(\.git|node_modules|Thumbs\.db|desktop\.ini|\.DS_Store|.*\.swp|.*~)$/i;

function walk(root, rel, out) {
  const abs = path.join(root, ...rel.split('/'));
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isDirectory()) {
    let names = [];
    try { names = fs.readdirSync(abs); } catch { return; }
    for (const n of names) {
      if (NEVER_BUILD.test(n)) continue;
      walk(root, `${rel}/${n}`, out);
    }
  } else if (st.isFile()) {
    try { out.push({ path: rel, blob: gitBlobId(normaliseEol(fs.readFileSync(abs))) }); } catch { /* unreadable: left out */ }
  }
}

/** HEAD of a git checkout at `root`, read from .git without spawning git; null otherwise. */
function gitHead(root) {
  try {
    // A git WORKTREE has a `.git` FILE pointing at its private git dir, whose
    // refs live in the main repository's common dir.
    let gitDir = path.join(root, '.git');
    let commonDir = gitDir;
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(root, m[1].trim());
      const common = path.join(gitDir, 'commondir');
      commonDir = fs.existsSync(common) ? path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim()) : gitDir;
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref: (.+)$/.exec(head);
    if (!m) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    for (const dir of [gitDir, commonDir]) {
      const refFile = path.join(dir, ...m[1].split('/'));
      if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim() || null;
    }
    const packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${m[1]}`));
    return line ? line.slice(0, 40) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} pluginRoot the directory the running server was loaded from
 * @returns {{version: string|null, fingerprint: string, files: number,
 *   gitHead: string|null, hooksManifest: boolean, root: string, identify: string}}
 */
export function describeRunningBuild(pluginRoot) {
  const entries = [];
  for (const r of FINGERPRINT_ROOTS) walk(pluginRoot, r, entries);
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).version ?? null; } catch { /* absent */ }
  const fingerprint = fingerprintFromEntries(entries);
  return {
    version,
    fingerprint,
    files: entries.length,
    gitHead: gitHead(pluginRoot),
    hooksManifest: fs.existsSync(path.join(pluginRoot, 'hooks', 'hooks.json')),
    root: pluginRoot,
    identify: `node scripts/identify-build.mjs ${fingerprint}  (run in a clone of the repository: names the commit)`,
  };
}

let cached = null;
/** Computed once per process: the files do not change under a running server. */
export function runningBuild(pluginRoot) {
  if (!cached || cached.root !== pluginRoot) cached = describeRunningBuild(pluginRoot);
  return cached;
}
