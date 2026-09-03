/**
 * file-lock.mjs — mutual exclusion between PROCESSES, via `mkdir`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MOVED HERE
 * ---------------------------------------------------------------------------
 * This lock was written for the dependency bootstrapper, where two Claude Code
 * sessions starting at once must not run `npm install` over each other. The
 * Codex review of 2026-09-03 found the same need one floor down, in the config
 * writer, and the honest answer to "we need that lock too" is to move the one
 * that exists rather than write a second one that will drift from it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR, AND WHAT ATOMIC WRITES DO NOT DO
 * ---------------------------------------------------------------------------
 * `writeFileAtomicSync` guarantees that a READER never sees half a file. It
 * guarantees nothing at all about two WRITERS:
 *
 *     A reads the config          {}
 *     B reads the config          {}
 *     B computes and writes       { bindings: { b } }
 *     A computes and writes       { bindings: { a } }     ← B is gone
 *
 * Both writes were atomic. The update was still lost, and the file this
 * happens to holds the vault registry and every vault's API key, so "lost
 * update" can mean a key somebody added thirty seconds ago. Only something
 * that makes the whole read-modify-write exclusive closes that, and that is
 * this.
 *
 * ---------------------------------------------------------------------------
 * WHY `mkdir`, AND WHY AN OWNER TOKEN INSIDE IT
 * ---------------------------------------------------------------------------
 * `mkdir` either creates the directory or fails with EEXIST, atomically, on
 * every platform this project targets — no advisory-locking differences, no
 * dependency. It MUST be a bare `mkdirSync`: the recursive form is idempotent
 * and succeeds on an existing directory, which removes the mutual exclusion
 * while looking tidier. (That exact mistake was made while moving this code,
 * and the bootstrapper's own test caught it on the first run.)
 *
 * A lock left behind by a process that died holding it has to be reaped, or
 * every future write hangs forever. Reaping by AGE alone, though, cannot tell
 * a dead holder from a slow live one — round 2 of the Codex review, 2026-09-03:
 * A is suspended past the stale threshold, B reaps A's lock and takes its own,
 * A resumes and its release deletes B's lock, C walks in beside B. Three
 * writers overlap and the lock has done nothing. So the directory holds an
 * OWNER TOKEN, and a release removes the lock only when the token is still its
 * own. A reaped holder's release becomes a no-op instead of a hole.
 *
 * Node builtins only: this sits on the start-up path of the binary.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizePathForCompare } from './vault-path-identity.mjs';

/** How long to wait for a holder before giving up. */
export const LOCK_WAIT_MS = 10_000;
/** How often to retry while waiting. */
export const LOCK_POLL_MS = 50;
/** After this, a lock is assumed to belong to a process that died holding it. */
export const LOCK_STALE_MS = 60_000;

const OWNER_FILE = 'owner';

/**
 * Exclusive lock via `mkdir`. Returns a release function, or null when the
 * lock could not be taken within `waitMs` because SOMEBODY ELSE HOLDS IT.
 *
 * Throws — rather than returning null — when the lock cannot be taken for any
 * OTHER reason (an unwritable temp directory, a missing parent). Those are not
 * contention, and a caller that reported them as "another process is writing"
 * would send the user to look for a process that does not exist. Found by
 * round 2 of the Codex review, 2026-09-03.
 *
 * Returning null on contention rather than throwing is deliberate: every
 * caller has a sensible thing to do when it cannot take the lock, and that
 * thing differs. The bootstrapper re-probes (the holder has very likely just
 * installed on its behalf); the config writer refuses the write and says so.
 *
 * @param {string} lockPath
 * @param {{ waitMs?: number, pollMs?: number, staleMs?: number, now?: () => number, sleep?: (ms: number) => void }} [opts]
 * @returns {(() => void)|null}
 */
export function acquireLock(lockPath, {
  waitMs = LOCK_WAIT_MS,
  pollMs = LOCK_POLL_MS,
  staleMs = LOCK_STALE_MS,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  const deadline = now() + waitMs;
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  const ownerPath = path.join(lockPath, OWNER_FILE);
  for (;;) {
    try {
      // BARE `mkdirSync`, NEVER `{ recursive: true }` — see the header.
      fs.mkdirSync(lockPath);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Held by somebody. Reap it only if it looks abandoned; the release
      // below is what makes reaping a live holder harmless.
      try {
        const age = now() - fs.statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { /* raced with the holder releasing it — just retry */ }
      if (now() >= deadline) return null;
      sleep(pollMs);
      continue;
    }
    // Ours. Stamp it, so a release can tell whether it is still ours.
    try {
      fs.writeFileSync(ownerPath, token, 'utf8');
    } catch (err) {
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
      throw err;
    }
    return () => {
      // RELEASE ONLY WHAT IS STILL OURS. If a reaper took the lock over while
      // this process was suspended, the directory now belongs to them and
      // deleting it would let a third writer in.
      let current = null;
      try { current = fs.readFileSync(ownerPath, 'utf8'); } catch { /* gone, or reaped */ }
      if (current !== token) return;
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
    };
  }
}

/**
 * A lock path for an arbitrary file, in the OS temp directory.
 *
 * NOT beside the file it guards, on purpose: the guarded file may live in a
 * directory the process cannot write to, and a lock that cannot be taken for
 * that reason would turn "this write will fail" into "this write hangs and
 * then fails".
 *
 * Keyed by a hash of the CANONICAL path — `normalizePathForCompare`, the one
 * normalisation this tree uses to decide whether two paths are the same file
 * — so two spellings of one config (`D:\Router\config.json` and
 * `d:\router\config.json`) take the SAME lock. The first version hashed the
 * raw `path.resolve` output, and on Windows two processes with differently
 * cased spellings held two locks and overwrote each other. Round 2 of the
 * Codex review, 2026-09-03.
 *
 * A real limit, stated rather than hidden: two processes whose `os.tmpdir()`
 * differ (two users, or a launcher that rewrites TEMP) still get two lock
 * directories. The lock protects one machine's processes sharing one temp
 * directory, which is what every Claude Code session on a machine does.
 *
 * @param {string} targetPath
 * @param {string} [tag] distinguishes lock families sharing a target
 * @returns {string}
 */
export function lockPathFor(targetPath, tag = 'file') {
  const canonical = normalizePathForCompare(path.resolve(targetPath));
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `obsidian-mcp-router-${tag}-${hash}.lock`);
}

function defaultSleep(ms) {
  // Synchronous sleep: the callers are synchronous read-modify-write paths,
  // some of them running before the server exists, so there is no event loop
  // work to yield to — and `Atomics.wait` needs no dependency.
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}
