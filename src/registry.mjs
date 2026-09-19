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
  portEntryOf,
  detectPortCollisions,
  summarizePortCollisions,
} from './helpers/port-registry.mjs';
import { isWindowsPath, normalizePathForCompare } from './helpers/vault-path-identity.mjs';
import {
  configuredDefaultVault,
  defaultNameFromPath,
  disabledVaultEntries,
  registeredVaultPaths,
  vaultRecordsOf,
  vaultSlug,
  vaultReachMode,
  openVaultEntries,
  alsoWritableEntries,
  alsoLockedEntries,
  bindableVaultNames,
} from './helpers/vault-slug.mjs';
import { isVaultReachable } from './helpers/vault-reach.mjs';
import { buildBindingProposal, declarationRequiredError, canOpenLocally } from './helpers/binding-proposal.mjs';
import { resolveLocalRestState, describeEndpointDrift } from './helpers/rest-endpoint-state.mjs';
import { sameUuid, isValidUuid } from './helpers/vault-identity.mjs';
import { readVaultIdentity } from './vault-identity-store.mjs';
import {
  envKeyOrigin,
  envKeySourceFile,
  dotenvRefusalHint,
  workspaceBindingProposal,
  isGatedDeployment,
} from './helpers/workspace-dotenv.mjs';
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
  readRefusals,
  rawBindingEntry,
  bindingIncoherences,
  describeBindingRepair,
  BINDING_INCOHERENCE,
  registryIncoherences,
  writerBindableNames,
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

/**
 * This workspace's binding, refusals and config AS THE FILE HAS THEM NOW —
 * never the copy parsed at start-up.
 *
 * Roland runs parallel sessions against one config, and `--no-watch` means a
 * session's in-memory copy can be arbitrarily old. Two separate repairs have
 * already been made for exactly that, one field at a time, and this is the
 * shared reader they should have had from the start.
 *
 * No lock is taken: this is a read, and a torn read is impossible because
 * every writer of this file writes it atomically through a rename. When the
 * file cannot be read at all the caller's own copy is returned, so a missing
 * or unreadable config degrades to the previous behaviour instead of throwing
 * on a path whose job is to produce a good error message.
 *
 * @param {string} cfgPath
 * @param {unknown} fallbackConfig the copy to use when the file cannot be read
 * @param {string} cwd
 */
