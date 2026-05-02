import { searchSimple } from '../rest-client.mjs';

export async function search(registry, { vault: name, query, contextLength = 100 } = {}) {
  if (!query) {
    throw new Error('Missing required argument: query');
  }

  // Special token "*" → fan-out to all vaults
  if (name === '*') {
    const results = await Promise.allSettled(
      registry.vaults
        .filter((v) => !v.missingApiKey)
        .map(async (v) => {
          const matches = await searchSimple(v, query, contextLength);
          return { vault: v.name, matches };
        }),
    );

    return {
      query,
      contextLength,
      perVault: results.map((r) =>
        r.status === 'fulfilled' ? r.value : { vault: '?', error: r.reason.message },
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
