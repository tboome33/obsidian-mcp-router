/**
 * get_wiki_context_pack — structured JSON context for a query.
 *
 * Roadmap item #6 from `llm-wiki-compiler-roadmap`. Unlike the `wiki-query`
 * skill (prose Q&A optimised for Claude in a chat loop), this tool returns
 * a versioned JSON envelope so non-Claude agents (Cursor, MCPHub multi-
 * agent workflows, custom scripts, dashboards) can consume the router's
 * vault knowledge programmatically.
 *
 * v1 envelope shape (stability invariants):
 *   - `version: "v1"` always present
 *   - Every top-level field is MANDATORY — empty arrays emit `[]`, never
 *     get omitted
 *   - Existing fields NEVER change shape in v1. New optional fields = OK.
 *   - Bumping to v2 = breaking change for consumers, so the design is
 *     deliberately conservative.
 *
 * Implementation reuses existing primitives rather than duplicating them:
 *   - `idf-score.mjs` for primary-page ranking against `wiki-meta/index.md`
 *   - `searchSmart` REST helper for `semanticChunks` (degrades gracefully
 *     when Smart Connections isn't installed → warning emitted)
 *   - `getFileContent` + `getNote` for graph neighbours and citations
 *
 * Dependency injection (`_deps` argument): the handler accepts an optional
 * deps bag exposing `{ getFileContent, getNote, searchSmart }` so tests
 * can run without a live REST endpoint. Production callers (the MCP
 * dispatcher in `src/index.mjs`) don't pass `_deps` and get the real
 * REST client. This is the established pattern across this codebase for
 * tool-level testability (ESM frozen exports make per-test `mock.method`
 * patching fragile — DI is the simpler stable contract).
 */

import * as defaultRestClient from '../rest-client.mjs';
import { sanitizeResponse, sanitizeLabel } from '../helpers/sanitize.mjs';
import { rankAndPick, scoreCandidates } from '../helpers/idf-score.mjs';

