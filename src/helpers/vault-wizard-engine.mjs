// Shared engine bridge for the layer-1 MCP tools (plan_vault / provision_vault).
// Both tools drive the SAME layer-0 CLI (scripts/setup-vault.mjs) so there is a
// single source of truth for provisioning: plan_vault runs it as
// `--dry-run --json`, provision_vault runs it for real (also `--json`, which
// makes it emit a nonce'd `##PROVISION_RESULT:<nonce>##` marker line). Nothing
// here mutates the filesystem itself — the child process does, and only for
// provision_vault.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { subprocessOptions } from './subprocess-env.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SETUP_VAULT_SCRIPT = path.resolve(SELF_DIR, '..', '..', 'scripts', 'setup-vault.mjs');

/**
 * Translate the structured tool input into setup-vault.mjs CLI flags.
 * Shape (both tools share it):
 *   { path (required), name?, source?:{kind,fromVault?,withFolderTree?},
 *     plugins?:{profile,custom?}, theme?, wikiMode?:{mode,sections?},
 *     linkWorkspace?, claudeWorkspace?, open?, probe?, probeTimeout?, gitInit? }
 */
export function composeSetupVaultArgs(input = {}) {
  // A PRESENT `path` must be a string — a wrong type is a caller bug, not "no
  // path given", and must never be silently swallowed just because `name`
  // also happens to be present. Found in review: checking only `typeof ===
  // 'string'` to decide "do we have a path" let a non-string `path` (e.g. an
  // accidentally-nested object) alongside a valid `name` provision silently
  // at the vaultsRoot-composed location instead of the caller's intended
  // target — no error, no warning, wrong vault created.
  if (input.path !== undefined && input.path !== null && typeof input.path !== 'string') {
    throw new Error('`path` must be a string.');
  }
  const hasPath = typeof input.path === 'string' && input.path !== '';
  // `path` may be omitted (or empty) when `name` is given: the engine then
  // composes it from the configured `vaultsRoot` (decision ergonomie-
  // creation-liaison-vaults §1). Neither present is still a hard error —
  // there is nothing to create a vault FROM.
  if (!hasPath && !input.name) {
    throw new Error('`path` or `name` (string) is required — `name` alone composes a path under the configured vaultsRoot.');
  }
  // The path is argv[0] (a positional). A value starting with `--` would be
  // parsed by the engine as a FLAG (not the vault path), silently activating
  // e.g. --regenerate/--force and then failing with "No vault path provided".
  // Reject it up front with a clear error (review+ W2 NIT #3).
  if (hasPath && input.path.startsWith('--')) {
    throw new Error('`path` must be a filesystem path, not a flag (got a value starting with "--").');
  }
  const args = [];
  if (hasPath) args.push(input.path);
  if (input.name) args.push('--name', String(input.name));

  const src = input.source || {};
  const kind = src.kind || 'reference';
  if (kind === 'from-vault') {
    if (!src.fromVault) throw new Error("source.kind 'from-vault' requires source.fromVault (a slug or path).");
    args.push('--from-vault', String(src.fromVault));
    if (src.withFolderTree) args.push('--with-folder-tree');
  } else if (kind === 'skeleton') {
    args.push('--from-skeleton');
  } else if (kind === 'bare') {
    args.push('--bare');
  } else if (kind !== 'reference') {
    throw new Error(`Unknown source.kind: ${kind} (expected reference|from-vault|skeleton|bare).`);
  }

  const pl = input.plugins || {};
  if (pl.profile === 'minimal') args.push('--plugins', 'minimal');
  else if (pl.profile === 'custom') args.push('--plugins', 'custom:' + (pl.custom || []).join(','));
  else if (pl.profile === 'recommended') args.push('--plugins', 'recommended');
  else if (pl.profile) throw new Error(`Unknown plugins.profile: ${pl.profile} (expected recommended|minimal|custom).`);

  if (input.theme) args.push('--theme', String(input.theme));

  const wm = input.wikiMode || {};
  if (wm.mode) {
    args.push('--wiki-mode', String(wm.mode));
    if (Array.isArray(wm.sections) && wm.sections.length) args.push('--wiki-sections', wm.sections.join(','));
  }

  if (input.linkWorkspace) args.push('--link-workspace', String(input.linkWorkspace));
  if (input.claudeWorkspace) args.push('--claude-workspace');
  if (input.open) args.push('--open');
  if (input.probe) {
    args.push('--probe');
    if (input.probeTimeout) args.push('--probe-timeout', String(input.probeTimeout));
  }
  if (input.gitInit) args.push('--git-init');
  return args;
}

