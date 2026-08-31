/**
 * Hash-based incremental ingest — fingerprint sources so re-ingesting an
 * unchanged source is a no-op, and re-ingesting a CHANGED source (e.g. an
 * upstream Wikipedia article that was edited since you last grabbed it)
 * triggers a re-ingest with a "source has evolved" flag.
 *
 * THIS MODULE IS PURE (v0.79.0). The state-file reads and writes moved to
 * `ingest-state-fs.mjs`; what remains is hashing, URL normalisation and the
 * freshness comparison, none of which touches a disk.
 *
 * Storage (in `ingest-state-fs.mjs`): per-vault JSON file at
 * `wiki-meta/ingest-state.json` with shape
 *   {
 *     "<source-id>": {
 *       "hash": "<sha256 hex>",
 *       "ingestedAt": "<ISO timestamp>",
 *       "page": "<wiki page slug or path that this source produced>",
 *     }
 *   }
 *
 * Source ID = normalised URL for URL sources, or absolute file path for
 * local files. Pasted text has no stable ID — skip the freshness check for
 * those (caller can pass `null` source ID).
 *
 * Hash is computed AFTER defuddle for URLs (so transient ads, JS-injected
 * timestamps, and tracking pixels don't trigger false-positive "changed"
 * detections). For local files and pasted text, hash is over the raw bytes
 * read.
 *
 * Synergy: the future agent-de-veille (#3 in llm-wiki-compiler-roadmap)
 * will scan this state periodically to detect sources that have evolved
 * upstream and prompt the user to refresh.
 *
 * Reference: roadmap item #4 from llm-wiki-compiler-roadmap.
 */

// PURE. `node:fs` and `node:path` left with the state-file I/O in v0.79.0 —
// see the "State file I/O — MOVED OUT" note below. Adding either back here
// would silently re-couple every importer of this module to a disk.
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash of a string, returned as lowercase hex.
 * Deterministic — same input string → same hash, always.
 *
 * @param {string} content Source content (raw text for files, post-defuddle markdown for URLs)
 * @returns {string} 64-char lowercase hex
 */
export function computeSourceHash(content) {
  if (typeof content !== 'string') {
    throw new TypeError('computeSourceHash: content must be a string');
  }
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

// Query parameters that are tracking / analytics noise — strip them so
// `?utm_source=newsletter` doesn't produce a different hash than the bare
// canonical URL. Lowercase comparison.
//
// PRs welcome to extend; useful references for new entries :
//   - ClearURLs rules: https://github.com/ClearURLs/Rules
//   - common platform docs (Marketo, Klaviyo, Adobe, etc.)
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid',
  'oly_anon_id', 'oly_enc_id',
  'ref', 'ref_src', 'referrer', 'src',
  '_hsenc', '_hsmi', 'hsctatracking',
  'igshid', 'twclid', 'vero_conv', 'vero_id',
  'wbraid', 'gbraid', 'yclid',
  'mkt_tok',     // Marketo
  '_kx',         // Klaviyo
  'oref', 'spm', // Alibaba
  's_cid',       // Adobe Analytics
]);

// Query parameter prefixes whose entire family should be stripped. Used
// when the platform emits `utm_*`, `X-Amz-*`, etc. with many variants —
// listing them all individually lets new ones slip through silently.
// Lowercase comparison.
const TRACKING_PARAM_PREFIXES = [
  'utm_',        // Google + many platforms (utm_source/medium/campaign/...)
  'x-amz-',      // AWS S3 signed-URL parameters
  'x-goog-',     // GCS signed-URL parameters
  'oly_',        // Omeda Olytics
  'vero_',       // Vero
];

// Query parameters that carry credentials / secrets / signatures. MUST be
// stripped before persisting to `wiki-meta/ingest-state.json`, otherwise
// the state file becomes a credential leak vector. (review+ pass 2 fix
// for Reviewer B IMPORTANT #2.) Lowercase comparison.
const SECRET_PARAMS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token',
  'api_key', 'apikey', 'apptoken',
  'key',                  // generic — overzealous but acceptable for ID
  'secret', 'client_secret',
  'signature', 'sig',
  'auth', 'authorization',
  'password', 'passwd', 'pwd',
  'code',                 // OAuth authorisation code (single-use but sensitive)
  'state',                // OAuth state param (CSRF token)
  'nonce',
  'session', 'sessionid', 'sid', 'jsessionid', 'phpsessid',
]);

/**
 * Return true when the query parameter name matches any tracking pattern
 * (exact name OR prefix match). Case-insensitive.
 */
