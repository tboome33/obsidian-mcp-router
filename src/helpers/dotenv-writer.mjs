/**
 * dotenv-writer.mjs — set or remove ONE `KEY=value` line in a workspace `.env`.
 *
 * `lock_vault --persist` and `set_auto_enrich_mode --persist` each carried a
 * private copy of these two functions, "forked from lock.mjs to avoid
 * cross-tool imports". Two copies were tolerable; the third caller —
 * `confirm_workspace_binding({ refuse })`, which writes the portable half of a
 * refused proposal (decision `refus-d-une-proposition-de-liaison`) — would have
 * made three, and this repository's recorded failure mode is a fix that lands
 * in one copy and not the others: the newline guard below was added to the
 * first copy alone for a whole review round while the setup script kept
 * writing injectable values. So the writer lives here once, the tools import
 * the async faces, and the setup script imports the synchronous ones.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CRITICAL SECTION IS SYNCHRONOUS, AND THE WAIT BEFORE IT IS NOT
 * ---------------------------------------------------------------------------
 * The first shared version (7efbad1) took the inter-process `mkdir` lock and
 * then `await`ed the read and the write. A second writer in the SAME process
 * — two tool calls the client pipelines, `lock_vault --persist` beside
 * `set_auto_enrich_mode --persist` — arrived during that await, found the lock
 * held, and spun in the lock's synchronous `Atomics.wait` for the full 10 s
 * budget: the server's event loop was frozen, every other request waited, and
 * the second write then failed with "another process is writing" while the
 * only writer was this very process. Measured by the Fable review round on
 * 7efbad1: two pipelined writers answered together at 10.07 s, a timer fired
 * once in ten seconds, one line lost.
 *
 * Two rules follow, and they are separate:
 *
 *   - NO `await` INSIDE THE SECTION. JavaScript runs one stretch of
 *     synchronous code at a time, so two same-process writers cannot
 *     interleave at all — the second simply runs after the first. The
 *     read-modify-write lives in `*Unlocked` functions that are synchronous
 *     by construction, and both faces call them.
 *   - THE ASYNC FACE WAITS FOR THE LOCK WITHOUT BLOCKING. Two different
 *     PROCESSES writing one file — two sessions in one workspace — still
 *     meet at the `mkdir` lock; the synchronous acquirer would freeze the
 *     server's loop for the wait (bounded, but a stall — the round on
 *     1fad78c measured 2 s with a dead process's lock in the way). The
 *     async face polls with a timer instead (`acquireLockAsync`), so a
 *     server waiting on another process keeps answering everything else.
 *     The setup script is synchronous end to end and keeps the synchronous
 *     acquirer: a CLI blocking its own thread for two seconds is nothing.
 *   - AND THE ASYNC FACE KEEPS CALL ORDER, per file, through a queue.
 *     Suspending before the write bought the loop back and cost the
 *     ordering the fully synchronous version had for free: a writer that
 *     went into the timer wait could be overtaken by one that arrived later
 *     and found the lock free. Measured on faf5b4b by the Codex round:
 *     `set_auto_enrich_mode` persisting `Hybrid` and then `off` left the
 *     session on `off` and the FILE on `Hybrid`, both calls reporting
 *     success, so the next start-up re-enabled enrichment the user had just
 *     switched off. Atomicity was never lost — the section stays
 *     synchronous — only order, which for a file that is read at start-up
 *     is the whole point. `queueDotenvWrite` chains each call of a process
 *     behind the previous one FOR THAT PHYSICAL PATH, so the last caller
 *     writes last. Different files do not wait for each other, and a failed
 *     write does not poison the queue behind it.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THE FORKS DID NOT HAVE
 * ---------------------------------------------------------------------------
 *   - `export KEY=value` IS the key — spelled exactly as `parseDotenv` reads
 *     it: `export`, ONE space, then any whitespace. The loader is the
 *     reference (`startsWith('export ')`, then `trim()`); the first shared
 *     version matched `export\s+`, so `export<TAB>KEY=old` was rewritten in
 *     place while the loader read that line as a key literally named
 *     `export\tKEY` — a persisted setting that never took effect. A table
 *     test feeds the same lines to the loader and to this regex.
 *   - A `.env` THAT IS A SYMBOLIC LINK IS REFUSED. The loader reads through a
 *     link happily; a writer that follows it edits whatever the link points
 *     at, outside the workspace — and a workspace is often a cloned
 *     repository, whose author chose where the link points. `lstat` on the
 *     final component, the same check `agent-host-install` makes, with the
 *     same honest limits: a link on a PARENT directory is not detected, and
 *     a link created between the check and the write is not either.
 *   - ONE WRITER AT A TIME across processes, keyed on the PHYSICAL path: a
 *     junctioned parent, an 8.3 short name, a `\\?\` prefix or the extended
 *     UNC spelling `\\?\UNC\server\share` used to yield a second lock for
 *     the same bytes.
 *
 * What is NOT here, on purpose: a second parser. `parseDotenv` in
 * workspace-dotenv.mjs is the one reader; `readDotenvVarSync` below goes
 * through it, so a caller asking "what does the file currently say for KEY"
 * gets the loader's answer and not a near copy of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertDotenvScalar } from './dotenv-scalar.mjs';
import { acquireLock, acquireLockAsync, lockPathFor } from './file-lock.mjs';
import { parseDotenv } from './workspace-dotenv.mjs';
import { realPathWithMissingTail } from './real-path.mjs';

/**
 * How long a writer waits for another PROCESS's lock. A writer holds the
 * lock for a read and a write of a small file — milliseconds — so two
 * seconds is generous for a live holder and cheap for a dead one.
 */
