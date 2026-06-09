/**
 * Tests for src/helpers/view-link.mjs — the shared view-agent transport (`fetchViewLink`)
 * and the deterministic auto-injection (`viewLinkForWrite`) used by the CallTool dispatch
 * after a successful note write (Option B).
 *
 * Strategy: a tiny local HTTP server mimics the view-agent /view endpoint; point
 * OBSIDIAN_ROUTER_VIEW_AGENT_URL at it and assert behaviour + the critical invariant that
 * `viewLinkForWrite` NEVER throws and NEVER fetches when it shouldn't.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  fetchViewLink,
  viewLinkForWrite,
  noteForWriteResult,
  __resetViewLinkCircuit,
} from '../src/helpers/view-link.mjs';

let server;
let baseUrl;
let received;
let respond;

const okRespond = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      url: 'https://obsidian:pw@abc.trycloudflare.com/',
      raw_url: 'https://abc.trycloudflare.com',
      vault: 'roland',
      note: '',
      idle_timeout_s: 1800,
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
  respond = okRespond;
  __resetViewLinkCircuit();
  delete process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL;
  delete process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN;
});

describe('fetchViewLink — pure transport', () => {
  test('returns the parsed view-agent JSON on success', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    const d = await fetchViewLink({ vaultName: 'roland', note: 'test.md' });
    assert.equal(d.url, 'https://obsidian:pw@abc.trycloudflare.com/');
    assert.equal(d.idle_timeout_s, 1800);
    const hit = received.find((x) => x.url.startsWith('/view'));
    assert.ok(hit.url.includes('vault=roland') && hit.url.includes('note=test.md'));
  });

  test('throwOnError:false returns null when unconfigured', async () => {
    assert.equal(await fetchViewLink({ vaultName: 'roland', throwOnError: false }), null);
  });

  test('throwOnError:true throws when unconfigured', async () => {
    await assert.rejects(
      () => fetchViewLink({ vaultName: 'roland', throwOnError: true }),
      /not configured/,
    );
  });

  test('sends X-View-Token when configured', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN = 'sek';
    await fetchViewLink({ vaultName: 'roland' });
    assert.equal(received.find((x) => x.url.startsWith('/view')).token, 'sek');
  });

  test('throwOnError:false returns null on a view-agent error status', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    respond = (_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown vault' }));
    };
    assert.equal(await fetchViewLink({ vaultName: 'zzz', throwOnError: false }), null);
  });
});

describe('viewLinkForWrite — deterministic injection, never throws', () => {
  test('returns {viewLink} on success', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    const r = await viewLinkForWrite({ vaultName: 'roland', note: 'Voyages/x.md' });
    assert.equal(r.viewLink, 'https://obsidian:pw@abc.trycloudflare.com/');
    assert.ok(!('viewLinkError' in r));
  });

  test('silent {} when unconfigured — and does NOT fetch', async () => {
    const r = await viewLinkForWrite({ vaultName: 'roland', note: 'x.md' });
    assert.deepEqual(r, {});
    assert.equal(received.length, 0, 'must not hit the view-agent when unconfigured');
  });

  test('skips wiki-meta/ housekeeping — and does NOT fetch', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    const r = await viewLinkForWrite({ vaultName: 'roland', note: 'wiki-meta/log.md' });
    assert.deepEqual(r, {});
    assert.equal(received.length, 0, 'must not hit the view-agent for housekeeping writes');
  });

  test('returns {} when vault or note is missing', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    assert.deepEqual(await viewLinkForWrite({ vaultName: 'roland' }), {});
    assert.deepEqual(await viewLinkForWrite({ note: 'x.md' }), {});
    assert.deepEqual(await viewLinkForWrite({}), {});
    assert.equal(received.length, 0);
  });

  test('configured but the agent fails → {viewLinkError}, no throw', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    respond = (_q, res) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tunnel failed' }));
    };
    const r = await viewLinkForWrite({ vaultName: 'roland', note: 'x.md' });
    assert.ok(r.viewLinkError, 'surfaces a discreet viewLinkError');
    assert.ok(!('viewLink' in r));
  });

  test('view-agent unreachable → {viewLinkError}, no throw', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = 'http://127.0.0.1:1';
    const r = await viewLinkForWrite({ vaultName: 'roland', note: 'x.md' });
    assert.ok(r.viewLinkError);
    assert.ok(!('viewLink' in r));
  });

  test('circuit-breaker: 3 consecutive eager failures → 4th call skips the fetch', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    respond = (_q, res) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'down' }));
    };
    const attempts = () => received.filter((x) => x.url.startsWith('/view')).length;
    for (let i = 0; i < 3; i++) {
      assert.ok((await viewLinkForWrite({ vaultName: 'roland', note: 'x.md' })).viewLinkError);
    }
    assert.equal(attempts(), 3, '3 real attempts before the circuit opens');
    const r4 = await viewLinkForWrite({ vaultName: 'roland', note: 'x.md' });
    assert.match(r4.viewLinkError, /circuit open/);
    assert.equal(attempts(), 3, '4th call must NOT hit the view-agent (circuit open)');
  });

  test('circuit-breaker: __resetViewLinkCircuit re-enables fetching', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    respond = (_q, res) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{}');
    };
    for (let i = 0; i < 3; i++) await viewLinkForWrite({ vaultName: 'roland', note: 'x.md' });
    __resetViewLinkCircuit();
    respond = okRespond;
    const r = await viewLinkForWrite({ vaultName: 'roland', note: 'x.md' });
    assert.equal(r.viewLink, 'https://obsidian:pw@abc.trycloudflare.com/');
  });

  test('circuit-breaker: per-vault 4xx (unknown vault) does NOT trip the global breaker', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    respond = (_q, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown vault' }));
    };
    const attempts = () => received.filter((x) => x.url.startsWith('/view')).length;
    // 4 writes to an unsupported vault: every one still hits the agent (4xx never opens the
    // breaker), so a healthy vault on the same agent keeps getting links.
    for (let i = 0; i < 4; i++) {
      assert.ok((await viewLinkForWrite({ vaultName: 'zzz', note: 'x.md' })).viewLinkError);
    }
    assert.equal(attempts(), 4, '4xx must not open the breaker — every write still tries');
  });
});

describe('noteForWriteResult — note path selection + no-op skip', () => {
  test('write-style result → path', () => {
    assert.equal(noteForWriteResult({ vault: 'r', path: 'Voyages/a.md' }), 'Voyages/a.md');
  });
  test('move_file result → to (destination), not source', () => {
    assert.equal(noteForWriteResult({ vault: 'r', from: 'a.md', to: 'b.md' }), 'b.md');
  });
  test('merge_frontmatter all-failed (applied:0) → null (no link for a no-op write)', () => {
    assert.equal(noteForWriteResult({ vault: 'r', path: 'a.md', applied: 0, failed: 2 }), null);
  });
  test('merge_frontmatter with applied>0 → path', () => {
    assert.equal(noteForWriteResult({ vault: 'r', path: 'a.md', applied: 3, failed: 0 }), 'a.md');
  });
  test('junk / empty / missing path → null', () => {
    assert.equal(noteForWriteResult(null), null);
    assert.equal(noteForWriteResult({}), null);
    assert.equal(noteForWriteResult('x'), null);
    assert.equal(noteForWriteResult({ vault: 'r', path: '' }), null);
  });
});
