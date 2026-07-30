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

// ---------------------------------------------------------------------------
// Dotenv autoload
// ---------------------------------------------------------------------------

/**
 * Load `<cwd>/.env` into process.env with standard dotenv semantics:
 * file values fill only UNSET keys (process.env always wins). Never
 * throws — silent no-op if the file doesn't exist or can't be parsed.
 *
 * Minimal parser supports: KEY=VALUE, # comments, optional `export `
 * prefix, optional surrounding double or single quotes. No
 * interpolation, no multi-line, no escaped quote support.
 *
 * Hooks call this once at startup before reading any
 * `process.env.OBSIDIAN_ROUTER_*` so workspace-scoped variables (notably
 * `OBSIDIAN_ROUTER_DEFAULT_VAULT` from `setup-vault.mjs --link-workspace`)
 * are honored even though hooks run as separate subprocesses that don't
 * inherit dotenv loading from the router binary.
 */
export function loadWorkspaceDotenv(cwd) {
  const envPath = path.join(cwd, '.env');
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env — nothing to do
  }
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
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
 * Slug derivation matching the router's `defaultNameFromPath` in
 * `src/registry.mjs` AND the inline copy in `scripts/setup-vault.mjs`.
 * Duplicated here so hooks can resolve slugs without importing the full
 * router code (keeps hook startup latency low and avoids hook-vs-src
 * version-skew issues in dev checkouts).
 *
 * TODO: extract to src/helpers/vault-slug.mjs once the 4 copies become
 * burdensome. For now, the convention is "if you change one, change all
 * — and add a regression test".
 */
export function defaultNameFromPath(p) {
  if (!p || typeof p !== 'string') return '';
  const isWindows = /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
  const base = (isWindows ? path.win32 : path.posix).basename(p);
  return base.replace(/^\./, '').toLowerCase();
}

/**
 * Given a router config and a slug, return the absolute vault path or
 * null. Matches the slug against `vaultNames[<path>]` if set, otherwise
 * falls back to `defaultNameFromPath(<path>)`. Case-insensitive on the
 * slug side (Windows/macOS friendly).
 */
export function resolveVaultBySlug(cfg, slug) {
  if (!cfg || !slug) return null;
  const target = String(slug).trim().toLowerCase();
  if (!target) return null;
  const vaultNames = cfg.vaultNames || {};
  const paths = Object.keys(cfg.portRegistry || {});
  for (const vp of paths) {
    const candidate = (vaultNames[vp] || defaultNameFromPath(vp)).toLowerCase();
    if (candidate === target) return vp;
  }
  return null;
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
 * possible failure mode for a rename. `context.legacyScaffold` carries the
 * old path so callers can surface `scaffoldMigrationHint()`.
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
