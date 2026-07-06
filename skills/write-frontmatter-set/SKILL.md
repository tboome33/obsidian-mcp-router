---
name: write-frontmatter-set
description: |
  Set or replace a single frontmatter property. Type-preserving (numbers stay numbers, arrays stay arrays).

  EN triggers: "set status to X on Y", "tag this with X", "set the property X on Y", "mark Y as <status>", "change the score of X to Y".
  FR triggers : "passe le statut de Y à X", "tag ça avec X", "mets la property X sur Y", "marque Y comme <statut>", "change le score de X à Y".

  Example / Exemple:
    EN: "set status to closed on Trades/AAPL.md"
    FR: "passe le statut de Trades/AAPL.md à closed"
---

# write-frontmatter-set

Call the obsidian-router `set_frontmatter` MCP tool with arguments parsed from $ARGUMENTS.

## Arguments

**Required**:
- `path` — file path relative to vault root.
- `key` — frontmatter property name (e.g. `status`, `tags`, `score`).
- `value` — new value. Supports any of: string, number, boolean, null, array, object. Types are preserved end-to-end (a number stays a number in YAML, an array stays an array, etc.).

**Optional**:
- `vault` — omit for default.
- `createIfMissing` — create the key if absent. Default true.

## Argument parsing from $ARGUMENTS

- `<path> <key>=<value>` — common shorthand (single key=value pair after the path)
- `path=X key=Y value=Z` — explicit
- `--no-create` → set `createIfMissing=false`

## Type inference from $ARGUMENTS

- numeric literal (e.g. `3.14`) → number
- `true`/`false` → boolean
- `null` → null
- starts with `[` → JSON-parse as array
- starts with `{` → JSON-parse as object
- otherwise → string

## On failure — remediate, NEVER fall back to filesystem writes

If the call fails, diagnose the failure class — do NOT silently redo the operation with direct-filesystem tools (`Read`/`Edit`/`Write` on the vault's real path):

- **Connection error** (`ECONNREFUSED`, timeout, "unreachable") → the vault is closed or Local REST API is off. Call `list_vaults`, then **ask the user to open the vault** via the clickable `openUri` link (message template: `default-vault-health-check` convention) and WAIT for their go-ahead.
- **Validation / API error** (HTTP 4xx) → the vault is reachable; the CALL is malformed. Fix the arguments — still through the router.

Direct FS writes bypass the Local REST API and lose the authoritative `clickToOpenUrl` (per-vault port) — hand-guessed citation links break. (Rule added 2026-07-05 at Roland's request after an FS-fallback incident.)

## Output

After the set, confirm: `<path>: <key> = <value>`.

For setting multiple keys at once, prefer `write-frontmatter-merge`.
