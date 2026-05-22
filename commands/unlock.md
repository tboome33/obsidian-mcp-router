---
description: Lift the single-vault lock and restore normal multi-vault routing. Pass "persist" to also remove `OBSIDIAN_ROUTER_LOCKED` from the workspace `.env`. (Skill `unlock` handles natural-language triggers + no-op edge cases.)
---

Invoke the `unlock` skill.

Optional: `persist` (default false) — when true, also removes the `OBSIDIAN_ROUTER_LOCKED` line from `<cwd>/.env` (otherwise the lock would re-apply at next router restart if the variable is still in the file).

The skill handles:
- Argument parsing (empty, `"persist"`, conversational phrasing like *"et nettoie le .env"*)
- Gentle no-op surfacing when the router wasn't locked
- Info-level surfacing when `persist=true` but `.env` had nothing to remove
- Push-back when the user tries to unlock + switch in one breath (suggest `/obsidian-router:lock <new-vault>` directly)
