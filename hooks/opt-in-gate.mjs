#!/usr/bin/env node
/**
 * opt-in-gate.mjs <hook> — runs one of the router's opt-in hooks, but only in
 * a workspace that switched it on (the vault panel's administration console,
 * stored in workspace-hooks.json beside the router's config).
 *
 * hooks/hooks.json declares every opt-in hook through this gate, so the
 * plugin's admission rule still holds: with nothing switched on, the gate is
 * read-only, makes no network call, prints nothing and exits 0 — the hook
 * behind it never starts.
 *
 * Two more ways it stays out of the way:
 *   - a hook still wired directly in ~/.claude/settings.json (the older,
 *     machine-wide `--install-hooks`) runs from there: the gate steps aside
 *     rather than fire it twice;
 *   - any failure of its own (an unreadable file, an unknown name) is a
 *     silent exit 0, never a blocked turn.
 *
 * Switched on, the hook runs as a child with this process's stdin, stdout and
 * stderr, and its exit code is the gate's: exit 2 still blocks, its JSON
 * output still reaches Claude Code.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OPT_IN_HOOKS,
  enabledHooks,
  globallyWiredHooks,
  readState,
  readUserSettings,
} from '../src/helpers/workspace-hooks.mjs';

function main() {
  const name = process.argv[2];
  if (!OPT_IN_HOOKS.includes(name)) {
    return 0;
  }
  const workspace = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!enabledHooks(readState(), workspace).includes(name)) {
    return 0;
  }
  if (globallyWiredHooks(readUserSettings()).includes(name)) {
    return 0;
  }
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), `${name}.mjs`);
  const ran = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });

  return typeof ran.status === 'number' ? ran.status : 0;
}

let code = 0;
try {
  code = main();
} catch {
  code = 0;
}
process.exit(code);
