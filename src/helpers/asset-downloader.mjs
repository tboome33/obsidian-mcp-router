/**
 * Asset downloader for the ingestion pipeline. Phase E (v0.14.x) of the
 * [[obsidian-clipper]] borrowing roadmap.
 *
 * Pipeline:
 *   1. **`extractImageUrls(content, baseUrl)`** — pure function. Scans
 *      HTML (`<img src>`, `<source srcset>`) AND markdown (`![alt](url)`)
 *      for image references, resolves relative URLs against `baseUrl`,
 *      dedupes, returns absolute URLs only (http/https — `data:` URIs
 *      are skipped because they're already inline).
 *   2. **`downloadOne(url, outputDir, opts)`** — fetches a single image
 *      via the SSRF-safe `safe-fetch-binary.mjs`. Picks a safe filename
 *      (last URL path segment if reasonable, sha256(buffer).slice(0,16)
 *      fallback for collisions or unprintable names). Picks an extension
 *      from Content-Type (or from the URL extension if Content-Type is
 *      bland `application/octet-stream`). Writes to `<outputDir>/<filename>`.
 *      Skips by size (default `minBytes: 1024` — most icons are <1 KB,
 *      most photos/equations are larger).
 *   3. **`downloadAssets(urls, outputDir, opts)`** — bulk wrapper with
 *      bounded parallelism. Returns `{downloaded, skipped, errors}` so
 *      the caller can render a manifest and decide whether to proceed.
 *   4. **`rewriteAssetUrls(markdown, urlMap)`** — pure function. Replaces
 *      `![alt](remoteUrl)` and `<img src="remoteUrl">` with the local
 *      relative path from `urlMap` (a `Map<sourceUrl, localPath>`).
 *      Leaves un-mapped URLs alone (failed downloads stay remote).
 *
 * What this MVP does NOT do (deferred Phase E.2 if user demand):
 *   - Image dimension parsing to skip icons by width/height instead of
 *     by size. Needs format-specific header decoders for PNG/JPEG/GIF/
 *     WebP/SVG. The roadmap originally specified "<100x100"; size-based
 *     filtering is the 80% approximation (icons are typically <1 KB).
 *   - `<picture>` / `srcset` multi-resolution selection (we pick the
 *     first `src` we see in `<source>`; the caller can post-filter).
 *   - Animated GIF / video / audio asset types (image-only for MVP).
 *
 * Threat model:
 *   - SSRF: handled by `safe-fetch-binary.mjs` (pinned-IP dispatcher).
 *   - Path traversal: the picked filename is sanitized via
 *     `sanitizeAssetFilename` — no `..`, no absolute paths, no separators.
 *     `outputDir` is required to be absolute (caller's responsibility);
 *     we never resolve relative paths so a malicious filename cannot
 *     climb above it.
 *   - Disk-fill DoS: `maxBytes` per asset (10 MiB default) + caller-
 *     controlled `urls` array length. Caller is responsible for capping
 *     the number of URLs it passes.
 *
 * @module asset-downloader
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

import { safeFetchBinary } from './safe-fetch-binary.mjs';

// -----------------------------------------------------------------------------
// Pure: URL extraction
// -----------------------------------------------------------------------------

/**
 * Extract image URLs from HTML or markdown content.
 *
 * Scans for three patterns:
 *   1. HTML `<img src="..."/>` (also handles `<img src='...'/>` and bare `<img src=...>`)
 *   2. HTML `<source srcset="...">` (takes the FIRST entry, drops density descriptors)
 *   3. Markdown `![alt](url)` and `![alt](url "title")` (drops the title)
 *
 * Resolves relative URLs against `baseUrl`. Skips `data:`, `blob:`, `javascript:`
 * URIs (no remote fetch needed/safe). Dedupes the final list.
 *
 * @param {string} content — HTML or markdown
 * @param {string} baseUrl — page URL for relative resolution; required
 * @returns {string[]} — absolute http(s) URLs, deduped, in document order
 */
