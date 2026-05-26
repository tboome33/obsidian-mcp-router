/**
 * Asset downloader for the ingestion pipeline. Phase E (v0.14.x) of the
 * [[obsidian-clipper]] borrowing roadmap.
 *
 * Pipeline:
 *   1. **`extractImagesWithMeta(content, baseUrl)`** — pure function.
 *      Scans HTML (`<img>`, `<source>`) and markdown (`![alt](url)`),
 *      returns `[{url, alt, isFigure}]` so callers can filter on
 *      relevance signals (empty alt = likely decorative, figure-wrapped
 *      = author-curated). Resolves relative URLs against `baseUrl`,
 *      dedupes by URL.
 *   2. **`extractImageUrls(content, baseUrl)`** — thin facade returning
 *      just the URL strings (back-compat with pre-v0.14.7 callers).
 *   3. **`decodeImageDimensions(buffer, contentType)`** — pure function.
 *      Parses magic bytes for PNG / JPEG / GIF / WebP (VP8 / VP8L / VP8X)
 *      and reads `width`/`height` attrs from SVG text. Returns
 *      `{width, height}` or `null` (unknown format / malformed header).
 *      Callers treat `null` as "can't verify → keep" rather than skip.
 *   4. **`downloadOne(url, outputDir, opts)`** — fetches a single image
 *      via the SSRF-safe `safe-fetch-binary.mjs`. Picks a safe filename
 *      (last URL path segment if reasonable, sha256(buffer).slice(0,16)
 *      fallback for collisions or unprintable names). Picks an extension
 *      from Content-Type (or from the URL extension if Content-Type is
 *      bland `application/octet-stream`). Writes to `<outputDir>/<filename>`.
 *      Skips by size (default `minBytes: 1024`) AND by dimensions
 *      (Phase E.2: default `minWidth: 0, minHeight: 0` at the helper
 *      level — the MCP tool turns these on by default at 100×100).
 *   5. **`downloadAssets(urls, outputDir, opts)`** — bulk wrapper with
 *      bounded parallelism. Returns `{downloaded, skipped, errors}` so
 *      the caller can render a manifest and decide whether to proceed.
 *   6. **`rewriteAssetUrls(markdown, urlMap)`** — pure function. Replaces
 *      `![alt](remoteUrl)` and `<img src="remoteUrl">` with the local
 *      relative path from `urlMap` (a `Map<sourceUrl, localPath>`).
 *      Leaves un-mapped URLs alone (failed downloads stay remote).
 *
 * What this MVP does NOT do:
 *   - `<picture>` / `srcset` multi-resolution selection (we pick the
 *     first `src` we see in `<source>`; the caller can post-filter).
 *   - Animated GIF / video / audio asset types (image-only for MVP).
 *   - BMP / TIFF / ICO / AVIF dimension parsing — these return `null`
 *     from `decodeImageDimensions` and the caller's dim filter ignores
 *     them ("can't verify → keep"). Rare on real-world articles.
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
// `decodeImageDimensions` is defined below (alongside the other pure
// helpers); imported via re-reference rather than a circular import.

// -----------------------------------------------------------------------------
// Pure: URL + metadata extraction
// -----------------------------------------------------------------------------

// Extract one HTML attribute value from a `<tag ...>` attribute string.
// Quote-aware: returns the value of the FIRST occurrence of `<name>`
// (case-insensitive). Returns `''` if the attribute is present with an
// empty value (e.g. `alt=""`), and `null` if absent.
//
// Why distinguish present-but-empty from absent: per ARIA, `alt=""` is
// an explicit signal that the image is decorative — the author chose
// to suppress it. We treat that the same as missing for the relevance
// filter, but the distinction is preserved at this layer in case
// future callers want to act on it differently.
//
// v0.14.7 P1 hardening — `\b` boundary is dangerous here:
//   In JS regex, `\b` triggers between `[A-Za-z0-9_]` and any other char.
//   `-` is "other", so `\bsrc` ALSO matches the `src` suffix of
//   `data-src` (very common lazy-loading attribute on Wikipedia, Medium,
//   any modern CMS). Pre-fix, `getAttr(attrs, 'src')` against
//   `<img data-src="lazy.png" src="real.png">` returned `'lazy.png'`
//   because that match comes first. Same trap for `srcset` matching
//   `imagesrcset` / `data-srcset`.
//
//   Fix: require a tag-attr boundary — start-of-string OR whitespace OR
//   the self-close slash — before the name. This is what HTML actually
//   uses between attributes, so it matches HTML syntax instead of
//   regex word-boundary semantics.
function getAttr(attrs, name) {
  const re = new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) {
    // Check for a presence-only attribute (no `=` form). Rare for src/alt
    // but cheap to handle. Same boundary discipline as above.
    if (new RegExp(`(?:^|[\\s/])${name}(?=[\\s>/]|$)(?!\\s*=)`, 'i').test(attrs)) return '';
    return null;
  }
  const v = m[1] ?? m[2] ?? m[3] ?? '';
  return v;
}

/**
 * Extract images from HTML or markdown content with per-image metadata.
 *
 * Returns one entry per UNIQUE absolute URL with:
 *   - `url`: absolute http(s) URL (relative URLs resolved against baseUrl)
 *   - `alt`: alt text (empty string when present-but-empty `alt=""` or
 *            absent; trimmed). For markdown `![alt](url)`, the bracket
 *            content. Defaults to `''` for `<source>` (no alt attribute).
 *   - `isFigure`: true when the source tag was lexically inside an
 *                 unclosed `<figure>...</figure>` block at the moment
 *                 of the match. Single-pass tokenizer — O(n).
 *
 * Patterns scanned:
 *   1. HTML `<img src="..." alt="...">` (quote-aware)
 *   2. HTML `<source srcset="...">` (takes the FIRST URL in srcset,
 *      drops density descriptors; `alt` defaults to '')
 *   3. Markdown `![alt](url)` and `![alt](url "title")` (drops the title;
 *      isFigure always false — markdown has no figure equivalent)
 *
 * Dedup is on absolute URL: if the same URL appears twice with different
 * alt text or once inside / once outside a figure, the FIRST occurrence's
 * metadata wins (document order).
 *
 * @param {string} content — HTML or markdown
 * @param {string} baseUrl — page URL for relative resolution; required
 * @returns {Array<{url: string, alt: string, isFigure: boolean}>}
 */
