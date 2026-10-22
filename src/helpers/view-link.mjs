/**
 * view-link helper — talks to the Dedibox "view-agent" HTTP endpoint and returns an
 * ephemeral browser link to a vault's live Obsidian GUI (navigated to a note, auth in
 * the URL). Two layers:
 *
 *   - `fetchViewLink({ vaultName, note, throwOnError, timeoutMs })` — pure transport.
 *     No registry, no arg validation, no result shaping. Used by the `get_view_link`
 *     MCP tool (throwOnError: true → surfaces a clear error).
 *
 *   - `viewLinkForWrite({ vaultName, note })` — the DETERMINISTIC auto-injection used by
 *     the CallTool dispatch after a successful note write (Option B). Returns a
 *     spread-ready `{ viewLink }` / `{ viewLinkError }` / `{}`:
 *       • smart link configured (resolver) — HIGHEST priority        → { viewLink, viewLinkKind:'smart' }
 *       • not configured (no smart link, no VIEW_AGENT_URL)          → {}      (silent)
 *       • housekeeping write (wiki-meta/…) or no note path           → {}      (skipped)
 *       • view-agent configured + returned a link                    → { viewLink, viewLinkKind:'agent' }
 *       • view-agent configured but failed/timed out                 → { viewLinkError }
 *     It NEVER throws — a view-link problem must never break the write that triggered it.
 *
 * Configured via env vars on the router instance:
 *   OBSIDIAN_ROUTER_SMART_LINK_URL    resolver base URL — with OBSIDIAN_ROUTER_SMART_LINK_SECRET,
 *                                     emits stable signed smart links (pure HMAC, no network;
 *                                     takes priority over the view-agent — see smart-link.mjs)
 *   OBSIDIAN_ROUTER_VIEW_AGENT_URL    e.g. http://10.8.0.1:27200   (required for the agent path)
 *   OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE  absolute path of a file holding the shared secret,
 *                                     re-read at every use (preferred: the secret then never sits
 *                                     in the host's settings, which every child process inherits)
 *   OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN  the same secret inline (optional; ignored when _FILE is set)
 * The secret is sent as X-View-Token. All three are settings of the MCP HOST: a workspace .env
 * refuses them (helpers/workspace-dotenv.mjs).
 *
 * WHEN NO LINK CAN BE GIVEN, SAY WHY (2026-10-11). A remote vault has no local click-to-open
 * link, and a router started without the agent URL hides get_view_link — so build_open_link
 * used to answer `clickToOpenUrl: null` and nothing else, and a session concluded "this vault
 * has no link" while the agent was up and one environment variable away. `remoteLinkHint`,
 * `viewAgentStatus` and `probeViewAgentHealth` below are what build_open_link, the read/write
 * results and list_vaults now use to say why the link is empty and how to get one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSmartLink, smartLinkEnabled } from './smart-link.mjs';
import { obsidianNameFor } from './obsidian-name.mjs';

/**
 * Where the view-agent settings belong, said in ONE place so the hint in a tool result,
 * list_vaults and the docs cannot drift apart.
 */
export const VIEW_AGENT_SETUP =
  'Set OBSIDIAN_ROUTER_VIEW_AGENT_URL (the agent\'s address, e.g. http://10.8.0.1:27200) and '
  + 'OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE (absolute path of a file holding the agent\'s token) in the '
  + 'environment the MCP server starts with — its server declaration\'s "env", or the "env" block of the '
  + 'Claude Code settings — never in a workspace .env, which refuses both. Then start a new session (or '
  + 'reload the plugin): get_view_link appears, and note writes carry a viewLink.';

/**
 * The view-agent secret, read AT EACH USE. The file form is preferred and wins when both are set:
 * a user moving the secret out of the settings is the one who set the file, and a stale inline
 * copy must not silently override it.
 *
 * Never throws. `error` says why no token could be read — the caller decides whether that blocks
 * the request (fetchViewLink: it does; sending none would only earn a 401).
 * @param {object} [env]
 * @returns {{token: string|null, source: 'file'|'env'|'none', error?: string, inlineIgnored?: boolean}}
 */