export function extractImageUrls(content, baseUrl) {
  const safe = String(content || '');
  if (!baseUrl) {
    throw new Error('extractImageUrls: baseUrl is required for relative URL resolution');
  }

  const found = [];

  // Pattern 1: <img src="..." | '...' | bare>
  // Quote-aware: match double-quoted, single-quoted, or bare (no quote) values.
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m;
  while ((m = imgRe.exec(safe)) !== null) {
    const raw = m[1] || m[2] || m[3];
    if (raw) found.push(raw);
  }

  // Pattern 2: <source srcset="..."> — take the first URL before any
  // size/density descriptor (`,` or whitespace separator).
  const srcsetRe = /<source\b[^>]*?\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  while ((m = srcsetRe.exec(safe)) !== null) {
    const raw = m[1] || m[2] || m[3];
    if (raw) {
      const firstUrl = raw.split(/[,\s]+/)[0];
      if (firstUrl) found.push(firstUrl);
    }
  }

  // Pattern 3: Markdown ![alt](url) — drop optional "title".
  //
  // v0.14.3 hardening (P2-2): the alt-text matcher must accept one level
  // of nested square brackets, e.g. `![Photo of [Eiffel tower]](url)`.
  // The pre-v0.14.3 `[^\]]*` regex bailed on the inner `[` and missed
  // the whole reference, so the image was neither extracted (skipping
  // download) nor rewritten (leaving a remote URL behind even when the
  // download succeeded via another path). Real-world content with this
  // pattern: Wikipedia citations, blogs with `[citation needed]` alt
  // hooks, etc.
  //
  // Pattern explanation:
  //   (?:\[[^\]]*\]|[^\]])*   — alternation:
  //     \[[^\]]*\]            — one full balanced [inner] block
  //     |                     — OR
  //     [^\]]                 — any single non-`]` character
  //   Repeated * times. Greedy is fine here — the closing `\]` is
  //   forced by the parenthetical that follows.
  const mdRe = /!\[((?:\[[^\]]*\]|[^\]])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((m = mdRe.exec(safe)) !== null) {
    if (m[2]) found.push(m[2]);
  }

  // Resolve + filter.
  const seen = new Set();
  const result = [];
  for (const raw of found) {
    const trimmed = raw.trim();
    // Skip non-fetchable schemes.
    if (/^(?:data|blob|javascript|mailto|tel|about):/i.test(trimmed)) continue;

    let abs;
    try {
      abs = new URL(trimmed, baseUrl).href;
    } catch {
      // Bad URL — skip silently rather than break the whole extraction.
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    result.push(abs);
  }

  return result;
}

// -----------------------------------------------------------------------------
// Helpers: filename + extension
// -----------------------------------------------------------------------------

// Map Content-Type → file extension. Conservative list — anything not
// recognized falls back to URL-path extension or `.bin`.
const CONTENT_TYPE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

/**
 * Pick a safe filename for a downloaded asset.
 *
 * Strategy:
 *   1. Try the last segment of the URL path.
 *   2. Sanitize it: strip everything except `[A-Za-z0-9._-]`, cap length
 *      at 80 chars, refuse pure-dot names (`.`, `..`, `...`).
 *   3. If the sanitized name is empty OR collides with an already-saved
 *      file, fall back to `sha256(buffer).slice(0,16) + ext`.
 *   4. Force the extension to match Content-Type (overrides any
 *      `.html`/`.exe` shenanigans hidden in the URL path).
 *
 * @param {string} url
 * @param {Buffer} buffer
 * @param {string} contentType
 * @param {Set<string>} usedNames — names already written in this batch
 * @returns {string}
 */
export function pickAssetFilename(url, buffer, contentType, usedNames = new Set()) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  const ctExt = CONTENT_TYPE_EXT[ct] || null;

  let lastSegment = '';
  try {
    const u = new URL(url);
    lastSegment = u.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    // fallthrough — use sha256 fallback
  }

  // Sanitize: keep [A-Za-z0-9._-], replace others with `_`.
  // Refuse purely-dot names.
  //
  // v0.14.3 hardening (P3-1): also strip LEADING dots after sanitization.
  // Without this, an URL ending in `/...png` or `/.png` produced names
  // like `..png` or `.png` which (a) are hidden files on POSIX (Finder
  // / `ls` hide them, surprising the user) and (b) look like
  // path-traversal even though `path.join` is safe. Trim leading dots
  // BEFORE the pure-dots check so `/...png` → `png` (still valid) and
  // `/..` → `` → sha256 fallback.
  let base = lastSegment.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  base = base.replace(/^\.+/, '');
  if (/^\.+$/.test(base) || base === '') {
    base = '';
  }

  // Force extension from content-type if we have one; else preserve URL ext.
  let ext = ctExt;
  if (!ext) {
    const urlExt = path.extname(base).toLowerCase();
    ext = /^\.[A-Za-z0-9]{1,6}$/.test(urlExt) ? urlExt : '.bin';
    base = base.slice(0, base.length - urlExt.length);
  } else {
    // Strip any existing extension from base to avoid `image.png.png`.
    const existing = path.extname(base).toLowerCase();
    if (existing) base = base.slice(0, base.length - existing.length);
  }

  let candidate = base ? `${base}${ext}` : null;

  // Collision OR empty base → sha256 fallback.
  if (!candidate || usedNames.has(candidate)) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    candidate = `${hash}${ext}`;
    // Still a collision (astronomically unlikely): append a digit.
    let n = 1;
    while (usedNames.has(candidate)) {
      candidate = `${hash}-${n}${ext}`;
      n += 1;
    }
  }

  return candidate;
}

