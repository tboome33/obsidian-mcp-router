---
description: Execute a Templater template, optionally writing the rendered output to a new file. Arguments are exposed inside the template via `tp.mcpTools.prompt("key")` (directly under `tp`, NOT under `tp.user` — easy footgun). (Skill `template-execute` handles natural-language triggers + the footgun warning.)
---

Invoke the `template-execute` skill.

Required: `name` — path to the template file (e.g. `Templates/Daily.md`).

Optional: `vault`, `arguments` (key/value object exposed via `tp.mcpTools.prompt("key")`), `createFile`, `targetPath` (required when `createFile: true`).

The skill handles:
- Argument parsing (bare path, structured form, conversational phrasing)
- Pre-requisite check (target vault must have the `templater-obsidian` plugin enabled — 503 with clear error otherwise)
- The `tp.mcpTools` vs `tp.user.mcpTools` footgun (the bridge plugin monkey-patches under `tp` directly, NOT under `tp.user`)
- Reporting rendered content and file-write confirmation
