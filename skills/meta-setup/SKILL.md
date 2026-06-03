---
name: meta-setup
description: Install obsidian-mcp-router and register it as the user-scope Obsidian MCP. Use when the user wants to switch from per-vault MCP entries to a single multi-vault router, or when bootstrapping the router on a fresh machine.
---

# meta-setup

Walks the user through installing **obsidian-mcp-router** and replacing their existing `obsidian-rest` / `obsidian-tools` user-scope MCP entries with a single `obsidian-router` entry that routes to all configured vaults.

## When to use

- The user says: "install the router", "replace the obsidian MCP with the router", "set up multi-vault Obsidian", "add a remote vault to Claude".
- The user has more than one Obsidian vault (or plans to) and doesn't want to maintain one MCP entry per vault.

## Pre-requisites to verify

1. `node --version` ≥ 18.
2. `~/.claude/obsidian-mcp-router/config.json` exists with at least one entry in `portRegistry`. If not, run `node <router-repo>/scripts/setup-vault.mjs <vault-path>` first.
3. Obsidian is installed and at least one vault has the Local REST API + MCP Router Bridge plugins activated.

## Install steps

```bash
# 1. Clone (pick a destination that fits your workflow — examples below).
#    Linux/macOS:
git clone https://github.com/tboome33/obsidian-mcp-router.git ~/dev/obsidian-mcp-router
cd ~/dev/obsidian-mcp-router
#    Windows (PowerShell):
#    git clone https://github.com/tboome33/obsidian-mcp-router.git "$env:USERPROFILE\dev\obsidian-mcp-router"
#    cd "$env:USERPROFILE\dev\obsidian-mcp-router"

# 2. Install dependencies + create global symlink
npm install
npm link

# 3. Verify the binary is callable
obsidian-mcp-router --version
```

Ask the user upfront which directory they prefer if it's not obvious. Don't pick a destination on their behalf — clone paths are a personal taste thing.

## Register in Claude (user scope)

Edit `~/.claude.json`. Find the `mcpServers` section, **remove** the existing `obsidian-rest` and `obsidian-tools` entries (the router replaces both for REST-level operations), and **add**:

```json
"obsidian-router": {
  "type": "stdio",
  "command": "obsidian-mcp-router"
}
```

## Install the slash-command plugin (optional but recommended)

To get `/obsidian-router:*` slash commands (vault discovery, reads, writes, etc.), enable the plugin shipped in the same repo. Add to `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "obsidian-mcp-router-marketplace": {
      "source": {
        "source": "github",
        "repo": "tboome33/obsidian-mcp-router"
      }
    }
  },
  "enabledPlugins": {
    "obsidian-router@obsidian-mcp-router-marketplace": true
  }
}
```

Restart Claude Code. Type `/obsidian-router:` to see the autocomplete list.

## Bump the skill-listing budget (recommended)

The router contributes ~30 skills (slash commands + skills) to Claude Code's skill listing. On a default install (`skillListingBudgetFraction: 0.01`, i.e. 1% of the context window), this often pushes the listing past the budget — Claude Code then truncates skill descriptions or drops them entirely, which silently disables natural-language triggering for `/save`, `/wiki`, `/autoresearch`, etc.

**Recommended fix**: raise the budget to `0.05` (5%) in `~/.claude/settings.json`.

### Steps

1. Read `~/.claude/settings.json` (use the `Read` tool — handle the BOM if Windows-created: `JSON.parse` after stripping `﻿` from the start).
2. Look for `skillListingBudgetFraction`:
   - **Absent** → propose to add `"skillListingBudgetFraction": 0.05`.
   - **Present and < 0.03** → propose to bump to `0.05`.
   - **Present and ≥ 0.03** → leave alone (already enough).
