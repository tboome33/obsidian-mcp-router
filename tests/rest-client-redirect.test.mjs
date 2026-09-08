/**
 * REDIRECTS ARE FOLLOWED WITHIN AN ORIGIN, NOT WITHIN A HOSTNAME.
 *
 * On loopback every vault is a port. The redirect follower compared hostnames
 * only, so a listener on port A could answer `302 → http://127.0.0.1:B/` and
 * have the router carry the bearer key to B — and report B's answer under A's
 * registry entry (pen-test scenario A5, 2026-09-08). The one cross-port
 * redirect that stays allowed is the http→https upgrade on the same hostname,
 * which is what a reverse proxy on :80 does.
 *
 * Real servers, as everywhere the claim is about the wire: the sink RECORDS
 * whether the key reached it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { pingVault } from '../src/rest-client.mjs';

const KEY = 'KEY-REDIRECT';

function serve(handler) {
  const seen = { requests: [], gotKey: false };
  const server = http.createServer((req, res) => {
    seen.requests.push(req.url);
    if ((req.headers.authorization || '').includes(KEY)) seen.gotKey = true;
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}
const closeAll = (...servers) => Promise.all(servers.map((s) => new Promise((r) => { s.server.closeAllConnections?.(); s.server.close(r); })));
const vaultAt = (port) => ({ name: 'v', type: 'local', baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY, timeoutMs: 2000 });
const ok = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

describe('redirect follower — same origin, not same hostname', () => {
  test('same host, ANOTHER port: refused, and the key never reaches the other port', async () => {
    const sink = await serve((req, res) => ok(res, { status: 'OK', authenticated: true }));
    const front = await serve((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${sink.port}/` }); res.end(); });
    try {
      const r = await pingVault(vaultAt(front.port));
      assert.equal(sink.seen.requests.length, 0, 'the sink must never be contacted');
      assert.equal(sink.seen.gotKey, false, 'and so never sees the key');
      assert.equal(r.online, false);
      assert.equal(r.identity, 'unverified', 'a 302 is an answer, and not one we can use');
      assert.match(r.error, /cross-origin redirect/);
    } finally {
      await closeAll(sink, front);
    }
  });

  test('same host, same port, another path: followed, key preserved', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/') { res.writeHead(302, { location: '/index' }); res.end(); return; }
      ok(res, { status: 'OK', authenticated: true });
    });
    try {
      const r = await pingVault(vaultAt(s.port));
      assert.deepEqual(s.seen.requests, ['/', '/index']);
      assert.equal(r.identity, 'confirmed');
    } finally {
      await closeAll(s);
    }
  });

  test('http → https on an ARBITRARY port is not an upgrade, it is the cross-port attack over TLS: refused', async () => {
    // Every local vault runs with `tlsInsecure`, so a self-signed listener on
    // port B would receive the key over TLS and have its answer attributed to
    // A. Speaking TLS does not make B the vault. The one upgrade allowed is
    // default port to default port (80 → 443), which loopback vaults never use.
    const sink = await serve((req, res) => ok(res, { status: 'OK', authenticated: true }));
    const front = await serve((req, res) => { res.writeHead(302, { location: `https://127.0.0.1:${sink.port}/` }); res.end(); });
    try {
      const r = await pingVault({ ...vaultAt(front.port), tlsInsecure: true });
      assert.equal(front.seen.requests.length, 1, 'the front WAS asked — this is a refused redirect, not a missed one');
      assert.match(r.error, /cross-origin redirect/);
      assert.equal(sink.seen.requests.length, 0, 'the sink was never contacted');
      assert.equal(sink.seen.gotKey, false);
      assert.equal(r.identity, 'unverified');
    } finally {
      await closeAll(sink, front);
    }
  });

  test('a redirect whose NEXT hop stalls is still an answer — the 302 is kept, the verdict is unverified, not unreachable', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/') { res.writeHead(302, { location: '/next' }); res.end(); return; }
      // '/next': accepted, never answered
    });
    try {
      const t0 = Date.now();
      const r = await pingVault({ ...vaultAt(s.port), timeoutMs: 400 });
      assert.ok(Date.now() - t0 < 5000);
      assert.deepEqual(s.seen.requests, ['/', '/next']);
      assert.equal(r.online, false);
      assert.equal(r.identity, 'unverified', 'the endpoint answered with a 302 before the next hop failed');
    } finally {
      await closeAll(s);
    }
  });

  test('same host, same PORT, another scheme (http → https on 8443) is still another origin: refused', async () => {
    // Equal ports are not equal origins when the scheme changes (round-9
    // review): the only cross-scheme redirect allowed is the 80 → 443 upgrade.
    const front = await serve((req, res) => { res.writeHead(302, { location: `https://127.0.0.1:${req.socket.localPort}/` }); res.end(); });
    try {
      const r = await pingVault({ ...vaultAt(front.port), tlsInsecure: true });
      assert.equal(front.seen.requests.length, 1);
      assert.match(r.error, /cross-origin redirect/);
      assert.equal(r.identity, 'unverified');
    } finally {
      await closeAll(front);
    }
  });

  test('a 302 followed by an endless body does not hold the call, and the discarded response is CANCELLED — the server sees its connection close', async () => {
    let timer;
    let redirectClosed;
    const s = await serve((req, res) => {
      if (req.url === '/') {
        redirectClosed = new Promise((resolve) => res.on('close', resolve));
        res.writeHead(302, { location: '/index' });
        timer = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write('x'); }, 5);
        return;
      }
      ok(res, { status: 'OK', authenticated: true });
    });
    try {
      const t0 = Date.now();
      const r = await pingVault(vaultAt(s.port));
      assert.ok(Date.now() - t0 < 5000);
      assert.equal(r.identity, 'confirmed');
      // The witness of the cancellation itself, BEFORE any cleanup of ours
      // could close the socket: the server's side of the redirect response
      // must have seen 'close' — which only the client's cancel produces.
      const closedInTime = await Promise.race([
        redirectClosed.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      assert.equal(closedInTime, true, 'the discarded 302 stream was not cancelled — its connection stayed open');
    } finally {
      clearInterval(timer);
      await closeAll(s);
    }
  });

  test('a different hostname spelling of loopback is still cross-origin', async () => {
    const front = await serve((req, res) => { res.writeHead(302, { location: 'http://localhost:1/' }); res.end(); });
    try {
      const r = await pingVault(vaultAt(front.port));
      assert.equal(r.identity, 'unverified');
      assert.match(r.error, /cross-origin redirect/);
    } finally {
      await closeAll(front);
    }
  });
});
