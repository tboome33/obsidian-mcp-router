#!/usr/bin/env node
/**
 * decisions-recall.mjs
 *
 * UserPromptSubmit hook. Fires BEFORE Claude sees the user's prompt, and
 * surfaces the **already-settled decisions** that touch its subject.
 *
 * Why this exists. A wiki records what is known; the decision layer
 * (v0.49.0 contract + v0.50.0 rejected-options rule) records what is
 * settled and what was refused. But both are passive: a new session — or a
 * different agent, or the same one after a context reset — starts blank
 * and re-proposes an approach that was ruled out months ago. Writing the
 * decision down is necessary and insufficient; something has to *present*
 * it, unprompted, at the moment a prompt arrives. That is the whole ROI of
 * the practice, and it cannot come from a convention: a convention is a
 * nudge, and nudge ≠ enforce (same lesson as vault-link-linter and
 * wiki-query-first-nudge — both shipped as hooks for exactly this reason).
 *
 * Design constraints, each deliberate:
 *
 *   • **Deterministic first.** Candidates are filtered by settled status
 *     (`accepted` plus the legacy synonyms the linter still tolerates) then
 *     ranked by plain token overlap, with vault-wide vocabulary demoted. No
 *     embeddings, no model call: the hot path of every prompt is the wrong
 *     place for either, and a selection you cannot explain is a selection
 *     you cannot debug when it surfaces the wrong page.
 *   • **Expired ≠ silent, expired ≠ binding.** A decision past its
 *     `review_after:` date is still shown, flagged as due for
 *     re-evaluation. Hiding it would lose the context; presenting it as a
 *     constraint would ossify a ruling whose conditions have changed.
 *   • **Cited data, never instructions.** Vault pages are user content, and
 *     content read by an agent must never be able to direct it — otherwise
 *     the vault becomes a prompt-injection surface. The injected block says
 *     so explicitly, and asks the agent to *flag* disagreement rather than
 *     obey or silently contradict.
 *   • **Bounded and silent when empty.** A wall-clock deadline on the walk
 *     (with likely decision folders visited first), plus caps on bytes per
 *     file, decisions surfaced and characters injected; no output at all
 *     when nothing matches, so ordinary prompts pay nothing.
 *
 * Dual-mode, like `wiki-query-first-nudge`: works when the workspace IS the
 * vault, and when it is a code project bound to one via
 * `OBSIDIAN_ROUTER_DEFAULT_VAULT`.
 *
 * Exit codes:
 *   0  — always. Informational only; never blocks a prompt. Any unexpected
 *        error exits 0 silently: a recall hook that breaks the session it
 *        was meant to help is worse than one that misses a decision.
 *
 * Opt-out: `OBSIDIAN_ROUTER_NO_DECISIONS_RECALL=true` (truthy: true / 1 /
 *          yes / on).
 * Debug:   `OBSIDIAN_ROUTER_HOOK_DEBUG=true` prints a swallowed error to
 *          stderr instead of letting it look like "nothing matched".
 */

import fs from 'node:fs';

import {
  loadWorkspaceDotenv,
  readRouterConfig,
  detectVaultContext,
} from './_helpers/workspace-vault.mjs';

import {
  collectDecisions,
  selectRelevant,
  formatRecallBlock,
} from './_helpers/decisions-recall-core.mjs';

// The opt-out is re-checked after loadWorkspaceDotenv below, so that a
// project can disable this hook from its own `.env` like every other
// OBSIDIAN_ROUTER_* setting. This first check is the cheap parent-env
// path — it lets an opt-out short-circuit before we even read stdin.
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const optedOut = () =>
  TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_DECISIONS_RECALL || '').trim().toLowerCase());
if (optedOut()) process.exit(0);

let stdinRaw = '';
try { stdinRaw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
let input;
try { input = JSON.parse(stdinRaw || '{}'); } catch { process.exit(0); }

const prompt = typeof input.prompt === 'string' ? input.prompt : '';
const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Same substantive-prompt gate as wiki-query-first-nudge: a decision recall
// on "oui" or "/save" is pure noise.
const trimmed = prompt.trim();
if (!trimmed || trimmed.length < 20 || trimmed.startsWith('/')) process.exit(0);
const TRIVIAL = /^\s*(oui|non|ok|d'?accord|merci|thanks|thank you|yes|no|continue|next|skip|pass|cancel|nevermind|nm)\b[\s.!?]*$/i;
if (TRIVIAL.test(trimmed)) process.exit(0);

loadWorkspaceDotenv(cwd);
if (optedOut()) process.exit(0);

let block = null;
try {
  const ctx = detectVaultContext(cwd, readRouterConfig());
  if (!ctx) process.exit(0);

  const { decisions, scanned, truncated } = collectDecisions(ctx.vaultPath);
  if (truncated && TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_HOOK_DEBUG || '').toLowerCase())) {
    // A cut-short scan and an empty vault look identical from the outside;
    // on slow storage (virtual drives) that difference is the whole story.
    process.stderr.write(`[decisions-recall] scan cut short after ${scanned} files — recall may be incomplete\n`);
  }
  if (!decisions.length) process.exit(0);

  const selected = selectRelevant(decisions, trimmed);
  if (!selected.length) process.exit(0);

  block = formatRecallBlock(selected, { slug: ctx.slug, scanTruncated: truncated });
} catch (err) {
  // Still exit 0 — a recall hook must never break the session it serves —
  // but a swallowed TypeError is otherwise indistinguishable from "no
  // decision matched", which is how a broken hook stays broken for weeks.
  if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_HOOK_DEBUG || '').toLowerCase())) {
    process.stderr.write(`[decisions-recall] ${err?.stack || err}\n`);
  }
  process.exit(0);
}

if (!block) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: block,
  },
}));
process.exit(0);
