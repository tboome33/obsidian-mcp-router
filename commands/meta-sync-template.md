---
description: Propagate the reference (`.template`) vault's plugins, snippets, Smart Connections config and root docs to one or more configured vaults. Interactive picker — lists each vault with online status, lets you sync all or a subset, with optional `--force` re-clone. (Skill `meta-sync-template` handles natural-language triggers + the picker flow.)
---

# meta-sync-template

Interactive bulk propagation of the reference vault (typically `.template`) to one or more configured vaults. Iterates the existing `scripts/setup-vault.mjs --sync-plugins` per-vault command behind a conversational picker with safety filters (case-insensitive reference-vault detection, pre-flight check for REST API plugin presence).

Follow the steps in the `meta-sync-template` skill. The skill:

1. Locates the cloned `obsidian-mcp-router` repo (CWD → `npm root -g` → `npm ls -g --parseable` → ask the user).
2. Reads the router config (`$HOME/.claude/obsidian-mcp-router/config.json`, or `$env:USERPROFILE\.claude\obsidian-mcp-router\config.json` on Windows) to get `referenceVault` + `portRegistry`.
3. Calls the router's `list_vaults` tool to probe online status (informational — sync works offline too).
4. Filters the target list: removes the reference vault (case-insensitive match via `fs.realpathSync.native()` — guards against the Windows-casing data-loss scenario where `--force` on the reference itself would wipe the source). Pre-flight checks each target for an existing `obsidian-local-rest-api/data.json` — vaults missing it get flagged `⚠️ no REST` (syncing them first-time would leak the reference vault's port + API key into the target). Renders the table and asks: **All safe vaults**, **subset**, or **cancel**.
5. Asks whether to pass `--force` (re-clone every plugin folder).
6. Iterates the validated target list — one `node scripts/setup-vault.mjs "<path>" --sync-plugins [--force]` per target. Does NOT call `--sync-all`, because that path bypasses the skill's filters (the bulk handler at `setup-vault.mjs:944` uses a case-sensitive self-skip and has no REST-less check).
7. Aggregates per-vault results client-side and reminds the user that any vault currently open in Obsidian needs a reload (Ctrl+R / Cmd+R) to pick up newly synced plugins.

The sync is filesystem-based — **offline vaults are propagated too**. The per-vault `obsidian-local-rest-api/data.json` (port + API key) is preserved across re-clones for vaults that already have the plugin (`setup-vault.mjs:835-842`). For first-time copies into vaults without the plugin, the skill refuses to sync (see step 4 pre-flight) to avoid leaking the reference's credentials.

## Examples

- "propage la config du template à tous mes vaults"
- "sync all vaults with the template"
- "mets à jour roland + coursera avec le template"
- "diffuse les plugins du vault de référence"

## Companion commands

- [`/obsidian-router:meta-status`](./meta-status.md) — pre-flight check (online/offline/missing API keys)
- [`/obsidian-router:meta-setup`](./meta-setup.md) — install the router itself
- [`/obsidian-router:meta-add-vault`](./meta-add-vault.md) — register a new vault
