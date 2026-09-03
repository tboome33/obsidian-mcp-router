#!/usr/bin/env node
/**
 * backfill-log-from-sessions.mjs (v0.12.8)
 *
 * One-shot opt-in script that walks a vault's `wiki-meta/Sessions/*.md`
 * files (closed sessions only) and appends a missing line for each one
 * to `wiki-meta/journal.md` — backfilling the cross-link that the
 * `session-auto-journal.mjs` hook now writes automatically at SessionEnd
 * (router v0.12.8+).
 *
 * Use this on vaults whose Sessions/ folder predates v0.12.8 (sessions
 * were captured but log.md was never updated). Safe to re-run: idempotent
 * via basename grep on log.md.
 *
 * Usage:
 *   node scripts/backfill-log-from-sessions.mjs --vault <slug-or-path> [--dry-run]
 *   node scripts/backfill-log-from-sessions.mjs --all                 [--dry-run]
 *   node scripts/backfill-log-from-sessions.mjs --all --include-open  [--dry-run]
 *
 * Behavior (default — closed sessions only):
 *   - Skips sessions whose `## H2` heading basename already appears in log.md
 *     as `[[<basename>]]` — idempotent
 *   - Reads the session file's frontmatter (`firstUserPrompt:` if present,
 *     `prompt:` fallback) for the "objectif"
 *   - Reads the session file's `## Recap (auto-generated)` block for the
 *     "résultat" (first counters line)
 *   - Marks backfilled entries with an HTML comment `<!-- backfilled YYYY-MM-DD -->`
 *     for audit trail
 *   - Appends in chronological order based on the session's `started-at`
 *
 * --include-open (v0.19.0): ALSO reconcile orphaned OPEN sessions — journals
 * left `status: open` because their `SessionEnd` hook never fired (terminal
 * closed, crash, kill). For each stale, non-live open session it closes the
 * file in place (status → closed + reconcile recap + ended-at + closed-by) AND
 * backfills its log.md line. Delegates to the shared
 * `hooks/_helpers/session-reconcile.mjs` module — the SAME routine the
 * `session-auto-journal` hook now runs automatically on every SessionStart.
 * A session whose state JSON was touched within the live window (default 120
 * min; override `--live-window-minutes N`) is treated as possibly running and
 * left alone. NOTE: unlike the default mode, --include-open DOES modify
 * session files (to close them).
 *
 * Default mode writes only to log.md. Silent skip on missing log.md (the wiki
 * skill is responsible for scaffolding it).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reconcileVaultSessions } from '../hooks/_helpers/session-reconcile.mjs';
import { resolveScaffold } from '../src/helpers/wiki-meta-scaffolds.mjs';
import { cmp } from '../src/helpers/total-order.mjs';
import { registeredVaultPaths, resolveVaultBySlug } from '../src/helpers/vault-slug.mjs';

// State dir where session-auto-journal.mjs persists per-session JSON (used by
// --include-open for recap enrichment + liveness). Mirrors the hook's path.
const STATE_DIR = path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'session-journals');

// v0.12.10 (review+ pass 1 — codex P2-3): honor OBSIDIAN_ROUTER_CONFIG
// like setup-vault.mjs and the hooks do, so users with a custom router
// config (CI, sandbox tests, multi-profile) don't get silently routed to
// the default config and backfill the wrong vaults.
function resolveConfigPath() {
  if (process.env.OBSIDIAN_ROUTER_CONFIG) {
    return path.resolve(process.env.OBSIDIAN_ROUTER_CONFIG);
  }
  return path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
}
const CONFIG_PATH = resolveConfigPath();

const COLORS = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m' };
const c = (color, s) => `${COLORS[color]}${s}${COLORS.reset}`;

function fail(msg) { console.error(c('red', '✗ ') + msg); process.exit(1); }
function ok(msg)   { console.log(c('green', '✓ ') + msg); }
function info(msg) { console.log(c('cyan', 'ℹ ') + msg); }

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return null; }
}

function resolveVaultPath(arg, cfg) {
  // If it looks like an absolute path that exists, use it directly.
  if (path.isAbsolute(arg) && fs.existsSync(arg)) return arg;
  // Otherwise treat as slug — resolved by the shared helper, which type-checks
  // the `vaultNames` value at the boundary. The loop that stood here read it
  // raw and called `.toLowerCase()` on it, so a hand-edited
  // `"vaultNames": { "<path>": 123 }` crashed this CLI with a TypeError before
  // it could say which vault it wanted. (v0.90.0)
  if (!cfg) return null;
  return resolveVaultBySlug(cfg, arg);
}

/**
 * Parse YAML-ish frontmatter (key: value only). Returns object or null.
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const block = content.slice(4, end);
  const out = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Extract the first meaningful "result line" from the auto-recap block.
 */
