#!/usr/bin/env node
/**
 * plugin-health.mjs — `obsidian-mcp-router --plugin-health <vault> [--json] [--offline]`.
 *
 * Read-only. Tells, per plugin, whether its code is on disk, whether Obsidian
 * is told to enable it, its version, and — when the vault's REST API answers —
 * whether the running Obsidian loaded it. Names the two silent failures
 * explicitly ("enabled without code", "bridge absent") with the command that
 * fixes each.
 *
 * The inventory is src/helpers/plugin-inventory.mjs; this file resolves the
 * vault, gathers the live evidence and prints.
 *
 * Exit codes: 0 the required plugins (Local REST API, the bridge) have code;
 * 1 one of them is missing, settings only, or enabled without code;
 * 2 usage / unusable target.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { samePath } from './path-helpers.mjs';
import {
  inspectVaultPlugins,
  loadExpectedPlugins,
  readLocalRestEndpoint,
  gatherLiveEvidence,
  evaluatePluginHealth,
  formatPluginHealth,
} from '../src/helpers/plugin-inventory.mjs';
import { loadRouterConfig, resolvePluginTarget } from '../src/helpers/plugin-cli-target.mjs';
import { portEntryOf } from '../src/helpers/port-registry.mjs';

const SKELETON_COMMUNITY_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'reference-vault-skeleton', '.obsidian', 'community-plugins.json',
);

const USAGE = `Usage:
  obsidian-mcp-router --plugin-health <vault-name|vault-path> [--json] [--offline] [--config <path>]

  --json      one JSON document instead of the table
  --offline   skip the live check against the vault's REST API
`;

export function parseHealthArgs(argv) {
  const a = { target: null, json: false, offline: false, configPath: null, help: false, error: null };
  const args = argv[0] === '--plugin-health' ? argv.slice(1) : [...argv];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--json') a.json = true;
    else if (x === '--offline') a.offline = true;
    else if (x === '--config') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) a.error = '--config requires a value';
      else { a.configPath = v; i += 1; }
    } else if (x.startsWith('--')) a.error = `unknown flag ${x}`;
    else if (a.target === null) a.target = x;
    else a.error = `unexpected argument ${x}`;
    if (a.error) break;
  }
  if (!a.error && !a.help && !a.target) a.error = 'a vault name or path is required';
  return a;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] injected for tests: fs, request, env, out, err, skeletonFile
 * @returns {Promise<number>}
 */
export async function runPluginHealth(argv, deps = {}) {
  const fs = deps.fs ?? nodeFs;
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const env = deps.env ?? process.env;

  const a = parseHealthArgs(argv);
  if (a.help) { out(USAGE); return 0; }
  if (a.error) { err(`plugin-health: ${a.error}\n\n${USAGE}`); return 2; }

  const { cfg, error: cfgError } = loadRouterConfig({ configPath: a.configPath, env, fs });
  const target = resolvePluginTarget(cfg, a.target, { fs });
  if (!target.ok) {
    const msg = `${target.error}${!cfg && cfgError && target.code === 'unknown_vault' ? ` (${cfgError})` : ''}`;
    if (a.json) out(JSON.stringify({ ok: false, code: target.code, error: msg }));
    else err(`plugin-health: ${msg}`);
    return 2;
  }

  const expected = loadExpectedPlugins(deps.skeletonFile ?? SKELETON_COMMUNITY_FILE, { fs });
  const inventory = inspectVaultPlugins(target.vaultPath, { fs, expected });

  let evidence = null;
  if (!a.offline) {
    let endpoint;
    if (target.type === 'remote') {
      endpoint = { ...target.endpoint, insecurePort: null, openProbeBase: target.endpoint?.baseUrl ?? null };
    } else {
      // The registry's remembered ports are the fallback the router itself
      // uses when data.json cannot say; an unregistered folder has none.
      const registryPorts = cfg && target.type === 'local' ? portEntryOf(cfg, target.vaultPath) : null;
      endpoint = readLocalRestEndpoint(target.vaultPath, { fs, registryPorts });
    }
    evidence = await gatherLiveEvidence({ endpoint, request: deps.request });
  }
  const verdict = evaluatePluginHealth(inventory, evidence, { vaultArg: a.target });

  if (a.json) {
    out(JSON.stringify({
      ok: verdict.exitCode === 0,
      vault: { name: target.name, type: target.type, path: target.vaultPath },
      communityPlugins: inventory.communityPlugins.state,
      plugins: verdict.rows,
      enabledWithoutCode: inventory.enabledWithoutCode,
      missing: inventory.missing,
      bridge: inventory.bridge,
      live: evidence,
      problems: verdict.problems,
    }, null, 2));
  } else {
    for (const line of formatPluginHealth({ target, inventory, evidence, verdict })) out(line);
  }
  return verdict.exitCode;
}

const IS_ENTRYPOINT = (() => {
  try { return !!process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1]); } catch { return false; }
})();

if (IS_ENTRYPOINT) {
  runPluginHealth(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`plugin-health: ${e?.stack || e}\n`); process.exitCode = 1; },
  );
}
