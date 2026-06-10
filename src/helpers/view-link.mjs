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
 *   OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN  shared secret (optional; sent as X-View-Token)
 */

import { buildSmartLink, smartLinkEnabled } from './smart-link.mjs';

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
 * Pure transport to the view-agent /view endpoint.
 * @param {object}  opts
 * @param {string}  opts.vaultName               canonical vault name (caller already resolved it)
 * @param {string} [opts.note]                   optional vault-relative note path to navigate to
 * @param {boolean}[opts.throwOnError=true]      throw on any failure vs. return null
 * @param {number} [opts.timeoutMs]              fetch timeout override
 * @returns {Promise<object|null>}               parsed view-agent JSON ({ url, idle_timeout_s, … }) or null
 */
export async function fetchViewLink({
  vaultName,
  note,
  throwOnError = true,
  timeoutMs = DEFAULT_VIEW_TIMEOUT_MS,
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

  const headers = {};
  const token = (process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN || '').trim();
  if (token) headers['X-View-Token'] = token;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return fail(
      `view-agent unreachable at ${agentBase} (${err?.message || err}). ` +
        'Check the view-agent service is running and reachable over WireGuard.',
    );
  }

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    let detail = bodyText;
    try {
      detail = JSON.parse(bodyText).error || bodyText;
    } catch {
      /* keep raw text */
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
 * @returns {Promise<{viewLink?: string, viewLinkKind?: 'smart'|'agent', viewLinkError?: string}>}
 */
export async function viewLinkForWrite({ vaultName, note } = {}) {
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