export const TOOL_NAME = 'get_wiki_context_pack';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Return a structured JSON context pack for a natural-language query — the machine-readable counterpart of the `wiki-query` skill. Reads `wiki-meta/index.md` to rank primary pages via IDF scoring, runs `search_smart` for semantic chunks (silently degrades when Smart Connections is missing), extracts wikilink graph neighbours, and collects per-page `sources:` frontmatter as citations. Returns a versioned envelope (`version: "v1"`) — additive-only schema for stable consumption by non-Claude agents (Cursor, MCPHub multi-agent flows, custom scripts).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language question, e.g. "money management rules for swing trading".',
      },
      vault: {
        type: 'string',
        description: 'Vault name (see list_vaults). Omit to use the default vault.',
      },
      maxPrimaryPages: {
        type: 'number',
        description: 'Cap on primaryPages[]. Default: 5.',
      },
      maxSemanticChunks: {
        type: 'number',
        description: 'Cap on semanticChunks[] (forwarded as `limit` to search_smart). Default: 10.',
      },
      includeNeighbors: {
        type: 'boolean',
        description: 'When true (default), expand wikilinks from primary pages into graphNeighbors[].',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Strip leading frontmatter block `--- ... ---` so the body parsing
// doesn't confuse YAML keys with markdown bullets. Returns the body
// portion only (frontmatter is read separately via `getNote`).
function stripFrontmatter(text) {
  if (typeof text !== 'string') return '';
  if (!text.startsWith('---')) return text;
  // Match the first complete `---\n...\n---` block at the start.
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

// Extract wikilink targets `[[<target>]]` (excluding embeds `![[...]]`).
// Handles `[[Page]]`, `[[Page|alias]]`, `[[Page#heading]]`, `[[Page^block]]`.
// Returns the canonical target part (everything before `|`, `#`, or `^`).
function extractWikilinks(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = new Set();
  const re = /(?<!!)\[\[([^\]\n]+)\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    // Strip alias/header/block-id suffixes — we want the target basename only.
    const target = raw.split(/[|#^]/)[0].trim();
    if (target) out.add(target);
  }
  return [...out];
}

// Parse the wiki-meta/index.md catalog and return one candidate object
// per `- [[link]]` (or `- [[link]] — description`) bullet. The optional
// `descriptionAfterDash` becomes the candidate's secondary label so it
// boosts but doesn't dominate the primary title match.
//
// Index format examples (intentionally tolerant):
//   - [[page-slug]] — short description
//   - [[page-slug|Display Name]] — short description
//   - [[page-slug]]
export function parseIndexEntries(indexMarkdown) {
  const body = stripFrontmatter(indexMarkdown);
  const entries = [];
  const seen = new Set();
  const re = /^\s*[-*+]\s*\[\[([^\]\n]+)\]\](?:\s*[—-]\s*(.+))?$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const rawTarget = m[1].trim();
    if (!rawTarget) continue;
    const target = rawTarget.split(/[|#^]/)[0].trim();
    const aliasPart = rawTarget.includes('|')
      ? rawTarget.split('|')[1].split(/[#^]/)[0].trim()
      : null;
    const description = m[2] ? m[2].trim() : '';
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = {
      label: target,
      aliases: aliasPart ? [aliasPart] : [],
      // Description as secondary label — relevant terms in the description
      // boost the candidate at half weight (cf. idf-score.SECONDARY_MULTIPLIER).
      secondaryLabel: description || undefined,
      description: description || null,
    };
    entries.push(candidate);
  }
  return entries;
}

// Resolve a wiki page basename to an actual vault path. Without a
// filesystem index we can't know where a `[[link]]` lives — so we emit
// the basename + `.md` extension and let consumers resolve via Obsidian
// (which natively resolves wikilinks by basename). The `via` field tells
// the caller which primary page introduced this neighbour.
function neighbourEntry(target, viaPath) {
  return {
    path: target.endsWith('.md') ? target : `${target}.md`,
    title: target,
    via: viaPath,
  };
}

// Build the first-paragraph summary fallback when no frontmatter summary
// is available. Strips wikilinks/inline-code markup minimally and caps at
// SUMMARY_MAX_CHARS so the envelope stays bounded.
const SUMMARY_MAX_CHARS = 280;
function firstParagraphSummary(body) {
  if (typeof body !== 'string') return '';
  const trimmed = body.trim();
  if (!trimmed) return '';
  // Take everything up to the first blank line OR the first heading.
  const stopIdx = trimmed.search(/\n\s*\n|\n#{1,6}\s/);
  const slice = stopIdx >= 0 ? trimmed.slice(0, stopIdx) : trimmed;
  const cleaned = slice
    .replace(/^>\s+/gm, '') // strip leading blockquote chars on each line
    .replace(/^#{1,6}\s+/gm, '') // strip leading heading markers
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > SUMMARY_MAX_CHARS
    ? `${cleaned.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : cleaned;
}

// Resolve the most relevant ~200 char snippet from the body — the
// paragraph containing the most query-token hits. Falls back to the
// first paragraph if no tokens match.
const SNIPPET_MAX_CHARS = 200;
function bestSnippet(body, queryTokens) {
  if (typeof body !== 'string' || !body.trim()) return '';
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return '';
  if (!queryTokens || queryTokens.length === 0) {
    const first = paragraphs[0].replace(/\s+/g, ' ');
    return first.length > SNIPPET_MAX_CHARS
      ? `${first.slice(0, SNIPPET_MAX_CHARS - 1)}…`
      : first;
  }
  let bestIdx = 0;
  let bestHits = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    const lower = paragraphs[i].toLowerCase();
    let hits = 0;
    for (const t of queryTokens) {
      if (lower.includes(t)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestIdx = i;
    }
  }
  const chosen = paragraphs[bestIdx].replace(/\s+/g, ' ');
  return chosen.length > SNIPPET_MAX_CHARS
    ? `${chosen.slice(0, SNIPPET_MAX_CHARS - 1)}…`
    : chosen;
}

// The candidate carries label (basename, no extension). Convert to a
// vault path under `wiki/`. Without a filesystem index we don't know the
// exact subfolder, so we ship the basename and let consumers route via
// Obsidian's wikilink resolution.
function candidateToVaultPath(label) {
  if (label.endsWith('.md')) return label;
  return `${label}.md`;
}

/**
 * Defence against a poisoned `wiki-meta/index.md` containing wikilinks
 * like `[[../../etc/passwd]]`, `[[/etc/passwd]]`, `[[C:\\Windows\\...]]`,
 * `[[\\\\server\\share]]`, or URL-like `[[file://etc/passwd]]`.
 * `getNote(vault, path)` ships the path verbatim to the Obsidian REST
 * API, which may resolve relative paths outside the vault. Refuse paths
 * that look unsafe BEFORE handing them to the REST layer.
 *
 * Conditions for rejection :
 *   - POSIX absolute (`/etc/...`)
 *   - Windows drive letter (`C:\Foo`, `C:/Foo`)
 *   - UNC / backslash-rooted (`\\server\share`)
 *   - `..` as a complete path segment (`../foo`, `foo/../bar`, `foo/..`)
 *   - Any control character (NUL, NL, etc.)
 *   - URL-like (`file://`, `http://`, etc.)
 *
 * @param {string} p Vault-relative path candidate
 * @returns {boolean} true when safe to pass to getNote
 */
export function isSafeVaultRelativePath(p) {
  if (typeof p !== 'string' || !p) return false;
  // POSIX absolute, Windows drive letter, UNC / backslash root
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\')) {
    return false;
  }
  // Control chars (including NUL, CR, LF) — must be rejected outright
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return false;
  // `..` as a complete path segment (bordered by /, \, start, or end)
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p)) return false;
  // URL-like (someone trying to smuggle an external fetch / file://).
  // Catches both `scheme://host/...` (file, http, ftp, etc.) AND opaque
  // schemes that don't use `//` (javascript:, data:, mailto:, ...).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return false;
  if (/^(?:javascript|data|vbscript|mailto|file):/i.test(p)) return false;
  return true;
}

// Pull the `summary:` frontmatter or fall back to the first paragraph of
// the body. Returns a trimmed, length-capped string.
function pickSummary(frontmatter, body) {
  if (frontmatter && typeof frontmatter.summary === 'string' && frontmatter.summary.trim()) {
    const s = frontmatter.summary.trim();
    return s.length > SUMMARY_MAX_CHARS ? `${s.slice(0, SUMMARY_MAX_CHARS - 1)}…` : s;
  }
  return firstParagraphSummary(body);
}

// Tokens for snippet ranking. Lowercased, length ≥ 3, deduped.
function snippetTokens(query) {
  if (typeof query !== 'string') return [];
  const out = new Set();
  for (const t of query.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (t.length >= 3) out.add(t);
  }
  return [...out];
}

// Coerce a `sources:` frontmatter value into a string array. Accepts
// arrays (returned as-is, strings only), or a single string (split on
// commas/whitespace). Anything else → empty array.
function coerceSources(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export async function getWikiContextPack(registry, args = {}, _deps = {}) {
  const {
    query,
    vault: name,
    maxPrimaryPages = 5,
    maxSemanticChunks = 10,
    includeNeighbors = true,
  } = args;

  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Missing required argument: query');
  }

  const deps = {
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    getNote: _deps.getNote || defaultRestClient.getNote,
    searchSmart: _deps.searchSmart || defaultRestClient.searchSmart,
  };

  const vault = registry.resolveVault(name);

  const warnings = [];
  const suggestedActions = [];

  // -------------------------------------------------------------------------
  // 1. Read index.md → parse candidates → score → pick top-N
  // -------------------------------------------------------------------------
  let candidates = [];
  let indexAvailable = true;
  try {
    const indexText = await deps.getFileContent(vault, 'wiki-meta/index.md');
    candidates = parseIndexEntries(
      typeof indexText === 'string' ? indexText : indexText?.content || '',
    );
  } catch (err) {
    indexAvailable = false;
    // Graceful degradation: an offline vault or a vault without a wiki-meta
    // scaffold should not crash the tool. Surface as a warning and continue
    // with empty primaryPages/graphNeighbors/citations — semantic search
    // may still produce useful chunks if the bridge is up.
    if (err && err.kind === 'unreachable') {
      warnings.push('vault-offline');
    } else if (err && err.kind === 'not_found') {
      warnings.push('index-not-found');
    } else {
      warnings.push('index-read-failed');
    }
  }

  // Cap the maxPrimaryPages bound at 50 to keep the envelope bounded even
  // if the caller passes absurd numbers. Tools elsewhere apply similar
  // bounds (search contextLength, search_smart limit).
  const primaryCap = Math.max(0, Math.min(50, Number.isFinite(maxPrimaryPages) ? maxPrimaryPages : 5));
  const chunkCap = Math.max(0, Math.min(50, Number.isFinite(maxSemanticChunks) ? maxSemanticChunks : 10));

  // Rank candidates by IDF (no idf prebuilt — defaultIdf is fine for our
  // corpus sizes; the relative ordering is what matters here).
  const scored = candidates.length > 0
    ? scoreCandidates({ query, candidates })
    : [];
  const ranked = scored.filter((s) => s.score > 0).slice(0, primaryCap);

  if (indexAvailable && ranked.length === 0) {
    warnings.push('no-primary-page-matched');
  }

  // -------------------------------------------------------------------------
  // 2. Drill into top-N primary pages — pull body + frontmatter in parallel
  // -------------------------------------------------------------------------
  const queryTokens = snippetTokens(query);
  const primaryPages = [];
  const graphTargetByVia = []; // [{ targets: [...], via: filePath }]
  const citations = [];

  // Resolve each candidate to a vault path. Without a filesystem index we
  // can only address by basename; consumers route via Obsidian's wikilink
  // resolution. We attempt to GET the file via the obvious `wiki/<base>.md`
  // location AND, if that fails, fall back to a basename-only path that
  // the Obsidian REST API may still resolve.
  const drillResults = await Promise.allSettled(
    ranked.map(async ({ candidate, score }) => {
      const basePath = candidateToVaultPath(candidate.label);
      // Path-traversal defence (review+ pass 2 hardening) : refuse to
      // pass anything that looks unsafe to `getNote`. A poisoned
      // wiki-meta/index.md with `[[../../etc/passwd]]` or `[[/etc/x]]`
      // would otherwise be forwarded verbatim to the REST API.
      if (!isSafeVaultRelativePath(basePath)) {
        return {
          path: basePath,
          title: candidate.label,
          summary: '',
          source_type: null,
          snippet: '',
          score,
          unsafePath: true,
        };
      }
      // Two heuristic attempts: `wiki/<base>.md` first (most pages live
      // under wiki/), then bare `<base>.md` as a fallback for root-level
      // pages. The first success wins.
      const candidatePaths = [`wiki/${basePath}`, basePath];
      let note = null;
      let body = '';
      let resolvedPath = null;
      let nonNotFoundError = null;
      for (const tryPath of candidatePaths) {
        try {
          // Note: getNote returns parsed frontmatter — much cheaper to
          // parse upstream than to re-derive YAML here.
          note = await deps.getNote(vault, tryPath);
          body = typeof note?.content === 'string' ? note.content : '';
          resolvedPath = tryPath;
          break;
        } catch (err) {
          // Distinguish "not found" (legitimate fallthrough to next
          // path) from real errors (timeout, auth, 5xx). Real errors
          // surface as a warning so the consumer knows the missing-page
          // status is provisional, not a confirmed dead link.
          // (review+ pass 1 finding A IMP-5 + B IMPORTANT #6 convergent)
          const status = err?.status ?? err?.statusCode;
          const msg = String(err?.message ?? err ?? '');
          const isNotFound =
            status === 404 ||
            err?.kind === 'not_found' ||
            /not.?found|no such file|404|enoent/i.test(msg);
          if (!isNotFound && !nonNotFoundError) {
            nonNotFoundError = { status, message: msg };
          }
        }
      }
      if (!resolvedPath) {
        // Page referenced by the index doesn't exist (dead wikilink) OR
        // a real error blocked us. Emit a placeholder so the consumer
        // sees the gap; the `fetchError` field tells them which case.
        return {
          path: basePath,
          title: candidate.label,
          summary: '',
          source_type: null,
          snippet: '',
          score,
          missing: true,
          fetchError: nonNotFoundError, // null when truly not-found
        };
      }
      const frontmatter = (note && note.frontmatter) || {};
      return {
        path: resolvedPath,
        title:
          (typeof frontmatter.title === 'string' && frontmatter.title.trim()) ||
          candidate.label,
        summary: pickSummary(frontmatter, body),
        source_type:
          typeof frontmatter.source_type === 'string' && frontmatter.source_type.trim()
            ? frontmatter.source_type.trim()
            : null,
        snippet: bestSnippet(body, queryTokens),
        score,
        _body: body,
        _frontmatter: frontmatter,
      };
    }),
  );

  for (const r of drillResults) {
    if (r.status === 'rejected') {
      // Unexpected exception in the inner async (post-getNote helpers
      // like pickSummary / bestSnippet shouldn't throw but defence in
      // depth — surface as warning rather than silently drop).
      warnings.push('primary-page-drill-failed');
      continue;
    }
    if (!r.value) continue;
    const page = r.value;
    // Surface specific warnings for the two refusal categories BEFORE
    // stripping the internal flags from the envelope.
    if (page.unsafePath) {
      warnings.push('unsafe-index-target');
    } else if (page.missing && page.fetchError) {
      // Real fetch failure (not 404) — surface so the consumer knows
      // the missing-page status is provisional, not a confirmed dead
      // link. (review+ pass 1 A IMP-5 + B #6 convergent.)
      warnings.push('page-read-failed');
    }
    // Body + frontmatter + internal flags — strip before envelope emit.
    const {
      _body: body,
      _frontmatter: fm,
      missing,
      unsafePath: _u, // eslint-disable-line no-unused-vars
      fetchError: _f, // eslint-disable-line no-unused-vars
      ...publicFields
    } = page;
    primaryPages.push(publicFields);

    if (missing) continue;

    // Citations: pull `sources:` frontmatter (string list / array / scalar).
    const sources = fm ? coerceSources(fm.sources) : [];
    if (sources.length > 0) {
      citations.push({ page: page.path, sources });
    }

    // Graph neighbours: wikilinks extracted from the body. Deferred dedupe
    // happens after we know all primary page basenames.
    if (includeNeighbors && body) {
      const links = extractWikilinks(body);
      if (links.length > 0) {
        graphTargetByVia.push({ targets: links, via: page.path });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Graph neighbours — flatten & dedupe, exclude primary page basenames
  // -------------------------------------------------------------------------
  const primaryBasenames = new Set(
    primaryPages.map((p) => {
      const m = /([^/\\]+?)(?:\.md)?$/.exec(p.path);
      return m ? m[1].toLowerCase() : '';
    }),
  );
  const graphNeighbors = [];
  const seenNeighbours = new Set();
  if (includeNeighbors) {
    for (const { targets, via } of graphTargetByVia) {
      for (const target of targets) {
        const key = target.toLowerCase();
        if (seenNeighbours.has(key)) continue;
        if (primaryBasenames.has(key)) continue;
        seenNeighbours.add(key);
        graphNeighbors.push(neighbourEntry(target, via));
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Semantic chunks via search_smart — degrades gracefully when missing
  // -------------------------------------------------------------------------
  let semanticChunks = [];
  if (chunkCap > 0) {
    try {
      const sm = await deps.searchSmart(vault, query, { limit: chunkCap });
      const rawChunks = Array.isArray(sm?.results)
        ? sm.results
        : Array.isArray(sm?.chunks)
          ? sm.chunks
          : Array.isArray(sm)
            ? sm
            : [];
      semanticChunks = rawChunks.slice(0, chunkCap).map((chunk) => ({
        path:
          (typeof chunk?.path === 'string' && chunk.path) ||
          (typeof chunk?.filename === 'string' && chunk.filename) ||
          '',
        breadcrumbs:
          (typeof chunk?.breadcrumbs === 'string' && chunk.breadcrumbs) ||
          (Array.isArray(chunk?.breadcrumbs) ? chunk.breadcrumbs.join(' > ') : ''),
        text:
          (typeof chunk?.text === 'string' && chunk.text) ||
          (typeof chunk?.excerpt === 'string' && chunk.excerpt) ||
          (typeof chunk?.content === 'string' && chunk.content) ||
          '',
        score:
          typeof chunk?.score === 'number'
            ? chunk.score
            : typeof chunk?.similarity === 'number'
              ? chunk.similarity
              : 0,
      }));
    } catch (err) {
      // Smart Connections / bridge missing → graceful empty array + warning.
      // The error.kind from rest-client lets us distinguish "vault is down"
      // (already flagged earlier) from "endpoint missing".
      const msg = (err && err.message) || '';
      if (
        /smart.?connections/i.test(msg) ||
        /\/search\/smart/i.test(msg) ||
        (err && err.status === 404) ||
        (err && err.status === 503)
      ) {
        warnings.push('smart-connections-not-available');
      } else if (err && err.kind === 'unreachable' && !warnings.includes('vault-offline')) {
        warnings.push('vault-offline');
      } else {
        warnings.push('semantic-search-failed');
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Compose the v1 envelope
  // -------------------------------------------------------------------------
  // sanitizeResponse strips ANSI/control chars from every string field in
  // the response — vault content is attacker-controlled the same way as
  // search hits, so the same hygiene applies. Non-string scalars (scores,
  // booleans) pass through untouched.
  return sanitizeResponse({
    version: 'v1',
    query: sanitizeLabel(query),
    vault: vault.name,
    primaryPages,
    semanticChunks,
    graphNeighbors,
    citations,
    warnings: [...new Set(warnings)],
    suggestedActions,
  });
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _internals = {
  parseIndexEntries,
  extractWikilinks,
  stripFrontmatter,
  firstParagraphSummary,
  bestSnippet,
  pickSummary,
  snippetTokens,
  coerceSources,
  candidateToVaultPath,
  isSafeVaultRelativePath,
  SUMMARY_MAX_CHARS,
  SNIPPET_MAX_CHARS,
};
