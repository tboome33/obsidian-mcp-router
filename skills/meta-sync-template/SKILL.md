---
name: meta-sync-template
description: Interactive flow to propagate the reference (`.template`) vault's plugins, snippets, and root docs to one or more configured vaults. Reads the active router config, lists every vault with online status, flags vaults missing `obsidian-local-rest-api` upfront, lets the user pick all or a subset, and optionally re-clones with `--force`. Use whenever the user says "propagate the template", "sync vaults with template", "propage la config du template aux autres vaults", "mets à jour les vaults avec la config du template", "diffuse les plugins du vault de référence", "/obsidian-router:meta-sync-template", or any phrasing implying the reference vault should be the source of truth for plugins/config across the fleet.
---

# meta-sync-template

Interactive bulk propagation of the reference vault (typically `.template`) to one or more configured vaults. Conversational picker over `scripts/setup-vault.mjs`'s `--sync-all` and `--sync-plugins` modes with up-front diagnostics (online/offline status, REST-API-plugin presence per target).

**Which command runs** (moved out of the frontmatter, which the Agent Skills spec caps at 1024 characters): the router config comes from the `OBSIDIAN_ROUTER_CONFIG` env var, defaulting to `~/.claude/obsidian-mcp-router/config.json`. The all-vaults case runs `npm run setup-vault -- --sync-all` (the script auto-skips the reference vault and refuses to leak credentials); subsets loop `scripts/setup-vault.mjs <path> --sync-plugins`. Flagging a missing `obsidian-local-rest-api` before anything runs lets the user bootstrap that vault first rather than meet a runtime warning mid-sync.

