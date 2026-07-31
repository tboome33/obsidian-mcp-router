/**
 * Content hashing for optimistic-concurrency ("ifMatch") writes — C1.
 *
 * A single canonical definition of "the fingerprint of a file's content",
 * shared by:
 *   - get_file (emits `contentSha256` of the RAW file content),
 *   - the write tools (replay that hash as `ifMatch`),
 *   - rest-client's conditional-write path.
 *
 * The companion obsidian-mcp-router-bridge plugin computes the SAME hash in
 * the Obsidian renderer via Web Crypto (crypto.subtle) — see
 * src/handlers/vault-cas-core.mjs there. Both hash the UTF-8 BYTES of the
 * content with NO normalization (no line-ending rewrite, no trim, no BOM
 * stripping), so a byte-identical file yields a byte-identical hash on both
 * sides. The known-vector test (tests/content-hash.test.mjs) pins the exact
 * digest so the two implementations can never silently drift apart.
 *
 * Why (almost) raw bytes and no normalization: the hash is a precondition
 * token, not a semantic identity. If the router normalized (say, CRLF→LF) but
 * the file on disk kept CRLF, the replayed hash would never match its own
 * source and every conditional write would spuriously 409. The rule is simple
 * and testable: hash exactly what `get_file` returned, before any sanitization.
 *
 * THE ONE DELIBERATE NORMALIZATION — a leading UTF-8 BOM (U+FEFF) is stripped.
 * This is not a style choice; it is what makes the two read paths agree. The
 * router reads a file through Local REST API's GET /vault, whose body arrives
 * via `res.text()` — the WHATWG UTF-8 decoder, which STRIPS a leading BOM. The
 * bridge's atomic CAS route reads the same file through `adapter.read()` =
 * `fs.readFile(path,'utf8')`, which KEEPS the BOM. Without this strip, a
 * BOM-prefixed file (common on Windows: PowerShell 5.1 `Out-File`, legacy
 * Notepad, many exporters) would hash differently on the two sides and every
 * atomic ifMatch write to it would 409 forever, unrecoverably. Both this
 * function and the bridge's mirror (vault-cas-core.mjs) strip the same single
 * leading BOM so the fingerprint is defined on BOM-free content. A mid-content
 * U+FEFF (a real zero-width no-break space) is left untouched — `res.text()`
 * only strips the leading one, and so do we.
 */
import { createHash } from 'node:crypto';

/**
 * SHA-256 of `content` interpreted as UTF-8 bytes, lowercase hex (64 chars).
 * A single leading BOM is stripped first (see the module comment).
 *
 * @param {string} content — the exact file content as read (pre-sanitize).
 * @returns {string} lowercase hex digest.
 */
export function contentSha256(content) {
  if (typeof content !== 'string') {
    throw new TypeError('contentSha256: content must be a string');
  }
  const normalized = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex');
}

/**
 * True when `value` is a well-formed content hash (64 lowercase hex chars).
 * Used to reject malformed `ifMatch` inputs early with a clear error rather
 * than letting a typo silently behave like "no precondition".
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isContentSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
