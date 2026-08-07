/**
 * wiki-graph-builder — DETERMINISTIC assembler of a UA-schema knowledge
 * graph from a vault's wiki pages, digests, and index.
 *
 * Roadmap item #1 (understand-anything-roadmap), step 2 (+ partial step 4:
 * it returns the graph object; the tool writes it to the two locations).
 * Pure-functional, NO I/O, deterministic — same input ⇒ same output
 * byte-for-byte (modelled on `llms-txt-exporter.buildLlmsTxt`). Timestamps
 * are INJECTED (`generatedAt`) so the module is unit-testable.
 *
 * What it maps (no LLM):
 *   - each wiki page                       → `article` node
 *   - digest concepts (per page)           → `entity` nodes (deduped global)
 *   - digest claims (per page)             → `claim` nodes (page-namespaced)
 *   - `[[wikilinks]]` between pages        → `related` edges
 *   - referenced sources                   → `source` nodes + `cites` edges
 *       (frontmatter `sources:`, `^[file:lines]` citations, `![[x.pdf]]`
 *        embeds) — created EVEN IF the referenced file matches `.wikiignore`
 *        (the "source référencée" invariant, Roland 2026-05-29)
 *   - `wiki-meta/catalog.md` sections        → `topic` nodes + `categorized_under`
 *                                            edges (the human-curated taxonomy)
 *   - graph link topology                  → `layers[]` via Louvain community
 *                                            detection (#1 step 2.5) — every
 *                                            node lands in exactly one layer
 *
 * Deferred to later commits (kept out of the deterministic core):
 *   - LLM enrich: builds_on / contradicts / exemplifies (#1 step 3)
 *   - autogen of missing/stale digests (#1 step 1)
 *   - tour[] generation (#3)
 *
 * Reuses `parseFrontmatter` + `parseIndex` from llms-txt-exporter,
 * `parseDigest` from digest-generator, and `detectCommunities` from louvain
 * rather than re-deriving them.
 */

import { parseFrontmatter, parseIndex } from './llms-txt-exporter.mjs';
import { parseDigest, digestPathForPage } from './digest-generator.mjs';
import { detectCommunities } from './louvain.mjs';
import { countProseWords, SUBSTANCE_MEASURE } from './boundary-score.mjs';
import { cmp } from './total-order.mjs';
import {
  emptyGraph,
  articleId,
  entityId,
  topicId,
  claimId,
  sourceId,
  kebab,
} from './wiki-graph-schema.mjs';

const SUMMARY_MAX_CHARS = 280;

// ---------------------------------------------------------------------------
// Small extractors (builder-local — kept here rather than imported from a
// tool's `_internals` to avoid coupling a helper to a tool)
// ---------------------------------------------------------------------------

// The `[` excluded from every character class below is LOAD-BEARING, not
// cosmetic. Without it, a page containing a long run of `[` makes each of the N
// start positions consume the whole tail and then backtrack it away — the pass
// goes quadratic. Measured on this builder before the fix: 25 KB of `[` = 178
// ms, 50 KB = 711 ms, 100 KB = 2861 ms (exactly ×4 per doubling), and the
// builder scans each body three times, so one 100 KB page cost 8.7 s of a
// single `build_wiki_graph` call. There is no per-file byte cap on this path,
// and a 1 MB note is an ordinary size — that is a session-long hang on a
// long-lived stdio server.
//
// `countProseWords` in boundary-score.mjs already carried this exact fix, with
// this exact reasoning, one file away; it was never propagated to its siblings.
//
// An earlier version of this comment claimed "a capability test now fails if
// any wikilink-shaped regex accepts `[` again". THAT TEST DID NOT EXIST — the
// only guard was a time budget on three hand-picked functions, and the fix
// went on to miss SEVEN further sites, including `get_wiki_context_pack` (a
// core read tool, no byte cap, neighbours on by default) and
// `filters/strip_md.mjs` at 5431 ms on four kilobytes. A comment describing a
// mechanism nobody built is worse than no comment: it stops the next reader
// checking. The test exists now — `GUARD: EVERY wikilink-shaped regex in the
// shipped tree is linear` in tests/security-invariants.test.mjs extracts every
// such regex from src/ scripts/ hooks/ bin/ and RUNS it against a bracket
// bomb, so this sentence is checkable rather than merely written.
//
// Forbidding `[` inside a link target makes a malformed run fail at its second
// character. The only inputs that parse differently are already-malformed
// nested forms like `[[a[b]]`, which were never valid link targets.

