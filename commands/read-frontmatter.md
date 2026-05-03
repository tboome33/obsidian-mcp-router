---
description: Read frontmatter (the whole object or one key) from a file. Types are preserved.
---

# read-frontmatter

Call the obsidian-router `get_frontmatter` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `path` — file path relative to vault root.

Optional:
- `vault` — vault name. Omit for default.
- `key` — specific frontmatter property to retrieve. Omit to get the whole frontmatter object.

Argument parsing:
- bare path → `path`, returns whole frontmatter
- `<path> <key>` → `path` + `key`
- `path=X key=Y vault=Z`

Render the result:
- If a single key was requested: `<key>: <value>` with the type-preserved value (number stays number, boolean stays boolean, array shown as YAML list, etc.). If `exists: false`, say so explicitly.
- If the whole frontmatter was returned: show it as a YAML-formatted code block.

Note: this tool reads via `application/vnd.olrapi.note+json` content negotiation, so values keep their type (numbers, booleans, arrays, nested objects) — they aren't all flattened to strings.
