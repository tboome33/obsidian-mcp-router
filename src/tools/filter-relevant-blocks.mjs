/**
 * filter_relevant_blocks — BM25 relevance second-pass over markdown the caller
 * ALREADY holds. No fetch, no vault I/O, no LLM: a deterministic topical filter.
 *
 * Borrowing #1 from Crawl4AI (workflow W-A). The heavy lifting lives in the pure
 * helper `../helpers/bm25-filter.mjs`; this file is only the thin tool shell
 * (validate → delegate → return the helper's structured result). Same
 * deterministic-core / thin-tool split as `wiki-path.mjs`.
 *
 * Read-only wrt vault state → excluded from WRITE_TOOL_NAMES (stays exposed on
 * OBSIDIAN_ROUTER_READONLY deployments, like the conversion tools). Takes no
 * `vault` argument — it operates on a markdown string, independent of any vault.
 */

import { bm25FilterBlocks } from '../helpers/bm25-filter.mjs';

export const TOOL_NAME = 'filter_relevant_blocks';

// Reject only a missing / non-string value. Unlike the conversion tools'
// `assertString`, an EMPTY string is allowed through: an empty `query` is the
// documented `empty-query` no-op, and empty `markdown` degrades to a
// `too-few-blocks` no-op — neither is an error.
function assertProvidedString(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`Missing required argument: ${fieldName}`);
  }
}

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Filter markdown you ALREADY have down to the blocks relevant to a topic, using a BM25 relevance score — no fetching, no LLM, fully deterministic. Use it as a cheap second pass after acquiring a page (e.g. after the defuddle skill in wiki-ingest) when you know the ingestion theme: it drops off-topic blocks (intros, author bios, digressions) so downstream synthesis is denser and cheaper. Frontmatter and headings are always kept; a code block follows the relevance of the prose that introduces it. Safety nets: a query with no usable token is a strict no-op (output identical to input); documents with fewer than 4 scorable blocks are left untouched; and if filtering would remove more than 70% of the content it returns the original intact (usedFallback). Returns { markdown, filtered, stats } (pass includeScores for per-block debug scores). Exact-token matching only — no stemming/synonyms.',
  inputSchema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: 'The markdown to filter (already acquired — this tool never fetches).',
      },
      query: {
        type: 'string',
        description:
          'The relevance topic — the keywords of what you are ingesting. An empty/whitespace query is a no-op that returns the input unchanged.',
      },
      threshold: {
        type: 'number',
        description:
          'Relevance cutoff in [0,1], normalized against the top-scoring block. Default 0.2. Higher = stricter (keeps fewer blocks).',
      },
      includeScores: {
        type: 'boolean',
        description: 'When true, also return a `scores` array with the per-block raw/normalized scores (debug). Default false.',
      },
    },
    required: ['markdown', 'query'],
    additionalProperties: false,
  },
};

export async function filterRelevantBlocksTool(_registry, args = {}) {
  const { markdown, query, threshold, includeScores } = args;
  assertProvidedString(markdown, 'markdown');
  assertProvidedString(query, 'query');
  return bm25FilterBlocks({
    markdown,
    query,
    threshold,
    includeScores: includeScores === true,
  });
}

export const _internals = { assertProvidedString };
