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
import { convertMathmlBlocksInHtml } from '../helpers/latex-preserver.mjs';

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
 * Buffer encoding: we decode the fetched bytes as UTF-8, run the transform,
 * and return the modified string (which markitdown.mjs's `toMarkdown` will
 * re-encode to UTF-8 for the temp file). Non-HTML responses (PDFs, images,
 * etc. — markitdown also handles those via this same code path) decode to
 * gibberish but the regex finds no `<math>` so they're returned unchanged.
 */
function mathPreservingTransform(buffer) {
  const html = buffer.toString('utf-8');
  const { html: transformed, count } = convertMathmlBlocksInHtml(html);
  // count === 0 means no <math> blocks were found OR none could be
  // converted; in either case the helper returns the input unchanged.
  // We could return buffer directly here, but returning the string lets
  // the markitdown.mjs hook handle the re-encoding uniformly.
  return count > 0 ? transformed : null; // null = "don't replace, keep original buffer"
}

/* ---------- URL-input tools (YouTube, Bing, generic webpage) ---------- */

export async function youtubeToMarkdown(_registry, { url } = {}) {
  return convertUrl(url);
}

export async function bingSearchToMarkdown(_registry, { url } = {}) {
  return convertUrl(url);
}

export async function webpageToMarkdown(_registry, { url } = {}) {
  return convertUrl(url, { transformContent: mathPreservingTransform });
}

/* ---------- File-input tools (binary formats) ---------- */

export async function pdfToMarkdown(_registry, { filepath } = {}) {
  return convertFile(filepath);
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

export async function gitRepoToMarkdown(_registry, { url, branch, compress } = {}) {
  assertString(url, 'url');
  const { text } = await fromRepo({ repoUrl: url, branch, compress });
  return text;
}
