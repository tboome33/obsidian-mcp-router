#!/usr/bin/env node
/**
 * session-auto-journal.mjs
 *
 * Multi-event hook that auto-writes one journal file per Claude Code
 * session under `<vault>/wiki/Sessions/`. Complements (does NOT replace)
 * the manual `/save` skill: this hook owns the chronological per-session
 * journal; `/save` owns polished, type-classified documents in
 * `wiki/Decisions/`, `wiki/Refs/`, `wiki/Answers/`, etc.
 *
 * Dispatches on `hook_event_name` from the stdin JSON payload:
 *
 *   - SessionStart:      create `<date>-<HHMM>-<workspace-slug>.md` with
 *                        an open frontmatter; record state.
 *   - UserPromptSubmit:  append `## HH:MM — User prompt` + verbatim prompt.
 *   - PostToolUse:       append `### HH:MM — tool: <name>` + concise args
 *                        for write-flavored tools (Write/Edit/Bash/MCP
 *                        write/patch/append). Reads skipped.
 *   - SessionEnd:        append closure marker, update frontmatter
 *                        `status: closed` + `ended-at` + `duration`, and
 *                        prepend a heuristic recap section right after
 *                        frontmatter (counts of prompts/tools, files
 *                        touched, bash highlights). Delete state file.
 *
 * Vault target (per workspace-bound design, picked 2026-05-23):
 *   - cwd-is-vault:    write under `<cwd>/wiki/Sessions/`
 *   - workspace-bound: write under `<associated-vault>/wiki/Sessions/`
 *   - else:            silent exit (the workspace has no associated vault)
 *
 * State management: one JSON file per active session at
 * `~/.claude/obsidian-mcp-router/session-journals/<session-id>.json`.
 * Cleaned up on SessionEnd.
 *
 * Privacy: user prompts and tool args are written VERBATIM. Don't paste
 * secrets in prompts if the vault syncs externally. Per the design
 * decision: "verbatim recommended, vaults locaux non-syncés extérieurement".
 *
 * Wire up in ~/.claude/settings.json:
 *   "SessionStart": [{ "matcher": "startup|resume|clear", "hooks": [
 *     { "type": "command", "command": "node \"<router>/hooks/session-auto-journal.mjs\"" }
 *   ]}],
 *   "UserPromptSubmit": [{ "matcher": "", "hooks": [
 *     { "type": "command", "command": "node \"<router>/hooks/session-auto-journal.mjs\"" }
 *   ]}],
 *   "PostToolUse": [{
 *     "matcher": "Write|Edit|MultiEdit|Bash|mcp__obsidian-router__write_file|mcp__obsidian-router__patch_file|mcp__obsidian-router__append_to_file|mcp__obsidian-router__set_frontmatter|mcp__obsidian-router__merge_frontmatter|mcp__obsidian-router__delete_file|mcp__obsidian-router__move_file",
 *     "hooks": [{ "type": "command", "command": "node \"<router>/hooks/session-auto-journal.mjs\"" }]
 *   }],
 *   "SessionEnd": [{ "matcher": "", "hooks": [
 *     { "type": "command", "command": "node \"<router>/hooks/session-auto-journal.mjs\"" }
 *   ]}]
 *
 * Opt-out per-session: set OBSIDIAN_ROUTER_NO_SESSION_JOURNAL=true.
 *
 * Cross-platform Node (no bash). Silent exit 0 on any failure — never
 * blocks Claude Code.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadWorkspaceDotenv,
  readRouterConfig,
  detectVaultContext,
} from './_helpers/workspace-vault.mjs';

// ---------------------------------------------------------------------------
// State directory
// ---------------------------------------------------------------------------

const STATE_DIR = path.join(
  os.homedir(),
  '.claude',
  'obsidian-mcp-router',
  'session-journals',
);

function stateFilePath(sessionId) {
  // Defensive: sanitize the session_id to avoid path traversal even though
  // Claude Code emits a UUID-like string.
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(STATE_DIR, `${safe}.json`);
}

function readState(sessionId) {
  try { return JSON.parse(fs.readFileSync(stateFilePath(sessionId), 'utf8')); }
  catch { return null; }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stateFilePath(state.sessionId), JSON.stringify(state, null, 2));
  } catch { /* swallow */ }
}

