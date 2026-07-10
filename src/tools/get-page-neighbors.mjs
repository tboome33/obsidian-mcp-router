/**
 * get_page_neighbors — the neighbourhood of ONE wiki page, read from the
 * knowledge graph. Read-only: reads `wiki-meta/graph/knowledge-graph.json`
 * (written by `build_wiki_graph`), resolves the page, and returns its neighbours
 * — the pages it links to (`forward`), the pages that link to it (`backward`),
 * or both — out to a bounded hop depth.
 *
 * Same deterministic-core / thin-tool split as `build_wiki_tour`: this module is
 * only the I/O shell (read graph → validate → delegate to `computeNeighbors` →
 * sanitize). It reads the SAME persisted graph the builder wrote — it does NOT
 * re-extract wikilinks from page bodies (the mistake `get_wiki_context_pack`'s
 * `graphNeighbors[]` makes), so it inherits the builder's ambiguity resolution
 * and its backlink bookkeeping for free. DI (`_deps`) for testability.
 *
 * Roadmap item W-A of [[page-neighbors-roadmap]].
 */

import * as defaultRestClient from '../rest-client.mjs';
import { sanitizeResponse } from '../helpers/sanitize.mjs';
import {
  computeNeighbors,
  DEFAULT_MAX_NEIGHBORS,
  MAX_NEIGHBORS_CEIL,
  MAX_DEPTH_CEIL,
} from '../helpers/graph-neighbors.mjs';
import { CANONICAL_GRAPH_PATH } from './build-wiki-graph.mjs';

export const TOOL_NAME = 'get_page_neighbors';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Return the neighbours of ONE wiki page from the knowledge graph (the `wiki-meta/graph/knowledge-graph.json` written by build_wiki_graph). Read-only. Give a page (exact vault-relative path, or just its name if unambiguous) and get the pages it links to (`forward`), the pages that link to it (`backward`), or both (default), out to `depth` hops. By default only page↔page links are followed (`edgeTypes: ["related"]`, `nodeTypes: ["article"]`) so you get pages, not the concepts/claims/sources the page also touches — widen `nodeTypes` (e.g. ["entity"]) to ask "which concepts does this page mention?" instead. Results are capped (`maxNeighbors`, default 50) and sorted by hop distance then id. An ambiguous page name is REFUSED with the list of candidates so you can re-specify. Two optional structural enrichments (opt-in, off by default, zero extra I/O): `includeSameFolder` for other pages in the same directory, `includeSharedTags` for pages sharing a real tag. If no graph exists yet, run build_wiki_graph (/wiki-graph) first.',
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'Vault name (see list_vaults). Omit to use the default vault.',
      },
      page: {
        type: 'string',
        description: 'The page whose neighbours you want: an exact vault-relative path (e.g. "wiki/Refs/oauth.md"), a bare page name if unique ("oauth"), or a unique path suffix ("Refs/oauth").',
      },
      direction: {
        type: 'string',
        enum: ['both', 'forward', 'backward'],
        description: 'forward = pages THIS page links to; backward = pages that link to it; both = union. Default: both.',
      },
      depth: {
        type: 'number',
        description: `Hop radius: 1 = direct neighbours, 2 = neighbours-of-neighbours, etc. Default 1, capped at ${MAX_DEPTH_CEIL}.`,
      },
      edgeTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Which edge types to follow. Default: ["related"] (the wikilink/embed web). Other graph edge types: "cites" (page→source), "categorized_under" (page→index topic).',
      },
      nodeTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Which node types to keep AND walk through. Default: ["article"] (pages only). Use ["entity"] for mentioned concepts, ["source"] for cited sources, ["topic"] for index sections.',
      },
      maxNeighbors: {
        type: 'number',
        description: `Cap on the number of neighbours returned. Default ${DEFAULT_MAX_NEIGHBORS}, hard ceiling ${MAX_NEIGHBORS_CEIL}. When the cap trims the list, \`truncated\` is true.`,
      },
      includeSameFolder: {
        type: 'boolean',
        description: 'When true, also return OTHER pages living in the same folder as `page` (a structural signal, not a graph link) — off by default. Result in `sameFolderNeighbors`.',
      },
      includeSharedTags: {
        type: 'boolean',
        description: 'When true, also return pages sharing a real tag with `page` (the universal "article" tag every page carries is ignored) — off by default. Result in `sharedTagNeighbors`, each entry carrying `sharedTags`.',
      },
    },
    required: ['page'],
    additionalProperties: false,
  },
};

function asText(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res.content === 'string') return res.content;
  return '';
}

export async function getPageNeighborsTool(registry, args = {}, _deps = {}) {
  const {
    vault: name,
    page,
    direction = 'both',
    depth = 1,
    edgeTypes,
    nodeTypes,
    maxNeighbors = DEFAULT_MAX_NEIGHBORS,
    includeSameFolder = false,
    includeSharedTags = false,
  } = args;
  const deps = {
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
  };
  const vault = registry.resolveVault(name);

  // Read the knowledge graph written by build_wiki_graph. Only a genuine
  // "not found" means the graph is unbuilt — preserve real operational failures
  // (vault offline, bad key, timeout) instead of misdirecting the user to
  // /wiki-graph (same guard as build_wiki_tour).
  let raw;
  try {
    raw = await deps.getFileContent(vault, CANONICAL_GRAPH_PATH);
  } catch (err) {
    const status = err && (err.status ?? err.statusCode);
    const isNotFound =
      (err && err.kind === 'not_found') ||
      status === 404 ||
      /not.?found|enoent|no such file/i.test(String((err && err.message) || ''));
    if (isNotFound) {
      throw new Error(
        `No knowledge graph at ${CANONICAL_GRAPH_PATH}. Run build_wiki_graph (the /wiki-graph skill) first.`,
      );
    }
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

  // Delegate the maths to the pure helper. Page-resolution errors (not found /
  // ambiguous) surface as thrown Errors with actionable messages.
  const result = computeNeighbors(graph, {
    page,
    direction,
    depth,
    edgeTypes,
    nodeTypes,
    maxNeighbors,
    includeSameFolder,
    includeSharedTags,
  });

  return sanitizeResponse({
    vault: vault.name,
    graphPath: CANONICAL_GRAPH_PATH,
    graphAnalyzedAt: (graph.project && graph.project.analyzedAt) || '',
    query: {
      page: result.page.id,
      direction: direction === 'forward' || direction === 'backward' ? direction : 'both',
      depth: Math.max(1, Math.min(MAX_DEPTH_CEIL, Number.isFinite(depth) ? Math.floor(depth) : 1)),
      edgeTypes: Array.isArray(edgeTypes) && edgeTypes.length ? edgeTypes : ['related'],
      nodeTypes: Array.isArray(nodeTypes) && nodeTypes.length ? nodeTypes : ['article'],
    },
    page: result.page,
    neighborCount: result.neighbors.length,
    totalFound: result.totalFound,
    truncated: result.truncated,
    neighbors: result.neighbors,
    sameFolderNeighbors: result.sameFolderNeighbors,
    sameFolderTruncated: result.sameFolderTruncated,
    sameFolderTotalFound: result.sameFolderTotalFound,
    sharedTagNeighbors: result.sharedTagNeighbors,
    sharedTagTruncated: result.sharedTagTruncated,
    sharedTagTotalFound: result.sharedTagTotalFound,
  });
}

export const _internals = { asText };
