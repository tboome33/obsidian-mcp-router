---
description: Move or rename a file (GET source → PUT destination → DELETE source — Local REST API has no native move). Reports if the source-delete step fails so you can clean up. (Skill `manage-move` handles natural-language triggers + the partial-failure mode.)
---

Invoke the `manage-move` skill.

Required: `from`, `to`. Optional: `vault`, `overwrite` (default false — refuses to clobber an existing destination).
