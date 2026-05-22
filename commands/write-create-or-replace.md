---
description: Create a new file, or replace the entire content of an existing one. Pass `ifNew=true` to refuse overwrite. (Skill `write-create-or-replace` handles natural-language triggers + the overwrite-confirm safety prompt.)
---

Invoke the `write-create-or-replace` skill.

Required: `path`, `content`. Optional: `vault`, `ifNew` (default false — will overwrite). The skill previews the existing top 10 lines before overwriting unless the user explicitly said "overwrite" / "remplace".
