import { searchSimple } from '../rest-client.mjs';
import { collectClickToOpenLinks } from '../helpers/click-to-open-walker.mjs';

export async function search(registry, { vault: name, query, contextLength = 100 } = {}) {
  if (!query) {
    throw new Error('Missing required argument: query');
  }

  // Special token "*" → fan-out to all vaults
  if (name === '*') {
    // Lock guard: cross-vault fan-out is incompatible with single-vault
    // isolation. Refuse explicitly rather than silently restrict.
    if (registry.lockedVault) {
      throw new Error(
        `Cannot fan-out: router is locked to vault "${registry.lockedVault}". ` +
          `Use unlock_vaults first or specify "${registry.lockedVault}" instead of "*".`,
      );
    }
    // Capture the vault list once so we can index back into it for the
    // rejected promises — Promise.allSettled doesn't surface the input
    // each promise was bound to, and we don't want to lose the vault
    // name on failure (was previously rendered as "?").
    const candidates = registry.vaults.filter((v) => !v.missingApiKey);
    const results = await Promise.allSettled(
      candidates.map(async (v) => {
        const matches = await searchSimple(v, query, contextLength);
        return {
          vault: v.name,
          matches,
          ...collectClickToOpenLinks(v, matches),
        };
      }),
    );

    return ({
      query,
      contextLength,
      perVault: results.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { vault: candidates[i].name, error: r.reason.message },
      ),
    });
  }

  const vault = registry.resolveVault(name);
  const matches = await searchSimple(vault, query, contextLength);
  return ({
    vault: vault.name,
    query,
    contextLength,
    matches,
    ...collectClickToOpenLinks(vault, matches),
  });
}
