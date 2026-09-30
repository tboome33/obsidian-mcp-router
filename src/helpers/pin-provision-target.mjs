/**
 * pin-provision-target — the vault directory provision_vault is about to
 * create or repair, pinned before the engine writes any of the vault's
 * content, and held until the provisioning process exits. The pin itself
 * writes first, in this order: on Windows its probe, in the nearest EXISTING
 * ancestor of the target, BEFORE the roots gate is asked (the probe is what
 * proves where that ancestor is); then the gate; then the missing levels of
 * the target, only once the gate has approved.
 *
 * Measured 2026-09-23 against the real engine (scripts/setup-vault.mjs), with
 * the same defect class the asset writers had:
 *   - the known-roots gate was LEXICAL: a junction under a known root, pointing
 *     anywhere, passed, and a whole vault — its dotenv file with the API key
 *     included — was created outside every root without `allowOutsideRoots`;
 *   - a DANGLING dotenv link in an existing target made the engine write the
 *     API key where the link pointed (`existsSync` said "absent", then
 *     `writeFileSync` followed the link); a `.obsidian` junction made it write
 *     the plugins and their data.json elsewhere;
 *   - a swap of the target's parent between provision_vault's dry-run gate and
 *     the real run redirected the whole vault.
 *
 * What this does (scope decided by Roland, 2026-09-23: targeted, not a
 * rewrite of the ~100 writes of the engine):
 *   1. `openPinnedOutputDir` pins the target — created if missing, level by
 *      level under the pin of its parent — and asks the roots gate about the
 *      PINNED real path (Windows: the probe held for the whole run blocks any
 *      rename of the vault directory and its ancestors; Linux: see below).
 *   2. Before the engine writes, the existing tree under the target is walked
 *      without following links, and ANY symlink or junction refuses the run:
 *      the engine writes by path everywhere under the vault (the dotenv file,
 *      `.obsidian/**`, `wiki/**` — the OKF projections write an index into
 *      every wiki directory), so a link anywhere below is a write elsewhere.
 *      So do a file with a second name (a hard link), a directory the walk
 *      cannot list (the pin's own probe excepted, by exact path), and — with
 *      gitInit — a pre-existing `.git`, which can send git elsewhere.
 *   3. The pinned REAL path is what the engine then writes to: a spelled path
 *      through a junction would not be pinned by the probe.
 *   4. provision_vault's dry-run reports the REAL target and roots its gate
 *      judged; the pin must land on that target and inside those roots,
 *      compared as given, never resolved again (Codex review, rounds 1 and 3:
 *      re-resolving follows a swap made after the gate). The current config's
 *      roots are asked as well; both must agree.
 *
 * What stays OPEN, stated (the engine keeps writing by path):
 *   - a link planted INSIDE the vault during the run by a program able to
 *     write there is followed by the engine's next write under that name;
 *   - on Linux the pin holds a descriptor, which does not stop a rename of
 *     the path: the engine's path writes stay racy there (the pin still
 *     proves the real path at pin time, so a PRE-EXISTING link is refused);
 *   - on macOS/BSD nothing is pinned (Node offers no primitive for it);
 *   - the known roots are named BY PATH in the config: whoever replaces a root
 *     directory itself with a link before the dry-run RESOLVES it moves the
 *     root, and the dry-run then judges against the moved one (its target and
 *     roots are resolved one after the other, not atomically — Codex review,
 *     round 4). From each resolution on, the values are frozen (point 4) — a
 *     round-2 version of this header called that snapshot useless, and round 3
 *     broke the argument: an attacker blocked until the dry-run ends can still
 *     act after it. plan_vault's seal covers the same real values, so a
 *     destination moved between an approved preview and the provisioning is
 *     refused as a drift (round 4);
 *   - a missing target level created meanwhile by someone else with another
 *     letter case refuses the run (the approved path is compared exactly):
 *     plan again.
 *
 * An ACCEPTED pin is never released here: the process exits after
 * provisioning, and the operating system closes the probe (delete-on-close)
 * or the descriptor. A pin whose target is then REFUSED is closed at once.
 */
import fs from 'node:fs';
import path from 'node:path';

import { openPinnedOutputDir } from './pinned-output-dir.mjs';
import { realPathWithMissingTail, isInsideRealPath } from './real-path.mjs';

/** Entries walked at most before refusing to vouch for a target tree. */
export const MAX_TARGET_ENTRIES = 200000;

/** The pins of this process: held until it exits, never released here. */
const HELD = [];

/**
 * TESTS ONLY: a test process lives on after its "provisioning", and on
 * Windows a held probe keeps its directory from being removed. The engine
 * never calls this.
 */
export function releaseHeldPinsForTests() {
  while (HELD.length) HELD.pop().close();
}

/** `real` (already real) is `root` or below it — compared exactly, case included (see isInsideRealPath). */
function isInsideReal(real, root) {
  return isInsideRealPath(real, root);
}

/** Against a root from the CURRENT config, resolved now. */
function within(real, root) {
  return isInsideReal(real, realPathWithMissingTail(root));
}

/**
 * Windows: the link count of a regular file, asked of an OPEN handle. `lstat`
 * by path can fall back, in libuv, to directory-entry metadata that carries no
 * link count and reports 1 (Codex review, from libuv's source; not reproduced
 * here — Windows 11 with libuv 1.51 answered 2 even with the file's
 * attribute-read right denied). A file that cannot be opened cannot be vouched
 * for, and refuses the run.
 */
