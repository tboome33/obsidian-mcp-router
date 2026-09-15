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
import { searchSmart, getFileContent, getNote } from '../rest-client.mjs';
import { resolveAsOf } from '../helpers/temporal-validity.mjs';
import { createValidityContext } from '../helpers/validity-annotator.mjs';
import { applyValidityFilter, normalizeValidityStates } from '../helpers/validity-filter.mjs';
import { collectClickToOpenLinks } from '../helpers/click-to-open-walker.mjs';
import { isVaultReachable } from '../helpers/vault-reach.mjs';
import { filterArchiveResults } from '../helpers/archive-filter.mjs';
import {
  searchLocalIndex,
  isSemanticTierUnusable,
  TIER_SEMANTIC,
  TIER_LOCAL,
} from '../helpers/local-search.mjs';
import { validateQuery, clampLimit } from '../helpers/bm25-index.mjs';
import { freshnessFor, freshnessNote } from '../helpers/embedding-staleness.mjs';
import {
  resolveExcludeFolders,
  partitionByFolders,
  exclusionReport,
  overfetchLimit,
} from '../helpers/search-exclusions.mjs';

/** Requested tier. `auto` = semantic, degrading to local when it cannot serve. */
const TIER_MODES = new Set(['auto', 'semantic', 'local']);

/** The one collection this tool annotates, and the quota it debits. */
const COLLECTION_HITS = 'hits';

/**
 * WHAT `moreCandidates` CAN HONESTLY SAY, per tier.
 *
 * On the local tier the index tells us how many chunks were ELIGIBLE — scored
 * and kept by every pre-existing exclusion — so "are there candidates I did not
 * look at" has a real answer. On the semantic tier the engine says nothing
 * about what it did not return, so the only honest answer is that we do not
 * know. `'unknown'` is not a placeholder for a value we failed to compute; it
 * is the measurement.
 */
const MORE_CANDIDATES_UNKNOWN = 'unknown';