function deleteState(sessionId) {
  try { fs.unlinkSync(stateFilePath(sessionId)); }
  catch { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Time + slug helpers
// ---------------------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function hhmm(d = new Date()) {
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function hhmmColon(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function workspaceSlug(cwd) {
  // Use the cwd's directory name as the slug. Lowercase + replace
  // non-alphanumeric with `-`. Cap length at 40 to keep filenames sane.
  const base = path.basename(cwd) || 'workspace';
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
}

function humanDuration(startIso, endIso) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${pad2(m)}m`;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function readStdinPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function resolveCwd(payload) {
  if (typeof payload.cwd === 'string' && payload.cwd) return payload.cwd;
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// ---------------------------------------------------------------------------
// Tool-argument summarization (short, lossy, safe for verbatim)
// ---------------------------------------------------------------------------

function truncate(s, max) {
  if (s == null) return '';
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return `file: ${input.file_path || '?'}`;
    case 'Bash':
      return `\`\`\`bash\n${truncate(input.command || '', 200)}\n\`\`\``;
    case 'Read':
      return `file: ${input.file_path || '?'}`;
    default:
      // MCP router tools — most have a path or vault+path. Try common keys.
      if (input.path) return `path: ${input.path}${input.vault ? ` (vault: ${input.vault})` : ''}`;
      if (input.target) return `target: ${input.target}`;
      return truncate(JSON.stringify(input), 200);
  }
}

// Tools that get logged in the journal. Reads are intentionally absent
// (too noisy). The PostToolUse hook config also filters at the matcher
// layer; this is the second line of defense.
//
// v0.12.5 (review+ pass 1 fix — codex P2 #2): `execute_template` is a
// router-side write tool when called with `createFile: true` (it can
// materialize a file in the vault). Listing it here so its writes land
// in the journal. The matcher in hooks.example.json was widened to
// match.
const LOGGED_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'Bash',
  'mcp__obsidian-router__write_file',
  'mcp__obsidian-router__patch_file',
  'mcp__obsidian-router__append_to_file',
  'mcp__obsidian-router__set_frontmatter',
  'mcp__obsidian-router__merge_frontmatter',
  'mcp__obsidian-router__delete_file',
  'mcp__obsidian-router__move_file',
  'mcp__obsidian-router__execute_template',
]);

// ---------------------------------------------------------------------------
// Journal file creation
// ---------------------------------------------------------------------------

function buildOpeningContent(state) {
  const fm = [
    '---',
    'type: session',
    `date: ${state.dateIso}`,
    `session-id: ${state.sessionId}`,
    `workspace: ${state.workspaceSlug}`,
    `cwd: ${state.cwd}`,
    `started-at: ${state.startedAt}`,
    'status: open',
    '---',
    '',
    `# Session ${state.dateIso} ${state.startTime} — ${state.workspaceSlug}`,
    '',
    '> Auto-generated by `session-auto-journal.mjs` (router v0.12.4+). One file per Claude Code session, chronological. Polished documents go elsewhere — see `/save` skill for type-classified output (decisions, references, answers).',
    '',
    '## Chronological log',
    '',
  ].join('\n');
  return fm;
}

