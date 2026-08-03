#!/usr/bin/env node
/**
 * wiki-query-first-nudge.mjs
 *
 * UserPromptSubmit hook. Fires BEFORE Claude sees the user's prompt.
 * Detects whether the current session is bound to an Obsidian vault in
 * one of two modes:
 *   - **cwd-is-vault**: the workspace itself is the vault (cwd contains
 *     `wiki-meta/catalog.md`).
 *   - **workspace-bound** (v0.11.6+): the workspace is a code/dev
 *     project ASSOCIATED with a vault via `OBSIDIAN_ROUTER_DEFAULT_VAULT`
 *     (set in the workspace `.env` by `setup-vault.mjs --link-workspace`).
 *
 * If either mode applies AND the prompt looks substantive (not trivial
 * follow-up like "oui"/"B"), injects a reminder into Claude's context
 * via `additionalContext` field (UserPromptSubmit spec) listing the 4
 * canonical wiki entry points (hot/catalog/journal/overview) and the
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
import path from 'node:path';

import {
  CATALOG_REL,
  JOURNAL_REL,
  isLegacyScaffoldPath,
  resolveScaffold,
  scaffoldMigrationHint,
} from '../src/helpers/wiki-meta-scaffolds.mjs';

import {
  loadWorkspaceDotenv,
  readRouterConfig,
  detectVaultContext,
  defaultNameFromPath,
} from './_helpers/workspace-vault.mjs';

/**
 * Read the vault's `obsidian-local-rest-api/data.json` and return the
 * insecure HTTP port (or null if the bridge isn't enabled / file is
 * missing / port is invalid). Used to pre-compute the click-to-open URL
 * prefix injected into the nudge — so the LLM never has to look it up.
 *
 * Same shape and safety guards as `src/helpers/click-to-open.mjs`, but
 * inlined here so the hook keeps zero runtime deps on src/ (hooks must
 * work pre-`npm install` in fresh checkouts — same convention as the
 * other hook helpers).
 */
