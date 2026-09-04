/**
 * register_remote_vault — MCP tool. Register, from the conversation, a REMOTE
 * vault that is ALREADY OPEN and already reachable over the network — without
 * requiring a hand edit of config.json.
 *
 * Decision ergonomie-creation-liaison-vaults §2 (2026-09-04, ACCEPTED). The
 * `remoteVaults` shape already works — registry.mjs has read `{name, baseUrl,
 * apiKey, ...}` since v0.9.0 — what was missing was a way to fill it in from a
 * session rather than editing the file by hand.
 *
 * ALWAYS writes to config.json — the router's OWN config — NEVER to a
 * workspace `.env`: the apiKey is a bearer token, and
 * `transport-des-cles-de-vault` is unconditional about where a key may live.
 *
 * GATED DEPLOYMENTS (OBSIDIAN_ROUTER_USER_ID): registered in LOCAL_ONLY_TOOL_
 * NAMES in src/index.mjs, hidden and refused there — NOT because it touches
 * local disk (it doesn't), but because MCPHub's multi-tenant instances all
 * read the SAME central config.json (registry.mjs, ALLOWED_VAULTS comment).
 * Left open, one tenant could plant a `remoteVaults` entry whose NAME another
 * tenant's OBSIDIAN_ROUTER_ALLOWED_VAULTS happens to include — that tenant's
 * sessions would then be silently routed through a vault (baseUrl + apiKey)
 * the planting tenant chose. plan_vault/provision_vault are excluded for a
 * different reason (they write to the HOST filesystem); this tool joins the
 * same Set for this one.
 */

import { registeredVaultPaths, vaultSlug } from '../helpers/vault-slug.mjs';
import { updateConfigBindings } from '../helpers/workspace-bindings.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';
import { hostIsWireguardOrLoopback, isTruthyEnv } from '../registry.mjs';

/** An absolute http(s) URL — no scheme other than http/https accepted. */
function isHttpUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The port a baseUrl actually serves on — the explicit `:port`, or the
 * scheme's implicit default when omitted (443 for https, 80 for http).
 * `new URL(...).port` is `''` for an implicit-default-port URL, and
 * `Number('')` is `0` — never a valid port — so a bare comparison against
 * `.port` silently never catches a collision on a URL with no explicit port
 * (e.g. "https://vault.example.com" really serves 443, but `.port` says '').
 */
function effectivePort(url) {
  return url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
}

/**
 * @param {object} registry the live registry (used for `configPath`)
 * @param {object} args tool input — see the schema in src/index.mjs
 * @param {{ readFile?: Function, writeFile?: Function }} [seams] test seams,
 *   threaded straight through to updateConfigBindings — omitted in production.
 */
