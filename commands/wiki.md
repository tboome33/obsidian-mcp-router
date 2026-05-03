---
description: Bootstrap a Karpathy-style LLM wiki structure inside an Obsidian vault — scaffolds index.md, log.md, hot.md, overview.md and updates CLAUDE.md so Claude knows how to navigate. Optionally takes a mode (personal, research, business, code, domain). Use to set up a vault for ongoing knowledge management with Claude.
---

Invoke the `wiki` skill to scaffold the target vault.

Default behavior:
- Target the default vault (call `mcp__obsidian-router__list_vaults` first to identify it).
- Ask for the mode if the user didn't specify.
- Refuse if the wiki is already scaffolded — suggest `wiki-lint` instead.

Arguments (optional, conversational form):
- `vault=<name>` to target a specific vault
- `mode=<personal|research|business|code|domain>` to skip the mode question
- A 1-sentence description of the wiki's domain ("vault for tracking my AI research") — used to seed `overview.md`

Output: confirmation with paths created and a one-liner suggesting next step (try `wiki-ingest` or just start asking questions).
