/**
 * worktree-origin.mjs — is this workspace a linked git worktree, and if so,
 * which directory is its main checkout?
 *
 * WHY IT EXISTS. Bindings are stored by the canonical path of a workspace, so
 * a worktree (`git worktree add`, and every `<repo>/.claude/worktrees/<name>`
 * Claude Code creates) used to start with no binding at all, or with a wrong
 * one, while the repository it was cut from was bound. `readBinding` now lets
 * a worktree with no entry of its own read its main checkout's entry from the
 * user's config; this module answers the one question that needs: "whose
 * worktree is this?".
 *
 * HOW, WITHOUT RUNNING GIT. A linked worktree has a `.git` FILE (not a
 * directory) holding `gitdir: <common>/.git/worktrees/<name>`. That admin
 * directory holds `commondir` (the path of the shared `.git`, usually `../..`)
 * and `gitdir` (the path of the worktree's own `.git` file). The main checkout
 * is the parent of the common `.git`. A handful of small file reads, no process.
 *
 * WHAT A PLANTED `.git` CAN DO, AND WHY IT IS NOT ENOUGH. The `.git` file sits
 * in the workspace, so any downloaded folder can carry one pointing at any
 * repository. Four rules keep it from choosing a binding:
 *
 *   1. The answer is only ever a DIRECTORY. `readBinding` looks that directory
 *      up in the user's own config; nothing here reads a vault name.
 *   2. NOTHING OUTSIDE THE WORKSPACE IS OPENED until the caller's `accept`
 *      says the candidate main checkout is one the user's config binds. A
 *      pointer to an unbound directory, or to a disconnected network share,
 *      costs one local read of the workspace's own `.git` and nothing more.
 *   3. The BACK-POINTER must agree, PHYSICALLY. The admin directory's `gitdir`
 *      file, which lives inside the main repository's own `.git` (not in the
 *      workspace), must name THIS workspace's `.git` — compared after
 *      resolving both through the filesystem (`realpath`), so neither a
 *      spelling that differs only in case (a case-sensitive Windows
 *      directory holds two distinct folders) nor a junction can make two
 *      different files look like one. Forging the back-pointer needs write
 *      access to the bound repository's `.git`, which is already game over.
 *   4. The answer is the candidate `accept` approved, returned only once git's
 *      own common directory is proved to be PHYSICALLY that candidate's
 *      `.git` — the same directory, not merely the same spelling — and the
 *      repository is proved not bare (a config that cannot be read fails
 *      closed).
 *
 * Anything that does not parse — a `.git` that is a link or a directory, a
 * submodule's `.git` file (no `commondir`), a bare repository, a record
 * larger than a pointer or spanning several lines, a special file (FIFO) —
 * answers null: "not a worktree we inherit for". Never throws, never writes.
 *
 * Node builtins only: read on the start-up
 * path and from hooks.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A pointer record is one short line; anything this large is not one. */
const MAX_RECORD_BYTES = 4096;
/** A repository `config` is read only to ask whether it is bare. */
const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * Read at most `max` bytes of `p` through ONE open descriptor, checked as a
 * regular file on that descriptor: the bound holds even if the file is
 * replaced between the `lstat` and the read. Returns null when the file is
 * larger than `max`.
 */
function boundedRead(p, max) {
  const fd = fs.openSync(p, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    const n = fs.readSync(fd, buf, 0, max + 1, 0);
    return n > max ? null : buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const defaultSeams = Object.freeze({
  lstat: (p) => fs.lstatSync(p),
  readFile: (p, max) => boundedRead(p, max),
  realpath: (p) => fs.realpathSync.native(p),
});

/**
 * A small REGULAR file, read whole — or null. `lstat` first, so a link, a
 * directory or a FIFO (which would block a synchronous open forever) is
 * refused before it is opened; the read itself is bounded on the open
 * descriptor (`boundedRead`), so the size bound holds for every file this
 * module reads, not only the first.
 */
function readSmall(p, max, { lstat, readFile }) {
  const st = lstat(p);
  if (!st || typeof st.isFile !== 'function' || !st.isFile() || st.size > max) return null;
  const text = readFile(p, max);
  if (text === null || text === undefined) return null;
  const s = String(text);
  return s.length > max ? null : s;
}

/** A one-line record (`gitdir`, `commondir`, the `.git` pointer): its line, or null when it is not exactly one. */
function oneLine(text) {
  if (text === null) return null;
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length !== 1) return null;
  const line = lines[0].trim();
  return line === '' ? null : line;
}

/**
 * A git config value read as a boolean, the way git reads one: `true`,
 * `yes`, `on` and a non-zero integer (decimal or `0x` hexadecimal, an
 * optional sign, an optional k/m/g unit) are true; `false`, `no`, `off`,
 * zero and the empty string are false. Anything else is UNDETERMINED (null).
 */
function gitBoolean(rawValue) {
  // A comment starts at the first # or ; outside double quotes.
  let out = '';
  let quoted = false;
  for (const ch of rawValue.trim()) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && (ch === '#' || ch === ';')) break;
    out += ch;
  }
  // Git does not trim INSIDE quotes: " false " is not a boolean to it.
  const trimmed = rawValue.trim();
  const v = (/^"[^"]*"$/.test(trimmed.replace(/\s[#;].*$/, '').trim()) ? out : out.trim()).toLowerCase();
  if (v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === 'no' || v === 'off' || v === '') return false;
  const m = /^([+-]?)(0x[0-9a-f]+|\d+)([kmg]?)$/.exec(v);
  if (m) return Number(m[2]) !== 0;
  return null;
}

