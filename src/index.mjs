/**
 * Obsidian MCP Router — entry point
 *
 * Boots an MCP stdio server that exposes a unified tool surface over multiple
 * Obsidian vaults (local or remote), routed via the Local REST API plugin.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry, resolveConfigPath } from './registry.mjs';
import { appendToFile as restAppendToFile } from './rest-client.mjs';
import { listVaults } from './tools/list-vaults.mjs';
import { listFiles } from './tools/list-files.mjs';
import { getFile } from './tools/get-file.mjs';
import { search } from './tools/search.mjs';
import { searchSmartTool } from './tools/search-smart.mjs';
import { writeFileTool } from './tools/write-file.mjs';
import { appendToFileTool } from './tools/append-to-file.mjs';
import { deleteFileTool } from './tools/delete-file.mjs';
import { patchFileTool } from './tools/patch-file.mjs';
import { executeTemplateTool } from './tools/execute-template.mjs';
import { moveFileTool } from './tools/move-file.mjs';
import { getFrontmatterTool } from './tools/get-frontmatter.mjs';
import { setFrontmatterTool } from './tools/set-frontmatter.mjs';
import { mergeFrontmatterTool } from './tools/merge-frontmatter.mjs';
import { lockVault, unlockVaults } from './tools/lock.mjs';
import { setAutoEnrichMode, canonicalizeMode, VALID_MODES } from './tools/auto-enrich.mjs';
import {
  youtubeToMarkdown,
  bingSearchToMarkdown,
  webpageToMarkdown,
  pdfToMarkdown,
  imageToMarkdown,
  audioToMarkdown,
  docxToMarkdown,
  xlsxToMarkdown,
  pptxToMarkdown,
  gitRepoToMarkdown,
} from './tools/convert.mjs';
import {
  TOOL_DEFINITION as EXTRACT_PAGE_METADATA_TOOL_DEFINITION,
  handleExtractPageMetadata,
} from './tools/extract-page-metadata.mjs';
import {
  TOOL_DEFINITION as PROPOSE_LINKED_SOURCES_TOOL_DEFINITION,
  handleProposeLinkedSources,
} from './tools/propose-linked-sources.mjs';

// Read package version once at module load. Fixes IMP-2 (handshake reported
// stale '0.8.2' instead of package.json version). Read synchronously at import
// time — runs once, can't drift from package.json.
const PKG_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const TOOLS = [
  {
    name: 'list_vaults',
    description:
      'List all configured Obsidian vaults (local and remote). Returns five fields: defaultVault (the name resolved by the cascade for the current session), vaults[] (active vaults, each pinged for online status + latency + missingApiKey + isDefault), disabled[] (vaults skipped by the disabledVaults config — name, type, reason), lockedTo (the locked vault name when single-vault isolation is on, or null when multi-vault), and autoEnrichMode (the wiki auto-enrichment mode: "ClaudeAsk" | "Hybrid" | "FullAuto" | "off"). Always call this first to discover which vaults are available and the current router state.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List files and subdirectories inside a vault. Pass a directory path (relative to vault root) to drill in, or omit it to list the vault root.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Vault name (see list_vaults). Omit to use the default vault.',
        },
        directory: {
          type: 'string',
          description: 'Directory path relative to vault root (e.g., "Sessions" or "Refs/Trading"). Omit for vault root.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_file',
    description:
      'Read the full content of a file from a vault. Returns markdown text, metadata, and frontmatter.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Vault name (see list_vaults). Omit to use the default vault.',
        },
        path: {
          type: 'string',
          description: 'File path relative to vault root (e.g., "Sessions/2025-05-02.md").',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Plain-text (substring) search across a vault. Returns matches with surrounding context. For meaning-based search, use search_smart instead.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Vault name (see list_vaults). Omit to search the default vault. Pass "*" to search ALL vaults in parallel.',
        },
        query: {
          type: 'string',
          description: 'Free-text query.',
        },
        contextLength: {
          type: 'number',
          description: 'Number of characters of context to return around each match. Default: 100.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Create a new file or replace the entire content of an existing file. Pass ifNew: true to refuse to overwrite an existing file (server returns 409 in that case).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Omit for default.' },
        path: { type: 'string', description: 'Target path relative to vault root.' },
        content: { type: 'string', description: 'Full file content (markdown).' },
        ifNew: {
          type: 'boolean',
          description: 'If true, fail with 409 if the file already exists. Default: false (overwrite).',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_to_file',
    description:
      'Append content to the end of a file. Creates the file if it doesn\'t exist (unless requireExisting is true). Use this for journals, logs, or running notes.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string', description: 'Markdown to append.' },
        requireExisting: {
          type: 'boolean',
          description: 'If true, fail when the file does not exist. Default: false (auto-create).',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_file',
    description:
      'Move or rename a file. Implemented as GET source → PUT destination → DELETE source (no native endpoint exists on Local REST API). Pass overwrite: true to replace an existing destination.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
        from: { type: 'string', description: 'Source path relative to vault root.' },
        to: { type: 'string', description: 'Destination path relative to vault root.' },
        overwrite: {
          type: 'boolean',
          description: 'If true, overwrite destination if it exists. Default: false (fails on conflict).',
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_frontmatter',
    description:
      'Read frontmatter from a file. Pass key to get a single property; omit it to get the full frontmatter object. Returns parsed values (numbers, booleans, arrays preserved — not just strings).',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
        path: { type: 'string' },
        key: {
          type: 'string',
          description: 'Specific frontmatter key to retrieve. Omit for the whole frontmatter object.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_frontmatter',
    description:
      'Set or replace a single frontmatter property. Convenience wrapper around patch_file with targetType: frontmatter. The value can be a string, number, boolean, array, or object — type is preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
        path: { type: 'string' },
        key: { type: 'string', description: 'Frontmatter property name (e.g. "status", "tags").' },
        value: {
          description: 'New value. Strings, numbers, booleans, null, arrays, and objects all supported.',
        },
        createIfMissing: {
          type: 'boolean',
          description: 'Create the key if absent. Default: true.',
        },
      },
      required: ['path', 'key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_frontmatter',
    description:
      'Apply multiple frontmatter updates in sequence (NOT atomic — partial failures possible). Returns a per-key result. For atomic multi-key updates, prefer get_frontmatter + modify + write_file.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
        path: { type: 'string' },
        values: {
          type: 'object',
          description: 'Key/value map of frontmatter properties to set.',
        },
        createIfMissing: {
          type: 'boolean',
          description: 'Create absent keys. Default: true.',
        },
      },
      required: ['path', 'values'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_file',
    description:
      'Permanently delete a file from the vault. Requires confirm: true to proceed — this guard prevents accidental deletes.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
        path: { type: 'string' },
        confirm: {
          type: 'boolean',
          description: 'Must be exactly true. Any other value blocks the operation.',
        },
      },
      required: ['path', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'patch_file',
    description:
      'Surgical edit of a specific section, block, or frontmatter field of a file — without rewriting the whole file. Use this when you want to insert under a specific heading, replace a block by ID, or update a single frontmatter property.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
        path: { type: 'string', description: 'File path relative to vault root.' },
        operation: {
          type: 'string',
          enum: ['append', 'prepend', 'replace'],
          description: 'How to combine new content with the target.',
        },
        targetType: {
          type: 'string',
          enum: ['heading', 'block', 'frontmatter'],
          description: 'What kind of target to address.',
        },
        target: {
          type: 'string',
          description:
            'For heading: the heading path joined by the delimiter (default "::") — e.g. "Section 1::Subsection". For block: the block id without the leading ^. For frontmatter: the property name.',
        },
        content: {
          oneOf: [
            { type: 'string', description: 'Markdown text (heading/block targets).' },
            { type: 'object', description: 'JSON value (frontmatter targets only).' },
          ],
          description: 'New content to insert.',
        },
        targetDelimiter: {
          type: 'string',
          description: 'Override the heading-path delimiter (default "::").',
        },
        createTargetIfMissing: {
          type: 'boolean',
          description: 'If the target doesn\'t exist, create it (heading/frontmatter only).',
        },
        applyIfContentPreexists: {
          type: 'boolean',
          description: 'Skip the patch when the target already contains the new content (idempotency).',
        },
        trimTargetWhitespace: {
          type: 'boolean',
          description: 'Trim whitespace around the target before applying the operation.',
        },
      },
      required: ['path', 'operation', 'targetType', 'target', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'execute_template',
    description:
      'Execute a Templater template against the vault. Optionally writes the rendered result to a new file. Requires the templater-obsidian plugin enabled in the target vault. The arguments map is exposed inside the template via tp.mcpTools.prompt("key") — note: directly under tp, NOT under tp.user.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
        name: {
          type: 'string',
          description: 'Path to the template file in the vault, e.g. "Templates/Daily.md".',
        },
        arguments: {
          type: 'object',
          description: 'Key-value map injected into the template via tp.user.mcpTools.prompt("key").',
          additionalProperties: { type: 'string' },
        },
        createFile: {
          type: 'boolean',
          description: 'If true, save the rendered template to targetPath. If false, only return the rendered content.',
        },
        targetPath: {
          type: 'string',
          description: 'Where to save the rendered template (required when createFile is true).',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_smart',
    description:
      'Semantic (meaning-based) search using Smart Connections embeddings. Returns ranked chunks with cosine similarity scores and breadcrumbs (heading path). Requires the target vault to have both the "obsidian-mcp-router-bridge" and "smart-connections" community plugins installed and enabled. Pass vault: "*" to fan-out across every vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Vault name (see list_vaults). Omit for default. Pass "*" to fan-out across all vaults.',
        },
        query: {
          type: 'string',
          description: 'Natural-language query, e.g. "money management rules for swing trading".',
        },
        folders: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict results to chunks whose path starts with one of these folders (e.g. ["Sessions", "Trades"]).',
        },
        excludeFolders: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude chunks whose path starts with one of these folders (e.g. [".trash", "Templates"]).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results. Default: 10.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'lock_vault',
    description:
      'Restrict the router to a single vault for the current session. While locked, every tool call that targets a different vault throws "Router is locked to ..."; calls without an explicit `vault` resolve to the locked one; cross-vault fan-out (`vault: "*"`) is refused. Use `unlock_vaults` to lift the lock. Pass `persist: true` to write OBSIDIAN_ROUTER_LOCKED=<vault> into the current workspace .env so the lock survives router restarts. Note: persist:true is refused when the current working directory IS the user home directory (avoids creating a stray ~/.env on a Claude Code launched from $HOME). The in-memory lock still applies in that case — to make the lock permanent, run from a real project directory or set OBSIDIAN_ROUTER_LOCKED in your shell profile.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description:
            'Name of the vault to lock to. Must be in the active vault set (see list_vaults). Locking to a disabled or unknown vault is refused.',
        },
        persist: {
          type: 'boolean',
          description:
            'If true, write OBSIDIAN_ROUTER_LOCKED=<vault> into <cwd>/.env so the lock survives a Claude Code restart. Default: false (volatile, this session only).',
        },
      },
      required: ['vault'],
      additionalProperties: false,
    },
  },
  {
    name: 'unlock_vaults',
    description:
      'Lift the single-vault lock and restore normal multi-vault routing. Pass `persist: true` to ALSO remove the OBSIDIAN_ROUTER_LOCKED line from the current workspace .env (otherwise the lock would re-apply at next startup if the .env still has it set).',
    inputSchema: {
      type: 'object',
      properties: {
        persist: {
          type: 'boolean',
          description:
            'If true, remove the OBSIDIAN_ROUTER_LOCKED line from <cwd>/.env. Default: false (in-memory only).',
        },
      },
      additionalProperties: false,
    },
  },
  /* ---------- Conversion tools (vendor port of markdownify-mcp, MIT) ---------- */
  {
    name: 'pdf_to_markdown',
    description:
      'Convert a local PDF file to markdown via the bundled `markitdown` Python CLI. Returns the markdown text — does NOT write to any vault. Chain with `write_file` to persist the output. Set `MD_ALLOWED_PATHS` to restrict which directories can be read.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: {
          type: 'string',
          description: 'Absolute path of the PDF file to convert.',
        },
      },
      required: ['filepath'],
      additionalProperties: false,
    },
  },
  {
    name: 'docx_to_markdown',
    description:
      'Convert a local DOCX file to markdown via `markitdown`. Returns markdown text only — does not write to any vault.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Absolute path of the DOCX file to convert.' },
      },
      required: ['filepath'],
      additionalProperties: false,
    },
  },
  {
    name: 'xlsx_to_markdown',
    description:
      'Convert a local XLSX spreadsheet to markdown via `markitdown`. Returns markdown text only — does not write to any vault.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Absolute path of the XLSX file to convert.' },
      },
      required: ['filepath'],
      additionalProperties: false,
    },
  },
  {
    name: 'pptx_to_markdown',
    description:
      'Convert a local PPTX presentation to markdown via `markitdown`. Returns markdown text only — does not write to any vault.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Absolute path of the PPTX file to convert.' },
      },
      required: ['filepath'],
      additionalProperties: false,
    },
  },
  {
    name: 'image_to_markdown',
    description:
      'Convert a local image to markdown (metadata + OCR-derived description) via `markitdown[all]`. Requires the `[all]` extras — image OCR fails on the slim install.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Absolute path of the image file to convert.' },
      },
      required: ['filepath'],
      additionalProperties: false,
    },
  },
  {
    name: 'audio_to_markdown',
    description:
      'Convert a local audio file to markdown (with transcription when supported) via `markitdown[all]`. Requires the `[all]` extras — audio transcription fails on the slim install.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Absolute path of the audio file to convert.' },
      },
      required: ['filepath'],
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_to_markdown',
    description:
      'Convert a YouTube video page to markdown — includes the transcript when one is available. URL must be http(s); private/loopback hosts are refused (SSRF guard).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the YouTube video.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'bing_search_to_markdown',
    description:
      'Convert a Bing search results page to markdown. Pass the full results URL. SPA pages that defer rendering to JS produce raw HTML — the tool detects that and returns a clear error rather than misleading "markdown".',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the Bing search results page.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'webpage_to_markdown',
    description:
      'Convert an arbitrary webpage to markdown. URL must be http(s); private/loopback hosts are refused (SSRF guard). For JS-rendered SPAs prefer the `defuddle` skill which uses a headless browser.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the webpage to convert.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_repo_to_markdown',
    description:
      'Convert a git repository into a single markdown document (file tree + source code) via `repomix`. Useful as input to an LLM that needs whole-repo context. Supports GitHub URLs and the `owner/repo` shorthand. Pass `compress: true` for Tree-sitter compression (~70% size reduction).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Git repository URL or GitHub shorthand (e.g. "https://github.com/owner/repo" or "owner/repo").',
        },
        branch: {
          type: 'string',
          description: 'Branch, tag, or commit to use. Defaults to the repo default branch.',
        },
        compress: {
          type: 'boolean',
          description: 'Use Tree-sitter compression to reduce output size. Default: false.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_auto_enrich_mode',
    description:
      'Set the wiki auto-enrichment mode for the current session. Auto-enrichment is the layer where Claude proactively proposes wiki saves at three triggers (validation pins, result-obtained digests, topic-switch checkpoints). Modes: "ClaudeAsk" (default — propose, user always confirms), "Hybrid" (auto-save type-safe items like facts and URLs, ask on high-stakes like decisions / ADRs / techniques), "FullAuto" (auto-save everything with audit log + sensitivity filter + hard cap), "off" (no auto-suggestions; user invokes /save manually). Pass `persist: true` to write OBSIDIAN_ROUTER_AUTO_ENRICH=<mode> into <cwd>/.env so the mode survives restarts. Persist with mode "off" removes the line entirely. Note: persist:true is refused when the current working directory IS the user home directory (avoids creating a stray ~/.env). The in-memory mode still applies.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description:
            'One of "ClaudeAsk" | "Hybrid" | "FullAuto" | "off". Case-insensitive.',
        },
        persist: {
          type: 'boolean',
          description:
            'If true, write OBSIDIAN_ROUTER_AUTO_ENRICH=<mode> to <cwd>/.env (or remove the line if mode is "off"). Default: false (volatile, this session only).',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  // Metadata extractor (Phase B of obsidian-clipper port, v0.13.2). Wraps
  // src/helpers/meta-extractor.mjs as a stand-alone MCP tool. Does NOT
  // touch any vault — it returns structured metadata only. Excluded from
  // WRITE_TOOL_NAMES below so OBSIDIAN_ROUTER_READONLY keeps it exposed
  // (deterministic frontmatter input is the whole point of pre-ingestion).
  EXTRACT_PAGE_METADATA_TOOL_DEFINITION,
  // Linked-sources proposer (Phase C of obsidian-clipper port, v0.13.3).
  // Scans a webpage's body for hyperlinks worth proposing for recursive
  // ingestion. Read-only — excluded from WRITE_TOOL_NAMES.
  PROPOSE_LINKED_SOURCES_TOOL_DEFINITION,
];

