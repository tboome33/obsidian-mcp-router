---
description: Apply multiple frontmatter updates at once (sequential, NOT atomic — see notes).
---

Call the obsidian-router `merge_frontmatter` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `path` — file path relative to vault root.
- `values` — object map of keys/values to set.

Optional:
- `vault` — omit for default.
- `createIfMissing` — create absent keys. Default true.

Argument parsing:
- `path=X k1=v1 k2=v2 k3=v3` — most natural form
- `path=X values={"k1":"v1","k2":"v2"}` — JSON-explicit form
- the user might phrase it conversationally: "marque le trade comme closed avec outcome=stopped" → infer values

Type inference per value:
- numeric → number
- `true`/`false` → boolean
- `null` → null
- `[...]` → JSON array
- `{...}` → JSON object
- otherwise → string

⚠️ Important: this is NOT atomic. If applying 5 updates and the 3rd fails, the first two are already applied. The tool returns a per-key status — surface that result honestly:
- N succeeded, M failed
- list the failed keys with their error

For atomic multi-key updates, the alternative is to read the current frontmatter (`get_frontmatter`), modify the object client-side, and `write_file` the entire file back — but that rewrites the body too.