**Safety**: as of obsidian-mcp-router v0.11.2+, the underlying script itself enforces every safety invariant this skill cares about — it refuses to sync the reference vault onto itself (case-insensitive on Windows / macOS), and it refuses to first-time-copy `obsidian-local-rest-api` into a target lacking it (the copy would clone the reference's `data.json` and leak the API key). The skill's role is purely UX: a friendly picker, clear pre-flight info, per-vault aggregation. The hard safety guarantees live in `setup-vault.mjs` (`samePath()` check at `syncPluginsMode` entry; `CREDENTIAL_LEAK_PLUGINS` skip in the plugin loop; case-insensitive self-skip in `--sync-all`). See `tests/setup-vault-safety.test.mjs` for the regression coverage.

## What the underlying script propagates

From `referenceVault` to each target vault:

- **Plugin folders**: `.obsidian/plugins/<plugin-id>/` — full directory copy when the plugin is missing from the target, or a re-clone with `--force` that preserves the target's local `data.json`. A source folder may hold CODE (`main.js` + `manifest.json`) or only a settings pre-seed (`data.json`); the report tells them apart (see step 7).
- **Plugin enablement**: `community-plugins.json` entries appended for every plugin copied for the first time — code or settings only — so a plugin switches on as soon as its code arrives. Those ids are listed on purpose and are **not** counted as synced.
- **CSS snippets**: `.obsidian/snippets/*.css` + enabled in `appearance.json` (idempotent)
- **Root docs**: `README.md`, `Documentation/` (the quick-reference PDFs, `SETUP.md`), `.claude/` (preserved if already present unless `--force`; under `--force` a folder is MERGED, never wiped first). Two things never travel, `--force` or not: a **backup** (`*.bak`, `*.bak-*` — the reference vault's history, not the target's), and the reference vault's **conventions file** (`Documentation/CLAUDE.md`) into a vault that already has one at any of the three candidate locations — a second file would leave the vault ambiguous, which is what the 2026-09-22 sync did to 13 vaults. A vault with no conventions file still receives the template's. The run prints each entry it left out and why. One more thing never travels: when the source is the **shipped skeleton** (the bundled `templates/reference-vault-skeleton`, or the one `--sync-from-github` extracts), its `README.md` is not copied — it documents the skeleton, not the vault.
- **Smart Connections** — **first-time only**: `.smart-env/smart_env.json` + embedding-model cache are cloned only when the target's `.smart-env/` directory is entirely missing (`planSmartEnv()` / `syncPluginsMode()` in `scripts/setup-vault.mjs`, `force: false`). On an already-bootstrapped target, **`--sync-plugins --force` does NOT refresh `.smart-env`**, and `--lang` does not rewrite it either. To push an updated Smart Connections config to an existing target, delete the target's whole `.smart-env/` directory (the check is on the directory, not on the file; the embedding cache is rebuilt on the next Smart Connections start) before re-running, or re-bootstrap the vault.
- **Embedding model by language** — `--lang <code>` (on `--sync-plugins` and `--sync-all`) picks the model of the `.smart-env` the sync creates: `en` keeps `TaylorAI/bge-micro-v2`, any other language gets the multilingual `onnx-community/embeddinggemma-300m-ONNX` (`zh`: `Xenova/jina-embeddings-v2-base-zh`), and `language` is set to match. Without `--lang`, a language the vault already declares is used (the `languages` convention in its CLAUDE.md → its first code; the retired `bilingual` convention → `fr`; or `language` in Smart Connections' settings); otherwise the source's model is kept and a one-line hint says to pass `--lang` for a non-English vault. The keys come from Smart Connections' own adapter table — see `src/helpers/smart-env-language.mjs`.

What it does **NOT** touch (intentional, per-vault):

- The target's existing `obsidian-local-rest-api/data.json` (port + API key) — preserved across re-clones by `recloneVaultPluginPreservingConfig()` in `scripts/setup-vault.mjs`. For targets that don't have the plugin yet, the script refuses the copy entirely rather than importing the reference's `data.json` — see "Pre-flight info" in step 4.
- `.smart-env/event_logs`, `smart_contexts/`, `smart_components/`, `multi/` (vault-specific runtime cache, not config)
- The vault's actual notes

Important: file-system sync. **Works on offline vaults too** — Obsidian doesn't need to be running on the target. But targets that *are* currently open will need a reload to see new plugins.

## Steps

### 1. Locate the router repo

The skill must `cd` to the cloned `obsidian-mcp-router` repo to run `npm run setup-vault`. Try these in order until one works, and **tell the user which one succeeded** (so failures are explainable):

1. **Current working directory** — if `process.cwd()` already contains a `scripts/setup-vault.mjs`, use it.
2. **npm global link** — `npm root -g` returns the global `node_modules`, and `<that>/obsidian-mcp-router/` is the symlink if the user ran `npm link` during `meta-setup`.
   ```bash
   REPO="$(npm root -g)/obsidian-mcp-router"
   [ -f "$REPO/scripts/setup-vault.mjs" ] && echo "$REPO"
   ```
   ```powershell
   $repo = Join-Path (npm root -g) "obsidian-mcp-router"
   if (Test-Path "$repo\scripts\setup-vault.mjs") { Write-Output $repo }
   ```
   ⚠️ **Windows + nvm/volta gotcha**: `npm root -g` returns the path for the *currently active* Node version. If the user ran `npm link` under a different Node version (or switched nvm afterwards), the symlink won't exist under the active one — `Test-Path` returns false silently. If step 2 fails this way, surface it explicitly: *"`npm root -g` resolved to `<path>` but no `obsidian-mcp-router` link is there. If you use nvm/volta, switch to the Node version you used during `meta-setup`, or re-run `npm link` from the cloned repo under your current version."*
3. **`npm ls -g --depth=0 --parseable obsidian-mcp-router`** — cross-version-manager fallback. Outputs the resolved path if the package is linked anywhere npm knows about. Empty output → not installed via `npm link`.
4. **Ask the user**: "Where is the obsidian-mcp-router repo cloned on this machine?" Take the answer, verify the script exists at `<answer>/scripts/setup-vault.mjs`.

If none of these work, surface this and stop:

> ⚠️ Can't find `scripts/setup-vault.mjs`. The skill needs the cloned obsidian-mcp-router repo to run the sync. Either `cd` into the repo first, or run the `meta-setup` skill to clone + `npm link` it.

### 2. Read the router config

**Get the active config path from `list_vaults`** (call it in step 3 too — you can do it once and reuse). The response includes `configPath`, which respects the `--config` CLI flag and the `OBSIDIAN_ROUTER_CONFIG` env var. Hard-coding `$HOME/.claude/obsidian-mcp-router/config.json` is wrong when the running router was launched against a custom config (it would let the skill pick the wrong fleet, or wrongly report "no reference vault" when the active registry has one). Read **that** file:

```js
const { configPath } = await callTool('list_vaults');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
```

Default path if needed for display only: `$HOME/.claude/obsidian-mcp-router/config.json` (Linux/macOS) or `$env:USERPROFILE\.claude\obsidian-mcp-router\config.json` (Windows). In Node, resolve via `path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json')` — never a literal `~/`.

Pull these fields:

- `referenceVault` — the source vault (absolute path, typically ending in `.template`). **Required**. If missing or the path doesn't exist on disk, stop:
  > ⚠️ No reference vault configured (`referenceVault` is empty or its path is missing). Run `node scripts/setup-vault.mjs --init-reference "<path>"` to designate one first.
- `portRegistry` — object keyed by vault absolute path. The keys are the candidate targets.
- `vaultNames` (optional) — `{ <path>: <display-name> }` for friendlier output.

### 3. Probe online status

Call the router's `list_vaults` tool (no args). It pings each configured vault in parallel and returns `vaults: [{ name, type, baseUrl, path, online, latencyMs, ... }]`. Each entry contains a `path` field directly — match it against `portRegistry` keys via `path.resolve(...)` on both sides (Windows is case-insensitive but the registry keys may differ in casing).

It's OK if some vaults are offline — **the sync still works on them** because it's filesystem-based. Online status is informational, not a gate.

### 4. Render the picker

Build the display list from `Object.keys(portRegistry)`. For each entry, look up its online status from the `list_vaults` results (match by `path` field). Additionally **check each target for `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json`** — if it's missing, annotate the row with `⚠️ needs bootstrap` so the user knows that target will be refused by the script with a warning unless they bootstrap it first.

Visually mark the reference vault separately so it's clear it's the source, not a target:

```
Reference vault (source — auto-skipped): C:\VAULTS\.template

Configured target vaults:
  #   Status            Vault                       Path
  1   ✅                roland                       P:\VAULTS\Roland
  2   ❌                qnap-archive                 \\server\notes\Archive
  3   ✅                coursera                     D:\Vaults\coursera
  4   ⚠️ needs bootstrap  raw-import                 D:\Vaults\raw-import
  ...
```

If any target shows `⚠️ needs bootstrap`, surface this hint **before** the picker:

> ℹ️ Targets marked `⚠️ needs bootstrap` lack the `obsidian-local-rest-api` plugin. The sync script will refuse to copy that plugin into them (it'd leak the reference's API key) and report the rest of the plugins synced fine. To bring those plugins online, bootstrap each first via `node scripts/setup-vault.mjs "<path>"` (no `--sync-plugins`) — that generates a per-vault port + key — then re-run this skill.

Then ask via AskUserQuestion (3 options):

- **All vaults (recommended)** — run `npm run setup-vault -- --sync-all`. The script auto-skips the reference vault (case-insensitive match) and per-vault refuses any credential-leak plugin into REST-less targets, while still syncing the rest.
- **Pick a subset** — follow-up text prompt; user replies with comma-separated numbers, names, **or absolute paths**. Example: `1, 3` or `roland, coursera` or `P:\VAULTS\Roland, D:\Vaults\coursera`.
- **Cancel** — stop here, no changes.

If the user picks "subset", ask a follow-up free-text question listing the table again and accept their selection. Validate every entry resolves to a known path. If the user picks the reference vault (rare — they'd have to type its path explicitly since it's not in the numbered list), let the script refuse it with a clear error rather than pre-filtering — the script's `samePath()` guard is the authoritative check.

### 5. Ask about `--force`

Second question (before running): "Do you want `--force`?" with two options:

- **No (recommended)** — idempotent, skips plugins/files that already match the reference.
- **Yes (re-clone)** — re-copies every plugin folder. The per-vault `data.json` and `.smart-env/event_logs` are still preserved. Use when a plugin in the reference was updated and you want every target to pick up the new binaries.

### 6. Execute

From the repo root located in step 1, via the Bash tool.

**Important — config propagation**. If the active router config path (`list_vaults.configPath` from step 2) is **not** the default `$HOME/.claude/obsidian-mcp-router/config.json`, you MUST export `OBSIDIAN_ROUTER_CONFIG=<configPath>` to the spawned `setup-vault.mjs` subprocess — otherwise the script falls back to the default config and operates on the wrong vault fleet. Detection:

```js
import os from 'node:os';
import path from 'node:path';
const defaultCfg = path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
const needsEnvVar = path.resolve(configPath) !== path.resolve(defaultCfg);
const envPrefix = needsEnvVar ? `OBSIDIAN_ROUTER_CONFIG="${configPath}" ` : '';
```

In Bash: `OBSIDIAN_ROUTER_CONFIG="<path>" npm run setup-vault -- --sync-all`. In PowerShell: set `$env:OBSIDIAN_ROUTER_CONFIG = "<path>"` before the call, or use the `cross-env` style inline prefix. Either way, do NOT skip this when the path is custom — silent fleet-mismatch is the bug codex flagged in pass 5 of the prior review.

**For "All vaults"** — single command, the script handles iteration + reference skip + credential-leak protection internally:

```bash
# default config
npm run setup-vault -- --sync-all
npm run setup-vault -- --sync-all --force

# custom config (export env var first if needed — see above)
OBSIDIAN_ROUTER_CONFIG="<path>" npm run setup-vault -- --sync-all
```

It prints a per-vault summary line then a final `Done. N synced, M skipped, K failed.` aggregate.

**For "Subset"** — iterate the user's selection client-side, same env var propagation rule:

```bash
node scripts/setup-vault.mjs "<vault-path>" --sync-plugins
node scripts/setup-vault.mjs "<vault-path>" --sync-plugins --force
node scripts/setup-vault.mjs "<vault-path>" --sync-plugins --lang fr      # non-English vault, fresh .smart-env
node scripts/setup-vault.mjs "<vault-path>" --sync-plugins --dry-run      # per-plugin plan, nothing written
```

`--dry-run` prints, per plugin, `copy [code]` / `copy [settings only — code still to install]` with the files, `skip — already present`, `skip — target version is newer`, `deferred — credentialed plugin`, then `will enable: …`, `enabled but still without code afterwards: …`, the `.smart-env` model/language and the root docs. Offer it when the user wants to see before writing. Add `--container` when Obsidian runs in a container (e.g. linuxserver/obsidian) so the checklist gives the container reload.

Track results from exit codes (0 = ok, including the "Refused first-time copy of credentialed plugin" warning case — the script exits 0 because the rest of the sync completed successfully). Aggregate ok/failed at the end for the user. If a mid-loop call exits non-zero with `--force`, stop and list the remaining untouched vaults so the user can re-run after diagnosing.

⚠️ **Windows quoting**: vault paths often contain spaces (`C:\My Vault\`) and a trailing backslash will escape the closing quote (`"C:\My Vault\"` → parsed as `C:\My Vault"`). Before passing each path:
- Strip any trailing `\` or `/`: PowerShell `($path).TrimEnd('\','/')`, or Node `path.normalize(p).replace(/[\\\/]+$/, '')`.
- Wrap the result in double-quotes inside the command.
- Resolve to absolute first — never rely on shell `~` expansion.

### 7. Report

Echo the script's output to the user verbatim (it's already well-formatted). Per vault it reports plugins in three buckets — relay them as such, and **never call a plugin installed unless it is in the first one**:

- `Code installed for N plugin(s)` — `main.js` + `manifest.json` are in the target after the copy.
- `Settings only for N plugin(s) — code still to install` — only the settings pre-seed arrived.
- `Enabled without code — N plugin(s)` — listed in the target's `community-plugins.json` (or enabled by the source) with no `main.js`, including ids the source enables and never ships. Listed on purpose, **not** counted as synced. Missing marketplace plugins come with the manual steps (Settings → Community plugins → Browse → Install → Enable) and the one-command alternative `obsidian-mcp-router --install-plugins "<vault>"`; GitHub-only ones (the bridge) are BRAT's job.

After a vault that changed, the script prints `Next steps in Obsidian for <vault>` — relay it in order: reload Obsidian (desktop: Ctrl+P → "Reload app without saving"; container: the same palette command in the web UI, or `docker compose restart <service>`), turn off Restricted mode, check the plugins with code are enabled, run BRAT "Check for updates" (`obsidian42-brat:checkForUpdatesAndUpdate`) so it installs the bridge, install the missing marketplace plugins, then verify with `obsidian-mcp-router --plugin-health "<vault>"`.

At the end, add:

- **All ran**: ✅ N vault(s) processed from `<referenceVault>` (the `Done. N synced…` count is vaults, not plugins), with the per-vault bucket counts.
- **Some failed**: list the failures with the per-vault error, then suggest re-running with `--force` for those specifically.

## Don't

- Don't pass `--force` silently. Ask once in step 5.
- Don't try to update `data.json` (port + API key). That's per-vault state — for vaults that already have the plugin, the script preserves their own data.json across re-clones (`recloneVaultPluginPreservingConfig()`); for vaults missing the plugin, the script refuses to copy it at all and asks the user to bootstrap them first.
- Don't gate on online status. Sync works offline; the status column in the picker is informational only.
- Don't write to the router config file. This skill is **execution-only** — config edits live in `meta-attach-vault` / manual edits.
- Don't try to bypass the script's safety refusals (e.g. by manually copying plugin folders to "fix" a REST-less vault). The script refuses these for a reason — bootstrap the target via plain `setup-vault.mjs "<path>"` first, then re-run the sync.

## When this skill fails

| Symptom | Likely cause | Fix |
|---|---|---|
| `Can't find scripts/setup-vault.mjs` | Router repo not cloned, or `npm link` never run | Run `meta-setup` first |
| `Sync source not found` (formerly `No reference vault configured`) | `config.json` has empty `referenceVault`, or its path no longer exists on disk | Run `node scripts/setup-vault.mjs --init-reference "<path>"` and pick a vault to be the template source |
| Per-vault: `skip (path missing)` | The target path in `portRegistry` no longer exists on disk (vault moved/deleted) | Edit the router config (`$HOME/.claude/obsidian-mcp-router/config.json` or `$env:USERPROFILE\.claude\obsidian-mcp-router\config.json` on Windows) to remove the dead entry, OR move the vault back |
| Per-vault: `skip (no .obsidian)` | The path exists but is not an Obsidian vault | Same as above — clean up the registry |
| Plugin appears in `community-plugins.json` but not in Obsidian | Obsidian hasn't reloaded, Restricted mode is on, or the plugin has no code yet (reported under `Enabled without code`) | Follow the printed checklist: reload, Restricted mode off, BRAT "Check for updates" / `--install-plugins`, then `--plugin-health` |
| User wants to roll back | The sync overwrote a plugin folder they had customized | The reference vault is now the source of truth — if customizations matter, port them back into `.template` then re-sync |

## Companion skills

- **`meta-status`** — pre-flight check: who's online, who's offline, who has missing API keys.
- **`meta-setup`** — install the router itself (clone + `npm link`).
- **`meta-attach-vault`** — attach a new vault to a workspace (or standalone / remote) — interactive wizard.
