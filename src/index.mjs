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
import { classifyError } from './error-classify.mjs';
import { registerResourceHandlers } from './resources.mjs';
import {
  appendToFile as restAppendToFile,
  listFilesIn as restListFilesIn,
  getFileContent as restGetFileContent,
  writeFile as restWriteFile,
  deleteFile as restDeleteFile,
} from './rest-client.mjs';
import { scaffoldCandidates, shouldTryLegacyScaffold } from './helpers/wiki-meta-scaffolds.mjs';
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
  pdfToMarkdownDocling,
  pdfToImagesTool,
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
import {
  TOOL_DEFINITION as DOWNLOAD_PAGE_ASSETS_TOOL_DEFINITION,
  handleDownloadPageAssets,
} from './tools/download-page-assets.mjs';
import { buildOpenLinkTool } from './tools/build-open-link.mjs';
import { openInObsidianTool } from './tools/open-in-obsidian.mjs';
import { getViewLinkTool } from './tools/get-view-link.mjs';
// Layer-1 vault-creation wizard tools (v0.35.0). LOCAL-ONLY: registered only on
// a non-gated router (hidden when OBSIDIAN_ROUTER_USER_ID is set — see
// LOCAL_ONLY_TOOL_NAMES + computeExposedTools). They write to the local
// filesystem, so they must never be reachable on a shared/gated deployment.
import { planVaultTool } from './tools/plan-vault.mjs';
import { provisionVaultTool } from './tools/provision-vault.mjs';
import { viewLinkForWrite, noteForWriteResult } from './helpers/view-link.mjs';
import { smartLinkEnabled } from './helpers/smart-link.mjs';
import {
  TOOL_DEFINITION as GET_WIKI_CONTEXT_PACK_TOOL_DEFINITION,
  getWikiContextPack,
} from './tools/get-wiki-context-pack.mjs';
import {
  TOOL_DEFINITION as BUILD_WIKI_GRAPH_TOOL_DEFINITION,
  buildWikiGraphTool,
  CANONICAL_GRAPH_PATH as BUILD_WIKI_GRAPH_CANONICAL_PATH,
} from './tools/build-wiki-graph.mjs';
import {
  TOOL_DEFINITION as BUILD_WIKI_TOUR_TOOL_DEFINITION,
  buildWikiTourTool,
} from './tools/build-wiki-tour.mjs';
import {
  TOOL_DEFINITION as BUILD_SEARCH_INDEX_TOOL_DEFINITION,
  buildSearchIndexTool,
} from './tools/build-search-index.mjs';
import {
  RECORD_TOOL_DEFINITION as RECORD_SOURCE_TOOL_DEFINITION,
  AUDIT_TOOL_DEFINITION as AUDIT_SOURCES_TOOL_DEFINITION,
  recordSourceTool,
  auditSourcesTool,
} from './tools/source-ledger.mjs';
import {
  TOOL_DEFINITION as GET_PAGE_NEIGHBORS_TOOL_DEFINITION,
  getPageNeighborsTool,
} from './tools/get-page-neighbors.mjs';
import {
  TOOL_DEFINITION as WIKI_PATH_TOOL_DEFINITION,
  wikiPathTool,
} from './tools/wiki-path.mjs';
import {
  TOOL_DEFINITION as FILTER_RELEVANT_BLOCKS_TOOL_DEFINITION,
  filterRelevantBlocksTool,
} from './tools/filter-relevant-blocks.mjs';
import {
  TOOL_DEFINITION as REFRESH_OKF_PROJECTIONS_TOOL_DEFINITION,
  refreshOkfProjectionsTool,
  refreshProjectionsForVault,
} from './tools/refresh-okf-projections.mjs';
import { createProjectionsScheduler, DEFAULT_DEBOUNCE_MS } from './helpers/projections-refresh.mjs';

