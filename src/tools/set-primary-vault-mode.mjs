/**
 * set_primary_vault_mode — record, for THIS workspace, the write tier of its
 * PRIMARY vault.
 *
 * Asked for by Roland on 2026-10-25, from the vault panel: the secondaries
 * have their three tiers (`set_secondary_vault_mode`), and the primary — which
 * the first decision (`portee-et-mode-ecriture-des-vaults` §2) made "always
 * read-write" — could be given none. The decision stands as the DEFAULT: a
 * primary nobody qualified stays read-write, no friction. What changes is that
 * the user may now NARROW it, per workspace, with the same three words:
 *
 *   - `locked`   — lecture seule stricte : every write is refused,
 *                  `confirmSecondaryWrite` is ignored.
 *   - `soft`     — lecture seule, écriture sur accord : refused unless the
 *                  write carries `confirmSecondaryWrite: true`, which the
 *                  model may set only after asking the user.
 *   - `writable` — lecture-écriture automatique : the default, no friction
 *                  (recording it REMOVES the restriction from the binding).
 *
 * WHERE THE ANSWER LIVES — on the binding record of this workspace, as
 * `primaryTier: { vault, mode }`, through `updateConfigBindings` (the one
 * writer of that section, with its inter-process lock and atomic write). The
 * tier carries the NAME of the vault it qualifies: re-binding the workspace to
 * another primary leaves it naming a vault that is no longer the primary, and
 * it simply stops applying — no writer has to remember to clear it.
 *
 * WHAT IT WILL NOT DO
 *   - Qualify a secondary (that is `set_secondary_vault_mode`), or bind
 *     anything.
 *   - Run on a gated deployment (OBSIDIAN_ROUTER_READONLY / ALLOWED_VAULTS /
 *     USER_ID): one caller's answer would stand for every tenant.
 *   - Rewrite a binding the router had to repair to read — same refusal, same
 *     renderer as the secondaries' tool.
 *
 * Like its sibling, a relaxation ("writable", "soft" after "locked") is the
 * user's call, never the model's: the description says so.
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
  rawBindingEntry,
  bindingIncoherences,
  registryIncoherences,
  registryFactsFor,
  describeBindingRepair,
  BINDING_REPAIR_REQUIRED_CODE,
  PRIMARY_MODES,
} from '../helpers/workspace-bindings.mjs';
import { isGatedDeployment, gatedDeploymentRefusal } from '../helpers/workspace-dotenv.mjs';

export const TOOL_NAME = 'set_primary_vault_mode';

const MODE_WORDS = Object.freeze({
  locked: 'read-only, strict (no override)',
  soft: 'read-only, with a per-write override once the user has said yes in the conversation',
  writable: 'read-write, no friction',
});

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Record, for the CURRENT workspace, the write tier of its PRIMARY vault (see list_vaults → workspaceBinding.vault). '
    + 'Three modes: "locked" = read-only, strict — every write to the primary is refused and confirmSecondaryWrite is '
    + 'ignored; "soft" = read-only with a per-write override — a write is refused unless it carries '
    + 'confirmSecondaryWrite: true, which you may set ONLY after asking the user and getting their explicit yes; '
    + '"writable" = read-write, no friction (the default of a primary nobody qualified — recording it removes the '
    + 'restriction). Recorded on this workspace\'s binding in the user\'s own router config, so the same vault can be '
    + 'strict in one project and writable in another; it applies to THAT vault only and stops applying if the '
    + 'workspace is re-bound to another primary. Changing the tier is the USER\'s call, in both directions — '
    + 'never loosen it on your own initiative. It never qualifies a secondary (use set_secondary_vault_mode) and never '
    + 'binds anything. Not available on a gated deployment (OBSIDIAN_ROUTER_READONLY / ALLOWED_VAULTS / USER_ID): '
    + 'the workspace there is the server\'s own directory, shared by every caller.',
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'The primary vault of this workspace — list_vaults → workspaceBinding.vault.',
      },
      mode: {
        type: 'string',
        enum: [...PRIMARY_MODES],
        description: '"locked" | "soft" | "writable" — see the tool description for what each means.',
      },
    },
    required: ['vault', 'mode'],
    additionalProperties: false,
  },
};

/**
 * Record the write tier of the primary `args.vault` for the current workspace.
 *
 * @param {object} registry the live registry — the binding is read from it and updated on it
 * @param {{ vault?: string, mode?: string }} args
 * @param {{ cwd?: string, readFile?: Function, writeFile?: Function }} [seams] test seams
 */
