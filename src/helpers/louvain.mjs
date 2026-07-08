/**
 * louvain — DETERMINISTIC Louvain community detection on an undirected,
 * weighted graph. Pure, no I/O, no dependencies, no randomness.
 *
 * Roadmap item #1 step 2.5 (understand-anything-roadmap): the wiki-graph
 * builder calls this to turn the graph's link topology into `layers[]`
 * (communities), which drive color-by-community in the viewer, god-node /
 * hub detection, and MOC suggestions.
 *
 * Why a from-scratch implementation rather than a library:
 *   - The whole `wiki-graph-builder` is byte-stable (same input ⇒ same output
 *     to the byte). Off-the-shelf Louvain implementations randomise node
 *     iteration order and tie-breaking, so their output shifts run-to-run.
 *     That would defeat the builder's no-op-write skip and pollute diffs.
 *   - The project ships with a tiny dependency set on purpose. Louvain is
 *     ~150 lines; a graph library would drag in a tree for one algorithm.
 *
 * How determinism is guaranteed:
 *   - Nodes are indexed in sorted-id order, so the local-moving pass always
 *     visits nodes in the same sequence.
 *   - When several candidate communities offer the same modularity gain, the
 *     lowest community index wins (a fixed, total tie-break).
 *   - No `Math.random`, no time, no hash-map iteration order dependence
 *     (community candidates are sorted before the argmax).
 *
 * The algorithm is textbook Louvain: repeatedly (1) local-moving — greedily
 * move each node to the neighbouring community that most increases modularity,
 * until no move helps; then (2) aggregation — collapse each community into a
 * super-node (intra-community edges become a self-loop) and repeat on the
 * smaller graph. Levels stop when a pass merges nothing.
 *
 * @module louvain
 */

// A community candidate whose gain is within EPS of the best is treated as a
// tie and resolved by the lowest community index — never by float noise.
const EPS = 1e-12;

// Code-unit id comparator. Deliberately NOT `localeCompare`: that is
// locale/ICU-sensitive, and here the id order sets node indices, traversal
// order, AND tie-breaking — so a locale difference between two machines could
// change the actual partition, not just its presentation. A code-unit compare
// is the same on every host, keeping the community output byte-stable across
// machines (the graph JSON is synced between them).
const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Safety bound on aggregation levels. Real graphs converge in a handful; this
// only stops a pathological non-converging input from looping forever.
const MAX_LEVELS = 100;
// Safety bound on local-moving passes within one level (same rationale).
const MAX_PASSES = 100;

/**
 * Fold the caller's node list + directed/weighted edge list into an
 * undirected, integer-indexed weighted graph.
 *
 * @param {string[]} nodeIds  Node identifiers. Deduped; non-string/empty
 *   dropped. Sorted so integer indices follow id order (determinism).
 * @param {Array<{source:string,target:string,weight?:number}>} edges
 *   Edges. `source===target` (self) and refs to unknown nodes are dropped.
 *   A non-positive / non-finite / missing weight defaults to 1. Parallel
 *   edges between the same pair (either direction, any type) sum.
 * @returns {{ids:string[], n:number, neighbors:Array<Map<number,number>>,
 *   degrees:number[], selfLoops:number[], twoM:number}}
 */
