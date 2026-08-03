/**
 * deterministic-zip.mjs — a byte-reproducible ZIP writer and a reader that
 * audits an archive WITHOUT extracting it.
 *
 * The codec half of C9's export gate (`export-gate.mjs` is the policy half).
 * It exists because the tools that used to produce our artifacts are not
 * reproducible: PowerShell's `Compress-Archive` stamps each entry with its
 * real mtime, walks the tree in filesystem order, and records host/attribute
 * bytes from the machine that ran it. Two builds of the same commit therefore
 * differed, and nothing could tie a published `.mcpb` back to its source.
 *
 * ── What is normalised (the reproducibility contract) ────────────────────
 *
 *   entry order        sorted by UTF-8 byte order of the name (not locale,
 *                      not filesystem order)
 *   modification time  frozen at the DOS epoch 1980-01-01T00:00:00
 *                      (dosDate 0x0021, dosTime 0x0000)
 *   name separators    always `/`, never `\`; no leading `/`, no drive letter
 *   version made by    0x0014 with host 0 (MS-DOS/FAT) — never the real OS,
 *                      which is what makes a Windows zip differ from a Linux
 *                      one for identical content
 *   external attrs     0 — no unix mode, no FAT attribute bits, no leak of
 *                      the umask or of the read-only flag
 *   general flags      0x0800 (UTF-8 names) and nothing else: no data
 *                      descriptors, no encryption bits
 *   extra fields       empty — in particular no `UT`/`Unix`/`NTFS` extended
 *                      timestamp blocks, the usual hidden source of drift
 *   directory entries  not written at all; consumers create parents. Empty
 *                      directories therefore do not survive a round trip.
 *   compression        deflate level 9, or STORE when deflate does not
 *                      actually shrink the entry (a deterministic rule, not
 *                      a heuristic that could depend on timing)
 *   archive comment    empty
 *
 * ── What is NOT normalised (say it plainly) ──────────────────────────────
 *
 *   1. **zlib's deflate output.** Identical input + identical level gives
 *      identical bytes for a given zlib build, but zlib is free to change its
 *      encoder between versions. A build on Node 20 and a build on Node 22 may
 *      legitimately produce different — both valid — archives. That is why
 *      `buildZipManifest` records `zlibVersion`: when two builds of the same
 *      commit disagree, the manifest says whether the encoder is the reason.
 *      Pass `compression: 'store'` for an archive whose bytes do not depend on
 *      zlib at all, at the cost of roughly 4x the size.
 *   2. **The input bytes themselves.** This module reproduces an archive from
 *      a file set; it cannot make the file set reproducible. `npm ci` output
 *      and git's line-ending translation are upstream of it — see
 *      `docs/export-gate.md`.
 *
 * ── The 64 KiB / 4 GiB ceiling ───────────────────────────────────────────
 *
 * ZIP64 is deliberately NOT implemented. Instead the writer throws when an
 * archive would exceed the classic limits (65535 entries, 4 GiB sizes or
 * offsets). Silently emitting a truncated central directory is exactly the
 * failure mode this module exists to prevent.
 *
 * `zlib.crc32` requires Node >= 20.15.0; `package.json` engines pins
 * >= 20.18.1, so it is always present.
 */

import zlib from 'node:zlib';

// DOS timestamp for 1980-01-01T00:00:00 — the earliest value the format can
// represent. Date = ((year-1980) << 9) | (month << 5) | day = 0x0021.
export const DOS_EPOCH_DATE = 0x0021;
export const DOS_EPOCH_TIME = 0x0000;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;

const VERSION_NEEDED = 20; // 2.0 — deflate
const VERSION_MADE_BY = 20; // 2.0, host byte 0 (MS-DOS) added separately
const FLAG_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// 0xfffe, not 0xffff: a count of exactly 0xffff in the classic EOCD is the
// ZIP64 sentinel, so an archive with 65535 entries would be legally written
// here and then read back as "this is ZIP64" — a valid archive failing its own
// audit. Stopping one short keeps the writer and the reader from disagreeing.
const MAX_ENTRIES = 0xfffe;
const MAX_U32 = 0xffffffff;

