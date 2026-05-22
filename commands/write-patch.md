---
description: Surgical edit — insert/replace under a specific heading, block id, or frontmatter key. Use when modifying ONE section of a long note without rewriting the whole file. (Skill `write-patch` handles natural-language triggers + the heading-full-path rule.)
---

Invoke the `write-patch` skill.

Required: `path`, `operation` (`append` / `prepend` / `replace`), `targetType` (`heading` / `block` / `frontmatter`), `target`, `content`.

Optional: `vault`, `targetDelimiter` (default `::`), `createTargetIfMissing`, `applyIfContentPreexists`, `trimTargetWhitespace`.

The skill documents the heading-target footgun (must be the FULL heading path joined by `::`, not just the immediate heading name).
