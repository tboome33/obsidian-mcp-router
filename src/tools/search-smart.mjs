/**
 * search_smart — semantic search powered by Smart Connections, exposed via
 * the obsidian-mcp-router-bridge plugin's API extension to Local REST API.
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
 */
import { searchSmart } from '../rest-client.mjs';
import { sanitizeResponse } from '../helpers/sanitize.mjs';
import { collectClickToOpenLinks } from '../helpers/click-to-open-walker.mjs';
import { filterArchiveResults } from '../helpers/archive-filter.mjs';

/** Overfetch margin: enough that a handful of archive chunks in the top of
 * the ranking cannot empty the page, small enough to stay cheap. */
const ARCHIVE_OVERFETCH = 10;

export async function searchSmartTool(registry, args = {}) {
  const {
    vault: name,
    query,
    folders,
    excludeFolders,
    limit = 10,
    includeArchives = false,
  } = args;

  if (!query) {
    throw new Error('Missing required argument: query');
  }

  const filter = {};
  if (Array.isArray(folders) && folders.length) filter.folders = folders;
  if (Array.isArray(excludeFolders) && excludeFolders.length) {
    filter.excludeFolders = excludeFolders;
  }
  if (typeof limit === 'number') filter.limit = limit;

  // The filter reported in the response keeps the caller's limit; the one
  // sent to Smart Connections overfetches so dropping archive hits does not
  // return fewer results than asked for.
  const scFilter = includeArchives
    ? filter
    : { ...filter, limit: (Number.isFinite(filter.limit) ? filter.limit : 10) + ARCHIVE_OVERFETCH };

  const searchOne = async (vault) => {
    const raw = await searchSmart(vault, query, scFilter);
    const { data, archivesExcluded } = filterArchiveResults(raw, {
      includeArchives,
      limit: filter.limit,
    });
    return {
      ...data,
      ...(archivesExcluded > 0 ? { archivesExcluded } : {}),
      ...collectClickToOpenLinks(vault, data),
    };
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

    return sanitizeResponse({
      query,
      filter,
      perVault: settled.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { vault: candidates[i]?.name ?? '?', error: r.reason.message },
      ),
    });
  }

  const vault = registry.resolveVault(name);
  return sanitizeResponse({
    vault: vault.name,
    query,
    filter,
    ...(await searchOne(vault)),
  });
}
