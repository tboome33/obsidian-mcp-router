# obsidian-mcp-router

> An MCP server that routes Claude tool calls to **multiple** Obsidian vaults — local or remote — over the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

Instead of registering one MCP per vault (one process, one port, one API key), this router exposes a single MCP that knows about every vault you've configured. Each tool takes a `vault` parameter (or uses your default), and the router fans out the HTTPS call to the right Obsidian instance.

## Why

The default Obsidian MCP setup ([jacksteamdev/mcp-tools](https://github.com/jacksteamdev/mcp-tools)) binds one MCP server process to one vault via env vars (`VAULT_PATH`, `OBSIDIAN_API_KEY`, `OBSIDIAN_BASE_URL`). If you have multiple vaults, you need multiple MCP entries — one per scope/project — and you can only ever reach one vault at a time per Claude session.

This router replaces that with:

- **One MCP entry** in `~/.claude.json` (user scope) → all vaults visible from any Claude Desktop/Code session.
- **Local + remote vaults**, treated identically. Want to query an Obsidian vault running on your QNAP, your iPad over Tailscale, or a headless VPS? Just add the URL + API key to the config.
- **Cross-vault search**: pass `vault: "*"` to the `search` tool to fan-out across every vault in parallel.

## How it differs from `mcp-tools`

| | jacksteamdev/mcp-tools | obsidian-mcp-router |
|---|---|---|
| Vaults per MCP process | 1 | N |
| Setup per vault | new MCP entry per scope | 1 line in config.json |
| Remote vaults | requires per-vault MCP + env tweaks | first-class citizen |
| Semantic search (Smart Connections) | yes (native binary) | not yet (REST-only for now) |
| Templater execution | yes | not yet |
| Cross-vault operations | no | yes (`search` with `vault: "*"`) |

The router covers the **REST API surface only**. If you need semantic search or Templater execution, keep `mcp-tools` registered alongside for those use cases — both can coexist.

## Install

```bash
git clone https://github.com/tboome33/obsidian-mcp-router.git
cd obsidian-mcp-router
npm install
npm link    # makes the `obsidian-mcp-router` binary available globally
```

Then register it in `~/.claude.json` (user scope):

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "stdio",
      "command": "obsidian-mcp-router"
    }
  }
}
```

That's it. The router reads `~/.claude/mcp-obsidian/config.json` on start (the same file that `setup-vault.mjs` already maintains) and exposes every vault automatically.

## Config

The router reads the existing config maintained by [`setup-vault.mjs`](https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/setup-vault.md), and adds three optional fields on top:

```jsonc
{
  // --- written by setup-vault.mjs (don't edit by hand) ---
  "referenceVault": "C:\\VAULTS\\.template",
  "portStart": 27124,
  "portRegistry": {
    "C:\\VAULTS\\.template": 27124,
    "C:\\VAULTS\\TradingView": 27125
  },

  // --- router-specific (optional, edit freely) ---
  "vaultNames": {
    "C:\\VAULTS\\.template": "template",
    "C:\\VAULTS\\TradingView": "tradingview"
  },
  "remoteVaults": [
    {
      "name": "qnap",
      "baseUrl": "https://192.168.0.11:27125",
      "apiKey": "...",
      "tlsInsecure": true
    }
  ],
  "defaultVault": "tradingview"
}
```

See [`examples/config.example.json`](./examples/config.example.json) for a complete example with comments, and [`docs/remote-vaults.md`](./docs/remote-vaults.md) for the full guide on adding remote vaults.

## Tools exposed

| Tool | Description |
|---|---|
| `list_vaults` | Catalogue of all configured vaults with online status + latency. Always call this first. |
| `list_files` | List files in a directory of a specific vault. |
| `get_file` | Read full file content (markdown + frontmatter). |
| `search` | Simple text search. Pass `vault: "*"` to fan-out across all vaults. |

More tools (`create_file`, `append_to_file`, `patch_file`, `delete_file`, `execute_template`) are on the roadmap — see [Issues](https://github.com/tboome33/obsidian-mcp-router/issues).

## TLS

The Local REST API plugin generates a self-signed certificate by default. For localhost vaults, set `tlsInsecure: true` (the default for vaults loaded from `portRegistry`). For remote vaults behind a real TLS cert (e.g., a reverse proxy with Let's Encrypt), set `tlsInsecure: false`.

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). No usage restrictions.