/**
 * A token is sent as an HTTP header, and fetch REFUSES an invalid header value with an error
 * whose message QUOTES the value — which the transport catch below used to copy into
 * viewLinkError and into get_view_link's error, i.e. into the conversation (review of
 * 2026-10-11). A file is exactly where a second line (a comment, a pasted duplicate) slips
 * in, so the value is checked here, before any request, and the error never quotes it.
 * Printable ASCII without spaces: what every token generator emits.
 */
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const UNSAFE_TOKEN = 'holds a space, a line break or a non-ASCII character inside the token (one token, alone on one line)';

export function resolveViewAgentToken(env = process.env) {
  const inline = (env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN || '').trim();
  const file = (env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE || '').trim();
  if (!file) {
    if (!inline) return { token: null, source: 'none' };
    return HEADER_SAFE.test(inline)
      ? { token: inline, source: 'env' }
      : { token: null, source: 'env', error: `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN ${UNSAFE_TOKEN}` };
  }
  const extra = inline ? { inlineIgnored: true } : {};
  // `~/` is expanded because the host settings that carry this value are not read by a shell.
  // Anything else must be absolute: a relative path would resolve against the router's cwd —
  // the workspace, i.e. possibly a cloned repository.
  const p = file === '~' || file.startsWith('~/') || file.startsWith('~\\')
    ? path.join(os.homedir(), file.slice(1))
    : file;
  if (!path.isAbsolute(p)) {
    return { token: null, source: 'file', ...extra, error: 'OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE must be an absolute path (or start with ~/)' };
  }
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return { token: null, source: 'file', ...extra, error: `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE could not be read (${err?.code || 'error'}): ${p}` };
  }
  const token = text.trim();
  if (!token) return { token: null, source: 'file', ...extra, error: `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE is empty: ${p}` };
  if (!HEADER_SAFE.test(token)) return { token: null, source: 'file', ...extra, error: `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN_FILE ${UNSAFE_TOKEN}: ${p}` };
  return { token, source: 'file', ...extra };
}

/**
 * What this router instance knows about its view agent — configuration only, no network.
 * The URL is reported as its origin: the agent's address is not a secret, but nothing else
 * in the value needs repeating. The token is described by its source, never by its value.
 * @param {object} [env]
 */
export function viewAgentStatus(env = process.env) {
  const raw = (env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim();
  const tok = resolveViewAgentToken(env);
  let url = null;
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') url = `${u.protocol}//${u.host}`;
    } catch { /* reported as invalid below */ }
  }
  return {
    configured: !!raw,
    url,
    ...(raw && !url ? { urlInvalid: true } : {}),
    token: tok.source,
    ...(tok.error ? { tokenError: tok.error } : {}),
    ...(tok.inlineIgnored ? { tokenInlineIgnored: true } : {}),
    smartLinks: smartLinkEnabled(env),
  };
}

const HEALTH_TIMEOUT_MS = 2000;

/**
 * GET <agent>/health WITHOUT the token — the route is public on the reference agent, and a
 * health probe that needed the secret could not tell "agent down" from "secret wrong".
 * Short timeout: list_vaults runs it at every session start, in parallel with the pings.
 * Never throws.
 * @returns {Promise<{status: 'not-configured'|'invalid-url'|'ok'|'unreachable'|'error', httpStatus?: number, vaults: string[]|null}>}
 */
