#!/usr/bin/env node
/**
 * wiki-autocommit.mjs
 *
 * PostToolUse hook (matcher: Write|Edit|mcp__obsidian-router__write_file|
 * mcp__obsidian-router__patch_file|mcp__obsidian-router__append_to_file).
 * After a write to the wiki, auto-commits wiki/, .raw/, .vault-meta/
 * changes to git so the wiki has a built-in undo history. Skips silently
 * if the cwd is not a git repo, or if there's nothing staged.
 *
 * Cross-platform Node replacement for the bash auto-commit hook used by
 * other wiki stacks (which fails silently on Windows because `[ -d .git ]`
 * is bash-only).
 *
 * Exits 0 in all cases — never blocks Claude Code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const gitDir = path.join(cwd, '.git');

if (!fs.existsSync(gitDir)) process.exit(0);

// Only auto-commit if at least one of these dirs exists in cwd —
// otherwise we have nothing to track and shouldn't pollute random repos.
const trackedDirs = ['wiki', '.raw', '.vault-meta'].filter((d) =>
  fs.existsSync(path.join(cwd, d)),
);
if (trackedDirs.length === 0) process.exit(0);

function git(args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

// Stage just the tracked dirs (NEVER -A — could grab unrelated files).
const addRes = git(['add', ...trackedDirs]);
if (addRes.status !== 0) process.exit(0); // git failed → bail silently

// Did anything actually get staged?
const diffRes = git(['diff', '--cached', '--quiet']);
// `git diff --cached --quiet` exits 0 if no diff, 1 if there's a diff.
if (diffRes.status === 0) process.exit(0);

// Compose a commit message.
const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
const msg = `wiki: auto-commit ${ts}`;

git(['commit', '-m', msg, '--no-verify']);
// --no-verify so this hook doesn't get blocked by other pre-commit hooks
// (lint-staged, husky, etc.) which might be slow/strict and aren't relevant
// to wiki bookkeeping.

process.exit(0);
