/**
 * Local BM25 search execution + the honest-fallback doctrine (C4).
 *
 * `bm25-index.mjs` is the pure algorithm; THIS module is the orchestration that
 * touches the vault: read `wiki-meta/search-index.json` over REST, score the
 * query against it, and shape the result so the caller always knows WHICH tier
 * answered.
 *
 * ── THE DOCTRINE ──────────────────────────────────────────────────────────
 * A search resolves to EXACTLY ONE tier, and the response says which.
 *
 * Semantic scores (cosine similarity, ~[0,1]) and BM25 scores (unbounded, corpus
 * relative) live on different scales. Interleaving them yields a ranking whose
 * order means nothing — the classic "hybrid search" trap that looks richer and
 * is strictly worse. So there is no blending, no score normalization across
 * tiers, no "top-k from each". One tier answers; it is named in the response.
 *
 * FALLING BACK IS FOR AN UNUSABLE TIER, NOT A DISAPPOINTING ANSWER. The rule is
 * C1's, transplanted: degrade when the semantic tier CANNOT SERVE (the bridge
 * route is absent, Smart Connections is not installed, or it has not indexed
 * yet), never when it served and simply had little to say. In particular an
 * EMPTY semantic result is a real answer — falling back on it would silently
 * replace "the vault has nothing on this" with a different engine's guesses.
 * Auth failures, timeouts, and unreachable vaults are NOT capability gaps and
 * surface unchanged — and could not be served anyway, since the local index
 * lives inside the same vault and is fetched over the same connection.
 *
 * AN ABSENT INDEX IS AN ACTIONABLE REFUSAL, NOT AN EMPTY LIST. If the fallback
 * is reached and no index exists, the caller gets a message naming the exact
 * tool that builds one — never a bare `[]`, which would read as "nothing in the
 * vault matches" when the truth is "nothing has been indexed yet".
 * ──────────────────────────────────────────────────────────────────────────
 */

import {
  queryIndex,
  indexProblem,
  clampLimit,
  absentIndexMessage,
  unusableIndexMessage,
  emptyIndexMessage,
  rebuildHint,
  SEARCH_INDEX_PATH,
} from './bm25-index.mjs';
import { isArchivePath } from './archive-filter.mjs';

/** Tier labels — the vocabulary the response speaks. */
export const TIER_SEMANTIC = 'semantic';
export const TIER_LOCAL = 'local-bm25';

/**
 * Does this error mean the SEMANTIC TIER CANNOT SERVE this vault (a capability
 * gap), as opposed to a transport/auth failure or a genuine tier malfunction?
 *
 * TWO signals, and only two:
 *   - `not_found` / 404 → the bridge's `/search/smart` route is absent (older or
 *     disabled plugin). Unambiguous: the handler itself never 404s.
 *   - a body that NAMES the missing capability ("Smart Connections plugin is not
 *     available") — whatever status carries it.
 *
 * WHY THE STATUS CODE ALONE IS NOT ENOUGH (Fable 5 review, v0.63.0). The bridge
 * wraps EVERY runtime exception from the search handler in a generic
 * `503 {"error":"An error occurred while processing the search request"}` —
 * a Smart Connections that is installed and working but crashes mid-query, a
 * single unreadable file, an exception during reindex. Treating any 503 as a
 * capability gap silently demoted those real malfunctions to a labelled BM25
 * degrade, so the operator never learned the semantic tier was broken — exactly
 * the "a real failure must surface" case this module's doctrine forbids. The
 * genuine plugin-absent 503 carries the identifying message, so requiring it
 * keeps the gap detectable while letting true errors through.
 *
 * Everything else — 401/403, timeouts, unreachable, 500, and an unexplained 503
 * — is NOT a capability gap and must surface.
 */
export function isSemanticTierUnusable(err) {
  if (!err) return false;
  if (err.kind === 'not_found' || err.status === 404) return true;
  // Match the bridge's ASSERTION ("Smart Connections … is not available"), not
  // loose proximity: a crash whose message merely QUOTED a page titled
  // "Smart Connections not available guide" used to trigger the fallback and
  // hide the crash (post-release Codex verification, v0.63.1). Requiring the
  // verb kills that; the genuine bridge bodies all carry it. Residual honesty:
  // this is still prose matching — the durable fix is a structured error code
  // from the bridge, tracked as future bridge work.
  return /smart[\s-]?connections(?:\s+plugin)?\s+is\s+not\s+(?:available|installed|enabled)/i.test(
    String(err.message || ''),
  );
}

/** An actionable refusal (not an empty result). Carries `kind` for classification. */
function actionable(message, reason) {
  const err = new Error(message);
  err.kind = 'validation';
  err.reason = reason;
  return err;
}

