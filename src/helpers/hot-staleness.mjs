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
 *     `Write`/`Edit`/`MultiEdit`, `execute_template` (only when
 *     `createFile:true`, via its `targetPath`) and `write_bundle` (per
 *     content-writing step, via `steps[].path`). `move_file`, `delete_file`,
 *     `set_frontmatter`, `merge_frontmatter` are deliberately NOT tracked (a
 *     rename/delete/metadata toggle adds no recent fact worth a hot entry).
 *     Pure scaffold writes (`wiki-meta/catalog.md`, `journal.md`, `overview.md`) do
 *     NOT trigger either. A write to `wiki-meta/hot.md` is the satisfying
 *     action.
 *   - PER-VAULT: each vault judged independently (a session can touch
 *     several). A vault whose root can't be resolved is SKIPPED (fail-open),
 *     never blocked.
 *   - OUTCOME-AWARE: a request is not an effect. A `tool_use` counts only when
 *     the `tool_result` that answers it exists and is not an error — see
 *     `extractToolResultOutcomes` for why the asymmetric alternative was
 *     rejected.
 *
 * Zero deps. Pure functions; all I/O (config, fs, platform) is injected by
 * the caller via `ctx`.
 */

import { writeTargets } from './write-targets.mjs';

const BUILTIN_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// MCP tools whose output can be a NOTE under `wiki/` (or a `wiki-meta/hot.md`
// refresh): the note-body writers, plus `execute_template` (counted only when
// it actually writes) and `write_bundle` (counted per step). Matched by SUFFIX
// so both the local `mcp__obsidian-router__write_file` form and the
// MCPHub-namespaced `mcp__<id>__obsidian-router-<X>-write_file` form work.
//
// `write_bundle` WAS MISSING, and it is the tool that writes the most files at
// once: a bundle applying twelve notes under `wiki/` was invisible here, so the
// Stop hook let the turn end with `hot.md` describing a vault state that no
// longer existed. Same omission, same tool, as the two the factorisation of
// `write-targets.mjs` fixed elsewhere — this copy simply never heard about it.
//
// DELIBERATELY EXCLUDED: `move_file` / `delete_file` / `set_frontmatter` /
// `merge_frontmatter`. A rename, a delete, or a metadata toggle IS a write but
// not "new note content worth a hot entry" — tracking them would force a
// hot.md refresh (and emit a "you wrote notes" message) for operations that
// add no recent fact. Widen the set here if that scope ever needs to change.
const MCP_TRACKED_RE = /(?:^|[_-])(write_file|patch_file|append_to_file|execute_template|write_bundle)$/;

/**
 * The BARE router tool name behind whatever prefix the host imposed, or null.
 * `mcp__plugin_obsidian-router_router__write_file` → `write_file`. Needed
 * because `writeTargets` is keyed on the bare names the server declares.
 */
function bareTrackedToolName(toolName) {
  const m = MCP_TRACKED_RE.exec(String(toolName || ''));
  return m ? m[1] : null;
}

/**
 * A bundle step `op` → the single-file tool it is the equivalent of.
 *
 * This exists so the tracked-set policy above is stated ONCE. Without it, "a
 * bundle's `set_frontmatter` step is a metadata toggle, not note content" would
 * be a second, hand-maintained copy of the exclusion list — and this module's
 * whole defect was a second copy of a rule nobody re-read. Steps are filtered
 * through `isTrackedWriteTool`, the same predicate the top-level names use.
 */
const STEP_OP_TO_TOOL = {
  write: 'write_file',
  append: 'append_to_file',
  patch: 'patch_file',
  set_frontmatter: 'set_frontmatter',
  merge_frontmatter: 'merge_frontmatter',
  delete: 'delete_file',
};

/**
 * A `patch` that targets FRONTMATTER is a metadata-only edit — the low-level
 * equivalent of `set_frontmatter`, which is deliberately excluded. Treated the
 * same so the primitive and the wrapper agree; a heading/block patch IS content.
 * (codex review+ P2, pass 2.) One definition, used by the single-file branch and
 * by the bundle-step filter.
 */