export async function registerRemoteVaultTool(registry, args = {}, seams = {}) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    throw new Error('register_remote_vault requires `name` — the vault name sessions will address it by.');
  }
  const baseUrl = typeof args.baseUrl === 'string' ? args.baseUrl.replace(/\/+$/, '') : '';
  if (!isHttpUrl(baseUrl)) {
    throw new Error(
      'register_remote_vault requires `baseUrl` — an absolute http(s) URL for the ALREADY-OPEN remote vault '
      + '(e.g. "https://10.8.0.5:27125" over WireGuard, or "https://vault.example.com" behind a TLS-terminating proxy).',
    );
  }
  const apiKey = typeof args.apiKey === 'string' ? args.apiKey : '';
  if (!apiKey) {
    throw new Error(
      "register_remote_vault requires `apiKey` — the bearer token from that vault's "
      + "Local REST API plugin settings (.obsidian/plugins/obsidian-local-rest-api/data.json).",
    );
  }

  // FAIL BEFORE WRITING, not after — the same deployment-wide policy
  // loadRegistry enforces at (re)load (registry.mjs's ENFORCE_WG_OR_LOOPBACK
  // section). Skipping this pre-check would let a public-TLS baseUrl (a
  // transport this tool and docs/remote-vaults.md explicitly endorse) get
  // written, return a confident `registered: true`, and then fail silently at
  // the next reload — logged to the server's stderr only, never surfaced to
  // the calling session, leaving the vault permanently unreachable behind a
  // response that claimed success.
  const enforceWgOrLoopback = process.env.OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK
    ?? process.env.OBSIDIAN_ROUTER_REQUIRE_WIREGUARD;
  if (isTruthyEnv(enforceWgOrLoopback) && !hostIsWireguardOrLoopback(baseUrl)) {
    throw new Error(
      `register_remote_vault: OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK is enabled on this deployment, and `
      + `"${safeForMessage(baseUrl, 80)}"'s host is neither loopback (127.0.0.1/::1/localhost) nor in the `
      + 'WireGuard mesh (10.8.0.0/24). Writing this entry would make the router refuse to reload its config '
      + '— refused before writing. Use a loopback or 10.8.0.x address, or ask the operator to disable the check.',
    );
  }

  const entry = { name, baseUrl, apiKey };
  if (typeof args.description === 'string' && args.description !== '') entry.description = args.description;
  // Verify TLS by default — the SAFER default, and a deliberate divergence
  // from buildRemoteVaultEntry's `?? true` (remote-config.mjs): that function
  // builds an entry for a vault WE ALREADY KNOW runs the plugin's self-signed
  // cert (it is exporting a vault from this router's own local fleet). This
  // tool registers a vault a caller merely CLAIMS is reachable at `baseUrl` —
  // which docs/remote-vaults.md Step 3 explicitly expects to sometimes be a
  // real, publicly-trusted TLS certificate behind a reverse proxy — so
  // skipping verification must be opt-in, not assumed.
  entry.tlsInsecure = args.tlsInsecure === true;
  const parsedBaseUrl = new URL(baseUrl);
  if (args.insecurePort !== undefined && args.insecurePort !== null) {
    if (!Number.isInteger(args.insecurePort) || args.insecurePort < 1 || args.insecurePort > 65535) {
      throw new Error('register_remote_vault: `insecurePort` must be an integer in 1..65535.');
    }
    if (args.insecurePort === effectivePort(parsedBaseUrl)) {
      throw new Error(
        `register_remote_vault: "${safeForMessage(name, 60)}" declares the same port ${args.insecurePort} `
        + 'for both baseUrl and insecurePort. One of the two is wrong — re-check that vault\'s data.json.',
      );
    }
    entry.insecurePort = args.insecurePort;
  }
  if (Number.isInteger(args.timeoutMs) && args.timeoutMs > 0) entry.timeoutMs = args.timeoutMs;

  const configPath = registry && registry.configPath;
  if (!configPath) {
    throw new Error('register_remote_vault: the router has no config path — nothing to write into.');
  }

  // CASE-INSENSITIVE, matching vault-slug.mjs's resolveVaultBySlug convention
  // ("NTFS and SMB are, and the slugs are things people type") — NOT the exact
  // match registry.mjs's runtime resolveVault() uses. The two ARE allowed to
  // differ: resolveVault() only needs to find the vault a caller names, so
  // exact match is fine there. This check exists to prevent creating a name a
  // caller did NOT intend — and confirm_workspace_binding / `--attach` resolve
  // names case-insensitively, so "Notes" alongside an existing "notes" would
  // be an unambiguous new vault to resolveVault() while being genuinely
  // ambiguous to every case-insensitive resolver in this codebase. `name` is
  // still STORED with its original casing (case is preserved on what a caller
  // chose, never on the fallback — same rule vaultSlug() itself follows).
  const nameLower = name.toLowerCase();
  const collidesWith = (candidate) => typeof candidate === 'string' && candidate.toLowerCase() === nameLower;
  const collisionMessage = () => (
    `register_remote_vault: "${safeForMessage(name, 60)}" is already a registered vault name `
    + '(matched case-insensitively — vault names are resolved case-insensitively elsewhere in this router). '
    + 'Pick a different `name`, or edit config.json directly to update the existing entry.'
  );

  // AGAINST BOTH THE LIVE REGISTRY AND THE CONFIG JUST RE-READ — same split as
  // confirm_workspace_binding's assertBindable, one file over, and for the same
  // reason. The live registry is what THIS session can already see, including a
  // `VAULT_*` env-var vault, which is never in config.json at all (registry.mjs:
  // "a VAULT_* entry OVERRIDES any same-name vault already added from
  // portRegistry or remoteVaults") — a collision there would not be a security
  // hole, but the newly-written entry would silently lose to the env var at the
  // next reload, which is worth refusing up front rather than shipping quietly
  // broken. The file re-read INSIDE THE LOCK is what catches a race against
  // another session or process writing the same name concurrently.
  const liveNames = registry && Array.isArray(registry.vaults) ? registry.vaults.map((v) => v.name) : [];
  if (liveNames.some(collidesWith)) {
    throw new Error(collisionMessage());
  }

  updateConfigBindings(configPath, (cfg) => {
    const localNames = registeredVaultPaths(cfg).map((vp) => vaultSlug(cfg, vp));
    const remoteVaults = Array.isArray(cfg.remoteVaults) ? cfg.remoteVaults : [];
    if (localNames.some(collidesWith) || remoteVaults.some((r) => r && collidesWith(r.name))) {
      throw new Error(collisionMessage());
    }
    return { ...cfg, remoteVaults: [...remoteVaults, entry] };
  }, seams);

  return {
    registered: true,
    name,
    baseUrl,
    message:
      `Registered remote vault "${name}" in your router config (never in a workspace .env). `
      + 'It becomes reachable within a moment as the router reloads its config — or on the next '
      + 'restart if this server was started with --no-watch.',
  };
}
