---
description: |
  List all configured Obsidian vaults — active vaults with online status, latency, and metadata, AND disabled vaults (skipped by the disabledVaults config). Returns three fields: defaultVault, vaults[] (active), disabled[] (skipped).

  EN triggers: "list my vaults", "show me my Obsidian vaults", "what vaults do I have", "are my vaults online", "which vaults are active", "which vaults are disabled", "show me all vaults including disabled".
  FR triggers : "liste mes vaults", "montre mes vaults Obsidian", "quels vaults j'ai", "mes vaults sont-ils en ligne", "quels vaults sont actifs", "quels vaults sont désactivés", "montre tous mes vaults y compris les désactivés".

  Example / Exemple:
    EN: "list my Obsidian vaults"
    FR: "liste mes vaults Obsidian"
---

# discover-list-vaults

Call the obsidian-router `list_vaults` MCP tool. It takes no arguments.

The tool pings every ACTIVE vault in parallel and returns:
- `defaultVault` — vault used when calls omit a `vault` argument (resolved by the 5-tier cascade)
- `configPath` — where the registry is loaded from
- `vaults[]` — active vaults, each with `name`, `type` (local|remote), `baseUrl`, `online`, `latencyMs`, `missingApiKey`, `error?`, `isDefault`
- `disabled[]` — vaults skipped by the `disabledVaults` config. NOT pinged. Each entry: `name`, `type`, `reason` (currently always `"disabled"`).

Adapt the response to what the user asked:

- **"which vaults are active"** → render only the `vaults[]` table, ignore `disabled[]`
- **"which vaults are disabled"** → render only the `disabled[]` list, mention the count of active in one line
- **"list all my vaults"** / **"which vaults do I have"** (default) → render BOTH: the active table at the top, then a "Disabled (N)" subsection below with the disabled list

Active table format:
- One status line: `<n> active vault(s) · <m> online · default: <name>`
- A markdown table with columns: name | type | status (✅/⚠️/❌) | latency | path or baseUrl
- Highlight any vault that is offline, has `missingApiKey: true`, or returns an error

For unhealthy active vaults, suggest the matching `meta-status` skill or a concrete fix.

Don't pass any arguments — `list_vaults` takes none.
