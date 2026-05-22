---
description: Permanently delete a file. Requires explicit `confirm=true` on a second invocation — first call shows a preview and refuses. (Skill `manage-delete` handles natural-language triggers + the two-step confirm guard.)
---

Invoke the `manage-delete` skill.

Required: `path`. Second-invocation: `confirm=true` to proceed.

The skill enforces a two-step protocol: first call shows a preview and refuses; second call with `confirm=true` actually deletes. Designed against accidental deletes from hallucinated tool calls.
