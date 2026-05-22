---
description: Apply multiple frontmatter updates at once (sequential, NOT atomic — partial failures are reported per-key). Use when updating 2+ properties on the same file in one call. (Skill `write-frontmatter-merge` handles natural-language triggers + type inference + non-atomicity reporting.)
---

Invoke the `write-frontmatter-merge` skill.

Required: `path`, `values` (object map). Optional: `vault`, `createIfMissing` (default true).

For atomic multi-key updates, the skill recommends an alternative (read + modify + `write-create-or-replace`).
