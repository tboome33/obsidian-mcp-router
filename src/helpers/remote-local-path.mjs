/**
 * remote-local-path.mjs — is this local directory REALLY that remote vault?
 *
 * ---------------------------------------------------------------------------
 * THE CASE
 * ---------------------------------------------------------------------------
 * A vault served by Obsidian in a container (linuxserver image, Local REST API
 * published on a WireGuard address) is REMOTE to the router: every note goes
 * over HTTP. But the container's volume is often a directory on the very
 * machine the router runs on. Declaring that directory
 * (`remoteVaults[].localPath`) lets the hooks load the hot cache and lets
 * `search_smart` check its index's freshness — two things that need a disk.
 *
 * A declared directory is an ASSERTION, and a wrong one is not harmless: the
 * hooks journal and read hot.md there. So before the CLI records it, the two
 * sides are compared — the bytes the Local REST API serves for one file, and
 * the bytes the directory holds for the same relative path. Same hash, same
 * vault (as far as one file can say); different hash, or a file one side has
 * and the other does not, and the directory is refused.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS RUNS
 * ---------------------------------------------------------------------------
 * In the CLI only (`setup-vault.mjs --attach --local-path`). Never in the
 * server: the server's doctrine is HTTP-only for note content
 * (tests/no-vault-disk.test.mjs), and reading a note from disk to compare it is
 * exactly a note read. That is also why `register_remote_vault` stores a
 * `localPath` as DECLARED — it cannot look, and it says so.
 *
 * ---------------------------------------------------------------------------
 * WHAT "THE SAME BYTES" MEANS HERE
 * ---------------------------------------------------------------------------
 * The REST client hands back TEXT, decoded with `TextDecoder('utf-8')` (which
 * drops a leading BOM and replaces invalid sequences). The disk side is decoded
 * the same way before hashing, so the comparison is "same text under the one
 * decoding the router itself applies". A BOM-only difference therefore reads
 * as identical — which is right: the router could not tell them apart either.
 *
 * The HTTP client is injected (`client`), so tests drive every branch without
 * a network; the default one is a small `node:http` GET with no connection
 * reuse — see `httpGet` for why it is not the router's own REST client.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import { canonicalVaultPath } from './vault-path-guard.mjs';
import { CATALOG_REL, LEGACY_CATALOG_REL } from './wiki-meta-scaffolds.mjs';

export const LOCAL_PATH_STATUS = Object.freeze({
  VERIFIED: 'verified',
  MISMATCH: 'mismatch',
  UNVERIFIABLE: 'unverifiable',
});

/** How many files are tried at most. One matching file is enough to verify. */
const MAX_CANDIDATES = 6;

/** sha256 of a string's UTF-8 bytes, hex. */
function sha256Text(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Ceiling on one response body — a note, or a root listing. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * One GET against the vault's Local REST API, over `node:http`/`node:https`,
 * with NO connection reuse (`agent: false`, `Connection: close`).
 *
 * WHY NOT THE ROUTER'S OWN REST CLIENT (src/rest-client.mjs). It was the first
 * choice, and it was measured: in a short-lived CLI, two sequential requests
 * over undici's keep-alive pool followed by `process.exit()` crashed Node on
 * Windows every time — libuv `Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING)`, exit code 3221226505 — and closing the pool first did
 * not help; exiting naturally instead hung on a handle that never closed. One
 * request did not crash; two did. The server never exits that way, so the
 * pool is right there; a CLI that asks two or three questions and exits is
 * better served by sockets that are closed when each answer arrives.
 *
 * Same request shape as rest-client: `Authorization: Bearer`, the vault's
 * `extraHeaders`, `tlsInsecure` honoured, the vault's `timeoutMs`, each path
 * segment percent-encoded. Redirects are NOT followed (a 3xx is an error): this
 * check has no reason to talk to any host but the one the config names.
 *
 * @returns {Promise<{ status: number, text: string }>}
 */
function httpGet(vault, urlPath) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(`${String(vault.baseUrl).replace(/\/+$/, '')}${urlPath}`);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      agent: false,
      rejectUnauthorized: vault.tlsInsecure !== true,
      headers: {
        ...(vault.extraHeaders && typeof vault.extraHeaders === 'object' ? vault.extraHeaders : {}),
        Authorization: `Bearer ${vault.apiKey}`,
        Connection: 'close',
      },
      timeout: Number.isFinite(vault.timeoutMs) && vault.timeoutMs > 0 ? vault.timeoutMs : 10000,
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_BODY_BYTES) {
          req.destroy(new Error(`response body exceeds ${MAX_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        // Decoded the way rest-client decodes (drops a BOM) — see the header.
        text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${vault.timeoutMs || 10000} ms`)));
    req.on('error', reject);
    req.end();
  });
}