function ensureJournalForSession(payload) {
  const cwd = resolveCwd(payload);
  // v0.12.5 (review+ pass 2 — Reviewer A + codex pass 2 P3): when Claude
  // Code omits session_id (very rare), use a raw UUID as the fallback.
  // Earlier iterations tried `unknown-${Date.now()}` then
  // `fallback-${randomUUID()}` — both lost entropy at the downstream
  // `slice(0, 8)` because the deterministic prefix consumed the whole
  // window. A raw UUID (no prefix) preserves 32 bits of entropy in the
  // first 8 alphanum chars → fallback sessions can no longer share a
  // filename suffix.
  const sessionId = payload.session_id || randomUUID();

  // Existing state for this session?
  const existing = readState(sessionId);
  if (existing) return existing;

  loadWorkspaceDotenv(cwd);

  // Opt-out check
  if (String(process.env.OBSIDIAN_ROUTER_NO_SESSION_JOURNAL || '').toLowerCase() === 'true') {
    return null;
  }

  const cfg = readRouterConfig();
  const ctx = detectVaultContext(cwd, cfg);
  if (!ctx) return null; // no associated vault — silent skip

  const now = new Date();
  const slug = workspaceSlug(cwd);
  const dateIso = isoDate(now);
  const hh = hhmm(now);
  // v0.12.5 (review+ pass 1 fix — codex P2 #1): include a session-id
  // discriminator in the filename so two distinct sessions for the same
  // workspace started within the same minute don't collide on the same
  // journal file. Same session_id resolves to the same filename (idempotent
  // on resume); different session_ids produce different filenames.
  const sessionIdShort = String(sessionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'session0';
  const filename = `${dateIso}-${hh}-${slug}-${sessionIdShort}.md`;
  const sessionsDir = path.join(ctx.vaultPath, 'wiki', 'Sessions');
  const journalPath = path.join(sessionsDir, filename);

  try { fs.mkdirSync(sessionsDir, { recursive: true }); }
  catch { return null; }

  const state = {
    sessionId,
    cwd,
    vaultPath: ctx.vaultPath,
    vaultMode: ctx.mode,
    vaultSlug: ctx.slug,
    workspaceSlug: slug,
    journalPath,
    dateIso,
    startTime: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    startedAt: now.toISOString(),
    counters: { prompts: 0, toolCalls: 0, writes: 0, bash: 0, reads: 0, mcpWrites: 0 },
    files: [],
    bashHighlights: [],
  };

  // If the file already exists (rare: SessionStart with resume + we just
  // didn't have state JSON), don't overwrite. Else create fresh.
  if (!fs.existsSync(journalPath)) {
    try { fs.writeFileSync(journalPath, buildOpeningContent(state), 'utf8'); }
    catch { return null; }
  }

  writeState(state);
  return state;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function appendToJournal(state, content) {
  try { fs.appendFileSync(state.journalPath, content, 'utf8'); }
  catch { /* swallow */ }
}

function handleSessionStart(payload) {
  // Just ensures the journal exists. The ensureJournalForSession call is
  // itself the work — no extra append needed.
  ensureJournalForSession(payload);
}

// Cap on user-prompt bytes written verbatim to the journal. A user
// pasting a 50 MB log dump into a prompt would otherwise produce a
// journal markdown that Obsidian can't render. Truncating at ~100 KB
// keeps the journal usable while preserving the typical short prompt
// verbatim. The full content is still visible in Claude Code's own
// transcript on disk — the journal is a navigation aid, not the
// source of truth. (review+ pass 1 fix — Reviewer A IMPORTANT #5)
const MAX_PROMPT_BYTES = 100_000;

function handleUserPromptSubmit(payload) {
  const state = ensureJournalForSession(payload);
  if (!state) return;
  const promptRaw = String(payload.prompt || '').trim();
  if (!promptRaw) return;
  const prompt = promptRaw.length > MAX_PROMPT_BYTES
    ? promptRaw.slice(0, MAX_PROMPT_BYTES) +
      `\n\n> [truncated by session-auto-journal — original prompt was ${promptRaw.length} chars; full content in Claude Code transcript]\n`
    : promptRaw;

  const time = hhmmColon();
  const block = `\n## ${time} — User prompt\n\n${prompt}\n`;
  appendToJournal(state, block);

  state.counters.prompts = (state.counters.prompts || 0) + 1;
  writeState(state);
}

function handlePostToolUse(payload) {
  const state = ensureJournalForSession(payload);
  if (!state) return;
  const toolName = payload.tool_name || '';
  if (!LOGGED_TOOLS.has(toolName)) return;

  const time = hhmmColon();
  const summary = summarizeToolInput(toolName, payload.tool_input);
  const block = `\n### ${time} — tool: ${toolName}\n${summary}\n`;
  appendToJournal(state, block);

  // Update counters + collect highlights for the recap
  state.counters.toolCalls = (state.counters.toolCalls || 0) + 1;
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    state.counters.writes = (state.counters.writes || 0) + 1;
    const fp = payload.tool_input?.file_path;
    if (fp && !state.files.includes(fp)) state.files.push(fp);
  } else if (toolName === 'Bash') {
    state.counters.bash = (state.counters.bash || 0) + 1;
    const cmd = String(payload.tool_input?.command || '').trim();
    if (cmd && state.bashHighlights.length < 8) {
      // Keep up to 8 distinct bash commands as recap highlights, first
      // ~80 chars each (enough to recognize the command + first arg).
      const short = truncate(cmd, 80);
      if (!state.bashHighlights.includes(short)) state.bashHighlights.push(short);
    }
  } else if (toolName.startsWith('mcp__obsidian-router__')) {
    state.counters.mcpWrites = (state.counters.mcpWrites || 0) + 1;
    // v0.12.5 (review+ pass 1 fix — codex P3 #3 + P2 #2): different MCP
    // write tools use different schema keys for the target file path —
    // most use `path`, `move_file` uses `from`/`to`, `execute_template`
    // uses `targetPath` when `createFile: true`. Collect any key that
    // could name a vault file so the recap's "Files touched" list is
    // complete regardless of which write tool fired.
    const input = payload.tool_input || {};
    const candidates = [input.path, input.from, input.to, input.targetPath].filter(Boolean);
    for (const f of candidates) {
      if (!state.files.includes(f)) state.files.push(f);
    }
  }

  writeState(state);
}

function buildRecap(state, endedAt) {
  const c = state.counters || {};
  const totalTools = c.toolCalls || 0;
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

  const duration = humanDuration(state.startedAt, endedAt);

  const lines = [
    '',
    '## Recap (auto-generated)',
    '',
    `- **${c.prompts || 0} user prompts** · **${totalTools} tool calls**${breakdownStr}`,
    filesLine,
    bashLine,
    `- **Workspace**: \`${state.workspaceSlug}\` · **Duration**: ${duration}`,
    `- **Vault**: ${state.vaultMode === 'workspace-bound' ? state.vaultSlug : '(cwd-is-vault)'}`,
    '',
    '> Recap heuristique (counts + filesystem activity). Pour un résumé extractif LLM, lance `/save` sur cette session et choisis "polish recap".',
    '',
  ];
  return lines.filter((x) => x !== null).join('\n');
}

function rewriteFrontmatter(state, endedAt) {
  // Update the top frontmatter block: status open → closed, add
  // ended-at + duration. Keep other keys intact. Idempotent.
  let content;
  try { content = fs.readFileSync(state.journalPath, 'utf8'); }
  catch { return; }
  if (!content.startsWith('---\n')) return;
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return;
  let block = content.slice(4, end);
  // v0.12.5 (review+ pass 1 fix — Reviewer A IMPORTANT #2): if the user
  // (or some other code path) removed the `status:` key, the previous
  // `block.replace(/^status:.*$/m, ...)` was a silent no-op — the
  // journal stayed marked `open` forever. Fall back to appending the
  // key so SessionEnd always lands a `status: closed`.
  if (/^status:/m.test(block)) {
    block = block.replace(/^status:.*$/m, 'status: closed');
  } else {
    block += '\nstatus: closed';
  }
  block = block.replace(/\s*$/, '');
  if (!/^ended-at:/m.test(block)) block += `\nended-at: ${endedAt}`;
  const duration = humanDuration(state.startedAt, endedAt);
  if (!/^duration:/m.test(block)) block += `\nduration: ${duration}`;
  const newContent = '---\n' + block + '\n---\n' + content.slice(end + 5);
  try { fs.writeFileSync(state.journalPath, newContent, 'utf8'); }
  catch { /* swallow */ }
}

function insertRecapAfterFrontmatter(state, recap) {
  let content;
  try { content = fs.readFileSync(state.journalPath, 'utf8'); }
  catch { return; }
  if (!content.startsWith('---\n')) return;
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return;
  const head = content.slice(0, end + 5); // up to and including the closing `---\n`
  const tail = content.slice(end + 5);
  // Don't double-insert if a Recap section already exists at the top.
  if (tail.startsWith('\n## Recap')) return;
  try { fs.writeFileSync(state.journalPath, head + recap + tail, 'utf8'); }
  catch { /* swallow */ }
}

function handleSessionEnd(payload) {
  const sessionId = payload.session_id || '';
  const state = readState(sessionId);
  if (!state) return;
  const endedAt = new Date().toISOString();

  // Closing chronological marker
  const time = hhmmColon();
  appendToJournal(state, `\n## ${time} — Session closed\n\nReason: ${payload.reason || 'unknown'}\n`);

  // Heuristic recap inserted at the top (after frontmatter)
  const recap = buildRecap(state, endedAt);
  insertRecapAfterFrontmatter(state, recap);

  // Frontmatter status: closed + ended-at + duration
  rewriteFrontmatter(state, endedAt);

  deleteState(sessionId);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function main() {
  const payload = readStdinPayload();
  const event = payload.hook_event_name || '';

  try {
    switch (event) {
      case 'SessionStart':       handleSessionStart(payload); break;
      case 'UserPromptSubmit':   handleUserPromptSubmit(payload); break;
      case 'PostToolUse':        handlePostToolUse(payload); break;
      case 'SessionEnd':         handleSessionEnd(payload); break;
      default:
        // Unknown event — silent no-op so the same script can be wired
        // to additional events later without breaking.
        break;
    }
  } catch { /* never throw — silent best-effort */ }

  process.exit(0);
}

main();