/**
 * Dispatch map from tool name to handler. Fixes IMP-3 — pre-v0.8.12 the
 * CallTool handler was a manual `switch (name)` that could drift silently
 * from the TOOLS array (typo in case → "Unknown tool" surface only at
 * runtime, e.g. when READONLY filtering was added in Phase 1 and a missed
 * case let a write through). The cross-check below runs at module load,
 * so any drift between TOOLS schemas and TOOL_HANDLERS keys is a static
 * boot-time error instead of a runtime surprise.
 *
 * Handler signature is uniform: (reg, args) => Promise<result>. `list_vaults`
 * ignores args; every other tool reads from it. The uniformity lets the
 * dispatcher be a one-liner.
 */
const TOOL_HANDLERS = {
  list_vaults: (reg, args) => listVaults(reg),
  list_files: (reg, args) => listFiles(reg, args),
  get_file: (reg, args) => getFile(reg, args),
  search: (reg, args) => search(reg, args),
  search_smart: (reg, args) => searchSmartTool(reg, args),
  write_file: (reg, args) => writeFileTool(reg, args),
  append_to_file: (reg, args) => appendToFileTool(reg, args),
  delete_file: (reg, args) => deleteFileTool(reg, args),
  patch_file: (reg, args) => patchFileTool(reg, args),
  execute_template: (reg, args) => executeTemplateTool(reg, args),
  move_file: (reg, args) => moveFileTool(reg, args),
  get_frontmatter: (reg, args) => getFrontmatterTool(reg, args),
  set_frontmatter: (reg, args) => setFrontmatterTool(reg, args),
  merge_frontmatter: (reg, args) => mergeFrontmatterTool(reg, args),
  lock_vault: (reg, args) => lockVault(reg, args),
  unlock_vaults: (reg, args) => unlockVaults(reg, args),
  set_auto_enrich_mode: (reg, args) => setAutoEnrichMode(reg, args),
  // Conversion tools (vendor port of markdownify-mcp). These don't touch any
  // vault — they return markdown text only. Excluded from WRITE_TOOL_NAMES so
  // OBSIDIAN_ROUTER_READONLY keeps them exposed for ingestion use cases.
  pdf_to_markdown: (reg, args) => pdfToMarkdown(reg, args),
  docx_to_markdown: (reg, args) => docxToMarkdown(reg, args),
  xlsx_to_markdown: (reg, args) => xlsxToMarkdown(reg, args),
  pptx_to_markdown: (reg, args) => pptxToMarkdown(reg, args),
  image_to_markdown: (reg, args) => imageToMarkdown(reg, args),
  audio_to_markdown: (reg, args) => audioToMarkdown(reg, args),
  youtube_to_markdown: (reg, args) => youtubeToMarkdown(reg, args),
  bing_search_to_markdown: (reg, args) => bingSearchToMarkdown(reg, args),
  webpage_to_markdown: (reg, args) => webpageToMarkdown(reg, args),
  git_repo_to_markdown: (reg, args) => gitRepoToMarkdown(reg, args),
  // v0.13.2 Phase B — deterministic page-metadata extractor.
  extract_page_metadata: (_reg, args) => handleExtractPageMetadata(args),
  // v0.13.3 Phase C — linked-sources proposer for recursive ingestion.
  propose_linked_sources: (_reg, args) => handleProposeLinkedSources(args),
};

