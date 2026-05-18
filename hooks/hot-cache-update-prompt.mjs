#!/usr/bin/env node
/**
 * hot-cache-update-prompt.mjs
 *
 * Stop hook. After every Claude response, if wiki/ files changed during
 * the turn (detected via `git diff --name-only HEAD` + recent commits),
 * emit a short prompt-style notice to stdout asking Claude to refresh
 * wiki/hot.md with a brief summary of what changed.
 *
 * v0.8.10 — topology-equality short-circuit (T1.C). Stores a fingerprint
 * of the changed-files set after firing, and skips re-firing on the next
 * Stop if the fingerprint is unchanged. This prevents the re-prompt loop
 * that happened when Claude saw the nudge but chose not to refresh hot.md
 * (or refreshed-but-changes-stayed-pending-for-other-reasons).
 *
 * Cross-platform Node replacement for a bash equivalent. Exits 0 on
 * non-vault, non-git, or no-wiki-changes scenarios — never blocks
 * Claude Code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  computeFingerprint,
  readFingerprint,
  writeFingerprint,
} from '../src/helpers/wiki-fingerprint.mjs';

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const gitDir = path.join(cwd, '.git');
const wikiDir = path.join(cwd, 'wiki');
const fingerprintFile = path.join(cwd, '.vault-meta', 'hot-prompt-fingerprint');

if (!fs.existsSync(gitDir) || !fs.existsSync(wikiDir)) process.exit(0);

// Detect wiki/ activity in BOTH the working tree (uncommitted) AND in
// recent commits — the PostToolUse autocommit hook may have already
// committed mid-session, so checking the working tree alone misses
// everything once autocommit fires. We union both sources.
const diffTree = spawnSync(
  'git',
  ['diff', '--name-only', 'HEAD', '--', 'wiki/'],
  { cwd, encoding: 'utf8', stdio: 'pipe' },
);
const recentCommits = spawnSync(
  'git',
  ['log', '--since=15 minutes ago', '--name-only', '--pretty=format:', '--', 'wiki/'],
  { cwd, encoding: 'utf8', stdio: 'pipe' },
);

if (diffTree.status !== 0 && recentCommits.status !== 0) process.exit(0);

const changedSet = new Set();
for (const out of [diffTree.stdout, recentCommits.stdout]) {
  if (!out) continue;
  for (const line of out.split('\n')) {
    const p = line.trim();
    if (p) changedSet.add(p);
  }
}
const changed = [...changedSet];

if (changed.length === 0) process.exit(0);

// Don't ask for a hot.md refresh if hot.md itself is the only thing that
// changed — would be a refresh-of-the-refresh loop.
const nonHot = changed.filter((p) => !p.endsWith('/hot.md'));
if (nonHot.length === 0) process.exit(0);

// v0.8.10 — dedup re-prompts. If the fingerprint of substantive changes
// is identical to what we stored after the last fire, Claude has already
// seen this exact nudge — don't re-fire. This breaks the loop where the
// hook prompts on every Stop until hot.md is actually refreshed.
//
// We fingerprint ONLY the non-hot.md files (hot.md being refreshed is the
// terminating condition — we want re-prompts to fire when it's stale
// relative to the rest, not when it itself changed).
const currentFingerprint = computeFingerprint(cwd, nonHot);
const storedFingerprint = readFingerprint(fingerprintFile);
if (storedFingerprint === currentFingerprint) {
  // Already prompted for this exact state — skip silently.
  process.exit(0);
}

process.stdout.write(
  'WIKI_CHANGED: ' + changed.length + ' wiki file(s) modified this session. ' +
  'Please update wiki/hot.md with a brief summary of what changed (under 500 words). ' +
  'Use the structure: ## Last Updated, ## Key Recent Facts, ## Recent Changes, ## Active Threads. ' +
  'Keep it factual. Overwrite the file completely (it is a cache, not a journal).',
);

// Record the fingerprint so the next Stop hook with the same state skips.
writeFingerprint(fingerprintFile, currentFingerprint);

process.exit(0);
