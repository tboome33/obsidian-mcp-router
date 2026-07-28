---
description: Sync one vault or the whole fleet straight from the GitHub skeleton (plugins, themes, snippets, root docs) — no dev repo or local .template needed. Same guards as --sync-plugins (credential-leak refusal, BRAT anti-downgrade) plus hardened archive extraction. (Skill `sync-from-github` carries the full procedure.)
---

Invoke the `sync-from-github` skill.

Arguments: vault path(s) or `--all` (empty → interactive picker over the configured fleet) · `--ref <branch|tag>` (default `main`) · `--force` (re-clone plugins, preserving each local data.json).

The skill handles:
- Target picking (never chooses for the user when no target is given)
- Running `node scripts/setup-vault.mjs --sync-from-github …` and reporting the four outcome categories per vault (synced / refreshed / kept-newer / refused-for-safety)
- Treating safety refusals and anti-downgrade keeps as guarantees to respect, never as errors to bypass
- Reminding that touched vaults need an Obsidian reload to load new plugins
