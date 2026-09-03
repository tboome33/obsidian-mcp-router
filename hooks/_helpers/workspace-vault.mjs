/**
 * Shared helpers used by multiple hooks (`hot-cache-load`,
 * `wiki-query-first-nudge`, future). Extracted to a single module to
 * avoid 3+ copies of the same code:
 *   - dotenv autoload (workspace `.env` → process.env, file values fill
 *     only UNSET keys, never throws)
 *   - router config loader (respects OBSIDIAN_ROUTER_CONFIG env)
 *   - slug → vault path resolver (matches the router's own logic)
 *   - vault context detector (cwd-is-vault OR workspace-bound)
 *
 * Zero *installed* deps (so hooks work even pre-`npm install` in fresh
 * checkouts): the one src/ import below, `wiki-meta-scaffolds.mjs`, is a
 * constants module that itself imports nothing — not even a node builtin —
 * so it loads on a tree with no `node_modules`. Pure functions where
 * possible — I/O isolated to the `loadWorkspaceDotenv` / `readRouterConfig`
 * boundaries.
 *
 * Used by:
 *   - hooks/wiki-query-first-nudge.mjs (v0.11.5+)
 *   - hooks/hot-cache-load.mjs (v0.11.6+)
 *
 * Naming: `workspace-vault.mjs` because the central abstraction here is
 * "which Obsidian vault is associated with the current workspace?".
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveScaffold } from '../../src/helpers/wiki-meta-scaffolds.mjs';
import { applyWorkspaceDotenv } from '../../src/helpers/workspace-dotenv.mjs';
import { readBinding, authoritativeDefaultVault } from '../../src/helpers/workspace-bindings.mjs';
import {
  defaultNameFromPath,
  resolveVaultBySlug,
  registeredVaultPaths,
  disabledVaultEntries,
  vaultSlug,
} from '../../src/helpers/vault-slug.mjs';

// ---------------------------------------------------------------------------
// Dotenv autoload
// ---------------------------------------------------------------------------

/**
 * Load `<cwd>/.env` into process.env with standard dotenv semantics —
 * file values fill only UNSET keys (process.env always wins) — under the
 * workspace policy of src/helpers/workspace-dotenv.mjs: exactly the keys the
 * router's own writers put in a workspace file (OBSIDIAN_ROUTER_DEFAULT_VAULT,
 * OBSIDIAN_ROUTER_LOCKED, OBSIDIAN_ROUTER_AUTO_ENRICH, VAULT_PATH,
 * MD_ALLOWED_PATHS, MD_SHARE_DIR) plus the enumerated OBSIDIAN_ROUTER_NO_*
 * opt-outs. Anything else — a repository's GIT_CONFIG_GLOBAL, a NODE_OPTIONS,
 * a tool override, a host setting such as OBSIDIAN_ROUTER_CONFIG — is
 * ignored, and ignored SILENTLY here (see the function body; the router
 * binary is the one that names it). Never throws — silent no-op if the file
 * doesn't exist or can't be read.
 *
 * Hooks call this once at startup before reading any
 * `process.env.OBSIDIAN_ROUTER_*` so workspace-scoped variables (notably
 * `OBSIDIAN_ROUTER_DEFAULT_VAULT` from `setup-vault.mjs --link-workspace`)
 * are honored even though hooks run as separate subprocesses that don't
 * inherit dotenv loading from the router binary.
 */
export function loadWorkspaceDotenv(cwd) {
  // Silent on purpose: a hook's stderr is the message Claude reads when the
  // hook blocks (exit 2), and a line about ignored .env keys in front of the
  // real reason would be read as an instruction. The router binary warns.
  return applyWorkspaceDotenv({ cwd, warn: () => {} });
}

// ---------------------------------------------------------------------------
// Router config
// ---------------------------------------------------------------------------

/**
 * Resolve the active router config path (respects OBSIDIAN_ROUTER_CONFIG
 * env var, falls back to `~/.claude/obsidian-mcp-router/config.json`).
 */
export function routerConfigPath() {
  if (process.env.OBSIDIAN_ROUTER_CONFIG) {
    return path.resolve(process.env.OBSIDIAN_ROUTER_CONFIG);
  }
  return path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
}

/**
 * Read + parse the router config. Returns the parsed object or null on
 * any I/O / parse error. Never throws.
 */
