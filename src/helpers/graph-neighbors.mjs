/**
 * graph-neighbors — PURE graph-traversal helpers over a UA-schema knowledge
 * graph (the JSON `build_wiki_graph` writes to
 * `wiki-meta/graph/knowledge-graph.json`). No I/O, deterministic — same graph +
 * same args ⇒ byte-identical result, regardless of the order nodes/edges were
 * enumerated. Same deterministic-core / thin-tool split as
 * `wiki-tour-topology.mjs`: the MCP tools (`get_page_neighbors`, `wiki_path`)
 * read + validate the graph JSON, then delegate the maths here.
 *
 * Two entry points, one shared foundation (page resolution + edge-filtered
 * adjacency):
 *   - computeNeighbors(graph, opts) — the neighbourhood of ONE page (who it
 *     links to / who links to it), DIRECTED, out to a bounded hop depth.
 *   - computePath(graph, opts) — the shortest chain of links between TWO pages,
 *     UNDIRECTED (a link read either way still connects the two topics).
 *
 * Why read the persisted graph rather than re-extract wikilinks from page
 * bodies (as get_wiki_context_pack.graphNeighbors does)? The graph already
 * resolved ambiguous link targets, followed embeds/citations, and recorded
 * backlinks — re-deriving that here would duplicate (and drift from) the
 * builder. See [[page-neighbors-roadmap]].
 */

import { articleId, normalisePathForId } from './wiki-graph-schema.mjs';
import { cmp } from './total-order.mjs';
import { safeForMessage } from './sanitize.mjs';

// Defaults + bounds. maxNeighbors mirrors get_wiki_context_pack's bounding
// discipline; the depth cap keeps a depth-2 crossroads page from fanning out
// without limit. wiki_path's maxDepth cap bounds the search on a big graph.
export const DEFAULT_MAX_NEIGHBORS = 50;
export const MAX_NEIGHBORS_CEIL = 200;
export const DEFAULT_DEPTH = 1;
export const MAX_DEPTH_CEIL = 4;
export const DEFAULT_EDGE_TYPES = Object.freeze(['related']);
export const DEFAULT_NODE_TYPES = Object.freeze(['article']);
export const DEFAULT_PATH_MAX_DEPTH = 6;
export const PATH_MAX_DEPTH_CEIL = 20;

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

/** Basename of a vault path, without `.md` — mirrors the builder's helper. */
function basenameNoMd(p) {
  const norm = String(p).replace(/\\/g, '/');
  const base = norm.split('/').pop() || norm;
  return base.replace(/\.md$/i, '');
}

function assertGraph(graph) {
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError('graph-neighbors: graph must be a KnowledgeGraph object with nodes[]/edges[]');
  }
}

/** Coerce an arg into a non-empty string[]; fall back to `fallback` otherwise. */
function coerceTypeList(value, fallback) {
  if (Array.isArray(value)) {
    const clean = value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
    if (clean.length > 0) return clean;
  }
  return [...fallback];
}

/**
 * Resolve a `page` reference to an ARTICLE node in the graph, using the same
 * three-step logic as the builder's `resolveArticle` (exact path → bare name →
 * unique path suffix) — but with one DELIBERATE difference: on an ambiguous
 * match this REFUSES and lists the candidates, where the builder silently takes
 * the first. The builder must pick one to lay down a deterministic edge; an
 * interactive tool should let the user disambiguate. See [[page-neighbors-roadmap]].
 *
 * @param {Map<string,object>} articlesById  id → article node
 * @param {string} page  the user-supplied page reference
 * @param {string} label  which argument this is (for error messages: "page"/"from"/"to")
 * @returns {object} the resolved article node
 */
