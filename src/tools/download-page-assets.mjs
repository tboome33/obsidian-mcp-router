/**
 * MCP tool wrapper for `src/helpers/asset-downloader.mjs`. Exposes the
 * Phase E (v0.14.x, [[obsidian-clipper-roadmap]]) asset downloader as
 * an opt-in MCP tool.
 *
 * The `wiki-ingest` skill is the primary consumer: when the user passes
 * `--save-assets`, the skill calls this tool with `url` (the source page)
 * and an `outputDir` derived from the vault path + source slug
 * (typically `<vault>/wiki/.assets/<slug>/`). The tool fetches the page,
 * extracts image URLs, downloads each (SSRF-safe, dimension-skipped, size-
 * capped), and returns a manifest the skill uses to rewrite the markdown
 * `![](url)` references to local paths.
 *
 * Inputs:
 *   - `url`: page URL to scan for assets (mutually exclusive with `html`)
 *   - `html`: raw HTML to scan (mutually exclusive with `url`)
 *   - `baseUrl`: required when `html` is given — used to resolve relative
 *               image URLs. When `url` is given, it doubles as baseUrl.
 *   - `outputDir`: absolute path where downloaded assets land. Required.
 *                  Must be inside `MD_ALLOWED_PATHS` if that env var is set.
 *   - `defuddleFirst` (v0.14.7, default true): run defuddle to extract
 *                  the article body BEFORE scanning for images. Strips
 *                  nav/header/sidebar/footer/ads/share-widgets without
 *                  any network round-trip. Set to false to scan the raw
 *                  HTML (pre-v0.14.7 behavior).
 *   - `requireAltOrFigure` (v0.14.7, default true): only download images
 *                  that have a non-empty alt attribute OR are wrapped in
 *                  `<figure>`. Filters out decorative icons, share buttons,
 *                  social-media glyphs. Set to false to download every
 *                  extracted image (pre-v0.14.7 behavior).
 *   - `minBytes`: skip assets under this size (default 1024 — most icons
 *                 are <1 KB, most photos/equations are larger)
 *   - `maxBytes`: refuse assets over this size (default 10*1024*1024 = 10 MiB)
 *   - `minWidth` (v0.14.7, default 100): skip assets whose decoded width
 *                  is below this. Phase E.2 — parses PNG/JPEG/GIF/WebP/SVG
 *                  headers post-fetch. Set to 0 to disable (pre-v0.14.7
 *                  behavior). Unknown formats (BMP/TIFF/ICO/AVIF) are NOT
 *                  skipped — treated as "can't verify → keep".
 *   - `minHeight` (v0.14.7, default 100): same as minWidth, applied to height.
 *   - `concurrency`: bounded parallelism (default 4)
 *   - `maxAssets`: cap on how many URLs we even attempt (default 200 —
 *                  prevents an attacker page with 10k <img> tags from
 *                  spinning up 10k fetches even with concurrency cap)
 *
 * Output (raw payload — wrapResult wraps once in src/index.mjs):
 *   ```js
 *   {
 *     baseUrl: '...',                       // resolved page URL
 *     outputDir: '...',                     // absolute path written into
 *     defuddled: true,                      // v0.14.7: whether defuddle ran successfully
 *     extracted: 24,                        // image URLs found (after defuddle if on)
 *     afterRelevanceFilter: 6,              // v0.14.7: count after alt/figure filter
 *     attempted: 6,                         // count after maxAssets cap
 *     downloaded: [{sourceUrl, savedAs, bytes, dimensions?}, ...],
 *     skipped:    [{sourceUrl, reason, bytes?, dimensions?}, ...],
 *     errors:     [{sourceUrl, message}, ...],
 *     urlMap:     { 'http://...': 'saved-name.png', ... }, // serializable form of the Map
 *   }
 *   ```
 *
 * The skill calls `rewriteAssetUrls(markdown, urlMap, {localPathPrefix})`
 * client-side on the returned `urlMap` to rewrite the markdown body.
 *
 * Registered in `src/index.mjs` TOOL_REGISTRY as `download_page_assets`.
 * Listed in `WRITE_TOOL_NAMES` because it writes to the filesystem — so
 * `OBSIDIAN_ROUTER_READONLY=true` deployments hide it.
 */

import path from 'node:path';

import { safeFetchHtml } from '../helpers/safe-fetch-html.mjs';
import {
  extractImagesWithMeta,
  downloadAssets,
} from '../helpers/asset-downloader.mjs';
import { extractMainContent } from '../helpers/defuddle-extract.mjs';
import { assertPathAllowed } from '../markdownify/utils.mjs';

