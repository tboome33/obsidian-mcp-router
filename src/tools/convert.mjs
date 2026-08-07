/**
 * Conversion tools — vendor port of markdownify-mcp (MIT, Zach Caceres).
 *
 * Ten MCP tools that turn an external source (PDF, DOCX, image, audio,
 * YouTube transcript, web page, git repo, …) into markdown text. The router
 * just returns the converted markdown — it deliberately does NOT write the
 * output into any vault. Composition is left to the caller: a client (or a
 * skill like `wiki-ingest`) chains a `*_to_markdown` call with a separate
 * `write_file` / `append_to_file` to land the artifact wherever it wants.
 *
 * Why these handlers don't take a `vault` argument:
 *   They're not vault-routed. The conversion happens on the router host,
 *   independent of any Obsidian vault. The `registry` argument is accepted
 *   to keep the handler signature uniform with the rest of `TOOL_HANDLERS`,
 *   but it's unused.
 *
 * Why they're not in `WRITE_TOOL_NAMES` (src/index.mjs):
 *   They never mutate vault state. They only read local files (gated by
 *   `MD_ALLOWED_PATHS` when set) and write to `os.tmpdir()` for URL inputs.
 *   So `OBSIDIAN_ROUTER_READONLY` keeps them exposed — read-only deployments
 *   stay useful for ingestion.
 */
import { toMarkdown, fromRepo } from '../markdownify/markitdown.mjs';
import { toMarkdownDocling } from '../markdownify/docling.mjs';
import { pdfToImages } from '../markdownify/pdf-images.mjs';
import { fetchYoutubeTranscriptViaYtdlp, isYoutubeVideoUrl } from '../markdownify/youtube-fallback.mjs';
import { convertMathmlBlocksInHtml } from '../helpers/latex-preserver.mjs';
import { bm25FilterBlocks, MAX_DROP_FRACTION } from '../helpers/bm25-filter.mjs';
function assertString(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required argument: ${fieldName}`);
  }
}

// Return the markdown string directly (not the `{ text }` wrapper from
// markitdown.mjs). The router's `wrapResult` (src/index.mjs) JSON-stringifies
// any non-string handler return — so returning the wrapper would ship
// `{"text":"# Heading..."}` to the MCP client instead of `# Heading...`, and
// downstream `write_file` chains would persist the wrapper. Found by codex
// during /review+ pass 1.
async function convertFile(filepath) {
  assertString(filepath, 'filepath');
  const { text } = await toMarkdown({ filePath: filepath });
  return text;
}

async function convertUrl(url, opts = {}) {
  assertString(url, 'url');
  const { text } = await toMarkdown({ url, ...opts });
  return text;
}

/**
 * v0.14.6 (Phase D.2) — when a webpage contains `<math>` MathML blocks
 * (typical of Wikipedia and a few math-heavy blogs), we pre-process the
 * fetched HTML to convert each `<math>` block to `$LaTeX$` / `$$LaTeX$$`
 * dollar-delimited strings BEFORE markitdown sees it. Without this
 * pre-processing, markitdown strips `<math>` tags along with their
 * content during HTML→markdown conversion, and the equations vanish from
 * the output.
 *
 * The transform is a no-op on pages without `<math>` blocks (convertMathml
 * returns the HTML unchanged when count === 0), so this is safe to apply
 * unconditionally on every URL. Cost is one extra regex scan of the body.
 *
 * v0.14.7 (P2-2 hardening): two new safety gates.
 *   - **Content-Type gate**: skip the transform unless the response is
 *     advertised as HTML (`text/html`, `application/xhtml+xml`). PDFs,
 *     images, audio, video, and other binary blobs that flow through
 *     `webpage_to_markdown` are NOT decoded to UTF-8, never get matched
 *     by the `<math>` regex, and never risk binary corruption from the
 *     buffer→string→buffer round-trip.
 *   - **Charset gate**: skip the transform if the response declares a
 *     charset that isn't UTF-8 / unset / ascii. Windows-1252, Latin-1,
 *     ISO-8859-*, Shift_JIS etc. would have their accented characters
 *     mangled by the UTF-8 round-trip (each invalid byte → U+FFFD = 3
 *     bytes, surrounding prose corrupted). Realistic blast radius is low
 *     because Wikipedia + modern publishers are UTF-8, but the guard is
 *     cheap to add and removes the failure mode entirely.
 *
 * Either gate failing → return `null` → markitdown uses the original
 * buffer untouched. The math conversion is sacrificed in exchange for
 * not corrupting the surrounding content. Trade-off explicit, not
 * hidden.
 */
const HTML_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  '', // unset Content-Type — assume HTML, the regex will no-op if it's not
]);

