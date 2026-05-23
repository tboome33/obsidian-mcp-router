---
description: Propagate the reference (`.template`) vault's plugins, snippets, and root docs to one or more configured vaults. Interactive picker — lists each vault with online status + REST-API-plugin presence, lets you sync all or a subset, with optional `--force` re-clone. (Skill `meta-sync-template` handles natural-language triggers + the picker flow.)
---

# meta-sync-template

Interactive bulk propagation of the reference vault (typically `.template`) to one or more configured vaults. Conversational picker over `scripts/setup-vault.mjs`'s `--sync-all` and `--sync-plugins` modes.

The safety guarantees are enforced **by the script itself** (`obsidian-mcp-router` v0.11.2+): the reference vault is auto-skipped via a case-insensitive `samePath()` match (Windows NTFS / macOS APFS safe), and first-time copies of credentialed plugins (currently `obsidian-local-rest-api`) into vaults that don't have them yet are refused to prevent API-key leaks. The skill's job is purely UX.

Follow the steps in the `meta-sync-template` skill. The skill:

1. Locates the cloned `obsidian-mcp-router` repo (CWD → `npm root -g` → `npm ls -g --parseable` → ask the user).
2. Reads the active router config (`list_vaults.configPath`, respecting `OBSIDIAN_ROUTER_CONFIG`).
3. Calls `list_vaults` to probe online status (informational — sync works offline too).
4. Renders a picker table flagging targets that lack `obsidian-local-rest-api/data.json` with `⚠️ needs bootstrap` so the user can prep them first. Asks: **All vaults**, **subset**, or **cancel**.
5. Asks whether to pass `--force` (re-clone every plugin folder).
6. Runs `npm run setup-vault -- --sync-all [--force]` for the all-vaults case (the script's bulk handler iterates safely). For a subset, loops `node scripts/setup-vault.mjs "<path>" --sync-plugins [--force]` over the user's selection.
7. Aggregates per-vault results and reminds the user that any vault currently open in Obsidian needs a reload (Ctrl+R / Cmd+R) to pick up newly synced plugins.

The sync is filesystem-based — **offline vaults are propagated too**. Per-vault `obsidian-local-rest-api/data.json` (port + API key) is preserved across re-clones for vaults that already have the plugin (`setup-vault.mjs:835-842`); for vaults without it, the script refuses the copy with a clear "bootstrap first via `setup-vault.mjs "<path>"`" message.

## Examples

- "propage la config du template à tous mes vaults"
- "sync all vaults with the template"
- "mets à jour roland + coursera avec le template"
- "diffuse les plugins du vault de référence"

## Companion commands

- [`/obsidian-router:meta-status`](./meta-status.md) — pre-flight check (online/offline/missing API keys)
- [`/obsidian-router:meta-setup`](./meta-setup.md) — install the router itself
- [`/obsidian-router:meta-add-vault`](./meta-add-vault.md) — register a new vault
