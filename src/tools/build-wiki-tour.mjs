/**
 * build_wiki_tour — compute a DETERMINISTIC guided-tour skeleton from a vault's
 * knowledge graph. Read-only: reads `wiki-meta/graph/knowledge-graph.json`
 * (written by `build_wiki_graph`), runs the pure topology analyser, and returns
 * an ordered step skeleton enriched with node names/summaries. The `/wiki-tour`
 * skill adds the pedagogical NARRATIVE (step titles/descriptions) on top and
 * writes the standalone markdown tour + the graph's `tour[]` field.
 *
 * Roadmap item #3 (understand-anything-roadmap). Same deterministic-core /
 * LLM-narrate split as #1. DI (`_deps`) for testability.
 */

import * as defaultRestClient from '../rest-client.mjs';
import { computeTourTopology } from '../helpers/wiki-tour-topology.mjs';
import { CANONICAL_GRAPH_PATH } from './build-wiki-graph.mjs';
import { isMissingReadError, graphMissingError } from '../helpers/missing-read-guard.mjs';

export const TOOL_NAME = 'build_wiki_tour';

const MAX_STEPS_CAP = 30;

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Compute a deterministic guided-tour skeleton from a vault\'s knowledge graph (the `wiki-meta/graph/knowledge-graph.json` written by build_wiki_graph). Read-only. Ranks articles by fan-in (backlinks), picks entry points (boosted for index/MOC names), and produces an ordered set of steps (an overview step + one per `wiki-meta/catalog.md` section/topic, top articles first) — each step carries node names + summaries so the caller can write the pedagogical narrative. Use `scope` to tour one section/topic/path of a multi-project vault. If no graph exists yet, run build_wiki_graph (/wiki-graph) first.',
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'Vault name (see list_vaults). Omit to use the default vault.',
      },
      scope: {
        type: 'string',
        description: 'Restrict the tour to one layer/topic (by id or name) or a path substring. Omit for a whole-vault tour.',
      },
      maxSteps: {
        type: 'number',
        description: 'Cap on the number of tour steps. Default: 12.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

function asText(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res.content === 'string') return res.content;
  return '';
}

export async function buildWikiTourTool(registry, args = {}, _deps = {}) {
  const { vault: name, scope = null, maxSteps = 12 } = args;
  const deps = {
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
  };
  const vault = registry.resolveVault(name);

  const cap = Math.max(1, Math.min(MAX_STEPS_CAP, Number.isFinite(maxSteps) ? maxSteps : 12));

  // Read the knowledge graph written by build_wiki_graph.
  let raw;
  try {
    raw = await deps.getFileContent(vault, CANONICAL_GRAPH_PATH);
  } catch (err) {
    // Only a genuine "not found" means the graph hasn't been built. Preserve
    // real operational failures (vault offline, bad API key, timeout) instead
    // of misleadingly telling the user to run /wiki-graph (codex review).
    // One shared definition (helpers/graph-read-guard.mjs) — the three copies
    // of this decision had drifted into the same ENOTFOUND bug.
    if (isMissingReadError(err)) throw graphMissingError(CANONICAL_GRAPH_PATH);
    throw err;
  }
  let graph;
  try {
    graph = JSON.parse(asText(raw));
  } catch {
    throw new Error(
      `Knowledge graph at ${CANONICAL_GRAPH_PATH} is not valid JSON — re-run /wiki-graph.`,
    );
  }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error(
      `Knowledge graph at ${CANONICAL_GRAPH_PATH} is malformed (missing nodes/edges) — re-run /wiki-graph.`,
    );
  }

  const topo = computeTourTopology(graph, { scope, maxSteps: cap });

  // Enrich each step's node ids with name + summary so the caller can narrate
  // without re-fetching the graph.
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps = topo.steps.map((s) => ({
    order: s.order,
    title: s.title,
    layer: s.layer,
    nodes: s.nodeIds.map((id) => {
      const n = nodeById.get(id);
      return { id, name: (n && n.name) || id, summary: (n && n.summary) || '' };
    }),
  }));

  const warnings = [];
  if (topo.totalArticles === 0) warnings.push('no-articles-in-scope');
  if (steps.length === 0) warnings.push('no-tour-steps');

  return ({
    vault: vault.name,
    scope: topo.scope,
    graphPath: CANONICAL_GRAPH_PATH,
    totalArticles: topo.totalArticles,
    entryPoints: topo.entryPoints,
    stepCount: steps.length,
    steps,
    warnings,
  });
}

export const _internals = { asText, MAX_STEPS_CAP };
