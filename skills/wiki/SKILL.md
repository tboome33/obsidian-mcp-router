---
name: wiki
description: Bootstrap or check a Karpathy-style "LLM wiki" structure inside an Obsidian vault — a self-maintaining knowledge base where pages reference each other and the LLM keeps it tidy. Sets up index.md (catalog), log.md (append-only operation history), hot.md (recent-context cache), and overview.md (executive summary). Use this skill when the user says "set up a wiki", "scaffold a knowledge base", "/wiki", "create my second brain", "bootstrap a vault for note-taking", or any phrasing that implies turning a plain Obsidian vault into a structured wiki for ongoing use with Claude.
---

# wiki

This skill creates the four scaffolding files at the root of a vault that turn it into a Karpathy-style LLM wiki. The pattern: an LLM ingests sources, files them as wiki pages, and maintains the catalog/log/hot-cache so future sessions can navigate and build on prior knowledge cheaply.

## When to use

- The user has an Obsidian vault and wants Claude to start using it as a knowledge base across sessions.
- The user asks "/wiki" or "set up the wiki".
- A vault already has notes but no `wiki/` folder, and the user wants to graduate it to a wiki.

## When NOT to use

- The user just wants to write a single note → don't scaffold.
- The vault already has `wiki/index.md` and looks healthy → suggest `wiki-lint` instead.
- The user is asking how the pattern works conceptually → explain, don't scaffold.

## Pre-flight

Before scaffolding, you must know:

1. **Which vault** to scaffold in. Call `mcp__obsidian-router__list_vaults` first. If the user said "this vault" without specifying, use the default vault. If multiple vaults are configured, ask which.
2. **Which mode** the wiki targets — this affects only the seed of `index.md` and `overview.md`. Common modes:
   - `personal` — second brain, journals, projects, references
   - `research` — papers, concepts, hypotheses, methodology
   - `business` — competitors, customers, decisions, stakeholders
   - `code` — codebases, ADRs, runbooks
   - `domain` — anything else (let the user describe in 1 sentence)

If the user didn't say, ask in one short question. Don't enumerate all modes — give 2-3 likely ones based on context.

## Steps

1. Verify the target vault is online via `list_vaults`. Bail with a clear message if `online: false` or `missingApiKey: true`.

2. Check whether `wiki/index.md` already exists:
   ```
   mcp__obsidian-router__get_file({ vault: <name>, path: "wiki/index.md" })
   ```
   If it returns 200 → the wiki is already scaffolded. Tell the user, offer to run `wiki-lint` instead. Stop.

3. Create the four scaffolding files using `mcp__obsidian-router__write_file` (use `ifNew: true` so we never clobber).

   The `templates/wiki/` folder in this repo (`I:\DEVELOPPEMENT\obsidian-mcp-router\templates\wiki\`) ships starter content for each scaffolding file. Read the template via the local filesystem and substitute these placeholders before writing to the target vault:

   | Placeholder | Substitute with |
   |---|---|
   | `{{TIMESTAMP}}` | Current ISO timestamp (`YYYY-MM-DD HH:MM`) |
   | `{{VAULT_PATH}}` | The absolute path of the target vault |
   | `{{MODE}}` | The chosen mode (`personal`, `research`, etc.) — only in `overview.md` if you decide to seed it |

   If you can't read the templates (e.g., the user installed via npm without the templates dir), fall back to inline content — the structure for each file is documented below:

   - `wiki/index.md` — catalog of all wiki pages, organized by domain. Initial structure must include sections matching the chosen mode. Include a one-line invariant at the top: "This file is the catalog of the wiki. Add a row for every new page filed under wiki/."

   - `wiki/log.md` — append-only operation history. Each entry: ISO timestamp + verb + target page(s) + 1-line reason. Initial entry: "scaffolded by wiki skill on YYYY-MM-DD".

   - `wiki/hot.md` — recent-context cache (≤500 words). What's been recently touched, key facts, active threads. Empty placeholder at scaffold time with structure: `## Last Updated`, `## Key Recent Facts`, `## Recent Changes`, `## Active Threads`.

   - `wiki/overview.md` — executive summary of the wiki's domain. 100-300 words written by you based on what the user said about the mode/domain. If the user gave no detail, leave a stub: "_Update me with a one-paragraph summary of what this wiki covers._"

4. Append a `CLAUDE.md` block at the vault root (or create the file if absent). The block tells Claude how to navigate the wiki:
   ```
   ## Wiki Knowledge Base

   Path: <vault-path>

   When you need context not already in this conversation:
   1. Read `wiki/hot.md` first (cheap, recent context).
   2. If not enough, read `wiki/index.md` to find the relevant page.
   3. Drill into specific wiki pages.
   4. After substantive work, append a 1-line entry to `wiki/log.md`.
   5. After substantive work, refresh `wiki/hot.md` with the latest state.

   Use the `obsidian-router` MCP for all reads/writes — it's the multi-vault aware path.
   ```

   Use `mcp__obsidian-router__append_to_file` if `CLAUDE.md` exists, else `write_file` with `ifNew: true`.

5. Append the scaffold operation to `wiki/log.md` itself:
   ```
   - YYYY-MM-DD HH:MM — scaffold — index.md, log.md, hot.md, overview.md, CLAUDE.md — initial wiki bootstrap (mode: <mode>)
   ```

6. Confirm to the user:
   - Vault scaffolded
   - List of files created (4 + CLAUDE.md update)
   - Suggested next step: "ingest your first source with `wiki-ingest`" or "ask me a question — I'll start filling the wiki as we go"

## Anti-patterns

- Don't scaffold without confirming which vault.
- Don't overwrite an existing `wiki/index.md` — bail and suggest `wiki-lint`.
- Don't invent vault content during scaffold. Stubs are fine. The wiki gets populated through ingestion and queries, not at scaffold time.
- Don't use Claude's native `Write` tool — it works only when the project IS the vault. Use `mcp__obsidian-router__write_file` everywhere so the skill is multi-vault and cross-project.

## Output format

End your turn with a compact summary:

> ✅ Wiki scaffolded in vault `<name>` (mode: `<mode>`).
> Created: `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`, `wiki/overview.md`, `CLAUDE.md` updated.
> Next: try `wiki-ingest <source>` to file your first source, or just start asking questions — I'll grow the wiki as we go.
