/**
 * Vault registry loader.
 *
 * Reads ~/.claude/obsidian-mcp-router/config.json (the same file used by setup-vault.mjs)
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

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.claude',
  'obsidian-mcp-router',
  'config.json',
);

export function resolveConfigPath({ configPath } = {}) {
  return configPath || process.env.OBSIDIAN_ROUTER_CONFIG || DEFAULT_CONFIG_PATH;
}

export async function loadRegistry({ configPath } = {}) {
  const cfgPath = resolveConfigPath({ configPath });
  const raw = await fs.readFile(cfgPath, 'utf8').catch((err) => {
    throw new Error(
      `Cannot read config at ${cfgPath} (${err.code}). ` +
        `Run 'node <router-repo>/scripts/setup-vault.mjs <vault-path>' ` +
        `to bootstrap a vault, or pass --config <path> / set OBSIDIAN_ROUTER_CONFIG.`,
    );
  });

  const config = JSON.parse(raw);
  const vaults = [];
  const disabled = new Set(
    Array.isArray(config.disabledVaults) ? config.disabledVaults : [],
  );
  const skipped = [];

  // --- 1. Local vaults from portRegistry ---
  const portRegistry = config.portRegistry || {};
  const vaultNames = config.vaultNames || {};

  for (const [vaultPath, port] of Object.entries(portRegistry)) {
    const name = vaultNames[vaultPath] || defaultNameFromPath(vaultPath);
    // disabledVaults entries can be either the resolved vault NAME or the
    // raw PATH (the registry key). Accepting both is friendlier — users
    // rarely remember the auto-generated name (defaultNameFromPath) but
    // know their vault path.
    if (disabled.has(name) || disabled.has(vaultPath)) {
      skipped.push({ name, type: 'local', reason: 'disabled' });
      continue;
    }
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
      // Redact secrets before logging — the malformed entry can contain
      // apiKey or extraHeaders.{CF-Access-Client-Secret, ...} that we
      // must never write to logs.
      const safe = redactSecrets(r);
      console.error(
        `[registry] Skipping malformed remoteVault entry: ${JSON.stringify(safe)}. ` +
          `Required: name, baseUrl, apiKey.`,
      );
      continue;
    }
    if (r.enabled === false || disabled.has(r.name)) {
      skipped.push({ name: r.name, type: 'remote', reason: 'disabled' });
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
  // Honor config.defaultVault only if it's still in the active set —
  // otherwise the user disables a vault and every tool call that omits the
  // `vault` argument fails with "Unknown vault". Fall back to the first
  // healthy local vault, then to the first active vault of any type.
  const configuredDefault = config.defaultVault;
  const isConfiguredDefaultActive =
    configuredDefault && vaults.some((v) => v.name === configuredDefault);

  const defaultVault =
    (isConfiguredDefaultActive && configuredDefault) ||
    vaults.find((v) => v.type === 'local' && !v.missingApiKey)?.name ||
    vaults[0]?.name;

  return {
    configPath: cfgPath,
    defaultVault,
    vaults,
    skipped,
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

/**
 * Returns a shallow copy of a remoteVault entry with sensitive fields
 * (apiKey, extraHeaders.*) replaced by "<redacted>". Used before logging
 * malformed entries — never write a user's API key or Cloudflare Access
 * service-token secret to a logfile or terminal.
 */
function redactSecrets(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  if ('apiKey' in out) out.apiKey = '<redacted>';
  if (out.extraHeaders && typeof out.extraHeaders === 'object') {
    out.extraHeaders = Object.fromEntries(
      Object.keys(out.extraHeaders).map((k) => [k, '<redacted>']),
    );
  }
  return out;
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
