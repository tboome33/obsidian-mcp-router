# commands/ — slash command wrappers for the 14 router tools

This folder ships **14 slash commands**, one per MCP tool the router exposes. They're intended for users who prefer typing `/obsidian-...` to discover and invoke tools rather than relying purely on natural language.

> **Both work.** These slash commands don't replace natural-language invocation — they coexist with it. Once you know the router well, NL is faster for most cases. The slash commands are for discoverability and for moments where you want predictable, explicit control.

## Naming convention

```
/obsidian-<category>-<verb>[-<qualifier>]
```

Five categories, fifteen-character ceiling-ish per token, alphabetical autocomplete grouping when you type `/obsidian-`:

| Category | Commands |
|---|---|
| **discover** | `/obsidian-discover-list-vaults` `/obsidian-discover-list-files` |
| **read** | `/obsidian-read-get` `/obsidian-read-search` `/obsidian-read-search-smart` `/obsidian-read-frontmatter` |
| **write** | `/obsidian-write-create-or-replace` `/obsidian-write-append` `/obsidian-write-patch` `/obsidian-write-frontmatter-set` `/obsidian-write-frontmatter-merge` |
| **manage** | `/obsidian-manage-move` `/obsidian-manage-delete` |
| **template** | `/obsidian-template-execute` |

## Mapping to MCP tools

| Slash command | MCP tool |
|---|---|
| `/obsidian-discover-list-vaults` | `list_vaults` |
| `/obsidian-discover-list-files` | `list_files` |
| `/obsidian-read-get` | `get_file` |
| `/obsidian-read-search` | `search` (substring) |
| `/obsidian-read-search-smart` | `search_smart` (semantic, Smart Connections) |
| `/obsidian-read-frontmatter` | `get_frontmatter` |
| `/obsidian-write-create-or-replace` | `write_file` |
| `/obsidian-write-append` | `append_to_file` |
| `/obsidian-write-patch` | `patch_file` |
| `/obsidian-write-frontmatter-set` | `set_frontmatter` |
| `/obsidian-write-frontmatter-merge` | `merge_frontmatter` |
| `/obsidian-manage-move` | `move_file` |
| `/obsidian-manage-delete` | `delete_file` (with `confirm=true` guard) |
| `/obsidian-template-execute` | `execute_template` |

## Install / refresh

Three equivalent install scripts ship in this folder. Pick whichever matches your shell:

| Script | Shell |
|---|---|
| [`install.sh`](./install.sh)   | Bash / Git Bash on Windows / Linux / macOS |
| [`install.cmd`](./install.cmd) | Windows CMD (double-click works) |
| [`install.ps1`](./install.ps1) | Windows PowerShell |

Each one copies `obsidian-*.md` from this folder into `~/.claude/commands/` (or `%USERPROFILE%\.claude\commands\` on Windows). Run the same script every time you `git pull` to stay in sync — the script is idempotent.

### Bash / Git Bash / Linux / macOS

```bash
cd <where-you-cloned-obsidian-mcp-router>/commands
bash install.sh
```

### Windows CMD

```cmd
cd <where-you-cloned-obsidian-mcp-router>\commands
install.cmd
```

### Windows PowerShell

```powershell
cd <where-you-cloned-obsidian-mcp-router>\commands
.\install.ps1
```

### Why scripts instead of symlinks?

On Linux and macOS, `ln -s` would let `git pull` automatically refresh the installed commands. On Windows, symlinks require admin or Developer Mode, which most users don't have. A flat copy works everywhere; the trade-off is that you re-run the install script after each `git pull`.

If you're on Linux/macOS and prefer the symlink approach:

```bash
cd <where-you-cloned-obsidian-mcp-router>/commands
mkdir -p ~/.claude/commands
ln -sf "$PWD"/obsidian-*.md ~/.claude/commands/
```

Then `git pull` is enough — no re-install needed.

### Verify

After installing, type `/obsidian-` in any Claude Code session — the autocomplete should list the 14 commands.

## Argument parsing

Each command's `.md` file describes the args it accepts and how to extract them from `$ARGUMENTS`. Most commands are flexible — they handle:

- bare positional values (e.g. just a path or a query)
- `key=value` pairs (e.g. `vault=tradingview path=Sessions/2026-05-02.md`)
- mixed natural language phrasing

If an argument is missing or ambiguous, Claude will ask you for it before calling the tool.

## Discoverability tip

After install, type `/obsidian-` and let autocomplete walk you through the catalog. The category prefix groups related commands together (`/obsidian-read-` shows you all the read tools, etc.).

## Distribution and customization

These 14 commands are **wrappers**, kept domain-agnostic on purpose. If you want **macros** that chain multiple tools or bake in your vault's conventions (daily notes, capture inbox, trade workflows…), build those separately following the pattern in [`../docs/building-commands.md`](../docs/building-commands.md). Don't fork these wrappers to embed your conventions — that defeats the purpose.

## When to use slash commands vs natural language

| Situation | Use |
|---|---|
| You're new to the router and want to see what's possible | Slash commands (`/obsidian-` autocomplete) |
| You know the tools well and want speed | Natural language ("ajoute X dans Y") |
| You want predictable, explicit control | Slash commands |
| The args are obvious from context, you want minimum typing | Natural language |
| You're scripting a workflow that runs the same way every time | Slash commands (or your own macro on top) |

Both work. Both call the same underlying MCP tools. Pick whichever feels right for the moment.