function freshWorkspaceState(cfgPath, fallbackConfig, cwd) {
  let fresh = fallbackConfig;
  let fromFile = false;
  try {
    fresh = JSON.parse(fsSync.readFileSync(cfgPath, 'utf8'));
    fromFile = true;
  } catch { /* keep the copy we have */ }
  return {
    config: fresh,
    fromFile,
    binding: readBinding(fresh, cwd),
    refusals: readRefusals(fresh, cwd),
    // THE ENTRY AS WRITTEN, from the FILE ONLY. `binding` above is the
    // forgiving reading and is what a proposal is minted from; this is what
    // `bindingIncoherences` inspects to decide whether a proposal may be
    // minted at all. When the file could not be read there is nothing honest
    // to inspect — a copy loaded at start-up says nothing about the file now —
    // so the answer is null, a proposal may go out, and the acceptance, which
    // re-reads the file under the write lock, is the door that decides.
    // `undefined` here means "not observed", the same value `rawBindingEntry`
    // uses for "no entry" — and NOT `null`, which since round 10 is a PRESENT
    // entry of the wrong type: the first version put `null` here and an
    // unreadable file was diagnosed as "the entry is not an object at all",
    // a sentence about a file nobody had read. (Codex, round 11.)
    rawEntry: fromFile ? rawBindingEntry(fresh, cwd) : undefined,
  };
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
  const disabled = new Set(disabledVaultEntries(config));
  const skipped = [];

  // --- 1. Local vaults from portRegistry ---
  // THE CONTAINER, THROUGH THE ACCESSOR. `config.portRegistry || {}` accepts
  // anything truthy, and `Object.entries` on a string or an array yields index
  // keys — so `"portRegistry": [27123]` manufactured a vault whose PATH was
  // "0", with a baseUrl of `https://127.0.0.1:null`, and the cascade could
  // hand it back as the default. The `vaultNames` sweep fixed the same shape
  // for `disabledVaults` (where a bare string silently disabled a
  // one-character slug) and for four other keys; this container was the site
  // it did not reach, found by the Codex review of the merge, 2026-09-03.
  // Composed from the accessor rather than adding a second entry point to a
  // helper that already has 211 tests: the keys are validated by
  // `registeredVaultPaths`, and indexing the container with its OWN keys is
  // safe by construction.
  const portRegistry = Object.fromEntries(
    registeredVaultPaths(config).map((vp) => [vp, portEntryOf(config, vp)]),
  );

  // Disk truth for the port-collision report below. Each vault's data.json is
  // read ONCE here and reused for both the apiKey and the two ports — the read
  // was already happening for the key, so the collision detection costs
  // nothing extra at startup.
  const onDiskPorts = new Map();

  // What the user needs told about ports, gathered while the vaults are built:
  // a file that could not be read, a port that is not a port, and above all a
  // port that moved. Carried on the registry the way `portCollisions` is, so
  // `list_vaults` can show it rather than leaving it to be rediscovered by
  // hand. PURELY DESCRIPTIVE — nothing here allocates, repairs or writes
  // (invariant I8, decision D6).
  const portDiagnostics = [];

  // path → the UUID this record is about, for a MIGRATED config only. A legacy
  // config has nothing to compare, and inventing an expectation there would be
  // a guess dressed as a check.
  const migratedVaultIds = new Map(
    (vaultRecordsOf(config) ?? []).map((r) => [r.path, r.vaultId]),
  );

  for (const [vaultPath, value] of Object.entries(portRegistry)) {
    // The config's word on this vault's name, type-checked at the boundary —
    // a hand-edited `"vaultNames": { "<path>": 123 }` falls back to the path
    // instead of travelling on as a vault name. See helpers/vault-slug.mjs.
    const name = vaultSlug(config, vaultPath);

    // READ PORTS FIRST, FILTER SECOND. `disabledVaults` hides a vault from the
    // MCP tool surface — it does NOT stop Obsidian from opening it and binding
    // its two sockets. Skipping the read for disabled vaults left the collision
    // report reasoning from their stale registry declarations instead of what
    // they actually bind, which both invents collisions and misses real ones
    // (pre-release review, 2026-08-30). The `.template` vault is disabled on
    // most fleets and is exactly the one that hands its factory ports to
    // copies. Only the ports are kept here; the apiKey is used below, and a
    // disabled vault still never enters `vaults[]`.
    const restData = await readLocalRestData(vaultPath);
    if (restData.status === 'ok') {
      onDiskPorts.set(vaultPath, { port: restData.port, insecurePort: restData.insecurePort });
    }

    // IS THE VAULT AT THAT PATH STILL THE VAULT THIS ENTRY IS ABOUT?
    //
    // The loader used to answer "whatever is at the registered path", and that
    // is wrong the moment a path is REUSED: move vault A away, put unrelated
    // vault B in its place, and the router served B's port and B's API KEY
    // under A's registration and A's name. Authentication would then confirm B
    // — with B's own key — while the caller believed it had selected A, and a
    // write meant for A would land in B. Found by the adversarial review of
    // this release (finding 1).
    //
    // Only checkable once the registry is keyed by identity: a legacy config
    // has no UUID to compare, so this is skipped there rather than guessed.
    // READ-ONLY, like everything else at load time — a mismatch removes the
    // vault from the served set and says why; it repairs nothing.
    // A VALID UUID, not merely a non-empty key. `setVaultPortEntry` records a
    // vault it cannot yet name under a placeholder like `unstamped:<path>`,
    // which is perfectly truthy — and `sameUuid(realUuid, placeholder)` is
    // always false, so this guard would have declared a mismatch and refused to
    // serve a vault whose registry entry never held a UUID to mismatch against.
    // The same invalid-identifier-comparison class as the `null === null` slip
    // in `setVaultPortEntry` (second adversarial round, finding 2).
    const recordedId = migratedVaultIds.get(vaultPath) ?? null;
    const expectedVaultId = isValidUuid(recordedId) ? recordedId : null;
    if (expectedVaultId) {
      const observed = await readVaultIdentity(vaultPath).catch(() => null);
      if (observed && observed.status === 'ok' && !sameUuid(observed.identity.vaultId, expectedVaultId)) {
        portDiagnostics.push({
          kind: 'identity-mismatch',
          severity: 'error',
          path: vaultPath,
          name,
          message:
            `The directory registered as "${name}" now holds a DIFFERENT vault than the one this ` +
            'record is about — its identity does not match. It has not been served: doing so would ' +
            'hand another vault\'s ports and credential to anything that asked for this name. ' +
            'Nothing was changed; re-register the directory, or point the record at where the ' +
            'original moved.',
        });
        skipped.push({ name, type: 'local', reason: 'identity mismatch at the registered path' });
        continue;
      }
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

    // DISK FIRST, FOR BOTH PROTOCOLS. Until v0.94.0 this line read
    // `entry.https` — the registry only — while the plaintext port two fields
    // below already preferred the disk. The router could therefore read a
    // vault's real HTTPS port, report a drift about it, and go on dialling the
    // old one; moving `recherches-etudes-sup` to 27192 on 2026-09-08 needed
    // BOTH files hand-edited for exactly that reason. `data.json` is what the
    // plugin binds. See helpers/rest-endpoint-state.mjs for the three states a
    // disk can be in and why an absent file and a corrupt one never merge.
    const restState = resolveLocalRestState({
      registryPorts: entry,
      restData,
      restDataStatus: restData.status,
    });
    const port = restState.effectivePorts.https;

    for (const issue of restState.issues) {
      portDiagnostics.push({ ...issue, path: vaultPath, name });
    }
    portDiagnostics.push(
      ...describeEndpointDrift({
        path: vaultPath,
        name,
        registeredPorts: entry,
        effectivePorts: restState.effectivePorts,
        sources: { https: restState.httpsSource, http: restState.httpSource },
      }),
    );

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
      insecurePort: restState.effectivePorts.http,
      // WHETHER that port is being served, as a THIRD value: true / false /
      // null. `enableInsecureServer: false` with a port still recorded is the
      // normal shape of a vault whose plaintext server was turned off, so a
      // number present is never a claim that anything is listening. `null` is
      // "the disk could not be read", which is NOT `false`: click-to-open may
      // still try its remembered number on a best-effort basis, but nothing may
      // tell the user the link is known to work. v0.94.0, lot 1.
      httpEnabled: restState.httpEnabled,
      // WHERE each port came from, carried rather than re-derived downstream.
      // `list_vaults` used to infer it — and inferred `'disk'` for every vault,
      // remote registrations included, which is a claim about a local file that
      // may not exist (adversarial rounds 1 and 2, finding 9). The resolver is
      // the only thing that knows; it says so here.
      httpsSource: restState.httpsSource,
      httpSource: restState.httpSource,
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

  // --- 3. Default vault — 6-tier resolution cascade (tier 0 + five) ---
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
  // Through the accessor (the `vaultNames` sweep). This tier was already safe
  // — `isActive` compares against names this module produced, so a number
  // could never win it — but reading the raw value made that safety
  // accidental, and it is the reason the six readers DOWNSTREAM of the
  // registry never had to care: `registry.defaultVault` is a resolved name,
  // not the config's word.
  const configuredDefault = configuredDefaultVault(config);
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
  // BOTH come back from the same call, and the binding is the one read INSIDE
  // the lock. Rebuilding it here from `bindingImported` — as the first version
  // did — described what this process asked for rather than what the file
  // ended up holding, and the `else` branch read the start-up copy, so a
  // binding another process confirmed in between was ignored all session.
  const {
    imported: bindingImported,
    binding: workspaceBinding,
    refusals: workspaceRefusals,
  } = importDotenvHintOnce(config, cfgPath, vaults);
  // WHICH LINE PROPOSED, and where it came from. A workspace file proposes a
  // vault through its default-vault line OR, failing that, its own lock line —
  // the one the import decides first and the refusal writes beside. Only the
  // FILE's lock counts: a lock the host sets is applied, so calling it a
  // proposal that was not applied would be false. (Phase 6.)
  const proposal = workspaceBindingProposal();
  const bindingHint = classifyBindingHint({
    hint: proposal.hint,
    binding: workspaceBinding,
    isRegistered: (name) => vaults.some((v) => v.name === name),
    // WHERE the proposal came from, from the dotenv loader's own record. The
    // variable reads the same whether this project's file set it or the MCP
    // host did, and the session-start briefing names the file the user should
    // go and edit — so a proposal from the host must not be reported as this
    // project's .env. The loader is the only thing that knows the difference.
    origin: proposal.origin,
    byLock: proposal.byLock,
    // The two halves of a refusal (decision refus-d-une-proposition-de-
    // liaison): the user's config decides, the workspace file only remembers.
    isRefused: (name) => workspaceRefusals.has(name),
    fileRefusal: dotenvRefusalHint(),
  });
  const resolvedDefault = resolveDefaultVaultWithSource({
    vaults,
    configuredDefault,
    binding: workspaceBinding,
    reach: { vaultReach: vaultReachMode(config), openVaults: openVaultEntries(config), workspaceBinding },
  });
  const defaultVault = resolvedDefault.name;

  return {
    configPath: cfgPath,
    // Reachability + the three write tiers (decision portee-et-mode-
    // ecriture-des-vaults, 2026-09-04). Purely config-derived — unlike
    // `lockedVault`/`autoEnrichMode`, nothing in this session can change them
    // at runtime, so they are simply recomputed fresh on every load
    // (including a hot-reload) rather than needing preserve-across-reload
    // logic. `resolveVault()` below reads `this.vaultReach`/`this.openVaults`
    // (static per load) together with `this.workspaceBinding` (live — see
    // helpers/vault-reach.mjs's header for why that one is never baked in).
    vaultReach: vaultReachMode(config),
    openVaults: openVaultEntries(config),
    alsoWritable: alsoWritableEntries(config),
    alsoLocked: alsoLockedEntries(config),
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
    // `workspaceBinding` null means "no binding": vaultReach still determines
    // which vaults are addressable; the cascade picks among that reachable set.
    workspaceBinding,
    // This workspace's canonical key — the same one `workspaceBindings` is
    // indexed by. Carried so a binding proposal can be derived without any
    // call site re-deriving it from `process.cwd()` (a second derivation is a
    // second chance to disagree), and so a test can set it explicitly instead
    // of having to run from a particular directory.
    workspaceKey: canonicalWorkspaceKey(process.cwd()),
    bindingHint,
    // WHICH vaults this workspace REFUSED, from the user's own config — the
    // Map `readRefusals` returns (vault → date), read in the same locked pass
    // as the binding. Carried so `refreshRegistryBindingHint` can re-classify
    // in-session, and replaced by `confirm_workspace_binding` after a refusal
    // or a retraction, exactly like `workspaceBinding` after a confirmation.
    workspaceRefusals,
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
    // What each vault's own configuration says about its ports versus what the
    // router remembered, plus the files that could not be read (v0.94.0, lot
    // 1). Always an array. A drift here has already been ACTED ON — the router
    // is dialling the disk's port — and is reported so the user can choose to
    // refresh the local record, which is a separate, explicit operation.
    portDiagnostics,
    // The parsed configuration, for consumers that must ask it a question the
    // registry does not pre-answer — `list_vaults` reads each vault's RECORDED
    // ports through the accessor to tell a drift from a match. Read-only by
    // convention: everything that WRITES this file goes through `saveConfig`
    // in the CLI, never through a handle taken from here.
    config,
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
      // Reachability (decision portee-et-mode-ecriture-des-vaults §1). A
      // no-op unless `vaultReach: "declared"` is configured — see
      // helpers/vault-reach.mjs. The SINGLE point of passage for this guard:
      // every one of the ~26 call sites that resolve a vault by name goes
      // through this method, so a check placed anywhere else would be the
      // exact "reaches only its first call site" defect class this repo has
      // already paid for four times (see the decision's own trap 1).
      //
      // IT COMES BEFORE THE API-KEY CHECK, and the order is load-bearing
      // (decision proposition-de-liaison-a-l-acces §1, trap 1). "This
      // workspace does not declare this vault" is a question of CONSENT;
      // "this vault has no key on disk" is a question of AVAILABILITY, and
      // the first precedes the second. With the old order, a vault that was
      // both undeclared AND keyless answered with the key message, so the
      // user was sent to re-run setup-vault.mjs for a vault they had simply
      // never bound — and the binding proposal that the refusal is meant to
      // carry never appeared at all. Declaring a vault does not promise it
      // will answer afterwards; that is a different message, at a different
      // moment.
      if (!isVaultReachable(v.name, this)) {
        const preamble = `Vault "${v.name}" is registered but not reachable from this workspace `
          + '(vaultReach: "declared" is active, and this workspace\'s binding does not name it, '
          + 'nor is it in `openVaults`).';
        // THE REFUSAL CARRIES A PROPOSAL — unless the user already said no.
        // (Decision proposition-de-liaison-a-l-acces §2 and §3.)
        //
        // `openVaults` needs no check here: a vault listed there is REACHABLE,
        // so this branch is not taken for it at all. The silence that does need
        // asking for is the durable refusal — decision
        // refus-d-une-proposition-de-liaison is explicit that a vault the user
        // turned down is not put back in front of them, and a tool call the
        // MODEL decided to make is not "the user bringing it up again". The way
        // back is `retract`, and only that.
        //
        // The object is built here and rendered nowhere: turning it into an MCP
        // result happens at the ONE conversion point, the CallTool catch block,
        // so no tool can compose a reply that forgets it.
        // AND THE SENTENCE CHANGES WITH IT, not only the object.
        //
        // The first version dropped `bindingProposal` for a refused vault and
        // left the prose saying "bind this workspace to it with
        // confirm_workspace_binding" — an invitation to re-propose exactly what
        // the user had turned down, in the channel this lot declares
        // AUTHORITATIVE. Silence that is only structured is not silence.
        // (Codex, review of 7571f77.)
        // THE CONSENT IS ASKED OF THE FILE, NOT OF THIS SESSION'S MEMORY, and
        // that was a blocking defect. `accept` was taught to read the file in
        // round three, and the PROPOSING path was left reading the in-memory
        // Map — this repository's signature shape, a fix that reaches only its
        // first site, for the fourth time. Concretely: A and B both run with
        // `--no-watch`, B records a refusal for X, and A goes on OFFERING X,
        // because its Map still predates the refusal. The write was safe (the
        // yes is turned away at the lock) but the CONSENT was not: the user is
        // asked again about a vault they already turned down, which is exactly
        // what the decision's third silence forbids — and then walked into a
        // wall. Reading the file repairs BOTH directions: a refusal recorded
        // elsewhere is honoured here, and a refusal RETRACTED elsewhere stops
        // silencing this session. (Codex, round four.)
        //
        // The live Map is the fallback for an unreadable config only. A
        // refusal must never be forgotten because a file could not be parsed.
        const live = freshWorkspaceState(this.configPath, this.config, process.cwd());
        // A SUCCESSFUL READ BECOMES THIS SESSION'S ANSWER, and that is what
        // makes the fallback honest. The first version consulted the file and
        // threw the answer away, so the map it fell back to when a later read
        // failed was the one loaded at START-UP — not the last state actually
        // observed. A refusal this very session had already seen and honoured
        // could then be forgotten by a single unreadable read, and the vault
        // proposed again. The comment beneath promised it could not.
        //
        // It also repairs a reader the first sweep missed:
        // `refreshRegistryBindingHint` classifies from this same field, so
        // until now the hint could answer "not refused" for a vault the
        // access beside it had just refused as refused. (Codex, round five.)
        //
        // The BINDING is deliberately not adopted here. This is a read path
        // that ends in a throw. THE BINDING IS NOT ADOPTED — it is READ, and
        // used to mint the proposal, which is a different thing and the whole
        // repair of round seven.
        //
        // `registry.workspaceBinding` is not knowledge: `isVaultReachable`
        // consults it on EVERY call, so installing a sibling session's binding
        // silently changes which vaults answer — and round six did exactly
        // that from the acceptance preflight, on a path that then refused. The
        // session could come away with its default vault no longer declared by
        // the binding it had just adopted, so the next unqualified call failed
        // where it had worked. Reachability moves by three authorised routes —
        // this session writing a binding, the user clearing one, and the config
        // watcher reloading the registry — and a refusal is none of them. The
        // rule is about SIDE EFFECTS, not immutability: round 7 first wrote it
        // as "settled once per session", which the watcher makes false.
        // (Codex, rounds seven and eight.)
        //
        // The loop round three fixed is closed HERE instead, at the source:
        // the proposal is minted from the FILE's binding, so re-running a
        // refused call cannot keep handing back the same dead identifier. No
        // session state changes to achieve it.
        if (live.fromFile) this.workspaceRefusals = live.refusals;
        const refused = this.workspaceRefusals?.has?.(v.name) === true;
        // The binding the PROPOSAL is about: the file's when it could be read,
        // this session's otherwise. A local value, deliberately not installed.
        const proposalBinding = live.fromFile ? live.binding : this.workspaceBinding;
        // A PROPOSAL WHOSE ACCEPTANCE CANNOT BE GIVEN IS NOT A PROPOSAL, and
        // the gated deployment is not the only place that is true. Asked here,
        // before the refusal branch, so that a refused vault on a gated
        // deployment is not told to use `retract` — a verb that deployment
        // refuses like every other. (Codex, round four; decision §3, the
        // fourth case.)
        //
        // On a gated deployment EVERY verb of `confirm_workspace_binding` is
        // refused: the workspace there is the server's own directory, shared
        // by every caller, so one answer would stand for all of them. Handing
        // the model an `accept` call that the server will turn away is worse
        // than saying nothing — it spends a conversation turn to arrive at a
        // wall. The refusal stays a refusal.
        if (isGatedDeployment()) {
          throw declarationRequiredError(
            `${preamble} This is a shared deployment, where a workspace binding cannot be recorded `
            + 'at all — the workspace here is the server\'s own directory, and one answer would '
            + 'stand for every caller. Address a vault this deployment already declares, or ask the '
            + 'operator to add it to `openVaults`.',
            null,
          );
        }
        if (refused) {
          throw declarationRequiredError(
            `${preamble} You already REFUSED this vault for this workspace, so it is not being proposed `
            + 'again. If you want it after all, take the refusal back first with '
            + 'confirm_workspace_binding({ retract: … }) — that is the route, and it is the only one '
            + 'to offer. (Binding the vault by name would also drop the refusal, as a side effect of '
            + 'writing a binding, but DO NOT assemble that call for this: passing `vault` REPLACES '
            + 'this workspace\'s primary and drops every secondary not passed again.) Otherwise '
            + 'address a vault this workspace already declares.',
            null,
          );
        }
        // A BINDING WHOSE PRIMARY THIS MACHINE DOES NOT HAVE IS ONE TO REPAIR,
        // NOT ONE TO EXTEND. `proposedRoleFor` answers "secondary" for it and
        // the prose would read "the primary stays <a vault that does not
        // exist>" — an offer to add a secondary to a binding that cannot
        // resolve. The full diagnostic is Phase 6 of the roadmap; until then
        // this refuses to guess, which is strictly better than guessing wrong.
        // (Codex, same review.)
        // A LOCAL VAULT THE CONFIG FILE DOES NOT LIST CANNOT BE BOUND, so it
        // is not proposed either. The live catalogue is wider than the file —
        // it holds vaults the environment alone provides (`VAULT_*`) — and
        // `confirm_workspace_binding` refuses to bind those, because the next
        // start-up would not find them. Offering an identifier for one is
        // offering a yes that the same tool turns away. Same predicate on both
        // sides now, `bindableVaultNames`, rather than two spellings of one
        // question. (Codex, round four.)
        // THE TEST IS "THE FILE DOES NOT LIST IT", AND THE MESSAGE SAYS ONLY
        // THAT. The first wording said the vault was "visible only through the
        // environment" — a claim about PROVENANCE that this condition never
        // establishes, and that was false in the commonest case of all: a vault
        // the file listed at start-up and a sibling session has since removed.
        // A diagnostic that names the wrong cause sends the reader to fix the
        // wrong thing. (Codex, round five — and its own witness had asserted
        // the false sentence, which is how a test locks a mistake in.)
        // THE WRITER'S SET, for every type: a remote the file no longer lists
        // is as unbindable as a local one, and a remote the environment
        // provides is bindable by its `source`. (Round 12 — the exemption
        // remotes had here and in the writer was the hole carried since
        // round 5.)
        if (!writerBindableNames(live.config, this.vaults).has(v.name)) {
          throw declarationRequiredError(
            `${preamble} This vault is not listed in the router's config file (and not provided by the `
            + 'environment) — either it was never registered there, or it has been removed since this '
            + 'session started — so it cannot be recorded in a workspace binding: '
            + 'confirm_workspace_binding refuses a vault the file does not know. Register it '
            + '(setup-vault, or remoteVaults) or restore it in the config, then bind this workspace to it.',
            null,
          );
        }
        // A BINDING THE ROUTER CANNOT READ AS WRITTEN IS ONE TO REPAIR, and no
        // role is proposed on top of it — the accepted decision's third
        // silence, "Mal configuré" rows 1 and 2, honoured as written. Phase 6
        // had measured that `normalizeBinding` absorbs a duplicate before the
        // proposal code can see it, and shipped that absorption as the policy;
        // the round-8 conformance pass found the contradiction, and the
        // decision of 2026-09-18 (Roland, by delegation) is that the accepted
        // text stands: diagnose, spell out the repair, propose nothing.
        //
        // The forgiving reading still ROUTES this session — least privilege
        // is the right reading to act on — and `proposalBinding` above is
        // still that reading. What changes is that a proposal is not minted
        // over a file whose entry says something the router had to repair to
        // read. `rawEntry` is null when the file could not be read, so the
        // acceptance, which re-reads the file inside the write lock, is the
        // door that decides in that case.
        //
        // A missing or empty primary is one of those incoherences, not "no
        // binding": an entry that carries secondaries, a lock or tiers but no
        // primary is a state to read first, not an occasion to create a
        // primary over it (decision point 2 says `primary` for a NULL binding;
        // the drift the conformance pass named as its third).
        const incoherences = bindingIncoherences(live.rawEntry);
        // A PRIMARY NO REGISTRY KNOWS IS NAMED IN THE SAME BREATH. An entry can
        // be both incoherent and broken, and the first version stopped at the
        // duplicate and spelled a repair call naming the unknown primary — a
        // call the tool refuses one step later. The predicate knows no
        // registry, so the fact is injected here, where both are known, and
        // the renderer puts a placeholder in the call. (Codex, round 10.)
        // WHAT THE REGISTRY SAYS ABOUT THE ENTRY'S VAULTS — the writer's own
        // set (`writerBindableNames`: the file's names plus the environment's
        // remotes) and this session's catalogue. Asked whether or not the
        // entry is structurally coherent: a COHERENT binding whose primary the
        // file no longer lists used to be extended with a proposal whose yes
        // the writer then refused, forever (Codex, round 12). Only computed
        // from a file that was read; "not observed" says nothing.
        const facts = live.fromFile
          ? registryIncoherences(live.rawEntry, {
            bindable: writerBindableNames(live.config, this.vaults),
            sessionNames: new Set(this.vaults.map((x) => x.name)),
          })
          : [];
        const unbindableParts = facts.filter((f) => f.kind === BINDING_INCOHERENCE.PRIMARY_NOT_REGISTERED
          || f.kind === BINDING_INCOHERENCE.SECONDARY_NOT_REGISTERED);
        if (incoherences.length || unbindableParts.length) {
          // ONE FUNCTION FOR EVERY DOOR (rounds 11 and 12).
          incoherences.push(...facts);
          // ITS OWN PREAMBLE, naming the source. The shared one says "this
          // workspace's binding does not name it", which the repaired reading
          // of THIS SESSION established — while the file's entry, incoherent,
          // may well name it. Two true sentences read as one false one unless
          // each says what it looked at. (Codex, round 10.)
          throw declarationRequiredError(
            `Vault "${v.name}" is registered but not reachable from this workspace (vaultReach: "declared" `
            + 'is active, and the binding this session routes by does not name it). '
            + describeBindingRepair(live.rawEntry, incoherences),
            null,
          );
        }
        const primary = proposalBinding?.vault;
        const brokenPrimary = typeof primary === 'string' && primary !== ''
          && !this.vaults.some((x) => x.name === primary);
        if (brokenPrimary) {
          // TWO REASONS A PRIMARY IS MISSING FROM THIS CATALOGUE, and only one
          // of them is a broken binding. The predicate above tests THIS
          // SESSION's vault list, which a sibling can have outgrown: register
          // a vault and bind to it while this process runs, and the primary is
          // perfectly real and simply unknown here. Telling that reader "this
          // machine has no such vault, re-confirm the binding" sends them to
          // rewrite a configuration that was right. The file knows which case
          // it is, and `bindableVaultNames` already asks it. (Codex, round 9.)
          const fileHasIt = live.fromFile && bindableVaultNames(live.config).has(primary);
          // THE GENUINELY BROKEN CASE SPELLS THE WHOLE BINDING TO RE-PASS —
          // the decision's own words for this row: "comment le remplacer sans
          // perdre les secondaires … à condition que le message épelle la
          // liaison entière à repasser". The first version said only "naming a
          // registered primary and the secondaries you want to keep", which
          // names nothing (Codex, round 10 — a non-conformity, not a wording).
          // Same renderer as the incoherent branch, with the fact injected;
          // the old sentence stays only for the fallback where the file could
          // not be read and there is no entry to spell.
          throw declarationRequiredError(
            fileHasIt
              ? `${preamble} This workspace's binding names "${primary}" as its primary, and the config `
                + 'file does have it — this session loaded its vault list before that vault existed, and '
                + 'has not picked it up: hot-reload is off here, or has not fired yet. Nothing needs '
                + 'repairing. Retry in a moment, or restart the session.'
              : live.fromFile && live.rawEntry !== undefined
                ? `${preamble} ${describeBindingRepair(live.rawEntry, [
                  { kind: BINDING_INCOHERENCE.PRIMARY_NOT_REGISTERED, names: [primary] },
                ])}`
                // NOT OBSERVED IS NOT "THE FILE HAS NO SUCH VAULT". The first
                // fallback answered "neither this session nor the config
                // file" from the copy loaded at start-up, about a file it had
                // just failed to read. (Codex, round 12.)
                : `${preamble} This workspace's binding names "${primary}" as its primary, which this session `
                + 'does not know — and the config file could not be read just now, so what it currently says '
                + 'is unverified. Nothing can be diagnosed or repaired from an unread file: retry in a moment, '
                + 'or restart the session.',
            null,
          );
        }
        // THE FILE ALREADY DECLARES IT, AND THIS SESSION HAS NOT RELOADED.
        // Minting a proposal here would hand out an identifier the acceptance
        // refuses with "this workspace already declares it" — a wall one turn
        // away, which is the rule the gated branch and the unbindable branch
        // already obey. The useful answer is the true one: the binding is
        // there, this process is the thing that has not caught up.
        if (proposalBinding
          && (proposalBinding.vault === v.name || (proposalBinding.also || []).includes(v.name))) {
          throw declarationRequiredError(
            `${preamble} The config file DOES declare it — another session bound it after this one `
            + 'started, and this process has not picked that up: hot-reload is off here, or has not '
            + 'fired yet. Nothing needs to be accepted. Retry in a moment, restart the session, or '
            + 'address a vault this one already declares.',
            null,
          );
        }
        throw declarationRequiredError(
          `${preamble} Bind this workspace to it with confirm_workspace_binding, add it to `
          + '`openVaults` in config.json, or address a vault this workspace already declares.'
          // PROVENANCE, when the file could not be read: the proposal then
          // rests on the binding this session loaded, and the reader should
          // know the yes may be refused if the file has moved. (Codex, round
          // 12.)
          + (live.fromFile ? '' : ' (The config file could not be read just now, so this proposal rests on '
            + 'the binding this session loaded; if another session has changed it since, the yes will be '
            + 'refused and a fresh proposal handed back.)'),
          buildBindingProposal({
            vault: v.name,
            // THE FILE'S BINDING, not this session's copy — see the comment
            // above `proposalBinding`. The identifier is derived from it, and
            // the acceptance recomputes against the file, so minting from
            // anything else is minting an identifier born dead.
            binding: proposalBinding,
            workspaceKey: this.workspaceKey,
            // A REMOTE vault has no local folder, and the opener skips anything
            // without one — so promising a window for it would be a promise the
            // accept path cannot keep. (Codex, same review.)
            willOpen: canOpenLocally(v),
          }),
        );
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
 * It also returns the binding as seen INSIDE the lock. The caller used to
 * fall back to `readBinding(config, cwd)` on its own stale copy whenever
 * nothing was imported — so a binding another process confirmed between this
 * process's start-up read and the locked re-read was correctly left alone on
 * disk and then ignored for the whole session under `--no-watch`. The locked
 * re-read is the freshest thing this function sees; not handing it back was
 * throwing away the only measurement that was up to date.
 *
 * @param {object} config the parsed config, as read at start-up
 * @param {string} cfgPath
 * @param {Array<{name: string}>} vaults the ACTIVE vault set
 * @returns {{ imported: {vault: string, at: string, locked: boolean, dotenvFile: string|null}|null, binding: object|null }}
 */
function importDotenvHintOnce(config, cfgPath, vaults) {
  const cwd = process.cwd();
  // THE FALLBACK RE-READS THE FILE, it does not hand back the start-up copy.
  //
  // This function can decide it has nothing to do without ever taking the
  // lock — the overwhelmingly common case — and the first version then
  // returned `readBinding(config, cwd)` from the object `loadRegistry` parsed
  // at start-up. Between that parse and this moment, another session's
  // `confirm_workspace_binding` or an `--attach` can have recorded a binding;
  // under `--no-watch` this session would then ignore it for its whole life
  // and route unqualified calls to whatever the cascade picked instead. The
  // repair that made the LOCKED path hand back its fresh read left this path
  // reading the stale one, which is this repository's signature shape: a fix
  // that reaches only its first site. (Codex, round 5.)
  //
  // No lock is taken: this is a read, and a torn read is impossible because
  // every writer of this file writes it atomically through a rename.
  const fallback = () => {
    const { binding, refusals } = freshWorkspaceState(cfgPath, config, cwd);
    return { imported: null, binding, refusals };
  };
  try {
    const key = canonicalWorkspaceKey(cwd);
    if (!key) return fallback();

    // The dotenv file's own mtime — the fact that tells a workspace attached
    // last year from a repository cloned this morning. Read from the file the
    // LOADER actually used, never a path composed here. This is the one input
    // that does not come from the config, so it is gathered out here.
    //
    // BOTH hints are gathered, each with the mtime of the file that actually
    // carried it: `OBSIDIAN_ROUTER_LOCKED` is migrated as well, or an upgrade
    // would silently drop a lock the user had explicitly persisted. They come
    // from the same `.env` in every case the router itself wrote, but the
    // loader is asked separately rather than assumed.
    const mtimeOf = (file) => {
      if (!file) return null;
      try { return fsSync.statSync(file).mtimeMs; } catch { return null; /* gone since it was read */ }
    };
    const dotenvFile = envKeySourceFile('OBSIDIAN_ROUTER_DEFAULT_VAULT');
    const lockFile = envKeySourceFile('OBSIDIAN_ROUTER_LOCKED');
    const dotenvMtimeMs = mtimeOf(dotenvFile);
    const lockMtimeMs = mtimeOf(lockFile);
    // The portable half of a refusal, from the same environment the hint came
    // through. It is joined below with the config's half, which has to be read
    // from the config the decision is taken against — the stale copy for the
    // pre-check, the locked re-read for the decision — so it is not in `hints`.
    const fileRefusal = dotenvRefusalHint();
    const refusedIn = (cfg) => {
      const recorded = readRefusals(cfg, cwd);
      return (name) => name === fileRefusal || recorded.has(name);
    };
    const hints = {
      hint: process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT,
      hintOrigin: envKeyOrigin('OBSIDIAN_ROUTER_DEFAULT_VAULT'),
      dotenvMtimeMs,
      lockHint: process.env.OBSIDIAN_ROUTER_LOCKED,
      lockHintOrigin: envKeyOrigin('OBSIDIAN_ROUTER_LOCKED'),
      lockMtimeMs,
      isRegistered: (name) => vaults.some((v) => v.name === name),
    };

    // A CHEAP PRE-CHECK ON THE STALE CONFIG, to avoid taking the lock for the
    // overwhelmingly common case where there is nothing to do and the window
    // is already open. It decides nothing: every branch below re-decides.
    //
    // `record` and not `import`: a workspace that is ALREADY BOUND has to be
    // written down as considered, or clearing that binding later re-opens the
    // window and the next start puts the binding back.
    const stale = readMigrationState(config);
    const staleDecision = migrationDecision({
      ...hints,
      binding: readBinding(config, cwd),
      openedAt: stale.openedAt,
      alreadyImported: stale.imported.has(key),
      isRefused: refusedIn(config),
    });
    //
    // A verdict that CLOSES the window is only a reason to take the lock when
    // the workspace is not already written down: `already-bound` is a closing
    // verdict on every single start, so without the second clause a bound
    // workspace took the config lock and re-wrote the file once per session,
    // forever. The write itself is now suppressed one floor down
    // (`withMigrationState` returns its input when nothing changes); this
    // avoids even taking the lock, which is the part that makes two sessions
    // starting together wait on each other.
    const nothingToRecord = !staleDecision.record || stale.imported.has(key);
    if (!staleDecision.import && nothingToRecord && stale.openedAt) return fallback();

    // THE DECISION IS RE-TAKEN INSIDE THE LOCK, against the config that
    // `updateConfigBindings` just re-read. Taking the lock is not enough if
    // the decision was made outside it: between this process reading the
    // config at start-up and writing it here, an `--attach` or another
    // session's `confirm_workspace_binding` can have recorded a binding — and
    // a transform that applied a decision computed from the stale copy would
    // overwrite that binding with a dotenv hint. That is the lost update the
    // lock exists to prevent, reappearing inside the function that takes it,
    // and it would have let an automatic import silently reverse an explicit
    // human decision. Found by the Codex review of the merge, 2026-09-03.
    const at = new Date().toISOString();
    let imported = null;
    let bindingInLock = null;
    let refusalsInLock = null;
    const next = updateConfigBindings(cfgPath, (cfg) => {
      const fresh = readMigrationState(cfg);
      bindingInLock = readBinding(cfg, cwd);
      refusalsInLock = readRefusals(cfg, cwd);
      const decision = migrationDecision({
        ...hints,
        binding: bindingInLock,
        openedAt: fresh.openedAt,
        alreadyImported: fresh.imported.has(key),
        isRefused: refusedIn(cfg),
      });
      // The window is opened on the FIRST start of this version whatever the
      // decision was — otherwise every later workspace would look like it
      // predates an upgrade that had never been recorded. And a workspace the
      // window has CLOSED for is written down even when nothing was imported:
      // `record` covers "already bound", which is the case a clear used to
      // re-open.
      if (!decision.import) return withMigrationState(cfg, { at, cwd, recordImported: decision.record });
      imported = {
        vault: decision.vault,
        at,
        locked: decision.locked,
        dotenvFile: (decision.locked ? lockFile : dotenvFile) || null,
      };
      return withMigrationState(
        withBinding(cfg, cwd, {
          vault: decision.vault,
          also: [],
          // A LOCK THE WORKSPACE FILE CARRIED COMES ACROSS. Dropping it turned
          // an upgrade into the silent removal of an isolation boundary the
          // user had explicitly persisted.
          locked: decision.locked,
          // NAMED AS AN IMPORT, not as something the user did. Six months
          // later the human reading this config must be able to tell a
          // confirmation they gave from one the router inferred from a file.
          confirmedVia: 'migration',
        }),
        { at, cwd, recordImported: true },
      );
    });
    // The binding as of the LOCKED re-read — fresher than the caller's copy,
    // and the only one that has seen another process's concurrent write. The
    // refusals come from the same read: an import never binds a refused
    // vault, so they are unchanged by the write.
    return {
      imported,
      binding: imported ? readBinding(next, cwd) : bindingInLock,
      refusals: refusalsInLock || readRefusals(next, cwd),
    };
  } catch {
    // Every failure mode — unwritable config, a lock held by another process,
    // a malformed migration block — degrades to "not imported this time". The
    // binding still comes from the copy this process has.
    return fallback();
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
//
// `defaultNameFromPath` itself moved to src/helpers/vault-slug.mjs (v0.90.0)
// and is imported at the top of this file — it was one of SIX identical
// copies, and the module that now owns it also owns the `vaultNames` lookup
// whose result it is the fallback for. It stays re-exported through
// `_internals` below, so existing tests reach it by the same name.

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
function resolveDefaultVaultWithSource({ vaults, configuredDefault, binding = null, reach = {} }) {
  vaults = vaults.filter((v) => isVaultReachable(v.name, reach));
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
      // WHERE IT CAME FROM, so a writer can tell "the file no longer lists
      // this remote" from "the environment provides this remote at every
      // start". Round 12 closed the exemption `assertBindable` gave every
      // remote — a remote a sibling had removed from the file could still be
      // bound, and the next start found no such vault — and this marker is
      // what lets the closure spare the vaults the file never listed at all.
      source: 'env',
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
 * NEVER THROWS, and never collapses its failures into one. The caller used to
 * wrap this in `.catch(() => null)`, which made four different facts — no file,
 * an unreadable file, a corrupt file, and a file whose ports are nonsense —
 * indistinguishable, so the router could not tell "this vault was never set up"
 * from "this vault's configuration was damaged". `status` is that distinction,
 * and `rawPort` / `rawInsecurePort` carry the values BEFORE validation so a
 * present-but-invalid port can be told apart from an absent one.
 * See `helpers/rest-endpoint-state.mjs`, which turns this into a verdict.
 *
 * @returns {{ status: string, apiKey: string|null, port: number|null,
 *             insecurePort: number|null, enableInsecureServer: boolean|null,
 *             rawPort: unknown, rawInsecurePort: unknown }}
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
  const empty = {
    apiKey: null,
    port: null,
    insecurePort: null,
    enableInsecureServer: null,
    rawPort: undefined,
    rawInsecurePort: undefined,
  };

  let raw;
  try {
    raw = await fs.readFile(dataPath, 'utf8');
  } catch (err) {
    // ENOENT is "never configured"; anything else is "configured, but this
    // process cannot see it". Both fall back to the registry, and the user is
    // told which one it was — the two call for different actions.
    return { ...empty, status: err?.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...empty, status: 'invalid' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ...empty, status: 'invalid' };
  }

  return {
    status: 'ok',
    apiKey: data.apiKey || null,
    port: asPort(data.port),
    insecurePort: asPort(data.insecurePort),
    // Strictly `=== true`: the plugin's own DEFAULT_SETTINGS is `false`, so an
    // absent field means off. A port number is not an announcement that the
    // server is on.
    enableInsecureServer: data.enableInsecureServer === true,
    rawPort: data.port,
    rawInsecurePort: data.insecurePort,
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

// Exposed for register_remote_vault (src/tools/register-remote-vault.mjs),
// which pre-checks OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK before writing a new
// remoteVaults entry — reusing the EXACT predicate loadRegistry enforces at
// (re)load, rather than an approximation that could silently disagree with it.
// Without this, a caller could register a public-TLS vault under an
// enforcing deployment, get a confident "registered" response, and only learn
// the vault is permanently unreachable from the server's stderr at the next
// config reload.
export { hostIsWireguardOrLoopback, isTruthyEnv };
