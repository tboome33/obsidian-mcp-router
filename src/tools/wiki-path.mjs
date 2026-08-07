/**
 * wiki_path — the shortest chain of links between TWO wiki pages, read from the
 * knowledge graph. "How are page A and page B connected?" Read-only: reads
 * `wiki-meta/graph/knowledge-graph.json` (written by `build_wiki_graph`),
 * resolves both endpoints, and returns the ordered list of pages hop-by-hop —
 * or an explicit `null` path when the two are not connected (a legitimate
 * answer, NOT an error: two pages can simply be unrelated).
 *
 * Traversal is UNDIRECTED — a link read either way still relates the two topics,
 * which is the sensible reading of "how are these connected?" (contrast
 * `get_page_neighbors`, where direction is meaningful). Widen `nodeTypes` beyond
 * the default `["article"]` to allow "connected via a shared concept" paths.
 *
 * Same deterministic-core / thin-tool split as `get_page_neighbors`: this is
 * only the I/O shell (read graph → validate → delegate to `computePath` →
 * sanitize). DI (`_deps`) for testability. Roadmap item W-B of
 * [[page-neighbors-roadmap]] — reuses the graph-loading + page-resolution core
 * that W-A introduced.
 */

import * as defaultRestClient from '../rest-client.mjs';
import {
  computePath,
  DEFAULT_PATH_MAX_DEPTH,
  PATH_MAX_DEPTH_CEIL,
} from '../helpers/graph-neighbors.mjs';
import { CANONICAL_GRAPH_PATH } from './build-wiki-graph.mjs';
import { isMissingReadError, graphMissingError } from '../helpers/missing-read-guard.mjs';

export const TOOL_NAME = 'wiki_path';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Find the shortest chain of links between TWO wiki pages in the knowledge graph (the `wiki-meta/graph/knowledge-graph.json` written by build_wiki_graph). Read-only. Answers "how are page A and page B connected?" — returns the ordered list of pages from `from` to `to`, hop by hop, or an explicit null path when they are NOT connected (a legitimate answer, not an error). Traversal is UNDIRECTED (a link read either way still connects the two topics). By default the path runs through pages only (`nodeTypes: ["article"]`); widen it to e.g. ["article","entity","topic"] to allow "connected via a shared concept" paths — often the interesting answer to "what relates A and B?". If no graph exists yet, run build_wiki_graph (/wiki-graph) first.',
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'Vault name (see list_vaults). Omit to use the default vault.',
      },
      from: {
        type: 'string',
        description: 'Start page: an exact vault-relative path (e.g. "wiki/Refs/oauth.md"), a bare page name if unique, or a unique path suffix.',
      },
      to: {
        type: 'string',
        description: 'Destination page (same accepted forms as `from`).',
      },
      maxDepth: {
        type: 'number',
        description: `Maximum number of hops to search. A path longer than this is reported as no path. Default ${DEFAULT_PATH_MAX_DEPTH}, capped at ${PATH_MAX_DEPTH_CEIL}.`,
      },
      edgeTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Which edge types count as a link. Default: ["related"] (the wikilink/embed web).',
      },
      nodeTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Node types an INTERMEDIATE hop may have (the two endpoints are always reachable). Default: ["article"] (pages only). Widen to e.g. ["article","entity","topic"] for "connected via a shared concept" paths.',
      },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
};

function asText(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res.content === 'string') return res.content;
  return '';
}

export async function wikiPathTool(registry, args = {}, _deps = {}) {
  const {
    vault: name,
    from,
    to,
    maxDepth = DEFAULT_PATH_MAX_DEPTH,
    edgeTypes,
    nodeTypes,
  } = args;
  const deps = {
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
  };
  const vault = registry.resolveVault(name);

  // Read the knowledge graph written by build_wiki_graph. Only a genuine
  // "not found" means the graph is unbuilt — preserve real operational failures
  // (same guard as build_wiki_tour / get_page_neighbors).
  let raw;
  try {
    raw = await deps.getFileContent(vault, CANONICAL_GRAPH_PATH);
  } catch (err) {
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

  // Delegate to the pure helper. Endpoint-resolution errors (not found /
  // ambiguous) surface as thrown Errors; a genuinely absent path is NOT an
  // error — it comes back as { found: false, path: null }.
  const result = computePath(graph, { from, to, maxDepth, edgeTypes, nodeTypes });

  return ({
    vault: vault.name,
    graphPath: CANONICAL_GRAPH_PATH,
    graphAnalyzedAt: (graph.project && graph.project.analyzedAt) || '',
    query: {
      from: result.from.id,
      to: result.to.id,
      maxDepth: Math.max(1, Math.min(PATH_MAX_DEPTH_CEIL, Number.isFinite(maxDepth) ? Math.floor(maxDepth) : DEFAULT_PATH_MAX_DEPTH)),
      edgeTypes: Array.isArray(edgeTypes) && edgeTypes.length ? edgeTypes : ['related'],
      nodeTypes: Array.isArray(nodeTypes) && nodeTypes.length ? nodeTypes : ['article'],
    },
    from: result.from,
    to: result.to,
    found: result.found,
    length: result.length,
    path: result.path,
  });
}

export const _internals = { asText };
