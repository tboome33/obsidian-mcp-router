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
 * Persistence: `persist: true` records `locked: true` on this workspace's
 * BINDING, in the user's own router config — that is what a restart reads.
 * It also writes `OBSIDIAN_ROUTER_LOCKED=<vault>` into `<cwd>/.env`, but only
 * as a portable hint for another machine: since the binding registry landed,
 * a lock named by a project file is reported and NOT applied at start-up, so
 * the dotenv line alone no longer survives anything. The result's `persisted`
 * means "will survive a restart" and is therefore false whenever the config
 * could not be written, with `hintWritten` reporting the dotenv half
 * separately.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertDotenvScalar } from '../helpers/dotenv-scalar.mjs';
import {
  updateConfigBindings,
  withBinding,
  readBinding,
  refreshRegistryBindingHint,
} from '../helpers/workspace-bindings.mjs';
import { isVaultReachable, isPromotionOfLockedSecondary } from '../helpers/vault-reach.mjs';
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
  // Same reasoning, one guard further: applyLockGuard() (src/index.mjs) makes
  // EVERY subsequent resolveVault() call — including calls that omit `vault`
  // — resolve `registry.lockedVault` specifically. Once vaultReach:
  // "declared" is active, resolveVault() refuses a vault this workspace
  // cannot reach, so locking to one it does not yet reach would brick every
  // tool call exactly as the comment above warns against for a disabled or
  // unknown vault — just one guard later, and previously unchecked here.
  if (!isVaultReachable(vault, registry)) {
    throw new Error(
      `lock_vault: cannot lock to "${vault}" — it is registered but not reachable from this workspace ` +
        '(vaultReach: "declared" is active, and this workspace\'s binding does not name it, nor is it in ' +
        '`openVaults`). Locking to it would refuse every subsequent call until unlock. Bind this workspace ' +
        'to it with confirm_workspace_binding first, or add it to `openVaults` in config.json.',
    );
  }

  // A PERSISTED lock rewrites the binding with the locked vault as PRIMARY
  // (`recordLockInBinding` below) — and a primary is never under a write
  // tier. So `lock_vault({ vault: S, persist: true })` on an `alsoLocked`
  // secondary S was a one-call way past "no exceptions", through a tool whose
  // whole purpose is to RESTRICT the session (review round 3). Refused
  // before anything is applied, in-memory lock included, so the refusal
  // leaves no half-state behind. A volatile lock to S stays allowed: it
  // does not touch the binding, S stays a locked secondary, and every write
  // routed to it is still refused by the gate.
  if (persist && isPromotionOfLockedSecondary(vault, registry)) {
    throw new Error(
      `lock_vault: "${vault}" is an alsoLocked SECONDARY of this workspace, and persist:true would `
      + 'record it as the workspace\'s PRIMARY — lifting that hard read-only tier from the conversation. '
      + 'Lock without persist (the lock stays for this session only), edit `alsoLocked` in config.json '
      + 'if this workspace is meant to maintain that vault, or clear the binding first.',
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
    // A LOCK THAT WAS RECORDED IS THE BINDING'S LOCK, and its source says so.
    // Left as 'runtime', `confirm_workspace_binding({ clear: true })` — which
    // releases a lock by asking who imposed it — kept the session locked after
    // removing the very binding that held the lock, while answering "all
    // registered vaults are available again"; the next start then disagreed
    // with the session. Found in the sixth review, 2026-09-04.
    if (bindingRecorded) registry.lockSource = { origin: 'binding', variable: null };
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
  // WHO IMPOSED IT, read before it is cleared. A lock the HOST set
  // (`OBSIDIAN_ROUTER_LOCKED` in the MCP declaration or the launching shell)
  // is re-imposed at every start whatever this tool writes: the config cannot
  // lift it, and the message used to promise "it will not come back on
  // restart" regardless. Found in the sixth review, 2026-09-04.
  const hostReimposes = registry.lockSource?.origin === 'host';
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
          ? 'No lock is recorded for this workspace in your router config, so the router will NOT '
            + 're-lock; the leftover line is only a stale hint for another machine — remove it when convenient.'
          : `Your router config could ALSO not be written, so if a lock is recorded there the router WILL re-lock to `
            + `"${wasLocked}" on next restart. Fix the config permissions and run unlock_vaults again.`),
      );
    }
  }

  return ({
    locked: false,
    wasLocked: wasLocked || null,
    // `persisted` MEANS THE SAME THING ON BOTH TOOLS: "this survives a
    // restart". It used to be `persist === true` here — a report of what the
    // CALLER ASKED FOR, not of what happened — so an unlock on an unwritable
    // config returned `persisted: true` beside `bindingLifted: false`, two
    // fields of one response contradicting each other while the binding stayed
    // locked and came back at the next start. Asymmetry between `lock_vault`
    // and `unlock_vaults` on a field of the same name was the part that made
    // it hard to see. (Codex, round 5.)
    // And never true for a host lock: nothing this tool writes outlives the
    // host's own declaration.
    persisted: persist === true && bindingLifted && !hostReimposes,
    envPath: persist ? envPath : undefined,
    persistRemoved,
    // Whether the lock was lifted where it actually persists.
    bindingLifted,
    // Whether the host's own OBSIDIAN_ROUTER_LOCKED re-imposes the lock at the
    // next start, which no persist can prevent.
    hostReimposes,
    message:
      wasLocked
        ? `Router unlocked from "${wasLocked}".` +
          (persist
            ? (hostReimposes
              ? ` This lock came from the host — OBSIDIAN_ROUTER_LOCKED in your MCP declaration or your shell —`
                + ' and the router config cannot lift that: it WILL come back at the next start until that'
                + ' variable is removed where it is set.'
              : bindingLifted
              // True also when the workspace had no recorded lock at all —
              // "no lock is recorded" is the fact the user needs, and it is
              // the same fact in both cases.
              ? ' No lock is recorded for this workspace in your router config any more,'
                + ' so it will not come back on restart.'
              : ' Your router config could NOT be written — if a lock was recorded there,'
                + ' it will come back on restart.')
              + (persistRemoved
                ? ` The hint was also removed from ${envPath}.`
                : ` No OBSIDIAN_ROUTER_LOCKED line found in ${envPath} — already absent.`)
            // A volatile unlock leaves whatever is recorded in the config
            // untouched, and THAT is what re-locks. A leftover `.env` line no
            // longer does anything on its own.
            : (hostReimposes
              ? ' In-memory only; this lock came from the host (OBSIDIAN_ROUTER_LOCKED in your MCP'
                + ' declaration or your shell) and will come back on restart until that variable is removed.'
              : ' In-memory only; a lock recorded in your router config will come back on restart.'
                + ' Use persist:true to lift it there too.'))
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
 * config.
 *
 * RETURNS: the binding's state when the operation succeeded — INCLUDING the
 * case where there was nothing to lift, which is a success and reports
 * `{ vault: null, locked: false, also: [] }` for a workspace with no binding.
 * `null` means one thing only: the config could not be written, so a lock
 * recorded there may still be in force. The caller turns that distinction into
 * `bindingLifted`, and `skills/unlock` tells Claude what each value means — an
 * earlier version returned `null` for both and had the skill announce a lock
 * that had never existed.
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
 * NOTHING IS LOST WHEN THE LOCK NAMES ANOTHER VAULT. The first version wrote
 * `also: existing.vault === vault ? existing.also : []`, so locking a
 * workspace bound to A (with B also bound) onto C left `{ vault: C, also: [] }`
 * — A and B silently gone, while the comment above the line claimed a lock
 * "does not change which OTHER vaults this workspace is bound to". Measured on
 * 2026-09-03. The locked vault does become the PRIMARY, because that is what
 * the user just said this workspace goes with; the previous primary and every
 * secondary move into `also`, where they stay bound — and addressable by name
 * again once the lock is lifted; while it holds, the guard answers for the
 * primary alone.
 *
 * @param {object} registry
 * @param {string} cwd
 * @param {string|null} vault the vault to lock to, or null to lift the lock
 * @returns {{ vault: string|null, locked: boolean, also: string[] }|null}
 */
function recordLockInBinding(registry, cwd, vault, seams = {}) {
  if (!registry?.configPath) return null;
  try {
    let wrote = false;
    const next = updateConfigBindings(registry.configPath, (cfg) => {
      // READ INSIDE THE LOCK. Everything this transform decides — which
      // secondaries survive, whose confirmation this was — is derived from
      // the binding as it is NOW, not from a copy read before the lock was
      // taken. That was the shape of the merge review's BLOCKER.
      const existing = readBinding(cfg, cwd);
      if (vault) {
        wrote = true;
        // The previous primary and its secondaries, minus the new primary.
        // `withBinding` drops the primary from `also` itself; the filter here
        // is what keeps the ORDER meaningful (previous primary first).
        const carried = existing
          ? [existing.vault, ...existing.also].filter((n) => n !== vault)
          : [];
        // The tier of each secondary that STAYS a secondary survives; the
        // previous primary joins `also` with no tier (soft), like any newly
        // declared secondary. Same rule as confirm_workspace_binding.
        const keep = (list) => (existing && Array.isArray(list) ? list.filter((n) => carried.includes(n)) : []);
        return withBinding(cfg, cwd, {
          vault,
          also: carried,
          locked: true,
          alsoLocked: keep(existing?.alsoLocked),
          alsoWritable: keep(existing?.alsoWritable),
          // AN EXPLICIT LOCK IS A CONFIRMATION, so it replaces `migration`.
          // Keeping it meant the briefing went on saying "NOBODY CONFIRMED
          // THIS BINDING" after the user had locked the workspace by hand —
          // an accusation the user's own action had already answered. A real
          // confirmation (`tool`, `attach`) is not overwritten: it is not
          // this lock's place to claim it.
          confirmedVia: existing && existing.confirmedVia !== 'migration'
            ? existing.confirmedVia
            : 'lock',
          confirmedAt: existing?.confirmedAt || undefined,
        });
      }
      // Lifting a lock never removes the binding — the workspace still goes
      // with its vault, it is simply no longer restricted to it. With no
      // binding at all there is nothing to lift, and the config is returned
      // untouched rather than rewritten to the same bytes.
      if (!existing || !existing.locked) return cfg;
      wrote = true;
      return withBinding(cfg, cwd, { ...existing, locked: false });
    }, seams);
    // NOT-WRITING IS A SUCCESS ON THE LIFT PATH, and the difference matters to
    // the sentence the user reads. `null` from this function means "the config
    // could not be written, a recorded lock may still be there"; a workspace
    // with no binding, or one already unlocked, has nothing to lift and the
    // honest report is that no lock will come back. The first version returned
    // `null` for both, and `skills/unlock` told Claude to say the lock was
    // still recorded — for a workspace that never had one.
    // ONE PLACE APPLIES THE RESULT TO THE LIVE REGISTRY, for both paths. The
    // first version of the no-write branch refreshed `workspaceBinding` and
    // the hint but not `defaultVault`, so an `unlock_vaults --persist` that
    // found the disk binding already pointing elsewhere adopted that binding
    // while still routing unqualified calls to the vault this session had
    // started on — a registry contradicting itself, and writes landing in the
    // vault the user had moved away from. A repair that reaches only one of
    // two exit paths is the shape this repository keeps rediscovering.
    // (Codex, round 5.)
    const b = readBinding(next, cwd);
    // THE LIVE REGISTRY LEARNS WHAT THE FILE NOW SAYS. Without this,
    // `list_vaults` kept reporting the binding as it was at start-up —
    // `locked: false` right after a persistent lock, `locked: true` right
    // after a persistent unlock — indefinitely under `--no-watch`. Codex
    // round 2, 2026-09-03. The registry object is the same one the server
    // holds, so this is the in-session half of the write.
    registry.workspaceBinding = b;
    // AND SO DOES THE DEFAULT VAULT. The binding is tier 0 of the cascade, so
    // a persisted lock that moves the primary moves the session default with
    // it — otherwise `unlock_vaults` handed the session back to whatever the
    // cascade had picked at start-up, while the config said the workspace goes
    // with the vault just locked. Found in the final review, 2026-09-03.
    if (b) {
      registry.defaultVault = b.vault;
      registry.defaultVaultSource = { origin: 'binding', variable: null };
    }
    // The hint is a statement ABOUT the binding, so it is re-read whenever the
    // binding changes.
    refreshRegistryBindingHint(registry);
    if (b) return { vault: b.vault, locked: b.locked, also: b.also };
    // NO BINDING, AND WHICH OPERATION THIS WAS DECIDES THE ANSWER. Lifting a
    // lock on a workspace that has none is a SUCCESS — there is nothing to
    // lift and nothing will come back — and `unlock_vaults` turns it into
    // `bindingLifted: true`. Locking that produced no binding is a failure,
    // because a lock was asked for and is not recorded anywhere. Collapsing
    // the two into `null` had `skills/unlock` announce a lock that had never
    // existed; unifying the two exit paths above brought the collapse back for
    // twenty minutes, which is why it is written out here rather than left to
    // the shape of the code.
    return vault ? null : { vault: null, locked: false, also: [] };
  } catch {
    return null;
  }
}

export const _internals = { upsertDotenvVar, removeDotenvVar, recordLockInBinding };
