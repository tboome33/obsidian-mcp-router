#!/usr/bin/env node
/**
 * vault-link-linter.mjs
 *
 * Stop hook. Scans the assistant's last response text for vault-file
 * mentions that violate the click-to-open link convention documented in
 * `~/.claude/CLAUDE.md` ("Obsidian vault links" section). If violations
 * are found, blocks the response (exit 2) with a helpful stderr message
 * listing each violation and the corrected form — Claude then regenerates
 * the response with proper links before the user sees anything.
 *
 * Why this exists: the click-to-open convention is loaded into Claude's
 * context every session via the global CLAUDE.md, but Claude has an
 * attention bottleneck — when wrapping up a multi-step task (writes →
 * recap), the moment-of-application trigger for the rule sometimes
 * doesn't fire. This hook is a deterministic check OUTSIDE the LLM
 * attention loop, in the same spirit as `wiki-autocommit` and
 * `check-router-update`.
 *
 * Three violation kinds are detected (avoiding false positives by stripping
 * fenced code blocks, indented code, and inline code spans first):
 *
 *   1. **`bare-path`** (v0.11.3 — original) — markdown links `[label](href)`
 *      where `href` has no scheme, ends in `.md`, and is relative. Each
 *      candidate is verified against the filesystem to confirm it points
 *      at a real file inside an active vault (no false flag on prose
 *      paths that happen to look like .md links). Suggestion is the full
 *      click-to-open URL built from the vault's `insecurePort`.
 *
 *   2. **`wrong-port`** (v0.12.8 — added after Roland incident 2026-05-24
 *      where Claude generated `http://127.0.0.1:27143/...` instead of
 *      `27142` for the `opsidian-mcp-router et bridge` vault) — markdown
 *      links of the form
 *      `[label](http(s)://127.0.0.1:<port>/open/<encoded-path>)` where
 *      `<port>` doesn't match the actual `insecurePort` (for http) /
 *      `port` (for https) read from the target vault's
 *      `.obsidian/plugins/obsidian-local-rest-api/data.json`. Pre-v0.12.8
 *      these slipped through because the scheme-skip guard at the
 *      bare-path stage treated any `http://`-prefixed href as
 *      "already in the correct format". The v0.12.8 extension verifies
 *      the port instead of assuming it.
 *
 *   3. **`cwd-vault-mix`** (v0.18.1 — added after Roland incident
 *      2026-05-29 where Claude emitted
 *      `I:\DEVELOPPEMENT\obsidian-mcp-router\wiki\...\graph-viewer-survey.md`
 *      — the workspace cwd path concatenated with a vault-internal
 *      subpath) — an ABSOLUTE path (markdown-link href OR bare prose
 *      token) that starts with the workspace cwd, continues into a
 *      `wiki/` or `wiki-meta/` segment, does NOT exist on disk, yet whose
 *      vault-relative tail DOES resolve to a real file in the bound
 *      vault. In workspace-bound mode the cwd and the vault live at
 *      different absolute roots (often with near-identical basenames —
 *      `obsidian-mcp-router` vs `opsidian-mcp-router et bridge`), so this
 *      concatenation produces a phantom path the user cannot open. Pre-
 *      v0.18.1 these slipped through TWICE over: the bare-path pass skips
 *      any href with a drive-letter "scheme" (`I:` matches the scheme
 *      regex) or a leading `/`, and prose tokens outside markdown links
 *      were never scanned at all. The four-condition gate (cwd-prefixed +
 *      wiki/wiki-meta segment + phantom-on-disk + tail-resolves-in-vault)
 *      makes the detection zero-false-positive without needing a
 *      scheme/relative guard — a real local file under the cwd, or an
 *      absolute path to some other vault, never matches all four.
 *
 *   4. **`bare-vault-path`** (v0.21.1 — added after Roland incident
 *      2026-06-01 where Claude wrote `` `wiki-meta/index.md` `` and
 *      `` `wiki-meta/log.md` `` as backtick-wrapped relative paths in a
 *      chat recap) — a BARE RELATIVE path token (no scheme, not absolute)
 *      whose first segment is `wiki/` or `wiki-meta/` and which resolves
 *      to a real file in a vault OTHER than the cwd. The Claude Code
 *      renderer clickifies any file-like token — including text inside
 *      inline-code backticks — by rooting it at the workspace cwd, so in
 *      workspace-bound mode (cwd ≠ vault) a bare `wiki-meta/index.md`
 *      becomes a clickable `<cwd>/wiki-meta/index.md` that is a phantom
 *      (the code repo has no `wiki-meta/` dir). This slipped past every
 *      earlier pass TWICE over: (a) `stripCode()` deletes inline-code
 *      spans BEFORE detection, so the most common form (backtick-wrapped)
 *      was invisible; (b) the `bare-path` pass only scans markdown links
 *      `[label](href)` and the `cwd-vault-mix` pass only scans ABSOLUTE
 *      paths — a bare relative token matched neither. This pass scans a
 *      variant of the text with fenced/indented code stripped but
 *      INLINE-CODE PRESERVED (4a), plus the inline-stripped prose (4b),
 *      and is made zero-false-positive by three gates: the token resolves
 *      to a real vault file, that vault is NOT the cwd (so the renderer's
 *      cwd-rooted link is genuinely a phantom — in cwd-is-vault mode the
 *      link works and is left alone), and the token is not also a real
 *      local file under the cwd. Repo files like `README.md` or
 *      `src/registry.mjs` never match (wrong prefix / resolve under cwd).
 *
 * Exit codes:
 *   0  — no violations (or env var opt-out, or recursion guard)
 *   2  — violations found, stderr lists them; Claude Code re-runs the
 *        turn so Claude can fix the response.
 *
 * Opt-out: `OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true` (truthy values:
 * `true` / `1` / `yes` / `on`).
 *
 * Input (stdin, JSON from Claude Code):
 *   { hook_event_name: "Stop", transcript_path: "...", stop_hook_active: bool, ... }
 *
 * Recursion guard: if `stop_hook_active` is true (we already fired once
 * this turn), exit 0 silently — never block the same turn twice.
 *
 * Known gaps (intentional tradeoffs):
 *   - **`bare-path` / `wrong-port` are markdown-links-only.** Bare path
 *     tokens with an arbitrary (non-`wiki`) prefix or extension in prose
 *     are not flagged by those two kinds — too many false positives on
 *     legitimate relative-path mentions. BUT as of v0.21.1 the
 *     `bare-vault-path` kind DOES scan bare prose AND inline-code spans
 *     for relative paths whose first segment is `wiki/` or `wiki-meta/`
 *     and that resolve to a real file in a non-cwd vault (e.g. a token
 *     like `wiki-meta/log.md`, backtick-wrapped or not — the old example
 *     here, a `| wiki-meta/log.md |` table cell, is now correctly caught).
 *     Three gates keep it zero-false-positive: resolves-to-real-vault-file
 *     + vault-is-not-cwd + not-a-real-local-file. The `cwd-vault-mix` kind
 *     (v0.18.1) similarly scans bare prose for ABSOLUTE phantom paths. So
 *     the only prose mentions still unflagged are NON-vault relative paths
 *     (repo files, arbitrary `.md` names) — which the renderer links to
 *     the cwd correctly, so there is nothing to fix.
 *   - **Path traversal** (`../`) is refused at the filesystem-check
 *     step (any href that resolves outside its candidate vault root is
 *     skipped — see `findOwningVault`). Otherwise a hallucinated link
 *     to `../../etc/passwd.md` could surface a system path in stderr.
 *   - **Synergy with hot-cache-update-prompt.mjs**: both run on Stop
 *     in series. If the linter exit-2s, hot-cache's stdout nudge from
 *     this turn is effectively lost — but the nudge re-fires on the
 *     next Stop (the fingerprint is only stored after emission), so no
 *     permanent loss.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- Load workspace .env (without clobbering process.env) -------------
// The hook runs as a separate Node subprocess invoked by Claude Code,
// so it does NOT inherit the workspace `.env` file that the router
// binary loads itself. Common workspace-scoped variables relevant to
// the linter — `VAULT_PATH` (auto-set by `setup-vault.mjs` in each
// bootstrapped vault), `OBSIDIAN_ROUTER_DEFAULT_VAULT`,
// `OBSIDIAN_ROUTER_LOCKED`, `OBSIDIAN_ROUTER_ALLOWED_VAULTS`, etc. —
// need to be honored here too, otherwise the linter biases toward the
// wrong vault in multi-vault setups. Codex P2 review pass 3 finding.
//
// Standard dotenv semantics: file values fill in only UNSET keys —
// `process.env` always wins. Minimal parser (KEY=VALUE / # comments /
// optional `export ` prefix / optional surrounding quotes), no
// interpolation, no multi-line.
function loadWorkspaceDotenv() {
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const envPath = path.join(dir, '.env');
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env, nothing to do
  }
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadWorkspaceDotenv();

// ---- Opt-out ----------------------------------------------------------
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
if (TRUTHY.has(String(process.env.OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS || '').toLowerCase())) {
  process.exit(0);
}

// ---- Read hook input from stdin ---------------------------------------
let stdinRaw = '';
try {
  stdinRaw = fs.readFileSync(0, 'utf8');
} catch {
  // No stdin attached (manual invocation for debugging). Fail silent.
  process.exit(0);
}

let input;
try {
  input = JSON.parse(stdinRaw || '{}');
} catch {
  process.exit(0);
}

// Recursion guard: Claude Code sets `stop_hook_active: true` when this
// Stop hook fires a second time within the same turn. Don't loop.
if (input.stop_hook_active === true) process.exit(0);

const transcriptPath = input.transcript_path;
if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

// ---- Read last assistant text from transcript ------------------------
// Transcript is JSONL; iterate from the end to find the last assistant
// message with text content. Bail silently on parse errors — hooks
// must never disrupt Claude Code on infrastructure issues.
function lastAssistantText(jsonlPath) {
  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const msg = entry.message || entry;
    const chunks = Array.isArray(msg.content) ? msg.content : [];
    const text = chunks
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (text) return text;
  }
  return null;
}

const text = lastAssistantText(transcriptPath);
if (!text) process.exit(0);

// ---- Strip code blocks to avoid false positives -----------------------
// Order matters:
//   1. Indented code blocks first (4 spaces or tab at line start) — if we
//      stripped fenced blocks first, an indented fence start (`    ```)
//      could be mis-handled.
//   2. Fenced ``` and ~~~ blocks next (may contain inline backticks).
//   3. Inline `code` spans last on the remaining text.
function stripCode(s) {
  let out = s;
  // Markdown 4-space-indented code blocks: any line starting with at
  // least 4 spaces or a tab is code. Conservative: doesn't enforce the
  // "preceded by a blank line" rule of the CommonMark spec, but the
  // tradeoff is fewer false-positive lint flags inside indented examples
  // at the cost of occasionally stripping a deeply-indented list item
  // (rare, and the filesystem check downstream catches the difference).
  out = out.replace(/^(?: {4}|\t).*$/gm, '');
  // Fenced ``` blocks (and ~~~ blocks). Non-greedy: limits a missing
  // closing fence to the first subsequent fence rather than the rest of
  // the doc — best-effort, the filesystem check is the real safety net.
  out = out.replace(/```[\s\S]*?```/g, '');
  out = out.replace(/~~~[\s\S]*?~~~/g, '');
  // Inline `code` spans — be conservative: only single-backtick pairs on
  // a single line, to avoid mangling spans that span newlines (rare).
  out = out.replace(/`[^`\n]+`/g, '');
  return out;
}

const stripped = stripCode(text);

// ---- Find candidate vault-file links ----------------------------------
// Two scan passes:
//
//   Pass 1 (bare-path)  — `[label](href.md)` where href has no scheme
//                          and is relative. Existing v0.11.3 behavior.
//   Pass 2 (wrong-port) — `[label](http(s)://127.0.0.1:<port>/open/<encoded-path>)`
//                          where the port may be wrong. Added v0.12.8.
//
// We do NOT scan for bare path tokens outside markdown links — too many
// false positives (paths inside conversational sentences, etc.). Markdown
// links are the explicit "I'm linking this file for the user" signal;
// they're what the convention targets.
const LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+\.md)\)/g;
const bareCandidates = [];
for (const m of stripped.matchAll(LINK_PATTERN)) {
  const label = m[1];
  const href = m[2].trim();

  // Skip if href has a scheme (http://, https://, obsidian://, mailto:, etc.)
  // These are picked up by the click-to-open pass below (if they're
  // click-to-open URLs) or are intentional external links (skip silently).
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
  // Skip absolute paths (POSIX leading /, Windows drive C:\... or UNC \\...)
  if (href.startsWith('/') || /^[a-z]:[\\/]/i.test(href) || href.startsWith('\\\\')) continue;
  // Skip wikilinks-mistakenly-written-as-md-links (unlikely but defensive)
  if (href.startsWith('#')) continue;

  bareCandidates.push({ label, href });
}

// Pass 2 — click-to-open URLs that may carry a wrong port. The path
// component can include any non-paren, non-whitespace chars (typically
// percent-encoded `/` as `%2F`, the filename, and the `.md` suffix —
// but we don't require `.md` here because the bridge `/open/*` endpoint
// in principle accepts any vault file extension).
const CLICK_TO_OPEN_PATTERN =
  /\[([^\]\n]+)\]\((https?):\/\/127\.0\.0\.1:(\d+)\/open\/([^)\s\n]+)\)/g;
const clickToOpenCandidates = [];
for (const m of stripped.matchAll(CLICK_TO_OPEN_PATTERN)) {
  clickToOpenCandidates.push({
    label: m[1],
    scheme: m[2],
    actualPort: Number.parseInt(m[3], 10),
    encodedPath: m[4],
  });
}

// Pass 3 candidate collection (v0.18.1) — the cwd+vault-subpath "phantom
// path" trap. MUST run before the early-exit guard below: these candidates
// produce ZERO Pass-1/Pass-2 hits because an absolute Windows path's drive
// letter (`I:`) trips Pass 1's scheme guard and a POSIX `/...` path trips
// its leading-slash guard — so without counting them here, the guard would
// `exit(0)` before the trap is ever evaluated. The vault-membership CHECK
// (needs the resolved config) runs later, in Pass 3 proper. Scans BOTH
// markdown-link hrefs AND bare prose tokens (the incident showed a bare
// path). See the header doc for the four-condition gate.
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const cwdResolved = path.resolve(cwd);
const cwdPrefix = cwdResolved.endsWith(path.sep) ? cwdResolved : cwdResolved + path.sep;

const trapCandidates = [];
// 3a — markdown-link form `[label](ABS.md)`. `[^)\n]+?` allows spaces so a
// cwd containing spaces still matches inside the parens.
const TRAP_LINK_PATTERN = /\[([^\]\n]+)\]\(((?:[A-Za-z]:[\\/]|\/)[^)\n]+?\.md)\)/g;
for (const m of stripped.matchAll(TRAP_LINK_PATTERN)) {
  trapCandidates.push({ label: m[1], raw: m[2].trim() });
}
// 3b — bare-prose form `ABS.md` (no spaces, to avoid swallowing prose).
// Deduped against 3a hits by resolved path in the check loop below.
const TRAP_BARE_PATTERN = /(?:[A-Za-z]:[\\/]|\/)[^\s)<>"'\n]+?\.md/g;
for (const m of stripped.matchAll(TRAP_BARE_PATTERN)) {
  trapCandidates.push({ label: null, raw: m[0].trim() });
}

// Pass 4 candidate collection (v0.21.1) — bare RELATIVE vault paths
// (`wiki/...` or `wiki-meta/...`) that the Claude Code renderer clickifies
// against the cwd, producing a broken link in workspace-bound mode (cwd ≠
// vault). MUST run before the early-exit guard below (like Pass 3): these
// produce zero Pass-1/2/3 hits — a bare relative token is neither a
// markdown link (Pass 1) nor an absolute path (Pass 3), and the most
// common form lives inside inline-code backticks that `stripCode()`
// already deleted from `stripped`. The vault-membership CHECK runs later
// in Pass 4 proper (needs the resolved config). Two forms collected:
//   4a — backtick-delimited inline code: `wiki-meta/index.md` (spaces OK,
//        the backticks delimit the token). The dominant real-world form.
//   4b — un-backticked bare prose token: wiki-meta/index.md (no spaces).
const VAULT_REL_PATH_RE = /^(?:wiki-meta|wiki)[\\/].+\.md$/;
const barePassCandidates = [];
// 4a — scan a variant with fenced/indented code stripped but INLINE CODE
// PRESERVED (the opposite of `stripped`), so backtick-wrapped paths are
// visible. Fenced/indented blocks stay stripped so genuine code examples
// remain exempt (consistent with Passes 1-3).
let blocksStripped = text;
blocksStripped = blocksStripped.replace(/^(?: {4}|\t).*$/gm, '');
blocksStripped = blocksStripped.replace(/```[\s\S]*?```/g, '');
blocksStripped = blocksStripped.replace(/~~~[\s\S]*?~~~/g, '');
for (const m of blocksStripped.matchAll(/`([^`\n]+)`/g)) {
  const inner = m[1].trim();
  if (VAULT_REL_PATH_RE.test(inner)) barePassCandidates.push({ raw: inner, form: 'inline-code' });
}
// 4b — un-backticked prose tokens (no spaces). Scan `stripped` (inline code
// already removed) with markdown links ALSO removed, so a `[label](wiki/x.md)`
// link already handled by Pass 1 isn't double-flagged. The negative
// lookbehind rejects a `wiki`/`wiki-meta` segment sitting INSIDE a longer
// path (preceded by a separator/word char) — that's an absolute path
// (Pass 3) or a URL component, not a relative-path start.
const proseNoLinks = stripped.replace(/\[[^\]\n]+\]\([^)\n]+\)/g, '');
for (const m of proseNoLinks.matchAll(/(?<![\w%/\\.-])(?:wiki-meta|wiki)[\\/][^\s)\]>"'`]+?\.md/g)) {
  barePassCandidates.push({ raw: m[0].trim(), form: 'prose' });
}

if (
  bareCandidates.length === 0 &&
  clickToOpenCandidates.length === 0 &&
  trapCandidates.length === 0 &&
  barePassCandidates.length === 0
) process.exit(0);

// ---- Resolve which vault each candidate belongs to --------------------
// Read the router config (same lookup order as the router binary and
// scripts/setup-vault.mjs): OBSIDIAN_ROUTER_CONFIG env var first, then
// the user-home default.
const CONFIG_PATH = process.env.OBSIDIAN_ROUTER_CONFIG
  ? path.resolve(process.env.OBSIDIAN_ROUTER_CONFIG)
  : path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  // No router config — can't verify vault membership, skip the lint
  // silently. (User probably runs Claude Code without the router.)
  process.exit(0);
}

/**
 * Slug derivation matching the router's `defaultNameFromPath` + the
 * one duplicated inline in `scripts/setup-vault.mjs`. Kept inline so
 * this hook has zero runtime dependencies on src/ (so it works even
 * before `npm install` in fresh checkouts).
 *
 * TODO: extract the 3 copies (src/registry.mjs, scripts/setup-vault.mjs,
 * here) into a single src/helpers/vault-slug.mjs module. Out of scope
 * for this PR — see Reviewer A pass 2 NIT.
 */
