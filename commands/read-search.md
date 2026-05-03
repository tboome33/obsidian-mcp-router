---
description: Plain-text (substring) search inside a vault, with surrounding context.
---

# read-search

Call the obsidian-router `search` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `query` — the substring to find.

Optional:
- `vault` — vault name. Omit for default. Pass `*` to fan-out across ALL vaults in parallel.
- `contextLength` — number of characters of surrounding context per match. Default 100.

Argument parsing:
- the entire $ARGUMENTS as `query` is fine for the most common case
- `vault=X query="some words"` or `vault=* query="words"`
- if user includes `--all` or "across all vaults", set `vault` to `*`

Render results as a markdown list, one per matching file:
- `<path>` (vault name if cross-vault)
  - <text snippet with surrounding context>

If many matches (>20), summarize counts and show the first 20. Suggest `read-search-smart` (semantic) if the user seems to be looking by meaning rather than literal text.
