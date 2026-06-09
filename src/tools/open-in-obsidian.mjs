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
 *
 * REMOTE-CONTAINER deployments (a view-agent is configured, e.g. MCPHub→Dedibox): there
 * is no local Obsidian the user can see — "open/show me note X" means "give me a browser
 * link to the live GUI on that note". So when OBSIDIAN_ROUTER_VIEW_AGENT_URL is set, this
 * returns an ephemeral `viewLink` (the view-agent navigates the container's Obsidian to the
 * note + returns a tunnel URL) instead of the browser-less bridge navigate (which the user
 * couldn't see anyway). → "show me a note" yields the link whichever tool the AI reaches for
 * (get_view_link OR open_in_obsidian) — the deterministic complement to the write-time
 * `viewLink` auto-injection (which only fires on writes, not reads).
 */
import { openInObsidian } from '../rest-client.mjs';
import { fetchViewLink } from '../helpers/view-link.mjs';

export async function openInObsidianTool(registry, args = {}) {
  const { vault: name, path: filePath, anchor } = args;

  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Missing required argument: `path` (the vault-relative file path to open).');
  }
  if (anchor != null && typeof anchor !== 'string') {
    throw new Error(`\`anchor\` must be a string, got ${typeof anchor}.`);
  }

  const vault = registry.resolveVault(name);

  // REMOTE-CONTAINER deployment: a configured view-agent means the user has no local
  // Obsidian to raise — return a browser view-link to the live GUI on the note instead
  // (the agent also navigates the container's Obsidian to it). Best-effort: if the agent
  // is unreachable, fall through to the bridge navigate below. See the docblock.
  if ((process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim()) {
    const data = await fetchViewLink({ vaultName: vault.name, note: filePath, throwOnError: false });
    if (data && data.url) {
      return {
        vault: vault.name,
        path: filePath,
        opened: true,
        viewLink: data.url,
        hint:
          'Remote vault — open this browser link to view the note in the live Obsidian GUI ' +
          '(credentials in the URL, nothing to type); it auto-closes after the idle timeout.',
      };
    }
  }

  // NOTE: deliberately NOT restricted to `vault.type === 'local'`. A review
  // flagged parity with `buildClickToOpenUrl` (which IS local-only) — but that
  // helper is local-only only because it must read the LOCAL data.json to find
  // the insecure port; a different reason. `open_in_obsidian` targets
  // `vault.baseUrl` directly. The bridge /open navigates whichever Obsidian
  // serves baseUrl. (For a configured + reachable view-agent the branch above
  // already returned a view-link; this is the local / no-view-agent path.)
  const result = await openInObsidian(vault, filePath, { anchor });

  return {
    vault: vault.name,
    path: filePath,
    ...(result.anchor ? { anchor: result.anchor } : {}),
    opened: true,
  };
}
