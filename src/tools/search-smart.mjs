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
 */
import { searchSmart } from '../rest-client.mjs';

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
    const candidates = registry.vaults.filter((v) => !v.missingApiKey);
    const settled = await Promise.allSettled(
      candidates.map(async (v) => {
        const data = await searchSmart(v, query, filter);
        return { vault: v.name, ...data };
      }),
    );

    return {
      query,
      filter,
      perVault: settled.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { vault: candidates[i]?.name ?? '?', error: r.reason.message },
      ),
    };
  }

  const vault = registry.resolveVault(name);
  const data = await searchSmart(vault, query, filter);
  return {
    vault: vault.name,
    query,
    filter,
    ...data,
  };
}