// Non-embed wikilinks `[[target]]` (negative lookbehind excludes `![[...]]`).
const WIKILINK_RE = /(?<!!)\[\[([^\]\n[]+)\]\]/g;
// Embeds `![[target]]`.
const EMBED_RE = /!\[\[([^\]\n[]+)\]\]/g;
// Inline line-citation marker `^[ref]` (caret then bracket — distinct from
// markdown footnotes `[^1]` and Obsidian block refs `[[page^block]]`).
const CITATION_RE = /\^\[([^\]\n[]+)\]/g;

/** Strip a `[[link]]` target's `|alias` / `#heading` / `^block` decorations. */
function bareTarget(raw) {
  return String(raw).split(/[|#^]/)[0].trim();
}

/** Distinct non-embed wikilink targets (bare basenames/paths) in a body. */
function extractWikilinks(body) {
  if (typeof body !== 'string' || !body) return [];
  const out = new Set();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const t = bareTarget(m[1]);
    if (t) out.add(t);
  }
  return [...out];
}

/** Distinct embed targets `![[x]]` in a body. */
function extractEmbeds(body) {
  if (typeof body !== 'string' || !body) return [];
  const out = new Set();
  for (const m of body.matchAll(EMBED_RE)) {
    const t = bareTarget(m[1]);
    if (t) out.add(t);
  }
  return [...out];
}

/**
 * Extract source refs from `^[ref]` line citations. The ref is the part
 * before a trailing line range (`:42-58` or `#L42-L58` / `#L42`). Line
 * citations target local files, so a trailing `:digits(-digits)` is treated
 * as a range, not a URL port (URLs belong in frontmatter `sources:`).
 */
function extractCitations(body) {
  if (typeof body !== 'string' || !body) return [];
  const out = new Set();
  for (const m of body.matchAll(CITATION_RE)) {
    let ref = m[1].trim();
    ref = ref.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?:-\d+)?$/, '');
    ref = ref.trim();
    if (ref) out.add(ref);
  }
  return [...out];
}

