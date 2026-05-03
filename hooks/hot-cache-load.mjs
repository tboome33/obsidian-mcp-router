#!/usr/bin/env node
/**
 * hot-cache-load.mjs
 *
 * SessionStart / PostCompact hook. Reads `wiki/hot.md` from the project's
 * cwd if it exists, prints the contents to stdout so Claude picks it up
 * as injected context, and exits 0 silently on non-vault projects.
 *
 * Cross-platform replacement for the bash one-liner used by other wiki
 * stacks. The bash version (`[ -f wiki/hot.md ] && cat wiki/hot.md`) is
 * a no-op on Windows cmd.exe / PowerShell — so the hot cache silently
 * never loaded for Windows users. This script works everywhere Node runs.
 *
 * Wire it up in ~/.claude/settings.json:
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [{
 *         "matcher": "startup|resume",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node \"<absolute-path>/hooks/hot-cache-load.mjs\""
 *         }]
 *       }],
 *       "PostCompact": [{
 *         "matcher": "",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node \"<absolute-path>/hooks/hot-cache-load.mjs\""
 *         }]
 *       }]
 *     }
 *   }
 */
import fs from 'node:fs';
import path from 'node:path';

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const hotPath = path.join(cwd, 'wiki', 'hot.md');

// Best-effort: also accept stdin payload with a `cwd` field if Claude Code
// provides one (matches how SessionStart hooks receive context).
try {
  const input = fs.readFileSync(0, 'utf8');
  if (input) {
    const data = JSON.parse(input);
    if (data.cwd) {
      const altPath = path.join(data.cwd, 'wiki', 'hot.md');
      if (fs.existsSync(altPath)) {
        process.stdout.write(fs.readFileSync(altPath, 'utf8'));
        process.exit(0);
      }
    }
  }
} catch { /* stdin missing or unparseable — fall back to cwd */ }

if (fs.existsSync(hotPath)) {
  process.stdout.write(fs.readFileSync(hotPath, 'utf8'));
}
process.exit(0);
