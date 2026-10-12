/**
 * The announced click-to-open prefix, end to end against a fake Local REST API
 * + bridge over real HTTP: `resolveVaultOpenPrefix` (rest-client), the link
 * builder, `openInObsidian`, the `pingVault` side feed, and the dispatcher's
 * `warmOpenPrefix`.
 *
 * Three setups, each one measured live on 2026-10-11:
 *   - '540-new'  Local REST API 5.4.0 + bridge 0.10.0: /ping announces
 *                /mcp-router-bridge/open/, GET /open/* is 5.4.0's own
 *                authenticated route (401 without a key, no GET with one).
 *   - '4x-old'   Local REST API 4.x + bridge 0.9.1: bare pong, root lists only
 *                /open/* — or nothing.
 *   - 'remote'   a vault reached over a network: the bridge's /ping refuses
 *                (403 loopback only), the authenticated root lists the routes.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  resolveVaultOpenPrefix,
  openInObsidian,
  pingVault,
} from '../src/rest-client.mjs';
import { buildClickToOpenUrl } from '../src/helpers/click-to-open.mjs';
import {
  getOpenPrefix,
  rememberOpenPrefix,
  describeOpenPrefix,
  _resetOpenPrefixCache,
} from '../src/helpers/open-prefix.mjs';
import { warmOpenPrefix, OPEN_LINK_TOOLS } from '../src/index.mjs';

const NEW = '/mcp-router-bridge/open/';
let server;
let port;
let mode = '540-new';
let received = [];

function rootBody(paths) {
  return {
    status: 'OK',
    authenticated: true,
    apiExtensions: [{
      id: 'mcp-router-bridge',
      version: mode === '4x-old' ? '0.9.1' : '0.10.0',
      ...(paths ? { routes: paths.map((path) => ({ path, authenticated: false })) } : {}),
    }],
  };
}

before(async () => {
  server = http.createServer((req, res) => {
    received.push(req.url);
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/ping') {
      if (mode === 'remote') return json(403, { message: 'loopback only' });
      return json(200, mode === '540-new' ? { pong: true, openPrefix: NEW } : { pong: true });
    }
    if (req.url === '/') {
      if (mode === '540-new') return json(200, rootBody(['/mcp-router-bridge/open/*', '/ping']));
      if (mode === 'remote') return json(200, rootBody(['/mcp-router-bridge/open/*', '/open/*', '/ping']));
      return json(200, rootBody(null));
    }
    if (req.url.startsWith('/mcp-router-bridge/open/') && mode !== '4x-old') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<p>opened</p>');
    }
    if (req.url.startsWith('/open/')) {
      if (mode === '540-new') return json(404, { message: 'Not Found', errorCode: 40400 });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<p>opened</p>');
    }
    return json(404, { message: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  _resetOpenPrefixCache();
  received = [];
  mode = '540-new';
});

function vaultDesc(name = 'v') {
  return {
    name,
    type: 'remote',
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k',
    timeoutMs: 3000,
    insecurePort: 27153,
  };
}

describe('resolveVaultOpenPrefix over HTTP', () => {
  test('5.4.0 + bridge 0.10.0 → the announced prefix, from /ping', async () => {
    const v = vaultDesc();
    assert.equal(await resolveVaultOpenPrefix(v), NEW);
    assert.equal(describeOpenPrefix(v).source, 'ping');
    assert.ok(!received.includes('/'), 'root not needed');
  });

  test('remote (ping 403) → the route list of the authenticated root', async () => {
    mode = 'remote';
    const v = vaultDesc();
    assert.equal(await resolveVaultOpenPrefix(v), NEW);
    assert.equal(describeOpenPrefix(v).source, 'root');
  });

  test('4.x + bridge 0.9.1 → /open/', async () => {
    mode = '4x-old';
    assert.equal(await resolveVaultOpenPrefix(vaultDesc()), '/open/');
  });

  test('nothing listening → /open/, no throw', async () => {
    const v = { ...vaultDesc(), baseUrl: 'http://127.0.0.1:1' };
    assert.equal(await resolveVaultOpenPrefix(v), '/open/');
  });
});

describe('buildClickToOpenUrl uses the announced prefix', () => {
  test('after a resolve, the link carries /mcp-router-bridge/open/', async () => {
    const v = vaultDesc();
    assert.equal(buildClickToOpenUrl(v, 'wiki/index.md'), 'http://127.0.0.1:27153/open/wiki%2Findex.md');
    await resolveVaultOpenPrefix(v);
    assert.equal(buildClickToOpenUrl(v, 'wiki/index.md'), `http://127.0.0.1:27153${NEW}wiki%2Findex.md`);
    assert.equal(
      buildClickToOpenUrl(v, 'wiki/index.md', { anchor: 'Top' }),
      `http://127.0.0.1:27153${NEW}wiki%2Findex.md?h=Top`,
    );
  });

  test('opts.openPrefix wins; an invalid one yields null, never a foreign host', () => {
    const v = vaultDesc();
    rememberOpenPrefix(v, NEW, 'ping');
    assert.equal(buildClickToOpenUrl(v, 'a.md', { openPrefix: '/open/' }), 'http://127.0.0.1:27153/open/a.md');
    for (const bad of ['@evil.example/', '//evil.example/', '/a?b/', '', null]) {
      assert.equal(buildClickToOpenUrl(v, 'a.md', { openPrefix: bad }), null, String(bad));
    }
  });
});

describe('openInObsidian follows the announced prefix', () => {
  test('5.4.0: GETs /mcp-router-bridge/open/, never the reserved /open/', async () => {
    await openInObsidian(vaultDesc(), 'wiki/Divers/foo.md', { anchor: 'Section 2' });
    assert.ok(received.includes(`${NEW}wiki%2FDivers%2Ffoo.md?h=Section%202`), received.join(' '));
    assert.ok(!received.some((u) => u.startsWith('/open/')));
  });

  test('4.x + old bridge: still /open/', async () => {
    mode = '4x-old';
    await openInObsidian(vaultDesc(), 'wiki/foo.md');
    assert.ok(received.includes('/open/wiki%2Ffoo.md'));
  });
});

describe('pingVault feeds the cache from the root it already fetched', () => {
  test('a root listing the route records it without a /ping', async () => {
    mode = 'remote';
    const v = vaultDesc();
    const r = await pingVault(v);
    assert.equal(r.online, true);
    assert.equal(getOpenPrefix(v), NEW);
    assert.ok(!received.includes('/ping'));
  });

  test('a root without routes leaves the cache alone', async () => {
    mode = '4x-old';
    const v = vaultDesc();
    rememberOpenPrefix(v, NEW, 'ping');
    await pingVault(v);
    assert.equal(getOpenPrefix(v), NEW);
  });
});

describe('warmOpenPrefix (dispatcher)', () => {
  test('covers the tools that emit links or call the open route', () => {
    for (const t of ['get_file', 'write_file', 'patch_file', 'write_bundle', 'build_open_link', 'open_in_obsidian', 'search']) {
      assert.ok(OPEN_LINK_TOOLS.has(t), t);
    }
  });

  test('resolves the target vault; skips one with no plaintext port; never throws', async () => {
    const asked = [];
    const resolve = async (v) => { asked.push(v.name); return NEW; };
    const withPort = vaultDesc('a');
    const noPort = { ...vaultDesc('b'), insecurePort: undefined };
    const reg = {
      vaults: [withPort, noPort],
      resolveVault: (n) => {
        if (n === 'missing') throw new Error('unknown vault');
        return n === 'b' ? noPort : withPort;
      },
    };
    await warmOpenPrefix(reg, { vault: 'a' }, resolve);
    await warmOpenPrefix(reg, { vault: 'b' }, resolve);
    await warmOpenPrefix(reg, { vault: 'missing' }, resolve);
    await warmOpenPrefix(reg, { vault: 'a' }, async () => { throw new Error('boom'); });
    assert.deepEqual(asked, ['a']);
  });

  test('vault "*" warms every vault that can carry a link, in parallel', async () => {
    const asked = [];
    const reg = {
      vaults: [vaultDesc('a'), vaultDesc('c'), { ...vaultDesc('b'), insecurePort: undefined }],
      resolveVault: () => { throw new Error('not used'); },
    };
    await warmOpenPrefix(reg, { vault: '*' }, async (v) => { asked.push(v.name); return NEW; });
    assert.deepEqual(asked.sort(), ['a', 'c']);
  });
});

// Codex review, 2026-10-11: the "*" warm-up must reach exactly the vaults the
// fan-out itself would query.
describe('warmOpenPrefix — vault "*" respects the session\'s reach (codex review)', () => {
  test('a locked session warms nothing (the search refuses "*" there)', async () => {
    const asked = [];
    const reg = { lockedVault: 'a', vaults: [vaultDesc('a'), vaultDesc('c')], resolveVault: () => { throw new Error('x'); } };
    await warmOpenPrefix(reg, { vault: '*' }, async (v) => { asked.push(v.name); return NEW; });
    assert.deepEqual(asked, []);
  });

  test('vaults without a key, or outside the workspace\'s declared reach, are not probed', async () => {
    const asked = [];
    const reg = {
      vaultReach: 'declared',
      openVaults: ['a', 'nokey'],
      workspaceBinding: null,
      vaults: [vaultDesc('a'), { ...vaultDesc('nokey'), missingApiKey: true }, vaultDesc('outside')],
      resolveVault: () => { throw new Error('x'); },
    };
    await warmOpenPrefix(reg, { vault: '*' }, async (v) => { asked.push(v.name); return NEW; });
    assert.deepEqual(asked, ['a']);
  });
});