// Single-source-of-truth for the package version (v0.13.4+). Extracted
// to src/helpers/pkg-version.mjs so MCP tools (extract_page_metadata,
// propose_linked_sources) can share the User-Agent string without
// circular imports or duplicated reads. Pre-v0.13.4 each tool hardcoded
// the version string and drifted across releases.
import { PKG_VERSION } from './helpers/pkg-version.mjs';

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
      'Read the full content of a file from a vault. Returns markdown text, metadata, and frontmatter. The result includes contentSha256 — pass it back as ifMatch on a later write/patch/delete/move to refuse the change if the file was modified in between (optimistic concurrency).',
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
      'Create a new file or replace the entire content of an existing file. Pass ifNew: true to refuse to overwrite an existing file (server returns 409). Pass ifMatch (a contentSha256 from get_file) for an atomic compare-and-swap: the write is refused with a 409 conflict if the file changed since you read it — use it whenever another session (or an Obsidian edit) could have touched the file. The result echoes the new contentSha256 so you can chain edits without re-reading.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name. Omit for default.' },
        path: { type: 'string', description: 'Target path relative to vault root.' },
        content: { type: 'string', description: 'Full file content (markdown).' },
        ifNew: {
          type: 'boolean',
          description: 'If true, fail with 409 if the file already exists. Default: false (overwrite). Mutually exclusive with ifMatch.',
        },
        ifMatch: {
          type: 'string',
          description: 'Optimistic-concurrency guard: the 64-hex contentSha256 from a prior get_file. Writes only if the file still hashes to this; otherwise 409. Atomic when the target vault runs obsidian-mcp-router-bridge >= 0.7.0, else a GET-compare fallback.',
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
        ifMatch: {
          type: 'string',
          description: 'Optimistic-concurrency guard on the SOURCE: the 64-hex contentSha256 from a prior get_file of the source. Refuses the move with 409 if the source changed since then.',
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
        ifMatch: {
          type: 'string',
          description: 'Optimistic-concurrency guard: the 64-hex contentSha256 from a prior get_file. Checked once before any key is written; a mismatch throws 409 before the first mutation. Does not make the multi-key update atomic.',
        },
      },
      required: ['path', 'values'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_file',
    description:
      'Permanently delete a file from the vault. Two-phase: call with preview:true to get a sealed plan (approvedPlanSha256), then call with confirm:true (echoing that seal) to proceed. The confirm:true guard prevents accidental deletes; the seal refuses the delete if the file drifted (changed/created/removed) since the preview.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string' },
        path: { type: 'string' },
        preview: {
          type: 'boolean',
          description: 'C3 phase 1: when true, do NOT delete — return the delete plan (existence + contentSha256) sealed as approvedPlanSha256. Echo that seal on the confirm:true call.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be exactly true to delete. Any other value blocks the operation (unless preview:true).',
        },
        approvedPlanSha256: {
          type: 'string',
          description: 'C3 sealed preview: the 64-hex seal a prior preview:true call returned. When supplied, the delete is refused (before the DELETE) if the file drifted since the preview, or if the seal came from a different vault.',
        },
        ifMatch: {
          type: 'string',
          description: 'Optimistic-concurrency guard: the 64-hex contentSha256 from a prior get_file. Refuses the delete with 409 if the file changed since then — avoids deleting a file another session just edited.',
        },
      },
      required: ['path'],
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
        ifMatch: {
          type: 'string',
          description: 'Optimistic-concurrency guard: the 64-hex contentSha256 from a prior get_file. The whole-file precondition is checked before patching; a mismatch throws 409. Guards against patching content that changed since you read it (the patch itself is not hash-locked).',
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
      'Semantic (meaning-based) search using Smart Connections embeddings. Returns ranked chunks with cosine similarity scores and breadcrumbs (heading path). Hits under an `archives/` folder (archived decision deliberation, `type: decision-archive`) are excluded by default — the response then carries `archivesExcluded: N`; pass includeArchives: true to see them. Requires the target vault to have both the "obsidian-mcp-router-bridge" and "smart-connections" community plugins installed and enabled. Pass vault: "*" to fan-out across every vault.',
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
        includeArchives: {
          type: 'boolean',
          description:
            'Include hits from `archives/` folders (archived decision deliberation moved out by consolidation). Default false: those chunks are dropped and counted in `archivesExcluded`.',
        },
        tier: {
          type: 'string',
          enum: ['auto', 'semantic', 'local'],
          description:
            "Which search engine answers. 'auto' (default): semantic, degrading WHOLLY to the local BM25 index when Smart Connections cannot serve this vault (the response then carries tier + fallback). 'semantic': semantic only — error out instead of degrading. 'local': the deterministic BM25 index only (works on every vault, no plugin needed; requires build_search_index). Results always come from exactly ONE tier — BM25 and cosine scores are never blended.",
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
    name: 'pdf_to_markdown_docling',
    description:
      "Convert a local PDF to markdown via Docling's standard pipeline (layout + table-structure recognition) — higher fidelity than `pdf_to_markdown` on complex tables / multi-column layouts, at ~10x the CPU cost. OPT-IN: requires the Docling extra (install with OBSIDIAN_ROUTER_ENABLE_DOCLING=1, or `npm run install-docling`); if it is not installed the call returns an actionable install hint. Returns markdown text only — does NOT write to any vault. For fast/simple PDFs or office formats use `pdf_to_markdown` instead.",
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
    name: 'pdf_to_images',
    description:
      "Render a local PDF's pages to PNG images and return them as MCP image content blocks so the model can visually SEE the pages — complements `pdf_to_markdown`/`pdf_to_markdown_docling`, which only extract TEXT and lose layout, figures, diagrams, and visual formatting. OPT-IN: requires pypdfium2 + Pillow, which ship with the Docling extra (install with OBSIDIAN_ROUTER_ENABLE_DOCLING=1, or `npm run install-docling`); if not installed the call returns an actionable install hint. Page count and render scale are capped (max_pages hard limit 30, scale clamped 0.5-4.0) to bound the token cost of the returned images. Does NOT write to any vault.",
    inputSchema: {
      type: 'object',
      properties: {
        filepath: {
          type: 'string',
          description: 'Absolute path of the PDF file to render.',
        },
        max_pages: {
          type: 'number',
          description: 'Max pages to render (default 8, hard cap 30).',
        },
        first_page: {
          type: 'number',
          description: '1-based first page (default 1).',
        },
        scale: {
          type: 'number',
          description: 'Render scale, ~2.0 ≈ 144 DPI (default 2.0, clamped 0.5–4.0).',
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
      'Convert a YouTube video page to markdown — includes the transcript when one is available. Falls back to yt-dlp caption extraction when the primary (MarkItDown) path fails; the fallback needs yt-dlp on PATH (or YTDLP_PATH) and degrades with a clear error if it is absent. URL must be http(s); private/loopback hosts are refused (SSRF guard).',
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
      'Convert an arbitrary webpage to markdown. URL must be http(s); private/loopback hosts are refused (SSRF guard). For JS-rendered SPAs prefer the `defuddle` skill which uses a headless browser. Optionally pass `relevanceQuery` to apply a BM25 relevance second-pass (see filter_relevant_blocks) that drops blocks unrelated to your topic — no re-fetch; the output stays a markdown string with a one-line HTML stats comment appended.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the webpage to convert.' },
        relevanceQuery: {
          type: 'string',
          description:
            'Optional. When set, filter the converted markdown to the blocks relevant to this topic (BM25, no re-fetch). Omit for the full unfiltered page.',
        },
        relevanceThreshold: {
          type: 'number',
          description:
            'Optional relevance cutoff in [0,1], normalized against the top block. Default 0.2. Ignored without relevanceQuery.',
        },
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
  // Asset downloader (Phase E of obsidian-clipper port, v0.14.x). Downloads
  // image assets from a web page to a local directory, returns a manifest
  // for markdown rewriting. WRITES to disk — included in WRITE_TOOL_NAMES
  // so OBSIDIAN_ROUTER_READONLY hides it.
  DOWNLOAD_PAGE_ASSETS_TOOL_DEFINITION,
  // v0.14.8 — build click-to-open URLs without touching vault files.
  // Companion to the `clickToOpenUrl` field that write/get/patch already
  // emit. Use when you need a URL for a file you didn't just touch
  // (typically a wikilink target to cite in a chat response). Read-only —
  // excluded from WRITE_TOOL_NAMES.
  {
    name: 'build_open_link',
    description:
      'Build a click-to-open URL (and a ready-to-paste markdown link) for one or many vault files WITHOUT reading or writing them. Use this when you need to cite a vault file in a chat response and you don\'t already have the URL from a previous tool call (write/get/patch all return clickToOpenUrl). Single mode: pass `path`. Batch mode: pass `paths` (array). Mutually exclusive — exactly one of `path` / `paths` must be provided. Returns null URL when the vault is remote or the bridge\'s insecure HTTP server isn\'t enabled.',
    // v0.19.1: the `path` xor `paths` mutual exclusion is enforced at
    // RUNTIME (src/tools/build-open-link.mjs rejects both/neither with a
    // clear message) and documented in the description above — NOT in the
    // schema. A top-level `oneOf`/`allOf`/`anyOf` here, even alongside
    // `type: object`, is rejected by the Anthropic Messages API
    // ("input_schema does not support oneOf, allOf, or anyOf at the top
    // level"), which 400s any client that inlines the whole catalogue into
    // a `tools` request (e.g. MCPHub). Do NOT re-introduce a top-level
    // composition keyword — the tools-click-to-open-integration test guards
    // the entire catalogue against this regression.
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Vault name (see list_vaults). Omit for default vault.',
        },
        path: {
          type: 'string',
          description: 'Single vault-relative path (e.g. "wiki/Divers/foo.md"). Mutually exclusive with `paths`.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Batch of vault-relative paths. Mutually exclusive with `path`. Use when citing multiple notes in one chat response.',
        },
        anchor: {
          type: 'string',
          description: 'Optional heading TEXT to deep-link to (e.g. "Installation"). Emitted as a `?h=` query param so the bridge scrolls to that heading on open (read-only — Obsidian headings are their own anchor, nothing is inserted into the note). Single mode only (`path`), not valid with `paths`. Leading `#` optional.',
        },
      },
      additionalProperties: false,
    },
  },
  // Navigation-only: opens a note in the running Obsidian (and raises its
  // window) by calling the bridge /open route SERVER-SIDE — no browser. The
  // browser-free counterpart to a click-to-open link, for clients (Claude
  // Desktop) that otherwise proxy clicked links through a browser. Read-only
  // wrt content → excluded from WRITE_TOOL_NAMES.
  {
    name: 'open_in_obsidian',
    description:
      'Navigate the running Obsidian for a vault to a file — and bring its window to the front — WITHOUT opening a browser. Use this when the user asks to "open" / "show" / "go to" a note: the router calls the bridge\'s /open route server-side, so (unlike a click-to-open LINK, which a browser-proxying client such as Claude Desktop always opens in a browser tab) no browser is involved. Optional `anchor` scrolls to a heading on the local/bridge path (for a remote-vault `viewLink` the GUI opens on the note — headings are not deep-linkable through the tunnel, so the anchor is echoed with `anchorApplied:false`). On a remote-vault deployment where a view-agent is configured, this instead returns an ephemeral browser `viewLink` to the live GUI on that note (the user has no local Obsidian to raise) — so "show me / open this note" works for remote vaults too. Configured smart links (OBSIDIAN_ROUTER_SMART_LINK_URL/SECRET) signal a REMOTE deployment: the tool then returns a stable smart `viewLink` with `opened:false` + `delivered:"link"` instead of navigating — do NOT set those env vars on a purely local router, or this tool hands back a link instead of navigating your local Obsidian. Requires the mcp-router-bridge plugin (>= 0.2.0) + Obsidian running for that vault (local path). Navigation-only — never changes content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Vault name (see list_vaults). Omit for the default vault.',
        },
        path: {
          type: 'string',
          description: 'Vault-relative path of the file to open (e.g. "wiki/Divers/foo.md").',
        },
        anchor: {
          type: 'string',
          description: 'Optional heading TEXT to scroll to (e.g. "Installation"). Leading `#` optional.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  // Interim "view link" to a vault's LIVE Obsidian GUI via the Dedibox view-agent
  // (on-demand cloudflared tunnel + Local REST /open navigate, credentials baked
  // into the URL). The stop-gap before the headless web app's per-note magic-links.
  // Read-only wrt content → excluded from WRITE_TOOL_NAMES.
  {
    name: 'get_view_link',
    description:
      'Get an ephemeral, ready-to-click browser link to VIEW/READ a vault\'s LIVE Obsidian GUI — navigated to a specific note, with credentials baked into the URL so the user types nothing. Call this WHENEVER the user asks for a link to read/see/open a note (e.g. "give me the link to the document", "can I see it", "où puis-je lire ça"), OR right after writing/updating a note to proactively offer a read link. IMPORTANT: this is the ONLY way to get a public URL for a REMOTE vault — when the `clickToOpenUrl` field comes back null (remote vault, no local data.json), do NOT tell the user "there is no public link", call get_view_link instead. Served by an on-demand Cloudflare tunnel that auto-closes after an idle timeout (ephemeral, never permanently exposed). Optional `note` opens the GUI on that file; omit `vault` for the default vault. Requires the view-agent configured on this router instance. Read-only — never changes vault content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: {
          type: 'string',
          description: 'Vault name (see list_vaults). Omit for the default vault.',
        },
        note: {
          type: 'string',
          description:
            'Optional vault-relative path of the note to open the GUI on (e.g. "Voyages/italie.md").',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  // Roadmap item #6 (llm-wiki-compiler) — structured JSON context pack for
  // non-Claude agents. Read-only (queries the wiki via index.md + smart
  // search + frontmatter), excluded from WRITE_TOOL_NAMES.
  GET_WIKI_CONTEXT_PACK_TOOL_DEFINITION,
  // Roadmap item #1 (understand-anything) — typed knowledge-graph artifact
  // (UA-compatible schema). WRITES the graph JSON (canonical wiki-meta/graph/
  // + derived .understand-anything/ copy) → included in WRITE_TOOL_NAMES.
  BUILD_WIKI_GRAPH_TOOL_DEFINITION,
  // Volet ② (catalog/journal decision, v0.59.0) — regenerates the OKF
  // navigation projections inside wiki/ (root index.md, per-directory
  // index.md, newest-first log.md). WRITES those files → WRITE_TOOL_NAMES.
  REFRESH_OKF_PROJECTIONS_TOOL_DEFINITION,
  // Roadmap item #3 (understand-anything) — deterministic guided-tour skeleton
  // from the knowledge graph. Read-only (reads the graph JSON) — excluded from
  // WRITE_TOOL_NAMES.
  BUILD_WIKI_TOUR_TOOL_DEFINITION,
  BUILD_SEARCH_INDEX_TOOL_DEFINITION,
  RECORD_SOURCE_TOOL_DEFINITION,
  AUDIT_SOURCES_TOOL_DEFINITION,
  // Page-neighbors roadmap W-A — the neighbourhood of ONE page from the graph
  // (backlinks + forward-links, bounded depth). Read-only (reads the graph JSON)
  // — excluded from WRITE_TOOL_NAMES.
  GET_PAGE_NEIGHBORS_TOOL_DEFINITION,
  // Page-neighbors roadmap W-B — the shortest link chain between TWO pages
  // (undirected). Read-only (reads the graph JSON) — excluded from
  // WRITE_TOOL_NAMES.
  WIKI_PATH_TOOL_DEFINITION,
  // Crawl4AI roadmap W-A — BM25 relevance second-pass over already-acquired
  // markdown (no fetch, no vault I/O) — excluded from WRITE_TOOL_NAMES.
  FILTER_RELEVANT_BLOCKS_TOOL_DEFINITION,
  // v0.35.0 — vault-creation wizard (LOCAL-ONLY, gated out when
  // OBSIDIAN_ROUTER_USER_ID is set). plan_vault is read-only; provision_vault
  // writes a new vault to the local filesystem.
  {
    name: 'plan_vault',
    description:
      'READ-ONLY. Plan the creation of a NEW local Obsidian vault: returns the computed defaults + a structured questionnaire (the 5 wiki modes with explanations, the themes installed in the source, the registered vaults you can copy config from, the plugin profiles) + warnings + an approvedPlanSha256 (C3 sealed preview), WITHOUT writing anything. The harness LLM drives the conversation from this data, then calls provision_vault with the SAME arguments plus that seal. LOCAL-ONLY: absent on gated deployments.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The intended vault location (e.g. "C:\\\\VAULTS\\\\MyProject"). The frontend proposes a default.' },
        name: { type: 'string', description: 'Optional display name (→ slug).' },
        source: {
          type: 'object',
          description: 'Template source override. kind: reference (default) | from-vault | skeleton | bare.',
          properties: {
            kind: { type: 'string', enum: ['reference', 'from-vault', 'skeleton', 'bare'] },
            fromVault: { type: 'string', description: 'Source vault slug or path (for kind=from-vault).' },
            withFolderTree: { type: 'boolean', description: 'Recreate the source wiki/ folder tree empty (from-vault only).' },
          },
          additionalProperties: false,
        },
        plugins: {
          type: 'object',
          properties: {
            profile: { type: 'string', enum: ['recommended', 'minimal', 'custom'] },
            custom: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        wikiMode: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['personal', 'research', 'business', 'code', 'domain'] },
            sections: { type: 'array', items: { type: 'string' }, description: 'Flat section list for mode=domain.' },
          },
          additionalProperties: false,
        },
        theme: { type: 'string', description: 'Theme to apply: a theme folder name cloned from the source (see plan_vault\'s themes list), or "obsidian-default" for the built-in look. Written as cssTheme in the new vault\'s appearance.json.' },
        linkWorkspace: { type: 'string', description: 'Code workspace path to bind to this vault.' },
        claudeWorkspace: { type: 'boolean' },
      },
      required: ['path'],
      additionalProperties: true,
    },
  },
  {
    name: 'provision_vault',
    description:
      'Create a NEW local Obsidian vault in one call from a set of wizard answers (typically the defaults/adjustments surfaced by plan_vault). Returns a step-by-step report + port, insecurePort, openUri, and probeResult. SECURITY: refuses any path outside the known vault roots unless allowOutsideRoots:true; --from-vault copies config only (workspace.json + credential data.json excluded, port + API key regenerated). LOCAL-ONLY: absent on gated deployments. Writes to the local filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target vault location (must be under a known vault root unless allowOutsideRoots).' },
        name: { type: 'string' },
        source: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['reference', 'from-vault', 'skeleton', 'bare'] },
            fromVault: { type: 'string' },
            withFolderTree: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        plugins: {
          type: 'object',
          properties: {
            profile: { type: 'string', enum: ['recommended', 'minimal', 'custom'] },
            custom: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        wikiMode: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['personal', 'research', 'business', 'code', 'domain'] },
            sections: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        theme: { type: 'string' },
        linkWorkspace: { type: 'string' },
        claudeWorkspace: { type: 'boolean' },
        open: { type: 'boolean', description: 'Launch Obsidian on the new vault.' },
        probe: { type: 'boolean', description: 'Poll the REST port for a health verdict after open.' },
        probeTimeout: { type: 'number', description: 'Probe timeout in seconds.' },
        gitInit: { type: 'boolean', description: 'git init + initial commit inside the vault.' },
        allowOutsideRoots: { type: 'boolean', description: 'Override the path gate to allow a target outside known vault roots.' },
        approvedPlanSha256: {
          type: 'string',
          description: 'C3 sealed preview: the 64-hex seal plan_vault returned. When supplied, provisioning is refused (before the filesystem-mutating run) if the plan drifted since the preview — a slug collision appeared, the source vault changed, a root vanished. Call plan_vault with the SAME arguments to obtain it.',
        },
      },
      required: ['path'],
      additionalProperties: true,
    },
  },
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
  pdf_to_markdown_docling: (reg, args) => pdfToMarkdownDocling(reg, args),
  // Returns a ready MCP `{content}` payload (image blocks), not a string —
  // see `isMcpContentPayload` / `wrapResult` below, which passes it through
  // untouched instead of JSON.stringify-ing it. Read-only wrt vault state,
  // same rationale as the other conversion tools — excluded from
  // WRITE_TOOL_NAMES.
  pdf_to_images: (reg, args) => pdfToImagesTool(reg, args),
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
  // v0.14.x Phase E — page asset downloader (image preservation in vault).
  download_page_assets: (_reg, args) => handleDownloadPageAssets(args),
  // v0.14.8 — click-to-open URL builder (read-only, no vault I/O beyond
  // the per-vault data.json port lookup).
  build_open_link: (reg, args) => buildOpenLinkTool(reg, args),
  // v0.24.0 — browser-free "open this note in Obsidian" (server-side /open call).
  open_in_obsidian: (reg, args) => openInObsidianTool(reg, args),
  // Interim ephemeral view-link to a vault's live Obsidian GUI (Dedibox view-agent).
  get_view_link: (reg, args) => getViewLinkTool(reg, args),
  // Roadmap item #6 — structured JSON context pack (v1 envelope).
  get_wiki_context_pack: (reg, args) => getWikiContextPack(reg, args),
  // Roadmap item #1 (understand-anything) — deterministic knowledge-graph builder.
  build_wiki_graph: (reg, args) => buildWikiGraphTool(reg, args),
  // C4/C5 — local deterministic BM25 index (plugin-free search tier).
  build_search_index: (reg, args) => buildSearchIndexTool(reg, args),
  // C6 — source ledger: forward-fill register + read-only independence audit.
  record_source: (reg, args) => recordSourceTool(reg, args),
  audit_sources: (reg, args) => auditSourcesTool(reg, args),
  refresh_okf_projections: (reg, args) => refreshOkfProjectionsTool(reg, args),
  // Roadmap item #3 (understand-anything) — read-only guided-tour skeleton.
  build_wiki_tour: (reg, args) => buildWikiTourTool(reg, args),
  // Page-neighbors roadmap W-A — read-only page-neighbourhood query.
  get_page_neighbors: (reg, args) => getPageNeighborsTool(reg, args),
  // Page-neighbors roadmap W-B — read-only shortest-path query between two pages.
  wiki_path: (reg, args) => wikiPathTool(reg, args),
  // Crawl4AI roadmap W-A — read-only BM25 relevance filter over given markdown.
  filter_relevant_blocks: (reg, args) => filterRelevantBlocksTool(reg, args),
  // v0.35.0 — vault-creation wizard (LOCAL-ONLY). plan_vault is read-only;
  // provision_vault writes a new vault. Both drive the setup-vault.mjs engine
  // and use `reg.configPath` so the child runs against the server's config.
  plan_vault: (reg, args) => planVaultTool(reg, args),
  provision_vault: (reg, args) => provisionVaultTool(reg, args),
};

