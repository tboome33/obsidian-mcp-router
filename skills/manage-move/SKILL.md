---
name: manage-move
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

## Arguments

**Required**:
- `from` — source path relative to vault root.
- `to` — destination path relative to vault root.

**Optional**:
- `vault` — omit for default.
- `overwrite` — if true, replace an existing destination. Default false (refuses).

## Argument parsing from $ARGUMENTS

- `<from> <to>` — most natural form, two paths separated by space
- `from=X to=Y`
- `--overwrite` or `overwrite=true` → set the flag

## Implementation note — partial-failure mode

The Local REST API plugin has no native move endpoint. The router falls back to GET source → PUT destination → DELETE source.

If the DELETE step fails after the PUT, the file is duplicated. The tool returns `sourceDeleted: false` and a `warning` field — surface this clearly so the user can clean up manually if needed.

## On failure — remediate, NEVER fall back to filesystem operations

If the call fails, diagnose the failure class — do NOT silently redo the move with direct-filesystem tools (shell `mv`, `Write`+delete on the vault's real path):

- **Connection error** (`ECONNREFUSED`, timeout, "unreachable") → the vault is closed or Local REST API is off. Call `list_vaults`, then **ask the user to open the vault** via the clickable `openUri` link (message template: `default-vault-health-check` convention) and WAIT for their go-ahead.
- **Validation / API error** (e.g. destination exists without `overwrite`) → the vault is reachable; resolve with the user or adjust the arguments — still through the router.

Direct FS operations bypass the Local REST API and lose the authoritative `clickToOpenUrl` (per-vault port) — hand-guessed citation links break. (Rule added 2026-07-05 at Roland's request after an FS-fallback incident.)

## Output

After the move, report `from`, `to`, `overwrite`, `moved`, `sourceDeleted` (and any warning).
