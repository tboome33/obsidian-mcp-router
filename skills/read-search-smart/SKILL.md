---
name: read-search-smart
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

## Arguments

**Required**:
- `query` — natural-language query (not a literal substring).

**Optional**:
- `vault` — vault name. Omit for default. Pass `*` to fan-out across ALL vaults.
- `folders` — array of folder prefixes to restrict results (e.g. `["Sessions", "Trades"]`).
- `excludeFolders` — array of folder prefixes to exclude (e.g. `[".trash", "Templates"]`).
- `limit` — max results (default 10).
- `tier` — which engine answers: `auto` (default), `semantic`, or `local`. See below.

## Argument parsing from $ARGUMENTS

- bare text in $ARGUMENTS → `query`, default vault, default limit
- `vault=X query="..."` → split
- `--all` or "across all vaults" → set `vault: "*"`
- `--limit 20` or `limit=20` → set `limit`
- `--in Sessions,Trades` or `folders=Sessions,Trades` → set `folders`
- `--local` / "recherche déterministe" / "sans plugin" → set `tier: "local"`
- `--semantic-only` → set `tier: "semantic"`

## The two tiers (v0.63.0, borrowing C4)

| tier | engine | needs |
|---|---|---|
| `semantic` | Smart Connections embeddings (cosine) | bridge + smart-connections plugins, indexed |
| `local` | local BM25 index (deterministic, pure JS) | `build_search_index` has been run once |

`auto` (the default) tries semantic and, **only when that tier cannot serve this vault** (plugin absent / route missing), falls back **entirely** to the local BM25 index. The two are **never blended** — their score scales are incomparable — and the response says which one answered.

**Never present a fallback result as a semantic one.** If the response carries `tier: "local-bm25"` with a `fallback` object, say so in one short line, e.g. *"Smart Connections isn't available on this vault — these come from the local BM25 index."*

## Pre-requisites

None for `tier: "local"` beyond a built index. For the semantic tier the vault needs BOTH the `obsidian-mcp-router-bridge` and `smart-connections` plugins enabled and indexed — but you no longer need to handle that as an error: `auto` degrades on its own and labels the result.

Two failures you must NOT paper over:
- **An absent/empty local index** → the tool refuses with a message naming `build_search_index`. Relay it; offer to run `/obsidian-router:build-search-index`. Do **not** report it as "no results found".
- **A semantic tier that errors for any other reason** (auth, timeout, a genuine bridge malfunction) → it surfaces on purpose. Report it; don't silently retry in `local`.

## Output format

Render the results as a markdown list, one entry per chunk:

```
1. **<breadcrumbs or section>** — *<vault name>*, score `0.XX`
   > <first ~150 chars of text>
```

Lead with the tier when it isn't plain semantic. Local hits carry `title`, `section` (the heading path) and `description` — use them as the breadcrumb.

If no results, suggest the substring `read-search` skill instead, or to broaden the query.
