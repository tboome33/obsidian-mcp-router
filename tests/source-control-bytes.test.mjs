/**
 * NO SOURCE FILE CARRIES A RAW C0 CONTROL BYTE OR DEL.
 *
 * THE INCIDENT, 2026-09-14. Three unicode escapes typed through an editing tool
 * landed in a new helper as LITERAL NUL bytes. Everything was green: the
 * module's tests, its mutations, the whole repository suite — and correctly so,
 * because a raw NUL and `String.fromCharCode(0)` are the same character. The
 * behaviour was right. What was wrong is that three bytes of source were
 * invisible to every reader and to every assertion.
 *
 * `grep` gave it away, refusing the file as "Binary file … matches" during an
 * unrelated search. A sweep then found the same shape in three MORE files, one
 * of them production code — the signature of a class defect, where a correction
 * reaching only the site that was noticed reads as closed.
 *
 * WHY IT IS WORTH A TEST, given that nothing misbehaves: a reader cannot see the
 * character, so they cannot review it; `grep`, `diff` and anything else that
 * classifies by content stops treating the file as text, which is how review and
 * search quietly lose it; and any tool that round-trips or sanitises the file can
 * drop or transform the byte with no diff a human would notice.
 *
 * FOUR RULES THIS CHECK LIVES BY, every one of them a review finding:
 *
 *   UNKNOWN MEANS SCANNED. The only escape is an explicit list of non-source
 *   extensions. A positive list of "these are source" stops covering anything it
 *   has not heard of — the first version skipped every extensionless file and
 *   tolerated an unknown extension until its THIRD occurrence.
 *
 *   BEING UNABLE TO LOOK IS NEVER CLEAN. Read failures, paths the tree does not
 *   hold, symlinks and non-regular files each land in their own bucket and are
 *   asserted empty. The coverage figure counts files actually READ.
 *
 *   NO LINK IS FOLLOWED, ANYWHERE ALONG THE PATH. Reading through a link
 *   examines content that may live outside the repository, so the same tree
 *   would pass, report an offender, or report an absence depending on the
 *   machine. `lstat` on the leaf is not enough — it resolves the ANCESTORS — so
 *   every component under the root is probed. SAID EXACTLY: the ROOT ITSELF and
 *   everything above it are trusted — a repository reached through a link is
 *   scanned without complaint, because the caller chose that path — and this
 *   detects a link BELOW the root that is there when the walk runs. It is a check followed by a read, and
 *   nothing stops another process from swapping a component in between; naming
 *   that bound is honest, where a second pathname check would only look like a
 *   fix. A tree being rewritten underneath the suite is outside the guarantee.
 *
 *   THE FIXTURES TOUCH NOTHING OUTSIDE THEIR TEMP DIRECTORY. `cwd` does not
 *   isolate git. An ambient `GIT_INDEX_FILE` redirects a fixture's `git add`
 *   into the caller's index; `GIT_CONFIG_COUNT` + `core.hooksPath` makes it
 *   EXECUTE the caller's hook; `GIT_TEMPLATE_DIR` installs hooks into every
 *   fixture repository; `GIT_TRACE` writes to an absolute path of its choosing.
 *   All of them are cleared for fixtures.
 *
 * WHAT IT DOES NOT COVER, said plainly: C1 controls (U+0080–U+009F), U+FEFF and
 * the bidirectional overrides (U+202A–U+202E) are a different question wanting
 * their own check; and it reads the WORKING TREE, which in CI is the commit,
 * while locally a byte staged behind a clean unstaged edit is caught by CI
 * rather than here.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The separator `git ls-files -z` puts between paths.
 *
 * BUILT, and the reason is this file's own history: its first version spelled
 * this as a unicode escape, which the editing tool turned into a literal NUL
 * byte in the source — inside the very check written to catch exactly that. It
 * happened three times in this one file, including in the paragraph describing
 * the trap.
 */
const NUL_SEPARATOR = String.fromCharCode(0);

/** Tab, line feed, carriage return — the only control characters source may hold. */
const ALLOWED_BYTES = new Set([0x09, 0x0a, 0x0d]);

/** What this check calls a control byte: the C0 block, plus DEL. */
export const isControlByte = (b) => (b < 0x20 && !ALLOWED_BYTES.has(b)) || b === 0x7f;

/**
 * Git variables that point a command at ANOTHER repository, or at the caller's
 * configuration, hooks, templates or trace files.
 *
 * Three rounds of review to get this list, and a fourth to get its SCOPE. The
 * first version cleared none of it and relied on `cwd`, which is not isolation:
 * a fixture's `git add` writes into whatever `GIT_INDEX_FILE` names. The second
 * cleared the repository selectors but left the RUNTIME configuration —
 * `GIT_CONFIG_COUNT` with a `core.hooksPath` pair makes that same `git add`
 * EXECUTE an arbitrary caller hook, a documented hook point and not a
 * hypothetical. The third cleared all of it for FIXTURES only, and left the scan
 * of this repository — the one call that runs in non-isolated mode — inheriting
 * traces, templates and injected configuration. Every one of these is cleared in
 * BOTH modes now: keeping the caller's global config FILE for `safe.directory`
 * never required keeping any of this.
 */
const GIT_HOSTILE_VARS = [
  // Which repository, index and object store.
  'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_INDEX_VERSION',
  // Configuration injected at runtime, which outranks any config FILE we point
  // elsewhere. `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` are removed by pattern.
  'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_ATTR_NOSYSTEM',
  // What a fresh repository is seeded with — hooks and an exclude file.
  'GIT_TEMPLATE_DIR',
  // WHO WROTE THE COMMIT, AND WHEN. A fixture that commits reads all six, and
  // `GIT_AUTHOR_DATE=not-a-date` makes git refuse before the thing under test
  // runs — a setup death wearing the clothes of a real failure. An explicit
  // `-c user.name` does not neutralise them; they are separate inputs.
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
  // WHERE GIT FINDS ITS OWN PROGRAMS, and which programs it calls out to.
  // `GIT_EXEC_PATH` is prepended to the search path git uses for its OWN
  // subprocesses: measured, a `git` executable placed there is run by a
  // fixture's `git commit` — auto-maintenance spawns one — while the commit
  // still reports success. And `GIT_SSH_COMMAND` outranks a config
  // `core.sshCommand`, so a caller can replace the transport a fixture
  // configures for itself, making that fixture measure somebody else's program.
  'GIT_EXEC_PATH', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
  'GIT_ASKPASS', 'GIT_PROXY_COMMAND',
  // SETTINGS THAT DECIDE WHETHER A DEFENCE IS EVEN NEEDED. An ambient
  // `GIT_NO_LAZY_FETCH=1` disables fetching on its own, and
  // `GIT_ALLOW_PROTOCOL` can forbid the transport a fixture configures — either
  // one makes the transport witness pass with its protection REMOVED. A variable
  // that can quietly satisfy a test is as dangerous as one that can break it.
  'GIT_NO_LAZY_FETCH', 'GIT_ALLOW_PROTOCOL', 'GIT_PROTOCOL', 'GIT_PROTOCOL_FROM_USER',
];

/**
 * Where git may write on its own initiative, outside our scratch space.
 *
 * BY PREFIX, NOT BY NAME. A review round listed `GIT_TRACE_REFS`, which was
 * absent from the hand-written list and is enough on its own to append
 * ref-operation traces to any absolute path the caller names, while `git init`
 * still succeeds. A family that grows with git cannot be enumerated by hand.
 */
const GIT_TRACE_PREFIX = 'GIT_TRACE';

/**
 * Should a variable the caller exported be kept out of a git call we make?
 *
 * BY UPPERCASED NAME, and this is the finding that matters most in the list.
 * Windows resolves environment variables case-insensitively, but the copy we
 * hand to `spawnSync` is an ordinary JavaScript object: `delete
 * env.GIT_INDEX_FILE` does nothing at all to a caller's `git_index_file`. It was
 * measured rather than argued — with the lowercase spelling exported and the
 * supposedly clean environment handed to git, `git rev-parse --git-path index`
 * answered with the victim's path. The whole isolation, defeated by a spelling.
 *
 * A previous version also split this list in two and used the SECOND half only
 * for the non-isolated mode, by position (`slice(0, 10)`) — a boundary no test
 * pinned and any insertion would have moved. There is no second half now.
 */
function isHostileGitVar(key) {
  const name = key.toUpperCase();
  return GIT_HOSTILE_VARS.includes(name)
    || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)
    || name.startsWith(GIT_TRACE_PREFIX);
}

