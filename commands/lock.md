---
description: Restrict the router to a single vault for the current session (single-vault isolation mode). Pass "persist" to write the lock into the workspace `.env`. (Skill `lock` handles natural-language triggers + edge cases like switching while already locked.)
---

Invoke the `lock` skill.

Required: the vault name to lock to.

Optional: `persist` (default false) — when true, writes `OBSIDIAN_ROUTER_LOCKED=<vault>` to `<cwd>/.env` so the lock survives a Claude Code restart.

The skill handles:
- Argument parsing (bare name, `<name> --persist`, conversational phrasing)
- Verification the vault is in the active set (refuses with the known-vaults list if not)
- Default-`persist=true` inference from phrasings like *"de manière permanente"*
- Push-back when the user is already locked to a different vault
- Homedir refusal when persisting from `~` (in-memory still applies)