function isUtf8Charset(charset) {
  // null/undefined → assume UTF-8 (HTML default, modern publishers). Empty
  // string treated the same. Otherwise compare against the small set of
  // UTF-8 aliases. Reject everything else (errs on the side of safety).
  if (!charset) return true;
  const c = String(charset).toLowerCase().replace(/[\s_-]/g, '');
  return c === 'utf8' || c === 'utf' || c === 'ascii' || c === 'usascii';
}

function mathPreservingTransform(buffer, ctx = {}) {
  // Safety gate 1: non-HTML content-type → skip. Protects PDFs, images,
  // audio, etc. against the UTF-8 round-trip.
  if (ctx.contentType !== undefined && !HTML_CONTENT_TYPES.has(ctx.contentType || '')) {
    return null;
  }
  // Safety gate 2: non-UTF-8 charset → skip. Protects Windows-1252 /
  // Latin-1 / ISO-8859-* pages against accented-char mangling.
  if (!isUtf8Charset(ctx.charset)) {
    return null;
  }

  const html = buffer.toString('utf-8');
  const { html: transformed, count } = convertMathmlBlocksInHtml(html);
  // count === 0 means no <math> blocks were found OR none could be
  // converted; in either case the helper returns the input unchanged.
  // We return null in that case so markitdown keeps the original buffer
  // (no round-trip cost).
  return count > 0 ? transformed : null;
}

/* ---------- URL-input tools (YouTube, Bing, generic webpage) ---------- */

/**
 * YouTube → markdown with a yt-dlp caption fallback.
 *
 * The primary path is MarkItDown's YouTubeConverter (page scrape +
 * youtube-transcript-api), which is fragile — it returns "fetch failed" on
 * videos that DO have captions (observed twice on watch?v=iYG5tiFfK3E). When
 * it throws, we retry via yt-dlp, which is far more robust at reaching caption
 * tracks. The contract is unchanged: still a plain markdown string, still no
 * vault writes (yt-dlp writes only to a private temp dir, cleaned up after).
 *
 * `assertString` runs BEFORE the try so a missing `url` fails cleanly with the
 * standard "Missing required argument" error instead of triggering a fallback
 * against `undefined`. The `_deps` bag is an injection seam for tests
 * (production callers pass only `(registry, args)`).
 */
export async function youtubeToMarkdown(_registry, { url } = {}, _deps = {}) {
  assertString(url, 'url');
  const primary = _deps.primary || ((u) => convertUrl(u));
  const fallback = _deps.fallback || ((u) => fetchYoutubeTranscriptViaYtdlp(u));
  try {
    return await primary(url);
  } catch (primaryErr) {
    // Only escalate to the yt-dlp fallback for real YouTube VIDEO URLs (a
    // parseable 11-char id — not just a youtube.com host, which still exposes
    // open-redirect endpoints). yt-dlp follows redirects + resolves its own DNS
    // outside the router's per-hop SSRF guard, so handing it arbitrary URLs
    // would be a broader network gadget than this tool's name implies (codex
    // P1). Non-video URLs keep the original MarkItDown behaviour.
    if (!isYoutubeVideoUrl(url)) throw primaryErr;
    try {
      return await fallback(url);
    } catch (fallbackErr) {
      // Surface BOTH failures so the user can tell the primary path broke AND
      // the fallback didn't save it (e.g. yt-dlp absent, or no captions).
      throw new Error(
        `${primaryErr?.message ?? 'Unknown error'}\n\n` +
          `yt-dlp fallback also failed: ${fallbackErr?.message ?? 'Unknown error'}`,
      );
    }
  }
}

export async function bingSearchToMarkdown(_registry, { url } = {}) {
  return convertUrl(url);
}

/**
 * Format the one-line HTML stats comment appended when `relevanceQuery` is used.
 * Kept to a single line so it never disturbs the H1-first shape that defuddle /
 * downstream validators expect (it lives at the END of the document).
 */
function bm25StatsComment(filtered, stats) {
  if (filtered) {
    return `<!-- bm25-filter: kept ${stats.kept}/${stats.scoredBlocks} scored blocks (threshold ${stats.threshold}) -->`;
  }
  if (stats.reason === 'over-filter-guard') {
    const pct = Math.round(stats.dropFraction * 100);
    const cap = Math.round(MAX_DROP_FRACTION * 100);
    return `<!-- bm25-filter: no-op (over-filter-guard: would drop ${pct}% > ${cap}%) -->`;
  }
  return `<!-- bm25-filter: no-op (${stats.reason || 'nothing-dropped'}) -->`;
}

