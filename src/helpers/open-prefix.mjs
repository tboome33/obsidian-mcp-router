/**
 * Which path prefix a vault's bridge serves click-to-open links under.
 *
 * Up to bridge 0.9.1 the route was always `/open/<path>`. Local REST API 5.4.0
 * reserves `/open/` (with `vault`, `active`, `search`, `commands`, `events`,
 * `mcp` and `tags`) for its own routes and refuses it as a public route, so a
 * 0.9.1 bridge on 5.4.0 has no click-to-open route at all, and a click on an
 * `/open/` link lands on 5.4.0's own authenticated route: 401, errorCode 40101.
 * Bridge 0.10.0 registers `/mcp-router-bridge/open/*` first, keeps `/open/*`
 * where Local REST API still accepts it (< 5.4.0), and ANNOUNCES the prefix it got
 * in `GET /ping`'s body as `openPrefix`. This module reads that announcement,
 * so the router never guesses which Local REST API a vault runs.
 *
 * WHERE THE ANSWER COMES FROM, in order:
 *   1. `GET /ping` on the vault's own REST channel → `openPrefix`. The bridge's
 *      own word, on every Local REST API version. Loopback-only on the bridge
 *      side, so it answers for a local vault and refuses (403) a vault reached
 *      over a network.
 *   2. `GET /` (authenticated) → the bridge's entry in `apiExtensions`, whose
 *      `routes` list what Local REST API ACTUALLY registered (measured on
 *      4.0.2, 5.1.0, 5.2.0 and 5.4.0; a root without `routes` says nothing).
 *      Covers the remote vault that step 1 cannot reach, and a bridge too old
 *      to announce anything.
 *   3. Neither said anything → LEGACY_OPEN_PREFIX. That is the right answer for
 *      a bridge < 0.10.0 on Local REST API < 5.4.0, the only setup where a
 *      silent bridge still has a working route.
 *
 * CACHED, BRIEFLY, AND WHY HERE WHEN click-to-open.mjs REFUSES A PORT MEMO. The
 * port is read from a local file on every call because a stale port is a dead
 * link and the read costs nothing. The prefix costs a network round trip, and
 * it changes only when a bridge is upgraded and reloaded — so it is kept for
 * PREFIX_TTL_MS and then re-asked. The link builder itself stays synchronous:
 * it reads the cache (`getOpenPrefix`), and whoever is about to emit links
 * warms it first (`resolveOpenPrefix`, awaited by the dispatcher for every
 * link-emitting tool, and fed for free by every `list_vaults` ping).
 *
 * Pure: no import from rest-client.mjs (which imports click-to-open.mjs, which
 * imports this) — the two probes are injected.
 */

/** The historical route, and the answer when no bridge said anything. */
export const LEGACY_OPEN_PREFIX = '/open/';

/** The bridge plugin's id, as Local REST API lists it in `apiExtensions`. */
export const BRIDGE_PLUGIN_ID = 'mcp-router-bridge';

/** How long an answer is trusted before it is asked again. */
export const PREFIX_TTL_MS = 60_000;

/** Budget for each probe: both are tiny local or same-channel requests. */
export const PREFIX_PROBE_TIMEOUT_MS = 2_000;

/** @type {Map<string, { prefix: string, source: string, at: number }>} */
const cache = new Map();
/** @type {Map<string, Promise<string>>} */
const inflight = new Map();

/**
 * True for an absolute, slash-terminated path made only of unreserved URL
 * characters, no segment starting with a dot (so no `..`), at most 128 chars.
 * The prefix comes off the network and is interpolated into a URL whose host
 * MUST stay 127.0.0.1 — anything that could carry `@`, `:`, `?`, `#`, `%` or a
 * backslash is refused, not cleaned.
 *
 * @param {unknown} p
 * @returns {p is string}
 */
export function isValidOpenPrefix(p) {
  return (
    typeof p === 'string' &&
    p.length <= 128 &&
    /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)+$/.test(p)
  );
}

/**
 * The prefix a `GET /ping` body announces, or null.
 * @param {unknown} body
 * @returns {string|null}
 */
export function prefixFromPing(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.pong !== true) return null;
  return isValidOpenPrefix(body.openPrefix) ? body.openPrefix : null;
}

