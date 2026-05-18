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
 */
import { searchSmart } from '../rest-client.mjs';
import { sanitizeResponse } from '../helpers/sanitize.mjs';

export async function searchSmartTool(registry, args = {}) {
  const {
    vault: name,
    query,
    folders,
    excludeFolders,
    limit = 10,
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
      candidates.map(async (v) => {
        const data = await searchSmart(v, query, filter);
        return { vault: v.name, ...data };
      }),
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
  const data = await searchSmart(vault, query, filter);
  return sanitizeResponse({
    vault: vault.name,
    query,
    filter,
    ...data,
  });
}
