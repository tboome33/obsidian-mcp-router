/**
 * list_vaults — meta-tool that returns the catalogue of configured vaults
 * along with their online status and latency.
 *
 * Pings each ACTIVE vault in parallel. Disabled vaults are surfaced in a
 * separate `disabled[]` field with their reason — they are NOT pinged
 * (no point: they're hidden from the MCP surface, and pinging them
 * would just add latency and timeout noise).
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

  // Disabled vaults from the registry's skipped[] list. Read-only metadata
  // (no ping). Each entry has { name, type, reason }. Always returned, even
  // when empty, so callers don't have to special-case "no disabled" vs
  // "field missing".
  const disabled = (registry.skipped || []).map((s) => ({
    name: s.name,
    type: s.type,
    reason: s.reason,
  }));

  return {
    defaultVault: registry.defaultVault,
    configPath: registry.configPath,
    vaults: results,
    disabled,
    // Lock state — null when the router is in normal multi-vault mode,
    // a vault name when the router is restricted to a single vault for
    // the current session. See `lock_vault` / `unlock_vaults` tools.
    lockedTo: registry.lockedVault || null,
  };
}
