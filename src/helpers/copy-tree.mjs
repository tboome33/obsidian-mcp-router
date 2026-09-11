/**
 * copy-tree.mjs — a recursive directory copy that does not corrupt non-ASCII
 * paths, plus the guard that detects the corruption when it happens anyway.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 * MEASURED on 2026-09-11, node v24.13.0, win32 — `fs.cpSync` does not carry a
 * path through unchanged when that path contains a character outside ASCII:
 *
 *   fs.mkdirSync / fs.writeFileSync / fs.copyFileSync   -> correct path
 *   fs.promises.cp                                      -> correct path
 *   fs.cpSync(file, file)                               -> correct path
 *   fs.cpSync(dir, dir, { recursive: true })            -> CORRUPTED
 *   fs.cpSync(dir, dir, { recursive: true, filter })    -> correct path (!)
 *
 * That last line is measured, not a typo, and it is a trap rather than a fix:
 * a `filter` makes Node fall back to its JavaScript implementation, which is
 * built out of the safe calls above. So the SAME function is correct or
 * corrupting depending on an option that has nothing to do with paths — which
 * is why the rule enforced by tests/copy-tree.test.mjs is "no `fs.cpSync` in
 * production code at all", and not "no `fs.cpSync` without a filter". A future
 * reader deleting a filter for tidiness would otherwise reintroduce the defect
 * while touching nothing that looks like a path.
 *
 * Copying a tree to `…\La méthode LICARES\x` created `…\La mÃ©thode LICARES\x`
 * instead: the UTF-8 bytes of the destination (`C3 A9` for `é`) were decoded
 * through the Windows ANSI code page and re-encoded, giving `C3 83 C2 A9`.
 * Node reimplemented `cpSync` on top of C++ `std::filesystem` in the 22.x line,
 * and on Windows a `std::filesystem::path` built from a NARROW string is
 * interpreted in the active code page, not in UTF-8.
 *
 * The same measurement, with the accent on the SOURCE side, is worse: the
 * process dies on an uncaught native exception — exit 0xC0000409
 * (STATUS_STACK_BUFFER_OVERRUN), no JavaScript error, no stderr, nothing a
 * `try/catch` can see. So this is not only a correctness bug, it is a
 * crash-without-a-message on any user whose vault, whose profile directory, or
 * whose repository checkout carries an accent.
 *
 * IT IS VERSION-SPECIFIC, AND THAT MATTERS FOR WHOEVER READS THE TESTS. Measured
 * on the same machine, same fixture, same minute:
 *
 *     node v24.13.0  ->  two directories, the twin mis-encoded   (defect)
 *     node v23.11.1  ->  one directory                           (no defect)
 *
 * So a test that asserts the corruption happens would be red on a runtime that
 * does not have it, and a mutation that reintroduces `fs.cpSync` SURVIVES there
 * — measured: the same two mutations that were killed on v24.13.0 survived on
 * v23.11.1, which for ten confusing minutes looked like a regression in this
 * module and was a change of `node` on PATH. Two consequences, both deliberate:
 * `tests/fixtures/cp-sync-accent-probe.mjs` REPORTS what the running runtime
 * does and only asserts the mangled shape when the runtime produced one; and the
 * regression guard that actually holds everywhere is the SOURCE SCAN in
 * tests/copy-tree.test.mjs, which does not care whether a given call site
 * corrupts on the runtime of the day. CI runs Node 20.19.0 and 22 — neither is
 * the version this was measured on, so the scan is the only guard CI exercises.
 *
 * What it looked like in production (router 0.94.1): provisioning a vault at
 * `C:\VAULTS\La méthode LICARES` produced TWO directories. Everything written
 * through `fs` — the config JSON, `.env`, `.mcp.json`, the `wiki/` scaffold,
 * `identity.json` — landed at the real path; everything cloned as a TREE — the
 * 11 plugins, the themes, `Documentation/`, `.claude/`, the embedding cache —
 * landed in the mojibake twin. The run reported `ok: true` with no warning,
 * because every individual call had in fact succeeded.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE PROVIDES
 * ---------------------------------------------------------------------------
 *   copyTreeSync()          the replacement: readdir + mkdir + copyFile, all
 *                           of which were measured to carry the path intact.
 *   isEncodingTwin()        name comparator: are these two names the same name
 *                           seen through a broken encoding boundary?
 *   findEncodingTwins()     scan a path's siblings for such a twin.
 *   assertNoEncodingTwin()  the end-of-provisioning guard: throw, loudly, with
 *                           both paths, rather than report success.
 *
 * The guard is deliberately NOT a re-implementation of the bug's mechanism: it
 * asks "does a sibling of my target look like my target, mangled?", which stays
 * true whichever API introduces the mangling next.
 *
 * Node builtins only — `scripts/setup-vault.mjs` imports this before any
 * dependency is known to exist.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// The single-byte code page a broken boundary decodes UTF-8 bytes through.
// ---------------------------------------------------------------------------

// windows-1252 is the ANSI code page on the machines this bug appears on, and
// it differs from latin1 exactly in 0x80-0x9F — where it puts the euro sign,
// the curly quotes, the dashes and `oe`. Both tables are tried, because a
// boundary that used plain latin1 produces a different, equally wrong twin.
//
// THE HIGH RANGE IS WRITTEN OUT, AND THAT IS NOT PEDANTRY. The first version of
// this table built itself with `new TextDecoder('windows-1252')`. Measured on
// node v24.13.0 (full ICU): that decoder reports `encoding: 'windows-1252'` and
// then maps byte 0x80 to U+0080 — it is doing ISO-8859-1 under a windows-1252
// label, and `iso-8859-1`, `latin1` and `cp1252` all resolve to the same
// decoder. It differed from true latin1 at ZERO of 256 bytes. So the pair of
// tables was one table twice, and every twin whose name carries a curly
// apostrophe, an em dash or a euro sign would have gone unnoticed — which in a
// vault called `L'Atelier` is not a corner case. A table that lies about its
// own identity cannot be caught by reading; only by measuring it.
//
// Codepoints are BUILT, never escaped: a backslash-u typed into a source file
// in this repository becomes the character itself, and a table of look-alike
// punctuation is the worst possible place for that to happen silently.
const CP1252_HIGH = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];

const CP1252 = (() => {
  const forward = [];
  const reverse = new Map();
  for (let i = 0; i < 256; i++) {
    // 0x81/0x8D/0x8F/0x90/0x9D have no character in windows-1252. They keep
    // their latin1 value here so the table stays total, and they are left OUT
    // of the reverse map so five unmapped bytes cannot alias one character.
    const high = i >= 0x80 && i <= 0x9f ? CP1252_HIGH[i - 0x80] : i;
    const ch = String.fromCharCode(high === null ? i : high);
    forward.push(ch);
    if (high !== null && !reverse.has(ch)) reverse.set(ch, i);
  }
  return { forward, reverse };
})();

const LATIN1 = (() => {
  const forward = [];
  const reverse = new Map();
  for (let i = 0; i < 256; i++) {
    forward.push(String.fromCharCode(i));
    reverse.set(String.fromCharCode(i), i);
  }
  return { forward, reverse };
})();

const TABLES = [CP1252, LATIN1];

/** `name` as it looks when its UTF-8 bytes are decoded through `table`. */
function mangleOnce(name, table) {
  const bytes = Buffer.from(name, 'utf8');
  let out = '';
  for (const b of bytes) out += table.forward[b];
  return out;
}