export const DOTENV_LOCK_WAIT_MS = 2000;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The line shape the loader reads as an assignment of `key`: optional
 * leading whitespace, an optional `export ` prefix (one space, then any
 * whitespace — `parseDotenv`'s exact rule), the key, `=`. Group 1 is the
 * prefix, kept when the line is rewritten so `export FOO=old` becomes
 * `export FOO=new` and stays sourceable by a shell.
 */
export function dotenvKeyLineRegex(key) {
  return new RegExp(`^(\\s*(?:export \\s*)?)${escapeRegex(key)}\\s*=`);
}

/**
 * The file's PHYSICAL path, so two spellings of one file share a lock. The
 * file itself may not exist yet (the upsert creates it): then its parent is
 * resolved and the basename kept. The extended-length prefix is folded first
 * through the shared helper — `\\?\UNC\server\share` becomes
 * `\\server\share`, `\\?\C:\x` becomes `C:\x`. The first version stripped the
 * four characters blindly, turned `\\?\UNC\server\…` into the RELATIVE path
 * `UNC\server\…`, and two processes writing one share took two locks
 * (Codex, both engines, round on 1fad78c).
 */
function physicalPath(envPath) {
  // ONE LEVEL WAS NOT THE RULE, it was this function's depth. It resolved the
  // file, else its parent — enough for a `.env` in a directory that exists,
  // and nothing more. The asset-containment guard had the same idea with no
  // levels at all and paid for it (a junction plus a not-yet-created child
  // escaped every vault gate; Codex, whole-lot review 2026-09-06). Both ask
  // the shared resolver now: nearest existing ancestor, junction folded there,
  // missing tail re-appended.
  return realPathWithMissingTail(envPath);
}

/**
 * The lock every dotenv mutation takes — one family, keyed on the physical
 * file path. The tag is spelled `env-file` rather than the obvious word
 * because the loader guard in tests/workspace-dotenv.test.mjs reads that word
 * in quotes, anywhere in src/, as an import of the npm package it forbids.
 */
export function dotenvLockPath(envPath) {
  return lockPathFor(physicalPath(envPath), 'env-file');
}

/**
 * Refuse to write THROUGH a link. `lstat` looks at the final component only,
 * so this is the file itself, not its parents — the limit is stated in the
 * header. A missing file is fine (the upsert creates it).
 *
 * @param {string} envPath
 */
export function assertDotenvNotSymlink(envPath) {
  const st = fs.lstatSync(envPath, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    throw new Error(
      `refusing to write ${envPath}: it is a symbolic link, and a workspace file that points elsewhere `
      + 'would have the router edit a file outside the workspace. Replace the link with a real file, '
      + 'or edit its target yourself.',
    );
  }
}

/**
 * The message when another process holds the lock past the wait. It says
 * what did NOT happen and no more: a caller may already have recorded its
 * config half (lock_vault writes the binding before the hint), so "nothing
 * was changed" would be false for it.
 */
function contentionError(envPath) {
  return new Error(
    `another process is writing ${envPath} and did not finish in time: the .env line was NOT written `
    + '(whatever this call had already recorded elsewhere stands). Run the command again.',
  );
}

/**
 * Take the inter-process lock for `envPath` SYNCHRONOUSLY, or throw when
 * another process holds it past the wait. For the setup script; the tools
 * use the async twin below. Returns the release function.
 *
 * @param {string} envPath
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams
 * @returns {() => void}
 */
export function takeDotenvLock(envPath, { waitMs = DOTENV_LOCK_WAIT_MS, lock } = {}) {
  const release = lock ? lock() : acquireLock(dotenvLockPath(envPath), { waitMs });
  if (!release) throw contentionError(envPath);
  return release;
}

/**
 * Take the inter-process lock for `envPath` WITHOUT blocking the event loop:
 * the wait is a timer, not `Atomics.wait`. Same contract otherwise.
 *
 * @param {string} envPath
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams
 * @returns {Promise<() => void>}
 */
export async function takeDotenvLockAsync(envPath, { waitMs = DOTENV_LOCK_WAIT_MS, lock } = {}) {
  const release = lock ? lock() : await acquireLockAsync(dotenvLockPath(envPath), { waitMs });
  if (!release) throw contentionError(envPath);
  return release;
}

/**
 * The tail of each physical path's queue — the promise that settles when the
 * write currently last in line is done. Never rejects (see below), so a
 * failed write cannot cancel the ones behind it. An entry is dropped as soon
 * as its own tail settles and nothing newer took its place, so the map holds
 * one key per file being written RIGHT NOW, not one per file ever written.
 */
const dotenvWriteQueues = new Map();

/**
 * Run `task` after every async write this process has already started for the
 * same physical file, and before every one it starts later. The key is
 * computed synchronously, at call time, which is what makes the queue's order
 * the CALLER's order rather than the order the lock happens to be won in.
 *
 * The synchronous faces do not queue: they cannot await, they hold the
 * inter-process lock for the whole of their own read-modify-write, and their
 * caller is a CLI that does one thing at a time. So a process that mixes the
 * two faces on one file has atomicity (the `mkdir` lock and the synchronous
 * sections give it that) but no ordering guarantee between the faces — which
 * is why the tools use only the async ones.
 *
 * @template T
 * @param {string} envPath
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function queueDotenvWrite(envPath, task) {
  const key = physicalPath(envPath);
  const previous = dotenvWriteQueues.get(key) || Promise.resolve();
  // `previous` never rejects, so `then(task)` always runs `task`.
  const mine = previous.then(task);
  // What goes back into the map is the SWALLOWED form: the next writer waits
  // for this one to finish, whether it succeeded or threw, and never inherits
  // its rejection. The caller gets `mine`, with the real result or the real
  // error.
  const settled = mine.then(() => {}, () => {});
  dotenvWriteQueues.set(key, settled);
  settled.then(() => {
    if (dotenvWriteQueues.get(key) === settled) dotenvWriteQueues.delete(key);
  });
  return mine;
}

/**
 * What the file currently says for `key` — the FIRST assignment, read by the
 * loader's own parser, `export` prefix and quotes handled the way the loader
 * handles them. `null` when the file or the key is absent.
 *
 * @param {string} envPath
 * @param {string} key
 * @returns {string|null}
 */
export function readDotenvVarSync(envPath, key) {
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const first = parseDotenv(text).find((entry) => entry.key === key);
  return first ? first.value : null;
}

/**
 * The read-modify-write itself — SYNCHRONOUS, and called only with the lock
 * held. Creates the file if it doesn't exist. Preserves all other lines,
 * including comments and formatting.
 *
 * Duplicate-line policy: updates the FIRST occurrence and leaves later
 * duplicates as-is. This matches the convention of the loader
 * (src/helpers/workspace-dotenv.mjs, "parent wins": the first line to APPLY
 * is the one that takes effect). Updating the last occurrence instead would
 * create a writer/reader disagreement: the writer would update the bottom
 * line but the loader would still read the stale top one. CRLF line endings
 * on Windows are silently converted to LF on write — acceptable for .env
 * files which shells/Node parse equivalently with either ending.
 */
function upsertDotenvVarUnlocked(envPath, key, value) {
  // One shared definition — see helpers/dotenv-scalar.mjs. The guard first
  // lived in ONE copy of this function and nowhere else, which is why the
  // setup script kept writing injectable values for a whole review round.
  // (The faces check it before taking the lock too; the security guard
  // requires the call HERE, in the function that writes.)
  assertDotenvScalar(value, key, envPath);
  let lines = [];
  try {
    lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // File doesn't exist — start with an empty array
  }

  // Find the FIRST occurrence of `<key>=` (start-of-line, ignoring
  // surrounding whitespace and an `export ` prefix) and update it in place,
  // prefix included. If absent, append.
  const keyRegex = dotenvKeyLineRegex(key);
  let firstIdx = -1;
  let prefix = '';
  for (let i = 0; i < lines.length; i++) {
    const m = keyRegex.exec(lines[i]);
    if (m) {
      firstIdx = i;
      prefix = m[1];
      break;
    }
  }
  if (firstIdx === -1) {
    const newLine = `${key}=${value}`;
    // Append, preserving trailing newline behavior
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push(newLine);
    } else if (lines.length > 0) {
      // Last line is empty (file ended with \n) — insert before it
      lines.splice(lines.length - 1, 0, newLine);
    } else {
      lines.push(newLine);
    }
  } else {
    lines[firstIdx] = `${prefix}${key}=${value}`;
  }

  // Always end with a newline
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  fs.writeFileSync(envPath, out, 'utf8');
}