// Cross-check: every TOOLS entry must have a handler, and vice-versa. Runs at
// module load — any mismatch (typo, forgotten handler, orphan handler) is a
// boot-time error, never a runtime "Unknown tool" surprise. This is the
// structural guarantee that protects Phase 1's READONLY filtering against
// the drift that the IMP-3 finding flagged.
{
  const toolNames = TOOLS.map((t) => t.name);
  const handlerNames = Object.keys(TOOL_HANDLERS);
  const missingHandlers = toolNames.filter((n) => !handlerNames.includes(n));
  const orphanHandlers = handlerNames.filter((n) => !toolNames.includes(n));
  if (missingHandlers.length || orphanHandlers.length) {
    throw new Error(
      `[obsidian-mcp-router] TOOLS / TOOL_HANDLERS drift detected. ` +
        `Missing handlers: [${missingHandlers.join(', ') || 'none'}]. ` +
        `Orphan handlers: [${orphanHandlers.join(', ') || 'none'}].`,
    );
  }
}

/**
 * Tools that mutate vault state. When `OBSIDIAN_ROUTER_READONLY` is truthy,
 * these are removed from the ListTools surface AND refused at CallTool
 * time. Filtering only the listing isn't enough — an MCP client that
 * already knows the tool name (e.g. from a previous session, or a stale
 * cache) could still call into a write tool. The dual guard closes that.
 *
 * Keep this list synced with the schemas in TOOLS / handlers in
 * TOOL_HANDLERS. The Set is shipped as `_internals.WRITE_TOOL_NAMES` for
 * tests and external auditors.
 */
