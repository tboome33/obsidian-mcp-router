#!/usr/bin/env node
/**
 * vault-doc-startup-check.mjs (v0.13.7+)
 *
 * SessionStart hook. Runs the same vault-side drift detection as
 * `doc-propagation-checker.mjs`, but **independently of any commit
 * event** — fires at every Claude Code session start. This catches the
 * "cumulative drift" scenario the user hit on 2026-05-24 where 8
 * versions of the router shipped without anyone updating the wiki
 * `router-changelog.md` — each individual commit's nudge was either
 * not visible to Claude (hook not installed at the time) or got lost
 * in the noise, and the drift compounded.
 *
 * By firing at SessionStart, the user sees the consolidated drift
 * report BEFORE they start working — giving Claude a chance to propose
 * the doc updates as the FIRST action of the session. This is the
 * pattern Roland asked for on 2026-05-24:
 *
 *   "JE VEUX TOUT A JOUR, JE VEUX QUE CE VAULT SE REMPLISSE AU FUR ET
 *    A MESURE. QUE LES INFOS SOIENT CONSOLIDEES"
 *
 * Translation: the vault must reflect the repo state at all times, the
 * drift must be surfaced and fixed early.
 *
 * Mechanism:
 *   1. Detect vault context (cwd-is-vault or workspace-bound, or
 *      portRegistry vault candidates).
 *   2. Run `detectDocDrift()` against the most relevant vault.
 *   3. If issues exist, fingerprint them. If the fingerprint matches
 *      the last fired state (stored at
 *      `<repo>/.vault-meta/doc-drift-startup-fingerprint`), exit silent.
 *      Otherwise emit the nudge to stdout.
 *
 * Non-blocking — always exit 0. The nudge becomes part of the
 * SessionStart context Claude reads.
 *
 * Opt-out:
 *   - `OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true` (shared opt-out
 *     with doc-propagation-checker — one flag for both)
 *   - `OBSIDIAN_ROUTER_NO_DOC_STARTUP_CHECK=true` (this hook only)
 *
 * Input (stdin, JSON from Claude Code SessionStart):
 *   { hook_event_name: "SessionStart",
 *     source: "startup" | "resume" | "clear",
 *     cwd: "...", session_id: "...", transcript_path: "..." }
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  readRouterConfig,
  orderedVaultCandidates,
  detectDocDrift,
  fingerprintIssues,
  renderDriftNudge,
} from './_helpers/doc-drift-detector.mjs';
import { loadWorkspaceDotenv } from './_helpers/workspace-vault.mjs';

// The workspace .env is loaded before the opt-outs are read, so a NO_* set in
// that file is honored here and not only when the parent shell carries it.
loadWorkspaceDotenv(process.env.CLAUDE_PROJECT_DIR || process.cwd());

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK || '').toLowerCase())) process.exit(0);
if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_DOC_STARTUP_CHECK || '').toLowerCase())) process.exit(0);

// ---- Resolve cwd from stdin or env ----------------------------------
function resolveCwd() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (raw) {
      const data = JSON.parse(raw);
      if (typeof data.cwd === 'string' && data.cwd) return data.cwd;
    }
  } catch { /* stdin missing or unparseable */ }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const cwd = resolveCwd();

// ---- Need a package.json + a vault candidate to be useful ----------
if (!fs.existsSync(path.join(cwd, 'package.json'))) process.exit(0);

const cfg = readRouterConfig();
const vaultCandidates = orderedVaultCandidates(cwd, cfg);
if (vaultCandidates.length === 0) process.exit(0);

// ---- Run detector against the first candidate that has any issues --
// We pick the MOST RELEVANT vault (first in candidates order) that has
// drift. Reporting multiple vaults at SessionStart would be noisy — the
// user typically works on one project's vault at a time, and the
// ordering puts that vault first.
let report = null;
for (const vp of vaultCandidates) {
  const r = detectDocDrift(cwd, vp, { cumulativeWindow: 5 });
  if (r.issues.length > 0) { report = r; break; }
}
if (!report) process.exit(0); // no drift anywhere — silent

// ---- Fingerprint dedup -----------------------------------------------
// Same pattern as hot-cache-update-prompt.mjs. State file stored under
// `<repo>/.vault-meta/` (already used by other hooks for state). If the
// fingerprint matches what we stored last time we fired, skip — the
// user has seen this exact set of issues and chose not to act, so
// don't keep nagging until something changes (a new commit, a partial
// fix, a code change that adds/removes an artifact, etc.).
const fingerprintFile = path.join(cwd, '.vault-meta', 'doc-drift-startup-fingerprint');
const currentFp = fingerprintIssues(report.issues);
try {
  const stored = fs.readFileSync(fingerprintFile, 'utf8').trim();
  if (stored === currentFp) process.exit(0);
} catch { /* no prior fingerprint or unreadable — proceed */ }

// ---- Emit the nudge --------------------------------------------------
const nudge = renderDriftNudge(
  'VAULT_DOC_STARTUP_DRIFT',
  report.vaultPath,
  report.projectSlug,
  report.currentVersion,
  report.issues,
);
process.stdout.write(nudge + '\n');

// Record fingerprint so we don't re-fire until state changes.
try {
  fs.mkdirSync(path.dirname(fingerprintFile), { recursive: true });
  fs.writeFileSync(fingerprintFile, currentFp, 'utf8');
} catch { /* swallow — fingerprinting is best-effort */ }

process.exit(0);
