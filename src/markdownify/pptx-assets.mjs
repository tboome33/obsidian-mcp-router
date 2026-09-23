/**
 * pptx-assets — pull the EMBEDDED IMAGES out of a .pptx, with the PRESENTATION
 * POSITION of the slide each one belongs to.
 *
 * ── Why this exists beside pptx_to_markdown ──────────────────────────────
 *
 * `pptx_to_markdown` goes through markitdown and reads a deck NATIVELY:
 * headings, tables and speaker notes all survive. What it cannot hand you is
 * the image BYTES, and what it emits instead is actively misleading. Measured
 * on a two-slide fixture (red PNG on slide 1; blue PNG plus the red one again
 * on slide 2):
 *
 *     ![red.png](Picture2.jpg)      <- slide 1
 *     ![blue.png](Picture2.jpg)     <- slide 2, SAME target as the red one
 *     ![red.png](Picture3.jpg)
 *
 * The targets name no file that exists, two different pictures share one
 * target because the name is a per-slide shape index and not an identity, and
 * the extension is invented (both files are PNG). So the split is deliberate:
 *
 *   pptx_to_markdown      text, tables, notes  ->  markdown string
 *   pptx_extract_assets   image bytes + slide  ->  files on disk + manifest
 *
 * ── Why no new dependency ────────────────────────────────────────────────
 *
 * A .pptx IS a zip, and this repository already ships a zip reader with
 * zip-bomb bounds: `src/helpers/deterministic-zip.mjs`, written for the
 * export gate. It was verified against a PowerPoint-produced archive (72
 * entries, STORE and DEFLATE both present) with local-header verification
 * left ON. Reusing it adds no dependency for the zip itself.
 *
 * ── POSITION, not file number (review finding, measured) ─────────────────
 *
 * `ppt/slides/slide3.xml` is the third slide FILE, not the third slide SHOWN.
 * Reorder a deck and the two diverge. Measured on a three-slide fixture whose
 * slides were reordered to C, A, B: markitdown numbers them 1=C, 2=A, 3=B,
 * while the files stay slide1=A, slide2=B, slide3=C. A manifest keyed on the
 * file number therefore tells an ingestion skill to place A's picture under
 * C's heading — the wrong image on the wrong slide, silently.
 *
 * So the order comes from `p:sldIdLst` in `ppt/presentation.xml` resolved
 * through `ppt/_rels/presentation.xml.rels`, which is what the format itself
 * calls the running order. The file number is used only as a fallback when a
 * deck has no readable presentation part, and the result says which of the
 * two it used via `orderSource`.
 *
 * ── Why the archive's own names never reach the filesystem ───────────────
 *
 * Entry names inside a zip are attacker-controlled. Every output name here is
 * CONSTRUCTED — `slide<pos>-<i>.<ext>` — and the extension comes from a fixed
 * allowlist keyed on the file's own magic bytes, not from the name. The
 * archive supplies bytes; it never supplies a path.
 *
 * ── Known gaps, stated rather than hidden ────────────────────────────────
 *
 * An image that lives only in a slide LAYOUT or MASTER (a logo repeated on
 * every slide) is not a slide relationship and is not extracted.
 *
 * ── The output directory is PINNED, not merely checked ───────────────────
 *
 * The first version judged the output directory by path and wrote by path:
 * a second local process swapping that directory, one of its ancestors or an
 * output name for a link between the check and the write redirected the
 * write (review rounds 1 and 3, four P1 findings). It was declared rather
 * than fixed, then fixed on Roland's decision (2026-09-23): the directory is
 * pinned before the first write and authorised on its REAL path, and every
 * file is placed through a temporary, never by opening the destination name
 * — `helpers/pinned-output-dir.mjs`, shared with `download_page_assets`.
 * Closed on Windows and Linux; on macOS and the BSDs, where Node exposes no
 * way to pin a directory, the directory swap stays open (a link at an output
 * NAME is refused everywhere). That module's header has the measurements.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { readZipDirectory, readZipEntryContent } from '../helpers/deterministic-zip.mjs';
import { openPinnedOutputDir } from '../helpers/pinned-output-dir.mjs';
import { expandHome, assertPathAllowed } from './utils.mjs';

/* ---------------------------------------------------------------------- *
 * Caps. Nothing here is returned inline, only paths, so these bound DISK,
 * MEMORY and wall-clock rather than token cost. The zip reader's own
 * AUDIT_LIMITS bound a single entry; these bound the batch, and the batch is
 * where a crafted deck does its damage.
 * ---------------------------------------------------------------------- */
export const MAX_ASSETS_DEFAULT = 200;
export const MAX_TOTAL_BYTES_DEFAULT = 256 * 1024 * 1024;

// The whole .pptx is read into memory before the zip directory can be parsed
// (the reader takes a buffer). Without a ceiling, naming a huge file is an
// out-of-memory primitive that no later cap can undo, because the allocation
// already happened. Checked with statSync BEFORE the read.
export const MAX_SOURCE_BYTES = 512 * 1024 * 1024;

// The .rels scan inflates one member per slide. A deck claiming thousands of
// slides would inflate thousands of members before a single image is even
// considered, so the scan needs its own bound.
export const MAX_RELS_MEMBERS = 2000;

// Bytes the run may INFLATE — XML parts, failed attempts and duplicates
// included. A fixed bound on inflated bytes (not on peak memory), deliberately
// NOT derived from `max_total_bytes`: that
// one limits what is WRITTEN, and tying the two made a small write cap forbid
// even READING an image already on disk (a createOnly re-run that needs no
// write at all) and made output names depend on the caller's cap (Codex,
// round 3). Twice the default write cap: room for every picture stored twice.
export const MAX_INFLATE_BYTES = 2 * MAX_TOTAL_BYTES_DEFAULT;

// The XML parts read along the way (presentation, its rels, each slide's rels)
// are small in every real deck. The zip reader's own ceiling is 512 MiB per
// entry, which multiplied by MAX_RELS_MEMBERS is no bound at all; this one is.
export const MAX_XML_PART_BYTES = 16 * 1024 * 1024;
const XML_PART_LIMITS = Object.freeze({ limits: { maxEntryBytes: MAX_XML_PART_BYTES } });

/**
 * Extension is decided by MAGIC BYTES, never by the name in the archive.
 * A deck that calls a file `.png` while shipping an EMF is common (Office
 * rewrites pasted vectors), and writing those bytes under `.png` produces a
 * file no viewer opens. Anything unrecognised is skipped with a reason
 * rather than written under a guessed extension.
 */
