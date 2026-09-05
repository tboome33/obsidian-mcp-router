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
 * writing injectable values. So the writer lives here once, and the tools
 * import it.
 *
 * THREE RULES THE COPIES DID NOT HAVE, found by the Codex round on b59eb00 —
 * all three pre-existing in both copies, and all three fixed here once (and
 * in the setup script's synchronous twin, which shares the line regex and
 * the lock path through the two exports below):
 *
 *   - `export KEY=value` IS the key. `parseDotenv` strips an optional
 *     `export ` prefix, so a file written that way is read like any other —
 *     but the writers matched `^\s*KEY\s*=` only, saw no line, and APPENDED a
 *     bare one. The loader then read the first occurrence: the stale exported
 *     value won, and the line just written was dead. The prefix is recognised
 *     and preserved.
 *   - A `.env` THAT IS A SYMBOLIC LINK IS REFUSED. The loader reads through a
 *     link happily; a writer that follows it edits whatever the link points
 *     at, outside the workspace — and a workspace is often a cloned
 *     repository, whose author chose where the link points. An `lstat` on the
 *     final component, the same check `agent-host-install` makes, with the
 *     same honest limit: a link on a PARENT directory is not detected.
 *   - ONE WRITER AT A TIME. Two tools persisting into the same file
 *     read-modify-write it with nothing between them; whichever wrote last
 *     erased the other's line while both reported success. The same `mkdir`
 *     lock the config writer takes, keyed on the file's canonical path.
 *
 * What is NOT here, on purpose: the reader. `parseDotenv` in
 * workspace-dotenv.mjs is the one parser; this module only edits lines, and
 * it matches keys the way that parser does (first `KEY=` at start of line,
 * an optional `export ` prefix, surrounding whitespace ignored) so that what
 * the writer touches is what the loader reads.
 *
 * Node builtins plus two dependency-free helpers: `assertDotenvScalar` is the
 * whole reason a shared writer is worth having, and the lock is the config
 * writer's own.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { assertDotenvScalar } from './dotenv-scalar.mjs';
import { acquireLock, lockPathFor } from './file-lock.mjs';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The line shape the loader reads as an assignment of `key`: optional
 * leading whitespace, an optional `export ` prefix, the key, `=`. Group 1 is
 * the prefix, kept when the line is rewritten so `export FOO=old` becomes
 * `export FOO=new` and stays sourceable by a shell.
 */
export function dotenvKeyLineRegex(key) {
  return new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegex(key)}\\s*=`);
}

/**
 * The lock every dotenv mutation takes — one family, keyed on the canonical
 * file path. The tag is spelled `env-file` rather than the obvious word
 * because the loader guard in tests/workspace-dotenv.test.mjs reads that word
 * in quotes, anywhere in src/, as an import of the npm package it forbids.
 */
export function dotenvLockPath(envPath) {
  return lockPathFor(envPath, 'env-file');
}

/**
 * Refuse to write THROUGH a link. `lstat` looks at the final component only,
 * so this is the file itself, not its parents — the limit is stated in the
 * header. A missing file is fine (the upsert creates it). Synchronous, so
 * the setup script's synchronous writers can share it.
 *
 * @param {string} envPath
 */
export function assertDotenvNotSymlink(envPath) {
  const st = fsSync.lstatSync(envPath, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    throw new Error(
      `refusing to write ${envPath}: it is a symbolic link, and a workspace file that points elsewhere `
      + 'would have the router edit a file outside the workspace. Replace the link with a real file, '
      + 'or edit its target yourself.',
    );
  }
}

/**
 * Take the dotenv lock for `envPath`, or throw when another process holds it
 * — the alternative is exactly the lost update the lock exists to prevent.
 * Returns the release function.
 *
 * @param {string} envPath
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams
 * @returns {() => void}
 */
export function takeDotenvLock(envPath, { waitMs, lock } = {}) {
  const release = lock
    ? lock()
    : acquireLock(dotenvLockPath(envPath), waitMs === undefined ? {} : { waitMs });
  if (!release) {
    throw new Error(
      `another process is writing ${envPath} and did not finish in time. Nothing was changed — run the command again.`,
    );
  }
  return release;
}

/**
 * Set or update KEY=VALUE in the .env file at envPath. Creates the file
 * if it doesn't exist. Preserves all other lines, including comments and
 * formatting.
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
export async function upsertDotenvVar(envPath, key, value, opts = {}) {
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
      const raw = await fs.readFile(envPath, 'utf8');
      lines = raw.split(/\r?\n/);
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
    await fs.writeFile(envPath, out, 'utf8');
  } finally {
    release();
  }
}

/**
 * Remove all `<key>=...` lines from the .env file, `export`-prefixed ones
 * included. Returns true if at least one line was removed, false if the file
 * or the key was absent.
 *
 * @param {string} envPath
 * @param {string} key
 * @param {{ waitMs?: number, lock?: () => (() => void)|null }} [opts] test seams for the lock
 * @returns {Promise<boolean>}
 */
export async function removeDotenvVar(envPath, key, opts = {}) {
  assertDotenvNotSymlink(envPath);
  const release = takeDotenvLock(envPath, opts);
  try {
    let raw;
    try {
      raw = await fs.readFile(envPath, 'utf8');
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
    await fs.writeFile(envPath, out, 'utf8');
    return true;
  } finally {
    release();
  }
}
