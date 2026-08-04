/**
 * find_boundary_pages — the "frontier" pages of a wiki: crossroads everybody
 * links to that stay thin inside. Read-only: reads
 * `wiki-meta/graph/knowledge-graph.json` (written by `build_wiki_graph`) and
 * ranks its article nodes. Nothing in the vault is touched.
 *
 * Borrowing C10 of [[roadmap-emprunts]] §2.17 — "une requête de plus sur
 * build_wiki_graph". Same deterministic-core / thin-tool split as
 * `get_page_neighbors` and `wiki_path`: this module is only the I/O shell
 * (read graph → validate → delegate to `scoreBoundaryPages` → sanitize).
 *
 * The score PROPOSES ATTENTION — it does not establish importance. See
 * `helpers/boundary-score.mjs` for the formula, its three stated constants, and
 * the written-down limitations of the substance measure.
 */

import * as defaultRestClient from '../rest-client.mjs';
import { sanitizeResponse } from '../helpers/sanitize.mjs';
import {
  scoreBoundaryPages,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_EXEMPT_TYPES,
} from '../helpers/boundary-score.mjs';
import { CANONICAL_GRAPH_PATH } from './build-wiki-graph.mjs';
import { isMissingReadError, graphMissingError } from '../helpers/missing-read-guard.mjs';

/** An actionable refusal — see the twin in `helpers/boundary-score.mjs`. */
function refusal(message) {
  const err = new Error(message);
  err.kind = 'validation';
  return err;
}

export const TOOL_NAME = 'find_boundary_pages';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Rank the "frontier" pages of a wiki — the crossroads many pages link to that stay thin inside — from the knowledge graph (`wiki-meta/graph/knowledge-graph.json`, written by build_wiki_graph). Read-only, deterministic, no LLM: the same graph always yields the same ranking. Score = inbound links damped by length (`inbound / (1 + words/100)`: full weight on an empty page, halved at 100 words, a tenth at 900), multiplied by a staleness factor that runs from ×1 (edited on the build date, or date unknown) to ×2 (untouched for a year or more). Use it to decide WHICH PAGES DESERVE RESEARCH — it is the upstream companion to /autoresearch (which picks questions inside an existing program), and an informational section of /wiki-lint. The score PROPOSES ATTENTION; it does not establish importance, quality or priority, and a thin page is very often legitimately thin. Pages typed redirect/source/answer are held out by default (being thin is their job) and the count held out is reported. If the graph predates this feature it carries no substance measurements and the tool REFUSES rather than treating every page as empty — rebuild with build_wiki_graph (/wiki-graph) first.',
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'Vault name (see list_vaults). Omit to use the default vault.',
      },
      limit: {
        type: 'number',
        description: `How many pages to return, best-scoring first. Default ${DEFAULT_LIMIT}, hard ceiling ${MAX_LIMIT}. \`truncated\` says whether more were ranked.`,
      },
      minInbound: {
        type: 'number',
        description: 'Ignore pages with fewer than this many inbound links. Default 1 — a page nobody links to is not a crossroads (it is an orphan, which is wiki-lint Check A\'s subject, not this one).',
      },
      exemptTypes: {
        type: 'array',
        items: { type: 'string' },
        description: `Frontmatter \`type:\` values to hold out of the ranking. Default ${JSON.stringify([...DEFAULT_EXEMPT_TYPES])} — pages whose thinness is by design. Pass [] to score every page (expect migration stubs and capture records to dominate).`,
      },
      exemptStatuses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Frontmatter `status:` values to hold out of the ranking (e.g. ["superseded"]). NO default — closed pages stay visible and annotated (every row carries `status`), and hiding them is a per-vault calibration you must ask for. Matching is trimmed, then exact, case-insensitive; a page with no usable status (absent, blank, non-string) is never exempted; a page matching both a type and a status exemption is counted once, under the type. Note the limit: this only sees what the metadata says — a topically closed page still marked `status: active` passes any filter.',
      },
      asOf: {
        type: 'string',
        description: 'The date recency is measured against, `YYYY-MM-DD`. Defaults to the graph\'s own build stamp, which makes the ranking a pure function of the graph file (same graph ⇒ same scores, forever). Override to ask "how would this look today?" against an older graph.',
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

export async function findBoundaryPagesTool(registry, args = {}, _deps = {}) {
  const { vault: name, limit, minInbound, exemptTypes, exemptStatuses, asOf } = args;
  const deps = { getFileContent: _deps.getFileContent || defaultRestClient.getFileContent };
  const vault = registry.resolveVault(name);

  // Read the graph. Only a genuine "not found" means it was never built —
  // preserve real operational failures (vault offline, bad key, timeout) rather
  // than misdirecting the user to /wiki-graph (same guard as get_page_neighbors).
  let raw;
  try {
    raw = await deps.getFileContent(vault, CANONICAL_GRAPH_PATH);
  } catch (err) {
    // Shared with build_wiki_tour / get_page_neighbors / wiki_path — one
    // definition, so the ENOTFOUND lesson cannot be re-learned per tool.
    if (isMissingReadError(err)) throw graphMissingError(CANONICAL_GRAPH_PATH);
    throw err;
  }

  let graph;
  try {
    graph = JSON.parse(asText(raw));
  } catch {
    throw refusal(
      `Knowledge graph at ${CANONICAL_GRAPH_PATH} is not valid JSON — re-run /wiki-graph.`,
    );
  }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw refusal(
      `Knowledge graph at ${CANONICAL_GRAPH_PATH} is malformed (missing nodes/edges) — re-run /wiki-graph.`,
    );
  }

  const result = scoreBoundaryPages(graph, { limit, minInbound, exemptTypes, exemptStatuses, asOf });

  return sanitizeResponse({
    vault: vault.name,
    graphPath: CANONICAL_GRAPH_PATH,
    // The graph is a SNAPSHOT. A stale one ranks pages that may no longer exist,
    // so its build stamp travels with every answer rather than being something
    // the caller has to think to ask for.
    graphAnalyzedAt: (graph.project && graph.project.analyzedAt) || '',
    ...result,
    note: 'The score proposes attention, not importance. A thin page is often legitimately thin — a definition, a deliberate index, a disambiguation. Read before acting.',
  });
}

export const _internals = { asText };