/** The removal itself — synchronous, lock held. True when at least one line went. */
function removeDotenvVarUnlocked(envPath, key) {
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const lines = raw.split(/\r?\n/);
  const keyRegex = dotenvKeyLineRegex(key);
  const filtered = lines.filter((l) => !keyRegex.test(l));
  if (filtered.length === lines.length) return false;
  let out = filtered.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  fs.writeFileSync(envPath, out, 'utf8');
  return true;
}

/**
 * Set or update KEY=VALUE in the .env file at envPath, synchronously (the
 * setup script's face). A refused value or a symlinked file takes no lock.
 *
 * @param {string} envPath
 * @param {string} key
 * @param {string} value
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams for the lock
 */
export function upsertDotenvVarSync(envPath, key, value, opts = {}) {
  assertDotenvScalar(value, key, envPath);
  assertDotenvNotSymlink(envPath);
  const release = takeDotenvLock(envPath, opts);
  try {
    upsertDotenvVarUnlocked(envPath, key, value);
  } finally {
    release();
  }
}

/**
 * Remove all `<key>=...` lines, synchronously. True if at least one line was
 * removed, false if the file or the key was absent.
 *
 * @param {string} envPath
 * @param {string} key
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams for the lock
 * @returns {boolean}
 */
export function removeDotenvVarSync(envPath, key, opts = {}) {
  assertDotenvNotSymlink(envPath);
  const release = takeDotenvLock(envPath, opts);
  try {
    return removeDotenvVarUnlocked(envPath, key);
  } finally {
    release();
  }
}

