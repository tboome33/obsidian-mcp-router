---
description: Create a new file, or replace the entire content of an existing one. Pass ifNew=true to refuse overwrite.
---

Call the obsidian-router `write_file` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `path` — file path relative to vault root.
- `content` — full markdown content (frontmatter + body).

Optional:
- `vault` — vault name. Omit for default.
- `ifNew` — if true, fail with HTTP 409 when the file already exists. Default false (overwrite).

Argument parsing:
- the user usually wants to give the path on the slash line and the content in a follow-up turn
  → if the slash line gives only a path, ask for the content
- `path=X content="..."` for full one-shot
- `--if-new` or `ifNew=true` → set `ifNew`

Safety:
- If overwriting an existing file (ifNew is not set/true), preview the existing top 10 lines first and ask the user to confirm before sending the write.
- If the user explicitly says "overwrite" or "remplace", skip the confirmation.

After the write, report:
- `vault`, `path`, `bytesWritten`, `mode` (create-only or create-or-replace).
