---
description: Install / remove / check status of CLAUDE.md conventions across vaults (source-type, languages, heading-hierarchy, auto-enrichment, ...). Calls the conventions skill.
---

Invoke the `conventions` skill to manage CLAUDE.md conventions in one or more Obsidian vaults.

Sub-commands:
- `list` — show available conventions + which are installed on the target vault(s)
- `install <id> [on <vault>] [--all]` — append a convention's snippet to the target vault(s)' CLAUDE.md
- `remove <id> [on <vault>] [--all] [confirm:true]` — strip a convention's section from the target vault(s)' CLAUDE.md
- `sync-all-vaults <id>` — convenience alias for `install <id> --all`
- `migrate-bilingual [on <vault>]` — replace the retired `bilingual` convention with `languages` (the value is asked; preview, backup and `ifMatch` write, one vault at a time)

Convention ids ship in `skills/conventions/snippets/<id>.md`. Initial library: `source-type`, `bilingual`, `heading-hierarchy`, `auto-enrichment`. Since 2026-09-26 `bilingual` is retired (`skills/conventions/retired/`, recognised and removable, never installed) and `languages` — which carries the vault's own list of languages — takes its place.

## ⚠️ Safety on `remove` (v0.8.12, NIT-4 + IMP-4)

`remove` is destructive — it strips a section identified by its H2 heading. If you've hand-edited the convention's section in your vault's `CLAUDE.md` (extended it with personal rules), removal will wipe your customisations.

Mandatory guards enforced by the skill:
- **Preview before write** — the exact content to remove is shown to you BEFORE any disk write.
- **Sidecar backup** — a copy of the unmodified `CLAUDE.md` is written to `CLAUDE.md.bak-<id>-<timestamp>` in the same vault before the destructive `write_file`. Backups are NEVER auto-cleaned.
- **`confirm:true` required for `--all`** — bulk removals refuse to proceed without an explicit confirmation argument. Single-vault removals can proceed after preview.

ARGUMENTS: $ARGUMENTS