function buildGraph(nodeIds, edges) {
  const ids = [...new Set((Array.isArray(nodeIds) ? nodeIds : []).filter(
    (x) => typeof x === 'string' && x,
  ))].sort(cmpId);
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;

  const neighbors = Array.from({ length: n }, () => new Map());
  const selfLoops = new Array(n).fill(0);

  // Fold edges in a canonical order rather than caller order. Float addition is
  // not associative, so summing the same undirected pair's parallel edges in
  // different orders could differ by an ULP and — near a tie — flip the
  // partition. Sorting first makes the fold, hence the whole result, independent
  // of caller order. The key CANONICALISES endpoint orientation — (min, max)
  // rather than (source, target) — because the graph is undirected: an edge
  // written x→y and one written y→x are the same pair and must group together
  // before summing. Weight is the tertiary key so parallel edges of differing
  // weight also sum in a fixed order. Null/malformed entries sort to the front
  // (empty keys) and are skipped in the loop below. `edgeWeight` mirrors the
  // loop's normalisation exactly, so the sort order and the summed values agree.
  const edgeKey = (e, field) =>
    e && typeof e[field] === 'string' ? e[field] : '';
  const edgeLo = (e) => {
    const s = edgeKey(e, 'source');
    const t = edgeKey(e, 'target');
    return s < t ? s : t;
  };
  const edgeHi = (e) => {
    const s = edgeKey(e, 'source');
    const t = edgeKey(e, 'target');
    return s < t ? t : s;
  };
  const edgeWeight = (e) => {
    const w = e && e.weight;
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1;
  };
  const sortedEdges = [...(Array.isArray(edges) ? edges : [])].sort(
    (e1, e2) =>
      cmpId(edgeLo(e1), edgeLo(e2)) ||
      cmpId(edgeHi(e1), edgeHi(e2)) ||
      edgeWeight(e1) - edgeWeight(e2),
  );

  for (const edge of sortedEdges) {
    if (!edge || typeof edge !== 'object') continue;
    const { source, target } = edge;
    if (typeof source !== 'string' || typeof target !== 'string') continue;
    if (source === target) continue; // self-edge: no community meaning
    const i = index.get(source);
    const j = index.get(target);
    if (i === undefined || j === undefined) continue; // ref to unknown node
    const raw = edge.weight;
    const w = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1;
    neighbors[i].set(j, (neighbors[i].get(j) || 0) + w);
    neighbors[j].set(i, (neighbors[j].get(i) || 0) + w);
  }

  // Weighted degree of each node = Σ incident edge weight + 2×self-loop.
  // (Self-loops are 0 at level 0; the aggregated graph produces them.)
  const degrees = new Array(n).fill(0);
  let twoM = 0;
  for (let i = 0; i < n; i++) {
    let deg = 2 * selfLoops[i];
    for (const w of neighbors[i].values()) deg += w;
    degrees[i] = deg;
    twoM += deg;
  }
  return { ids, n, neighbors, degrees, selfLoops, twoM };
}

/**
 * One level of local-moving on an integer-indexed graph. Returns a `community`
 * label per node (labels are arbitrary node indices, not yet contiguous).
 *
 * @param {{n:number, neighbors:Array<Map<number,number>>, degrees:number[],
 *   twoM:number}} g
 * @param {number} resolution
 * @returns {{community:Int32Array, moved:boolean}}
 */
function localMoving(g, resolution) {
  const { n, neighbors, degrees, twoM } = g;
  const community = new Int32Array(n);
  const comTot = new Float64Array(n); // Σ degree of nodes in each community
  for (let i = 0; i < n; i++) {
    community[i] = i;
    comTot[i] = degrees[i];
  }
  if (twoM === 0) return { community, moved: false }; // edgeless → all singletons

  let movedEver = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let movedThisPass = false;
    for (let i = 0; i < n; i++) {
      const ci = community[i];
      // Weight from i to each neighbouring community.
      const comWeight = new Map();
      for (const [j, w] of neighbors[i]) {
        const cj = community[j];
        comWeight.set(cj, (comWeight.get(cj) || 0) + w);
      }
      // Tentatively remove i from its community.
      comTot[ci] -= degrees[i];

      // Simplified modularity gain of putting i into community c (the constant
      // terms shared across candidates for a fixed i are dropped — valid for a
      // ranking). `wic` = weight from i to community c.
      const gainOf = (c) =>
        (comWeight.get(c) || 0) - (resolution * comTot[c] * degrees[i]) / twoM;

      // Baseline: rejoin the CURRENT community. A node only moves when a
      // neighbouring community beats staying by more than EPS — so modularity
      // is non-decreasing (no plateau churn) and a within-EPS tie always keeps
      // the node put. Neighbour communities are visited in ascending index
      // order, so the lowest index wins among strictly-better candidates.
      let bestC = ci;
      let bestGain = gainOf(ci);
      const neighbourComs = [...comWeight.keys()].sort((a, b) => a - b);
      for (const c of neighbourComs) {
        if (c === ci) continue;
        const gain = gainOf(c);
        if (gain > bestGain + EPS) {
          bestGain = gain;
          bestC = c;
        }
      }

      comTot[bestC] += degrees[i];
      community[i] = bestC;
      if (bestC !== ci) {
        movedThisPass = true;
        movedEver = true;
      }
    }
    if (!movedThisPass) break;
  }
  return { community, moved: movedEver };
}

