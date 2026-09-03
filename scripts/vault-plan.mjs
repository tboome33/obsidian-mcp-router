// Pure planning layer for the vault-creation wizard (layer 0 → layer 1 bridge).
//
// Extracted from setup-vault.mjs so it is unit-testable WITHOUT triggering that
// module's top-level CLI dispatch, and so the MCP tools (`plan_vault` /
// `provision_vault`, layer 1) can import the SAME resolution logic the CLI uses
// — the wizard lives in this data, not in any harness. Everything here is
// read-only: no fs writes, no config mutation, no port allocation.
//
// The functions resolve the wizard's "answers → plan" mapping deterministically:
//   - resolveSourceVault: which vault/skeleton the config + plugins are cloned from
//   - resolvePluginProfile: recommended | minimal | custom:… → concrete list
//   - existingSlugs / knownVaultRoots / isPathWithinRoots: collision + security
//   - buildProvisionPlan: the whole resolved plan (defaults + context + warnings
//     + ordered human-readable steps) that `--dry-run --json` emits and that
//     `provision_vault` executes.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePluginsToClone } from './plugin-resolver.mjs';
import {
  defaultNameFromPath,
  registeredVaultPaths,
  vaultNamesOf,
  vaultSlug,
} from '../src/helpers/vault-slug.mjs';

// Was a copy of setup-vault.mjs's copy of src/registry.mjs's — "change all
// three and keep tests green" was the convention, and there were six. Now
// imported from the one module that owns it (v0.90.0). Re-exported because
// tests/vault-plan.test.mjs and setup-vault.mjs both reach for it by this
// name, and because the slug this module computes and the slug the CLI writes
// still MUST agree — which is now true by construction rather than by
// discipline.
export { defaultNameFromPath };

/**
 * Map slug → registered vault path, so a new vault's slug can be checked for
 * collisions against both the portRegistry (by derived slug) and vaultNames
 * (by explicit custom name).
 */
export function existingSlugs(cfg) {
  const map = new Map();
  for (const vp of registeredVaultPaths(cfg)) {
    const slug = vaultSlug(cfg, vp).toLowerCase();
    if (!map.has(slug)) map.set(slug, vp);
  }
  // Custom names not in portRegistry (rare, but honor them). A collision map
  // is the one place where a name that is NOT a usable slug still has to be
  // enumerated — so this loop reads the raw entries rather than asking
  // `vaultSlug` per path. It skips what the readers would skip: a non-string
  // name reserves nothing, because no reader would ever resolve to it.
  for (const [vp, name] of Object.entries(vaultNamesOf(cfg) || {})) {
    if (typeof name !== 'string' || name === '') continue;
    const slug = name.toLowerCase();
    if (!map.has(slug)) map.set(slug, vp);
  }
  return map;
}

/**
 * Roots under which provisioning a new vault is allowed: the parent directory
 * of every registered vault + the reference vault's parent. Used by the layer-1
 * `provision_vault` path gate — no arbitrary remote-driven mkdir/writes.
 */
export function knownVaultRoots(cfg) {
  const roots = new Set();
  for (const vp of Object.keys(cfg.portRegistry || {})) {
    try { roots.add(path.dirname(path.resolve(vp))); } catch { /* skip */ }
  }
  if (cfg.referenceVault) {
    try { roots.add(path.dirname(path.resolve(cfg.referenceVault))); } catch { /* skip */ }
  }
  if (cfg.vaultsRoot) {
    try { roots.add(path.resolve(cfg.vaultsRoot)); } catch { /* skip */ }
  }
  return [...roots];
}

