/**
 * session-reconcile.mjs — shared self-healing reconciliation for the
 * per-session journal (`wiki-meta/Sessions/*.md`) ↔ `wiki-meta/journal.md`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `session-auto-journal.mjs` writes the session journal incrementally
 * (SessionStart → create, UserPromptSubmit/PostToolUse → append) but only
 * *finishes* a session in the `SessionEnd` handler: that's where the
 * frontmatter flips `status: open → closed`, the recap is inserted, and a
 * one-line summary is appended to `wiki-meta/journal.md`.
 *
 * The problem: Claude Code's `SessionEnd` hook is NOT guaranteed to fire.
 * It is skipped when the terminal window is closed abruptly, the process
 * is killed (hard Ctrl-C, OS shutdown, crash), or the machine loses power.
 * When `SessionEnd` never fires, a session is left half-finished:
 *   - journal file exists but stays `status: open` forever
 *   - no recap, no `ended-at`, no `duration`
 *   - NO `log.md` entry  ← the user-visible symptom: a Sessions/ file with
 *     no matching summary line in the chronological journal
 *   - its state JSON lingers in `~/.claude/obsidian-mcp-router/session-journals/`
 *
 * Observed in the wild (2026-05-29): a vault with 27 session files where
 * every `status: closed` file had a log.md line and every `status: open`
 * file did not — 11 orphans. The pre-existing `backfill-log-from-sessions`
 * script could not repair them because it skipped non-closed sessions.
 *
 * THE FIX: don't depend on `SessionEnd` alone. Reconcile on `SessionStart`
 * (self-healing) — every time a new session starts, sweep the vault's
 * Sessions/ folder for *stale, non-live* open sessions left behind by a
 * prior crash, close them properly, and backfill their log.md line. The
 * same routine powers the explicit `backfill-log-from-sessions --include-open`
 * sweep for repairing existing vaults in one shot.
 *
 * LIVENESS GUARD (don't clobber a concurrent session)
 * ---------------------------------------------------
 * A user can legitimately run two Claude Code sessions at once (two
 * terminals), so we must not "close" a session that's actually alive. The
 * reliable signal is the session's STATE JSON mtime: it is rewritten on
 * SessionStart and on every UserPromptSubmit/PostToolUse, so an active
 * session has a fresh state JSON. We skip any open session whose state
 * JSON was touched within `liveWindowMs` (default 120 min). A session with
 * NO state JSON at all is definitely dead (state is deleted only on a
 * clean SessionEnd, or was lost) → safe to reconcile. The current session
 * is additionally skipped by explicit `currentJournalPath`.
 *
 * Idempotent: log.md dedup is by `[[basename]]` grep; the frontmatter flip
 * is a no-op once `status: closed`; the recap is inserted at most once.
 *
 * Zero deps on src/. Pure functions where possible; all I/O is best-effort
 * and never throws (callers are hooks that must not block Claude Code).
 *
 * Introduced: router v0.19.0.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isRouterWriteTool } from './tool-names.mjs';
import { resolveScaffold, scaffoldWritePath } from '../../src/helpers/wiki-meta-scaffolds.mjs';
import { cmp } from '../../src/helpers/total-order.mjs';

// ---------------------------------------------------------------------------
// Pure helpers (single source of truth — imported by session-auto-journal.mjs
// so the hook and this module can never drift on sanitize/summary format)
// ---------------------------------------------------------------------------

export function pad2(n) { return String(n).padStart(2, '0'); }

export function truncate(s, max) {
  if (s == null) return '';
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

export function humanDuration(startIso, endIso) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${pad2(m)}m`;
}

/**
 * Sanitize a string before inserting it as the human-readable portion of a
 * log.md entry. Defends against four markdown-injection vectors that would
 * corrupt the surrounding bullet (see session-auto-journal.mjs v0.12.9 for
 * the full rationale): table pipes, parasitic wikilinks, HTML comments, and
 * a leading structural char (bullet/heading/quote). Insert U+200B between
 * the chars of each opening token — invisible in Obsidian but un-parseable.
 */
