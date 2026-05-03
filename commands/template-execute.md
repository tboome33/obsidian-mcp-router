---
description: Execute a Templater template, optionally writing the rendered output to a new file.
---

# template-execute

Call the obsidian-router `execute_template` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `name` — path to the template file in the vault (e.g. `Templates/Daily.md`).

Optional:
- `vault` — omit for default.
- `arguments` — key/value object exposed inside the template via `tp.mcpTools.prompt("key")`. Note: directly under `tp`, NOT under `tp.user`.
- `createFile` — if true, save the rendered output to `targetPath`.
- `targetPath` — path where to save (required when `createFile: true`).

Argument parsing:
- bare path → `name` only, no createFile (preview mode)
- `name=X arguments={"k":"v"} createFile=true targetPath=Y`
- conversational: "execute Templates/Trade.md with ticker AAPL and create file Trades/AAPL.md" → infer the structure

Pre-requisites: the target vault must have the `templater-obsidian` plugin enabled. If the tool returns 503 with "Templater plugin is not available", surface that clearly.

The obsidian-mcp-router-bridge plugin (which exposes `/templates/execute`) monkey-patches Templater so `tp.mcpTools.prompt("key")` returns whatever you put in the `arguments` map. This is **directly under `tp`**, not under `tp.user` (which is the convention for Templater user scripts) — easy footgun.

After execution:
- If `createFile` was true: report the rendered content and confirm the file was written at `targetPath`
- If `createFile` was false: just show the rendered content (preview mode)
