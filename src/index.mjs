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

import { loadRegistry } from './registry.mjs';
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

const TOOLS = [
  {
    name: 'list_vaults',
    description:
      'List all configured Obsidian vaults (local and remote) with their online status, latency, and metadata. Always call this first to discover which vaults are available.',
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
      'Semantic (meaning-based) search using Smart Connections embeddings. Returns ranked chunks with cosine similarity scores and breadcrumbs (heading path). Requires the target vault to have both the "mcp-tools" and "smart-connections" community plugins installed and enabled. Pass vault: "*" to fan-out across every vault.',
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
];

export async function startServer() {
  const registry = await loadRegistry();

  const server = new Server(
    {
      name: 'obsidian-mcp-router',
      version: '0.3.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case 'list_vaults':
          return await wrapResult(listVaults(registry));
        case 'list_files':
          return await wrapResult(listFiles(registry, args));
        case 'get_file':
          return await wrapResult(getFile(registry, args));
        case 'search':
          return await wrapResult(search(registry, args));
        case 'search_smart':
          return await wrapResult(searchSmartTool(registry, args));
        case 'write_file':
          return await wrapResult(writeFileTool(registry, args));
        case 'append_to_file':
          return await wrapResult(appendToFileTool(registry, args));
        case 'delete_file':
          return await wrapResult(deleteFileTool(registry, args));
        case 'patch_file':
          return await wrapResult(patchFileTool(registry, args));
        case 'execute_template':
          return await wrapResult(executeTemplateTool(registry, args));
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't pollute the stdio MCP channel
  console.error(
    `[obsidian-mcp-router] Ready. ${registry.vaults.length} vault(s) configured: ${registry.vaults
      .map((v) => v.name)
      .join(', ')}`,
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