export const TOOL_NAME = 'download_page_assets';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Download RELEVANT image assets from a web page or HTML string to a local directory, returning a manifest of saved files. Used by wiki-ingest when the user opts into `--save-assets`. v0.14.7 makes the relevance filters smart-by-default: runs `defuddle` to extract the article body first (so nav/header/sidebar/footer/ad/share-widget images are skipped without any fetch), keeps only images with a non-empty alt attribute or `<figure>` wrapper, and skips images decoded as < 100×100 pixels (PNG/JPEG/GIF/WebP/SVG). All filters can be disabled by setting their flags. SSRF-safe (pinned-IP dispatcher), size-capped per asset (10 MiB default). Returns a urlMap that callers use to rewrite `![](url)` references in the source markdown to local paths.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL of the page to fetch and scan for image assets. Mutually exclusive with `html`. When provided, serves as baseUrl for resolving relative image URLs.',
      },
      html: {
        type: 'string',
        description: 'Raw HTML string to scan. Mutually exclusive with `url`. Requires `baseUrl` for relative URL resolution.',
      },
      baseUrl: {
        type: 'string',
        description: 'Page URL used to resolve relative image URLs. Required when `html` is given; ignored when `url` is given (which doubles as baseUrl).',
      },
      outputDir: {
        type: 'string',
        description: 'Absolute path to the directory where downloaded assets land. Created if missing. Must be inside MD_ALLOWED_PATHS if that env var is set.',
      },
      defuddleFirst: {
        type: 'boolean',
        description: 'v0.14.7: when true (default), run defuddle to extract the article body before scanning for images. Strips nav/header/sidebar/footer/ads/share-widgets at zero network cost. Set to false to scan raw HTML (pre-v0.14.7 behavior).',
      },
      requireAltOrFigure: {
        type: 'boolean',
        description: 'v0.14.7: when true (default), only download images with a non-empty `alt` attribute OR wrapped in `<figure>`. Filters decorative icons and share buttons. Set to false to download every extracted image.',
      },
      minBytes: {
        type: 'number',
        description: 'Skip assets smaller than this (default 1024 = 1 KiB). Filters out icons / 1x1 tracking pixels.',
      },
      maxBytes: {
        type: 'number',
        description: 'Refuse assets larger than this (default 10485760 = 10 MiB).',
      },
      minWidth: {
        type: 'number',
        description: 'v0.14.7: skip assets whose decoded width is below this (default 100). Phase E.2 — parses PNG/JPEG/GIF/WebP/SVG headers post-fetch. Set to 0 to disable. Unknown formats are kept (can\'t verify → keep).',
      },
      minHeight: {
        type: 'number',
        description: 'v0.14.7: same as minWidth, applied to height (default 100).',
      },
      concurrency: {
        type: 'number',
        description: 'Bounded parallelism (default 4).',
      },
      maxAssets: {
        type: 'number',
        description: 'Cap on number of image URLs to even attempt downloading (default 200). Prevents 10k-img attacker pages from spinning up 10k fetches.',
      },
    },
    required: ['outputDir'],
  },
};

const DEFAULTS = {
  defuddleFirst: true,
  requireAltOrFigure: true,
  minBytes: 1024,
  maxBytes: 10 * 1024 * 1024,
  minWidth: 100,
  minHeight: 100,
  concurrency: 4,
  maxAssets: 200,
};

/**
 * MCP tool handler. Returns raw payload (wrapResult wraps once).
 *
 * @param {{
 *   url?: string,
 *   html?: string,
 *   baseUrl?: string,
 *   outputDir: string,
 *   defuddleFirst?: boolean,
 *   requireAltOrFigure?: boolean,
 *   minBytes?: number,
 *   maxBytes?: number,
 *   minWidth?: number,
 *   minHeight?: number,
 *   concurrency?: number,
 *   maxAssets?: number,
 * }} args
 */
