#!/usr/bin/env node
/**
 * wiki-autocommit.mjs
 *
 * PostToolUse hook (matcher: the router's MCP mutators under any
 * registration prefix — write_file, patch_file, append_to_file,
 * set_frontmatter, merge_frontmatter, delete_file, move_file,
 * execute_template). After a vault write, auto-commits wiki/, wiki-meta/,
 * .raw/, .vault-meta/ changes to git so the wiki has a built-in undo
 * history.
 *
 * GUARDS (all must hold, else silent exit 0):
 *   - OBSIDIAN_ROUTER_NO_WIKI_AUTOCOMMIT is not truthy;
 *   - the cwd is a git repo;
 *   - the cwd IS a wiki vault (wiki-meta/catalog.md present) — NOT merely a
 *     repo that happens to contain a directory named `wiki`;
 *   - something is actually staged.
 *
 * This hook is opt-in only (`setup-vault.mjs --install-hooks`). It is
 * deliberately absent from hooks/hooks.json, which the plugin activates
 * for every user without asking: writing to somebody's git history is not
 * a defensible default.
 *
 * v0.12.0: added `wiki-meta/` to trackedDirs so the 4 scaffolds
 * (hot/catalog/journal/overview) that moved out of `wiki/` are still
 * auto-committed. Without this, scaffold changes (notably the
 * hot.md refresh triggered by hot-cache-update-prompt) would silently
 * fall out of the autocommit safety net.
 *
 * Caveat (multi-vault): this hook fires from the cwd of the Claude
 * Code session, NOT from the path of the vault that the router wrote
 * to. So if you're working in project A and the router writes to a
 * vault at /vaults/B, the hook checks the git status of project A
 * (whose `wiki/` may not exist) and silently no-ops. The hook is
 * effective when the project IS the wiki vault — which is the common
 * personal-knowledge-base case.
 *
 * Cross-platform Node implementation. Exits 0 in all cases — never
 * blocks Claude Code. Failures during git operations are surfaced on
 * stderr (visible in Claude Code's hook output) but never abort.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { detectVaultContext, readRouterConfig, loadWorkspaceDotenv } from './_helpers/workspace-vault.mjs';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ── Opt-out ──────────────────────────────────────────────────────────
// This hook writes to the user's git history. It must be switchable off
// without editing settings.json.
if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_WIKI_AUTOCOMMIT || '').trim().toLowerCase())) {
  process.exit(0);
}

const gitDir = path.join(cwd, '.git');
if (!fs.existsSync(gitDir)) process.exit(0);

// ── The cwd must BE a wiki vault ─────────────────────────────────────
// This used to be "cwd contains any of wiki/, wiki-meta/, .raw/,
// .vault-meta/", which is not a vault test at all: `wiki/` and `.raw/`
// are ordinary directory names, so the hook silently injected
// `wiki: auto-commit …` commits — with --no-verify, bypassing the user's
// own pre-commit hooks — into unrelated repositories that merely had a
// docs folder called wiki/.
//
// `wiki-meta/catalog.md` is the marker `setup-vault.mjs` scaffolds, so it
// identifies a real vault. Workspace-bound sessions are deliberately
// excluded: there the vault lives elsewhere and the cwd's own wiki/ is
// somebody else's, which is exactly the case this hook must not touch.
loadWorkspaceDotenv(cwd);
const ctx = detectVaultContext(cwd, readRouterConfig());
if (!ctx || ctx.mode !== 'cwd-is-vault') process.exit(0);

// Stage only the vault's own directories that actually exist.
const trackedDirs = ['wiki', 'wiki-meta', '.raw', '.vault-meta'].filter((d) =>
  fs.existsSync(path.join(cwd, d)),
);
if (trackedDirs.length === 0) process.exit(0);

function git(args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function warn(msg) {
  // Non-blocking — write to stderr so failures are at least visible in
  // Claude Code's hook output for diagnostics.
  process.stderr.write(`[wiki-autocommit] ${msg}\n`);
}

// Stage just the tracked dirs (NEVER -A — could grab unrelated files).
const addRes = git(['add', ...trackedDirs]);
if (addRes.status !== 0) {
  warn(`git add failed: ${(addRes.stderr || '').trim()}`);
  process.exit(0);
}

// Did anything actually get staged?
const diffRes = git(['diff', '--cached', '--quiet']);
// `git diff --cached --quiet` exits 0 if no diff, 1 if there's a diff.
if (diffRes.status === 0) process.exit(0);

// Compose a commit message.
const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
const msg = `wiki: auto-commit ${ts}`;

const commitRes = git(['commit', '-m', msg, '--no-verify']);
// --no-verify so this hook doesn't get blocked by other pre-commit hooks
// (lint-staged, husky, etc.) which might be slow/strict and aren't relevant
// to wiki bookkeeping.
if (commitRes.status !== 0) {
  // Common cause: missing user.email / user.name. We surface this once
  // so the user knows why their wiki isn't auto-committing.
  warn(`git commit failed: ${(commitRes.stderr || '').trim()}`);
}

process.exit(0);
