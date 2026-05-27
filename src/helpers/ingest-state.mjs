/**
 * Hash-based incremental ingest — fingerprint sources so re-ingesting an
 * unchanged source is a no-op, and re-ingesting a CHANGED source (e.g. an
 * upstream Wikipedia article that was edited since you last grabbed it)
 * triggers a re-ingest with a "source has evolved" flag.
 *
 * Storage: per-vault JSON file at `wiki-meta/ingest-state.json` with shape
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

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
 * Returns the original input if URL parsing fails (so we don't lose data
 * on weird inputs — the caller can still use the unparsed form as an ID).
 *
 * @param {string} url
 * @returns {string} normalised URL or original input on parse failure
 */
export function normaliseUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  // Lowercase host
  parsed.hostname = parsed.hostname.toLowerCase();
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
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// State file I/O
// ---------------------------------------------------------------------------

const STATE_FILENAME = 'ingest-state.json';
const STATE_DIR = 'wiki-meta';

/**
 * Resolve the absolute path to a vault's ingest-state.json file.
 *
 * @param {string} vaultPath Absolute filesystem path to the vault root
 * @returns {string} Absolute path to wiki-meta/ingest-state.json
 */
export function getStatePath(vaultPath) {
  if (typeof vaultPath !== 'string' || !vaultPath) {
    throw new TypeError('getStatePath: vaultPath must be a non-empty string');
  }
  return path.join(vaultPath, STATE_DIR, STATE_FILENAME);
}

/**
 * Load the ingest state for a vault. Returns an empty object if the file
 * doesn't exist yet (first ingest into this vault) OR if it's corrupt.
 *
 * Corruption handling (review+ pass 2 fix for Reviewer A IMP-6) — silent
 * recovery would mean the next `saveIngestState` overwrites the broken
 * file with a fresh empty state, erasing the entire ingestion history
 * invisibly. To prevent that, on corruption we :
 *   1. Log a clear warning to stderr (user sees it).
 *   2. Backup the corrupted file as `<path>.corrupted-<timestamp>` so
 *      the data isn't lost — user can inspect and recover.
 *   3. Then return `{}` so processing continues.
 *
 * If the rename fails (permissions, etc.), the warning still fires but
 * the corrupted file is left in place — the caller will see the next
 * load attempt also fail in the same way until they intervene.
 *
 * @param {string} vaultPath Absolute filesystem path to the vault root
 * @returns {Record<string, { hash: string, ingestedAt: string, page: string }>}
 */
export function loadIngestState(vaultPath) {
  const statePath = getStatePath(vaultPath);
  if (!fs.existsSync(statePath)) return {};
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[ingest-state] WARN: failed to read ${statePath}: ${err.message} — treating as empty.\n`,
    );
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Corrupted JSON — back up the file before we overwrite it.
    const backupPath = `${statePath}.corrupted-${Date.now()}`;
    try {
      fs.renameSync(statePath, backupPath);
      process.stderr.write(
        `[ingest-state] WARN: corrupted JSON at ${statePath} (${err.message}). ` +
          `Backed up to ${backupPath} and treating as empty.\n`,
      );
    } catch (renameErr) {
      process.stderr.write(
        `[ingest-state] WARN: corrupted JSON at ${statePath} (${err.message}). ` +
          `Backup failed (${renameErr.message}); leaving file in place. Manual cleanup may be required.\n`,
      );
    }
    return {};
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed;
  }
  // Valid JSON but wrong shape (array, scalar, null). Treat as empty
  // but warn — same recovery path as full corruption.
  const backupPath = `${statePath}.corrupted-${Date.now()}`;
  try {
    fs.renameSync(statePath, backupPath);
    process.stderr.write(
      `[ingest-state] WARN: wrong shape at ${statePath} (expected object, got ${typeof parsed}). ` +
        `Backed up to ${backupPath} and treating as empty.\n`,
    );
  } catch {
    // Best-effort backup.
  }
  return {};
}

/**
 * Save the ingest state for a vault atomically (write to tmp file then
 * rename, so a crash mid-write can't leave a corrupted JSON). Creates
 * `wiki-meta/` if it doesn't exist.
 *
 * @param {string} vaultPath Absolute filesystem path to the vault root
 * @param {Record<string, { hash: string, ingestedAt: string, page: string }>} state
 */
export function saveIngestState(vaultPath, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('saveIngestState: state must be a plain object');
  }
  const statePath = getStatePath(vaultPath);
  const stateDir = path.dirname(statePath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(tmpPath, json, 'utf8');
  fs.renameSync(tmpPath, statePath);
}

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
