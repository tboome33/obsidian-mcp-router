/**
 * find-vaults — the Obsidian vaults on this machine the router does not know
 * yet, and the one step that adds such a vault to the router's config.
 *
 * Why it exists: a project's vault often already sits on disk (a folder under
 * the vaults root, or a container's volume beside the project), served by an
 * Obsidian that answers on its port — and the router has never heard of it.
 * Getting it registered used to mean finding the Local REST API key in the
 * plugin's `data.json` by hand, typing it into `register_remote_vault`, then
 * `setup-vault.mjs --attach --local-path` (games.kiviri.fr, on the Hermès VM).
 * The vault panel's first-run screen runs this instead, through
 * `scripts/find-vaults.mjs`.
 *
 * THE KEY NEVER LEAVES THIS PROCESS. `findVaults` reads each folder's key only
 * to ask the address whether it accepts it, and reports the verdict, never the
 * key. `adoptFoundVault` reads it again and writes it straight into the
 * router's own config (as `register_remote_vault` does) — the panel, the
 * session and the transcript only ever see the folder and the address.
 *
 * Scope, said plainly: the folders looked at are the configured vaults root,
 * the folders that hold vaults already registered (local ones, and remote ones
 * whose files sit here), and a `Vaults` folder beside the project or its
 * parent — one level deep each, the folder itself included. The addresses
 * asked are the loopback and the hosts the remote vaults already registered
 * live on (the WireGuard addresses, typically), at the ports the folder's own
 * `data.json` names. Nothing else on the network is scanned.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fetch, Agent } from 'undici';

import { registeredVaultPaths, referenceVaultPath, vaultsRootPath } from './vault-slug.mjs';
import { isWindowsPath, normalizePathForCompare } from './vault-path-identity.mjs';
import { readLocalRestData } from '../registry.mjs';
import { registerRemoteVaultTool } from '../tools/register-remote-vault.mjs';

// The two plugins a vault cannot be routed to without (setup-vault.mjs).
export const REQUIRED_PLUGINS = ['obsidian-local-rest-api', 'mcp-router-bridge'];
// The plugin's own defaults, when its data.json does not name a port.
const DEFAULT_PORT = 27124;
const DEFAULT_INSECURE_PORT = 27123;
const PROBE_TIMEOUT_MS = 1500;
// A folder full of folders (a whole drive named as a root) is not scanned past this.
const MAX_FOLDERS = 60;

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

const libOf = (p) => (isWindowsPath(p) ? path.win32 : path.posix);
const sameKey = (p) => {
  const n = normalizePathForCompare(p);
  return isWindowsPath(p) ? n.replace(/\//g, '\\').toLowerCase() : n;
};
const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folders looked in, deduplicated, in the order given in the header.
 *
 * @param {object} cfg the router config as read from its file
 * @param {string|null} workspace this project's folder
 * @returns {string[]}
 */
export function scanRoots(cfg, workspace) {
  const roots = [];
  const root = vaultsRootPath(cfg);
  if (root) roots.push(root);
  const parentOf = (p) => libOf(p).dirname(p);
  for (const p of registeredVaultPaths(cfg)) {
    if (typeof p === 'string' && p) roots.push(parentOf(p));
  }
  for (const r of Array.isArray(cfg?.remoteVaults) ? cfg.remoteVaults : []) {
    if (r && typeof r.localPath === 'string' && r.localPath) roots.push(parentOf(r.localPath));
  }
  if (typeof workspace === 'string' && workspace) {
    const lib = libOf(workspace);
    roots.push(lib.join(lib.dirname(workspace), 'Vaults'));
    roots.push(lib.join(lib.dirname(lib.dirname(workspace)), 'Vaults'));
  }
  const seen = new Set();

  return roots.filter((r) => {
    const key = sameKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The folders under the roots that are Obsidian vaults (they hold `.obsidian/`).
async function vaultFolders(roots) {
  const found = [];
  const seen = new Set();
  const add = (p) => {
    const key = sameKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(p);
    }
  };
  for (const root of roots) {
    if (!(await isDir(root))) continue;
    const lib = libOf(root);
    if (await isDir(lib.join(root, '.obsidian'))) add(root);
    let children = [];
    try {
      children = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children.slice(0, MAX_FOLDERS)) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue;
      const folder = lib.join(root, child.name);
      if (await isDir(lib.join(folder, '.obsidian'))) add(folder);
    }
  }

  return found;
}

/**
 * Whether `baseUrl` is a Local REST API that accepts `apiKey`: its `GET /`
 * answers `authenticated: true` only for the right key, and the key is a
 * random secret of that one vault — the best proof of identity a folder can
 * give without a server of the router's own.
 *
 * @returns {Promise<'accepted'|'refused'|'unreachable'>}
 */
export async function probeAddress({ baseUrl, apiKey, tlsInsecure }, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      ...(tlsInsecure ? { dispatcher: insecureAgent } : {}),
    });
    const body = await res.json().catch(() => null);
    if (body && typeof body === 'object' && body.authenticated === true) return 'accepted';

    return body && typeof body === 'object' && 'authenticated' in body ? 'refused' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

