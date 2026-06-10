/**
 * Tests for src/helpers/smart-link.mjs — token build/verify, URL shape, env gating,
 * and the CROSS-IMPLEMENTATION test vector shared with the resolver (private saas repo):
 * both implementations must produce the SAME literal token for the same inputs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSmartLinkToken,
  verifySmartLinkToken,
  buildSmartLink,
  smartLinkEnabled,
  DEFAULT_SMART_LINK_TTL_SECONDS,
} from '../src/helpers/smart-link.mjs';

const SECRET = 'unit-test-secret-not-real';

describe('buildSmartLinkToken / verifySmartLinkToken — round-trip', () => {
  test('round-trips vault + note', () => {
    const token = buildSmartLinkToken({
      vault: 'roland',
      note: 'Voyages/Japon 2026.md',
      secret: SECRET,
      nowSeconds: 1_750_000_000,
    });
    const v = verifySmartLinkToken({ token, secret: SECRET, nowSeconds: 1_750_000_000 });
    assert.deepEqual(v, { ok: true, vault: 'roland', note: 'Voyages/Japon 2026.md' });
  });

  test('default TTL is 30 days (exp = now + 2592000)', () => {
    assert.equal(DEFAULT_SMART_LINK_TTL_SECONDS, 2_592_000);
    const token = buildSmartLinkToken({ vault: 'r', note: 'a.md', secret: SECRET, nowSeconds: 100 });
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(payload.exp, 100 + 2_592_000);
  });

  test('payload JSON keys are in contract order v,n,exp', () => {
    const token = buildSmartLinkToken({ vault: 'r', note: 'a.md', secret: SECRET, nowSeconds: 100 });
    const json = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    assert.match(json, /^\{"v":"r","n":"a\.md","exp":2592100\}$/);
  });

  test('expired token → { ok:false, reason:"expired" }', () => {
    const token = buildSmartLinkToken({
      vault: 'r',
      note: 'a.md',
      ttlSeconds: 60,
      secret: SECRET,
      nowSeconds: 1000,
    });
    // Still valid AT exp...
    assert.equal(verifySmartLinkToken({ token, secret: SECRET, nowSeconds: 1060 }).ok, true);
    // ...rejected strictly after.
    assert.deepEqual(verifySmartLinkToken({ token, secret: SECRET, nowSeconds: 1061 }), {
      ok: false,
      reason: 'expired',
    });
  });

  test('tampered signature → bad-signature', () => {
    const token = buildSmartLinkToken({ vault: 'r', note: 'a.md', secret: SECRET, nowSeconds: 100 });
    const [payload, sig] = token.split('.');
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    assert.deepEqual(verifySmartLinkToken({ token: `${payload}.${flipped}`, secret: SECRET }), {
      ok: false,
      reason: 'bad-signature',
    });
  });

  test('tampered payload (claims swap) → bad-signature', () => {
    const token = buildSmartLinkToken({ vault: 'r', note: 'a.md', secret: SECRET, nowSeconds: 100 });
    const sig = token.split('.')[1];
    const forged = Buffer.from(
      JSON.stringify({ v: 'other-vault', n: 'a.md', exp: 9999999999 }),
      'utf8',
    ).toString('base64url');
    assert.equal(verifySmartLinkToken({ token: `${forged}.${sig}`, secret: SECRET }).ok, false);
  });

  test('wrong secret → bad-signature', () => {
    const token = buildSmartLinkToken({ vault: 'r', note: 'a.md', secret: SECRET, nowSeconds: 100 });
    assert.deepEqual(verifySmartLinkToken({ token, secret: 'another-fake-secret' }), {
      ok: false,
      reason: 'bad-signature',
    });
  });

  test('malformed tokens → { ok:false } without throwing', () => {
    for (const bad of ['', 'no-dot', '.leading', 'trailing.', 'a.b.c-extra-ok-but-garbage', null, 42]) {
      const v = verifySmartLinkToken({ token: bad, secret: SECRET });
      assert.equal(v.ok, false, `token ${JSON.stringify(bad)} must be rejected`);
    }
  });

  test('build validates its inputs', () => {
    assert.throws(() => buildSmartLinkToken({ note: 'a.md', secret: SECRET }), /vault/);
    assert.throws(() => buildSmartLinkToken({ vault: 'r', secret: SECRET }), /note/);
    assert.throws(() => buildSmartLinkToken({ vault: 'r', note: 'a.md' }), /secret/);
  });
});

describe('cross-implementation test vector (contract 1 — pinned in router AND resolver)', () => {
  // secret='test-secret', v='roland', n='wiki/Test.md', exp=4102444800 (2100-01-01) →
  // the resolver test suite pins this SAME literal string:
  // eyJ2Ijoicm9sYW5kIiwibiI6Indpa2kvVGVzdC5tZCIsImV4cCI6NDEwMjQ0NDgwMH0.gLwMDgNPpdKOLbPjFItr88D0d_l-5WVzN5JMXgNT6w0
  const VECTOR_TOKEN =
    'eyJ2Ijoicm9sYW5kIiwibiI6Indpa2kvVGVzdC5tZCIsImV4cCI6NDEwMjQ0NDgwMH0.' +
    'gLwMDgNPpdKOLbPjFItr88D0d_l-5WVzN5JMXgNT6w0';

  test('produces the exact pinned token', () => {
    const token = buildSmartLinkToken({
      vault: 'roland',
      note: 'wiki/Test.md',
      ttlSeconds: 0,
      secret: 'test-secret',
      nowSeconds: 4102444800, // exp = nowSeconds + 0
    });
    assert.equal(token, VECTOR_TOKEN);
  });

  test('verifies the pinned token', () => {
    const v = verifySmartLinkToken({
      token: VECTOR_TOKEN,
      secret: 'test-secret',
      nowSeconds: 1_750_000_000,
    });
    assert.deepEqual(v, { ok: true, vault: 'roland', note: 'wiki/Test.md' });
  });
});

describe('buildSmartLink — URL shape (contract 2)', () => {
  test('`${base}/o/${token}` with no query string', () => {
    const url = buildSmartLink({
      baseUrl: 'https://open.example.test',
      vault: 'roland',
      note: 'wiki/Test.md',
      secret: SECRET,
      nowSeconds: 100,
    });
    assert.match(url, /^https:\/\/open\.example\.test\/o\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!url.includes('?'), 'no query string');
    const token = url.slice(url.indexOf('/o/') + 3);
    assert.equal(verifySmartLinkToken({ token, secret: SECRET, nowSeconds: 100 }).ok, true);
  });

  test('trailing slash(es) on baseUrl are normalized', () => {
    const a = buildSmartLink({ baseUrl: 'https://x.test', vault: 'r', note: 'a.md', secret: SECRET, nowSeconds: 1 });
    const b = buildSmartLink({ baseUrl: 'https://x.test/', vault: 'r', note: 'a.md', secret: SECRET, nowSeconds: 1 });
    assert.equal(a, b);
    assert.ok(!a.includes('//o/'), 'no double slash before /o/');
  });

  test('missing baseUrl throws', () => {
    assert.throws(() => buildSmartLink({ vault: 'r', note: 'a.md', secret: SECRET }), /baseUrl/);
  });
});

describe('smartLinkEnabled — env gating', () => {
  test('true only when BOTH vars are set and non-empty', () => {
    const url = 'https://open.example.test';
    assert.equal(smartLinkEnabled({ OBSIDIAN_ROUTER_SMART_LINK_URL: url, OBSIDIAN_ROUTER_SMART_LINK_SECRET: 's' }), true);
    assert.equal(smartLinkEnabled({ OBSIDIAN_ROUTER_SMART_LINK_URL: url }), false);
    assert.equal(smartLinkEnabled({ OBSIDIAN_ROUTER_SMART_LINK_SECRET: 's' }), false);
    assert.equal(smartLinkEnabled({}), false);
  });

  test('whitespace-only values count as unset', () => {
    assert.equal(
      smartLinkEnabled({ OBSIDIAN_ROUTER_SMART_LINK_URL: '   ', OBSIDIAN_ROUTER_SMART_LINK_SECRET: 's' }),
      false,
    );
    assert.equal(
      smartLinkEnabled({ OBSIDIAN_ROUTER_SMART_LINK_URL: 'https://x.test', OBSIDIAN_ROUTER_SMART_LINK_SECRET: '  ' }),
      false,
    );
  });
});