/**
 * Spawn setup-vault.mjs, capturing stdout/stderr/exit. Never rejects.
 * @param {object} opts
 * @param {object} opts.extraEnv Extra env vars for the child.
 * @param {string} opts.configPath The router's ACTIVE config path — passed as
 *   OBSIDIAN_ROUTER_CONFIG so the child computes roots/registration against the
 *   SAME config the running server uses (review+ W2 P2). Falls back to whatever
 *   is already in process.env when omitted.
 * @param {string} [opts.scriptPath] Test seam: the script to run instead of
 *   the real engine (one that prints what it received). Production callers
 *   omit it.
 */
export function runSetupVault(args, { extraEnv = {}, configPath, scriptPath = SETUP_VAULT_SCRIPT } = {}) {
  return new Promise((resolve) => {
    // The child's environment is the `setup-vault` allowlist (subprocess-env.mjs):
    // the three OBSIDIAN_ROUTER_* variables the engine reads, the git family
    // it spawns with, the Node and proxy variables, and the platform basics —
    // built FROM process.env, never a copy of it. The MCP server's own
    // environment carries the workspace `.env` and the smart-link secret; a
    // vault provisioning run has no use for either.
    const child = spawn(process.execPath, [scriptPath, ...args], subprocessOptions('setup-vault', {
      extraEnv: {
        // The caller's additions go FIRST, so the two imposed values below
        // cannot be overridden by them — "must never" has to hold against a
        // caller too, not only against the environment.
        ...extraEnv,
        // An MCP tool must never silently mutate the user's global
        // ~/.claude/settings.json — hooks are wired separately (skill / CLI).
        OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1',
        // Use the server's active config, not setup-vault's default.
        ...(configPath ? { OBSIDIAN_ROUTER_CONFIG: configPath } : {}),
      },
    }));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
  });
}

/**
 * The drift-sensitive core of a dry-run plan, for the C3 sealed preview. Both
 * plan_vault (which emits the seal) and provision_vault (which verifies it)
 * derive it from `runDryRunPlan(input)` with the SAME input, so the seal matches
 * unless the ENVIRONMENT moved between the two calls — a slug collision that
 * appeared, a source vault that changed its plugin set, a vault root that
 * vanished, an outside-roots verdict that flipped. Those are exactly the
 * conditions under which applying the previewed plan would do something other
 * than what the caller approved.
 *
 * A curated subset (not the raw plan) on purpose: it captures WHAT will be
 * created (resolved path/slug/source/plugins/theme/wikiMode/conventions), the
 * ORDERED action steps, and the blocking/adjusting signals (warning CODES,
 * order-independent), while excluding presentational context (copyable-vault
 * lists, available-theme lists, probe latencies) that can jitter without
 * changing the outcome.
 *
 * `steps` must be part of the seal (independent Codex verification of v0.61.0,
 * confirmed by probe): the engine's step list is itself state-dependent — e.g.
 * "create vault directory X" appears only when the target does NOT exist. A
 * preview taken against an absent target, followed by someone creating that
 * directory before the apply, used to hash IDENTICALLY (create-vs-adopt is
 * exactly the kind of executed-behaviour drift the seal exists to refuse: the
 * adopt path preserves a pre-existing app.json and skips existing plugin dirs
 * the caller never previewed). Steps are deterministic for an identical
 * input+environment (they embed the resolved path/plugins/mode, all stable), so
 * including them order-preserved adds no false positives.
 *
 * @param {object} plan a `runDryRunPlan` result
 * @returns {object} stable plan core
 */