export async function probeViewAgentHealth({ env = process.env, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const raw = (env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim();
  if (!raw) return { status: 'not-configured', vaults: null };
  let url;
  try {
    url = new URL('/health', raw.endsWith('/') ? raw : raw + '/');
  } catch {
    return { status: 'invalid-url', vaults: null };
  }
  let res;
  try {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: 'unreachable', vaults: null };
  }
  // A 200 whose body stalls or breaks is not a healthy agent: read failures are failures
  // (Codex review). Only a body that ARRIVED and is not a vault list is tolerated.
  let text;
  try {
    text = await res.text();
  } catch {
    return { status: 'unreachable', httpStatus: res.status, vaults: null };
  }
  if (!res.ok) return { status: 'error', httpStatus: res.status, vaults: null };
  let vaults = null;
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data?.vaults)) vaults = data.vaults.filter((v) => typeof v === 'string');
  } catch { /* a provider is free to answer /health without a vault list */ }
  return { status: 'ok', httpStatus: res.status, vaults };
}

/**
 * Why a REMOTE vault's result carries no click-to-open link, and how to get a link instead —
 * or null when there is nothing to explain (a local vault, or no vault). Two lengths: `brief`
 * rides on every read and write result, so it points at the setup instead of repeating it;
 * the full form is for build_open_link, the tool a session calls when it wants a link.
 * @param {object} o
 * @param {object} o.vault   the resolved descriptor
 * @param {string} [o.note]  vault-relative path, for the ready-made get_view_link call
 * @param {object} [o.env]
 * @param {boolean} [o.brief]
 * @param {boolean} [o.batch]  several notes at once (build_open_link's `paths`)
 * @returns {string|null}
 */
