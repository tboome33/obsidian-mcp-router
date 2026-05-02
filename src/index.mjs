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
      version: '0.2.0',
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
