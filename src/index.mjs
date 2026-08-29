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
// The audit line's truncation notice carries a digest of the ORIGINAL path, so
// two long paths sharing a prefix and a length cannot collapse to one line.
import { createHash } from 'node:crypto';
import { loadRegistry, resolveConfigPath } from './registry.mjs';
import { classifyError } from './error-classify.mjs';
import { registerResourceHandlers } from './resources.mjs';
import {
  appendToFile as restAppendToFile,
  listFilesIn as restListFilesIn,
  getFileContent as restGetFileContent,
  writeFile as restWriteFile,
  deleteFile as restDeleteFile,
  attemptAtomicCas as restAttemptAtomicCas,
} from './rest-client.mjs';
import { strictReservedCasEnabled } from './helpers/reserved-path-write.mjs';
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
  buildIndexForVault,
} from './tools/build-search-index.mjs';
import {
  RECORD_TOOL_DEFINITION as RECORD_SOURCE_TOOL_DEFINITION,
  AUDIT_TOOL_DEFINITION as AUDIT_SOURCES_TOOL_DEFINITION,
  recordSourceTool,
  auditSourcesTool,
} from './tools/source-ledger.mjs';
import {
  TOOL_DEFINITION as WRITE_BUNDLE_TOOL_DEFINITION,
  writeBundleTool,
} from './tools/write-bundle.mjs';
// The vault paths three write tools target without ever naming them in an
// argument — see FIXED_AUDIT_TARGETS.
import { SEARCH_INDEX_PATH } from './helpers/bm25-index.mjs';
import { SOURCE_LEDGER_PATH } from './helpers/source-ledger.mjs';
import { BUNDLE_JOURNAL_DIR } from './helpers/write-bundle.mjs';
import {
  TOOL_DEFINITION as GET_PAGE_NEIGHBORS_TOOL_DEFINITION,
  getPageNeighborsTool,
} from './tools/get-page-neighbors.mjs';
import {
  TOOL_DEFINITION as WIKI_PATH_TOOL_DEFINITION,
  wikiPathTool,
} from './tools/wiki-path.mjs';
import {
  TOOL_DEFINITION as FIND_BOUNDARY_PAGES_TOOL_DEFINITION,
  findBoundaryPagesTool,
} from './tools/find-boundary-pages.mjs';
import {
  TOOL_DEFINITION as FIND_TWIN_PAGES_TOOL_DEFINITION,
  findTwinPagesTool,
} from './tools/find-twin-pages.mjs';
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
import { createConformanceGate, createMaintenancePass } from './helpers/vault-conformance.mjs';

