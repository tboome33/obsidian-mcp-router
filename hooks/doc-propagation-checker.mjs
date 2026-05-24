#!/usr/bin/env node
/**
 * doc-propagation-checker.mjs (v0.11.4 + v0.13.7 generalization)
 *
 * PostToolUse hook on Bash. Fires after every `git commit` and checks
 * the repo's documentation surface for drift against the current code
 * state — CHANGELOG, ROADMAP, AND the vault wiki pages (router-
 * changelog, index.md current-version, project-router frontmatter,
 * artifact catalog completeness).
 *
 * Version history:
 *   - v0.11.4 (origin): only checked CHANGELOG/ROADMAP for the current
 *     version + one vault wiki router-changelog match.
 *   - v0.13.7: refactored to use the shared `_helpers/doc-drift-
 *     detector.mjs`. Now checks:
 *       (a) ALL vaults whose CHANGELOG.md is missing the version
 *       (b) cumulative window of last 5 versions (not just current)
 *       (c) wiki-meta/index.md mentions current version
 *       (d) project-router.md frontmatter `current-version` matches
 *       (e) artifact catalog pages cover the basenames in tracked dirs
 *     Vault selection order: workspace-bound → defaultVault → cwd-
 *     basename heuristic → others → `.template` last (was: arbitrary
 *     first-match in portRegistry, which usually hit `.template` and
 *     stopped — pre-v0.13.7 bug that let 8 versions of drift slip
 *     through unnoticed in 2026-05-24).
 *
 * Non-blocking (exit 0). Stop hooks emit nudges to stdout which become
 * part of Claude's context for the NEXT turn.
 *
 * Opt-out: `OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true`.
 *
 * Input (stdin, JSON from Claude Code PostToolUse):
 *   { hook_event_name: "PostToolUse",
 *     tool_name: "Bash",
 *     tool_input: { command: "..." },
 *     tool_response: ... }
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  readRouterConfig,
  orderedVaultCandidates,
  detectDocDrift,
  readPackageVersion,
  renderDriftNudge,
} from './_helpers/doc-drift-detector.mjs';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK || '').toLowerCase())) {
  process.exit(0);
}

// ---- Read hook input from stdin ---------------------------------------
let stdinRaw = '';
try { stdinRaw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
let input;
try { input = JSON.parse(stdinRaw || '{}'); } catch { process.exit(0); }

// Only fire on git commit (Bash tool only).
if (input.tool_name !== 'Bash') process.exit(0);
const command = input.tool_input?.command || '';
if (!/(?:^|[\s;&|])git\s+commit\b/.test(command)) process.exit(0);

// ---- Locate the repo ---------------------------------------------------
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const currentVersion = readPackageVersion(cwd);
if (!currentVersion) process.exit(0); // no package.json — skip

// ---- Repo-level checks: CHANGELOG.md and ROADMAP.md --------------------
const nudges = [];

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function changelogHasVersion(content, version) {
  if (!content) return false;
  return new RegExp(`^## \\[${escapeRegex(version)}\\]`, 'm').test(content);
}
function roadmapHasVersion(content, version) {
  if (!content) return false;
  return new RegExp(`^## (?:✅\\s*)?v${escapeRegex(version)}\\b`, 'm').test(content);
}
function unreleasedContent(content) {
  if (!content) return null;
  const m = content.match(/^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## )/m);
  if (!m) return null;
  const body = m[1].trim();
  if (!body || /^nothing pending right now\.?$/i.test(body)) return null;
  return body;
}

const changelog = readSafe(path.join(cwd, 'CHANGELOG.md'));
if (changelog !== null && !changelogHasVersion(changelog, currentVersion)) {
  nudges.push(
    `CHANGELOG.md doesn't have a \`## [${currentVersion}]\` section.\n` +
    `  Action: promote the [Unreleased] entries (or add a new section if [Unreleased] is empty).`,
  );
}
const roadmap = readSafe(path.join(cwd, 'ROADMAP.md'));
if (roadmap !== null && !roadmapHasVersion(roadmap, currentVersion)) {
  nudges.push(
    `ROADMAP.md doesn't have a \`## ✅ v${currentVersion}\` section.\n` +
    `  Action: add a "## ✅ v${currentVersion} — <theme> (shipped <date>)" entry summarizing this release.`,
  );
}
if (changelog !== null) {
  const unreleased = unreleasedContent(changelog);
  if (unreleased && changelogHasVersion(changelog, currentVersion)) {
    nudges.push(
      `CHANGELOG.md [Unreleased] still has content even though [${currentVersion}] section exists.\n` +
      `  Action: either promote those entries into [${currentVersion}] or reset [Unreleased].`,
    );
  }
}

// ---- Vault-side checks via the shared detector -------------------------
// v0.13.7: iterate ALL relevant vault candidates (not just first match).
// The order from `orderedVaultCandidates` puts the most likely owner
// (workspace-bound → defaultVault → cwd-basename → others → templates
// last) first so the most relevant nudge fires first.
const cfg = readRouterConfig();
const vaultCandidates = orderedVaultCandidates(cwd, cfg);
const vaultIssuesPerVault = [];
let firedVaultsCount = 0;

for (const vp of vaultCandidates) {
  const report = detectDocDrift(cwd, vp, { cumulativeWindow: 5 });
  if (report.issues.length > 0) {
    vaultIssuesPerVault.push(report);
    firedVaultsCount += 1;
    // Cap at 2 vaults to avoid spamming when multiple vaults are out of
    // sync (e.g. .template + the project vault both stale). The first 2
    // are the most relevant per the ordering.
    if (firedVaultsCount >= 2) break;
  }
}

// ---- Compose final nudge if anything was flagged -----------------------
if (nudges.length === 0 && vaultIssuesPerVault.length === 0) process.exit(0);

const lines = [];
lines.push(`DOC_PROPAGATION_CHECK: post-commit drift detected for v${currentVersion}.`);
lines.push('');
lines.push(`Just-run command: ${command.length > 120 ? command.slice(0, 120) + '…' : command}`);
lines.push('');

if (nudges.length > 0) {
  lines.push(`Repo-level (${nudges.length} issue${nudges.length === 1 ? '' : 's'}):`);
  lines.push('');
  for (const [i, n] of nudges.entries()) {
    lines.push(`${i + 1}. ${n}`);
    lines.push('');
  }
}

for (const report of vaultIssuesPerVault) {
  lines.push(renderDriftNudge(
    'VAULT_DOC_DRIFT',
    report.vaultPath,
    report.projectSlug,
    report.currentVersion,
    report.issues,
  ));
  lines.push('');
}

lines.push(
  'Please propose the doc updates now so the version-bump cascade stays ' +
  'consistent across repo + vault wiki. Opt-out: ' +
  'OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true.',
);

process.stdout.write(lines.join('\n') + '\n');
process.exit(0);
