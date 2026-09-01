---
description: Install obsidian-mcp-router and register it as the user-scope Obsidian MCP — clone, npm link, register binary in ~/.claude.json. (Skill `meta-setup` handles natural-language triggers.)
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

## Conversion toolbox (optional — say it out loud, install only if asked)

**Eight of the tools do nothing until a separate opt-in step**: `pdf`, `docx`, `xlsx`,
`pptx`, `image`, `audio`, `bing_search` and `webpage` → markdown all shell out to the
`markitdown` Python CLI. `youtube_to_markdown` degrades rather than dying — it falls
back to yt-dlp captions, which keeps it working **only if yt-dlp is installed**, itself
another executable the router does not install. `git_repo_to_markdown` is unaffected (it
uses repomix). The router **never installs markitdown on its own** — no `postinstall`,
and the auto-updater will not run it either. That is a written decision: no imposed
Python install.

**CHECK THE OPT-OUT FIRST.** If `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` is set (`optedOut:
true` in `list_vaults`' `conversionToolbox`), **skip this section entirely** — say
nothing about markitdown. That variable exists so the user stops being asked; asking
anyway makes it a lie.

Otherwise tell them ONCE, here, while they are already provisioning — otherwise the first
thing they learn is a failing tool call mid-task, which reads as "these tools are
broken" rather than "these tools are not switched on".

- **"Yes"** → `npm run install-markitdown` from the router install directory. It needs
  Python 3.10+, checks that itself, and refuses cleanly if it is missing. Budget
  30-180 s and ~100 MB of wheels.
- **"Not now"** → nothing breaks: vault routing, search, reads and writes are all
  unaffected.
- **"Never ask again"** → set `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1`.

Already have it via `pipx install "markitdown[all]"`? Point `MARKITDOWN_PATH` at it.

Ask once, take the answer, move on. **Do not** install on your own initiative, do not
re-ask later in the same session, and do not treat "not now" as an opening to argue —
the whole point of the opt-in is that declining is a complete answer.

*(Docling — the higher-fidelity PDF backend — is a separate, heavier opt-in behind
`OBSIDIAN_ROUTER_ENABLE_DOCLING=1`, installed by `npm run install-docling`. Do not
bundle the two questions.)*

## Verify

1. Restart Claude Desktop / Claude Code.
2. Run `/mcp` to confirm `obsidian-router` is connected.
3. Type `/obsidian-router:discover-list-vaults` — it should call `list_vaults` and return every vault with online status.
4. That same response carries `conversionToolbox`. It measures the MACHINE, not the
   answer the user gave: a "yes" can still read `available: false` (Python missing, or
   the install failed), and a "not now" can read `available: true` when markitdown is
   already on `PATH` from an earlier `pipx install`. Read it as a fact to report, never
   as a check on whether they consented.

## Add a remote vault (optional)

For an interactive walkthrough of attaching any vault (workspace-first, standalone, or remote), use the companion skill **`meta-attach-vault`**. For diagnostic checks of all configured vaults, use **`meta-status`**.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot read config at ...` | The router can't find `config.json` | Run `setup-vault.mjs` for at least one vault first |
| Vault shows `online: false` | Obsidian not running on that vault, or wrong port | Open the vault in Obsidian; verify with `meta-status` |
| `missingApiKey: true` | Local REST API plugin never enabled on that vault | Enable it in Obsidian, copy the key, then re-run `setup-vault.mjs` |
| Cert errors on a remote vault | TLS misconfiguration | If self-signed → `tlsInsecure: true`. If real cert → check the cert chain. |
