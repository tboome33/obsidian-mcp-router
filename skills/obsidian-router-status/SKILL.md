---
name: obsidian-router-status
description: Diagnose the obsidian-mcp-router and all its configured vaults. Pings each vault, reports online/offline/auth status, and suggests fixes for each issue type. Use when the user says "check vault status", "diagnose the router", "are my vaults reachable", "status of obsidian", "what's wrong with the router", or asks to debug an obsidian connection issue.
---

# obsidian-router-status

This skill produces a one-shot diagnostic of the multi-vault Obsidian router. Run it when the user wants to know what's working, what isn't, and how to fix it.

## Steps

1. Call the router's `list_vaults` tool (no arguments). The router will ping each configured vault in parallel and return a structure like:
   ```json
   {
     "defaultVault": "tradingview",
     "configPath": "/Users/.../.claude/mcp-obsidian/config.json",
     "vaults": [
       {
         "name": "tradingview",
         "type": "local",
         "baseUrl": "https://127.0.0.1:27125",
         "online": true,
         "latencyMs": 4,
         "missingApiKey": false,
         "isDefault": true
       },
       {
         "name": "qnap",
         "type": "remote",
         "baseUrl": "https://qnap.tailnet.local:27125",
         "online": false,
         "latencyMs": 5012,
         "error": "[qnap] timed out after 5000ms calling /",
         "missingApiKey": false
       }
     ]
   }
   ```

2. Render the result as a compact summary:
   - First line: `<n> vault(s) configured · <m> online · default: <name>`
   - Then a markdown table with columns: name | type | status | latency | path/baseUrl
   - Use ✅ for online, ❌ for offline, ⚠️ for missingApiKey or any partial issue

3. For each vault that is NOT fully healthy, add a short diagnostic block explaining the likely cause and the fix:

| Symptom | Likely cause | Fix to suggest |
|---|---|---|
| `online: false` AND `type: local` | Obsidian not running on this vault, or a different vault is open | Open Obsidian and load the vault at the path shown |
| `online: false` AND `type: remote` AND `error` includes "unreachable" | Remote host not reachable | Check that the remote machine is online, the tunnel is up (Tailscale / Cloudflare), and that no firewall changed |
| `online: false` AND `error` includes "timed out" | Network path is alive but slow, or the remote vault is busy | Bump `timeoutMs` for that vault to 15000-20000 |
| `online: false` AND `error` includes "401" | API key is wrong or expired | For local: re-run `setup-vault.mjs` to regenerate. For remote: re-fetch the key from the host's `data.json` |
| `online: false` AND `error` includes "cf_access" or "cloudflareaccess.com" | Cloudflare Access policy is blocking the request | Verify `extraHeaders` has the right `CF-Access-Client-Id` + `CF-Access-Client-Secret` and that the service token is attached to a "Service Auth" policy on the Access app |
| `missingApiKey: true` AND `type: local` | Local REST API plugin never enabled for this vault, so no `data.json` to read | Open Obsidian on this vault, enable Local REST API plugin, then re-run `setup-vault.mjs` |
| `online: true` AND `latencyMs > 500` AND `type: remote` | Functional but slow; might cause timeouts on large operations | Note it as a soft warning; consider Tailscale Funnel for a closer relay or moving to a Cloudflare Tunnel |

4. End with one of two endings:

- **All healthy**:
  > 🎉 All <n> vaults online. Ready to use.

- **Issues present**:
  > Found `<k>` issue(s). Apply the fixes above, then re-run `obsidian-router-status` to verify.

## Don't

- Don't try to fix issues automatically — this skill is a diagnostic, not a fixer. Surface the problem and let the user choose how to proceed.
- Don't expose API keys in the output.
- Don't dump the full raw JSON to the user — render the table and the issue blocks. The raw JSON is for your own consumption.
- Don't run write/delete tools as part of this skill. Read-only diagnostic.

## When this skill fails

If `list_vaults` itself errors out (e.g., the router process crashed, MCP connection dead), report that distinctly:

> ⚠️ The Obsidian router MCP didn't respond. Possible causes:
> - The router binary `obsidian-mcp-router` isn't installed (run `npm link` in the repo)
> - `~/.claude.json` doesn't have the router registered under `mcpServers.obsidian` (or whatever name)
> - Claude Desktop / Code wasn't restarted after the registration
>
> Fix: verify with `which obsidian-mcp-router` and check the `mcpServers` block in `~/.claude.json`.