3. Show the user the proposed change + the trade-off (below) and **ask for confirmation** before editing — this is a global setting, never edit silently.
4. If confirmed, merge into the existing JSON (don't replace the file). Use the `Edit` tool, not `Write`, to preserve unrelated keys (`env`, `permissions`, `hooks`, etc.).

### Trade-off to communicate

- **Cost**: ~6k extra tokens of context per session (the skill listing is sent at every turn).
- **Benefit**: every router skill stays listed with its full description → natural-language triggers work consistently. Without the bump, skills like `/save` and `/wiki` are among the first to be dropped because they're competing with default Anthropic skills + other plugins.
- **Indicator that the bump worked**: at next session start, no `Skill listing will be truncated` warning in the diagnostics.

If the user has a tight context budget for other reasons (e.g., they run a lot of large `Read` calls), a value of `0.03` is a safer middle ground — covers the router but leaves more headroom.

## Install router hooks (recommended)

The router ships **9 hooks** that automate vault maintenance. **Since v0.18.2 they are auto-wired into `~/.claude/settings.json` at the end of a `setup-vault.mjs <vault>` bootstrap** (pass `--no-hooks`, or set `OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS=1`, to skip). Before that, wiring was a manual, skippable step — and skipping it was the failure mode behind the recurring cwd+vault phantom-link bug: a dormant `vault-link-linter` / `wiki-query-first-nudge` catches and prevents nothing. For an already-bootstrapped vault, or to (re)wire by hand, `setup-vault.mjs --install-hooks` does it idempotently.

### What the 9 hooks do

| Hook | Event | Purpose |
|---|---|---|
| `hot-cache-load` | SessionStart + PostCompact | Loads `wiki-meta/hot.md` into Claude's context at session start |
| `check-router-update` | SessionStart | Once-per-day GitHub check for new router versions |
| `vault-doc-startup-check` | SessionStart | Warns at startup if the vault's CLAUDE.md / scaffolds have drifted |
| `wiki-query-first-nudge` | UserPromptSubmit | Injects a pre-answer reminder to check the vault first + the PATH RESOLUTION RULES (the two real roots) that prevent cwd+vault path mixups |
| `session-auto-journal` | SessionStart / UserPromptSubmit / PostToolUse / SessionEnd | Captures a per-session log into `wiki-meta/Sessions/` |
| `wiki-autocommit` | PostToolUse (8 mutating MCP tools) | Auto-commits wiki changes via git |
| `doc-propagation-checker` | PostToolUse (Bash) | Post-`git commit` check that CHANGELOG/ROADMAP/wiki mention the current version |
| `vault-link-linter` | Stop | Blocks responses with bare-path / wrong-port / cwd+vault-mix vault links, forces click-to-open format |
| `hot-cache-update-prompt` | Stop | **Blocks the turn** (exit 2) until `wiki-meta/hot.md` is refreshed when this session wrote a `wiki/` note — deterministic, per-vault, transcript-scoped |

### Interactive install

**If the vault was just bootstrapped with `setup-vault.mjs <vault>` (v0.18.2+), all hooks are ALREADY wired** — this step is only for the cases where bootstrap was run with `--no-hooks`, where you want a custom subset, or where you're wiring an older/already-bootstrapped vault. Otherwise, skip to "Verify after install".

When you do need to wire manually, ask the user which scope they want, then run the appropriate command from the cloned router repo. Recommended phrasing:

> The router ships 9 hooks that turn your vault into an actively-maintained assistant (auto-commit, link linting incl. cwd+vault phantom-path detection, version-drift detection, etc.). Install which?
>
> **All (recommended)** — full kit, opt-in by env var per hook later if any becomes noisy.
> **Pick** — choose specific hooks.
> **Skip** — leave settings.json alone; you can run `node scripts/setup-vault.mjs --install-hooks` later.

Based on the answer, run from the router repo:

- **All**: `node scripts/setup-vault.mjs --install-hooks`
- **Pick**: `node scripts/setup-vault.mjs --install-hooks --select <names>` (comma-separated basenames without `.mjs`, e.g. `vault-link-linter,doc-propagation-checker`)
- **Skip**: don't run anything; mention `--install-hooks` exists for when they're ready.

The command is **idempotent** (re-run safe), **preserves user-defined non-router hooks**, uses **forward-slash paths** in JSON for Windows compatibility, and auto-detects the absolute path of THIS clone (no `<router-repo>` placeholder to fill manually). Restart Claude Code afterward to pick up the new hooks.

### Per-hook opt-out env vars

If any hook becomes noisy or unwanted after install, the user can disable it WITHOUT touching settings.json:

- `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` — disables `check-router-update`
- `OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true` — disables `vault-link-linter`
- `OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true` — disables `doc-propagation-checker`
- `OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD=true` — disables the `hot-cache-update-prompt` blocking guard
- For the others (`hot-cache-load`, `wiki-autocommit`), the user can run `--uninstall-hooks` (removes ALL router hooks) and then re-run `--install-hooks --select <wanted-ones>` to keep a subset.

### Verify after install

Run `node scripts/setup-vault.mjs --hooks-status` from the router repo. Should show all installed hooks as `✓ active`.

## Verify

1. Restart Claude Desktop / Claude Code.
2. Run `/mcp` to confirm `obsidian-router` is connected.
3. Type `/obsidian-router:discover-list-vaults` — it should call `list_vaults` and return every vault with online status.

## Bulk-bootstrap existing vaults (recommended on fresh machines) — v0.13.9+

Once `--bootstrap-reference` is done, the user typically has 1–N existing Obsidian vaults on disk that the router doesn't know about yet. Each one needs `setup-vault.mjs <path>` to be added to `portRegistry`. Doing this by hand on a fresh machine with 5+ vaults is tedious and easy to skip.

**Discover them in one shot:**

```bash
node scripts/setup-vault.mjs --discover-vaults
```

The script scans well-known per-OS locations (`C:/VAULTS`, `~/Documents/Obsidian`, `~/Obsidian`, iCloud `Mobile Documents/iCloud~md~obsidian/Documents`, Google Drive desktop mounts, OneDrive) and classifies each found vault as:

- **reference** — the configured `.template` vault
- **registered** — already in `portRegistry`
- **candidate** — has `.obsidian/` AND Local REST API plugin, but not registered → bootstrap target
- **partial** — has `.obsidian/` but missing Local REST API plugin → install it in Obsidian first

Add custom roots with `--scan-dir <path>` (repeatable). To bypass default locations entirely (e.g. testing or unusual layouts), add `--no-default-scan`.

**Bootstrap every candidate at once:**

```bash
node scripts/setup-vault.mjs --discover-vaults --bootstrap-all
```

Or with `--dry-run` to preview without writing. Per-vault allocation of port + apiKey is collision-avoided against the live `portRegistry`. If a single vault fails, the batch reports it and continues with the rest.

**Interactive selection** (skill-driven, not script-driven): if the user wants to pick a subset, run `--discover-vaults` first (read-only), ask which candidates to include, then loop `setup-vault.mjs <path>` for each chosen one.

## Backfill HTTP-side endpoint on legacy vaults — v0.13.9+

Vaults bootstrapped BEFORE the v0.10.x release that added `insecurePort` + `enableInsecureServer` to the default `data.json` stay HTTPS-only. That breaks click-to-open links on machines with Bitdefender / ESET / Kaspersky (silent drop of self-signed HTTPS loopback). `--sync-plugins --force` deliberately preserves `data.json` for credential safety, so it doesn't backfill those fields either.

**Patch every legacy vault in one shot:**

```bash
node scripts/setup-vault.mjs --upgrade-insecure-server-all
```

Or `--dry-run` to preview. The script reports per-vault status (upgraded / already-enabled / no-data-json / no-port / failed) and tells the user to reload Obsidian on the affected vaults. Per-vault collision avoidance for freshly-allocated `insecurePort` values (existing user values are respected — even on collision — to avoid breaking already-shared links).

Single-vault form: `--upgrade-insecure-server <vault-path>`.

**No-op-safe**: re-running on a vault that's already HTTP-enabled is a no-op (no write, no mtime bump). Suitable for inclusion in maintenance scripts.

## Propagate click-to-open convention to `~/.claude/CLAUDE.md` — v0.13.9+

The "Obsidian vault links" formatting rules live in the user's global `~/.claude/CLAUDE.md`. Without that section, Claude on a fresh machine doesn't know to emit `http://127.0.0.1:<insecurePort>/open/<path>` links — it falls back to `obsidian://` (silently filtered by Claude Code CLI on click) or `https://` (silently dropped by Bitdefender). The user gets dead links.

**List available conventions:**

```bash
node scripts/setup-vault.mjs --list-global-conventions
```

**Install the click-to-open convention:**

```bash
node scripts/setup-vault.mjs --install-global-convention obsidian-vault-links
```

Appends the canonical snippet to `~/.claude/CLAUDE.md` with HTML-comment markers (`<!-- BEGIN obsidian-mcp-router:obsidian-vault-links -->` … `<!-- END ... -->`). **Idempotent**: re-runs are no-ops. **Safe**: content outside the marker block is never touched. **Upgradable**: re-run with `--force` to replace the marker block contents with the latest canonical text, preserving surrounding user edits.

**Always ask for confirmation before running this on a fresh-machine install** — the user's global CLAUDE.md is their private space; a Claude session writing into it (even with markers) deserves an explicit "yes". Show the section name + a one-line description before invoking.

## Add a remote vault (optional)

For an interactive walkthrough of attaching any vault (workspace-first, standalone, or remote), use the companion skill **`meta-attach-vault`**. For diagnostic checks of all configured vaults, use **`meta-status`**.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot read config at ...` | The router can't find `config.json` | Run `setup-vault.mjs` for at least one vault first |
| Vault shows `online: false` | Obsidian not running on that vault, or wrong port | Open the vault in Obsidian; verify with `meta-status` |
| `missingApiKey: true` | Local REST API plugin never enabled on that vault | Enable it in Obsidian, copy the key, then re-run `setup-vault.mjs` |
| Cert errors on a remote vault | TLS misconfiguration | If self-signed → `tlsInsecure: true`. If real cert → check the cert chain. |
