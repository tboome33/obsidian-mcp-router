---
description: Run several vault writes as ONE logical operation — before-images captured first, all-or-nothing apply, byte-for-byte rollback if any step fails, and a journal that survives a crash. Also the recovery entry point (`recover:true`). (Skill `write-bundle` handles natural-language triggers.)
---

Invoke the `write-bundle` skill.

Required: `steps` — an ordered array of `{ op, path, ...args }`, at most 25. `op` ∈ write | append | patch | set_frontmatter | merge_frontmatter | delete (a delete step still needs `confirm: true`).

Optional: `vault` (omit for default — a bundle is single-vault), `preview: true` (sealed plan, writes nothing, and flags any `ifMatch` that is already stale), `approvedPlanSha256`, per-step `ifMatch` (checked for the whole group before the first write), `recover: true` (list unfinished bundles) or `recover: "op-<hex>"` + `confirm: true` (+ optional `only: [paths]`) to replay a rollback.

Read `outcome` before reporting: `applied` · `rolled-back` · `rolled-back-unverified` (everything is back, but the undo could not be proven) · `rolled-back-partial` (say so plainly, and name what `rollback.paths` left dirty).
