/**
 * Digest sidecar generator — produces a compact summary of a wiki page,
 * stored at `wiki-meta/digests/<page-slug>.md`, that a future `wiki-lint
 * --deep` pass reads in bulk to detect cross-page redundancies,
 * contradictions, and missing wikilinks.
 *
 * Reformulation (Roland's idea, roadmap item #7') of llmwiki's two-phase
 * compile pattern: instead of refactoring `wiki-ingest` to extract
 * concepts up-front from all sources, we keep `wiki-ingest` single-pass
 * and generate a compact digest per page. The digests are cheap to scan
 * in bulk (much smaller than the full pages) and are the substrate for
 * the future agent-de-veille (#3) self-review pass.
 *
 * Format:
 *   wiki-meta/digests/<page-slug>.md
 *   ---
 *   type: digest
 *   for: wiki/Refs/oauth-howto.md          # path of the page this digest summarises
 *   page_hash: <sha256 of source page>     # for staleness detection
 *   concepts: ["OAuth 2.0", "PKCE", ...]   # inline YAML array
 *   claims: ["PKCE replaces ...", ...]     # inline YAML array
 *   keywords: [oauth, auth, security]      # inline YAML array
 *   generated_at: 2026-05-27T12:34:56Z
 *   ---
 *
 *   ## Summary
 *   1-2 sentences summarising the page.
 *
 *   ## Notable
 *   Anything else worth flagging at a glance (rare; optional).
 *
 * Reference: roadmap item #7' from llm-wiki-compiler-roadmap.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Page hash (independent from src/helpers/ingest-state.mjs to avoid coupling)
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash of a page's full content (frontmatter + body), used for
 * staleness detection — the digest's `page_hash` field is compared against
 * a fresh hash of the current page during `wiki-lint --deep`. Mismatch
 * means the page was edited manually since the digest was generated and
 * the digest is stale.
 *
 * @param {string} pageContent Full markdown content (with frontmatter)
 * @returns {string} 64-char lowercase hex
 */