// -----------------------------------------------------------------------------
// Downloader: single + bulk
// -----------------------------------------------------------------------------

/**
 * Download one asset to `outputDir`.
 *
 * Returns one of:
 *   - `{ ok: true, sourceUrl, savedAs, bytes }`        — saved to disk
 *   - `{ ok: false, sourceUrl, reason: 'too-small' }`  — under minBytes (icon)
 *   - `{ ok: false, sourceUrl, reason: 'too-large' }`  — over maxBytes
 *   - `{ ok: false, sourceUrl, reason: 'fetch-error', message }`
 *
 * @param {string} url
 * @param {string} outputDir — must be absolute
 * @param {object} [opts]
 * @param {number} [opts.minBytes=1024]
 * @param {number} [opts.maxBytes=10*1024*1024]
 * @param {Set<string>} [opts.usedNames]               — collision-avoid across batch
 * @param {Function} [opts._fetchFn]                   — injection seam for tests
 * @param {Function} [opts._writeFn]                   — injection seam for tests
 */
export async function downloadOne(url, outputDir, opts = {}) {
  const {
    minBytes = 1024,
    maxBytes = 10 * 1024 * 1024,
    usedNames = new Set(),
    _fetchFn = safeFetchBinary,
    _writeFn = fs.writeFile,
  } = opts;

  if (!path.isAbsolute(outputDir)) {
    throw new Error(`downloadOne: outputDir must be absolute, got ${outputDir}`);
  }

  let fetched;
  try {
    fetched = await _fetchFn(url, { maxBytes });
  } catch (e) {
    return { ok: false, sourceUrl: url, reason: 'fetch-error', message: String(e.message || e) };
  }

  const { buffer, contentType } = fetched;
  if (buffer.length < minBytes) {
    return { ok: false, sourceUrl: url, reason: 'too-small', bytes: buffer.length };
  }
  if (buffer.length > maxBytes) {
    return { ok: false, sourceUrl: url, reason: 'too-large', bytes: buffer.length };
  }

  const filename = pickAssetFilename(url, buffer, contentType, usedNames);
  usedNames.add(filename);
  const fullPath = path.join(outputDir, filename);
  await _writeFn(fullPath, buffer);

  return { ok: true, sourceUrl: url, savedAs: filename, bytes: buffer.length };
}