/**
 * Ceilings for the audit path, which by definition runs on archives from
 * elsewhere. `inflateRawSync` allocates the whole output up front, so an entry
 * claiming 40 bytes compressed and 4 GiB expanded exhausts memory long before
 * any size check downstream could report the mismatch.
 */
export const AUDIT_LIMITS = Object.freeze({
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxCompressionRatio: 2000,
});

/**
 * Normalise an entry name into the only shape this writer emits.
 *
 * Rejects — rather than sanitises — anything unsafe. A writer that quietly
 * "fixed" `../../etc/passwd` into `etc/passwd` would hide the fact that
 * something upstream produced a traversal path; the gate wants to hear about
 * it. Sanitising is the caller's decision, never the codec's.
 */
export function normalizeZipEntryName(name) {
  const raw = String(name);
  if (raw.length === 0) throw new Error('zip entry name is empty');
  if (raw.includes('\0')) throw new Error(`zip entry name contains NUL: ${JSON.stringify(raw)}`);

  const slashed = raw.replace(/\\/g, '/');
  if (slashed.startsWith('/')) throw new Error(`zip entry name is absolute: ${raw}`);
  if (/^[A-Za-z]:/.test(slashed)) throw new Error(`zip entry name carries a drive letter: ${raw}`);
  if (slashed.endsWith('/')) throw new Error(`zip entry name is a directory: ${raw}`);

  const segments = slashed.split('/');
  if (segments.some((s) => s === '..')) throw new Error(`zip entry name escapes the archive root: ${raw}`);
  if (segments.some((s) => s === '' || s === '.')) throw new Error(`zip entry name has an empty or "." segment: ${raw}`);

  return slashed;
}

/**
 * Deflate `data` and pick the method deterministically.
 *
 * STORE wins ties: when deflate does not strictly shrink the entry, storing it
 * is both smaller (no deflate framing) and independent of the zlib version.
 */
function compressEntry(data, mode) {
  if (mode === 'store') return { method: METHOD_STORE, body: data };
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  if (deflated.length < data.length) return { method: METHOD_DEFLATE, body: deflated };
  return { method: METHOD_STORE, body: data };
}

/**
 * Build a ZIP archive whose bytes depend only on the entry names and contents.
 *
 * @param {Array<{path: string, content: Buffer|Uint8Array|string}>} entries
 * @param {{compression?: 'deflate'|'store'}} [options]
 * @returns {Buffer}
 */