function linkCountByHandle(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch (err) {
    throw new Error(`provision target refused: ${p} could not be opened (${err?.code ?? err?.message}), so its names cannot be counted`);
  }
  try {
    return fs.fstatSync(fd).nlink;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Walk `dir` without following links; throw on the first link found, on a
 * regular file with more than one name (a hard link: an in-place overwrite
 * would change the other name too, possibly outside the vault), on any
 * directory that cannot be listed, or when the tree is larger than
 * `maxEntries`. The ONE exemption is `exemptPath`, the pin's own probe (held
 * exclusively, so unlistable) — by exact path: a first version exempted any
 * unlistable `.router-pin-*` directory, which another program holding its own
 * such directory exclusively could use to hide a subtree (Codex review).
 */
export function assertNoLinksBelow(dir, { maxEntries = MAX_TARGET_ENTRIES, exemptPath = null } = {}) {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const current = stack.pop();
    if (exemptPath !== null && current === exemptPath) continue;
    let names;
    try {
      names = fs.readdirSync(current);
    } catch (err) {
      throw new Error(`provision target refused: ${current} could not be listed (${err?.code ?? err?.message}), so it cannot be checked for links`);
    }
    for (const name of names) {
      seen += 1;
      if (seen > maxEntries) {
        throw new Error(`provision target refused: more than ${maxEntries} entries under ${dir} — too many to check for links`);
      }
      const p = path.join(current, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        throw new Error(`provision target refused: ${p} is a link. The engine writes by path under the vault, so a link there would send a write elsewhere. Remove it, or provision elsewhere.`);
      }
      if (st.isFile()) {
        const nlink = process.platform === 'win32' ? linkCountByHandle(p) : st.nlink;
        if (nlink > 1) {
          throw new Error(`provision target refused: ${p} has ${nlink} names (a hard link). An in-place write there would change its other names too. Remove it, or provision elsewhere.`);
        }
      }
      if (st.isDirectory()) stack.push(p);
    }
  }
}

/**
 * Pin the provision target and return the REAL path the engine must write to.
 * Throws (the caller turns it into the engine's `fail`) when the pinned path
 * is outside the known roots (unless `allowOutsideRoots`), when there are no
 * known roots at all (fail-closed, same rule as provision_vault's own gate),
 * or when the existing tree holds a link.
 *
 * @param {string} target
 * @param {{ roots: string[], frozenRoots?: string[]|null, allowOutsideRoots?: boolean,
 *   expectedTarget?: string|null, gitInit?: boolean, pinOptions?: object }} opts
 *   `expectedTarget` — the REAL path of the target, as the dry-run itself
 *   resolved it for its gate (reported in its plan, never resolved again by
 *   the handler); the pinned path must be it (a name-only request recomposes
 *   its path from a config that may have changed since — Codex review).
 *   Compared as given, never re-resolved here: re-resolving it would follow
 *   the very swap it exists to catch (measured: a first version did, and the
 *   swapped target matched itself). `frozenRoots` — the real roots the same
 *   gate judged against, compared as given too. `gitInit` — a `.git` already in the target is refused: a `.git`
 *   FILE can point git at a repository outside the vault (Codex review).
 *   `pinOptions` — tests only (strategy / native helper), never from a caller.
 * @returns {string}
 */
export function pinProvisionTarget(target, {
  roots, frozenRoots = null, allowOutsideRoots = false, expectedTarget = null, gitInit = false, pinOptions = {},
} = {}) {
  if (typeof target !== 'string' || target.trim() === '') throw new Error('provision target must be a non-empty path');
  const knownRoots = Array.isArray(roots) ? roots : [];
  const approved = typeof expectedTarget === 'string' && expectedTarget !== '' ? path.resolve(expectedTarget) : null;
  const frozen = Array.isArray(frozenRoots) ? frozenRoots.map((r) => path.resolve(r)) : null;
  const pinned = openPinnedOutputDir(target, {
    ...pinOptions,
    authorize: (real) => {
      if (approved !== null && real !== approved) {
        throw new Error(`Refused: the target is now ${real}, not ${approved} — the one the plan approved. Plan again.`);
      }
      if (allowOutsideRoots) return;
      // The roots the dry-run's gate judged against, compared as given: a
      // root swapped for a link since then would re-resolve to where it
      // points now (Codex review, round 3).
      if (frozen !== null && !frozen.some((root) => isInsideReal(real, root))) {
        throw new Error(
          `Refused: ${real} is outside the vault roots the plan was judged against [${frozen.join(', ') || '(none)'}]. `
          + 'A root may have moved since the plan. Plan again, or pass allowOutsideRoots:true to override.',
        );
      }
      // AND the current config's roots, resolved now.
      if (!knownRoots.some((root) => within(real, root))) {
        throw new Error(
          `Refused: ${real} is outside all known vault roots [${knownRoots.join(', ') || '(none configured)'}] `
          + '(judged on the pinned real path). Pass allowOutsideRoots:true to override.',
        );
      }
    },
  });
  try {
    assertNoLinksBelow(pinned.path, { exemptPath: pinned.probePath });
    if (gitInit) {
      let dotGit = null;
      try { dotGit = fs.lstatSync(path.join(pinned.path, '.git')); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
      if (dotGit) {
        throw new Error(`provision target refused: ${path.join(pinned.path, '.git')} already exists, and gitInit would run git against it — a .git FILE can send git to a repository outside the vault.`);
      }
    }
  } catch (err) {
    // Refused: nothing will be written, so the probe goes now rather than at exit.
    pinned.close();
    throw err;
  }
  // Not released: see the module header. Kept reachable for the process's life.
  HELD.push(pinned);
  return pinned.path;
}
