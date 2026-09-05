---
description: Deterministic wizard to bind the current workspace to a PRIMARY vault (detects the open vaults, asks which one, confirms, binds), then optionally to SECONDARY vaults with a write tier each — read-only strict, read-only with writes on request, or read-write. English canonical prompts, answered in the user's language. (Skill `bind-workspace` carries the full script.)
---

Invoke the `bind-workspace` skill.

The skill handles, step by step, each with one prompt and one tool call:
1. Where we are (`list_vaults`) — an existing primary is named, and the user chooses: change it, or go to the secondaries
2. The open vaults, listed — the user names the primary; if none is open, the user opens one and says when
3. Detect again
4. "Do you want to bind vault X as the primary vault of this workspace?"
5. `confirm_workspace_binding({ vault, open: false })`
6. "Do you want to attach secondary vaults? Open them in Obsidian, then tell me" — the primary is never listed
7. Detect, propose the list for confirmation, `confirm_workspace_binding` with `also` (earlier secondaries kept)
8. One question per new secondary — strict / on request / read-write — then `set_secondary_vault_mode`
9. Summary table, and where the answers live (the user's own router config, this workspace only)
