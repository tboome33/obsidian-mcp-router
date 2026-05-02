---
name: obsidian-router-add-vault
description: Interactive flow to add a new Obsidian vault (local or remote) to the obsidian-mcp-router config. Use whenever the user wants to "add a vault to the router", "register a new obsidian vault", "connect a remote vault", "set up Obsidian for this project", or any phrasing implying a new vault should be wired up to the multi-vault router.
---

# obsidian-router-add-vault

Walk the user through adding a new vault to `~/.claude/mcp-obsidian/config.json`. There are two flavors:

- **Local vault**: an Obsidian vault running on the same machine as the user.
- **Remote vault**: an Obsidian vault running elsewhere (NAS, VPS, behind Cloudflare Tunnel, on a different OS), reachable via HTTPS.

## Step 1 — Disambiguate

First, ask the user which case applies if it's not obvious from their message. Examples:

- "I want to add my vault on the QNAP" → **remote**
- "I just created a vault at D:\Notes" → **local**
- "Add a vault to the router" → **ask the user**

## Step 2A — Local vault flow

1. Ask for the absolute vault path (e.g. `D:\Notes\Recherche` or `/Users/me/Vaults/Personal`). If the user already mentioned it, confirm.
2. Verify the path exists and contains a `.obsidian/` directory (use `Read` or `Bash` `ls`). If not, ask whether to bootstrap it as a new vault — `setup-vault.mjs` handles both.
3. Run the setup script:
   ```bash
   node "$HOME/.claude/mcp-obsidian/scripts/setup-vault.mjs" "<path>"
   ```
   On Windows, use `%USERPROFILE%`:
   ```bash
   node "%USERPROFILE%\.claude\mcp-obsidian\scripts\setup-vault.mjs" "<path>"
   ```
4. Show the user what the script printed (allocated port, generated API key, plugins synced).
5. Tell the user the next steps explicitly:
   - **Open the vault in Obsidian** (otherwise the REST API server doesn't run)
   - **Disable Restricted Mode** in Settings → Community plugins
   - **Verify Local REST API and MCP Tools are toggled ON**
   - **Restart Claude Desktop / Claude Code** so the router picks up the new entry on next start
6. Optionally call the router's `list_vaults` tool to confirm the new vault appears (note: it'll show offline until the user opens it in Obsidian).

If `setup-vault.mjs` is not found:

> The vault provisioning script `~/.claude/mcp-obsidian/scripts/setup-vault.mjs` doesn't exist on this machine. You'll need to either install it (it's part of the per-user Claude home setup) or add the vault entry manually. Want me to walk you through the manual path?

## Step 2B — Remote vault flow

Required information from the user (ask only what's missing):

1. **`name`** — short identifier used everywhere (e.g. `qnap`, `vps-research`, `tradingview-tunnel`). Lowercase, no spaces.
2. **`baseUrl`** — the HTTPS URL where the remote Obsidian Local REST API is reachable. Examples:
   - `https://192.168.0.11:27125` (LAN)
   - `https://qnap.tailnet.local:27125` (Tailscale)
   - `https://vault.mydomain.com` (Cloudflare Tunnel with custom domain)
3. **`apiKey`** — the Local REST API key from the vault's `data.json` on the remote machine. The user must fetch this themselves; offer guidance if asked:
   - Open the remote vault in Obsidian on its host machine
   - Settings → Community plugins → Local REST API
   - Copy the API Key field

Optional:

4. **`tlsInsecure`** (default `true` if URL is on localhost or LAN, `false` otherwise) — only set to `true` for self-signed certs in trusted networks.
5. **`timeoutMs`** (default `10000`) — bump to 15-20s if the link is slow.
6. **`extraHeaders`** — for vaults behind Cloudflare Access with a service token. Two values needed:
   - `CF-Access-Client-Id`
   - `CF-Access-Client-Secret`
   See [`docs/cloudflare-tunnel.md`](https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/cloudflare-tunnel.md) for setup.

### Edit the config

1. Read `~/.claude/mcp-obsidian/config.json`.
2. Parse the JSON.
3. If a `remoteVaults` entry with the same name already exists → ask the user before overwriting.
4. Append (or replace) the entry in the `remoteVaults` array with the values gathered above.
5. Write the file back atomically (read full file → modify → write tmp → rename, or use `Edit` tool with the full block).
6. Confirm to the user:
   - The path that was edited
   - The vault name added
   - That a Claude Desktop / Claude Code restart is required to pick up the change

### Optional: live verification

Before declaring success, you can do a quick live test:

```bash
curl -sk -H "Authorization: Bearer <apiKey>" \
  [-H "CF-Access-Client-Id: ..."] [-H "CF-Access-Client-Secret: ..."] \
  "<baseUrl>/" | head -5
```

If it returns the JSON server-info, you're golden. If it 401s, the API key is wrong; if it times out, the URL is unreachable.

## Don't

- Don't write secrets (API keys, service token secrets) anywhere except `~/.claude/mcp-obsidian/config.json`. No log files, no echo to terminal beyond the immediate confirmation, no clipboard write.
- Don't auto-restart Claude. Tell the user to do it themselves.
- Don't add a remote vault entry without a full set of `name`, `baseUrl`, `apiKey`. Refuse and ask for the missing fields.
- Don't pretend the setup-vault.mjs script exists if it doesn't. Fall back to the manual path.

## Final confirmation

End your turn with a short recap:

> ✅ Added vault `<name>` to the router config.
> Next step: restart Claude Desktop, then run `list_vaults` to confirm.
