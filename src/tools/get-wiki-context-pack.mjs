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
 *   - `idf-score.mjs` for primary-page ranking against `wiki-meta/catalog.md`
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
import { sanitizeLabel } from '../helpers/sanitize.mjs';
import { rankAndPick, scoreCandidates } from '../helpers/idf-score.mjs';
import { scaffoldCandidates, shouldTryLegacyScaffold } from '../helpers/wiki-meta-scaffolds.mjs';
import { isMissingReadError } from '../helpers/missing-read-guard.mjs';
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';
import { freshnessFor, freshnessNote, isDoubtful } from '../helpers/embedding-staleness.mjs';
import {
  resolveExcludeFolders,
  partitionByFolders,
  exclusionReport,
  overfetchLimit,
} from '../helpers/search-exclusions.mjs';
import { filterArchiveResults } from '../helpers/archive-filter.mjs';

export const TOOL_NAME = 'get_wiki_context_pack';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Return a structured JSON context pack for a natural-language query — the machine-readable counterpart of the `wiki-query` skill. Reads `wiki-meta/catalog.md` to rank primary pages via IDF scoring, runs `search_smart` for semantic chunks (silently degrades when Smart Connections is missing), extracts wikilink graph neighbours, and collects per-page `sources:` frontmatter as citations. Returns a versioned envelope (`version: "v1"`) — additive-only schema for stable consumption by non-Claude agents (Cursor, MCPHub multi-agent flows, custom scripts).',
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
      excludeFolders: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Folder prefixes to keep OUT of the semantic chunks. Omit to apply the measured default '
          + '(`wiki-meta/Sessions` — chronological session logs, 41.6% of the indexed pages across '
          + 'this fleet). Pass `[]` to exclude nothing. Whatever applies is reported in '
          + '`folderExclusion`, with the count of hits it cost.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// A3 — provenance, per item
// ---------------------------------------------------------------------------
/**
 * WHERE A RESULT CAME FROM, ON THE RESULT ITSELF.
 *
 * The envelope already separated navigation from augmentation by ARRAY —
 * `primaryPages` before `semanticChunks` — but nothing said so on the items, and
 * a consumer that flattens the pack (many do: one list, sorted by score) lost
 * the distinction entirely. Then a semantic chunk of middling cosine reads
 * exactly like a page reached by navigating the catalogue, which is the inverse
 * of the risk A1 addresses: not trusting a stale index, but OVER-WEIGHTING the
 * index against navigation that is authoritative.
 *
 * A CLOSED VOCABULARY, AND IT SAYS WHAT THIS TOOL ACTUALLY DOES:
 *
 *   index      ranked out of `wiki-meta/catalog.md` — the vault's own map.
 *   graph      a wikilink found in a page that `index` had already reached.
 *   semantic   a Smart Connections chunk. AUGMENTATION: useful for fit-by-meaning,
 *              never the sole support for a factual claim, and possibly stale
 *              (see the per-chunk `freshness` A1 adds).
 *
 * The roadmap sketched `hot` and `plain-search` too. THEY ARE NOT EMITTED HERE
 * and are deliberately absent rather than declared-and-unused: they are tiers of
 * the `wiki-query` SKILL, not of this tool, and a vocabulary listing values
 * nothing produces teaches a consumer to branch on cases that never arrive.
 */
export const SOURCE_INDEX = 'index';
export const SOURCE_GRAPH = 'graph';
export const SOURCE_SEMANTIC = 'semantic';

