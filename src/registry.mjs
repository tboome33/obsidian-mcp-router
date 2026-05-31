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
 * 3. VAULT_* env   → one env var per vault (VAULT_<NAME>=<JSON>), editable straight
 *                    from the MCPHub dashboard. Same descriptor shape as a
 *                    remoteVaults entry; merged as a 3rd source that OVERRIDES any
 *                    same-name vault from sources 1-2. Opt-in: with no VAULT_* set,
 *                    behavior is byte-identical to v0.19.x. (v0.20.0)
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

  // --- 2.5. VAULT_* env-var vaults (v0.20.0, 3rd config source, opt-in) ---
  //
  // One env var per vault (`VAULT_<NAME>=<JSON>`), editable directly from the
  // MCPHub server's Environment Variables UI — no SSH + config.json edit. See
  // parseEnvVaults() for the schema + defensive parsing.
  //
  // ADDITIVE and OPT-IN: with no VAULT_* var set, parseEnvVaults returns [] and
  // this block is a no-op → behavior is byte-identical to v0.19.x (the
  // non-negotiable "local mode stays unchanged" constraint).
  //
  // Precedence (decided 2026-05-31): a VAULT_* entry OVERRIDES any same-name
  // vault already added from portRegistry or remoteVaults; the existing
  // portRegistry-vs-remoteVaults ordering is left untouched. Among VAULT_* keys
  // themselves, the last in sorted-key order wins (parseEnvVaults sorts).
  //
  // CRITICAL ordering: this MUST run BEFORE the ALLOWED_VAULTS whitelist (2.6)
  // and resolveDefaultVault() (3) — a VAULT_* vault must be filterable by the
  // whitelist and selectable as the default (same rationale as the R3 note).
  const { envVaults } = parseEnvVaults(process.env);
  for (const ev of envVaults) {
    const clashIdx = vaults.findIndex((v) => v.name === ev.name);
    if (clashIdx !== -1) {
      console.error(
        `[registry] VAULT_* env var "${ev.name}" overrides a same-name vault ` +
          `already in the registry.`,
      );
      vaults.splice(clashIdx, 1);
    }
    // disabledVaults (config.json) can disable an env vault by name too.
    if (disabled.has(ev.name)) {
      skipped.push({ name: ev.name, type: 'remote', reason: 'disabled' });
      continue;
    }
    vaults.push(ev);
  }

  // --- 2.6. Whitelist filtering via OBSIDIAN_ROUTER_ALLOWED_VAULTS (v0.9.0, opt-in) ---
  //
  // When the env var is set (CSV list of vault names), the registry only
  // exposes those vaults — everything else is moved to `skipped[]` with
  // reason "not in allowed vaults whitelist". When unset/empty, the
  // registry behaves exactly as v0.8.x (no filtering).
  //
  // Used by the v0.9.0 multi-tenant deployment on MCPHub: each registered
  // instance gets its own `OBSIDIAN_ROUTER_ALLOWED_VAULTS` env so that
  // `obsidian-router-Roland` only sees Roland's vaults, `obsidian-router-Karine`
  // only Karine's, etc. — even though they all read the same central config.json.
  //
  // CRITICAL ordering: this MUST run BEFORE `resolveDefaultVault()` below,
  // otherwise `configuredDefault` could resolve to a vault that gets filtered
  // out right after, and tier-3 of the cascade would silently pick a vault
  // the user filtered away. See `2026-05-21-codex-audit.md` risk R3.
  const allowedVaultsEnv = process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS;
  if (allowedVaultsEnv && allowedVaultsEnv.trim().length > 0) {
    const allowed = new Set(
      allowedVaultsEnv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    // Iterate in reverse so splice() index math stays correct.
    for (let i = vaults.length - 1; i >= 0; i -= 1) {
      const v = vaults[i];
      if (!allowed.has(v.name)) {
        skipped.push({
          name: v.name,
          type: v.type,
          reason: 'not in OBSIDIAN_ROUTER_ALLOWED_VAULTS whitelist',
        });
        vaults.splice(i, 1);
      }
    }
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

/**
 * Detect Windows-style paths structurally so we can route to the correct
 * `path` module regardless of runtime. Returns true for:
 *   - Drive-letter:           `C:\VAULTS\X`, `C:/VAULTS/X`
 *   - UNC (network share):    `\\server\share\Vault`
 *   - Extended-length prefix: `\\?\C:\path`, `\\?\UNC\server\share\path`
 *
 * Used by every helper that takes a path which MAY come from the registry
 * config (where Windows paths are stored verbatim even when the runtime
 * is POSIX — e.g., a CI matrix runner on Linux loading a Windows-paths
 * config). Without this, `path.basename` / `path.join` etc. on POSIX would
 * treat `\` as a literal character and produce garbage.
 */
function isWindowsPath(p) {
  if (!p || typeof p !== 'string') return false;
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

function defaultNameFromPath(p) {
  const base = (isWindowsPath(p) ? path.win32 : path.posix).basename(p);
  // strip leading dot (.template → template) and lowercase
  return base.replace(/^\./, '').toLowerCase();
}

/**
 * Path basename with EXACT case preserved — used to derive `obsidianName`
 * for `obsidian://open?vault=<name>` URIs.
 *
 * Why a separate helper from `defaultNameFromPath`:
 *  - `defaultNameFromPath` lowercases + strips leading dot to produce a
 *    router slug (`.template` → `template`, `Roland` → `roland`). Slugs
 *    are stable identifiers across portRegistry/vaultNames maps.
 *  - `pathBasename` preserves the on-disk casing because Obsidian's URI
 *    handler is case-sensitive about the vault label: `obsidian://open?vault=Roland`
 *    works, `obsidian://open?vault=roland` may not match the registered
 *    vault title in the Obsidian config (depends on platform / how the
 *    vault was first opened).
 *
 * Returns the empty string for falsy input — matches `defaultNameFromPath`.
 *
 * Cross-platform detection identical to `defaultNameFromPath`: Windows-style
 * paths route to `path.win32.basename` regardless of runtime, so a CI matrix
 * on Linux reading a Windows-paths config still produces the right result.
 */
function pathBasename(p) {
  if (!p || typeof p !== 'string') return '';
  return (isWindowsPath(p) ? path.win32 : path.posix).basename(p);
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
  const isWindowsStyle = isWindowsPath(p);
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

/**
 * Reserved `VAULT_`-prefixed env var names that are NOT vault configs and must
 * be excluded from the VAULT_* scan. `VAULT_PATH` is the tier-2 default-vault
 * auto-detection hint (a filesystem path, not JSON) that setup-vault.mjs writes
 * into every bootstrapped vault's .env — without this exclusion, every
 * vault-bound session would emit a spurious "not valid JSON" warning.
 */
const RESERVED_VAULT_ENV_KEYS = new Set(['VAULT_PATH']);

/**
 * Parse `VAULT_*` environment variables into vault descriptors — the 3rd config
 * source (after portRegistry + remoteVaults). v0.20.0.
 *
 * Each matching env var holds a JSON object describing one vault, editable
 * directly from the MCPHub server's Environment Variables UI:
 *
 *   VAULT_DEDIBOX={"name":"dedibox","baseUrl":"http://10.8.0.10:27161",
 *                  "apiKey":"<token>","wireguard":true,"tlsInsecure":false,
 *                  "timeoutMs":15000}
 *
 * Required: name, baseUrl, apiKey (apiKey = the BARE token; the router adds
 * `Authorization: Bearer ` itself). Optional: description, wireguard,
 * tlsInsecure, timeoutMs. `wireguard` is security-policy METADATA — the router
 * does not use it to connect (the baseUrl decides that); it drives the
 * defensive check below + the future per-vault firewall.
 *
 * Defensive + non-fatal (mirrors remoteVaults handling): a malformed entry is
 * SKIPPED with a clear stderr warning naming the faulty key — never throws, so
 * one bad env var can't take down the other vaults.
 *
 * SECURITY: on a JSON.parse failure NEITHER the raw value NOR the parser's
 * error message is logged — V8's SyntaxError echoes a snippet of the input
 * (Node ≥19) that can contain the apiKey if the JSON breaks near the token. On
 * a validation failure (parsed but missing a field) the parsed object is
 * redacted via redactSecrets() before logging.
 *
 * Dedup/merge against the other two sources is the caller's job (loadRegistry);
 * this returns descriptors as-is (possibly with duplicate names). `type:
 * 'remote'` because the shape + behavior match a remoteVaults entry.
 *
 * @param {Record<string,string>} [env] - usually process.env.
 * @returns {{ envVaults: object[], warnings: string[] }}
 */
function parseEnvVaults(env = {}) {
  const envVaults = [];
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    console.error(`[registry] ${msg}`);
  };

  // Sort keys for deterministic processing — env iteration order is not
  // guaranteed, and determinism matters for the "last-wins on duplicate name"
  // tie-break during the merge.
  const keys = Object.keys(env)
    .filter((k) => /^VAULT_.+/.test(k) && !RESERVED_VAULT_ENV_KEYS.has(k))
    .sort();

  for (const key of keys) {
    const raw = env[key];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      warn(`${key}: empty value — skipped.`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // SECURITY: never log `raw` OR the parser error — both can echo the
      // apiKey (see the SECURITY note in the docblock).
      warn(
        `${key}: value is not valid JSON (${raw.length} chars) — skipped. ` +
          `It must be a single JSON object; check quoting/commas.`,
      );
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(
        `${key}: JSON must be an object (got ` +
          `${Array.isArray(parsed) ? 'array' : typeof parsed}) — skipped.`,
      );
      continue;
    }

    const missing = ['name', 'baseUrl', 'apiKey'].filter(
      (f) => typeof parsed[f] !== 'string' || parsed[f].trim().length === 0,
    );
    if (missing.length > 0) {
      // SECURITY: log only the KEY NAMES present, never the values — a malformed
      // entry can carry secrets under non-standard keys (e.g. `token`,
      // `password`) that redactSecrets() (apiKey + extraHeaders only) would NOT
      // catch. Key names are enough to spot a typo (`baseURL` vs `baseUrl`).
      warn(
        `${key}: missing/invalid required field(s) [${missing.join(', ')}]; ` +
          `keys present: [${Object.keys(parsed).join(', ')}] — skipped. ` +
          `Required: name, baseUrl, apiKey (apiKey = bare token, no "Bearer ").`,
      );
      continue;
    }

    const descriptor = {
      name: parsed.name.trim(),
      type: 'remote',
      baseUrl: parsed.baseUrl.trim().replace(/\/$/, ''),
      apiKey: parsed.apiKey,
      description:
        typeof parsed.description === 'string' ? parsed.description : undefined,
      wireguard: parsed.wireguard === true,
      tlsInsecure: parsed.tlsInsecure === true,
      // Clamp to a positive timeout — a 0/negative value makes every request
      // abort immediately (the AbortController fires ~now).
      timeoutMs:
        Number.isFinite(parsed.timeoutMs) && parsed.timeoutMs > 0
          ? parsed.timeoutMs
          : 10000,
      // Parity with remoteVaults: pass extraHeaders through so a VAULT_* vault
      // behind Cloudflare Access (CF-Access-Client-Id/Secret) still works.
      extraHeaders:
        parsed.extraHeaders && typeof parsed.extraHeaders === 'object'
          ? { ...parsed.extraHeaders }
          : undefined,
    };

    // Defensive: a wireguard:true vault whose baseUrl host is NOT in the
    // 10.8.0.x WG range is suspicious — sensitive (often medical) data could
    // transit unencrypted on the LAN due to a typo. Warn, but still load it.
    if (descriptor.wireguard) {
      let host = null;
      try {
        host = new URL(descriptor.baseUrl).hostname;
      } catch {
        /* malformed baseUrl — host stays null → treated as out-of-range */
      }
      if (!host || !host.startsWith('10.8.0.')) {
        warn(
          `${key}: wireguard:true but baseUrl host "${host ?? '?'}" is not in ` +
            `the 10.8.0.x WireGuard range — sensitive data may transit ` +
            `unencrypted. Double-check the baseUrl.`,
        );
      }
    }

    envVaults.push(descriptor);
  }

  return { envVaults, warnings };
}

async function readLocalApiKey(vaultPath) {
  // Same cross-platform consideration as defaultNameFromPath: vaultPath
  // may be a Windows-style string from config even when runtime is POSIX
  // (CI matrix on Linux). `path.posix.join` on `C:\VAULTS\X` would produce
  // `C:\VAULTS\X/.obsidian/...` — well-formed in neither universe.
  // Fall through to a real file read either way; the caller's `.catch`
  // will mark the vault `missingApiKey: true` if the path is unreachable
  // from this runtime, which is the honest answer.
  const lib = isWindowsPath(vaultPath) ? path.win32 : path.posix;
  const dataPath = lib.join(
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
  pathBasename,
  redactSecrets,
  parseEnvVaults,
};

// Exposed for the list_vaults tool which needs the on-disk casing for the
// `obsidianName` field that feeds the obsidian://open?vault=<name> URI.
export { pathBasename };
