/**
 * Tests for src/tools/get-view-link.mjs — the interim "view link" tool that asks
 * the Dedibox view-agent for an ephemeral tunnel URL to a vault's live GUI.
 *
 * Strategy: stand up a tiny local HTTP server that mimics the view-agent's /view
 * endpoint, point OBSIDIAN_ROUTER_VIEW_AGENT_URL at it, and assert the tool builds
 * the right request (vault/note query + optional token header) and surfaces the URL.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { getViewLinkTool } from '../src/tools/get-view-link.mjs';

let server;
let baseUrl;
let received;
let respond;

const defaultRespond = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      url: 'https://obsidian:pw@abc.trycloudflare.com/',
      raw_url: 'https://abc.trycloudflare.com',
      vault: 'roland',
      note: '',
      idle_timeout_s: 900,
    }),
  );
};

before(async () => {
  received = [];
  server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, token: req.headers['x-view-token'] });
    respond(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  received.length = 0;
  respond = defaultRespond;
  delete process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL;
  delete process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN;
});

function makeRegistry(name = 'roland') {
  return {
    resolveVault() {
      return { type: 'remote', name, baseUrl: 'http://10.8.0.1:27145' };
    },
    defaultVault: name,
  };
}

describe('get_view_link — happy path', () => {
  test('calls /view?vault=&note= and returns the auth-in-URL', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    const r = await getViewLinkTool(makeRegistry('roland'), { vault: 'roland', note: 'test.md' });
    assert.equal(r.url, 'https://obsidian:pw@abc.trycloudflare.com/');
    assert.equal(r.vault, 'roland');
    assert.equal(r.note, 'test.md');
    assert.equal(r.expiresInSeconds, 900);

    const hit = received.find((x) => x.url.startsWith('/view'));
    assert.ok(hit, 'view-agent received a /view request');
    assert.equal(hit.method, 'GET');
    assert.ok(hit.url.includes('vault=roland'), 'passes the vault');
    assert.ok(hit.url.includes('note=test.md'), 'passes the note');
  });

  test('omits note when not provided', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    const r = await getViewLinkTool(makeRegistry('roland'), {});
    assert.equal(r.note, null);
    const hit = received.find((x) => x.url.startsWith('/view'));
    assert.ok(hit.url.includes('vault=roland'));
    assert.ok(!hit.url.includes('note='), 'no note param when omitted');
  });

  test('sends X-View-Token header when configured', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN = 'sekret';
    await getViewLinkTool(makeRegistry('roland'), { vault: 'roland' });
    const hit = received.find((x) => x.url.startsWith('/view'));
    assert.equal(hit.token, 'sekret');
  });

  test('tolerates a base URL with a trailing slash', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl + '/';
    await getViewLinkTool(makeRegistry('roland'), { vault: 'roland' });
    const hit = received.find((x) => x.url.startsWith('/view'));
    assert.ok(hit, 'reached /view even with a trailing-slash base');
  });
});

describe('get_view_link — validation + errors', () => {
  test('throws when OBSIDIAN_ROUTER_VIEW_AGENT_URL is unset', async () => {
    await assert.rejects(
      () => getViewLinkTool(makeRegistry('roland'), { vault: 'roland' }),
      /not configured/,
    );
  });

  test('rejects a non-string note', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    await assert.rejects(
      () => getViewLinkTool(makeRegistry('roland'), { note: 5 }),
      /note.*must be a string/i,
    );
  });

  test('surfaces a view-agent error status + body', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    respond = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown vault' }));
    };
    await assert.rejects(
      () => getViewLinkTool(makeRegistry('zzz'), { vault: 'zzz' }),
      /unknown vault/,
    );
  });

  test('throws a clear error when the view-agent is unreachable', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = 'http://127.0.0.1:1';
    await assert.rejects(
      () => getViewLinkTool(makeRegistry('roland'), { vault: 'roland' }),
      /unreachable/,
    );
  });
});
