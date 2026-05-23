#!/usr/bin/env node
/**
 * wiki-query-first-nudge.mjs
 *
 * UserPromptSubmit hook. Fires BEFORE Claude sees the user's prompt.
 * Detects whether the current session is bound to an Obsidian vault in
 * one of two modes:
 *   - **cwd-is-vault**: the workspace itself is the vault (cwd contains
 *     `wiki-meta/index.md`).
 *   - **workspace-bound** (v0.11.6+): the workspace is a code/dev
 *     project ASSOCIATED with a vault via `OBSIDIAN_ROUTER_DEFAULT_VAULT`
 *     (set in the workspace `.env` by `setup-vault.mjs --link-workspace`).
 *
 * If either mode applies AND the prompt looks substantive (not trivial
 * follow-up like "oui"/"B"), injects a reminder into Claude's context
 * via `additionalContext` field (UserPromptSubmit spec) listing the 4
 * canonical wiki entry points (hot/index/log/overview) and the
 * appropriate read mechanism for the detected mode (filesystem `Read`
 * for cwd-is-vault, `mcp__obsidian-router__get_file({vault, path})` for
 * workspace-bound).
 *
 * Why this exists: Roland observed (2026-05-23) that in vault-bound
 * sessions, Claude answers from scratch without first checking if the
 * topic was already discussed in the vault — wasting prior research,
 * decisions, and references. Documenting the convention alone doesn't
 * fix the recall problem (same pattern as vault-link-linter). A
 * UserPromptSubmit hook is the deterministic catch outside the LLM
 * attention loop.
 *
 * v0.11.6: workspace-bound mode added after Roland pointed out that the
 * v0.11.5 cwd-is-vault detection missed the case where the workspace is
 * a code project associated with a vault (e.g. router repo associated
 * with the router project's wiki vault).
 *
 * Injection: emit JSON on stdout with `additionalContext` field per the
 * UserPromptSubmit spec. Claude sees the reminder alongside the user's
 * prompt and applies it.
 *
 * Exit codes:
 *   0  — always. Hook is informational only; never block the prompt.
 *
 * Opt-out: `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true` (truthy:
 *          true / 1 / yes / on).
 */

import fs from 'node:fs';

import {
  loadWorkspaceDotenv,
  readRouterConfig,
  detectVaultContext,
  defaultNameFromPath,
} from './_helpers/workspace-vault.mjs';

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

// Load workspace `.env` BEFORE checking vault context — this lets
// `OBSIDIAN_ROUTER_DEFAULT_VAULT` from `<cwd>/.env` participate in the
// detection without requiring it to be set in the parent shell.
loadWorkspaceDotenv(cwd);

// ---- Detect vault context (dual-mode) --------------------------------
const cfg = readRouterConfig();
const ctx = detectVaultContext(cwd, cfg);
if (!ctx) process.exit(0); // neither cwd-is-vault nor workspace-bound — silent

// ---- Filter: prompt must be substantive ------------------------------
const trimmed = prompt.trim();
if (!trimmed) process.exit(0);
if (trimmed.length < 20) process.exit(0);
if (trimmed.startsWith('/')) process.exit(0);

