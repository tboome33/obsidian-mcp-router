---
description: Surgical edit — insert/replace under a specific heading, block id, or frontmatter key.
---

Call the obsidian-router `patch_file` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `path` — file path relative to vault root.
- `operation` — `append`, `prepend`, or `replace`.
- `targetType` — `heading`, `block`, or `frontmatter`.
- `target` — the target identifier:
    * heading → the FULL heading path joined by `::` (e.g. `Section 1::Subsection`). Just the heading name alone won't work; the parent path is required.
    * block → the block id without the leading `^` (e.g. `atp-config`).
    * frontmatter → the property name (e.g. `status`).
- `content` — new content. String for heading/block; for frontmatter accepts string/number/boolean/array/object (types preserved).

Optional:
- `vault` — omit for default.
- `targetDelimiter` — override the heading delimiter (default `::`).
- `createTargetIfMissing` — create the target if absent (heading/frontmatter only).
- `applyIfContentPreexists` — skip if target already contains the content (idempotency).
- `trimTargetWhitespace` — trim whitespace around the target before applying.

Argument parsing:
- This tool has many parameters. If $ARGUMENTS doesn't make the intent crystal-clear, ask the user before calling. A typical bare invocation should be `path=... operation=... targetType=... target=... content=...`.

Common quick patterns:
- Set a frontmatter key: `path=X operation=replace targetType=frontmatter target=<key> content=<value>` (consider using `obsidian-write-frontmatter-set` instead — friendlier wrapper)
- Append under a heading: `path=X operation=append targetType=heading target="Section::Sub" content="..."`
- Replace a block: `path=X operation=replace targetType=block target=<block-id> content="..."`

After the patch, report what was patched (target type, target, operation).