/**
 * Bulk download with bounded parallelism. Creates outputDir if missing.
 *
 * @param {string[]} urls
 * @param {string} outputDir — absolute
 * @param {object} [opts]
 * @param {number} [opts.concurrency=4]
 * @param {number} [opts.minBytes]
 * @param {number} [opts.maxBytes]
 * @param {Function} [opts._fetchFn]
 * @param {Function} [opts._writeFn]
 * @param {Function} [opts._mkdirFn]
 * @returns {Promise<{
 *   downloaded: Array<{sourceUrl, savedAs, bytes}>,
 *   skipped:    Array<{sourceUrl, reason, bytes?}>,
 *   errors:     Array<{sourceUrl, message}>,
 *   urlMap:     Map<string, string>,                  — sourceUrl → savedAs
 * }>}
 */
export async function downloadAssets(urls, outputDir, opts = {}) {
  const {
    concurrency = 4,
    minBytes = 1024,
    maxBytes = 10 * 1024 * 1024,
    _fetchFn,
    _writeFn,
    _mkdirFn = fs.mkdir,
    _statFn = fs.stat,
  } = opts;

  if (!path.isAbsolute(outputDir)) {
    throw new Error(`downloadAssets: outputDir must be absolute, got ${outputDir}`);
  }

  // v0.14.3 hardening (P2-1): when `MD_ALLOWED_PATHS` is unset, the
  // upstream `assertPathAllowed` is a no-op — so a hostile caller can
  // pass `/etc/cron.d` (existing system dir) and `fs.mkdir(...,
  // {recursive: true})` silently succeeds, allowing image writes into
  // arbitrary places on disk. We close this with two cheap checks:
  //
  //   1. After mkdir-recursive, stat the resulting path and assert
  //      isDirectory(). If it's a file (mkdir on existing file path
  //      throws EEXIST), or a symlink to a file (mkdir resolves the
  //      link), the write would clobber unrelated data. Reject.
  //
  //   2. Require the PARENT to exist BEFORE the mkdir call. This
  //      prevents an MCP caller from bootstrapping arbitrary system
  //      directory trees (`/etc/cron.d/whatever-they-want/`) — a
  //      legitimate ingest uses an existing vault dir as the parent.
  //      `wiki-ingest` always calls with `<vault>/wiki/.assets/<slug>/`
  //      where `<vault>/wiki/` already exists.
  const parentDir = path.dirname(outputDir);
  try {
    const parentStat = await _statFn(parentDir);
    if (!parentStat.isDirectory()) {
      throw new Error(`downloadAssets: outputDir parent is not a directory: ${parentDir}`);
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(
        `downloadAssets: outputDir parent must exist (got ${parentDir}). ` +
        `For safety, this helper does not bootstrap arbitrary directory trees — ` +
        `the caller should pre-create the vault root or pass an outputDir whose ` +
        `parent already exists.`,
      );
    }
    throw e;
  }

  await _mkdirFn(outputDir, { recursive: true });

  // Belt-and-suspenders: stat the resulting path. `mkdir -p` on an
  // existing FILE throws EEXIST, but on an existing SYMLINK-to-file the
  // behaviour is platform-dependent (some Node versions silently treat
  // the symlink target as the "directory"). Explicit isDirectory()
  // check catches both.
  const outStat = await _statFn(outputDir);
  if (!outStat.isDirectory()) {
    throw new Error(`downloadAssets: outputDir exists but is not a directory: ${outputDir}`);
  }

  const usedNames = new Set();
  const downloaded = [];
  const skipped = [];
  const errors = [];
  const urlMap = new Map();

  // Bounded-parallel iteration via a fixed-size worker pool.
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < urls.length) {
      const idx = cursor++;
      const url = urls[idx];
      const r = await downloadOne(url, outputDir, {
        minBytes,
        maxBytes,
        usedNames,
        _fetchFn,
        _writeFn,
      });
      if (r.ok) {
        downloaded.push({ sourceUrl: r.sourceUrl, savedAs: r.savedAs, bytes: r.bytes });
        urlMap.set(r.sourceUrl, r.savedAs);
      } else if (r.reason === 'fetch-error') {
        errors.push({ sourceUrl: r.sourceUrl, message: r.message });
      } else {
        skipped.push({ sourceUrl: r.sourceUrl, reason: r.reason, bytes: r.bytes });
      }
    }
  });
  await Promise.all(workers);

  return { downloaded, skipped, errors, urlMap };
}