function encodeVaultRel(rel) {
  return String(rel).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/**
 * The HTTP client this check uses by default, adapted to its two questions.
 * `readText` answers null for a 404 — "the vault has no such file" is
 * evidence, not a failure — and throws for anything else, WITHOUT echoing the
 * response body (it came off the wire).
 */
export async function defaultRemoteClient() {
  return {
    async readText(vault, rel) {
      const { status, text } = await httpGet(vault, `/vault/${encodeVaultRel(rel)}`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status} for ${rel}`);
      return text;
    },
    async list(vault, dir = '') {
      const d = dir ? `${encodeVaultRel(dir)}/` : '';
      const { status, text } = await httpGet(vault, `/vault/${d}`);
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status} listing the vault`);
      const parsed = JSON.parse(text);
      return Array.isArray(parsed?.files) ? parsed.files : [];
    },
    // Nothing pooled, nothing to close; kept so callers need not know.
    async close() {},
  };
}

/**
 * The disk text of `rel` under `root`, decoded as the REST client decodes, or
 * null when the file is absent. Any other error (EACCES…) is rethrown: "could
 * not look" is not "absent".
 */
function readDiskText(io, root, rel) {
  const abs = path.resolve(root, ...rel.split('/'));
  // Containment, after resolution — `rel` is canonical already, this is the
  // second lock on the same door.
  const rootResolved = path.resolve(root);
  const within = abs === rootResolved || abs.startsWith(rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep);
  if (!within) return null;
  try {
    // A note that is a link points outside the directory being judged: the
    // text it would yield says nothing about THIS directory. Not compared.
    if (io.lstatSync(abs).isSymbolicLink()) return null;
    return new TextDecoder('utf-8').decode(io.readFileSync(abs));
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR')) return null;
    throw err;
  }
}

/**
 * Compare the remote vault `vault` (a registry descriptor — `remoteVaultDescriptor`)
 * with the local directory `localPath`.
 *
 * Candidates, in order: `wiki-meta/catalog.md` (then its legacy name), then the
 * root-level `.md` files the REST listing names, sorted. `.obsidian/` is never
 * used: the Local REST API does not serve dot-directories, so it cannot be
 * compared.
 *
 * Verdicts:
 *   - `verified`     a file present on both sides with the same text.
 *   - `mismatch`     the directory does not exist; or a file present on both
 *                    sides differs; or a file one side has, the other lacks
 *                    (and nothing matched).
 *   - `unverifiable` nothing to compare (an empty vault), or the REST side
 *                    could not be read. The directory is NOT recorded then.
 *
 * Never throws.
 *
 * @param {{ vault: object, localPath: string, client?: object, fs?: object }} args
 * @returns {Promise<{ status: string, evidence: object }>}
 */
