/**
 * WHICH vaults a workspace may even NAME, and WHAT it may do to a secondary
 * one — the two orthogonal guards of decision `portee-et-mode-ecriture-des-
 * vaults` (accepted 2026-09-04), factored into ONE module so both land at
 * `resolveVault()`'s single point of passage rather than being re-derived at
 * each of the ~26 call sites that resolve a vault. This is the same shape as
 * `helpers/vault-path-guard.mjs`: one definition, imported everywhere a
 * decision has to be made, plus a test that scans for anyone re-deriving it.
 *
 * Both guards are HYGIENE, not access control (the decision page's own
 * words): they stop an inadvertent cross-project write or a session that
 * drifted onto the wrong vault, not a determined actor — anyone with disk or
 * config access can already read any vault regardless. Neither function here
 * throws; the callers (`resolveVault`, the CallTool dispatcher, `list_vaults`)
 * decide what a `false`/tier answer means for them.
 *
 * ---------------------------------------------------------------------------
 * REACHABILITY (`vaultReach` / `openVaults`)
 * ---------------------------------------------------------------------------
 * Absent `vaultReach: "declared"`, every registered vault is reachable from
 * every workspace — today's behaviour, unchanged. Once active, a vault is
 * reachable only if:
 *   - it is listed in `openVaults` (the escape valve — without it, activating
 *     the switch would cut the Desktop chat, which starts with no workspace
 *     and so can never declare a binding, from every vault); OR
 *   - the CURRENT workspace's binding names it, as `vault` (primary) or
 *     inside `also` (secondary).
 *
 * `registry.workspaceBinding` is read LIVE (never cached on the vault object)
 * because it can change mid-session — `confirm_workspace_binding` mutates it
 * in place on the same registry object every handler already receives (see
 * that tool's own file). Baking a `reachable` flag onto each vault at load
 * time would go stale the moment a binding changes without a config reload.
 *
 * ---------------------------------------------------------------------------
 * THE THREE WRITE TIERS FOR A SECONDARY (`also`) VAULT
 * ---------------------------------------------------------------------------
 * Only applies to a vault the CURRENT workspace's binding lists in `also` —
 * never to the binding's own `vault` (primary, always read-write), and never
 * to a vault reached some other way (no binding at all, or via `openVaults`
 * outside of any binding) — the decision's own scope is explicitly "a
 * secondary vault... within a liaison already established", not every vault a
 * session can merely name.
 *
 * The tier is declared PER WORKSPACE, on the binding record itself
 * (`alsoLocked`/`alsoWritable` beside `also`, written by
 * `set_secondary_vault_mode` — the "paramétrons les vaults secondaires"
 * conversation), so one reference base can be strict in a project that only
 * consults it and read-write in another. The global config lists of the
 * same names, which the decision page first described, still work and are
 * read as well; see `alsoWriteTierFor` for the precedence (locked anywhere
 * wins).
 *
 *   - `alsoWritable` — direct write, no friction.
 *   - `alsoLocked`   — refused UNCONDITIONALLY for the SECONDARY role. No
 *     write parameter can lift this; only editing config.json removes a
 *     vault from the list. This is what makes "never, no exceptions" actually
 *     true rather than a description of what the model is supposed to do.
 *     The list is global but the ROLE is per binding — the decision keeps
 *     the same base read-write in the workspace that maintains it, which
 *     declares it as PRIMARY from the start. Review round 3 found the one
 *     conversational way out: PROMOTING a locked secondary to primary from
 *     inside the workspace that declared it as secondary — through
 *     `confirm_workspace_binding({ vault })` or `lock_vault({ persist })`,
 *     which rewrites the binding with the locked vault as primary. Both
 *     now refuse while the vault is a locked secondary of the live binding
 *     (`isPromotionOfLockedSecondary`). Clearing the binding first and
 *     re-binding is still possible — two explicit, announced acts, which is
 *     what hygiene against inadvertence asks for, not access control.
 *   - neither list (the default for an `also` vault) — SOFT read-only:
 *     refused unless the caller passes an explicit confirmation, which the
 *     tool's own description instructs it to obtain from the user in
 *     conversation FIRST. The decision names MCP elicitation
 *     (`elicitation/create`) as the preferred way to obtain that consent
 *     deterministically, with the plain conversational round-trip as the
 *     SYSTEMATIC fallback — measured (about thirty open tickets across MCP
 *     hosts) to be needed far more often than the exception. Wiring the
 *     protocol-level elicitation call itself is item 15 of the roadmap
 *     (portee-ergonomie-refus-roadmap), deliberately deferred: the decision
 *     asks for its reliability to be MEASURED on this project's own host
 *     before anything depends on it, not assumed. The conversational path
 *     implemented here is not a placeholder for that — the decision requires
 *     it to keep working even where elicitation is announced and silently
 *     never honoured, so it has to exist regardless of what item 15 finds.
 */

