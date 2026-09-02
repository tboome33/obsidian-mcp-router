/**
 * serve-http — expose the LOCAL router as a streamable-HTTP MCP server,
 * one child stdio router process per MCP session.
 *
 * WHY THIS EXISTS. Remote Claude Code sessions (the Dedibox `dev` account)
 * need the router's full feature set, and the router needs its disks — so the
 * router stays HOME and is SERVED through the existing SSH tunnel instead of
 * being ported. The topology was proven by the 2026-08-28 spike (vault page
 * `servir-le-routeur-roadmap`): sessions are isolated exactly when each MCP
 * session owns its own child process, which also preserves the semantics
 * every stdio session already has today.
 *
 * DESIGN CONSTRAINTS — each one is a measurement or a reviewed requirement,
 * not a preference (spike measurements + Codex consultation, 2026-08-28):
 *
 *   - BIND 127.0.0.1 ONLY, and there is deliberately NO option to widen it.
 *     The Windows firewall on this fleet is arbitrated by a third-party
 *     product and must never be counted as a mitigation; the tunnel is the
 *     only intended path in. (This is what disqualified supergateway: it
 *     binds `::` with no host option.)
 *   - BEARER AUTH ON EVERY VERB (POST, GET, DELETE). The tunneled port lands
 *     on the remote box's loopback, which every local process there can
 *     reach — the bearer is the actual boundary. The token is compared in
 *     constant time, never logged, never placed in argv, and never forwarded
 *     to the child.
 *   - ONE CHILD PER SESSION, spawned as `process.execPath` + entry file —
 *     never through a shell. The spike showed shell-spawned children hide
 *     behind a cmd.exe intermediary, which breaks process-tree cleanup.
 *   - FINITE SESSION TIMEOUT. A tunnel drop is NOT a DELETE: the spike left
 *     6 zombie children from 6 closed clients. Idle sessions are reaped and
 *     their children killed. Explicit DELETE keeps working (verified 200).
 *     The threshold defaults to FOUR HOURS, not thirty minutes: a reaper set
 *     below a human work pause harvests live sessions, which is what happened
 *     on 2026-08-29. See DEFAULT_SESSION_TIMEOUT_MS for the full reasoning.
 *   - AN UNKNOWN SESSION ID GETS A 404, NEVER A NEW CHILD. Silently respawning
 *     would be the tempting fix and the wrong one: per-session state (the
 *     vault lock, the auto-enrich mode, the once-per-session conformance pass)
 *     would silently reset under an id the client believes is stable. Lying
 *     about continuity is worse than reporting the break.
 *   - RELAYING IS RAW MESSAGE FORWARDING between the two SDK transports.
 *     SSE framing, session headers and JSON-RPC parsing belong to the SDK —
 *     re-implementing any of it was the reviewed anti-pattern.
 *   - A reconnecting client re-initializes and gets a NEW session (and a new
 *     child). Session resumption after a tunnel blip is out of scope by
 *     design — do not assume it, do not fake it.
 *
 * Run it via the scheduled task (see the roadmap's Phase 2), or by hand:
 *
 *   node scripts/serve-http.mjs [--port 27300] [--session-timeout-min 240]
 *
 * The bearer token is read from OBSIDIAN_ROUTER_HTTP_TOKEN or from the file
 * `~/.claude/obsidian-mcp-router/serve-http.token` (trimmed). Refusing to
 * start without one is the point: an unauthenticated listener is the one
 * state this script must never reach.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER_BIN = path.join(PACKAGE_ROOT, 'bin', 'obsidian-mcp-router.mjs');
const DEFAULT_PORT = 27300;
/**
 * Idle-session reap threshold, in ms. FOUR HOURS — raised from 30 minutes in
 * v0.77.0, and the reasoning is worth keeping because the obvious reading of
 * this constant ("shorter is tidier") is the wrong one.
 *
 * WHAT 30 MINUTES DID. On 2026-08-29 a multi-hour session driven from a remote
 * `dedibox-dev` box lost the router mid-flight: all 49 tools vanished, the
 * client reporting `CONNECT_TIMEOUT`. The server was fine throughout — measured
 * from the box while the client called it dead: `initialize` answered 200 in
 * 0.4 s, `tools/list` returned 53 tools, and a request carrying the OLD
 * session id got the correct 404. What had happened is that the human paused:
 * ran a script on their own machine, answered a question, thought. Nothing
 * crossed the bridge for half an hour, the reaper fired, and Claude Code — which
 * does not restore an MCP server that dies mid-session — dropped the router for
 * the rest of the sitting.
 *
 * THE ASYMMETRY THAT DECIDES THE VALUE. The two failure modes are not
 * comparable:
 *   - Too SHORT costs the user their tools for hours, with no recovery
 *     available from inside the session. It fires during NORMAL work.
 *   - Too LONG costs one dormant child process per abandoned session, until
 *     the threshold. Bounded, recoverable, and invisible to the user.
 * When one side of a trade is unrecoverable and the other is a little memory,
 * the default belongs on the memory side.
 *
 * WHY NOT INFINITE. The timeout is not decoration: a tunnel drop is not a
 * DELETE, and the 2026-08-28 spike left six zombie children from six closed
 * clients. Reaping stays mandatory (see the vault decision page
 * `http-only-comme-interface-de-backend`, where it is called non-negotiable) —
 * only its scale was wrong. Four hours is above any plausible human work pause
 * while still guaranteeing that an abandoned session is collected the same day.
 *
 * WHY THIS NUMBER. It is the value already proven in production on the machine
 * this serves, passed as `--session-timeout-min 240` in the scheduled task
 * since 2026-08-30. Shipping a default the fleet had to override was the
 * remaining half of the bug: the workaround fixed one machine, this fixes every
 * other installation.
 *
 * Operators serving many clients from one host, for whom dormant children are
 * the dominant cost, should lower it with `--session-timeout-min`.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 240 * 60_000;
const TOKEN_FILE = path.join(
  os.homedir(),
  '.claude',
  'obsidian-mcp-router',
  'serve-http.token',
);

/** Constant-time bearer check. Hashing both sides first normalises length,
 * which `timingSafeEqual` requires — and means the comparison cost does not
 * depend on how much of the token an attacker guessed. */
