/**
 * hot-staleness.mjs
 *
 * Pure logic for the deterministic hot-cache freshness guard
 * (`hooks/hot-cache-update-prompt.mjs`, v0.25.0). Extracted here so it can
 * be unit-tested without spawning the hook or touching the filesystem.
 *
 * The guard answers ONE question from a session transcript:
 *   "Did this session write a NOTE under some vault's `wiki/` directory
 *    WITHOUT also refreshing that vault's `wiki-meta/hot.md`?"
 *
 * If yes for ≥1 vault, the Stop hook blocks (exit 2) so Claude refreshes
 * hot.md before the turn ends — the recent-context cache stays current by
 * construction.
 *
 * Design notes:
 *   - Detection is TRANSCRIPT-SCOPED (this session's `tool_use` blocks),
 *     never git — so a concurrent session's uncommitted changes or a manual
 *     Obsidian edit can never cause a false block (Claude can only fix what
 *     it itself wrote).
 *   - TRIGGER = a NOTE-BODY write under `wiki/<...>`. The tracked tools are
 *     `write_file`/`patch_file`/`append_to_file`, the built-in
 *     `Write`/`Edit`/`MultiEdit`, and `execute_template` (only when
 *     `createFile:true`, via its `targetPath`). `move_file`, `delete_file`,
 *     `set_frontmatter`, `merge_frontmatter` are deliberately NOT tracked (a
 *     rename/delete/metadata toggle adds no recent fact worth a hot entry).
 *     Pure scaffold writes (`wiki-meta/index.md`, `log.md`, `overview.md`) do
 *     NOT trigger either. A write to `wiki-meta/hot.md` is the satisfying
 *     action.
 *   - PER-VAULT: each vault judged independently (a session can touch
 *     several). A vault whose root can't be resolved is SKIPPED (fail-open),
 *     never blocked.
 *
 * Zero deps. Pure functions; all I/O (config, fs, platform) is injected by
 * the caller via `ctx`.
 */

const BUILTIN_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// MCP tools whose output can be a NOTE under `wiki/` (or a `wiki-meta/hot.md`
// refresh): the note-body writers, plus `execute_template` (counted only when
// it actually writes — see targetsFromToolUse). Matched by SUFFIX so both the
// local `mcp__obsidian-router__write_file` form and the MCPHub-namespaced
// `mcp__<id>__obsidian-router-<X>-write_file` form work.
//
// DELIBERATELY EXCLUDED: `move_file` / `delete_file` / `set_frontmatter` /
// `merge_frontmatter`. A rename, a delete, or a metadata toggle IS a write but
// not "new note content worth a hot entry" — tracking them would force a
// hot.md refresh (and emit a "you wrote notes" message) for operations that
// add no recent fact. Widen the set here if that scope ever needs to change.
const MCP_TRACKED_RE = /(?:^|[_-])(write_file|patch_file|append_to_file|execute_template)$/;
const EXECUTE_TEMPLATE_RE = /(?:^|[_-])execute_template$/;
const PATCH_FILE_RE = /(?:^|[_-])patch_file$/;

export function isBuiltinWriteTool(name) {
  return typeof name === 'string' && BUILTIN_WRITE_TOOLS.has(name);
}

/**
 * True if a tool name is one the guard TRACKS: a note-body writer (built-in
 * Write/Edit/MultiEdit, or MCP write_file/patch_file/append_to_file) or
 * execute_template. Non-tracked writes (move_file/delete_file/
 * set_frontmatter/merge_frontmatter) return false by design — see the
 * MCP_TRACKED_RE comment.
 */
export function isTrackedWriteTool(name) {
  if (!name || typeof name !== 'string') return false;
  if (BUILTIN_WRITE_TOOLS.has(name)) return true;
  return MCP_TRACKED_RE.test(name);
}

/**
 * Parse a JSONL transcript string → array of `{ toolName, input }` for
 * every write-flavored `tool_use` block in assistant messages. Robust to
 * malformed lines (skipped) and missing fields.
 */