import fs from 'node:fs';
import path from 'node:path';
import { boundVaults } from './workspace-bindings.mjs';
import { normalizePathForCompare, stripExtendedPathPrefix } from './vault-path-identity.mjs';
import { alsoLockedEntries } from './vault-slug.mjs';
import { identifierForCall } from './sanitize.mjs';

/**
 * The `confirmSecondaryWrite` schema property, shared BY IDENTITY across
 * every write tool's `inputSchema` (src/index.mjs, plus the five tool
 * definitions that live in their own files — build-wiki-graph.mjs,
 * build-search-index.mjs, source-ledger.mjs, write-bundle.mjs,
 * refresh-okf-projections.mjs) rather than repeated as a literal ~13 times,
 * so its wording — and the field name itself — cannot drift the way
 * `open`/`gitInit`/etc. once did between plan_vault and provision_vault
 * before those were unified onto one seal. `assertVaultWritable` below
 * ignores it entirely unless the resolved target is actually a soft-tier
 * secondary of the CURRENT workspace's binding — safe to pass on every call,
 * not just the ones that need it.
 */
export const CONFIRM_SECONDARY_WRITE_PROP = {
  type: 'boolean',
  description:
    'Set to true ONLY after telling the user which SECONDARY vault (an `also` of this workspace\'s '
    + 'binding, never its primary) you want to write to, and getting their explicit go-ahead in THIS '
    + 'conversation. Ignored unless the resolved target is a soft-tier secondary vault (in `also`, not '
    + 'in `alsoWritable` or `alsoLocked`) of the current workspace binding — never set it speculatively.',
};

/**
 * Is `vaultName` reachable from THIS session, given the live `registry`?
 *
 * @param {string} vaultName
 * @param {{ vaultReach?: string|null, openVaults?: string[], workspaceBinding?: { vault?: string, also?: string[] }|null }} registry
 * @returns {boolean}
 */
export function isVaultReachable(vaultName, registry) {
  if (!registry || registry.vaultReach !== 'declared') return true;
  const openVaults = Array.isArray(registry.openVaults) ? registry.openVaults : [];
  if (openVaults.includes(vaultName)) return true;
  if (!registry.workspaceBinding) return false;
  // `boundVaults()` (helpers/workspace-bindings.mjs) is the one place that
  // already answers "every vault this workspace is bound to" — reusing it
  // rather than re-deriving `[binding.vault, ...binding.also]` here means a
  // future change to binding shape or semantics can't make the two disagree.
  return boundVaults(registry.workspaceBinding).includes(vaultName);
}

/**
 * The registered LOCAL vault whose folder contains `fsPath`, or null.
 *
 * A vault is reached over REST by NAME everywhere in this router except one
 * door: a tool that writes to a caller-named directory on the local disk
 * (`download_page_assets`' `outputDir`). When that directory is inside a
 * vault's folder, it is a write to that vault, and the two guards of this
 * module apply to it by the vault's name. Compared through the same
 * normalisation the registry uses to tell two spellings of one vault apart
 * (Windows case folded, trailing separators stripped), on the RESOLVED path,
 * so `..` segments cannot step out of a folder they appear to be under.
 *
 * @param {unknown} fsPath
 * @param {{ vaults?: Array<{ name: string, path?: string }> }} registry
 * @returns {object|null} the vault entry, or null when no registered vault contains the path
 */
export function vaultContainingPath(fsPath, registry) {
  if (typeof fsPath !== 'string' || fsPath.trim() === '') return null;
  const child = normalizePathForCompare(realOrResolved(fsPath));
  const vaults = registry && Array.isArray(registry.vaults) ? registry.vaults : [];
  for (const v of vaults) {
    if (!v || typeof v.path !== 'string' || v.path === '') continue;
    const root = normalizePathForCompare(realOrResolved(v.path));
    if (child === root || child.startsWith(`${root}\\`) || child.startsWith(`${root}/`)) return v;
  }
  return null;
}

