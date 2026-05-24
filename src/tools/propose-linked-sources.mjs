/**
 * MCP tool wrapper around `src/helpers/link-extractor.mjs`. Phase C of
 * the obsidian-clipper feature-borrowing roadmap (v0.13.3, Level 1
 * "Ask mode").
 *
 * Inputs (one of `url` or `html` required, not both):
 *   - `url`: fetched via undici with SSRF guards + redirect re-SSRF
 *           (same path as `extract_page_metadata`). The fetched HTML
 *           is passed to the extractor along with the final canonical
 *           URL (post-redirect) as `baseUrl`.
 *   - `html`: raw HTML string, used as-is. `baseUrl` REQUIRED in this
 *            branch since we have no fetch to derive it from.
 *   - `maxCandidates`: cap on output length (default 30).
 *
 * Output: `{baseUrl, candidates: [{href, text, contextSnippet, score,
 *         sourceSection, sameDomain}]}` JSON-stringified into a single
 * MCP `content[0].text` block. The wiki-ingest skill renders the
 * candidates for user review (step 4.5 of that skill).
 *
 * SSRF + redirect handling: copied from `extract-page-metadata.mjs`
 * (5-pass review-hardened). Same `validateUrl` + `assertHostnameNotPrivate`
 * stages, same manual redirect loop with re-SSRF per hop. Refactoring
 * both into a shared `safeFetchHtml` helper is tracked for Phase A.4
 * hardening (cf. roadmap follow-ups).
 *
 * Why this tool exists (vs. just calling `link-extractor` from a
 * skill): the skill is markdown — it can't `import` JS. The MCP tool
 * is the bridge. The skill calls `propose_linked_sources({url: '...'})`
 * via the standard MCP CallTool dispatch, gets back the JSON payload,
 * presents it to the user.
 */

import { request } from 'undici';
import { extractLinks } from '../helpers/link-extractor.mjs';
import { validateUrl, assertHostnameNotPrivate } from '../markdownify/utils.mjs';

const USER_AGENT = 'obsidian-mcp-router/0.13.3 (+https://github.com/tboome33/obsidian-mcp-router)';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_REDIRECTS = 5;

export const TOOL_NAME = 'propose_linked_sources';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Scan a webpage's body for hyperlinks worth proposing for recursive ingestion. Returns candidates ranked by heuristic score (same-domain +2, in a 'Related'/'See also' section +3, social/boilerplate hostname -5). Used by the wiki-ingest skill (step 4.5) to present a user-in-the-loop selection UI before fanning out to ingest the chosen links. Strips nav/footer/aside/header semantic boilerplate; skips fragment-only, mailto, tel, javascript schemes; dedupes by canonical href.",
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
 * Handler. Invoked by `CallTool` dispatch in `src/index.mjs` via
 * TOOL_HANDLERS map.
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
    const { html: fetchedHtml, finalUrl } = await fetchHtmlWithRedirects(url);
    resolvedHtml = fetchedHtml;
    resolvedBase = finalUrl;
  } else {
    resolvedHtml = html;
    resolvedBase = explicitBaseUrl;
  }

  const candidates = extractLinks(resolvedHtml, resolvedBase, {
    maxCandidates: typeof maxCandidates === 'number' ? maxCandidates : undefined,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            baseUrl: resolvedBase,
            count: candidates.length,
            candidates,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Fetch HTML with SSRF guards + manual redirect handling. Returns
 * `{html, finalUrl}` so the caller has the post-redirect canonical
 * URL for same-domain scoring. Duplicated from `extract-page-metadata.mjs`
 * — refactor to shared `safeFetchHtml` is a tracked follow-up.
 */
async function fetchHtmlWithRedirects(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      validateUrl(current);
    } catch (e) {
      throw new Error(`propose_linked_sources: ${e.message}`);
    }

    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error(`propose_linked_sources: invalid URL: ${current}`);
    }

    try {
      await assertHostnameNotPrivate(parsed.hostname);
    } catch (e) {
      throw new Error(`propose_linked_sources: ${e.message}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const { statusCode, headers, body: respBody } = await request(current, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal,
        maxRedirections: 0,
      });

      if (statusCode >= 300 && statusCode < 400) {
        const location = headers.location || headers.Location;
        if (!location) {
          throw new Error(`propose_linked_sources: HTTP ${statusCode} without Location header`);
        }
        try { for await (const _ of respBody) { /* drain */ } } catch { /* ignore */ }
        current = new URL(location, current).href;
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`propose_linked_sources: HTTP ${statusCode} from ${current}`);
      }

      const chunks = [];
      let total = 0;
      for await (const chunk of respBody) {
        total += chunk.length;
        if (total > MAX_HTML_BYTES) {
          throw new Error(`propose_linked_sources: response exceeds ${MAX_HTML_BYTES} bytes`);
        }
        chunks.push(chunk);
      }
      return {
        html: Buffer.concat(chunks).toString('utf-8'),
        finalUrl: current,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`propose_linked_sources: too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
}