function isFrontmatterOnlyPatch(bareTool, o) {
  return bareTool === 'patch_file' && o?.targetType === 'frontmatter';
}

export function isBuiltinWriteTool(name) {
  return typeof name === 'string' && BUILTIN_WRITE_TOOLS.has(name);
}

/**
 * True if a tool name is one the guard TRACKS: a note-body writer (built-in
 * Write/Edit/MultiEdit, or MCP write_file/patch_file/append_to_file),
 * execute_template, or write_bundle. Non-tracked writes (move_file/delete_file/
 * set_frontmatter/merge_frontmatter) return false by design — see the
 * MCP_TRACKED_RE comment. Also answers for a BARE name, which is how the
 * bundle-step filter reuses this one policy instead of restating it.
 */
export function isTrackedWriteTool(name) {
  if (!name || typeof name !== 'string') return false;
  if (BUILTIN_WRITE_TOOLS.has(name)) return true;
  return MCP_TRACKED_RE.test(name);
}

/**
 * Parse a JSONL transcript string → `Map<tool_use_id, 'ok'|'error'>`, one
 * entry per `tool_result` block found. An id absent from the map has NO
 * result in the transcript (call still in flight, or the file was truncated).
 *
 * SHAPES ARE MEASURED, NOT ASSUMED (10 real transcripts under
 * `~/.claude/projects/`, 16 731 `tool_use` blocks):
 *   - a `tool_use` is a content chunk of an `entry.type === "assistant"` line,
 *     keyed `{ type, id, name, input, caller }` — the identity is `c.id`;
 *   - a `tool_result` is a content chunk of an `entry.type === "user"` line,
 *     keyed `{ tool_use_id, type, content, is_error }`;
 *   - a failed call really does carry `is_error: true` AND its `tool_use_id`
 *     (observed on a router write refused with `HTTP 404`).
 * `isError` is accepted alongside `is_error` because that is the spelling in
 * the MCP `CallToolResult` the host maps from; only `is_error` was observed
 * here, so the second branch is defensive breadth, not a measurement.
 *
 * WHY THIS EXISTS AT ALL. The classifier used to read only the assistant's
 * REQUESTS, so a `wiki-meta/hot.md` write that FAILED — a concurrency 409, an
 * offline vault, a refused path — satisfied the guard exactly like one that
 * succeeded. The turn ended clean while the cache had not moved: a false
 * assurance, which is worse at that instant than no guard at all.
 */
export function extractToolResultOutcomes(jsonlText) {
  const outcomes = new Map();
  if (!jsonlText || typeof jsonlText !== 'string') return outcomes;
  for (const rawLine of jsonlText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'user') continue;
    const msg = entry.message || entry;
    const chunks = Array.isArray(msg.content) ? msg.content : [];
    for (const c of chunks) {
      if (!c || c.type !== 'tool_result') continue;
      const id = c.tool_use_id;
      if (typeof id !== 'string' || !id) continue;
      outcomes.set(id, c.is_error === true || c.isError === true ? 'error' : 'ok');
    }
  }
  return outcomes;
}

/**
 * Parse a JSONL transcript string → array of `{ id, toolName, input }` for
 * every write-flavored `tool_use` block that ACTUALLY WROTE: one the
 * assistant requested AND whose `tool_result` came back without an error.
 * Robust to malformed lines (skipped) and missing fields.
 *
 * THE RULE FOR A `tool_use` WITH NO `tool_result`, stated once and applied to
 * both sides: an absent result is not a success, so the call is not counted —
 * neither as a note write nor as a hot refresh. Two consequences, both wanted:
 *
 *   - a hot.md write still in flight (or lost to a truncated transcript) does
 *     not clear a vault, so the guard never certifies a refresh it did not see
 *     land — the whole point of the fix;
 *   - a NOTE write in the same state does not mark a vault stale either, so the
 *     correction cannot produce the mirror-image defect of blocking a turn for
 *     a write that never happened.
 *
 * Treating the two sides differently was the tempting alternative — count an
 * unresolved note write, ignore an unresolved hot write, i.e. "block when in
 * doubt". It was rejected: a transcript whose results are missing WHOLESALE
 * (another host's format, a half-flushed file) would then block every turn that
 * touched a vault, and this hook must never wedge a session on a file it could
 * not read. Under the symmetric rule that case counts nothing and passes.
 *
 * The cost of the symmetric rule was measured before it was chosen: across ten
 * real transcripts, 2 of 16 731 `tool_use` blocks had no result, both of them
 * the single call in flight while the file was being read, and neither a write.
 * At Stop-hook time the results of a finished turn are already on disk.
 */
