/**
 * get_view_link — ask the Dedibox "view-agent" for an ephemeral Cloudflare-tunnel
 * link that opens a vault's LIVE Obsidian GUI in a browser, navigated to a specific
 * note, with HTTP basic-auth baked into the URL so the user types nothing.
 *
 * Why this exists: the canonical long-term answer for "let me read what the AI just
 * wrote" is the headless web app (per-note markdown view + signed magic-links). This
 * tool is the INTERIM: it surfaces the existing container GUI (Selkies, streamed)
 * through an on-demand tunnel that the view-agent starts and auto-closes after an idle
 * timeout — ephemeral, never permanently exposed. The agent also navigates the
 * container's Obsidian to the note (Local REST API POST /open) before returning, so
 * the link lands ON the note.
 *
 * Architecture: router (this process, on MCPHub/QNAP) → HTTP over WireGuard →
 * view-agent (on the Dedibox, where the GUIs live) → cloudflared + Local REST API.
 * Configured via two env vars on the router instance:
 *   OBSIDIAN_ROUTER_VIEW_AGENT_URL   e.g. http://10.8.0.1:27200   (required)
 *   OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN shared secret (optional; sent as X-View-Token)
 *
 * Read-only with respect to vault CONTENT — it only spins a tunnel and moves the
 * Obsidian UI — so it is NOT in WRITE_TOOL_NAMES (stays exposed under READONLY).
 */

const VIEW_TIMEOUT_MS = 25000; // first call per vault waits on cloudflared cold-start (~15s)

export async function getViewLinkTool(registry, args = {}) {
  const { vault: name, note } = args;

  const agentBase = (process.env.OBSIDIAN_ROUTER_VIEW_AGENT_URL || '').trim();
  if (!agentBase) {
    throw new Error(
      'get_view_link is not configured on this router instance: set ' +
        'OBSIDIAN_ROUTER_VIEW_AGENT_URL (e.g. http://10.8.0.1:27200).',
    );
  }
  if (note != null && typeof note !== 'string') {
    throw new Error(`\`note\` must be a string, got ${typeof note}.`);
  }

  // Resolve/validate the vault through the registry (canonical name + existence,
  // honours the default-vault cascade when `vault` is omitted).
  const vault = registry.resolveVault(name);

  let url;
  try {
    url = new URL('/view', agentBase.endsWith('/') ? agentBase : agentBase + '/');
  } catch {
    throw new Error(`OBSIDIAN_ROUTER_VIEW_AGENT_URL is not a valid URL: ${agentBase}`);
  }
  url.searchParams.set('vault', vault.name);
  if (note) url.searchParams.set('note', note);

  const headers = {};
  const token = (process.env.OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN || '').trim();
  if (token) headers['X-View-Token'] = token;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(VIEW_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(
      `view-agent unreachable at ${agentBase} (${err?.message || err}). ` +
        'Check the view-agent service is running and reachable over WireGuard.',
    );
  }

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    let detail = bodyText;
    try {
      detail = JSON.parse(bodyText).error || bodyText;
    } catch {
      /* keep raw text */
    }
    throw new Error(`view-agent returned ${res.status} for vault "${vault.name}": ${detail}`);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`view-agent returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
  if (!data || typeof data.url !== 'string' || !data.url) {
    throw new Error(`view-agent response missing "url": ${bodyText.slice(0, 200)}`);
  }

  return {
    vault: vault.name,
    note: note || null,
    url: data.url,
    expiresInSeconds: typeof data.idle_timeout_s === 'number' ? data.idle_timeout_s : null,
    hint:
      'Ephemeral view link — opens the live Obsidian GUI in a browser (credentials are ' +
      'in the URL, nothing to type), navigated to the note. Auto-closes after the idle ' +
      'timeout; ask again for a fresh link if it has expired.',
  };
}
