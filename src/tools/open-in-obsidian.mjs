/**
 * open_in_obsidian — navigate the Obsidian serving a vault to a file (and raise
 * its window) WITHOUT opening a browser.
 *
 * Why this exists: a click-to-open *link* is great in terminals that dispatch
 * URLs straight to the OS, but clients that proxy link clicks through a browser
 * — notably Claude Desktop (its web link handler routes every clicked link via
 * a `claude.ai` proxy) — always pop a browser tab for an http link. This tool
 * sidesteps that entirely: the router calls the bridge's public `/open` route
 * server-side (router process → loopback HTTP → bridge), so Obsidian navigates
 * with ZERO browser. Call it when the user asks to "open" / "show" a note.
 *
 * Read-only with respect to vault CONTENT — it only moves the Obsidian UI — so
 * it is allowed even under `OBSIDIAN_ROUTER_READONLY` (not in WRITE_TOOL_NAMES).
 *
 * Requires the `mcp-router-bridge` plugin (≥ 0.2.0) installed + enabled and an
 * Obsidian instance running for the target vault. A missing file 404s and a
 * down Obsidian / REST API surfaces a categorized transient error — both
 * propagate as a normal tool error.
 */
import { openInObsidian } from '../rest-client.mjs';

export async function openInObsidianTool(registry, args = {}) {
  const { vault: name, path: filePath, anchor } = args;

  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Missing required argument: `path` (the vault-relative file path to open).');
  }
  if (anchor != null && typeof anchor !== 'string') {
    throw new Error(`\`anchor\` must be a string, got ${typeof anchor}.`);
  }

  const vault = registry.resolveVault(name);

  // NOTE: deliberately NOT restricted to `vault.type === 'local'`. A review
  // flagged parity with `buildClickToOpenUrl` (which IS local-only) — but that
  // helper is local-only only because it must read the LOCAL data.json to find
  // the insecure port; a different reason. `open_in_obsidian` targets
  // `vault.baseUrl` directly, and the PRIMARY deployment is MCPHub, where the
  // user's own vaults are configured as `remote` with a WireGuard baseUrl
  // (e.g. http://10.8.0.10:<port>). Restricting to local would break exactly
  // that case. The bridge /open navigates whichever Obsidian serves baseUrl —
  // by config, the user's own.
  const result = await openInObsidian(vault, filePath, { anchor });

  return {
    vault: vault.name,
    path: filePath,
    ...(result.anchor ? { anchor: result.anchor } : {}),
    opened: true,
  };
}
