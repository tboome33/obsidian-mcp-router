/**
 * list_vaults — meta-tool that returns the catalogue of configured vaults
 * along with their online status and latency.
 *
 * Pings each ACTIVE vault in parallel. Disabled vaults are surfaced in a
 * separate `disabled[]` field with their reason — they are NOT pinged
 * (no point: they're hidden from the MCP surface, and pinging them
 * would just add latency and timeout noise).
 *
 * v0.10.0 — adds top-level `defaultVaultStatus` field. Surfaces whether
 * the default vault is reachable at session start, together with an
 * `obsidian://open?vault=<obsidianName>` URI the convention
 * `default-vault-health-check` uses to compose a clickable one-click
 * fix in the natural-language warning. See
 * `wiki/obsidian-mcp-router/router-ux-improvements-roadmap.md` Phase 1.
 */
import { pingVault } from '../rest-client.mjs';
import { pathBasename } from '../registry.mjs';
/**
 * Build the `defaultVaultStatus` summary for the list_vaults response.
 *
 * Exported as a pure helper (no I/O) so unit tests can exercise the URI
 * composition + null cases without needing to ping real vaults.
 *
 * Parameters:
 *  - `defaultVaultName`: registry.defaultVault — the resolved slug, or
 *    null/undefined when no vault matched the resolution cascade.
 *  - `pingedResults`: the `results[]` array built by `listVaults`. Each
 *    entry must carry `{ name, type, path?, online, error?, missingApiKey? }`.
 *
 * Returns null when:
 *  - `defaultVaultName` is falsy (empty registry / no cascade match)
 *  - `defaultVaultName` doesn't match any entry in `pingedResults`
 *    (post-load mutation — leave for the convention layer to surface)
 *
 * Otherwise returns a frozen-shape object: `{ name, obsidianName, type,
 * online, error, missingApiKey, openUri, path }`. `path` is `null` for
 * remote vaults (no on-disk folder to derive a basename from).
 *
 * For LOCAL vaults the obsidian:// URI handler matches against the vault
 * label registered in Obsidian itself, which is the on-disk folder
 * basename WITH its on-disk casing. The router slug is lowercased
 * (defaultNameFromPath), so we need the exact-case basename here.
 *
 * For REMOTE vaults there's no local Obsidian to open. We still emit an
 * openUri using the router slug — the convention layer can branch on
 * `type !== 'local'` to skip the suggestion, but a remote vault MAY also
 * be opened locally if the user happens to have a clone, so surfacing
 * the URI is harmless.
 */
export function buildDefaultVaultStatus(defaultVaultName, pingedResults) {
  if (!defaultVaultName) return null;
  const def = pingedResults.find((r) => r.name === defaultVaultName);
  if (!def) return null;
  const defPath = def.path; // undefined for remote vaults
  const obsidianName = defPath ? pathBasename(defPath) : def.name;
  const openUri = `obsidian://open?vault=${encodeURIComponent(obsidianName)}`;
  return {
    name: def.name,
    obsidianName,
    type: def.type,
    online: def.online,
    error: def.error || null,
    missingApiKey: def.missingApiKey || false,
    openUri,
    path: defPath || null,
  };
}

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

  // Default vault health summary (v0.10.0) — null when no default vault
  // resolved (empty registry / no cascade match) OR when the resolved
  // default name isn't in the pinged results (pathological post-load
  // mutation; let the convention layer surface the inconsistency).
  const defaultVaultStatus = buildDefaultVaultStatus(registry.defaultVault, results);

  return ({
    defaultVault: registry.defaultVault,
    defaultVaultStatus,
    configPath: registry.configPath,
    vaults: results,
    disabled,
    // Port collisions + registry drift detected when the config was loaded
    // (v0.77.0). This is the ANSWER to an "online: false" above that has no
    // other explanation: two vaults on one port means the second one to start
    // never bound its socket. Always an array — empty when the fleet is clean.
    portCollisions: registry.portCollisions || [],
    // Lock state — null when the router is in normal multi-vault mode,
    // a vault name when the router is restricted to a single vault for
    // the current session. See `lock_vault` / `unlock_vaults` tools.
    lockedTo: registry.lockedVault || null,
    // Auto-enrichment mode — controls whether/how Claude proactively
    // proposes wiki saves at three triggers (validation pins, result
    // digests, topic-switch checkpoints). One of:
    //   - "ClaudeAsk"  — propose, user always confirms (default)
    //   - "Hybrid"     — auto-save type-safe items, ask on high-stakes
    //   - "FullAuto"   — auto-save everything (audit log + safety nets)
    //   - "off"        — no auto-suggestions; manual /save only
    // See `set_auto_enrich_mode` tool to change this at runtime.
    // Legacy fallback: a registry from a pre-v0.8.2 boot path won't have
    // this field set. Default to 'ClaudeAsk' — the safe default that
    // matches the documented behavior (propose + always confirm). We do
    // NOT silently default to 'off' here, because absence of an explicit
    // mode means "user hasn't customized" and the safe default applies.
    autoEnrichMode: registry.autoEnrichMode || 'ClaudeAsk',
  });
}
