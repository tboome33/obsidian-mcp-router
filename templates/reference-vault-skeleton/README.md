# Reference vault skeleton

This directory is the canonical starting point for an `obsidian-mcp-router` reference vault. When you run:

```bash
node scripts/setup-vault.mjs --bootstrap-reference <path>
```

…the script copies this skeleton to `<path>`, downloads the **MCP Router Bridge** plugin from its GitHub release, and registers the path as your `referenceVault` in `~/.claude/obsidian-mcp-router/config.json`. After that, opening the path in Obsidian completes the setup (Obsidian itself proposes installing the three remaining marketplace plugins listed in `.obsidian/community-plugins.json`).

## What's in here

| Path | Purpose |
|---|---|
| `.obsidian/community-plugins.json` | The canonical 5-plugin list. Obsidian uses this to know which plugins to enable on first launch. |
| `.obsidian/app.json` | Empty — marks the directory as a valid Obsidian vault. |
| `.smart-env/smart_env.json` | Smart Connections config (transformers embedding model, English language, etc.). **No API keys** — the chat API key field is empty by design; the user pastes their own after install. |
| `.claude/settings.json` | Minimal Claude Code project settings — enables the `obsidian-router` plugin scoped to this vault. |
| `CLAUDE.md` | Navigation rules for Claude. Treats the vault as a Karpathy-style LLM wiki under `wiki/`. |
| `wiki/index.md` | Catalog of all pages. Empty sections per type. |
| `wiki/log.md` | Append-only operation log. |
| `wiki/hot.md` | Recent-context cache. |
| `wiki/overview.md` | Executive summary of the vault's purpose. |

## What's NOT in here (by design)

- **Plugin code** (`main.js`, `manifest.json`, `styles.css` of any plugin). Reasons:
  - Different licenses (Smart Connections GPL-3.0, Templater MIT, bridge MIT) — bundling them here would conflate licensing.
  - Plugins update at their own cadence, separate from this repo. Shipping copies would mean the router release lags Smart Connections updates.
  - The marketplace plugins (Local REST API, Smart Connections, Templater, Quiet Outline) install in two clicks from Obsidian's Community Plugins browser. The bridge plugin is auto-downloaded by `setup-vault.mjs --bootstrap-reference` from its GitHub release.
- **Secrets**: API keys, TLS certs, Local REST API credentials. These are user-specific and generated/regenerated per vault by `setup-vault.mjs`.

## Manual customization after bootstrap

The skeleton is intentionally generic — `mode: personal` in the frontmatter, English language, "your" pronouns in `overview.md`. After bootstrap, the user is free to:

- Switch to a different `mode` in `wiki/overview.md` (e.g., `team`, `research`, `project`) and update the prose accordingly.
- Rewrite `CLAUDE.md` to reflect domain-specific conventions.
- Add other root files that should propagate to every bootstrapped vault (quick-reference PDFs, custom `roadmap.md`, etc.) — `setup-vault.mjs` clones whatever is at the reference root.

See [`docs/reference-vault-setup.md`](../../docs/reference-vault-setup.md) for the full procedure.
