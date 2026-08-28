/**
 * fake-mcp-stdio-server — a minimal stateful MCP server over stdio, used by
 * tests/serve-http.test.mjs as the per-session CHILD instead of the real
 * router (fast, hermetic, no vault access).
 *
 * Three tools, chosen to make the proxy's guarantees observable:
 *   - set_state {value}  — writes process-local state
 *   - get_state          — reads it back ("null" when untouched): if two MCP
 *                          sessions see each other's state, isolation is broken
 *   - pid                — this process's pid, so tests can verify the child
 *                          is actually killed on DELETE / idle reap
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

let state = null;

const server = new Server(
  { name: 'fake-mcp-child', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'set_state',
      description: 'Store a value in this process.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
    {
      name: 'get_state',
      description: 'Read the stored value back ("null" when untouched).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'pid',
      description: 'Return this process pid.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'set_state') {
    state = String(args?.value ?? '');
    return { content: [{ type: 'text', text: 'ok' }] };
  }
  if (name === 'get_state') {
    return { content: [{ type: 'text', text: String(state) }] };
  }
  if (name === 'pid') {
    return { content: [{ type: 'text', text: String(process.pid) }] };
  }
  throw new Error(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
