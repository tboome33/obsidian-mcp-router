---
type: wiki-claude
mode: personal
created: 2026-05-17
updated: 2026-05-17
---

# Navigation rules for Claude

This vault is a Karpathy-style **LLM wiki** in **personal mode**. Treat it as a living second-brain.

The wiki lives entirely under the `wiki/` subdirectory. The four scaffolding files are at `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`, `wiki/overview.md`. Page folders described below are also under `wiki/` (e.g. `wiki/People/`, `wiki/Concepts/`, etc.).

## Read order at session start

1. `wiki/hot.md` — recent-context cache, fastest recovery.
2. `wiki/index.md` — full catalog when you need to navigate.
3. Specific pages under `wiki/<folder>/<slug>.md` — drill into whatever the user is asking about.
4. `wiki/log.md` — only when the user asks "what changed recently".

Use the `obsidian-router` MCP for all reads/writes (`mcp__obsidian-router__get_file`, `mcp__obsidian-router__write_file`, etc.). Native `Read`/`Write` only work when the project IS the vault — the router-prefixed tools are multi-vault and cross-project safe.

## Folder conventions (all under `wiki/`)

- `wiki/People/` — one file per person. Frontmatter: `type: person`, optional `relationship`, `since`, `tags`.
- `wiki/Concepts/` — one file per idea/framework. Frontmatter: `type: concept`, `tags`.
- `wiki/Sessions/` — daily notes and chat logs. Filename `YYYY-MM-DD.md` for daily, free-form for ad-hoc. Frontmatter: `type: session`, `date`.
- `wiki/Decisions/` — one file per decision. Frontmatter: `type: decision`, `date`, `status`.
- `wiki/Refs/` — external sources. Frontmatter: `type: reference`, `url`, `author`, `accessed`.
- `wiki/Projects/` — personal threads. Frontmatter: `type: project`, `status`.

## Writing pages

- Path always starts with `wiki/`.
- Always include frontmatter (`type`, `created`, `updated`, plus type-specific fields).
- Cross-link liberally with `[[wikilinks]]`. Resolution is from the vault root, so `[[hot]]` from a page under `wiki/Concepts/` will NOT find `wiki/hot.md` — use `[[wiki/hot]]` or rely on Obsidian's name resolution which handles unique filenames.
- Add the page to `wiki/index.md` under the right section.
- Append a one-line entry to `wiki/log.md`.
- Refresh `wiki/hot.md` if the page is significant.

## Note structure — headings hierarchy (mandatory)

Every wiki page MUST have a proper heading hierarchy so the **Outline** plugin can navigate it. Without this, the Outline panel is empty and long notes become unscannable.

- **Exactly one `# H1`** at the top — matches the note's `title:` frontmatter (or a clean rephrasing of the filename).
- **`## H2`** for main sections (Context, Notes, Interactions, See also, etc.).
- **`### H3`** for sub-sections inside an H2 (only when needed).
- **Never skip levels** (no H3 without H2 above).
- **Length rule**: any note > 200 words MUST have at least 2 `## H2` sections.

### Type-specific minimums

| Type | Required `## H2` sections |
|---|---|
| `session` | `## Prompt`, `## What happened`, `## Outcome`, optional `## See also` |
| `answer` | `## Question`, `## Answer`, optional `## See also` |
| `decision` | `## Context`, `## Decision`, `## Consequences`, optional `## Alternatives` |
| `person` | `## Context`, `## Notes`, `## Interactions` |
| `concept` | `## Definition`, `## Why it matters`, `## Related` |
| `reference` | `## Summary`, `## Key takeaways`, `## Source` |
| `project` | `## Goal`, `## Status`, `## Open questions`, optional `## Log` |

If the content is too thin for 2 H2 sections, file it as a one-liner in `wiki/facts.md` instead of creating a flat standalone page.

## Skills to use

- `wiki-ingest` — file external sources (URLs, articles, pasted text).
- `save` — file the current conversation as a session/decision/answer.
- `wiki-query` — answer questions grounded in this vault only (no web).
- `autoresearch` — web-fed research loop (asks confirmation, costs tokens).
- `wiki-lint` — health-check (orphans, dead links, drift).
- `wiki-fold` — roll up `wiki/log.md` entries into a fold page.

## Don't

- Don't write pages outside the `wiki/` subdirectory. The whole stack assumes the prefix.
- Don't invent facts. If something isn't in the wiki, say so.
- Don't write pages without updating `wiki/index.md` and `wiki/log.md`.
- Don't bypass the type frontmatter — it's how queries find things.