/** A scratch HOME and an EMPTY template, so nothing ambient seeds a fixture. */
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-home-'));
const EMPTY_TEMPLATE = path.join(ISOLATED_HOME, 'empty-template');
fs.mkdirSync(EMPTY_TEMPLATE, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * The environment a git call runs under.
 *
 * EVERY HOSTILE VARIABLE IS CLEARED IN BOTH MODES. What `full` decides is
 * narrower than it used to be, and deliberately so.
 *
 * @param {boolean} full  false keeps the caller's global and system
 *   configuration FILES, which is what the scan of THIS repository needs: a
 *   contributor whose checkout has different ownership relies on a global
 *   `safe.directory` exception, and an earlier version of this isolation hid it,
 *   so git refused the repository before the scan could start. That need is
 *   about a config FILE. It never justified inheriting `GIT_TRACE*` (which
 *   writes wherever the caller says), `GIT_TEMPLATE_DIR`, or runtime config
 *   injection — and a review round found the non-isolated call doing exactly
 *   that, which put the external-write hole back for the one call that runs
 *   against a real repository.
 *
 * @param {object} [source]  the environment to filter, `process.env` by default.
 *   A test passes a synthetic object: on Windows `process.env` cannot hold
 *   `git_index_file` and `GIT_INDEX_FILE` as separate entries — they are one
 *   variable — so a fixture that sets every spelling in turn overwrites its own
 *   saved values and puts a hostile one BACK on teardown. Asking the question of
 *   a plain object asks it exactly once, and means the same thing on both
 *   platforms.
 */
export function gitEnv(full = true, source = process.env) {
  const env = {};
  // BUILT BY COPYING WHAT SURVIVES, not by deleting from a copy: on Windows the
  // caller's spelling is not ours to predict, and a `delete` by literal property
  // name misses every spelling but one.
  for (const [key, value] of Object.entries(source)) {
    if (!isHostileGitVar(key)) env[key] = value;
  }
  // TRACE2 IS ALSO A CONFIG KEY, so clearing the environment does not close it.
  // `trace2.normalTarget`, `trace2.perfTarget` and `trace2.eventTarget` each name
  // an absolute path, and the NON-isolated mode keeps the caller's global config
  // file on purpose. Measured against a control run: all three wrote outside the
  // scratch space while the enumeration reported success, 4 kB of event trace for
  // one `ls-files`. Measured too, because the obvious fix is the wrong one:
  // `-c trace2.x=` and `-c trace2.x=0` do NOT disable them — trace2 is set up
  // before command-line configuration is applied. The environment outranks the
  // file, and `0` means off.
  env.GIT_TRACE2 = '0';
  env.GIT_TRACE2_PERF = '0';
  env.GIT_TRACE2_EVENT = '0';
  if (full) {
    // Non-existent paths: git reads a missing config as empty, which is the
    // neutrality wanted.
    env.GIT_CONFIG_GLOBAL = path.join(ISOLATED_HOME, 'gitconfig-absent');
    env.GIT_CONFIG_SYSTEM = path.join(ISOLATED_HOME, 'gitsystem-absent');
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_TERMINAL_PROMPT = '0';
    env.HOME = ISOLATED_HOME;
    env.USERPROFILE = ISOLATED_HOME;
    env.XDG_CONFIG_HOME = ISOLATED_HOME;
  }
  return env;
}

/**
 * Extensions whose contents are NOT source — binaries, archives, fonts.
 *
 * The ONLY way a file escapes being read. Every entry removes a whole category
 * from inspection, which is why the suite pins the categories that must stay
 * scanned with their own end-to-end fixtures: the accounting identity cannot see
 * a category vanish, since an excluded file leaves both sides of it at once.
 */
const NOT_SOURCE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.7z', '.rar', '.mcpb',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov',
  '.bin', '.node', '.wasm', '.exe', '.dll', '.so', '.dylib',
  '.db', '.sqlite', '.p12', '.pfx',
]);

/** Categories that must never stop being scanned, whatever the list above says. */
const REQUIRED_SOURCE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.json', '.md', '.yml', '.yaml', '.sh', '.svg', '.css', '.html'];

/**
 * Files allowed to carry a control byte, each with the reason.
 *
 * EMPTY TODAY, AND MEASURED: every site found on 2026-09-14 was converted to a
 * constructed character, including the hostile-input fixtures where the control
 * character IS the thing under test — those now build it and say so, which is
 * strictly better than a raw byte because the reader can see what is tested.
 */
const ALLOWED_FILES = new Map([
  // ['path/from/repo/root.mjs', 'why this one genuinely needs a raw byte'],
]);

/** Is this path's content source we should read? */
export function isSourcePath(rel) {
  return !NOT_SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

/**
 * Does `rel` stay inside `root`, spelled as a path?
 *
 * `path.relative` rather than a `startsWith` on `base + sep`: the latter builds
 * `'//'` when the root IS the filesystem root and then rejects every ordinary
 * child. This is a LEXICAL check — it says nothing about links, which is why
 * `pathProbe` below walks the components.
 */
export function isContained(root, rel) {
  const rest = path.relative(path.resolve(root), path.resolve(root, rel));
  // `startsWith('..')` alone rejects an ordinary file named `..fixture.mjs`,
  // which is a legal name and lives inside the repository. Only the PARENT
  // component escapes.
  return rest !== ''
    && rest !== '..'
    && !rest.startsWith(`..${path.sep}`)
    && !path.isAbsolute(rest);
}

/**
 * Is `rel` spelled the way `git ls-files` prints a path?
 *
 * THE SCAN LOOKS EXEMPTIONS UP BY EXACT STRING, against the path git printed. So
 * a spelling git never produces cannot match one — and a review round found
 * `./f.mjs` passing validation, because the walk simply drops a `.` component.
 * The entry was accepted, exempted nothing, and neither side said a word. The
 * same holds for a doubled separator or a `..` that lands back inside.
 */
export function isCanonicalRelative(rel) {
  if (rel === '' || path.isAbsolute(rel)) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Walk every component of `rel` under `root`, and report the first link.
 *
 * `lstat` ON THE LEAF IS NOT ENOUGH, and a review round supplied the
 * counterexample: stage a file under a directory, then replace that DIRECTORY
 * with a link to somewhere else. `--cached` still lists the descendant, and
 * `lstat` on it describes the real file at the end of a resolved ancestor — so
 * the scanner reads outside the repository while reporting nothing.
 *
 * @returns {{link?: string, stat?: import('node:fs').Stats, error?: NodeJS.ErrnoException}}
 */
export function pathProbe(root, rel) {
  // GIT'S SPELLING, and the contract is stated rather than defended: `rel` comes
  // from `git ls-files`, which always prints '/'. A review round found the
  // EXPORTED exemption validator taking `sub\\a.mjs` from a maintainer instead,
  // where the whole path collapsed to one component and the `lstat` resolved
  // `sub` — reporting the file at the end of a directory link as an ordinary
  // file. That is fixed where it belongs, by refusing the spelling in
  // `exemptionProblem`; splitting on a backslash here would take apart a
  // perfectly legal POSIX filename to defend against input that no longer
  // arrives.
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  let current = path.resolve(root);
  let stat;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      return { error };
    }
    if (stat.isSymbolicLink()) {
      return { link: path.relative(path.resolve(root), current).split(path.sep).join('/') };
    }
  }
  return { stat };
}

/**
 * Split `git ls-files -z` output into paths, keeping only what decodes exactly.
 *
 * THE BYTES ARE THE PATH. A filename byte that is not valid UTF-8 is perfectly
 * legal on Linux, and git prints it verbatim. Decoding the stream as UTF-8
 * replaces such a byte with U+FFFD — so a file literally named with a `0xFF`
 * byte and a file named with the three bytes of U+FFFD arrive as THE SAME
 * STRING, and a `Set` merges them. One of the two is then read and the other
 * never is: not eligible, not absent, not unreadable, not a link. The accounting
 * balances and the scan reports clean over a file it never opened.
 *
 * So each path survives only if decoding and re-encoding returns the original
 * bytes. Anything else is reported — being unable to NAME a file is a failure to
 * look, exactly like being unable to read one. The offending filename cannot be
 * created on Windows at all, which is why this is a pure function tested on
 * synthetic bytes rather than on a fixture.
 *
 * @returns {{paths: string[], undecodable: string[]}}
 */
export function undecodablePaths(buf) {
  const paths = [];
  const undecodable = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i += 1) {
    if (i !== buf.length && buf[i] !== 0) continue;
    if (i > start) {
      const slice = buf.subarray(start, i);
      const text = slice.toString('utf8');
      // DEDUPLICATION COMES AFTER THIS, never before: merging first is precisely
      // how the two names became one.
      if (Buffer.from(text, 'utf8').equals(slice)) paths.push(text);
      else undecodable.push(slice.toString('hex'));
    }
    start = i + 1;
  }
  return { paths: [...new Set(paths)], undecodable };
}

/**
 * Enumerate what a repository holds — tracked, plus added-but-not-committed.
 *
 * `--others` closes the gap this check fell into on its first day: `git ls-files`
 * alone lists only TRACKED paths, so the scan's own source file sat in the
 * working tree carrying three raw NULs while the suite reported green.
 * `--deduplicate` is not cosmetic either: an unresolved merge lists one path at
 * several stages, and every occurrence would otherwise be counted.
 *
 * WHICH IGNORE RULES COUNT, decided rather than inherited. `--exclude-standard`
 * bundles three sources, and two of them are private to one machine: a global
 * `core.excludesFile` and `$GIT_DIR/info/exclude`. Either one removes an
 * untracked offender from enumeration ENTIRELY — never eligible, never read, the
 * accounting still balanced, the coverage threshold still met, nothing said.
 * Both were measured doing it, against a control run that reported the offender.
 * A round-4 repair neutralised the config key and left the exclude file, which
 * is why the bundle is gone: `--exclude-per-directory=.gitignore` honours the
 * rules the repository COMMITS and reviewers can read, and nothing else. On this
 * repository the two enumerations were verified to list the same 646 paths.
 */
