---
name: write-append
description: |
  Append content at the end of a file. Auto-creates the file unless requireExisting=true. Best for daily journals, logs, running captures.

  EN triggers: "add to X", "append to my journal", "log this in X", "tack on the end of X", "add a line to X".
  FR triggers : "ajoute à X", "append dans mon journal", "log ça dans X", "rajoute à la fin de X", "ajoute une ligne à X".

  Example / Exemple:
    EN: "append 'closed AAPL position +2.3%' to Trades/journal.md"
    FR: "ajoute 'fermé position AAPL +2,3%' à Trades/journal.md"
---

# write-append

Call the obsidian-router `append_to_file` MCP tool with arguments parsed from $ARGUMENTS.

## Arguments

**Required**:
- `path` — file path relative to vault root.
- `content` — markdown to append.

**Optional**:
- `vault` — vault name. Omit for default.
- `requireExisting` — if true, fail when the file does not exist. Default false (auto-create).

## Argument parsing from $ARGUMENTS

- if the slash line has only a path, ask the user for the content to append
- `path=X content="..."` for one-shot
- `--require-existing` or `requireExisting=true` → set the flag

## Use cases

- Daily journals, logs, running notes, captures
- For surgical edits under a specific heading or block, prefer `write-patch` instead

## Output

After the append, report `vault`, `path`, `bytesAppended`.