/** Read + parse the stored index. Returns null when absent (a normal state). */
export async function readStoredIndex(getFileContent, vault) {
  let raw;
  try {
    raw = await getFileContent(vault, SEARCH_INDEX_PATH);
  } catch (err) {
    if (err?.kind === 'not_found') return null;
    throw err;
  }
  const text = typeof raw === 'string' ? raw : (raw && typeof raw.content === 'string' ? raw.content : '');
  try {
    return JSON.parse(text);
  } catch {
    return { __unparseable: true };
  }
}

/** Does `path` sit under one of these folder prefixes? */
function underAny(path, prefixes) {
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Run a query against the vault's local BM25 index.
 *
 * Overfetches before filtering (archives, folders) so post-filtering never
 * shrinks the page below the caller's `limit` — the same courtesy the semantic
 * path already extends.
 *
 * @param {object} vault resolved vault descriptor
 * @param {{getFileContent: Function}} deps
 * @param {object} params {query, limit, folders, excludeFolders, includeArchives}
 * @returns {Promise<object>} `{ tier, results, archivesExcluded?, indexStats, … }`
 * @throws an actionable error when no usable index exists.
 */
export async function searchLocalIndex(vault, deps, params = {}) {
  const { query, limit = 10, folders, excludeFolders, includeArchives = false } = params;

  const stored = await readStoredIndex(deps.getFileContent, vault);
  if (stored === null) {
    throw actionable(absentIndexMessage(vault.name), 'index-absent');
  }
  const problem = stored.__unparseable ? 'malformed' : indexProblem(stored);
  if (problem !== null) {
    // Name the precise problem (corrupt vs foreign-version vs unreadable) —
    // `index-${problem}` gives the caller a machine-readable reason too.
    throw actionable(unusableIndexMessage(vault.name, stored, problem), `index-${problem}`);
  }
  // An EMPTY index is a misconfiguration, not an answer. Serving `[]` from it
  // would be indistinguishable from "the vault has nothing on this" — the exact
  // silent-empty failure C4 forbids. (Fable 5 review, v0.63.0.)
  if (stored.chunks.length === 0) {
    throw actionable(emptyIndexMessage(vault.name), 'index-empty');
  }

  const want = clampLimit(limit);
  const includeFolders = Array.isArray(folders) && folders.length
    ? folders.map((f) => String(f).replace(/\/+$/, ''))
    : null;
  const denyFolders = Array.isArray(excludeFolders) && excludeFolders.length
    ? excludeFolders.map((f) => String(f).replace(/\/+$/, ''))
    : null;

  // Filtering happens DURING ranking (see queryIndex): post-filtering a capped
  // page could hand back nothing while eligible matches sat just past the cap.
  let archivesExcluded = 0;
  const keep = (chunk) => {
    if (includeFolders && !underAny(chunk.path, includeFolders)) return false;
    if (denyFolders && underAny(chunk.path, denyFolders)) return false;
    if (!includeArchives && isArchivePath(chunk.path)) {
      archivesExcluded += 1;
      return false;
    }
    return true;
  };

  const { hits: results, scored, tokens } = queryIndex({ index: stored, query, limit: want, keep });

  return {
    tier: TIER_LOCAL,
    // Scores are BM25 — comparable WITHIN this response, never against a
    // semantic response's cosine scores.
    scoreScale: 'bm25',
    results,
    ...(archivesExcluded > 0 ? { archivesExcluded } : {}),
    matched: scored,
    queryTokens: tokens,
    // A truncated index does NOT cover the whole vault, so this tier cannot
    // claim to be a COMPLETE fallback for it. Say so on every response — the
    // flag lived only in the index file, invisible to searchers (Codex).
    ...(stored.stats?.truncated
      ? {
          incomplete: {
            reason: 'index-truncated',
            detail:
              `This index was capped at ${stored.stats.maxChunks ?? 'its chunk limit'} chunks and does NOT cover the whole vault — ` +
              `results may omit matching pages. ${rebuildHint(vault.name)}`,
          },
        }
      : {}),
    index: {
      path: SEARCH_INDEX_PATH,
      fingerprint: stored.fingerprint ?? null,
      chunks: stored.stats?.chunks ?? null,
      pages: stored.stats?.pages ?? null,
      truncated: Boolean(stored.stats?.truncated),
      // Freshness is NOT re-verified per query (that would re-read the whole
      // vault on the hot path). Say so, and name the cheap way to check.
      freshness: `not verified on this query — run build_search_index with check:true to compare against the vault. ${rebuildHint(vault.name)}`,
    },
  };
}