function makeAuthCheck(token) {
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return (req) => {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || header.length === 0) return false;
    const got = createHash('sha256').update(header).digest();
    return timingSafeEqual(expected, got);
  };
}

function jsonError(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
  });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/**
 * Create (but do not start) the serving stack.
 *
 * @param {object} options
 * @param {string} options.token           bearer token (required, non-empty)
 * @param {number} [options.port]          listen port (default 27300)
 * @param {string} [options.childCommand]  executable for the child (default process.execPath)
 * @param {string[]} [options.childArgs]   argv for the child (default [bin/obsidian-mcp-router.mjs])
 * @param {object} [options.childEnv]      extra env for the child (merged over process.env)
 * @param {string} [options.childCwd]      cwd for the child (default PACKAGE_ROOT — chosen so
 *                                         that no CALLER's workspace file reaches the served
 *                                         instance; remote sessions address vaults explicitly
 *                                         or use the global default).
 *                                         CAVEAT, measured 2026-09-02: PACKAGE_ROOT is this
 *                                         repository's own root, and a development checkout
 *                                         keeps a dotenv file there — which the child DOES
 *                                         load. So the default vault of a served instance can
 *                                         come from that file, and v0.88.0's provenance fields
 *                                         will say so (`workspace-dotenv`, truthfully). The
 *                                         launcher's own variables still win, because the
 *                                         parent always beats the file. A genuinely empty
 *                                         directory is the fix; it is a behaviour change for
 *                                         served deployments and belongs to the binding-registry
 *                                         lot of the decision liaison-workspace-vault-hors-depot,
 *                                         not to a doc comment.
 * @param {number} [options.sessionTimeoutMs] idle reap threshold (default 240 min — see
 *                                         DEFAULT_SESSION_TIMEOUT_MS for why not 30)
 * @param {number} [options.reapIntervalMs]   reaper cadence (default min(60s, timeout/4))
 * @param {(line: string) => void} [options.log] stderr-style logger (never receives the token)
 * @returns {{ listen: () => Promise<{port:number, host:string}>, close: () => Promise<void>,
 *             server: import('node:http').Server, sessions: Map<string, object> }}
 */
