#!/usr/bin/env node
/**
 * wiki-query-first-nudge.mjs
 *
 * UserPromptSubmit hook. Fires BEFORE Claude sees the user's prompt.
 * When the workspace is an Obsidian vault (has `wiki/index.md`) AND
 * the prompt looks substantive (not trivial follow-up like "oui"/"B"),
 * injects a reminder into Claude's context asking it to consult the
 * wiki FIRST before composing its answer:
 *
 *   "Before answering, parcours wiki/index.md, then run search_smart
 *    on the keywords. Cite notes found. Skip if prompt is trivial."
 *
 * Why this exists: Roland observed (2026-05-23) that in vault-bound
 * sessions, Claude answers from scratch without first checking if the
 * topic was already discussed in the vault — wasting prior research,
 * decisions, and references. Documenting the convention alone doesn't
 * fix the recall problem (same pattern as vault-link-linter). A
 * UserPromptSubmit hook is the deterministic catch outside the LLM
 * attention loop.
 *
 * Injection mechanism: emit JSON on stdout with `additionalContext`
 * field (UserPromptSubmit spec). Claude sees the reminder alongside
 * the user's prompt and applies it.
 *
 * Exit codes:
 *   0  — always. Hook is informational only; never block the prompt.
 *        If the prompt isn't substantive (trivial follow-up, slash
 *        command, opt-out, non-vault workspace), exit 0 silent.
 *
 * Opt-out: `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true` (truthy:
 *          true / 1 / yes / on).
 *
 * Input (stdin, JSON from Claude Code UserPromptSubmit):
 *   {
 *     "hook_event_name": "UserPromptSubmit",
 *     "prompt": "Je veux créer une connexion RDP...",
 *     "cwd": "/current/working/directory",
 *     "session_id": "...",
 *     "transcript_path": "..."
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';

// ---- Opt-out ----------------------------------------------------------
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST || '').toLowerCase())) {
  process.exit(0);
}

// ---- Read hook input from stdin ---------------------------------------
let stdinRaw = '';
try { stdinRaw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
let input;
try { input = JSON.parse(stdinRaw || '{}'); } catch { process.exit(0); }

const prompt = typeof input.prompt === 'string' ? input.prompt : '';
const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ---- Filter: workspace must be a vault --------------------------------
// Heuristic: vault workspaces have `wiki/index.md` (Karpathy-style LLM
// wiki convention shipped by this router via setup-vault.mjs). Non-vault
// workspaces (regular code projects, etc.) don't get the nudge —
// would be irrelevant noise.
const wikiIndex = path.join(cwd, 'wiki', 'index.md');
if (!fs.existsSync(wikiIndex)) process.exit(0);

// ---- Filter: prompt must be substantive ------------------------------
// "Substantive" = warrants a wiki-search investigation. The opposite is
// trivial follow-ups (one-word ack, single-letter answer to a previous
// AskUserQuestion, slash command, etc.) that don't merit the nudge.
//
// Conservative heuristics (false negatives = no nudge on a real
// question = annoying but recoverable; false positives = nudge on
// trivial input = wasted context tokens):
//   - Strip leading/trailing whitespace.
//   - Skip if empty or < 20 chars (short = likely follow-up).
//   - Skip if starts with `/` (slash command).
//   - Skip if matches a known trivial pattern (oui / non / ok / merci /
//     continue / single letter / single digit).
const trimmed = prompt.trim();
if (!trimmed) process.exit(0);
if (trimmed.length < 20) process.exit(0);
if (trimmed.startsWith('/')) process.exit(0);

// Trivial-pattern allowlist: short affirmative/negative/control replies
// that bypass the length check (e.g. "oui s'il te plaît") — rare but
// possible. Case-insensitive, allows trailing punctuation.
const TRIVIAL = /^\s*(oui|non|ok|d'?accord|merci|thanks|thank you|yes|no|continue|next|skip|pass|cancel|nevermind|nm)\b[\s.!?]*$/i;
if (TRIVIAL.test(trimmed)) process.exit(0);

// ---- Compose the nudge ------------------------------------------------
// Wrapping in JSON with `additionalContext` per UserPromptSubmit spec:
// the text is injected alongside the prompt for Claude to read.
const nudge = [
  'INVESTIGATION_REFLEX: this workspace is an Obsidian vault. Before answering',
  'the user prompt, take a moment to check whether the topic has been discussed',
  'or documented in this vault. Recommended pre-answer flow:',
  '',
  '  1. Read `wiki/index.md` to get the catalog (likely cached via hot-cache-load).',
  '  2. If a folder/page looks relevant to the prompt, read it directly.',
  '  3. For semantic-fit topics, run `mcp__obsidian-router__search_smart` with',
  '     the keywords from the user prompt — vault: omit to use default vault.',
  '  4. Cite the notes you found in your answer (use the click-to-open link',
  '     format per ~/.claude/CLAUDE.md "Obsidian vault links" section).',
  '',
  'Skip this reflex ONLY if the prompt is a trivial follow-up (single word, slash',
  'command, "oui"/"non", typo fix request) — the hook already pre-filters most of',
  'those but lets borderline cases through with this nudge so you decide.',
  '',
  'Opt-out (per-session): set OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true.',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: nudge,
  },
}));
process.exit(0);
