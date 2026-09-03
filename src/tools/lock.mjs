/**
 * lock_vault / unlock_vaults — runtime isolation toggle.
 *
 * "Lock mode" restricts the router to a single vault for the duration of
 * a session. Useful when you want to:
 *   - Prevent accidental writes to the wrong vault (safety)
 *   - Route a shared Claude install per-user (Donald's session locks
 *     to "donald", Mitch's locks to "mitch")
 *   - Focus a long session on one vault and reject cross-vault drift
 *
 * Lock state is stored as `registry.lockedVault` (mutated in-place by
 * these handlers). The actual enforcement happens via an
 * `applyLockGuard()` monkey-patch on `registry.resolveVault` (see
 * src/index.mjs) plus explicit checks in fan-out tools (search,
 * search_smart) for `vault: "*"`.
 *
 * Persistence: `persist: true` writes (or removes) the
 * `OBSIDIAN_ROUTER_LOCKED=<vault>` line in `<cwd>/.env`. The router
 * reads `OBSIDIAN_ROUTER_LOCKED` at startup, so persisted locks survive
 * Claude Code restarts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertDotenvScalar } from '../helpers/dotenv-scalar.mjs';
import { updateConfigBindings, withBinding, readBinding } from '../helpers/workspace-bindings.mjs';
/**
 * Lock the router to a single vault.
 *
 * Args:
 *   - vault (required): name of the vault to lock to.
 *   - persist (optional): if true, write OBSIDIAN_ROUTER_LOCKED=<vault>
 *     into <cwd>/.env so the lock survives router restarts.
 */
export async function lockVault(registry, args = {}) {
  const { vault, persist } = args;

  if (!vault || typeof vault !== 'string') {
    throw new Error(
      'lock_vault: missing required argument `vault` (string). Pass the name of the vault to lock to (see list_vaults).',
    );
  }

  // Verify the target is a real, active vault. Locking to a disabled or
  // unknown vault would brick every tool call until unlock.
  const target = registry.vaults.find((v) => v.name === vault);
  if (!target) {
    const known = registry.vaults.map((v) => v.name).join(', ') || '(none)';
    throw new Error(
      `lock_vault: cannot lock to "${vault}" — not in the active vault set. ` +
        `Known vaults: ${known}.`,
    );
  }

  // Apply the lock state BEFORE attempting persistence — even if the
  // persist write fails (refused below, or filesystem error), the
  // in-memory lock takes effect. The user can still re-run with persist
  // pointing at a sensible directory.
  registry.lockedVault = vault;
  // Provenance: from here on the lock is this session's doing, whatever a
  // workspace file said at start-up (decision `liaison-workspace-vault-hors-depot`).
  registry.lockSource = { origin: 'runtime', variable: null };

  let hintWritten = false;
  let envPath = null;
  let bindingRecorded = null;
  if (persist) {
    const cwd = process.cwd();
    // Refuse to write a `.env` at the user's home directory. That's
    // almost always a mistake (Claude Code launched from `~`) and
    // creating ~/.env silently would surprise the user. The proper
    // place for a global lock is `~/.claude/...` config or a real
    // project directory.
    //
    // Case-folding caveat: Windows paths are case-insensitive (NTFS),
    // so `C:\Users\Alice` and `C:\Users\alice` resolve to the same
    // directory. We normalize case on Windows before comparison so a
    // mixed-case cwd doesn't bypass the refusal.
    const samePath = (a, b) => {
      const ra = path.resolve(a);
      const rb = path.resolve(b);
      if (process.platform === 'win32') {
        return ra.toLowerCase() === rb.toLowerCase();
      }
      return ra === rb;
    };
    if (samePath(cwd, os.homedir())) {
      throw new Error(
        `lock_vault: refusing to persist OBSIDIAN_ROUTER_LOCKED in your home directory (${cwd}/.env). ` +
          `That's almost always unintended — Claude Code was launched from your home rather than a project folder. ` +
          `Either: (a) run \`lock_vault\` again from a real project directory, OR (b) set OBSIDIAN_ROUTER_LOCKED=${vault} manually in your shell profile (.bashrc / PowerShell $PROFILE) for true machine-wide persistence. ` +
          `The in-memory lock IS active for this session.`,
      );
    }
    envPath = path.join(cwd, '.env');
    await upsertDotenvVar(envPath, 'OBSIDIAN_ROUTER_LOCKED', vault);
    hintWritten = true;
    // AND the binding, since v0.90.0. Persisting a lock is an explicit act of
    // the user saying "this workspace goes with this vault, permanently" —
    // which is exactly a confirmation. Recording it means the lock survives in
    // the user's OWN config rather than only in a file that travels with a
    // clone; the dotenv line stays as the portable hint for the next machine.
    // Best effort: a config this process cannot write must not undo a lock
    // that is already in force and already persisted to the workspace file.
    bindingRecorded = recordLockInBinding(registry, cwd, vault);
  }

  // `persisted` MEANS "WILL SURVIVE A RESTART", and since v0.90.0 only the
  // binding does that. The workspace `.env` line is still written — it is the
  // portable hint that lets the next machine PROPOSE this lock — but a lock a
  // project file names is no longer imposed on start-up, so reporting the
  // dotenv write as persistence would promise something that has stopped being
  // true. The Codex review of 2026-09-03 flagged the older mismatch (a
  // `persisted: true` that meant "the .env, at least"); closing the gate that
  // same day turned it from misleading into false.
  const persisted = bindingRecorded !== null;
  return ({
    locked: true,
    vault,
    persisted,
    // The portable hint, reported separately from the thing that persists.
    hintWritten,
    envPath: hintWritten ? envPath : undefined,
    // What was recorded in the user's own config, or null when nothing was
    // (no persist asked, or a config that could not be written).
    bindingRecorded,
    message:
      `Router locked to "${vault}". ` +
      (persisted
        ? 'The workspace is bound to it in your own router config, so the lock survives a restart'
          + (hintWritten ? `, and OBSIDIAN_ROUTER_LOCKED=${vault} was written to ${envPath} as a portable hint for another machine.` : '.')
        : hintWritten
          ? `OBSIDIAN_ROUTER_LOCKED=${vault} was written to ${envPath}, but your router config could NOT be written`
            + ' — so this lock does NOT survive a restart: a lock named only by a project file is no longer'
            + ' applied at start-up. Fix the config permissions and run lock_vault again.'
          : 'Lock is volatile (this session only). Use persist:true to make it survive restarts.'),
  });
}

