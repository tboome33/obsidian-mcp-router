/**
 * tool-names.mjs — recognise the router's MCP write tools whatever prefix
 * the host happens to give them.
 *
 * The same tool reaches a hook under at least three different names,
 * because the prefix is imposed by how the server was REGISTERED, not by
 * the server (which only ever declares bare names like `write_file`):
 *
 *   mcp__obsidian-router__write_file                      direct registration
 *                                                         (~/.claude.json, .mcpb)
 *   mcp__plugin_obsidian-router_router__write_file        provided by the plugin
 *                                                         (inline mcpServers in
 *                                                         .claude-plugin/plugin.json, Lot 5)
 *   mcp__<id>__obsidian-router-<vault>-write_file         behind MCPHub
 *
 * Matching the literal `mcp__obsidian-router__` prefix — which is what the
 * hooks did before Lot 5 — silently drops the other two. Silently, because
 * a hook that never fires looks exactly like a hook with nothing to do.
 *
 * So we match by SUFFIX, the way `src/helpers/hot-staleness.mjs` already
 * does (and which `tests/hot-cache-guard.test.mjs` already proves tolerates
 * a foreign prefix). This helper exists so the three remaining sites share
 * one rule instead of three hand-rolled ones.
 *
 * PRECISION NOTE: a suffix rule also matches an unrelated server's
 * `write_file`. That is deliberate and safe here, because every caller
 * uses this only to answer "did a vault write just happen?" — the decision
 * to *act* on it is gated separately, on the workspace actually being bound
 * to a configured vault. Never use this helper as an authorisation check.
 *
 * Zero dependencies: node builtins are not even needed.
 */

/** Bare router tool names that denote a vault mutation. */
export const ROUTER_WRITE_TOOLS = [
  'write_file',
  'patch_file',
  'append_to_file',
  'set_frontmatter',
  'merge_frontmatter',
  'delete_file',
  'move_file',
  'execute_template',
];

/** Built-in (non-MCP) tools that write to the filesystem. */
export const BUILTIN_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// `(?:^|[_-])` is what makes every prefix form work: the character just
// before the bare name is `_` in the direct and plugin forms and `-` in the
// MCPHub form. Anchored at the end so `write_file_backup` never matches.
const ROUTER_WRITE_RE = new RegExp(`(?:^|[_-])(${ROUTER_WRITE_TOOLS.join('|')})$`);

/**
 * The bare router tool name behind a possibly-prefixed name, or null.
 * `mcp__plugin_obsidian-router_router__patch_file` → `patch_file`.
 */
export function routerWriteToolName(toolName) {
  if (!toolName || typeof toolName !== 'string') return null;
  if (!toolName.startsWith('mcp__')) return null;
  const m = ROUTER_WRITE_RE.exec(toolName);
  return m ? m[1] : null;
}

/** True for a router MCP write tool under any registration prefix. */
export function isRouterWriteTool(toolName) {
  return routerWriteToolName(toolName) !== null;
}

/**
 * True for anything the session journal logs: the built-in writers, Bash,
 * and the router's MCP write tools under any prefix.
 */
export function isLoggedTool(toolName) {
  if (!toolName || typeof toolName !== 'string') return false;
  if (BUILTIN_WRITE_TOOLS.has(toolName) || toolName === 'Bash') return true;
  return isRouterWriteTool(toolName);
}

/**
 * A PostToolUse `matcher` regex string covering the router write tools
 * under every prefix form. Kept next to the rule it mirrors so the two
 * cannot drift; `hooks/hooks.example.json` embeds the same pattern, and
 * `tests/lot5-plugin-server.test.mjs` asserts they agree.
 */
export const ROUTER_WRITE_MATCHER = `mcp__.*(?:${ROUTER_WRITE_TOOLS.join('|')})$`;
