---
description: List all configured Obsidian vaults with online status, latency, and any issues.
---

# discover-list-vaults

Call the obsidian-router `list_vaults` MCP tool. It takes no arguments.

The tool pings every configured vault in parallel and returns:
- `defaultVault` — vault used when calls omit a `vault` argument
- `configPath` — where the registry is loaded from
- `vaults[]` — each with `name`, `type` (local|remote), `baseUrl`, `online`, `latencyMs`, `missingApiKey`, `error?`

Render the result as a compact summary:
- One status line: `<n> vault(s) configured · <m> online · default: <name>`
- A markdown table with columns: name | type | status (✅/⚠️/❌) | latency | path or baseUrl
- Highlight any vault that is offline, has `missingApiKey: true`, or returns an error
- For unhealthy vaults, suggest the matching `meta-status` skill or a concrete fix

Don't pass any arguments unless the user explicitly asks to filter or test something specific.
