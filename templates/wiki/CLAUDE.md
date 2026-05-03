## Wiki Knowledge Base

Path: {{VAULT_PATH}}

When you need context not already in this conversation:

1. Read `wiki/hot.md` first (cheap, recent context).
2. If hot.md doesn't cover it, read `wiki/index.md` to find the relevant page.
3. Drill into specific wiki pages.
4. After substantive work, append a 1-line entry to `wiki/log.md`.
5. After substantive work, refresh `wiki/hot.md` with the latest state.

**Always use the `obsidian-router` MCP tools for vault reads/writes** (`mcp__obsidian-router__get_file`, `mcp__obsidian-router__write_file`, `mcp__obsidian-router__patch_file`, etc.) — they're the multi-vault aware path and work cross-project. Do NOT use Claude's native `Read`/`Write` for vault content; those work only when the project IS the vault.

**Available wiki workflows** (slash commands or natural language):
- `/obsidian-router:wiki-ingest <source>` — file a source
- `/obsidian-router:wiki-query <question>` — answer from the wiki
- `/obsidian-router:save` — file the current conversation
- `/obsidian-router:wiki-lint` — health check
- `/obsidian-router:wiki-fold` — roll up the log
- `/obsidian-router:autoresearch <topic>` — autonomous research loop
- `/obsidian-router:canvas` — visual canvas operations

The wiki pattern (Karpathy LLM-wiki) is documented in `wiki/overview.md`.
