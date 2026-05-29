/**
 * wiki-tour-topology — DETERMINISTIC topology analysis of a knowledge graph,
 * producing an ordered pedagogical TOUR SKELETON (which nodes, in what order,
 * grouped how). The LLM narrative (step titles/descriptions) is added by the
 * `/wiki-tour` skill on top of this — same deterministic-core / LLM-narrate
 * split as `build_wiki_graph` (#1). Reference: understand-anything-roadmap #3,
 * adapted from Understand-Anything's `tour-builder` Phase-1 topology script.
 *
 * Pure-functional, NO I/O, deterministic — same graph ⇒ same skeleton
 * (byte-for-byte). Operates on a UA-schema KnowledgeGraph (the JSON written by
 * `build_wiki_graph`): it reads `article` nodes, `related` edges (the wikilink
 * web), and `layers` (the index.md sections / topics).
 *
 * Signals computed:
 *   - fan-in  (backlinks): how many articles link TO a node → importance
 *   - fan-out: how many articles a node links to → breadth
 *   - entry points: best places to start (high fan-in, boosted for index/MOC
 *     names) — what a newcomer should read first
 *   - steps[]: a deterministic ordered skeleton — an overview step (entry
 *     points) then one step per layer (its top articles by fan-in), capped.
 *
 * `scope` restricts the tour to one layer/topic (by id, name, kebab(name)) or
 * a path substring — for a multi-project vault you tour one project at a time.
 */

import { kebab } from './wiki-graph-schema.mjs';

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_NODES_PER_STEP = 5;

// Names that signal a natural starting point (index / map-of-content / etc.),
// bilingual. Used to boost entry-point scoring.
const ENTRY_NAME_RE =
  /\b(index|overview|readme|moc|map[\s-]?of[\s-]?content|sommaire|accueil|home|start|d[ée]marrage|pr[ée]sentation)\b/i;

/**
 * Resolve a `scope` argument to a set of article ids + a human label.
 *
 * @returns {{ ids: Set<string>, label: string, layers: Array }}
 */
function resolveScope(scope, articles, articleIds, layers) {
  if (!scope || typeof scope !== 'string' || !scope.trim()) {
    return { ids: articleIds, label: 'whole-vault', layers };
  }
  const s = scope.trim();
  const sk = kebab(s);
  // 1. Match a layer by id / name / kebab(name).
  const layer = layers.find(
    (l) => l.id === s || l.name === s || kebab(l.name || '') === sk,
  );
  if (layer) {
    const ids = new Set((layer.nodeIds || []).filter((id) => articleIds.has(id)));
    return { ids, label: layer.name || s, layers: [layer] };
  }
  // 2. Fallback: treat as a path substring (case-insensitive) over filePath/id.
  const lower = s.toLowerCase();
  const ids = new Set(
    articles
      .filter(
        (a) =>
          (typeof a.filePath === 'string' && a.filePath.toLowerCase().includes(lower)) ||
          a.id.toLowerCase().includes(lower),
      )
      .map((a) => a.id),
  );
  // Project the layers onto the scoped ids (keep only members in scope).
  const projected = layers
    .map((l) => ({ ...l, nodeIds: (l.nodeIds || []).filter((id) => ids.has(id)) }))
    .filter((l) => l.nodeIds.length > 0);
  return { ids, label: s, layers: projected };
}

/**
 * Compute the deterministic tour topology + step skeleton.
 *
 * @param {object} graph A UA-schema KnowledgeGraph object.
 * @param {object} [opts]
 * @param {string|null} [opts.scope=null] Layer id/name or path substring.
 * @param {number} [opts.maxSteps=12]
 * @param {number} [opts.maxNodesPerStep=5]
 * @returns {{
 *   scope: string,
 *   totalArticles: number,
 *   entryPoints: Array<{id:string,name:string,fanIn:number}>,
 *   fanIn: Record<string,number>,
 *   fanOut: Record<string,number>,
 *   steps: Array<{order:number,title:string,nodeIds:string[],layer:string|null}>,
 * }}
 */
