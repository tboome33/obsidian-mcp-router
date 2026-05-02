---
description: Append content at the end of a file. Auto-creates the file unless requireExisting=true.
---

Call the obsidian-router `append_to_file` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `path` — file path relative to vault root.
- `content` — markdown to append.

Optional:
- `vault` — vault name. Omit for default.
- `requireExisting` — if true, fail when the file does not exist. Default false (auto-create).

Argument parsing:
- if the slash line has only a path, ask the user for the content to append
- `path=X content="..."` for one-shot
- `--require-existing` or `requireExisting=true` → set the flag

Use cases:
- Daily journals, logs, running notes, captures
- For surgical edits under a specific heading or block, prefer `obsidian-write-patch` instead

After the append, report:
- `vault`, `path`, `bytesAppended`.