/**
 * The inverse: read `name` back as if it WERE the mangled form, i.e. encode
 * each character to its single byte and decode the result as UTF-8. Returns
 * null when `name` cannot be a mangled form (a character outside the table, or
 * a byte sequence that is not valid UTF-8).
 */
function unmangleOnce(name, table) {
  const bytes = [];
  for (const ch of name) {
    const b = table.reverse.get(ch);
    if (b === undefined) return null;
    bytes.push(b);
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  // A lossy decode means these bytes were not UTF-8 to begin with.
  if (decoded.includes(String.fromCharCode(0xfffd))) return null;
  return decoded;
}

const nfc = (s) => String(s).normalize('NFC');

/**
 * Every form `name` can take after 1..depth passes through a broken boundary,
 * in both directions, each normalised to NFC. Double mangling is real: a name
 * that crosses two such boundaries comes out mangled twice.
 */
function encodingVariants(name, depth = 3) {
  const seen = new Set([nfc(name)]);
  let frontier = [name];
  for (let round = 0; round < depth; round++) {
    const next = [];
    for (const value of frontier) {
      for (const table of TABLES) {
        for (const candidate of [mangleOnce(value, table), unmangleOnce(value, table)]) {
          if (candidate === null || candidate === '') continue;
          const key = nfc(candidate);
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(candidate);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return seen;
}

/**
 * True when `a` and `b` are the same name written twice — once correctly, once
 * through a broken encoding boundary, or once in NFC and once in NFD.
 *
 * DELIBERATELY NOT a twin: two names that differ only in CASE. On Windows they
 * cannot both exist, and on POSIX `Foo` and `foo` are two legitimate different
 * directories — flagging them would make the guard refuse correct trees. The
 * defect this comparator exists for never changes a letter's case.
 *
 * Identical names are not twins either: a name is not its own duplicate.
 */
export function isEncodingTwin(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a === b) return false;
  // NFC on both sides — NFC vs NFD is two different byte strings on disk and
  // one name to a reader, which is the same hazard. `encodingVariants` seeds
  // itself with `nfc(a)`, so normalising the target is what closes that case;
  // there is no separate branch for it.
  //
  // EXPANDED FROM BOTH SIDES, because the relation is not symmetric when
  // normalisation and mangling combine. Review counter-example: with `a` the
  // latin1 mangling of the DECOMPOSED spelling and `b` the composed one,
  // un-mangling `a` reaches the decomposed form, which normalises to `b` — but
  // expanding `b` never produces the decomposed spelling to mangle in the first
  // place, so the same pair answered `true` one way round and `false` the
  // other. `findEncodingTwins` only ever asks one way round, so the asymmetry
  // was a missed twin, not a curiosity.
  return encodingVariants(a).has(nfc(b)) || encodingVariants(b).has(nfc(a));
}

/**
 * Existing directories that are encoding twins of `targetPath` or of ANY of its
 * ancestors.
 *
 * The ancestor walk is not thoroughness for its own sake: the mangling happens
 * on whichever path segment carries the non-ASCII character, and that is not
 * always the last one. `C:\VAULTS\La méthode LICARES` puts the twin next to the
 * target; `C:\VAULTS\Café\notes` puts it next to `Café`, two levels up, and a
 * guard that only looked at siblings of `notes` would call that run clean.
 *
 * Only DIRECTORIES count. A regular file that happens to bear the mangled name
 * is not a split vault, and reporting it would abort a healthy provisioning —
 * found in review.
 *
 * @param {string} targetPath the directory that SHOULD be the only one.
 * @returns {string[]} paths of the twins found, deepest first (empty when
 *   clean). An unreadable parent contributes nothing: an empty result means
 *   "nothing detected where I could look", never "no twin exists", and the
 *   guard treats a permissions problem as unknown rather than as a failure.
 */
export function findEncodingTwins(targetPath) {
  return describeEncodingTwins(targetPath).map((t) => t.path);
}

/**
 * The same scan, keeping WHAT each match is — the shape the guard needs to say
 * something true about it.
 *
 * A twin beside the target means the vault itself was split, and merging is the
 * remedy. A twin beside an ANCESTOR is a different fact: the mangled directory
 * is a whole parallel folder that may hold several vaults' worth of files, and
 * telling the operator to "merge it into the target" would point them at the
 * wrong structural level. Round-1 review finding.
 *
 * @returns {{path: string, level: 'self'|'ancestor', of: string}[]}
 */
export function describeEncodingTwins(targetPath) {
  return scanEncodingTwins(targetPath).twins;
}

/**
 * The same scan, plus whether it could see everything it needed to.
 *
 * `complete: false` means at least one parent directory could not be listed, so
 * an empty (or short) result is "nothing detected where I could look", not "no
 * twin exists". The provisioning guard needs that distinction: it compares a
 * before-scan with an after-scan, and if the BEFORE scan was blind, a twin that
 * shows up later may simply have been invisible the first time — not created by
 * this run. Blaming the run for it would abort a healthy provisioning, which is
 * the exact failure round 1 already caught once. Round 2 found the same shape
 * hiding behind a permissions error.
 */
export function scanEncodingTwins(targetPath) {
  const twins = [];
  let complete = true;
  let current = path.resolve(targetPath);
  let isSelf = true;
  for (let parent = path.dirname(current); parent !== current; parent = path.dirname(current)) {
    const base = path.basename(current);
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch (err) {
      // A parent that does not exist yet is not blindness — there is genuinely
      // nothing there to list. Anything else (EACCES, EPERM, EIO) is.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') complete = false;
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isEncodingTwin(entry.name, base)) continue;
      twins.push({ path: path.join(parent, entry.name), level: isSelf ? 'self' : 'ancestor', of: current });
    }
    current = parent;
    isSelf = false;
  }
  return { twins, complete };
}

/**
 * Split a twin scan into "this run made it" and "it was already there".
 *
 * THE DISTINCTION IS THE WHOLE POINT, and the first version did not draw it. A
 * name match is evidence that two names are related, not that anything is
 * damaged: `café` and `cafÃ©` can both belong to the user, deliberately, and a
 * provisioning that ran correctly beside them has done nothing wrong. Failing
 * on the mere existence of a twin aborted exactly that case — and did so AFTER
 * the configuration and workspace changes had been written. Found in review.
 *
 * So the caller inventories the candidates before it copies anything, and this
 * function says what changed. Only what appeared is a failure; what was already
 * there is worth telling the operator about, and nothing more.
 *
 * @param {string[]} before paths from a scan taken before any copy.
 * @param {{path: string, level: string, of: string}[]} now a later
 *   `describeEncodingTwins` result.
 */
export function classifyProvisioningTwins(before, now, { beforeComplete = true } = {}) {
  const preExistingPaths = new Set(Array.isArray(before) ? before : []);
  const created = [];
  const preExisting = [];
  for (const twin of now || []) {
    if (preExistingPaths.has(twin.path)) {
      preExisting.push(twin);
    } else if (!beforeComplete) {
      // The before-scan was blind somewhere, so "not in the list" does not mean
      // "was not there". Unknown provenance is reported, never blamed: a
      // permissions error must not turn into an aborted healthy run.
      preExisting.push({ ...twin, provenance: 'unknown' });
    } else {
      created.push(twin);
    }
  }
  return { created, preExisting };
}

// THERE IS NO `assertNoEncodingTwin()` HERE, AND THAT IS THE POINT.
//
// One existed. It threw on any twin and told the operator to "merge the twin
// into the target and delete it" — advice that is right for a twin of the vault
// and actively harmful for a twin of a PARENT directory, which may hold other
// vaults. When the provisioning tail was repaired to distinguish the two, this
// helper was not, so the repository held two answers to one question and the
// wrong one was the exported, reusable, easily-called one. Round 2 found it
// still standing after the repair that was supposed to remove it.
//
// The decision now lives in exactly one place: `describeEncodingTwins` says
// what was found and at which level, `classifyProvisioningTwins` says what this
// run is responsible for, and the caller writes the message it can justify.

// ---------------------------------------------------------------------------
// The copy itself.
// ---------------------------------------------------------------------------

/** Deep enough for any real vault; shallow enough to fail before the stack does. */
const MAX_DEPTH = 64;

/**
 * Recursively copy `src` to `dst`, carrying every path byte-for-byte.
 *
 * Replaces `fs.cpSync(src, dst, { recursive: true })` at this repository's call
 * sites, built only out of calls measured to be path-safe.
 *
 * SYMLINKS ARE FOLLOWED, NOT RECREATED — a deliberate difference from
 * `fs.cpSync`'s default, and the one place this is not a drop-in. The first
 * version did recreate them, and an adversarial review took it apart: a
 * RELATIVE link copied verbatim resolves somewhere else once it is in the new
 * tree (`link -> ../shared` under `/src` means `/shared`, under `/out/copy` it
 * means `/out/shared`); the "no privilege to create links" fallback dropped the
 * caller's `filter`, which is what keeps the credential file out; a link whose
 * target had vanished produced no destination and no error; and the removal
 * that preceded link creation ran even under `force:false`, deleting a
 * destination directory the caller had asked it not to touch.
 *
 * Every one of those is a symptom of recreating a link in a tree where it no
 * longer means the same thing. These call sites clone a template INTO a new
 * vault: what the operator asked for is the plugin's bytes, in their vault, not
 * a pointer back into the template. So links are dereferenced, `filter` applies
 * to everything the walk reaches, and a dangling link is an error rather than a
 * silent omission.
 *
 * @param {string} src file or directory to copy.
 * @param {string} dst destination path.
 * @param {object} [opts]
 * @param {(src: string, dst: string) => boolean} [opts.filter] called for every
 *   entry; returning false skips it, and skips its whole subtree when it is a
 *   directory — same contract as `fs.cpSync`'s `filter`. It is called with the
 *   path as WALKED, so a filter written against a name still matches inside a
 *   directory that was reached through a link.
 * @param {boolean} [opts.force=true] when false, an existing destination is
 *   left untouched instead of being overwritten (as `fs.cpSync` does). It never
 *   causes a deletion, whatever the source turns out to be.
 * @param {boolean} [opts.allowDanglingLinks=false] skip a link whose target is
 *   missing instead of throwing.
 */
export function copyTreeSync(src, dst, opts = {}) {
  const srcReal = path.resolve(src);
  const dstReal = path.resolve(dst);
  // `fs.cpSync` refuses this with ERR_FS_CP_EINVAL, and so must anything
  // replacing it: copying a directory into itself makes the walk feed on its
  // own output until the filesystem stops it, having written an unbounded
  // amount first.
  if (samePathIgnoringCase(dstReal, srcReal) || isInside(dstReal, srcReal)) {
    const err = new Error(`Cannot copy ${src} into itself (${dst}).`);
    err.code = 'ERR_FS_CP_EINVAL';
    throw err;
  }
  copyEntry(src, dst, opts, 0, new Set());
}

/**
 * True when `child` is at or below `parent`, comparing resolved paths.
 *
 * `rel.startsWith('..')` — the obvious spelling, and the one round 2 broke in
 * one line: `path.relative('/tmp/src', '/tmp/src/..cache')` is `..cache`, an
 * ordinary directory name that starts with two dots. The check declared it
 * OUTSIDE, so `copyTreeSync('/tmp/src', '/tmp/src/..cache')` was allowed and the
 * walk then fed on its own output until the depth limit stopped it. The segment
 * has to be exactly `..`, not merely begin with it.
 */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '' || path.isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes('..');
}

/** Windows and macOS resolve paths case-insensitively; Linux does not. */
function samePathIgnoringCase(a, b) {
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

function copyEntry(src, dst, opts, depth, ancestors) {
  const { filter, force = true, allowDanglingLinks = false } = opts;
  if (typeof filter === 'function' && !filter(src, dst)) return;
  if (depth > MAX_DEPTH) {
    throw new Error(`Refusing to copy deeper than ${MAX_DEPTH} levels below the source (at ${src}).`);
  }

  // `statSync`, not `lstatSync`: links are followed. A link that points nowhere
  // reports ENOENT here, which is the honest answer — it used to be swallowed.
  let stat;
  try {
    stat = fs.statSync(src);
  } catch (err) {
    if (allowDanglingLinks && (err.code === 'ENOENT' || err.code === 'ELOOP')) return;
    throw err;
  }

  if (stat.isDirectory()) {
    // A link cycle would otherwise walk for ever. The identity that matters is
    // the real directory, not the path used to reach it. A cycle is SKIPPED,
    // not copied: there is no finite tree to write, and the alternative is a
    // copy that never ends.
    let real;
    try { real = fs.realpathSync(src); } catch { real = path.resolve(src); }
    if (ancestors.has(real)) return;

    if (force) {
      clearBlockingSymlink(dst);
    } else if (isSymlink(dst)) {
      // NEITHER DELETE NOR TRAVERSE. Round 2: with `force:false` the removal
      // was correctly skipped — and then `mkdirSync` + the recursion went
      // straight THROUGH the link, creating every missing child inside whatever
      // external directory it named. "Do not overwrite" has to mean "do not
      // write here at all", not "write somewhere else instead".
      return;
    }
    fs.mkdirSync(dst, { recursive: true });

    ancestors.add(real);
    try {
      for (const entry of fs.readdirSync(src)) {
        copyEntry(path.join(src, entry), path.join(dst, entry), opts, depth + 1, ancestors);
      }
    } finally {
      ancestors.delete(real);
    }
    return;
  }

  // `lstatSync`, not `existsSync`: a destination that is a DANGLING link does
  // not "exist" by `existsSync`, so under `force:false` execution used to fall
  // through and delete it — a removal on the one setting that promises none.
  // Round 2 finding. Presence of the entry itself is the question.
  if (!force && lstatOrNull(dst)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // A destination that is itself a link would send this write outside the
  // destination tree — into whatever the link names.
  clearBlockingSymlink(dst);
  fs.copyFileSync(src, dst);
}

/** `fs.lstatSync(p)` or null when the entry is absent. Other errors propagate. */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    // ONLY absence is "nothing there". A permission or I/O failure is not, and
    // swallowing it made the copy behave as though the path were free.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

function isSymlink(p) {
  const st = lstatOrNull(p);
  return Boolean(st && st.isSymbolicLink());
}

/**
 * Remove `dst` when — and only when — it is a symlink. Anything else is left
 * alone: `mkdirSync({recursive:true})` and `copyFileSync` handle a real
 * directory or a real file correctly, and deleting one would exceed what a copy
 * was asked to do.
 *
 * NON-RECURSIVE ON PURPOSE. The check and the removal are two operations, so
 * between them the entry can be replaced — and the first version's
 * `rmSync({recursive: true})` would then have deleted a real directory and
 * everything under it. `unlinkSync` and `rmdirSync` cannot: they refuse a
 * non-empty directory. The race is not closed (nothing here can close it), but
 * its worst outcome is now an error instead of a silent deletion.
 */
function clearBlockingSymlink(dst) {
  const st = lstatOrNull(dst);
  if (!st || !st.isSymbolicLink()) return;
  try {
    // A Windows directory symlink or junction needs rmdir; a file link needs
    // unlink. Try the cheap one first and fall back on the error.
    fs.unlinkSync(dst);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EISDIR' && err.code !== 'EACCES') throw err;
    fs.rmdirSync(dst);
  }
}