export async function verifyRemoteLocalPath({ vault, localPath, client, fs: io = fs } = {}) {
  const checked = [];
  const result = (status, extra = {}) => ({ status, evidence: { localPath, ...extra, checked } });

  if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) {
    return result(LOCAL_PATH_STATUS.MISMATCH, { reason: 'not-absolute' });
  }
  try {
    if (!io.statSync(localPath).isDirectory()) return result(LOCAL_PATH_STATUS.MISMATCH, { reason: 'not-a-directory' });
  } catch {
    return result(LOCAL_PATH_STATUS.MISMATCH, { reason: 'not-a-directory' });
  }

  let rc = client;
  try {
    if (!rc) rc = await defaultRemoteClient();
  } catch (err) {
    return result(LOCAL_PATH_STATUS.UNVERIFIABLE, { reason: 'rest-client-unavailable', error: String(err?.message || err) });
  }

  const candidates = [CATALOG_REL, LEGACY_CATALOG_REL];
  let listed = null;
  const oneSided = [];

  const tryOne = async (rel) => {
    let canonical;
    try {
      canonical = canonicalVaultPath(rel, 'candidate');
    } catch {
      return null;
    }
    let restText;
    try {
      restText = await rc.readText(vault, canonical);
    } catch (err) {
      return { stop: result(LOCAL_PATH_STATUS.UNVERIFIABLE, { reason: 'rest-error', file: canonical, error: String(err?.message || err) }) };
    }
    let diskText;
    try {
      diskText = readDiskText(io, localPath, canonical);
    } catch (err) {
      return { stop: result(LOCAL_PATH_STATUS.UNVERIFIABLE, { reason: 'disk-unreadable', file: canonical, error: String(err?.code || err?.message || err) }) };
    }
    const row = { file: canonical, rest: restText === null ? 'absent' : 'present', disk: diskText === null ? 'absent' : 'present' };
    checked.push(row);
    if (restText === null && diskText === null) return null;
    if (restText === null || diskText === null) {
      oneSided.push(canonical);
      return null;
    }
    const restSha256 = sha256Text(restText);
    const diskSha256 = sha256Text(diskText);
    row.restSha256 = restSha256;
    row.diskSha256 = diskSha256;
    if (restSha256 === diskSha256) {
      return { stop: result(LOCAL_PATH_STATUS.VERIFIED, { reason: 'same-content', file: canonical, restSha256, diskSha256 }) };
    }
    return { stop: result(LOCAL_PATH_STATUS.MISMATCH, { reason: 'different-content', file: canonical, restSha256, diskSha256 }) };
  };

  for (let i = 0; i < candidates.length && checked.length < MAX_CANDIDATES; i++) {
    const out = await tryOne(candidates[i]);
    if (out?.stop) return out.stop;
    // After the catalog names, extend with the root listing — fetched once,
    // and only when the catalog did not settle it.
    if (i === candidates.length - 1 && listed === null) {
      try {
        listed = await rc.list(vault, '');
      } catch (err) {
        listed = [];
        if (oneSided.length === 0) {
          return result(LOCAL_PATH_STATUS.UNVERIFIABLE, { reason: 'rest-error', error: String(err?.message || err) });
        }
      }
      const extra = listed
        .filter((f) => typeof f === 'string' && f.endsWith('.md') && !f.includes('/') && !f.startsWith('.'))
        .sort();
      for (const f of extra) if (!candidates.includes(f)) candidates.push(f);
    }
  }

  if (oneSided.length > 0) {
    return result(LOCAL_PATH_STATUS.MISMATCH, { reason: 'present-on-one-side-only', files: oneSided });
  }
  return result(LOCAL_PATH_STATUS.UNVERIFIABLE, { reason: 'nothing-to-compare' });
}

/**
 * Does a remote vault have its wiki — the catalog, and the hot cache — asked
 * over REST? For the CLI's `--attach` of a remote vault with no verified local
 * directory, where the disk probe that local vaults get is not available.
 *
 * Tri-state per file: `true` present, `false` a 404, `null` could not be asked
 * (and `error` says why). A `null` is never reported as absent: "the vault did
 * not answer" and "the vault has no wiki" call for different remedies.
 *
 * @param {{ vault: object, client?: object }} args
 * @returns {Promise<{ catalog: boolean|null, hot: boolean|null, error?: string }>}
 */
export async function probeRemoteWiki({ vault, client } = {}) {
  let rc = client;
  try {
    if (!rc) rc = await defaultRemoteClient();
  } catch (err) {
    return { catalog: null, hot: null, error: String(err?.message || err) };
  }
  const has = async (rel) => (await rc.readText(vault, rel)) !== null;
  try {
    const catalog = (await has(CATALOG_REL)) || (await has(LEGACY_CATALOG_REL));
    const hot = await has('wiki-meta/hot.md');
    return { catalog, hot };
  } catch (err) {
    return { catalog: null, hot: null, error: String(err?.message || err) };
  }
}
