/**
 * set_secondary_vault_mode — record, for THIS workspace, the write tier of
 * one of its SECONDARY (`also`) vaults.
 *
 * The conversational half of decision `portee-et-mode-ecriture-des-vaults`
 * §2, in the shape Roland asked for on 2026-09-05: "paramétrons les vaults
 * secondaires" → the secondaries that answer are detected and bound, then
 * for EACH one the user is asked which of three modes it gets. This tool
 * records one answer. The three modes, in the user's own words:
 *
 *   - `locked`   — lecture seule stricte : refused unconditionally, no
 *                  write-call override, no direct promotion to primary while
 *                  listed. This tool can change a binding-local tier; clearing
 *                  the binding also removes its local tiers.
 *   - `soft`     — lecture seule, écriture possible sur demande : refused
 *                  unless the write carries `confirmSecondaryWrite: true`,
 *                  which the model may only set after asking the user.
 *                  The default of every secondary; recording it EXPLICITLY
 *                  is how a vault leaves the other two modes.
 *   - `writable` — lecture-écriture automatique : no friction.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE ANSWER LIVES
 * ---------------------------------------------------------------------------
 * On the BINDING RECORD of this workspace, in the user's own router config
 * (`workspaceBindings.<canonical cwd>.alsoLocked` / `.alsoWritable`), through
 * `updateConfigBindings` — the ONE writer of that section, with its
 * inter-process lock and atomic write. Per workspace, because that is what
 * the user described: the same reference base can be strict in a project
 * that only consults it and read-write in the one that maintains it (where
 * it is the PRIMARY, and this tool does not apply at all).
 *
 * The decision page first described these as GLOBAL config lists; those
 * still work (`alsoWriteTierFor` reads both, locked anywhere wins). This
 * tool never touches them — a vault the global list locks stays locked
 * whatever is recorded here, and the result says so.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT DO
 * ---------------------------------------------------------------------------
 *   - Bind anything. The vault must already be a secondary of this
 *     workspace's binding (`confirm_workspace_binding({ vault, also })`).
 *     A tool that both binds and qualifies would be a tool that binds a
 *     vault the user never named, by accident, while answering a question
 *     about another one.
 *   - Qualify the PRIMARY. It is always read-write, by the decision.
 *   - Act on a workspace with no binding, or on another workspace than the
 *     current one — same reasons as `confirm_workspace_binding`.
 */

import fs from 'node:fs';
import { writeFileAtomicSync } from '../helpers/write-file-atomic.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';
import {
  readBinding,
  readRefusals,
  withBinding,
  canonicalWorkspaceKey,
  updateConfigBindings,
  refreshRegistryBindingHint,
} from '../helpers/workspace-bindings.mjs';
import { isGatedDeployment, gatedDeploymentRefusal } from '../helpers/workspace-dotenv.mjs';

export const TOOL_NAME = 'set_secondary_vault_mode';

/** The closed vocabulary of a secondary's write tier. */
export const SECONDARY_MODES = Object.freeze(['locked', 'soft', 'writable']);

const MODE_WORDS = Object.freeze({
  locked: 'read-only, strict (no override, no promotion)',
  soft: 'read-only, with a per-write override once the user has said yes in the conversation',
  writable: 'read-write, no friction',
});

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Record, for the CURRENT workspace, the write tier of one of its SECONDARY vaults (a vault in the binding\'s `also`). '
    + 'Three modes: "locked" = read-only, strict — every write is refused, confirmSecondaryWrite is ignored, and the '
    + 'vault cannot be promoted to primary from the conversation; "soft" = read-only with a per-write override — a write '
    + 'is refused unless it carries confirmSecondaryWrite: true, which you may set ONLY after asking the user and getting '
    + 'their explicit yes (this is the default of every secondary); "writable" = read-write, no friction. Recorded on '
    + 'this workspace\'s binding in the user\'s own router config, so the same vault can be strict in one project and '
    + 'writable in another. The vault must ALREADY be a secondary of this workspace (confirm_workspace_binding with '
    + '`also`) — this never binds. It never qualifies the primary, which is always read-write. Call it once per '
    + 'secondary, with the mode the user chose; the "configure-secondary-vaults" skill is the guided conversation '
    + 'that detects the open vaults and asks the question for each. Not available on a gated deployment '
    + '(OBSIDIAN_ROUTER_READONLY / ALLOWED_VAULTS / USER_ID): the workspace there is the server\'s own directory, '
    + 'shared by every caller, so one caller would be opening a vault for writing on behalf of all of them.',
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'A secondary vault of this workspace — a name from the binding\'s `also` (see list_vaults → workspaceBinding.also).',
      },
      mode: {
        type: 'string',
        enum: [...SECONDARY_MODES],
        description: '"locked" | "soft" | "writable" — see the tool description for what each means.',
      },
    },
    required: ['vault', 'mode'],
    additionalProperties: false,
  },
};