function defaultNameFromPath(p) {
  const isWindows = /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
  const base = (isWindows ? path.win32 : path.posix).basename(p);
  return base.replace(/^\./, '').toLowerCase();
}

const allVaultPaths = Object.keys(cfg.portRegistry || {});
if (allVaultPaths.length === 0) process.exit(0);

/**
 * Filter the raw portRegistry down to the vaults the router would
 * actively expose in this session — same filtering as `loadRegistry()`
 * in src/registry.mjs. Without this, the linter could block on (or
 * suggest URLs for) vaults the router intentionally hides:
 *   - `cfg.disabledVaults: [name|path, ...]` — globally disabled per
 *     v0.5.0+ (entries may be slug NAME or absolute PATH).
 *   - `OBSIDIAN_ROUTER_ALLOWED_VAULTS=a,b,c` env var (v0.9.0+) —
 *     multi-tenant whitelist applied BEFORE default resolution.
 *
 * Codex P2 review finding 2026-05-23.
 */
function activeVaultPaths() {
  const vaultNames = cfg.vaultNames || {};
  const disabledSet = new Set();
  for (const entry of Array.isArray(cfg.disabledVaults) ? cfg.disabledVaults : []) {
    // Accept either form (slug or path) per setup-vault.mjs convention.
    if (typeof entry === 'string') disabledSet.add(entry);
  }
  const allowedRaw = process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS || '';
  const allowedSlugs = allowedRaw
    ? new Set(allowedRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : null; // null = whitelist not in effect (allow all)

  return allVaultPaths.filter((vp) => {
    const slug = vaultNames[vp] || defaultNameFromPath(vp);
    if (disabledSet.has(slug) || disabledSet.has(vp)) return false;
    if (allowedSlugs && !allowedSlugs.has(slug)) return false;
    return true;
  });
}

let vaultPaths = activeVaultPaths();
if (vaultPaths.length === 0) process.exit(0);

/**
 * Lock-mode filter (v0.8.0+). When `OBSIDIAN_ROUTER_LOCKED=<slug>` is
 * set (per-process via env, or persisted in workspace `.env` that we
 * loaded above), the router only honors that one vault — every other
 * tool call throws. The linter must mirror this: any link to a file
 * in another vault is OUTSIDE the lock scope and should not be
 * surfaced or auto-corrected as if it were a vault file at all.
 *
 * Codex P2 review pass 3 finding.
 *
 * Behavior:
 *   - Locked slug matches an active vault → restrict to that vault only.
 *   - Locked slug doesn't match any active vault → the router would
 *     fail to resolve too. Skip linting entirely (`exit 0`) — no safe
 *     suggestion to make.
 */
const lockedSlug = (process.env.OBSIDIAN_ROUTER_LOCKED || '').trim();
if (lockedSlug) {
  const vaultNames = cfg.vaultNames || {};
  const lockedPath = vaultPaths.find((vp) => {
    const slug = vaultNames[vp] || defaultNameFromPath(vp);
    return slug === lockedSlug;
  });
  if (!lockedPath) process.exit(0);
  vaultPaths = [lockedPath];
}

/**
 * Resolve the active default vault path, honoring the same cascade the
 * router uses for per-process default selection:
 *   1. `OBSIDIAN_ROUTER_DEFAULT_VAULT` env (slug) — explicit per-process.
 *   2. `VAULT_PATH` env (absolute path) — auto-detected by setup-vault
 *      in each bootstrapped vault's `.env`.
 *   3. `cfg.defaultVault` (slug) — global fallback from config.
 * Returns null if no tier matches the active vault set.
 *
 * Used to bias `findOwningVault` toward the current vault when multiple
 * vaults could own the same relative file (e.g. `wiki-meta/log.md` exists in
 * every router-bootstrapped vault). Codex P2 review finding 2026-05-23.
 */
function resolveDefaultVaultPath() {
  const vaultNames = cfg.vaultNames || {};

  // Tier 1: explicit env slug override
  const envSlug = (process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT || '').trim();
  if (envSlug) {
    for (const vp of vaultPaths) {
      const slug = vaultNames[vp] || defaultNameFromPath(vp);
      if (slug === envSlug) return vp;
    }
  }

  // Tier 2: VAULT_PATH env (absolute path). Use path.resolve on both
  // sides to normalize separators and trailing slashes before compare.
  const envPath = (process.env.VAULT_PATH || '').trim();
  if (envPath) {
    const target = path.resolve(envPath);
    for (const vp of vaultPaths) {
      if (path.resolve(vp) === target) return vp;
    }
  }

  // Tier 3: cfg.defaultVault slug
  if (cfg.defaultVault) {
    for (const vp of vaultPaths) {
      const slug = vaultNames[vp] || defaultNameFromPath(vp);
      if (slug === cfg.defaultVault) return vp;
    }
  }

  return null;
}

const defaultVaultPath = resolveDefaultVaultPath();

/**
 * Safe URI decode that never throws. Returns the original string on
 * malformed escapes (e.g. a literal `%` in a filename like
 * `wiki/100% done.md`).
 */
function safeDecodeURI(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * For a candidate href, find the configured vault that contains a file
 * at `<vault>/<href>` on disk. Returns `{ vault, decodedHref }` or null.
 *
 * Vault preference order:
 *   1. The `defaultVault` (per router config) — most likely correct in
 *      multi-vault setups where common files like `wiki-meta/log.md` exist
 *      in every vault.
 *   2. Otherwise, first matching vault in `portRegistry` insertion order.
 *
 * Decodes URL percent-encoding so links written with %20 / %2F still
 * resolve. Returns the decoded value so the caller doesn't re-decode
 * (which would throw on filenames containing literal `%`).
 *
 * Path-traversal guard: a malicious or hallucinated href like
 * `../../../Windows/System32/drivers/etc/hosts.md` would otherwise
 * resolve OUTSIDE the vault root after path.resolve, and `statSync`
 * could succeed on a real system file. The hook would then surface
 * that sensitive path in stderr and ship a bogus "fix" suggestion.
 * We refuse any resolved candidate that doesn't live strictly under
 * the vault root.
 */
function findOwningVault(href) {
  const decoded = safeDecodeURI(href);
  // Try default first, then the rest (deduped).
  const order = defaultVaultPath
    ? [defaultVaultPath, ...vaultPaths.filter((p) => p !== defaultVaultPath)]
    : vaultPaths;
  for (const vaultPath of order) {
    const candidate = path.resolve(vaultPath, decoded);
    const vaultResolved = path.resolve(vaultPath);
    const vaultPrefix = vaultResolved.endsWith(path.sep)
      ? vaultResolved
      : vaultResolved + path.sep;
    // The candidate must be inside (not equal to) the vault root.
    if (!candidate.startsWith(vaultPrefix)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return { vault: vaultPath, decodedHref: decoded };
    } catch {
      /* not a file in this vault */
    }
  }
  return null;
}

/**
 * Look up the insecurePort + enableInsecureServer of a vault's Local
 * REST API plugin. Returns { insecurePort, enableInsecureServer, port }
 * or null on any read/parse error.
 */
function vaultPortInfo(vaultPath) {
  const dataJson = path.join(
    vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json',
  );
  try {
    const data = JSON.parse(fs.readFileSync(dataJson, 'utf8'));
    return {
      port: data.port || null,
      insecurePort: data.insecurePort || null,
      enableInsecureServer: data.enableInsecureServer !== false,
    };
  } catch {
    return null;
  }
}

// ---- Build the correction list ----------------------------------------

/**
 * Compose the canonical click-to-open suggestion for a given (label,
 * relative-path, vault) triplet. Returns the markdown link string, or
 * null if the vault's REST API plugin doesn't expose enough info to build
 * one. Centralized here so both violation kinds emit consistent fixes.
 */
function composeSuggestion(label, decodedHref, info, querySuffix = '') {
  // Encode for the URL: percent-encode segment by segment to preserve `/`
  // as `%2F` (the bridge plugin expects the path in URL-encoded form).
  // We use the already-decoded href from `findOwningVault` (which used
  // safeDecodeURI). A fresh decodeURIComponent here would throw URIError
  // on filenames containing literal `%` (e.g. `wiki/100% done.md` —
  // codex P2 review finding).
  //
  // `querySuffix` (v0.22.0) preserves a trailing query string like
  // `?h=<heading>` (a heading anchor) so a wrong-port fix doesn't strip the
  // user's deep-link. Empty for the bare-path / cwd-mix / bare-vault kinds.
  // encodeURIComponent leaves `(` / `)` unescaped, which would terminate the
  // `[label](url)` destination early for a file/heading containing a paren
  // (e.g. `foo (draft).md`). Escape both so the suggested fix is valid
  // markdown — and so the CLICK_TO_OPEN_PATTERN above (which stops at `)`)
  // can re-capture the whole URL on a subsequent pass. Mirrors
  // encodeUriMarkdownSafe() in src/helpers/click-to-open.mjs.
  const mdSafe = (s) => encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29');
  const encodedPath = decodedHref.split(/[\\/]/).map(mdSafe).join('%2F');
  const suffix = querySuffix || '';

  if (info.enableInsecureServer && info.insecurePort) {
    return `[${label}](http://127.0.0.1:${info.insecurePort}/open/${encodedPath}${suffix})`;
  }
  if (info.port) {
    // HTTPS fallback — Bitdefender/Kaspersky/ESET may silently drop
    // self-signed HTTPS loopback (see CLAUDE.md global). Flag the caveat.
    return `[${label}](https://127.0.0.1:${info.port}/open/${encodedPath}${suffix})  ` +
      `# ⚠️ HTTPS fallback — enable insecureServer in this vault's data.json for reliable click-to-open`;
  }
  // Plugin data.json missing port info; can't build a suggestion.
  return null;
}

const violations = [];

// Pass 1 — bare-path violations (no scheme on a relative .md href).
for (const c of bareCandidates) {
  const owner = findOwningVault(c.href);
  if (!owner) continue;
  const { vault, decodedHref } = owner;
  const info = vaultPortInfo(vault);
  if (!info) continue;

  violations.push({
    kind: 'bare-path',
    label: c.label,
    bareHref: c.href,
    suggested: composeSuggestion(c.label, decodedHref, info),
    vault,
  });
}

// Pass 2 — click-to-open URLs with the wrong port (v0.12.8).
//
// Logic: extract the (scheme, port, encodedPath) from the URL, resolve
// the owning vault from the path, read the vault's REST API plugin
// `data.json`, and compare against the expected port for the scheme.
// If the expected port matches the actual port, the URL is correct —
// no violation. Otherwise flag it and propose the canonical version.
//
// Edge cases handled:
//   - Path doesn't resolve to any active vault → skip silently (a
//     hallucinated URL that doesn't reference a real file isn't this
//     hook's concern; matches the bare-path skip behavior).
//   - Vault's data.json unreadable → skip (can't verify either way).
//   - http:// scheme but the vault has `enableInsecureServer: false`
//     → flag as violation (the URL won't work anyway because the HTTP
//     server isn't listening); the suggestion will route through
//     `composeSuggestion` which surfaces the HTTPS fallback.
//   - https:// with a port that matches `insecurePort` but not `port`
//     → flag (user clearly intended HTTPS, port is wrong for HTTPS).
for (const c of clickToOpenCandidates) {
  // The encoded path may carry a query string (e.g. `?h=<heading>` for a
  // heading anchor, v0.22.0). Resolve the file by the PATH part only, but
  // keep the query so the suggested fix preserves the anchor. Without this
  // split, an anchored URL would never resolve (`wiki%2Ffoo.md?h=X` is not
  // a real file) and the wrong-port check would be silently skipped.
  const qIdx = c.encodedPath.indexOf('?');
  const encodedPathOnly = qIdx === -1 ? c.encodedPath : c.encodedPath.slice(0, qIdx);
  const queryStr = qIdx === -1 ? '' : c.encodedPath.slice(qIdx); // includes leading '?'

  const owner = findOwningVault(encodedPathOnly);
  if (!owner) continue;
  const { vault, decodedHref } = owner;
  const info = vaultPortInfo(vault);
  if (!info) continue;

  let expectedPort;
  let portIsValid;
  if (c.scheme === 'http') {
    expectedPort = info.insecurePort;
    // http only valid if insecureServer enabled AND port matches.
    portIsValid = info.enableInsecureServer && expectedPort === c.actualPort;
  } else {
    expectedPort = info.port;
    portIsValid = expectedPort === c.actualPort;
  }

  if (portIsValid) continue; // correct URL — no violation

  violations.push({
    kind: 'wrong-port',
    // bareHref intentionally uses the FULL c.encodedPath (query included) —
    // it's the "before" shown to the user, so it must echo their original
    // line verbatim. The query-stripped encodedPathOnly is only for the
    // filesystem resolution above.
    label: c.label,
    bareHref: `${c.scheme}://127.0.0.1:${c.actualPort}/open/${c.encodedPath}`,
    suggested: composeSuggestion(c.label, decodedHref, info, queryStr),
    vault,
    scheme: c.scheme,
    actualPort: c.actualPort,
    expectedPort,
  });
}

// Pass 3 — cwd + vault-subpath "phantom path" trap (v0.18.1). The
// CANDIDATES (cwd vars + trapCandidates) were collected earlier, above the
// "no candidates → exit" guard, because phantom paths produce zero
// Pass-1/Pass-2 hits (the drive-letter `I:` reads as a URL scheme, so Pass 1
// skips them). Here we run the vault-membership CHECK — it needs the
// resolved vault config (findOwningVault / vaultPortInfo) that only exists
// below. See the header doc for the four-condition gate and why this is a
// dedicated pass rather than a relaxation of the Pass-1 guards.
const trapSeen = new Set();
for (const cand of trapCandidates) {
  let resolved;
  try { resolved = path.resolve(cand.raw); } catch { continue; }
  if (trapSeen.has(resolved)) continue;
  // (1) must resolve under the cwd root.
  if (!resolved.startsWith(cwdPrefix)) continue;
  // (2) first segment below the cwd must be a vault-internal dir.
  const tail = resolved.slice(cwdPrefix.length);
  const firstSeg = tail.split(/[\\/]/)[0].toLowerCase();
  if (firstSeg !== 'wiki' && firstSeg !== 'wiki-meta') continue;
  // (3) a real local file under the cwd is NOT a phantom — leave it alone.
  if (fs.existsSync(resolved)) continue;
  // (4) the vault-relative tail must resolve to a real vault file.
  const owner = findOwningVault(tail);
  if (!owner) continue;
  const info = vaultPortInfo(owner.vault);
  if (!info) continue;

  trapSeen.add(resolved);
  const label = cand.label || path.basename(tail, '.md');
  violations.push({
    kind: 'cwd-vault-mix',
    label,
    bareHref: cand.raw,
    suggested: composeSuggestion(label, owner.decodedHref, info),
    vault: owner.vault,
    cwd: cwdResolved,
    firstSeg,
  });
}

// Pass 4 — bare relative vault-path violations (v0.21.1). Candidates
// (barePassCandidates) were collected earlier, above the no-candidates
// guard, because they produce zero Pass-1/2/3 hits. Three gates make this
// zero-false-positive (see header doc):
//   (a) NOT a real local file under the cwd — a genuine repo file, or the
//       cwd-is-vault case where the renderer's cwd-rooted link works.
//   (b) resolves to a real file in some active vault.
//   (c) that vault is NOT the cwd — the exact condition where the
//       renderer's cwd-rooted link is a phantom (workspace-bound mode).
const barePassSeen = new Set();
for (const cand of barePassCandidates) {
  const token = cand.raw;
  if (barePassSeen.has(token)) continue;
  // (a) skip a real local file under the cwd (repo file or cwd-is-vault).
  let localResolved;
  try { localResolved = path.resolve(cwd, safeDecodeURI(token)); } catch { continue; }
  if (fs.existsSync(localResolved)) continue;
  // (b) must resolve to a real file in an active vault.
  const owner = findOwningVault(token);
  if (!owner) continue;
  // (c) only flag when the owning vault is NOT the cwd.
  if (path.resolve(owner.vault) === cwdResolved) continue;
  const info = vaultPortInfo(owner.vault);
  if (!info) continue;

  barePassSeen.add(token);
  const label = path.basename(owner.decodedHref, '.md');
  violations.push({
    kind: 'bare-vault-path',
    label,
    bareHref: token,
    suggested: composeSuggestion(label, owner.decodedHref, info),
    vault: owner.vault,
    form: cand.form,
  });
}

if (violations.length === 0) process.exit(0);

// ---- Compose bilingual stderr feedback --------------------------------
const barePathCount = violations.filter((v) => v.kind === 'bare-path').length;
const wrongPortCount = violations.filter((v) => v.kind === 'wrong-port').length;
const trapCount = violations.filter((v) => v.kind === 'cwd-vault-mix').length;
const bareVaultCount = violations.filter((v) => v.kind === 'bare-vault-path').length;

const lines = [];
lines.push('[obsidian-mcp-router/vault-link-linter] Convention violation');
lines.push('');
lines.push(`FR — ${violations.length} violation(s) du format click-to-open dans ta dernière réponse :`);
if (barePathCount) lines.push(`  • ${barePathCount} lien(s) vault sans le format http://127.0.0.1:<port>/open/...`);
if (wrongPortCount) lines.push(`  • ${wrongPortCount} URL(s) click-to-open avec un mauvais port`);
if (trapCount) lines.push(`  • ${trapCount} chemin(s) absolu(s) mêlant le cwd et un sous-chemin vault (fichier fantôme, n'existe pas sur le disque)`);
if (bareVaultCount) lines.push(`  • ${bareVaultCount} chemin(s) vault relatif(s) nu(s) (ex. \`wiki-meta/index.md\`) — le renderer les rattache au cwd, pas au vault, donc le lien est cassé`);
lines.push('');
lines.push(`EN — ${violations.length} click-to-open convention violation(s) in your last response:`);
if (barePathCount) lines.push(`  • ${barePathCount} vault link(s) missing the http://127.0.0.1:<port>/open/... format`);
if (wrongPortCount) lines.push(`  • ${wrongPortCount} click-to-open URL(s) with the wrong port`);
if (trapCount) lines.push(`  • ${trapCount} absolute path(s) mixing the cwd with a vault subpath (phantom file, does not exist on disk)`);
if (bareVaultCount) lines.push(`  • ${bareVaultCount} bare relative vault path(s) (e.g. \`wiki-meta/index.md\`) — the renderer roots them at the cwd, not the vault, so the link breaks`);
lines.push('');
lines.push('Violations + corrections :');
for (const v of violations) {
  const tag = v.kind === 'wrong-port' ? '[wrong-port] '
    : v.kind === 'cwd-vault-mix' ? '[cwd+vault]  '
    : v.kind === 'bare-vault-path' ? '[bare-vault] '
    : '[bare-path]  ';
  lines.push(`  ${tag}• [${v.label}](${v.bareHref})`);
  if (v.kind === 'wrong-port') {
    lines.push(`                used port ${v.actualPort}, expected ${v.expectedPort ?? '?'} for ${v.scheme} (vault ${path.basename(v.vault)})`);
  }
  if (v.kind === 'cwd-vault-mix') {
    lines.push(`                phantom path — the cwd (${v.cwd}) has no \`${v.firstSeg}/\` subdir; this file lives in vault ${path.basename(v.vault)}, NOT under the cwd`);
  }
  if (v.kind === 'bare-vault-path') {
    lines.push(`                bare relative path${v.form === 'inline-code' ? ' (inside backticks)' : ''} — the renderer clickifies it to <cwd>/${v.bareHref} (phantom); the file lives in vault ${path.basename(v.vault)}`);
  }
  if (v.suggested) {
    lines.push(`               → ${v.suggested}`);
  } else {
    lines.push('               → (could not look up the vault\'s port — fix manually per ~/.claude/CLAUDE.md)');
  }
}
lines.push('');
lines.push('Why : a bare relative path is not clickable in Claude Code, and');
lines.push('a click-to-open URL with the wrong port silently fails (browser');
lines.push('hits nothing on 127.0.0.1:<wrong-port>); and an absolute path');
lines.push('mixing the cwd with a vault subpath (e.g. `<cwd>/wiki/x.md`)');
lines.push('points at a phantom file — the vault lives at a DIFFERENT');
lines.push('absolute root. The correct format is');
lines.push('http://127.0.0.1:<insecurePort>/open/<URL-encoded-path> where');
lines.push('<insecurePort> is read from the TARGET vault\'s data.json');
lines.push('(.obsidian/plugins/obsidian-local-rest-api/data.json). The port');
lines.push('differs per vault — NEVER reuse a port memorized from another');
lines.push('vault or session. See ~/.claude/CLAUDE.md section "Obsidian');
lines.push('vault links" for the full convention. Please regenerate your');
lines.push('response with the corrected links.');
lines.push('');
lines.push('Opt-out (per-session): OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true');

process.stderr.write(lines.join('\n') + '\n');
process.exit(2);