export function extractImagesWithMeta(content, baseUrl) {
  const safe = String(content || '');
  if (!baseUrl) {
    throw new Error('extractImagesWithMeta: baseUrl is required for relative URL resolution');
  }

  // Single-pass tokenizer for HTML tags. We care about five tag kinds:
  //   <img>, <source>, <figure>, </figure>, <picture>, </picture>
  // The tokenizer is intentionally minimal: scan for `<`, peek next
  // chars, advance. O(n) where n = HTML length, vs. the O(n²) we'd
  // get from re-scanning context per match.
  //
  // v0.14.7 P2 hardening — picture/source alt propagation:
  //   A `<picture>` block typically wraps several `<source srcset>`
  //   responsive variants and ends with `<img src alt>` as fallback.
  //   Pre-fix, each `<source>` was extracted with `alt: ''` because
  //   sources have no alt attribute, then the relevance filter
  //   (requireAltOrFigure) dropped them — regressing the pre-v0.14.7
  //   responsive-image path that callers relied on. Fix: when an
  //   `<img>` with non-empty alt is seen inside `<picture>`, retroactively
  //   assign its alt to all preceding sibling sources still in the
  //   pending buffer. This makes the filter "the picture is relevant
  //   iff its img has alt", which matches HTML5 spec intent (the img
  //   is the canonical reference; sources are alternates).
  const found = [];
  let figureDepth = 0;
  let pictureDepth = 0;
  // Indexes into `found` for sources awaiting an <img> sibling alt
  // within the CURRENT <picture> block.
  let pendingPictureSources = [];
  let i = 0;
  const n = safe.length;

  while (i < n) {
    const lt = safe.indexOf('<', i);
    if (lt === -1) break;

    // Peek the tag name (lowercased, up to 9 chars — enough for "/picture").
    const tagSnippet = safe.slice(lt + 1, lt + 10).toLowerCase();

    if (tagSnippet.startsWith('figure') && /^[\s>]/.test(safe[lt + 7] || '>')) {
      // <figure ...> — open. Advance to the closing `>`.
      const gt = safe.indexOf('>', lt + 7);
      figureDepth += 1;
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    if (tagSnippet.startsWith('/figure') && /^[\s>]/.test(safe[lt + 8] || '>')) {
      // </figure> — close. Decrement (clamp at 0).
      // Symmetric boundary check with the open tag (v0.14.7 NIT fix).
      figureDepth = Math.max(0, figureDepth - 1);
      const gt = safe.indexOf('>', lt + 8);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    if (tagSnippet.startsWith('picture') && /^[\s>]/.test(safe[lt + 8] || '>')) {
      // <picture ...> — open. Reset pending-sources buffer (we only
      // propagate alt within a single picture block).
      const gt = safe.indexOf('>', lt + 8);
      pictureDepth += 1;
      pendingPictureSources = [];
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    if (tagSnippet.startsWith('/picture') && /^[\s>]/.test(safe[lt + 9] || '>')) {
      // </picture> — close. Pending sources keep their `alt: ''`
      // (their <img> sibling had no alt either, so the relevance
      // filter will drop them consistently).
      pictureDepth = Math.max(0, pictureDepth - 1);
      pendingPictureSources = [];
      const gt = safe.indexOf('>', lt + 9);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    if (tagSnippet.startsWith('img') && /^[\s>/]/.test(safe[lt + 4] || '>')) {
      // <img ...> — extract src + alt.
      //
      // v0.14.7 P2 codex pass 2 — read `alt` BEFORE the `if (src)` gate.
      // Reason: a lazy-loaded picture often has `<img data-src="..."
      // alt="Hero">` as fallback. We intentionally ignore `data-src`
      // (the BLOCKER pass-1 fix), so `src` is empty and we'd skip the
      // alt-propagation step — leaving the `<picture>`'s sources with
      // `alt: ''` and dropped by the relevance filter. The alt itself
      // is the relevance signal for the WHOLE picture; we must
      // propagate it regardless of whether THIS specific img has a
      // usable `src` to push.
      const gt = safe.indexOf('>', lt + 4);
      const tag = safe.slice(lt, gt === -1 ? n : gt + 1);
      const attrs = tag.slice(4, -1); // strip "<img" prefix and ">" suffix
      const src = getAttr(attrs, 'src');
      const altRaw = getAttr(attrs, 'alt');
      const alt = (altRaw == null ? '' : altRaw).trim();
      if (src) {
        found.push({ raw: src, alt, isFigure: figureDepth > 0 });
      }
      // Propagate alt to preceding `<source>` siblings in the current
      // `<picture>` regardless of whether the img had a usable `src`.
      // Only when alt is non-empty — empty alt would be a no-op
      // (sources stay `alt: ''`).
      if (pictureDepth > 0 && alt !== '' && pendingPictureSources.length > 0) {
        for (const idx of pendingPictureSources) {
          if (!found[idx].alt) found[idx].alt = alt;
        }
        pendingPictureSources = [];
      }
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    if (tagSnippet.startsWith('source') && /^[\s>/]/.test(safe[lt + 7] || '>')) {
      // <source srcset="..."> — first URL.
      const gt = safe.indexOf('>', lt + 7);
      const tag = safe.slice(lt, gt === -1 ? n : gt + 1);
      const attrs = tag.slice(7, -1); // strip "<source" prefix and ">" suffix
      const srcset = getAttr(attrs, 'srcset');
      if (srcset) {
        const firstUrl = srcset.split(/[,\s]+/)[0];
        if (firstUrl) {
          const idx = found.length;
          found.push({ raw: firstUrl, alt: '', isFigure: figureDepth > 0 });
          if (pictureDepth > 0) pendingPictureSources.push(idx);
        }
      }
      i = gt === -1 ? n : gt + 1;
      continue;
    }

    // Some other tag — skip past its `>`.
    const gt = safe.indexOf('>', lt + 1);
    i = gt === -1 ? n : gt + 1;
  }

  // Markdown `![alt](url)` — drop optional "title".
  //
  // Stays in lock-step with rewriteAssetUrls's matching regex
  // (HARDENING P2-2 / P3-b — see tests). Accepts one level of nested
  // brackets in alt: `![Photo of [Eiffel tower]](url)`.
  const mdRe = /!\[((?:\[[^\]]*\]|[^\]])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = mdRe.exec(safe)) !== null) {
    if (m[2]) {
      found.push({ raw: m[2], alt: (m[1] || '').trim(), isFigure: false });
    }
  }

  // Resolve + dedupe by absolute URL. First occurrence wins.
  const seen = new Set();
  const result = [];
  for (const { raw, alt, isFigure } of found) {
    const trimmed = String(raw).trim();
    if (/^(?:data|blob|javascript|mailto|tel|about):/i.test(trimmed)) continue;

    let abs;
    try {
      abs = new URL(trimmed, baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    result.push({ url: abs, alt, isFigure });
  }

  return result;
}

/**
 * Back-compat facade returning only URL strings. Equivalent to the
 * pre-v0.14.7 behavior. Callers that need alt-text / figure-wrapping
 * signals should use `extractImagesWithMeta` directly.
 *
 * @param {string} content — HTML or markdown
 * @param {string} baseUrl — page URL for relative resolution; required
 * @returns {string[]} — absolute http(s) URLs, deduped, in document order
 */
export function extractImageUrls(content, baseUrl) {
  if (!baseUrl) {
    throw new Error('extractImageUrls: baseUrl is required for relative URL resolution');
  }
  return extractImagesWithMeta(content, baseUrl).map((e) => e.url);
}

// -----------------------------------------------------------------------------
// Pure: dimension decoding (Phase E.2)
// -----------------------------------------------------------------------------

/**
 * Decode `{width, height}` in pixels from raw image bytes by parsing
 * the format's header. Supports PNG, JPEG, GIF, WebP (VP8 / VP8L / VP8X),
 * and SVG (text-based width/height/viewBox).
 *
 * Returns `null` when:
 *   - Buffer is too short to contain a valid header for any supported format
 *   - Magic bytes don't match any supported format
 *   - Format is supported but the header is malformed
 *   - Format is unsupported (BMP, TIFF, ICO, AVIF, JPEG-2000 — return null,
 *     callers treat null as "can't verify → keep")
 *
 * The `contentType` argument is advisory only: we always sniff magic
 * bytes. This is defensive — servers misreport content-type all the
 * time (.png served as application/octet-stream, .svg as text/xml,
 * etc.), and we'd rather trust the bytes than the header.
 *
 * @param {Buffer} buffer
 * @param {string} [contentType] — advisory; used as a hint for SVG fast-path
 * @returns {{width: number, height: number} | null}
 */
export function decodeImageDimensions(buffer, contentType = '') {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length < 8) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR chunk (width/height as BE uint32 at offsets 16, 20).
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const w = buffer.readUInt32BE(16);
    const h = buffer.readUInt32BE(20);
    if (w > 0 && h > 0) return { width: w, height: h };
    return null;
  }

  // GIF: 47 49 46 38 [37|39] 61 + LE uint16 width@6, height@8.
  if (
    buffer.length >= 10 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    const w = buffer.readUInt16LE(6);
    const h = buffer.readUInt16LE(8);
    if (w > 0 && h > 0) return { width: w, height: h };
    return null;
  }

  // WebP: 'RIFF' <size> 'WEBP' <chunk-fourcc>
  if (
    buffer.length >= 30 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    const fourcc = buffer.slice(12, 16).toString('ascii');
    if (fourcc === 'VP8 ') {
      // VP8 (lossy): start code at 23-25 (0x9d 0x01 0x2a), then
      // 2-byte LE width-with-scale at 26, height-with-scale at 28.
      // Mask the top 2 bits which are scale.
      if (buffer.length < 30) return null;
      const wRaw = buffer.readUInt16LE(26) & 0x3fff;
      const hRaw = buffer.readUInt16LE(28) & 0x3fff;
      if (wRaw > 0 && hRaw > 0) return { width: wRaw, height: hRaw };
      return null;
    }
    if (fourcc === 'VP8L') {
      // VP8L (lossless): signature 0x2F at offset 20, then 28 bits
      // packed at offsets 21-24 (LE). Width = bits 0-13 + 1, height = bits 14-27 + 1.
      if (buffer.length < 25 || buffer[20] !== 0x2f) return null;
      const b21 = buffer[21];
      const b22 = buffer[22];
      const b23 = buffer[23];
      const b24 = buffer[24];
      const w = (b21 | ((b22 & 0x3f) << 8)) + 1;
      const h = ((b22 >> 6) | (b23 << 2) | ((b24 & 0x0f) << 10)) + 1;
      if (w > 0 && h > 0) return { width: w, height: h };
      return null;
    }
    if (fourcc === 'VP8X') {
      // VP8X (extended): 24-bit LE width-1 at 24-26, 24-bit LE height-1 at 27-29.
      const w = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
      const h = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
      if (w > 0 && h > 0) return { width: w, height: h };
      return null;
    }
    return null;
  }

  // JPEG: FF D8 FF, walk markers to find SOF (FF C0/C1/C2/C3) which
  // carries height (BE u16 at offset+5) and width (BE u16 at offset+7).
  // Skip non-SOF markers via their 2-byte BE length.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let off = 2;
    while (off + 8 < buffer.length) {
      if (buffer[off] !== 0xff) return null; // misaligned
      let marker = buffer[off + 1];
      // 0xFF padding bytes — skip.
      while (marker === 0xff && off + 2 < buffer.length) {
        off += 1;
        marker = buffer[off + 1];
      }
      if (marker === 0xd8 || marker === 0xd9) {
        // SOI again or EOI — give up.
        return null;
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        // SOF marker — dimensions at offset+5 (height), +7 (width), BE u16.
        if (off + 9 > buffer.length) return null;
        const h = buffer.readUInt16BE(off + 5);
        const w = buffer.readUInt16BE(off + 7);
        if (w > 0 && h > 0) return { width: w, height: h };
        return null;
      }
      // Non-SOF marker — skip via 2-byte BE length at offset+2.
      if (off + 4 > buffer.length) return null;
      const segLen = buffer.readUInt16BE(off + 2);
      if (segLen < 2) return null; // malformed
      off += 2 + segLen;
    }
    return null;
  }

  // SVG: text-based. Look for `<svg ... width="X" height="Y" ... viewBox="0 0 W H">`.
  // Only try this when content-type smells like SVG/XML, OR the first
  // non-whitespace bytes look like `<svg` or `<?xml`.
  const ctLooksSvg = /svg|xml/i.test(String(contentType || ''));
  const firstChars = buffer.slice(0, 64).toString('utf8').trim().toLowerCase();
  const bytesLookSvg = firstChars.startsWith('<svg') || firstChars.startsWith('<?xml');
  if (ctLooksSvg || bytesLookSvg) {
    // Cap the slice we parse — SVG files can be megabytes of paths,
    // but the <svg ...> open tag is in the first few KiB. Cap at
    // 32 KiB to accommodate Inkscape-emitted SVGs that have long XML
    // preambles + `<defs>` + inline `<style>` before the `<svg>` tag
    // (v0.14.7 NIT — pre-fix 8 KiB caused false-negatives on those).
    const text = buffer.slice(0, Math.min(buffer.length, 32 * 1024)).toString('utf8');
    const tag = /<svg\b([^>]*)>/i.exec(text);
    if (!tag) return null;
    const attrs = tag[1] || '';
    const parsePx = (raw) => {
      if (raw == null) return null;
      const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(raw);
      return m ? Math.round(parseFloat(m[1])) : null;
    };
    const w = parsePx(getAttr(attrs, 'width'));
    const h = parsePx(getAttr(attrs, 'height'));
    if (w != null && h != null && w > 0 && h > 0) return { width: w, height: h };
    // Fall back to viewBox "minX minY width height".
    const vb = getAttr(attrs, 'viewBox');
    if (vb) {
      const parts = vb.trim().split(/[\s,]+/);
      if (parts.length === 4) {
        const vbW = parseFloat(parts[2]);
        const vbH = parseFloat(parts[3]);
        if (Number.isFinite(vbW) && Number.isFinite(vbH) && vbW > 0 && vbH > 0) {
          return { width: Math.round(vbW), height: Math.round(vbH) };
        }
      }
    }
    return null;
  }

  // Unknown format — let the caller decide ("can't verify → keep").
  return null;
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
 *   - `{ ok: true, sourceUrl, savedAs, bytes, dimensions? }` — saved to disk
 *   - `{ ok: false, sourceUrl, reason: 'too-small' }`        — under minBytes (icon)
 *   - `{ ok: false, sourceUrl, reason: 'too-large' }`        — over maxBytes
 *   - `{ ok: false, sourceUrl, reason: 'too-small-dimensions', dimensions }`
 *                                                            — Phase E.2 v0.14.7:
 *     width or height below `minWidth`/`minHeight` after header parse.
 *     Only triggers when dimensions could be decoded — unknown formats
 *     (BMP, TIFF, ICO, AVIF) are kept ("can't verify → keep").
 *   - `{ ok: false, sourceUrl, reason: 'fetch-error', message }`
 *
 * @param {string} url
 * @param {string} outputDir — must be absolute
 * @param {object} [opts]
 * @param {number} [opts.minBytes=1024]
 * @param {number} [opts.maxBytes=10*1024*1024]
 * @param {number} [opts.minWidth=0]                    — Phase E.2 v0.14.7. **Disabled by default at this helper layer**. `download_page_assets` (MCP tool wrapper) sets the smart default of `100` at its layer; direct helper callers stay opt-in.
 * @param {number} [opts.minHeight=0]                   — Phase E.2 v0.14.7. Same caveat as `minWidth`.
 * @param {Set<string>} [opts.usedNames]               — collision-avoid across batch
 * @param {Function} [opts._fetchFn]                   — injection seam for tests
 * @param {Function} [opts._writeFn]                   — injection seam for tests
 * @param {Function} [opts._decodeDimsFn]              — injection seam for tests
 */
export async function downloadOne(url, outputDir, opts = {}) {
  const {
    minBytes = 1024,
    maxBytes = 10 * 1024 * 1024,
    minWidth = 0,
    minHeight = 0,
    usedNames = new Set(),
    _fetchFn = safeFetchBinary,
    _writeFn = fs.writeFile,
    _decodeDimsFn = decodeImageDimensions,
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

  // Phase E.2 v0.14.7: dimension filter (post-fetch). Only enforced
  // when at least one of minWidth/minHeight is set (>0). Decoded
  // dimensions stay null for unsupported formats (BMP/TIFF/ICO/AVIF) —
  // we DON'T skip those (treat as "can't verify → keep"), only skip
  // when dimensions parsed AND below threshold.
  let dimensions = null;
  if (minWidth > 0 || minHeight > 0) {
    dimensions = _decodeDimsFn(buffer, contentType);
    if (dimensions && (dimensions.width < minWidth || dimensions.height < minHeight)) {
      return {
        ok: false,
        sourceUrl: url,
        reason: 'too-small-dimensions',
        bytes: buffer.length,
        dimensions,
      };
    }
  }

  const filename = pickAssetFilename(url, buffer, contentType, usedNames);
  usedNames.add(filename);
  const fullPath = path.join(outputDir, filename);
  await _writeFn(fullPath, buffer);

  const result = { ok: true, sourceUrl: url, savedAs: filename, bytes: buffer.length };
  if (dimensions) result.dimensions = dimensions;
  return result;
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
 * @param {number} [opts.minWidth=0]                    — Phase E.2 v0.14.7. **Disabled by default at this helper layer**. `download_page_assets` (MCP tool wrapper) sets the smart default of `100` at its layer; direct helper callers stay opt-in.
 * @param {number} [opts.minHeight=0]                   — Phase E.2 v0.14.7. Same caveat as `minWidth`.
 * @param {Function} [opts._fetchFn]
 * @param {Function} [opts._writeFn]
 * @param {Function} [opts._mkdirFn]
 * @param {Function} [opts._statFn]                   — v0.14.3 injection seam for the parent-exists + post-mkdir isDirectory() guards. Defaults to `fs.stat`. Tests use a stub that returns `{isDirectory: () => true}` to bypass the real-filesystem check.
 * @param {Function} [opts._decodeDimsFn]             — injection seam for tests
 * @returns {Promise<{
 *   downloaded: Array<{sourceUrl, savedAs, bytes, dimensions?}>,
 *   skipped:    Array<{sourceUrl, reason, bytes?, dimensions?}>,
 *   errors:     Array<{sourceUrl, message}>,
 *   urlMap:     Map<string, string>,                  — sourceUrl → savedAs
 * }>}
 */
export async function downloadAssets(urls, outputDir, opts = {}) {
  const {
    concurrency = 4,
    minBytes = 1024,
    maxBytes = 10 * 1024 * 1024,
    minWidth = 0,
    minHeight = 0,
    _fetchFn,
    _writeFn,
    _mkdirFn = fs.mkdir,
    _statFn = fs.stat,
    _decodeDimsFn,
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
        minWidth,
        minHeight,
        usedNames,
        _fetchFn,
        _writeFn,
        ...(_decodeDimsFn ? { _decodeDimsFn } : {}),
      });
      if (r.ok) {
        const entry = { sourceUrl: r.sourceUrl, savedAs: r.savedAs, bytes: r.bytes };
        if (r.dimensions) entry.dimensions = r.dimensions;
        downloaded.push(entry);
        urlMap.set(r.sourceUrl, r.savedAs);
      } else if (r.reason === 'fetch-error') {
        errors.push({ sourceUrl: r.sourceUrl, message: r.message });
      } else {
        const skipEntry = { sourceUrl: r.sourceUrl, reason: r.reason, bytes: r.bytes };
        if (r.dimensions) skipEntry.dimensions = r.dimensions;
        skipped.push(skipEntry);
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

  // HTML `<source srcset="...">` — rewrite the FIRST URL in srcset,
  // matching what `extractImagesWithMeta` extracted.
  //
  // v0.14.7 P2 codex pass 4 — close the picture-source lock-step gap:
  //   Pre-fix, the P2 picture-source alt propagation (codex pass 1)
  //   made `<source>` URLs pass the relevance filter and get downloaded
  //   — but there was no `rewriteAssetUrls` path for `<source srcset>`.
  //   Result: HTML callers that round-trip through rewriteAssetUrls saw
  //   `<source srcset="https://remote/...">` in the output even though
  //   the asset was downloaded. (Markdown callers via markitdown didn't
  //   see this because markitdown strips `<source>` during HTML→md
  //   conversion. But the lock-step contract should hold for any caller.)
  //
  //   The rewrite preserves the rest of the srcset (descriptors + other
  //   URLs) untouched — only the first URL is replaced because that's
  //   what we extracted. Subsequent variants stay remote, consistent
  //   with the "we picked one URL per source" extract policy.
  out = out.replace(
    /(<source\b[^>]*?(?:^|[\s/])srcset\s*=\s*)("([^"]+)"|'([^']+)'|([^\s>]+))/gi,
    (match, lead, _all, dq, sq, bare) => {
      const fullSrcset = dq || sq || bare;
      // Use the SAME split as `extractImagesWithMeta` so we replace the
      // same URL the extractor picked. Any divergence here would break
      // the lock-step contract again (HARDENING P3-b would catch it).
      const firstUrl = fullSrcset.split(/[,\s]+/)[0];
      const local = firstUrl && remap.get(firstUrl);
      if (!local) return match;
      // `String.replace(string, string)` replaces only the FIRST
      // occurrence — perfect for our "first URL only" semantics.
      const newSrcset = fullSrcset.replace(firstUrl, local);
      if (dq !== undefined) return `${lead}"${newSrcset}"`;
      if (sq !== undefined) return `${lead}'${newSrcset}'`;
      return `${lead}${newSrcset}`;
    },
  );

  // HTML `<img src="...">` — keep attribute style (quote-aware).
  //
  // v0.14.7 P2 codex pass 3 — attribute boundary discipline:
  //   Pre-fix, the regex used `\bsrc\s*=` which ALSO matched `data-src=`
  //   (the `-` is a regex word-boundary). This was in lock-step with
  //   the buggy pre-v0.14.7 `getAttr` regex by accident — they were
  //   both wrong the same way. Now `getAttr` correctly ignores
  //   `data-src`, so `extractImagesWithMeta` returns the real `src`
  //   URL. But this rewrite regex still consumed `data-src` first,
  //   tried to look it up in urlMap (miss), and bailed out — leaving
  //   the WHOLE `<img>` tag with its remote `src` URL intact even
  //   though we downloaded the asset. Result: stale remote refs in
  //   the markdown after a `--save-assets` ingest of a lazy-loaded
  //   article (Wikipedia, Medium, etc.).
  //
  //   Fix: same boundary as `getAttr` — `(?:^|[\s/])src\s*=` requires
  //   the previous char to be whitespace or self-close slash, so
  //   `data-src` is skipped. The HARDENING P3-b lock-step test was
  //   the canary that SHOULD have caught this — extended below with
  //   `data-src` fixtures to plug the regression-test gap.
  out = out.replace(
    /(<img\b[^>]*?(?:^|[\s/])src\s*=\s*)("([^"]+)"|'([^']+)'|([^\s>]+))/gi,
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