/**
 * The click-to-open prefix Local REST API's root says the bridge registered,
 * or null when the root does not list routes or lists no such route.
 * Prefers a non-legacy route when both are registered (bridge 0.10.0 on a
 * Local REST API that still accepts `/open/*`): that is the one the bridge
 * announces too.
 *
 * @param {unknown} info - parsed `GET /` body.
 * @returns {string|null}
 */
export function prefixFromRoot(info) {
  const exts = info && typeof info === 'object' ? info.apiExtensions : null;
  if (!Array.isArray(exts)) return null;
  const bridge = exts.find((e) => e && typeof e === 'object' && e.id === BRIDGE_PLUGIN_ID);
  if (!bridge || !Array.isArray(bridge.routes)) return null;
  const candidates = bridge.routes
    .filter((r) => r && r.authenticated === false && typeof r.path === 'string' && r.path.endsWith('/open/*'))
    .map((r) => r.path.slice(0, -1))
    .filter(isValidOpenPrefix);
  return candidates.find((p) => p !== LEGACY_OPEN_PREFIX) ?? candidates[0] ?? null;
}

/** Cache key: the vault's name AND where it is reached, so a re-pointed vault is re-asked. */
function keyOf(vault) {
  return `${vault?.name ?? ''}\u0000${vault?.baseUrl ?? ''}`;
}

/**
 * Record an answer. Ignores an invalid prefix.
 * @param {object} vault
 * @param {string} prefix
 * @param {string} source - 'ping' | 'root' | 'fallback'
 * @param {number} [now]
 */
export function rememberOpenPrefix(vault, prefix, source, now = Date.now()) {
  if (!vault || !isValidOpenPrefix(prefix)) return;
  cache.set(keyOf(vault), { prefix, source, at: now });
}

/**
 * Feed the cache from a `GET /` body the caller already has (pingVault). Only
 * a POSITIVE finding is recorded: a root that lists no routes says nothing,
 * and must not overwrite what `/ping` said.
 * @param {object} vault
 * @param {unknown} info
 */
export function rememberOpenPrefixFromRoot(vault, info) {
  const prefix = prefixFromRoot(info);
  if (prefix) rememberOpenPrefix(vault, prefix, 'root');
}

/**
 * Synchronous read for the link builder: the last answer for this vault,
 * however old, else LEGACY_OPEN_PREFIX. Age only decides when to ask again —
 * an old answer is still a better guess than none.
 * @param {object} vault
 * @returns {string}
 */
export function getOpenPrefix(vault) {
  return cache.get(keyOf(vault))?.prefix ?? LEGACY_OPEN_PREFIX;
}

/**
 * The cached entry, for diagnostics (`list_vaults`, tests). Null when never asked.
 * @param {object} vault
 */
export function describeOpenPrefix(vault) {
  const e = cache.get(keyOf(vault));
  return e ? { ...e } : null;
}

/**
 * Ask the vault which prefix its bridge serves, unless a fresh answer is
 * cached. Never throws: every failure ends at LEGACY_OPEN_PREFIX. Concurrent
 * callers for one vault share one probe.
 *
 * @param {object} vault
 * @param {object} probes
 * @param {(vault: object) => Promise<unknown>} probes.fetchPing - `GET /ping` body.
 * @param {(vault: object) => Promise<unknown>} probes.fetchRoot - `GET /` body.
 * @param {() => number} [probes.now]
 * @returns {Promise<string>}
 */
export async function resolveOpenPrefix(vault, { fetchPing, fetchRoot, now = Date.now } = {}) {
  if (!vault || typeof vault !== 'object') return LEGACY_OPEN_PREFIX;
  const key = keyOf(vault);
  const hit = cache.get(key);
  if (hit && now() - hit.at < PREFIX_TTL_MS) return hit.prefix;
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async () => {
    let prefix = null;
    let source = 'fallback';
    if (typeof fetchPing === 'function') {
      try {
        prefix = prefixFromPing(await fetchPing(vault));
        if (prefix) source = 'ping';
      } catch { /* 403 off-loopback, old bridge, timeout: try the root */ }
    }
    if (!prefix && typeof fetchRoot === 'function') {
      try {
        prefix = prefixFromRoot(await fetchRoot(vault));
        if (prefix) source = 'root';
      } catch { /* nothing more to ask */ }
    }
    const answer = prefix ?? LEGACY_OPEN_PREFIX;
    rememberOpenPrefix(vault, answer, source, now());
    return answer;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/** Tests only. */
export function _resetOpenPrefixCache() {
  cache.clear();
  inflight.clear();
}
