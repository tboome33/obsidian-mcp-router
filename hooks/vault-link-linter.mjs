#!/usr/bin/env node
/**
 * vault-link-linter.mjs
 *
 * Stop hook. Scans the assistant's last response text for vault-file
 * mentions that DON'T use the click-to-open link format documented in
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
 * Detection logic (avoiding false positives):
 *   - Strip fenced code blocks (```...```) and inline code (`...`).
 *   - Find markdown links `[label](href)` where:
 *     - `href` has no scheme (no `http://`, `https://`, `obsidian://`, etc.)
 *     - `href` ends in `.md`
 *     - `href` is relative (no leading `/` or `<drive>:` on Windows)
 *   - For each candidate, verify it points at a real file inside ANY
 *     configured vault (read `portRegistry` from the router config).
 *     This filesystem check is the actual safety net — if the path
 *     doesn't resolve to a vault file, it's not flagged.
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
 *   - **Markdown links only**. Bare path tokens in prose, tables, or
 *     lists (e.g. a row like `| wiki-meta/log.md | log file |`) are NOT
 *     flagged. Detecting those would generate too many false positives
 *     on legitimate path mentions inside conversational text. The
 *     screenshot motivating this hook actually showed table-cell bare
 *     paths — Claude is expected to use markdown links in tables too,
 *     and this hook only catches the markdown-link case. The user is
 *     the second line of defense for prose mentions.
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
// Pattern: [label](href.md) where href has no scheme and is relative.
// We do NOT scan for bare path tokens outside markdown links — too many
// false positives (paths inside conversational sentences, etc.). Markdown
// links are the explicit "I'm linking this file for the user" signal;
// they're what the convention targets.
const LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+\.md)\)/g;
const candidates = [];
for (const m of stripped.matchAll(LINK_PATTERN)) {
  const label = m[1];
  const href = m[2].trim();

  // Skip if href has a scheme (http://, https://, obsidian://, mailto:, etc.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
  // Skip absolute paths (POSIX leading /, Windows drive C:\... or UNC \\...)
  if (href.startsWith('/') || /^[a-z]:[\\/]/i.test(href) || href.startsWith('\\\\')) continue;
  // Skip wikilinks-mistakenly-written-as-md-links (unlikely but defensive)
  if (href.startsWith('#')) continue;

  candidates.push({ label, href });
}

if (candidates.length === 0) process.exit(0);

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
const violations = [];
for (const c of candidates) {
  const owner = findOwningVault(c.href);
  if (!owner) continue;
  const { vault, decodedHref } = owner;
  const info = vaultPortInfo(vault);
  if (!info) continue;

  // Encode for the URL: percent-encode segment by segment to preserve `/`
  // as `%2F` (the bridge plugin expects the path in URL-encoded form).
  // Reuse `decodedHref` from findOwningVault — that one was decoded via
  // safeDecodeURI (never throws). Doing a fresh decodeURIComponent here
  // would throw URIError on filenames containing literal `%` (e.g.
  // `wiki/100% done.md` — codex P2 review finding).
  const encodedPath = decodedHref.split(/[\\/]/).map(encodeURIComponent).join('%2F');

  let suggested;
  if (info.enableInsecureServer && info.insecurePort) {
    suggested = `[${c.label}](http://127.0.0.1:${info.insecurePort}/open/${encodedPath})`;
  } else if (info.port) {
    // HTTPS fallback — Bitdefender/Kaspersky/ESET may silently drop
    // self-signed HTTPS loopback (see CLAUDE.md global). Flag the caveat.
    suggested = `[${c.label}](https://127.0.0.1:${info.port}/open/${encodedPath})  ` +
      `# ⚠️ HTTPS fallback — enable insecureServer in this vault's data.json for reliable click-to-open`;
  } else {
    // Plugin data.json missing port info; skip the suggestion but still flag.
    suggested = null;
  }

  violations.push({
    label: c.label,
    bareHref: c.href,
    suggested,
    vault,
  });
}

if (violations.length === 0) process.exit(0);

// ---- Compose bilingual stderr feedback --------------------------------
const lines = [];
lines.push('[obsidian-mcp-router/vault-link-linter] Convention violation');
lines.push('');
lines.push(`FR — ${violations.length} fichier(s) vault mentionné(s) sans format click-to-open dans ta dernière réponse.`);
lines.push(`EN — ${violations.length} vault file(s) mentioned without click-to-open format in your last response.`);
lines.push('');
lines.push('Violations + corrections :');
for (const v of violations) {
  lines.push(`  • [${v.label}](${v.bareHref})`);
  if (v.suggested) {
    lines.push(`    → ${v.suggested}`);
  } else {
    lines.push(`    → (could not look up the vault's port — fix manually per ~/.claude/CLAUDE.md)`);
  }
}
lines.push('');
lines.push('Why : a bare relative path is not clickable in Claude Code. The');
lines.push('http://127.0.0.1:<insecurePort>/open/<URL-encoded-path> format is');
lines.push('dispatched to the browser, which hits the obsidian-mcp-router-bridge');
lines.push('plugin and Obsidian navigates to the file (1 click → file opens).');
lines.push('See ~/.claude/CLAUDE.md section "Obsidian vault links" for the full');
lines.push('convention. Please regenerate your response with the corrected links.');
lines.push('');
lines.push('Opt-out (per-session): OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true');

process.stderr.write(lines.join('\n') + '\n');
process.exit(2);