export function provisionPlanCore(plan) {
  const p = plan || {};
  const pl = p.plugins || {};
  return {
    path: p.path ?? null,
    slug: p.slug ?? null,
    name: p.name ?? null,
    source: p.source ?? null,
    plugins: {
      profile: pl.profile ?? null,
      resolved: Array.isArray(pl.resolved) ? [...pl.resolved].sort() : [],
    },
    theme: p.theme && typeof p.theme === 'object' ? p.theme.name ?? null : p.theme ?? null,
    wikiMode: p.wikiMode && typeof p.wikiMode === 'object' ? p.wikiMode.mode ?? null : p.wikiMode ?? null,
    conventions: p.conventions ?? null,
    claudeWorkspace: p.claudeWorkspace ?? null,
    // Ordered action steps — order preserved (it is the execution order).
    steps: Array.isArray(p.steps) ? p.steps.map((s) => String(s)) : [],
    // Warning CODES only, sorted — order-independent set of blocking/adjusting
    // conditions. The human-readable `message` is excluded (it may embed a path
    // or count that jitters without changing the verdict).
    warnings: Array.isArray(p.warnings)
      ? p.warnings.map((w) => (w && w.code != null ? String(w.code) : null)).filter(Boolean).sort()
      : [],
  };
}

/**
 * The executable OPTIONS a provision run will act on that are NOT reflected in
 * the dry-run plan core — the side-effect knobs `composeSetupVaultArgs` forwards
 * to the mutating child (`--link-workspace`, `--open`, `--probe`, `--git-init`,
 * `--claude-workspace`) plus the `allowOutsideRoots` gate override. The C3 seal
 * must cover EXACTLY what will be executed (spec §2.17); without these, a preview
 * approved with `gitInit:false, open:false` could be applied with
 * `gitInit:true, open:true` — different side effects, same seal. Derived from the
 * SAME `input` in plan_vault and provision_vault, so identical args pass and any
 * divergence in these knobs is a drift refusal.
 *
 * @param {object} input the tool input (already `{...args, path}`)
 * @returns {object} normalized executable options
 */
export function provisionExecOptions(input = {}) {
  return {
    linkWorkspace: input.linkWorkspace ?? null,
    claudeWorkspace: input.claudeWorkspace ?? null,
    open: input.open ?? null,
    probe: input.probe ?? null,
    probeTimeout: input.probeTimeout ?? null,
    gitInit: input.gitInit ?? null,
    allowOutsideRoots: input.allowOutsideRoots ?? null,
    // Captured verbatim (not resolved to a workspace path) so the seal only
    // has to compare a boolean: provision_vault is the one that turns `true`
    // into `linkWorkspace = process.cwd()` at apply time (decision
    // ergonomie-creation-liaison-vaults §1 — bindToWorkspace, default false).
    bindToWorkspace: input.bindToWorkspace ?? null,
  };
}

/** Run the engine in dry-run mode and return the parsed plan (read-only). */
export async function runDryRunPlan(input, { configPath } = {}) {
  const args = [...composeSetupVaultArgs(input), '--dry-run', '--json'];
  const { code, stdout, stderr } = await runSetupVault(args, { configPath });
  if (code !== 0) throw new Error(`Planning failed: ${(stderr || stdout).trim()}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Planner produced invalid JSON: ${stdout.slice(0, 400)}`);
  }
}

/**
 * Run the engine for real, using a per-run NONCE in the result marker so a
 * crafted --name/section value printed by the child can never spoof the
 * machine-readable result (review+ W2 NIT #2). Returns { code, stdout, stderr,
 * result }.
 */
export async function runProvision(input, { configPath } = {}) {
  const nonce = crypto.randomUUID();
  const args = [...composeSetupVaultArgs(input), '--json'];
  const { code, stdout, stderr } = await runSetupVault(args, {
    configPath,
    extraEnv: { OBSIDIAN_ROUTER_PROVISION_NONCE: nonce },
  });
  return { code, stdout, stderr, result: parseProvisionResult(stdout, nonce) };
}

/**
 * Extract the machine-readable provision result from a real run's stdout.
 * Matches the nonce'd marker when a nonce is supplied (the MCP path), else the
 * plain marker (direct CLI use).
 */
export function parseProvisionResult(stdout, nonce) {
  const marker = nonce ? `##PROVISION_RESULT:${nonce}##` : '##PROVISION_RESULT##';
  const line = (stdout || '').split(/\r?\n/).find((l) => l.startsWith(marker));
  if (!line) return null;
  try { return JSON.parse(line.slice(marker.length).trim()); }
  catch { return null; }
}
