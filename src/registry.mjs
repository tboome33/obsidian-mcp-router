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
 * Deployment-wide transport guard: OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK=true
 * makes the router REFUSE TO START if any served vault's baseUrl host is neither
 * loopback (127.0.0.1/::1/localhost) nor in the 10.8.0.0/24 WG mesh. It is a
 * BOOT-TIME CONFIG CHECK on the configured baseUrls — it does NOT require the WG
 * tunnel to be up, and loopback passes (so it is NOT "WireGuard-only"). This is a
 * GLOBAL invariant — it replaces the former per-vault `wireguard` boolean flag
 * (removed; that field is now ignored if still present in a VAULT_* / remoteVaults
 * entry). Rationale: "no vault served over an exposed link" is a deployment policy,
 * not a per-vault attribute (see the vault's wg-mandatory decision note).
 * Renamed from OBSIDIAN_ROUTER_REQUIRE_WIREGUARD in v0.27.0 (that name wrongly
 * implied "WG must be running" and hid that loopback also passes); the old name
 * is still honored as a deprecated alias.
 *
 * Vault names default to the lowercased basename of the local vault path,
 * unless overridden in `vaultNames` ({ "<path>": "<name>" }).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  normalizePortEntry,
  detectPortCollisions,
  summarizePortCollisions,
} from './helpers/port-registry.mjs';
import { isWindowsPath, normalizePathForCompare } from './helpers/vault-path-identity.mjs';
import { envKeyOrigin, envKeySourceFile } from './helpers/workspace-dotenv.mjs';
import { safeForMessage } from './helpers/sanitize.mjs';
import {
  readBinding,
  classifyBindingHint,
  authoritativeDefaultVault,
  authoritativeVaultPath,
  readMigrationState,
  migrationDecision,
  withMigrationState,
  withBinding,
  updateConfigBindings,
  canonicalWorkspaceKey,
} from './helpers/workspace-bindings.mjs';

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.claude',
  'obsidian-mcp-router',
  'config.json',
);

// Module-level latch so the deprecated-env-var warning logs at most ONCE per
// process. loadRegistry re-runs on every config.json hot-reload (the file
// watcher in index.mjs's reload()), and re-logging the deprecation line on
// each reload would spam stderr. Reset only for tests via _internals.
let deprecationWarned = false;

// Same idea for the port-collision report, but a FINGERPRINT rather than a
// boolean: loadRegistry re-runs on every config.json hot-reload, and
// re-printing the whole list each time would bury everything else on stderr —
// while a plain boolean would silence a genuinely NEW collision that appeared
// after an earlier one was repaired. Holds the last reported finding set, or
// null when the fleet last loaded clean. The findings stay available on the
// returned registry (and through `list_vaults`) regardless.
let portCollisionsWarned = null;

export function resolveConfigPath({ configPath } = {}) {
  return configPath || process.env.OBSIDIAN_ROUTER_CONFIG || DEFAULT_CONFIG_PATH;
}

