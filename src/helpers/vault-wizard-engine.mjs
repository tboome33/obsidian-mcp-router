// Shared engine bridge for the layer-1 MCP tools (plan_vault / provision_vault).
// Both tools drive the SAME layer-0 CLI (scripts/setup-vault.mjs) so there is a
// single source of truth for provisioning: plan_vault runs it as
// `--dry-run --json`, provision_vault runs it for real (also `--json`, which
// makes it emit a `##PROVISION_RESULT##` marker line). Nothing here mutates the
// filesystem itself — the child process does, and only for provision_vault.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!input.path || typeof input.path !== 'string') {
    throw new Error('`path` (string) is required.');
  }
  const args = [input.path];
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

/** Spawn setup-vault.mjs, capturing stdout/stderr/exit. Never rejects. */
export function runSetupVault(args, { extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SETUP_VAULT_SCRIPT, ...args], {
      env: {
        ...process.env,
        // An MCP tool must never silently mutate the user's global
        // ~/.claude/settings.json — hooks are wired separately (skill / CLI).
        OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
  });
}

/** Run the engine in dry-run mode and return the parsed plan (read-only). */
export async function runDryRunPlan(input) {
  const args = [...composeSetupVaultArgs(input), '--dry-run', '--json'];
  const { code, stdout, stderr } = await runSetupVault(args);
  if (code !== 0) throw new Error(`Planning failed: ${(stderr || stdout).trim()}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Planner produced invalid JSON: ${stdout.slice(0, 400)}`);
  }
}

const PROVISION_MARKER = '##PROVISION_RESULT##';

/** Extract the machine-readable provision result from a real run's stdout. */
export function parseProvisionResult(stdout) {
  const line = (stdout || '').split(/\r?\n/).find((l) => l.startsWith(PROVISION_MARKER));
  if (!line) return null;
  try { return JSON.parse(line.slice(PROVISION_MARKER.length).trim()); }
  catch { return null; }
}
