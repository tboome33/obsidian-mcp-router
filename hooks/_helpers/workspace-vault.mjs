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
import { defaultNameFromPath, resolveVaultBySlug } from '../../src/helpers/vault-slug.mjs';

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
  // Mode 1: cwd is the vault itself
  const local = resolveScaffold(cwd, 'catalog', { fs, path });
  if (local) {
    return {
      mode: 'cwd-is-vault',
      vaultPath: cwd,
      slug: null,
      legacyScaffold: local.legacy ? local.relPath : null,
    };
  }
  // Mode 2: workspace-bound via env var
  const slug = (process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT || '').trim();
  if (!slug || !cfg) return null;
  const vp = resolveVaultBySlug(cfg, slug);
  if (!vp) return null;
  const bound = resolveScaffold(vp, 'catalog', { fs, path });
  if (!bound) return null;
  return {
    mode: 'workspace-bound',
    vaultPath: vp,
    slug,
    legacyScaffold: bound.legacy ? bound.relPath : null,
  };
}