/**
 * Relabel arbitrary community labels to a contiguous 0..K-1 range, assigning
 * new labels in order of first appearance across ascending node index
 * (deterministic).
 *
 * @param {Int32Array} community
 * @param {number} n
 * @returns {{label:Int32Array, k:number}}
 */
function relabel(community, n) {
  const map = new Map();
  const label = new Int32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const c = community[i];
    let l = map.get(c);
    if (l === undefined) {
      l = k++;
      map.set(c, l);
    }
    label[i] = l;
  }
  return { label, k };
}

/**
 * Collapse each community into a super-node: intra-community edge weight folds
 * into the super-node's self-loop, inter-community weight becomes edges
 * between super-nodes. `twoM` is invariant across levels.
 *
 * @param {{n:number, neighbors:Array<Map<number,number>>, selfLoops:number[],
 *   twoM:number}} g
 * @param {Int32Array} label  contiguous community label per node (0..k-1)
 * @param {number} k
 * @returns {{n:number, neighbors:Array<Map<number,number>>, degrees:number[],
 *   selfLoops:number[], twoM:number}}
 */
function aggregate(g, label, k) {
  const neighbors = Array.from({ length: k }, () => new Map());
  const selfLoops = new Array(k).fill(0);

  for (let i = 0; i < g.n; i++) {
    const ci = label[i];
    // Existing self-loop of node i carries straight over.
    selfLoops[ci] += g.selfLoops[i];
    for (const [j, w] of g.neighbors[i]) {
      const cj = label[j];
      if (ci === cj) {
        // Intra-community edge. `neighbors` is symmetric, so each undirected
        // intra edge is visited twice (i→j and j→i); halve to get its weight
        // once, as a self-loop contribution.
        selfLoops[ci] += w / 2;
      } else {
        neighbors[ci].set(cj, (neighbors[ci].get(cj) || 0) + w);
      }
    }
  }

  const degrees = new Array(k).fill(0);
  for (let c = 0; c < k; c++) {
    let deg = 2 * selfLoops[c];
    for (const w of neighbors[c].values()) deg += w;
    degrees[c] = deg;
  }
  return { n: k, neighbors, degrees, selfLoops, twoM: g.twoM };
}

/**
 * Detect communities in an undirected weighted graph using deterministic
 * Louvain modularity maximisation.
 *
 * @param {string[]} nodeIds  All node identifiers (isolated nodes included →
 *   they come back as singleton communities).
 * @param {Array<{source:string,target:string,weight?:number}>} edges
 * @param {{resolution?:number}} [opts]  `resolution` (γ, default 1) — higher
 *   yields more, smaller communities; lower yields fewer, larger ones.
 * @returns {string[][]}  Communities. Each community's ids are sorted; the
 *   outer array is sorted by each community's first (smallest) id. Every input
 *   node appears exactly once. Byte-stable for a given input.
 */
