---
name: write-create-or-replace
description: |
  Create a new file, or replace the entire content of an existing one. Pass ifNew=true to refuse overwrite.

  EN triggers: "create a note X", "make a file at X", "write X", "replace X with this content", "save this as X.md".
  FR triggers : "crée une note X", "fais un fichier à X", "écris X", "remplace X par ce contenu", "enregistre ça comme X.md".

  Example / Exemple:
    EN: "create a note Sessions/2026-05-03.md with my morning review"
    FR: "crée la note Sessions/2026-05-03.md avec mon point du matin"
---

# write-create-or-replace

Call the obsidian-router `write_file` MCP tool with arguments parsed from $ARGUMENTS.

## Arguments

**Required**:
- `path` — file path relative to vault root.
- `content` — full markdown content (frontmatter + body).

**Optional**:
- `vault` — vault name. Omit for default.
- `ifNew` — if true, fail with HTTP 409 when the file already exists. Default false (overwrite).

## Argument parsing from $ARGUMENTS

- the user usually wants to give the path on the slash line and the content in a follow-up turn → if the slash line gives only a path, ask for the content
- `path=X content="..."` for full one-shot
- `--if-new` or `ifNew=true` → set `ifNew`

## Safety

- If overwriting an existing file (`ifNew` is not set/true), preview the existing top 10 lines first and ask the user to confirm before sending the write.
- If the user explicitly says "overwrite" or "remplace", skip the confirmation.

## On failure — remediate, NEVER fall back to filesystem writes

If the call fails, diagnose the failure class — do NOT silently redo the operation with direct-filesystem tools (`Read`/`Edit`/`Write` on the vault's real path):

- **Connection error** (`ECONNREFUSED`, timeout, "unreachable") → the vault is closed or Local REST API is off. Call `list_vaults`, then **ask the user to open the vault** via the clickable `openUri` link (message template: `default-vault-health-check` convention) and WAIT for their go-ahead.
- **Validation / API error** (e.g. HTTP 409 with `ifNew=true`) → the vault is reachable; resolve the conflict with the user or adjust the arguments — still through the router.

Direct FS writes bypass the Local REST API and lose the authoritative `clickToOpenUrl` (per-vault port) — hand-guessed citation links break. (Rule added 2026-07-05 at Roland's request after an FS-fallback incident.)

## Output

After the write, report `vault`, `path`, `bytesWritten`, `mode` (create-only or create-or-replace).
