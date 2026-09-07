/**
 * THE PING MUST PROVE IDENTITY, NOT MERELY LIVENESS.
 *
 * `GET /` on Local REST API is PUBLIC: it answers 200 to anyone, with or
 * without a key. So "it answered" never proved the vault we asked for is the
 * vault that replied. Two vaults configured for one port make that gap
 * observable — the loser fails to bind, the winner answers the loser's ping,
 * and `list_vaults` prints `online: true` for a vault whose Obsidian is closed.
 *
 * Measured on the real fleet (2026-09-08): `C:\VAULTS\Roland` was closed, a
 * different vault held its port 27126, and the router reported it online with a
 * latency. The identity signal lives in the same response for free —
 * `authenticated` is true only when the server accepted OUR key, and keys are
 * per-vault.
 *
 * These tests stand up REAL servers rather than stubbing the client, because
 * the claim is about what comes back over the wire.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { pingVault } from '../src/rest-client.mjs';
import { listVaults } from '../src/tools/list-vaults.mjs';

/**
 * A stand-in for Local REST API: a PUBLIC `GET /` that reports whether it
 * accepted the caller's key, and a PROTECTED `GET /vault/` that 401s without it.
 *
 * @param {object} opts
 * @param {string|null} opts.key the ONE key this server accepts
 * @param {boolean} [opts.reportAuthentication=true] false = an older plugin
 *   that never sends the `authenticated` field at all
 * @param {boolean} [opts.anonymousRootOnly=false] the PROXY shape: `/` is
 *   answered anonymously (cached, or auth stripped on the public route) while
 *   authenticated routes are forwarded correctly. A healthy vault that merely
 *   LOOKS unauthenticated on `/`.
 */
