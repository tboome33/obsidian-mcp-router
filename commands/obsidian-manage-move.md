---
description: Move or rename a file. GET source → PUT destination → DELETE source.
---

Call the obsidian-router `move_file` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `from` — source path relative to vault root.
- `to` — destination path relative to vault root.

Optional:
- `vault` — omit for default.
- `overwrite` — if true, replace an existing destination. Default false (refuses).

Argument parsing:
- `<from> <to>` — most natural form, two paths separated by space
- `from=X to=Y`
- `--overwrite` or `overwrite=true` → set the flag

Implementation notes (for the user's awareness, not for execution):
- The Local REST API plugin has no native move endpoint. The router falls back to GET source → PUT destination → DELETE source.
- If the DELETE step fails after the PUT, the file is duplicated. The tool returns `sourceDeleted: false` and a `warning` field — surface this clearly so the user can clean up manually if needed.

After the move, report `from`, `to`, `overwrite`, `moved`, `sourceDeleted` (and any warning).
