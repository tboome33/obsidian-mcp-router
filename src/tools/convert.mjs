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

async function convertUrl(url) {
  assertString(url, 'url');
  const { text } = await toMarkdown({ url });
  return text;
}

/* ---------- URL-input tools (YouTube, Bing, generic webpage) ---------- */

export async function youtubeToMarkdown(_registry, { url } = {}) {
  return convertUrl(url);
}

export async function bingSearchToMarkdown(_registry, { url } = {}) {
  return convertUrl(url);
}

export async function webpageToMarkdown(_registry, { url } = {}) {
  return convertUrl(url);
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
