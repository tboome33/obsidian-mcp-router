/**
 * src/helpers/open-prefix.mjs — the click-to-open prefix a vault's bridge
 * announces (bridge 0.10.0+), read from `/ping`, then from Local REST API's
 * route list, else `/open/`.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_OPEN_PREFIX,
  PREFIX_TTL_MS,
  isValidOpenPrefix,
  prefixFromPing,
  prefixFromRoot,
  rememberOpenPrefixFromRoot,
  getOpenPrefix,
  describeOpenPrefix,
  resolveOpenPrefix,
  _resetOpenPrefixCache,
} from '../src/helpers/open-prefix.mjs';

const vault = { name: 'dedibox-hermes', type: 'local', baseUrl: 'https://127.0.0.1:27143' };
const NEW = '/mcp-router-bridge/open/';

/** Local REST API 5.4.0 root, as measured live on 2026-10-11 (trimmed). */
function root540(paths) {
  return {
    status: 'OK',
    apiExtensions: [
      { id: 'other-plugin', routes: [{ path: '/x/open/*', authenticated: false }] },
      {
        id: 'mcp-router-bridge',
        version: '0.10.0',
        routes: [
          { path: '/search/smart', authenticated: true },
          ...paths.map((path) => ({ path, authenticated: false })),
          { path: '/ping', authenticated: false },
        ],
      },
    ],
  };
}

beforeEach(() => _resetOpenPrefixCache());

describe('isValidOpenPrefix', () => {
  test('accepts the two real prefixes', () => {
    assert.ok(isValidOpenPrefix(NEW));
    assert.ok(isValidOpenPrefix('/open/'));
  });
  test('refuses anything that could move the host or escape the path', () => {
    for (const bad of [
      '', '/', 'open/', '/open', '//evil.example/', '/@evil.example/', '/a:b/', '/a?b/', '/a#b/',
      '/a%2F/', '/../', '/./', '/.hidden/', '/a\\b/', '/a b/', 'http://x/', null, 42, {}, `/${'a'.repeat(130)}/`,
    ]) {
      assert.equal(isValidOpenPrefix(bad), false, JSON.stringify(bad));
    }
  });
});

describe('prefixFromPing', () => {
  test('reads openPrefix off a bridge 0.10.0 pong', () => {
    assert.equal(prefixFromPing({ pong: true, openPrefix: NEW }), NEW);
  });
  test('a bridge < 0.10.0 pong, a non-pong, or a hostile prefix → null', () => {
    assert.equal(prefixFromPing({ pong: true }), null);
    assert.equal(prefixFromPing({ openPrefix: NEW }), null);
    assert.equal(prefixFromPing({ pong: true, openPrefix: '//evil.example/' }), null);
    assert.equal(prefixFromPing('pong'), null);
    assert.equal(prefixFromPing(null), null);
  });
});

describe('prefixFromRoot', () => {
  test('5.4.0 + bridge 0.10.0: only the plugin-id route is registered', () => {
    assert.equal(prefixFromRoot(root540(['/mcp-router-bridge/open/*'])), NEW);
  });
  test('5.1/5.2 + bridge 0.10.0: both registered → the plugin-id one wins', () => {
    assert.equal(prefixFromRoot(root540(['/mcp-router-bridge/open/*', '/open/*'])), NEW);
  });
  test('5.2 + bridge 0.9.1: only /open/* → /open/', () => {
    assert.equal(prefixFromRoot(root540(['/open/*'])), '/open/');
  });
  test('5.4.0 + bridge 0.9.1: no open route at all → null', () => {
    assert.equal(prefixFromRoot(root540([])), null);
  });
  test('a root without routes → null; another plugin\'s open route is ignored', () => {
    assert.equal(prefixFromRoot({ apiExtensions: [{ id: 'mcp-router-bridge', version: '0.10.0' }] }), null);
    assert.equal(prefixFromRoot({ apiExtensions: [{ id: 'other-plugin', routes: [{ path: '/x/open/*', authenticated: false }] }] }), null);
    assert.equal(prefixFromRoot(null), null);
  });
  test('an authenticated open route does not count', () => {
    const info = { apiExtensions: [{ id: 'mcp-router-bridge', routes: [{ path: '/mcp-router-bridge/open/*', authenticated: true }] }] };
    assert.equal(prefixFromRoot(info), null);
  });
});