/** Coerce a frontmatter `sources:` value (array | comma/space string) → string[]. */
function coerceSources(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

/** Coerce a frontmatter `tags:` value (array | comma/space string) → string[]. */
function coerceTags(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Copy a parsed-frontmatter object, dropping prototype-pollution keys
 * (`__proto__` / `constructor` / `prototype`). The raw frontmatter is
 * embedded verbatim into `knowledgeMeta.frontmatter` and shipped in the graph
 * JSON; a `constructor:` key in a page's frontmatter would otherwise become an
 * own-enumerable property a naive downstream consumer could mishandle.
 */
const DANGEROUS_FM_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function safeFrontmatter(fm) {
  if (!fm || typeof fm !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(fm)) {
    if (DANGEROUS_FM_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** First-paragraph summary fallback, capped. */
function firstParagraphSummary(body) {
  if (typeof body !== 'string') return '';
  const trimmed = body.trim();
  if (!trimmed) return '';
  const stopIdx = trimmed.search(/\n\s*\n|\n#{1,6}\s/);
  const slice = stopIdx >= 0 ? trimmed.slice(0, stopIdx) : trimmed;
  const cleaned = slice
    .replace(/^>\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    // `[` excluded from every class — see the note on WIKILINK_RE above. This
    // summary pass is the builder's THIRD scan of the same body, so it paid
    // the quadratic cost a third time.
    .replace(/!\[\[[^\]\n[]*\]\]/g, '') // embeds (incl. binary refs)
    .replace(/\^\[[^\]\n[]*\]/g, '') // ^[citation] markers
    .replace(/\[\[([^\]|\n[]+)(?:\|([^\]\n[]+))?\]\]/g, (_m, t, a) => (a || t))
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > SUMMARY_MAX_CHARS
    ? `${cleaned.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : cleaned;
}

/** Basename of a vault path, without `.md`. */
function basenameNoMd(p) {
  const norm = String(p).replace(/\\/g, '/');
  const base = norm.split('/').pop() || norm;
  return base.replace(/\.md$/i, '');
}

/** Does a wikilink/embed target look like a non-markdown file (→ a source)? */
function looksLikeBinaryRef(target) {
  const base = String(target).split('/').pop() || target;
  // Has an extension that is not `.md`.
  return /\.[a-z0-9]+$/i.test(base) && !/\.md$/i.test(base);
}

/** Display name for a source ref (basename for paths, the URL for URLs). */
function sourceName(ref) {
  if (/^https?:\/\//i.test(ref)) return ref;
  return String(ref).split('/').pop() || ref;
}

/**
 * Turn a Louvain community partition into UA `Layer[]`. Each community becomes
 * one layer whose `name` is its highest-degree member — the community's hub,
 * usually a `topic` node or a well-linked article — with ties broken by the
 * lowest id. `id` is `layer:community-<N>` where N (1-based) follows the
 * deterministic community order `detectCommunities` returns (communities sorted
 * by their smallest member id), so the array is already canonically ordered.
 *
 * @param {string[]} nodeIds  every node id in the graph
 * @param {Array<{source:string,target:string,weight?:number}>} edges
 * @param {Map<string,object>} nodesById  id → node (for the hub's display name)
 * @param {number} resolution  Louvain resolution γ
 * @returns {Array<{id:string,name:string,description:string,nodeIds:string[],method:string}>}
 */
function buildLayers(nodeIds, edges, nodesById, resolution) {
  const communities = detectCommunities(nodeIds, edges, { resolution });
  if (communities.length === 0) return [];

  // Undirected weighted degree per node — used only to pick each community's
  // hub (the node that best labels the group).
  const degree = new Map();
  for (const e of edges) {
    const w = typeof e.weight === 'number' && Number.isFinite(e.weight) ? e.weight : 1;
    degree.set(e.source, (degree.get(e.source) || 0) + w);
    degree.set(e.target, (degree.get(e.target) || 0) + w);
  }

  return communities.map((members, i) => {
    // `members` is already id-sorted, so a strict `>` keeps the lowest id on a
    // degree tie — deterministic hub selection.
    let hub = members[0];
    let hubDegree = degree.get(hub) || 0;
    for (const id of members) {
      const d = degree.get(id) || 0;
      if (d > hubDegree) {
        hubDegree = d;
        hub = id;
      }
    }
    const hubNode = nodesById.get(hub);
    const name = (hubNode && typeof hubNode.name === 'string' && hubNode.name) || hub;
    const count = members.length;
    return {
      id: `layer:community-${i + 1}`,
      name,
      description: `Community of ${count} node${count === 1 ? '' : 's'} · detected via Louvain modularity`,
      nodeIds: members,
      method: 'louvain',
    };
  });
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a UA-schema KnowledgeGraph from vault inputs.
 *
 * @param {object} input
 * @param {string} input.vaultName Vault/project name (→ project.name)
 * @param {string} [input.indexMd=''] Content of wiki-meta/catalog.md (topics/layers)
 * @param {Array<{path:string, content:string}>} [input.pages=[]] Wiki content
 *   pages (vault-relative path + raw markdown). The CALLER should pass only
 *   non-ignored content pages; the builder also defensively re-filters when
 *   `ignore` is provided.
 * @param {Array<{path:string, content:string}>} [input.digests=[]] Digest
 *   sidecar files (raw content). Parsed + keyed by their `for:` field.
 * @param {'knowledge'|'codebase'} [input.kind='knowledge']
 * @param {{isIgnored:(p:string)=>boolean}} [input.ignore=null] Optional
 *   wiki-ignore matcher — filters CONTENT pages only (NOT source refs).
 * @param {string} [input.generatedAt=''] ISO timestamp (injected, determinism)
 * @param {string} [input.description='']
 * @param {string} [input.gitCommitHash='']
 * @returns {object} KnowledgeGraph (UA schema; `validateGraph` should pass)
 */
export function buildWikiGraph({
  vaultName,
  indexMd = '',
  pages = [],
  digests = [],
  kind = 'knowledge',
  ignore = null,
  generatedAt = '',
  description = '',
  gitCommitHash = '',
  communityResolution = 1,
} = {}) {
  if (typeof vaultName !== 'string' || !vaultName) {
    throw new TypeError('buildWikiGraph: vaultName is required (string)');
  }
  if (!Array.isArray(pages)) {
    throw new TypeError('buildWikiGraph: pages must be an array');
  }
  if (!Array.isArray(digests)) {
    throw new TypeError('buildWikiGraph: digests must be an array');
  }

  // Sort inputs by path for ORDER-INDEPENDENCE. The builder must be
  // deterministic regardless of the order the caller enumerated pages/digests
  // (the Local REST API listing order is not guaranteed stable), and this
  // makes first-wins basename-collision resolution deterministic too.
  //
  // `cmp` (code-unit), NOT `localeCompare`. localeCompare is NOT A TOTAL ORDER:
  // it returns 0 for distinct strings (NFC vs NFD `café.md` — routine in a
  // vault synced between macOS and Linux — and a soft hyphen U+00AD), and
  // `Array.prototype.sort` then falls back to insertion order. So the caller's
  // enumeration order leaked straight into the output bytes, which is exactly
  // what this sort exists to prevent: the same vault produced two different
  // graph hashes. It is also ICU-version and locale dependent, so two machines
  // emitted different bytes for the same vault.
  //
  // boundary-score.mjs and louvain.mjs both already carry long comments saying
  // precisely this — and this builder, which feeds them both, did the thing
  // those comments forbid. A capability test now fails on any localeCompare in
  // a sort comparator.
  const orderedPages = [...pages].sort((a, b) => cmp(a?.path ?? '', b?.path ?? ''));
  const orderedDigests = [...digests].sort((a, b) => cmp(a?.path ?? '', b?.path ?? ''));

  const graph = emptyGraph({
    name: vaultName,
    kind,
    description,
    // emptyGraph's field is `analyzedAt` — map the injected `generatedAt`
    // onto it so `project.analyzedAt` is actually populated (it was silently
    // dropped before — review CRITICAL).
    analyzedAt: generatedAt,
    gitCommitHash,
  });

  // Content pages = the non-ignored ones. The ignore filter governs CONTENT
  // enumeration only; source refs below bypass it by design (the invariant).
  const contentPages = orderedPages.filter(
    (p) => p && typeof p.path === 'string' && (!ignore || !ignore.isIgnored(p.path)),
  );

  // Parse digests, keyed by the page path they summarise (`for:`).
  const digestByPage = new Map();
  const digestsRejected = [];
  for (const d of orderedDigests) {
    if (!d || typeof d.content !== 'string') continue;
    let parsed;
    try {
      parsed = parseDigest(d.content);
    } catch {
      continue; // malformed digest → skip (defensive)
    }
    if (!parsed.for) continue;
    const claimed = parsed.for.replace(/\\/g, '/');
    // A digest may only speak for the page whose sidecar slot it OCCUPIES.
    //
    // Without this check `for:` was taken on trust, so any file under
    // `wiki-meta/digests/` could claim any page — and because the digest list
    // is path-sorted and this is a last-wins `Map.set`, a later-sorting
    // attacker file REPLACED the legitimate digest. The forged claims and
    // entities were then namespaced under the VICTIM page's stem, so the graph
    // (and every agent reading it) attributed the text to a page that never
    // said it. Reproduced by pen test: `wiki-meta/digests/zzz-attacker.md`
    // claiming `wiki/security-policy.md` injected "This policy permits sending
    // API keys over email" as a claim of the security policy.
    //
    // `digestPathForPage` is the ONE mapping both writers use, and it already
    // refuses absolute paths, `..` and drive letters — so binding to it also
    // means a `for:` value cannot name anything outside the vault.
    let expected;
    try {
      expected = digestPathForPage(claimed);
    } catch {
      digestsRejected.push({ digest: d.path, claimed, reason: 'unsafe `for:` path' });
      continue;
    }
    const actual = String(d.path ?? '').replace(/\\/g, '/');
    if (actual !== expected) {
      digestsRejected.push({ digest: actual, claimed, expected, reason: 'digest does not occupy the sidecar slot of the page it claims' });
      continue;
    }
    digestByPage.set(claimed, parsed);
  }

  // Node accumulators keyed by id (dedup). Maps preserve insertion order;
  // we sort canonically at the end.
  const nodesById = new Map();
  const edgeKeys = new Set();
  const edges = [];

  function addNode(node) {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
    return node.id;
  }
  function addEdge(source, target, type, weight, extra = {}) {
    if (!source || !target || source === target) return;
    const key = `${source} ${target} ${type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, type, direction: 'forward', weight, ...extra });
  }

  // basename(lowercase) → articleId, for resolving BARE wikilinks/bullets.
  const articleByBasename = new Map();
  // All article node ids, for resolving PATH-QUALIFIED links exactly.
  const articleIds = new Set();

  // Resolve a wikilink / embed / citation / index-bullet target to an article
  // id. A PATH-QUALIFIED target (`wiki/y/dup`) resolves to its EXACT article
  // first; only a BARE target (`dup`) falls back to basename (first-wins),
  // mirroring Obsidian's "shortest unique path, else full path" semantics.
  // Without this, `[[wiki/y/dup]]` wrongly resolves to `wiki/x/dup` on a
  // basename collision (codex review+ P2).
  function resolveArticle(target) {
    if (typeof target !== 'string' || !target) return null;
    // `articleId` is the canonical normaliser (forward slashes, strip `.md`),
    // so the id minted here matches the ids stored in `articleIds` exactly.
    const exactId = articleId(target);
    const tnorm = exactId.slice('article:'.length);
    if (!tnorm) return null;
    // 1. Exact vault-root path — `[[wiki/sub/page]]` (absolute-link format).
    if (articleIds.has(exactId)) return exactId;
    // 2. BARE target (no slash) — basename map, first-wins by path sort
    //    (Obsidian's "shortest path when possible" default).
    if (!/[\\/]/.test(target)) {
      return articleByBasename.get(basenameNoMd(target).toLowerCase()) || null;
    }
    // 3. PATH-QUALIFIED but not an exact vault-root path → segment-aligned
    //    SUFFIX match (Obsidian resolves a relative link `[[sub/page]]` to the
    //    article whose vault path ends with `sub/page`). Resolve ONLY when that
    //    suffix is UNIQUE: a stale `[[wiki/GONE/dup]]` matches nothing (→ null,
    //    no wrong edge), and an ambiguous suffix refuses rather than guess
    //    (reconciles codex review+ pass 3 "no wrong fallback" with pass 4
    //    "resolve relative links"). `..`-relative links aren't path-resolved
    //    against the source dir (rare) — they only match via this suffix rule.
    const suffix = `/${tnorm}`;
    let match = null;
    let count = 0;
    for (const aid of articleIds) {
      const p = aid.slice('article:'.length);
      if (p === tnorm || p.endsWith(suffix)) {
        match = aid;
        if (++count > 1) break;
      }
    }
    return count === 1 ? match : null;
  }

  // ---- Pass 1: article nodes -------------------------------------------------
  const pageMeta = []; // [{ path, body, frontmatter, id }] in input order
  for (const page of contentPages) {
    const path = page.path.replace(/\\/g, '/');
    const { frontmatter, body } = parseFrontmatter(
      typeof page.content === 'string' ? page.content : '',
    );
    const id = articleId(path);
    const title =
      (typeof frontmatter.title === 'string' && frontmatter.title.trim()) ||
      basenameNoMd(path);
    const summary =
      (typeof frontmatter.summary === 'string' && frontmatter.summary.trim()) ||
      firstParagraphSummary(body);
    const wikilinks = extractWikilinks(body);
    const tags = ['article', ...coerceTags(frontmatter.tags)];
    const sourceUrl =
      (typeof frontmatter['source-url'] === 'string' && frontmatter['source-url']) ||
      (typeof frontmatter.source_url === 'string' && frontmatter.source_url) ||
      undefined;

    const node = {
      id,
      type: 'article',
      name: title,
      filePath: path,
      summary: summary || '',
      tags,
      complexity: 'simple',
      knowledgeMeta: {
        format: 'obsidian',
        wikilinks,
        frontmatter: safeFrontmatter(frontmatter),
        // C10 — how much page there IS, recorded at build time because the
        // builder is the only place holding the content. Deliberately NOT
        // folded into `complexity`: that field is part of the verbatim
        // Understand-Anything mirror (it is in `validateGraph`'s enum and the
        // UA dashboard reads it), so redefining `simple|moderate|complex` to
        // mean thin/medium/thick would silently change what a third-party UA
        // consumer sees. `knowledgeMeta` is the router's own extension bag —
        // nothing in the schema validates it, and it already carries
        // Obsidian-only keys. Extensions belong in the extension bag.
        substance: { words: countProseWords(body), measure: SUBSTANCE_MEASURE },
        ...(sourceUrl ? { sourceUrl } : {}),
      },
    };
    addNode(node);
    articleIds.add(id);
    const baseKey = basenameNoMd(path).toLowerCase();
    if (!articleByBasename.has(baseKey)) articleByBasename.set(baseKey, id);
    pageMeta.push({ path, body, frontmatter, id });
  }

  // ---- Pass 2: entities/claims (digests) + wikilinks + sources --------------
  for (const { path, body, frontmatter, id } of pageMeta) {
    // Digest → entity + claim nodes.
    const digest = digestByPage.get(path);
    if (digest) {
      for (const concept of digest.concepts || []) {
        if (typeof concept !== 'string' || !concept.trim()) continue;
        const eid = entityId(concept);
        if (!eid || eid === 'entity:') continue;
        addNode({
          id: eid,
          type: 'entity',
          name: concept.trim(),
          summary: '',
          tags: ['entity'],
          complexity: 'simple',
        });
        addEdge(id, eid, 'related', 0.4);
      }
      for (const claim of digest.claims || []) {
        if (typeof claim !== 'string' || !claim.trim()) continue;
        if (!kebab(claim)) continue; // skip claims with no word content
        const cid = claimId(path, claim);
        addNode({
          id: cid,
          type: 'claim',
          name: claim.trim().slice(0, 120),
          summary: claim.trim(),
          tags: ['claim'],
          complexity: 'simple',
        });
        addEdge(id, cid, 'related', 0.5);
      }
    }

    // Wikilinks → related edges between articles (path-qualified or basename).
    for (const target of extractWikilinks(body)) {
      const targetId = resolveArticle(target);
      if (targetId) addEdge(id, targetId, 'related', 0.6);
    }

    // Embeds: `.md`-ish → related article link; binary → source ref.
    const sourceRefs = new Set();
    for (const target of extractEmbeds(body)) {
      if (looksLikeBinaryRef(target)) {
        sourceRefs.add(target);
      } else {
        const targetId = resolveArticle(target);
        if (targetId) addEdge(id, targetId, 'related', 0.6);
      }
    }

    // Source refs: frontmatter sources: + ^[citations] + binary embeds.
    // THE INVARIANT — these become `source` nodes regardless of `.wikiignore`.
    for (const ref of coerceSources(frontmatter.sources)) sourceRefs.add(ref);
    for (const ref of extractCitations(body)) sourceRefs.add(ref);
    for (const ref of sourceRefs) {
      const isUrl = /^https?:\/\//i.test(ref);
      // A non-URL ref that resolves to an existing content page is an article
      // cross-reference, not an external source — emit `related` to that
      // article instead of minting a duplicate `source:` node for the file.
      if (!isUrl) {
        const refArticle = resolveArticle(ref);
        if (refArticle && refArticle !== id) {
          addEdge(id, refArticle, 'related', 0.6);
          continue;
        }
      }
      const sid = sourceId(ref);
      if (!sid || sid === 'source:') continue;
      addNode({
        id: sid,
        type: 'source',
        name: sourceName(ref),
        summary: '',
        tags: ['source'],
        complexity: 'simple',
        ...(isUrl ? { knowledgeMeta: { sourceUrl: ref } } : {}),
      });
      addEdge(id, sid, 'cites', 0.7);
    }
  }

  // ---- Pass 3: topic nodes from index.md sections ---------------------------
  // index.md sections become `topic` nodes + `categorized_under` edges — the
  // human-curated taxonomy. They no longer populate `layers[]`: that is now the
  // Louvain community partition built in Pass 4 (roadmap #1 step 2.5). The two
  // groupings are complementary — a hand-written table of contents (topics) vs
  // the clusters the link structure actually forms (layers).
  if (typeof indexMd === 'string' && indexMd.trim()) {
    let sections = [];
    try {
      sections = parseIndex(indexMd);
    } catch {
      sections = [];
    }
    for (const section of sections) {
      if (!section || !section.title) continue;
      // Resolve the section's bullets to article ids (skip meta pages that
      // aren't content pages, e.g. [[overview]]/[[log]] under wiki-meta/).
      const memberIds = [];
      for (const bullet of section.bullets || []) {
        const aid = resolveArticle(bullet.pageSlug);
        if (aid && !memberIds.includes(aid)) memberIds.push(aid);
      }
      // Skip taxonomy entries that don't categorise any actual content page —
      // avoids orphan topic nodes (e.g. the "Wiki Core" nav section).
      if (memberIds.length === 0) continue;
      const tid = topicId(section.title);
      addNode({
        id: tid,
        type: 'topic',
        name: section.title,
        summary: '',
        tags: ['topic'],
        complexity: 'simple',
      });
      for (const aid of memberIds) addEdge(aid, tid, 'categorized_under', 0.5);
    }
  }

  // ---- Pass 4: layers = Louvain communities over the whole graph ------------
  // Community detection runs on the FULL node/edge set (articles, entities,
  // claims, sources AND the topic nodes built above), so the human taxonomy
  // informs the partition without dictating it, and every node lands in exactly
  // one layer — the partition that color-by-community and hub detection want.
  // Deterministic (see louvain.mjs), so byte-stability is preserved.
  const layers = buildLayers(
    [...nodesById.keys()],
    edges,
    nodesById,
    communityResolution,
  );

  // ---- Canonical ordering (stable, diff-friendly) ---------------------------
  // `cmp` (code-unit), NOT `localeCompare`. See the note on the page ordering
  // above: localeCompare is not a total order, so the sort silently fell back
  // to enumeration order for NFC/NFD-equivalent ids and the graph hash changed
  // without the vault changing.
  graph.nodes = [...nodesById.values()].sort((a, b) => cmp(a.id, b.id));
  graph.edges = edges.sort(
    (a, b) =>
      cmp(a.source, b.source) ||
      cmp(a.target, b.target) ||
      cmp(a.type, b.type),
  );
  // `layers` is already canonically ordered: detectCommunities sorts communities
  // by their smallest member id, and the `community-N` numbering follows that.
  graph.layers = layers;
  // tour[] left empty (deferred to #3).

  // Surface slot-mismatched digests. They are DROPPED (that is the security
  // invariant), but a silent drop leaves the operator with no way to tell a
  // forgery from a misplaced legitimate sidecar — and the first version of
  // this fix collected them into a variable nothing ever read. Non-enumerable
  // so it cannot leak into the serialized graph or change its hash.
  if (digestsRejected.length) {
    Object.defineProperty(graph, 'digestsRejected', {
      value: digestsRejected,
      enumerable: false,
      configurable: true,
      writable: true, // else a later `graph.digestsRejected = …` throws (ESM is strict)
    });
  }
  return graph;
}

export const _internals = {
  extractWikilinks,
  extractEmbeds,
  extractCitations,
  coerceSources,
  coerceTags,
  firstParagraphSummary,
  basenameNoMd,
  looksLikeBinaryRef,
  sourceName,
  bareTarget,
};
