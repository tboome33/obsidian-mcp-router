#!/usr/bin/env node
/**
 * hot-cache-update-prompt.mjs
 *
 * Stop hook — DETERMINISTIC hot-cache freshness GUARD (v0.25.0).
 *
 * Blocks the end of a turn (exit 2) when THIS session wrote one or more
 * notes under a vault's `wiki/` directory but did NOT refresh that vault's
 * `wiki-meta/hot.md` in the same session. Claude then refreshes hot.md
 * before the turn completes, so the recent-context cache stays current by
 * construction — not by reminder.
 *
 * History — why this became a guard (v0.25.0). Pre-v0.25.0 this hook was a
 * soft *nudge*: it detected wiki changes via `git diff`/`git log` and wrote
 * a "please refresh hot.md" message to stdout (exit 0, never blocking).
 * That was advisory, so hot.md drifted stale whenever the nudge was not
 * acted on. Per Roland 2026-06-03 — "le hot doit toujours être à jour" — it
 * is now an enforcing Stop hook, exactly mirroring `vault-link-linter` and
 * the user-level `chat-link-guard`. The recurring lesson: nudge ≠ enforce.
 *
 * Detection is TRANSCRIPT-SCOPED (this session's `tool_use` calls), NOT git:
 *   - git diff/log would also flag uncommitted changes from a CONCURRENT
 *     session or a manual Obsidian edit — neither of which THIS Claude can
 *     fix — producing false blocks. Roland runs concurrent sessions on the
 *     same vaults, so this matters. Scanning the transcript counts only what
 *     this session actually wrote.
 *   - no git dependency → also works in non-git vaults.
 *
 * Trigger = a write to `wiki/<...>` (a NOTE). Pure scaffold edits
 * (`wiki-meta/index.md`, `log.md`, `overview.md`) do NOT trigger — they are
 * bookkeeping, not notes. A write to `wiki-meta/hot.md` is the satisfying
 * action. PER-VAULT: a session can touch several vaults; each is judged
 * independently. A vault whose root cannot be resolved is SKIPPED — the
 * guard fails OPEN, never blocking on ambiguity or infrastructure trouble.
 *
 * The classification logic lives in `src/helpers/hot-staleness.mjs` (pure,
 * unit-tested in `tests/hot-cache-guard.test.mjs`).
 *
 * Exit codes:
 *   0 — nothing stale, or opt-out, or recursion guard, or ANY error
 *       (fail-open — a guard must never wedge Claude Code on a bug).
 *   2 — ≥1 vault had a `wiki/` write but no hot.md refresh; stderr names
 *       the vault(s) and how to fix. Claude Code re-runs the turn.
 *
 * Opt-out: OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD=true (truthy: true/1/yes/on).
 * Recursion guard: stop_hook_active === true → exit 0 (never block twice).
 *
 * Input (stdin, JSON from Claude Code):
 *   { hook_event_name: "Stop", transcript_path, stop_hook_active, ... }
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  loadWorkspaceDotenv,
  readRouterConfig,
  resolveVaultBySlug,
  detectVaultContext,
} from './_helpers/workspace-vault.mjs';
import { findStaleVaults } from '../src/helpers/hot-staleness.mjs';

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Load workspace .env so OBSIDIAN_ROUTER_DEFAULT_VAULT (workspace-bound
// mode) and the opt-out var are honored even though hooks run as separate
// subprocesses. Fills only UNSET keys — process.env always wins.
try {
  loadWorkspaceDotenv(cwd);
} catch {
  /* never throw from the env loader */
}

// ---- Opt-out ----------------------------------------------------------
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD || '').toLowerCase())) {
  process.exit(0);
}

// ---- Read hook input from stdin ---------------------------------------
let stdinRaw = '';
try {
  stdinRaw = fs.readFileSync(0, 'utf8');
} catch {
  process.exit(0); // no stdin (manual debug) → fail silent
}
let input;
try {
  input = JSON.parse(stdinRaw || '{}');
} catch {
  process.exit(0);
}

// Recursion guard: don't block the same turn twice.
if (input.stop_hook_active === true) process.exit(0);

const transcriptPath = input.transcript_path;
if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

let jsonl;
try {
  jsonl = fs.readFileSync(transcriptPath, 'utf8');
} catch {
  process.exit(0);
}

// ---- Build the vault-resolution context from the router config --------
const isWin = process.platform === 'win32';
const cfg = readRouterConfig(); // null on any error — handled below
const vaultRoots = [];
if (cfg && cfg.portRegistry && typeof cfg.portRegistry === 'object') {
  for (const p of Object.keys(cfg.portRegistry)) vaultRoots.push(p);
}
let defaultRoot = null;
try {
  const ctx = detectVaultContext(cwd, cfg);
  if (ctx && ctx.vaultPath) {
    defaultRoot = ctx.vaultPath;
    if (!vaultRoots.includes(ctx.vaultPath)) vaultRoots.push(ctx.vaultPath);
  }
} catch {
  /* fail-open */
}

// ---- Decide ------------------------------------------------------------
let stale = [];
try {
  const result = findStaleVaults(jsonl, {
    vaultRoots,
    slugToRoot: (slug) => {
      try {
        return resolveVaultBySlug(cfg, slug);
      } catch {
        return null;
      }
    },
    defaultRoot,
    isWin,
  });
  stale = (result && result.stale) || [];
} catch {
  process.exit(0); // fail-open on any analysis error
}

if (stale.length === 0) process.exit(0);

// ---- Block (exit 2) with a bilingual, actionable message --------------
const names = stale.map((s) => path.basename(s.vaultRoot)).join(', ');
const lines = [];
lines.push('[obsidian-mcp-router/hot-cache-guard] hot.md non rafraîchi');
lines.push('');
lines.push(
  `FR — Tu as écrit des notes sous \`wiki/\` dans ${stale.length} vault(s) (${names}) ` +
    'sans rafraîchir leur `wiki-meta/hot.md` cette session.',
);
lines.push('Le `hot` est le cache de contexte récent : il doit TOUJOURS refléter les dernières pages touchées.');
lines.push('Mets-le à jour AVANT de terminer le tour :');
lines.push('  • ajoute une entrée en tête : `> 🆕 **<sujet>** (<date>) — <résumé bilingue 1 phrase> · [[lien]]`');
lines.push('  • corrige toute ligne devenue obsolète (version, statut) ;');
lines.push('  • écris dans `wiki-meta/hot.md` du vault concerné (write_file ou patch_file).');
lines.push('');
lines.push(
  `EN — You wrote notes under \`wiki/\` in ${stale.length} vault(s) (${names}) ` +
    'without refreshing their `wiki-meta/hot.md` this session.',
);
lines.push('The `hot` file is the recent-context cache: it must ALWAYS reflect the latest touched pages.');
lines.push('Update it BEFORE finishing: prepend a fresh one-line entry, fix any now-stale line, write to that vault\'s `wiki-meta/hot.md`.');
lines.push('');
lines.push('Opt-out (per-session): OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD=true');

process.stderr.write(lines.join('\n') + '\n');
process.exit(2);