/**
 * Unlock the router (clear the active lock).
 *
 * Args:
 *   - persist (optional): if true, ALSO remove the
 *     OBSIDIAN_ROUTER_LOCKED line from <cwd>/.env so the unlock
 *     survives a restart. If false (default), only the in-memory lock
 *     is cleared — a persisted .env entry would re-lock at next startup.
 */
export async function unlockVaults(registry, args = {}) {
  const { persist } = args;

  const wasLocked = registry.lockedVault;
  registry.lockedVault = null;
  registry.lockSource = { origin: 'unset', variable: null };

  let persistRemoved = false;
  let bindingLifted = false;
  let envPath = null;
  if (persist) {
    envPath = path.join(process.cwd(), '.env');
    // Symmetrical with `lock_vault --persist`: lift the lock in the user's own
    // config too, or a restart would re-lock from the binding even after the
    // dotenv line is gone. It does NOT remove the binding — the workspace still
    // goes with its vault, it is simply no longer restricted to it. Best effort,
    // and before the throwing branch below so an unwritable config cannot mask
    // the dotenv failure, which is the one that actually re-locks on restart.
    bindingLifted = recordLockInBinding(registry, process.cwd(), null) !== null;
    try {
      persistRemoved = await removeDotenvVar(envPath, 'OBSIDIAN_ROUTER_LOCKED');
    } catch (err) {
      // The in-memory lock IS already cleared above. Surface the
      // partial-success state explicitly.
      //
      // WHAT ACTUALLY RE-LOCKS ON RESTART IS THE BINDING, not the dotenv line.
      // Since v0.90.0 a lock named only by a project file is refused at
      // start-up, so a leftover `.env` line is now inert — and telling the
      // user to go and delete it would send them to fix the harmless half
      // while the real one (a binding whose lock could not be lifted) went
      // unmentioned. The two cases are reported separately for that reason.
      throw new Error(
        `unlock_vaults: in-memory lock cleared, but failed to remove `
        + `OBSIDIAN_ROUTER_LOCKED from ${envPath} (${err.message}). `
        + (bindingLifted
          ? 'The lock was lifted in your router config, so the router will NOT re-lock on restart; '
            + 'the leftover line is only a stale hint for another machine — remove it when convenient.'
          : `The lock could ALSO not be lifted in your router config, so the router WILL re-lock to `
            + `"${wasLocked}" on next restart. Fix the config permissions and run unlock_vaults again.`),
      );
    }
  }

  return ({
    locked: false,
    wasLocked: wasLocked || null,
    persisted: persist === true,
    envPath: persist ? envPath : undefined,
    persistRemoved,
    // Whether the lock was lifted where it actually persists.
    bindingLifted,
    message:
      wasLocked
        ? `Router unlocked from "${wasLocked}".` +
          (persist
            ? (bindingLifted
              ? ' The lock was lifted in your router config, so it will not come back on restart.'
              : ' The lock could NOT be lifted in your router config — if one was recorded there,'
                + ' it will come back on restart.')
              + (persistRemoved
                ? ` The hint was also removed from ${envPath}.`
                : ` No OBSIDIAN_ROUTER_LOCKED line found in ${envPath} — already absent.`)
            // A volatile unlock leaves whatever is recorded in the config
            // untouched, and THAT is what re-locks. A leftover `.env` line no
            // longer does anything on its own.
            : ' In-memory only; a lock recorded in your router config will come back on restart.'
              + ' Use persist:true to lift it there too.')
        : 'Router was not locked. No-op.',
  });
}

