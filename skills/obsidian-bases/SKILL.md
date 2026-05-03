---
name: obsidian-bases
description: Create or edit Obsidian Bases (.base files) — the native database layer for dynamic tables, card views, list views, filters, formulas, and summaries over vault notes. Bases query the vault by frontmatter properties and tags, then render as table/card/list views. Use when the user says "create a base", "make a database view", "obsidian base", "filter notes into a table", "task tracker base", "reading list base", "/obsidian-bases", or any phrasing implying a queryable, filterable view of vault content.
---

# obsidian-bases

Obsidian Bases (released late 2025) are YAML files with `.base` extension that produce live database-like views. They're under-documented; this skill gets the syntax right.

## When to use

- The user wants a dynamic view of notes by some property (dates, tags, status, project).
- The user has a frontmatter convention (e.g., every project note has `status: active|done`) and wants a filtered table.
- A wiki dashboard — `wiki/meta/dashboard.base` is a common pattern: tasks-by-status, recent saves, source list.

## When NOT to use

- The user wants a static list → just write a markdown file with a list.
- The user wants chart visualizations → Bases don't render charts; suggest the Charts plugin or the `canvas` skill.

## .base file format

```yaml
filters:
  and:
    - 'file.path.startsWith("Projects/")'
    - 'status != "archived"'

properties:
  status:
    displayName: "Status"
  due:
    displayName: "Due Date"

views:
  - type: table
    name: "Active Projects"
    order:
      - file.name
      - status
      - due
    sort:
      - column: due
        direction: ASC
    columnSize:
      file.name: 280
      status: 100

  - type: cards
    name: "By Status"
    cardSize: medium
    grouping:
      by: status
```

Key concepts:

- **`filters`** — boolean expression tree (`and`, `or`, `not`). Atoms are JS-ish expressions over `file.*` and frontmatter properties. Common atoms:
  - `file.path.startsWith("X")` / `endsWith` / `contains`
  - `file.name == "X"`
  - `<frontmatter-key> == "value"` (also `!=`, `>`, `<`, `>=`, `<=`, `in`, `contains`)
  - `tags.contains("project")`
  - `file.cday` (creation day), `file.mday` (modified day) — date math: `file.mday > date("2026-01-01")`

- **`properties`** — declared columns the views can show. `displayName` overrides the raw frontmatter key.

- **`views`** — one or more views over the same filtered set. Each has `type` (`table`, `cards`, `list`), `name`, optional `order` (column order), `sort`, `grouping`, `columnSize`, etc.

## Steps

### 1. Clarify the schema

Before writing the base, you need:
- Which folder/path scope (root? `Projects/`? `wiki/`?)
- Which frontmatter properties the user uses
- Which property values are meaningful (status enum? tag list?)
- What views they want (table/cards/list, sorted by what?)

Ask 1-2 short questions if unclear. Don't write a base on assumptions — it's the kind of thing that's annoying to debug if the filter is wrong.

### 2. Verify properties exist

Sample a few notes from the target scope (`mcp__obsidian-router__list_files` then `get_frontmatter` on 3-5 of them) to confirm the frontmatter keys you're filtering on actually appear. If they don't, surface this — the base will return empty results.

### 3. Compose the YAML

Build the filter, properties, and views per the schema. Common patterns:

**Task tracker** (`tasks.base`):
```yaml
filters:
  and:
    - 'tags.contains("task")'
    - 'status != "done"'
properties:
  due: { displayName: "Due" }
  priority: { displayName: "P" }
views:
  - type: table
    name: "Open Tasks"
    order: [file.name, priority, due]
    sort:
      - { column: priority, direction: ASC }
      - { column: due, direction: ASC }
```

**Reading list** (`reading.base`):
```yaml
filters:
  and:
    - 'file.path.startsWith("Reading/")'
properties:
  status: { displayName: "Status" }
  rating: { displayName: "Rating" }
views:
  - type: cards
    name: "By Status"
    grouping: { by: status }
    cardSize: medium
```

**Wiki dashboard** (`wiki/meta/dashboard.base`):
```yaml
filters:
  and:
    - 'file.path.startsWith("wiki/")'
    - 'type != "fold"'
properties:
  type: { displayName: "Type" }
  saved_at: { displayName: "Filed" }
views:
  - type: table
    name: "All Pages"
    order: [file.name, type, saved_at]
    sort: [{ column: saved_at, direction: DESC }]
  - type: cards
    name: "By Type"
    grouping: { by: type }
```

### 4. Write the file

```
mcp__obsidian-router__write_file({
  vault: <name>,
  path: "<path>.base",
  content: <yaml>,
  ifNew: true
})
```

If the path already exists: read it, propose a diff, ask before overwriting.

### 5. Tell the user where to see it

Bases render in the Obsidian UI when opened. The user must open the `.base` file in Obsidian to see the live view. Mention this — they might not realize it's not a markdown file.

## Anti-patterns

- Don't fabricate frontmatter properties the vault doesn't actually use. Verify first.
- Don't write `.base` files at the vault root unless the user asked. Default to `wiki/meta/` or a sensible domain folder.
- Don't try to filter by free-text body content — Bases filter on properties (frontmatter + tags + file.*), not on body content.
- Don't add a `formula:` field unless you're sure of the syntax — Obsidian Bases formula syntax is fragile and version-dependent. When in doubt, use sortable string properties.

## Output format

> ✅ Created `<path>.base` with N filters, M properties, V views.
> Open it in Obsidian to see the live view.
> Schema preview:
> ```yaml
> <key fields>
> ```