export function sanitizeForLogEntry(s) {
  if (s == null) return '';
  let out = String(s);
  out = out.replace(/\|/g, '\\|');
  out = out.replace(/\[\[/g, '[​[');
  out = out.replace(/\]\]/g, ']​]');
  out = out.replace(/<!--/g, '<​!--');
  out = out.replace(/-->/g, '-​->');
  out = out.replace(/^(\s*)([-*#>])/, (_m, ws, ch) => `${ws}\\${ch}`);
  return out;
}

/**
 * Parse YAML-ish frontmatter (key: value only, no nesting). Returns an
 * object or null. Mirrors the parser in backfill-log-from-sessions.mjs.
 */
export function parseFrontmatter(content) {
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
 * Compose the one-line "objectif" + "résultat" summary from a session state
 * object (the JSON persisted in the state dir, OR a pseudo-state
 * reconstructed from a journal file). Same logic the SessionEnd path uses.
 */
export function buildLogLineSummary(state, endedAt) {
  const objective = (state.firstUserPrompt && String(state.firstUserPrompt).trim())
    || '(no user prompt captured)';

  const c = state.counters || {};
  const parts = [];
  if (c.writes) parts.push(`${c.writes} writes`);
  if (c.mcpWrites) parts.push(`${c.mcpWrites} mcp writes`);
  if (c.bash) parts.push(`${c.bash} bash`);
  const fileCount = (state.files || []).length;
  if (fileCount) parts.push(`${fileCount} files`);
  const bashHint = (state.bashHighlights || [])[0];
  if (bashHint) {
    const flat = String(bashHint).replace(/\s+/g, ' ').trim();
    parts.push(`first bash: ${truncate(flat, 60)}`);
  }
  if (state.startedAt && endedAt) parts.push(humanDuration(state.startedAt, endedAt));

  const result = parts.length ? parts.join(' · ') : 'no-op session';
  return { objective, result };
}

/**
 * Build the 2-line log.md entry string (Format A — Karpathy-strict):
 *   - YYYY-MM-DD HH:MM — session — [[<basename>]] — <objective>
 *     → <result>  <!-- optional marker -->
 *
 * `endedAtMs` is a local timestamp in ms; date AND time are derived from the
 * SAME instant (never mix UTC date with local hours — wrong-day bug near
 * midnight). `objective`/`result` are sanitized here.
 */
export function composeSessionLogEntry({ basename, endedAtMs, objective, result, marker }) {
  const t = new Date(endedAtMs);
  const date = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
  const time = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  const safeObjective = sanitizeForLogEntry(objective);
  const safeResult = sanitizeForLogEntry(result);
  const tail = marker ? `  ${marker}` : '';
  return `\n- ${date} ${time} — session — [[${basename}]] — ${safeObjective}\n  → ${safeResult}${tail}\n`;
}

// ---------------------------------------------------------------------------
// Pseudo-state reconstruction (when the state JSON is gone but the journal
// file is on disk — e.g. an orphan older than the state dir, or a vault
// synced from another machine). We recover what we can by parsing the file.
// ---------------------------------------------------------------------------

const RE_PROMPT_HEADING = /^## \d{2}:\d{2}:\d{2} — User prompt/gm;
const RE_TOOL_HEADING = /^### \d{2}:\d{2}:\d{2} — tool: (.+)$/gm;
const RE_FIRST_PROMPT = /^## \d{2}:\d{2}:\d{2} — User prompt\n+([^\n]+)/m;

/**
 * Reconstruct an approximate session-state from a journal file's body. Used
 * only when no state JSON exists. Counters are recovered by counting the
 * chronological headings the hook wrote during the session.
 */
export function reconstructStateFromContent(content, fm) {
  const prompts = (content.match(RE_PROMPT_HEADING) || []).length;
  let toolCalls = 0;
  let writes = 0;
  let bash = 0;
  let mcpWrites = 0;
  let m;
  RE_TOOL_HEADING.lastIndex = 0;
  while ((m = RE_TOOL_HEADING.exec(content)) !== null) {
    toolCalls += 1;
    const tool = m[1];
    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') writes += 1;
    else if (tool === 'Bash') bash += 1;
    // Suffix match, not the old literal `mcp__obsidian-router__` prefix:
    // an orphaned journal can have been written by a session whose router
    // was plugin-provided or MCPHub-namespaced. See _helpers/tool-names.mjs.
    else if (isRouterWriteTool(tool)) mcpWrites += 1;
  }
  const firstPromptMatch = content.match(RE_FIRST_PROMPT);
  const firstUserPrompt = firstPromptMatch ? truncate(firstPromptMatch[1].trim(), 120) : null;

  return {
    counters: { prompts, toolCalls, writes, bash, mcpWrites, reads: 0 },
    files: [],
    bashHighlights: [],
    firstUserPrompt: firstUserPrompt || (fm && fm.firstUserPrompt) || (fm && fm.prompt) || null,
    startedAt: (fm && fm['started-at']) || null,
  };
}

// ---------------------------------------------------------------------------
// Journal-file mutation: close an orphaned session file in place
// ---------------------------------------------------------------------------

/**
 * Build the recap block inserted near the top of a reconciled journal. Marked
 * "(reconciled — no SessionEnd)" so it reads as auto-recovered, not a clean
 * close. Heading still starts with "## Recap" so the idempotence guard in
 * insertRecap matches and a re-run won't double-insert.
 */
function buildReconcileRecap(state, endedAt) {
  const c = state.counters || {};
  const breakdown = [];
  if (c.writes) breakdown.push(`${c.writes} writes`);
  if (c.bash) breakdown.push(`${c.bash} bash`);
  if (c.mcpWrites) breakdown.push(`${c.mcpWrites} mcp writes`);
  const breakdownStr = breakdown.length ? ` (${breakdown.join(', ')})` : '';
  const filesLine = (state.files || []).length
    ? '- **Files touched** (' + state.files.length + '): ' + state.files.slice(0, 15).map((f) => '`' + f + '`').join(', ')
      + (state.files.length > 15 ? ' …' : '')
    : null;
  const bashLine = (state.bashHighlights || []).length
    ? '- **Bash highlights**: ' + state.bashHighlights.map((b) => '`' + b + '`').join(' · ')
    : null;
  const duration = state.startedAt ? humanDuration(state.startedAt, endedAt) : 'unknown';

  const lines = [
    '',
    '## Recap (reconciled — no SessionEnd)',
    '',
    '> ⚠️ This session was closed by `session-reconcile` on a later SessionStart because its own `SessionEnd` never fired (terminal closed, crash, or kill). Counts below are best-effort.',
    '',
    `- **${c.prompts || 0} user prompts** · **${c.toolCalls || 0} tool calls**${breakdownStr}`,
    filesLine,
    bashLine,
    `- **Duration** (start → last activity): ${duration}`,
    '',
  ];
  return lines.filter((x) => x !== null).join('\n');
}

/**
 * Close an orphaned journal file in place: insert a reconcile recap after the
 * frontmatter (once) and flip the frontmatter to closed with ended-at,
 * duration, and `closed-by: reconciliation`. Idempotent. Best-effort; returns
 * true if it wrote, false otherwise.
 */
export function closeJournalFile(journalPath, { state, endedAt }) {
  let content;
  try { content = fs.readFileSync(journalPath, 'utf8'); }
  catch { return false; }
  if (!content.startsWith('---\n')) return false;
  const fmEnd = content.indexOf('\n---\n', 4);
  if (fmEnd < 0) return false;

  // 1. Insert recap after frontmatter (skip if a Recap section is already there).
  const head = content.slice(0, fmEnd + 5);
  let tail = content.slice(fmEnd + 5);
  if (!tail.startsWith('\n## Recap')) {
    tail = buildReconcileRecap(state, endedAt) + tail;
  }

  // 2. Rewrite frontmatter block: status → closed (+ append if missing),
  //    add ended-at / duration / closed-by when absent.
  let block = head.slice(4, head.length - 5); // strip leading '---\n' and trailing '\n---\n'
  if (/^status:/m.test(block)) {
    block = block.replace(/^status:.*$/m, 'status: closed');
  } else {
    block = block.replace(/\s*$/, '') + '\nstatus: closed';
  }
  block = block.replace(/\s*$/, '');
  if (!/^ended-at:/m.test(block)) block += `\nended-at: ${endedAt}`;
  if (!/^duration:/m.test(block)) {
    block += `\nduration: ${state.startedAt ? humanDuration(state.startedAt, endedAt) : 'unknown'}`;
  }
  if (!/^closed-by:/m.test(block)) block += '\nclosed-by: reconciliation';

  const newContent = '---\n' + block + '\n---\n' + tail;
  try { fs.writeFileSync(journalPath, newContent, 'utf8'); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// State-dir indexing
// ---------------------------------------------------------------------------

function normalizePath(p) {
  // Case-insensitive on Windows; collapse separators. Good enough to match a
  // state JSON's `journalPath` against a Sessions/ file path.
  return path.resolve(String(p)).replace(/[\\/]+/g, '/').toLowerCase();
}

/**
 * Index every state JSON in the state dir by its normalized `journalPath`.
 * Returns Map<normalizedJournalPath, { stateFile, mtimeMs, state }>. Silent
 * on a missing/garbage dir.
 */
export function indexStateFilesByJournal(stateDir) {
  const map = new Map();
  let names;
  try { names = fs.readdirSync(stateDir); }
  catch { return map; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const stateFile = path.join(stateDir, name);
    let state;
    let mtimeMs;
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      state = JSON.parse(raw);
      mtimeMs = fs.statSync(stateFile).mtimeMs;
    } catch { continue; }
    if (!state || !state.journalPath) continue;
    map.set(normalizePath(state.journalPath), { stateFile, mtimeMs, state });
  }
  return map;
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

const DEFAULT_LIVE_WINDOW_MS = 120 * 60 * 1000; // 120 min

/**
 * Reconcile a vault's session journals against log.md.
 *
 *   - OPEN + stale + not-live      → close the journal in place (status,
 *                                     recap, ended-at, closed-by) AND backfill
 *                                     its log.md line. (the SessionEnd-never-
 *                                     fired orphan — the core bug this fixes)
 *   - CLOSED + missing from log.md → backfill its log.md line only; the file
 *                                     is already closed, leave it untouched.
 *                                     (the pre-v0.12.8 "captured but never
 *                                     logged" case)
 *   - already in log.md            → fast-skip without even reading the file
 *   - OPEN + live (fresh state JSON within liveWindowMs) → left alone
 *   - the current session's journal → always skipped
 *
 * @param {object} opts
 * @param {string}  opts.vaultPath            absolute vault root
 * @param {string}  opts.stateDir             session-journals state dir (enrichment + liveness)
 * @param {string}  [opts.currentJournalPath] the live session's journal — always skipped
 * @param {number}  [opts.nowMs]              "now" in ms (injectable for tests; default Date.now())
 * @param {number}  [opts.liveWindowMs]       skip open sessions whose state JSON is fresher than this
 * @param {string}  [opts.marker]             audit comment appended to backfilled log lines
 * @param {boolean} [opts.dryRun]             compute only; no writes
 * @returns {{ scanned, reconciledOpen: string[], closedLogged: string[], skippedLive, skippedCurrent, alreadyLogged, deletedStaleState, missingSessions, missingLog }}
 */
export function reconcileVaultSessions(opts) {
  const {
    vaultPath,
    stateDir,
    currentJournalPath = null,
    nowMs = Date.now(),
    liveWindowMs = DEFAULT_LIVE_WINDOW_MS,
    marker = null,
    dryRun = false,
  } = opts || {};

  const result = {
    scanned: 0,
    reconciledOpen: [],
    closedLogged: [],
    skippedLive: 0,
    skippedCurrent: 0,
    alreadyLogged: 0,
    deletedStaleState: 0,
    missingSessions: false,
    missingLog: false,
  };

  const sessionsDir = path.join(vaultPath, 'wiki-meta', 'Sessions');
  // `wiki-meta/journal.md`, or the pre-0.58.0 `wiki-meta/log.md`.
  const logPath =
    resolveScaffold(vaultPath, 'journal', { fs, path })?.absPath ??
    scaffoldWritePath(vaultPath, 'journal', { path });

  let files;
  try { files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.md')); }
  catch { result.missingSessions = true; return result; }

  // The journal is optional: we can still close orphaned journals (flip
  // status + recap) even if no journal scaffold exists; we just can't append
  // a summary.
  let logContent = '';
  let logExists = false;
  try { logContent = fs.readFileSync(logPath, 'utf8'); logExists = true; }
  catch { result.missingLog = true; }

  const stateByJournal = indexStateFilesByJournal(stateDir);
  const currentNorm = currentJournalPath ? normalizePath(currentJournalPath) : null;

  const toAppend = []; // { entry, sortKey }
  const queued = new Set(); // basenames queued this run (dedup within the batch)

  function queueLogEntry(basename, endedAtMs, state) {
    if (!logExists) return;
    const endedAt = new Date(endedAtMs).toISOString();
    const { objective, result: summary } = buildLogLineSummary(state, endedAt);
    const entry = composeSessionLogEntry({ basename, endedAtMs, objective, result: summary, marker });
    const sortKey = state.startedAt
      || (basename.match(/^\d{4}-\d{2}-\d{2}-\d{4}/) || [''])[0]
      || basename;
    toAppend.push({ entry, sortKey });
    queued.add(basename);
  }

  for (const f of files) {
    const journalPath = path.join(sessionsDir, f);
    const basename = f.slice(0, -3); // strip .md
    const norm = normalizePath(journalPath);

    if (currentNorm && norm === currentNorm) { result.skippedCurrent += 1; continue; }

    // Fast path: a basename already in log.md (or queued this run) was closed +
    // logged properly, or reconciled on a prior run. Skip WITHOUT reading the
    // file — keeps SessionStart cheap even for vaults with thousands of sessions.
    if (logExists && (logContent.includes(`[[${basename}]]`) || queued.has(basename))) {
      result.alreadyLogged += 1;
      continue;
    }

    let content;
    try { content = fs.readFileSync(journalPath, 'utf8'); }
    catch { continue; }
    const fm = parseFrontmatter(content);
    // Only act on auto-journal sessions. Manual /save documents (decisions,
    // refs, answers) can live under Sessions/ but carry a different `type:`
    // and own their own curated log lines — never touch them.
    if (!fm || fm.type !== 'session') continue;
    result.scanned += 1;

    const status = (fm.status || 'open').toLowerCase();
    const stEntry = stateByJournal.get(norm);

    if (status === 'open') {
      // Liveness guard: a fresh state JSON means a session is actively writing
      // here right now (concurrent terminal) → leave it alone.
      if (stEntry && (nowMs - stEntry.mtimeMs) < liveWindowMs) {
        result.skippedLive += 1;
        continue;
      }
      // endedAt: best "last seen alive" — state JSON mtime, else file mtime.
      let endedAtMs;
      if (stEntry) endedAtMs = stEntry.mtimeMs;
      else { try { endedAtMs = fs.statSync(journalPath).mtimeMs; } catch { endedAtMs = nowMs; } }
      const endedAt = new Date(endedAtMs).toISOString();

      const state = stEntry ? stEntry.state : reconstructStateFromContent(content, fm);
      if (!state.startedAt && fm['started-at']) state.startedAt = fm['started-at'];

      if (!dryRun) {
        closeJournalFile(journalPath, { state, endedAt });
        // Consume the stale state JSON so it can't resurface as a phantom.
        if (stEntry) {
          try { fs.unlinkSync(stEntry.stateFile); result.deletedStaleState += 1; }
          catch { /* swallow */ }
        }
      }
      result.reconciledOpen.push(basename);
      queueLogEntry(basename, endedAtMs, state);
      continue;
    }

    // Closed but not in log.md (we only get here past the fast-skip when it's
    // absent): backfill its log line. Don't touch the file — already closed.
    let endedAtMs = null;
    if (fm['ended-at']) {
      const t = new Date(fm['ended-at']).getTime();
      if (Number.isFinite(t)) endedAtMs = t;
    }
    if (endedAtMs == null) {
      try { endedAtMs = fs.statSync(journalPath).mtimeMs; } catch { endedAtMs = nowMs; }
    }
    const state = reconstructStateFromContent(content, fm);
    if (!state.startedAt && fm['started-at']) state.startedAt = fm['started-at'];
    result.closedLogged.push(basename);
    queueLogEntry(basename, endedAtMs, state);
  }

  if (!dryRun && logExists && toAppend.length) {
    toAppend.sort((a, b) => cmp(String(a.sortKey), String(b.sortKey)));
    try { fs.appendFileSync(logPath, toAppend.map((e) => e.entry).join(''), 'utf8'); }
    catch { /* swallow — never block */ }
  }

  return result;
}
