/**
 * search_smart — semantic search powered by Smart Connections, exposed via
 * the obsidian-mcp-router-bridge plugin's API extension to Local REST API,
 * with the C4 local BM25 tier underneath it.
 *
 * Per-vault: the vault must have BOTH the obsidian-mcp-router-bridge plugin
 * AND the smart-connections plugin installed and enabled. The router surfaces
 * "Smart Connections plugin is not available" as a clear error if the vault
 * has the bridge but no smart-connections.
 *
 * Cross-vault: pass `vault: "*"` to fan-out across every configured vault
 * in parallel. Vaults that don't support semantic search are silently
 * skipped (their entries appear as `{ vault, error }` in the response).
 *
 * Hardening (v0.8.8): every string in the response is run through
 * `sanitizeLabel` to strip ANSI escapes / control chars from breadcrumbs,
 * excerpts, paths — vault content can be authored by anyone and we don't
 * want corpus-injected escape sequences reaching Claude's context.
 *
 * Archived deliberation (v0.54.0): hits under an `archives/` folder — where
 * the `decision-consolidate` skill parks the chronicle of a consolidated
 * decision (`type: decision-archive`) — are excluded by default, with an
 * `archivesExcluded` count so the cut is never silent. The page is
 * overfetched before filtering so exclusion does not shrink the result set
 * below `limit`. Opt back in with `includeArchives: true`.
 *
 * C4 (v0.63.0) — HONEST FALLBACK, NEVER MIXED. Most of the fleet has no Smart
 * Connections. When the semantic tier CANNOT SERVE a vault, this tool now falls
 * back WHOLLY to the local deterministic BM25 index and labels the response
 * (`tier`, `fallback.reason`) instead of erroring out. It never blends the two
 * rankings — their score scales are incomparable — and it never falls back on an
 * empty-but-successful semantic answer, which is a real answer. `tier: 'semantic'`
 * forbids the fallback; `tier: 'local'` demands the deterministic tier outright.
 * See src/helpers/local-search.mjs for the full doctrine.
 */
import { searchSmart, getFileContent } from '../rest-client.mjs';
import { collectClickToOpenLinks } from '../helpers/click-to-open-walker.mjs';
import { filterArchiveResults } from '../helpers/archive-filter.mjs';
import {
  searchLocalIndex,
  isSemanticTierUnusable,
  TIER_SEMANTIC,
  TIER_LOCAL,
} from '../helpers/local-search.mjs';
import { validateQuery, clampLimit } from '../helpers/bm25-index.mjs';
import { freshnessFor, freshnessNote } from '../helpers/embedding-staleness.mjs';

/** Overfetch margin: enough that a handful of archive chunks in the top of
 * the ranking cannot empty the page, small enough to stay cheap. */
const ARCHIVE_OVERFETCH = 10;

/** Requested tier. `auto` = semantic, degrading to local when it cannot serve. */
const TIER_MODES = new Set(['auto', 'semantic', 'local']);

