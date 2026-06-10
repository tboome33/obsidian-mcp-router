/**
 * Tests for src/tools/open-in-obsidian.mjs — the browser-free "open this note
 * in Obsidian" tool. It fires a GET to the bridge's /open route server-side.
 *
 * Strategy: stand up a tiny local HTTP server that records the request target
 * and 200s any /open/* path (mimicking the bridge). Point a fake vault's
 * baseUrl at it and assert the tool builds + fires the right URL.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { openInObsidianTool } from '../src/tools/open-in-obsidian.mjs';
import { verifySmartLinkToken } from '../src/helpers/smart-link.mjs';

let server;
let baseUrl;
let received;

before(async () => {
  received = [];
  server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url });
    if (req.url.startsWith('/view')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://obsidian:pw@vt.trycloudflare.com/', idle_timeout_s: 1800 }));
    } else if (req.url.startsWith('/open/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html>Opened in Obsidian.');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  // self-sufficient: don't leak to later files
  delete process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL;
  delete process.env.OBSIDIAN_ROUTER_SMART_LINK_URL;
  delete process.env.OBSIDIAN_ROUTER_SMART_LINK_SECRET;
});

beforeEach(() => {
  received.length = 0;
  // bridge-path tests must NOT see a view-agent nor a smart-link resolver
  delete process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL;
  delete process.env.OBSIDIAN_ROUTER_SMART_LINK_URL;
  delete process.env.OBSIDIAN_ROUTER_SMART_LINK_SECRET;
});

function makeRegistry(vault) {
  return {
    resolveVault() {
      return vault;
    },
    defaultVault: vault.name,
  };
}

function localVault(extra = {}) {
  return { type: 'local', name: 'test', baseUrl, timeoutMs: 5000, ...extra };
}

describe('open_in_obsidian — fires /open server-side', () => {
  test('GET /open/<encoded-path> and returns opened:true', async () => {
    const r = await openInObsidianTool(makeRegistry(localVault()), {
      path: 'wiki/Divers/foo.md',
    });
    assert.equal(r.opened, true);
    assert.equal(r.vault, 'test');
    assert.equal(r.path, 'wiki/Divers/foo.md');
    assert.ok(!('anchor' in r), 'no anchor field when none requested');

    const hit = received.find((x) => x.url.startsWith('/open/'));
    assert.ok(hit, 'server received a /open request');
    assert.equal(hit.method, 'GET');
    assert.equal(hit.url, '/open/wiki%2FDivers%2Ffoo.md');
  });

  test('appends ?h=<heading> and echoes the normalized anchor', async () => {
    const r = await openInObsidianTool(makeRegistry(localVault()), {
      path: 'wiki/foo.md',
      anchor: '#Section 2',
    });
    assert.equal(r.anchor, 'Section 2'); // leading # stripped
    const hit = received.find((x) => x.url.startsWith('/open/'));
    assert.equal(hit.url, '/open/wiki%2Ffoo.md?h=Section%202');
  });

  test('whitespace-only anchor → no ?h=, no anchor field', async () => {
    const r = await openInObsidianTool(makeRegistry(localVault()), {
      path: 'wiki/foo.md',
      anchor: '   ',
    });
    assert.ok(!('anchor' in r));
    const hit = received.find((x) => x.url.startsWith('/open/'));
    assert.equal(hit.url, '/open/wiki%2Ffoo.md');
  });

  test('adversarial path: ?/#/& are encoded into the segment (no query/fragment injection)', async () => {
    // A path containing URL-control chars must NOT be able to spawn a real
    // query/fragment on the /open URL — it stays one encoded path segment.
    await openInObsidianTool(makeRegistry(localVault()), {
      path: 'wiki/foo.md?h=evil&x=1#frag',
    });
    const hit = received.find((x) => x.url.startsWith('/open/'));
    assert.equal(hit.url, '/open/wiki%2Ffoo.md%3Fh%3Devil%26x%3D1%23frag');
    assert.ok(!hit.url.includes('?h=evil'), 'must not produce a parasitic ?h= query');
    assert.ok(!hit.url.includes('#frag'), 'must not produce a parasitic fragment');
  });
});

describe('open_in_obsidian — validation + errors', () => {
  test('rejects missing path', async () => {
    await assert.rejects(
      () => openInObsidianTool(makeRegistry(localVault()), {}),
      /Missing required argument: `path`/,
    );
  });

  test('rejects empty path', async () => {
    await assert.rejects(
      () => openInObsidianTool(makeRegistry(localVault()), { path: '' }),
      /Missing required argument: `path`/,
    );
  });

  test('rejects non-string anchor', async () => {
    await assert.rejects(
      () => openInObsidianTool(makeRegistry(localVault()), { path: 'a.md', anchor: 5 }),
      /anchor.*must be a string/i,
    );
  });

  test('propagates an error when Obsidian / REST API is unreachable', async () => {
    // Port 1 is unbindable/refused — simulates Obsidian not running.
    const dead = { type: 'local', name: 'dead', baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 };
    await assert.rejects(() => openInObsidianTool(makeRegistry(dead), { path: 'a.md' }));
  });
});

describe('open_in_obsidian — remote view-agent returns a viewLink (deterministic "show me")', () => {
  test('view-agent configured → returns viewLink, does NOT hit the bridge /open', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    const r = await openInObsidianTool(makeRegistry(localVault()), { path: 'Voyages/x.md' });
    assert.equal(r.opened, true);
    assert.equal(r.viewLink, 'https://obsidian:pw@vt.trycloudflare.com/');
    assert.equal(r.viewLinkKind, 'agent');
    const viewHit = received.find((x) => x.url.startsWith('/view'));
    assert.ok(viewHit && viewHit.url.includes('note=Voyages%2Fx.md'), 'hit /view with the note');
    assert.ok(!received.some((x) => x.url.startsWith('/open/')), 'did NOT call the bridge /open');
  });

  test('view-agent + anchor → echoes anchor as anchorApplied:false (not silently dropped)', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    const r = await openInObsidianTool(makeRegistry(localVault()), { path: 'wiki/foo.md', anchor: '#Section 2' });
    assert.equal(r.viewLink, 'https://obsidian:pw@vt.trycloudflare.com/');
    assert.equal(r.anchor, '#Section 2');
    assert.equal(r.anchorApplied, false);
  });

  test('view-agent configured but unreachable → falls through to the bridge navigate', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = 'http://127.0.0.1:1';
    const r = await openInObsidianTool(makeRegistry(localVault()), { path: 'wiki/foo.md' });
    assert.equal(r.opened, true);
    assert.ok(!('viewLink' in r), 'no viewLink when the agent is down');
    assert.ok(received.some((x) => x.url.startsWith('/open/')), 'fell through to the bridge /open');
  });
});

describe('open_in_obsidian — smart link takes priority over the view-agent (remote)', () => {
  const SMART_URL = 'https://open.example.test';
  const SMART_SECRET = 'fake-test-smart-secret';

  beforeEach(() => {
    process.env.OBSIDIAN_ROUTER_SMART_LINK_URL = SMART_URL;
    process.env.OBSIDIAN_ROUTER_SMART_LINK_SECRET = SMART_SECRET;
  });

  test('smart + agent configured → smart viewLink, ZERO network (no /view, no /open)', async () => {
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    const r = await openInObsidianTool(makeRegistry(localVault()), { path: 'Voyages/x.md' });
    assert.equal(r.opened, true);
    assert.equal(r.vault, 'test');
    assert.equal(r.path, 'Voyages/x.md');
    assert.equal(r.viewLinkKind, 'smart');
    assert.ok(r.viewLink.startsWith(`${SMART_URL}/o/`));
    const token = r.viewLink.slice(r.viewLink.indexOf('/o/') + 3);
    assert.deepEqual(verifySmartLinkToken({ token, secret: SMART_SECRET }), {
      ok: true,
      vault: 'test',
      note: 'Voyages/x.md',
    });
    assert.equal(received.length, 0, 'no view-agent call, no bridge call — pure HMAC');
    assert.ok(!('anchor' in r), 'no anchor field when none requested');
  });

  test('smart link keeps the remote anchor contract: anchorApplied:false', async () => {
    const r = await openInObsidianTool(makeRegistry(localVault()), {
      path: 'wiki/foo.md',
      anchor: '#Section 2',
    });
    assert.equal(r.viewLinkKind, 'smart');
    assert.equal(r.anchor, '#Section 2');
    assert.equal(r.anchorApplied, false);
    assert.equal(received.length, 0);
  });

  test('half-configured smart link (secret missing) → existing agent path, kind agent', async () => {
    delete process.env.OBSIDIAN_ROUTER_SMART_LINK_SECRET;
    process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL = baseUrl;
    const r = await openInObsidianTool(makeRegistry(localVault()), { path: 'wiki/foo.md' });
    assert.equal(r.viewLink, 'https://obsidian:pw@vt.trycloudflare.com/');
    assert.equal(r.viewLinkKind, 'agent');
    assert.ok(received.some((x) => x.url.startsWith('/view')));
  });

  test('regression: neither provider configured → bridge navigate, no viewLink fields', async () => {
    delete process.env.OBSIDIAN_ROUTER_SMART_LINK_URL;
    delete process.env.OBSIDIAN_ROUTER_SMART_LINK_SECRET;
    const r = await openInObsidianTool(makeRegistry(localVault()), { path: 'wiki/foo.md' });
    assert.equal(r.opened, true);
    assert.ok(!('viewLink' in r) && !('viewLinkKind' in r));
    assert.ok(received.some((x) => x.url.startsWith('/open/')), 'bridge /open as before');
  });
});