/**
 * Whether a repository config makes it BARE, the way git reads `core.bare`:
 * a key with no value is true, otherwise `gitBoolean`; the last assignment
 * wins. A value git would read as SOMETHING but this parser cannot place
 * answers true — "bare" — so the caller fails closed rather than guessing a
 * checkout. (Codex, review round 3.)
 */
export function isBareConfig(text) {
  if (text === null) return false;
  let inCore = false;
  let bare = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    let rest = line;
    if (line.startsWith('[')) {
      const header = /^\[([^\]]*)\](.*)$/.exec(line);
      if (!header) { inCore = false; continue; }
      inCore = /^\s*core\s*$/i.test(header[1]);
      // Git accepts a variable on the header's own line: `[core] bare = true`.
      rest = header[2].trim();
      if (rest === '' || rest.startsWith('#') || rest.startsWith(';')) continue;
    }
    if (!inCore) continue;
    const m = /^bare\s*(?:=(.*))?$/i.exec(rest);
    if (!m) continue;
    if (m[1] === undefined) { bare = true; continue; }
    const value = gitBoolean(m[1]);
    bare = value === null ? true : value;
  }
  return bare;
}

/**
 * The main checkout of the linked worktree at `cwd`, or null.
 *
 * Only `cwd` itself is examined, never its parents: bindings are keyed by the
 * exact workspace path, and a subdirectory of a worktree is not the worktree.
 *
 * The answer is the candidate AS SPELLED by the pointer — the spelling
 * `accept` approved and the config is looked up by — once its physical
 * identity with git's own common directory is proved. Returning the
 * physical spelling instead would lose a binding stored under a mapped drive
 * letter or a `subst` drive that `realpath` rewrites. (Codex, round 2.)
 *
 * @param {string} cwd the workspace directory
 * @param {{
 *   accept?: (candidate: string) => boolean,
 *   lstat?: (p: string) => fs.Stats,
 *   readFile?: (p: string, max: number) => string|null,
 *   realpath?: (p: string) => string,
 * }} [seams] `accept` is asked about the candidate main checkout BEFORE any
 *   file outside the workspace is opened; absent, every candidate is examined.
 * @returns {string|null} the main checkout, as the pointer spells it
 */
