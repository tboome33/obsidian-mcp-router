---
description: Semantic search via Smart Connections embeddings. Returns ranked chunks with scores and breadcrumbs.
---

Call the obsidian-router `search_smart` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `query` — natural-language query (not a literal substring).

Optional:
- `vault` — vault name. Omit for default. Pass `*` to fan-out across ALL vaults.
- `folders` — array of folder prefixes to restrict results (e.g. `["Sessions", "Trades"]`)
- `excludeFolders` — array of folder prefixes to exclude (e.g. `[".trash", "Templates"]`)
- `limit` — max results (default 10).

Argument parsing:
- bare text → `query`, default vault, default limit
- `vault=X query="..."` → split
- `--all` or "across all vaults" → set `vault: "*"`
- `--limit 20` or `limit=20` → set `limit`
- `--in Sessions,Trades` or `folders=Sessions,Trades` → set `folders`

Pre-requisites: the target vault must have BOTH the `mcp-tools` and `smart-connections` plugins enabled, with Smart Connections having indexed the vault. If the tool returns a 503 saying smart-connections isn't available, surface that clearly and tell the user how to install it.

Render the results as a markdown list, one entry per chunk:
1. **<breadcrumbs>** — *<vault name>*, score `0.XX`
   > <first ~150 chars of text>

If no results, suggest the substring `search` tool instead, or to broaden the query.
