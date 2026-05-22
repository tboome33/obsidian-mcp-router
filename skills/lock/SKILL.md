---
name: lock
description: |
  Restrict the router to a single vault for the current session (single-vault isolation mode). While locked, tool calls targeting any other vault are refused, cross-vault fan-out (`vault: "*"`) is refused, and tool calls without an explicit `vault` resolve to the locked one. Lift the lock with `/obsidian-router:unlock`. Pass "persist" to write the lock into the workspace `.env` so it survives a Claude Code restart.

  EN triggers: "lock to vault X", "lock the router to X", "I only want to work on vault X", "restrict me to X", "isolate to vault X", "single-vault mode on X".
  FR triggers : "verrouille sur le vault X", "lock le router sur X", "je ne veux travailler que sur le vault X", "restreins-moi à X", "isole sur le vault X", "mode mono-vault sur X".

  Example / Exemple:
    EN: "lock to tradingview, persist this so it stays after restart"
    FR: "verrouille sur tradingview de manière permanente"
---

# lock

Invoke the `lock_vault` MCP tool.

## Argument parsing from $ARGUMENTS

- bare vault name → `vault=<name>`, persist defaults to false
- `<name> --persist` or "permanently" / "persist" / "de manière permanente" / "qui survit au restart" → `persist=true`
- `vault=X persist=true` — explicit form

## Always

- Verify the named vault is in the active set (the tool itself does this and refuses otherwise — surface the error clearly to the user, including the list of known vaults).
- After a successful lock, confirm to the user: which vault, whether the lock is volatile or persisted, and where the `.env` was written if persisted.
- If the user phrased it persistently ("permanently", "de manière permanente", "à chaque démarrage") but didn't explicitly say "persist", default `persist=true` — that's clearly their intent.
- If the user phrased it temporarily ("just for now", "juste pour cette session", "pour l'instant"), default `persist=false`.

## Push back if

- The vault name is missing or ambiguous → ask for the explicit name.
- The user is already locked to a different vault → tell them, ask if they want to switch (which means re-running `lock` with the new name) or `unlock` first.

## Homedir refusal caveat (persist mode only)

If the user asks for a persistent lock from their home directory (e.g., they launched Claude Code from `~` rather than a project folder), the tool refuses with an explicit error and the in-memory lock still applies for the session. Surface the message verbatim — it tells them how to fix it (run from a real project directory, or set `OBSIDIAN_ROUTER_LOCKED=<vault>` in their shell profile / PowerShell `$PROFILE`). Do not retry the persist call from the same cwd.