export async function setPrimaryVaultMode(registry, args = {}, seams = {}) {
  const {
    cwd = process.cwd(),
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    writeFile = (p, c) => writeFileAtomicSync(p, c),
  } = seams;

  const configPath = registry?.configPath;
  if (!configPath) {
    throw new Error('set_primary_vault_mode: the router has no config path — nothing to record the mode into.');
  }
  const key = canonicalWorkspaceKey(cwd);
  if (!key) {
    throw new Error('set_primary_vault_mode: no usable working directory, so there is no workspace whose primary to qualify.');
  }
  if (isGatedDeployment()) {
    throw gatedDeploymentRefusal('set_primary_vault_mode', "the primary vault's write tier");
  }

  const vault = args.vault;
  if (typeof vault !== 'string' || vault.trim() === '') {
    throw new Error('set_primary_vault_mode: `vault` is required — the primary vault of this workspace (see list_vaults → workspaceBinding.vault).');
  }
  const mode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : args.mode;
  if (!PRIMARY_MODES.includes(mode)) {
    throw new Error(
      `set_primary_vault_mode: \`mode\` must be one of ${PRIMARY_MODES.map((m) => `"${m}"`).join(', ')} `
      + `(got ${safeForMessage(JSON.stringify(args.mode), 60)}).`,
    );
  }

  const shown = safeForMessage(vault, 80);
  const io = { readFile, writeFile };
  let previousMode = null;
  let wrote = false;
  // EVERY ACCEPTANCE OR REFUSAL IS DECIDED INSIDE THE CONFIG LOCK, against the
  // file as it is — never against `registry.workspaceBinding`, which another
  // session may have overtaken (the rule `set_secondary_vault_mode` learnt in
  // its first review).
  const next = updateConfigBindings(configPath, (cfg) => {
    const existing = readBinding(cfg, cwd);
    if (!existing) {
      throw new Error(
        'set_primary_vault_mode: this workspace has no binding in the router config, so it has no primary. '
        + 'Bind the workspace first: confirm_workspace_binding({ vault: <primary>, also: [...] }).',
      );
    }
    if (existing.vault !== vault) {
      const reason = existing.also.includes(vault)
        ? `"${shown}" is a SECONDARY of this workspace — its tier is set with set_secondary_vault_mode`
        : `"${shown}" is not bound to this workspace`;
      throw new Error(
        `set_primary_vault_mode: ${reason}. This workspace's primary is "${safeForMessage(existing.vault, 80)}".`,
      );
    }
    // A RESTRICTION THIS SESSION WOULD NOT ENFORCE IS NOT RECORDED. The gate
    // reads the live binding, and `primaryWriteTierFor` answers only for the
    // live primary: where the file's primary is a vault this session holds as
    // a secondary (or does not hold), recording the tier would report a
    // restriction in force while every write here still went through.
    // (Codex review, 2026-10-25.) Nothing is written; the session restarts.
    if (!registry.workspaceBinding || registry.workspaceBinding.vault !== vault) {
      throw new Error(
        `set_primary_vault_mode: "${shown}" is the primary in the config file, but THIS session's binding names `
        + `${registry.workspaceBinding ? `"${safeForMessage(String(registry.workspaceBinding.vault), 80)}"` : 'no vault'} `
        + 'as its primary (another session re-bound the workspace since this one started), so a tier recorded now '
        + 'would not be enforced here. NOTHING WAS RECORDED. Restart the session, then ask again.',
      );
    }
    previousMode = existing.primaryTier && existing.primaryTier.vault === vault ? existing.primaryTier.mode : 'writable';
    if (previousMode === mode) return cfg;
    // AN ENTRY THE ROUTER HAD TO REPAIR TO READ IS NOT REWRITTEN BY A TIER
    // CHANGE — the refusal, the renderer and the code of the secondaries' tool.
    const raw = rawBindingEntry(cfg, cwd);
    const incoherences = bindingIncoherences(raw);
    if (incoherences.length) {
      incoherences.push(...registryIncoherences(raw, registryFactsFor(cfg, registry.vaults)));
      const err = new Error(
        `set_primary_vault_mode: the mode of "${shown}" was NOT recorded and NO BINDING WAS WRITTEN. `
        + describeBindingRepair(raw, incoherences),
      );
      err.code = BINDING_REPAIR_REQUIRED_CODE;
      throw err;
    }
    wrote = true;

    return withBinding(cfg, cwd, { ...existing, primaryTier: { vault, mode } });
  }, io);

  // THE LIVE REGISTRY LEARNS WHAT THE FILE NOW SAYS, when this session holds
  // the same primary: the gate reads `registry.workspaceBinding` on every call,
  // so a restriction asked for is in force at once. A session that holds
  // ANOTHER primary (a sibling re-bound the workspace since it started) is not
  // re-routed by a tier change — it is told, below.
  const fileBinding = readBinding(next, cwd);
  // `withBinding` drops a stale refusal of any bound vault on its way through,
  // and the live copy must say what the file says (the rule every writer of
  // the binding follows).
  registry.workspaceRefusals = readRefusals(next, cwd);
  const live = registry.workspaceBinding;
  // Always true here — the transform refused otherwise — kept as the guard
  // the next reader of this block would otherwise have to prove.
  const sameLive = !!live && live.vault === vault;
  if (sameLive) {
    const { primaryTier: _drop, ...rest } = live;
    registry.workspaceBinding = fileBinding && fileBinding.primaryTier && fileBinding.primaryTier.vault === vault
      ? { ...rest, primaryTier: fileBinding.primaryTier }
      : rest;
  }
  const inForceHere = sameLive
    ? (registry.workspaceBinding.primaryTier ? registry.workspaceBinding.primaryTier.mode : 'writable')
    : null;

  return {
    workspace: key,
    vault,
    mode,
    previousMode,
    // What THIS session applies right now — `null` when its binding names another primary.
    modeInForceHere: inForceHere,
    message:
      `"${shown}" is now ${MODE_WORDS[mode]} as the PRIMARY vault of this workspace`
      + (previousMode === mode ? ' (unchanged).' : ` (was: ${previousMode}).`)
      + (inForceHere === null
        ? ' NOTE: THIS session holds another primary than the one in the config file (another session re-bound '
          + 'the workspace since it started), so the tier is NOT applied here. Restart the session before relying on it.'
        : '')
      + ' Recorded in your own router config, for this workspace only. THIS session applies it at once; '
      + 'sessions already open pick it up when they next reload the router\'s config (a restart does it at '
      + 'once). It governs the router\'s own write tools and the session journal hook — not the setup, '
      + 'provisioning and maintenance commands, nor the helpers a skill runs by itself.',
  };
}