export function remoteLinkHint({ vault, note, env = process.env, brief = false, batch = false } = {}) {
  if (!vault || vault.type !== 'remote' || typeof vault.name !== 'string') return null;
  const name = vault.name;
  // A batch names no single note, and its view links are fetched one note at a time: the agent
  // navigates the vault's single GUI, so N links fetched together would all show the last note.
  const call = batch
    ? 'get_view_link({ vault, note }) once per note (a view link navigates the vault\'s single GUI, so they are not fetched in batch)'
    : `get_view_link(${JSON.stringify(note ? { vault: name, note } : { vault: name })})`;
  const why = brief
    ? `No local click-to-open link for remote vault "${name}"`
    : `Vault "${name}" is remote and declares no insecurePort, so no click-to-open link is emitted: that link is `
      + 'http://127.0.0.1:<port>/mcp-router-bridge/open/… (/open/… on a bridge older than 0.10.0) and only works for a reader sitting at the machine running that vault\'s Obsidian';
  if ((env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim()) {
    // Configured but unusable → say what is wrong, not "call get_view_link", which would fail.
    const st = viewAgentStatus(env);
    if (st.urlInvalid) return `${why}. The view agent is misconfigured: OBSIDIAN_ROUTER_VIEW_AGENT_URL is not a valid http(s) URL.`;
    if (st.tokenError) return `${why}. The view agent is misconfigured: ${st.tokenError}.`;
    return `${why}. For a browser link to the note, call ${call}.`;
  }
  if (smartLinkEnabled(env)) {
    return `${why}. For a browser link to the note, call build_open_link or open_in_obsidian: this router emits smart links.`;
  }
  return brief
    ? `${why}, and this router has no view agent (OBSIDIAN_ROUTER_VIEW_AGENT_URL unset). build_open_link and list_vaults (viewAgent.hint) say how to configure one.`
    : `${why}. And this router instance has no view agent: OBSIDIAN_ROUTER_VIEW_AGENT_URL is unset, so get_view_link is hidden and no viewLink is attached to writes. ${VIEW_AGENT_SETUP}`;
}

/**
 * An EXPLICITLY requested read link for one note (build_open_link): smart link, else the view
 * agent, else nothing. Unlike viewLinkForWrite there is no housekeeping skip — a caller who
 * asks for a link to a wiki-meta/ page gets one — and no short timeout or circuit-breaker:
 * someone is waiting for this link, so a cold tunnel gets its full time, as in open_in_obsidian.
 * `network: false` restricts it to the smart link (pure HMAC) — the batch mode, where one view
 * link per entry would navigate the vault's single GUI N times. Never throws.
 * @returns {Promise<{viewLink?: string, viewLinkKind?: 'smart'|'agent', expiresInSeconds?: number, viewLinkError?: string}>}
 */
export async function explicitReadLink({ vaultName, note, vault, env = process.env, network = true } = {}) {
  if (!vaultName || !note) return {};
  if (smartLinkEnabled(env)) {
    try {
      return {
        viewLink: buildSmartLink({
          baseUrl: env.OBSIDIAN_ROUTER_SMART_LINK_URL,
          vault: vaultName,
          note,
          secret: env.OBSIDIAN_ROUTER_SMART_LINK_SECRET,
        }),
        viewLinkKind: 'smart',
      };
    } catch (err) {
      return { viewLinkError: String((err && err.message) || err).slice(0, 300) };
    }
  }
  if (!network || !(env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim()) return {};
  try {
    const data = await fetchViewLink({ vaultName, note, vault, throwOnError: true });
    return {
      viewLink: data.url,
      viewLinkKind: 'agent',
      ...(typeof data.idle_timeout_s === 'number' ? { expiresInSeconds: data.idle_timeout_s } : {}),
    };
  } catch (err) {
    return { viewLinkError: String((err && err.message) || err).slice(0, 300) };
  }
}

const DEFAULT_PORT_BY_SCHEME = { 'http:': '80', 'https:': '443' };

/**
 * The optional "vault hints" of the /view contract (view-agent repo,
 * docs/CONTRACT.md § Vault hints) for a resolved vault descriptor. They let a
 * provider serve a vault nobody declared to it — a container on its own host,
 * or a desktop Obsidian on a WireGuard peer — by classifying it from what the
 * router already knows.
 *
 * `rest` is REBUILT from the parsed URL's scheme, host and port, never copied
 * from `baseUrl`: whatever else `baseUrl` holds — userinfo, a path, a query, a
 * fragment — stays behind by construction rather than by a strip that could
 * miss one. The port is always explicit (the provider requires one), so a
 * `baseUrl` without a port sends its scheme's default. Only http and https are
 * sent: the provider maps the scheme onto that fixed choice. Nothing here ever
 * reads `apiKey` or `extraHeaders`.
 *
 * `obsidian_name` is the vault's label inside Obsidian (see obsidian-name.mjs).
 *
 * Each hint is independent and omitted when unknown or unparsable — a missing
 * hint degrades to today's behaviour, it never blocks the link.
 * @param {object} [vault]  a registry descriptor
 * @returns {{rest?: string, obsidian_name?: string}}
 */
export function vaultHints(vault) {
  const hints = {};
  if (!vault || typeof vault !== 'object') return hints;
  if (typeof vault.baseUrl === 'string' && vault.baseUrl) {
    let u = null;
    try {
      u = new URL(vault.baseUrl);
    } catch {
      /* unparsable → no rest hint */
    }
    const defaultPort = u ? DEFAULT_PORT_BY_SCHEME[u.protocol] : undefined;
    if (u && defaultPort && u.hostname) {
      hints.rest = `${u.protocol}//${u.hostname}:${u.port || defaultPort}`;
    }
  }
  const obsidianName = obsidianNameFor(vault);
  if (obsidianName) hints.obsidian_name = obsidianName;
  return hints;
}

// First call per vault waits on a cloudflared cold-start (~15s); reused tunnels are
// near-instant. The eager auto-injection blocks the write up to this long ONLY when the
// agent is up but the tunnel is cold (which still yields a link). A DOWN agent fails fast.
const DEFAULT_VIEW_TIMEOUT_MS = 25000;

// The EAGER auto-injection (viewLinkForWrite) blocks the write it rides on, so it uses a
// MUCH shorter timeout than the explicit get_view_link call: a cold tunnel may not finish
// in time (→ {viewLinkError} that turn; the AI can still call get_view_link explicitly for
// the full wait), but a hung/black-holed agent (TCP accepted, never answers — the classic
// over-WireGuard failure) must NOT stall every note write for 25s. (review+ pass 1.)
const EAGER_VIEW_TIMEOUT_MS = 6000;

// Lightweight circuit-breaker for the eager path: after CB_FAILURE_THRESHOLD consecutive
// eager failures, skip the fetch entirely for CB_COOLDOWN_MS so a persistently down/hung
// view-agent costs ZERO latency on writes (instead of EAGER_VIEW_TIMEOUT_MS × every write).
// A single success closes it. GLOBAL, not per-vault: the view-agent is a single shared
// service (one OBSIDIAN_ROUTER_VIEW_AGENT_URL per process), so when it's down it's down for
// every vault — a per-vault breaker would just pay the timeout once per vault before
// protecting. Module-level (per router process); reset for tests.
const CB_FAILURE_THRESHOLD = 3;
const CB_COOLDOWN_MS = 60_000;
let cbConsecutiveFailures = 0;
let cbOpenUntil = 0;

/** Test-only: reset the eager-path circuit-breaker so tests are deterministic. */
export function __resetViewLinkCircuit() {
  cbConsecutiveFailures = 0;
  cbOpenUntil = 0;
}

/**
 * What a failed fetch is reported as. The cause's code when there is one (ECONNREFUSED,
 * UND_ERR_CONNECT_TIMEOUT…), else the message with the token masked: a value fetch rejected
 * is quoted in its error, and that error reaches the conversation.
 */
function transportReason(err, token) {
  const code = err?.cause?.code || err?.code;
  if (code) return String(code);
  let msg = String(err?.message || err || 'error');
  if (token) msg = msg.split(token).join('<token>');
  return msg;
}

/**
 * Pure transport to the view-agent /view endpoint.
 * @param {object}  opts
 * @param {string}  opts.vaultName               canonical vault name (caller already resolved it)
 * @param {string} [opts.note]                   optional vault-relative note path to navigate to
 * @param {object} [opts.vault]                  the resolved descriptor — source of the optional
 *                                               `rest` / `obsidian_name` hints (see vaultHints)
 * @param {boolean}[opts.throwOnError=true]      throw on any failure vs. return null
 * @param {number} [opts.timeoutMs]              fetch timeout override
 * @param {boolean}[opts.casedRetry=false]       internal: this call already retries under the
 *                                               agent's casing of the name, so it does not again
 * @returns {Promise<object|null>}               parsed view-agent JSON ({ url, idle_timeout_s, … }) or null
 */
export async function fetchViewLink({
  vaultName,
  note,
  vault,
  throwOnError = true,
  timeoutMs = DEFAULT_VIEW_TIMEOUT_MS,
  casedRetry = false,
} = {}) {
  // `transient` marks an AGENT-HEALTH failure (unreachable / timeout / 5xx) vs. a per-vault
  // 4xx (e.g. "unknown vault" — the agent doesn't serve THAT vault, a permanent per-vault
  // condition). The eager circuit-breaker only trips on transient failures, so one
  // unsupported vault never suppresses links for healthy vaults (codex review+ pass 3).
  const fail = (msg, { transient = true } = {}) => {
    if (throwOnError) {
      const e = new Error(msg);
      e.viewAgentTransient = transient;
      throw e;
    }
    return null;
  };

  const agentBase = (process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim();
  if (!agentBase) {
    return fail(
      'get_view_link is not configured on this router instance: set ' +
        'OBSIDIAN_ROUTER_VIEW_AGENT_URL (e.g. http://10.8.0.1:27200).',
      { transient: false },
    );
  }

  let url;
  try {
    url = new URL('/view', agentBase.endsWith('/') ? agentBase : agentBase + '/');
  } catch {
    return fail(`OBSIDIAN_ROUTER_VIEW_AGENT_URL is not a valid URL: ${agentBase}`, {
      transient: false,
    });
  }
  url.searchParams.set('vault', vaultName);
  if (note) url.searchParams.set('note', note);
  // Hints describe `vault`; a descriptor for another vault than the one named
  // on the wire would label one vault with another's REST origin — send none.
  const hints = vault && vault.name === vaultName ? vaultHints(vault) : {};
  if (hints.rest) url.searchParams.set('rest', hints.rest);
  if (hints.obsidian_name) url.searchParams.set('obsidian_name', hints.obsidian_name);

  const headers = {};
  // Re-read at every request: a token file rotated on disk is picked up without a restart.
  // A configured file that cannot be read stops the request — sending none would only earn
  // a 401 that names the wrong cause.
  const tok = resolveViewAgentToken(process.env);
  if (tok.error) return fail(`${tok.error}.`, { transient: false });
  if (tok.token) headers['X-View-Token'] = tok.token;

  let res;
  try {
    // redirect: 'manual' — the contract has no redirects, and following one
    // would replay X-View-Token (a custom header, which fetch does not strip
    // across origins) and the vault hints to wherever `Location` points.
    res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return fail(
      `view-agent unreachable at ${agentBase} (${transportReason(err, tok.token)}). ` +
        'Check the view-agent service is running and reachable over WireGuard.',
    );
  }

  if (res.status >= 300 && res.status < 400) {
    // Not followed (see above). A per-provider misconfiguration, not a health
    // failure: it does not trip the eager circuit-breaker.
    await res.body?.cancel().catch(() => {});
    return fail(
      `view-agent answered a redirect (${res.status}) for vault "${vaultName}" — refused: ` +
        'the /view contract has none, and following it would send the token elsewhere.',
      { transient: false },
    );
  }

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    let detail = bodyText;
    let served = null;
    try {
      const parsed = JSON.parse(bodyText);
      detail = parsed.error || bodyText;
      served = Array.isArray(parsed.vaults) ? parsed.vaults : null;
    } catch {
      /* keep raw text */
    }
    // The router lower-cases names the agent may keep cased ("la méthode licares" here,
    // "La méthode LICARES" in the agent's config). A name the agent does not list, refused
    // while it lists exactly one other casing of it, is asked again, once, under that name.
    // Whatever the refusal says: an agent that detects vaults tries the unlisted name as a
    // container of its own first, and refuses with what the detection found instead
    // ("container obsidian-commun publishes its GUI port 3001 several times").
    if (res.status >= 400 && res.status < 500 && !casedRetry && served && !served.includes(vaultName)) {
      const same = served.filter(
        (n) => typeof n === 'string' && n !== vaultName && n.toLowerCase() === vaultName.toLowerCase(),
      );
      if (same.length === 1) {
        return fetchViewLink({ vaultName: same[0], note, vault, throwOnError, timeoutMs, casedRetry: true });
      }
    }
    // 4xx = per-vault (e.g. unknown/unsupported vault) → do NOT trip the global breaker;
    // 5xx = agent-side error → transient. (codex review+ pass 3.)
    return fail(`view-agent returned ${res.status} for vault "${vaultName}": ${detail}`, {
      transient: res.status >= 500,
    });
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return fail(`view-agent returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
  if (!data || typeof data.url !== 'string' || !data.url) {
    return fail(`view-agent response missing "url": ${bodyText.slice(0, 200)}`);
  }

  return data;
}

/**
 * Pick the note path a write result should produce a viewLink for — or null to skip.
 * `move_file` carries the destination as `result.to`; all other note-writes use `result.path`.
 * `merge_frontmatter` reports `applied` (keys written): when it's 0 every sub-write failed, so
 * the note may have received nothing — do NOT promise a read link for it (review+ pass 1).
 * @param {object} result   a note-write tool's result object
 * @returns {string|null}
 */
export function noteForWriteResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.applied === 0) return null; // merge_frontmatter: nothing applied → no link
  const note = result.to || result.path;
  return typeof note === 'string' && note ? note : null;
}

/**
 * Deterministic auto-injection for note-write tools (Option B). Spread-ready, NEVER throws.
 * Uses a SHORT eager timeout + a circuit-breaker so a down/hung view-agent can't stall writes.
 * Provider priority: smart link (pure HMAC, zero network — can't be slowed by a dead
 * agent) → view-agent fetch (existing) → none. `viewLinkKind` traces which one emitted.
 * @param {object} opts
 * @param {string} opts.vaultName   resolved (canonical) vault name from the write result
 * @param {string} opts.note        written note path
 * @param {object} [opts.vault]     the resolved descriptor, for the view-agent's vault hints
 * @returns {Promise<{viewLink?: string, viewLinkKind?: 'smart'|'agent', viewLinkError?: string}>}
 */
export async function viewLinkForWrite({ vaultName, note, vault } = {}) {
  // Not enough to build a link, or housekeeping/scaffold write → emit nothing, silently.
  if (!vaultName || typeof vaultName !== 'string' || !note || typeof note !== 'string') return {};
  if (note.startsWith('wiki-meta/')) return {};
  // PRIORITY 1 — smart link (resolver configured): stable signed URL, computed locally.
  // No fetch, no timeout, no circuit-breaker — the write pays ~zero latency.
  if (smartLinkEnabled(process.env)) {
    try {
      return {
        viewLink: buildSmartLink({
          baseUrl: process.env.OBSIDIAN_ROUTER_SMART_LINK_URL,
          vault: vaultName,
          note,
          secret: process.env.OBSIDIAN_ROUTER_SMART_LINK_SECRET, // raw, per contract
        }),
        viewLinkKind: 'smart',
      };
    } catch (err) {
      // Defensive: inputs are validated above, so this should be unreachable — but the
      // never-throws guarantee must hold even against a builder bug. A link problem must
      // never convert a SUCCESSFUL write into a tool error.
      return { viewLinkError: String((err && err.message) || err).slice(0, 140) };
    }
  }
  // PRIORITY 2 — view-agent. Gate: instances without one stay silent + pay ZERO latency.
  if (!(process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim()) return {};

  // Circuit open after a recent burst of failures → skip the fetch (no per-write latency).
  if (Date.now() < cbOpenUntil) {
    return { viewLinkError: 'view-agent unavailable (circuit open after repeated failures)' };
  }

  try {
    const data = await fetchViewLink({
      vaultName,
      note,
      vault,
      throwOnError: true,
      timeoutMs: EAGER_VIEW_TIMEOUT_MS,
    });
    cbConsecutiveFailures = 0; // a success fully closes the circuit...
    cbOpenUntil = 0; // ...incl. an in-flight success that lands after an overlapping burst
    //                  had opened it — otherwise writes keep skipping for the full cooldown
    //                  even though the agent is back (codex review+ pass 2).
    return { viewLink: data.url, viewLinkKind: 'agent' };
  } catch (err) {
    // Only AGENT-HEALTH failures (transport / timeout / 5xx) trip the breaker — NEVER a
    // per-vault 4xx, else one unsupported vault would suppress links for healthy vaults for
    // the whole cooldown (codex review+ pass 3).
    if (!err || err.viewAgentTransient !== false) {
      cbConsecutiveFailures += 1;
      if (cbConsecutiveFailures >= CB_FAILURE_THRESHOLD) {
        cbOpenUntil = Date.now() + CB_COOLDOWN_MS;
        cbConsecutiveFailures = 0; // the open window now gates; reset the counter
      }
    }
    // Configured but the agent failed/timed out — surface a short, discreet diagnostic
    // (NOT silent: the operator/AI can tell "configured but broken" from "not configured").
    return { viewLinkError: String((err && err.message) || err).slice(0, 140) };
  }
}
