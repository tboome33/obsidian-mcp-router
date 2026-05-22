---
description: Set or replace a single frontmatter property. Type-preserving (numbers stay numbers, arrays stay arrays). (Skill `write-frontmatter-set` handles natural-language triggers + type inference.)
---

Invoke the `write-frontmatter-set` skill.

Required: `path`, `key`, `value` (string/number/boolean/null/array/object). Optional: `vault`, `createIfMissing` (default true).

For multiple keys at once, prefer `write-frontmatter-merge`.
