---
name: write-frontmatter-merge
description: |
  Apply multiple frontmatter updates at once (sequential, NOT atomic — partial failures are reported per-key). Use when you want to update 2+ properties on the same file in one call.

  EN triggers: "update multiple properties on X", "set status, score, and tags on X", "mark Y as closed with outcome stopped", "bulk-update the metadata of X".
  FR triggers : "mets à jour plusieurs propriétés sur X", "définis status, score et tags sur X en une fois", "marque Y comme closed avec outcome stopped", "mets à jour plusieurs métadonnées de X d'un coup".

  Example / Exemple:
    EN: "on Trades/AAPL.md set status=closed outcome=tp1 closed_at=2026-05-03"
    FR: "sur Trades/AAPL.md mets status=closed outcome=tp1 closed_at=2026-05-03"
---

# write-frontmatter-merge

Call the obsidian-router `merge_frontmatter` MCP tool with arguments parsed from $ARGUMENTS.

## Arguments

**Required**:
- `path` — file path relative to vault root.
- `values` — object map of keys/values to set.

**Optional**:
- `vault` — omit for default.
- `createIfMissing` — create absent keys. Default true.

## Argument parsing from $ARGUMENTS

- `path=X k1=v1 k2=v2 k3=v3` — most natural form
- `path=X values={"k1":"v1","k2":"v2"}` — JSON-explicit form
- the user might phrase it conversationally: *"marque le trade comme closed avec outcome=stopped"* → infer values

## Type inference per value

- numeric → number
- `true`/`false` → boolean
- `null` → null
- `[...]` → JSON array
- `{...}` → JSON object
- otherwise → string

## ⚠️ Not atomic

This is NOT atomic. If applying 5 updates and the 3rd fails, the first two are already applied. The tool returns a per-key status — surface that result honestly:

- N succeeded, M failed
- list the failed keys with their error

For atomic multi-key updates, the alternative is to read the current frontmatter (`read-frontmatter`), modify the object client-side, and `write-create-or-replace` the entire file back — but that rewrites the body too.