function readInsecurePort(vaultPath) {
  if (!vaultPath || typeof vaultPath !== 'string') return null;
  const isWindowsStyle = /^[A-Za-z]:[\\/]/.test(vaultPath) || /^\\\\/.test(vaultPath);
  const lib = isWindowsStyle ? path.win32 : path.posix;
  const dataPath = lib.join(
    vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json',
  );
  try {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (data?.enableInsecureServer !== true) return null;
    const port = Number.isInteger(data?.insecurePort) ? data.insecurePort : null;
    if (port === null || port < 1 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
}

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
// `Read("wiki-meta/catalog.md")` that would fail with ENOENT in
// workspace-bound mode.
//
// Scaffold paths are `wiki-meta/{hot,catalog,journal,overview}.md` (v0.58.0;
// `{hot,index,log,overview}.md` before that),
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

// The compat layer keeps the CODE working on a vault still using the
// pre-0.58.0 names, but this text is an INSTRUCTION: naming the current file
// unconditionally would tell Claude to read a path that 404s there. Cite the
// name each scaffold actually has, and pass the migration hint along.
//
// Each slot is probed SEPARATELY. `ctx.legacyScaffold` reports the CATALOG
// only (that is the file vault detection keys on), and the two slots can
// legitimately disagree — a half-finished migration, or a vault where one
// file was renamed by hand. Deriving the journal from the catalog's flag
// sends the reader to a path that does not exist in either mixed state.
// (review+ pass 2, codex P2.)
const resolveRel = (which, fallback) =>
  resolveScaffold(ctx.vaultPath, which, { fs, path })?.relPath ?? fallback;
const catalogRel = resolveRel('catalog', CATALOG_REL);
const journalRel = resolveRel('journal', JOURNAL_REL);
const legacyPaths = [catalogRel, journalRel].filter(isLegacyScaffoldPath);
const legacyNote = legacyPaths.length
  ? `\n\n⚠ ${legacyPaths.map(scaffoldMigrationHint).join('\n⚠ ')}`
  : '';

const indexReadHint = isWorkspaceBound
  ? `Read \`${catalogRel}\` first — via \`mcp__obsidian-router__get_file({ vault: "${ctx.slug}", path: "${catalogRel}" })\`.`
  : `Read \`${catalogRel}\` first — via \`Read\` (filesystem) or \`mcp__obsidian-router__get_file({ path: "${catalogRel}" })\`.`;

// v0.10.2: PATH RESOLUTION RULES (workspace-bound only)
// Triggered by Roland 2026-05-23 after Claude generated a filesystem path
// that concatenated the cwd path with a vault-internal subpath
// (`C:\Users\me\DEDIBOX/Stack/host.md` instead of
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

// v0.14.8: CHAT RESPONSE LINK FORMAT — applies in BOTH modes.
//
// Triggered by Roland 2026-05-26 after the 10th time the LLM cited a vault
// file as a bare path (`wiki/Divers/LIGHTRAG/lightrag.md`) in chat. The
// Claude Code renderer auto-clickifies these and prepends the cwd → produces
// `<cwd>/wiki/...` which doesn't exist (in workspace-bound mode) or which
// opens in the OS file viewer instead of Obsidian (in cwd-is-vault mode).
// Either way, the link is broken from the user's perspective.
//
// The fix lives in three layers:
//   1. write/get/patch/etc. tool results now carry a `clickToOpenUrl` field
//      ready to paste verbatim. The LLM never composes the URL by hand.
//   2. `mcp__obsidian-router__build_open_link({ vault, paths: [...] })` builds
//      URLs for files the LLM didn't just touch (typically cross-references).
//   3. THIS hook injects the rule + pre-computed URL prefix so the LLM has
//      everything in attention when it composes the chat response.
//
// The pre-computed URL_PREFIX is injected ONLY when the bridge is actually
// reachable (port read OK + enableInsecureServer:true). When unavailable,
// emit a fallback paragraph telling the LLM to use `obsidian://` URIs
// inline-code or to ask the user to enable the insecure server.
const insecurePort = readInsecurePort(ctx.vaultPath);
const urlPrefix = insecurePort
  ? `http://127.0.0.1:${insecurePort}/open/`
  : null;

const chatLinkBlock = urlPrefix ? [
  '',
  'CHAT RESPONSE LINK FORMAT (applies to YOUR REPLIES, not to tool calls)',
  '',
  'When citing a vault file in your reply to the user, NEVER write the path',
  'as bare text like `wiki/Divers/foo.md` or `wiki-meta/catalog.md`. The',
  'Claude Code renderer turns those into clickable links by prepending the',
  isWorkspaceBound
    ? 'cwd path → produces `<cwd>/wiki/Divers/foo.md` which does NOT exist in this workspace (the vault is at a different absolute path). User clicks → broken link.'
    : 'cwd path → produces a filesystem link that opens in the OS file viewer instead of in Obsidian, missing wikilink resolution, backlinks, plugins, etc. User clicks → wrong app.',
  '',
  'ALWAYS use one of these formats instead:',
  '',
  '  ✅ BEST when the file is in *this* vault and you have the URL handy:',
  '     `[label](URL)` markdown link, where URL is the click-to-open URL.',
  '     Three ways to get the URL without composing it by hand:',
  '       (a) tool results from write_file / get_file / patch_file /',
  '           append_to_file / move_file / set_frontmatter / merge_frontmatter /',
  '           get_frontmatter / execute_template now carry a',
  '           `clickToOpenUrl` field — copy that verbatim.',
  '       (b) search / search_smart return a `clickToOpenLinks` map at the',
  '           response top level: { "<path>": "<url>", ... }. Look up the',
  '           path of any hit you want to cite.',
  '       (c) for any other file (cross-references, wikilink targets you',
  '           didn\'t fetch): call `mcp__obsidian-router__build_open_link`',
  '           with `{ paths: [...] }` to batch-build URLs in ONE call.',
  '',
  '  ✅ BEST when writing INSIDE a vault note (markdown body): `[[basename]]`',
  '     Obsidian wikilink. Resolves by basename, survives renames. Use ONLY',
  '     inside note bodies you write to the vault, NOT in chat replies — chat',
  '     wikilinks don\'t resolve to anything.',
  '',
  `  Pre-computed URL prefix for this vault: \`${urlPrefix}\``,
  `  Encode the vault-relative path with encodeURIComponent (slashes → %2F,`,
  `  spaces → %20). Then concatenate: \`${urlPrefix}<encoded-path>\`.`,
  '',
  'CONCRETE WRONG/RIGHT chat reply examples (using a real path from this vault):',
  '',
  '  ❌ WRONG: "Created the note at `wiki/Divers/foo.md`."',
  '            (bare path → Claude Code clickifies → broken link)',
  isWorkspaceBound
    ? `  ❌ WRONG: "Created at \`${cwd}/wiki/Divers/foo.md\`."  (cwd+vault mix → 404)`
    : `  ❌ WRONG: "Created at \`${cwd}\\\\wiki\\\\Divers\\\\foo.md\`."  (filesystem link, won't open in Obsidian)`,
  `  ✅ RIGHT: "Created [foo](${urlPrefix}wiki%2FDivers%2Ffoo.md)."`,
  '',
  'This is the single most repeated correction in vault sessions. Every',
  'bare-path citation in a chat reply is a dead link the reader has to work',
  'around. Use the URL — your tool results already carry it.',
  '',
] : [
  '',
  'CHAT RESPONSE LINK FORMAT — DEGRADED (insecure HTTP server not reachable)',
  '',
  `Could not read \`insecurePort\` from \`${ctx.vaultPath}/.obsidian/plugins/obsidian-local-rest-api/data.json\``,
  `(file missing, JSON broken, or \`enableInsecureServer\` is not true).`,
  '',
  'Without the bridge\'s HTTP route, click-to-open links can\'t be built.',
  'Fall back to one of these in your chat replies:',
  '',
  `  • \`obsidian://open?vault=<encoded-vault-name>&file=<encoded-path>\` URI`,
  '    as INLINE CODE (NOT as a markdown link — those don\'t render in the',
  '    terminal). The user copy-pastes into Win+R or equivalent.',
  '  • Tell the user to enable the insecure HTTP server by editing',
  `    \`${ctx.vaultPath}/.obsidian/plugins/obsidian-local-rest-api/data.json\``,
  `    and setting \`"enableInsecureServer": true\` + \`"insecurePort": <port>\`,`,
  '    then reloading Obsidian. The /open route only works through the HTTP',
  '    server (HTTPS self-signed certs get killed by AV silently).',
  '',
];

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
  `  • \`${catalogRel}\`    — full catalog of pages organized by folder`,
  '                               (people, concepts, sessions, decisions,',
  '                               refs, projects). Scan this first.',
  '  • `wiki-meta/overview.md` — executive summary of vault scope +',
  '                               conventions.',
  `  • \`${journalRel}\`      — append-only operation history. Useful`,
  '                               when the user asks "what changed',
  '                               recently?".',
  '',
  'User notes/pages themselves live under `wiki/...` (e.g. `wiki/people/`,',
  '`wiki/concepts/`, `wiki/projects/...`). Use the index to find them.',
  ...pathRulesBlock,
  ...chatLinkBlock,
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
].join('\n') + legacyNote;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: nudge,
  },
}));
process.exit(0);