/**
 * The tools' face of the upsert: the call takes its place in this file's
 * queue immediately, the lock is then awaited with a timer (the loop keeps
 * running), and the section itself is synchronous. A refused value or a
 * symlinked file throws before the call is queued at all.
 *
 * @param {string} envPath
 * @param {string} key
 * @param {string} value
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams for the lock
 */
export async function upsertDotenvVar(envPath, key, value, opts = {}) {
  // The VALUE is refused up front: it cannot change while we wait, and a
  // caller passing a broken one should hear so without taking a queue slot.
  assertDotenvScalar(value, key, envPath);
  return queueDotenvWrite(envPath, async () => {
    const release = await takeDotenvLockAsync(envPath, opts);
    try {
      // THE SYMLINK CHECK BELONGS INSIDE THE LOCK, immediately before the
      // synchronous read-modify-write. It used to run before the queue and the
      // lock wait — which is a window the async faces made real: replace the
      // file with a link to somewhere outside the workspace while a writer
      // waits, and the core then reads and writes THROUGH it, having checked a
      // file that no longer exists. The check was correct when everything was
      // synchronous (7efbad1) and was quietly invalidated by making the wait
      // asynchronous. (Codex, whole-lot review of the six phases, 2026-09-06.)
      // The residual window is now one synchronous stretch — nothing can run
      // between this line and the write — which is as closed as a check-then-
      // write gets without an O_NOFOLLOW open.
      assertDotenvNotSymlink(envPath);
      upsertDotenvVarUnlocked(envPath, key, value);
    } finally {
      release();
    }
  });
}

/**
 * The tools' face of the removal.
 *
 * @param {string} envPath
 * @param {string} key
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams for the lock
 * @returns {Promise<boolean>}
 */
export async function removeDotenvVar(envPath, key, opts = {}) {
  return queueDotenvWrite(envPath, async () => {
    const release = await takeDotenvLockAsync(envPath, opts);
    try {
      // Inside the lock, for the reason spelled out in `upsertDotenvVar`.
      assertDotenvNotSymlink(envPath);
      return removeDotenvVarUnlocked(envPath, key);
    } finally {
      release();
    }
  });
}