// -----------------------------------------------------------------------------
// Pure: markdown rewriting
// -----------------------------------------------------------------------------

/**
 * Rewrite `![alt](remoteUrl)` and `<img src="remoteUrl">` to point at
 * local paths from `urlMap`. Un-mapped URLs are left alone (failed
 * downloads stay remote — caller decides whether to retry or accept).
 *
 * The `localPathPrefix` is prepended to each saved filename. Typical
 * usage from `wiki-ingest`:
 *   ```js
 *   rewriteAssetUrls(md, urlMap, { localPathPrefix: '.assets/<source-slug>/' })
 *   ```
 *
 * @param {string} content — markdown or HTML
 * @param {Map<string, string>} urlMap — sourceUrl → localFilename
 * @param {object} [opts]
 * @param {string} [opts.localPathPrefix='']           — joined with the saved filename
 * @returns {string}
 */
export function rewriteAssetUrls(content, urlMap, opts = {}) {
  const { localPathPrefix = '' } = opts;
  if (!urlMap || urlMap.size === 0) return String(content || '');

  // Build a lookup that accepts both the canonical http(s) form and the
  // legacy protocol-relative form (`//example.com/img.png`). We only
  // store http(s) keys in `urlMap`; we synthesize a `//` variant on the
  // fly so markdown sources that used protocol-relative don't escape.
  const remap = new Map();
  for (const [src, local] of urlMap.entries()) {
    const localPath = localPathPrefix
      ? `${localPathPrefix.replace(/\/+$/, '')}/${local}`
      : local;
    remap.set(src, localPath);
    // Also accept the `//host/path` form mapping to the same target.
    const protoRel = src.replace(/^https?:/, '');
    if (protoRel.startsWith('//')) remap.set(protoRel, localPath);
  }

  let out = String(content || '');

  // Markdown `![alt](url)` — preserve alt text and optional title.
  //
  // v0.14.3 hardening (P2-2): accept one level of nested brackets in alt
  // (`![Photo of [Eiffel tower]](url)`). Must stay in sync with the
  // matching regex in `extractImageUrls` — otherwise we'd extract images
  // we can't rewrite, leaving stale remote URLs in the markdown.
  out = out.replace(
    /(!\[(?:\[[^\]]*\]|[^\]])*\]\()([^)\s]+)(\s+"[^"]*")?\)/g,
    (match, prefix, url, title) => {
      const local = remap.get(url);
      if (!local) return match;
      return `${prefix}${local}${title || ''})`;
    },
  );

  // HTML `<img src="...">` — keep attribute style (quote-aware).
  out = out.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)("([^"]+)"|'([^']+)'|([^\s>]+))/gi,
    (match, lead, _all, dq, sq, bare) => {
      const url = dq || sq || bare;
      const local = remap.get(url);
      if (!local) return match;
      // Preserve the original quoting style.
      if (dq !== undefined) return `${lead}"${local}"`;
      if (sq !== undefined) return `${lead}'${local}'`;
      return `${lead}${local}`;
    },
  );

  return out;
}
