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
 * the async wrappers, and the setup script imports the synchronous core.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CRITICAL SECTION IS SYNCHRONOUS
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
 * The cure is the one `updateConfigBindings` already uses: no `await` inside
 * the section. JavaScript runs one stretch of synchronous code at a time, so
 * two same-process writers cannot interleave at all — the second simply runs
 * after the first, no lock needed between them. The `mkdir` lock then only
 * ever meets another PROCESS, which is what it is for, and its wait is short
 * (`DOTENV_LOCK_WAIT_MS`) because a writer holds it for milliseconds: a
 * dead process's lock still costs that wait once, then a refusal, until the
 * lock's own stale reaping clears it. The async exports are thin wrappers so
 * the three tools keep their `await`.
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
 *     junctioned parent, an 8.3 short name or a `\\?\` prefix used to yield
 *     a second lock for the same bytes.
 *
 * What is NOT here, on purpose: a second parser. `parseDotenv` in
 * workspace-dotenv.mjs is the one reader; `readDotenvVarSync` below goes
 * through it, so a caller asking "what does the file currently say for KEY"
 * gets the loader's answer and not a near copy of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertDotenvScalar } from './dotenv-scalar.mjs';
import { acquireLock, lockPathFor } from './file-lock.mjs';
import { parseDotenv } from './workspace-dotenv.mjs';

/**
 * How long a writer waits for another PROCESS's lock. A writer holds the
 * lock for a read and a write of a small file — milliseconds — so two
 * seconds is generous for a live holder and cheap for a dead one. Shorter
 * than the config writer's default because this wait, too, is synchronous.
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
 * resolved and the basename kept. A `\\?\` prefix is stripped first —
 * `realpathSync.native` would keep it and `lockPathFor` would hash it.
 */
function physicalPath(envPath) {
  const resolved = path.resolve(String(envPath).replace(/^\\\\\?\\/, ''));
  try {
    return fs.realpathSync.native(resolved);
  } catch { /* absent — resolve the directory it will be created in */ }
  try {
    return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
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
 * Take the inter-process lock for `envPath`, or throw when another process
 * holds it past the wait — the alternative is exactly the lost update the
 * lock exists to prevent. Returns the release function.
 *
 * The message says what did NOT happen and no more: a caller may already
 * have recorded its config half (lock_vault writes the binding before the
 * hint), so "nothing was changed" would be false for it.
 *
 * @param {string} envPath
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams
 * @returns {() => void}
 */
export function takeDotenvLock(envPath, { waitMs = DOTENV_LOCK_WAIT_MS, lock } = {}) {
  const release = lock ? lock() : acquireLock(dotenvLockPath(envPath), { waitMs });
  if (!release) {
    throw new Error(
      `another process is writing ${envPath} and did not finish in time: the .env line was NOT written `
      + '(whatever this call had already recorded elsewhere stands). Run the command again.',
    );
  }
  return release;
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
 * Set or update KEY=VALUE in the .env file at envPath, synchronously. Creates
 * the file if it doesn't exist. Preserves all other lines, including comments
 * and formatting.
 *
 * Duplicate-line policy: updates the FIRST occurrence and leaves later
 * duplicates as-is. This matches the convention of the loader
 * (src/helpers/workspace-dotenv.mjs, "parent wins": the first line to APPLY
 * is the one that takes effect). Updating the last occurrence instead would
 * create a writer/reader disagreement: the writer would update the bottom
 * line but the loader would still read the stale top one. CRLF line endings
 * on Windows are silently converted to LF on write — acceptable for .env
 * files which shells/Node parse equivalently with either ending.
 *
 * @param {string} envPath
 * @param {string} key
 * @param {string} value
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams for the lock
 */
export function upsertDotenvVarSync(envPath, key, value, opts = {}) {
  // One shared definition — see helpers/dotenv-scalar.mjs. The guard first
  // lived in ONE copy of this function and nowhere else, which is why the
  // setup script kept writing injectable values for a whole review round.
  // Checked BEFORE the lock: a refused value takes no lock and touches nothing.
  assertDotenvScalar(value, key, envPath);
  assertDotenvNotSymlink(envPath);
  const release = takeDotenvLock(envPath, opts);
  try {
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
  } finally {
    release();
  }
}

/**
 * Remove all `<key>=...` lines from the .env file, `export`-prefixed ones
 * included, synchronously. Returns true if at least one line was removed,
 * false if the file or the key was absent.
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
  } finally {
    release();
  }
}

/** The async face of `upsertDotenvVarSync`, for the tools that `await` it. The work itself is synchronous — see the header. */
export async function upsertDotenvVar(envPath, key, value, opts = {}) {
  return upsertDotenvVarSync(envPath, key, value, opts);
}

/** The async face of `removeDotenvVarSync`. */
export async function removeDotenvVar(envPath, key, opts = {}) {
  return removeDotenvVarSync(envPath, key, opts);
}
