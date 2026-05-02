---
name: obsidian-router-setup
description: Install obsidian-mcp-router and register it as the user-scope Obsidian MCP. Use when the user wants to switch from per-vault MCP entries to a single multi-vault router, or when bootstrapping the router on a fresh machine.
---

# obsidian-router-setup

This skill walks the user through installing **obsidian-mcp-router** and replacing their existing `obsidian-rest` / `obsidian-tools` user-scope MCP entries with a single `obsidian` entry that routes to all configured vaults.

## When to use

- The user says: "install the router", "replace the obsidian MCP with the router", "set up multi-vault Obsidian", "add a remote vault to Claude".
- The user has more than one Obsidian vault (or plans to) and doesn't want to maintain one MCP entry per vault.

## Pre-requisites to verify

1. `node --version` ≥ 18.
2. `~/.claude/mcp-obsidian/config.json` exists with at least one entry in `portRegistry`. If not, run `node ~/.claude/mcp-obsidian/scripts/setup-vault.mjs <vault-path>` first (see the `obsidian-vault-setup` skill).
3. Obsidian is installed and at least one vault has the Local REST API + MCP Tools plugins activated.

## Install steps

```bash
# 1. Clone (private GitHub repo for now)
git clone https://github.com/tboome33/obsidian-mcp-router.git I:\DEVELOPPEMENT\obsidian-mcp-router
cd I:\DEVELOPPEMENT\obsidian-mcp-router

# 2. Install dependencies + create global symlink
npm install
npm link

# 3. Verify the binary is callable
obsidian-mcp-router --help 2>/dev/null || echo "binary registered"
```

## Register in Claude (user scope)

Edit `~/.claude.json`. Find the `mcpServers` section, **remove** the existing `obsidian-rest` and `obsidian-tools` entries (the router replaces both for REST-level operations), and **add**:

```json
"obsidian": {
  "type": "stdio",
  "command": "obsidian-mcp-router"
}
```

> Note: keep `obsidian-tools` if you rely on Smart Connections semantic search or Templater execution — the router doesn't cover those yet. Both can coexist under different names.

## Verify

1. Restart Claude Desktop.
2. Run `/mcp` to confirm `obsidian` is connected.
3. Ask Claude: "list my Obsidian vaults" — it should call `list_vaults` and return every vault with online status.

## Add a remote vault (optional)

Edit `~/.claude/mcp-obsidian/config.json`, add an entry under `remoteVaults`. See `docs/remote-vaults.md` in the repo for the full guide. Restart Claude after editing.

For an interactive walkthrough of adding any vault (local or remote), use the companion skill **`obsidian-router-add-vault`**. For diagnostic checks of all configured vaults, use **`obsidian-router-status`**.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot read config at ...` | The router can't find `config.json` | Run `setup-vault.mjs` for at least one vault first |
| Vault shows `online: false` | Obsidian not running on that vault, or wrong port | Open the vault in Obsidian; verify with `--status` |
| `missingApiKey: true` | Local REST API plugin never enabled on that vault | Enable it in Obsidian, copy the key, then re-run `setup-vault.mjs` |
| Cert errors on a remote vault | TLS misconfiguration | If self-signed → `tlsInsecure: true`. If real cert → check the cert chain. |
