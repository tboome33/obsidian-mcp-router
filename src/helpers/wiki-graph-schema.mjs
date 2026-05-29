/**
 * Knowledge-graph schema — Understand-Anything-compatible, VERBATIM.
 *
 * Roadmap item #1 (understand-anything-roadmap). This module is the single
 * source of truth for the node/edge type vocabulary, the graph shape, the
 * canonical ID builders, and a validator. The deterministic assembler
 * (`wiki-graph-builder.mjs`) and the `build_wiki_graph` MCP tool build on
 * top of it.
 *
 * Why mirror Understand-Anything (`Lum1104/Understand-Anything`) verbatim
 * rather than invent our own schema? Free interop: the router writes a
 * `knowledge-graph.json` that `/understand-dashboard` reads directly (the
 * `.understand-anything/` copy written by the tool), and any third-party
 * tool/agent that knows the UA schema can consume ours. See
 * [[understand-anything-roadmap]] §"Schéma".
 *
 * Graph shape (UA `KnowledgeGraph`):
 *   {
 *     version: "1.0.0",
 *     kind: "knowledge" | "codebase",   // drives the dashboard layout
 *     project: { name, languages[], frameworks[], description, analyzedAt, gitCommitHash },
 *     nodes:  GraphNode[],
 *     edges:  GraphEdge[],
 *     layers: Layer[],                   // architectural / topic groupings
 *     tour:   TourStep[],                // ordered pedagogical walkthrough
 *   }
 *
 * Pure module — no I/O, deterministic. Everything is exported for unit tests.
 */

import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = '1.0.0';

export const GRAPH_KINDS = Object.freeze(['codebase', 'knowledge']);

export const COMPLEXITY = Object.freeze(['simple', 'moderate', 'complex']);

/**
 * The full UA node-type vocabulary (21 types). The knowledge builder only
 * EMITS the 5 "knowledge" types (article/entity/topic/claim/source), but we
 * declare all 21 so the validator accepts graphs that mix in code/domain
 * nodes (e.g. a future `/understand`-style pass), and so the schema stays a
 * faithful mirror of UA.
 */
export const NODE_TYPES = Object.freeze([
  // code (5)
  'file', 'function', 'class', 'module', 'concept',
  // non-code (8)
  'config', 'document', 'service', 'table', 'endpoint', 'pipeline', 'schema', 'resource',
  // domain (3)
  'domain', 'flow', 'step',
  // knowledge (5)
  'article', 'entity', 'topic', 'claim', 'source',
]);

/** The 5 knowledge node types the deterministic builder emits. */
export const KNOWLEDGE_NODE_TYPES = Object.freeze([
  'article', 'entity', 'topic', 'claim', 'source',
]);

/**
 * The full UA edge-type vocabulary (35 types). The deterministic builder
 * emits a subset (`related`, `cites`, `categorized_under`); the LLM enrich
 * pass (roadmap #1 step 3) adds `builds_on`/`contradicts`/`exemplifies`.
 */
export const EDGE_TYPES = Object.freeze([
  // structural
  'imports', 'exports', 'contains', 'inherits', 'implements',
  // behavioral
  'calls', 'subscribes', 'publishes', 'middleware',
  // data flow
  'reads_from', 'writes_to', 'transforms', 'validates',
  // dependencies
  'depends_on', 'tested_by', 'configures',
  // semantic
  'related', 'similar_to',
  // infrastructure
  'deploys', 'serves', 'provisions', 'triggers', 'migrates', 'documents', 'routes', 'defines_schema',
  // domain
  'contains_flow', 'flow_step', 'cross_domain',
  // knowledge
  'cites', 'contradicts', 'builds_on', 'exemplifies', 'categorized_under', 'authored_by',
]);

export const EDGE_DIRECTIONS = Object.freeze(['forward', 'backward', 'bidirectional']);

const NODE_TYPE_SET = new Set(NODE_TYPES);
const EDGE_TYPE_SET = new Set(EDGE_TYPES);
const COMPLEXITY_SET = new Set(COMPLEXITY);
const KIND_SET = new Set(GRAPH_KINDS);
const DIRECTION_SET = new Set(EDGE_DIRECTIONS);

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/**
 * Kebab-case a free-text label for use inside a node ID: lowercase, collapse
 * any run of non-alphanumeric characters to a single hyphen, trim leading/
 * trailing hyphens. Unicode letters/numbers are preserved (so accented
 * concept names survive). Empty input → `''`.
 *
 * @param {string} s
 * @returns {string}
 */