const MAGIC = [
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'bmp', bytes: [0x42, 0x4d] },
  { ext: 'tif', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { ext: 'tif', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { ext: 'wmf', bytes: [0xd7, 0xcd, 0xc6, 0x9a] },
];

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

export function sniffExtension(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return null;
  for (const { ext, bytes } of MAGIC) if (startsWith(buf, bytes)) return ext;

  // EMF needs two checks, not one. Its record header starts with the 32-bit
  // little-endian 1 (`01 00 00 00`), which is far too common a prefix to
  // identify anything on its own — a review found it claiming `emf` for
  // `01 00 00 00 41 42`. A real EMF also carries the signature ' EMF' at
  // offset 40, so both must hold.
  if (buf.length >= 44 && startsWith(buf, [0x01, 0x00, 0x00, 0x00])
      && buf.readUInt32LE(40) === 0x464d4520) return 'emf';

  // WEBP and SVG are not identified by their first four bytes alone.
  if (buf.length >= 12
      && buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const head = buf.subarray(0, 512).toString('latin1').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

/**
 * Slide number out of `ppt/slides/_rels/slide12.xml.rels`. Returns null for
 * anything that is not a numbered slide rels file — notesSlide and
 * slideLayout rels live in sibling directories and must not be mistaken for
 * slides, or a layout logo would be attributed to a slide that never showed
 * it.
 *
 * This is a FILE number. See `slidePositions` for the running order.
 */
export function slideNumberFromRelsName(name) {
  // A positive integer of at most six digits. `\d+` accepted four hundred
  // nines, which `Number` turns into Infinity — a file named
  // `slideInfinity-1.png` and a `null` slide in the JSON manifest (Codex,
  // round 1). No real deck numbers a slide file past 999999.
  const m = /^ppt\/slides\/_rels\/slide([1-9]\d{0,5})\.xml\.rels$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * The five predefined XML entities and numeric character references, decoded
 * in ONE pass over the original text. Chained replacements decoded their own
 * output: `&#38;amp;` became `&amp;` and then `&` (Codex, round 6), where an
 * XML parser stops at `&amp;`. A reference to a code point that does not
 * exist is malformed and throws, like any other malformed markup here.
 */
const PREDEFINED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
export function decodeXmlText(s) {
  // Any `&` that does not open one of these references is malformed — an
  // entity only a DTD could declare, which a package part may not have.
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);|&/g, (_, ref) => {
    if (ref === undefined) throw new Error('malformed XML: a bare & or an undeclared entity reference');
    if (ref[0] !== '#') return PREDEFINED_ENTITIES[ref];
    const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff) throw new Error(`malformed XML: character reference &${ref};`);
    return String.fromCodePoint(cp);
  });
}

/**
 * An attribute value as an XML parser delivers it: line ends normalised
 * (CRLF and lone CR to LF), then every literal tab or line feed to a space,
 * THEN references decoded — so `&#9;` stays a tab while a literal tab does
 * not (XML 1.0 §3.3.3; Codex, round 7).
 */
function normaliseAttributeValue(raw) {
  return decodeXmlText(raw.replace(/\r\n?/g, '\n').replace(/[\t\n]/g, ' '));
}

/**
 * The text of an XML part. OPC allows UTF-8 and UTF-16 (either byte order);
 * reading every part as UTF-8 turned a UTF-16 relationships part into text
 * with a NUL between every character, where no tag matched and every picture
 * of the slide vanished without a word (Codex, round 6). A byte-order mark
 * decides; without one, the first character — `<` or whitespace — encoded on
 * two bytes does. Decoding is STRICT: invalid UTF-8, or UTF-16 with an odd
 * byte count, throws instead of yielding replacement characters or dropping
 * a byte (Codex, round 7) — and a text with no root element at all is refused
 * by the tokenizer, so a mis-decoded part cannot pass as an empty one.
 */
export function decodeXmlBytes(buf) {
  if (typeof buf === 'string') return buf;
  const b = Buffer.from(buf);
  const decode = (label, bytes) => {
    if (label !== 'utf-8' && bytes.length % 2 !== 0) throw new Error('malformed XML: UTF-16 text with an odd byte count');
    try { return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error(`malformed XML: not valid ${label}`); }
  };
  const ws = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
  if (b[0] === 0xff && b[1] === 0xfe) return decode('utf-16le', b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return decode('utf-16be', b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return decode('utf-8', b.subarray(3));
  if (b.length >= 2 && b[1] === 0x00 && (b[0] === 0x3c || ws(b[0]))) return decode('utf-16le', b);
  if (b.length >= 2 && b[0] === 0x00 && (b[1] === 0x3c || ws(b[1]))) return decode('utf-16be', b);
  return decode('utf-8', b);
}

/** `p:sldId` -> `sldId`. */
function localName(name) {
  const colon = name.lastIndexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

const isXmlSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * A FORWARD tokenizer for the three small parts this module reads: yields
 * `{ type: 'start', name, attrs, selfClosing }` and `{ type: 'end', name }`
 * in document order, skipping text, comments, processing instructions and
 * CDATA sections as the constructs they are.
 *
 * Why it replaced the regexes. Six review rounds found six ways a regex over
 * raw XML read something no XML parser reads: a relationship inside a
 * comment, a fake slide list inside a processing instruction or CDATA, one
 * construct's opener inside another, an `r:id` inside another attribute's
 * value, a `>` inside a value cutting a tag short, a Unicode prefix stopping
 * the attribute scan — and a slide list with no closing tag rescanned from
 * every opener, in quadratic time. Every character is visited a bounded
 * number of times here, and a quoted value is consumed whole.
 *
 * It is not a full validating parser. It checks what the two consumers rely
 * on, and THROWS — a reported loss, never a silent one — on anything else it
 * would otherwise have to guess about:
 *   - an unterminated comment, PI, CDATA section, tag or attribute value;
 *   - any `<!` declaration: a DOCTYPE could declare entities, and OPC forbids
 *     DTDs in a package part (ECMA-376 Part 2, §8.1.4);
 *   - an attribute without `=` and a quoted value, a duplicate attribute, a
 *     literal `<` in a value, an undeclared entity reference;
 *   - an end tag that does not close the element that is open (with the same
 *     name), an end tag with nothing open, a second root element, an element
 *     still open at the end, and a part with no root element at all.
 * The last group is what keeps element DEPTH trustworthy: an unmatched
 * `</bogus>` used to pop an ancestor, and a nested list then passed for the
 * root's own (Codex, round 7). Each event carries `depth` (0 = the root).
 * The generator must be consumed to the end: the end-of-document checks run
 * there, and a consumer that stops early skips them.
 */
function* xmlTags(text) {
  const n = text.length;
  const fail = (what, at) => { throw new Error(`malformed XML: ${what} at offset ${at}`); };
  const upTo = (token, from, what) => {
    const e = text.indexOf(token, from);
    if (e === -1) fail(`unterminated ${what}`, from);
    return e + token.length;
  };
  const open = [];
  let rootSeen = false;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    if (text.startsWith('<!--', lt)) { i = upTo('-->', lt + 4, 'comment'); continue; }
    if (text.startsWith('<?', lt)) { i = upTo('?>', lt + 2, 'processing instruction'); continue; }
    if (text.startsWith('<![CDATA[', lt)) { i = upTo(']]>', lt + 9, 'CDATA section'); continue; }
    if (text.startsWith('<!', lt)) fail('declaration (a DTD is not allowed in a package part)', lt);
    if (text[lt + 1] === '/') {
      const e = upTo('>', lt + 2, 'end tag');
      // Trailing whitespace trimmed by a BACKWARD scan: an unanchored
      // `/\s+$/` retries from every space of a long run, which is quadratic
      // on a crafted `</a` + spaces + `x>` (Codex, round 8).
      let stop = e - 1;
      while (stop > lt + 2 && isXmlSpace(text.charCodeAt(stop - 1))) stop -= 1;
      const name = text.slice(lt + 2, stop);
      if (!name || /[\x20\t\r\n]/.test(name)) fail('malformed end tag', lt);
      if (open.length === 0) fail(`end tag </${name}> with no element open`, lt);
      if (open[open.length - 1] !== name) fail(`end tag </${name}> does not close <${open[open.length - 1]}>`, lt);
      open.pop();
      yield { type: 'end', name, depth: open.length };
      i = e;
      continue;
    }
    // A start tag: the name, then attribute tokens until `>` or `/>`.
    let j = lt + 1;
    while (j < n && !isXmlSpace(text.charCodeAt(j)) && text[j] !== '>' && text[j] !== '/') j += 1;
    const name = text.slice(lt + 1, j);
    if (!name) fail('empty element name', lt);
    if (open.length === 0 && rootSeen) fail(`a second root element <${name}>`, lt);
    rootSeen = true;
    const attrs = [];
    const seen = new Set();
    let selfClosing = false;
    for (;;) {
      while (j < n && isXmlSpace(text.charCodeAt(j))) j += 1;
      if (j >= n) fail('unterminated start tag', lt);
      if (text[j] === '>') { j += 1; break; }
      if (text[j] === '/' && text[j + 1] === '>') { selfClosing = true; j += 2; break; }
      const a = j;
      while (j < n && !isXmlSpace(text.charCodeAt(j)) && text[j] !== '=' && text[j] !== '>' && text[j] !== '/') j += 1;
      const attrName = text.slice(a, j);
      if (!attrName) fail('attribute name expected', j);
      if (seen.has(attrName)) fail(`duplicate attribute ${attrName}`, a);
      seen.add(attrName);
      while (j < n && isXmlSpace(text.charCodeAt(j))) j += 1;
      if (text[j] !== '=') fail(`attribute ${attrName} without a value`, j);
      j += 1;
      while (j < n && isXmlSpace(text.charCodeAt(j))) j += 1;
      const q = text[j];
      if (q !== '"' && q !== "'") fail(`attribute ${attrName} value is not quoted`, j);
      const close = text.indexOf(q, j + 1);
      if (close === -1) fail(`unterminated value of ${attrName}`, j);
      const raw = text.slice(j + 1, close);
      if (raw.includes('<')) fail(`a literal < in the value of ${attrName}`, j);
      attrs.push([attrName, normaliseAttributeValue(raw)]);
      j = close + 1;
    }
    const depth = open.length;
    if (!selfClosing) open.push(name);
    yield { type: 'start', name, attrs, selfClosing, depth };
    i = j;
  }
  if (!rootSeen) fail('no root element', 0);
  if (open.length) fail(`<${open[open.length - 1]}> is never closed`, n);
}

function attrValue(attrs, name) {
  const hit = attrs.find(([n]) => n === name);
  return hit ? hit[1] : null;
}

/**
 * Relationship targets of type .../image out of a .rels document (a string,
 * or the part's raw bytes in either OPC encoding). Read with `xmlTags`, so a
 * relationship inside a comment is not one, both quote styles and any element
 * prefix are read, and malformed markup THROWS — the caller reports the
 * slide's pictures as lost rather than pretending the slide had none.
 *
 * Targets are percent-encoded URI references in OPC, so a media file with a
 * space or an accent in its name arrives encoded and must be decoded.
 */
export function imageTargetsFromRels(xml) {
  const out = [];
  for (const tag of relationshipTags(decodeXmlBytes(xml))) {
    if (!IMAGE_REL_TYPES.has(collapse(attrValue(tag.attrs, 'Type')))) continue;
    // An EXTERNAL relationship names a URL, not an archive member. Following
    // one would turn deck ingestion into an outbound fetch — a different
    // tool's job, and an SSRF surface this one does not want.
    if (isExternal(tag)) continue;
    const target = attrValue(tag.attrs, 'Target');
    // An image relationship with no target cannot be followed, and dropping it
    // was a silent loss (Codex, round 10): it is malformed, so it throws and
    // the caller reports the slide's relationships as unreadable.
    if (!target) throw new Error('malformed relationships part: an image relationship without a Target');
    out.push(target);
  }
  return out;
}

/**
 * The `Relationship` elements of a relationships part — the ONE reader both
 * callers use (the presentation's rels and each slide's). The part must BE a
 * relationships part: its root a `Relationships` element, the relationships
 * its direct children. A well-formed part with any other root (`<unrelated/>`)
 * used to read as "no relationships", and every picture of the slide vanished
 * with nothing said (Codex, round 11); it now throws, and the caller reports.
 */
function* relationshipTags(text) {
  let rootOk = false;
  let rootBindings = new Map();
  for (const tag of xmlTags(text)) {
    if (tag.type !== 'start') continue;
    if (tag.depth === 0) {
      rootBindings = declaredNamespaces(tag.attrs, new Map());
      // The package-relationships namespace — or none declared, tolerated as
      // PresentationML is. An element of the same name in a FOREIGN namespace
      // is not a relationships part (Codex, round 12).
      if (localName(tag.name) !== 'Relationships' || !inPackageRelNs(tag.name, rootBindings)) {
        throw new Error(`malformed relationships part: root element <${excerpt(tag.name)}>, not <Relationships>`);
      }
      rootOk = true;
    } else if (tag.depth === 1 && rootOk && localName(tag.name) === 'Relationship'
      && inPackageRelNs(tag.name, rootBindings, tag.attrs)) {
      yield tag;
    }
  }
}

const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** `bindings` extended with the `xmlns` / `xmlns:p` declarations of `attrs`. */
function declaredNamespaces(attrs, bindings) {
  const out = new Map(bindings);
  for (const [n, v] of attrs) {
    if (n === 'xmlns') out.set('', v);
    else if (n.startsWith('xmlns:')) out.set(n.slice(6), v);
  }
  return out;
}

/**
 * Is `name` in the package-relationships namespace (or in none)? Only ITS
 * prefix is resolved — on the element's own attributes first, then in the
 * root's bindings. Copying every root binding into every child made a part
 * with many declarations and many relationships O(R x C) (Codex, round 13).
 */
function inPackageRelNs(name, bindings, ownAttrs = []) {
  const colon = name.indexOf(':');
  const prefix = colon === -1 ? '' : name.slice(0, colon);
  const own = ownAttrs.find(([n]) => (prefix === '' ? n === 'xmlns' : n === `xmlns:${prefix}`));
  const uri = own ? own[1] : bindings.get(prefix);
  return uri === undefined || uri === '' || uri === PACKAGE_REL_NS;
}

/**
 * Is this relationship EXTERNAL? `TargetMode` is `Internal` (the default when
 * absent) or `External`, compared exactly after whitespace collapse. Any other
 * value is malformed and THROWS: a substring test read `NotExternal` as
 * external and dropped the relationship with nothing said (Codex, round 12).
 * The one helper both readers of relationships use.
 */
function isExternal(tag) {
  const mode = collapse(attrValue(tag.attrs, 'TargetMode'));
  if (mode === '' || mode === 'Internal') return false;
  if (mode === 'External') return true;
  throw new Error(`malformed relationships part: TargetMode "${excerpt(mode)}"`);
}

/**
 * Resolve a rels Target (`../media/image3.png`) against the slides directory
 * into an archive member name (`ppt/media/image3.png`).
 *
 * Returns null when the result escapes `ppt/` — the traversal case. A zip
 * member cannot legitimately sit above the package root, so an escape is a
 * malformed or hostile archive and is refused rather than clamped.
 */
export function resolveRelTarget(target, fromDir = 'ppt/slides') {
  let raw = String(target);
  // Bounded, so every join is bounded (Codex, round 10). Two bounds, not one:
  // the ENCODED target may be up to nine times the member-name bound, because
  // percent-encoding one three-byte UTF-8 character takes nine characters, and
  // a short non-ASCII name must not be refused for its encoding (round 11);
  // the DECODED result is held to the member-name bound below.
  if (raw.length > MAX_RAW_TARGET || String(fromDir).length > MAX_PART_NAME) return null;
  // Refuse an ABSOLUTE target before joining, not after. `path.posix.join`
  // strips a leading slash, so `/etc/passwd` would silently become
  // `ppt/slides/etc/passwd` — a rebase that looks like containment while
  // hiding the fact that the archive asked for a root path. Reject, do not
  // sanitise, exactly as normalizeZipEntryName in deterministic-zip.mjs does.
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) return null;
  raw = raw.replace(/\\/g, '/');
  // OPC part names are URI references; decode before matching a member name.
  try { raw = decodeURIComponent(raw); } catch { /* keep the raw form */ }
  const joined = path.posix.normalize(path.posix.join(fromDir, raw));
  if (joined.startsWith('..') || joined.startsWith('/')) return null;
  if (!joined.startsWith('ppt/')) return null;
  if (joined.length > MAX_PART_NAME) return null;
  return joined;
}

// The longest archive member name a slide or image may have — an APPLICATION
// limit of this tool, chosen far above the few dozen characters the producers
// we know write; a longer one is refused and reported, never guessed at.
export const MAX_PART_NAME = 1024;
export const MAX_RAW_TARGET = 9 * MAX_PART_NAME;

/**
 * The deck's RUNNING ORDER: `{ order, count }`, where `order` maps the member
 * name of each slide part to its position in `p:sldIdLst` (resolved through
 * the presentation's own rels) and `count` is the number of entries.
 *
 * When the order cannot be read, returns `{ order: null, reason }` instead,
 * so the caller falls back to file numbering and SAYS both that it did and
 * WHY: a missing part, an unreadable one and the inflation budget used to
 * look alike from outside (Codex, round 5).
 */
export function slidePositions(buf, entries, tryCharge = () => true) {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const pres = byName.get('ppt/presentation.xml');
  const rels = byName.get('ppt/_rels/presentation.xml.rels');
  if (!pres) return { order: null, reason: 'no ppt/presentation.xml in the archive' };
  if (!rels) return { order: null, reason: 'no ppt/_rels/presentation.xml.rels in the archive' };
  if (!tryCharge(pres) || !tryCharge(rels)) {
    return { order: null, reason: 'the presentation parts were not read: inflation budget reached' };
  }

  const idToTarget = new Map();
  const memberByRid = new Map();
  const order = new Map();
  const unresolved = [];
  let position = 0;
  let listFound = false;
  let rootName = null;
  try {
    const relsXml = decodeXmlBytes(readZipEntryContent(buf, rels, XML_PART_LIMITS));
    const presXml = decodeXmlBytes(readZipEntryContent(buf, pres, XML_PART_LIMITS));

    const idsSeen = new Set();
    for (const tag of relationshipTags(relsXml)) {
      // Ids are unique in a relationship set (OPC). A duplicate is ambiguous —
      // `idToTarget.set` kept the LAST one silently, filing another slide's
      // pictures under this position (Codex, round 15) — so it is refused,
      // before any filtering, and the order falls back with the reason.
      const anyId = attrValue(tag.attrs, 'Id');
      if (anyId !== null) {
        if (idsSeen.has(anyId)) throw new Error(`duplicate relationship Id "${excerpt(anyId)}" in ppt/_rels/presentation.xml.rels`);
        idsSeen.add(anyId);
      }
      // Only INTERNAL relationships of the SLIDE type: a list entry pointing
      // at a notes slide or a layout used to be taken for a slide, and its
      // pictures filed under that slide's position (Codex, round 8). Compared
      // EXACTLY, after XML Schema whitespace collapse: a suffix test accepted
      // any URI ending in `/slide` and refused the standard one followed by a
      // space (round 9).
      if (!SLIDE_REL_TYPES.has(collapse(attrValue(tag.attrs, 'Type')))) continue;
      if (isExternal(tag)) continue;
      const id = attrValue(tag.attrs, 'Id');
      const target = attrValue(tag.attrs, 'Target');
      if (id && target) idToTarget.set(id, target);
    }

    // The slide list is the PresentationML `sldIdLst` that is a CHILD OF THE
    // ROOT, and its entries are that list's own `sldId` children. Namespace
    // bindings live in ONE map, each element recording what it changed so its
    // end tag can undo it — own declarations over ancestors', as XML scoping
    // does (rounds 3 and 6), without copying every ancestor's bindings into
    // every element, which made a deep document quadratic (round 7). The whole
    // part is read to its end, so the tokenizer's end-of-document checks run.
    const ns = new Map();
    let relNsBound = 0; // prefixes currently bound to the relationships namespace
    const bind = (prefix, uri, undo) => {
      undo.push([prefix, ns.has(prefix) ? ns.get(prefix) : NOT_BOUND]);
      if (RELATIONSHIPS_NS.has(ns.get(prefix))) relNsBound -= 1;
      ns.set(prefix, uri);
      if (RELATIONSHIPS_NS.has(uri)) relNsBound += 1;
    };
    const unbind = (undo) => {
      for (let k = undo.length - 1; k >= 0; k -= 1) {
        const [prefix, prev] = undo[k];
        if (RELATIONSHIPS_NS.has(ns.get(prefix))) relNsBound -= 1;
        if (prev === NOT_BOUND) ns.delete(prefix); else ns.set(prefix, prev);
        if (RELATIONSHIPS_NS.has(prev)) relNsBound += 1;
      }
    };
    // An element is PresentationML when its prefix is bound to that namespace
    // (Transitional or Strict) — or bound to nothing, tolerated as `r` is
    // below; `xmlns=""` undeclares the default and counts as nothing (round 8).
    // A prefix bound to any OTHER namespace is a foreign element of the same
    // local name, such as an extension's own `x:sldIdLst` (round 7).
    const isPml = (name) => {
      const colon = name.indexOf(':');
      const uri = ns.get(colon === -1 ? '' : name.slice(0, colon));
      return uri === undefined || uri === '' || PRESENTATIONML_NS.has(uri);
    };
    // The relationship id: an `id` attribute whose prefix is bound to the
    // relationships namespace — or `r:id` when nothing in scope binds that
    // namespace and `r` is bound to nothing else. Never the unprefixed `id`,
    // which is the slide's own numeric id (rounds 1, 2, 3).
    const relationshipIdOf = (attrs) => {
      for (const [name, value] of attrs) {
        const colon = name.indexOf(':');
        if (colon <= 0 || name.slice(colon + 1) !== 'id') continue;
        const prefix = name.slice(0, colon);
        const uri = ns.get(prefix);
        if (RELATIONSHIPS_NS.has(uri)) return value;
        if (uri === undefined && prefix === 'r' && relNsBound === 0) return value;
      }
      return null;
    };

    const frames = [];
    for (const tag of xmlTags(presXml)) {
      if (tag.type === 'end') { unbind(frames.pop().undo); continue; }
      const undo = [];
      for (const [n, v] of tag.attrs) {
        if (n === 'xmlns') bind('', v, undo);
        else if (n.startsWith('xmlns:')) bind(n.slice(6), v, undo);
      }
      const local = localName(tag.name);
      let selectedList = false;
      // The root must be a PresentationML `presentation` — the local name
      // alone let a foreign `<x:presentation>` supply the order (round 15).
      if (tag.depth === 0) rootName = isPml(tag.name) ? local : `${local} (foreign namespace)`;
      else if (tag.depth === 1 && !listFound && local === 'sldIdLst' && isPml(tag.name)) {
        listFound = true;
        selectedList = true;
      } else if (tag.depth === 2 && frames[1]?.selectedList && local === 'sldId' && isPml(tag.name)) {
        // EVERY entry takes a position, resolvable or not. Counting only the
        // resolved ones compressed the order: one unreadable entry shifted
        // every later slide down by one, and their images were filed under
        // the wrong heading while `orderSource` still said "presentation"
        // (round 1). And an entry that does not resolve is REPORTED by the
        // caller, not merely skipped (round 7).
        position += 1;
        // Each relationship is resolved ONCE: many entries naming one
        // relationship with a long target re-resolved it per entry, O(N x L)
        // (Codex, round 9).
        const rid = relationshipIdOf(tag.attrs);
        if (rid && !memberByRid.has(rid)) {
          const target = idToTarget.get(rid);
          memberByRid.set(rid, target ? resolveRelTarget(target, 'ppt') : null);
        }
        const member = rid ? memberByRid.get(rid) : null;
        // Resolving to a PATH is not resolving to a slide: the part must be
        // in the archive, and must not already hold an earlier position —
        // `order.set` overwrote it, and the earlier slide lost its pictures
        // with nothing said (Codex, round 8). Each case is reported.
        if (!member) unresolved.push({ position, reason: 'this slide list entry resolves to no slide part' });
        else if (!byName.has(member)) unresolved.push({ position, reason: `this slide list entry names ${excerpt(member)}, which is not in the archive` });
        else if (order.has(member)) unresolved.push({ position, reason: `this slide list entry names ${excerpt(member)} again (already slide ${order.get(member)}); a part shown twice is not supported — its pictures stay listed under slide ${order.get(member)} only` });
        else order.set(member, position);
      }
      if (tag.selfClosing) unbind(undo);
      else frames.push({ undo, selectedList });
    }
  } catch (err) {
    return { order: null, reason: `the presentation parts are unreadable: ${excerpt(err.message, 300)}` };
  }
  if (rootName !== 'presentation') {
    return { order: null, reason: `ppt/presentation.xml is not a presentation (root element <${excerpt(rootName)}>)` };
  }
  if (!listFound) return { order: null, reason: 'ppt/presentation.xml has no slide list (p:sldIdLst)' };
  // `count` is every entry, trailing unresolved ones included; the map holds
  // only what resolved. A max over the map lost a trailing gap (Codex, round 2).
  return order.size > 0
    ? { order, count: position, unresolved }
    : { order: null, reason: 'no entry of the slide list resolves to a slide part' };
}

// Transitional (what PowerPoint writes) AND Strict (ISO/IEC 29500 Strict): a
// Strict deck named its namespaces differently and fell back to file numbers
// on every slide (Codex, round 8).
const RELATIONSHIPS_NS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const PRESENTATIONML_NS = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
// Relationship TYPE URIs, Transitional and Strict, matched exactly.
const SLIDE_REL_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/slide',
]);
const IMAGE_REL_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/image',
]);

