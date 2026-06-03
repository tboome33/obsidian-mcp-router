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
 *   - TRIGGER = a write to `wiki/<...>` (a note). Pure scaffold writes
 *     (`wiki-meta/index.md`, `log.md`, `overview.md`) do NOT trigger — they
 *     are bookkeeping. A write to `wiki-meta/hot.md` is the satisfying
 *     action.
 *   - PER-VAULT: each vault judged independently (a session can touch
 *     several). A vault whose root can't be resolved is SKIPPED (fail-open),
 *     never blocked.
 *
 * Zero deps. Pure functions; all I/O (config, fs, platform) is injected by
 * the caller via `ctx`.
 */

const BUILTIN_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// MCP write-flavored tool verbs (the tail of `mcp__<server>__<verb>` or the
// MCPHub form `mcp__<id>__<server>-<verb>`). Matched against the full tool
// name by suffix so both local and hub namespacings work.
const MCP_WRITE_RE =
  /(?:^|[_-])(write_file|patch_file|append_to_file|set_frontmatter|merge_frontmatter|move_file|delete_file|execute_template)$/;

export function isBuiltinWriteTool(name) {
  return typeof name === 'string' && BUILTIN_WRITE_TOOLS.has(name);
}

/** True if a tool name is a write-flavored MCP or built-in tool. */
export function isWriteToolName(name) {
  if (!name || typeof name !== 'string') return false;
  if (BUILTIN_WRITE_TOOLS.has(name)) return true;
  return MCP_WRITE_RE.test(name);
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
      if (!isWriteToolName(c.name)) continue;
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
 * Pull the candidate written path(s) + optional vault slug out of one write
 * tool call. Built-in Write/Edit/MultiEdit carry an ABSOLUTE `file_path`;
 * MCP tools carry vault-RELATIVE `path` (+ `destination`/`toPath` for moves)
 * and an optional `vault` slug.
 */
export function targetsFromToolUse({ toolName, input } = {}) {
  const inp = input && typeof input === 'object' ? input : {};
  if (isBuiltinWriteTool(toolName)) {
    const fp = inp.file_path || inp.filePath;
    return { absolutePaths: typeof fp === 'string' && fp ? [fp] : [], relPaths: [], vaultSlug: undefined };
  }
  const relPaths = [];
  for (const key of ['path', 'destination', 'toPath', 'dest', 'target', 'outputPath']) {
    const v = inp[key];
    if (typeof v === 'string' && v) relPaths.push(v);
  }
  const vaultSlug = typeof inp.vault === 'string' && inp.vault.trim() ? inp.vault.trim() : undefined;
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
 *   { stale: [{ vaultKey, vaultRoot }], byVault: Map<vaultKey,{content,hot}> }
 * `stale` lists vaults with ≥1 `wiki/` content write and NO hot.md refresh.
 */
export function findStaleVaults(jsonlText, ctx = {}) {
  const toolUses = extractWriteToolUses(jsonlText);
  const byVault = new Map(); // vaultKey -> { content, hot }
  const rawByKey = new Map(); // vaultKey -> raw root (for messaging)

  for (const r of ctx.vaultRoots || []) rawByKey.set(normAbs(r, !!ctx.isWin), r);

  for (const tu of toolUses) {
    for (const { vaultKey, vaultRootRaw, kind } of classifyToolUse(tu, ctx)) {
      if (!vaultKey || kind === 'other') continue; // unresolvable or irrelevant → skip
      if (vaultRootRaw && !rawByKey.has(vaultKey)) rawByKey.set(vaultKey, vaultRootRaw);
      const cur = byVault.get(vaultKey) || { content: false, hot: false };
      if (kind === 'content') cur.content = true;
      if (kind === 'hot') cur.hot = true;
      byVault.set(vaultKey, cur);
    }
  }

  const stale = [];
  for (const [key, v] of byVault) {
    if (v.content && !v.hot) stale.push({ vaultKey: key, vaultRoot: rawByKey.get(key) || key });
  }
  return { stale, byVault };
}
