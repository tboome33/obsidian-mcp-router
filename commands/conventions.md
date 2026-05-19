---
description: Install / remove / check status of CLAUDE.md conventions across vaults (source-type, bilingual, heading-hierarchy, auto-enrichment, ...). Calls the conventions skill.
---

Invoke the `conventions` skill to manage CLAUDE.md conventions in one or more Obsidian vaults.

Sub-commands:
- `list` — show available conventions + which are installed on the target vault(s)
- `install <id> [on <vault>] [--all]` — append a convention's snippet to the target vault(s)' CLAUDE.md
- `remove <id> [on <vault>] [--all]` — strip a convention's section from the target vault(s)' CLAUDE.md
- `sync-all-vaults <id>` — convenience alias for `install <id> --all`

Convention ids ship in `skills/conventions/snippets/<id>.md`. Initial library: `source-type`, `bilingual`, `heading-hierarchy`, `auto-enrichment`.

ARGUMENTS: $ARGUMENTS
