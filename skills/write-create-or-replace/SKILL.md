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
- `ifMatch` — a `contentSha256` from a prior `get_file` of this file. The write is refused with a 409 conflict if the file changed since you read it (optimistic concurrency). Use it whenever another session — or an Obsidian edit — could have touched the file between your read and your write. Atomic when the vault runs the bridge plugin ≥ 0.7.0, otherwise a GET-compare fallback. Mutually exclusive with `ifNew`.

## Argument parsing from $ARGUMENTS

- the user usually wants to give the path on the slash line and the content in a follow-up turn → if the slash line gives only a path, ask for the content
- `path=X content="..."` for full one-shot
- `--if-new` or `ifNew=true` → set `ifNew`
- `ifMatch=<hash>` → set `ifMatch`

## Read-modify-write safely (ifMatch)

When you are rewriting a file whose current content matters (appending to a running note by full replace, editing a shared scaffold like `hot.md`/`catalog.md`), do it as a conditional write:

1. `get_file` the path → note the `contentSha256` it returns.
2. Build the new full content from what you read.
3. `write_file` with `ifMatch=<that contentSha256>`.

If it 409s, someone changed the file since your read: re-read, rebuild your change on the current content, retry. Never respond to a 409 by dropping `ifMatch` and force-overwriting — that is exactly the clobber the guard prevents. The write result echoes the new `contentSha256`, so a chain of edits can reuse it without re-reading.

## Safety

- If overwriting an existing file (`ifNew` is not set/true), preview the existing top 10 lines first and ask the user to confirm before sending the write.
- If the user explicitly says "overwrite" or "remplace", skip the confirmation.

## On failure — remediate, NEVER fall back to filesystem writes

If the call fails, do NOT silently redo it with direct-filesystem tools (`Read`/`Edit`/`Write` on the vault's real path):
- **Connection error** (`ECONNREFUSED`, timeout) → vault closed; `list_vaults`, then ask the user to open it via the `openUri` link and wait.
- **Validation / API error** (e.g. HTTP 409 with `ifNew=true`) → resolve the conflict with the user or adjust the arguments — still through the router.

Rationale + message template: the `default-vault-health-check` convention (canonical source).

## Output

After the write, report `vault`, `path`, `bytesWritten`, and `mode` (`create-only`, `create-or-replace`, or `if-match:atomic` / `if-match:fallback` when `ifMatch` was used).