export function extractWriteToolUses(jsonlText) {
  const out = [];
  if (!jsonlText || typeof jsonlText !== 'string') return out;
  for (const rawLine of jsonlText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'assistant') continue;
    const msg = entry.message || entry;
    const chunks = Array.isArray(msg.content) ? msg.content : [];
    for (const c of chunks) {
      if (!c || c.type !== 'tool_use') continue;
      if (!isTrackedWriteTool(c.name)) continue;
      out.push({
        toolName: c.name,
        input: c.input && typeof c.input === 'object' ? c.input : {},
      });
    }
  }
  return out;
}

/** Normalize a vault-relative path: forward slashes, collapse repeats, strip leading `./` and `/`. */
function normRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** Normalize an absolute path for prefix comparison (slashes, no trailing slash, lowercased on Windows). */
function normAbs(p, isWin) {
  let s = String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
  if (isWin) s = s.toLowerCase();
  return s;
}

/**
 * Pull the candidate written path(s) + optional vault slug out of one tracked
 * tool call. Built-in Write/Edit/MultiEdit carry an ABSOLUTE `file_path`;
 * write_file/patch_file/append_to_file carry a vault-RELATIVE `path`;
 * execute_template carries `targetPath` (only when `createFile === true`).
 * All MCP tools may carry an optional `vault` slug.
 */
export function targetsFromToolUse({ toolName, input } = {}) {
  const inp = input && typeof input === 'object' ? input : {};

  // Built-in Write/Edit/MultiEdit carry an ABSOLUTE `file_path`.
  if (isBuiltinWriteTool(toolName)) {
    const fp = inp.file_path || inp.filePath;
    return { absolutePaths: typeof fp === 'string' && fp ? [fp] : [], relPaths: [], vaultSlug: undefined };
  }

  const vaultSlug = typeof inp.vault === 'string' && inp.vault.trim() ? inp.vault.trim() : undefined;

  // execute_template: the only WRITTEN path is `targetPath`, and only when
  // `createFile === true`. `name` is the TEMPLATE's path (an input, not an
  // output) → never counted; a render with `createFile:false` writes nothing.
  if (EXECUTE_TEMPLATE_RE.test(String(toolName))) {
    if (inp.createFile === true && typeof inp.targetPath === 'string' && inp.targetPath) {
      return { absolutePaths: [], relPaths: [inp.targetPath], vaultSlug };
    }
    return { absolutePaths: [], relPaths: [], vaultSlug };
  }

  // A `patch_file` with `targetType: 'frontmatter'` is a metadata-only edit —
  // the low-level equivalent of `set_frontmatter`, which we deliberately
  // exclude. Treat it the same (not note content) so the primitive and the
  // wrapper agree; a heading/block patch IS content. (codex review+ P2, pass 2.)
  if (PATCH_FILE_RE.test(String(toolName)) && inp.targetType === 'frontmatter') {
    return { absolutePaths: [], relPaths: [], vaultSlug };
  }

  // write_file / patch_file (heading|block) / append_to_file: vault-relative `path`.
  const relPaths = typeof inp.path === 'string' && inp.path ? [inp.path] : [];
  return { absolutePaths: [], relPaths, vaultSlug };
}

/** Classify a vault-relative path into 'hot' | 'content' | 'other'. */
export function pathKind(relPath, { contentPrefix = 'wiki/', hotPath = 'wiki-meta/hot.md' } = {}) {
  const r = normRel(relPath);
  if (!r) return 'other';
  if (r === hotPath) return 'hot';
  if (r.startsWith(contentPrefix)) return 'content';
  return 'other';
}

/**
 * Classify one write tool call into zero or more `{ vaultKey, vaultRootRaw,
 * kind }`. `vaultKey` is the normalized absolute vault root used for
 * grouping; `null` means "could not resolve which vault" → caller skips
 * (fail-open, never block). `ctx`:
 *   - vaultRoots: string[]  (absolute vault roots, e.g. config.portRegistry keys)
 *   - slugToRoot: (slug) => string|null
 *   - defaultRoot: string|null  (vault used for MCP writes with no explicit `vault`)
 *   - isWin: bool
 *   - contentPrefix / hotPath: overridable path conventions
 */
