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
 * v0.14.7 P2 hardening — defuddle's deps are `optionalDependencies`:
 *   `defuddle@0.18.1` declares `linkedom`, `mathml-to-latex`, `temml`
 *   and `turndown` as OPTIONAL dependencies. With a normal `npm install`
 *   they're installed; but `npm ci --omit=optional` (used in some CI
 *   pipelines, containerized installs, and `node:slim` Docker images)
 *   skips them — then `import 'defuddle/node'` throws `ERR_MODULE_NOT_FOUND`
 *   on `linkedom` at module load. If we did a top-level import here,
 *   that load would happen as part of `src/index.mjs` boot (via
 *   `download-page-assets.mjs` → this file) and the WHOLE MCP server
 *   would fail to start.
 *
 *   Fix: lazy-import inside the function. The wrapper is already
 *   defensive (try/catch + `usedFallback`), so a missing module
 *   degrades gracefully to "defuddle unavailable → caller falls back
 *   to raw HTML scanning". Node caches the resolved module after the
 *   first import, so the call-site cost is amortized to one resolution
 *   per process.
 *
 * @module defuddle-extract
 */

// Cache the resolved `Defuddle` function across calls. Hit on call 2+.
let _cachedDefuddle = null;
let _cachedDefuddleError = null;

async function loadDefuddle() {
  if (_cachedDefuddle) return _cachedDefuddle;
  if (_cachedDefuddleError) throw _cachedDefuddleError;
  try {
    const mod = await import('defuddle/node');
    _cachedDefuddle = mod.Defuddle;
    if (typeof _cachedDefuddle !== 'function') {
      // Defensive: defuddle changed its export shape upstream. Treat as
      // load failure so we hit the usedFallback path.
      throw new Error('defuddle/node did not export a Defuddle function');
    }
    return _cachedDefuddle;
  } catch (e) {
    _cachedDefuddleError = e;
    throw e;
  }
}

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
 *                                        Defaults to lazy-loaded
 *                                        `Defuddle` from `defuddle/node`.
 * @returns {Promise<{content: string, title?: string, author?: string,
 *                    image?: string, wordCount?: number, usedFallback: boolean}>}
 *
 *   - `content`: cleaned article HTML. Empty string if defuddle found
 *                no article body (rare — usually means the page is a
 *                pure landing page with no article structure).
 *   - other fields are passed through from defuddle when available.
 *   - `usedFallback: true` when defuddle threw, the module wasn't
 *                         installed (`--omit=optional`), or returned
 *                         empty content — caller should treat `content`
 *                         as untrusted and fall back to scanning the
 *                         original HTML.
 */
export async function extractMainContent(html, opts = {}) {
  const { url, _defuddleFn } = opts;
  const safeHtml = typeof html === 'string' ? html : '';

  if (safeHtml.trim() === '') {
    return { content: '', usedFallback: true };
  }

  // Resolve the defuddle function lazily — see module comment for why.
  // Tests bypass this by passing `_defuddleFn` directly.
  let defuddle;
  if (_defuddleFn) {
    defuddle = _defuddleFn;
  } else {
    try {
      defuddle = await loadDefuddle();
    } catch {
      // Module not installed (--omit=optional) OR upstream shape change.
      // Either way, signal fallback — the caller scans raw HTML.
      return { content: '', usedFallback: true };
    }
  }

  try {
    // Defuddle signature: `Defuddle(input, url, options)` — url is the
    // SECOND positional argument (a string, not an object). Pre-v0.14.7
    // we incorrectly passed `{url}` which triggered "Invalid URL"
    // warnings in defuddle's extractor registry. The function still
    // returned content, but the warnings were noisy.
    const result = await defuddle(safeHtml, url || undefined);
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