// LOCAL-ONLY tools: they touch the local filesystem (provision_vault writes a
// new vault), so they are HIDDEN from the tool list — and refused at CallTool —
// on any gated/multi-tenant deployment (OBSIDIAN_ROUTER_USER_ID set). Same
// spirit as the MD_ALLOWED_PATHS sandbox gate. Exported for testing.
const LOCAL_ONLY_TOOL_NAMES = new Set(['plan_vault', 'provision_vault']);

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
  // v0.14.x Phase E — writes binary asset files to disk (in vault `.assets/`
  // under MD_ALLOWED_PATHS sandbox). Read-only deployments must hide it.
  'download_page_assets',
  // Roadmap item #1 (understand-anything) — writes the knowledge-graph JSON
  // to wiki-meta/graph/ + .understand-anything/. Read-only must hide it.
  'build_wiki_graph',
  // C4 — writes wiki-meta/search-index.json. Read-only deployments must hide
  // it (search_smart's `tier: 'local'` still READS the index, which is fine).
  'build_search_index',
  // C6 — writes wiki-meta/source-ledger.json. `audit_sources` is read-only and
  // is deliberately NOT in this set.
  'record_source',
  // v0.59.0 — rewrites the generated OKF projections inside wiki/. Read-only
  // deployments must hide it.
  'refresh_okf_projections',
  // v0.35.0 — writes a NEW vault to the local filesystem. A read-only
  // deployment must hide it too (not just the OBSIDIAN_ROUTER_USER_ID gate).
  // plan_vault is read-only and is deliberately NOT in this set. (review+ W2 P1)
  'provision_vault',
]);