export async function searchSmartTool(registry, args = {}, _deps = {}) {
  const {
    vault: name,
    query,
    folders,
    excludeFolders,
    limit = 10,
    includeArchives = false,
    tier: requestedTier = 'auto',
  } = args;

  if (!query) {
    throw new Error('Missing required argument: query');
  }
  if (!TIER_MODES.has(requestedTier)) {
    throw new Error(
      `Invalid tier "${requestedTier}": expected 'auto' (semantic, falling back to the local BM25 index), ` +
        `'semantic' (semantic only — error if unavailable), or 'local' (the deterministic BM25 index only).`,
    );
  }
  // C4 UPPER bounds are TIER-INDEPENDENT (abuse guards): an over-long or
  // over-tokenised query is refused before any dispatch, whichever engine is
  // live (Codex verification, v0.63.0). But `no-usable-tokens` (no token ≥ 3
  // chars) is a BM25 PREREQUISITE, not a semantic one — embeddings serve short
  // queries like "C1" or "IA" fine, and v0.62.0 did. Refusing it up-front
  // regressed exactly those queries on semantic vaults (post-release Fable 5
  // verification, v0.63.1). So: refuse it here only when the LOCAL tier is the
  // one that must answer; on the auto path, if the fallback is reached,
  // queryIndex re-validates and refuses with the same actionable message.
  const bounds = validateQuery(query);
  if (!bounds.ok) {
    const bm25PrereqOnly = bounds.reason === 'no-usable-tokens';
    if (!bm25PrereqOnly || requestedTier === 'local') {
      const err = new Error(bounds.message);
      err.kind = 'validation';
      err.reason = bounds.reason;
      throw err;
    }
  }
  const boundedLimit = clampLimit(limit);

  const deps = { searchSmart: _deps.searchSmart || searchSmart };
  // The local tier reads the index through the same REST client; injectable so
  // tests drive both tiers without touching the network.
  const localDeps = { getFileContent: _deps.getFileContent || getFileContent };

  const filter = {};
  if (Array.isArray(folders) && folders.length) filter.folders = folders;
  if (Array.isArray(excludeFolders) && excludeFolders.length) {
    filter.excludeFolders = excludeFolders;
  }
  filter.limit = boundedLimit;

  // The filter reported in the response keeps the caller's limit; the one
  // sent to Smart Connections overfetches so dropping archive hits does not
  // return fewer results than asked for.
  const scFilter = includeArchives ? filter : { ...filter, limit: boundedLimit + ARCHIVE_OVERFETCH };

  /** The semantic tier, unchanged from v0.8.8 behaviour. */
  const searchSemantic = async (vault) => {
    const raw = await deps.searchSmart(vault, query, scFilter);
    const { data, archivesExcluded } = filterArchiveResults(raw, {
      includeArchives,
      limit: filter.limit,
    });
    // A1 — SAY WHEN A HIT COMES FROM A PAGE THAT HAS MOVED ON.
    //
    // Cosine ranks against vectors Smart Connections computed on its own
    // schedule, and until now a hit from a page edited since then looked
    // exactly like a fresh one. `freshnessFor` compares each hit's page mtime
    // against the mtime the store recorded at import; it reads local disk only,
    // returns `checkable: false` rather than guessing for a vault this machine
    // has no disk for, and never throws — a freshness check that could fail a
    // search would be a worse trade than not knowing. Only the SEMANTIC tier
    // gets this: the local BM25 tier carries its own `index.freshness`, and
    // giving two tiers the same field name for two different measurements is
    // how a reader ends up comparing incomparable things.
    // NOT pre-filtered: a malformed entry is something the assessor COUNTS
    // (`refusedPaths`). Dropping it here hid it from the only place that
    // reports it.
    const paths = Array.isArray(data?.results) ? data.results.map((r) => r?.path) : [];
    const freshness = freshnessFor(vault, paths, { fs: _deps.fs });
    const note = freshnessNote(freshness);
    return {
      tier: TIER_SEMANTIC,
      scoreScale: 'cosine',
      ...data,
      ...(archivesExcluded > 0 ? { archivesExcluded } : {}),
      ...(freshness ? { freshness: note ? { ...freshness, note } : freshness } : {}),
      ...collectClickToOpenLinks(vault, data),
    };
  };

  /** The local deterministic tier (C4). */
  const searchLocal = async (vault) => {
    const local = await searchLocalIndex(vault, localDeps, {
      query,
      limit: boundedLimit,
      folders,
      excludeFolders,
      includeArchives,
    });
    return { ...local, ...collectClickToOpenLinks(vault, local.results) };
  };

  /**
   * One vault, one tier. The ONLY place the fallback decision is made — and it
   * degrades exclusively on a capability gap (never on an empty answer, never
   * on auth/transport failure).
   */
  const searchOne = async (vault) => {
    if (requestedTier === 'local') return searchLocal(vault);
    if (requestedTier === 'semantic') return searchSemantic(vault);
    try {
      return await searchSemantic(vault);
    } catch (err) {
      if (!isSemanticTierUnusable(err)) throw err;
      const local = await searchLocal(vault);
      return {
        ...local,
        fallback: {
          from: TIER_SEMANTIC,
          to: TIER_LOCAL,
          reason: 'semantic-tier-unavailable',
          detail: err.message,
          note: 'Results come ENTIRELY from the local BM25 index — no semantic result is blended in. BM25 scores are not comparable to cosine scores.',
        },
      };
    }
  };

  // Cross-vault fan-out
  if (name === '*') {
    // Lock guard: cross-vault fan-out is incompatible with single-vault
    // isolation. Refuse explicitly rather than silently restrict.
    if (registry.lockedVault) {
      throw new Error(
        `Cannot fan-out: router is locked to vault "${registry.lockedVault}". ` +
          `Use unlock_vaults first or specify "${registry.lockedVault}" instead of "*".`,
      );
    }
    const candidates = registry.vaults.filter((v) => !v.missingApiKey);
    const settled = await Promise.allSettled(
      candidates.map(async (v) => ({ vault: v.name, ...(await searchOne(v)) })),
    );

    return ({
      query,
      filter,
      requestedTier,
      perVault: settled.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { vault: candidates[i]?.name ?? '?', error: r.reason.message },
      ),
    });
  }

  const vault = registry.resolveVault(name);
  return ({
    vault: vault.name,
    query,
    filter,
    requestedTier,
    ...(await searchOne(vault)),
  });
}