// Single-source-of-truth for the package version (v0.13.4+). Extracted
// to src/helpers/pkg-version.mjs so MCP tools (extract_page_metadata,
// propose_linked_sources) can share the User-Agent string without
// circular imports or duplicated reads. Pre-v0.13.4 each tool hardcoded
// the version string and drifted across releases.
import { PKG_VERSION } from './helpers/pkg-version.mjs';
import { sanitizeResponse, safeForMessage, NO_TRUNCATION } from './helpers/sanitize.mjs';
// The ONE definition of "which files does this call really write", shared with
// the projections scheduler — it used to be a second copy that drifted three
// ways. See helpers/write-targets.mjs.
import { writeTargets, isRecoveryCall } from './helpers/write-targets.mjs';
import { canonicalVaultPath as guardVaultPath } from './helpers/vault-path-guard.mjs';

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
        ifMatch: {
          type: 'string',
          description: 'Optimistic-concurrency guard (C1): the contentSha256 from get_file. The append is refused with a 409 conflict if the file changed since you read it. Checked before the append, not atomically with it.',
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
        ifMatch: {
          type: 'string',
          description: 'Optimistic-concurrency guard (C1): the contentSha256 from get_file. The property is not set if the file changed since you read it — a 409 conflict instead. Checked before the patch, not atomically with it.',
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
  // C2 — journaled multi-file bundle with rollback. WRITES (it runs the other
  // write tools, plus its own journal under wiki-meta/) → WRITE_TOOL_NAMES.
  WRITE_BUNDLE_TOOL_DEFINITION,
  // Page-neighbors roadmap W-A — the neighbourhood of ONE page from the graph
  // (backlinks + forward-links, bounded depth). Read-only (reads the graph JSON)
  // — excluded from WRITE_TOOL_NAMES.
  GET_PAGE_NEIGHBORS_TOOL_DEFINITION,
  // Page-neighbors roadmap W-B — the shortest link chain between TWO pages
  // (undirected). Read-only (reads the graph JSON) — excluded from
  // WRITE_TOOL_NAMES.
  WIKI_PATH_TOOL_DEFINITION,
  // C10 — "frontier" pages: heavily linked, thin inside. Read-only (reads the
  // graph JSON, writes nothing) — excluded from WRITE_TOOL_NAMES.
  FIND_BOUNDARY_PAGES_TOOL_DEFINITION,
  // C11 — quasi-twin pages by cosine over the Smart Connections vector store.
  // Read-only (reads `.smart-env/multi/` + the wiki pages, writes nothing) —
  // excluded from WRITE_TOOL_NAMES.
  FIND_TWIN_PAGES_TOOL_DEFINITION,
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
        // C3 catch-22 fix (v0.76.0): these 5 are EXEC options — plan_vault
        // never executes them (it is read-only), but they are folded into the
        // sealed plan so provision_vault's apply-time hash matches. Omitting
        // them here let a client that forwards only schema-declared
        // properties drop them before the handler saw them, so the preview
        // sealed e.g. `allowOutsideRoots: null` while provision_vault's own
        // (correctly-declared) schema kept the caller's `true` — a systematic
        // plan_drift for the common case of a target outside the known roots.
        // Pass the SAME values here that you intend for provision_vault.
        open: { type: 'boolean', description: 'Exec option — not executed during this READ-ONLY preview; sealed so it must match what you pass to provision_vault (which does execute it).' },
        probe: { type: 'boolean', description: 'Exec option — same as `open`: sealed here, executed by provision_vault.' },
        probeTimeout: { type: 'number', description: 'Exec option — same as `open`: sealed here, executed by provision_vault.' },
        gitInit: { type: 'boolean', description: 'Exec option — same as `open`: sealed here, executed by provision_vault.' },
        allowOutsideRoots: { type: 'boolean', description: 'Exec option — same as `open`: sealed here, executed by provision_vault. Pass it here too when the target is outside known vault roots, matching what you will pass to provision_vault — otherwise the sealed preview will not match provision_vault\'s apply-time hash and it will refuse with plan_drift.' },
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
  // C2 — journaled multi-file bundle (all-or-nothing apply + rollback).
  write_bundle: (reg, args) => writeBundleTool(reg, args),
  refresh_okf_projections: (reg, args) => refreshOkfProjectionsTool(reg, args),
  // Roadmap item #3 (understand-anything) — read-only guided-tour skeleton.
  build_wiki_tour: (reg, args) => buildWikiTourTool(reg, args),
  // Page-neighbors roadmap W-A — read-only page-neighbourhood query.
  get_page_neighbors: (reg, args) => getPageNeighborsTool(reg, args),
  // Page-neighbors roadmap W-B — read-only shortest-path query between two pages.
  wiki_path: (reg, args) => wikiPathTool(reg, args),
  // C10 — read-only ranking of heavily-linked-but-thin "frontier" pages.
  find_boundary_pages: (reg, args) => findBoundaryPagesTool(reg, args),
  // C11 — read-only detection of quasi-twin page pairs (cosine over the local
  // Smart Connections vector store). LOCAL-ONLY: the store is a dot-directory
  // the REST API does not serve.
  find_twin_pages: (reg, args) => findTwinPagesTool(reg, args),
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
  // C2 — runs several write tools as one journaled operation. Its `recover:true`
  // listing is read-only, but the tool as a whole writes (steps + journal), so
  // it is hidden wholesale in readonly mode: a deployment that cannot write
  // cannot have left a bundle half-applied either.
  'write_bundle',
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
const projectionsOff = PROJECTIONS_OPTOUT.has(
  String(process.env.OBSIDIAN_ROUTER_NO_OKF_PROJECTIONS || '').toLowerCase(),
);

/**
 * THE maintenance pass, shared by every automatic trigger: the debounced
 * post-write flush and the first-contact repair. It refreshes the OKF
 * projections and then the BM25 index, inside ONE hold of the per-vault lock —
 * see helpers/vault-conformance.mjs for why both live in the same window, and
 * helpers/vault-maintenance-lock.mjs for what the lock protects.
 */
const maintainVault = createMaintenancePass({
  refreshProjections: projectionsOff ? null : (vault) => refreshProjectionsForVault(
    vault,
    {
      listFilesIn: restListFilesIn,
      getFileContent: restGetFileContent,
      writeFile: restWriteFile,
      deleteFile: restDeleteFile,
      attemptAtomicCas: restAttemptAtomicCas,
    },
    // `requireScaffold`: the opt-in signal is the private `wiki-meta/` scaffold
    // the provisioner writes, NOT a marked `wiki/index.md`. Gating on the latter
    // meant refusing to repair the exact file whose absence is what needed
    // repairing — while the bridge's Notice promised the router would fix it.
    //
    // F3-b: the automatic path writes CONDITIONALLY (foreign content on a
    // reserved path is backed up, never blindly clobbered) and NEVER deletes
    // automatically (a delete of a reserved-path file is irrecoverable — it is
    // reported as `pendingDeletes` for an explicit action).
    {
      requireScaffold: true,
      conditionalWrites: true,
      deferDeletes: true,
      strictReservedCas: strictReservedCasEnabled(),
    },
  ),
  // `automatic: true` is the difference between this path and the explicit tool:
  // calling `build_search_index` is consent to rewrite whatever sits at that
  // path (including migrating a foreign version); an unattended repair is not.
  ensureSearchIndex: (vault) => buildIndexForVault(
    vault,
    {
      listFilesIn: restListFilesIn,
      getFileContent: restGetFileContent,
      writeFile: restWriteFile,
      attemptAtomicCas: restAttemptAtomicCas,
    },
    // `requireScaffold` for the same reason as the projections half. F3-b:
    // conditional write so a foreign file on the index path is preserved.
    { automatic: true, requireScaffold: true, conditionalWrites: true },
  ),
  // Middleware writes bypass the tool layer, hence the audit trail — a one-line
  // stderr trace keeps them observable (review v0.59.0 N4).
  logInfo: (msg) => console.error(msg),
});

const projectionsScheduler = createProjectionsScheduler({
  refresh: maintainVault,
  delayMs: projectionsDebounceMs,
});

// ---------------------------------------------------------------------------
// FIRST CONTACT — the "contact" moment of vault conformance.
//
// The debounced middleware above only reacts to writes MADE BY THIS ROUTER, and
// the BM25 index had no trigger at all. So a vault could be reached all session
// long with stale projections and no search index — which is how `search_smart`
// on a vault without Smart Connections ended up with no tier left and an
// outright error instead of a degraded service.
//
// The fix is not another background loop: it is the one moment that reliably
// happens, the first time a session touches a vault. See
// helpers/vault-conformance.mjs for the once-per-session contract and for what
// this deliberately does NOT repair.
//
// NOT a second refresh path: it runs the SAME `maintainVault` pass the debounced
// flush runs, which holds the same per-vault lock as the two explicit tools.
//
// Read-only deployments get no gate at all — repair writes, and a router told
// not to write must not write behind the user's back either.
// ---------------------------------------------------------------------------

const CONFORMANCE_OPTOUT = new Set(['true', '1', 'yes', 'on']);
const conformanceDisabled = CONFORMANCE_OPTOUT.has(
  String(process.env.OBSIDIAN_ROUTER_NO_AUTO_CONFORMANCE || '').toLowerCase(),
);

function makeConformanceGate({ readonly }) {
  if (conformanceDisabled || readonly) return null;
  return createConformanceGate({ maintain: maintainVault });
}

/**
 * WHICH TOOL CALLS COUNT AS "CONTACT WITH A VAULT".
 *
 * Derived from the tool schemas, not hand-listed: a tool is a candidate when its
 * own `inputSchema` declares a `vault` property. A converter like
 * `pdf_to_markdown` does not, and letting it through would have meant
 * `resolveVault(undefined)` running maintenance on the DEFAULT vault every time
 * somebody converted an unrelated PDF.
 *
 * Then four exemptions, each for its own reason:
 *
 *   `build_search_index`, `refresh_okf_projections` — IN BOTH MODES. `check:
 *     true` advertises, in the tool description users read, that it reports
 *     "WITHOUT writing"; triggering a repair alongside it would make that
 *     sentence false. And an `apply` call already does the repair itself, so
 *     following it with another pass is pure duplicated work.
 *   `plan_vault`, `provision_vault` — these are ABOUT a vault that does not
 *     exist yet. Neither carries a `vault` name in the router's sense, so the
 *     resolution would land on whatever the old default was — maintaining the
 *     wrong vault at the exact moment a new one is being created.
 *   `lock_vault`, `unlock_vaults` — session routing, not vault content.
 */
const CONFORMANCE_TRIGGER_EXEMPT = new Set([
  'build_search_index',
  'refresh_okf_projections',
  'plan_vault',
  'provision_vault',
  'lock_vault',
  'unlock_vaults',
]);

/** Exported for tests: the trigger set, computed from the live tool catalog. */
export function computeConformanceTriggers(tools) {
  return new Set(
    tools
      .filter((t) => Object.prototype.hasOwnProperty.call(t.inputSchema?.properties ?? {}, 'vault'))
      .map((t) => t.name)
      .filter((name) => !CONFORMANCE_TRIGGER_EXEMPT.has(name)),
  );
}

const CONFORMANCE_TRIGGER_TOOLS = computeConformanceTriggers(TOOLS);

/**
 * The one tool whose first call must WAIT for the repair.
 *
 * `search_smart` is the founding incident: on a vault with no Smart Connections
 * and no BM25 index it has no tier left and fails outright. Repairing after it
 * returns would leave the session's FIRST semantic search failing — the exact
 * symptom this feature exists to remove — and, worse, a failing first call is
 * also what should have triggered the repair, so the naive version loops.
 *
 * Everything else stays fire-and-forget. Only `search_smart` pays the latency,
 * once per vault per session, and the trade is stated in the docs.
 */
const CONFORMANCE_BLOCKING_TOOLS = new Set(['search_smart']);

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
 * The vault path each fixed-target write tool actually writes. Consulted BEFORE
 * anything the caller supplied, because for these tools the target is not an
 * argument at all — the tool decides it.
 */
const FIXED_AUDIT_TARGETS = {
  // No `path` arg: it writes the canonical graph JSON (+ a derived UA copy).
  build_wiki_graph: BUILD_WIKI_GRAPH_CANONICAL_PATH,
  // Rewrites a SET of files; audit the root index.
  refresh_okf_projections: 'wiki/index.md (okf projections)',
  build_search_index: SEARCH_INDEX_PATH,
  record_source: SOURCE_LEDGER_PATH,
};

/** Does this tool's own inputSchema declare `field`? */
function declaresArg(toolName, field) {
  const tool = TOOLS.find((t) => t.name === toolName);
  return !!tool?.inputSchema?.properties?.[field];
}

/**
 * Text the ROUTER chose, as opposed to text a caller supplied.
 *
 * The distinction is the whole reason the audit line can be unforgeable and
 * still tell two files apart. `formatAuditLine` escapes every caller-derived
 * part and then adds the structure around it; a value wrapped here skips the
 * escaping because it never came from a caller — it is one of this module's own
 * constants. `formatAuditLine` still checks that the text cannot spell the
 * line's structure before trusting it, so a future constant containing a quote,
 * a bracket, a comma or a colon degrades to escaping instead of opening a hole.
 */
const routerText = (text) => ({ kind: 'router', text });

/**
 * Pick the path that identifies the file a write tool touched.
 *
 * THE FIELD HAS TO BE DECLARED. `request.params.arguments` is validated by the
 * SDK as an OPEN record, never against `inputSchema`, so `additionalProperties:
 * false` stops nothing at runtime. Reproduced against the real dispatcher with a
 * loopback vault recording the writes: `build_search_index` called with an
 * undeclared `path: "wiki/innocent.md"` wrote `wiki-meta/search-index.json` and
 * journalled
 *
 *     [claude-write by roland] … — build_search_index path="wiki/innocent.md"
 *
 * Same for `record_source` (writes the ledger) and `download_page_assets`
 * (writes an absolute outputDir), and on `write_bundle` the appended field
 * REPLACED the `(unknown)` sentinel and hid a real `wiki/secret-c.md` write.
 * The journal exists to attribute writes; an attribution the caller chooses is
 * worse than none, because it is believed.
 *
 * AND THE REAL TARGETS GET ENUMERATED. `write_bundle` used to log `(unknown)`
 * while writing every path in `steps[]` — the trail was blank for exactly the
 * tool that writes the most files at once.
 *
 * Returns `(unknown)` as a last-resort sentinel: audit is best-effort and never
 * blocks the call, so a missing path is a placeholder rather than an error.
 *
 * RETURN TYPE — this does NOT return a pre-assembled string any more, and that
 * change is the fix for a conflict three consecutive rounds could not settle.
 * The line has to be unforgeable (no character of the payload may spell the
 * structure) AND injective (two files, two lines). The previous round bought
 * the first by MUTILATING (`,` `(` `)` → `;`) and the second by ESCAPING, in
 * this function and the next, thirty lines apart — and mutilating destroys
 * injectivity: `{ , ( ) ; }` all fused into one symbol, measured at 569
 * collisions over 8 972 distinct canonical paths on this branch (0 on
 * `write_file`, which the mutilation does not touch).
 *
 * So the assembly moves to `formatAuditLine`, which escapes each part FIRST and
 * adds the structure AFTERWARDS. A payload cannot spell a separator because
 * everything it contains has already been escaped, and no part is mutilated, so
 * the two properties stop competing. What comes back here is therefore one of:
 *
 *   'wiki/a.md'                                       a caller-derived path
 *   { kind: 'router', text }                          text this module chose
 *   { kind: 'bundle', count, paths, omitted }         parts, not a rendering
 *
 * Exported for testing.
 */
export function pickAuditPath(toolName, args = {}) {
  // 1. Tools whose target is not an argument at all.
  const fixed = FIXED_AUDIT_TARGETS[toolName];
  if (fixed) return routerText(fixed);

  // 2. write_bundle carries its real targets inside steps[].
  if (toolName === 'write_bundle') {
    // RECOVERY IS THE HANDLER'S DEFINITION, not "is this truthy". The dispatcher
    // routes on `normalizeRecoverArg`, which reads the strings `"false"`, `"0"`,
    // `"no"` and `"off"` as an ORDINARY bundle — the field is a
    // `boolean|operationId` union and a real MCP client was observed sending the
    // string `"true"`, which is why the normaliser exists. A bare `if
    // (args.recover)` here called those four calls recoveries, so a bundle sent
    // with `recover: "false"` wrote its real steps and was journalled
    // `wiki-meta/write-journal/ (recovery)` — the one tool that writes the most
    // files at once, attributed to a file it did not touch.
    if (isRecoveryCall(args.recover)) return routerText(`${BUNDLE_JOURNAL_DIR}/ (recovery)`);
    const paths = writeTargets(toolName, args, { declares: declaresArg });
    if (!paths.length) return routerText('(unknown)');
    // The parts, unmutilated. The COUNT still comes first in the rendering, and
    // it is still the fact a caller cannot choose — but it is now `count`, a
    // number, and the text `path(s): ` around it is added by `formatAuditLine`
    // after every path has been escaped. `omitted` is carried the same way, so
    // the `(+N not shown)` notice is router text too.
    const head = paths.slice(0, 10).map(String);
    return {
      kind: 'bundle',
      count: paths.length,
      paths: head,
      omitted: paths.length - head.length,
      // The tail is carried so the rendering can DIGEST it. Without that, two
      // bundles differing only past the tenth target produced the same line.
      tail: paths.slice(10).map(String),
    };
  }

  // 3. execute_template writes at `targetPath` ONLY when `createFile` is true.
  //
  // The handler learned that in this same release — it drops a targetPath it
  // cannot canonicalise instead of forwarding it — and the journal did not,
  // because `pickAuditPath` re-reads the ORIGINAL `args`. Measured end to end
  // against the real dispatcher, one `tools/call`:
  //
  //   WIRE body        : {"name":"Templates/t.md","arguments":{}}
  //   JOURNAL appended : [claude-write by roland] … — execute_template
  //                      path="../../../etc/passwd"
  //
  // The journal attributed to the user a write to a path the router had just
  // refused to send anywhere. A record of a write that did not happen is the
  // same defect as a record naming the wrong file; both make the journal
  // unusable for the thing it exists for.
  //
  // `createFile === true`, strictly, because that is the gate the handler and
  // the bridge both use (`body.createFile === true`) — a journal that disagrees
  // with the handler about when a file is written is back where it started.
  //
  // WHAT THIS BRANCH DOES NOT DO — and the previous round's comment claimed it
  // did, which is worse than saying nothing: the handler has NOT canonicalised
  // the value that arrives here. `pickAuditPath` re-reads the ORIGINAL
  // `request.params.arguments`, so `targetPath` is exactly the caller's bytes,
  // never the bridge's. Measured: a call whose target the bridge received as
  // `Sessions/today.md` was journalled `/Sessions//today.md`, the caller's
  // spelling. The journal names the FIELD the write came from, not the byte
  // sequence the bridge resolved; `formatAuditLine` is what makes that safe to
  // print, and `canonicalTargetPath` below is what makes it name the same file.
  //
  // This branch reads three fields without asking `declaresArg`, and that is
  // only sound while `execute_template`'s own schema declares all three — the
  // declared-field rule below exists because `arguments` is an OPEN record at
  // runtime. The dependency is asserted rather than re-implemented here (one
  // mechanism, not two): see the pin in `tests/security-invariants.test.mjs`
  // that fails if the schema stops declaring `createFile`, `targetPath` or
  // `name`.
  //
  // AND THE FALLBACK SAYS SO NOW. `write-targets.mjs` calls it "a display
  // fallback and not a write", and for two rounds that sentence existed only in
  // the docstring: the branch returned `args.name` BARE, so a render-only call
  // produced a line no reader could tell from a real write. Reachable with
  // nothing more than an existing note:
  //
  //   REAL WRITE  : … execute_template path="wiki/private/salaries.md"
  //   RENDER ONLY : … execute_template path="wiki/private/salaries.md"
  //   IDENTICAL   : true
  //
  // Which is exactly what this module forbids thirty lines above — "A record of
  // a write that did not happen is the same defect as a record naming the wrong
  // file". The two cases were distinguishable in the ARGUMENTS all along and the
  // rendering threw the distinction away, so the fix is to carry it: the tag
  // travels to `renderAuditPath`, which appends the disclaimer as ROUTER TEXT,
  // after the name has been escaped. A payload cannot spell the disclaimer (its
  // own parens and commas are already `%28`/`%29`/`%2C` by then), so a hostile
  // `name` cannot dress a real write up as a render, nor the reverse.
  if (toolName === 'execute_template') {
    const [target] = writeTargets(toolName, args, { declares: declaresArg });
    if (target) return canonicalTargetPath(target);
    return typeof args.name === 'string' && args.name
      ? { kind: 'template-only', name: args.name }
      : routerText('(unknown)');
  }

  // 4. Everything else: the first field this tool actually declares.
  const [target] = writeTargets(toolName, args, { declares: declaresArg });
  return target || routerText('(unknown)');
}

/**
 * The path `execute_template` really wrote, spelled the way the BRIDGE spelled
 * it — `Sessions/today.md`, not the caller's `/Sessions//today.md`.
 *
 * Not a security guard: `formatAuditLine` already makes any byte sequence safe
 * to print. This is about the journal naming the same FILE the write hit, which
 * is the property `canonicalVaultPath`'s tab rule exists for ("the journal would
 * name a different file than the one written") and which this branch lacked
 * because it re-reads the original arguments rather than the handler's output.
 *
 * Best-effort by construction: a value the guard refuses is journalled verbatim
 * rather than dropped. Audit never blocks a call, and a refused path that was
 * nonetheless attempted is precisely what a reader wants to see.
 */
function canonicalTargetPath(value) {
  try {
    return guardVaultPath(value, 'targetPath', (m) => new Error(m));
  } catch {
    return value;
  }
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
  // FLATTENED HERE, at the point the line is built.
  //
  // `canonicalVaultPath` grew a CR/LF rule whose stated purpose was to stop
  // exactly this forgery — and it never saw the value that arrives here,
  // because `pickAuditPath` reads `request.params.arguments` directly. The
  // seven write tools were protected only TRANSITIVELY (their own guard on
  // `args.path` throws first), so any tool whose guarded field is not `path`
  // was open. The cleanest carrier was `execute_template.targetPath`, which
  // this same release deliberately stopped validating when `createFile` is
  // false — correct on its own terms, and `pickAuditPath` acts on it anyway.
  //
  // Proven end-to-end against the real dispatcher: one `tools/call` produced
  //
  //   [claude-write by alice] … — execute_template path="ok.md"]
  //   [claude-write by roland] … — delete_file path="wiki/private/salaries.md"
  //
  // a second attribution line naming a different user and a delete that never
  // happened. The audit journal exists to attribute writes; a forgeable
  // attribution is worse than none.
  //
  // Flattening at CONSTRUCTION rather than validating upstream, because this
  // function is the only place that knows the output is line-structured — the
  // same reasoning as `assertDotenvScalar`. An undeclared extra argument can
  // reach `pickAuditPath` too (the SDK validates `arguments` as an open
  // record, never against `inputSchema`), so no amount of per-tool guarding
  // upstream can be complete.
  const safeUser = safeForMessage(userId, 120).replace(/[[\]]/g, '');
  const safeTool = safeForMessage(toolName, 80).replace(/[[\]]/g, '');
  // NOT run through `escapeAuditPart`, and that is a decision rather than an
  // oversight. `toolName` comes from a FIXED vocabulary two doors upstream (the
  // dispatcher rejects an unknown name before this is reached), and the bracket
  // strip on it is a proven no-op across all 15 real names; `userId` is operator
  // config read once at startup, never caller-supplied. Escaping them would be
  // free in effort and not free in effect — it would rewrite the userId of any
  // operator whose id contains a paren, changing how their existing journals
  // grep. Left alone, deliberately, and the strip stays because it is what makes
  // the record marker unspellable from those two fields.
  const safePath = renderAuditPath(auditPath);
  return `\n[claude-write by ${safeUser}] ${ts} — ${safeTool} path="${safePath}"\n`;
}

/** Characters that would let a payload spell this line's structure. */
const AUDIT_ESCAPES = [
  // `%` FIRST, and this is the trap every hand-rolled percent-encoder falls
  // into: escape the brackets before the percent and `wiki/a%5Bb.md` and
  // `wiki/a[b.md` both journal as `wiki/a%5Bb.md` — injectivity lost to the
  // escape mechanism itself. Escaping `%` first is what makes the encoding
  // reversible, and reversible is the whole point.
  [/%/g, '%25'],
  // The LINE's structure: the `path="…"` field and the `[claude-write by …]`
  // record marker. Flattening the newline alone stopped the forged LINE but
  // left a second `[claude-write by roland] … delete_file …` sitting INSIDE the
  // surviving one, so `grep "by roland"` still reported a write that never
  // happened.
  [/"/g, '%22'], [/\[/g, '%5B'], [/\]/g, '%5D'],
  // The PATH FIELD's own structure: `N path(s): `, the `, ` between items and
  // the ` (+N not shown)` notice, all three assembled below out of these three
  // characters. The previous round bought this by MUTILATING them to `;`
  // instead — and mutilation is many-to-one, so `,`, `(`, `)` and `;` fused
  // into a single symbol: 569 collisions over 8 972 distinct canonical paths,
  // against 0 on the `write_file` branch the mutilation never touched. Escaped
  // rather than collapsed, so the payload still cannot spell the structure AND
  // two different files still cannot produce the same line.
  [/,/g, '%2C'], [/\(/g, '%28'], [/\)/g, '%29'],
];

// A part is capped at 400 rendered characters, and 400 is a real bound because
// it is applied AFTER escaping. It used to be applied before, by
// `safeForMessage(auditPath, 400)`, which is not a bound on anything the
// journal writes: escaping runs afterwards and multiplies, so a 408-character
// path reached the file at 1 051 characters. Measured.
const AUDIT_PART_CAP = 400;
const AUDIT_PART_HEAD = 360;

/**
 * Escape ONE caller-supplied part. Injective — that is the whole contract.
 *
 * Order: neutralise (WITHOUT truncating) → escape → truncate. The middle step
 * is why `NO_TRUNCATION` is passed: `sanitizeLabel`'s own notice is bracketed,
 * so letting it fire here delivered `…%5Btruncated by sanitize: original was
 * 608 chars%5D` into the journal — the exact defect the bundle notice was
 * parenthesised to avoid, in the module next door, unnoticed because the two
 * truncations are 300 lines apart.
 *
 * Truncating LAST is also the correct half of the previous round's reasoning,
 * kept: the notice must report a property of the ORIGINAL, never of the escaped
 * form, because escaped length is not an injective function of the input —
 * raw lengths 380 and 382 can escape to the same length and would then be
 * indistinguishable.
 *
 * And the notice carries a DIGEST, because length alone is not enough either.
 * Above the cap the only surviving discriminants were the shared prefix and the
 * original length, so 5 000 distinct paths sharing their first 336 characters
 * and their length collapsed to ONE journal line. Measured.
 *
 * WHAT THE DIGEST IS HASHING, and why it changed. `update(raw, 'utf8')` is not
 * injective over JS strings: an unpaired surrogate has no UTF-8 encoding, so
 * every one of the 2 048 lone surrogates encodes to the SAME three bytes
 * (U+FFFD). Measured on this branch — 64 long paths differing only in their
 * surrogate:
 *
 *   accepted by guard    : 64
 *   distinct audit lines : 1
 *   paths lost           : 63
 *
 * `Buffer.from(raw, 'utf16le')` is a lossless view of the code units, so the
 * digest now distinguishes what the string distinguishes. (The GUARD refuses
 * unpaired surrogates outright — see `vault-path-guard`, which is what fixes the
 * short-path case where no digest is involved at all. This half exists because
 * `escapeAuditPart` also renders values that never meet the guard.)
 *
 * AND THE CLAIM IS "COLLISION-RESISTANT", NOT "INJECTIVE". Three rounds asserted
 * that this function is bounded AND injective. It cannot be both: the output is
 * capped at ~440 characters and the input is unbounded, so by pigeonhole some
 * pair must collide. What is achievable — and what is now claimed — is that no
 * pair can be FOUND: 128 bits of sha256 (32 hex chars, widened from 64 bits),
 * over a lossless encoding, alongside the 360-character prefix and the exact
 * original length. Below the cap the escaping really is injective, and that is
 * stated separately because it is a different, stronger property.
 */
function escapeAuditPart(value) {
  const raw = String(value);
  let clean = safeForMessage(raw, NO_TRUNCATION);
  for (const [re, to] of AUDIT_ESCAPES) clean = clean.replace(re, to);
  if (clean.length <= AUDIT_PART_CAP) return clean;
  // Never cut between a surrogate pair — half a pair is a lone surrogate, which
  // survives here as an unpaired code unit and reaches the journal as U+FFFD.
  let head = AUDIT_PART_HEAD;
  const c = clean.charCodeAt(head - 1);
  if (c >= 0xd800 && c <= 0xdbff) head -= 1;
  const tag = auditDigest(raw);
  // Parenthesised, not bracketed, and safe either way: this text is appended
  // AFTER the escaping above, so no payload can spell it.
  return `${clean.slice(0, head)}…(truncated ${raw.length} chars, sha256:${tag})`;
}

/**
 * The ONE digest used by the audit line — 128 bits over a LOSSLESS encoding.
 *
 * Two call sites had grown the same `createHash('sha256').update(x, 'utf8')
 * .digest('hex').slice(0, 16)` expression independently, and both carried the
 * same two defects: `utf8` is lossy over lone surrogates (2 048 code units, one
 * encoding) and 64 bits is a weak claim to hang "cannot be made to collide" on.
 * Fixing one and not the other is how this repo's recurring failure looks, so
 * the expression moved here.
 */
function auditDigest(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf16le')).digest('hex').slice(0, 32);
}

/**
 * Router text may be printed verbatim only while it cannot spell the structure.
 * A future constant carrying a quote, a bracket or a percent degrades to
 * escaping rather than opening a hole.
 *
 * THE COMMENT USED TO CLAIM MORE THAN THE REGEX DELIVERED — "removes the need to
 * trust every future edit to `FIXED_AUDIT_TARGETS`" — while the class allowed
 * digits, commas, colons and parentheses, i.e. every character of
 * `3 path(s): a.md, b.md`. No shipped constant spells that; the point is that
 * the check was the reason nobody had to verify that, and it was not checking.
 *
 * `,` and `:` are excluded, and those two are enough to make EVERY structural
 * token unspellable, because each one needs at least one of them:
 *
 *   N path(s):                  needs `:`
 *   `, ` between bundle items   needs `,`
 *   (+N not shown, sha256:…)    needs both
 *   …(truncated N chars, sha…)  needs both
 *   (template rendered, …)      needs `,`
 *   path="                      needs `"`   (already excluded)
 *   [claude-write by            needs `[`   (already excluded)
 *
 * Parentheses and digits stay LEGAL on purpose: three of the six shipped
 * constants need them (`(unknown)`, `wiki/index.md (okf projections)`,
 * `wiki-meta/write-journal/ (recovery)`), and excluding them would push those
 * three through `escapeAuditPart` — turning the fleet's most common journal
 * lines into `%28unknown%29`. Pinned in `tests/security-invariants.test.mjs`
 * from both ends: every shipped constant must pass, and every structural token
 * must fail.
 */
const ROUTER_TEXT_SAFE = /^[^%"[\],:\r\n]*$/;

/**
 * ONE CONSTRUCTION, and this is the fix for the conflict that three rounds
 * could not settle by fixing one line at a time.
 *
 * The audit line has to be unforgeable (no character of the payload may spell
 * the structure) and injective (two files, two lines). The previous round got
 * the first by mutilating and the second by escaping, in two functions thirty
 * lines apart, and mutilation destroys injectivity. Here every caller-derived
 * part is escaped FIRST and the structure — the separators, the parentheses,
 * the words `path(s):`, the `(+N not shown)` notice — is router text added
 * AFTERWARDS. A payload cannot spell any of it, because everything it contains
 * has already been escaped; and nothing is mutilated, so the distinctions that
 * come in survive.
 *
 * SAY THE PROPERTY CORRECTLY. Three rounds claimed this line is "bounded AND
 * injective". That is not a hard property, it is an impossible one: the line is
 * capped at ~440 characters per part and the input is unbounded, so a colliding
 * pair must exist by pigeonhole. Two claims replace it, and they are separately
 * true:
 *
 *   - BELOW the cap the rendering IS injective — every escape is reversible
 *     (`%` first) and nothing is collapsed;
 *   - ABOVE it, COLLISION-RESISTANT — a 128-bit sha256 over a lossless
 *     (`utf16le`) encoding, plus the 360-character prefix and the exact original
 *     length.
 *
 * The distinction is not pedantry. It is what tells a reader that finding a
 * collision means breaking sha256, rather than that none exists — and the
 * version of the claim that could not be true is the version nobody could test.
 * The inputs' OWN distinctness is `canonicalVaultPath`'s job, not this
 * function's: `safeForMessage` runs first and is many-to-one by design (U+2028
 * → `\n` → space), so a field that skips the guard must ask `isAuditStable`.
 */
function renderAuditPath(auditPath) {
  if (auditPath && typeof auditPath === 'object') {
    if (auditPath.kind === 'router') {
      return ROUTER_TEXT_SAFE.test(auditPath.text)
        ? auditPath.text
        : escapeAuditPart(auditPath.text);
    }
    if (auditPath.kind === 'bundle') {
      const shown = auditPath.paths.map(escapeAuditPart).join(', ');
      // THE OMITTED TAIL GETS A DIGEST, for the same reason the truncation
      // notice does — and this hole was found by the pin that closed that one,
      // not before it. Only the first ten paths are shown, so two twelve-step
      // bundles differing ONLY in their eleventh and twelfth targets rendered
      // byte-identical lines: same count, same ten names, same `(+2 not
      // shown)`. Measured:
      //
      //   12 path(s): wiki/p0.md, … wiki/p9.md (+2 not shown)
      //   12 path(s): wiki/p0.md, … wiki/p9.md (+2 not shown)   identical
      //
      // and the second bundle had written `wiki/DIFFERENT.md`. Hashing the
      // JSON of the omitted tail rather than a joined string because joining is
      // ambiguous: `['a\0b']` and `['a','b']` share a NUL-joined form, and the
      // whole point of the digest is that it cannot be made to collide.
      let omitted = '';
      if (auditPath.omitted > 0) {
        const tail = auditPath.tail || [];
        omitted = ` (+${auditPath.omitted} not shown, sha256:${auditDigest(JSON.stringify(tail))})`;
      }
      // The COUNT leads, before any payload — the one structural fact in the
      // line that the caller does not choose.
      return `${auditPath.count} path(s): ${shown}${omitted}`;
    }
    // A RENDER THAT WROTE NOTHING, said out loud. The name is the TEMPLATE's
    // path, not a target — `execute_template` with `createFile` unset writes no
    // file at all. Escaped first, disclaimer appended after, so the suffix is
    // router text a payload cannot forge: its own `(`, `)` and `,` are already
    // `%28`, `%29` and `%2C` by the time this concatenates.
    if (auditPath.kind === 'template-only') {
      return `${escapeAuditPart(auditPath.name)} (template rendered, nothing written)`;
    }
  }
  return escapeAuditPart(auditPath);
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
  // The first-contact conformance gate. Built here because it is off on a
  // read-only deployment (it repairs, and repairing writes).
  const conformanceGate = makeConformanceGate({ readonly });
  if (!conformanceGate) {
    console.error(
      '[obsidian-mcp-router] first-contact vault conformance is OFF ' +
        (readonly ? '(read-only mode).' : '(OBSIDIAN_ROUTER_NO_AUTO_CONFORMANCE).'),
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

  /**
   * Fire the first-contact repair for whatever vault this call names.
   *
   * `blocking: false` (the default) means fire-and-forget — the caller is not
   * delayed and the repair lands for the NEXT call on that vault. `blocking:
   * true` awaits it, which only `search_smart` does.
   *
   * Never throws: an unresolvable vault (`vault: "*"` fan-out, an unknown name)
   * is not this feature's problem, and conformance upkeep must not be able to
   * turn a working tool call into a failing one.
   */
  async function noteVaultContact(reg, name, args, { blocking = false } = {}) {
    if (!conformanceGate || !CONFORMANCE_TRIGGER_TOOLS.has(name)) return;
    let target;
    try {
      target = reg.resolveVault(args.vault);
    } catch {
      return; // `*` fan-out, unknown vault, empty registry
    }
    const pass = Promise.resolve(conformanceGate.ensure(target)).catch(() => null);
    if (blocking) await pass;
  }

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

      // FIRST CONTACT, BLOCKING BRANCH. `search_smart` is the one call that must
      // not run before the repair: on a vault without Smart Connections and
      // without a BM25 index it has no tier at all, so a post-call repair would
      // leave the session's first semantic search failing — the very symptom
      // this feature exists to remove.
      if (CONFORMANCE_BLOCKING_TOOLS.has(name)) {
        await noteVaultContact(reg, name, args, { blocking: true });
      }

      const result = await handler(reg, args);

      // `list_vaults` IS the session health check, and it is the one tool that
      // names no vault — so it gets its own rule rather than the schema-derived
      // one. Two constraints shape it:
      //
      //   - it must stay FAST. Every session's startup hooks call it, and a
      //     blocking repair here would tax every session start.
      //   - it must not repair a vault it has just MEASURED as offline. The ping
      //     result is right there in the response; launching a full enumerate →
      //     read → write cycle at a vault that just failed to answer buys
      //     nothing but a guaranteed failed pass (and, with the retry budget,
      //     spends one of the session's three attempts on it).
      if (conformanceGate && name === 'list_vaults' && result && typeof result === 'object') {
        const def = result.defaultVaultStatus;
        if (def && def.online === true) {
          try {
            void Promise.resolve(conformanceGate.ensure(reg.resolveVault(def.name))).catch(() => {});
          } catch { /* the default vault vanished between ping and resolve */ }
        }
      }

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

      // FIRST CONTACT — verify and repair this vault's derived artefacts, once
      // per session. AFTER the handler and NOT awaited for every tool but
      // `search_smart`: a full corpus scan in front of the session's first
      // `get_file` would tax every session start to save one call's worth of
      // degradation. The consequence is stated rather than hidden — for those
      // tools the repair lands for the SECOND call on that vault.
      void noteVaultContact(reg, name, args);

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
          // SANITISE HERE, not in the tool. This block runs AFTER the tool has
          // already sanitized its own result, and it assigns a `viewLink` whose
          // URL comes from an external view-agent over HTTP. A reviewer walked a
          // forged `<result>` wrapper and a live ESC through this assignment
          // into an otherwise-clean response — the per-tool rule cannot reach
          // it, because the field does not exist when the tool returns.
          //
          // The lesson generalises past this line: "every tool sanitizes" is a
          // statement about tools, and anything the dispatcher ADDS afterwards
          // is outside it. This is the only such site today; a second one would
          // need the same treatment, or the rule needs to move down here.
          Object.assign(result, sanitizeResponse(await viewLinkForWrite({ vaultName: result.vault, note })));
        }
      }

      return await wrapResult(Promise.resolve(result));
    } catch (err) {
      // FIRST CONTACT ON THE FAILURE PATH TOO — and this branch is the whole
      // point, not a completeness flourish.
      //
      // The founding incident is a `search_smart` that FAILS because the vault
      // has no search index. Triggering the repair only on success means the one
      // call that proves the vault needs repairing is the one call that never
      // asks for it: every subsequent attempt fails identically, forever. A
      // feature built to end that loop would have re-created it.
      //
      // Wrapped so a repair problem can never replace the error the user is
      // actually being shown.
      try {
        void noteVaultContact(registryRef.current, name, args);
      } catch { /* never let upkeep rewrite the user's error */ }

      // THE ERROR CHANNEL, SANITISED ONCE, HERE.
      //
      // This is the only place every thrown error passes through, and for five
      // rounds it was the one place nobody looked. The release fixed error
      // echoes in `heading-patch`, in `graph-neighbors`, in the digest warning,
      // in `parseJournal`, in `build-open-link`, and in `RestApiError`'s
      // constructor — six sites, one at a time, each found by a reviewer — while
      // `Error: ${err.message}` right here rendered ANY other throw verbatim.
      //
      // What that cost, measured: the sentence "…is version X; this router
      // speaks version Y" exists THREE times in the tree and the release
      // sanitised ONE of them. The other two parse a file out of the vault
      // (`wiki-meta/source-ledger.json`, `wiki-meta/search-index.json`) and
      // interpolate its `version` field raw — reachable through `audit_sources`
      // and `search_smart`, both deliberately READ-ONLY tools, so a hardened
      // `OBSIDIAN_ROUTER_READONLY` deployment was fully exposed. Plus
      // `search_smart`'s tier echo, `delete_file`'s confirm prompt, and every
      // unknown-tool name.
      //
      // Sanitising per-site is not a strategy, it is a subscription: every new
      // throw is a new hole and the guard can only ever name the sites someone
      // already thought of. One choke point, no exceptions.
      //
      // `hint` and `kind` get the same treatment — a reviewer could not make
      // `hint` carry a payload today, but "I could not reach it" is a fact
      // about today's call sites, not a property of the channel.
      const { errorCategory, isRetryable } = classifyError(err);
      const lines = [`Error: ${safeForMessage(err.message, 2000)}`];
      if (err.kind) lines.push(`Kind: ${safeForMessage(err.kind, 80)}`);
      if (err.hint) lines.push(`Hint: ${safeForMessage(err.hint, 500)}`);
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
          // Normalized like the readable `Kind:` line above. Every `kind` in
          // the tree is fixed vocabulary today — and "today" is a fact about
          // the current call sites, not a property of the channel.
          kind: safeForMessage(err.kind || 'unknown', 80),
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

/**
 * Sanitize an MCP content payload BLOCK-AWARE: text blocks get neutralized,
 * binary `data` (base64 images) is never touched.
 *
 * The old passthrough was correct about the images and wrong about everything
 * else — it skipped normalization for the WHOLE payload, which is how
 * `pdf_to_images` shipped a summary splicing in a tool argument, invisible to a
 * guard that only ever looked at tool modules.
 */
function sanitizeContentBlocks(payload) {
  return {
    ...payload,
    content: payload.content.map((block) => {
      // EVERY FIELD BUT THE BYTES. The first version normalized `text` and
      // returned the block untouched otherwise — so `_meta`, `annotations`,
      // `mimeType` and any field a future MCP revision adds rode through raw.
      // No shipped tool carries untrusted data in them, which is exactly the
      // sentence that was true about the error channel for thirteen rounds.
      const { data, ...rest } = block;
      const safe = sanitizeResponse(rest, { maxLen: NO_TRUNCATION });
      // `data` is base64 — no `<` to neutralize, and no cap may touch it.
      // Excluded BY NAME rather than by type, so a future non-string field
      // cannot inherit the exemption by accident.
      return data === undefined ? safe : { ...safe, data };
    }),
  };
}

/**
 * THE WIRE BOUNDARY. Everything the model receives passes through here, and
 * this is the only place it is normalized.
 *
 * Why here and not in each tool — three defects, all from putting it in the
 * tools:
 *
 *   1. IT BROKE A FEATURE. The dispatcher reads `result.path` to build the
 *      view-link. With the tool sanitizing first, a legitimate POSIX filename
 *      `wiki/<result>.md` became `wiki/&lt;result>.md` and the link pointed at a
 *      note that does not exist. Sanitizing an IDENTITY that later code still
 *      has to use is simply wrong, and no amount of care in the tools fixes it —
 *      only doing it last does.
 *   2. IT COULD NEVER BE COMPLETE. 22 of 36 tools opted out; two more were
 *      missed because their module merely MENTIONED a sanitizer; each new tool
 *      is a new chance to forget. The guard could only ever name the sites
 *      someone had already thought of.
 *   3. IT SPRAYED SIZE POLICY EVERYWHERE. Nineteen call sites had to remember
 *      `{ maxLen: NO_TRUNCATION }`, sixteen of them unpinned, and forgetting it
 *      silently truncated a 100 KB note to 16 KB. Here there is one answer:
 *      NO_TRUNCATION. Bounding size is the job of whatever produced the bytes —
 *      the subprocess `maxBuffer`, the REST layer — not of the sanitizer, which
 *      cannot know what it is looking at.
 *
 * Ordering matters and is the whole point: the view-link block and the audit
 * journal above run on the RAW result, then this runs last.
 */
async function wrapResult(promise) {
  const raw = await promise;
  // Decide BEFORE walking: a typed payload gets the block-aware treatment, so
  // megabytes of base64 are never copied through the generic object rebuild.
  if (isMcpContentPayload(raw)) return sanitizeContentBlocks(raw);
  // Image-returning tools (currently only `pdf_to_images`) return a finished
  // MCP content payload — `{ content: [{type:'text',…}, {type:'image', data,
  // mimeType}, …] }` — handled above. It must NOT come down here: the generic
  // stringify would fold the whole object, base64 included, into one text
  // block and destroy the typed image blocks the client needs to render.
  const result = sanitizeResponse(raw, { maxLen: NO_TRUNCATION });
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
  // v0.71.0 — the wire boundary. Exposed so a test can prove the ONE place
  // normalization happens actually normalizes, instead of re-implementing it.
  wrapResult,
  sanitizeContentBlocks,
  // v0.71.0 — the router-text trust class. Exposed because ONE of its members is
  // not observable through the rendering: `escapeAuditPart` has no escape for
  // `:`, so a colon that correctly falls out of the trusted class renders
  // identically either way. A test that could only see the rendering therefore
  // proved seven of the eight members and silently skipped the eighth — and the
  // eighth is the one that makes `path(s): ` unspellable.
  ROUTER_TEXT_SAFE,
};