/**
 * Which mode a normalised binding currently records for `vault`.
 * @param {{ alsoLocked?: string[], alsoWritable?: string[] }} binding
 * @param {string} vault
 */
function recordedMode(binding, vault) {
  if (Array.isArray(binding?.alsoLocked) && binding.alsoLocked.includes(vault)) return 'locked';
  if (Array.isArray(binding?.alsoWritable) && binding.alsoWritable.includes(vault)) return 'writable';
  return 'soft';
}

/**
 * Record the write tier of `args.vault` for the current workspace.
 *
 * @param {object} registry the live registry — the binding is read from it and updated on it
 * @param {{ vault?: string, mode?: string }} args
 * @param {{ cwd?: string, readFile?: Function, writeFile?: Function }} [seams] test seams
 */
export async function setSecondaryVaultMode(registry, args = {}, seams = {}) {
  const {
    cwd = process.cwd(),
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    writeFile = (p, c) => writeFileAtomicSync(p, c),
  } = seams;

  const configPath = registry?.configPath;
  if (!configPath) {
    throw new Error('set_secondary_vault_mode: the router has no config path — nothing to record the mode into.');
  }
  const key = canonicalWorkspaceKey(cwd);
  if (!key) {
    throw new Error('set_secondary_vault_mode: no usable working directory, so there is no workspace whose secondary to qualify.');
  }

  // NOT ON A GATED DEPLOYMENT — the same rule, and the same sentence, as
  // `confirm_workspace_binding`. This tool writes a write TIER onto the
  // server's own workspace binding, in the config every tenant shares: one
  // caller could open a vault for writing on behalf of all of them, which is
  // the opposite of what the tier exists for. Closed in Phase 6.
  if (isGatedDeployment()) {
    throw gatedDeploymentRefusal('set_secondary_vault_mode', "a secondary's write tier");
  }

  const vault = args.vault;
  if (typeof vault !== 'string' || vault.trim() === '') {
    throw new Error('set_secondary_vault_mode: `vault` is required — a secondary vault of this workspace (see list_vaults → workspaceBinding.also).');
  }
  const mode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : args.mode;
  if (!SECONDARY_MODES.includes(mode)) {
    throw new Error(
      `set_secondary_vault_mode: \`mode\` must be one of ${SECONDARY_MODES.map((m) => `"${m}"`).join(', ')} `
      + `(got ${safeForMessage(JSON.stringify(args.mode), 60)}).`,
    );
  }

  // EVERY ACCEPTANCE OR REFUSAL IS DECIDED INSIDE THE CONFIG LOCK, against the
  // file as it is — never against `registry.workspaceBinding`, which is what
  // this process loaded (or last wrote) and which another session may have
  // overtaken since: process A still holds `ref` as its primary while B has
  // re-bound the workspace onto `notes` with `ref` as a secondary, and A's
  // answer about `ref` must be recorded, not refused on A's stale copy. The
  // first version asked the live copy first, "for a message that names what
  // this session sees" — and refused on it. (Codex, round on fd9e1cd.) The
  // live registry LEARNS from the file afterwards, below.
  const shown = safeForMessage(vault, 80);
  const io = { readFile, writeFile };
  let previousMode = null;
  const next = updateConfigBindings(configPath, (cfg) => {
    const existing = readBinding(cfg, cwd);
    if (!existing) {
      throw new Error(
        'set_secondary_vault_mode: this workspace has no binding in the router config'
        + (registry.workspaceBinding
          ? ' any more (another session or a hand edit removed it since this session started)'
          : '')
        + `, so "${shown}" is not a secondary of anything. `
        + 'Bind the workspace first: confirm_workspace_binding({ vault: <primary>, also: [...] }).',
      );
    }
    if (existing.vault === vault) {
      throw new Error(
        `set_secondary_vault_mode: "${shown}" is this workspace's PRIMARY vault, which is always read-write. `
        + 'Only a secondary (a vault in `also`) has a write tier.',
      );
    }
    if (!existing.also.includes(vault)) {
      const secondaries = existing.also.map((n) => `"${safeForMessage(n, 60)}"`).join(', ') || '(none)';
      throw new Error(
        `set_secondary_vault_mode: "${shown}" is not a secondary of this workspace. Secondaries: ${secondaries}. `
        + 'Add it first with confirm_workspace_binding({ vault: <primary>, also: [...] }), then record its mode.',
      );
    }
    previousMode = recordedMode(existing, vault);
    // THE SAME ANSWER TWICE WRITES NOTHING — decided HERE, not left to
    // `withBinding`'s identity rule. That rule compares NORMALISED records,
    // and a hand-authored binding with no `confirmedAt` normalises to one
    // carrying today's date, so re-recording its unchanged mode rewrote the
    // file that holds every vault's API key and stamped a confirmation date
    // nobody gave. (Codex, round on fd9e1cd.) `updateConfigBindings` reads
    // the returned identity and leaves the file alone.
    if (previousMode === mode) return cfg;
    const alsoLocked = existing.alsoLocked.filter((n) => n !== vault);
    const alsoWritable = existing.alsoWritable.filter((n) => n !== vault);
    if (mode === 'locked') alsoLocked.push(vault);
    if (mode === 'writable') alsoWritable.push(vault);
    return withBinding(cfg, cwd, { ...existing, alsoLocked, alsoWritable });
  }, io);

  // The live registry learns what the file now says — the gate reads
  // `registry.workspaceBinding` on every call, so the mode is in force at once.
  // AND THE DEFAULT VAULT WITH IT (tier 0 of the cascade): a binding adopted
  // from the file may name another primary than the one this session loaded,
  // and a registry whose binding says `notes` while unqualified calls still go
  // to `ref` is the self-contradiction `lock_vault` had to fix in round 5.
  const binding = readBinding(next, cwd);
  registry.workspaceBinding = binding;
  // The refusals too: `withBinding` drops a stale refusal of any bound vault
  // on its way through, and the live copy must say what the file says
  // (Codex, round on b59eb00 — found one writer over, in lock.mjs).
  registry.workspaceRefusals = readRefusals(next, cwd);
  if (binding) {
    registry.defaultVault = binding.vault;
    registry.defaultVaultSource = { origin: 'binding', variable: null };
  }
  refreshRegistryBindingHint(registry);

  // A GLOBAL list can outrank what was just recorded (locked anywhere wins).
  // Said in the result rather than silently: the user just answered a
  // question and deserves to know if config.json answered it first.
  const globallyLocked = Array.isArray(registry.alsoLocked) && registry.alsoLocked.includes(vault);
  const globallyWritable = Array.isArray(registry.alsoWritable) && registry.alsoWritable.includes(vault);
  let overriddenBy = null;
  if (globallyLocked && mode !== 'locked') overriddenBy = 'alsoLocked';
  else if (globallyWritable && mode === 'soft') overriddenBy = 'alsoWritable';

  return {
    workspace: key,
    vault,
    mode,
    previousMode,
    effectiveMode: overriddenBy === 'alsoLocked' ? 'locked' : overriddenBy === 'alsoWritable' ? 'writable' : mode,
    overriddenBy,
    message:
      `"${shown}" is now ${MODE_WORDS[mode]} as a secondary of this workspace`
      + (previousMode === mode ? ' (unchanged).' : ` (was: ${previousMode}).`)
      + (overriddenBy
        ? ` NOTE: config.json's global \`${overriddenBy}\` list also names this vault and takes precedence — the mode in force is "${overriddenBy === 'alsoLocked' ? 'locked' : 'writable'}" until that list is edited by hand.`
        : '')
      + ' Recorded in your own router config, for this workspace only.',
  };
}
