---
name: discover-list-files
description: |
  List files and subdirectories inside a vault directory (or vault root).

  EN triggers: "list files in X", "show me what's in <folder>", "what's inside <folder>", "ls X", "browse the X directory".
  FR triggers : "liste les fichiers de X", "qu'est-ce qu'il y a dans <dossier>", "montre le dossier X", "ls X".

  Example / Exemple:
    EN: "list files in Sessions"
    FR: "liste les fichiers du dossier Sessions"
---

# discover-list-files

Call the obsidian-router `list_files` MCP tool with arguments parsed from $ARGUMENTS.

## Arguments

- `vault` — vault name. Optional. If omitted, the router uses its default vault.
- `directory` — directory path relative to the vault root (e.g. `Sessions`, `Trades/2026`). Optional. Omit to list root.

## Argument parsing from $ARGUMENTS

- bare path → use as `directory`
- `<vault>/<directory>` → split on first slash if the first segment matches a known vault name
- `vault=X directory=Y` or `vault=X dir=Y`
- empty → list the default vault's root

If $ARGUMENTS contains a clear vault name (matching one returned by `list_vaults`), set `vault` accordingly; otherwise leave it unset.

## Output format

Format the result as a markdown list, with directories distinguishable from files (trailing `/` or 📁 prefix). If the directory has many entries (>50), summarize counts and show the first 50.