function extractRecapResult(content) {
  const recapIdx = content.indexOf('## Recap');
  if (recapIdx < 0) return null;
  const after = content.slice(recapIdx);
  // First bullet line under the recap heading
  const m = after.match(/^- \*\*([^*]+)\*\*\s*([^\n]+)/m);
  if (m) {
    // Combine the bolded label with its value
    return (m[1] + ' ' + m[2]).replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return null;
}

/**
 * Extract the first user prompt from the chrono section.
 */
function extractFirstPrompt(content) {
  const m = content.match(/^## \d{2}:\d{2}:\d{2} — User prompt\n+([^\n]+)/m);
  return m ? m[1].trim().slice(0, 120) : null;
}

/**
 * Reconstruct a single log.md entry for a session file.
 * Returns { entry: string, basename: string, sortKey: string } or null.
 */
function reconstructEntry(sessionPath) {
  const basename = path.basename(sessionPath, '.md');
  let content;
  try { content = fs.readFileSync(sessionPath, 'utf8'); }
  catch { return null; }

  const fm = parseFrontmatter(content) || {};
  if (fm.status && fm.status !== 'closed') return null; // skip open sessions

  // Objective: frontmatter firstUserPrompt → frontmatter prompt (legacy
  // pre-v0.12.8 sessions or manual notes) → chrono prompt → fallback.
  // v0.12.10 (review+ pass 1 — codex P3): the header documented `prompt:`
  // as a fallback but the code skipped it — adding now.
  const objective = (fm.firstUserPrompt && fm.firstUserPrompt.trim())
    || (fm.prompt && fm.prompt.trim())
    || extractFirstPrompt(content)
    || '(historical session — no objective captured)';

  // Result: recap first counters line → frontmatter duration
  let result = extractRecapResult(content);
  if (!result) {
    result = fm.duration ? `(no recap captured; duration ${fm.duration})` : '(no recap captured)';
  }

  // Sort key: prefer started-at, fall back to filename's date prefix
  const sortKey = fm['started-at'] || (basename.match(/^\d{4}-\d{2}-\d{2}-\d{4}/) || [''])[0];

  // Time portion for the entry's date header
  const dt = fm['started-at'] ? new Date(fm['started-at']) : null;
  let dateStr, timeStr;
  if (dt && !isNaN(dt.getTime())) {
    // v0.12.10 (review+ pass 1 — codex P2-2): derive date AND time from the
    // same local-tz Date instance — mixing UTC date + local hours creates a
    // wrong-day entry near local midnight.
    const pad2 = (n) => String(n).padStart(2, '0');
    dateStr = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    timeStr = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  } else {
    // Fallback: parse from filename `YYYY-MM-DD-HHMM-...`
    const fm2 = basename.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})/);
    dateStr = fm2 ? fm2[1] : 'unknown-date';
    timeStr = fm2 ? `${fm2[2]}:${fm2[3]}` : '00:00';
  }

  // v0.12.9 (review+ pass 1 — A1): mirror the sanitize from
  // hooks/session-auto-journal.mjs's `sanitizeForLogEntry` — defends
  // against markdown-injection from historical user prompts that get
  // surfaced into log.md via the backfill. Keep this in sync with the
  // hook function (no shared module yet — duplication acceptable for now).
  const sanitize = (s) => String(s == null ? '' : s)
    .replace(/\|/g, '\\|')
    .replace(/\[\[/g, '[​[')
    .replace(/\]\]/g, ']​]')
    .replace(/<!--/g, '<​!--')
    .replace(/-->/g, '-​->')
    .replace(/^(\s*)([-*#>])/, (_m, ws, ch) => `${ws}\\${ch}`);
  const safeObj = sanitize(objective);
  const safeRes = sanitize(result);
  const backfillDate = new Date().toISOString().slice(0, 10);
  const entry = (
    `\n- ${dateStr} ${timeStr} — session — [[${basename}]] — ${safeObj}\n` +
    `  → ${safeRes}  <!-- backfilled ${backfillDate} -->\n`
  );
  return { entry, basename, sortKey };
}

function backfillVault(vaultPath, { dryRun }) {
  const sessionsDir = path.join(vaultPath, 'wiki-meta', 'Sessions');
  // `wiki-meta/journal.md`, or the pre-0.58.0 `wiki-meta/log.md`.
  const logPath = resolveScaffold(vaultPath, 'journal', { fs, path })?.absPath ?? null;
  const result = { vaultPath, considered: 0, backfilled: 0, skipped: 0, openSkipped: 0, missingLog: false, missingSessions: false };

  if (!fs.existsSync(sessionsDir)) {
    result.missingSessions = true;
    return result;
  }
  if (!logPath) {
    result.missingLog = true;
    return result;
  }

  const existing = fs.readFileSync(logPath, 'utf8');
  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
  result.considered = files.length;

  const entries = [];
  for (const f of files) {
    const sessionPath = path.join(sessionsDir, f);
    const rec = reconstructEntry(sessionPath);
    if (!rec) { result.openSkipped += 1; continue; }
    if (existing.includes(`[[${rec.basename}]]`)) {
      result.skipped += 1;
      continue;
    }
    entries.push(rec);
  }

  // Append in chronological order (sortKey ascending)
  entries.sort((a, b) => cmp(a.sortKey, b.sortKey));

  if (entries.length === 0) return result;

  if (dryRun) {
    info(`[DRY-RUN] ${vaultPath} — would backfill ${entries.length} session(s):`);
    for (const e of entries) info(`  + ${e.basename}`);
    result.backfilled = entries.length;
    return result;
  }

  const concatenated = entries.map((e) => e.entry).join('');
  try {
    fs.appendFileSync(logPath, concatenated, 'utf8');
    result.backfilled = entries.length;
  } catch (err) {
    fail(`Failed to append to ${logPath}: ${err.message}`);
  }
  return result;
}

// --include-open path: delegate to the shared reconcile routine. Closes stale
// OPEN orphans (status → closed + recap) AND backfills log lines for both the
// just-closed sessions and any closed-but-unlogged ones. Returns a result
// shape compatible with the summary loop.
function reconcileVaultIncludingOpen(vaultPath, { dryRun, liveWindowMs }) {
  const sessionsDir = path.join(vaultPath, 'wiki-meta', 'Sessions');
  // `wiki-meta/journal.md`, or the pre-0.58.0 `wiki-meta/log.md`.
  const logPath = resolveScaffold(vaultPath, 'journal', { fs, path })?.absPath ?? null;
  const result = { vaultPath, considered: 0, backfilled: 0, skipped: 0, openSkipped: 0, reconciledOpen: 0, missingLog: false, missingSessions: false };

  if (!fs.existsSync(sessionsDir)) { result.missingSessions = true; return result; }
  if (!logPath) { result.missingLog = true; return result; }

  const backfillDate = new Date().toISOString().slice(0, 10);
  const r = reconcileVaultSessions({
    vaultPath,
    stateDir: STATE_DIR,
    ...(liveWindowMs != null ? { liveWindowMs } : {}),
    marker: `<!-- backfilled ${backfillDate} -->`,
    dryRun,
  });

  result.reconciledOpen = r.reconciledOpen.length;
  result.backfilled = r.reconciledOpen.length + r.closedLogged.length;
  result.skipped = r.alreadyLogged;
  result.openSkipped = r.skippedLive;
  result.considered = r.scanned + r.alreadyLogged;

  if (dryRun && result.backfilled > 0) {
    info(`[DRY-RUN] ${vaultPath} — would reconcile ${r.reconciledOpen.length} open + backfill ${r.closedLogged.length} closed session(s):`);
    for (const b of r.reconciledOpen) info(`  ~ ${b} (open→closed + log)`);
    for (const b of r.closedLogged) info(`  + ${b} (log only)`);
  }

  return result;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const includeOpen = args.includes('--include-open');
  const vaultIdx = args.indexOf('--vault');
  const isAll = args.includes('--all');

  // --live-window-minutes N : open sessions whose state JSON is fresher than
  // this are treated as possibly-live and left alone (default 120 in the
  // shared module). Only meaningful with --include-open.
  let liveWindowMs = null;
  const lwIdx = args.indexOf('--live-window-minutes');
  if (lwIdx >= 0) {
    const n = Number(args[lwIdx + 1]);
    if (Number.isFinite(n) && n >= 0) liveWindowMs = n * 60 * 1000;
  }

  if (!isAll && vaultIdx < 0) {
    fail('Usage:\n  backfill-log-from-sessions.mjs --vault <slug-or-path> [--include-open] [--dry-run]\n  backfill-log-from-sessions.mjs --all [--include-open] [--dry-run]');
  }

  const cfg = loadConfig();
  let vaults;
  if (isAll) {
    if (!cfg) fail(`Router config not found at ${CONFIG_PATH}. Run setup-vault.mjs --init-reference first.`);
    // Through the accessor: the container is validated, so a hand-edited
    // `"portRegistry": "AB"` yields no vaults instead of the paths "0" and "1".
    vaults = registeredVaultPaths(cfg);
    if (vaults.length === 0) fail('No vaults in portRegistry.');
  } else {
    const arg = args[vaultIdx + 1];
    if (!arg) fail('--vault requires a slug or absolute path argument.');
    const vp = resolveVaultPath(arg, cfg);
    if (!vp) fail(`No vault matched "${arg}".`);
    vaults = [vp];
  }

  const mode = includeOpen ? 'Reconciling (open + closed)' : 'Backfilling';
  console.log(c('bold',
    `\n${dryRun ? '[DRY-RUN] ' : ''}${mode} journal.md from Sessions/ for ${vaults.length} vault(s)...\n`));

  const totals = { backfilled: 0, skipped: 0, openSkipped: 0, reconciledOpen: 0, missingLog: 0, missingSessions: 0 };
  for (const vp of vaults) {
    const r = includeOpen
      ? reconcileVaultIncludingOpen(vp, { dryRun, liveWindowMs })
      : backfillVault(vp, { dryRun });
    totals.backfilled += r.backfilled;
    totals.skipped += r.skipped;
    totals.openSkipped += r.openSkipped;
    totals.reconciledOpen += (r.reconciledOpen || 0);
    if (r.missingLog) totals.missingLog += 1;
    if (r.missingSessions) totals.missingSessions += 1;
    if (r.missingSessions) {
      info(`${vp} — no wiki-meta/Sessions/ (skipping)`);
    } else if (r.missingLog) {
      info(`${vp} — no wiki-meta/journal.md (run the wiki scaffold first)`);
    } else if (!dryRun && r.backfilled > 0) {
      const openNote = includeOpen ? `, ${r.reconciledOpen} open→closed` : '';
      const skipLabel = includeOpen ? 'live skipped' : 'open skipped';
      ok(`${vp} — backfilled ${r.backfilled} entries${openNote} (${r.skipped} already present, ${r.openSkipped} ${skipLabel})`);
    } else if (r.backfilled === 0 && r.considered > 0) {
      info(`${vp} — all ${r.considered} sessions already logged${includeOpen ? ' or live' : ' or open'} (nothing to ${includeOpen ? 'reconcile' : 'backfill'})`);
    }
  }

  console.log('');
  console.log(c('bold', 'Summary:'));
  console.log(`  ${c('green',  'backfilled:        ' + totals.backfilled)}`);
  if (includeOpen) console.log(`  ${c('green', 'open→closed:       ' + totals.reconciledOpen)}`);
  console.log(`  ${c('gray',   'already-logged:    ' + totals.skipped)}`);
  console.log(`  ${c('gray',   (includeOpen ? 'live (skipped):    ' : 'open (skipped):    ') + totals.openSkipped)}`);
  if (totals.missingSessions > 0) console.log(`  ${c('yellow', 'no Sessions/:      ' + totals.missingSessions)}`);
  if (totals.missingLog > 0)      console.log(`  ${c('yellow', 'no journal.md:     ' + totals.missingLog)}`);

  if (dryRun) {
    console.log('');
    info('Dry-run only — re-run without --dry-run to apply.');
  }

  process.exit(0);
}

main();