// ---------------------------------------------------------------------------
// v0.59.0 — volet ② of the catalog/journal decision: keep the OKF navigation
// projections inside `wiki/` fed as content is written. Debounced full
// refresh per vault (see helpers/projections-refresh.mjs for why full-refresh
// -debounced beats incremental surgery); the core's `requireInitialized` gate
// means only vaults whose root `wiki/index.md` exists AND carries the
// generated marker are ever touched — scaffolding or one explicit
// `refresh_okf_projections` call is the opt-in.
// ---------------------------------------------------------------------------

const PROJECTIONS_OPTOUT = new Set(['true', '1', 'yes', 'on']);
const projectionsDebounceMs = (() => {
  const raw = Number.parseInt(process.env.OBSIDIAN_ROUTER_PROJECTIONS_DEBOUNCE_MS ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_DEBOUNCE_MS;
})();
const projectionsScheduler = PROJECTIONS_OPTOUT.has(
  String(process.env.OBSIDIAN_ROUTER_NO_OKF_PROJECTIONS || '').toLowerCase(),
)
  ? null
  : createProjectionsScheduler({
    refresh: async (vault) => {
      const result = await refreshProjectionsForVault(
        vault,
        {
          listFilesIn: restListFilesIn,
          getFileContent: restGetFileContent,
          writeFile: restWriteFile,
          deleteFile: restDeleteFile,
        },
        { requireInitialized: true },
      );
      // Middleware writes bypass the tool layer, hence the audit trail — a
      // one-line stderr trace keeps them observable (review v0.59.0 N4).
      if (result && !result.skipped && (result.written?.length || result.deleted?.length)) {
        console.error(
          `[obsidian-mcp-router] okf-projections refreshed for "${vault.name}": ` +
            `${result.written.length} written, ${result.deleted.length} deleted` +
            `${result.conflicts?.length ? `, ${result.conflicts.length} conflict(s) untouched` : ''}`,
        );
      }
      return result;
    },
    delayMs: projectionsDebounceMs,
  });

/**
 * Subset of WRITE_TOOL_NAMES that writes a NOTE the member may want to read — the
 * tools that get a deterministic `viewLink` attached to their result (Option B), via
 * the central hook in the CallTool dispatch. Excludes delete_file (note gone),
 * download_page_assets / build_wiki_graph (not notes), and execute_template (variable
 * result shape). The hook reads the note path from `result.to` (move_file) or
 * `result.path` (all others) and the vault name from `result.vault`.
 */
const VIEW_LINK_TOOLS = new Set([
  'write_file',
  'append_to_file',
  'patch_file',
  'set_frontmatter',
  'merge_frontmatter',
  'move_file',
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
 * Compute the ListTools surface from the full catalog + the active gates. Pure (no env
 * reads) so it is unit-testable. Two filters:
 *   - readonly             → drop WRITE_TOOL_NAMES (v0.9.0).
 *   - !viewAgentConfigured → drop `get_view_link` (v0.29.0, geste 1 of the "provider model"):
 *     a router with no OBSIDIAN_ROUTER_VIEW_AGENT_URL shows ZERO view-link tool, so a
 *     published build without the optional view-agent infra carries no dead/confusing tool.
 *     (The `viewLink` auto-injection is separately gated inside `viewLinkForWrite`.)
 * Exported for testing.
 */
export function computeExposedTools(tools, { readonly = false, viewAgentConfigured = false, gated = false } = {}) {
  let out = readonly ? tools.filter((t) => !WRITE_TOOL_NAMES.has(t.name)) : tools;
  if (!viewAgentConfigured) out = out.filter((t) => t.name !== 'get_view_link');
  // Gated/multi-tenant deployments hide the local-only vault-provisioning tools.
  if (gated) out = out.filter((t) => !LOCAL_ONLY_TOOL_NAMES.has(t.name));
  return out;
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
  // build_wiki_graph has no `path` arg — it writes the canonical graph JSON
  // (+ a derived UA copy). Record the canonical path (codex review+ P2).
  if (toolName === 'build_wiki_graph') return BUILD_WIKI_GRAPH_CANONICAL_PATH;
  // refresh_okf_projections rewrites a SET of files; audit the root index.
  if (toolName === 'refresh_okf_projections') return 'wiki/index.md (okf projections)';
  return args.path || '(unknown)';
}

/**
 * Format a single audit-log line. Stable shape so we can grep it later
 * (e.g. `git log -p wiki-meta/journal.md | grep "by roland"`). The leading
 * and trailing newlines isolate the entry from whatever sits in
 * `wiki-meta/journal.md` already — the file is append-only so we always end
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
        resources: {},
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
  // Tool EXPOSURE filtering. Two gates:
  //  - READONLY (v0.9.0): hide write tools.
  //  - view-agent (v0.29.0, geste 1 of the provider model): hide `get_view_link` when no
  //    view-agent is configured, so a published router without the optional Dedibox-style
  //    infra shows zero dead/confusing tool. The `viewLink` auto-injection is independently
  //    gated inside `viewLinkForWrite` (silent + zero latency when unconfigured).
  const viewAgentConfigured = !!(process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim();
  // v0.35.0 — the local-only vault-wizard tools (plan_vault / provision_vault)
  // are hidden on any gated deployment (OBSIDIAN_ROUTER_USER_ID set), since
  // provision_vault writes to the local filesystem and must never be reachable
  // from a shared/multi-tenant router.
  const gated = !!(process.env.OBSIDIAN_ROUTER_USER_ID || '').trim();
  if (gated) {
    console.error(
      `[obsidian-mcp-router] OBSIDIAN_ROUTER_USER_ID set — local-only tools hidden: ` +
        [...LOCAL_ONLY_TOOL_NAMES].join(', '),
    );
  }
  const exposedTools = computeExposedTools(TOOLS, { readonly, viewAgentConfigured, gated });
  // Smart links (resolver provider) take PRIORITY over the view-agent inside
  // viewLinkForWrite / open_in_obsidian — pure HMAC emission, no network call.
  const smartLinksOn = smartLinkEnabled(process.env);
  if (smartLinksOn) {
    console.error(
      '[obsidian-mcp-router] smart links enabled (OBSIDIAN_ROUTER_SMART_LINK_URL) — note ' +
        'writes carry a resolver viewLink (no view-agent call; takes priority over the agent).',
    );
  } else if (
    (process.env.OBSIDIAN_ROUTER_SMART_LINK_URL || '').trim() ||
    (process.env.OBSIDIAN_ROUTER_SMART_LINK_SECRET || '').trim()
  ) {
    // Exactly one of the two vars set = almost certainly a typo'd deploy. Without this
    // line the misconfiguration is fully silent (gate closed → agent/none fallback).
    console.error(
      '[obsidian-mcp-router] smart links HALF-configured — set BOTH ' +
        'OBSIDIAN_ROUTER_SMART_LINK_URL and OBSIDIAN_ROUTER_SMART_LINK_SECRET to enable them. ' +
        'Smart links are OFF; falling back to the view-agent (or no viewLink).',
    );
  }
  if (!viewAgentConfigured) {
    console.error(
      '[obsidian-mcp-router] OBSIDIAN_ROUTER_VIEW_AGENT_URL unset — get_view_link hidden' +
        (smartLinksOn
          ? '.'
          : ', no viewLink injection (the view-link provider is optional).'),
    );
  }

  // v0.9.0 — audit log (USER_ID). When OBSIDIAN_ROUTER_USER_ID is set,
  // every SUCCESSFUL write tool call gets a line appended to the touched
  // vault's `wiki-meta/journal.md` so we can trace "who wrote what" later.
  // Each MCPHub instance gets its own USER_ID env, so a 6-instance
  // multi-tenant setup gives us free user-level attribution without
  // modifying any downstream tool.
  //
  // v0.12.0: target path moved from `wiki/log.md` to `wiki-meta/log.md`
  // along with the other 3 scaffolds (hot/index/overview). User content
  // stays under `wiki/`. v0.58.0 renamed it again to `wiki-meta/journal.md`
  // (OKF reserves the `log` basename) — see `wiki-meta-scaffolds.mjs`.
  //
  // CRITICAL: the audit append uses `restAppendToFile` directly (REST
  // helper) — NOT the `append_to_file` tool handler. Going through the
  // handler would loop because the audit write itself is a write tool.
  // The direct REST call bypasses the dispatcher and the audit middleware.
  //
  // Failure policy: best-effort. If the audit write fails (disk full,
  // journal not writable, etc.), we log the cause to stderr and return
  // the original write's success — better to lose an audit line than to
  // fail the user-facing operation. Cf. risk R5 in 2026-05-21-codex-audit.
  const rawUserId = process.env.OBSIDIAN_ROUTER_USER_ID;
  const userId = rawUserId && rawUserId.trim().length > 0 ? rawUserId.trim() : null;
  if (userId) {
    console.error(
      `[obsidian-mcp-router] OBSIDIAN_ROUTER_USER_ID="${userId}" — audit logging enabled. ` +
        `Every successful write appends to <vault>/wiki-meta/journal.md.`,
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
      // v0.35.0 — second-layer gate for the local-only wizard tools. Refuse
      // even if a client skipped ListTools and called the name directly.
      if (gated && LOCAL_ONLY_TOOL_NAMES.has(name)) {
        throw new Error(
          `Tool "${name}" is disabled on this deployment ` +
            `(OBSIDIAN_ROUTER_USER_ID is set — the local-only vault-provisioning ` +
            `tools are hidden). Use the local, non-gated router to create vaults.`,
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
          //
          // v0.58.0: `journal.md`, with `log.md` as a fallback for vaults
          // not yet migrated. Order matters — appending with
          // `createTargetIfMissing` on the FIRST try would silently create a
          // second journal next to the existing `log.md` and split the audit
          // trail in two. So: try each name without creating, and only
          // create the current name when neither exists. The migrated case
          // (the common one) still costs exactly one round-trip.
          const [journalRel, legacyJournalRel] = scaffoldCandidates('journal');
          let appended = false;
          for (const rel of [journalRel, legacyJournalRel]) {
            try {
              await restAppendToFile(auditVault, rel, auditLine, {
                createTargetIfMissing: false,
              });
              appended = true;
              break;
            } catch (e) {
              // Only a 404 means "not under this name"; an offline or
              // unauthorized vault must not fall through to a create.
              if (!shouldTryLegacyScaffold(e)) throw e;
            }
          }
          if (!appended) {
            await restAppendToFile(auditVault, journalRel, auditLine, {
              createTargetIfMissing: true,
            });
          }
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

      // v0.59.0 — volet ②: schedule the debounced OKF-projections refresh
      // after any successful write. Best-effort and self-gating: the
      // scheduler ignores paths outside wiki/ content, and the refresh core
      // aborts on vaults whose projections were never initialised. Its own
      // writes go through rest-client directly, so nothing here recurses.
      if (projectionsScheduler && WRITE_TOOL_NAMES.has(name)) {
        try {
          projectionsScheduler.noteWrite(reg.resolveVault(args.vault), name, args);
        } catch { /* nav upkeep must never block or fail a user write */ }
      }

      // v0.29.0 — DETERMINISTIC ephemeral view-link on note writes (Option B).
      // After a successful note write, ask the view-agent for a read link and attach it
      // to the result. Cross-cutting + async + expensive → centralized HERE (next to the
      // audit-log block above, the closest precedent), NOT per-tool like the cheap sync
      // `clickToOpenUrl`. `viewLinkForWrite` is gated by OBSIDIAN_ROUTER_VIEW_AGENT_URL
      // (silent + zero latency when unset), skips wiki-meta/ housekeeping, and NEVER
      // throws — a view-link problem must never break the write that triggered it.
      // Deliberately NOT gated on `userId`: the link applies regardless of audit config.
      if (VIEW_LINK_TOOLS.has(name) && result && typeof result === 'object') {
        // `noteForWriteResult` selects result.to (move_file) / result.path (others) and
        // returns null to SKIP — e.g. merge_frontmatter that applied 0 keys (nothing written,
        // so no read link to promise). review+ pass 1 (Code Reviewer + codex convergent).
        const note = noteForWriteResult(result);
        if (note) {
          Object.assign(result, await viewLinkForWrite({ vaultName: result.vault, note }));
        }
      }

      return await wrapResult(Promise.resolve(result));
    } catch (err) {
      // Friendly errors when the underlying RestApiError carries a `hint`.
      const { errorCategory, isRetryable } = classifyError(err);
      const lines = [`Error: ${err.message}`];
      if (err.kind) lines.push(`Kind: ${err.kind}`);
      if (err.hint) lines.push(`Hint: ${err.hint}`);
      // Machine-readable classification (v0.20.0, MCP standard #4). The readable
      // text lines (Category:/Retryable:) are the AUTHORITATIVE channel — every
      // MCP client sees them. `_meta` below is a best-effort programmatic mirror
      // (the MCP spec treats result `_meta` as passthrough; some clients may
      // drop it), so we never rely on it alone. Lets an agent auto-retry a
      // transient WireGuard drop.
      lines.push(`Category: ${errorCategory}`);
      lines.push(`Retryable: ${isRetryable}`);
      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n'),
          },
        ],
        isError: true,
        _meta: {
          errorCategory,
          isRetryable,
          kind: err.kind || 'unknown',
        },
      };
    }
  });

  const transport = new StdioServerTransport();
  // v0.20.0 — MCP Resources (#6): expose the wiki catalogue read-only. Safe on
  // READONLY instances (resources never mutate). registryRef.current is the
  // live, hot-reload-aware registry.
  registerResourceHandlers(server, () => registryRef.current);

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