/** XML Schema `collapse` for an anyURI: trim, and runs of spaces to one. */
function collapse(value) {
  return String(value ?? '').replace(/ +/g, ' ').trim();
}

/**
 * Text taken from the ARCHIVE, made safe to quote in a reason: control
 * characters shown as `\xNN`, and cut to `max` characters with a marker.
 * A reason quoted a refused target verbatim — any length, any control
 * character — and the skill repeats reasons in the vault page (round 9).
 */
export function excerpt(value, max = 120) {
  // CUT first, then escape: escaping the whole string before cutting it made
  // every call proportional to the full length, and one long member name
  // quoted once per duplicate list entry became O(N x L) (Codex, round 10).
  const s = String(value);
  const head = s.length > max ? s.slice(0, max) : s;
  const shown = head.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return s.length > max ? `${shown}... [${s.length - max} more characters]` : shown;
}
const NOT_BOUND = Symbol('not bound');

/**
 * A cap the caller supplied: absent means the default, above the ceiling is
 * clamped DOWN, and anything else invalid is REFUSED with a message.
 *
 * Refusing rather than clamping up from zero follows the precedent already
 * written down for `download_page_assets`: passing `maxAssets: 0` there used
 * to produce a silent empty-list no-op that read as "the tool is broken".
 * A first version of this function clamped `-5` to `1`, which is the same
 * trap wearing a different number — a one-byte budget that writes nothing
 * and explains nothing. Its own test caught it.
 */