export function listRepositoryFiles(root, { isolate = true } = {}) {
  const r = spawnSync(
    'git',
    [
      // ENUMERATION MUST NOT FETCH, because a fetch runs a program. Reproduced
      // against a control: with the indexed `.gitignore` blob missing — ordinary
      // in a partial clone — and a promisor remote configured, this command
      // fetched that blob and RAN the caller's `core.sshCommand`, exiting 0.
      //
      // AS AN OPTION, NOT THE ENVIRONMENT VARIABLE. `GIT_NO_LAZY_FETCH` is
      // simply ignored by a git that predates it, so the protection would vanish
      // without a sound while every test stayed green. An unknown OPTION is
      // refused — measured, exit 129 — so on such a git this scan fails loudly
      // instead of quietly losing its defence.
      '--no-lazy-fetch',
      // `core.fsmonitor` NAMES A PROGRAM GIT RUNS to ask what changed, and
      // `--others` is precisely the walk that consults it. From the caller's
      // global config — which the non-isolated mode keeps — the enumeration
      // executed it: witness written, status 0, nothing said. Measured: this
      // flag stops it, and the control run without it shows the program
      // executing.
      '-c', 'core.fsmonitor=false',
      'ls-files', '-z', '--cached', '--others', '--exclude-per-directory=.gitignore', '--deduplicate',
    ],
    // NO `encoding`, so stdout arrives as BYTES. A path is a byte string and
    // decoding the whole stream as UTF-8 is lossy — see `undecodablePaths`.
    { cwd: root, env: gitEnv(isolate) },
  );
  if (r.status !== 0) {
    const why = r.stderr ? r.stderr.toString('utf8') : (r.error?.message ?? 'no status');
    throw new Error(`git ls-files failed in ${root}: ${why}`);
  }
  // `--deduplicate` is recent enough that an older git would ignore it, and a
  // duplicate here inflates coverage silently — so the set is rebuilt anyway,
  // AFTER the undecodable ones have been taken out.
  return undecodablePaths(r.stdout);
}

/**
 * Scan a repository and report what was found AND what could not be looked at.
 *
 * THE SECOND HALF IS THE POINT. The first version swallowed every read failure
 * with a bare `catch { continue; }` and counted PATHS THAT MATCHED AN EXTENSION
 * rather than files actually read, so enough listed paths satisfied its
 * thresholds while nothing at all was examined.
 *
 * @returns {{eligible: number, read: number, exempt: number, offenders: string[],
 *   unreadable: string[], absent: string[], links: string[], undecodable: string[]}}
 */
export function scanRepository(root, { exempt = new Map(), isolate = true } = {}) {
  const { paths: files, undecodable } = listRepositoryFiles(root, { isolate });
  const offenders = [];
  const unreadable = [];
  const absent = [];
  const links = [];
  let eligible = 0;
  let read = 0;
  let exemptSeen = 0;

  for (const rel of files) {
    if (!isSourcePath(rel)) continue;
    eligible += 1;

    // THE LINK CHECK COMES BEFORE THE EXEMPTION, and a review round is why: with
    // the order reversed, an exempt symlink was counted as exempt and never
    // reported — the one shape that lets content from outside the repository sit
    // behind a line somebody wrote for a different reason.
    const probe = pathProbe(root, rel);
    if (probe.error) {
      if (probe.error.code === 'ENOENT') absent.push(rel);
      else unreadable.push(`${rel}: ${probe.error.code ?? ''} ${probe.error.message}`.trim());
      continue;
    }
    if (probe.link) {
      links.push(probe.link === rel ? rel : `${rel} (via ${probe.link})`);
      continue;
    }
    if (!probe.stat.isFile()) {
      unreadable.push(`${rel}: not a regular file (${probe.stat.isDirectory() ? 'directory' : 'special'})`);
      continue;
    }
    if (exempt.has(rel)) { exemptSeen += 1; continue; }

    let raw;
    try {
      raw = fs.readFileSync(path.join(root, rel));
    } catch (err) {
      if (err.code === 'ENOENT') absent.push(rel);
      else unreadable.push(`${rel}: ${err.code ?? ''} ${err.message}`.trim());
      continue;
    }
    read += 1;
    const hits = new Map();
    for (const b of raw) {
      if (isControlByte(b)) hits.set(b, (hits.get(b) ?? 0) + 1);
    }
    if (hits.size > 0) {
      const what = [...hits.entries()]
        .map(([b, n]) => `0x${b.toString(16).padStart(2, '0')} x${n}`)
        .join(', ');
      offenders.push(`${rel} — ${what}`);
    }
  }
  // `undecodable` is deliberately NOT part of the accounting identity: such a
  // path never becomes eligible, because nothing can be said about its
  // extension or read from it. It is asserted empty instead, which is the only
  // honest treatment of a file this check cannot even name.
  return { eligible, read, exempt: exemptSeen, offenders, unreadable, absent, links, undecodable };
}

/**
 * Why an exemption is no longer valid, or `null` if it still is.
 *
 * Pure and exported so the RULE can be tested on synthetic cases: with an empty
 * exemption map the previous version's "no stale exemption" test executed zero
 * assertions — an empty loop counted as evidence that the rejection works.
 */
export function exemptionProblem(root, rel, reason) {
  if (!reason || reason.trim() === '') return 'an exemption must say why';
  if (!isContained(root, rel)) return 'exempted path escapes the repository — an exemption may only name a file inside it';
  // A WINDOWS RULE, and only a Windows rule. There, a backslash is a separator:
  // the scan looks entries up by the path git printed, which uses '/', so the
  // entry would sit in the map exempting nothing — and the walk, which splits on
  // '/' alone, would collapse `sub\\a.mjs` into one component and let its `lstat`
  // resolve a directory link. On POSIX the same character is a perfectly legal
  // filename character: git prints it, the scan matches it, and refusing it here
  // would reject a file this check can genuinely exempt. A review round supplied
  // that counterexample against the first version of this line.
  if (path.sep === '\\' && rel.includes('\\')) {
    return 'an exemption is spelled with forward slashes, the way git lists a path';
  }
  if (!isCanonicalRelative(rel)) {
    return 'an exemption is spelled exactly as git lists the path — no leading ./, no empty or .. component';
  }
  if (!isSourcePath(rel)) return 'exempted but not a file this check reads — the entry does nothing';
  // THE SAME LINK RULE AS THE SCAN. Validating an exemption by following a link
  // would let an external file supply the control byte that keeps the entry
  // "valid" — the exemption would then be justified by content the repository
  // does not contain.
  const probe = pathProbe(root, rel);
  if (probe.error) {
    return probe.error.code === 'ENOENT'
      ? 'exempted but no longer in the repository — drop the entry'
      : `exempted but unreadable (${probe.error.message})`;
  }
  if (probe.link) return 'exempted path passes through a symbolic link — this check never follows one';
  if (!probe.stat.isFile()) return 'exempted but not a regular file';
  const raw = fs.readFileSync(path.join(root, rel));
  if (![...raw].some(isControlByte)) return 'exempted but carries no control byte any more — drop the entry';
  return null;
}