/**
 * Is `result` already a ready-to-ship MCP content payload — i.e. does it
 * have the `{ content: [{ type, ... }, ...] }` shape the MCP SDK expects
 * verbatim? Used by `wrapResult` to distinguish tools like `pdf_to_images`
 * (which build their own typed `content[]`, including `image` blocks that
 * must NOT be stringified) from every other tool, which returns either a
 * plain string or a plain object with no typed `content[]` of its own.
 */
export function isMcpContentPayload(result) {
  return !!result && typeof result === 'object' && Array.isArray(result.content)
    && result.content.length > 0
    && result.content.every((c) => c && typeof c === 'object' && typeof c.type === 'string');
}

async function wrapResult(promise) {
  const result = await promise;
  // Image-returning tools (currently only `pdf_to_images`) already return a
  // finished MCP content payload — `{ content: [{type:'text',...}, {type:
  // 'image', data, mimeType}, ...] }`. That must pass through UNTOUCHED: the
  // generic stringify path below would JSON.stringify the whole object
  // (including the base64 image data) into a single text block, destroying
  // the typed image blocks the MCP client needs to actually render them.
  // Every other existing tool returns a plain string or a plain object with
  // no typed `content[]` — `isMcpContentPayload` is false for those, so they
  // fall through to the existing behavior unchanged.
  if (isMcpContentPayload(result)) return result;
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
  VIEW_LINK_TOOLS,
  LOCAL_ONLY_TOOL_NAMES,
  computeExposedTools,
  PKG_VERSION,
  isMcpContentPayload,
};