// The addresses a folder's vault may answer on: the loopback, then each host a
// registered remote vault lives on, at the folder's own ports.
function addressesFor(rest, hosts) {
  const port = rest.port ?? DEFAULT_PORT;
  const insecure = rest.enableInsecureServer ? rest.insecurePort ?? DEFAULT_INSECURE_PORT : null;
  const out = [];
  for (const host of hosts) {
    out.push({ baseUrl: `https://${host}:${port}`, tlsInsecure: true, insecurePort: insecure, isLocal: isLoopback(host) });
    if (insecure) {
      out.push({ baseUrl: `http://${host}:${insecure}`, tlsInsecure: false, insecurePort: null, isLocal: isLoopback(host) });
    }
  }

  return out;
}

function remoteHosts(cfg) {
  const hosts = [];
  for (const r of Array.isArray(cfg?.remoteVaults) ? cfg.remoteVaults : []) {
    try {
      const host = new URL(r.baseUrl).hostname;
      if (host && !isLoopback(host) && !hosts.includes(host)) hosts.push(host);
    } catch {
      /* a malformed baseUrl names no host */
    }
  }

  return hosts;
}

async function pluginIds(folder) {
  const lib = libOf(folder);
  try {
    const entries = await fsp.readdir(lib.join(folder, '.obsidian', 'plugins'), { withFileTypes: true });

    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function enabledPlugins(folder) {
  try {
    const parsed = JSON.parse(await fsp.readFile(libOf(folder).join(folder, '.obsidian', 'community-plugins.json'), 'utf8'));

    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The vault folders found and not registered, each with the address its
 * Obsidian answers on (null when nothing does: closed, or not reachable from
 * here) and what it lacks.
 *
 * @param {{ cfg: object, workspace?: string|null }} opts
 * @param {{ probe?: typeof probeAddress, readRest?: typeof readLocalRestData }} [seams]
 */
export async function findVaults({ cfg, workspace = null }, seams = {}) {
  const probe = seams.probe ?? probeAddress;
  const readRest = seams.readRest ?? readLocalRestData;
  const roots = scanRoots(cfg, workspace);
  // The FOLDERS already registered (local vaults, and remote ones whose files
  // sit here) — paths, not the bindable-name set vault-slug.mjs owns.
  const localFolders = registeredVaultPaths(cfg).filter((p) => typeof p === 'string');
  const remoteFolders = (Array.isArray(cfg?.remoteVaults) ? cfg.remoteVaults : [])
    .map((r) => r?.localPath)
    .filter((p) => typeof p === 'string' && p);
  const known = new Set(localFolders.concat(remoteFolders).map(sameKey));
  const reference = referenceVaultPath(cfg);
  const recommended = reference ? await enabledPlugins(reference) : [];
  const hosts = ['127.0.0.1', ...remoteHosts(cfg)];
  const folders = (await vaultFolders(roots)).filter((f) => !known.has(sameKey(f)) && !(reference && sameKey(f) === sameKey(reference)));

  const vaults = await Promise.all(
    folders.map(async (folder) => {
      const lib = libOf(folder);
      const installed = await pluginIds(folder);
      const rest = await readRest(folder);
      const hasKey = rest.status === 'ok' && !!rest.apiKey;
      let address = null;
      let key = hasKey ? 'unanswered' : 'absent';
      if (hasKey) {
        const tries = addressesFor(rest, hosts);
        const verdicts = await Promise.all(tries.map((a) => probe({ ...a, apiKey: rest.apiKey })));
        const at = verdicts.indexOf('accepted');
        if (at >= 0) {
          const { baseUrl, tlsInsecure, insecurePort, isLocal } = tries[at];
          address = { baseUrl, tlsInsecure, ...(insecurePort ? { insecurePort } : {}), isLocal };
          key = 'accepted';
        } else if (verdicts.includes('refused')) {
          key = 'refused';
        }
      }
      const hasWiki = (await isDir(lib.join(folder, 'wiki-meta'))) || (await isDir(lib.join(folder, 'wiki')));

      return {
        name: lib.basename(folder),
        path: folder,
        hasRestApi: installed.includes('obsidian-local-rest-api'),
        hasBridge: installed.includes('mcp-router-bridge'),
        hasWiki,
        missingPlugins: [...new Set([...REQUIRED_PLUGINS, ...recommended])].filter((id) => !installed.includes(id)),
        address,
        key,
      };
    }),
  );

  // Whether a closed vault can be opened from here: a desktop Obsidian, not a server's containers.
  return { roots, platform: process.platform, vaults };
}

/**
 * Registers a found vault whose Obsidian answers on a non-loopback address
 * (a container): a `remoteVaults` entry with its key read here, its address
 * proven again just before, and `localPath` set to its folder — what
 * `register_remote_vault` + `setup-vault.mjs --attach --local-path` did by
 * hand. A vault answering on the loopback is not registered here: the router
 * adopts it as a local vault (provision_vault on its folder).
 *
 * @param {{ configPath: string, folder: string, baseUrl: string, name?: string }} opts
 */
export async function adoptFoundVault({ configPath, folder, baseUrl, name }, seams = {}) {
  const probe = seams.probe ?? probeAddress;
  const readRest = seams.readRest ?? readLocalRestData;
  const register = seams.register ?? registerRemoteVaultTool;
  if (!configPath) throw new Error('adopt: the router config path is required.');
  if (typeof folder !== 'string' || !folder) throw new Error('adopt: the vault folder is required.');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`adopt: "${baseUrl}" is not an address.`);
  }
  if (isLoopback(url.hostname)) {
    throw new Error('adopt: a vault answering on this machine is adopted as a local vault (provision_vault), not here.');
  }
  const rest = await readRest(folder);
  if (rest.status !== 'ok' || !rest.apiKey) {
    throw new Error(`adopt: no Local REST API key in ${folder} (its plugin settings: ${rest.status}).`);
  }
  const tlsInsecure = url.protocol === 'https:';
  const verdict = await probe({ baseUrl: url.origin, apiKey: rest.apiKey, tlsInsecure });
  if (verdict !== 'accepted') {
    throw new Error(
      verdict === 'refused'
        ? `adopt: ${url.origin} answers but refuses the key of ${folder} — another vault holds that address.`
        : `adopt: nothing answers on ${url.origin} any more.`,
    );
  }
  const insecure = rest.enableInsecureServer ? rest.insecurePort ?? DEFAULT_INSECURE_PORT : null;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

  return register(
    { configPath, vaults: [] },
    {
      name: name || libOf(folder).basename(folder),
      baseUrl: url.origin,
      apiKey: rest.apiKey,
      tlsInsecure,
      ...(tlsInsecure && insecure && insecure !== port ? { insecurePort: insecure } : {}),
      localPath: folder,
      description: 'Found by the vault panel',
    },
  );
}
