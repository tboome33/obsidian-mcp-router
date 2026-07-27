/**
 * archive-filter.mjs — default exclusion of archived deliberation from
 * semantic search results.
 *
 * The decision contract (meta-vault decision `consolidation-sans-amnesie`,
 * accepted 2026-07-28) lets a SETTLED decision page be consolidated: the
 * page keeps the verdict and the minimal why, while the deliberation
 * chronicle moves to an `archives/` folder next to the page (frontmatter
 * `type: decision-archive`). Those notes exist for HUMANS browsing history —
 * for an LLM they are exactly the context pollution the consolidation
 * removed, so search must not resurface them by default.
 *
 * The filter keys on the PATH (a directory segment named `archives`), not
 * on the frontmatter type: search hits arrive from Smart Connections as
 * bare chunks, and reading N frontmatters per query to learn each hit's
 * type would put REST round-trips on the hot path. The folder name is the
 * contract's own deterministic signal — the `decision-consolidate` skill
 * always writes the archive under `<page-folder>/archives/`.
 *
 * Never silent: the caller is handed the count of dropped hits so the
 * response can carry `archivesExcluded: N` instead of quietly shrinking.
 * `includeArchives: true` restores them.
 */

/**
 * A path whose directory chain contains an `archives` segment, at any
 * depth, case-insensitively, with either separator. The trailing separator
 * is what keeps a page or folder merely NAMED `archives.md` /
 * `mes-archives/` from matching — only a directory exactly called
 * `archives` is the contract's signal.
 */
const ARCHIVE_SEGMENT_RE = /(^|[/\\])archives[/\\]/i;

export function isArchivePath(path) {
  return ARCHIVE_SEGMENT_RE.test(String(path ?? ''));
}

/**
 * Drop archive-folder hits from a Smart Connections result payload, then
 * trim back to `limit` (the caller overfetches so that filtering does not
 * shrink the page below what was asked for).
 *
 * Pass-through when the payload has no `results` array (the bridge's error
 * shape) or when the caller asked for archives — in that case the caller
 * did not overfetch either, so no trim is needed.
 *
 * @param {object} data  raw payload from the bridge (`{ results: [...] }`)
 * @param {{includeArchives?: boolean, limit?: number}} [options]
 * @returns {{data: object, archivesExcluded: number}}
 */
export function filterArchiveResults(data, options = {}) {
  const { includeArchives = false, limit } = options;
  if (includeArchives || !data || !Array.isArray(data.results)) {
    return { data, archivesExcluded: 0 };
  }
  let kept = data.results.filter((entry) => !isArchivePath(entry?.path));
  const archivesExcluded = data.results.length - kept.length;
  if (Number.isFinite(limit) && kept.length > limit) {
    kept = kept.slice(0, limit);
  }
  if (kept.length === data.results.length) {
    return { data, archivesExcluded };
  }
  return { data: { ...data, results: kept }, archivesExcluded };
}