export function classifyToolUse(toolUse, ctx = {}) {
  const isWin = !!ctx.isWin;
  const { absolutePaths, relPaths, vaultSlug } = targetsFromToolUse(toolUse);
  const roots = (ctx.vaultRoots || []).map((r) => ({ raw: r, norm: normAbs(r, isWin) }));
  const results = [];

  // Absolute (built-in Write/Edit/MultiEdit): match the LONGEST root prefix.
  for (const ap of absolutePaths) {
    const apNorm = normAbs(ap, isWin);
    let best = null;
    for (const root of roots) {
      if (apNorm === root.norm || apNorm.startsWith(root.norm + '/')) {
        if (!best || root.norm.length > best.norm.length) best = root;
      }
    }
    if (!best) {
      results.push({ vaultKey: null, vaultRootRaw: null, kind: 'other' });
      continue;
    }
    const rel = apNorm.slice(best.norm.length).replace(/^\/+/, '');
    results.push({ vaultKey: best.norm, vaultRootRaw: best.raw, kind: pathKind(rel, ctx) });
  }

  // Relative (MCP): resolve the vault root via explicit slug or the default.
  if (relPaths.length) {
    let rootRaw = null;
    if (vaultSlug && typeof ctx.slugToRoot === 'function') rootRaw = ctx.slugToRoot(vaultSlug) || null;
    if (!rootRaw && !vaultSlug) rootRaw = ctx.defaultRoot || null;
    const vaultKey = rootRaw ? normAbs(rootRaw, isWin) : null;
    for (const rp of relPaths) {
      results.push({ vaultKey, vaultRootRaw: rootRaw, kind: pathKind(rp, ctx) });
    }
  }

  return results;
}

/**
 * Main entry point. Given a transcript (JSONL string) + ctx, return:
 *   { stale: [{ vaultKey, vaultRoot }], byVault: Map<vaultKey,{lastContent,lastHot}> }
 *
 * A vault is STALE when its most recent `wiki/` content write comes AFTER its
 * most recent `wiki-meta/hot.md` refresh (or there was no hot refresh at all).
 *
 * Tracking ORDER — not just two booleans — is essential: in a multi-turn
 * session, ONE early hot refresh must NOT excuse a note written later. The
 * hot refresh has to FOLLOW the latest content write to clear the vault,
 * otherwise the cache no longer reflects the latest touched pages. (Without
 * ordering, `content:true, hot:true` would pass forever after the first
 * refresh — codex review+ P1.)
 *
 * Indices are per-`tool_use` (monotonic). A vault is stale iff
 * `lastContent >= 0 && lastContent > lastHot` (a hot write at the same index
 * as a content write is impossible for our tracked tools).
 */
export function findStaleVaults(jsonlText, ctx = {}) {
  const toolUses = extractWriteToolUses(jsonlText);
  const byVault = new Map(); // vaultKey -> { lastContent, lastHot } (tool-use indices, -1 = none)
  const rawByKey = new Map(); // vaultKey -> raw root (for messaging)

  for (const r of ctx.vaultRoots || []) rawByKey.set(normAbs(r, !!ctx.isWin), r);

  let idx = 0;
  for (const tu of toolUses) {
    for (const { vaultKey, vaultRootRaw, kind } of classifyToolUse(tu, ctx)) {
      if (!vaultKey || kind === 'other') continue; // unresolvable or irrelevant → skip
      if (vaultRootRaw && !rawByKey.has(vaultKey)) rawByKey.set(vaultKey, vaultRootRaw);
      const cur = byVault.get(vaultKey) || { lastContent: -1, lastHot: -1 };
      if (kind === 'content') cur.lastContent = idx;
      else if (kind === 'hot') cur.lastHot = idx;
      byVault.set(vaultKey, cur);
    }
    idx += 1;
  }

  const stale = [];
  for (const [key, v] of byVault) {
    // Stale when content was written AND the latest content write is more
    // recent than the latest hot refresh (or there was none).
    if (v.lastContent >= 0 && v.lastContent > v.lastHot) {
      stale.push({ vaultKey: key, vaultRoot: rawByKey.get(key) || key });
    }
  }
  return { stale, byVault };
}
