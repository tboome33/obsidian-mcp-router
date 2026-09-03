---
name: unlock
description: |
  Lift the single-vault lock and restore normal multi-vault routing. Pass "persist" to ALSO lift the lock where a restart reads it from — the `locked` flag on this workspace's binding in the user's router config — and to remove the `OBSIDIAN_ROUTER_LOCKED` hint from the workspace `.env`. Without it, a lock recorded on the binding comes back at the next start; a leftover `.env` line on its own does not, since a lock named only by a project file is no longer applied.

  EN triggers: "unlock vaults", "unlock the router", "I want access to all vaults again", "give me back multi-vault mode", "exit single-vault mode", "lift the lock".
  FR triggers : "déverrouille les vaults", "unlock le router", "je veux pouvoir avoir accès à tous les vaults", "redonne-moi le mode multi-vault", "sors du mode mono-vault", "lève le verrou".

  Example / Exemple:
    EN: "unlock and clean up the .env"
    FR: "déverrouille et nettoie le .env"
---

# unlock

Invoke the `unlock_vaults` MCP tool.

## Argument parsing from $ARGUMENTS

- empty → `persist=false` (in-memory only)
- "persist" / "permanently" / "de manière permanente" / "et nettoie le .env" → `persist=true`
- `persist=true` / `persist=false` — explicit

## Always

- After a successful unlock, confirm to the user: previous lock target (if any), whether the `.env` was cleaned, and that the router is back in normal multi-vault mode.
- If the router wasn't locked, the tool returns a no-op message. Surface that gently — no need to be dramatic.
- If the user said "persist" but the `.env` didn't have `OBSIDIAN_ROUTER_LOCKED`, the tool reports `persistRemoved: false` — surface that as an info ("nothing to clean up in .env"). The field that matters is `bindingLifted`: **true** means no lock is recorded for this workspace in the router config any more — either it was lifted, or there never was one — so nothing comes back at the next start. **False means the router config could not be written**, so a lock recorded there (if any) WILL come back; say that plainly and point at the config's permissions. Do not report a lock as "still recorded" on a false: the tool cannot see whether one existed when the write failed. One field overrides all of that: **`hostReimposes: true`** means the lock came from the host's `OBSIDIAN_ROUTER_LOCKED` (the MCP declaration or the shell), which no persist can lift — say plainly that it WILL come back at the next start until that variable is removed where it is set, and do not promise otherwise even though `bindingLifted` is true.

## Push back if

- The user wants to unlock and switch to a different vault in the same breath — that's two operations. Suggest `/obsidian-router:lock <new-vault>` directly (`lock_vault` overrides the previous lock without needing an unlock).
