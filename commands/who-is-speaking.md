---
description: Identify the family member speaking in a shared family vault (e.g. `vault_tribu` with the `tribu-routing` convention installed), then lock the router to that vault + set auto-enrich mode to `Hybrid` so subsequent auto-saves route to `wiki/People/<member>/`. (Skill `who-is-speaking` handles natural-language triggers + member alias matching from the vault's CLAUDE.md table.)
---

Invoke the `who-is-speaking` skill.

ARGUMENTS: $ARGUMENTS

Required: the family member's name or one of their accepted aliases (e.g., "Roland", "roro", "papa", "Karine", "max", "nico", …) — passed via `$ARGUMENTS` above. If omitted, the skill will ASK the user explicitly before guessing.

The skill handles:
- Reading the vault's `CLAUDE.md` for the canonical members + aliases table (per-vault — never hardcoded)
- Case-insensitive matching against canonical names AND aliases
- Refusing to guess when no match — pushes back with the canonical list
- Locking the router to the family vault (`lock_vault`) + setting `Hybrid` auto-enrich mode (`set_auto_enrich_mode`) after a successful match
- Re-identification mid-session ("c'est <autre>" / "switch to <other>") without unlocking
- Push-back when the current default vault doesn't have the `tribu-routing` convention installed

Best paired with the `tribu-routing` convention. Install on a vault via `/obsidian-router:conventions install tribu-routing` then customize the members table in the vault's `CLAUDE.md`.