/** True when `abs` is inside (or equal to) one of the given roots. */
export function isPathWithinRoots(abs, roots) {
  const a = path.resolve(abs);
  for (const root of roots) {
    const r = path.resolve(root);
    if (a === r) return true;
    const rel = path.relative(r, a);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/**
 * Resolve the source vault the config/plugins are cloned from.
 * @returns {{ kind, sourceVault, fromVault, error }}
 */
export function resolveSourceVault({ source = 'reference', fromVault } = {}, cfg = {}, skeletonDir) {
  if (source === 'from-vault') {
    if (!fromVault) return { kind: source, error: '--from-vault requires a vault slug or path' };
    // Slug → registered path, else treat as a direct path.
    let resolved = null;
    const bySlug = existingSlugs(cfg).get(String(fromVault).toLowerCase());
    if (bySlug) resolved = bySlug;
    else resolved = path.resolve(fromVault);
    if (!fs.existsSync(resolved)) {
      return { kind: source, fromVault, error: `--from-vault source not found: ${resolved}` };
    }
    if (!fs.existsSync(path.join(resolved, '.obsidian'))) {
      return { kind: source, fromVault, error: `--from-vault source is not an Obsidian vault (no .obsidian/): ${resolved}` };
    }
    return { kind: source, fromVault, sourceVault: resolved };
  }
  if (source === 'skeleton') {
    return { kind: source, sourceVault: skeletonDir };
  }
  // 'reference' and 'bare' both clone their (REQUIRED, for bare) plugins from
  // the configured reference vault.
  return { kind: source, sourceVault: cfg.referenceVault || null };
}

/**
 * Resolve a plugin profile to a concrete clone list.
 * @param {'recommended'|'minimal'|'custom'} profile
 * @param {string[]|null} custom explicit plugin ids (for 'custom')
 * @param {string} sourceVault used for 'recommended' (reads its community-plugins.json)
 * @param {string[]} requiredPlugins always included
 */
export function resolvePluginProfile(profile, custom, sourceVault, requiredPlugins = []) {
  if (profile === 'minimal') return [...requiredPlugins];
  if (profile === 'custom') {
    const seen = new Set();
    const list = [];
    for (const p of [...requiredPlugins, ...(custom || [])]) {
      if (typeof p === 'string' && p && !seen.has(p)) { seen.add(p); list.push(p); }
    }
    return list;
  }
  // 'recommended' (default): everything the source enables + REQUIRED.
  if (sourceVault) return resolvePluginsToClone(sourceVault, requiredPlugins);
  return [...requiredPlugins];
}

/** Default wiki mode: `code` when a workspace drives the flow, else `personal`. */
export function defaultWikiMode({ linkWorkspace } = {}) {
  return linkWorkspace ? 'code' : 'personal';
}

// The 5 wiki modes, each with a one-line explanation. The "guided creation"
// flow (plan_vault + the meta-attach-vault skill) presents ALL FIVE with these
// descriptions so any harness shows the same choices (spec §4.2). `domain` is
// user-tailored: the frontend translates a one-line domain description into a
// flat --wiki-sections list; the engine stays deterministic.
export const WIKI_MODES = [
  { id: 'personal', label: '🧠 personal', description: 'Second brain — people, concepts, decisions, references, personal projects.' },
  { id: 'research', label: '🔬 research', description: 'Studying a subject — papers, concepts, hypotheses, methodology, findings.' },
  { id: 'business', label: '💼 business', description: 'A business — competitors, clients, decisions, stakeholders, meetings.' },
  { id: 'code', label: '💻 code', description: 'Tied to a repo — codebases, architecture decisions (ADR), runbooks.' },
  { id: 'domain', label: '🎯 domain', description: 'Custom — describe the domain in one line; index sections are generated for you (pass --wiki-sections).' },
];

/** Themes installed in a vault (its `.obsidian/themes/` folders) + the built-in default. */
export function availableThemes(sourceVault) {
  const out = [{ id: 'obsidian-default', label: 'Obsidian default (no custom theme)' }];
  if (!sourceVault) return out;
  try {
    for (const e of fs.readdirSync(path.join(sourceVault, '.obsidian', 'themes'), { withFileTypes: true })) {
      if (e.isDirectory()) out.push({ id: e.name, label: e.name });
    }
  } catch { /* no themes dir → default only */ }
  return out;
}

/** Registered vaults you can copy config FROM (--from-vault), as {slug, path}. */
export function copyableVaults(cfg = {}) {
  const out = [];
  for (const [slug, vp] of existingSlugs(cfg)) out.push({ slug, path: vp });
  return out;
}

/**
 * Build the complete, resolved provisioning plan (read-only). This is what
 * `--dry-run [--json]` prints and what `provision_vault` executes.
 */
export function buildProvisionPlan({ vaultPath, opts = {}, cfg = {}, requiredPlugins = [], skeletonDir } = {}) {
  const warnings = [];
  const abs = path.resolve(vaultPath);
  const name = opts.name || defaultNameFromPath(abs);
  const slug = (opts.name ? opts.name : defaultNameFromPath(abs)).toLowerCase();

  // Slug collision (against a DIFFERENT registered path).
  const slugs = existingSlugs(cfg);
  if (slugs.has(slug) && path.resolve(slugs.get(slug)) !== abs) {
    warnings.push({
      code: 'slug-collision',
      message: `Slug "${slug}" already maps to ${slugs.get(slug)}. Pass a distinct --name, or the router will not be able to disambiguate the two vaults.`,
    });
  }

  // Source resolution.
  const src = resolveSourceVault(
    { source: opts.source || 'reference', fromVault: opts.fromVault }, cfg, skeletonDir);
  if (src.error) warnings.push({ code: 'source-error', message: src.error });

  // Plugin profile (bare forces minimal).
  const rawProfile = opts.source === 'bare' ? 'minimal' : (opts.pluginProfile || 'recommended');
  const resolvedPlugins = resolvePluginProfile(
    rawProfile, opts.pluginCustom, src.sourceVault, requiredPlugins);

  // Wiki mode. `explicit` distinguishes a user-passed --wiki-mode (which the
  // engine actually seeds) from the computed default (the engine keeps the
  // generic template unless told). The frontend/plan_vault presents `mode` as
  // the recommended default; the raw CLI only seeds when explicit.
  const explicitMode = Boolean(opts.wikiMode);
  const mode = opts.wikiMode || defaultWikiMode(opts);
  const wikiMode = {
    mode,
    explicit: explicitMode,
    sections: mode === 'domain' ? (opts.wikiSections || []) : undefined,
  };
  if (mode === 'domain' && (!opts.wikiSections || opts.wikiSections.length === 0)) {
    warnings.push({
      code: 'domain-no-sections',
      message: 'wiki mode "domain" without --wiki-sections — index/overview will use a generic seed.',
    });
  }

  // Context.
  const gitPresent = opts.linkWorkspace
    ? fs.existsSync(path.join(path.resolve(opts.linkWorkspace), '.git'))
    : false;
  const flow = opts.linkWorkspace ? 'workspace-bound' : 'standalone';
  const context = {
    flow,
    gitPresent,
    referenceConfigured: Boolean(cfg.referenceVault),
    knownRoots: knownVaultRoots(cfg),
    existingBinding: null,
    // Questionnaire inputs (consumed by plan_vault to build the option lists).
    copyableVaults: copyableVaults(cfg),
    availableThemes: availableThemes(src.sourceVault),
  };

  // Path gate signals (informational at plan time; ENFORCED by provision_vault).
  // Emitted so the plan and the provision gate agree — a clean plan never turns
  // into a surprise refusal at write time (review+ W2 pass 2). Two cases:
  //  - roots exist but the target is outside them → path-outside-known-roots
  //  - NO roots at all (empty/fresh config) → no-known-roots
  // provision_vault refuses on EITHER unless allowOutsideRoots is passed.
  if (!context.knownRoots.length) {
    warnings.push({
      code: 'no-known-roots',
      message: `No known vault roots configured (no referenceVault, no registered vaults, no vaultsRoot). ` +
        `The CLI allows any path; the MCP provision_vault tool refuses one unless allowOutsideRoots is set.`,
    });
  } else if (!isPathWithinRoots(abs, context.knownRoots)) {
    warnings.push({
      code: 'path-outside-known-roots',
      message: `Target ${abs} is outside all known vault roots. The CLI allows it; the MCP provision_vault tool refuses it unless explicitly opted in.`,
    });
  }

  // Lot 2 (shipped): the engine clones the source's themes/ then writes the
  // chosen cssTheme via applyThemeChoice() — the choice is applied, no longer
  // recorded-but-blocked. `blocked: false` is kept in the shape (rather than
  // dropping the key) so plan consumers written against the blocked era keep
  // reading a boolean.
  const theme = opts.theme ? { name: opts.theme, blocked: false } : null;

  // Ordered, human-readable provisioning steps (what provision_vault will do).
  const steps = [];
  if (src.kind === 'skeleton') {
    // --from-skeleton delegates to the bootstrap-reference flow — a DIFFERENT
    // end-state (a skeleton to finish in Obsidian, not a fully-cloned vault).
    // The steps reflect that so a machine consumer of the plan isn't misled.
    steps.push(`scaffold from the shipped reference skeleton (${skeletonDir || 'templates/reference-vault-skeleton'})`);
    steps.push('download the mcp-router-bridge plugin from GitHub releases');
    steps.push('print next-steps: open in Obsidian → install REQUIRED marketplace plugins → --init-reference');
    steps.push('(no port/.env/wiki-meta at this stage — that is the bootstrap-reference end-state)');
  } else {
    if (!fs.existsSync(abs)) steps.push(`create vault directory ${abs}`);
    steps.push(`clone ${resolvedPlugins.length} plugin(s): ${resolvedPlugins.join(', ')}`);
    steps.push('allocate a fresh REST API port + generate a fresh API key');
    if (src.kind === 'from-vault') {
      steps.push(`copy config-only from ${src.sourceVault} (appearance + themes/ + CLAUDE.md; exclude workspace.json + credentialed data.json; secrets regenerated)`);
      if (opts.withFolderTree) steps.push('recreate the source wiki/ folder tree (empty, no notes)');
    }
    steps.push('clone .smart-env, themes/ (per-theme, target-newer preserved), snippets, root docs');
    if (opts.theme) steps.push(`apply theme "${opts.theme}" (write cssTheme in appearance.json)`);
    steps.push(`scaffold fresh wiki-meta/ (mode: ${mode}${explicitMode ? '' : ' — DEFAULT; generic template unless --wiki-mode is passed'})`);
    steps.push('write .env, .mcp.json, .gitignore');
    if (opts.claudeWorkspace && opts.linkWorkspace) steps.push(`merge enabledPlugins into ${opts.linkWorkspace}/.claude/settings.json (+ verify global marketplace)`);
    if (opts.linkWorkspace) steps.push(`bind workspace ${opts.linkWorkspace} to this vault`);
    if (opts.open) steps.push('open Obsidian on the new vault (obsidian://open)');
    if (opts.probe) steps.push('probe REST port reachability → health verdict');
  }

  return {
    name,
    slug,
    path: abs,
    source: { kind: src.kind, fromVault: src.fromVault || null, sourceVault: src.sourceVault || null },
    plugins: { profile: rawProfile, resolved: resolvedPlugins },
    theme,
    wikiMode,
    conventions: opts.conventions || [],
    claudeWorkspace: Boolean(opts.claudeWorkspace),
    open: Boolean(opts.open),
    probe: Boolean(opts.probe),
    gitInit: Boolean(opts.gitInit),
    withFolderTree: Boolean(opts.withFolderTree),
    context,
    warnings,
    steps,
  };
}
