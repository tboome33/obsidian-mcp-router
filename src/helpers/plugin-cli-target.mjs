/**
 * plugin-cli-target — "which vault, and where is its disk?" for the two plugin
 * CLIs (`--install-plugins`, `--plugin-health`).
 *
 * Both commands work on a vault's FILES — `.obsidian/plugins/<id>/main.js`,
 * `community-plugins.json` — so a target is only usable when it has a disk
 * this machine can reach:
 *   - a registered LOCAL vault (portRegistry): its registry path;
 *   - a REMOTE vault (remoteVaults) that declares `localPath` — the vault's
 *     folder as seen from this machine (a mounted share, the host itself).
 *     Without it there is nowhere to write, and the command says so rather
 *     than guessing a path;
 *   - an explicit directory that contains `.obsidian/` — registered or not
 *     (an unregistered one simply has no REST endpoint for live evidence).
 *
 * The config is read as the file has it (OBSIDIAN_ROUTER_CONFIG, else the
 * default path), through the vault-slug accessors — the same resolver the
 * hooks and setup-vault use, so a name means here what it means there.
 */

import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveVaultBySlug, registeredVaultPaths, vaultSlug, knownVaultSlugs } from './vault-slug.mjs';
import { sameVaultPath } from './vault-path-identity.mjs';

export function defaultConfigPath(env = process.env) {
  return env.OBSIDIAN_ROUTER_CONFIG
    ? path.resolve(env.OBSIDIAN_ROUTER_CONFIG)
    : path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
}

/** @returns {{ cfg: object|null, configPath: string, error?: string }} */
export function loadRouterConfig({ configPath, env = process.env, fs = nodeFs } = {}) {
  const p = configPath || defaultConfigPath(env);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return { cfg: null, configPath: p, error: `cannot read the router config at ${p} (${err.code || err.message})` };
  }
  try {
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not a JSON object');
    return { cfg, configPath: p };
  } catch (err) {
    return { cfg: null, configPath: p, error: `the router config at ${p} is not valid (${err.message})` };
  }
}

function looksLikePath(arg) {
  return path.isAbsolute(arg) || /[\\/]/.test(arg) || arg === '.' || arg === '..';
}

function isVaultDir(fs, dir) {
  try { return fs.statSync(path.join(dir, '.obsidian')).isDirectory(); } catch { return false; }
}

function remoteEntries(cfg) {
  return Array.isArray(cfg?.remoteVaults) ? cfg.remoteVaults.filter((r) => r && typeof r.name === 'string') : [];
}

function remoteTarget(r, fs) {
  const endpoint = {
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl.replace(/\/$/, '') : null,
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : null,
    tlsInsecure: r.tlsInsecure === true,
    extraHeaders: r.extraHeaders && typeof r.extraHeaders === 'object' ? { ...r.extraHeaders } : undefined,
  };
  const local = typeof r.localPath === 'string' && r.localPath.trim() ? r.localPath : null;
  if (!local) {
    return {
      ok: false,
      code: 'remote_without_local_path',
      error:
        `Vault "${r.name}" is a remote vault with no localPath: this command works on the vault's files `
        + '(.obsidian/plugins, community-plugins.json) and a remote registration gives it no folder to reach. '
        + `Add "localPath" (the vault's folder as seen from this machine) to its remoteVaults entry, `
        + 'or run the command on the machine that hosts the vault, against its path.',
    };
  }
  const vaultPath = path.resolve(local);
  if (!isVaultDir(fs, vaultPath)) {
    return {
      ok: false,
      code: 'local_path_not_a_vault',
      error: `Vault "${r.name}" declares localPath ${vaultPath}, which has no .obsidian folder from here — is the share mounted?`,
    };
  }
  return { ok: true, type: 'remote', name: r.name, vaultPath, endpoint };
}

/**
 * Resolve the CLI's vault argument.
 *
 * @returns {{ok:true, type:'local'|'remote'|'unregistered', name:string|null, vaultPath:string, endpoint?:object}
 *         | {ok:false, code:string, error:string}}
 */
export function resolvePluginTarget(cfg, arg, { fs = nodeFs } = {}) {
  if (typeof arg !== 'string' || !arg.trim()) {
    return { ok: false, code: 'usage', error: 'a vault name or a vault path is required' };
  }
  if (cfg) {
    const local = resolveVaultBySlug(cfg, arg);
    if (local) return { ok: true, type: 'local', name: vaultSlug(cfg, local), vaultPath: path.resolve(local) };
    const remotes = remoteEntries(cfg);
    const exact = remotes.find((r) => r.name === arg);
    const folded = remotes.filter((r) => r.name.trim().toLowerCase() === arg.trim().toLowerCase());
    const remote = exact ?? (folded.length === 1 ? folded[0] : null);
    if (remote) return remoteTarget(remote, fs);
  }
  if (looksLikePath(arg)) {
    const abs = path.resolve(arg);
    if (cfg) {
      const reg = registeredVaultPaths(cfg).find((p) => sameVaultPath(p, abs));
      if (reg) return { ok: true, type: 'local', name: vaultSlug(cfg, reg), vaultPath: path.resolve(reg) };
      const remote = remoteEntries(cfg).find((r) => typeof r.localPath === 'string' && sameVaultPath(r.localPath, abs));
      if (remote) return remoteTarget(remote, fs);
    }
    if (!isVaultDir(fs, abs)) {
      return { ok: false, code: 'not_a_vault', error: `${abs} has no .obsidian folder — not an Obsidian vault` };
    }
    return { ok: true, type: 'unregistered', name: null, vaultPath: abs };
  }
  const known = cfg ? [...knownVaultSlugs(cfg), ...remoteEntries(cfg).map((r) => r.name)] : [];
  return {
    ok: false,
    code: 'unknown_vault',
    error: `no vault named "${arg}" in the router config${known.length ? ` (known: ${known.join(', ')})` : ''} — pass its name or its folder`,
  };
}