/** The provenances that are NAVIGATION — authoritative, not augmentation. */
const NAVIGATIONAL = new Set([SOURCE_INDEX, SOURCE_GRAPH]);

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
  // A `[[link]]` INSIDE CODE OR A COMMENT IS NOT AN EDGE. Obsidian does not
  // create one, and since A3 labels these `graph` — declared authoritative
  // navigation — emitting them turns a long-standing looseness into a false
  // claim: a link shown as an EXAMPLE in a fenced block, or parked in an HTML
  // comment, would be presented as a page the vault actually points at. The
  // masks preserve length so nothing else shifts.
  // The delimiters are counted, not assumed to be three: CommonMark allows a
  // fence of N ≥ 3 backticks (a four-backtick fence legitimately CONTAINS a
  // triple one), and an inline span of N backticks closes only on N. Matching
  // exactly ``` and exactly ` left both shapes leaking example links into the
  // graph — found in review, with `` `[[ghost]]` `` as the smallest case.
  const mask = (s) => s.replace(/[^\n]/g, ' ');
  text = text
    .replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g,
      (m, lead) => lead + mask(m.slice(lead.length)))
    .replace(/<!--[\s\S]*?(?:-->|$)/g, mask)
    .replace(/(`+)(?:(?!\1)[\s\S])*\1/g, mask);
  // `[` excluded — this tool is a CORE READ PATH with no per-file byte cap,
  // and `includeNeighbors` defaults true, so this runs on every page body of
  // every call. The v0.71.0 bracket-bomb fix reached boundary-score,
  // llms-txt-exporter and wiki-graph-builder and MISSED this copy: measured
  // 178 / 715 / 2869 ms at 25 / 50 / 100 KB — byte-for-byte the pre-fix curve.
  const re = /(?<!!)\[\[([^\]\n[]+)\]\]/g;
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

// Parse the wiki-meta/catalog.md catalogue and return one candidate object
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
    // review+ pass 2 Reviewer A IMPORTANT — sibling-parser drift fix.
    // Previously `[[#Anchor]]` (bare anchor, no page slug) produced
    // an empty-target candidate that polluted IDF scoring + triggered
    // wasted REST probes. Align with `llms-txt-exporter.parseIndex`
    // which skips empty slugs.
    if (!target) continue;
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
    source: SOURCE_GRAPH,
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

// `isSafeVaultRelativePath` LIVED HERE and is gone. It was the second answer to
// the question `canonicalVaultPath` already answers, and the two disagreed on
// 688 of 3 074 swept inputs. Its last caller — the catalogue drill loop above —
// now calls the canonical one, so the function had no users left; deleting it
// rather than leaving it exported is the point, because an unused second answer
// is exactly what the next site reaches for. What changes for a caller that
// used it: a backslash and a `.` segment are now REFUSED instead of being
// treated as ordinary text, and a leading `/` is NORMALISED instead of refused.
// (v0.71.0 — see CHANGELOG.)

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
  // 1. Read the catalogue → parse candidates → score → pick top-N
  // -------------------------------------------------------------------------
  let candidates = [];
  let indexAvailable = true;
  try {
    // `wiki-meta/catalog.md`, or the pre-0.58.0 `wiki-meta/index.md`.
    let indexText;
    let lastErr;
    for (const rel of scaffoldCandidates('catalog')) {
      try {
        indexText = await deps.getFileContent(vault, rel);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        // A 404 means "not under this name" → try the legacy one. Anything
        // else is about the vault, so keep that error: it is the diagnosis.
        if (!shouldTryLegacyScaffold(e)) break;
      }
    }
    if (lastErr) throw lastErr;
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

  // THE BUDGET IS SPENT ON PAGES THAT CAN BE READ, not on refusals.
  //
  // The guard used to run INSIDE the drill, after `slice(0, primaryCap)` had
  // already handed out the slots — so a poisoned catalogue evicted legitimate
  // pages before anything was validated. Measured with the default cap of 5 and
  // a catalogue carrying three poisoned entries that outscore the real ones:
  // 3 healthy pages lost, and the envelope came back holding three placeholders
  // that name nothing readable. Whoever edits `wiki-meta/catalog.md` should not
  // get to choose which pages the model is allowed to see.
  //
  // REFUSE THE LINK, NEVER THE CALL — unchanged, and the reason it is a filter
  // and not a throw: these paths come out of a catalogue, not out of an
  // argument, so one poisoned wikilink must not kill the whole context pack.
  // The refusals are still reported, and now they are COUNTED (see
  // `refusedLinks` below) rather than collapsed into a single warning.
  const refusedLinks = [];
  const admissible = [];
  for (const s of scored) {
    if (s.score <= 0) continue;
    // THE CANONICAL GUARD, not the second one. This was the last caller of
    // `isSafeVaultRelativePath`, the looser of the two predicates the repo
    // carried for one question: swept over 3 074 inputs they disagreed on 688
    // (22 %), the loose one accepting C1 controls including U+009B, bare `.`
    // segments, `<result>` markup and mid-string backslashes. It reads
    // WIKILINKS OUT OF A VAULT FILE, so it gets the strict one.
    try {
      s.safePath = canonicalVaultPath(candidateToVaultPath(s.candidate.label), 'catalog link');
      admissible.push(s);
    } catch {
      refusedLinks.push(candidateToVaultPath(s.candidate.label));
    }
  }
  const ranked = admissible.slice(0, primaryCap);

  // ONE WARNING PER REFUSED LINK'S WORTH OF INFORMATION. `warnings` is
  // deduplicated at emit time (`[...new Set(warnings)]`), which turned N
  // refusals into a single `unsafe-index-target` — a consumer could not tell
  // one poisoned wikilink from forty. The count is the part that matters, so
  // it is carried IN the warning rather than by repeating a bare token that
  // the Set would collapse anyway.
  if (refusedLinks.length > 0) {
    warnings.push(`unsafe-index-target (${refusedLinks.length} link${refusedLinks.length === 1 ? '' : 's'} refused)`);
  }

  if (indexAvailable && ranked.length === 0) {
    warnings.push('no-primary-page-matched');
  }

  // -------------------------------------------------------------------------
  // 2. Drill into top-N primary pages — pull body + frontmatter in parallel
  // -------------------------------------------------------------------------
  const queryTokens = snippetTokens(query);
  const primaryPages = [];
  // The subset of `primaryPages` that was really read — placeholders excluded.
  // Only these may suppress a graph neighbour; see the exclusion set below.
  const included = [];
  const graphTargetByVia = []; // [{ targets: [...], via: filePath }]
  const citations = [];

  // Resolve each candidate to a vault path. Without a filesystem index we
  // can only address by basename; consumers route via Obsidian's wikilink
  // resolution. We attempt to GET the file via the obvious `wiki/<base>.md`
  // location AND, if that fails, fall back to a basename-only path that
  // the Obsidian REST API may still resolve.
  const drillResults = await Promise.allSettled(
    ranked.map(async ({ candidate, score, safePath }) => {
      // `safePath` was produced by `canonicalVaultPath` BEFORE the budget was
      // spent (see above) — a poisoned link never reaches this point, and never
      // costs a legitimate page its slot. `basePath` is kept for the
      // dead-wikilink placeholder, which names what the catalogue asked for.
      const basePath = candidateToVaultPath(candidate.label);
      // Two heuristic attempts: `wiki/<base>.md` first (most pages live
      // under wiki/), then bare `<base>.md` as a fallback for root-level
      // pages. The first success wins.
      const candidatePaths = [`wiki/${safePath}`, safePath];
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
          // Shared predicate (helpers/missing-read-guard.mjs). The local copy
          // this replaces carried BOTH original defects: `err.kind` was OR'd
          // rather than authoritative, and the message test matched a bare
          // `404` AND `enotfound` outright — so an unreachable vault was
          // recorded here as a CONFIRMED dead citation with `fetchError: null`,
          // which is a worse lie than the graph tools told.
          const isNotFound = isMissingReadError(err);
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
          // Provenance travels on the PLACEHOLDER too: a dead catalogue link is
          // still a catalogue link, and a consumer filtering by source must
          // not lose the gap it is being shown.
          source: SOURCE_INDEX,
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
        source: SOURCE_INDEX,
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
    // Surface specific warnings for the refusal categories BEFORE stripping the
    // internal flags from the envelope. `unsafePath` no longer occurs here —
    // the guard runs before the budget slice now, and refused links are counted
    // in one warning up there rather than deduplicated to a single token.
    if (page.missing && page.fetchError) {
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
    // The envelope keeps the placeholder — the consumer wants to see the gap —
    // but only a page that was really read may suppress a neighbour.
    if (!missing) included.push(publicFields);

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
  // ONLY PAGES THAT ARE REALLY IN THE ENVELOPE EXCLUDE A NEIGHBOUR.
  //
  // This was built from every entry that reached `primaryPages`, and that array
  // carries PLACEHOLDERS: a dead wikilink produces one, with `missing: true`
  // and an empty body. So a single perfectly canonical catalogue entry pointing
  // at a page that does not exist was enough to delete a legitimate neighbour
  // from the pack — and silently, because a 404 emits no warning at all (that
  // is deliberate: a dead wikilink is not an error). The consumer saw a
  // complete-looking envelope with a neighbour missing and nothing to explain
  // it. Suppressing a neighbour is only justified by a page the reader can
  // actually read, which is what `included` means here.
  const primaryBasenames = new Set(
    included.map((p) => {
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
  let semanticFreshness = null;
  let folderExcludedHits = 0;
  let archivesExcludedHits = 0;
  const exclusion = resolveExcludeFolders(args.excludeFolders, _deps.env);
  if (chunkCap > 0) {
    try {
      // C4 — the same default exclusion the `search_smart` tool applies. This
      // path calls the REST helper DIRECTLY, so it does not inherit the tool's
      // behaviour: without this it would surface exactly what the tool hides,
      // and the two would disagree about the same vault.
      // OVER-FETCH, like the tool does. Asking for exactly  and then
      // cutting router-side returned a short pack while eligible hits sat just
      // past the window — the cut is 41.6% of the corpus by default.
      const scArgs = { limit: overfetchLimit(chunkCap, { excluding: exclusion.folders.length > 0, archives: true }) };
      if (exclusion.folders.length) scArgs.excludeFolders = [...exclusion.folders];
      const sm = await deps.searchSmart(vault, query, scArgs);
      let rawChunks = Array.isArray(sm?.results)
        ? sm.results
        : Array.isArray(sm?.chunks)
          ? sm.chunks
          : Array.isArray(sm)
            ? sm
            : null;
      // A 200 WITH THE WRONG SHAPE IS NOT AN EMPTY RESULT SET — the rule the
      // rest of this codebase applies to listings, missing here. A successful
      // response the router cannot read (`{error: "index still loading"}`,
      // `{results: {...}}`) was coerced to `[]` and presented as a semantic
      // search that ran and found nothing. That is the same lie this item exists
      // to remove, one layer up. Found in adversarial review.
      if (rawChunks === null) warnings.push('semantic-payload-unrecognised');
      // AN ENTRY THAT CARRIES NEITHER A PATH NOR TEXT IS NOT A CHUNK. Mapped
      // anyway it became `{path:'', text:'', score:0}` — a fabricated result
      // indistinguishable from a real one that happened to be empty. The
      // container being an array was checked; its members were not.
      // Router-side, for the same reason the tool does it: the guarantee cannot
      // rest on the bridge honouring a filter we could not verify.
      if (exclusion.folders.length && Array.isArray(rawChunks)) {
        const { kept, excluded } = partitionByFolders(rawChunks, exclusion.folders);
        folderExcludedHits = excluded;
        if (excluded > 0) rawChunks = kept;
      }
      // ARCHIVED DELIBERATION IS EXCLUDED HERE TOO. `search_smart` has dropped
      // it since v0.54.0; this path calls the REST helper directly and never
      // did, so the same vault answered differently through the two tools —
      // the pack resurfacing exactly what consolidation moved out of the way.
      if (Array.isArray(rawChunks)) {
        const { data: trimmed } = filterArchiveResults({ results: rawChunks }, { includeArchives: false });
        archivesExcludedHits = rawChunks.length - trimmed.results.length;
        rawChunks = trimmed.results;
      }
      const nonBlank = (v) => typeof v === 'string' && v.trim() !== '';
      const usable = (rawChunks || []).filter((c) => {
        // TRIMMED, not merely truthy: `{path: "   ", text: ""}` passed a
        // truthiness test and became a chunk made of whitespace.
        const p = nonBlank(c?.path) || nonBlank(c?.filename);
        const t = nonBlank(c?.text) || nonBlank(c?.excerpt) || nonBlank(c?.content);
        return p || t;
      });
      if (rawChunks && usable.length !== rawChunks.length) {
        warnings.push('semantic-payload-unrecognised');
      }
      semanticChunks = usable.slice(0, chunkCap).map((chunk) => ({
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
        source: SOURCE_SEMANTIC,
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
  // 4bis. A1 — freshness of the pages those chunks came from
  // -------------------------------------------------------------------------
  // OUTSIDE the try above, deliberately. In it, any throw here would be
  // classified by that catch as a semantic-search failure — a wrong diagnosis
  // written into the envelope, which is the failure mode this whole item exists
  // to remove. `freshnessFor` reads local disk only, answers `null` rather than
  // guessing for a vault this machine has no disk for, and never throws.
  if (semanticChunks.length > 0) {
    semanticFreshness = freshnessFor(
      vault,
      semanticChunks.map((c) => c.path).filter(Boolean),
      { fs: _deps.fs },
    );
    if (semanticFreshness?.checkable) {
      // JOIN ON WHAT WAS ASKED, NOT ON WHAT WAS RESOLVED. A row is keyed by the
      // PAGE its record is about, while a chunk carries whatever the bridge
      // returned — possibly a block anchor, possibly a non-canonical spelling
      // the assessor normalised. Matching those by string dropped the
      // annotation from the very chunk that had raised the warning. Each row
      // now lists the requested paths that reached it, so the join is exact.
      const byPath = new Map();
      for (const p of semanticFreshness.pages) {
        byPath.set(p.path, p.state);
        for (const requested of p.requested || []) byPath.set(requested, p.state);
      }
      for (const chunk of semanticChunks) {
        const state = byPath.get(chunk.path);
        if (state) chunk.freshness = state;
      }
      if (semanticFreshness.summary.doubtful > 0) {
        warnings.push('semantic-results-possibly-stale');
        const note = freshnessNote(semanticFreshness);
        if (note) suggestedActions.push(note);
      }
      if (semanticFreshness.summary.pageMissing > 0) {
        warnings.push('semantic-hit-page-missing');
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4ter. A3 — the agentic-first guard
  // -------------------------------------------------------------------------
  // NAVIGATION IS PRIMARY; THE INDEX IS AUGMENTATION. The envelope has always
  // ordered it that way, but ordering is a convention a consumer can ignore,
  // and nothing said anything when the navigational half came back EMPTY. A
  // pack whose only content is semantic chunks is not a weaker answer of the
  // same kind — it is an answer with no navigational anchor at all, and the
  // whole point of the borrowing is that such an answer must not be the sole
  // support for a factual claim.
  //
  // A page that could NOT be read does not count as an anchor: a placeholder
  // names a gap, it does not carry content. `included` is exactly that subset,
  // which is why it is used here rather than `primaryPages`.
  const navigationalAnchors = included.length + graphNeighbors.length;
  if (navigationalAnchors === 0 && semanticChunks.length > 0) {
    warnings.push('answer-relies-on-semantic-only');
    // THE ACTION MUST BE PERFORMABLE. "Open the pages they name" is impossible
    // for a chunk that names none — some bridge payloads carry text only — and
    // an instruction the reader cannot follow is worse than none, because it
    // reads as though verification were available.
    // TRIMMED. A whitespace path is truthy and is not a page anyone can open,
    // so counting it as "named" put back the unperformable instruction the
    // previous round removed, one shape narrower (found in review).
    const named = semanticChunks.filter((c) => typeof c.path === 'string' && c.path.trim()).length;
    const pathless = semanticChunks.length - named;
    suggestedActions.push(
      'Nothing in this pack came from navigation — no catalogue page was read and no wikilink was '
      + 'followed; every result is a semantic chunk. Treat these as pointers to verify, not as '
      + 'support for a factual claim: '
      + (named > 0
        ? `open the ${named} page(s) they name (get_file), or search for the terms directly (search), before relying on them.`
        : 'search for the terms directly (search), because none of them names a page to open.')
      + (pathless > 0
        ? ` ${pathless} chunk(s) carry no path at all and cannot be opened or verified — do not cite them.`
        : ''),
    );
  }

  // -------------------------------------------------------------------------
  // 5. Compose the v1 envelope
  // -------------------------------------------------------------------------
  // sanitizeResponse strips ANSI/control chars from every string field in
  // the response — vault content is attacker-controlled the same way as
  // search hits, so the same hygiene applies. Non-string scalars (scores,
  // booleans) pass through untouched.
  return ({
    version: 'v1',
    query: sanitizeLabel(query),
    vault: vault.name,
    primaryPages,
    semanticChunks,
    graphNeighbors,
    citations,
    // ADDITIVE, and present only when there is something to say — the v1
    // contract makes every DECLARED field mandatory and allows new optional
    // ones. A `checkable: false` block is still worth emitting (it tells the
    // consumer the silence is "could not look", not "looked and found nothing");
    // `null` is not, so the key is simply absent then.
    ...(semanticFreshness ? { semanticFreshness } : {}),
    ...(chunkCap > 0 && exclusionReport({
      ...exclusion,
      excluded: folderExcludedHits,
      shortPage: folderExcludedHits > 0 && semanticChunks.length < chunkCap,
    })
      ? {
        folderExclusion: exclusionReport({
          ...exclusion,
          excluded: folderExcludedHits,
          shortPage: folderExcludedHits > 0 && semanticChunks.length < chunkCap,
        }),
      }
      : {}),
    ...(archivesExcludedHits > 0 ? { archivesExcluded: archivesExcludedHits } : {}),
    // A3 — the provenance vocabulary, stated rather than left to be inferred
    // from the values that happen to appear. A consumer branching on `source`
    // can see the whole closed set and which half of it is authoritative,
    // without having to receive an example of each first.
    provenance: {
      values: [SOURCE_INDEX, SOURCE_GRAPH, SOURCE_SEMANTIC],
      navigational: [...NAVIGATIONAL],
      augmentation: [SOURCE_SEMANTIC],
      note:
        'Navigation (index, graph) is primary and authoritative; semantic chunks are an '
        + 'augmentation — good for fit-by-meaning, never the sole support for a factual claim, '
        + 'and possibly older than the page (see each chunk\'s `freshness`).',
    },
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
  SUMMARY_MAX_CHARS,
  SNIPPET_MAX_CHARS,
};
