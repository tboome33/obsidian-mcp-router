# Building your own slash commands on top of obsidian-mcp-router

The router exposes 14 generic MCP tools. They're domain-agnostic on purpose: they work the same whether your vault is for trading, academic research, recipes, gardening logs, or fiction writing.

If you want to streamline your *own* workflows on top of those tools, the right place for that is **slash commands in your Claude home** — not in the router itself. The router stays neutral; you build the conventions you need on top of it.

This guide shows the pattern with a few illustrative examples. **Adapt the paths, date formats, vault names, and folder conventions to your own vault**. Nothing here is meant to ship as-is.

---

## How slash commands relate to the router

| Layer | Owns | Lives where |
|---|---|---|
| **MCP tools** (the 14) | Reading/writing/searching primitives — agnostic of your folder structure | The router process (this repo) |
| **Slash commands** (your macros) | Workflow orchestration — opinionated about your folders, templates, naming | `~/.claude/commands/*.md` (or per-project `.claude/commands/`) |

Slash commands consume the router's tools; the router knows nothing about your slash commands. That separation keeps the router reusable across vaults and users.

## When does a slash command earn its keep?

For one-off requests, plain natural language is faster ("ajoute X dans Y"). Slash commands are worth the file when:

- The workflow chains **3+ MCP tools** (e.g. read a template → render it → write the result → update an index entry).
- The same workflow runs **dozens of times per week** and the friction adds up.
- You want **defaults baked in** so you don't restate them every time (default vault, default folder for the day's note, default search depth).

A slash command that's just a 1-to-1 wrapper around a single MCP tool generally adds little over NL — Claude already calls the right tool from a one-line ask. Reserve slash commands for **orchestration**.

## Anatomy of a slash command file

A Claude Code slash command is a markdown file at `~/.claude/commands/<name>.md`. When the user types `/<name> <args>`, Claude reads the file and follows its instructions, with `<args>` available as `$ARGUMENTS`.

```markdown
---
description: <one-line summary shown in the autocomplete>
allowed-tools: <comma-separated MCP tool names this command may call>
---

# <name>

<Plain-language instructions for Claude. Reference the router's MCP tools
by name. Use $ARGUMENTS to splice in the user's input.>
```

For the canonical reference of the slash-command spec, see Claude Code's own slash-command documentation — this guide focuses on the obsidian-mcp-router-shaped patterns.

---

## Three illustrative examples (adapt freely)

### Example 1 — Quick capture into an inbox note

> **Adapt**: change the inbox path and the timestamp format. Some users keep `Inbox.md` at vault root, others under `00 - Inbox/`. Some use full ISO timestamps, others just `HH:MM`.

`~/.claude/commands/capture.md` :

```markdown
---
description: Append a timestamped capture to my inbox note.
allowed-tools: append_to_file
---

Append the user's input ($ARGUMENTS) to `Inbox.md` in vault `personal`,
prefixed with a `## YYYY-MM-DD HH:MM` heading so each capture is its own
section.

Use the obsidian-router `append_to_file` tool. The file auto-creates if
absent — that's fine.

Confirm in one short line: "Captured to Inbox.md".
```

Then `/capture saw a hawk over the river` adds a timestamped block to your inbox.

---

### Example 2 — Open or create today's daily note

> **Adapt**: the folder layout, the date format, the template path, and the template's variable names are all conventions of your vault. Mine here are placeholders.

`~/.claude/commands/today.md` :

```markdown
---
description: Open or create today's daily note in vault `personal`.
allowed-tools: get_file, execute_template
---

Compute today's date in `YYYY-MM-DD` format.

Try `get_file` on `Daily/<date>.md` in vault `personal`.

- If the file exists: show the current content briefly and stop.
- If it doesn't exist: call `execute_template` with
    name: "Templates/Daily.md"
    arguments: { date: "<date>" }
    createFile: true
    targetPath: "Daily/<date>.md"
  Then show the rendered content.

Always finish by telling the user the path so they can open it in Obsidian.
```

Then `/today` gets you straight into the right note, regardless of whether it existed before.

---

### Example 3 — Smart recall across every vault

> Generic enough to be reusable as-is — but you may want to change the formatting or the result count.

`~/.claude/commands/recall.md` :

```markdown
---
description: Semantic search across ALL vaults. Returns the top 10 chunks.
allowed-tools: search_smart
---

Call the obsidian-router `search_smart` tool with:
  vault: "*"
  query: $ARGUMENTS
  limit: 10

Render the results as a markdown list, one entry per chunk:
  1. **<breadcrumbs>** — *<vault name>*, score `0.XX`
     > <first ~120 chars of text>

If no results come back, suggest the user try the substring `search` tool
instead, or to widen the query.
```

Then `/recall how do I configure rate limiting` searches every configured vault by meaning.

---

## Where to draw the line

If your slash command is starting to look like:

```markdown
Call the obsidian-router `<single tool>` tool with $ARGUMENTS as args.
```

…you almost certainly **should not** make it. NL is just as fast and you save a maintenance file. Reserve slash commands for **stitching tools together** with intent and defaults. If there's no stitching, skip the file.

## Discoverability tips

- Type `/` in Claude Code and your command list pops up in autocomplete — that's your TOC.
- Prefix all your vault-related commands with the same word (e.g. `vault-`, `kb-`, `note-`) so they group together. The author of *this* repo uses no prefix in the examples above to keep them short, but for a real setup with many domains, a prefix helps.
- Keep the `description` field meaningful — it's what shows in the picker.

## Distribution

Your slash commands are personal — they live in your Claude home and reflect your conventions. Two options:

1. **Keep them local** in `~/.claude/commands/`. Simple, no syncing.
2. **Version them** in a private repo of your own (e.g. `<your-handle>-vault-commands`) and symlink the relevant `.md` files into `~/.claude/commands/`. Useful if you have multiple machines or want git history of your workflow evolution.

Either way, **don't push them upstream into obsidian-mcp-router**. The router has to stay neutral.