export async function handleDownloadPageAssets(args = {}) {
  const {
    url,
    html,
    baseUrl: explicitBaseUrl,
    outputDir,
    defuddleFirst = DEFAULTS.defuddleFirst,
    requireAltOrFigure = DEFAULTS.requireAltOrFigure,
    minBytes = DEFAULTS.minBytes,
    maxBytes = DEFAULTS.maxBytes,
    minWidth = DEFAULTS.minWidth,
    minHeight = DEFAULTS.minHeight,
    concurrency = DEFAULTS.concurrency,
    maxAssets = DEFAULTS.maxAssets,
  } = args;

  // Input validation — fail fast with clear messages.
  if (!url && !html) {
    throw new Error('download_page_assets: one of `url` or `html` is required');
  }
  if (url && html) {
    throw new Error('download_page_assets: `url` and `html` are mutually exclusive');
  }
  if (!outputDir || typeof outputDir !== 'string') {
    throw new Error('download_page_assets: `outputDir` (string, absolute path) is required');
  }
  if (!path.isAbsolute(outputDir)) {
    throw new Error(`download_page_assets: outputDir must be absolute, got: ${outputDir}`);
  }
  if (html && !explicitBaseUrl) {
    throw new Error('download_page_assets: when passing `html`, you must also pass `baseUrl` for relative URL resolution');
  }

  // v0.14.3 hardening (P3-3): explicit numeric validation. Pre-hardening,
  // passing maxAssets=0 (or a negative number) silently produced an
  // empty-list no-op — the caller saw `extracted: 24, attempted: 0,
  // downloaded: []` and might think the tool was broken. Reject with a
  // clear message instead. Same for non-numeric / NaN.
  if (
    args.maxAssets !== undefined &&
    (!Number.isInteger(maxAssets) || maxAssets < 1)
  ) {
    throw new Error(`download_page_assets: maxAssets must be a positive integer, got: ${args.maxAssets}`);
  }
  if (args.concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
    throw new Error(`download_page_assets: concurrency must be a positive integer, got: ${args.concurrency}`);
  }
  if (args.minBytes !== undefined && (!Number.isFinite(minBytes) || minBytes < 0)) {
    throw new Error(`download_page_assets: minBytes must be a non-negative number, got: ${args.minBytes}`);
  }
  if (args.maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes < 1)) {
    throw new Error(`download_page_assets: maxBytes must be a positive number, got: ${args.maxBytes}`);
  }
  if (args.minWidth !== undefined && (!Number.isFinite(minWidth) || minWidth < 0)) {
    throw new Error(`download_page_assets: minWidth must be a non-negative number, got: ${args.minWidth}`);
  }
  if (args.minHeight !== undefined && (!Number.isFinite(minHeight) || minHeight < 0)) {
    throw new Error(`download_page_assets: minHeight must be a non-negative number, got: ${args.minHeight}`);
  }

  // Sandbox check — refuse writes outside MD_ALLOWED_PATHS when set.
  // assertPathAllowed throws with a clear message; we wrap it so the
  // tool prefix is in the error.
  try {
    assertPathAllowed(outputDir);
  } catch (e) {
    throw new Error(`download_page_assets: ${e.message}`);
  }

  // Resolve HTML.
  let resolvedHtml = html;
  let baseUrl = explicitBaseUrl;
  if (url) {
    try {
      const fetched = await safeFetchHtml(url);
      resolvedHtml = fetched.html;
      baseUrl = fetched.finalUrl;
    } catch (e) {
      throw new Error(`download_page_assets: ${e.message}`);
    }
  }

  // v0.14.7: defuddle-first relevance filter. Strips nav/header/sidebar/
  // footer/ads from the HTML before image extraction. Defuddle is
  // best-effort: on failure or empty result, fall back to the raw HTML
  // (still better than skipping the whole download).
  let scannedHtml = resolvedHtml;
  let defuddled = false;
  if (defuddleFirst && resolvedHtml) {
    const dfd = await extractMainContent(resolvedHtml, { url: baseUrl });
    if (!dfd.usedFallback && dfd.content) {
      scannedHtml = dfd.content;
      defuddled = true;
    }
  }

  // Extract with metadata so we can apply the alt/figure filter.
  const allImages = extractImagesWithMeta(scannedHtml, baseUrl);

  // v0.14.7: alt-text / figure relevance filter. An image is kept iff
  //   - the filter is disabled, OR
  //   - alt has non-empty trimmed text, OR
  //   - the image is wrapped in a <figure>.
  // Markdown ![alt](url) participates in the alt check naturally.
  const relevant = requireAltOrFigure
    ? allImages.filter((e) => (e.alt && e.alt.trim() !== '') || e.isFigure)
    : allImages;

  const urls = relevant.map((e) => e.url);
  const capped = urls.slice(0, Math.max(0, maxAssets));

  const result = await downloadAssets(capped, outputDir, {
    minBytes,
    maxBytes,
    minWidth,
    minHeight,
    concurrency,
  });

  // Serialize the Map for MCP transport (JSON has no Map type).
  const urlMapObj = {};
  for (const [k, v] of result.urlMap.entries()) urlMapObj[k] = v;

  return {
    baseUrl,
    outputDir,
    defuddled,
    extracted: allImages.length,
    afterRelevanceFilter: relevant.length,
    attempted: capped.length,
    downloaded: result.downloaded,
    skipped: result.skipped,
    errors: result.errors,
    urlMap: urlMapObj,
  };
}
