/**
 * serve-http tests — the proxy's four load-bearing guarantees, each proven
 * against a real child process (the stateful fixture, not the router):
 *
 *   1. bearer auth is enforced on POST, GET and DELETE alike;
 *   2. two concurrent MCP sessions are ISOLATED (child-per-session);
 *   3. an explicit DELETE terminates the session AND kills its child;
 *   4. an idle session is reaped and its child killed (a tunnel drop is
 *      not a DELETE — the reaper is what prevents zombie children);
 *   plus: the listener binds 127.0.0.1 and nothing else.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServeHttp, DEFAULT_SESSION_TIMEOUT_MS } from '../scripts/serve-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-mcp-stdio-server.mjs');
const TOKEN = 'test-token-0123456789abcdef';

let stack;
let baseUrl;

before(async () => {
  stack = createServeHttp({
    token: TOKEN,
    port: 0, // ephemeral — tests must not collide with a real 27300
    childCommand: process.execPath,
    childArgs: [FIXTURE],
    sessionTimeoutMs: 60_000,
    log: () => {},
  });
  const { port, host } = await stack.listen();
  baseUrl = `http://${host}:${port}/mcp`;
});

after(async () => {
  await stack.close();
});

function makeClient(headers = { Authorization: `Bearer ${TOKEN}` }) {
  const client = new Client({ name: 'serve-http-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers },
  });
  return { client, transport, connect: () => client.connect(transport) };
}

function textOf(result) {
  return (result.content ?? []).map((c) => c.text ?? '').join('');
}

async function waitGone(pid, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH — process is gone
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('refuses every verb without (or with a wrong) bearer', async () => {
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'anon', version: '0' },
    },
  });
  const cases = [
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: initBody },
    { method: 'GET', headers: {} },
    { method: 'DELETE', headers: { 'mcp-session-id': 'whatever' } },
    {
      method: 'POST',
      // Deliberately short/unshaped — a value the export-gate's
      // authorization-header scanner (12+ char shaped token) won't flag as a
      // credential-looking literal in a tracked test file. Any wrong value
      // proves the point; it doesn't need to look like a real token.
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: initBody,
    },
  ];
  for (const c of cases) {
    const res = await fetch(baseUrl, c);
    assert.equal(res.status, 401, `${c.method} ${c.headers.Authorization ?? '(no auth)'}`);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  }
});

test('two concurrent sessions are isolated (child-per-session)', async () => {
  const a = makeClient();
  const b = makeClient();
  await a.connect();
  await b.connect();
  try {
    const tools = await a.client.listTools();
    assert.equal(tools.tools.length, 3);

    await a.client.callTool({ name: 'set_state', arguments: { value: 'A-was-here' } });
    const seenByB = await b.client.callTool({ name: 'get_state', arguments: {} });
    assert.equal(textOf(seenByB), 'null', 'B must not see state written by A');
    const seenByA = await a.client.callTool({ name: 'get_state', arguments: {} });
    assert.equal(textOf(seenByA), 'A-was-here');

    const pidA = Number(textOf(await a.client.callTool({ name: 'pid', arguments: {} })));
    const pidB = Number(textOf(await b.client.callTool({ name: 'pid', arguments: {} })));
    assert.notEqual(pidA, pidB, 'each session must own its own child process');
  } finally {
    await a.client.close().catch(() => {});
    await b.client.close().catch(() => {});
  }
});

test('explicit DELETE terminates the session and kills the child', async () => {
  const a = makeClient();
  await a.connect();
  const pid = Number(textOf(await a.client.callTool({ name: 'pid', arguments: {} })));
  const sessionId = a.transport.sessionId;
  assert.ok(sessionId, 'session id must be assigned after initialize');

  await a.transport.terminateSession();
  assert.ok(await waitGone(pid), 'child must die after DELETE');

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
  });
  assert.equal(res.status, 404, 'a terminated session must answer 404');
  await a.client.close().catch(() => {});
});

test('idle sessions are reaped and their children killed', async () => {
  const shortStack = createServeHttp({
    token: TOKEN,
    port: 0,
    childCommand: process.execPath,
    childArgs: [FIXTURE],
    sessionTimeoutMs: 400,
    reapIntervalMs: 100,
    log: () => {},
  });
  const { port, host } = await shortStack.listen();
  const url = `http://${host}:${port}/mcp`;
  try {
    const client = new Client({ name: 'reap-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    const pid = Number(textOf(await client.callTool({ name: 'pid', arguments: {} })));

    // Do NOT close the client — simulate a tunnel drop (no DELETE ever sent).
    assert.ok(await waitGone(pid, 5000), 'idle child must be reaped');
    assert.equal(shortStack.sessions.size, 0, 'reaped session must leave the map');
    await client.close().catch(() => {});
  } finally {
    await shortStack.close();
  }
});

test('listener binds 127.0.0.1 only', () => {
  const addr = stack.server.address();
  assert.equal(addr.address, '127.0.0.1');
});

// --- v0.77.0: the idle threshold, and the rebirth that must NOT happen -------

test('the DEFAULT idle threshold is 4 hours — longer than any human work pause', () => {
  // A reaper set below a plausible pause harvests LIVE sessions. On 2026-08-29
  // a 30-minute default killed a multi-hour session mid-flight while the user
  // was running a script on their own machine, and Claude Code does not
  // restore an MCP server that dies mid-session: the router was gone for the
  // rest of the sitting.
  //
  // The asymmetry is what fixes the number. Too short costs the user their
  // tools for hours with no in-session recovery; too long costs one dormant
  // child until the threshold. This test exists so lowering the default is a
  // deliberate act with a reason, not a tidy-up.
  assert.equal(DEFAULT_SESSION_TIMEOUT_MS, 240 * 60_000, '240 minutes');
  assert.ok(DEFAULT_SESSION_TIMEOUT_MS > 60 * 60_000, 'must exceed an hour-long pause');
  assert.ok(Number.isFinite(DEFAULT_SESSION_TIMEOUT_MS), 'still FINITE — the spike left 6 zombie children');
});

test('a stack built with no explicit timeout actually uses that default', () => {
  // Pins the wiring, not just the constant: a default that the factory does
  // not read is a comment, not a behaviour.
  const s = createServeHttp({ token: TOKEN, port: 0, childCommand: process.execPath, childArgs: [FIXTURE], log: () => {} });
  assert.equal(s.sessionTimeoutMs, DEFAULT_SESSION_TIMEOUT_MS);
});

test('an UNKNOWN session id gets 404 and spawns NO child — no silent rebirth', async () => {
  // A DELIBERATE NON-FEATURE, and the one a future edit is most likely to
  // "fix". Respawning a child under an unknown id would let the client sail on
  // — while its per-session state (the vault lock, the auto-enrich mode, the
  // once-per-session conformance pass) had silently reset underneath an id it
  // believes is stable. That is lying about continuity; the honest 404 is the
  // contract, and recovering from it is the client's job.
  const before = stack.sessions.size;
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      'mcp-session-id': 'a-session-that-was-reaped-hours-ago',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error.message, /re-initialize/i, 'the 404 must tell the client what to do');
  assert.equal(stack.sessions.size, before, 'no session (and so no child) may be created for an unknown id');
});