export function readRouterConfig() {
  try {
    return JSON.parse(fs.readFileSync(routerConfigPath(), 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Slug ↔ path resolution
// ---------------------------------------------------------------------------

/**
 * Slug derivation and slug → path resolution both moved to
 * `src/helpers/vault-slug.mjs` in v0.90.0 — the TODO that stood here asking
 * for exactly that is now done.
 *
 * The TODO said "4 copies"; there were six, and the two other TODOs saying so
 * each said three. That drift is the argument: the shared module is now the
 * only place either function exists, so there is no count left to keep
 * accurate. It also type-checks the `vaultNames` value, which is what the
 * inline `(vaultNames[vp] || …).toLowerCase()` below used to get wrong — a
 * non-string in the config threw a TypeError out of a hook that promises to
 * exit 0 whatever it finds.
 *
 * Re-exported rather than merely imported: `detectVaultContext` below is not
 * the only caller — the hooks and their tests import both names FROM here,
 * and this module stays their single entry point.
 *
 * The dependency floor is unchanged: `vault-slug.mjs` imports `node:path` and
 * `vault-path-identity.mjs`, which imports `node:path` and nothing else. Hooks
 * still load on a checkout with no `node_modules`.
 */
export { defaultNameFromPath, resolveVaultBySlug };

/**
 * The vault names this machine has registered, as far as a HOOK can know.
 *
 * Built from the two sources that live in the config file — `portRegistry`
 * (local vaults) and `remoteVaults` — minus whatever `disabledVaults` hides,
 * which it may name either by vault name or by registry path (the registry
 * accepts both, and so does this).
 *
 * DELIBERATELY SHORT OF THE REGISTRY, and the caller must treat it that way.
 * `src/registry.mjs` has a third source, `VAULT_*` environment entries, and a
 * whitelist (`OBSIDIAN_ROUTER_ALLOWED_VAULTS`) that can narrow the result.
 * Both belong to the served/multi-tenant deployment, which the accepted
 * decision puts out of this lot's scope, and both are parsed by code that
 * pulls in the router's dependencies — which a hook may not do (hooks run on
 * checkouts that have never seen `npm install`). So this answers "does this
 * machine have vaults, and is this name one of them?" and must never be used
 * to publish a count: a census that is quietly short still reads as
 * authoritative. `list_vaults` is the authority.
 *
 * @param {object|null} cfg the parsed router config
 * @returns {Set<string>} vault names, lowercased for comparison
 */
export function registeredVaultNames(cfg) {
  const out = new Set();
  if (!cfg || typeof cfg !== 'object') return out;

  // EVERY TYPE CHECK HERE USED TO BE WRITTEN OUT BY HAND, and each one was a
  // bug found separately: `vaultNames[vp]` called `.toLowerCase()` on a number
  // and threw out of a hook that promises to exit 0; `Object.keys` on a
  // `portRegistry` that was a string or an array manufactured a vault called
  // "0"; the `disabledVaults` container was guarded here but not in five other
  // readers. The `vaultNames` sweep turned all three into one boundary, so
  // this function now asks the helper instead of re-deriving the answer —
  // which is also what keeps it out of that sweep's scan guard.
  const disabled = new Set(disabledVaultEntries(cfg).map((d) => d.toLowerCase()));
  for (const vp of registeredVaultPaths(cfg)) {
    const name = vaultSlug(cfg, vp).toLowerCase();
    if (!name || disabled.has(name) || disabled.has(String(vp).toLowerCase())) continue;
    out.add(name);
  }
  for (const r of Array.isArray(cfg.remoteVaults) ? cfg.remoteVaults : []) {
    const name = typeof r?.name === 'string' ? r.name.trim().toLowerCase() : '';
    if (!name || disabled.has(name)) continue;
    out.add(name);
  }
  return out;
}

/**
 * Is `name` a vault this machine currently serves — registered, and not hidden
 * by `disabledVaults`?
 *
 * The hooks' equivalent of the registry's `isActive`, and it exists so a
 * BINDING can be checked the same way the cascade checks one. The cascade
 * lets a binding whose vault was disabled or removed fall through rather than
 * bricking the session; two hook resolvers took `binding.vault`
 * unconditionally, so the server acted on one vault while journaling,
 * autocommit and recall acted on another. Found by the Codex review of the
 * merge, 2026-09-03.
 *
 * Inherits `registeredVaultNames`'s limits, deliberately: a hook cannot see
 * `VAULT_*` entries or the allowed-vaults whitelist, so a binding to one of
 * those reads as inactive here. That errs toward the hooks doing nothing
 * rather than toward them writing into a vault they guessed at.
 *
 * @param {object|null} cfg
 * @param {string} name
 * @returns {boolean}
 */
export function bindingIsActive(cfg, name) {
  if (typeof name !== 'string' || !name) return false;
  return registeredVaultNames(cfg).has(name.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Dual-mode vault context detection (cwd-is-vault OR workspace-bound)
// ---------------------------------------------------------------------------

/**
 * Detect the vault context for a given cwd. Returns one of:
 *   - { mode: 'cwd-is-vault', vaultPath: <cwd> }
 *     when `cwd/wiki-meta/catalog.md` exists (the workspace IS the vault)
 *   - { mode: 'workspace-bound', vaultPath, slug }
 *     when cwd has no catalog BUT `OBSIDIAN_ROUTER_DEFAULT_VAULT`
 *     resolves to a configured vault whose catalog exists
 *   - null
 *     when neither condition holds
 *
 * Caller is expected to have loaded the workspace `.env` first (via
 * `loadWorkspaceDotenv(cwd)`) so the env var lookup honors workspace
 * config.
 *
 * Why both modes share return shape: callers can switch on
 * `mode` for nudge-text differences while reading `vaultPath` uniformly
 * for filesystem reads (e.g. `<vaultPath>/wiki-meta/hot.md`).
 *
 * v0.12.0: switched the scaffold-detection probe from `wiki/index.md`
 * to `wiki-meta/index.md`. The 4 canonical scaffolds (hot, index, log,
 * overview) now live in `wiki-meta/` separate from user content under
 * `wiki/`. Clean break — no fallback to the old layout. Vaults still
 * on `wiki/<scaffold>.md` need migration via `setup-vault.mjs
 * --migrate-wiki-meta` (shipped in v0.12.1).
 *
 * v0.58.0: the probe is `wiki-meta/catalog.md`, with `wiki-meta/index.md`
 * accepted as a fallback. Unlike v0.12.0 this one is NOT a clean break:
 * the plugin updates independently of the vaults it reads, and a failed
 * probe silently disables every workspace-bound hook — the most expensive
 * possible failure mode for a rename.
 *
 * `context.legacyScaffold` reports which name the CATALOG was found under —
 * informational, for diagnostics and for callers that only care about vault
 * detection. It says nothing about the JOURNAL: the two slots can disagree on
 * a half-migrated vault, so a caller that names the journal must resolve that
 * slot itself (`resolveScaffold(vaultPath, 'journal', …)`) rather than infer
 * it from this field.
 */
export function detectVaultContext(cwd, cfg) {
  // THE CONFIRMED BINDING IS CONSULTED BEFORE ANYTHING ELSE — even before
  // asking whether the cwd is itself a vault. Round 2 of the Codex review
  // (2026-09-03): the first version returned `cwd-is-vault` first, so a
  // workspace that carries its own catalog but is explicitly bound to another
  // vault had the SERVER defaulting to the binding while every hook — hot
  // cache, decision recall, journaling, autocommit — acted on the cwd. Two
  // answers to "which vault is this session's", from one config. The binding
  // is the user's explicit act and outranks an inference from the directory
  // layout, in the hooks exactly as in the cascade's tier 0.
  // A BINDING TO A VAULT THAT IS NOT ACTIVE IS NOT A BINDING. The cascade
  // checks every tier against the active set — a binding whose vault was
  // disabled or removed falls through there rather than bricking the session
  // — and these hooks must agree with it, or the server acts on one vault
  // while journaling, autocommit and recall act on another. Found by the
  // Codex review of the merge, 2026-09-03: the two hook resolvers took
  // `binding.vault` unconditionally.
  const bindingRaw = cfg ? readBinding(cfg, cwd) : null;
  const binding = bindingRaw && bindingIsActive(cfg, bindingRaw.vault) ? bindingRaw : null;

  // Mode 1: cwd is the vault itself — unless a binding says otherwise.
  const local = binding ? null : resolveScaffold(cwd, 'catalog', { fs, path });
  if (local) {
    return {
      mode: 'cwd-is-vault',
      vaultPath: cwd,
      slug: null,
      legacyScaffold: local.legacy ? local.relPath : null,
    };
  }
  if (!cfg) return null;

  // Mode 2: workspace-bound.
  //
  // TWO SOURCES, IN THIS ORDER, and the order is the accepted decision
  // `liaison-workspace-vault-hors-depot` rather than a preference:
  //
  //   (a) the CONFIRMED BINDING in the user's own config, for this exact
  //       workspace path. The only source that cannot have arrived with a
  //       `git clone`.
  //   (b) `OBSIDIAN_ROUTER_DEFAULT_VAULT` **only when it may decide** —
  //       `authoritativeDefaultVault` returns null for a value the loader
  //       recorded taking from this project's own `.env`.
  //
  // Before the Codex review of 2026-09-03 this function read the variable
  // directly, whatever had set it. That made every workspace-bound hook —
  // hot-cache injection, decision recall, session journaling, autocommit —
  // redirectable by a cloned repository's `.env`, INDEPENDENTLY of the
  // resolution cascade. Fixing only the cascade would have read as closed
  // while three of the four doors stayed open.
  const slug = binding?.vault || authoritativeDefaultVault();
  if (!slug) return null;
  const vp = resolveVaultBySlug(cfg, slug);
  if (!vp) return null;
  const bound = resolveScaffold(vp, 'catalog', { fs, path });
  if (!bound) return null;
  return {
    mode: 'workspace-bound',
    vaultPath: vp,
    slug,
    boundBy: binding ? 'binding' : 'host',
    legacyScaffold: bound.legacy ? bound.relPath : null,
  };
}
