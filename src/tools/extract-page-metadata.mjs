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
 *   - `url`: fetched via shared `safe-fetch-html.mjs` (pinned-IP SSRF
 *           guard + manual redirect re-SSRF per hop, 10s timeout, 5 MiB
 *           cap, User-Agent auto-synced with package version)
 *   - `html`: raw HTML string, used as-is
 *   - `body`: optional plain-text body for accurate wordCount (else
 *            computed from html stripped of tags)
 *
 * Output: raw payload `{title, author, published, image, site, lang,
 *         description, wordCount, readingMinutes}`. The router's
 *         `wrapResult` (src/index.mjs) JSON-stringifies it into the
 *         standard MCP content block — the handler MUST return the
 *         raw payload, NOT a pre-wrapped `{content:[...]}` shape
 *         (cf. v0.13.4 review+ finding P2 wrapResult double-wrap).
 *
 * v0.13.4 hardening:
 *   - Switched to shared `safe-fetch-html.mjs` (pinned-IP dispatcher
 *     closes the DNS-rebinding TOCTOU that the simpler 2-stage guard
 *     left open in v0.13.0-v0.13.3).
 *   - User-Agent string now auto-derived from `PKG_VERSION` (no more
 *     manual hardcoding that drifted across releases).
 *   - Handler returns raw payload object (no `{content:[...]}` wrap)
 *     so the router's CallTool dispatcher's wrapResult doesn't
 *     double-wrap.
 *
 * Registered in `src/index.mjs` TOOL_REGISTRY as `extract_page_metadata`
 * since v0.13.2 (Phase B). Excluded from WRITE_TOOL_NAMES (no vault
 * mutation).
 */

import { extractMetadata } from '../helpers/meta-extractor.mjs';
import { safeFetchHtml } from '../helpers/safe-fetch-html.mjs';
import { detectLatexInHtml, convertMathmlBlocksInHtml } from '../helpers/latex-preserver.mjs';

export const TOOL_NAME = 'extract_page_metadata';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Deterministically extract metadata from a web page (title, author, published date, cover image, site name, language, description, word count, reading time, hasLatex math detection). Parses Schema.org JSON-LD, OpenGraph tags, and standard HTML meta tags in priority order. Also detects LaTeX/math signals (MathML, KaTeX, MathJax, data-latex attrs, $...$ dollar delimiters) so callers like wiki-ingest can set `has_latex: true` frontmatter and preserve math verbatim. Use as a pre-flight before wiki-ingest, or for debugging which signals a page exposes.',
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
 * MCP tool handler. Invoked by `CallTool` dispatch in `src/index.mjs`.
 * Returns the raw metadata payload — the router's `wrapResult` does
 * the `{content:[{type:'text', text: JSON.stringify(...)}]}` wrap.
 *
 * @param {{url?: string, html?: string, body?: string}} args
 * @returns {Promise<object>} — raw `extractMetadata` output
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
    try {
      const fetched = await safeFetchHtml(url);
      resolvedHtml = fetched.html;
    } catch (e) {
      // Re-throw with the tool name prefixed so the error trace clearly
      // points to which MCP tool failed (vs. just "safe-fetch-html: ...").
      throw new Error(`extract_page_metadata: ${e.message}`);
    }
  }

  const metadata = extractMetadata(resolvedHtml, body);

  // Phase D (v0.13.10+) — augment with LaTeX detection so wiki-ingest can set
  // `has_latex: true` in frontmatter and instruct Claude to preserve $...$
  // verbatim in the body instead of reformatting it to Unicode.
  const latex = detectLatexInHtml(resolvedHtml);

  // Phase D.2 (v0.14.6+) — when MathML blocks are present, extract them as
  // LaTeX source. The caller (wiki-ingest skill) can use the resulting
  // `mathmlLatex` array to verify what equations the page contains, OR
  // surface them in a `## Équations` section of the source page body. The
  // actual in-place substitution happens earlier in the pipeline
  // (webpageToMarkdown's pre-process transform), so the markdown body
  // already has the equations inlined — this field is for audit + UI.
  let mathmlLatex = [];
  if (latex.signals.mathml > 0) {
    const conv = convertMathmlBlocksInHtml(resolvedHtml);
    mathmlLatex = conv.conversions
      .filter((c) => c.converted)
      .map((c) => ({ latex: c.latex, display: c.display }));
  }

  // `metadata` is title / description / author / site-name lifted out of a
  // FETCHED page — attacker-authored strings, every one of them, arriving on
  // the success path where nothing else was looking at them.
  // NO_TRUNCATION: wrapping this in a bare `sanitizeResponse` also applied the
  // 16 KiB LABEL cap, and a page's `description` or a converted `mathmlLatex`
  // entry routinely exceeds it — a 20,000-character description came back as
  // 16,371. Second instance of the same mistake as the 1 MiB converter cap, in
  // the same round: reaching for a sanitiser and inheriting its size policy
  // without deciding whether that policy fits the payload.
  return ({
    ...metadata,
    hasLatex: latex.hasLatex,
    latexSignals: latex.signals,
    mathmlLatex,
  });
}
