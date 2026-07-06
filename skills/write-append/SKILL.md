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

## On failure — remediate, NEVER fall back to filesystem writes

If the call fails, diagnose the failure class — do NOT silently redo the operation with direct-filesystem tools (`Read`/`Edit`/`Write` on the vault's real path):

- **Connection error** (`ECONNREFUSED`, timeout, "unreachable") → the vault is closed or Local REST API is off. Call `list_vaults`, then **ask the user to open the vault** via the clickable `openUri` link (message template: `default-vault-health-check` convention) and WAIT for their go-ahead.
- **Validation / API error** (HTTP 4xx) → the vault is reachable; the CALL is malformed. Fix the arguments, or fall back to a coarser ROUTER tool (`write_file` full rewrite) — still through the router.

Direct FS writes bypass the Local REST API and lose the authoritative `clickToOpenUrl` (per-vault port) — hand-guessed citation links break. (Rule added 2026-07-05 at Roland's request after an FS-fallback incident.)

## Output

After the append, report `vault`, `path`, `bytesAppended`.