export function kebab(s) {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalise a vault-relative path for use inside a node ID: forward slashes,
 * strip a trailing `.md`. Does NOT kebab — paths keep their structure (UA
 * uses `article:concepts/concept-brain`). Backslashes → forward slashes.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalisePathForId(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/').replace(/\.md$/i, '');
}

/** `article:<vault-rel-path-without-ext>` — e.g. `article:wiki/Refs/oauth`. */
export function articleId(pageRelPath) {
  return `article:${normalisePathForId(pageRelPath)}`;
}

/** `entity:<kebab(name)>` — deduped case-insensitively by the kebab form. */
export function entityId(name) {
  return `entity:${kebab(name)}`;
}

/** `topic:<kebab(title)>` — one per index.md section. */
export function topicId(title) {
  return `topic:${kebab(title)}`;
}

/**
 * `claim:<page-stem>:<kebab(claim, capped)>` — claims belong to one article,
 * so the page stem namespaces them. The claim text is kebab'd and capped to
 * keep IDs bounded.
 *
 * @param {string} pageRelPath Path of the article asserting the claim
 * @param {string} claimText
 */
export function claimId(pageRelPath, claimText) {
  const stem = normalisePathForId(pageRelPath).split('/').pop() || 'page';
  const slug = kebab(claimText).split('-').slice(0, 8).join('-') || 'claim';
  // Disambiguate collisions: two distinct claims on the same page that share
  // their first 8 kebab tokens would otherwise collapse to one ID (and lose
  // one claim). A short content hash of the FULL claim text keeps the ID
  // deterministic AND collision-free. Identical claims still map to one node.
  const hash = createHash('sha256').update(String(claimText)).digest('hex').slice(0, 6);
  return `claim:${stem}:${slug}-${hash}`;
}

/**
 * `source:<ref>` — a referenced source (frontmatter `sources:`, `^[...]`
 * citation, or `![[embed]]`). For URLs we keep the URL (minus protocol noise
 * is NOT applied here — the ref is used verbatim as identity); for local
 * paths we normalise slashes + strip `.md`. Kept lightweight by design (UA
 * `raw/` sources are filename-only, unparsed).
 *
 * @param {string} ref
 */
export function sourceId(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return 'source:unknown';
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed)) return `source:${trimmed}`;
  return `source:${normalisePathForId(trimmed)}`;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build an empty-but-valid KnowledgeGraph scaffold. Timestamps are injected
 * (not generated here) so the module stays deterministic + unit-testable —
 * the caller (the tool) passes `analyzedAt: new Date().toISOString()`.
 *
 * @param {object} input
 * @param {string} input.name Project / vault name
 * @param {'knowledge'|'codebase'} [input.kind='knowledge']
 * @param {string} [input.description='']
 * @param {string[]} [input.languages=['markdown']]
 * @param {string[]} [input.frameworks=[]]
 * @param {string} [input.analyzedAt=''] ISO timestamp (injected for determinism)
 * @param {string} [input.gitCommitHash='']
 * @returns {object} KnowledgeGraph
 */
