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
 *
 * Configuring smart links signals a REMOTE deployment: do NOT set
 * OBSIDIAN_ROUTER_SMART_LINK_URL / OBSIDIAN_ROUTER_SMART_LINK_SECRET on a purely
 * local router — this tool would hand back a link (`opened: false`,
 * `delivered: 'link'`) instead of navigating your local Obsidian.
 */
import { openInObsidian, getFileContent, RestApiError } from '../rest-client.mjs';
import { fetchViewLink } from '../helpers/view-link.mjs';
import { buildSmartLink, smartLinkEnabled } from '../helpers/smart-link.mjs';

export async function openInObsidianTool(registry, args = {}) {
  const { vault: name, path: filePath, anchor } = args;

  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Missing required argument: `path` (the vault-relative file path to open).');
  }
  if (anchor != null && typeof anchor !== 'string') {
    throw new Error(`\`anchor\` must be a string, got ${typeof anchor}.`);
  }

  const vault = registry.resolveVault(name);

  // REMOTE deployment, PRIORITY 1 — smart link (resolver configured): return the stable
  // signed URL (pure HMAC, no resolver round-trip). The resolver page decides AT CLICK
  // TIME, on the clicking device, between a local Obsidian mirror, the obsidian:// deep
  // link, and the streamed GUI. Same anchor contract as the view-agent branch below:
  // remote links can't deep-link a heading.
  //
  // EXISTENCE GUARD (review codex P2 + reviewer I2): the other branches surface a
  // missing note as an error (bridge /open 404s, the agent navigates a real note) —
  // signing a link to a non-existent note would silently regress that. So check the
  // note against the vault's Local REST API first: 404 → throw (pre-smart parity).
  // Any OTHER failure (vault offline, timeout, auth) must NOT block the link — the
  // link is still the right deliverable; it just carries an explicit "unverified" hint.
  if (smartLinkEnabled(process.env)) {
    let unverified = false;
    try {
      await getFileContent(vault, filePath);
    } catch (err) {
      if (err instanceof RestApiError && err.kind === 'not_found') {
        // Rethrow the ORIGINAL RestApiError (message customized) so the CallTool
        // wrapper keeps the machine-readable kind/hint classification — wrapping in
        // a plain Error degraded it to "unknown" (review+ pass 2, codex P2).
        err.message = `Note not found: ${filePath} (vault: ${vault.name})`;
        throw err;
      }
      unverified = true;
    }
    return {
      vault: vault.name,
      path: filePath,
      // Nothing was navigated server-side — the link IS the deliverable. The old
      // `opened: true` here was a lie (review codex P2 + reviewer I2).
      opened: false,
      delivered: 'link',
      viewLink: buildSmartLink({
        baseUrl: process.env.OBSIDIAN_ROUTER_SMART_LINK_URL,
        vault: vault.name,
        note: filePath,
        secret: process.env.OBSIDIAN_ROUTER_SMART_LINK_SECRET, // raw, per contract
      }),
      viewLinkKind: 'smart',
      ...(anchor ? { anchor, anchorApplied: false } : {}),
      hint:
        'Remote vault — open this smart link to view the note; it resolves on the clicking ' +
        'device (local Obsidian mirror if present, otherwise the live streamed GUI).' +
        (anchor ? ' The note opens at the top — heading anchors are not deep-linkable here.' : '') +
        (unverified ? ' (existence non vérifiée — vault injoignable au moment de la demande)' : ''),
    };
  }

  // REMOTE-CONTAINER deployment: a configured view-agent means the user has no local
  // Obsidian to raise — return a browser view-link to the live GUI on the note instead
  // (the agent also navigates the container's Obsidian to it). Best-effort: if the agent
  // is unreachable, fall through to the bridge navigate below. See the docblock.
  //
  // Timeout: this path is USER-INITIATED (the user asked to see the note + is waiting), so it
  // keeps fetchViewLink's default (long) timeout to allow a cold cloudflared tunnel (~15-18s)
  // — unlike the eager write-time path (short timeout + circuit-breaker) which rides EVERY
  // write. A persistently black-holed agent thus costs the full timeout here, but this path is
  // on-demand + infrequent and falls through to the bridge on failure (review+ 159adac).
  if ((process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim()) {
    const data = await fetchViewLink({ vaultName: vault.name, note: filePath, throwOnError: false });
    if (data && data.url) {
      return {
        vault: vault.name,
        path: filePath,
        opened: true,
        viewLink: data.url,
        viewLinkKind: 'agent',
        // The tunnel opens the GUI ON the note, but an Obsidian heading is NOT deep-linkable
        // through it — so a requested `anchor` is echoed with `anchorApplied: false` (NOT
        // silently dropped, since the schema/description advertise anchor support; review+
        // 159adac, codex P2 + Code Reviewer convergent).
        ...(anchor ? { anchor, anchorApplied: false } : {}),
        hint:
          'Remote vault — open this browser link to view the note in the live Obsidian GUI ' +
          '(credentials in the URL, nothing to type); it auto-closes after the idle timeout.' +
          (anchor ? ' The note opens at the top — heading anchors are not deep-linkable here.' : ''),
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
    // Symmetric anchor contract with the view-link branch above: when an anchor is honoured
    // (local bridge navigate), echo it WITH `anchorApplied: true`; the remote viewLink branch
    // echoes `anchorApplied: false`; no anchor → neither field (review+ 159adac, Code Reviewer nit).
    ...(result.anchor ? { anchor: result.anchor, anchorApplied: true } : {}),
    opened: true,
  };
}