export function computePageHash(pageContent) {
  if (typeof pageContent !== 'string') {
    throw new TypeError('computePageHash: pageContent must be a string');
  }
  return createHash('sha256').update(pageContent, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// YAML scalar/array serialisation — hardened in review+ pass 2
// ---------------------------------------------------------------------------

// YAML 1.1/1.2 reserved bare scalars that change meaning when unquoted.
// Lowercase comparison against the trimmed string.
const YAML_RESERVED_SCALARS = new Set([
  'true', 'false', 'yes', 'no', 'on', 'off',
  'null', '~',
]);

// YAML structural characters that change parse meaning inside a flow
// scalar. Listed EXPLICITLY (no ranges) to avoid the regex range pitfall
// `[ -\\]` (space-to-backslash) which would over-quote ordinary paths
// like `wiki/foo.md`. Includes the backslash (escape char).
const YAML_STRUCTURAL_CHARS = /[,:[\]{}"'\\]/;

// Control characters (NUL through US, plus DEL) — must always be escaped
// inside a YAML scalar. Single explicit range, no risk of confusion.
const YAML_CONTROL_CHARS = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex

// Leading character that triggers a YAML directive / anchor / alias / tag /
// indicator. Per YAML 1.2 spec § 5.5.
const YAML_SPECIAL_LEADING_CHAR = /^[!&*?|>%@`,'"\-[\]{}#:]/;

// Anything that looks like an int/float — would be re-parsed as number.
const YAML_NUMERIC_LIKE =
  /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/**
 * Return true when a string must be YAML-quoted to round-trip safely as a
 * scalar (frontmatter value OR inline-array item). See the regex constants
 * above for the full quoting policy.
 *
 * @param {string} s
 * @returns {boolean}
 */
function needsYamlQuoting(s) {
  if (typeof s !== 'string') return true;
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (YAML_RESERVED_SCALARS.has(s.toLowerCase())) return true;
  if (YAML_STRUCTURAL_CHARS.test(s)) return true;
  if (YAML_CONTROL_CHARS.test(s)) return true;
  if (YAML_SPECIAL_LEADING_CHAR.test(s)) return true;
  if (YAML_NUMERIC_LIKE.test(s)) return true;
  return false;
}

/**
 * Escape a string for safe inclusion inside a YAML double-quoted scalar.
 * Handles backslash, double quote, and the THREE most common whitespace
 * controls (`\n` `\r` `\t`). Other control characters (NUL through US,
 * DEL, and the C1 set) are still detected by `needsYamlQuoting` (so the
 * scalar gets quoted) but emitted verbatim inside the quotes — they
 * survive a YAML 1.2 double-quoted parse but are NOT pretty-displayed.
 * Acceptable for our digest payload (concepts/claims/keywords + ISO
 * timestamps + paths) which should NEVER contain raw control bytes in
 * practice ; if one slips through it's preserved as-is for debugging.
 *
 * Review+ pass 3 NIT (Reviewer B) : previous comment claimed "all
 * control chars escaped" — corrected to reflect actual behaviour.
 *
 * @param {string} s
 * @returns {string} Escape-only payload (no surrounding quotes)
 */
function escapeYamlDoubleQuoted(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Quote a string for YAML using the double-quoted form. Returns the input
 * unchanged when no quoting is needed.
 *
 * @param {string} s
 * @returns {string}
 */
function quoteYamlScalar(s) {
  const str = String(s);
  if (!needsYamlQuoting(str)) return str;
  return `"${escapeYamlDoubleQuoted(str)}"`;
}

/**
 * Serialise a list of strings as a YAML inline array, with proper quoting
 * for items that need it.
 *
 * Examples:
 *   ['oauth', 'auth']         → '[oauth, auth]'
 *   ['First, second', 'Bare'] → '["First, second", Bare]'
 *   ['yes', 'no']             → '["yes", "no"]'   (YAML booleans)
 *   ['*alias']                → '["*alias"]'      (YAML alias trigger)
 *   ['42']                    → '["42"]'          (would parse as int)
 *   []                        → '[]'
 *
 * @param {string[]} items
 * @returns {string} YAML inline array literal
 */
function serialiseInlineArray(items) {
  if (!Array.isArray(items)) {
    throw new TypeError('serialiseInlineArray: items must be an array');
  }
  if (items.length === 0) return '[]';
  const parts = items.map((item) => quoteYamlScalar(item));
  return `[${parts.join(', ')}]`;
}

/**
 * Parse a YAML inline array literal back into a string array. Handles
 * quoted items (single or double) and bare items. The inverse of
 * serialiseInlineArray (modulo whitespace normalisation).
 *
 * @param {string} literal The text between '[' and ']' inclusive
 * @returns {string[]}
 */
function parseInlineArray(literal) {
  if (typeof literal !== 'string') return [];
  const trimmed = literal.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let i = 0;
  let current = '';
  let inQuote = null; // null | '"' | "'"
  while (i < inner.length) {
    const ch = inner[i];
    if (inQuote) {
      if (ch === '\\' && i + 1 < inner.length) {
        current += inner[i + 1];
        i += 2;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      items.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

// ---------------------------------------------------------------------------
// Digest parsing
// ---------------------------------------------------------------------------

const DIGEST_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a digest markdown file into a structured object.
 *
 * Tolerant of missing optional fields — defaults to empty arrays and
 * empty strings. Throws only if the input is malformed (no frontmatter,
 * non-string input).
 *
 * @param {string} digestMd Content of a digest .md file
 * @returns {{
 *   type: string,
 *   for: string,
 *   pageHash: string,
 *   concepts: string[],
 *   claims: string[],
 *   keywords: string[],
 *   generatedAt: string,
 *   summary: string,
 *   notable: string,
 * }}
 */
export function parseDigest(digestMd) {
  if (typeof digestMd !== 'string') {
    throw new TypeError('parseDigest: digestMd must be a string');
  }
  const match = DIGEST_FRONTMATTER_RE.exec(digestMd);
  if (!match) {
    throw new Error('parseDigest: missing or malformed frontmatter');
  }
  const yaml = match[1];
  const body = digestMd.slice(match[0].length);

  const result = {
    type: 'digest',
    for: '',
    pageHash: '',
    concepts: [],
    claims: [],
    keywords: [],
    generatedAt: '',
    summary: '',
    notable: '',
  };

  for (const line of yaml.split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    // Strip surrounding quotes for scalar values
    if (
      !value.startsWith('[') &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'type') result.type = value;
    else if (key === 'for') result.for = value;
    else if (key === 'page_hash') result.pageHash = value;
    else if (key === 'concepts') result.concepts = parseInlineArray(value);
    else if (key === 'claims') result.claims = parseInlineArray(value);
    else if (key === 'keywords') result.keywords = parseInlineArray(value);
    else if (key === 'generated_at') result.generatedAt = value;
  }

  // Body sections — extract ## Summary and ## Notable
  const sections = parseBodySections(body);
  if (sections.Summary) result.summary = sections.Summary;
  if (sections.Notable) result.notable = sections.Notable;

  return result;
}

/**
 * Parse the body of a digest into a section name → content map.
 * Only matches H2 headings (`## Name`). Section content is everything
 * between the H2 and the next H2 (or end of file), trimmed.
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
function parseBodySections(body) {
  const sections = {};
  const lines = body.split(/\r?\n/);
  let currentName = null;
  let currentLines = [];
  for (const line of lines) {
    const h2Match = /^##\s+(.+?)\s*$/.exec(line);
    if (h2Match) {
      if (currentName !== null) {
        // Detect duplicate H2 (review+ pass 2 fix for Reviewer A IMP-3).
        // Previously the parser silently overwrote — a re-generated
        // digest that accidentally produced two `## Summary` blocks
        // would lose the first one without warning. Throw instead so
        // the user notices and can fix the digest source.
        if (Object.prototype.hasOwnProperty.call(sections, currentName)) {
          throw new Error(
            `parseDigest: duplicate H2 section "${currentName}" — refuse to silently overwrite`,
          );
        }
        sections[currentName] = currentLines.join('\n').trim();
      }
      currentName = h2Match[1].trim();
      currentLines = [];
      continue;
    }
    if (currentName !== null) {
      currentLines.push(line);
    }
  }
  if (currentName !== null) {
    if (Object.prototype.hasOwnProperty.call(sections, currentName)) {
      throw new Error(
        `parseDigest: duplicate H2 section "${currentName}" — refuse to silently overwrite`,
      );
    }
    sections[currentName] = currentLines.join('\n').trim();
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Digest serialisation
// ---------------------------------------------------------------------------

/**
 * Serialise a digest object back into a markdown string. The inverse of
 * `parseDigest` modulo whitespace normalisation — `parseDigest(serialiseDigest(d))`
 * yields `d` with the same field values (arrays in same order, scalars
 * identical), but the surrounding whitespace may differ.
 *
 * @param {object} digest
 * @param {string} digest.for Path of the wiki page this digest summarises
 * @param {string} digest.pageHash SHA-256 hex of the source page
 * @param {string[]} [digest.concepts=[]]
 * @param {string[]} [digest.claims=[]]
 * @param {string[]} [digest.keywords=[]]
 * @param {string} [digest.generatedAt] ISO timestamp; defaults to now
 * @param {string} [digest.summary=''] Free-text summary (H2 Summary content)
 * @param {string} [digest.notable=''] Free-text notable observations
 * @returns {string} Markdown content
 */
export function serialiseDigest(digest) {
  if (!digest || typeof digest !== 'object') {
    throw new TypeError('serialiseDigest: digest must be an object');
  }
  if (!digest.for || typeof digest.for !== 'string') {
    throw new TypeError('serialiseDigest: digest.for is required (string)');
  }
  if (!digest.pageHash || typeof digest.pageHash !== 'string') {
    throw new TypeError('serialiseDigest: digest.pageHash is required (string)');
  }
  // Defence in depth against YAML injection: the canonical pageHash is
  // 64-char hex from computePageHash(). Reject anything else — a caller
  // passing `aaa\nclaims: [injected]` would otherwise smuggle YAML lines.
  if (!/^[0-9a-f]{64}$/i.test(digest.pageHash)) {
    throw new TypeError(
      'serialiseDigest: digest.pageHash must be a 64-char hex string (SHA-256)',
    );
  }
  const generatedAt = digest.generatedAt ?? new Date().toISOString();
  const concepts = digest.concepts ?? [];
  const claims = digest.claims ?? [];
  const keywords = digest.keywords ?? [];
  const summary = digest.summary ?? '';
  const notable = digest.notable ?? '';

  const lines = [];
  lines.push('---');
  lines.push('type: digest');
  // `for` is an arbitrary caller-controlled path — MUST be YAML-quoted
  // to prevent injection via `digest.for = "foo.md\nclaims: [malicious]"`.
  lines.push(`for: ${quoteYamlScalar(digest.for)}`);
  // page_hash is hex-validated above; no quoting needed but harmless.
  lines.push(`page_hash: ${digest.pageHash}`);
  lines.push(`concepts: ${serialiseInlineArray(concepts)}`);
  lines.push(`claims: ${serialiseInlineArray(claims)}`);
  lines.push(`keywords: ${serialiseInlineArray(keywords)}`);
  // generatedAt contains `:` (ISO timestamp colons) → must be quoted.
  lines.push(`generated_at: ${quoteYamlScalar(generatedAt)}`);
  lines.push('---');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(summary || '(pending — fill in when generating)');
  if (notable) {
    lines.push('');
    lines.push('## Notable');
    lines.push('');
    lines.push(notable);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Digest skeleton — for use by wiki-ingest skill
// ---------------------------------------------------------------------------

/**
 * Generate a digest skeleton — frontmatter is fully populated (type, for,
 * page_hash, empty arrays, generated_at), body has empty `## Summary` and
 * `## Notable` placeholders. Claude fills in the concepts/claims/keywords/
 * summary fields based on its understanding of the page, then writes the
 * result to `wiki-meta/digests/<page-slug>.md`.
 *
 * @param {object} input
 * @param {string} input.pageContent Full markdown content of the wiki page
 * @param {string} input.forPath Path of the wiki page (used as `for:` field)
 * @returns {string} Skeleton markdown ready for Claude to populate
 */
export function generateDigestSkeleton({ pageContent, forPath }) {
  if (typeof pageContent !== 'string') {
    throw new TypeError('generateDigestSkeleton: pageContent must be a string');
  }
  if (typeof forPath !== 'string' || !forPath) {
    throw new TypeError('generateDigestSkeleton: forPath must be a non-empty string');
  }
  return serialiseDigest({
    for: forPath,
    pageHash: computePageHash(pageContent),
    concepts: [],
    claims: [],
    keywords: [],
    summary: '',
    notable: '',
  });
}

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

/**
 * Check whether a digest is stale w.r.t. the current page content. A
 * digest is stale when the source page has been edited since the digest
 * was generated (the stored `page_hash` no longer matches a fresh hash
 * of the page).
 *
 * @param {object} input
 * @param {object} input.digest Parsed digest object (from parseDigest)
 * @param {string} input.currentPageContent Current full content of the page
 * @returns {boolean} true if stale (hashes differ)
 */
export function isDigestStale({ digest, currentPageContent }) {
  if (!digest || typeof digest !== 'object') {
    throw new TypeError('isDigestStale: digest must be an object');
  }
  if (typeof currentPageContent !== 'string') {
    throw new TypeError('isDigestStale: currentPageContent must be a string');
  }
  const currentHash = computePageHash(currentPageContent);
  return digest.pageHash !== currentHash;
}

// ---------------------------------------------------------------------------
// Cross-digest analysis helpers (for wiki-lint --deep)
// ---------------------------------------------------------------------------

/**
 * Compute concept overlap between two digests, as a Jaccard similarity
 * coefficient (|A ∩ B| / |A ∪ B|). Case-insensitive matching.
 *
 * @param {object} digestA
 * @param {object} digestB
 * @returns {number} 0..1
 */
export function conceptOverlap(digestA, digestB) {
  const a = new Set((digestA.concepts ?? []).map((c) => c.toLowerCase()));
  const b = new Set((digestB.concepts ?? []).map((c) => c.toLowerCase()));
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Return the list of concepts shared between two digests (intersection),
 * case-insensitive, returning the original casing from digestA.
 *
 * @param {object} digestA
 * @param {object} digestB
 * @returns {string[]}
 */
export function sharedConcepts(digestA, digestB) {
  const bLower = new Set((digestB.concepts ?? []).map((c) => c.toLowerCase()));
  return (digestA.concepts ?? []).filter((c) => bLower.has(c.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Digest path naming — SINGLE source of truth (review+ pass 2 fix)
// ---------------------------------------------------------------------------

/**
 * Compute the canonical digest sidecar path for a wiki page.
 *
 * This is the SINGLE source of truth for the naming convention — both
 * the `wiki-ingest` skill (write side, step 5.5) and the
 * `wiki-refresh-digests` skill (read + write) MUST call this function
 * rather than improvising a path. Pre-review+ pass 2 the two skills
 * used different filename derivations (slug() vs <page-slug>) which
 * meant the same page would end up writing to and reading from
 * different digest files — sidecars effectively unfindable.
 *
 * Mapping (NESTED — mirrors the source path under `wiki-meta/digests/`) :
 *   wiki/Refs/oauth-howto.md  → wiki-meta/digests/wiki/Refs/oauth-howto.md
 *   wiki/Misc/foo.md          → wiki-meta/digests/wiki/Misc/foo.md
 *   wiki/A/B.md               → wiki-meta/digests/wiki/A/B.md
 *   wiki/A-B.md               → wiki-meta/digests/wiki/A-B.md
 *
 * IMPORTANT — review+ pass 3 fix : the previous flatten-with-dashes
 * mapping (slash → dash) collided when two real paths produced the
 * same flattened form, e.g. `wiki/A/B.md` and `wiki/A-B.md` both →
 * `wiki-A-B.md`. NESTED preserves the original path structure
 * verbatim, eliminating collisions by construction. Trade-off : nested
 * directories under `wiki-meta/digests/`, so callers must glob with a
 * recursive pattern (e.g. double-star slash dot-md) instead of a flat
 * `*.md`. Acceptable — correctness wins over glob brevity.
 *
 * Backslashes are normalised to forward slashes so the result uses
 * the vault's canonical path separator regardless of input OS.
 *
 * Refuses unsafe inputs : absolute paths, `..` segments, drive letters.
 *
 * @param {string} pageRelPath Path relative to vault root (e.g. "wiki/Refs/foo.md")
 * @returns {string} Vault-relative path for the digest sidecar
 */
export function digestPathForPage(pageRelPath) {
  if (typeof pageRelPath !== 'string' || !pageRelPath) {
    throw new TypeError(
      'digestPathForPage: pageRelPath must be a non-empty string',
    );
  }
  // Reject paths that clearly aren't vault-relative — defence against
  // accidental absolute paths or path-traversal attempts being turned
  // into digest filenames.
  if (
    /^[a-zA-Z]:[\\/]/.test(pageRelPath) || // Windows drive letter
    pageRelPath.startsWith('/') ||           // POSIX absolute
    pageRelPath.startsWith('\\') ||          // UNC-ish
    /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(pageRelPath)  // .. segment
  ) {
    throw new TypeError(
      `digestPathForPage: pageRelPath must be vault-relative without ".." : ${pageRelPath}`,
    );
  }
  // Normalise backslashes to forward slashes (canonical vault separator).
  const normalised = pageRelPath.replace(/\\/g, '/');
  return `wiki-meta/digests/${normalised}`;
}