// ---------------------------------------------------------------------------
// .env mutation helpers — line-oriented, preserve other lines verbatim
// ---------------------------------------------------------------------------

/**
 * Set or update KEY=VALUE in the .env file at envPath. Creates the file
 * if it doesn't exist. Preserves all other lines, including comments and
 * formatting.
 *
 * Duplicate-line policy: updates the FIRST occurrence and leaves later
 * duplicates as-is. This matches the convention of our .env loader at
 * bin/obsidian-mcp-router.mjs, which keeps the first occurrence
 * (line ~45: `if (!(key in process.env))` skips later assignments).
 * Updating the last occurrence instead would create a writer/reader
 * disagreement: the writer would update the bottom line but the loader
 * would still read the stale top one. CRLF line endings on Windows are
 * silently converted to LF on write — acceptable for .env files which
 * shells/Node parse equivalently with either ending.
 */
async function upsertDotenvVar(envPath, key, value) {
  // One shared definition — see helpers/dotenv-scalar.mjs. The guard first
  // lived HERE and nowhere else, which is why the setup script kept writing
  // injectable values for a whole review round.
  assertDotenvScalar(value, key, envPath);
  let lines = [];
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    lines = raw.split(/\r?\n/);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // File doesn't exist — start with an empty array
  }

  // Find the FIRST occurrence of `<key>=` (start-of-line, ignoring
  // surrounding whitespace) and update it. If absent, append.
  let firstIdx = -1;
  const keyRegex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    if (keyRegex.test(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  const newLine = `${key}=${value}`;
  if (firstIdx === -1) {
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
    lines[firstIdx] = newLine;
  }

  // Always end with a newline
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  await fs.writeFile(envPath, out, 'utf8');
}

/**
 * Remove all `<key>=...` lines from the .env file. Returns true if at
 * least one line was removed, false if the file or the key was absent.
 */
async function removeDotenvVar(envPath, key) {
  let raw;
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }

  const lines = raw.split(/\r?\n/);
  const keyRegex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const filtered = lines.filter((l) => !keyRegex.test(l));
  if (filtered.length === lines.length) return false;

  let out = filtered.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  await fs.writeFile(envPath, out, 'utf8');
  return true;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exported for tests only.
/**
 * Record (or lift) the lock on this workspace's binding, in the user's own
 * config. Returns what happened, or null when there was nothing to do or the
 * config could not be written.
 *
 * BEST EFFORT BY DESIGN. The lock itself is already in force in memory and
 * already written to the workspace file by the time this runs; a config the
 * process cannot write must not turn a successful lock into a failed tool
 * call. The caller reports what happened instead.
 *
 * When `locked` is true and the workspace has no binding yet, one is CREATED:
 * persisting a lock is the user saying "this workspace goes with this vault,
 * permanently", which is a confirmation in everything but name.
 *
 * @param {object} registry
 * @param {string} cwd
 * @param {string|null} vault the vault to lock to, or null to lift the lock
 * @returns {{ vault: string|null, locked: boolean }|null}
 */
function recordLockInBinding(registry, cwd, vault, seams = {}) {
  if (!registry?.configPath) return null;
  try {
    const next = updateConfigBindings(registry.configPath, (cfg) => {
      const existing = readBinding(cfg, cwd);
      if (vault) {
        return withBinding(cfg, cwd, {
          vault,
          // A lock does not change which OTHER vaults this workspace is bound
          // to; it only narrows what the session may reach right now.
          also: existing && existing.vault === vault ? existing.also : [],
          locked: true,
          confirmedVia: existing?.confirmedVia || 'lock',
          confirmedAt: existing?.confirmedAt || undefined,
        });
      }
      // Lifting a lock never removes the binding — the workspace still goes
      // with its vault, it is simply no longer restricted to it.
      if (!existing) return cfg;
      return withBinding(cfg, cwd, { ...existing, locked: false });
    }, seams);
    const b = readBinding(next, cwd);
    // THE LIVE REGISTRY LEARNS WHAT THE FILE NOW SAYS. Without this,
    // `list_vaults` kept reporting the binding as it was at start-up —
    // `locked: false` right after a persistent lock, `locked: true` right
    // after a persistent unlock — indefinitely under `--no-watch`. Codex
    // round 2, 2026-09-03. The registry object is the same one the server
    // holds, so this is the in-session half of the write.
    registry.workspaceBinding = b;
    return b ? { vault: b.vault, locked: b.locked } : null;
  } catch {
    return null;
  }
}

export const _internals = { upsertDotenvVar, removeDotenvVar, recordLockInBinding };
