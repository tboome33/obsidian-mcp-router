/**
 * workspace-hooks.mjs — which of the router's opt-in hooks run in WHICH
 * workspace, and the one place that answers it.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 * ---------------------------------------------------------------------------
 * Two families of hooks:
 *
 *   - ALWAYS ON — the three read-only hooks the plugin activates for everyone
 *     (hooks/hooks.json): they read, never write, never block, never call the
 *     network, and are silent without a vault.
 *   - OPT-IN — everything else: they commit to git, write session transcripts
 *     into a vault, block a turn, or call the network. Each one is declared in
 *     hooks/hooks.json too, but behind hooks/opt-in-gate.mjs, which runs it
 *     only in a workspace whose owner switched it on from the vault panel's
 *     administration console. Off is the default, everywhere.
 *
 * Before this, the opt-in hooks were wired once, machine-wide, into
 * ~/.claude/settings.json (by a vault's bootstrap, or `--install-hooks`), so a
 * hook wanted in one project ran in every project. Entries left there still
 * run — the gate steps aside for a hook wired there, so nothing fires twice —
 * and `setup-vault.mjs --uninstall-hooks` takes them out.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CHOICE LIVES
 * ---------------------------------------------------------------------------
 * In `workspace-hooks.json`, beside the router's config — the user's own
 * file, never a file of the repository: a cloned project must not be able to
 * switch on a hook that commits or blocks. Keyed by the canonical workspace
 * path (`normalizePathForCompare`, the registry's own normalisation), like the
 * workspace bindings.
 *
 * Node builtins plus one pure local helper: the gate loads this on every
 * event it is declared for, so it stays small.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizePathForCompare } from './vault-path-identity.mjs';

/** The read-only hooks the plugin runs everywhere (hooks/hooks.json). */
export const ALWAYS_ON_HOOKS = Object.freeze(['hot-cache-load', 'workspace-briefing', 'decisions-recall']);

/** The hooks a workspace switches on from the console, in the console's order. */
export const OPT_IN_HOOKS = Object.freeze([
  'wiki-query-first-nudge',
  'session-auto-journal',
  'wiki-autocommit',
  'vault-link-linter',
  'hot-cache-update-prompt',
  'doc-propagation-checker',
  'vault-doc-startup-check',
  'check-router-update',
]);

const FILE_VERSION = 1;

/**
 * The router config's path: OBSIDIAN_ROUTER_CONFIG, else
 * `~/.claude/obsidian-mcp-router/config.json`. hooks/_helpers/workspace-vault.mjs
 * answers the same question through this function.
 */
export function routerConfigPath(env = process.env) {
  if (env.OBSIDIAN_ROUTER_CONFIG) {
    return path.resolve(env.OBSIDIAN_ROUTER_CONFIG);
  }
  return path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
}

/** The per-workspace choices: beside the router's config. */
export function workspaceHooksPath(env = process.env) {
  return path.join(path.dirname(routerConfigPath(env)), 'workspace-hooks.json');
}

/** Claude Code's user settings, where `--install-hooks` wires hooks machine-wide. */
export function userSettingsPath(home = os.homedir()) {
  return path.join(home, '.claude', 'settings.json');
}

export const workspaceKey = (workspace) => normalizePathForCompare(path.resolve(String(workspace)));

/** An empty state, or the file's, keeping only what this version understands. */
export function parseState(raw) {
  const empty = { version: FILE_VERSION, workspaces: {} };
  if (!raw || typeof raw !== 'object' || !raw.workspaces || typeof raw.workspaces !== 'object') {
    return empty;
  }
  const workspaces = {};
  for (const [key, entry] of Object.entries(raw.workspaces)) {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks.filter((h) => OPT_IN_HOOKS.includes(h)) : [];
    workspaces[key] = { path: typeof entry?.path === 'string' ? entry.path : key, hooks: [...new Set(hooks)] };
  }
  return { version: FILE_VERSION, workspaces };
}

/** The opt-in hooks switched on for `workspace`, in catalogue order. */
export function enabledHooks(state, workspace) {
  const key = workspaceKey(workspace);
  const found = new Set();
  // Every spelling that folds to this workspace counts: a file edited by hand
  // may hold a key the console would have normalised.
  for (const [k, entry] of Object.entries(state.workspaces)) {
    if (workspaceKey(k) === key) {
      for (const h of entry.hooks) found.add(h);
    }
  }
  return OPT_IN_HOOKS.filter((h) => found.has(h));
}

/** `state` with `name` switched on or off for `workspace`; throws on an unknown hook. */
export function withHook(state, workspace, name, isOn) {
  if (!OPT_IN_HOOKS.includes(name)) {
    throw new Error(`unknown opt-in hook: ${name}`);
  }
  return withHooks(state, workspace, (current) => (isOn ? [...current, name] : current.filter((h) => h !== name)));
}

/** `state` with `workspace`'s list replaced by `change(current)`; other spellings folded into one. */
export function withHooks(state, workspace, change) {
  const key = workspaceKey(workspace);
  const current = enabledHooks(state, workspace);
  const next = OPT_IN_HOOKS.filter((h) => change(current).includes(h));
  const workspaces = Object.fromEntries(
    Object.entries(state.workspaces).filter(([k]) => workspaceKey(k) !== key),
  );
  if (next.length > 0) {
    workspaces[key] = { path: path.resolve(String(workspace)), hooks: next };
  }
  return { version: FILE_VERSION, workspaces };
}

export function readState(file = workspaceHooksPath()) {
  try {
    return parseState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return parseState(null);
  }
}

/** Written whole through a temporary file: a reader never sees half a file. */
export function writeState(state, file = workspaceHooksPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// A settings command that runs one of the router's hook files directly (not
// through the gate): `.../hooks/<name>.mjs`, quoted or not, either separator.
const DIRECT = /[\\/]hooks[\\/]([a-z0-9-]+)\.mjs\b/;

function commandHook(command) {
  if (typeof command !== 'string' || command.includes('opt-in-gate.mjs')) {
    return null;
  }
  const m = command.replace(/["']/g, '').match(DIRECT);
  return m && OPT_IN_HOOKS.includes(m[1]) ? m[1] : null;
}

/** The opt-in hooks a settings object wires directly, machine-wide. */
export function globallyWiredHooks(settings) {
  const found = new Set();
  for (const blocks of Object.values(settings?.hooks ?? {})) {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      for (const entry of Array.isArray(block?.hooks) ? block.hooks : []) {
        const name = commandHook(entry?.command);
        if (name) found.add(name);
      }
    }
  }
  return OPT_IN_HOOKS.filter((h) => found.has(h));
}

export function readUserSettings(file = userSettingsPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
