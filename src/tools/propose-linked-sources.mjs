/**
 * MCP tool wrapper around `src/helpers/link-extractor.mjs`. Phase C of
 * the obsidian-clipper feature-borrowing roadmap (v0.13.3, Level 1
 * "Ask mode" — user picks which candidate links to also ingest).
 *
 * Inputs (one of `url` or `html` required, not both):
 *   - `url`: fetched via shared `safe-fetch-html.mjs` (pinned-IP SSRF
 *           guard + manual redirect re-SSRF per hop). The fetched HTML
 *           is passed to the extractor along with the FINAL canonical
 *           URL (post-redirect) as `baseUrl` so same-domain scoring
 *           uses the resolved publisher, not the input host.
 *   - `html`: raw HTML string, used as-is. `baseUrl` REQUIRED in this
 *            branch since we have no fetch to derive it from.
 *   - `maxCandidates`: cap on output length (default 30).
 *
 * Output: raw payload `{baseUrl, count, candidates}`. The router's
 *         `wrapResult` (src/index.mjs) JSON-stringifies it into the
 *         standard MCP content block — the handler MUST NOT return a
 *         pre-wrapped `{content:[...]}` shape (cf. v0.13.4 review+
 *         finding P2 wrapResult double-wrap).
 *
 * v0.13.4 hardening:
 *   - Switched to shared `safe-fetch-html.mjs` (closes the SSRF
 *     TOCTOU P1 finding that the v0.13.3 inline implementation had).
 *   - User-Agent string auto-derived from PKG_VERSION.
 *   - Handler returns raw payload (no double-wrap).
 *
 * Registered in `src/index.mjs` TOOL_REGISTRY as `propose_linked_sources`.
 * Excluded from WRITE_TOOL_NAMES (no vault mutation).
 */

import { extractLinks } from '../helpers/link-extractor.mjs';
import { safeFetchHtml } from '../helpers/safe-fetch-html.mjs';

export const TOOL_NAME = 'propose_linked_sources';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Scan a webpage's body for hyperlinks worth proposing for recursive ingestion. Returns candidates ranked by heuristic score (same-domain +2, in a 'Related'/'See also' section +3, social/boilerplate hostname -5). Used by the wiki-ingest skill (step 4.5) to present a user-in-the-loop selection UI before fanning out to ingest the chosen links. Strips nav/footer/aside/header semantic boilerplate; skips fragment-only, mailto, tel, javascript schemes; dedupes by canonical href keeping highest score.",
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL of the page to fetch and scan. Mutually exclusive with `html`.',
      },
      html: {
        type: 'string',
        description: 'Raw HTML string to scan. Mutually exclusive with `url`. Requires `baseUrl`.',
      },
      baseUrl: {
        type: 'string',
        description: 'Absolute URL to resolve relative hrefs against and score same-domain matches. Required when `html` is provided; auto-derived (post-redirect canonical) when `url` is provided.',
      },
      maxCandidates: {
        type: 'number',
        description: 'Cap output to top N candidates by score (default 30).',
      },
    },
  },
};

/**
 * Handler. Returns the raw payload — wrapResult does the MCP shape wrap.
 */
export async function handleProposeLinkedSources(args = {}) {
  const { url, html, baseUrl: explicitBaseUrl, maxCandidates } = args;

  if (!url && !html) {
    throw new Error('propose_linked_sources: one of `url` or `html` is required');
  }
  if (url && html) {
    throw new Error('propose_linked_sources: `url` and `html` are mutually exclusive');
  }
  if (html && !explicitBaseUrl) {
    throw new Error('propose_linked_sources: `baseUrl` is required when `html` is provided');
  }

  let resolvedHtml;
  let resolvedBase;
  if (url) {
    try {
      const fetched = await safeFetchHtml(url);
      resolvedHtml = fetched.html;
      resolvedBase = fetched.finalUrl;
    } catch (e) {
      throw new Error(`propose_linked_sources: ${e.message}`);
    }
  } else {
    resolvedHtml = html;
    resolvedBase = explicitBaseUrl;
  }

  const candidates = extractLinks(resolvedHtml, resolvedBase, {
    maxCandidates: typeof maxCandidates === 'number' ? maxCandidates : undefined,
  });

  // Link TEXT and titles come from the fetched page — the anchor label is
  // attacker prose by construction. sanitizeResponse walks the candidate list
  // (objects in an array), which is what this returns.
  return ({
    baseUrl: resolvedBase,
    count: candidates.length,
    candidates,
  });
}
