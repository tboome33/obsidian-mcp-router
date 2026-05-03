---
description: |
  Create or edit Obsidian Bases (.base files) — native database layer for dynamic tables, card views, list views, filters, formulas, and summaries over vault notes. Use to build a task tracker, reading list, project dashboard, or any frontmatter-driven view. The skill validates that referenced frontmatter properties exist before writing, and asks for clarifications when the schema is ambiguous.

  EN triggers: "create a base for X", "make a database view of my Y", "filter my notes into a table", "task tracker base", "reading list base", "create an Obsidian base".
  FR triggers : "crée une base pour X", "fais une vue tableau de mes Y", "filtre mes notes dans un tableau", "base task tracker", "base reading list", "crée une base Obsidian".

  Example / Exemple:
    EN: "create a tasks base filtering on tag=task and status!=done"
    FR: "crée une base tasks qui filtre sur tag=task et status!=done"
---

Invoke the `obsidian-bases` skill.

Common shapes the user will ask for:
- Task tracker (`tasks.base`) — filter by `tags.contains("task")` and `status != "done"`
- Reading list (`reading.base`) — filter by path prefix (`Reading/`), grouped by status
- Wiki dashboard (`wiki/meta/dashboard.base`) — all wiki pages by type, sorted by `saved_at`
- Project portfolio — filter by tag, sorted by due date

The skill verifies via `mcp__obsidian-router__list_files` + `get_frontmatter` that the properties you're filtering on actually exist in the target scope before writing. If they don't, surface the mismatch — the base will return empty results otherwise.

Default location: `wiki/meta/` for dashboards, or a sensible domain folder. Never writes to vault root unless the user explicitly says.
