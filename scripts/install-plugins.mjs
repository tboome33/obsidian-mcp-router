#!/usr/bin/env node
/**
 * install-plugins.mjs — `obsidian-mcp-router --install-plugins`.
 *
 *   obsidian-mcp-router --install-plugins <vault-name|vault-path> --dry-run
 *   obsidian-mcp-router --install-plugins <vault-name|vault-path> --approved-plan-sha256 <seal>
 *     [--only id,id] [--force] [--config <path>]
 *
 * Downloads the code of the community plugins a vault has ENABLED but lacks
 * (plus the required ones: Local REST API and the bridge), from their GitHub
 * releases, into the vault's `.obsidian/plugins/`. One named command, so the
 * user can authorise it once instead of an agent improvising a download.
 *
 * SEALED, ALWAYS. The dry run prints the plan plugin by plugin — registry repo,
 * the repo it really resolved to, release tag, assets and sizes, destination,
 * and what is refused or left alone — then `approvedPlanSha256: <seal>`. The
 * apply re-resolves everything and refuses unless the fresh plan seals to that
 * exact value. There is no unsealed apply.
 *
 * The logic lives in src/helpers/plugin-installer.mjs (plan + disk) and
 * src/helpers/plugin-release-resolver.mjs (network, host allowlist on every
 * redirect hop). This file parses arguments and prints.
 *
 * Exit codes: 0 done (or dry run printed), 1 refused or failed (drift, a
 * plugin that could not be written), 2 usage / unusable target.
 */

import nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
// A NAMESPACE import on purpose: setup-vault.mjs owns the allowlist, the
// required list and the bridge URLs, and a named import of a binding it does
// not export would fail at link time and take this whole command down with it.
// setup-vault.mjs exports NETWORK_PLUGIN_ALLOWLIST, REQUIRED_PLUGINS and
// BRIDGE_PLUGIN_URLS; should one ever stop being exported, this command refuses
// with a message naming it instead of inventing a copy of a security list.
import * as setupVault from './setup-vault.mjs';
import { samePath } from './path-helpers.mjs';
import { verifyPlanSeal, isPlanSeal, PlanDriftError } from '../src/helpers/plan-seal.mjs';
import { createGuardedFetch, repoFromGithubUrl } from '../src/helpers/plugin-release-resolver.mjs';
import {
  INSTALL_OP,
  buildInstallPlan,
  applyInstallPlan,
  formatInstallPlan,
  installIdentity,
  sealablePlan,
  sealInstallPlan,
  parseOnlyList,
  postInstallChecklist,
} from '../src/helpers/plugin-installer.mjs';
import { loadRouterConfig, resolvePluginTarget } from '../src/helpers/plugin-cli-target.mjs';

const USAGE = `Usage:
  obsidian-mcp-router --install-plugins <vault-name|vault-path> --dry-run [--only id,id] [--force]
  obsidian-mcp-router --install-plugins <vault-name|vault-path> --approved-plan-sha256 <seal> [--only id,id] [--force]

  --dry-run                     print the plan and its seal; write nothing
  --approved-plan-sha256 <seal> apply the plan the dry run printed (required to write)
  --only id,id                  consider only these plugin ids
  --force                       reinstall plugins whose main.js is already on disk
  --config <path>               router config (default: OBSIDIAN_ROUTER_CONFIG, then ~/.claude/obsidian-mcp-router/config.json)
`;

/**
 * The three setup-vault constants this command needs, or the names of the
 * ones that are not exported yet.
 */
export function setupVaultSymbols(ns = setupVault) {
  const missing = [];
  const allowlist = ns.NETWORK_PLUGIN_ALLOWLIST;
  const required = ns.REQUIRED_PLUGINS;
  const bridgeUrls = ns.BRIDGE_PLUGIN_URLS;
  if (!(allowlist instanceof Set)) missing.push('NETWORK_PLUGIN_ALLOWLIST');
  if (!Array.isArray(required)) missing.push('REQUIRED_PLUGINS');
  if (!bridgeUrls || typeof bridgeUrls !== 'object') missing.push('BRIDGE_PLUGIN_URLS');
  return { allowlist, required, bridgeUrls, missing };
}

export function parseInstallArgs(argv) {
  const a = { target: null, dryRun: false, seal: null, only: null, force: false, configPath: null, help: false, error: null };
  const args = argv[0] === '--install-plugins' ? argv.slice(1) : [...argv];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    const value = () => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) { a.error = `${x} requires a value`; return null; }
      i += 1;
      return v;
    };
    if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--force') a.force = true;
    else if (x === '--approved-plan-sha256') a.seal = value();
    else if (x === '--only') a.only = parseOnlyList(value());
    else if (x === '--config') a.configPath = value();
    else if (x.startsWith('--')) a.error = `unknown flag ${x}`;
    else if (a.target === null) a.target = x;
    else a.error = `unexpected argument ${x}`;
    if (a.error) break;
  }
  if (!a.error && !a.help) {
    if (!a.target) a.error = 'a vault name or path is required';
    else if (a.dryRun && a.seal) a.error = '--dry-run and --approved-plan-sha256 are exclusive';
    else if (a.seal !== null && !isPlanSeal(a.seal)) a.error = '--approved-plan-sha256 expects the 64-hex seal a --dry-run printed';
    else if (a.only && a.only.length === 0) a.error = '--only needs at least one plugin id';
  }
  return a;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] injected for tests: fs, fetch, env, out, err, symbols
 * @returns {Promise<number>} exit code
 */
