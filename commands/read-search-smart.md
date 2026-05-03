---
description: |
  Semantic search via Smart Connections embeddings. Returns ranked chunks with cosine scores and breadcrumbs. Use when the query is conceptual (meaning, not literal substring).

  EN triggers: "find notes about X", "what do I have on X", "semantic search for X", "find concepts related to X", "notes similar to <topic>".
  FR triggers : "trouve mes notes sur X", "qu'est-ce que j'ai sur X", "recherche sémantique sur X", "concepts liés à X", "notes similaires à <sujet>".

  Example / Exemple:
    EN: "find my notes about position sizing"
    FR: "trouve mes notes sur la taille de position"
---

# read-search-smart

Call the obsidian-router `search_smart` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `query` — natural-language query (not a literal substring).

Optional:
- `vault` — vault name. Omit for default. Pass `*` to fan-out across ALL vaults.
- `folders` — array of folder prefixes to restrict results (e.g. `["Sessions", "Trades"]`)
- `excludeFolders` — array of folder prefixes to exclude (e.g. `[".trash", "Templates"]`)
- `limit` — max results (default 10).

Argument parsing:
- bare text in $ARGUMENTS → `query`, default vault, default limit
- `vault=X query="..."` → split
- `--all` or "across all vaults" → set `vault: "*"`
- `--limit 20` or `limit=20` → set `limit`
- `--in Sessions,Trades` or `folders=Sessions,Trades` → set `folders`

Pre-requisites: the target vault must have BOTH the `obsidian-mcp-router-bridge` and `smart-connections` plugins enabled, with Smart Connections having indexed the vault. If the tool returns 503 saying smart-connections isn't available, surface that clearly and tell the user how to install it.

Render the results as a markdown list, one entry per chunk:
1. **<breadcrumbs>** — *<vault name>*, score `0.XX`
   > <first ~150 chars of text>

If no results, suggest the substring `read-search` skill instead, or to broaden the query.
