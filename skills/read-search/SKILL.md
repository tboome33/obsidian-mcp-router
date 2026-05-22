---
name: read-search
description: |
  Plain-text (substring) search inside a vault, with surrounding context.

  EN triggers: "find <text> in my vault", "search for the literal string X", "grep for X", "where do I mention X", "find files containing X".
  FR triggers : "trouve <texte> dans mon vault", "cherche la chaîne X littéralement", "grep <X>", "où est-ce que je mentionne X", "trouve les fichiers contenant X".

  Example / Exemple:
    EN: "find 'risk management' in my vault"
    FR: "cherche 'gestion du risque' dans mes notes"
---

# read-search

Call the obsidian-router `search` MCP tool with arguments parsed from $ARGUMENTS.

## Arguments

**Required**:
- `query` — the substring to find.

**Optional**:
- `vault` — vault name. Omit for default. Pass `*` to fan-out across ALL vaults in parallel.
- `contextLength` — number of characters of surrounding context per match. Default 100.

## Argument parsing from $ARGUMENTS

- the entire $ARGUMENTS as `query` is fine for the most common case
- `vault=X query="some words"` or `vault=* query="words"`
- if user includes `--all` or "across all vaults", set `vault` to `*`

## Output format

Render results as a markdown list, one per matching file:

```
<path> (vault name if cross-vault)
  - <text snippet with surrounding context>
```

If many matches (>20), summarize counts and show the first 20. Suggest `read-search-smart` (semantic) if the user seems to be looking by meaning rather than literal text.
