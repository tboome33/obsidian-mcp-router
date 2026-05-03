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

  // --- 3. Default vault — 5-tier resolution cascade ---
  //
  // Priority (highest first):
  //   1. OBSIDIAN_ROUTER_DEFAULT_VAULT env var — explicit per-process override.
  //      Most useful in a project's .env when the auto-detection (step 2) picks
  //      the wrong vault, or when the project isn't a vault directory.
  //   2. VAULT_PATH env var — auto-detection from the project's .env.
  //      `setup-vault.mjs` writes this into every bootstrapped vault, so opening
  //      Claude Code in a vault directory "just works" with that vault as default.
  //   3. config.defaultVault — explicit global default in
  //      ~/.claude/obsidian-mcp-router/config.json.
  //   4. First healthy local vault — historical fallback.
  //   5. First active vault of any type — last resort.
  //
  // At each step we only honor a candidate if it's actually in the active
  // `vaults[]` set (i.e., not disabled and not removed since the override
  // was written). Local vaults with `missingApiKey: true` ARE eligible for
  // tiers 1, 2, 3 — the user explicitly named/configured them, so respect
  // that choice and let resolveVault() raise a clear error at tool-call
  // time. Tier 4 (the implicit fallback) DOES skip missing-key candidates,
  // so a router with no explicit configuration prefers a healthy vault.
  const configuredDefault = config.defaultVault;
  const defaultVault = resolveDefaultVault({ vaults, configuredDefault });

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
 * Normalize a path for equality comparison, robust across OSes.
 *
 * Windows paths are normalized via `path.win32` and lowercased
 * (NTFS / SMB are case-insensitive). POSIX paths are normalized via
 * `path.posix` and case is preserved (POSIX file systems are
 * case-sensitive).
 *
 * Windows-style paths recognized:
 *   - Drive-letter:           `C:\VAULTS\X`, `C:/VAULTS/X`
 *   - UNC (network share):    `\\server\share\Vault`
 *   - Extended-length prefix: `\\?\C:\path`, `\\?\UNC\server\share\path`
 *
 * Detection is structural — it works correctly even when running under
 * WSL/Linux but the portRegistry contains Windows paths (or vice versa).
 */
function normalizePathForCompare(p) {
  if (!p) return p;
  const isDriveLetter = /^[A-Za-z]:[\\/]/.test(p);
  const isUNC = /^\\\\/.test(p); // `\\server\share\...` or `\\?\...`
  const isWindowsStyle = isDriveLetter || isUNC;
  const lib = isWindowsStyle ? path.win32 : path.posix;
  let n = lib.normalize(p);
  // Strip a trailing separator except for the root marker itself. For UNC
  // the "root" is `\\server\share`, longer than 3 chars, so the >3 guard is
  // safe but a UNC of just `\\s\s` (5 chars) would still be trimmed past
  // the separator — acceptable since we only use this for vault paths,
  // which are always deeper than the share root.
  const sep = isWindowsStyle ? '\\' : '/';
  while (n.length > 3 && (n.endsWith(sep) || n.endsWith('/'))) {
    n = n.slice(0, -1);
  }
  if (isWindowsStyle) n = n.toLowerCase();
  return n;
}

/**
 * Five-tier default-vault resolution. See the call site in loadRegistry() for
 * the full priority order. This function only returns a name that is in the
 * active vaults[] set — disabled or missing-key candidates fall through.
 *
 * Logs a one-line warning to stderr if `OBSIDIAN_ROUTER_DEFAULT_VAULT` is
 * set to a name that doesn't match any active vault, so the user notices
 * their override didn't take effect (typical cause: typo or a vault that
 * was disabled/removed since the override was written).
 */
function resolveDefaultVault({ vaults, configuredDefault }) {
  const isActive = (name) => name && vaults.some((v) => v.name === name);

  // 1. Explicit per-process override
  const envOverride = process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
  if (envOverride) {
    if (isActive(envOverride)) return envOverride;
    console.error(
      `[registry] OBSIDIAN_ROUTER_DEFAULT_VAULT="${envOverride}" does not match any active vault — ` +
        `falling through to other resolution tiers. Active vaults: ` +
        (vaults.map((v) => v.name).join(', ') || '(none)') + '.',
    );
  }

  // 2. VAULT_PATH auto-detection (matches a portRegistry path → vault name)
  const cwdVaultPath = process.env.VAULT_PATH;
  if (cwdVaultPath) {
    const target = normalizePathForCompare(cwdVaultPath);
    const matched = vaults.find(
      (v) => v.type === 'local' && v.path && normalizePathForCompare(v.path) === target,
    );
    if (matched) return matched.name;
    // Don't warn — VAULT_PATH might be set by other tools for other purposes;
    // a non-match here is not necessarily a router config error.
  }

  // 3. Global default from config file
  if (isActive(configuredDefault)) return configuredDefault;

  // 4. First healthy local vault
  const healthyLocal = vaults.find((v) => v.type === 'local' && !v.missingApiKey);
  if (healthyLocal) return healthyLocal.name;

  // 5. First active vault of any type — last resort
  return vaults[0]?.name;
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

// Exposed for tests only — not part of the public API. Consumers should
// only use the named exports above (loadRegistry, resolveConfigPath).
export const _internals = {
  resolveDefaultVault,
  normalizePathForCompare,
  defaultNameFromPath,
  redactSecrets,
};
