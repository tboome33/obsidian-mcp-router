/**
 * Vault registry loader.
 *
 * Reads ~/.claude/mcp-obsidian/config.json (the same file used by setup-vault.mjs)
 * and produces a flat list of vault descriptors that the rest of the router uses.
 *
 * Supported sources, in order:
 *
 * 1. portRegistry  → local vaults (legacy + current). Resolves API key by reading
 *                    each vault's .obsidian/plugins/obsidian-local-rest-api/data.json.
 * 2. remoteVaults  → explicit { name, baseUrl, apiKey, tlsInsecure?, timeoutMs? } entries.
 *
 * Vault names default to the lowercased basename of the local vault path,
 * unless overridden in `vaultNames` ({ "<path>": "<name>" }).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CONFIG_PATH =
  process.env.OBSIDIAN_ROUTER_CONFIG ||
  path.join(os.homedir(), '.claude', 'mcp-obsidian', 'config.json');

export async function loadRegistry() {
  const raw = await fs.readFile(CONFIG_PATH, 'utf8').catch((err) => {
    throw new Error(
      `Cannot read config at ${CONFIG_PATH} (${err.code}). ` +
        `Run 'node ~/.claude/mcp-obsidian/scripts/setup-vault.mjs <vault-path>' ` +
        `to bootstrap a vault, or set OBSIDIAN_ROUTER_CONFIG to a valid config file.`,
    );
  });

  const config = JSON.parse(raw);
  const vaults = [];

  // --- 1. Local vaults from portRegistry ---
  const portRegistry = config.portRegistry || {};
  const vaultNames = config.vaultNames || {};

  for (const [vaultPath, port] of Object.entries(portRegistry)) {
    const name = vaultNames[vaultPath] || defaultNameFromPath(vaultPath);
    const apiKey = await readLocalApiKey(vaultPath).catch(() => null);

    vaults.push({
      name,
      type: 'local',
      path: vaultPath,
      baseUrl: `https://127.0.0.1:${port}`,
      apiKey,
      tlsInsecure: true,
      timeoutMs: 5000,
      missingApiKey: !apiKey,
    });
  }

  // --- 2. Remote vaults from explicit array ---
  const remotes = Array.isArray(config.remoteVaults) ? config.remoteVaults : [];
  for (const r of remotes) {
    if (!r.name || !r.baseUrl || !r.apiKey) {
      console.error(
        `[registry] Skipping malformed remoteVault entry: ${JSON.stringify(r)}. ` +
          `Required: name, baseUrl, apiKey.`,
      );
      continue;
    }
    vaults.push({
      name: r.name,
      type: 'remote',
      baseUrl: r.baseUrl.replace(/\/$/, ''),
      apiKey: r.apiKey,
      description: r.description,
      tlsInsecure: r.tlsInsecure === true,
      timeoutMs: r.timeoutMs ?? 10000,
      // extraHeaders are merged into every request — used for things like
      // Cloudflare Access service tokens (CF-Access-Client-Id +
      // CF-Access-Client-Secret) when the vault is fronted by an auth
      // gateway. See docs/cloudflare-tunnel.md for the typical recipe.
      extraHeaders:
        r.extraHeaders && typeof r.extraHeaders === 'object'
          ? { ...r.extraHeaders }
          : undefined,
    });
  }

  // --- 3. Defaults ---
  const defaultVault =
    config.defaultVault ||
    vaults.find((v) => v.type === 'local' && !v.missingApiKey)?.name ||
    vaults[0]?.name;

  return {
    configPath: CONFIG_PATH,
    defaultVault,
    vaults,
    resolveVault(name) {
      const target = name || this.defaultVault;
      if (!target) {
        throw new Error('No vault specified and no default vault is configured.');
      }
      const v = this.vaults.find((x) => x.name === target);
      if (!v) {
        const known = this.vaults.map((x) => x.name).join(', ') || '(none)';
        throw new Error(`Unknown vault "${target}". Known vaults: ${known}.`);
      }
      if (v.missingApiKey) {
        throw new Error(
          `Vault "${target}" has no API key on disk. Open Obsidian on this vault, ` +
            `enable Local REST API plugin, then re-run setup-vault.mjs.`,
        );
      }
      return v;
    },
  };
}

function defaultNameFromPath(p) {
  const base = path.basename(p);
  // strip leading dot (.template → template) and lowercase
  return base.replace(/^\./, '').toLowerCase();
}

async function readLocalApiKey(vaultPath) {
  const dataPath = path.join(
    vaultPath,
    '.obsidian',
    'plugins',
    'obsidian-local-rest-api',
    'data.json',
  );
  const raw = await fs.readFile(dataPath, 'utf8');
  const data = JSON.parse(raw);
  return data.apiKey || null;
}