function capOrThrow(value, fallback, ceiling, label) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer, got: ${value}`);
  }
  return Math.min(n, ceiling);
}

/**
 * Read a REGULAR file of at most `ceiling` bytes, through one descriptor.
 * The size is taken from `fstat` on that descriptor and exactly that many
 * bytes are read, so a file that grows afterwards cannot push the read past
 * what was measured, and a FIFO, a device or a directory is refused before a
 * single byte is read.
 */
function readRegularFileBounded(file, ceiling) {
  // Refused before `open`, too: on POSIX, opening a FIFO for reading BLOCKS
  // until a writer appears, so the fstat below would never be reached.
  // O_NONBLOCK covers the race where the path is swapped for a FIFO between
  // the two calls (it is a no-op on regular files, and absent on Windows).
  if (!fs.statSync(file).isFile()) throw new Error(`refusing to read ${file}: not a regular file`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`refusing to read ${file}: not a regular file`);
    if (st.size > ceiling) {
      throw new Error(`refusing to read ${file}: ${st.size} bytes, over the ${ceiling}-byte ceiling`);
    }
    const out = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, out, off, st.size - off, off);
      if (n === 0) break; // truncated under us: parse what was there
      off += n;
    }
    return off === st.size ? out : out.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create-only placement, the same contract as `download_page_assets`'
 * `createOnly`: the constructed name first; if it is taken by the SAME bytes,
 * that file IS the asset (`alreadyPresent`); if it is taken by different
 * bytes (a human edited the picture, or another deck's image sits there), the
 * content-hash name is tried the same way. Nothing is ever overwritten, and a
 * link at either name is never written through: `out` places every file by
 * hard link from a temporary (helpers/pinned-output-dir.mjs).
 * Returns `{ name, alreadyPresent }`, or null when both names hold other bytes.
 */
function placeCreateOnly(out, name, hashedName, bytes) {
  for (const candidate of [name, hashedName]) {
    if (out.createNoReplace(candidate, bytes) === 'created') return { name: candidate, alreadyPresent: false };
    if (out.holdsSameBytes(candidate, bytes)) return { name: candidate, alreadyPresent: true };
  }
  return null;
}

/**
 * THE reading of the `outdir` argument — absolute path, or null for "none
 * given, use a fresh temp directory". Exported because the dispatcher's
 * containment gate must judge the SAME directory this module writes to: the
 * gate once resolved `~/x` as a literal `~` under the cwd while the handler
 * expanded it to the home directory, and treated a blank string as absent
 * while the handler wrote into `<cwd>/  ` (Codex, round 2). One definition,
 * two callers.
 */
export function resolveOutDirArg(outDir) {
  if (outDir === undefined || outDir === null) return null;
  if (typeof outDir !== 'string') throw new Error(`outdir must be a string, got ${typeof outDir}`);
  if (outDir.trim() === '') return null;
  return path.resolve(expandHome(outDir));
}

export function extractPptxAssets({
  filePath,
  outDir,
  createOnly = false,
  maxAssets = MAX_ASSETS_DEFAULT,
  maxTotalBytes = MAX_TOTAL_BYTES_DEFAULT,
  // Not an MCP argument: the tool schema does not declare it. It lets a test
  // LOWER the fixed inflation bound to fixture size; it can never raise it.
  maxInflateBytes = MAX_INFLATE_BYTES,
  // Not an MCP argument either: the dispatcher's containment gate, handed in
  // so that it judges the REAL directory about to be pinned — the one the
  // files will land in — and not only the string it was given earlier.
  authorizeOutDir = null,
  // Tests only (the platform's own strategy otherwise).
  pinStrategy = undefined,
} = {}) {
  if (typeof createOnly !== 'boolean') {
    throw new Error(`createOnly must be a boolean, got ${typeof createOnly}`);
  }
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('filepath is required and must be a string');
  }
  const assetCap = capOrThrow(maxAssets, MAX_ASSETS_DEFAULT, MAX_ASSETS_DEFAULT, 'max_assets');
  const byteCap = capOrThrow(maxTotalBytes, MAX_TOTAL_BYTES_DEFAULT, MAX_TOTAL_BYTES_DEFAULT, 'max_total_bytes');
  const inflateBudget = capOrThrow(maxInflateBytes, MAX_INFLATE_BYTES, MAX_INFLATE_BYTES, 'maxInflateBytes');

  const src = path.resolve(expandHome(filePath));
  assertPathAllowed(src);

  // Bounded BEFORE the read, and read through the descriptor that was
  // measured. `statSync` then `readFileSync` measured one thing and read
  // another: a FIFO reports size 0 and then streams without end, and a regular
  // file can grow between the two calls (Codex, round 1). So: one open, a
  // regular-file check and the ceiling on THAT descriptor, then exactly the
  // measured number of bytes — never more.
  const buf = readRegularFileBounded(src, MAX_SOURCE_BYTES);

  let target = resolveOutDirArg(outDir);
  const pinOptions = {
    authorize: authorizeOutDir,
    ...(pinStrategy === undefined ? {} : { strategy: pinStrategy }),
  };
  let out;
  if (target) {
    // The read gate applies to the WRITE side too. Without this, a sandboxed
    // host that carefully limits what may be read would still hand an
    // arbitrary-write primitive to any caller that named an outdir.
    assertPathAllowed(target);
    // PINNED before the first write: from here on, a rename of the directory
    // or of an ancestor cannot move the writes elsewhere (review rounds 1 and
    // 3; helpers/pinned-output-dir.mjs says how, per platform).
    out = openPinnedOutputDir(target, pinOptions);
  } else {
    // Deliberately NOT gated by MD_ALLOWED_PATHS: this directory is created
    // by us, is not caller-controlled, and matches what every sibling
    // converter in src/tools/convert.mjs already does with os.tmpdir(). A
    // reviewer flagged it as an escape; it is a fresh mkdtemp, not a path an
    // archive or a caller can steer. Pinned and authorised like any other,
    // and CREATED through the pin: `mkdtempSync` created it by path first,
    // before any authorisation — under a swapped ancestor, somewhere else
    // (Codex, round P1). The random name is ours; the pin creates it.
    target = path.join(os.tmpdir(), `pptx-assets-${crypto.randomBytes(8).toString('hex')}`);
    out = openPinnedOutputDir(target, pinOptions);
  }
  try {
    // The manifest names the PINNED directory, not the spelling asked for:
    // through an alias the two differ, and the pinned one is where the files
    // are (Codex, round P2).
    return extractInto(out, out.path, { buf, src, createOnly, assetCap, byteCap, inflateBudget });
  } finally {
    out.close();
  }
}

function extractInto(out, target, { buf, src, createOnly, assetCap, byteCap, inflateBudget }) {
  let dir;
  try {
    dir = readZipDirectory(buf);
  } catch (err) {
    throw new Error(`not a readable PPTX (a PPTX is a ZIP package): ${excerpt(err.message, 300)}`);
  }

  // Bytes INFLATED in this run — the XML parts, every image attempt, failed
  // ones and duplicates included — against the fixed MAX_INFLATE_BYTES (see
  // there). One counter for every read: the XML parts were once outside it,
  // so 2000 slide relationship parts of 16 MiB each were not bounded by it at
  // all (Codex, round 4). Each read is charged its declared size + 1, the
  // reader's own ceiling for one attempt, BEFORE the attempt. What this bounds
  // is inflated BYTES; it is not a ceiling on the process's peak memory, which
  // also holds the source buffer and one image being compared.
  let inflatedBytes = 0;
  const tryCharge = (entry) => {
    const charge = entry.size + 1;
    if (inflatedBytes + charge > inflateBudget) return false;
    inflatedBytes += charge;
    return true;
  };
  const INFLATION_REASON = `inflation budget reached (${inflateBudget} bytes read in this run)`;

  const byName = new Map(dir.entries.map((e) => [e.name, e]));
  const running = slidePositions(buf, dir.entries, tryCharge);
  const positions = running.order ? running : null;
  const orderSource = positions ? 'presentation' : 'file-number';
  const slideParts = dir.entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
  const slideCount = positions ? positions.count : slideParts.length;

  const assets = [];
  const skipped = [];

  // A slide list entry that resolves to no slide part is a slide whose
  // pictures cannot be found — SAID, not merely left out (Codex, round 7).
  for (const { position, reason } of positions ? positions.unresolved : []) {
    skipped.push({ member: 'ppt/presentation.xml', slides: [position], reason: `${reason}: its pictures cannot be located` });
  }

  // The slides to scan, IN SLIDE ORDER, each with its own relationships part.
  // With a running order, they are the parts it names — whatever their file
  // names: a first version recognised only `slide<N>.xml`, and a deck whose
  // parts were called `intro.xml` lost every picture silently (round 7). The
  // relationships part of `<dir>/<name>` is `<dir>/_rels/<name>.rels` (OPC).
  // Without a running order, only `slide<N>.xml` parts that EXIST, by number:
  // orphan relationship parts used to count as slides and exhaust the scan
  // limit ahead of the real ones (round 4).
  const relsOf = (part) => `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels`;
  const shown = positions
    ? [...positions.order].sort((a, b) => a[1] - b[1]).map(([part, slide]) => ({ part, slide }))
    : slideParts
      .map((e) => ({ part: e.name, slide: Number(/slide(\d+)\.xml$/.exec(e.name)[1]) }))
      .filter((s) => slideNumberFromRelsName(relsOf(s.part)) !== null)
      .sort((a, b) => a.slide - b.slide);

  // member name -> set of slide POSITIONS that reference it
  const usage = new Map();
  const minSlide = new Map(); // member name -> its lowest slide position
  let relsSeen = 0;
  for (const { part, slide } of shown) {
    const entry = byName.get(relsOf(part));
    if (!entry) {
      // Every slide PowerPoint writes has a relationships part — at the very
      // least to its layout — so a slide without one is not "a slide with no
      // pictures": its pictures, if it has any, cannot be located. Said, not
      // assumed (Codex, round 14).
      skipped.push({
        member: relsOf(part),
        slides: [slide],
        reason: 'this slide has no relationships part: its pictures, if any, cannot be located',
      });
      continue;
    }
    // The stop is SAID: a silent `break` dropped every later slide's pictures
    // with nothing in `skipped` (round 3).
    if (relsSeen >= MAX_RELS_MEMBERS) {
      skipped.push({
        member: entry.name,
        slides: [slide],
        reason: `relationship scan limit reached (${MAX_RELS_MEMBERS} slides): slide ${slide} and every later slide were not scanned`,
      });
      break;
    }
    relsSeen += 1;
    if (!tryCharge(entry)) {
      skipped.push({ member: entry.name, slides: [slide], reason: `slide relationships not read: ${INFLATION_REASON}` });
      continue;
    }
    let targets;
    try {
      // Raw bytes: `imageTargetsFromRels` decodes either OPC encoding, and
      // THROWS on markup it will not guess about — inside this try, so that
      // too is a reported loss.
      targets = imageTargetsFromRels(readZipEntryContent(buf, entry, XML_PART_LIMITS));
    } catch (err) {
      // One unreadable rels member costs that slide's pictures, not the run —
      // and the loss is SAID. A silent `continue` here dropped every image of
      // the slide with no entry in `skipped`, which is the one thing this
      // tool promises never to do.
      skipped.push({ member: entry.name, slides: [slide], reason: `slide relationships unreadable: ${excerpt(err.message, 300)}` });
      continue;
    }
    // Relative to the slide part's OWN directory, which is not always
    // `ppt/slides` now that parts are taken as the running order names them —
    // computed once per slide, not once per target (Codex, round 10).
    const baseDir = path.posix.dirname(part);
    for (const t of targets) {
      const member = resolveRelTarget(t, baseDir);
      if (!member) {
        // A picture the slide references but that cannot be an archive member
        // (absolute, or outside ppt/) — refused, and SAID (Codex, round 8).
        skipped.push({ member: entry.name, slides: [slide], reason: `image target refused (absolute, outside ppt/, over ${MAX_RAW_TARGET} characters as written, or over ${MAX_PART_NAME} once resolved): ${excerpt(t)}` });
        continue;
      }
      if (!usage.has(member)) usage.set(member, new Set());
      usage.get(member).add(slide);
      // The member's FIRST slide, kept as it is collected: the sort below
      // used to recompute `Math.min(...set)` in every comparison, O(S) per
      // comparison, O(S x M log M) in all (Codex, round 16).
      if (!(minSlide.get(member) <= slide)) minSlide.set(member, slide);
    }
  }

  let totalBytes = 0;

  // Deterministic order: by first referencing slide, then by member name.
  // The CONSTRUCTED name of an image depends on the deck alone — not on the
  // caps, not on the disk — or a re-ingest would rewrite every image link
  // already in the vault. The FINAL name can still differ under createOnly,
  // deliberately: a constructed name held by other bytes falls through to the
  // content-hash name. Consume the manifest's names; never rebuild them.
  const members = [...usage.keys()].sort((a, b) => {
    const sa = minSlide.get(a);
    const sb = minSlide.get(b);
    return sa - sb || (a < b ? -1 : a > b ? 1 : 0);
  });

  const perSlideIndex = new Map();
  // digest -> the asset written for it, OR the `skipped` entry it was refused
  // under. Refused images are registered too: otherwise a later duplicate of
  // one would consume a second index, and every name after it would differ
  // from a run where the cap did not bite.
  const byDigest = new Map();
  const slideSets = new Map(); // digest -> Set of slide positions, merged across duplicates
  let cappedReason = null;
  let writtenCount = 0;

  for (const member of members) {
    const slides = [...usage.get(member)].sort((a, b) => a - b);
    const entry = byName.get(member);
    if (!entry) {
      skipped.push({ member, slides, reason: 'referenced by a slide but absent from the archive' });
      continue;
    }
    if (entry.size === 0) {
      skipped.push({ member, slides, reason: 'empty entry' });
      continue;
    }
    // Inflation budget checked on the DECLARED size, BEFORE inflating, and
    // CHARGED before the attempt — a failed inflation costs work too, and a
    // first version charged only the successful ones, so a deck of members
    // that inflate past their declared size and fail was unbounded (Codex,
    // round 2). The reader caps each attempt at `entry.size + 1` bytes, so the
    // charge covers it. Its own reason: this is not the output byte cap, and
    // the member may well have been a duplicate that would write nothing.
    if (!tryCharge(entry)) {
      skipped.push({
        member,
        slides,
        reason: `${INFLATION_REASON}: this image was not read, so not known to be a duplicate of an image already listed`,
      });
      continue;
    }

    let bytes;
    try {
      bytes = readZipEntryContent(buf, entry);
    } catch (err) {
      skipped.push({ member, slides, reason: `could not inflate: ${excerpt(err.message, 300)}` });
      continue;
    }
    const ext = sniffExtension(bytes);
    if (!ext) {
      skipped.push({ member, slides, reason: 'unrecognised image format (magic bytes matched nothing)' });
      continue;
    }

    // Deduplicate on CONTENT, not on member name. PowerPoint routinely stores
    // one picture under two members; keying on the name alone wrote the same
    // bytes twice and gave the vault two files for one image.
    //
    // BEFORE the output caps: a duplicate writes nothing, so a cap must never
    // stop it. The caps used to run first, and a member holding bytes already
    // written was skipped — its slide silently dropped from the asset that
    // does show on it (Codex, round 1).
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const seen = byDigest.get(digest);
    if (seen) {
      // A Set per digest, sorted ONCE at the end: `includes` then `sort` on
      // every duplicate made D duplicates of an image shown on S slides cost
      // O(D x S) (Codex, round 14).
      const set = slideSets.get(digest);
      for (const s of slides) set.add(s);
      seen.members.push(member);
      continue;
    }

    // The name is decided BEFORE any cap or write, from the slide order
    // alone, so it does not depend on what the caps or the disk say.
    const first = slides[0];
    const n = (perSlideIndex.get(first) || 0) + 1;
    perSlideIndex.set(first, n);
    const constructed = `slide${first}-${n}.${ext}`;
    const hashed = `slide${first}-${digest.slice(0, 16)}.${ext}`;
    const refuse = (reason) => {
      const s = { member, slides, reason, members: [member] };
      skipped.push(s);
      byDigest.set(digest, s);
      slideSets.set(digest, new Set(slides));
    };

    // createOnly: a file already holding these exact bytes IS the asset —
    // recognised before the caps, because it costs no write and the caps bound
    // writes. A first version reported every taken name as skipped, so a
    // re-ingest of the same deck LOST every image link, and a later version
    // let the write caps refuse files that needed no writing (Codex, round 2).
    let name = null;
    let alreadyPresent = false;
    if (createOnly) {
      name = [constructed, hashed].find((c) => out.holdsSameBytes(c, bytes)) ?? null;
      alreadyPresent = name !== null;
    }

    if (!alreadyPresent) {
      // Once a cap has closed the run for NEW files, every later new file is
      // skipped for THAT reason. A first version reported the asset cap for
      // members the BYTE cap had stopped, which sends a reader looking at the
      // wrong number.
      if (cappedReason) { refuse(cappedReason); continue; }
      if (writtenCount >= assetCap) {
        cappedReason = `asset cap reached (${assetCap})`;
        refuse(cappedReason);
        continue;
      }
      if (totalBytes + bytes.length > byteCap) {
        cappedReason = `total byte cap reached (${byteCap})`;
        refuse(cappedReason);
        continue;
      }
      if (createOnly) {
        // The precondition the shared-vault gate asks for: nothing already
        // there is overwritten. The constructed name, else the content-hash
        // name, each created exclusively; a name that turned out to hold the
        // same bytes after all (a concurrent writer) is the asset.
        const placed = placeCreateOnly(out, constructed, hashed, bytes);
        if (!placed) {
          refuse(`name taken by different content, left untouched (createOnly): ${constructed}`);
          continue;
        }
        ({ name, alreadyPresent } = placed);
      } else {
        name = constructed;
        // Replaces a file or a link at the name — the link itself, never its
        // target — through a temporary and a rename.
        out.replace(name, bytes);
      }
      if (!alreadyPresent) {
        writtenCount += 1;
        totalBytes += bytes.length;
      }
    }
    const dest = path.join(target, name);

    const asset = {
      name,
      path: dest,
      slides,
      bytes: bytes.length,
      ext,
      sha256: digest,
      member,
      members: [member],
      ...(alreadyPresent ? { alreadyPresent: true } : {}),
    };
    assets.push(asset);
    byDigest.set(digest, asset);
    slideSets.set(digest, new Set(slides));
  }
  // The merged slide lists, materialised and sorted once per image.
  for (const [digest, entry] of byDigest) entry.slides = [...slideSets.get(digest)].sort((a, b) => a - b);

  return {
    source: src,
    outDir: target,
    orderSource,
    ...(positions ? {} : { orderFallbackReason: running.reason }),
    slideCount,
    assetCount: assets.length,
    totalBytes,
    assets,
    // Member names come from the archive and are QUOTED by the skill: bounded
    // and escaped like reasons (round 10). The two names the skill tells apart
    // — `ppt/presentation.xml` and `ppt/slides/_rels/...` — are short and
    // come through unchanged.
    skipped: skipped.map((s) => ({
      ...s,
      member: excerpt(s.member, 300),
      ...(s.members ? { members: s.members.map((m) => excerpt(m, 300)) } : {}),
    })),
  };
}
