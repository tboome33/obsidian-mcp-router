/**
 * list_vaults — meta-tool that returns the catalogue of configured vaults
 * along with their online status and latency.
 *
 * Pings each vault in parallel.
 */
import { pingVault } from '../rest-client.mjs';

export async function listVaults(registry) {
  const results = await Promise.all(
    registry.vaults.map(async (v) => {
      const ping = await pingVault(v);
      return {
        name: v.name,
        type: v.type,
        baseUrl: v.baseUrl,
        path: v.path,
        description: v.description,
        isDefault: v.name === registry.defaultVault,
        online: ping.online,
        latencyMs: ping.latencyMs,
        error: ping.error,
        missingApiKey: v.missingApiKey || false,
      };
    }),
  );

  return {
    defaultVault: registry.defaultVault,
    configPath: registry.configPath,
    vaults: results,
  };
}
