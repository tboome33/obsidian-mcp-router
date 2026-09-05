---
description: Declare the SECONDARY vaults of the current workspace and pick each one's write tier — read-only strict, read-only with writes on request, or read-write. Detects the vaults whose Obsidian is open besides the primary, confirms the list, binds them, then asks vault by vault. (Skill `bind-workspace` carries the full script; this command enters it at its secondary-vaults step.)
---

Invoke the `bind-workspace` skill, entering at its **secondary vaults** step (Step 6) — the user asked about the secondaries only.

Requires: the workspace already has a primary vault. Without one, the skill says so and sets the primary first (its Steps 2-5), then continues with the secondaries.

The skill handles, step by step, each with one prompt and one tool call:
- "Open the secondary vaults you want in Obsidian, close the others, tell me when it is done" — then WAITS; the primary is never listed
- Detect (`list_vaults`, `online: true`, not the primary), propose the list for confirmation, bind (`confirm_workspace_binding` with `also`, earlier secondaries kept)
- One question per new secondary — strict / on request / read-write — then `set_secondary_vault_mode`
- Summary table, and where the answers live (the user's own router config, this workspace only)
