#!/usr/bin/env node
/**
 * doc-propagation-checker.mjs
 *
 * PostToolUse hook on Bash. Fires after every `git commit` and checks
 * that the repo's documentation surface (CHANGELOG, ROADMAP, optional
 * vault wiki router-changelog) is aligned with the current
 * `package.json` version. If drift is detected, emits a prompt-style
 * stdout notice asking Claude to fix the docs in the next turn.
 *
 * Why this exists: even with the global CLAUDE.md "roadmap discipline"
 * rule (every shipped feature must update CHANGELOG + ROADMAP + per-
 * version vault wiki), Claude consistently slips on this — bumps the
 * version manifests OR ships a feat commit, then moves on to the next
 * thing without propagating to the human-readable docs. Roland has
 * caught this twice in the same session — the slip-pattern is real
 * and structural. Memory entries don't solve recall-at-the-right-
 * moment; a deterministic check OUTSIDE the LLM attention loop does.
 * Same spirit as `vault-link-linter` (v0.11.3) and `wiki-autocommit`.
 *
 * Non-blocking (exit 0) — emits a NUDGE on stdout, not a block. The
 * difference vs vault-link-linter (which blocks): a commit being out
 * of sync with docs is informational; the commit already landed. The
 * nudge invites Claude to propose the doc update in the NEXT response.
 *
 * Checks performed (only when the just-run command is `git commit ...`):
 *   1. CHANGELOG.md has a `## [X.Y.Z]` section matching package.json.
 *   2. ROADMAP.md has a `## ✅ vX.Y.Z` section matching package.json.
 *   3. CHANGELOG.md `[Unreleased]` section has substantive content
 *      after a recent version section exists (suggests the commit
 *      forgot to promote pending entries).
 *   4. Vault wiki (if router has a portRegistry vault containing
 *      `wiki/obsidian-mcp-router/router-changelog.md`) mentions the
 *      current version.
 *
 * Exit codes:
 *   0  — always (nudge or silent; never blocks). Hooks must not
 *        disrupt git commits or other tool calls.
 *
 * Opt-out: `OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true` (truthy:
 *          `true` / `1` / `yes` / `on`).
 *
 * Input (stdin, JSON from Claude Code PostToolUse):
 *   { hook_event_name: "PostToolUse",
 *     tool_name: "Bash",
 *     tool_input: { command: "..." },
 *     tool_response: ... }
 */

import fs from 'node:fs';
import path from 'node:path';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK || '').toLowerCase())) {
  process.exit(0);
}

