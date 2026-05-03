---
description: |
  Move or rename a file. The router does GET source → PUT destination → DELETE source (Local REST API has no native move). Reports if the source-delete step fails so you can clean up.

  EN triggers: "rename X to Y", "move X to Y", "relocate X into <folder>", "move X into the archive", "send X to <folder>".
  FR triggers : "renomme X en Y", "déplace X vers Y", "déplace X dans <dossier>", "archive X", "envoie X dans <dossier>".

  Example / Exemple:
    EN: "rename Sessions/draft.md to Sessions/2026-05-03.md"
    FR: "renomme Sessions/draft.md en Sessions/2026-05-03.md"
---

# manage-move

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
