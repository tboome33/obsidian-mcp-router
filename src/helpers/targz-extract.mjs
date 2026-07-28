/**
 * targz-extract.mjs — dependency-free, hardened .tar.gz extraction for the
 * `--sync-from-github` mode (template-distribution Lot 3).
 *
 * Why hand-rolled: the archive comes from the network (GitHub codeload), and
 * the decision `brat-dans-template-vivant` / roadmap Lot 3 explicitly require
 * a **path-traversal guard on the downloaded archive**. Owning the ~150 lines
 * of ustar parsing means the guard is exact, unit-tested, and adds no
 * dependency to a script that must run on any user PC.
 *
 * Threat model (hostile or corrupted archive):
 *   - **Zip-slip / path traversal**: entry names containing `..`, absolute
 *     paths, drive letters or backslash tricks must never write outside the
 *     destination directory → the WHOLE extraction throws (a hostile archive
 *     is not partially trusted).
 *   - **Link smuggling**: symlinks/hardlinks could point outside the tree and
 *     turn a later write into an arbitrary-file write → link entries are
 *     SKIPPED (recorded, never silent) rather than materialized.
 *   - **Decompression bombs**: entry-count and total-bytes caps abort the
 *     extraction with a clear error.
 *
 * Format notes: handles ustar name+prefix, GNU 'L' longnames, and skips pax
 * ('x'/'g') and GNU 'K' longlink metadata entries. Checksums are not
 * verified — GitHub tarballs are well-formed, and a corrupted header fails
 * fast on the octal parse instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import https from 'node:https';

export const EXTRACT_LIMITS = {
  maxEntries: 20_000,
  // A vault skeleton is ~2 MB; 200 MB is already 100× headroom. The gunzip
  // output cap derives from this (review finding: a fixed large floor let a
  // ~575 KB download decompress to half a GB before any entry was inspected).
  maxTotalBytes: 200 * 1024 * 1024,
};

/**
 * Validate the owner/name and git ref used to build the codeload URL, so a
 * caller-supplied value can never smuggle path segments or query strings
 * into the request.
 */
export function assertSafeRepoRef(repo, ref) {
  const repoText = String(repo ?? '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoText)
    || repoText.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error(`Invalid GitHub repo "${repo}" — expected owner/name`);
  }
  const refText = String(ref ?? '');
  if (!/^[A-Za-z0-9_./-]+$/.test(refText) || refText.includes('..') || refText.startsWith('-')) {
    throw new Error(`Invalid git ref "${ref}"`);
  }
}