function isTrackingParam(name) {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/** Return true when the query parameter carries a credential / secret. */
function isSecretParam(name) {
  return SECRET_PARAMS.has(name.toLowerCase());
}

// Single regex generated from SECRET_PARAMS, used by the parse-failure
// branch of normaliseUrl to detect "this raw string contains creds even
// though we couldn't parse it as a URL". Built once at module load so
// the set + regex never drift (Pass 4 fix : the parse-fail branch
// originally used a hand-curated regex narrower than SECRET_PARAMS,
// letting `refresh_token` / `client_secret` / `authorization` leak).
// `[#?&]` — not just query separators. OAuth's implicit flow returns the token
// in the FRAGMENT (`…/callback#access_token=…`), and on the parse-failure branch
// there is no `parsed.hash = ''` to strip it, so a schemeless callback URL
// persisted the token verbatim into the state file (Fable 5 review of C6, which
// reaches this same normaliser).
// `[#?&;]` — the semicolon covers MATRIX parameters, which neither
// URLSearchParams nor the path normaliser touch: `?a=1;token=X` leaves the
// secret inside the value of `a`, and `/app;jsessionid=X` sits in the path.
// Both persisted verbatim before this (Codex review of C6).
const SECRET_PARAMS_RE = new RegExp(
  `[#?&;](?:${[...SECRET_PARAMS]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})=`,
  'i',
);

/**
 * Does this URL carry a secret in a form the structured normaliser cannot
 * strip — a matrix parameter in the path or smuggled inside a query VALUE?
 * Such a URL must be refused outright rather than half-cleaned.
 */
export function hasUnstrippableSecret(url) {
  const normalised = normaliseUrl(url);
  // Already refused by the normaliser (unparseable + credential-bearing).
  if (normalised === null) return true;
  // Ask the question the simple way: after the structured pass has stripped
  // everything it knows how to strip, does a secret assignment SURVIVE? That
  // catches the forms the structured pass cannot reach — a matrix parameter in
  // the path (`/app;jsessionid=…`) and a secret smuggled inside another
  // parameter's value (`?foo=1;token=…`, which URLSearchParams keeps whole and
  // then percent-encodes) — without having to enumerate them.
  let probe = String(normalised);
  try {
    probe = decodeURIComponent(probe);
  } catch {
    // Malformed escapes: test the raw form instead.
  }
  return SECRET_PARAMS_RE.test(probe);
}

/**
 * Return true when the raw string (no URL parse) contains a query
 * parameter that matches any name in SECRET_PARAMS. Used by the
 * parse-failure fallback in normaliseUrl as a defensive leak detector.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function rawHasSecretQueryParam(raw) {
  return SECRET_PARAMS_RE.test(raw);
}

/**
 * Normalise a URL to a stable identifier:
 *   - lowercase the host (DNS is case-insensitive)
 *   - strip default port (80 for http, 443 for https)
 *   - strip tracking query params (utm_*, fbclid, gclid, msclkid, ...)
 *   - sort remaining query params (so `?a=1&b=2` === `?b=2&a=1`)
 *   - strip fragment (#anchor — server-side identical)
 *   - normalise trailing slash on path: keep one trailing slash if the path
 *     is just `/`; strip it otherwise (so `/foo/` and `/foo` are equivalent)
 *   - protocol-relative or schemeless URLs are returned as-is (caller's
 *     responsibility to pass a fully-formed URL)
 *
 * Returns the original input if URL parsing fails AND it contains no
 * credentials (the caller can still use the unparsed form as an opaque
 * ID). Returns `null` if parse-failed input contains credentials or
 * secret query params — caller MUST surface an error rather than
 * silently persist a leaky form. (review+ pass 3+ hardening for the
 * `//user:pass@host?token=...` protocol-relative leak vector.)
 *
 * @param {string} url
 * @returns {string|null} normalised URL ; original input on benign
 *   parse failure ; null when the parse-failed input looks credential-
 *   bearing (caller must handle).
 */
export function normaliseUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // URL parse failed — but we still must NOT leak credentials.
    // (review+ pass 3 fix for Reviewer B Pass 2 finding : protocol-
    // relative URLs like `//user:pass@example.com/x?token=...` aren't
    // parseable but contain creds that would otherwise persist to
    // ingest-state.json.)
    //
    // Detect basic-auth userinfo OR any secret query param. Source of
    // truth for the secret-param list is SECRET_PARAMS (single
    // canonical set used by both the parsed path AND this fallback) —
    // do NOT maintain a parallel hand-curated regex here. The Pass 3
    // fix originally did, and Pass 4 caught that `refresh_token`,
    // `client_secret`, `authorization`, etc. were leaking through.
    if (/\/\/[^/]*@/.test(url) || rawHasSecretQueryParam(url)) {
      // Return null so the caller surfaces an error rather than
      // silently persisting the leaky form.
      return null;
    }
    return url;
  }
  // Lowercase host, and drop the root-zone trailing dot: `example.com.` and
  // `example.com` are the same host, and keeping the dot produced two ids for
  // one source (Fable 5 review of C6).
  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  // Strip default port
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }
  // CRITICAL : strip URL credentials (basic auth in userinfo).
  // `https://user:pass@host/path?...` → `https://host/path?...`
  // The state file MUST NOT persist creds. (review+ pass 2 fix for
  // Reviewer B IMPORTANT #2.)
  parsed.username = '';
  parsed.password = '';
  // Strip fragment
  parsed.hash = '';
  // Filter + sort query params. Two filter categories :
  //   - tracking : noise that shouldn't influence hash equality
  //   - secrets  : credentials that MUST NOT persist to the state file
  const params = new URLSearchParams();
  const sortedKeys = [...parsed.searchParams.keys()]
    .filter((k) => !isTrackingParam(k) && !isSecretParam(k))
    .sort();
  for (const key of sortedKeys) {
    for (const value of parsed.searchParams.getAll(key)) {
      params.append(key, value);
    }
  }
  parsed.search = params.toString() ? `?${params.toString()}` : '';
  // Normalise trailing slash on path (keep `/` for root, strip otherwise)
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  // RFC 3986 §6.2.2: percent-encoded UNRESERVED characters are equivalent to
  // their literal form, and escape hex is case-insensitive. Without this,
  // `/~alice`, `/%7Ealice` and `/%7ealice` were three different identities for
  // one page (Codex review).
  parsed.pathname = parsed.pathname
    .replace(/%[0-9a-fA-F]{2}/g, (esc) => {
      const ch = String.fromCharCode(parseInt(esc.slice(1), 16));
      return /[A-Za-z0-9\-._~]/.test(ch) ? ch : esc.toUpperCase();
    });
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// State file I/O — MOVED OUT in v0.79.0
// ---------------------------------------------------------------------------
//
// `getStatePath` / `loadIngestState` / `saveIngestState` now live in
// `ingest-state-fs.mjs`. They are NOT re-exported from here, deliberately: a
// re-export would put `node:fs` back into this module's import graph and undo
// the reason for the split.
//
// The reason is a claim the HTTP-only workstream has to be able to state — no
// MCP tool reads a vault's disk to track ingestion state. Proving it by grepping
// for three function names failed a review (`import * as ns` names none of
// them), and no regex over source text can settle a question about module
// boundaries. Moving the disk half into its own file turns the claim into a
// substring nothing under `src/` may contain, which is checkable and cannot be
// evaded by import syntax. Same convention as `okf-projections-fs.mjs` and
// `bm25-index-fs.mjs`.
//
// Importers (the `wiki-ingest` skill, tests) use `ingest-state-fs.mjs`.
// ---------------------------------------------------------------------------
// Freshness check
// ---------------------------------------------------------------------------