export function createDeterministicZip(entries, options = {}) {
  const mode = options.compression === 'store' ? 'store' : 'deflate';

  const normalised = entries.map((e) => ({
    name: normalizeZipEntryName(e.path),
    data: Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? ''),
  }));

  // Byte-order sort on the encoded name. `Array#sort` with the default
  // comparator sorts by UTF-16 code unit, which differs from UTF-8 byte order
  // for astral characters — and locale-aware comparison would differ per
  // machine, which is precisely the class of drift this module removes.
  const encoded = normalised.map((e) => ({ ...e, nameBuf: Buffer.from(e.name, 'utf8') }));
  encoded.sort((a, b) => Buffer.compare(a.nameBuf, b.nameBuf));

  for (let i = 1; i < encoded.length; i++) {
    if (encoded[i].nameBuf.equals(encoded[i - 1].nameBuf)) {
      throw new Error(`duplicate zip entry name: ${encoded[i].name}`);
    }
  }
  if (encoded.length > MAX_ENTRIES) {
    throw new Error(`archive would hold ${encoded.length} entries — ZIP64 is not implemented (limit ${MAX_ENTRIES})`);
  }

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of encoded) {
    const { method, body } = compressEntry(entry.data, mode);
    const crc = zlib.crc32(entry.data) >>> 0;

    if (entry.data.length > MAX_U32 || body.length > MAX_U32 || offset > MAX_U32) {
      throw new Error(`entry ${entry.name} crosses the 4 GiB ZIP64 boundary — not implemented`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_EPOCH_TIME, 10);
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length — always zero
    localChunks.push(local, entry.nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4); // low byte 20, high byte 0 = MS-DOS host
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_EPOCH_TIME, 12);
    central.writeUInt16LE(DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes — no mode, no FAT bits
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, entry.nameBuf);

    offset += local.length + entry.nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  if (centralBuf.length > MAX_U32 || offset > MAX_U32) {
    throw new Error('central directory crosses the 4 GiB ZIP64 boundary — not implemented');
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(encoded.length, 8);
  eocd.writeUInt16LE(encoded.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // archive comment length

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

/**
 * Locate and parse the End Of Central Directory record.
 *
 * The EOCD sits at the tail but may be followed by a comment of up to 64 KiB,
 * so the signature is searched backwards over the last 64 KiB + 22 bytes.
 */
function findEocd(buf) {
  const maxBack = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      const commentLength = buf.readUInt16LE(i + 20);
      // A stray 4-byte match inside compressed data is possible; the comment
      // length must account for exactly the remaining bytes for it to be real.
      if (i + 22 + commentLength === buf.length) return i;
    }
  }
  return -1;
}

/**
 * Read an archive's central directory WITHOUT writing anything to disk.
 *
 * This is the "audit without extraction" primitive: the dangerous part of
 * consuming an untrusted archive is unpacking it (zip-slip, symlink escapes,
 * device names), so every check the gate performs must be answerable from the
 * directory alone. Entry bodies are inflated in memory only when the caller
 * asks for hashes.
 *
 * @returns {{entries: Array<{name, method, crc32, compressedSize, size,
 *   localOffset, externalAttributes, versionMadeBy, hostSystem, flags,
 *   dosDate, dosTime, unixMode, isSymlink, isDirectory, extraFieldLength}>,
 *   comment: Buffer, zip64: boolean}}
 */
export function readZipDirectory(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new Error('not a ZIP archive: shorter than an EOCD record');

  const eocdOffset = findEocd(buf);
  if (eocdOffset < 0) throw new Error('not a ZIP archive: no End Of Central Directory record found');

  const thisDisk = buf.readUInt16LE(eocdOffset + 4);
  const cdDisk = buf.readUInt16LE(eocdOffset + 6);
  let countThisDisk = buf.readUInt16LE(eocdOffset + 8);
  let count = buf.readUInt16LE(eocdOffset + 10);
  let centralSize = buf.readUInt32LE(eocdOffset + 12);
  let centralOffset = buf.readUInt32LE(eocdOffset + 16);
  const commentLength = buf.readUInt16LE(eocdOffset + 20);
  const comment = buf.subarray(eocdOffset + 22, eocdOffset + 22 + commentLength);

  // A ZIP64 archive parks 0xffff / 0xffffffff sentinels in the classic EOCD.
  // We do not write ZIP64, but we must READ one well enough to say so rather
  // than reporting a bogus 65535-entry directory. `zip64` is set only when the
  // ZIP64 EOCD record is actually FOUND — a sentinel with no record behind it
  // is a corrupt archive, not a ZIP64 one, and must not be reported as merely
  // "an archive this gate did not produce".
  let zip64 = false;
  if (count === 0xffff || centralSize === MAX_U32 || centralOffset === MAX_U32) {
    let found = false;
    for (let i = eocdOffset - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === SIG_ZIP64_EOCD) {
        count = Number(buf.readBigUInt64LE(i + 32));
        countThisDisk = Number(buf.readBigUInt64LE(i + 24));
        centralSize = Number(buf.readBigUInt64LE(i + 40));
        centralOffset = Number(buf.readBigUInt64LE(i + 48));
        found = true;
        zip64 = true;
        break;
      }
    }
    if (!found) throw new Error('corrupt ZIP: EOCD carries a ZIP64 sentinel but no ZIP64 EOCD record follows');
  }

  // Multi-disk archives are refused rather than partially parsed: every offset
  // in this reader assumes a single contiguous file.
  if (thisDisk !== 0 || cdDisk !== 0) {
    throw new Error(`corrupt ZIP: multi-disk archive (disk ${thisDisk}, central directory on disk ${cdDisk})`);
  }
  // The two counts are independent fields, and an attacker only needs the one
  // this reader loops on. Requiring agreement removes that degree of freedom.
  if (countThisDisk !== count) {
    throw new Error(`corrupt ZIP: EOCD entry counts disagree (${countThisDisk} on this disk vs ${count} total)`);
  }
  if (centralOffset + centralSize > buf.length) {
    throw new Error('corrupt ZIP: central directory extends past the end of the file');
  }
  // The central directory must end exactly where the EOCD says it does, and —
  // for an archive shaped like ours — exactly where the EOCD begins. Without
  // this, lowering the EOCD count by one leaves a fully-formed central record
  // physically present and simply invisible to the loop below: the smuggled
  // entry keeps its local header, extractors that scan for records still see
  // it, and the auditor reports a clean archive.
  const centralEnd = centralOffset + centralSize;
  // ...and, for a single-part archive, exactly where the EOCD begins. Round 1
  // added the "lands on centralEnd" rule and this comment claimed both halves;
  // only the first was coded. The gap was not academic: instead of EDITING the
  // EOCD count, an attacker APPENDS a fresh 22-byte EOCD with a lower count
  // AND a correspondingly shorter centralSize. Every other invariant then
  // holds — the counts agree, the parse lands exactly on centralEnd, no
  // duplicates, no sentinel — while a fully-formed central record for the
  // smuggled entry sits between centralEnd and the new EOCD. The auditor
  // reported OK and `unzip` wrote the extra file.
  if (!zip64 && centralEnd !== eocdOffset) {
    throw new Error(
      `corrupt ZIP: ${eocdOffset - centralEnd} byte(s) between the end of the central directory and the EOCD `
      + '— an entry is present in the file but excluded from the directory',
    );
  }

  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > centralEnd) throw new Error('corrupt ZIP: central directory record runs past the declared directory size');
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`corrupt ZIP: expected a central directory header at offset ${p}`);
    }
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const dosTime = buf.readUInt16LE(p + 12);
    const dosDate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16) >>> 0;
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const externalAttributes = buf.readUInt32LE(p + 38) >>> 0;
    const localOffset = buf.readUInt32LE(p + 42);

    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    // Names are decoded as UTF-8 whether or not bit 11 is set: a name that is
    // not valid UTF-8 must still be *seen* by the auditor, mojibake and all,
    // rather than throwing and leaving the entry unexamined.
    const name = nameBuf.toString('utf8');

    const hostSystem = versionMadeBy >> 8;
    const unixMode = hostSystem === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    // S_IFLNK = 0xA000 in the top four bits of the unix mode.
    const isSymlink = hostSystem === 3 && (unixMode & 0xf000) === 0xa000;
    const isDirectory = name.endsWith('/') || (hostSystem === 3 && (unixMode & 0xf000) === 0x4000);

    entries.push({
      name,
      nameIsUtf8Flagged: (flags & FLAG_UTF8) !== 0,
      method,
      crc32: crc,
      compressedSize,
      size,
      localOffset,
      externalAttributes,
      versionMadeBy,
      hostSystem,
      flags,
      dosDate,
      dosTime,
      unixMode,
      isSymlink,
      isDirectory,
      extraFieldLength: extraLen,
    });

    p += 46 + nameLen + extraLen + cmtLen;
  }

  // Anything left between the last parsed record and the declared end of the
  // directory is a record the EOCD count hid from us.
  if (p !== centralEnd) {
    throw new Error(
      `corrupt ZIP: central directory has ${centralEnd - p} unparsed byte(s) after ${count} records `
      + '— the EOCD entry count does not match the records present',
    );
  }

  // Two entries with the same name: extractors disagree on whether the first
  // or the last wins, so an archive can carry a hostile copy and a clean copy
  // and satisfy a checksum list with whichever one the auditor happened to
  // keep. Refuse the ambiguity outright.
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.name)) {
      throw new Error(`corrupt ZIP: duplicate entry name "${e.name}" — extractors disagree on which one wins`);
    }
    seen.add(e.name);
  }

  // The LOCAL-header region must contain exactly the declared entries and
  // nothing else.
  //
  // Two earlier rounds each closed a way of hiding a record that IS in the
  // central directory (lowering the EOCD count; appending a fresh EOCD).
  // Neither checked the converse, and every other check in this module
  // iterates the central directory — so a complete local record (header, name,
  // body) spliced in before `centralOffset`, with the EOCD's offset bumped by
  // four bytes to cover it, was invisible to all of them. A streaming reader
  // extracts it: verified with `stream-unzip`, which wrote a file that appears
  // in no listing, no checksum and no scan — traversal name included, so even
  // the unsuppressable `path-traversal` category never fired.
  //
  // Tiling is the only property that catches it: the declared entries must
  // cover [0, centralOffset) contiguously, with no gap and no overlap.
  if (!zip64 && entries.length) {
    const ordered = [...entries].sort((a, b) => a.localOffset - b.localOffset);
    let cursor = 0;
    for (const e of ordered) {
      if (e.localOffset !== cursor) {
        throw new Error(
          `corrupt ZIP: ${e.localOffset - cursor} unaccounted byte(s) before the local header of "${e.name}" `
          + '— the file contains a record the central directory does not declare',
        );
      }
      const nameLen = buf.readUInt16LE(e.localOffset + 26);
      const extraLen = buf.readUInt16LE(e.localOffset + 28);
      cursor = e.localOffset + 30 + nameLen + extraLen + e.compressedSize;
      // A data descriptor (GP flag bit 3) trails the body: 12 or 16 bytes,
      // optionally preceded by the 0x08074b50 signature. Skip whichever form
      // is present rather than declaring a gap.
      if (e.flags & 0x0008) {
        if (cursor + 4 <= buf.length && buf.readUInt32LE(cursor) === 0x08074b50) cursor += 4;
        cursor += 12;
      }
      if (cursor > buf.length) {
        throw new Error(`corrupt ZIP: the body of "${e.name}" runs past the end of the file`);
      }
    }
    if (cursor !== centralOffset) {
      throw new Error(
        `corrupt ZIP: ${centralOffset - cursor} byte(s) between the last entry body and the central directory `
        + '— the file contains a record the central directory does not declare',
      );
    }
  }

  return { entries, comment, zip64 };
}

