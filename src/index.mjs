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
];

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

export async function startServer({ configPath, watch = true } = {}) {
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
      version: '0.8.2',
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
      const reg = registryRef.current;
      switch (name) {
        case 'list_vaults':
          return await wrapResult(listVaults(reg));
        case 'list_files':
          return await wrapResult(listFiles(reg, args));
        case 'get_file':
          return await wrapResult(getFile(reg, args));
        case 'search':
          return await wrapResult(search(reg, args));
        case 'search_smart':
          return await wrapResult(searchSmartTool(reg, args));
        case 'write_file':
          return await wrapResult(writeFileTool(reg, args));
        case 'append_to_file':
          return await wrapResult(appendToFileTool(reg, args));
        case 'delete_file':
          return await wrapResult(deleteFileTool(reg, args));
        case 'patch_file':
          return await wrapResult(patchFileTool(reg, args));
        case 'execute_template':
          return await wrapResult(executeTemplateTool(reg, args));
        case 'move_file':
          return await wrapResult(moveFileTool(reg, args));
        case 'get_frontmatter':
          return await wrapResult(getFrontmatterTool(reg, args));
        case 'set_frontmatter':
          return await wrapResult(setFrontmatterTool(reg, args));
        case 'merge_frontmatter':
          return await wrapResult(mergeFrontmatterTool(reg, args));
        case 'lock_vault':
          return await wrapResult(lockVault(reg, args));
        case 'unlock_vaults':
          return await wrapResult(unlockVaults(reg, args));
        case 'set_auto_enrich_mode':
          return await wrapResult(setAutoEnrichMode(reg, args));
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
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