export function extractWriteToolUses(jsonlText) {
  const out = [];
  if (!jsonlText || typeof jsonlText !== 'string') return out;
  const outcomes = extractToolResultOutcomes(jsonlText);
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
      // The pairing key. A block with no usable id can never be shown to have
      // succeeded, so it falls under the same rule as a missing result.
      const id = typeof c.id === 'string' && c.id ? c.id : null;
      if (!id || outcomes.get(id) !== 'ok') continue;
      out.push({
        id,
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
 * tool call. Built-in Write/Edit/MultiEdit carry an ABSOLUTE `file_path`; the
 * router tools carry vault-RELATIVE paths and may carry an optional `vault`
 * slug.
 *
 * WHICH FIELD NAMES THE TARGET IS NOT DECIDED HERE ANY MORE.
 * `helpers/write-targets.mjs` is the one definition — `path` for most tools,
 * `targetPath` only when `execute_template` has `createFile === true`,
 * `steps[].path` for a bundle, nothing for a recovery replay. This function had
 * its own copy of two of those rules and had never heard of the other two:
 *
 *   - it re-spelled the `createFile === true` gate inline, the very rule the
 *     shared module was extracted to own;
 *   - it did not know `write_bundle` existed, so a bundle writing twelve notes
 *     produced zero targets and the freshness guard saw an idle session.
 *
 * The docstring over there says it out loud — "two rounds of propagate-the-fix
 * is exactly how the copies drift, and the second copy is always the one nobody
 * re-reads". This was that copy. What stays local is only what is genuinely this
 * guard's own policy: which tools count as NOTE CONTENT at all.
 */
export function targetsFromToolUse({ toolName, input } = {}) {
  const inp = input && typeof input === 'object' ? input : {};

  // Built-in Write/Edit/MultiEdit carry an ABSOLUTE `file_path`.
  if (isBuiltinWriteTool(toolName)) {
    const fp = inp.file_path || inp.filePath;
    return { absolutePaths: typeof fp === 'string' && fp ? [fp] : [], relPaths: [], vaultSlug: undefined };
  }

  const vaultSlug = typeof inp.vault === 'string' && inp.vault.trim() ? inp.vault.trim() : undefined;
  const none = { absolutePaths: [], relPaths: [], vaultSlug };

  const bare = bareTrackedToolName(toolName);
  if (!bare) return none;
  if (isFrontmatterOnlyPatch(bare, inp)) return none;

  // A bundle's steps are filtered to the content-writing ones BEFORE the shared
  // extractor runs, so `writeTargets` stays the sole authority on the recovery
  // gate and on the `steps[].path` shape, while the exclusion policy is applied
  // to its input rather than re-derived from its output.
  const args = bare === 'write_bundle' && Array.isArray(inp.steps)
    ? { ...inp, steps: inp.steps.filter((s) => {
      const stepTool = STEP_OP_TO_TOOL[s?.op];
      return isTrackedWriteTool(stepTool) && !isFrontmatterOnlyPatch(stepTool, s);
    }) }
    : inp;

  return { absolutePaths: [], relPaths: writeTargets(bare, args), vaultSlug };
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
 * Indices are per-APPLIED-`tool_use` (monotonic): the sequence
 * `extractWriteToolUses` returns, which is the requests that came back without
 * an error, in transcript order. A vault is stale iff
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