export function detectCommunities(nodeIds, edges, opts = {}) {
  const resolution =
    typeof opts.resolution === 'number' && Number.isFinite(opts.resolution) && opts.resolution > 0
      ? opts.resolution
      : 1;

  const base = buildGraph(nodeIds, edges);
  const { ids, n } = base;
  if (n === 0) return [];

  // `membership[i]` = the current super-node that original node i belongs to.
  let membership = new Int32Array(n);
  for (let i = 0; i < n; i++) membership[i] = i;

  let level = base;
  for (let depth = 0; depth < MAX_LEVELS; depth++) {
    const { community } = localMoving(level, resolution);
    const { label, k } = relabel(community, level.n);

    // Fold this level's labels into the original-node membership.
    for (let i = 0; i < n; i++) membership[i] = label[membership[i]];

    // A level that merged nothing (k === current node count) is the fixed
    // point — no coarser grouping exists.
    if (k === level.n) break;

    level = aggregate(level, label, k);
  }

  // Group original ids by final community label, then canonicalise ordering.
  const byCommunity = new Map();
  for (let i = 0; i < n; i++) {
    const c = membership[i];
    if (!byCommunity.has(c)) byCommunity.set(c, []);
    byCommunity.get(c).push(ids[i]);
  }
  const communities = [...byCommunity.values()].map((members) => members.sort(cmpId));
  communities.sort((a, b) => cmpId(a[0], b[0]));
  return communities;
}

/**
 * Modularity Q of a partition on an undirected weighted graph, with the same
 * resolution convention as {@link detectCommunities}. Useful for tests and
 * for callers that want to report partition quality. Returns 0 for an edgeless
 * graph (no division by zero).
 *
 * @param {string[]} nodeIds
 * @param {Array<{source:string,target:string,weight?:number}>} edges
 * @param {string[][]} partition  Communities as arrays of node ids.
 * @param {{resolution?:number}} [opts]
 * @returns {number}
 */
export function modularity(nodeIds, edges, partition, opts = {}) {
  const resolution =
    typeof opts.resolution === 'number' && Number.isFinite(opts.resolution) && opts.resolution > 0
      ? opts.resolution
      : 1;
  const { ids, n, neighbors, degrees, twoM } = buildGraph(nodeIds, edges);
  if (twoM === 0 || n === 0) return 0;

  // Map each node id to its community index from the supplied partition.
  const idToIndex = new Map(ids.map((id, i) => [id, i]));
  const communityOf = new Int32Array(n).fill(-1);
  (Array.isArray(partition) ? partition : []).forEach((members, c) => {
    for (const id of Array.isArray(members) ? members : []) {
      const i = idToIndex.get(id);
      if (i !== undefined) communityOf[i] = c;
    }
  });

  // Q = Σ_ij [ A_ij / 2m − γ (k_i k_j) / (2m)^2 ] · δ(c_i, c_j).
  // Intra-community edge weight (A_ij summed over same-community ordered pairs)
  // and the degree penalty are accumulated per community.
  const comInternal = new Map(); // 2× intra edge weight (ordered-pair sum)
  const comDegree = new Map();
  for (let i = 0; i < n; i++) {
    const ci = communityOf[i];
    if (ci < 0) continue; // node absent from the partition → ignored
    comDegree.set(ci, (comDegree.get(ci) || 0) + degrees[i]);
    for (const [j, w] of neighbors[i]) {
      if (communityOf[j] === ci) comInternal.set(ci, (comInternal.get(ci) || 0) + w);
    }
  }

  let q = 0;
  for (const [c, internal] of comInternal) {
    const tot = comDegree.get(c) || 0;
    q += internal / twoM - resolution * (tot / twoM) * (tot / twoM);
  }
  // Communities with no internal edge still contribute their degree penalty.
  for (const [c, tot] of comDegree) {
    if (!comInternal.has(c)) q -= resolution * (tot / twoM) * (tot / twoM);
  }
  return q;
}

export const _internals = { buildGraph, localMoving, relabel, aggregate, EPS };