/**
 * The path as the FILESYSTEM knows it, when it exists; `path.resolve` alone
 * when it does not (an `outputDir` the tool is about to create). A purely
 * lexical containment test was escaped by a junction into the vault, by the
 * `\\?\` long-path prefix, and by an 8.3 short name — all spellings of a
 * directory inside the vault that do not start with the vault's own spelling.
 * `realpathSync.native` resolves the three when the path is real; the prefix
 * is stripped either way. What this still does not see is named in the
 * header (a `remoteVaults` entry for a local vault has no `path` at all).
 * (Fable 5.1 round, verifying the gate's assumptions about existing code.)
 */
function realOrResolved(p) {
  // The extended-length prefix is folded by the shared helper, not stripped
  // here: `\\?\UNC\server\share\x` has to become `\\server\share\x`, and
  // the blind four-character strip this used to do made it the RELATIVE
  // path `UNC\server\share\x` (Codex, round on 1fad78c — same defect in the
  // dotenv writer's lock key, fixed in the one place both import).
  const resolved = path.resolve(stripExtendedPathPrefix(String(p)));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The write tier `vaultName` falls under, for the CURRENT workspace's
 * binding — or `null` when the also-tier gate does not apply at all: no
 * binding, the vault is the binding's own PRIMARY, or the vault is not
 * something this binding declared as a secondary in the first place (reached
 * some other way — e.g. `openVaults` outside any binding, or, when
 * `vaultReach` is inactive, simply named directly).
 *
 * @param {string} vaultName
 * @param {{ alsoWritable?: string[], alsoLocked?: string[], workspaceBinding?: { vault?: string, also?: string[], alsoLocked?: string[], alsoWritable?: string[] }|null }} registry
 * @returns {'writable'|'locked'|'soft'|null}
 */
export function alsoWriteTierFor(vaultName, registry) {
  const binding = registry && registry.workspaceBinding;
  if (!binding) return null;
  if (binding.vault === vaultName) return null;
  const also = Array.isArray(binding.also) ? binding.also : [];
  if (!also.includes(vaultName)) return null;
  // TWO PLACES CAN DECLARE A TIER, and the hard tier wins wherever it is
  // declared. The BINDING's own lists (`alsoLocked`/`alsoWritable` on the
  // binding record — what `set_secondary_vault_mode` writes, per workspace,
  // so the same vault can be strict in one project and read-write in
  // another) and the GLOBAL config lists the decision first described
  // (hand-edited, one answer for every workspace). Locked anywhere → locked;
  // otherwise writable anywhere → writable; otherwise soft, the default.
  const has = (list) => Array.isArray(list) && list.includes(vaultName);
  if (has(binding.alsoLocked) || has(registry.alsoLocked)) return 'locked';
  if (has(binding.alsoWritable) || has(registry.alsoWritable)) return 'writable';
  return 'soft';
}

/**
 * Would binding this workspace to `vaultName` as its PRIMARY promote a vault
 * that the LIVE binding currently declares as an `alsoLocked` SECONDARY?
 *
 * The one conversational way past the hard tier that review round 3 found:
 * `alsoWriteTierFor` returns null for a primary, so any tool that rewrites
 * the binding with the locked vault on top — `confirm_workspace_binding`,
 * `lock_vault` with `persist` (which records the locked vault as primary,
 * see tools/lock.mjs `recordLockInBinding`) — lifted "no exceptions" in one
 * call. Both call this before touching the binding. A workspace with no
 * binding, or one where the vault is not a secondary, is never affected: it
 * is not promoting anything.
 *
 * @param {string} vaultName
 * @param {object} registry the live registry
 * @returns {boolean}
 */
export function isPromotionOfLockedSecondary(vaultName, registry) {
  return alsoWriteTierFor(vaultName, registry) === 'locked';
}

/**
 * The SAME question, asked of the config file as it is INSIDE the config
 * lock — the binding record the writer has just re-read, and the file's own
 * global `alsoLocked` list — rather than of the live registry.
 *
 * Both writers that can promote a secondary (`confirm_workspace_binding`,
 * `lock_vault` with `persist`) asked `isPromotionOfLockedSecondary` of the
 * live registry BEFORE taking the lock, then re-read the file inside it and
 * rewrote the binding from that fresh copy — so a tier another process had
 * recorded in between (a sibling session running `set_secondary_vault_mode`;
 * under `--no-watch` the live copy never learns) was read fresh, filtered
 * away as "no longer a secondary", and the vault came out primary. The
 * preflight is kept for the message it gives early; this is the check that
 * decides. Found by the Codex round on fd9e1cd — the same
 * decide-outside-apply-inside shape the merge review had called a BLOCKER,
 * one field over from where round 3 added the preflight.
 *
 * @param {string} vaultName
 * @param {object|null} binding the workspace's binding as `readBinding(cfg, cwd)` returns it inside the lock
 * @param {object} cfg the config as handed to the `updateConfigBindings` transform
 * @returns {boolean}
 */
export function isPromotionOfLockedSecondaryOnDisk(vaultName, binding, cfg) {
  return isPromotionOfLockedSecondary(vaultName, {
    workspaceBinding: binding,
    alsoLocked: alsoLockedEntries(cfg),
    alsoWritable: [],
  });
}

/**
 * The error code carried by a promotion refusal, so that a caller which
 * swallows every other failure of a best-effort config write (`lock_vault`'s
 * `recordLockInBinding` returns `null` for "the config could not be written")
 * can let THIS one out: a refused promotion is not a write that failed, it is
 * a write that must not happen, and reporting it as "fix the config
 * permissions" would send the user to repair a file that is fine.
 */
export const PROMOTION_REFUSED_CODE = 'ERR_PROMOTION_OF_LOCKED_SECONDARY';

/**
 * @param {string} message the tool's own sentence, naming the vault and the way out
 * @returns {Error & { code: string }}
 */
export function lockedSecondaryPromotionError(message) {
  return Object.assign(new Error(message), { code: PROMOTION_REFUSED_CODE });
}

/**
 * Refuse a write `vault` cannot accept from THIS workspace, given whether the
 * caller already asserted it obtained the user's explicit go-ahead for a
 * soft-tier vault. Silent (no throw) for a primary vault, an `alsoWritable`
 * one, or a confirmed soft-tier one.
 *
 * @param {{ name: string }} vault a resolved vault object (registry.resolveVault's return)
 * @param {object} registry the live registry
 * @param {{ confirmed?: boolean, toolName?: string }} [opts]
 */
export function assertVaultWritable(vault, registry, { confirmed = false, toolName } = {}) {
  const tier = alsoWriteTierFor(vault.name, registry);
  if (tier === null || tier === 'writable') return;
  const tool = toolName ? `\`${toolName}\`` : 'this tool';
  if (tier === 'locked') {
    // THE LIMIT, STATED IN THE MESSAGE ITSELF (review round 3): this tier is
    // about the SECONDARY role. The decision keeps the same base read-write
    // in the workspace that maintains it, so `alsoLocked` cannot forbid a
    // workspace from binding the vault as its PRIMARY — and re-binding
    // (`confirm_workspace_binding`, or `lock_vault` with `persist`) is an
    // explicit, announced act, not a write parameter. Saying "nothing in
    // conversation can lift this" was therefore false, and a false absolute
    // in a refusal is the kind of text the sixth v0.90.0 review hunted.
    throw new Error(
      `Vault "${vault.name}" is locked read-only as a SECONDARY vault of this workspace `
      + '(listed in `alsoLocked`). No parameter passed in conversation can override this — '
      + 'confirmSecondaryWrite is ignored here, and re-binding or persistently locking this workspace '
      + 'onto that vault to make it the primary is refused while it is listed. Only editing '
      + '`alsoLocked` in config.json lifts it. (A workspace that MAINTAINS that vault declares it as '
      + 'its primary from the start; this one declared it as a secondary.)',
    );
  }
  // tier === 'soft' — the one tier a caller CAN pass through, by asserting
  // (via `confirmed`) that it already obtained the user's explicit go-ahead.
  if (confirmed) return;
  // THE REFUSAL NAMES EVERY WAY OUT, not just the per-write one. The per-write
  // override answers "let me write this once"; a user who never wanted the
  // friction for this vault at all is asking a different question, and the
  // release notes promise this message answers it too — a promise the message
  // did not keep. (Codex, round on da6a371.) The standing remedies come second,
  // because the per-write one is what the caller should reach for by default.
  throw new Error(
    `Vault "${vault.name}" is a SECONDARY vault of this workspace and read-only by default `
    + '(not in `alsoWritable` or `alsoLocked`). Tell the user which vault and what you want to '
    + `write, get their explicit go-ahead in the conversation, then retry ${tool} with `
    + 'confirmSecondaryWrite: true. Do not set that flag without having actually asked. '
    + 'If the user would rather stop being asked for this vault, the standing answers are '
    + `set_secondary_vault_mode({ vault: ${identifierForCall(vault.name)}, mode: "writable" }) for this `
    + 'workspace, or adding it to the `alsoWritable` list in config.json for every workspace — '
    + 'both are their call, never yours to make on their behalf.',
  );
}