const WRITE_TOOL_NAMES = new Set([
  'write_file',
  'append_to_file',
  'patch_file',
  'set_frontmatter',
  'merge_frontmatter',
  'move_file',
  'delete_file',
  'execute_template',
]);

/**
 * Parse the OBSIDIAN_ROUTER_READONLY env var into a boolean. Truthy
 * recognised tokens: "true", "1", "yes", "on" (case-insensitive). Anything
 * else (unset, empty, "false", "0", "no", "off", typos) → false.
 *
 * Exported for testing.
 */
export function isReadonlyMode(rawEnvValue) {
  if (rawEnvValue == null) return false;
  const v = String(rawEnvValue).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Pick the path field that identifies the file a write tool touched.
 * Different tools name the field differently (path vs to vs targetPath) —
 * normalise so the audit log line is always populated. Returns `(unknown)`
 * as a last-resort sentinel (audit is best-effort and never blocks the
 * call, so a missing path becomes a placeholder rather than an error).
 *
 * Exported for testing.
 */
export function pickAuditPath(toolName, args = {}) {
  if (toolName === 'move_file') return args.to || args.from || '(unknown)';
  if (toolName === 'execute_template') return args.targetPath || args.name || '(unknown)';
  return args.path || '(unknown)';
}

/**
 * Format a single audit-log line. Stable shape so we can grep it later
 * (e.g. `git log -p wiki-meta/log.md | grep "by roland"`). The leading
 * and trailing newlines isolate the entry from whatever sits in
 * `wiki-meta/log.md` already — the file is append-only so we always end
 * up between existing entries.
 *
 * Exported for testing.
 */
export function formatAuditLine({ userId, toolName, auditPath, now = new Date() }) {
  const ts = now.toISOString().replace('T', ' ').slice(0, 16);
  return `\n[claude-write by ${userId}] ${ts} — ${toolName} path="${auditPath}"\n`;
}

/**
 * Validate that a candidate lock name is in the active vault set. Returns
 * `{ lock, warning }`: `lock` is the candidate if valid, otherwise null;
 * `warning` is null when the candidate is valid (or absent), otherwise a
 * stderr-ready string explaining the fall-through.
 *
 * Two contexts are supported:
 *   - "env"        — initial lock from `OBSIDIAN_ROUTER_LOCKED` at startup
 *   - "preserved"  — runtime lock that survived a config hot-reload but
 *                    whose target may have been disabled/removed since
 *
 * Exported for testing (in addition to its use by startServer + watcher).
 */
export function validateLock(candidate, vaults, context = 'env') {
  if (!candidate) return { lock: null, warning: null };
  if (vaults.some((v) => v.name === candidate)) {
    return { lock: candidate, warning: null };
  }
  const active = vaults.map((v) => v.name).join(', ') || '(none)';
  const prefix =
    context === 'preserved'
      ? `[obsidian-mcp-router] Locked vault "${candidate}" is no longer in the active set after config reload`
      : `[obsidian-mcp-router] OBSIDIAN_ROUTER_LOCKED="${candidate}" does not match any active vault`;
  return {
    lock: null,
    warning: `${prefix} — falling back to normal multi-vault mode. Active vaults: ${active}.`,
  };
}

/**
 * Validate the auto-enrichment mode read from `OBSIDIAN_ROUTER_AUTO_ENRICH`
 * (or preserved from a prior session). Returns `{ mode, warning }`:
 *   - mode is the canonical mode name if recognized, otherwise null
 *   - warning is a stderr-ready string when the input was invalid
 *
 * Two contexts mirror validateLock:
 *   - "env"        — initial mode from the env var at startup
 *   - "preserved"  — runtime mode kept across a config hot-reload
 *
 * Default is "ClaudeAsk" — consistent with the Phase 0 ship: if no env
 * var is set, auto-enrichment is on but only ever proposes (never
 * auto-acts). To fully disable, set OBSIDIAN_ROUTER_AUTO_ENRICH=off.
 *
 * Exported for testing.
 */
export function validateAutoEnrichMode(candidate, context = 'env') {
  if (!candidate) return { mode: 'ClaudeAsk', warning: null };
  const canonical = canonicalizeMode(candidate);
  if (canonical) return { mode: canonical, warning: null };
  const valid = VALID_MODES.join(', ');
  const prefix =
    context === 'preserved'
      ? `[obsidian-mcp-router] Preserved auto-enrichment mode "${candidate}" is not recognized after config reload`
      : `[obsidian-mcp-router] OBSIDIAN_ROUTER_AUTO_ENRICH="${candidate}" is not a recognized mode`;
  return {
    mode: 'ClaudeAsk',
    warning: `${prefix} — falling back to "ClaudeAsk" (always-confirm). Valid modes: ${valid}.`,
  };
}

/**
 * Wrap the registry's `resolveVault()` so that, when `registry.lockedVault`
 * is set, requests for a different vault throw with a clear error. Calls
 * that omit `vault` resolve to the locked vault. Idempotent — applying
 * twice is safe because we always bind the ORIGINAL once via `_originalResolveVault`.
 *
 * Exported so tests exercise the production helper rather than an inlined
 * copy that could silently drift.
 */
export function applyLockGuard(registry) {
  const original =
    registry._originalResolveVault || registry.resolveVault.bind(registry);
  registry._originalResolveVault = original;
  registry.resolveVault = (name) => {
    if (registry.lockedVault) {
      if (name && name !== registry.lockedVault) {
        throw new Error(
          `Router is locked to vault "${registry.lockedVault}". Cannot operate on "${name}". ` +
            `Use unlock_vaults first or specify "${registry.lockedVault}".`,
        );
      }
      return original(registry.lockedVault);
    }
    return original(name);
  };
}

/**
 * Reject startup when the deployment is gated as multi-tenant / read-only but
 * `MD_ALLOWED_PATHS` (the sandbox for the file-input conversion tools) is
 * unset.
 *
 * Context — bug_015 from /ultrareview on v0.11.0:
 *   The 10 `*_to_markdown` conversion tools are deliberately excluded from
 *   `WRITE_TOOL_NAMES` (they don't mutate vault state, so `READONLY=true`
 *   keeps them exposed for ingestion). But 6 of them take a `filepath`
 *   argument and spawn markitdown, which reads whatever the router process
 *   can read. Without `MD_ALLOWED_PATHS`, a "read-only" guest tenant can
 *   call `pdf_to_markdown({ filepath: "/etc/passwd" })` or `.../.ssh/id_rsa`
 *   or `/proc/self/environ` and exfiltrate arbitrary server files.
 *
 *   The trigger for the refusal is "operator opted into a multi-tenant /
 *   gated topology" — any of: `OBSIDIAN_ROUTER_READONLY=true`,
 *   `OBSIDIAN_ROUTER_ALLOWED_VAULTS=*`, `OBSIDIAN_ROUTER_USER_ID=*`. Single-
 *   user setups without these env vars are unaffected (the README never
 *   marketed READONLY in that context, so blocking startup there would
 *   surprise legitimate users).
 *
 * Exported for tests.
 */
export function assertSandboxConsistent(env = process.env) {
  const multiTenantSignals = [];
  if (isReadonlyMode(env.OBSIDIAN_ROUTER_READONLY)) multiTenantSignals.push('OBSIDIAN_ROUTER_READONLY');
  if (env.OBSIDIAN_ROUTER_ALLOWED_VAULTS && env.OBSIDIAN_ROUTER_ALLOWED_VAULTS.trim()) {
    multiTenantSignals.push('OBSIDIAN_ROUTER_ALLOWED_VAULTS');
  }
  if (env.OBSIDIAN_ROUTER_USER_ID && env.OBSIDIAN_ROUTER_USER_ID.trim()) {
    multiTenantSignals.push('OBSIDIAN_ROUTER_USER_ID');
  }
  if (multiTenantSignals.length === 0) return; // Single-user setup — no constraint.
  const sandboxSet = (env.MD_ALLOWED_PATHS && env.MD_ALLOWED_PATHS.trim())
    || (env.MD_SHARE_DIR && env.MD_SHARE_DIR.trim());
  if (sandboxSet) return; // Operator opted in AND set the sandbox — all good.
  throw new Error(
    `[obsidian-mcp-router] Multi-tenant / gated deployment detected ` +
      `(${multiTenantSignals.join(', ')} set) but MD_ALLOWED_PATHS is unset.\n` +
      `\n` +
      `The v0.11+ conversion tools (pdf_to_markdown, docx_to_markdown, etc.) ` +
      `bypass OBSIDIAN_ROUTER_READONLY and read any path the router process ` +
      `can open — including secrets like /etc/passwd, ~/.ssh/id_rsa, or other ` +
      `tenants' vaults. Set MD_ALLOWED_PATHS to a path-delimiter-separated list ` +
      `of directories the conversion tools may read (POSIX uses ":", Windows ";"), ` +
      `OR opt out of file-conversion entirely by removing the conversion tools ` +
      `from your handler map.\n` +
      `\n` +
      `Example: MD_ALLOWED_PATHS=/data/ingest /data/vaults`,
  );
}

export async function startServer({ configPath, watch = true } = {}) {
  // Multi-tenant sandbox consistency — refuse to start a "read-only" or
  // user-scoped deployment that would silently expose the host filesystem
  // through the new file-input conversion tools. bug_015 from /ultrareview
  // on v0.11.0 release.
  assertSandboxConsistent();

  const cfgPath = resolveConfigPath({ configPath });
  const fresh = await loadRegistry({ configPath: cfgPath });

  // Validate OBSIDIAN_ROUTER_LOCKED at startup. If it points to a vault
  // that isn't in the active set (typo, vault disabled, vault removed
  // since the env var was written), warn and fall through to no lock —
  // mirrors the friendlier failure mode of OBSIDIAN_ROUTER_DEFAULT_VAULT.
  // Otherwise a typo here would brick every subsequent tool call with
  // "Router is locked to <typo>" until the user noticed.
  const { lock: initialLock, warning: lockWarning } = validateLock(
    process.env.OBSIDIAN_ROUTER_LOCKED,
    fresh.vaults,
    'env',
  );
  if (lockWarning) console.error(lockWarning);
  fresh.lockedVault = initialLock;
  applyLockGuard(fresh);

  // Initialize the auto-enrichment mode from env var. Same friendly
  // failure mode as validateLock: typo or invalid value warns and falls
  // back to "ClaudeAsk" (the safe default — always proposes, never
  // auto-acts) rather than bricking on an unrecognized mode.
  const { mode: initialMode, warning: modeWarning } = validateAutoEnrichMode(
    process.env.OBSIDIAN_ROUTER_AUTO_ENRICH,
    'env',
  );
  if (modeWarning) console.error(modeWarning);
  fresh.autoEnrichMode = initialMode;

  const registryRef = { current: fresh };

  // Hot-reload of the config file. Debounced (500ms) to coalesce rapid
  // successive writes from setup-vault.mjs. On parse error, the existing
  // registry is preserved and the reason is logged to stderr — the server
  // never crashes on a bad edit.
  if (watch) {
    let timer;
    // Watch the parent directory rather than the config file directly. On
    // Linux/macOS, an atomic write (tmp + rename) replaces the inode and a
    // file-level watcher stays attached to the old, now-orphaned inode —
    // missing every subsequent edit. Watching the directory and filtering
    // by filename survives atomic replacements gracefully and works on all
    // three OSes. Caveat: the dir watcher fires for sibling files too, so
    // we must filter on `filename`.
    const watchDir = path.dirname(cfgPath);
    const watchName = path.basename(cfgPath);
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const fresh = await loadRegistry({ configPath: cfgPath });
          // Preserve the runtime lock state across config reloads — but
          // VALIDATE it. If the user disabled or removed the locked
          // vault since the last reload, drop the lock and warn rather
          // than bricking every subsequent tool call with "Router is
          // locked to <gone>".
          const preserved = registryRef.current?.lockedVault || null;
          const { lock: validatedLock, warning: reloadWarning } = validateLock(
            preserved,
            fresh.vaults,
            'preserved',
          );
          if (reloadWarning) console.error(reloadWarning);
          fresh.lockedVault = validatedLock;
          applyLockGuard(fresh);

          // Preserve the runtime auto-enrichment mode across reloads.
          // Same defensive validation as the lock — an in-memory "Hybrid"
          // could end up on a fresh registry as a string we don't expect
          // if the field was ever corrupted; revalidate.
          const preservedMode = registryRef.current?.autoEnrichMode || null;
          const { mode: validatedMode, warning: modeReloadWarning } =
            validateAutoEnrichMode(preservedMode, 'preserved');
          if (modeReloadWarning) console.error(modeReloadWarning);
          fresh.autoEnrichMode = validatedMode;

          registryRef.current = fresh;
          console.error(
            `[obsidian-mcp-router] Config reloaded. ` +
              `${fresh.vaults.length} active vault(s)` +
              (fresh.skipped?.length ? `, ${fresh.skipped.length} disabled` : '') +
              (fresh.lockedVault ? `, locked to "${fresh.lockedVault}"` : '') +
              (fresh.autoEnrichMode && fresh.autoEnrichMode !== 'ClaudeAsk'
                ? `, auto-enrich: ${fresh.autoEnrichMode}`
                : '') +
              '.',
          );
        } catch (err) {
          console.error(
            `[obsidian-mcp-router] Config reload failed (keeping previous): ${err.message}`,
          );
        }
      }, 500);
    };
    try {
      const watcher = fs.watch(watchDir, (eventType, changedFile) => {
        // Some platforms pass null for changedFile — fall back to "any
        // change in the directory triggers a reload" rather than missing
        // the event.
        if (changedFile && changedFile !== watchName) return;
        reload();
      });
      // fs.watch is an EventEmitter; an unhandled 'error' event crashes the
      // process. This realistically happens when the watched directory is
      // deleted out from under us (e.g. user removes ~/.claude/obsidian-mcp-router/
      // while the server is running). Log and disable hot-reload — the
      // server keeps serving the cached registry rather than dying.
      watcher.on('error', (err) => {
        console.error(
          `[obsidian-mcp-router] Config watcher error (hot-reload disabled): ${err.message}`,
        );
        try { watcher.close(); } catch {}
      });
      // Don't keep the event loop alive just for the watcher — let stdin
      // closure (MCP transport disconnect) terminate the process cleanly.
      watcher.unref?.();
    } catch (err) {
      console.error(
        `[obsidian-mcp-router] Cannot watch ${watchDir} (${err.code}). Hot-reload disabled.`,
      );
    }
  }

  const server = new Server(
    {
      name: 'obsidian-mcp-router',
      version: PKG_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // v0.9.0 — read-only mode (opt-in). When OBSIDIAN_ROUTER_READONLY is
  // truthy, write tools are filtered out of ListTools AND refused at
  // CallTool. Read once at startup; we don't watch the env var for change
  // because flipping a security gate mid-session is more surprising than
  // useful — restart the router to flip it.
  const readonly = isReadonlyMode(process.env.OBSIDIAN_ROUTER_READONLY);
  if (readonly) {
    console.error(
      `[obsidian-mcp-router] OBSIDIAN_ROUTER_READONLY=true — write tools disabled: ` +
        [...WRITE_TOOL_NAMES].join(', '),
    );
  }
  const exposedTools = readonly
    ? TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.name))
    : TOOLS;

  // v0.9.0 — audit log (USER_ID). When OBSIDIAN_ROUTER_USER_ID is set,
  // every SUCCESSFUL write tool call gets a line appended to the touched
  // vault's `wiki-meta/log.md` so we can trace "who wrote what" later.
  // Each MCPHub instance gets its own USER_ID env, so a 6-instance
  // multi-tenant setup gives us free user-level attribution without
  // modifying any downstream tool.
  //
  // v0.12.0: target path moved from `wiki/log.md` to `wiki-meta/log.md`
  // along with the other 3 scaffolds (hot/index/overview). User content
  // stays under `wiki/`.
  //
  // CRITICAL: the audit append uses `restAppendToFile` directly (REST
  // helper) — NOT the `append_to_file` tool handler. Going through the
  // handler would loop because the audit write itself is a write tool.
  // The direct REST call bypasses the dispatcher and the audit middleware.
  //
  // Failure policy: best-effort. If the audit write fails (disk full,
  // log.md not writable, etc.), we log the cause to stderr and return
  // the original write's success — better to lose an audit line than to
  // fail the user-facing operation. Cf. risk R5 in 2026-05-21-codex-audit.
  const rawUserId = process.env.OBSIDIAN_ROUTER_USER_ID;
  const userId = rawUserId && rawUserId.trim().length > 0 ? rawUserId.trim() : null;
  if (userId) {
    console.error(
      `[obsidian-mcp-router] OBSIDIAN_ROUTER_USER_ID="${userId}" — audit logging enabled. ` +
        `Every successful write appends to <vault>/wiki-meta/log.md.`,
    );
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      const reg = registryRef.current;
      // v0.9.0 — read-only guard. Refuse write tools even if the client
      // skipped ListTools and called the name directly. The static guard
      // here is the second layer; the dynamic guard at startup (`exposedTools`)
      // is the first.
      if (readonly && WRITE_TOOL_NAMES.has(name)) {
        throw new Error(
          `Tool "${name}" is disabled in read-only mode ` +
            `(OBSIDIAN_ROUTER_READONLY is set). Restart the router with the env ` +
            `var cleared to enable writes.`,
        );
      }
      // Map-based dispatch (IMP-3). The boot-time cross-check between TOOLS
      // and TOOL_HANDLERS guarantees every advertised tool has a handler, so
      // a missing entry here is impossible.
      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }
      const result = await handler(reg, args);

      // v0.9.0 — audit log AFTER a successful write. We deliberately don't
      // log failed writes — the user already sees the error, and a failed
      // write didn't modify the vault, so there's nothing to attribute.
      if (userId && WRITE_TOOL_NAMES.has(name)) {
        const auditPath = pickAuditPath(name, args);
        const auditLine = formatAuditLine({ userId, toolName: name, auditPath });
        try {
          const auditVault = reg.resolveVault(args.vault);
          // Direct REST call → break the recursion that would happen if we
          // routed through `appendToFileTool` (which is itself a write tool
          // that would trigger another audit, ad infinitum).
          await restAppendToFile(auditVault, 'wiki-meta/log.md', auditLine, {
            createTargetIfMissing: true,
          });
        } catch (auditErr) {
          // Best-effort: don't fail the original write. Log the cause so
          // the operator can diagnose (typical: missing wiki-meta/ folder,
          // or vault was locked and audit vault resolution mismatched).
          console.error(
            `[obsidian-mcp-router] audit log failed for ${name} ` +
              `(by ${userId}): ${auditErr.message}`,
          );
        }
      }

      return await wrapResult(Promise.resolve(result));
    } catch (err) {
      // Friendly errors when the underlying RestApiError carries a `hint`.
      const lines = [`Error: ${err.message}`];
      if (err.kind) lines.push(`Kind: ${err.kind}`);
      if (err.hint) lines.push(`Hint: ${err.hint}`);
      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n'),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't pollute the stdio MCP channel
  const reg = registryRef.current;
  const skippedNote = reg.skipped?.length
    ? ` (${reg.skipped.length} disabled: ${reg.skipped.map((s) => s.name).join(', ')})`
    : '';
  const lockNote = reg.lockedVault ? ` LOCKED to "${reg.lockedVault}".` : '';
  // Only mention auto-enrich mode in boot log if it's been customized away
  // from the safe default. Saves noise for the common case.
  const autoEnrichNote =
    reg.autoEnrichMode && reg.autoEnrichMode !== 'ClaudeAsk'
      ? ` Auto-enrich mode: ${reg.autoEnrichMode}.`
      : '';
  console.error(
    `[obsidian-mcp-router] Ready. ${reg.vaults.length} vault(s) configured: ${reg.vaults
      .map((v) => v.name)
      .join(', ')}${skippedNote}.${lockNote}${autoEnrichNote}`,
  );
}

async function wrapResult(promise) {
  const result = await promise;
  return {
    content: [
      {
        type: 'text',
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

// Exposed for tests only — not part of the public API. v0.9.0 needs
// TOOLS + WRITE_TOOL_NAMES visible so unit tests can verify the readonly
// filtering behavior without spinning up an MCP transport.
export const _internals = {
  TOOLS,
  TOOL_HANDLERS,
  WRITE_TOOL_NAMES,
  PKG_VERSION,
};
