/**
 * Thin wrapper around `defuddle/node` for use in the ingestion pipeline.
 *
 * `defuddle` (kepano/defuddle, MIT, the same library obsidian-clipper uses
 * for content extraction) parses an HTML page in a JSDOM-backed virtual
 * DOM and returns the "article body" stripped of navigation, header,
 * sidebar, footer, ads, social-share widgets, related-article rails,
 * cookie banners, etc.
 *
 * Why this exists separately from `safe-fetch-html.mjs`:
 *   - `safeFetchHtml` returns the RAW HTML as the page served it.
 *   - `extractMainContent` runs defuddle on top of that raw HTML and
 *     returns ONLY the article body (and metadata defuddle parsed
 *     along the way). This is what the asset downloader feeds to its
 *     image extractor when `defuddleFirst: true` (Phase E.2 default),
 *     so images outside the article (logos, nav icons, ads, share
 *     buttons, tracking pixels) are skipped without a network round-trip.
 *
 * Why a wrapper rather than direct calls:
 *   - One import point so the `defuddle/node` entry is exercised the
 *     same way everywhere (the package has 3 entry shapes — `.`, `./full`,
 *     `./node` — and `./node` is the only one that works in pure Node).
 *   - Injection seam for tests: callers can pass `_defuddleFn` to swap
 *     the real lib for a stub.
 *   - Defensive: if defuddle ever throws on pathological input, we
 *     don't poison the caller — we return the original HTML with
 *     `usedFallback: true` so the caller falls back to raw-HTML
 *     extraction. Worst case is "we didn't gain the filter benefit on
 *     this one page", not "the whole ingestion errored out".
 *
 * @module defuddle-extract
 */

import { Defuddle } from 'defuddle/node';

/**
 * Run defuddle on an HTML string and return the cleaned article HTML
 * (plus a small bag of metadata defuddle parses along the way).
 *
 * @param {string} html — raw HTML
 * @param {object} [opts]
 * @param {string} [opts.url] — page URL, used by defuddle for relative
 *                              URL resolution and Schema.org parsing.
 *                              Optional but recommended.
 * @param {Function} [opts._defuddleFn] — test injection seam.
 *                                        Defaults to `Defuddle` from
 *                                        `defuddle/node`.
 * @returns {Promise<{content: string, title?: string, author?: string,
 *                    image?: string, wordCount?: number, usedFallback: boolean}>}
 *
 *   - `content`: cleaned article HTML. Empty string if defuddle found
 *                no article body (rare — usually means the page is a
 *                pure landing page with no article structure).
 *   - other fields are passed through from defuddle when available.
 *   - `usedFallback: true` when defuddle threw or returned empty content
 *                         — caller should treat `content` as untrusted
 *                         and fall back to scanning the original HTML.
 */
export async function extractMainContent(html, opts = {}) {
  const { url, _defuddleFn = Defuddle } = opts;
  const safeHtml = typeof html === 'string' ? html : '';

  if (safeHtml.trim() === '') {
    return { content: '', usedFallback: true };
  }

  try {
    // Defuddle signature: `Defuddle(input, url, options)` — url is the
    // SECOND positional argument (a string, not an object). Pre-v0.14.7
    // we incorrectly passed `{url}` which triggered "Invalid URL"
    // warnings in defuddle's extractor registry. The function still
    // returned content, but the warnings were noisy.
    const result = await _defuddleFn(safeHtml, url || undefined);
    const content = typeof result?.content === 'string' ? result.content : '';
    if (content.trim() === '') {
      // Defuddle ran without throwing but produced no body — likely a
      // landing/index page. Signal fallback so the caller can decide
      // whether to scan the raw HTML instead.
      return { content: '', usedFallback: true };
    }
    return {
      content,
      title: result?.title || undefined,
      author: result?.author || undefined,
      image: result?.image || undefined,
      wordCount: typeof result?.wordCount === 'number' ? result.wordCount : undefined,
      usedFallback: false,
    };
  } catch {
    // Defuddle is best-effort. Pathological HTML, JSDOM parse errors,
    // CSS-too-complex, etc. should not break ingestion. Signal fallback.
    return { content: '', usedFallback: true };
  }
}