const TRIVIAL = /^\s*(oui|non|ok|d'?accord|merci|thanks|thank you|yes|no|continue|next|skip|pass|cancel|nevermind|nm)\b[\s.!?]*$/i;
if (TRIVIAL.test(trimmed)) process.exit(0);

// ---- Compose the nudge (mode-aware) -----------------------------------
// In cwd-is-vault mode, Claude can use either `Read` (filesystem) or
// MCP tools. In workspace-bound mode, cwd has no `wiki-meta/` so Claude
// MUST use `mcp__obsidian-router__get_file({vault: "<slug>", path: ...})`.
// We make this explicit in the nudge to prevent Claude from trying a
// `Read("wiki-meta/index.md")` that would fail with ENOENT in
// workspace-bound mode.
//
// v0.12.0: scaffold paths are `wiki-meta/{hot,index,log,overview}.md`,
// user content (notes/pages) stays under `wiki/...`.

const isWorkspaceBound = ctx.mode === 'workspace-bound';
const readGuidance = isWorkspaceBound
  ? `Use \`mcp__obsidian-router__get_file({ vault: "${ctx.slug}", path: "wiki-meta/<scaffold>" or "wiki/<page>" })\` to read vault files — the cwd has no \`wiki-meta/\` or \`wiki/\` directory, only the associated vault has the notes.`
  : `Use \`Read\` on \`wiki-meta/<scaffold>\` (or \`wiki/<page>\`) directly (cwd IS the vault), or \`mcp__obsidian-router__get_file({ path: "wiki-meta/<scaffold>" })\` for the same result via MCP.`;

const searchGuidance = isWorkspaceBound
  ? `Run \`mcp__obsidian-router__search_smart({ vault: "${ctx.slug}", query: "<keywords>" })\` for semantic-fit topics.`
  : `Run \`mcp__obsidian-router__search_smart({ query: "<keywords>" })\` (vault: omit, uses cwd default).`;

const modeLine = isWorkspaceBound
  ? `This workspace (cwd) is a code/dev project ASSOCIATED with the Obsidian vault \`${ctx.slug}\` (path: \`${ctx.vaultPath}\`). The vault holds the notes — cwd is just the code.`
  : `This workspace IS an Obsidian vault. Scaffolds live under \`wiki-meta/\`; user pages live under \`wiki/\`.`;

const indexReadHint = isWorkspaceBound
  ? `Read \`wiki-meta/index.md\` first — via \`mcp__obsidian-router__get_file({ vault: "${ctx.slug}", path: "wiki-meta/index.md" })\`.`
  : `Read \`wiki-meta/index.md\` first — via \`Read\` (filesystem) or \`mcp__obsidian-router__get_file({ path: "wiki-meta/index.md" })\`.`;

// v0.10.2: PATH RESOLUTION RULES (workspace-bound only)
// Triggered by Roland 2026-05-23 after Claude generated a filesystem path
// that concatenated the cwd path with a vault-internal subpath
// (`C:\Users\rolan\DEDIBOX/Stack/host.md` instead of
// `C:\VAULTS\DEDIBOX\wiki\Stack\host.md`). The cwd and the vault share
// the same basename (DEDIBOX) but live under different parents — easy to
// mix up at generation time. This block injects the two absolute roots
// + concrete WRONG/RIGHT examples so the LLM sees the trap explicitly.
//
// Only emitted in workspace-bound mode — in cwd-is-vault mode the two
// roots are identical so the confusion doesn't exist.
const pathRulesBlock = isWorkspaceBound ? [
  '',
  'PATH RESOLUTION RULES (workspace-bound — TWO ROOTS EXIST)',
  '',
  'The cwd and the vault have DIFFERENT absolute paths. NEVER concatenate',
  'the cwd path with a vault-internal subpath (`wiki/...`, `wiki-meta/...`)',
  '— that produces a non-existent filesystem path. They share the same',
  `basename (\`${defaultNameFromPath(ctx.vaultPath)}\`) but live under different parents.`,
  '',
  `  • Workspace cwd (code/dev repo):  ${cwd}`,
  '    Files at THIS root: top-level code/data only (no `wiki/` or',
  '    `wiki-meta/` subdirectory). Examples: README.md, package.json,',
  '    scripts/, .env, source files specific to the code project.',
  '',
  `  • Vault root (Obsidian notes):    ${ctx.vaultPath}`,
  '    Files at THIS root: `wiki/` (user pages), `wiki-meta/` (scaffolds),',
  '    `.obsidian/` (Obsidian config). Notes live under',
  '    `wiki/<folder>/<page>.md`.',
  '',
  'When referencing a vault page in chat, PREFER (in order):',
  '',
  '  1. Obsidian wikilink: `[[basename]]` — resolves by basename across',
  '     the vault, survives file renames/moves. ✅ Best default.',
  '  2. Click-to-open link: `[label](http://127.0.0.1:<insecurePort>/open/<url-encoded-vault-relative-path>)`',
  '     — cf ~/.claude/CLAUDE.md "Obsidian vault links" section. Reads the',
  `     port from \`${ctx.vaultPath}/.obsidian/plugins/obsidian-local-rest-api/data.json\``,
  '     `insecurePort` field. ✅ When a clickable cross-vault link is needed.',
  '  3. Absolute filesystem path: ONLY when explicitly requested AND',
  `     double-checked. The vault root is \`${ctx.vaultPath}\`, NOT \`${cwd}\`.`,
  '',
  'CONCRETE EXAMPLE of the trap to avoid:',
  '',
  `  ❌ WRONG: \`${cwd}/wiki/Stack/host.md\``,
  '            (mixes cwd path + vault-internal subpath — that folder',
  '            does not exist; the cwd has no `wiki/` subdir)',
  `  ❌ WRONG: \`${cwd}\\\\wiki\\\\Stack\\\\host.md\`  (same trap, all backslashes)`,
  `  ✅ RIGHT: \`${ctx.vaultPath}\\\\wiki\\\\Stack\\\\host.md\`  (real vault path)`,
  '  ✅ BEST:  `[[host]]`  (wikilink, basename resolution, no path concern)',
  '',
] : [];

const nudge = [
  `INVESTIGATION_REFLEX (mode: ${ctx.mode}) — ${modeLine}`,
  '',
  'Before answering the user prompt, check whether the topic has been',
  'discussed/documented in this vault. The 4 canonical entry points',
  '(scaffolds, separate from user content):',
  '',
  '  • `wiki-meta/hot.md`      — recent-context cache (likely already',
  '                               loaded via the hot-cache-load',
  '                               session-start hook).',
  '  • `wiki-meta/index.md`    — full catalog of pages organized by folder',
  '                               (people, concepts, sessions, decisions,',
  '                               refs, projects). Scan this first.',
  '  • `wiki-meta/overview.md` — executive summary of vault scope +',
  '                               conventions.',
  '  • `wiki-meta/log.md`      — append-only operation history. Useful',
  '                               when the user asks "what changed',
  '                               recently?".',
  '',
  'User notes/pages themselves live under `wiki/...` (e.g. `wiki/people/`,',
  '`wiki/concepts/`, `wiki/projects/...`). Use the index to find them.',
  ...pathRulesBlock,
  'Recommended pre-answer flow:',
  '',
  `  1. ${indexReadHint}`,
  '  2. If a folder/page looks relevant, read it directly with the same',
  '     mechanism, gather the relevant sections.',
  `  3. ${searchGuidance}`,
  '  4. Cite the notes found in your answer using the click-to-open link',
  '     format from ~/.claude/CLAUDE.md "Obsidian vault links" section.',
  '',
  'Skip this reflex ONLY if the prompt is a trivial follow-up (single',
  'word, slash command, "oui"/"non", typo fix request) — the hook',
  'already pre-filters most of those but lets borderline cases through',
  'with this nudge so you decide.',
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
