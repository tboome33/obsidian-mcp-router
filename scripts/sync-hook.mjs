#!/usr/bin/env node
/**
 * sync-hook.mjs
 *
 * Claude Code SessionStart hook. Reads JSON event payload from stdin to find
 * the project cwd, then runs setup-vault.mjs --sync-plugins --quiet against it.
 *
 * Silent unless something changed (a new plugin was synced from .template).
 * Exits 0 in all cases so it never blocks Claude Code startup.
 *
 * Wire it up in ~/.claude/settings.json:
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [{
 *         "type": "command",
 *         "command": "node \"<absolute-path-to>/scripts/sync-hook.mjs\""
 *       }]
 *     }
 *   }
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const setupScript = resolve(__dirname, 'setup-vault.mjs');

let cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
try {
  const input = fs.readFileSync(0, 'utf8');
  if (input) {
    const data = JSON.parse(input);
    if (data.cwd) cwd = data.cwd;
  }
} catch {}

if (!fs.existsSync(join(cwd, '.obsidian'))) process.exit(0);

// SessionStart hooks should be silent on the happy path. We drop the child's
// stdout (which prints "[obsidian-mcp-router] Synced N plugin(s)..." on
// changes) but keep stderr so genuine failures still surface.
const result = spawnSync(
  process.execPath,
  [setupScript, cwd, '--sync-plugins', '--quiet'],
  { stdio: ['ignore', 'ignore', 'inherit'], timeout: 10000 }
);

process.exit(0);
