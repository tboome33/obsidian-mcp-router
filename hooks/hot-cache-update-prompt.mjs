#!/usr/bin/env node
/**
 * hot-cache-update-prompt.mjs
 *
 * Stop hook. After every Claude response, if wiki/ files changed during
 * the turn (detected via `git diff --name-only HEAD`), emit a short
 * prompt-style notice to stdout asking Claude to refresh wiki/hot.md
 * with a brief summary of what changed.
 *
 * Cross-platform Node replacement for a bash equivalent. Exits 0 on
 * non-vault, non-git, or no-wiki-changes scenarios — never blocks
 * Claude Code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const gitDir = path.join(cwd, '.git');
const wikiDir = path.join(cwd, 'wiki');

if (!fs.existsSync(gitDir) || !fs.existsSync(wikiDir)) process.exit(0);

const diff = spawnSync(
  'git',
  ['diff', '--name-only', 'HEAD', '--', 'wiki/'],
  { cwd, encoding: 'utf8', stdio: 'pipe' },
);

if (diff.status !== 0) process.exit(0);

const changed = (diff.stdout || '')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

if (changed.length === 0) process.exit(0);

// Don't ask for a hot.md refresh if hot.md itself is the only thing that
// changed — would be a refresh-of-the-refresh loop.
const nonHot = changed.filter((p) => !p.endsWith('/hot.md'));
if (nonHot.length === 0) process.exit(0);

process.stdout.write(
  'WIKI_CHANGED: ' + changed.length + ' wiki file(s) modified this session. ' +
  'Please update wiki/hot.md with a brief summary of what changed (under 500 words). ' +
  'Use the structure: ## Last Updated, ## Key Recent Facts, ## Recent Changes, ## Active Threads. ' +
  'Keep it factual. Overwrite the file completely (it is a cache, not a journal).',
);

process.exit(0);