export async function runInstallPlugins(argv, deps = {}) {
  const fs = deps.fs ?? nodeFs;
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const env = deps.env ?? process.env;

  const a = parseInstallArgs(argv);
  if (a.help) { out(USAGE); return 0; }
  if (a.error) { err(`install-plugins: ${a.error}\n\n${USAGE}`); return 2; }

  const sym = deps.symbols ?? setupVaultSymbols();
  if (sym.missing?.length) {
    err(`install-plugins: scripts/setup-vault.mjs does not export ${sym.missing.join(', ')} — this install is incomplete; nothing was changed.`);
    return 2;
  }
  const bridgeRepo = repoFromGithubUrl(sym.bridgeUrls['main.js']);

  const { cfg, error: cfgError } = loadRouterConfig({ configPath: a.configPath, env, fs });
  const target = resolvePluginTarget(cfg, a.target, { fs });
  if (!target.ok) {
    err(`install-plugins: ${target.error}${!cfg && cfgError && target.code === 'unknown_vault' ? ` (${cfgError})` : ''}`);
    return 2;
  }

  const fetch = deps.fetch ?? createGuardedFetch();
  const planArgs = {
    vaultPath: target.vaultPath, fetch, fs,
    allowlist: sym.allowlist, required: sym.required, bridgeRepo,
    only: a.only, force: a.force,
  };

  if (!a.dryRun && !a.seal) {
    err('install-plugins: refusing to write without an approved plan. Run it with --dry-run first, review the plan, '
      + 'then re-run with --approved-plan-sha256 <the printed seal>.');
    return 2;
  }

  let plan;
  try {
    plan = await buildInstallPlan(planArgs);
  } catch (e) {
    err(`install-plugins: ${e.message}`);
    return 1;
  }

  if (a.dryRun) {
    for (const line of formatInstallPlan(plan, { vaultPath: target.vaultPath })) out(line);
    const seal = sealInstallPlan(target, plan);
    out('');
    out(`approvedPlanSha256: ${seal}`);
    const flags = [a.only ? `--only ${a.only.join(',')}` : '', a.force ? '--force' : ''].filter(Boolean).join(' ');
    out(plan.install.length
      ? `Apply exactly this plan: obsidian-mcp-router --install-plugins ${JSON.stringify(a.target)} --approved-plan-sha256 ${seal}${flags ? ` ${flags}` : ''}`
      : 'Nothing to install.');
    return 0;
  }

  try {
    verifyPlanSeal({
      op: INSTALL_OP,
      identity: installIdentity(target),
      plan: sealablePlan(plan),
      approvedPlanSha256: a.seal,
      previewHint: `obsidian-mcp-router --install-plugins ${JSON.stringify(a.target)} --dry-run`,
      subject: 'The vault or a plugin release',
    });
  } catch (e) {
    if (e instanceof PlanDriftError) {
      err(`install-plugins: ${e.message}`);
      return 1;
    }
    throw e;
  }

  if (!plan.install.length) {
    out('Nothing to install — the approved plan installs no plugin.');
    return 0;
  }
  let res;
  try {
    res = await applyInstallPlan({ vaultPath: target.vaultPath, plan, fetch, fs, force: a.force });
  } catch (e) {
    // A refusal that stops the WHOLE apply before any write — a link inside
    // the vault's `.obsidian/plugins` chain — is a reported exit, not a crash.
    err(`install-plugins: refused — ${e?.message || e}`);
    return 1;
  }
  for (const i of res.installed) {
    out(`✓ ${i.id} ${i.version} — ${i.files.join(', ')}${i.dataJsonKept ? ' (data.json kept untouched)' : ''}`);
  }
  for (const f of res.failed) err(`✗ ${f.id}: ${f.reason}`);
  if (res.communityPlugins.state === 'invalid' || res.communityPlugins.state === 'refused') {
    err(`! community-plugins.json was left as it is: ${res.communityPlugins.error}`);
  } else if (res.communityPlugins.added.length) {
    out(`Added to community-plugins.json: ${res.communityPlugins.added.join(', ')}`);
  }
  if (res.installed.length) {
    out('');
    for (const line of postInstallChecklist({ vaultArg: a.target, installedIds: res.installed.map((i) => i.id) })) out(line);
  }
  return res.failed.length || res.communityPlugins.state !== 'ok' && res.communityPlugins.state !== 'absent' ? 1 : 0;
}

const IS_ENTRYPOINT = (() => {
  try { return !!process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1]); } catch { return false; }
})();

if (IS_ENTRYPOINT) {
  runInstallPlugins(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`install-plugins: ${e?.stack || e}\n`); process.exitCode = 1; },
  );
}
