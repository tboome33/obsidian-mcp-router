---
description: Restrict the router to a single vault for the current session (single-vault isolation mode). Pass "persist" to record the lock on this workspace's binding, so it survives a restart. (Skill `lock` handles natural-language triggers + edge cases like switching while already locked.)
---

Invoke the `lock` skill.

Required: the vault name to lock to.

Optional: `persist` (default false) — when true, records `locked: true` on this workspace's binding in the user's router config (what a restart reads) and writes `OBSIDIAN_ROUTER_LOCKED=<vault>` to `<cwd>/.env` as a portable hint. A lock named only by a project file is not applied at start-up, so `persisted` in the result is false when the config could not be written.

The skill handles:
- Argument parsing (bare name, `<name> --persist`, conversational phrasing)
- Verification the vault is in the active set (refuses with the known-vaults list if not)
- Default-`persist=true` inference from phrasings like *"de manière permanente"*
- Push-back when the user is already locked to a different vault
- Homedir refusal when persisting from `~` (in-memory still applies)
