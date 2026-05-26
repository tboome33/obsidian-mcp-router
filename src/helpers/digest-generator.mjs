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
// YAML inline-array serialisation
// ---------------------------------------------------------------------------

/**
 * Serialise a list of strings as a YAML inline array, with proper quoting
 * for items that contain special characters (commas, colons, brackets,
 * quotes, leading/trailing whitespace).
 *
 * Examples:
 *   ['oauth', 'auth']         → '[oauth, auth]'
 *   ['First, second', 'Bare'] → '["First, second", Bare]'
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
  const needsQuoting = (s) => /[,:\[\]"'\n]/.test(s) || s !== s.trim();
  const parts = items.map((item) => {
    const str = String(item);
    if (needsQuoting(str)) {
      // Escape backslashes and double quotes for YAML double-quoted form
      const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    return str;
  });
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
  const generatedAt = digest.generatedAt ?? new Date().toISOString();
  const concepts = digest.concepts ?? [];
  const claims = digest.claims ?? [];
  const keywords = digest.keywords ?? [];
  const summary = digest.summary ?? '';
  const notable = digest.notable ?? '';

  const lines = [];
  lines.push('---');
  lines.push('type: digest');
  lines.push(`for: ${digest.for}`);
  lines.push(`page_hash: ${digest.pageHash}`);
  lines.push(`concepts: ${serialiseInlineArray(concepts)}`);
  lines.push(`claims: ${serialiseInlineArray(claims)}`);
  lines.push(`keywords: ${serialiseInlineArray(keywords)}`);
  lines.push(`generated_at: ${generatedAt}`);
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