/**
 * Inflate one entry into memory. Nothing is written to disk — the point of the
 * audit path is to answer questions about an archive that must never be
 * unpacked (its names may be hostile).
 */
/**
 * Compare an entry's LOCAL file header against its central-directory record.
 *
 * This exists because the two are independent copies of the same metadata, and
 * consumers disagree about which one they believe. Every listing tool
 * (`unzip -l`, `7z l`, Python's `zipfile`, .NET's `ZipFile`) reads the central
 * directory; every STREAMING reader (Java's `ZipInputStream`, node's
 * `unzipper.Parse()`, libarchive fed from a pipe) reads local headers and
 * never sees the central one at all.
 *
 * So an archive whose central record says `server/abc.mjs` while its local
 * header says `../../evil.mjs` audits perfectly — CRC, sizes, checksums and
 * the manifest chain all key off the central name — and escapes the extraction
 * root on any streaming consumer. Verified: a 14-byte patch was enough.
 *
 * Returns an array of mismatch descriptions; empty means the two agree.
 */
export function compareLocalHeader(buffer, entry) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const o = entry.localOffset;
  const problems = [];
  if (o + 30 > buf.length) return { problems: ['local header runs past EOF'], unsupported: [] };
  if (buf.readUInt32LE(o) !== SIG_LOCAL) return { problems: [`no local file header at offset ${o}`], unsupported: [] };

  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  if (o + 30 + nameLen > buf.length) return { problems: ['local header name runs past EOF'], unsupported: [] };

  const localName = buf.subarray(o + 30, o + 30 + nameLen).toString('utf8');
  if (localName !== entry.name) {
    problems.push(`local header names it ${JSON.stringify(localName)}, the central directory says ${JSON.stringify(entry.name)}`);
  }
  const localFlags = buf.readUInt16LE(o + 6);
  const localMethod = buf.readUInt16LE(o + 8);
  const localCrc = buf.readUInt32LE(o + 14) >>> 0;
  const localCompressed = buf.readUInt32LE(o + 18);
  const localSize = buf.readUInt32LE(o + 22);

  if (localMethod !== entry.method) problems.push(`method ${localMethod} locally vs ${entry.method} centrally`);

  // The two headers are the same metadata written twice, so ANY field that
  // disagrees is a place where two consumers see different things. Round 2
  // compared name, method, CRC and sizes; flags and the timestamp were left
  // out, and a divergence in either stayed completely invisible — including a
  // local mtime that differs from the normalised central one, which is exactly
  // the reproducibility claim the archive is supposed to carry.
  if (localFlags !== entry.flags) {
    problems.push(`general-purpose flags 0x${localFlags.toString(16)} locally vs 0x${entry.flags.toString(16)} centrally`);
  }
  const localTime = buf.readUInt16LE(o + 10);
  const localDate = buf.readUInt16LE(o + 12);
  if (localTime !== entry.dosTime || localDate !== entry.dosDate) {
    problems.push(`timestamp ${localDate.toString(16)}/${localTime.toString(16)} locally vs `
      + `${entry.dosDate.toString(16)}/${entry.dosTime.toString(16)} centrally`);
  }

  // Bit 3 moves crc/sizes into a trailing data descriptor, leaving zeros in the
  // local header. That is what every STREAMING producer emits — Java's
  // ZipOutputStream and `jar`, Python writing to a pipe, `archiver` — and such
  // an archive is perfectly valid. Reporting it as a header disagreement made
  // the auditor unable to examine an entire class of legitimate archives while
  // describing them as tampered. It is a FORMAT limitation of this reader, not
  // evidence of an attack, and the caller is told which it is.
  if (localFlags & 0x0008) {
    return { problems, unsupported: ['data-descriptor: sizes and CRC live after the body, which this reader does not parse'] };
  }
  // A ZIP64 member legally parks 0xffffffff in the 32-bit size fields and puts
  // the real values in a zip64 extra field (header ID 0x0001), which this
  // reader does not parse. Reporting the sentinel as a size disagreement told
  // an operator that a perfectly ordinary archive — any archive with a member
  // over 4 GiB, and whatever a writer emits eagerly — had been tampered with.
  // Unsupported is not the same accusation as altered.
  const MAX_U32_SENTINEL = 0xffffffff;
  if (localCompressed === MAX_U32_SENTINEL || localSize === MAX_U32_SENTINEL
      || entry.compressedSize === MAX_U32_SENTINEL || entry.size === MAX_U32_SENTINEL) {
    return { problems, unsupported: ['zip64 member: the real sizes live in a zip64 extra field, which this reader does not parse'], extraField: null };
  }

  if (localCrc !== entry.crc32) problems.push(`CRC 0x${localCrc.toString(16)} locally vs 0x${entry.crc32.toString(16)} centrally`);
  if (localCompressed !== entry.compressedSize) problems.push(`compressed size ${localCompressed} locally vs ${entry.compressedSize} centrally`);
  if (localSize !== entry.size) problems.push(`uncompressed size ${localSize} locally vs ${entry.size} centrally`);

  // A local-only extra field is explicitly legal (APPNOTE 4.3.12) — `zipalign`
  // and several jar tools emit exactly that, and it cannot mislead anyone: the
  // body is framed by the local lengths, which is what a streaming reader uses
  // anyway. Round 1 flagged it, which rejected archives Python reads happily.
  //
  // But its BYTES are arbitrary and are carried into every copy of the
  // archive, so they are handed back for scanning: a credential parked in an
  // extra field was present in the file and read by nothing.
  return {
    problems,
    unsupported: [],
    extraField: extraLen ? Buffer.from(buf.subarray(o + 30 + nameLen, o + 30 + nameLen + extraLen)) : null,
  };
}