describe('no source file carries a raw control byte', () => {
  // `isolate: false` — the caller's GLOBAL configuration is kept for THIS scan,
  // because a contributor whose checkout has different ownership relies on a
  // global `safe.directory` exception. Only the repository SELECTORS are
  // cleared, which is what stops an ambient GIT_DIR pointing this enumeration
  // at another tree entirely.
  const result = scanRepository(REPO, { exempt: ALLOWED_FILES, isolate: false });

  test('the scan actually read the repository', () => {
    assert.ok(result.eligible > 400, `only ${result.eligible} source files listed — enumeration did not run properly`);
    assert.deepEqual(result.unreadable, [], 'a file this scan could not read is a failure to look, not a clean result');
    assert.deepEqual(result.absent, [], 'git listed a path the working tree does not hold — coverage is incomplete');
    assert.deepEqual(result.links, [], 'this repository bans symlinked source: decide what one should mean before scanning it');
    assert.deepEqual(
      result.undecodable, [],
      'git listed a path whose bytes are not valid UTF-8; it cannot be named, so it cannot be read',
    );
    assert.equal(
      result.read + result.absent.length + result.unreadable.length + result.links.length + result.exempt,
      result.eligible,
      'every eligible file must be read, absent, unreadable, a link, or exempt — nothing may fall between',
    );
  });

  test('no scanned file carries a control byte outside tab, LF and CR', () => {
    assert.deepEqual(
      result.offenders, [],
      'raw control bytes in source: build them with String.fromCharCode and say why, '
      + 'or add the file to ALLOWED_FILES with a reason',
    );
  });

  test('the definition of a control byte is the one this check claims', () => {
    assert.equal(isControlByte(0x00), true, 'NUL is a control byte');
    assert.equal(isControlByte(0x1b), true, 'ESC is a control byte');
    assert.equal(isControlByte(0x1f), true, 'US is a control byte');
    assert.equal(isControlByte(0x7f), true, 'DEL is a control byte — the first sweep missed it');
    assert.equal(isControlByte(0x09), false, 'tab is allowed');
    assert.equal(isControlByte(0x0a), false, 'LF is allowed');
    assert.equal(isControlByte(0x0d), false, 'CR is allowed — a CRLF checkout must not fail this');
    assert.equal(isControlByte(0x20), false, 'space is not a control byte');
    assert.equal(isControlByte(0x41), false, 'A is not a control byte');
    assert.equal(isControlByte(0x7e), false, '~ is the last printable ASCII');
    assert.equal(isControlByte(0x80), false, 'C1 is out of scope here, and the header says so');
  });

  /**
   * THE COLLISION THAT CANNOT BE BUILT ON WINDOWS, tested as bytes.
   *
   * A review round supplied it: a file whose name is the single byte `0xFF`
   * followed by `.mjs`, and a file whose name is the three UTF-8 bytes of
   * U+FFFD followed by `.mjs`. Both are legal on Linux and git prints both
   * verbatim. Decoded as UTF-8 they are the SAME STRING, and the set that
   * deduplicates the list merges them — so one is read and the other is never
   * looked at, in no bucket at all.
   */
  test('a path whose bytes are not valid UTF-8 is reported, never merged with another', () => {
    const nul = 0x00;
    const suffix = [0x2e, 0x6d, 0x6a, 0x73]; // ".mjs"
    const invalid = Buffer.from([0xff, ...suffix]);
    const replacement = Buffer.from([0xef, 0xbf, 0xbd, ...suffix]); // U+FFFD, legitimately
    const stream = Buffer.from([...invalid, nul, ...replacement, nul]);

    // The shape of the defect, first: decoding both gives one string.
    assert.equal(
      invalid.toString('utf8'), replacement.toString('utf8'),
      'the premise of this test is that UTF-8 decoding merges these two names',
    );

    const { paths, undecodable } = undecodablePaths(stream);
    assert.deepEqual(
      paths, [replacement.toString('utf8')],
      'only the genuinely UTF-8 name is kept as a path',
    );
    assert.deepEqual(
      undecodable, [invalid.toString('hex')],
      'the byte sequence that cannot be named is REPORTED, not silently merged away',
    );

    // And ordinary paths still deduplicate.
    const plain = Buffer.from('a.mjs\0b.mjs\0a.mjs\0', 'utf8');
    assert.deepEqual(undecodablePaths(plain).paths, ['a.mjs', 'b.mjs'], 'duplicates still collapse');
    assert.deepEqual(undecodablePaths(plain).undecodable, [], 'and nothing valid is rejected');
  });

  test('containment is decided without building a doubled separator', () => {
    assert.equal(isContained('/', 'a.mjs'), true, 'a child of the filesystem root is inside it');
    assert.equal(isContained('/tmp/repo/', 'a.mjs'), true, 'a trailing separator on the root changes nothing');
    // EVERY ONE OF THESE CARRIES A MESSAGE. A review round pointed out that a
    // mutation of this predicate produced a bare `true !== false`, attributable
    // to nothing — and this is the only place containment is measured on its
    // own, the exemption validator having a second rule that rejects the same
    // two inputs for a different reason.
    assert.equal(isContained('/tmp/repo', '../outside.mjs'), false, 'a parent escape is not contained');
    assert.equal(isContained('/tmp/repo', 'sub/../a.mjs'), true, 'a `..` that lands back inside is inside');
    assert.equal(isContained('/tmp/repo', ''), false, 'the root itself is not a file in it');
    assert.equal(isContained('/tmp/repo', '..fixture.mjs'), true, 'a name may begin with two dots');
    assert.equal(isContained('/tmp/repo', '..'), false, 'the parent itself is outside');
  });

  describe('an exemption has to earn its place', () => {
    const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exempt-probe-'));

    test('over a file that still carries a byte, it is accepted', () => {
      const dir = scratch();
      try {
        fs.writeFileSync(path.join(dir, 'f.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
        assert.equal(exemptionProblem(dir, 'f.mjs', 'the byte is the fixture'), null);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('with no reason, it is refused', () => {
      const dir = scratch();
      try {
        fs.writeFileSync(path.join(dir, 'f.mjs'), `x${String.fromCharCode(0)}`);
        assert.match(
          String(exemptionProblem(dir, 'f.mjs', '   ')),
          /must say why/,
          'an exemption with no reason must be refused',
        );
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('over a file that no longer exists, it is refused', () => {
      const dir = scratch();
      try {
        assert.match(
          String(exemptionProblem(dir, 'gone.mjs', 'because')),
          /no longer in the repository/,
          'an exemption over a file that is gone must be refused',
        );
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('over a file that is now clean, it is refused', () => {
      const dir = scratch();
      try {
        fs.writeFileSync(path.join(dir, 'f.mjs'), 'const x = 1;\n');
        assert.match(
          String(exemptionProblem(dir, 'f.mjs', 'because')),
          /carries no control byte any more/,
          'an exemption over a file that is clean again must be refused, and say so',
        );
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('over a file this check never reads, it is refused as pointless', () => {
      const dir = scratch();
      try {
        fs.writeFileSync(path.join(dir, 'f.png'), Buffer.from([0, 1, 2]));
        assert.match(
          String(exemptionProblem(dir, 'f.png', 'because')),
          /not a file this check reads/,
          'an exemption over a file this check never reads does nothing, and must be refused',
        );
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('over a path outside the repository, it is refused', () => {
      const dir = scratch();
      try {
        fs.writeFileSync(path.join(dir, 'outside.mjs'), `x${String.fromCharCode(0)}`);
        const inner = path.join(dir, 'repo');
        fs.mkdirSync(inner);
        const escape = 'an exemption naming a path outside the repository must be refused';
        assert.match(String(exemptionProblem(inner, '../outside.mjs', 'because')), /escapes the repository/, escape);
        assert.match(String(exemptionProblem(inner, path.join(dir, 'outside.mjs'), 'because')), /escapes the repository/, escape);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    // The route a review round found: the exemption is spelled inside the
    // repository, and a LINK carries the reader outside it.
    test('over a link whose target supplies the byte, it is refused', (t) => {
      const dir = scratch();
      try {
        fs.writeFileSync(path.join(dir, 'outside.mjs'), `x${String.fromCharCode(0)}`);
        const inner = path.join(dir, 'repo');
        fs.mkdirSync(inner);
        try {
          fs.symlinkSync(path.join(dir, 'outside.mjs'), path.join(inner, 'inside.mjs'));
        } catch (err) {
          t.skip(`this environment cannot create a symlink (${err.code})`);
          return;
        }
        assert.match(
          String(exemptionProblem(inner, 'inside.mjs', 'because')),
          /passes through a symbolic link/,
          'an exemption reaching its byte through a link must be refused',
        );
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    // A BACKSLASH SPELLING IS REFUSED, not resolved. The scan looks entries up by
    // the path git printed, so `sub\\a.mjs` would exempt nothing whatever it
    // meant; and before the walk handled both separators it collapsed to ONE
    // component, so the `lstat` resolved `sub` and reported the file at the end
    // of a directory link as an ordinary file.
    test('a backslash is a separator on Windows and a filename character elsewhere', () => {
      const dir = scratch();
      try {
        fs.mkdirSync(path.join(dir, 'sub'));
        fs.writeFileSync(path.join(dir, 'sub', 'a.mjs'), `x${String.fromCharCode(0)}`);
        assert.equal(exemptionProblem(dir, 'sub/a.mjs', 'because'), null, 'the git spelling is accepted');

        if (path.sep === '\\') {
          assert.match(
            String(exemptionProblem(dir, 'sub\\a.mjs', 'because')),
            /forward slashes/,
            'on Windows an exemption spelled with a backslash must be refused, not walked',
          );
        } else {
          // THE COUNTEREXAMPLE A REVIEW ROUND SUPPLIED. Here this is one file
          // whose name contains a backslash — git prints it, the scan matches it,
          // and refusing it would reject a file this check can genuinely exempt.
          fs.writeFileSync(path.join(dir, 'lit\\eral.mjs'), `x${String.fromCharCode(0)}`);
          assert.equal(
            exemptionProblem(dir, 'lit\\eral.mjs', 'because'), null,
            'on POSIX a backslash is part of the filename, and such an exemption is legal',
          );
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    // THE SPELLING MUST BE THE ONE THE SCAN LOOKS UP. An entry git would never
    // print cannot match anything, so accepting it creates an exemption that
    // exempts nothing — and says nothing.
    test('an exemption must be spelled exactly as git lists the path', () => {
      const dir = scratch();
      try {
        fs.writeFileSync(path.join(dir, 'f.mjs'), `x${String.fromCharCode(0)}`);
        fs.mkdirSync(path.join(dir, 'sub'));
        fs.writeFileSync(path.join(dir, 'sub', 'g.mjs'), `x${String.fromCharCode(0)}`);
        assert.equal(exemptionProblem(dir, 'f.mjs', 'because'), null, 'the git spelling is accepted');

        for (const spelling of ['./f.mjs', 'sub//g.mjs', 'sub/./g.mjs', 'sub/../f.mjs']) {
          assert.match(
            String(exemptionProblem(dir, spelling, 'because')),
            /spelled exactly as git lists the path/,
            `${JSON.stringify(spelling)} must be refused: the scan looks entries up by the path git printed, `
            + 'so this entry would exempt nothing at all',
          );
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('every exemption actually recorded here is still valid', () => {
      for (const [rel, reason] of ALLOWED_FILES) {
        const problem = exemptionProblem(REPO, rel, reason);
        assert.equal(problem, null, `${rel}: ${problem}`);
      }
    });

    /**
     * AND EVERY KEY MUST BE ONE GIT ACTUALLY PRINTS.
     *
     * The syntactic rules say a spelling is well formed; they cannot say it is
     * THE spelling. On a case-insensitive filesystem `F.mjs` passes every one of
     * them — the probe and the read both reach `f.mjs` — while the scan's
     * exact-string lookup of `f.mjs` misses the entry entirely. An exemption that
     * exempts nothing, once more, and silently.
     */
    test('every exemption key is a path this repository actually lists', () => {
      if (ALLOWED_FILES.size === 0) return;
      const listed = new Set(listRepositoryFiles(REPO, { isolate: false }).paths);
      for (const rel of ALLOWED_FILES.keys()) {
        assert.equal(
          listed.has(rel), true,
          `${rel} is not a path git lists here, so the scan would never match this exemption`,
        );
      }
    });
  });

  /**
   * THE SCAN, RUN AGAINST REAL REPOSITORIES IT DOES NOT OWN.
   *
   * The first version planted a probe inside THIS repository's `tests/` and then
   * merely called `isControlByte` on it — never invoking the scanner, so it
   * would have passed with discovery removed entirely. Throwaway repositories
   * answer the question the names promise.
   */
  describe('the scan refuses what it should, in a repository of its own', () => {
    const dirs = [];
    const makeRepo = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-probe-'));
      dirs.push(dir);
      // `--template` with an EMPTY directory: an ambient GIT_TEMPLATE_DIR would
      // otherwise seed every fixture repository with the caller's hooks and
      // exclude file.
      const init = spawnSync(
        'git',
        ['init', '-q', `--template=${EMPTY_TEMPLATE}`],
        { cwd: dir, encoding: 'utf8', env: gitEnv() },
      );
      assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
      return dir;
    };
    /**
     * Point a config key at a PROGRAM, quoted, through git itself.
     *
     * These values are shell command lines, so an unquoted path containing a
     * space becomes two words and the program never runs — and the fixture then
     * reports "nothing executed", which is exactly what it is supposed to prove.
     * An earlier version skipped the test instead, which CI accepts: the
     * coverage simply disappeared.
     *
     * MEASURED, with a control: an unspaced path runs quoted or unquoted, a
     * spaced path runs ONLY quoted. Quoting therefore costs nothing and buys the
     * spaced case. The value goes through `git config` so the FILE-level
     * escaping is git's problem rather than a second guess of mine — there are
     * two quoting layers here and guessing at them has been wrong before.
     */
    const configureProgram = (configPath, key, program) => {
      const r = spawnSync(
        'git',
        ['config', '--file', configPath, key, `"${program.split('\\').join('/')}"`],
        { encoding: 'utf8', env: gitEnv() },
      );
      assert.equal(r.status, 0, `git config --file failed: ${r.stderr}`);
    };

    const gitIn = (dir, args) => {
      // `-c core.hooksPath` on top of the cleared runtime config.
      //
      // A CLAIM WAS WITHDRAWN HERE. An earlier comment said a mutation had
      // MEASURED that environment-injected configuration defeats this flag.
      // It measured nothing: that mutant left `GIT_CONFIG_COUNT=1` while the
      // KEY/VALUE pair was still deleted, so git errored on a count with no
      // pairs and the fixture failed at `git init` — before the hook could
      // run. Git documents that `-c` overrides those pairs. Two defences,
      // then, and the test below exists to name the environment one alone.
      const r = spawnSync(
        'git',
        [
          '-c', `core.hooksPath=${EMPTY_TEMPLATE}`,
          // An identity, because the isolated HOME holds no configuration and a
          // fixture that needs to COMMIT would otherwise fail at the identity
          // check rather than at the thing under test.
          '-c', 'user.name=scan fixture', '-c', 'user.email=fixture@example.invalid',
          ...args,
        ],
        { cwd: dir, encoding: 'utf8', env: gitEnv() },
      );
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
      return r;
    };
    after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

    test('a clean repository passes, and the file really was read', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
      const r = scanRepository(dir);
      assert.deepEqual(r.offenders, []);
      assert.equal(r.eligible, 1);
      assert.equal(r.read, 1);
    });

    test('an UNTRACKED file carrying a control byte is caught', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
      const r = scanRepository(dir);
      assert.equal(r.read, 1, `the file must actually have been read: ${JSON.stringify(r)}`);
      assert.equal(r.offenders.length, 1);
      assert.match(r.offenders[0], /a\.mjs — 0x00 x1/);
    });

    test('a TRACKED file carrying a control byte is caught', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), `const x = 'a${String.fromCharCode(0x1b)}b';\n`);
      gitIn(dir, ['add', 'a.mjs']);
      const r = scanRepository(dir);
      assert.equal(r.read, 1);
      assert.equal(r.offenders.length, 1);
      assert.match(r.offenders[0], /0x1b/);
    });

    test('an extensionless file is read, not skipped', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'Dockerfile'), `FROM x${String.fromCharCode(0)}\n`);
      const r = scanRepository(dir);
      assert.equal(r.read, 1, 'the Dockerfile must be read, not skipped for having no extension');
      assert.equal(r.offenders.length, 1);
      assert.match(r.offenders[0], /Dockerfile/);
    });

    test('ONE file of an unheard-of kind is enough, not three', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'one.tsx'), `const x = 'a${String.fromCharCode(0)}b';\n`);
      const r = scanRepository(dir);
      assert.equal(r.read, 1);
      assert.equal(r.offenders.length, 1);
    });

    // ONE CASE PER CATEGORY. The accounting identity cannot see a whole
    // extension leave the scan — an excluded file disappears from BOTH sides of
    // it — so each category that must stay scanned is pinned on its own.
    for (const ext of REQUIRED_SOURCE_EXTENSIONS) {
      test(`a ${ext} file is still scanned`, () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, `probe${ext}`), `x${String.fromCharCode(0)}y\n`);
        const r = scanRepository(dir);
        assert.equal(r.eligible, 1, `${ext} must be eligible`);
        assert.equal(r.read, 1, `${ext} must actually be read`);
        assert.equal(r.offenders.length, 1, `${ext} must report its control byte`);
      });
    }

    test('a declared non-source file is left alone, and not counted', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x1b]));
      const r = scanRepository(dir);
      assert.deepEqual(r.offenders, []);
      assert.equal(r.eligible, 0);
    });

    test('tab, LF and CR pass — a CRLF checkout must not fail this', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), 'const x = 1;\r\n\tconst y = 2;\r\n');
      const r = scanRepository(dir);
      assert.equal(r.read, 1, 'and the file was read, not skipped by an ambient ignore');
      assert.deepEqual(r.offenders, []);
    });

    test('a file that cannot be read is REPORTED, never counted as clean', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
      gitIn(dir, ['add', 'a.mjs']);
      fs.rmSync(path.join(dir, 'a.mjs'));
      fs.mkdirSync(path.join(dir, 'a.mjs'));
      const r = scanRepository(dir);
      assert.equal(r.read, 0, 'nothing was read');
      assert.equal(r.unreadable.length, 1, `and the failure is reported: ${JSON.stringify(r)}`);
      assert.deepEqual(r.offenders, [], 'without inventing a finding');
    });

    test('a path git lists but the tree does not hold is reported as absent', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
      gitIn(dir, ['add', 'a.mjs']);
      fs.rmSync(path.join(dir, 'a.mjs'));
      const r = scanRepository(dir);
      assert.deepEqual(r.absent, ['a.mjs']);
      assert.equal(r.read, 0);
    });

    test('a symlinked file is reported, never followed', (t) => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'clean.mjs'), 'export const a = 1;\n');
      try {
        fs.symlinkSync(path.join(dir, 'clean.mjs'), path.join(dir, 'link.mjs'));
      } catch (err) {
        t.skip(`this environment cannot create a symlink (${err.code})`);
        return;
      }
      const r = scanRepository(dir);
      assert.deepEqual(r.links, ['link.mjs'], JSON.stringify(r));
      assert.equal(r.read, 1, 'only the real file was read');
    });

    // THE ANCESTOR ROUTE. `lstat` on the leaf resolves the directories above it,
    // so a link in the MIDDLE of the path carried the reader outside the
    // repository while the scan reported nothing at all.
    test('a link in the MIDDLE of the path is reported, never followed', (t) => {
      const dir = makeRepo();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      dirs.push(outside);
      fs.writeFileSync(path.join(outside, 'a.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 'a.mjs'), 'export const a = 1;\n');
      gitIn(dir, ['add', 'sub/a.mjs']);
      fs.rmSync(path.join(dir, 'sub'), { recursive: true, force: true });
      try {
        fs.symlinkSync(outside, path.join(dir, 'sub'), 'dir');
      } catch (err) {
        t.skip(`this environment cannot create a directory symlink (${err.code})`);
        return;
      }
      const r = scanRepository(dir);
      assert.equal(r.read, 0, `nothing outside the repository may be read: ${JSON.stringify(r)}`);
      assert.deepEqual(r.offenders, [], 'and no finding invented from foreign content');
      // NOT AN EXACT COUNT: git lists the untracked link `sub` AND the tracked
      // `sub/a.mjs` beneath it, so both are reported. Pinning "exactly one"
      // would describe git's enumeration rather than the rule under test.
      assert.ok(r.links.length >= 1, JSON.stringify(r));
      assert.ok(
        r.links.some((l) => l.includes('via sub')),
        `the descendant must be reported as reached through the link: ${JSON.stringify(r)}`,
      );
    });

    test('a directory git cannot enumerate throws rather than reporting clean', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
      dirs.push(dir);
      assert.throws(
        () => scanRepository(dir), /git ls-files failed/,
        'a directory git refuses to enumerate must throw, never read as an empty clean repository',
      );
    });

    test('an exempt file is not read, and the accounting says so', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
      const r = scanRepository(dir, { exempt: new Map([['a.mjs', 'because']]) });
      // THE MEANING FIRST. This assertion is what the test is about, and a
      // review round found it sitting fourth, behind an unmessaged `deepEqual`
      // that fails first and explains nothing.
      assert.equal(r.read, 0, `an exempt file is counted as eligible but never read: ${JSON.stringify(r)}`);
      assert.equal(r.exempt, 1, JSON.stringify(r));
      assert.equal(r.eligible, 1, JSON.stringify(r));
      assert.deepEqual(r.offenders, [], 'an exempt file cannot produce a finding');
    });

    // An exemption must not be able to hide a link: the link check runs first.
    test('an exempt SYMLINK is still reported as a link', (t) => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'clean.mjs'), 'export const a = 1;\n');
      try {
        fs.symlinkSync(path.join(dir, 'clean.mjs'), path.join(dir, 'link.mjs'));
      } catch (err) {
        t.skip(`this environment cannot create a symlink (${err.code})`);
        return;
      }
      const r = scanRepository(dir, { exempt: new Map([['link.mjs', 'because']]) });
      assert.deepEqual(r.links, ['link.mjs'], `an exemption may not swallow a link: ${JSON.stringify(r)}`);
      assert.equal(r.exempt, 0);
    });

    /**
     * THE FIXTURES MUST NOT REACH THE CALLER'S REPOSITORY.
     *
     * `cwd` is not isolation, and this project's own commit procedure exports
     * `GIT_INDEX_FILE` routinely. Hostile values are set here deliberately and
     * the things they name — all inside temp directories — must come out
     * untouched.
     */
    test('a hostile GIT_INDEX_FILE cannot be written by these fixtures', () => {
      const victimRepo = makeRepo();
      const victimIndex = path.join(victimRepo, '.git', 'index');
      fs.writeFileSync(path.join(victimRepo, 'v.mjs'), 'export const v = 1;\n');
      gitIn(victimRepo, ['add', 'v.mjs']);
      const before = fs.readFileSync(victimIndex);

      const saved = process.env.GIT_INDEX_FILE;
      process.env.GIT_INDEX_FILE = victimIndex;
      try {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, 'a.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
        gitIn(dir, ['add', 'a.mjs']);
        const r = scanRepository(dir);
        assert.equal(r.offenders.length, 1, 'the fixture still worked');
      } finally {
        if (saved === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = saved;
      }

      assert.deepEqual(
        fs.readFileSync(victimIndex), before,
        'a fixture wrote into the index named by the ambient GIT_INDEX_FILE',
      );
    });

    // RUNTIME CONFIGURATION OUTRANKS ANY CONFIG FILE. `GIT_CONFIG_COUNT` with a
    // `core.hooksPath` pair makes a fixture's `git add` EXECUTE the caller's
    // hook — a documented hook point, not a hypothetical.
    test('an ambient core.hooksPath cannot make a fixture run somebody else\'s hook', () => {
      const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
      dirs.push(hookDir);
      const witness = path.join(hookDir, 'the-hook-ran');
      const hook = path.join(hookDir, 'post-index-change');
      const script = process.platform === 'win32'
        ? `#!/bin/sh\necho ran > "${witness.split('\\').join('/')}"\n`
        : `#!/bin/sh\necho ran > "${witness}"\n`;
      fs.writeFileSync(hook, script, { mode: 0o755 });

      const saved = {
        count: process.env.GIT_CONFIG_COUNT,
        key: process.env.GIT_CONFIG_KEY_0,
        value: process.env.GIT_CONFIG_VALUE_0,
        template: process.env.GIT_TEMPLATE_DIR,
      };
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
      process.env.GIT_CONFIG_VALUE_0 = hookDir;
      process.env.GIT_TEMPLATE_DIR = hookDir;
      try {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
        gitIn(dir, ['add', 'a.mjs']);
      } finally {
        for (const [k, v] of [
          ['GIT_CONFIG_COUNT', saved.count], ['GIT_CONFIG_KEY_0', saved.key],
          ['GIT_CONFIG_VALUE_0', saved.value], ['GIT_TEMPLATE_DIR', saved.template],
        ]) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      assert.equal(fs.existsSync(witness), false, 'a fixture executed a hook the caller supplied');
    });

    // THE SAME HOSTILE SETUP, WITHOUT THE FLAG, so the environment clearing has
    // a witness that names it alone. Two overlapping defences otherwise leave
    // every mutation ambiguous about which one is holding — the project's rule
    // is to write the missing witness rather than remove a check.
    test('the cleared environment ALONE stops a caller hook, without the -c flag', () => {
      const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-env-'));
      dirs.push(hookDir);
      const witness = path.join(hookDir, 'the-hook-ran');
      fs.writeFileSync(
        path.join(hookDir, 'post-index-change'),
        `#!/bin/sh\necho ran > "${witness.split('\\').join('/')}"\n`,
        { mode: 0o755 },
      );

      const saved = {
        count: process.env.GIT_CONFIG_COUNT,
        key: process.env.GIT_CONFIG_KEY_0,
        value: process.env.GIT_CONFIG_VALUE_0,
      };
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
      process.env.GIT_CONFIG_VALUE_0 = hookDir;
      try {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
        const add = spawnSync('git', ['add', 'a.mjs'], { cwd: dir, encoding: 'utf8', env: gitEnv() });
        assert.equal(add.status, 0, `git add failed: ${add.stderr}`);
      } finally {
        for (const [k, v] of [
          ['GIT_CONFIG_COUNT', saved.count], ['GIT_CONFIG_KEY_0', saved.key],
          ['GIT_CONFIG_VALUE_0', saved.value],
        ]) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      assert.equal(
        fs.existsSync(witness), false,
        'with the -c flag absent, the environment alone must still refuse the hook',
      );
    });

    /**
     * ENUMERATION MUST NOT FETCH, because a fetch runs a program.
     *
     * The chain, and every link of it was built and checked rather than argued:
     * `.gitignore` in the index as `skip-worktree` and gone from the worktree, so
     * the ignore rules are read from the INDEXED BLOB; that blob missing, which
     * is ordinary in a partial clone; a promisor remote configured, so git tries
     * to fetch it; and the fetch running `core.sshCommand` from the caller's
     * global config — which the non-isolated mode keeps deliberately. Measured:
     * the program ran and `ls-files` exited 0.
     *
     * With the fetch refused, git cannot read that ignore file and its rules
     * lapse. An earlier note here claimed that direction is always safe — "more
     * files scanned, never fewer". That is FALSE, and a review round supplied the
     * counterexample: a nested `!offender.mjs` under a parent `sub/*.mjs` lapses
     * into FEWER files enumerated. What actually keeps this fail-closed is that
     * the ignore file is TRACKED and missing from the worktree, so the scan of a
     * real repository reports it as absent — a bucket asserted empty.
     */
    test("a missing indexed ignore blob cannot make the enumeration run the caller's transport program", () => {
      const progDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-'));
      dirs.push(progDir);
      const witness = path.join(progDir, 'transport.ran');
      const prog = path.join(progDir, 'ssh.sh');
      fs.writeFileSync(
        prog,
        `#!/bin/sh\necho ran > "${witness.split('\\').join('/')}"\nexit 1\n`,
        { mode: 0o755 },
      );
      const config = path.join(progDir, 'gitconfig');
      configureProgram(config, 'core.sshCommand', prog);

      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.mjs\n');
      fs.writeFileSync(path.join(dir, 'kept.mjs'), 'export const k = 1;\n');
      fs.writeFileSync(path.join(dir, 'ignored.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
      gitIn(dir, ['add', '.gitignore', 'kept.mjs']);
      gitIn(dir, ['commit', '-q', '-m', 'seed']);

      const hash = gitIn(dir, ['rev-parse', 'HEAD:.gitignore']).stdout.trim();
      gitIn(dir, ['update-index', '--skip-worktree', '.gitignore']);
      fs.rmSync(path.join(dir, '.gitignore'));
      const loose = path.join(dir, '.git', 'objects', hash.slice(0, 2), hash.slice(2));
      // If this git packs the object instead of writing it loose, the chain
      // cannot be built and the test would pass for the wrong reason.
      assert.equal(fs.existsSync(loose), true, 'the fixture needs the blob as a loose object');
      fs.rmSync(loose);

      for (const [key, value] of [
        ['extensions.partialClone', 'probe'], ['remote.probe.promisor', 'true'],
        ['remote.probe.url', 'ssh://example.invalid/r'],
        ['remote.probe.fetch', '+refs/heads/*:refs/remotes/probe/*'],
      ]) gitIn(dir, ['config', key, value]);

      // SET DELIBERATELY. Either of these, inherited, stops the fetch on its
      // own — so clearing them is what makes the control run below mean
      // anything, and setting them here is what turns that from a claim into a
      // witness.
      const saved = {
        global: process.env.GIT_CONFIG_GLOBAL,
        noLazy: process.env.GIT_NO_LAZY_FETCH,
        protocols: process.env.GIT_ALLOW_PROTOCOL,
      };
      process.env.GIT_CONFIG_GLOBAL = config;
      process.env.GIT_NO_LAZY_FETCH = '1';
      process.env.GIT_ALLOW_PROTOCOL = 'file';
      try {
        // THE INSTRUMENT FIRST, and here it matters twice: an ambient
        // `GIT_NO_LAZY_FETCH` or `GIT_ALLOW_PROTOCOL` would also keep the
        // program from running, so an absent witness alone could mean the
        // caller's environment rather than this scan's flag. Without the flag,
        // the fetch must happen and the program must run.
        const unprotected = spawnSync(
          'git',
          ['-c', 'core.fsmonitor=false',
            'ls-files', '-z', '--cached', '--others', '--exclude-per-directory=.gitignore', '--deduplicate'],
          { cwd: dir, encoding: 'utf8', env: gitEnv(false) },
        );
        assert.equal(
          fs.existsSync(witness), true,
          'the control run must EXECUTE the transport, or this fixture proves nothing about --no-lazy-fetch'
          + ` (status ${unprotected.status}: ${unprotected.stderr})`,
        );
        fs.rmSync(witness);

        scanRepository(dir, { isolate: false });
      } finally {
        for (const [key, value] of [
          ['GIT_CONFIG_GLOBAL', saved.global],
          ['GIT_NO_LAZY_FETCH', saved.noLazy],
          ['GIT_ALLOW_PROTOCOL', saved.protocols],
        ]) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      assert.equal(
        fs.existsSync(witness), false,
        'the enumeration ran the transport program the caller configured',
      );
    });

    /**
     * WHERE GIT LOOKS FOR ITS OWN PROGRAMS IS ALSO THE CALLER'S TO SET.
     *
     * `GIT_EXEC_PATH` is prepended to the search path git uses when it spawns
     * its own subprocesses. Put a `git` there and a fixture's commit runs it —
     * measured, with the commit still reporting success, because a successful
     * commit triggers auto-maintenance and that spawns another git. Nothing in
     * the config or the command line is involved; it is the environment alone,
     * which is why this belongs beside the `core.hooksPath` case rather than
     * with the config keys.
     */
    test('an ambient GIT_EXEC_PATH cannot make a fixture run a caller program', () => {
      const execDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execpath-'));
      dirs.push(execDir);
      const witness = path.join(execDir, 'the-caller-git-ran');
      fs.writeFileSync(
        path.join(execDir, 'git'),
        `#!/bin/sh\necho ran >> "${witness.split('\\').join('/')}"\nexit 0\n`,
        { mode: 0o755 },
      );

      const saved = process.env.GIT_EXEC_PATH;
      process.env.GIT_EXEC_PATH = execDir;
      try {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
        gitIn(dir, ['add', 'a.mjs']);
        gitIn(dir, ['commit', '-q', '-m', 'seed']);
        const r = scanRepository(dir);
        assert.equal(r.read, 1, `the fixture still worked: ${JSON.stringify(r)}`);
      } finally {
        if (saved === undefined) delete process.env.GIT_EXEC_PATH;
        else process.env.GIT_EXEC_PATH = saved;
      }
      assert.equal(
        fs.existsSync(witness), false,
        'a fixture ran a git the caller supplied through GIT_EXEC_PATH',
      );
    });

    /**
     * A FIXTURE THAT COMMITS MUST NOT DEPEND ON THE CALLER EITHER.
     *
     * The committed-ignore case was added by a review round, and with it the
     * first `git commit` in this file. Author and committer metadata come from
     * six environment variables that an explicit `-c user.name` does not touch:
     * `GIT_AUTHOR_DATE=not-a-date` makes git refuse the commit, so the fixture
     * dies at setup and its name lands in the failing list having tested
     * nothing. That is the exact shape three rounds of this review have been
     * removing.
     */
    test('a hostile ambient GIT_AUTHOR_DATE cannot break a fixture that commits', () => {
      const saved = process.env.GIT_AUTHOR_DATE;
      process.env.GIT_AUTHOR_DATE = 'not-a-date';
      try {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
        gitIn(dir, ['add', 'a.mjs']);
        // NOT through `gitIn`'s own assertion: its message names the command,
        // not the rule, and a kill has to be attributable to what it proves.
        const commit = spawnSync(
          'git',
          ['-c', 'user.name=scan fixture', '-c', 'user.email=fixture@example.invalid',
            'commit', '-q', '-m', 'seed'],
          { cwd: dir, encoding: 'utf8', env: gitEnv() },
        );
        assert.equal(
          commit.status, 0,
          `a fixture that commits must not depend on the caller's ambient metadata: ${commit.stderr}`,
        );
        const r = scanRepository(dir);
        assert.equal(r.read, 1, JSON.stringify(r));
      } finally {
        if (saved === undefined) delete process.env.GIT_AUTHOR_DATE;
        else process.env.GIT_AUTHOR_DATE = saved;
      }
    });

    // THE TRACE FAMILY GROWS WITH GIT, so it is cleared by PREFIX. A review
    // round named `GIT_TRACE_REFS`, which was absent from the hand-written list
    // and is enough on its own to append to any absolute path the caller sets,
    // while `git init` still succeeds — a fixture writing outside its scratch
    // directory with nothing failing.
    test('an ambient GIT_TRACE_REFS cannot make a fixture write outside its scratch space', () => {
      const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
      dirs.push(traceDir);
      const traceFile = path.join(traceDir, 'refs.log');

      const saved = process.env.GIT_TRACE_REFS;
      process.env.GIT_TRACE_REFS = traceFile;
      try {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
        gitIn(dir, ['add', 'a.mjs']);
      } finally {
        if (saved === undefined) delete process.env.GIT_TRACE_REFS;
        else process.env.GIT_TRACE_REFS = saved;
      }
      assert.equal(fs.existsSync(traceFile), false, 'a fixture wrote a trace outside its scratch space');
    });

    // THE PRICE OF KEEPING THE CALLER'S GLOBAL CONFIGURATION. The scan of this
    // repository does keep it — `safe.directory` lives there — and
    // `--exclude-standard` honours a global `core.excludesFile`, so a
    // contributor's global ignore could remove an untracked offender from
    // enumeration entirely: never eligible, never read, accounting balanced,
    // threshold met, nothing said.
    test('a global core.excludesFile cannot hide an untracked offender from the non-isolated scan', () => {
      const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'globalconf-'));
      dirs.push(confDir);
      const excludes = path.join(confDir, 'ignore');
      fs.writeFileSync(excludes, 'a.mjs\n');
      const config = path.join(confDir, 'gitconfig');
      fs.writeFileSync(config, `[core]\n\texcludesFile = ${excludes.split('\\').join('/')}\n`);

      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);

      const saved = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = config;
      let r;
      try {
        // `isolate: false` is the mode this repository's own scan uses.
        r = scanRepository(dir, { isolate: false });
      } finally {
        if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = saved;
      }
      assert.equal(r.eligible, 1, `a global ignore hid the file from enumeration: ${JSON.stringify(r)}`);
      assert.equal(r.offenders.length, 1, JSON.stringify(r));
    });

    // THE PRIVATE EXCLUDE FILE, which is the half of the same hole a round-4
    // repair left open. `--exclude-standard` bundles three sources and two of
    // them are per-machine; neutralising `core.excludesFile` said nothing about
    // `$GIT_DIR/info/exclude`. Measured against a control run: with the line
    // present the offender vanished from `eligible` entirely.
    test('a private .git/info/exclude cannot hide an untracked offender', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
      fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'a.mjs\n');

      const r = scanRepository(dir);
      assert.equal(r.eligible, 1, `a private exclude hid the file from enumeration: ${JSON.stringify(r)}`);
      assert.equal(r.read, 1, JSON.stringify(r));
      assert.equal(r.offenders.length, 1, JSON.stringify(r));
    });

    // A COMMITTED `.gitignore` still counts, and must: those rules are in the
    // repository, a reviewer can read them, and excluding build output is what
    // they are for.
    test('a committed .gitignore is still honoured', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'ignored.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
      fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.mjs\n');
      // ACTUALLY COMMITTED. The first version of this test only wrote the file
      // and called it committed, so it was evidence for the case below instead —
      // a name doing the work an assertion should do.
      gitIn(dir, ['add', '.gitignore']);
      gitIn(dir, ['commit', '-q', '-m', 'ignore rules']);
      const r = scanRepository(dir);
      assert.deepEqual(r.offenders, [], `the committed ignore must still apply: ${JSON.stringify(r)}`);
      assert.equal(r.eligible, 1, 'only the .gitignore itself is eligible');
    });

    /**
     * THE BOUND OF THE IGNORE RULE, STATED BY A TEST RATHER THAN BY A SENTENCE.
     *
     * Dropping `--exclude-standard` removed the two ignore sources that are
     * invisible to anyone looking at the checkout — the global `core.excludesFile`
     * and `$GIT_DIR/info/exclude`. It did NOT establish provenance for what
     * remains: an UNTRACKED `.gitignore` in the worktree is honoured exactly like
     * a committed one, so a contributor can still hide a new offender locally.
     *
     * That is a smaller hole than the two that were closed — the file is sitting
     * in the tree where anyone in that checkout can see it, and CI clones the
     * commit, where it does not exist — but it is a hole, and it belongs in a
     * test rather than in a claim about "committed rules".
     */
    test('an UNTRACKED .gitignore is honoured too — the residual this flag does not close', () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'ignored.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
      fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.mjs\n');
      // A SENTINEL, because "no offender" is also what an empty enumeration
      // says. A review round pointed out that with nothing tracked here,
      // dropping `--others` made this test pass while NOTHING was looked at.
      fs.writeFileSync(path.join(dir, 'sentinel.mjs'), 'export const s = 1;\n');

      const r = scanRepository(dir);
      assert.equal(
        r.read, 2,
        'the sentinel must have been enumerated and read, or "no offender" only means '
        + `nothing was looked at: ${JSON.stringify(r)}`,
      );
      assert.deepEqual(
        r.offenders, [],
        'an untracked .gitignore hides an offender from the local scan; CI clones the commit, '
        + `where it does not exist: ${JSON.stringify(r)}`,
      );
    });

    // AN AMBIENT TRACE IN THE MODE THE REAL SCAN USES. The trace clearing had a
    // witness, and it ran in the ISOLATED mode only — while the one call that
    // touches a real repository runs non-isolated, where nothing was cleared but
    // the repository selectors.
    /**
     * A GLOBAL CONFIG CAN DO WHAT THE ENVIRONMENT WAS STOPPED FROM DOING.
     *
     * The trace family has config keys too, and the non-isolated mode keeps the
     * caller's global file on purpose. This is the same hole the environment
     * clearing closed, reached through the door that was deliberately left open.
     *
     * ONE CASE PER TARGET, and a review round is why: the first version
     * configured `eventTarget` alone, so the override for either of the other two
     * could have been deleted without a single test noticing. A family claim
     * needs a witness per member.
     */
    for (const target of ['eventTarget', 'normalTarget', 'perfTarget']) {
      test(`a global trace2 ${target} cannot make the non-isolated enumeration write outside its scratch space`, () => {
        const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace2-'));
        dirs.push(confDir);
        const written = path.join(confDir, `${target}.log`);
        const config = path.join(confDir, 'gitconfig');
        fs.writeFileSync(config, `[trace2]\n\t${target} = ${written.split('\\').join('/')}\n`);

        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');

        const saved = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = config;
        try {
          const r = scanRepository(dir, { isolate: false });
          assert.equal(r.read, 1, `the scan still worked: ${JSON.stringify(r)}`);
        } finally {
          if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
          else process.env.GIT_CONFIG_GLOBAL = saved;
        }
        assert.equal(
          fs.existsSync(written), false,
          `a global trace2 ${target} made the enumeration write outside its scratch space`,
        );
      });
    }

    /**
     * AND A GLOBAL CONFIG CAN RUN A PROGRAM.
     *
     * `core.fsmonitor` names one, and `--others` asks it what changed. This is
     * the `core.hooksPath` finding again through a different key — and unlike
     * that one it reaches the call that runs against a real repository.
     */
    test('a global core.fsmonitor cannot make the non-isolated enumeration run a caller program', () => {
      const progDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmonitor-'));
      dirs.push(progDir);
      const witness = path.join(progDir, 'the-monitor-ran');
      const prog = path.join(progDir, 'monitor.sh');
      // It must answer something git accepts, or the run fails for the wrong
      // reason and the witness proves nothing.
      fs.writeFileSync(
        prog,
        `#!/bin/sh\necho ran > "${witness.split('\\').join('/')}"\nprintf '/'\n`,
        { mode: 0o755 },
      );
      const config = path.join(progDir, 'gitconfig');
      configureProgram(config, 'core.fsmonitor', prog);

      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');

      const saved = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = config;
      try {
        // THE INSTRUMENT FIRST. Without the neutralising flag the program MUST
        // run, or an absent witness below says nothing about the flag.
        const unprotected = spawnSync(
          'git',
          ['ls-files', '-z', '--cached', '--others', '--exclude-per-directory=.gitignore', '--deduplicate'],
          { cwd: dir, encoding: 'utf8', env: gitEnv(false) },
        );
        assert.equal(unprotected.status, 0, `the control enumeration failed: ${unprotected.stderr}`);
        assert.equal(
          fs.existsSync(witness), true,
          'the control run must EXECUTE the program, or this fixture proves nothing about the flag',
        );
        fs.rmSync(witness);

        const r = scanRepository(dir, { isolate: false });
        assert.equal(r.read, 1, `the scan still worked: ${JSON.stringify(r)}`);
      } finally {
        if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = saved;
      }
      assert.equal(
        fs.existsSync(witness), false,
        'a global core.fsmonitor made the enumeration execute a program the caller named',
      );
    });

    test('the NON-isolated enumeration also refuses an ambient GIT_TRACE', () => {
      const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-plain-'));
      dirs.push(traceDir);
      const traceFile = path.join(traceDir, 'trace.log');
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');

      const saved = process.env.GIT_TRACE;
      process.env.GIT_TRACE = traceFile;
      try {
        const r = scanRepository(dir, { isolate: false });
        assert.equal(r.read, 1, `the scan still worked: ${JSON.stringify(r)}`);
      } finally {
        if (saved === undefined) delete process.env.GIT_TRACE;
        else process.env.GIT_TRACE = saved;
      }
      assert.equal(
        fs.existsSync(traceFile), false,
        'the non-isolated enumeration wrote a trace outside its scratch space',
      );
    });

    /**
     * THE SPELLING RULE, STATED ON THE FUNCTION RATHER THAN THROUGH GIT.
     *
     * The end-to-end version of this would pass for free on CI's ubuntu, where
     * `git_index_file` is simply a different variable from `GIT_INDEX_FILE` and
     * nothing is inherited. The hazard is Windows, where the environment is
     * case-insensitive and `delete env.GIT_INDEX_FILE` leaves the caller's
     * lowercase spelling untouched: measured, `git rev-parse --git-path index`
     * then answered with the victim's path. Asking the question of `gitEnv`
     * directly means the same thing on every platform.
     */
    test('no spelling of a hostile variable survives gitEnv, in either mode', () => {
      // A SYNTHETIC ENVIRONMENT, not `process.env`. On Windows these names are
      // ONE variable, so setting them in turn would overwrite the saved values
      // and the teardown would write a hostile one back into the caller's real
      // environment — the fixture about case handling, defeated by case
      // handling. A plain object holds them all at once and asks the question
      // identically on both platforms.
      const spellings = [
        'git_index_file', 'Git_Index_File', 'GIT_INDEX_FILE',
        'git_dir', 'GIT_TEMPLATE_DIR', 'git_template_dir',
        'git_trace', 'GIT_TRACE_REFS', 'Git_Trace_Performance',
        'git_config_count', 'GIT_CONFIG_KEY_0', 'git_config_value_0',
      ];
      const source = { PATH: process.env.PATH ?? '' };
      for (const name of spellings) source[name] = 'x';

      for (const full of [true, false]) {
        const env = gitEnv(full, source);
        const survivors = Object.keys(env).filter(
          (k) => spellings.some((n) => n.toUpperCase() === k.toUpperCase()),
        );
        assert.deepEqual(
          survivors, [],
          `gitEnv(${full}) let a hostile variable through: ${JSON.stringify(survivors)}`,
        );
      }
      // And the harmless one is still there, so the filter is not simply empty.
      assert.equal(gitEnv(true, source).PATH, source.PATH, 'gitEnv dropped an innocent variable');
    });

    /**
     * THE ACCOUNTING IDENTITY, OVER A PARTITION THAT IS ACTUALLY PARTITIONED.
     *
     * It was asserted only against this repository, where `absent`, `unreadable`,
     * `links` and `exempt` are all empty and it says no more than
     * `read === eligible`. A bucket could be dropped on the floor without the
     * sum ever noticing. Here one file lands in each.
     */
    test('the sum closes over read, absent, unreadable and exempt', (t) => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'read.mjs'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(dir, 'exempt.mjs'), `const x = 'a${String.fromCharCode(0)}b';\n`);
      // NOT SOURCE, so it belongs to no bucket AND to no count. It is here
      // because the identity could not otherwise be made to fail on its own: the
      // five bucket assertions above it catch a LOST entry first, and what the
      // sum uniquely catches is a path counted as eligible that reaches no
      // bucket at all.
      fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x1b]));

      // absent: tracked, then removed from the working tree.
      fs.writeFileSync(path.join(dir, 'gone.mjs'), 'export const g = 1;\n');
      gitIn(dir, ['add', 'gone.mjs']);
      fs.rmSync(path.join(dir, 'gone.mjs'));

      // unreadable: tracked, then replaced by a directory.
      fs.writeFileSync(path.join(dir, 'dir.mjs'), 'export const d = 1;\n');
      gitIn(dir, ['add', 'dir.mjs']);
      fs.rmSync(path.join(dir, 'dir.mjs'));
      fs.mkdirSync(path.join(dir, 'dir.mjs'));

      let linked = true;
      try {
        fs.symlinkSync(path.join(dir, 'read.mjs'), path.join(dir, 'link.mjs'));
      } catch (err) {
        linked = false;
        // NAMED, not swallowed. A review round found this branch turning a
        // five-bucket claim into a four-bucket one in silence.
        t.diagnostic(`this environment cannot create a symlink (${err.code}); the link bucket stays empty`);
      }

      const r = scanRepository(dir, { exempt: new Map([['exempt.mjs', 'the byte is the fixture']]) });
      assert.equal(r.read, 1, `exactly the clean file was read: ${JSON.stringify(r)}`);
      assert.deepEqual(r.absent, ['gone.mjs'], JSON.stringify(r));
      assert.equal(r.unreadable.length, 1, `the directory must be reported: ${JSON.stringify(r)}`);
      assert.equal(r.exempt, 1, `the exemption must be counted: ${JSON.stringify(r)}`);
      if (linked) assert.deepEqual(r.links, ['link.mjs'], JSON.stringify(r));
      assert.deepEqual(r.offenders, [], `nothing was invented: ${JSON.stringify(r)}`);
      assert.equal(
        r.read + r.absent.length + r.unreadable.length + r.links.length + r.exempt,
        r.eligible,
        `the sum must close over a populated partition: ${JSON.stringify(r)}`,
      );
      assert.equal(r.eligible, linked ? 5 : 4, `the .png is not eligible and not counted: ${JSON.stringify(r)}`);
    });
  });
});
