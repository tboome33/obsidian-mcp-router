---
description: Create or edit Obsidian Bases (.base files) — native database layer for dynamic tables, card views, list views, filters, formulas, and summaries over vault notes. Use to build a task tracker, reading list, project dashboard, or any frontmatter-driven view. The skill validates that referenced frontmatter properties exist before writing, and asks for clarifications when the schema is ambiguous.
---

Invoke the `obsidian-bases` skill.

Common shapes the user will ask for:
- Task tracker (`tasks.base`) — filter by `tags.contains("task")` and `status != "done"`
- Reading list (`reading.base`) — filter by path prefix (`Reading/`), grouped by status
- Wiki dashboard (`wiki/meta/dashboard.base`) — all wiki pages by type, sorted by `saved_at`
- Project portfolio — filter by tag, sorted by due date

The skill verifies via `mcp__obsidian-router__list_files` + `get_frontmatter` that the properties you're filtering on actually exist in the target scope before writing. If they don't, surface the mismatch — the base will return empty results otherwise.

Default location: `wiki/meta/` for dashboards, or a sensible domain folder. Never writes to vault root unless the user explicitly says.
