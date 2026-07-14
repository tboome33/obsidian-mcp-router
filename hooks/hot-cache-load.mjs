#!/usr/bin/env node
/**
 * hot-cache-load.mjs
 *
 * SessionStart / PostCompact hook. Loads the vault's `wiki-meta/hot.md`
 * into Claude's context at session start (or after a context
 * compaction). Two modes (v0.11.6+):
 *
 *   - **cwd-is-vault**: cwd contains `wiki-meta/hot.md` directly. Read it
 *     and print to stdout (original behavior since v0.4.1).
 *
 *   - **workspace-bound**: cwd has no `wiki-meta/`, but
 *     `OBSIDIAN_ROUTER_DEFAULT_VAULT` (in workspace `.env` or env) maps
 *     to a configured vault that has a `wiki-meta/hot.md`. Read THAT file
 *     and print, prefixed with a marker indicating which vault it came
 *     from so Claude knows the hot cache is the ASSOCIATED vault's,
 *     not the cwd's.
 *
 *   - Else: silent exit 0.
 *
 * Cross-platform replacement for the bash one-liner used by other wiki
 * stacks. Bash equivalents are silent no-ops on Windows cmd/PowerShell.
 *
 * Wire it up in ~/.claude/settings.json:
 *
 *   "SessionStart": [{ "matcher": "startup|resume|clear", "hooks": [
 *     { "type": "command", "command": "node \"<router>/hooks/hot-cache-load.mjs\"" }
 *   ]}],
 *   "PostCompact": [{ "matcher": "", "hooks": [
 *     { "type": "command", "command": "node \"<router>/hooks/hot-cache-load.mjs\"" }
 *   ]}]
 *
 * (v0.12.4 widened the SessionStart matcher from `startup|resume` to
 * `startup|resume|clear` so hot.md is also reloaded after a `/clear`
 * — same desired behavior since `/clear` wipes the context.)
 *
 * Stdin: optional JSON payload with a `cwd` field (Claude Code sends
 * this on SessionStart). Falls back to `CLAUDE_PROJECT_DIR` env var,
 * then `process.cwd()`.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  loadWorkspaceDotenv,
  readRouterConfig,
  detectVaultContext,
} from './_helpers/workspace-vault.mjs';
import {
  countHotSize,
  hotStatus,
  selectBoundedContent,
  buildHotBanner,
  INJECTION_CAP_BYTES,
} from '../src/helpers/hot-size.mjs';

// ---- Resolve cwd from stdin or env ----------------------------------
// Claude Code passes `{ cwd, hook_event_name, session_id, ... }` on
// stdin for SessionStart. Best-effort: try stdin first, fall back to
// CLAUDE_PROJECT_DIR env, finally process.cwd(). Never throws.
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

// ---- Load workspace .env BEFORE checking vault context --------------
// In workspace-bound mode, `OBSIDIAN_ROUTER_DEFAULT_VAULT` is set in
// the workspace `.env` (by `setup-vault.mjs --link-workspace`). Without
// the autoload, the hook would only see env vars from the parent shell.
loadWorkspaceDotenv(cwd);

// ---- Detect vault context (dual-mode) --------------------------------
const cfg = readRouterConfig();
const ctx = detectVaultContext(cwd, cfg);
if (!ctx) process.exit(0); // non-vault project, no associated vault — silent

// ---- Read hot.md from the resolved vault path ------------------------
// v0.12.0: scaffold files now live under `wiki-meta/`, separate from
// user content in `wiki/`. Clean break, no fallback.
const hotPath = path.join(ctx.vaultPath, 'wiki-meta', 'hot.md');
let hotContent;
try {
  hotContent = fs.readFileSync(hotPath, 'utf8');
} catch {
  // The vault has wiki-meta/index.md (detection passed) but no hot.md yet
  // — common before the user runs `/save` for the first time. Silent
  // exit so the absence isn't surfaced as an error.
  process.exit(0);
}

// ---- Size discipline (v0.46.0 — sober dynamic token budget) ----------
// The hot is a CACHE. Injecting an oversized hot verbatim silently burns
// context on EVERY session start (observed: 129 KB ≈ 35k tokens on the
// oldest vault). Measure through the SHARED module (same enforced limit as
// the Stop guard and the compaction skill), in ONE unit — estimated tokens —
// with the limit breathing within a narrow band around the ~500-word anchor
// (vault role + active threads) under a fixed absolute cap. When over the
// enforced limit, inject only a bounded, newest-first excerpt topped with an
// actionable banner. This hook never MODIFIES the vault — the rewrite is the
// session's job (`/obsidian-router:hot-compact`).
const st = hotStatus(hotContent);
if (st.over) {
  // Inject up to the absolute-cap worth of bytes (~4 bytes/token), bounded by
  // the hard injection ceiling — enough context without re-importing the drift.
  const budget = Math.min(st.absoluteCapTokens * 4, INJECTION_CAP_BYTES);
  const bounded = selectBoundedContent(hotContent, budget);
  const banner = buildHotBanner({
    tokens: st.tokens,
    limitTokens: st.limitTokens,
    targetTokens: st.targetTokens,
    vaultLabel: path.basename(ctx.vaultPath),
  });
  hotContent = banner + '\n\n' + bounded.content;
} else if (countHotSize(hotContent).bytes > INJECTION_CAP_BYTES) {
  // Defensive: an under-limit hot cannot exceed the cap in practice, but
  // never let ANY code path inject more than the absolute injection ceiling.
  hotContent = selectBoundedContent(hotContent, INJECTION_CAP_BYTES).content;
}

// In workspace-bound mode, prefix the output with a clear marker so
// Claude knows the hot cache is the ASSOCIATED vault's, not the cwd's.
// This avoids confusion when Claude later sees "wiki/X.md" mentioned in
// the hot — it should know to read via MCP with `vault: "<slug>"` arg,
// not via filesystem `Read` (which would fail in workspace-bound).
if (ctx.mode === 'workspace-bound') {
  const marker = [
    '<!-- hot-cache-load: workspace-bound mode -->',
    `<!-- This hot.md was loaded from the ASSOCIATED vault \`${ctx.slug}\` (path: ${ctx.vaultPath}). -->`,
    `<!-- The current workspace (cwd: ${cwd}) is a code/dev project, not the vault itself. -->`,
    `<!-- To read other vault files, use mcp__obsidian-router__get_file({ vault: "${ctx.slug}", path: "wiki/..." }). -->`,
    '',
    '',
  ].join('\n');
  process.stdout.write(marker + hotContent);
} else {
  process.stdout.write(hotContent);
}
process.exit(0);
