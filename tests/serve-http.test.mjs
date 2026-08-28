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
import { createServeHttp } from '../scripts/serve-http.mjs';

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
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token-000000' },
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