/**
 * Convert a webpage to markdown, with an OPT-IN BM25 relevance second-pass.
 *
 * Without `relevanceQuery` the output is byte-identical to the historical
 * behaviour (the string contract every existing caller depends on). With it, the
 * output stays a markdown string; the filter stats are appended as one trailing
 * HTML comment. The heavy lifting is delegated to the shared bm25-filter helper,
 * the same one behind the `filter_relevant_blocks` tool.
 */
export async function webpageToMarkdown(_registry, { url, relevanceQuery, relevanceThreshold } = {}, _deps = {}) {
  // `_deps.convert` is an injection seam for tests (production callers pass only
  // `(registry, args)`), mirroring youtubeToMarkdown's `_deps`.
  const convert = _deps.convert || ((u) => convertUrl(u, { transformContent: mathPreservingTransform }));
  const markdown = await convert(url);
  // Strict no-op path: no (or blank) relevanceQuery → return unchanged. Catches
  // undefined AND whitespace-only so passing an empty query never mutates output.
  if (typeof relevanceQuery !== 'string' || relevanceQuery.trim() === '') {
    return markdown;
  }
  const { markdown: filteredMd, filtered, stats } = bm25FilterBlocks({
    markdown,
    query: relevanceQuery,
    threshold: typeof relevanceThreshold === 'number' ? relevanceThreshold : undefined,
  });
  return `${filteredMd}\n\n${bm25StatsComment(filtered, stats)}`;
}

/* ---------- File-input tools (binary formats) ---------- */

export async function pdfToMarkdown(_registry, { filepath } = {}) {
  return convertFile(filepath);
}

async function convertFileDocling(filepath, run) {
  assertString(filepath, 'filepath');
  const { text } = await toMarkdownDocling({ filePath: filepath, run });
  return text;
}

export async function pdfToMarkdownDocling(_registry, { filepath } = {}, _deps = {}) {
  return convertFileDocling(filepath, _deps.run);
}

/**
 * Render local PDF pages to PNG images, returned as MCP image content
 * blocks (see `pdfToImages` in ../markdownify/pdf-images.mjs). Unlike every
 * other conversion tool in this file, the return value is NOT a markdown
 * string — it's a ready `{ content: [...] }` MCP payload that must pass
 * through `wrapResult` (src/index.mjs) untouched. Named `pdfToImagesTool`
 * (not `pdfToImages`) to avoid colliding with the imported markdownify
 * function of the same name.
 */
export async function pdfToImagesTool(_registry, { filepath, max_pages, first_page, scale } = {}, _deps = {}) {
  return pdfToImages({
    filePath: filepath,
    maxPages: max_pages,
    firstPage: first_page,
    scale,
    run: _deps.run,
  });
}

export async function imageToMarkdown(_registry, { filepath } = {}) {
  return convertFile(filepath);
}

export async function audioToMarkdown(_registry, { filepath } = {}) {
  return convertFile(filepath);
}

export async function docxToMarkdown(_registry, { filepath } = {}) {
  return convertFile(filepath);
}

export async function xlsxToMarkdown(_registry, { filepath } = {}) {
  return convertFile(filepath);
}

export async function pptxToMarkdown(_registry, { filepath } = {}) {
  return convertFile(filepath);
}

/* ---------- Git-repo via repomix ---------- */

export async function gitRepoToMarkdown(_registry, { url, branch, compress } = {}, _deps = {}) {
  assertString(url, 'url');
  // `_deps.fromRepo` is the injection seam every sibling converter already had
  // (`_deps.convert`, `_deps.primary`, `_deps.run`). This one lacked it, so it
  // was the only converter with no way to test its output — and, not by
  // coincidence, the only one the sanitisation pass missed on its first sweep.
  // Untestable and unfixed turned out to be the same property.
  const run = _deps.fromRepo || fromRepo;
  const { text } = await run({ repoUrl: url, branch, compress });
  // A repository is somebody else's text — the least trusted input in this
  // file, since source trees routinely contain the exact byte sequences the
  // sanitiser looks for. Missed on the first pass of this very fix because it
  // is the only converter that destructures `{ text }` instead of returning a
  // call; the shape differed, so the edit did not reach it. That is the whole
  // release in one line.
  return text;
}

// Test-only exports.
export const _internals = { bm25StatsComment };