export function worktreeMainCheckout(cwd, seams = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  const io = { ...defaultSeams, ...seams };
  const accept = typeof seams.accept === 'function' ? seams.accept : () => true;
  try {
    const root = path.resolve(cwd);
    const dotGit = path.join(root, '.git');
    const pointer = /^gitdir:\s*(.+)$/.exec(oneLine(readSmall(dotGit, MAX_RECORD_BYTES, io)) ?? '');
    if (!pointer) return null;
    const adminDir = path.resolve(root, pointer[1].trim());

    // RULE 2: the candidate is derived from the pointer's SPELLING alone —
    // `<main>/.git/worktrees/<name>` — and approved before anything it names
    // is opened.
    const spelledCommon = path.dirname(path.dirname(adminDir));
    if (path.basename(path.dirname(adminDir)).toLowerCase() !== 'worktrees') return null;
    if (path.basename(spelledCommon).toLowerCase() !== '.git') return null;
    const candidate = path.dirname(spelledCommon);
    if (!accept(candidate)) return null;

    // `commondir` is what makes this a LINKED WORKTREE. A submodule's `.git`
    // file points at `.git/modules/<name>`, which has none.
    const common = oneLine(readSmall(path.join(adminDir, 'commondir'), MAX_RECORD_BYTES, io));
    if (!common) return null;

    // RULES 3 AND 4, on PHYSICAL paths. `realpath` resolves junctions and
    // links and, on Windows, returns the spelling the filesystem holds —
    // so two folders that differ only in case stay two.
    const real = (p) => io.realpath(p);
    const realAdmin = real(adminDir);
    const realCommon = real(path.resolve(adminDir, common));
    if (path.dirname(realAdmin) !== path.join(realCommon, 'worktrees')) return null;
    // The common directory must be THE ONE the approved spelling names —
    // physically, not by a case-folded name: on a case-sensitive directory
    // `.GIT` beside `.git` is another folder. (Codex, round 2.)
    const checkoutGit = path.join(candidate, '.git');
    if (realCommon !== real(checkoutGit)) return null;

    const back = oneLine(readSmall(path.join(adminDir, 'gitdir'), MAX_RECORD_BYTES, io));
    if (!back) return null;
    if (real(path.resolve(adminDir, back)) !== real(dotGit)) return null;

    // A bare repository has no main checkout — whatever its directory is
    // called. A config that cannot be read, or is too large to be one, is not
    // proof of a checkout: the answer is then null (fail closed).
    // Read through the approved spelling: it is the same directory, proved above.
    const config = readSmall(path.join(checkoutGit, 'config'), MAX_CONFIG_BYTES, io);
    if (config === null || isBareConfig(config)) return null;
    // With `extensions.worktreeConfig`, the main working tree's own settings —
    // `core.bare` included — live in `config.worktree`, and override.
    // Absent is fine; present but unreadable fails closed. (Codex, round 4.)
    let worktreeConfig = null;
    try {
      worktreeConfig = readSmall(path.join(checkoutGit, 'config.worktree'), MAX_CONFIG_BYTES, io);
      if (worktreeConfig === null) return null;
    } catch (err) {
      if (err?.code !== 'ENOENT') return null;
    }
    if (worktreeConfig !== null && isBareConfig(worktreeConfig)) return null;

    if (real(candidate) === real(root)) return null;
    return candidate;
  } catch {
    return null;
  }
}

/**
 * The linked worktrees git has registered for the main checkout `mainDir`:
 * each `<mainDir>/.git/worktrees/<name>/gitdir` names a worktree's `.git`
 * file, whose directory is the worktree. Only directories that still exist
 * are returned.
 *
 * Used to COUNT writers (a worktree that inherits a binding writes the same
 * vaults as its main checkout), never to grant anything. `complete` is false
 * when the listing exists but could not be read in full — a guard that counts
 * writers must then assume the worst. No `.git/worktrees` at all is a
 * complete, empty answer. Never throws, never writes.
 *
 * @param {string} mainDir
 * @param {{ lstat?: Function, readFile?: Function, readdir?: Function }} [seams]
 * @returns {{ dirs: string[], complete: boolean }}
 */
export function linkedWorktreesOf(mainDir, seams = {}) {
  if (typeof mainDir !== 'string' || mainDir.trim() === '') return { dirs: [], complete: true };
  const io = { ...defaultSeams, readdir: (p) => fs.readdirSync(p), stat: (p) => fs.statSync(p), ...seams };
  const dirs = [];
  let names;
  const root = path.join(path.resolve(mainDir), '.git', 'worktrees');
  try {
    names = io.readdir(root);
  } catch (err) {
    return { dirs, complete: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' };
  }
  let complete = true;
  for (const name of names) {
    try {
      const back = oneLine(readSmall(path.join(root, String(name), 'gitdir'), MAX_RECORD_BYTES, io));
      if (!back) continue;
      const dir = path.dirname(path.resolve(root, String(name), back));
      // FOLLOWED, not lstat'd: a worktree moved by hand can leave its
      // registered location as a link to the new one, and its session still
      // inherits (the caller checks every listed directory with the forward
      // rule). (Codex, review round 3.)
      let st = null;
      try { st = io.stat(dir); } catch (err) { if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') complete = false; continue; }
      if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) continue;
      dirs.push(dir);
      // The PHYSICAL location too, when the registered one is a link: a session
      // started there is keyed by that spelling.
      try {
        const physical = io.realpath(dir);
        if (physical && physical !== dir) dirs.push(physical);
      } catch { /* the registered spelling is enough to count */ }
    } catch (err) {
      // A registration that vanished is a stale entry; anything else is unread.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') complete = false;
    }
  }
  return { dirs, complete };
}
