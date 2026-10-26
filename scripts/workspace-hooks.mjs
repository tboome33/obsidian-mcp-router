#!/usr/bin/env node
/**
 * workspace-hooks.mjs — reads and changes which opt-in hooks run in a
 * workspace. The vault panel's administration console calls it (a hooks
 * module has no Node of its own); it prints one JSON object on stdout.
 *
 * Usage:
 *   node scripts/workspace-hooks.mjs status --workspace <dir>
 *   node scripts/workspace-hooks.mjs set --workspace <dir> --hook <name> --on|--off
 *
 * `status` answers:
 *   { workspace, file, alwaysOn: [name…],
 *     optIn: [{ name, enabled, global }…] }
 * where `global` says the hook is still wired machine-wide in
 * ~/.claude/settings.json: it runs in every workspace whatever is chosen here
 * (`setup-vault.mjs --uninstall-hooks` takes those entries out).
 *
 * `set` writes the choice and answers the new status. Exit 1, with
 * `{ error }`, on a bad call.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALWAYS_ON_HOOKS,
  OPT_IN_HOOKS,
  enabledHooks,
  globallyWiredHooks,
  readState,
  readUserSettings,
  withHook,
  workspaceHooksPath,
  writeState,
} from '../src/helpers/workspace-hooks.mjs';

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
}

export function status(workspace, file = workspaceHooksPath(), settings = readUserSettings()) {
  const enabled = enabledHooks(readState(file), workspace);
  const global = globallyWiredHooks(settings);

  return {
    workspace,
    file,
    alwaysOn: [...ALWAYS_ON_HOOKS],
    optIn: OPT_IN_HOOKS.map((name) => ({ name, enabled: enabled.includes(name), global: global.includes(name) })),
  };
}

export function run(args, file = workspaceHooksPath(), settings = readUserSettings()) {
  const [command] = args;
  const workspace = option(args, '--workspace');
  if (!workspace) {
    throw new Error('--workspace <dir> is required');
  }
  if (command === 'status') {
    return status(workspace, file, settings);
  }
  if (command === 'set') {
    const hook = option(args, '--hook');
    const isOn = args.includes('--on');
    if (!hook || isOn === args.includes('--off')) {
      throw new Error('set needs --hook <name> and exactly one of --on, --off');
    }
    writeState(withHook(readState(file), workspace, hook, isOn), file);

    return status(workspace, file, settings);
  }
  throw new Error(`unknown command: ${command ?? '(none)'}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exit(1);
  }
}