function resolveArticleNode(articlesById, page, label = 'page') {
  if (typeof page !== 'string' || !page.trim()) {
    throw new Error(`get_page_neighbors: \`${label}\` is required (a page path or name).`);
  }
  const raw = page.trim();

  // 1. Exact vault-root path — `wiki/sub/page` or `wiki/sub/page.md`.
  const exactId = articleId(raw);
  if (articlesById.has(exactId)) return articlesById.get(exactId);

  // 2. BARE name (no slash): match by basename, case-insensitive. Collect ALL
  //    matches — one resolves, several REFUSE (the deliberate difference).
  if (!/[\\/]/.test(raw)) {
    const wanted = basenameNoMd(raw).toLowerCase();
    const matches = [...articlesById.values()].filter(
      (n) => basenameNoMd(n.filePath || n.id).toLowerCase() === wanted,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw ambiguousError(label, raw, matches);
    throw notFoundError(label, raw);
  }

  // 3. PATH-QUALIFIED but not an exact vault-root path → segment-aligned SUFFIX
  //    match. Resolve only when UNIQUE; several matches REFUSE with candidates.
  const tnorm = normalisePathForId(raw);
  const suffix = `/${tnorm}`;
  const matches = [...articlesById.values()].filter((n) => {
    const p = n.id.slice('article:'.length);
    return p === tnorm || p.endsWith(suffix);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw ambiguousError(label, raw, matches);
  throw notFoundError(label, raw);
}

/**
 * Sanitise a value being interpolated into a THROWN message.
 *
 * These errors are the third instance of a defect this release fixed twice:
 * `sanitizeResponse` runs on the SUCCESS path only, so an exception carries
 * its interpolated content straight past it — `index.mjs` renders
 * `Error: ${err.message}` verbatim into the model's context. `heading-patch`
 * and the digest-slot warning were fixed; these two were the sibling left
 * live, and both `get_page_neighbors` and `wiki_path` throw them.
 *
 * `raw` is the caller's query and `filePath` comes from the knowledge graph —
 * a plain JSON file in the syncable vault tree, so a planted graph can carry
 * hostile bytes in a node path. Proven: an `ESC`, a `BEL` and a forged
 * `<result>` wrapper all reached the rendered message.
 */
function ambiguousError(label, raw, matches) {
  const paths = matches
    .map((n) => n.filePath || n.id)
    .sort((a, b) => cmp(String(a), String(b)))
    // NOT point-free: `.map(safeForMessage)` hands the ARRAY INDEX to the
    // second parameter, so the first candidate was capped at maxLen 0 and the
    // second at 1 — every path in the list replaced by a truncation notice.
    // The local helper this replaced took one argument, so extracting the
    // shared two-argument one silently changed the contract at this call site.
    // Caught by tests/graph-neighbors.test.mjs, not by review.
    .map((p) => safeForMessage(p));
  return new Error(
    `${label} "${safeForMessage(raw)}" is ambiguous — ${matches.length} pages match: ${paths.join(', ')}. `
      + 'Re-run with the exact vault-relative path.',
  );
}

function notFoundError(label, raw) {
  return new Error(
    `${label} "${safeForMessage(raw)}" not found in the knowledge graph. Pass an exact vault-relative path `
      + '(e.g. "wiki/Refs/oauth.md") or a unique page name.',
  );
}

/** Directory portion of a vault-relative path (everything before the last `/`). */
function dirOf(filePath) {
  if (typeof filePath !== 'string') return '';
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

/**
 * A5 enrichment (page-neighbors-roadmap): pages in the SAME folder as `startNode`
 * (same directory prefix of `filePath`) — a structural signal already present on
 * every article node, no graph traversal needed. Scoped to `type: 'article'`
 * regardless of the caller's `nodeTypes` (folders are a page-level concept; other
 * node types don't carry a meaningful `filePath`). Deterministic: sorted by id.
 */
function computeSameFolderNeighbors(articles, startNode, cap) {
  const startDir = dirOf(startNode.filePath);
  const matches = articles
    .filter((n) => n.id !== startNode.id && dirOf(n.filePath) === startDir)
    .map((n) => ({ id: n.id, name: n.name || n.id, filePath: n.filePath || null }))
    .sort((a, b) => cmp(a.id, b.id));
  return { neighbors: matches.slice(0, cap), truncated: matches.length > cap, totalFound: matches.length };
}

/**
 * A5 enrichment: pages that share at least one REAL tag with `startNode` (the
 * universal `"article"` tag every article carries is excluded — matching on it
 * would pair every page in the vault with every other page). Scoped to
 * `type: 'article'`, same rationale as `computeSameFolderNeighbors`. Each result
 * carries `sharedTags` (sorted) so the caller knows WHY it matched.
 */
function computeSharedTagNeighbors(articles, startNode, cap) {
  const startTags = new Set((startNode.tags || []).filter((t) => t !== 'article'));
  if (startTags.size === 0) return { neighbors: [], truncated: false, totalFound: 0 };
  const matches = [];
  for (const n of articles) {
    if (n.id === startNode.id) continue;
    const shared = [...new Set((n.tags || []).filter((t) => t !== 'article' && startTags.has(t)))].sort();
    if (shared.length > 0) {
      matches.push({ id: n.id, name: n.name || n.id, filePath: n.filePath || null, sharedTags: shared });
    }
  }
  matches.sort((a, b) => cmp(a.id, b.id));
  return { neighbors: matches.slice(0, cap), truncated: matches.length > cap, totalFound: matches.length };
}

/**
 * Build directed adjacency over the edges whose type ∈ edgeTypes.
 *   out.get(id) → [{ to, type }]   (edges where id is the SOURCE)
 *   in.get(id)  → [{ from, type }] (edges where id is the TARGET)
 * Lists are sorted by (neighbour id, edge type) so traversal order — and thus
 * the recorded `viaEdgeType` — is independent of input edge order.
 */
function buildAdjacency(edges, edgeTypesSet) {
  const out = new Map();
  const inn = new Map();
  for (const e of edges) {
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue;
    if (!edgeTypesSet.has(e.type)) continue;
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push({ to: e.target, type: e.type });
    if (!inn.has(e.target)) inn.set(e.target, []);
    inn.get(e.target).push({ from: e.source, type: e.type });
  }
  const bySortedTo = (a, b) => cmp(String(a.to), String(b.to)) || cmp(String(a.type), String(b.type));
  const bySortedFrom = (a, b) => cmp(String(a.from), String(b.from)) || cmp(String(a.type), String(b.type));
  for (const list of out.values()) list.sort(bySortedTo);
  for (const list of inn.values()) list.sort(bySortedFrom);
  return { out, inn };
}

// ---------------------------------------------------------------------------
// computeNeighbors — the neighbourhood of one page (DIRECTED BFS)
// ---------------------------------------------------------------------------

/**
 * @param {object} graph  A UA-schema KnowledgeGraph object.
 * @param {object} opts
 * @param {string} opts.page  Page reference (exact path, bare name, or unique suffix).
 * @param {'both'|'forward'|'backward'} [opts.direction='both']  forward = pages
 *   THIS page links to; backward = pages that link to it; both = union.
 * @param {number} [opts.depth=1]  Hop radius (clamped to [1, 4]).
 * @param {string[]} [opts.edgeTypes=['related']]  Edge types to traverse.
 * @param {string[]} [opts.nodeTypes=['article']]  Node types to KEEP + walk
 *   through (default: pages only — without this, entities/claims/sources pollute
 *   "the neighbours of X").
 * @param {number} [opts.maxNeighbors=50]  Result cap (clamped to [1, 200]).
 * @param {boolean} [opts.includeSameFolder=false]  A5 enrichment: also return
 *   OTHER article pages living in the same folder (opt-in, off by default).
 * @param {boolean} [opts.includeSharedTags=false]  A5 enrichment: also return
 *   article pages sharing a real tag (opt-in, off by default).
 * @returns {{
 *   page: { id, name, filePath, nodeType },
 *   neighbors: Array<{ id, name, filePath, nodeType, hopDistance, viaEdgeType }>,
 *   truncated: boolean,
 *   totalFound: number,
 *   sameFolderNeighbors: Array<{ id, name, filePath }>,
 *   sameFolderTruncated: boolean,
 *   sameFolderTotalFound: number,
 *   sharedTagNeighbors: Array<{ id, name, filePath, sharedTags: string[] }>,
 *   sharedTagTruncated: boolean,
 *   sharedTagTotalFound: number,
 * }}
 */
export function computeNeighbors(graph, opts = {}) {
  assertGraph(graph);
  const {
    page,
    direction = 'both',
    depth = DEFAULT_DEPTH,
    edgeTypes,
    nodeTypes,
    maxNeighbors = DEFAULT_MAX_NEIGHBORS,
    includeSameFolder = false,
    includeSharedTags = false,
  } = opts;

  const dir = direction === 'forward' || direction === 'backward' ? direction : 'both';
  const hopLimit = Math.max(1, Math.min(MAX_DEPTH_CEIL, Number.isFinite(depth) ? Math.floor(depth) : DEFAULT_DEPTH));
  const cap = Math.max(1, Math.min(MAX_NEIGHBORS_CEIL, Number.isFinite(maxNeighbors) ? Math.floor(maxNeighbors) : DEFAULT_MAX_NEIGHBORS));
  const edgeTypesSet = new Set(coerceTypeList(edgeTypes, DEFAULT_EDGE_TYPES));
  const nodeTypesSet = new Set(coerceTypeList(nodeTypes, DEFAULT_NODE_TYPES));

  const nodeById = new Map();
  const articlesById = new Map();
  for (const n of graph.nodes) {
    if (!n || typeof n.id !== 'string') continue;
    nodeById.set(n.id, n);
    if (n.type === 'article') articlesById.set(n.id, n);
  }

  const startNode = resolveArticleNode(articlesById, page, 'page');
  const { out, inn } = buildAdjacency(graph.edges, edgeTypesSet);

  // BFS from the start. `visited` marks a node the moment it is enqueued so its
  // recorded hopDistance is the minimum (FIFO ⇒ shortest hop wins). The start is
  // the anchor and is never itself returned.
  const visited = new Set([startNode.id]);
  const neighbors = [];
  const queue = [{ id: startNode.id, hop: 0 }];
  while (queue.length > 0) {
    const { id, hop } = queue.shift();
    if (hop >= hopLimit) continue;
    const candidates = [];
    if (dir === 'both' || dir === 'forward') {
      for (const { to, type } of out.get(id) || []) candidates.push({ nid: to, type });
    }
    if (dir === 'both' || dir === 'backward') {
      for (const { from, type } of inn.get(id) || []) candidates.push({ nid: from, type });
    }
    for (const { nid, type } of candidates) {
      if (visited.has(nid)) continue;
      const node = nodeById.get(nid);
      if (!node || !nodeTypesSet.has(node.type)) continue; // filter TRAVERSAL + output by node type
      visited.add(nid);
      neighbors.push({
        id: nid,
        name: (node && node.name) || nid,
        filePath: (node && node.filePath) || null,
        nodeType: node.type,
        hopDistance: hop + 1,
        viaEdgeType: type,
      });
      queue.push({ id: nid, hop: hop + 1 });
    }
  }

  // Deterministic order: nearest first, then id.
  neighbors.sort((a, b) => a.hopDistance - b.hopDistance || cmp(a.id, b.id));
  const totalFound = neighbors.length;
  const capped = neighbors.slice(0, cap);

  // A5 enrichment (opt-in): structural signals already on the article nodes —
  // no traversal needed, so these are computed independently of the BFS above.
  const articles = [...articlesById.values()];
  const sameFolder = includeSameFolder
    ? computeSameFolderNeighbors(articles, startNode, cap)
    : { neighbors: [], truncated: false, totalFound: 0 };
  const sharedTag = includeSharedTags
    ? computeSharedTagNeighbors(articles, startNode, cap)
    : { neighbors: [], truncated: false, totalFound: 0 };

  return {
    page: {
      id: startNode.id,
      name: startNode.name || startNode.id,
      filePath: startNode.filePath || null,
      nodeType: startNode.type,
    },
    neighbors: capped,
    truncated: totalFound > cap,
    totalFound,
    sameFolderNeighbors: sameFolder.neighbors,
    sameFolderTruncated: sameFolder.truncated,
    sameFolderTotalFound: sameFolder.totalFound,
    sharedTagNeighbors: sharedTag.neighbors,
    sharedTagTruncated: sharedTag.truncated,
    sharedTagTotalFound: sharedTag.totalFound,
  };
}

// ---------------------------------------------------------------------------
// computePath — shortest link chain between two pages (UNDIRECTED BFS)
// ---------------------------------------------------------------------------

/**
 * Shortest chain of links from `from` to `to`, IGNORING link direction (a
 * link read either way still relates the two topics — that is the sensible
 * reading of "how are A and B connected?"). Returns `path: null` when the two
 * pages are not connected within `maxDepth` — a legitimate answer, NOT an error.
 *
 * A plain level-order BFS (not bidirectional) is used deliberately: at the
 * router's bounded graph size (≤ MAX_FILES pages) it returns the identical
 * shortest path with far less state to get wrong, so its correctness is easy to
 * verify. Bidirectional BFS remains a drop-in optimisation should graphs grow.
 *
 * @param {object} graph
 * @param {object} opts
 * @param {string} opts.from
 * @param {string} opts.to
 * @param {number} [opts.maxDepth=6]  Max hops to search (clamped to [1, 20]).
 * @param {string[]} [opts.nodeTypes=['article']]  Node types an INTERMEDIATE
 *   node may have to sit on the path (the two endpoints are always reachable
 *   whatever their type). Default ['article'] = links between pages only.
 *   Widen to e.g. ['article','entity','topic'] to allow "connected via a shared
 *   concept" paths; ['entity'] alone bridges strictly through concepts (no
 *   intermediate pages).
 * @param {string[]} [opts.edgeTypes=['related']]
 * @returns {{
 *   from: { id, name, filePath, nodeType },
 *   to: { id, name, filePath, nodeType },
 *   path: Array<{ id, name, filePath, nodeType }> | null,
 *   length: number | null,
 *   found: boolean,
 * }}
 */
export function computePath(graph, opts = {}) {
  assertGraph(graph);
  const { from, to, maxDepth = DEFAULT_PATH_MAX_DEPTH, nodeTypes, edgeTypes } = opts;

  const hopLimit = Math.max(1, Math.min(PATH_MAX_DEPTH_CEIL, Number.isFinite(maxDepth) ? Math.floor(maxDepth) : DEFAULT_PATH_MAX_DEPTH));
  const edgeTypesSet = new Set(coerceTypeList(edgeTypes, DEFAULT_EDGE_TYPES));
  const nodeTypesSet = new Set(coerceTypeList(nodeTypes, DEFAULT_NODE_TYPES));

  const nodeById = new Map();
  const articlesById = new Map();
  for (const n of graph.nodes) {
    if (!n || typeof n.id !== 'string') continue;
    nodeById.set(n.id, n);
    if (n.type === 'article') articlesById.set(n.id, n);
  }

  const fromNode = resolveArticleNode(articlesById, from, 'from');
  const toNode = resolveArticleNode(articlesById, to, 'to');

  const brief = (node) => ({
    id: node.id,
    name: node.name || node.id,
    filePath: node.filePath || null,
    nodeType: node.type,
  });
  const wrap = (path) => ({
    from: brief(fromNode),
    to: brief(toNode),
    path: path ? path.map((id) => brief(nodeById.get(id))) : null,
    length: path ? path.length - 1 : null,
    found: Boolean(path),
  });

  if (fromNode.id === toNode.id) return wrap([fromNode.id]);

  // An INTERMEDIATE node may sit on the path only if its type ∈ nodeTypes. The
  // two endpoints are always reachable regardless of type — `from` is the BFS
  // start (never type-checked) and `to` is exempted below (`nid !== toNode.id`).
  // We deliberately do NOT widen the allowed set with the endpoints' TYPE
  // (`article`): that would let arbitrary OTHER article pages onto the path even
  // when the caller excluded articles (e.g. nodeTypes:["entity"] must bridge
  // ONLY through concepts, not through unrelated pages). Undirected adjacency.
  const { out, inn } = buildAdjacency(graph.edges, edgeTypesSet);
  const neighborsOf = (id) => {
    const seen = new Set();
    const res = [];
    for (const { to: t } of out.get(id) || []) if (!seen.has(t)) { seen.add(t); res.push(t); }
    for (const { from: f } of inn.get(id) || []) if (!seen.has(f)) { seen.add(f); res.push(f); }
    res.sort((a, b) => cmp(String(a), String(b))); // deterministic parent choice
    return res;
  };

  // Level-order BFS with parent pointers; expand a node only while its distance
  // is below maxDepth, and step onto a neighbour only if it is an allowed type.
  const parent = new Map([[fromNode.id, null]]);
  const dist = new Map([[fromNode.id, 0]]);
  const queue = [fromNode.id];
  while (queue.length > 0) {
    const id = queue.shift();
    const d = dist.get(id);
    if (d >= hopLimit) continue;
    for (const nid of neighborsOf(id)) {
      if (parent.has(nid)) continue;
      if (nid !== toNode.id && !nodeTypesSet.has((nodeById.get(nid) || {}).type)) continue;
      parent.set(nid, id);
      dist.set(nid, d + 1);
      if (nid === toNode.id) {
        // Reconstruct from `to` back to `from`.
        const path = [];
        let cur = nid;
        while (cur != null) { path.push(cur); cur = parent.get(cur); }
        path.reverse();
        return wrap(path);
      }
      queue.push(nid);
    }
  }
  return wrap(null);
}

export const _internals = {
  basenameNoMd,
  resolveArticleNode,
  buildAdjacency,
  coerceTypeList,
  dirOf,
  computeSameFolderNeighbors,
  computeSharedTagNeighbors,
};