/** Join an archive entry name under destRoot, refusing any escape. */
function safeJoin(destRoot, entryName) {
  const norm = String(entryName).replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
    throw new Error(`Archive entry has an absolute path: ${entryName}`);
  }
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.');
  // Windows strips trailing dots/spaces in classic Win32 paths but NOT in
  // the extended-length paths Node uses — `.. ` or `...` land as literal
  // names. A component that reduces to '', '.' or '..' once that trailing
  // noise is stripped is never legitimate template content: reject it
  // explicitly instead of relying on the rel-prefix test below to catch it
  // by accident (review finding).
  if (parts.some((p) => {
    const stripped = p.replace(/[. ]+$/, '');
    return p === '..' || stripped === '' || stripped === '.' || stripped === '..';
  })) {
    throw new Error(`Archive entry escapes the destination (path traversal): ${entryName}`);
  }
  const out = path.join(destRoot, ...parts);
  const rel = path.relative(destRoot, out);
  // Segment-accurate escape test — a plain startsWith('..') also rejected
  // legitimate names like `..foo` (review finding).
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Archive entry escapes the destination: ${entryName}`);
  }
  return out;
}

function readOctal(buffer, offset, length) {
  // GNU base-256 numeric extension (high bit set on the first byte) is only
  // needed for entries > 8 GiB — nothing a template archive legitimately
  // contains. 'ascii' decoding would silently MASK that high bit and parse
  // garbage as 0 (review finding: a base-256 size yielded an empty file and
  // the payload was re-parsed as headers) — refuse it explicitly, and decode
  // as latin1 so no byte is rewritten before validation.
  if (buffer[offset] & 0x80) {
    throw new Error(`Unsupported base-256 numeric field at ${offset}`);
  }
  const text = buffer.subarray(offset, offset + length).toString('latin1')
    .replace(/\0/g, ' ').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`Malformed tar header (bad octal field at ${offset})`);
  }
  return Number.parseInt(text, 8);
}

function readName(buffer, offset, length) {
  const raw = buffer.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? length : nul).toString('utf8');
}

/**
 * Extract a gzipped tar buffer into destDir.
 *
 * @returns {{files: number, dirs: number, skippedLinks: string[]}}
 * @throws on traversal attempts, malformed headers, or exceeded limits.
 */
export function extractTarGz(gzBuffer, destDir, limits = {}) {
  const maxEntries = limits.maxEntries ?? EXTRACT_LIMITS.maxEntries;
  const maxTotalBytes = limits.maxTotalBytes ?? EXTRACT_LIMITS.maxTotalBytes;

  // The caller's limit governs the decompressed size too (review finding:
  // a fixed large floor let a tiny download decompress to half a GB). The
  // headroom covers headers (≤ 512 B × maxEntries) and per-entry padding.
  const tar = zlib.gunzipSync(gzBuffer, { maxOutputLength: maxTotalBytes + 16 * 1024 * 1024 });

  let offset = 0;
  let entries = 0;
  let totalBytes = 0;
  let files = 0;
  let dirs = 0;
  let pendingLongName = null;
  const skippedLinks = [];

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    offset += 512;

    entries += 1;
    if (entries > maxEntries) {
      throw new Error(`Archive exceeds the ${maxEntries}-entry limit`);
    }

    const size = readOctal(header, 124, 12);
    const dataBlocks = Math.ceil(size / 512) * 512;
    // Strict: a legit archive always carries the full padded data block
    // before the end-of-archive zeros. Any slack here would let a crafted
    // final entry silently extract truncated content (subarray clamps).
    if (offset + dataBlocks > tar.length) {
      throw new Error('Truncated tar archive');
    }
    // EVERY entry's payload counts toward the cap — pax/longname metadata
    // and mislabeled directory payloads included (review finding: metadata
    // entries dodged the accounting entirely).
    totalBytes += size;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Archive exceeds the ${Math.round(maxTotalBytes / 1024 / 1024)} MB extraction limit`);
    }
    const type = String.fromCharCode(header[156] || 0x30);

    let name = readName(header, 0, 100);
    const prefix = readName(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (pendingLongName !== null) {
      name = pendingLongName;
      pendingLongName = null;
    }

    if (type === 'L') {
      // GNU longname: the data of THIS entry is the name of the NEXT one.
      pendingLongName = tar.subarray(offset, offset + size).toString('utf8').replace(/\0+$/, '');
      offset += dataBlocks;
      continue;
    }
    if (type === 'x' || type === 'g' || type === 'K') {
      // pax extended headers / GNU longlink metadata — not needed, skip data.
      offset += dataBlocks;
      continue;
    }
    if (type === '1' || type === '2') {
      // Hard/symlinks are never materialized (link smuggling) — recorded so
      // the caller can report the omission instead of hiding it.
      skippedLinks.push(name);
      offset += dataBlocks;
      continue;
    }

    if (type === '5') {
      fs.mkdirSync(safeJoin(destDir, name), { recursive: true });
      dirs += 1;
      // A well-formed dir entry has size 0, but a crafted one can declare a
      // payload — skipping it here keeps the stream in sync (review finding:
      // the payload was otherwise re-parsed as tar headers).
      offset += dataBlocks;
      continue;
    }

    if (type === '0' || type === '\0') {
      const dest = safeJoin(destDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, tar.subarray(offset, offset + size));
      files += 1;
      offset += dataBlocks;
      continue;
    }

    // Char/block devices, FIFOs… nothing a vault template legitimately
    // contains — skip the data, record like links.
    skippedLinks.push(`${name} (type ${type})`);
    offset += dataBlocks;
  }

  return { files, dirs, skippedLinks };
}

/**
 * Download a URL to a Buffer over HTTPS with a hard size cap and bounded
 * redirect following. Rejects non-https redirect targets.
 */
export function httpsGetBuffer(url, { maxBytes = 100 * 1024 * 1024, maxRedirects = 3, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'user-agent': 'obsidian-mcp-router (sync-from-github)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).href;
        if (!next.startsWith('https://')) return reject(new Error(`Refusing non-HTTPS redirect to ${next}`));
        return resolve(httpsGetBuffer(next, { maxBytes, maxRedirects: maxRedirects - 1, timeoutMs }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          request.destroy(new Error(`Download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB cap`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Timeout downloading ${url}`)));
    request.on('error', reject);
  });
}
