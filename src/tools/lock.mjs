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

  let persisted = false;
  let envPath = null;
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
    persisted = true;
  }

  return ({
    locked: true,
    vault,
    persisted,
    envPath: persisted ? envPath : undefined,
    message:
      `Router locked to "${vault}". ` +
      (persisted
        ? `OBSIDIAN_ROUTER_LOCKED=${vault} written to ${envPath} — lock survives restart.`
        : `Lock is volatile (this session only). Use persist:true to make it survive restarts.`),
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

  let persistRemoved = false;
  let envPath = null;
  if (persist) {
    envPath = path.join(process.cwd(), '.env');
    try {
      persistRemoved = await removeDotenvVar(envPath, 'OBSIDIAN_ROUTER_LOCKED');
    } catch (err) {
      // The in-memory lock IS already cleared above. Surface the
      // partial-success state explicitly so the user can fix the .env
      // manually before the next router restart relocks them.
      throw new Error(
        `unlock_vaults: in-memory lock cleared, but failed to remove ` +
          `OBSIDIAN_ROUTER_LOCKED from ${envPath} (${err.message}). ` +
          `If you don't remove the line manually, the router will re-lock ` +
          `to "${wasLocked}" on next restart.`,
      );
    }
  }

  return ({
    locked: false,
    wasLocked: wasLocked || null,
    persisted: persist === true,
    envPath: persist ? envPath : undefined,
    persistRemoved,
    message:
      wasLocked
        ? `Router unlocked from "${wasLocked}".` +
          (persist
            ? persistRemoved
              ? ` Removed OBSIDIAN_ROUTER_LOCKED from ${envPath}.`
              : ` No OBSIDIAN_ROUTER_LOCKED line found in ${envPath} — already absent.`
            : ` In-memory only; if .env has OBSIDIAN_ROUTER_LOCKED set, it'll re-lock on restart. Use persist:true to remove it.`)
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
export const _internals = { upsertDotenvVar, removeDotenvVar };
