/**
 * Does anything already hold this port?
 *
 * The one adapter in the port machinery that touches the network. Everything
 * that DECIDES lives in `helpers/port-policy.mjs` and `helpers/port-registry.mjs`,
 * which are pure and stay that way — this module is injected into them as a
 * function, never imported by them.
 *
 * ---------------------------------------------------------------------------
 * WHY ASK THE OS AT ALL
 * ---------------------------------------------------------------------------
 * Because the router's registry only knows about vaults the router registered.
 * A vault nobody registered, another application, a dev server, an SSH tunnel —
 * none of them appear in `portRegistry` or in any `data.json` the router reads,
 * and all of them can be sitting on the port about to be handed to a new vault.
 * And Local REST API does not recover from that: it calls `listen()` with its
 * configured port and has no `EADDRINUSE` handler anywhere in its `main.js`, so
 * the loser of the race simply never binds and the vault looks ABSENT rather
 * than misconfigured.
 *
 * ---------------------------------------------------------------------------
 * WHAT A SUCCESSFUL PROBE DOES NOT PROMISE
 * ---------------------------------------------------------------------------
 * Nothing about the future. The socket is opened and closed immediately, so
 * between this answer and the moment Obsidian's plugin binds, anything may take
 * the port. This is a filter that removes ports already in use; it is NOT a
 * reservation, and no message built on it may say "reserved".
 *
 * The converse matters more, and is the rule the whole module is shaped around:
 * AN ERROR IS NOT A FREE PORT. A timeout, an EACCES, an EADDRNOTAVAIL, an
 * unexpected throw — every one of them answers `available: false`. Treating an
 * unclear answer as "free" is how a collision gets created deliberately.
 */

import net from 'node:net';

/** Where the Local REST API plugin binds. Probing anywhere else proves nothing. */
export const DEFAULT_PROBE_HOST = '127.0.0.1';

/** Generous: a loopback bind either works or fails at once. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1000;

/**
 * Try to bind one port on the loopback interface, then let it go.
 *
 * @param {number} port
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ available: boolean, reason: string|null }>} Never rejects.
 */
export function probeLoopbackPort(port, { host = DEFAULT_PROBE_HOST, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      resolve({ available: false, reason: 'not-a-port' });
      return;
    }

    let settled = false;
    let timer = null;
    let server = null;

    // ONE exit, and it always closes the socket — including on the error and
    // timeout paths. A probe that leaks a listening server would make the very
    // next candidate look taken by a process that is this one.
    const finish = (available, reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (server) {
        try {
          server.close();
        } catch {
          // Closing a server that never listened throws ERR_SERVER_NOT_RUNNING.
          // The verdict is already decided; nothing here may change it.
        }
      }
      resolve({ available, reason });
    };

    try {
      server = net.createServer();
    } catch (err) {
      finish(false, err?.code || 'create-failed');
      return;
    }

    server.once('error', (err) => finish(false, err?.code || 'error'));
    server.once('listening', () => finish(true, null));

    timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      // `exclusive: true` so a port already bound by a process using SO_REUSEADDR
      // still reads as taken. Without it, two servers can share a port on some
      // platforms and the probe would cheerfully report a collision as free.
      server.listen({ host, port, exclusive: true });
    } catch (err) {
      finish(false, err?.code || 'listen-threw');
    }
  });
}

/**
 * Probe both members of a candidate pair. Short-circuits: if the first is
 * taken, the second is never opened.
 *
 * @returns {Promise<{ available: boolean, reason: string|null, port: number|null }>}
 */
export async function probeLoopbackPair(https, http, options = {}) {
  for (const port of [https, http]) {
    if (port === null || port === undefined) continue;
    const result = await probeLoopbackPort(port, options);
    if (!result.available) return { available: false, reason: result.reason, port };
  }
  return { available: true, reason: null, port: null };
}
