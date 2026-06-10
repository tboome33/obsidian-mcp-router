/**
 * smart-link helper — emits the STABLE per-note "smart link" that points at the
 * device-side resolver (see the smart-link-resolver spec / private saas repo):
 *
 *   ${OBSIDIAN_ROUTER_SMART_LINK_URL}/o/${token}
 *
 * The token is a signed, self-contained claim { vault, note, exp }:
 *
 *   payload = base64url( JSON.stringify({ v, n, exp }) )    // key order v,n,exp — FIXED
 *   sig     = base64url( HMAC-SHA256(secret, payload) )     // secret = raw UTF-8 string
 *   token   = payload + '.' + sig
 *
 * Emission is a PURE HMAC computation — zero network. That is the point: unlike the
 * view-agent path, a smart link can never slow a note write down or fail transiently.
 * `verifySmartLinkToken` lives here too so the cross-implementation test vector is
 * pinned in ONE place (the resolver re-implements verification against the same vector).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default token TTL: 30 days (the link is meant to stay valid in chat history). */
export const DEFAULT_SMART_LINK_TTL_SECONDS = 30 * 24 * 60 * 60; // 2592000

/**
 * Build a signed smart-link token for a note.
 * @param {object}  opts
 * @param {string}  opts.vault              canonical vault name (token claim `v`)
 * @param {string}  opts.note               vault-relative note path WITH .md (claim `n`)
 * @param {number} [opts.ttlSeconds]        lifetime; exp = nowSeconds + ttlSeconds
 * @param {string}  opts.secret             HMAC secret (raw UTF-8 string)
 * @param {number} [opts.nowSeconds]        injectable clock (unix seconds) for tests
 * @returns {string} token = base64url(payload) + '.' + base64url(sig)
 */
export function buildSmartLinkToken({
  vault,
  note,
  ttlSeconds = DEFAULT_SMART_LINK_TTL_SECONDS,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  if (typeof vault !== 'string' || !vault) throw new Error('buildSmartLinkToken: missing `vault`');
  if (typeof note !== 'string' || !note) throw new Error('buildSmartLinkToken: missing `note`');
  if (typeof secret !== 'string' || !secret) throw new Error('buildSmartLinkToken: missing `secret`');
  const exp = nowSeconds + ttlSeconds;
  // Key order v,n,exp is part of the cross-implementation contract (the resolver
  // re-serializes nothing — it verifies the OPAQUE payload string — but tests on both
  // sides pin the same literal token, which requires deterministic serialization).
  const payload = Buffer.from(JSON.stringify({ v: vault, n: note, exp }), 'utf8').toString(
    'base64url',
  );
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify a smart-link token. Constant-time signature comparison, then expiry check.
 * @param {object}  opts
 * @param {string}  opts.token
 * @param {string}  opts.secret
 * @param {number} [opts.nowSeconds]   injectable clock (unix seconds) for tests
 * @returns {{ok:true, vault:string, note:string} | {ok:false, reason:string}}
 */
export function verifySmartLinkToken({
  token,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  if (typeof token !== 'string' || typeof secret !== 'string' || !secret) {
    return { ok: false, reason: 'malformed' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Signature FIRST (before parsing anything) — never JSON.parse unauthenticated input.
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  // Length is not secret; timingSafeEqual requires equal lengths anyway.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    !claims ||
    typeof claims !== 'object' ||
    typeof claims.v !== 'string' ||
    !claims.v ||
    typeof claims.n !== 'string' ||
    !claims.n ||
    typeof claims.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (nowSeconds > claims.exp) return { ok: false, reason: 'expired' };
  return { ok: true, vault: claims.v, note: claims.n };
}

/**
 * Build the full smart-link URL: `${baseUrl}/o/${token}` (no query string).
 * @param {object}  opts
 * @param {string}  opts.baseUrl     resolver base URL (trailing slashes stripped)
 * @param {string}  opts.vault
 * @param {string}  opts.note
 * @param {string}  opts.secret
 * @param {number} [opts.ttlSeconds]
 * @param {number} [opts.nowSeconds]
 * @returns {string}
 */
export function buildSmartLink({ baseUrl, vault, note, secret, ttlSeconds, nowSeconds } = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('buildSmartLink: missing `baseUrl`');
  }
  const token = buildSmartLinkToken({ vault, note, ttlSeconds, secret, nowSeconds });
  return `${baseUrl.trim().replace(/\/+$/, '')}/o/${token}`;
}

/**
 * Gate: smart links are emitted only when BOTH env vars are set and non-empty.
 * @param {object} [env]   defaults to process.env (injectable for tests)
 * @returns {boolean}
 */
export function smartLinkEnabled(env = process.env) {
  return Boolean(
    (env.OBSIDIAN_ROUTER_SMART_LINK_URL || '').trim() &&
      (env.OBSIDIAN_ROUTER_SMART_LINK_SECRET || '').trim(),
  );
}