/**
 * Back-compatible shape: callers that only want the mismatch list.
 * Returns `[]` for an archive this reader merely cannot parse (see above), so
 * "unsupported" is never silently reported as "tampered".
 */
export function compareLocalHeaderProblems(buffer, entry) {
  const r = compareLocalHeader(buffer, entry);
  return Array.isArray(r) ? r : r.problems;
}

/**
 * Inflate one entry into memory. Nothing is written to disk — the point of the
 * audit path is to answer questions about an archive that must never be
 * unpacked (its names may be hostile).
 *
 * The local header is verified against the central record FIRST: framing the
 * body with local lengths while trusting central metadata is precisely the
 * disagreement an attacker exploits.
 */
export function readZipEntryContent(buffer, entry, options = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const limits = { ...AUDIT_LIMITS, ...(options.limits || {}) };
  const o = entry.localOffset;
  if (o + 30 > buf.length) throw new Error(`corrupt ZIP: local header of ${entry.name} runs past EOF`);
  if (buf.readUInt32LE(o) !== SIG_LOCAL) {
    throw new Error(`corrupt ZIP: no local file header for ${entry.name} at offset ${o}`);
  }
  if (options.verifyLocalHeader !== false) {
    const { problems: mismatches, unsupported } = compareLocalHeader(buf, entry);
    if (mismatches.length) {
      throw new Error(`corrupt ZIP: local/central header disagreement for ${entry.name}: ${mismatches.join('; ')}`);
    }
    if (unsupported.length) {
      const err = new Error(`unsupported ZIP feature in ${entry.name}: ${unsupported.join('; ')}`);
      err.unsupportedFormat = true;
      throw err;
    }
  }

  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const start = o + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error(`corrupt ZIP: body of ${entry.name} runs past EOF`);

  // Bounded BEFORE inflating: `inflateRawSync` allocates the declared output in
  // one go, so a 40-byte entry claiming gigabytes takes the process down long
  // before any post-hoc size comparison could report it.
  if (entry.size > limits.maxEntryBytes) {
    throw new Error(`refusing to inflate ${entry.name}: declares ${entry.size} bytes, over the ${limits.maxEntryBytes}-byte audit ceiling`);
  }
  if (entry.compressedSize > 0 && entry.size / entry.compressedSize > limits.maxCompressionRatio) {
    throw new Error(`refusing to inflate ${entry.name}: compression ratio ${Math.round(entry.size / entry.compressedSize)}:1 exceeds ${limits.maxCompressionRatio}:1`);
  }

  const body = buf.subarray(start, end);
  if (entry.method === METHOD_STORE) return Buffer.from(body);
  if (entry.method === METHOD_DEFLATE) {
    return zlib.inflateRawSync(body, { maxOutputLength: Math.min(limits.maxEntryBytes, entry.size + 1) });
  }
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}