/**
 * Compare a freshly-computed hash against the stored state for a given
 * source ID. Returns one of three sentinels:
 *
 *   - 'new'        → source ID never seen before (proceed with full ingest)
 *   - 'unchanged'  → hash matches stored value (skip total, no fetch / no LLM)
 *   - 'changed'    → hash differs from stored value (re-ingest, optionally diff)
 *
 * @param {object} input
 * @param {Record<string, { hash: string }>} input.state Loaded state object
 * @param {string} input.sourceId Source identifier (normalised URL or absolute file path)
 * @param {string} input.hash Freshly computed SHA-256 hex
 * @returns {'new' | 'unchanged' | 'changed'}
 */
export function checkSourceFreshness({ state, sourceId, hash }) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('checkSourceFreshness: state must be an object');
  }
  if (typeof sourceId !== 'string' || !sourceId) {
    throw new TypeError('checkSourceFreshness: sourceId must be a non-empty string');
  }
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) {
    throw new TypeError(
      'checkSourceFreshness: hash must be a 64-char hex string (SHA-256)',
    );
  }
  const entry = state[sourceId];
  if (!entry) return 'new';
  if (entry.hash === hash) return 'unchanged';
  return 'changed';
}

/**
 * Record a freshly-ingested source in the state object (mutates input).
 * Returns the mutated state for chaining convenience.
 *
 * @param {object} input
 * @param {Record<string, { hash: string, ingestedAt: string, page: string }>} input.state
 * @param {string} input.sourceId
 * @param {string} input.hash
 * @param {string} input.page Wiki page slug or path produced by this source
 * @param {string} [input.ingestedAt] ISO timestamp; defaults to now
 * @returns {typeof input.state}
 */
export function recordIngest({ state, sourceId, hash, page, ingestedAt }) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('recordIngest: state must be an object');
  }
  state[sourceId] = {
    hash,
    ingestedAt: ingestedAt ?? new Date().toISOString(),
    page,
  };
  return state;
}