export function computeTourTopology(graph, opts = {}) {
  const { scope = null, maxSteps = DEFAULT_MAX_STEPS, maxNodesPerStep = DEFAULT_MAX_NODES_PER_STEP } = opts;
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError('computeTourTopology: graph must be a KnowledgeGraph object');
  }
  const layers = Array.isArray(graph.layers) ? graph.layers : [];

  const articles = graph.nodes.filter((n) => n && n.type === 'article' && typeof n.id === 'string');
  const articleById = new Map(articles.map((a) => [a.id, a]));
  const articleIds = new Set(articleById.keys());

  // Fan-in / fan-out over `related` edges between articles (the wikilink web).
  const fanIn = new Map();
  const fanOut = new Map();
  for (const id of articleIds) {
    fanIn.set(id, 0);
    fanOut.set(id, 0);
  }
  for (const e of graph.edges) {
    if (!e || e.type !== 'related') continue;
    if (articleIds.has(e.target)) fanIn.set(e.target, fanIn.get(e.target) + 1);
    if (articleIds.has(e.source)) fanOut.set(e.source, fanOut.get(e.source) + 1);
  }

  const { ids: scopedIds, label, layers: scopedLayers } = resolveScope(
    scope,
    articles,
    articleIds,
    layers,
  );
  const scopedArticles = articles.filter((a) => scopedIds.has(a.id));

  // Entry-point score: fan-in, boosted for index/MOC-like names. Deterministic
  // tie-break by id.
  const entryScore = (a) => (fanIn.get(a.id) || 0) + (ENTRY_NAME_RE.test(a.name || '') ? 1000 : 0);
  const entryPoints = [...scopedArticles]
    .sort((a, b) => entryScore(b) - entryScore(a) || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((a) => ({ id: a.id, name: a.name, fanIn: fanIn.get(a.id) || 0 }));

  // Step skeleton.
  const steps = [];
  let order = 1;
  const seenInSteps = new Set();

  // Step 1 — overview (the entry points).
  if (entryPoints.length > 0) {
    const ids = entryPoints.map((e) => e.id).slice(0, maxNodesPerStep);
    ids.forEach((id) => seenInSteps.add(id));
    steps.push({
      order: order++,
      title: label === 'whole-vault' ? 'Overview — start here' : `${label} — overview`,
      nodeIds: ids,
      layer: null,
    });
  }

  // One step per scoped layer — its top members by fan-in.
  for (const lyr of scopedLayers) {
    if (steps.length >= maxSteps) break;
    const members = (lyr.nodeIds || []).filter((id) => scopedIds.has(id));
    if (members.length === 0) continue;
    const top = members
      .map((id) => ({ id, fi: fanIn.get(id) || 0 }))
      .sort((a, b) => b.fi - a.fi || a.id.localeCompare(b.id))
      .slice(0, maxNodesPerStep)
      .map((x) => x.id);
    top.forEach((id) => seenInSteps.add(id));
    steps.push({ order: order++, title: lyr.name || lyr.id, nodeIds: top, layer: lyr.id });
  }

  // Trailing step — high-fan-in scoped articles not surfaced by any layer
  // (unindexed pages), so the tour doesn't silently omit important hubs.
  if (steps.length < maxSteps) {
    const leftovers = scopedArticles
      .filter((a) => !seenInSteps.has(a.id))
      .map((a) => ({ id: a.id, fi: fanIn.get(a.id) || 0 }))
      .filter((x) => x.fi > 0)
      .sort((a, b) => b.fi - a.fi || a.id.localeCompare(b.id))
      .slice(0, maxNodesPerStep)
      .map((x) => x.id);
    if (leftovers.length > 0) {
      steps.push({ order: order++, title: 'Other notable pages', nodeIds: leftovers, layer: null });
    }
  }

  return {
    scope: label,
    totalArticles: scopedArticles.length,
    entryPoints,
    fanIn: Object.fromEntries(fanIn),
    fanOut: Object.fromEntries(fanOut),
    steps: steps.slice(0, maxSteps),
  };
}

export const _internals = { resolveScope, ENTRY_NAME_RE };