// ---- Read hook input from stdin ---------------------------------------
let stdinRaw = '';
try { stdinRaw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
let input;
try { input = JSON.parse(stdinRaw || '{}'); } catch { process.exit(0); }

// Filter to Bash tool calls that look like `git commit` (vs other git
// subcommands like `git status`, `git push`). Be conservative on the
// regex so wrappers like `git commit -m '...'` or `git commit --amend`
// match. Multi-command shell lines (e.g. `git add . && git commit -m
// '...'`) match too via the global flag.
if (input.tool_name !== 'Bash') process.exit(0);
const command = input.tool_input?.command || '';
if (!/(?:^|[\s;&|])git\s+commit\b/.test(command)) process.exit(0);

// ---- Locate the repo + read package.json version ----------------------
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const pkgPath = path.join(cwd, 'package.json');
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch {
  // No package.json (not a Node project root) → nothing to check.
  process.exit(0);
}
const currentVersion = pkg.version;
if (!currentVersion || typeof currentVersion !== 'string') process.exit(0);

// ---- Helpers to scan CHANGELOG + ROADMAP ------------------------------
function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does CHANGELOG.md have a section `## [X.Y.Z]` for the current version?
 * Accepts both `## [X.Y.Z]` and `## [X.Y.Z] — date` forms (Keep a
 * Changelog convention).
 */
function changelogHasVersion(content, version) {
  if (!content) return false;
  const re = new RegExp(`^## \\[${escapeRegex(version)}\\]`, 'm');
  return re.test(content);
}

/**
 * Does ROADMAP.md have a `## ✅ vX.Y.Z` (or `## v X.Y.Z`) section?
 * Accept the project's existing style with optional dash + text.
 */
function roadmapHasVersion(content, version) {
  if (!content) return false;
  const re = new RegExp(`^## (?:✅\\s*)?v${escapeRegex(version)}\\b`, 'm');
  return re.test(content);
}

/**
 * Does CHANGELOG.md `[Unreleased]` section have substantive content
 * (more than just "Nothing pending right now.")? Returns the content
 * between `## [Unreleased]` and the next `## ` for inspection.
 */
function unreleasedContent(content) {
  if (!content) return null;
  const m = content.match(/^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## )/m);
  if (!m) return null;
  const body = m[1].trim();
  // Recognize the "empty" placeholder text the project uses.
  if (!body || /^nothing pending right now\.?$/i.test(body)) return null;
  return body;
}

// ---- Run the checks ---------------------------------------------------
const nudges = [];

const changelogPath = path.join(cwd, 'CHANGELOG.md');
const changelog = readSafe(changelogPath);
if (changelog !== null && !changelogHasVersion(changelog, currentVersion)) {
  nudges.push(
    `CHANGELOG.md doesn't have a \`## [${currentVersion}]\` section.\n` +
    `  Action: promote the [Unreleased] entries (or add a new section if [Unreleased] is empty).`,
  );
}

const roadmapPath = path.join(cwd, 'ROADMAP.md');
const roadmap = readSafe(roadmapPath);
if (roadmap !== null && !roadmapHasVersion(roadmap, currentVersion)) {
  nudges.push(
    `ROADMAP.md doesn't have a \`## ✅ v${currentVersion}\` section.\n` +
    `  Action: add a "## ✅ v${currentVersion} — <theme> (shipped <date>)" entry summarizing this release.`,
  );
}

if (changelog !== null) {
  const unreleased = unreleasedContent(changelog);
  // Only flag "stale Unreleased" when the current version section
  // ALREADY exists — otherwise the user is mid-flow with pending
  // entries waiting for the next version bump, which is normal.
  if (unreleased && changelogHasVersion(changelog, currentVersion)) {
    nudges.push(
      `CHANGELOG.md [Unreleased] still has content even though [${currentVersion}] section exists.\n` +
      `  Action: either promote those entries into [${currentVersion}] or reset [Unreleased] to "Nothing pending right now." if they were already moved.`,
    );
  }
}

// ---- Optional: check vault wiki router-changelog.md -------------------
// Iterate the router's portRegistry and look for the project's wiki
// changelog file. If found AND the current version isn't mentioned in
// it, nudge.
const CONFIG_PATH = process.env.OBSIDIAN_ROUTER_CONFIG
  ? path.resolve(process.env.OBSIDIAN_ROUTER_CONFIG)
  : path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.claude', 'obsidian-mcp-router', 'config.json',
    );
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* no config */ }
if (cfg) {
  const vaultPaths = Object.keys(cfg.portRegistry || {});
  for (const vp of vaultPaths) {
    const wikiChangelog = path.join(vp, 'wiki', 'obsidian-mcp-router', 'router-changelog.md');
    const content = readSafe(wikiChangelog);
    if (!content) continue;
    // Vault changelog uses `## vX.Y.Z` style (no ✅).
    const versionRe = new RegExp(`^## v${escapeRegex(currentVersion)}\\b`, 'm');
    if (!versionRe.test(content)) {
      nudges.push(
        `Vault wiki router-changelog.md (in "${vp}") doesn't mention v${currentVersion}.\n` +
        `  Action: prepend a "## v${currentVersion} — <date>" section with bilingual FR+EN narration.`,
      );
    }
    break; // only flag the first matching vault (avoid spam in multi-vault setups)
  }
}

if (nudges.length === 0) process.exit(0);

// ---- Emit prompt-style nudge to stdout --------------------------------
const lines = [];
lines.push(`DOC_PROPAGATION_CHECK: post-commit drift detected for v${currentVersion}.`);
lines.push('');
lines.push(`Just-run command: ${command.length > 120 ? command.slice(0, 120) + '…' : command}`);
lines.push('');
lines.push(`${nudges.length} issue(s) to address in the NEXT response:`);
lines.push('');
for (const [i, n] of nudges.entries()) {
  lines.push(`${i + 1}. ${n}`);
  lines.push('');
}
lines.push(
  'Please propose the doc updates now so the version-bump cascade stays ' +
  'consistent. If you intentionally split docs across commits, ignore — ' +
  'this is informational only, the commit already landed. Opt-out: set ' +
  'OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true.',
);

process.stdout.write(lines.join('\n') + '\n');
process.exit(0);