export function emptyGraph({
  name,
  kind = 'knowledge',
  description = '',
  languages = ['markdown'],
  frameworks = [],
  analyzedAt = '',
  gitCommitHash = '',
} = {}) {
  return {
    version: SCHEMA_VERSION,
    kind: KIND_SET.has(kind) ? kind : 'knowledge',
    project: {
      name: typeof name === 'string' ? name : '',
      languages: Array.isArray(languages) ? languages : ['markdown'],
      frameworks: Array.isArray(frameworks) ? frameworks : [],
      description: typeof description === 'string' ? description : '',
      analyzedAt: typeof analyzedAt === 'string' ? analyzedAt : '',
      gitCommitHash: typeof gitCommitHash === 'string' ? gitCommitHash : '',
    },
    nodes: [],
    edges: [],
    layers: [],
    tour: [],
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a KnowledgeGraph object against the UA schema. Returns a report
 * `{ valid, errors[], warnings[] }` rather than throwing — the tool surfaces
 * errors to the user and refuses to write an invalid graph; warnings are
 * non-fatal (e.g. an unknown but non-empty edge type the LLM enrich pass
 * might add later).
 *
 * Checks (errors):
 *   - top-level shape (version, kind, project, nodes[], edges[], layers[], tour[])
 *   - kind ∈ GRAPH_KINDS
 *   - every node: non-empty string id, type ∈ NODE_TYPES, non-empty name,
 *     string summary, array tags, complexity ∈ COMPLEXITY
 *   - no duplicate node IDs
 *   - every edge: source/target reference an existing node id, type ∈
 *     EDGE_TYPES, direction ∈ EDGE_DIRECTIONS (if present), weight in [0,1]
 *     (if present), no self-edge
 *   - every layer.nodeIds entry references an existing node
 *
 * @param {object} graph
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateGraph(graph) {
  const errors = [];
  const warnings = [];

  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { valid: false, errors: ['graph must be a non-array object'], warnings };
  }
  if (graph.version !== SCHEMA_VERSION) {
    warnings.push(`version is "${graph.version}" (expected "${SCHEMA_VERSION}")`);
  }
  if (!KIND_SET.has(graph.kind)) {
    errors.push(`kind must be one of ${GRAPH_KINDS.join('|')} (got "${graph.kind}")`);
  }
  if (!graph.project || typeof graph.project !== 'object') {
    errors.push('project must be an object');
  }
  for (const field of ['nodes', 'edges', 'layers', 'tour']) {
    if (!Array.isArray(graph[field])) {
      errors.push(`${field} must be an array`);
    }
  }
  // Bail early if the container shape is broken — node/edge checks below
  // assume arrays.
  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  const nodeIds = new Set();
  graph.nodes.forEach((node, i) => {
    const where = `nodes[${i}]`;
    if (!node || typeof node !== 'object') {
      errors.push(`${where} must be an object`);
      return;
    }
    if (typeof node.id !== 'string' || !node.id) {
      errors.push(`${where}.id must be a non-empty string`);
    } else if (nodeIds.has(node.id)) {
      errors.push(`${where}.id "${node.id}" is duplicated`);
    } else {
      nodeIds.add(node.id);
    }
    if (!NODE_TYPE_SET.has(node.type)) {
      errors.push(`${where}.type "${node.type}" is not a known node type`);
    }
    if (typeof node.name !== 'string' || !node.name) {
      errors.push(`${where}.name must be a non-empty string`);
    }
    if (typeof node.summary !== 'string') {
      errors.push(`${where}.summary must be a string`);
    }
    if (!Array.isArray(node.tags)) {
      errors.push(`${where}.tags must be an array`);
    }
    if (!COMPLEXITY_SET.has(node.complexity)) {
      errors.push(`${where}.complexity "${node.complexity}" must be one of ${COMPLEXITY.join('|')}`);
    }
  });

  graph.edges.forEach((edge, i) => {
    const where = `edges[${i}]`;
    if (!edge || typeof edge !== 'object') {
      errors.push(`${where} must be an object`);
      return;
    }
    if (typeof edge.source !== 'string' || !nodeIds.has(edge.source)) {
      errors.push(`${where}.source "${edge.source}" does not reference an existing node`);
    }
    if (typeof edge.target !== 'string' || !nodeIds.has(edge.target)) {
      errors.push(`${where}.target "${edge.target}" does not reference an existing node`);
    }
    if (edge.source && edge.source === edge.target) {
      errors.push(`${where} is a self-edge (source === target === "${edge.source}")`);
    }
    if (!EDGE_TYPE_SET.has(edge.type)) {
      // Unknown edge types are a warning, not an error — the LLM enrich pass
      // may legitimately introduce a type we add to the vocab later. But an
      // empty/missing type is an error.
      if (typeof edge.type !== 'string' || !edge.type) {
        errors.push(`${where}.type must be a non-empty string`);
      } else {
        warnings.push(`${where}.type "${edge.type}" is not in the known edge vocabulary`);
      }
    }
    if (edge.direction != null && !DIRECTION_SET.has(edge.direction)) {
      errors.push(`${where}.direction "${edge.direction}" must be one of ${EDGE_DIRECTIONS.join('|')}`);
    }
    if (edge.weight != null) {
      if (typeof edge.weight !== 'number' || Number.isNaN(edge.weight) || edge.weight < 0 || edge.weight > 1) {
        errors.push(`${where}.weight must be a number in [0,1] (got ${edge.weight})`);
      }
    }
  });

  graph.layers.forEach((layer, i) => {
    const where = `layers[${i}]`;
    if (!layer || typeof layer !== 'object') {
      errors.push(`${where} must be an object`);
      return;
    }
    if (typeof layer.id !== 'string' || !layer.id) {
      errors.push(`${where}.id must be a non-empty string`);
    }
    if (typeof layer.name !== 'string' || !layer.name) {
      errors.push(`${where}.name must be a non-empty string`);
    }
    if (!Array.isArray(layer.nodeIds)) {
      errors.push(`${where}.nodeIds must be an array`);
    } else {
      layer.nodeIds.forEach((id, j) => {
        if (!nodeIds.has(id)) {
          warnings.push(`${where}.nodeIds[${j}] "${id}" does not reference an existing node`);
        }
      });
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

export const _internals = {
  NODE_TYPE_SET,
  EDGE_TYPE_SET,
  COMPLEXITY_SET,
  KIND_SET,
  DIRECTION_SET,
};