function startFakeVaultServer({ key, reportAuthentication = true, anonymousRootOnly = false }) {
  const server = http.createServer((req, res) => {
    const sent = /^Bearer (.*)$/.exec(req.headers.authorization || '')?.[1] ?? null;
    const accepted = key !== null && sent === key;

    // Authorisation BEFORE existence — measured against Local REST API 4.0.2,
    // and the whole reason the probe can ask for a path that cannot exist.
    if (req.url.startsWith('/vault/')) {
      if (!accepted) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Authorization required.', errorCode: 40101 }));
        return;
      }
      if (req.url === '/vault/') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ files: ['wiki/'] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not found', errorCode: 40400 }));
      return;
    }

    const body = {
      status: 'OK',
      manifest: { id: 'obsidian-local-rest-api', version: '4.0.2' },
      versions: { obsidian: '1.13.7', self: '4.0.2' },
      service: 'Obsidian Local REST API',
      ...(reportAuthentication ? { authenticated: anonymousRootOnly ? false : accepted } : {}),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const vaultAt = (name, baseUrl, apiKey) => ({ name, type: 'remote', baseUrl, apiKey, timeoutMs: 2000 });

describe('pingVault — identity, not just liveness', () => {
  let owner;      // the server that holds the port, keyed 'KEY-A'
  let silent;     // a server that never reports `authenticated`

  before(async () => {
    owner = await startFakeVaultServer({ key: 'KEY-A' });
    silent = await startFakeVaultServer({ key: 'KEY-A', reportAuthentication: false });
  });
  after(() => { owner.server.close(); silent.server.close(); });

  test('the right vault with the right key is CONFIRMED online', async () => {
    const r = await pingVault(vaultAt('a', owner.baseUrl, 'KEY-A'));
    assert.equal(r.online, true);
    assert.equal(r.identity, 'confirmed');
    assert.equal(r.error, undefined);
  });

  // THE regression. Vault B holds the port; we ask for vault A with A's key.
  test('a SQUATTED port is not online — the answer came from another vault', async () => {
    const r = await pingVault(vaultAt('roland', owner.baseUrl, 'KEY-B-DIFFERENT'));
    assert.equal(r.online, false, 'a stranger answering must never read as online');
    assert.equal(r.identity, 'rejected');
    assert.match(r.error, /REFUSED this vault's API key/);
    assert.match(r.error, /roland/, 'the message must name the vault that was asked for');
  });

  test('an older plugin that reports nothing is UNVERIFIED, not condemned', async () => {
    // Silence is not a denial: the pre-identity behaviour is preserved.
    const r = await pingVault(vaultAt('a', silent.baseUrl, 'ANY-KEY'));
    assert.equal(r.online, true);
    assert.equal(r.identity, 'unverified');
  });

  // The actual regression for the keyless gate: a response CLAIMING
  // `authenticated: true` must not become `confirmed` when no key was sent —
  // nothing was accepted, so nothing is confirmed. A cached or proxy-generated
  // body can carry that shape.
  test('no key + a response claiming authenticated:true is UNVERIFIED, not confirmed', async () => {
    const liar = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK', authenticated: true }));
    });
    await new Promise((r) => liar.listen(0, '127.0.0.1', r));
    try {
      const { port } = liar.address();
      const r = await pingVault(vaultAt('keyless-but-flattered', `http://127.0.0.1:${port}`, null));
      assert.equal(r.online, true);
      assert.equal(r.identity, 'unverified', 'no key was sent, so nothing was accepted');
    } finally {
      liar.close();
    }
  });

  test('a vault we hold NO key for is unverified, never reported as squatted', async () => {
    // `authenticated:false` is the correct answer here — there was no key to
    // accept. Calling it a squatter would turn missingApiKey into a phantom
    // port collision.
    const r = await pingVault(vaultAt('keyless', owner.baseUrl, null));
    assert.equal(r.online, true);
    assert.equal(r.identity, 'unverified');
  });

  test('nothing listening is unreachable, and says so', async () => {
    const r = await pingVault(vaultAt('gone', 'http://127.0.0.1:1', 'KEY-A'));
    assert.equal(r.online, false);
    assert.equal(r.identity, 'unreachable');
    assert.ok(r.error);
  });

  // THE FALSE POSITIVE GUARD — the worst thing this function can do is take a
  // WORKING vault offline. A proxy may answer the public `/` anonymously (or
  // from cache) while forwarding authenticated routes perfectly well. The public
  // route's word alone must never condemn: the demotion is confirmed against a
  // route that actually requires the key.
  test('a vault whose PUBLIC route looks anonymous but whose authenticated routes work stays ONLINE', async () => {
    const proxied = await startFakeVaultServer({ key: 'KEY-A', anonymousRootOnly: true });
    try {
      const r = await pingVault(vaultAt('behind-proxy', proxied.baseUrl, 'KEY-A'));
      assert.equal(r.online, true, 'a healthy vault must not be demoted on the public route alone');
      assert.notEqual(r.identity, 'rejected');
      assert.equal(r.identity, 'unverified', 'we could not prove identity, and we must not pretend otherwise');
    } finally {
      proxied.server.close();
    }
  });

  // The confirmation must not become a reason to read the vault. It asks for a
  // path that cannot exist, so a healthy vault answers 404 and nothing is
  // listed; only the 401 decides.
  test('the confirming request reads NO vault content — it asks for a path that cannot exist', async () => {
    const seen = [];
    const watcher = http.createServer((req, res) => {
      seen.push(req.url);
      const sent = /^Bearer (.*)$/.exec(req.headers.authorization || '')?.[1] ?? null;
      if (req.url.startsWith('/vault/')) {
        res.writeHead(sent === 'KEY-A' ? 404 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'x' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK', authenticated: false }));
    });
    await new Promise((r) => watcher.listen(0, '127.0.0.1', r));
    try {
      const { port } = watcher.address();
      await pingVault(vaultAt('probed', `http://127.0.0.1:${port}`, 'KEY-B'));
      const vaultCalls = seen.filter((u) => u.startsWith('/vault/'));
      assert.equal(vaultCalls.length, 1, 'exactly one confirming request');
      assert.notEqual(vaultCalls[0], '/vault/', 'never the root listing');
      assert.match(vaultCalls[0], /does-not-exist/, 'a path chosen because it is overwhelmingly unlikely to exist');
      assert.ok(!vaultCalls[0].includes('/.'), 'no leading dot — a dot-path policy would 401 for the wrong reason');
    } finally {
      watcher.close();
    }
  });
});

describe('list_vaults carries the identity verdict', () => {
  let owner;
  before(async () => { owner = await startFakeVaultServer({ key: 'KEY-A' }); });
  after(() => { owner.server.close(); });

  test('a squatted vault is listed offline WITH the reason, not silently up', async () => {
    const registry = {
      vaults: [vaultAt('squatted', owner.baseUrl, 'NOT-THE-RIGHT-KEY')],
      skipped: [], configPath: '/c',
    };
    const out = await listVaults(registry);
    const row = out.vaults.find((v) => v.name === 'squatted');
    assert.equal(row.online, false);
    assert.equal(row.identity, 'rejected');
    assert.match(row.error, /REFUSED this vault's API key/);
  });

  test('a healthy vault reports identity confirmed', async () => {
    const registry = {
      vaults: [vaultAt('healthy', owner.baseUrl, 'KEY-A')],
      skipped: [], configPath: '/c',
    };
    const out = await listVaults(registry);
    const row = out.vaults.find((v) => v.name === 'healthy');
    assert.equal(row.online, true);
    assert.equal(row.identity, 'confirmed');
  });

  test('the field is ALWAYS present — an unreachable vault carries one too', async () => {
    const registry = {
      vaults: [vaultAt('gone', 'http://127.0.0.1:1', 'KEY-A')],
      skipped: [], configPath: '/c',
    };
    const out = await listVaults(registry);
    const row = out.vaults.find((v) => v.name === 'gone');
    assert.equal(row.online, false);
    assert.equal(row.identity, 'unreachable');
  });
});