describe('resolveOpenPrefix', () => {
  test('ping answers → its prefix, root never asked', async () => {
    let rootCalls = 0;
    const p = await resolveOpenPrefix(vault, {
      fetchPing: async () => ({ pong: true, openPrefix: NEW }),
      fetchRoot: async () => { rootCalls++; return {}; },
    });
    assert.equal(p, NEW);
    assert.equal(rootCalls, 0);
    assert.equal(getOpenPrefix(vault), NEW);
    assert.equal(describeOpenPrefix(vault).source, 'ping');
  });

  test('ping refused (remote: 403 loopback only) → the root route list', async () => {
    const p = await resolveOpenPrefix(vault, {
      fetchPing: async () => { throw Object.assign(new Error('loopback only'), { status: 403 }); },
      fetchRoot: async () => root540(['/mcp-router-bridge/open/*', '/open/*']),
    });
    assert.equal(p, NEW);
    assert.equal(describeOpenPrefix(vault).source, 'root');
  });

  test('old bridge: silent ping, root without an open route → /open/', async () => {
    const p = await resolveOpenPrefix(vault, {
      fetchPing: async () => ({ pong: true }),
      fetchRoot: async () => ({ apiExtensions: [{ id: 'mcp-router-bridge', version: '0.9.1' }] }),
    });
    assert.equal(p, LEGACY_OPEN_PREFIX);
    assert.equal(describeOpenPrefix(vault).source, 'fallback');
  });

  test('everything fails → /open/, never throws', async () => {
    const boom = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await resolveOpenPrefix(vault, { fetchPing: boom, fetchRoot: boom }), LEGACY_OPEN_PREFIX);
    assert.equal(await resolveOpenPrefix(null, {}), LEGACY_OPEN_PREFIX);
  });

  test('a fresh answer is reused; after the TTL it is asked again', async () => {
    let t = 1_000;
    let calls = 0;
    const probes = {
      fetchPing: async () => { calls++; return { pong: true, openPrefix: NEW }; },
      fetchRoot: async () => ({}),
      now: () => t,
    };
    await resolveOpenPrefix(vault, probes);
    t += PREFIX_TTL_MS - 1;
    await resolveOpenPrefix(vault, probes);
    assert.equal(calls, 1);
    t += 2;
    await resolveOpenPrefix(vault, probes);
    assert.equal(calls, 2);
  });

  test('concurrent callers share one probe', async () => {
    let calls = 0;
    const probes = {
      fetchPing: async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return { pong: true, openPrefix: NEW }; },
    };
    const all = await Promise.all([1, 2, 3].map(() => resolveOpenPrefix(vault, probes)));
    assert.deepEqual(all, [NEW, NEW, NEW]);
    assert.equal(calls, 1);
  });

  test('the cache is keyed by name AND baseUrl', async () => {
    await resolveOpenPrefix(vault, { fetchPing: async () => ({ pong: true, openPrefix: NEW }) });
    assert.equal(getOpenPrefix({ ...vault, baseUrl: 'https://127.0.0.1:1' }), LEGACY_OPEN_PREFIX);
  });
});

describe('getOpenPrefix / rememberOpenPrefixFromRoot', () => {
  test('never asked → /open/', () => {
    assert.equal(getOpenPrefix(vault), LEGACY_OPEN_PREFIX);
  });
  test('a root that lists the route feeds the cache; a root without routes does not overwrite it', () => {
    rememberOpenPrefixFromRoot(vault, root540(['/mcp-router-bridge/open/*']));
    assert.equal(getOpenPrefix(vault), NEW);
    rememberOpenPrefixFromRoot(vault, { apiExtensions: [{ id: 'mcp-router-bridge' }] });
    assert.equal(getOpenPrefix(vault), NEW);
  });
});