export async function searchSmartTool(registry, args = {}, _deps = {}) {
  const {
    vault: name,
    query,
    folders,
    excludeFolders,
    limit = 10,
    includeArchives = false,
    tier: requestedTier = 'auto',
    asOf,
    validityStates,
  } = args;

  if (!query) {
    throw new Error('Missing required argument: query');
  }

  // TEMPORAL VALIDITY — both arguments are judged on their OWN terms, before
  // any dispatch. A filter naming a state that does not exist would hide a
  // different set than the caller asked for while looking like it worked, and
  // an unreadable `asOf` must fail rather than quietly become today.
  //
  // The day is resolved ONCE here rather than inside each context: a fan-out
  // creates one context per vault, and resolving per vault could classify two
  // vaults of one response on different days if the call straddled midnight
  // (invariant 8).
  const keepStates = normalizeValidityStates(validityStates);
  const filtering = keepStates !== null;
  // Presence in the response follows what the CALLER passed, not what it
  // normalised to: asking with `[]` is still asking, and the report then says
  // "you filtered on nothing" rather than vanishing.
  const filterRequested = validityStates !== undefined && validityStates !== null;
  const asOfDay = resolveAsOf(asOf);
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

  const deps = { searchSmart: _deps.searchSmart || searchSmart, getNote: _deps.getNote || getNote };
  // The local tier reads the index through the same REST client; injectable so
  // tests drive both tiers without touching the network.
  const localDeps = { getFileContent: _deps.getFileContent || getFileContent };

  // C4 — the effective exclusion, resolved ONCE and used by both tiers. An
  // explicit `excludeFolders` (including `[]`, which means "nothing") wins over
  // the measured default; see helpers/search-exclusions.mjs for why the default
  // is one folder and not the four the roadmap sketched.
  const exclusion = resolveExcludeFolders(excludeFolders, _deps.env);

  const filter = {};
  if (Array.isArray(folders) && folders.length) filter.folders = folders;
  if (exclusion.folders.length) filter.excludeFolders = [...exclusion.folders];
  filter.limit = boundedLimit;

  // The filter REPORTED in the response keeps the caller's limit; the one sent
  // to the bridge over-fetches so a router-side cut does not shrink the page.
  // Overfetch when ANY router-side cut may follow — archives, or the C4 folder
  // exclusion. Filtering a page that was already trimmed to `limit` hands back
  // fewer results than were asked for while matches sit just past the cut.
  // A VALIDITY FILTER IS A THIRD REASON TO OVER-FETCH, and it had to become
  // one. Without it, a call that excludes no folder and keeps archives would
  // ask for exactly `limit`, and the temporal filter would then cut into a page
  // that cannot be refilled — an empty answer with eligible hits sitting just
  // past the window, which is the silent-empty failure this tier exists to
  // avoid. The local tier had no over-fetch at all before this: its pre-existing
  // exclusions are applied DURING ranking, where validity cannot be, because
  // deciding it costs one read per page.
  const fetchLimit = overfetchLimit(boundedLimit, {
    excluding: exclusion.folders.length > 0,
    archives: !includeArchives,
    validity: filtering,
  });
  const scFilter = fetchLimit === boundedLimit ? filter : { ...filter, limit: fetchLimit };

  /** The semantic tier, unchanged from v0.8.8 behaviour. */
  const searchSemantic = async (vault) => {
    const raw = await deps.searchSmart(vault, query, scFilter);
    // C4 APPLIED ROUTER-SIDE, BEFORE the archive trim. `excludeFolders` is also
    // forwarded to the bridge above, but the guarantee cannot rest on that:
    // whether Smart Connections honours it is unverified here, and a default
    // whose effect depends on an unverified remote behaviour is not a default.
    let folderExcluded = 0;
    let payload = raw;
    if (exclusion.folders.length && Array.isArray(raw?.results)) {
      const { kept, excluded } = partitionByFolders(raw.results, exclusion.folders);
      folderExcluded = excluded;
      if (excluded > 0) payload = { ...raw, results: kept };
    }
    // THE ARCHIVE TRIM MUST NOT CUT TO `limit` WHILE A VALIDITY FILTER IS
    // PENDING, or the over-fetch above is spent and then thrown away one step
    // before the filter that needed it. When nothing is filtering, the limit
    // passed here is the caller's, exactly as before.
    const { data, archivesExcluded } = filterArchiveResults(payload, {
      includeArchives,
      limit: filtering ? fetchLimit : filter.limit,
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
    const report = exclusionReport({
      ...exclusion,
      excluded: folderExcluded,
      // A SHORT PAGE THAT ADMITS IT beats a full-looking one. The over-fetch
      // makes the common case whole; it cannot guarantee it, and no backend
      // here takes an offset to refill from.
      shortPage: folderExcluded > 0 && (data?.results?.length ?? 0) < boundedLimit,
    });
    return {
      tier: TIER_SEMANTIC,
      scoreScale: 'cosine',
      ...data,
      ...(archivesExcluded > 0 ? { archivesExcluded } : {}),
      ...(report ? { folderExclusion: report } : {}),
      ...(freshness ? { freshness: note ? { ...freshness, note } : freshness } : {}),
      ...collectClickToOpenLinks(vault, data),
    };
  };

  /** The local deterministic BM25 tier. */
  const searchLocal = async (vault) => {
    const local = await searchLocalIndex(vault, localDeps, {
      query,
      // Over-fetched only when something downstream will cut. Unfiltered, this
      // is the caller's limit and the tier behaves exactly as it did.
      limit: filtering ? fetchLimit : boundedLimit,
      folders,
      // The SAME effective exclusion as the semantic tier. A fallback that
      // surfaces what the tier it replaced was hiding would make the degrade
      // visible as a content change rather than as a change of engine.
      excludeFolders: exclusion.folders,
      includeArchives,
    });
    const report = exclusionReport({
      ...exclusion,
      excluded: local.folderExcluded ?? 0,
      shortPage: (local.folderExcluded ?? 0) > 0 && (local.results?.length ?? 0) < boundedLimit,
    });
    return {
      ...local,
      ...(report ? { folderExclusion: report } : {}),
      ...collectClickToOpenLinks(vault, local.results),
    };
  };

  /**
   * Annotate the page a tier produced, apply the filter, cut to the limit.
   *
   * ANNOTATION IS UNCONDITIONAL, the filter is not. Every hit carries its
   * window — or says it could not be established — whether or not the caller
   * filters, because `validitySummary` is always present and a summary that
   * appeared only under a filter would leave a reader unable to tell "no page
   * is dated" from "this build does not annotate".
   *
   * The counts are computed HERE rather than inside the annotator, because they
   * are about the search: what the ranking held, what this call looked at, what
   * the filter removed, and what the cut removed. Only the tier knows the first.
   */
  const withValidity = async (vault, payload) => {
    const results = Array.isArray(payload.results) ? payload.results : [];
    // The quota is the number of DISTINCT pages among the candidates already
    // fetched — no new ceiling, as the over-fetch is bounded already. It is
    // stated rather than left unmetered so that reading more pages than there
    // are candidates would be refused instead of quietly happening.
    const distinctPages = new Set(
      results.map((r) => (typeof r?.path === 'string' ? r.path.trim() : '')).filter(Boolean),
    ).size;
    const ctx = createValidityContext({
      vault,
      readNote: deps.getNote,
      asOf: asOfDay,
      budget: { [COLLECTION_HITS]: distinctPages },
    });

    await ctx.annotate(results, { collection: COLLECTION_HITS, pathOf: (hit) => hit?.path });

    const { kept, excludedHits } = applyValidityFilter(results, keepStates);
    // THE CUT BELONGS TO THE FILTER, and only to it. Applying it unconditionally
    // looked harmless and violated invariant 6: `filterArchiveResults` returns
    // EARLY when archives are kept, so its `limit` is never applied, and an
    // unfiltered semantic call with `includeArchives: true` and a folder
    // exclusion in force used to hand back the whole over-fetched page —
    // measured at 14 hits for a `limit` of 2. Cutting it here would have been a
    // silent behaviour change on a path this batch is not allowed to touch.
    //
    // That over-return is a real pre-existing defect, and it is NOT fixed here:
    // it belongs to its own change, decided on its own terms.
    const returned = filtering && kept.length > boundedLimit
      ? kept.slice(0, boundedLimit)
      : kept;
    // Admissible, inspected, and removed only because the page was full. Named
    // apart from `excludedHits` because a reader who sees a short page needs to
    // know which of the two shortened it.
    const cutByLimit = kept.length - returned.length;

    // ELIGIBLE VS INSPECTED, and never `matched`. A chunk excluded by folder was
    // never a candidate, so counting it would report unexamined candidates that
    // do not exist. `eligible` is absent on the semantic tier, which is exactly
    // why that tier answers `'unknown'`.
    const moreCandidates = typeof payload.eligible === 'number'
      ? payload.eligible > results.length
      : MORE_CANDIDATES_UNKNOWN;

    const summary = ctx.finalize(returned);

    return {
      ...payload,
      results: returned,
      validitySummary: summary,
      ...(filterRequested
        ? {
          validityFilter: {
            states: keepStates ? [...keepStates] : [],
            excludedHits,
            cutByLimit,
            moreCandidates,
          },
        }
        : {}),
    };
  };

  /**
   * One vault, one tier. The ONLY place the fallback decision is made — and it
   * degrades exclusively on a capability gap (never on an empty answer, never
   * on auth/transport failure).
   */
  const searchOne = async (vault) => {
    if (requestedTier === 'local') return withValidity(vault, await searchLocal(vault));
    if (requestedTier === 'semantic') return withValidity(vault, await searchSemantic(vault));
    let semantic;
    try {
      semantic = await searchSemantic(vault);
    } catch (err) {
      if (!isSemanticTierUnusable(err)) throw err;
      const local = await searchLocal(vault);
      return withValidity(vault, {
        ...local,
        fallback: {
          from: TIER_SEMANTIC,
          to: TIER_LOCAL,
          reason: 'semantic-tier-unavailable',
          detail: err.message,
          note: 'Results come ENTIRELY from the local BM25 index — no semantic result is blended in. BM25 scores are not comparable to cosine scores.',
        },
      });
    }
    // OUTSIDE the catch. `withValidity` is very nearly throw-proof — a read
    // that fails marks its entry and never propagates — so this placement is
    // defence rather than a load-bearing guarantee, and it is written down as
    // such instead of being claimed as a property no test can show. What it
    // buys: should the annotation ever throw, the call fails as itself instead
    // of being diagnosed as "the semantic tier cannot serve this vault" and
    // answered from a different engine under a capability gap that never
    // happened.
    return withValidity(vault, semantic);
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
    // Reachability applies to fan-out exactly like it applies to naming a
    // vault directly — see the identical comment in tools/search.mjs, whose
    // lockedVault check just above this shares this same call site.
    const candidates = registry.vaults.filter((v) => !v.missingApiKey && isVaultReachable(v.name, registry));
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
