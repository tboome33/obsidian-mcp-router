/**
 * lock_vault / unlock_vaults — runtime isolation toggle.
 *
 * "Lock mode" restricts the router to a single vault for the duration of
 * a session. Useful when you want to:
 *   - Prevent accidental writes to the wrong vault (safety)
 *   - Route a shared Claude install per-user (Roland's session locks
 *     to "roland", Nicolas's locks to "nicolas")
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

  registry.lockedVault = vault;

  let persisted = false;
  let envPath = null;
  if (persist) {
    envPath = path.join(process.cwd(), '.env');
    await upsertDotenvVar(envPath, 'OBSIDIAN_ROUTER_LOCKED', vault);
    persisted = true;
  }

  return {
    locked: true,
    vault,
    persisted,
    envPath: persisted ? envPath : undefined,
    message:
      `Router locked to "${vault}". ` +
      (persisted
        ? `OBSIDIAN_ROUTER_LOCKED=${vault} written to ${envPath} — lock survives restart.`
        : `Lock is volatile (this session only). Use persist:true to make it survive restarts.`),
  };
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
    persistRemoved = await removeDotenvVar(envPath, 'OBSIDIAN_ROUTER_LOCKED');
  }

  return {
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
  };
}

// ---------------------------------------------------------------------------
// .env mutation helpers — line-oriented, preserve other lines verbatim
// ---------------------------------------------------------------------------

/**
 * Set or update KEY=VALUE in the .env file at envPath. Creates the file
 * if it doesn't exist. Preserves all other lines, including comments and
 * formatting. If KEY exists multiple times, only the last occurrence is
 * updated and earlier ones are left as-is (they would be shadowed by
 * the last anyway in standard parsers — this matches the .env loader's
 * behavior).
 */
async function upsertDotenvVar(envPath, key, value) {
  let lines = [];
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    lines = raw.split(/\r?\n/);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // File doesn't exist — start with an empty array
  }

  // Find the LAST occurrence of `<key>=` (start-of-line, ignoring
  // surrounding whitespace) and update it. If absent, append.
  let lastIdx = -1;
  const keyRegex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (keyRegex.test(lines[i])) {
      lastIdx = i;
      break;
    }
  }
  const newLine = `${key}=${value}`;
  if (lastIdx === -1) {
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
    lines[lastIdx] = newLine;
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
