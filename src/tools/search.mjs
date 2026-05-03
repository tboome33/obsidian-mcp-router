import { searchSimple } from '../rest-client.mjs';

export async function search(registry, { vault: name, query, contextLength = 100 } = {}) {
  if (!query) {
    throw new Error('Missing required argument: query');
  }

  // Special token "*" → fan-out to all vaults
  if (name === '*') {
    // Capture the vault list once so we can index back into it for the
    // rejected promises — Promise.allSettled doesn't surface the input
    // each promise was bound to, and we don't want to lose the vault
    // name on failure (was previously rendered as "?").
    const candidates = registry.vaults.filter((v) => !v.missingApiKey);
    const results = await Promise.allSettled(
      candidates.map(async (v) => {
        const matches = await searchSimple(v, query, contextLength);
        return { vault: v.name, matches };
      }),
    );

    return {
      query,
      contextLength,
      perVault: results.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { vault: candidates[i].name, error: r.reason.message },
      ),
    };
  }

  const vault = registry.resolveVault(name);
  const matches = await searchSimple(vault, query, contextLength);
  return {
    vault: vault.name,
    query,
    contextLength,
    matches,
  };
}