export function createServeHttp(options) {
  const {
    token,
    port = DEFAULT_PORT,
    childCommand = process.execPath,
    childArgs = [ROUTER_BIN],
    childEnv = {},
    childCwd = PACKAGE_ROOT,
    sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
    reapIntervalMs = Math.min(60_000, Math.max(250, Math.floor(sessionTimeoutMs / 4))),
    log = (line) => process.stderr.write(`[serve-http] ${line}\n`),
  } = options ?? {};

  if (typeof token !== 'string' || token.trim().length < 16) {
    throw new Error(
      'serve-http refuses to start without a bearer token of at least 16 characters — ' +
        'an unauthenticated listener is the one state this script must never reach.',
    );
  }
  const HOST = '127.0.0.1'; // deliberately not configurable — see docblock

  const isAuthorized = makeAuthCheck(token.trim());
  /** @type {Map<string, {httpTransport: StreamableHTTPServerTransport, child: StdioClientTransport, lastActivity: number, closing: boolean}>} */
  const sessions = new Map();

  function destroySession(sessionId, reason) {
    const entry = sessions.get(sessionId);
    if (!entry || entry.closing) return;
    entry.closing = true;
    sessions.delete(sessionId);
    log(`session ${sessionId} closed (${reason}) — ${sessions.size} left`);
    // Close both ends; each close is best-effort and must not block the other.
    Promise.resolve(entry.httpTransport.close()).catch(() => {});
    Promise.resolve(entry.child.close()).catch(() => {});
  }

  async function openSession(req, res) {
    // Spawn the child FIRST and wire the relay BEFORE handling the initialize
    // request — otherwise the parsed initialize message would fire onmessage
    // into the void.
    const child = new StdioClientTransport({
      command: childCommand,
      args: childArgs,
      env: { ...process.env, ...childEnv },
      cwd: childCwd,
      stderr: 'inherit',
    });
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, {
          httpTransport,
          child,
          lastActivity: Date.now(),
          closing: false,
        });
        log(`session ${sessionId} opened — ${sessions.size} active`);
      },
      onsessionclosed: (sessionId) => {
        destroySession(sessionId, 'client DELETE');
      },
    });

    httpTransport.onmessage = (message) => {
      child.send(message).catch((err) => log(`relay →child failed: ${err?.message || err}`));
    };
    child.onmessage = (message) => {
      httpTransport
        .send(message)
        .catch((err) => log(`relay →client failed: ${err?.message || err}`));
    };
    const dropForChild = () => {
      const sid = httpTransport.sessionId;
      if (sid) destroySession(sid, 'child exited');
    };
    child.onclose = dropForChild;
    child.onerror = (err) => log(`child error: ${err?.message || err}`);
    httpTransport.onclose = () => {
      const sid = httpTransport.sessionId;
      if (sid) destroySession(sid, 'transport closed');
    };
    httpTransport.onerror = (err) => log(`http transport error: ${err?.message || err}`);

    try {
      await child.start();
      await httpTransport.start();
    } catch (err) {
      Promise.resolve(child.close()).catch(() => {});
      Promise.resolve(httpTransport.close()).catch(() => {});
      throw err;
    }
    await httpTransport.handleRequest(req, res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAuthorized(req)) {
        jsonError(res, 401, 'Unauthorized');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${HOST}`);
      if (url.pathname !== '/mcp') {
        jsonError(res, 404, 'Not found — the MCP endpoint is /mcp');
        return;
      }
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        const entry = sessions.get(sessionId);
        if (!entry || entry.closing) {
          // Per spec: an unknown session gets 404 so the client re-initializes.
          jsonError(res, 404, 'Unknown or expired session — re-initialize');
          return;
        }
        entry.lastActivity = Date.now();
        await entry.httpTransport.handleRequest(req, res);
        return;
      }
      if (req.method === 'POST') {
        // No session header: only an initialize request may open a session;
        // the SDK transport itself rejects anything else.
        await openSession(req, res);
        return;
      }
      jsonError(res, 400, 'Missing Mcp-Session-Id');
    } catch (err) {
      log(`request failed: ${err?.message || err}`);
      jsonError(res, 500, 'Internal error');
    }
  });

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, entry] of sessions) {
      if (now - entry.lastActivity > sessionTimeoutMs) {
        destroySession(sessionId, `idle > ${sessionTimeoutMs} ms`);
      }
    }
  }, reapIntervalMs);
  reaper.unref();

  return {
    server,
    sessions,
    // Surfaced so the effective threshold can be read rather than inferred —
    // by the startup banner, by an operator, and by the test that pins the
    // default (a constant nobody checks is a constant that drifts back).
    sessionTimeoutMs,
    listen: () =>
      new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(port, HOST, () => {
          server.removeListener('error', rejectPromise);
          const addr = server.address();
          resolvePromise({ port: addr.port, host: addr.address });
        });
      }),
    close: async () => {
      clearInterval(reaper);
      for (const sessionId of [...sessions.keys()]) {
        destroySession(sessionId, 'server shutdown');
      }
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

/** Token resolution for the CLI path: env var first, then the token file.
 * Returned trimmed; null when neither source yields one. */
export function resolveToken({ env = process.env, tokenFile = TOKEN_FILE } = {}) {
  const fromEnv = env.OBSIDIAN_ROUTER_HTTP_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  try {
    const raw = fs.readFileSync(tokenFile, 'utf8').trim();
    if (raw) return raw;
  } catch {
    /* fall through */
  }
  return null;
}

function parseCliArgs(argv) {
  const out = { port: DEFAULT_PORT, sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--session-timeout-min') out.sessionTimeoutMs = Number(argv[++i]) * 60_000;
    else {
      process.stderr.write(`[serve-http] unknown flag: ${a}\n`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    process.stderr.write('[serve-http] --port must be an integer in [1, 65535]\n');
    process.exit(2);
  }
  if (!Number.isFinite(out.sessionTimeoutMs) || out.sessionTimeoutMs < 60_000) {
    process.stderr.write('[serve-http] --session-timeout-min must be ≥ 1\n');
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const token = resolveToken();
  if (!token) {
    process.stderr.write(
      '[serve-http] no bearer token found. Set OBSIDIAN_ROUTER_HTTP_TOKEN, or create the token file:\n' +
        `  node -e "const c=require('node:crypto'),f=require('node:fs'),p=require('node:path');const t=c.randomBytes(32).toString('base64url');f.mkdirSync(p.dirname(String.raw\`${TOKEN_FILE}\`),{recursive:true});f.writeFileSync(String.raw\`${TOKEN_FILE}\`,t);console.log('token written')"\n` +
        'Refusing to start without one — an unauthenticated listener is not an acceptable state.\n',
    );
    process.exit(1);
  }
  const stack = createServeHttp({
    token,
    port: args.port,
    sessionTimeoutMs: args.sessionTimeoutMs,
  });
  const { port, host } = await stack.listen();
  process.stderr.write(
    `[serve-http] obsidian-mcp-router served on http://${host}:${port}/mcp ` +
      `(child: ${ROUTER_BIN}; session timeout ${Math.round(args.sessionTimeoutMs / 60_000)} min; ` +
      'bearer required on every verb)\n',
  );
  const shutdown = () => {
    process.stderr.write('[serve-http] shutting down…\n');
    stack.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`[serve-http] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