/** A valid TCP port, or null. Used for both ports, from all three sources. */
function asPort(n) {
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
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

  // Disk truth for the port-collision report below. Each vault's data.json is
  // read ONCE here and reused for both the apiKey and the two ports — the read
  // was already happening for the key, so the collision detection costs
  // nothing extra at startup.
  const onDiskPorts = new Map();

  for (const [vaultPath, value] of Object.entries(portRegistry)) {
    const name = vaultNames[vaultPath] || defaultNameFromPath(vaultPath);

    // READ PORTS FIRST, FILTER SECOND. `disabledVaults` hides a vault from the
    // MCP tool surface — it does NOT stop Obsidian from opening it and binding
    // its two sockets. Skipping the read for disabled vaults left the collision
    // report reasoning from their stale registry declarations instead of what
    // they actually bind, which both invents collisions and misses real ones
    // (pre-release review, 2026-08-30). The `.template` vault is disabled on
    // most fleets and is exactly the one that hands its factory ports to
    // copies. Only the ports are kept here; the apiKey is used below, and a
    // disabled vault still never enters `vaults[]`.
    const restData = await readLocalRestData(vaultPath).catch(() => null);
    if (restData) {
      onDiskPorts.set(vaultPath, { port: restData.port, insecurePort: restData.insecurePort });
    }

    // disabledVaults entries can be either the resolved vault NAME or the
    // raw PATH (the registry key). Accepting both is friendlier — users
    // rarely remember the auto-generated name (defaultNameFromPath) but
    // know their vault path.
    if (disabled.has(name) || disabled.has(vaultPath)) {
      skipped.push({ name, type: 'local', reason: 'disabled' });
      continue;
    }
    const apiKey = restData?.apiKey || null;

    // A registry value is either the legacy number or { https, http }; the
    // baseUrl always uses the HTTPS one. `normalizePortEntry` is the single
    // funnel so neither shape can reach the URL template raw — an object
    // interpolated straight into it would yield `https://127.0.0.1:[object
    // Object]`, i.e. a vault that is unreachable for a reason nobody would
    // guess from the error.
    const entry = normalizePortEntry(value);
    const port = entry.https;

    vaults.push({
      name,
      type: 'local',
      path: vaultPath,
      baseUrl: `https://127.0.0.1:${port}`,
      apiKey,
      tlsInsecure: true,
      timeoutMs: 5000,
      missingApiKey: !apiKey,
      // The PLAINTEXT port, carried so click-to-open can still emit a link when
      // this vault's disk cannot be read (unplugged drive, permissions). Disk
      // first — the plugin binds what data.json says — then the registry's
      // remembered number. `click-to-open.mjs` re-reads data.json itself and
      // only reaches for this when that read fails, so a stale registry value
      // can never override a live one. v0.79.0, lot 2.
      insecurePort: asPort(restData?.insecurePort) ?? entry.http ?? null,
    });
  }

  // --- 1b. Port-collision report (v0.77.0) -----------------------------------
  //
  // Two vaults on one port is a silent failure: the second server to start
  // fails to bind and the vault simply looks "offline", with nothing anywhere
  // explaining why. Nine such collisions were measured on a 27-vault fleet on
  // 2026-08-29, one of them making a vault permanently unreachable. This
  // surfaces them at load time — logged to stderr AND carried on the registry
  // so `list_vaults` can show them to the user rather than leaving them to be
  // rediscovered by hand.
  //
  // Non-fatal by design: a collision degrades a vault, it does not make the
  // router unsafe, and refusing to start would take away the very tool needed
  // to diagnose it.
  const portCollisions = detectPortCollisions(config, { onDisk: onDiskPorts });
  // Suppress only an IDENTICAL repeat. A plain boolean latch meant that once
  // any collision had been reported, a DIFFERENT one appearing after a config
  // hot-reload printed nothing at all — the router would know about a new
  // silent-bind failure and say nothing (pre-release review, 2026-08-30).
  // Fingerprinting the finding set keeps reload spam away while letting a
  // changed situation speak; a clean load resets it.
  const collisionFingerprint = portCollisions.map((f) => `${f.kind}:${f.port ?? ''}:${f.vaultPath ?? ''}`).join('|');
  if (portCollisions.length === 0) {
    portCollisionsWarned = null;
  } else if (portCollisionsWarned !== collisionFingerprint) {
    portCollisionsWarned = collisionFingerprint;
    console.error(
      `[registry] Port problems detected — ${summarizePortCollisions(portCollisions)}. ` +
        `Run \`node <router-repo>/scripts/setup-vault.mjs --check-ports\` for the full report.`,
    );
    for (const f of portCollisions) console.error(`[registry]   ${f.severity === 'error' ? '✗' : '!'} ${f.message}`);
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
      // OPTIONAL, and it only ever buys back a click-to-open link. A vault with
      // no local disk has no data.json to read the plaintext port from, so
      // without this field the 13 tools that emit `clickToOpenUrl` emit `null`
      // for it. DECLARING IT IS AN ASSERTION: the emitted link is always
      // `http://127.0.0.1:<port>/…`, so it only works for a reader sitting at
      // the machine running that vault's Obsidian. `baseUrl` says nothing about
      // that — it describes the router's own hop — so it is not consulted.
      // `gen-remote-config.mjs` therefore requires `--with-click-to-open`
      // rather than adding this wherever it finds a port. v0.79.0, lot 2.
      insecurePort: asPort(r.insecurePort),
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

  // --- 2.7. Global transport guard (OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK) ---
  //
  // Opt-in, deployment-wide invariant. Replaces the former per-vault `wireguard`
  // boolean flag (removed). When set truthy — typically on a multi-tenant MCPHub
  // instance whose policy is "no vault may be served over an exposed network
  // link" — the router REFUSES TO START if any served vault's baseUrl host is
  // neither loopback (127.0.0.1/::1/localhost — same-machine, no network
  // exposure, strictly safer than WG) nor inside the 10.8.0.0/24 WireGuard mesh.
  //
  // NOTE — this is a BOOT-TIME CONFIG CHECK on the configured baseUrls, NOT a
  // runtime probe: it does NOT require the WireGuard tunnel to be up, and it does
  // NOT turn WireGuard on. It only validates that every served vault is addressed
  // over loopback or the WG mesh. (Renamed from OBSIDIAN_ROUTER_REQUIRE_WIREGUARD
  // in v0.27.0 — that name wrongly implied "WG must be running" and hid that
  // loopback also passes; the old name is still honored as a deprecated alias.)
  //
  // Fail-closed: a misconfigured vault (public IP, plain LAN like 192.168.x, a
  // typo) can never be SILENTLY served over an exposed link — the operator is
  // forced to fix it. Runs AFTER the ALLOWED_VAULTS filter so only vaults this
  // instance actually serves are validated (a non-WG vault filtered out by the
  // whitelist is not a violation). baseUrl is safe to surface in the error;
  // apiKey is never logged.
  const enforceWgOrLoopback =
    process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK ??
    process.env.OBSIDIAN_ROUTER_REQUIRE_WIREGUARD;
  if (
    !deprecationWarned &&
    process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK == null &&
    process.env.OBSIDIAN_ROUTER_REQUIRE_WIREGUARD != null
  ) {
    deprecationWarned = true;
    console.error(
      `[obsidian-mcp-router] OBSIDIAN_ROUTER_REQUIRE_WIREGUARD is DEPRECATED — ` +
        `renamed to OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK (clearer: loopback also ` +
        `passes, and it is a boot-time config check, not a "WG must be up" switch). ` +
        `The old name still works for now; please migrate.`,
    );
  }
  if (isTruthyEnv(enforceWgOrLoopback)) {
    const offenders = vaults.filter((v) => !hostIsWireguardOrLoopback(v.baseUrl));
    if (offenders.length > 0) {
      const list = offenders.map((v) => `${v.name} (${v.baseUrl})`).join(', ');
      throw new Error(
        `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK is enabled, but ${offenders.length} ` +
          `served vault(s) have a baseUrl host that is neither loopback ` +
          `(127.0.0.1/::1/localhost) nor in the WireGuard mesh (10.8.0.0/24): ${list}. ` +
          `This is a boot-time config check — it does NOT require the WG tunnel to be ` +
          `up. Fix each baseUrl to a loopback or http://10.8.0.x:<port> address, remove ` +
          `the vault, or disable the check. Refusing to start to avoid serving a vault ` +
          `over an exposed (non-WG, non-loopback) link.`,
      );
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
  // Tier 0 of the cascade: what THIS user confirmed, for THIS workspace path,
  // in their own config. Read once here and carried on the registry so the
  // eleven readers — seven of them hooks — never learn the storage shape.
  //
  // THE ONE-TIME IMPORT RUNS FIRST, so a binding it creates is in force for
  // THIS session rather than the next one. Everything it decides lives in
  // `migrationDecision` (pure); this reads the two facts it needs from disk —
  // the dotenv file's mtime and the migration state — and writes the result
  // through the single config writer. Best effort in the strict sense: a
  // config that cannot be written must never stop the router from starting,
  // so the import is simply not recorded and is retried next time.
  const bindingImported = importDotenvHintOnce(config, cfgPath, vaults);
  const workspaceBinding = bindingImported
    ? { vault: bindingImported.vault, also: [], locked: false, confirmedAt: bindingImported.at, confirmedVia: 'migration' }
    : readBinding(config, process.cwd());
  const bindingHint = classifyBindingHint({
    hint: process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT,
    binding: workspaceBinding,
    isRegistered: (name) => vaults.some((v) => v.name === name),
    // WHERE the proposal came from, from the dotenv loader's own record. The
    // variable reads the same whether this project's file set it or the MCP
    // host did, and the session-start briefing names the file the user should
    // go and edit — so a proposal from the host must not be reported as this
    // project's .env. The loader is the only thing that knows the difference.
    origin: envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT'),
  });
  const resolvedDefault = resolveDefaultVaultWithSource({
    vaults,
    configuredDefault,
    binding: workspaceBinding,
  });
  const defaultVault = resolvedDefault.name;

  return {
    configPath: cfgPath,
    defaultVault,
    // The config's own `defaultVault`, carried so a caller that has to re-run
    // the cascade after mutating tier 0 (clearing a binding, in
    // `confirm_workspace_binding`) can pass it back in rather than reaching
    // into the config file a second time.
    configuredDefault,
    // WHICH tier of the cascade answered, and — when it read an environment
    // variable — whether that variable came from the workspace `.env` or from
    // the host. Surfaced by `list_vaults`; see the decision
    // `liaison-workspace-vault-hors-depot`.
    defaultVaultSource: { origin: resolvedDefault.origin, variable: resolvedDefault.variable },
    // WHAT this workspace is bound to, and what its dotenv file proposed.
    // Two SEPARATE fields, never folded into `defaultVaultSource`: a hint that
    // was not applied is not the source of what replaced it — the rule v0.89.0
    // established one setting over, applied here unchanged.
    // `workspaceBinding` null means "no binding": every registered vault stays
    // addressable and the cascade picks the default. That is the third state,
    // "all vaults" — never "no vault".
    workspaceBinding,
    bindingHint,
    // What the ONE-TIME import created during THIS start-up, or null. The
    // decision's requirement that the router "name everything it imported":
    // an import nobody is told about is a decision made on the user's behalf
    // in silence, which is what this whole lot exists to stop.
    bindingImported,
    vaults,
    skipped,
    // Port collisions + registry drift found at load time (v0.77.0). Always
    // an array, empty when the fleet is clean, so consumers never branch on
    // "field missing". Surfaced to the user through `list_vaults`.
    portCollisions,
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
 * Run the ONE-TIME import of this workspace's dotenv hint, and return what it
 * created — or null when it created nothing.
 *
 * The rules are all in `migrationDecision`; this is the I/O around them. It
 * NEVER throws: the router starting is more important than the import running,
 * and an import that could not be recorded is retried at the next start rather
 * than half-applied.
 *
 * @param {object} config the parsed config, as read at start-up
 * @param {string} cfgPath
 * @param {Array<{name: string}>} vaults the ACTIVE vault set
 * @returns {{ vault: string, at: string, dotenvFile: string|null }|null}
 */
function importDotenvHintOnce(config, cfgPath, vaults) {
  try {
    const cwd = process.cwd();
    const key = canonicalWorkspaceKey(cwd);
    if (!key) return null;
    const state = readMigrationState(config);

    // The dotenv file's own mtime — the fact that tells a workspace attached
    // last year from a repository cloned this morning. Read from the file the
    // LOADER actually used, never a path composed here.
    const dotenvFile = envKeySourceFile('OBSIDIAN_ROUTER_DEFAULT_VAULT');
    let dotenvMtimeMs = null;
    if (dotenvFile) {
      try { dotenvMtimeMs = fsSync.statSync(dotenvFile).mtimeMs; } catch { /* gone since it was read */ }
    }

    const decision = migrationDecision({
      binding: readBinding(config, cwd),
      hint: process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT,
      hintOrigin: envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT'),
      isRegistered: (name) => vaults.some((v) => v.name === name),
      dotenvMtimeMs,
      openedAt: state.openedAt,
      alreadyImported: state.imported.has(key),
    });

    // The window is opened on the FIRST start of this version whatever the
    // decision was — otherwise every later workspace would look like it
    // predates an upgrade that had never been recorded.
    const at = new Date().toISOString();
    if (!decision.import) {
      if (!state.openedAt) {
        try { updateConfigBindings(cfgPath, (cfg) => withMigrationState(cfg, { at })); } catch { /* next time */ }
      }
      return null;
    }

    updateConfigBindings(cfgPath, (cfg) => withMigrationState(
      withBinding(cfg, cwd, {
        vault: decision.vault,
        also: [],
        locked: false,
        // NAMED AS AN IMPORT, not as something the user did. Six months later
        // the human reading this config must be able to tell a confirmation
        // they gave from one the router inferred from a file.
        confirmedVia: 'migration',
      }),
      { at, cwd, recordImported: true },
    ));
    return { vault: decision.vault, at, dotenvFile: dotenvFile || null };
  } catch {
    // Every failure mode — unwritable config, a lock held by another process,
    // a malformed migration block — degrades to "not imported this time".
    return null;
  }
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
// Moved to src/helpers/vault-path-identity.mjs (v0.77.0) so the port helpers
// can reuse it without importing this module, which imports THEM. The doc
// block above stays here because it documents why the callers below need it.
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
// Implementation moved to src/helpers/vault-path-identity.mjs (v0.77.0) and
// imported at the top of this file — same function, one definition. Still
// re-exported through `_internals` below, so existing tests reach it unchanged.

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
  return resolveDefaultVaultWithSource({ vaults, configuredDefault }).name;
}

/**
 * The same cascade, saying WHICH tier answered — the "provenance" lot of the
 * accepted decision `liaison-workspace-vault-hors-depot`. Two of the five
 * tiers read an environment variable, and a variable can come from the
 * workspace `.env` of a cloned repository as easily as from the MCP host; the
 * `origin` says which, through the loader's own record.
 *
 * `resolveDefaultVault` stays the name-only function it always was: a dozen
 * cascade tests call it directly, and the cascade is not what changes here.
 *
 * @returns {{ name: string|undefined, origin: string, variable: string|null }}
 */
function resolveDefaultVaultWithSource({ vaults, configuredDefault, binding = null }) {
  const isActive = (name) => name && vaults.some((v) => v.name === name);
  const fromEnv = (variable) => ({ origin: envKeyOrigin(variable), variable });

  // 0. THE CONFIRMED BINDING — the user's own answer, from the user's own
  //    config, for this exact workspace path. It outranks the environment
  //    because it is the only tier that cannot have arrived with a `git clone`:
  //    the config file that holds it is never synchronised between machines.
  //    Accepted decision `liaison-workspace-vault-hors-depot`, points 1-2.
  //
  //    Checked against the ACTIVE set like every other tier: a binding whose
  //    vault was since disabled or removed falls through rather than bricking
  //    the session, the same friendly failure the other tiers already have.
  if (binding && isActive(binding.vault)) {
    return { name: binding.vault, origin: 'binding', variable: null };
  }

  // 1. Explicit per-process override — FROM THE HOST ONLY.
  //    `authoritativeDefaultVault` is the gate: it returns the value when the
  //    MCP host, a launcher or a shell set it, and null when the loader
  //    recorded taking it from this project's own `.env`. A workspace file
  //    therefore PROPOSES and never decides, which is what the accepted
  //    decision says and what `bindingHint` has been reporting all along.
  //
  //    Until the Codex review of 2026-09-03 this tier applied the variable
  //    whatever had set it, so `list_vaults` and the session briefing reported
  //    a hint as "not applied" while it was deciding the default vault. Both
  //    halves were individually defensible; the lie lived in the gap.
  const envOverride = authoritativeDefaultVault();
  if (envOverride) {
    if (isActive(envOverride)) return { name: envOverride, ...fromEnv('OBSIDIAN_ROUTER_DEFAULT_VAULT') };
    // Sanitised: this value comes from the workspace .env as often as not, and
    // a raw escape sequence here erases whatever the loader printed above it.
    // Third of the three sister warnings built from an untrusted workspace
    // value; the other two are validateLock and validateAutoEnrichMode.
    console.error(
      `[registry] OBSIDIAN_ROUTER_DEFAULT_VAULT="${safeForMessage(envOverride, 200)}" does not match any active vault — ` +
        `falling through to other resolution tiers. Active vaults: ` +
        (vaults.map((v) => v.name).join(', ') || '(none)') + '.',
    );
  }

  // 2. VAULT_PATH auto-detection (matches a portRegistry path → vault name).
  //    GATED since round 2 of the Codex review (2026-09-03): from a workspace
  //    file this is honoured only when it names the workspace itself — the
  //    "current directory IS a vault" case the spec meant — never another
  //    registered vault. Otherwise a cloned repository's `.env` chose the
  //    default through this tier after tier 1 had just refused it.
  const cwdVaultPath = authoritativeVaultPath(process.cwd());
  if (cwdVaultPath) {
    const target = normalizePathForCompare(cwdVaultPath);
    const matched = vaults.find(
      (v) => v.type === 'local' && v.path && normalizePathForCompare(v.path) === target,
    );
    if (matched) return { name: matched.name, ...fromEnv('VAULT_PATH') };
    // Don't warn — VAULT_PATH might be set by other tools for other purposes;
    // a non-match here is not necessarily a router config error.
  }

  // 3. Global default from config file
  if (isActive(configuredDefault)) return { name: configuredDefault, origin: 'config', variable: null };

  // 4. First healthy local vault
  const healthyLocal = vaults.find((v) => v.type === 'local' && !v.missingApiKey);
  if (healthyLocal) return { name: healthyLocal.name, origin: 'first-healthy', variable: null };

  // 5. First active vault of any type — last resort.
  // Decided on the ARRAY, not on the truthiness of the name: the function this
  // one replaces returned `vaults[0]?.name` verbatim, so an empty-string or
  // null name must come back unchanged rather than collapse to undefined.
  if (vaults.length > 0) return { name: vaults[0].name, origin: 'first-active', variable: null };
  return { name: undefined, origin: 'unset', variable: null };
}

/**
 * Loose truthy parse for string env vars ("true"/"1"/"yes"/"on", case-insensitive).
 * Anything else (including undefined) is false. Used by the global WireGuard
 * enforcement switch (OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK, alias OBSIDIAN_ROUTER_REQUIRE_WIREGUARD).
 */
function isTruthyEnv(val) {
  if (typeof val !== 'string') return false;
  const v = val.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * True when a baseUrl's host is allowed under the WireGuard-only policy:
 * either loopback (same-machine, no network exposure — strictly safer than WG)
 * or inside the 10.8.0.0/24 WireGuard mesh. A malformed baseUrl (unparseable)
 * is treated as NOT allowed → fail-closed under enforcement.
 *
 * The 10.8.0.0/24 subnet is the project's WG mesh (the whole mesh, including
 * the Dedibox peer, lives in this /24 — see wg-firewall-preflight).
 *
 * SECURITY: the subnet test must be an ANCHORED IPv4 match, NOT a textual
 * `startsWith('10.8.0.')`. A prefix check would accept a DNS hostname that
 * merely begins with the prefix (e.g. `10.8.0.evil.com`) and let it pass the
 * fail-closed guard over a non-WireGuard link. The regex requires a literal
 * 4th octet (0-255) and end-of-string, so only real 10.8.0.0/24 IPv4 addresses
 * match. (review+ convergent BLOCKER, 2026-06-03.)
 *
 * Note: `new URL()` first NORMALIZES IPv4 hex/octal/32-bit forms to canonical
 * dotted-decimal (`0xc0a8000a` → `192.168.0.10`, `012.8.0.5` → `10.8.0.5`)
 * before the regex runs. So an in-mesh address written in hex still matches
 * (safe — it really routes into the /24), and an out-of-mesh address in hex
 * normalizes out of `10.8.0.x` and is rejected (fail-closed preserved).
 */
function hostIsWireguardOrLoopback(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  // URL() may bracket IPv6 hosts ([::1]) — strip for comparison.
  const h = host.replace(/^\[|\]$/g, '');
  if (h === '127.0.0.1' || h === '::1' || h === 'localhost') return true;
  return /^10\.8\.0\.(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(h);
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
 *                  "apiKey":"<token>"}
 *
 * Required: name, baseUrl, apiKey (apiKey = the BARE token; the router adds
 * `Authorization: Bearer ` itself). Optional: description, tlsInsecure,
 * timeoutMs, extraHeaders. (The former per-vault `wireguard` boolean is GONE —
 * WireGuard is now a deployment-wide invariant enforced globally via
 * OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK in loadRegistry; a leftover `wireguard` key
 * in the JSON is simply ignored.) On MCPHub the descriptor reduces to the 3
 * required fields: tlsInsecure/https only apply to the local-HTTPS-loopback case,
 * not to the http-over-WG hop.
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
      // Parity with remoteVaults — see the note there. Optional, and declaring
      // it asserts that readers sit at the machine running this vault's Obsidian.
      insecurePort: asPort(parsed.insecurePort),
    };

    envVaults.push(descriptor);
  }

  return { envVaults, warnings };
}

/**
 * One read of a vault's Local REST API `data.json`, yielding the three fields
 * the registry needs: the API key and BOTH ports.
 *
 * Widened from the former `readLocalApiKey` so the port-collision report costs
 * no extra I/O — the file was already being opened for the key. Only these
 * three fields leave the function: the same file also holds the vault's TLS
 * private key, which must never travel further than this parse.
 *
 * @returns {{ apiKey: string|null, port: number|null, insecurePort: number|null }}
 */
async function readLocalRestData(vaultPath) {
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
  return {
    apiKey: data.apiKey || null,
    port: asPort(data.port),
    insecurePort: asPort(data.insecurePort),
  };
}

// Exposed for tests only — not part of the public API. Consumers should
// only use the named exports above (loadRegistry, resolveConfigPath).
export const _internals = {
  resolveDefaultVault,
  resolveDefaultVaultWithSource,
  normalizePathForCompare,
  defaultNameFromPath,
  pathBasename,
  redactSecrets,
  parseEnvVaults,
  isTruthyEnv,
  hostIsWireguardOrLoopback,
  // Test-only: reset the once-per-process deprecation-warning latch so a test
  // can assert the warning fires (and fires only once) deterministically.
  __resetDeprecationWarningForTests: () => {
    deprecationWarned = false;
  },
  // Same, for the once-per-process port-collision report.
  __resetPortCollisionWarningForTests: () => {
    portCollisionsWarned = null;
  },
};

// Exposed for the list_vaults tool which needs the on-disk casing for the
// `obsidianName` field that feeds the obsidian://open?vault=<name> URI.
export { pathBasename };
