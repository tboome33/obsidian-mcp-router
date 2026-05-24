/**
 * MCP tool wrapper for `src/helpers/meta-extractor.mjs`. Exposes the
 * deterministic page-metadata extractor as a standalone MCP tool so a
 * Claude agent (or any MCP client) can fetch structured metadata from a
 * URL or raw HTML blob without invoking the full `wiki-ingest` pipeline.
 *
 * Use cases:
 *   - Debug / inspection ("what does the metadata extractor see on this URL?")
 *   - Pre-flight before `wiki-ingest` (decide whether to clip)
 *   - Powering the deterministic frontmatter assembly in `defuddle` +
 *     `wiki-ingest` (Phase B of [[obsidian-clipper-roadmap]])
 *
 * Inputs (one of `url` or `html` required, not both):
 *   - `url`: fetched via `undici` (already a router dep), 10s timeout,
 *           User-Agent identifies as obsidian-mcp-router
 *   - `html`: raw HTML string, used as-is
 *   - `body`: optional plain-text body for accurate wordCount (else computed
 *            from html stripped of tags)
 *
 * Output: see `extractMetadata` JSDoc — `{title, author, published, image,
 *         site, lang, description, wordCount, readingMinutes}`.
 *
 * NOT YET registered in `src/index.mjs` TOOL_REGISTRY — registration ships
 * with Phase B (v0.13.2, defuddle skill upgrade that calls this tool).
 * Until then, this file is dead code, importable only by tests and (later)
 * the wiki-ingest skill via direct require.
 *
 * v0.13.1 hardening: file renamed from `extractPageMetadata.mjs` to
 * `extract-page-metadata.mjs` to align with the kebab-case convention of
 * every other file in `src/tools/`. User-Agent string updated to match the
 * shipped package version.
 */

import { request } from 'undici';
import { extractMetadata } from '../helpers/meta-extractor.mjs';
import { validateUrl, assertHostnameNotPrivate } from '../markdownify/utils.mjs';

const USER_AGENT = 'obsidian-mcp-router/0.13.1 (+https://github.com/tboome33/obsidian-mcp-router)';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MiB — Wikipedia featured articles are <2 MiB
const MAX_REDIRECTS = 5; // industry-standard cap; matches `fetch` and `curl` defaults

export const TOOL_NAME = 'extract_page_metadata';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Deterministically extract metadata from a web page (title, author, published date, cover image, site name, language, description, word count, reading time). Parses Schema.org JSON-LD, OpenGraph tags, and standard HTML meta tags in priority order. Use as a pre-flight before wiki-ingest, or for debugging which signals a page exposes.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL of the page to fetch and extract metadata from. Mutually exclusive with `html`.',
      },
      html: {
        type: 'string',
        description: 'Raw HTML string to parse. Mutually exclusive with `url`.',
      },
      body: {
        type: 'string',
        description: 'Optional plain-text body for accurate word count. If omitted, counted from HTML stripped of tags.',
      },
    },
  },
};

/**
 * MCP tool handler. Invoked by `CallTool` dispatch in `src/index.mjs` once
 * registered.
 *
 * @param {{url?: string, html?: string, body?: string}} args
 * @returns {Promise<{content: Array<{type: 'text', text: string}>}>}
 */
export async function handleExtractPageMetadata(args = {}) {
  const { url, html, body } = args;

  if (!url && !html) {
    throw new Error('extract_page_metadata: one of `url` or `html` is required');
  }
  if (url && html) {
    throw new Error('extract_page_metadata: `url` and `html` are mutually exclusive');
  }

  let resolvedHtml = html;
  if (url) {
    resolvedHtml = await fetchHtml(url);
  }

  const result = extractMetadata(resolvedHtml, body);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * Fetch a URL with SSRF guards, sensible timeout, and size cap. Returns
 * the body as a string. Throws on non-2xx, fetch errors, oversized
 * response, or refused-target (private IP / loopback / link-local).
 *
 * SSRF defense (v0.13.0 review+ pass 1) — reuses the existing
 * `src/markdownify/utils.mjs` helpers:
 *   - `validateUrl(url)`     — sync: scheme allowlist (http/https only)
 *                              + textual private-IP refuse
 *                              (rejects `http://127.0.0.1/...`,
 *                              `http://[::1]/...`, `http://169.254.x/...`,
 *                              `http://10.x/...` etc.)
 *   - `assertHostnameNotPrivate(hostname)` — async: DNS-resolves the
 *                              hostname and refuses if it lands on a
 *                              private/loopback IP. Closes the case where
 *                              `evil.com` resolves to `127.0.0.1`.
 *
 * Known residual gap (acceptable for now, tracked for Phase A.4 hardening):
 * DNS rebinding TOCTOU — between `assertHostnameNotPrivate`'s DNS lookup
 * and undici's own getaddrinfo at connect time, an attacker controlling
 * the DNS could flip the answer. The full mitigation is to pin the
 * connect target via a custom undici dispatcher (cf. `safeFetch` in
 * `src/markdownify/utils.mjs`). For the metadata extractor — which is
 * scoped to defuddle pre-flight and not wired to dispatch on user-typed
 * URLs at production rates — the simpler 2-stage guard is sufficient
 * until Phase A.4 wires the tool into TOOL_REGISTRY.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchHtml(url) {
  // Manual redirect loop: undici.request does NOT follow redirects by
  // default, and we DON'T want it to via its built-in `maxRedirections`
  // option either — that would skip our SSRF guard on each hop. Instead
  // we re-run BOTH SSRF stages (sync validateUrl + async DNS check) on
  // every hop, so a chain like `evil.com → http://attacker.com → http://
  // 127.0.0.1/internal` is refused at the final hop.
  //
  // Why redirects matter at all: many real article URLs do HTTP→HTTPS,
  // canonical-host normalization, paywall login redirects, etc. The
  // pre-pass-3 code rejected these as `HTTP 301/302` errors. Review+
  // pass 2 finding F (codex).
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Stage 1 — sync scheme + textual private-IP check.
    try {
      validateUrl(current);
    } catch (e) {
      throw new Error(`extract_page_metadata: ${e.message}`);
    }

    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error(`extract_page_metadata: invalid URL: ${current}`);
    }

    // Stage 2 — async DNS resolution + refusal of private-resolved hosts.
    try {
      await assertHostnameNotPrivate(parsed.hostname);
    } catch (e) {
      throw new Error(`extract_page_metadata: ${e.message}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const { statusCode, headers, body: respBody } = await request(current, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal,
        maxRedirections: 0, // we handle them manually
      });

      // 3xx with Location → follow manually after re-SSRF.
      if (statusCode >= 300 && statusCode < 400) {
        const location = headers.location || headers.Location;
        if (!location) {
          throw new Error(`extract_page_metadata: HTTP ${statusCode} without Location header`);
        }
        // Drain body so undici can release the socket cleanly.
        try { for await (const _ of respBody) { /* discard */ } } catch { /* ignore */ }
        // Resolve relative redirect targets against the current URL.
        current = new URL(location, current).href;
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`extract_page_metadata: HTTP ${statusCode} from ${current}`);
      }

      const chunks = [];
      let total = 0;
      for await (const chunk of respBody) {
        total += chunk.length;
        if (total > MAX_HTML_BYTES) {
          throw new Error(`extract_page_metadata: response exceeds ${MAX_HTML_BYTES} bytes`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf-8');
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`extract_page_metadata: too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
}
