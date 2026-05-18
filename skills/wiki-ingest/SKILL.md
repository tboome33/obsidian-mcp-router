---
name: wiki-ingest
description: Read a source (file, URL, or pasted text), extract the entities and concepts that matter, and file them as wiki pages with cross-references. Updates the wiki's index.md, log.md, and hot.md so future sessions can find what was ingested. Use this skill whenever the user says "ingest this", "add this to the wiki", "process this source", "file this article", "absorb this", "ingest <url>", "/wiki-ingest", or drops a file/URL with the implicit intent to incorporate it into their knowledge base.
---

# wiki-ingest

Take a source (URL, local file path, or pasted text) and do the structured work of: pulling it in, identifying what's worth keeping, writing wiki pages for the new entities/concepts, and updating the relevant cross-references — all idempotently so re-ingesting the same source doesn't duplicate.

## Pre-conditions

1. The target vault has a `wiki/` folder with `index.md`, `log.md`, `hot.md`. If not, run the `wiki` skill first.
2. The vault is online (call `list_vaults`).
3. You have one of: a URL, a file path on disk, or text the user pasted.

## When to use

- "ingest this URL" / "absorb this article"
- The user pastes a long block of text and says "file this"
- Batch mode: "ingest all of these" with multiple sources → fan out via the `wiki-ingest` sub-agent (in `agents/wiki-ingest.md`).

## When NOT to use

- The user wants a quick answer without filing → just answer, don't ingest.
- The source is already filed (check `wiki/index.md` for the title or URL) → tell them; offer to refresh instead.
- The "source" is the current conversation → use the `save` skill instead.

## Steps

### 1. Acquire the source content

- **URL**: use `WebFetch` (or the `defuddle` skill first if it's a noisy webpage with ads/nav).
- **Local file**: prefer `mcp__obsidian-router__get_file` if the file is inside a vault; else `Read`.
- **Pasted text**: use what the user gave you.

If acquisition fails, surface the error and stop. Don't ingest a partial source.

### 2. Extract structure (do this before writing anything)

Identify:

1. **Source metadata**: title, author(s) if known, publication date, URL or path, source type (article, paper, video transcript, code repo, book chapter, conversation, etc.).
2. **Top-level entities** the source is fundamentally ABOUT (e.g., a person, a concept, a project, a place). Usually 1-5.
3. **Supporting concepts** that show up but aren't the main focus (e.g., a method, a tool, a related work). Usually 3-10.
4. **Claims worth recording** — assertions the source makes that someone querying the wiki would later want to look up.

Don't extract everything. The wiki gets cluttered when ingestion is too eager. If a concept is only mentioned in passing, skip it.

### 3. Page plan (decide before writing)

For each entity/concept:

- Does a wiki page already exist for it? Read `wiki/index.md` to check.
  - **Exists** → you'll APPEND a section to that page, not create a new one.
  - **Doesn't exist** → you'll CREATE a new page.
- What folder should it live in? Match the wiki's existing organization (read `wiki/index.md` structure). If unclear, default folders: `concepts/`, `entities/`, `sources/`, `projects/`.

Output a 1-paragraph plan to the user before writing files. They can correct misclassifications cheaply now.

### 4. File the source itself

Create `wiki/sources/<slugified-title>.md` with frontmatter:

```yaml
---
type: source
title: "<exact title>"
url: <url or path>
ingested_at: <ISO date>
authors: [<...>]
tags: [<source-type>, <topic-tags>]
source_type: extracted    # see "Source provenance" in vault CLAUDE.md
---
```

The source page itself is `extracted` — the body is a faithful summary/quote of an external document. For entity/concept pages spawned from this source (step 5), the provenance varies — use `inferred` when Claude derived the page from cues in the source, `claude_synthesized` when the page is pure synthesis with no direct textual basis. When in doubt, prefer the more conservative tag (`claude_synthesized` over `inferred`, `inferred` over `extracted`).

Body structure (heading hierarchy is MANDATORY — see vault `CLAUDE.md` section "Note structure"):

- `# <title>` — exactly one H1 at the top (matches the frontmatter title).
- `## Summary` — 1-2 paragraph summary of what the source says.
- `## Key Claims` — 3-7 bulleted claims (each ≤2 lines, factual, citable).
- `## Related` — wikilinks to the entity/concept pages you're about to create or update.

Never produce a flat body without H2 sections — Outline plugin relies on the structure for navigation.

Use `mcp__obsidian-router__write_file` with `ifNew: true`. If a page with this slug already exists, **stop and ask** — never silently overwrite.

### 5. Create or update entity/concept pages

For each entity/concept identified in step 2:

- **New page**: `mcp__obsidian-router__write_file` with frontmatter `type: entity` (or `concept`), `tags`, **and `source_type`** (`extracted` if the page is a literal quote/citation, `inferred` if derived by reading the source, `claude_synthesized` if pure synthesis — see step 4 note and vault CLAUDE.md "Source provenance" section). For paragraphs of mixed provenance inside the body, use inline callouts `[!extracted]` / `[!inferred]` / `[!claude_synthesized]`. Body MUST follow the heading hierarchy: one `# <title>` H1, then for `concept` use `## Definition` / `## Why it matters` / `## Related` / `## Sources`; for `entity` use `## Context` / `## Notes` / `## Sources`. End the body with a `## Sources` H2 that wikilinks to the source page you just filed.

- **Existing page**: use `mcp__obsidian-router__patch_file` to:
  - Append a bullet under `## Sources` — fully-specified call:
    ```
    patch_file({
      vault, path,
      operation: "append",
      targetType: "heading",
      target: "Sources",
      content: "- [[sources/<slug>]]"
    })
    ```
    If the `## Sources` section doesn't exist yet, fall back to `append_to_file` with the heading + bullet inline.
  - Append a new section `## From <source-title>` containing the new claims/insights — use `append_to_file` (creates or appends), not `patch_file` (which targets an EXISTING heading).
  - Don't rewrite existing content. The wiki is append-only at the section level.

### 6. Update index.md

Use `patch_file` with `operation: append`, `targetType: heading`, `target: "<section-name>"` (e.g., `target: "Sources"` for source pages, `target: "Concepts"` for concept pages) to add rows for any newly created pages. Keep the index alphabetized within each section.

If the section heading doesn't exist in `index.md` yet, fall back to `append_to_file` and write `\n## <section>\n\n- [[<page>]]\n`. The `wiki` skill scaffolds the standard sections, so this fallback is rare.

### 7. Append to log.md

```
- YYYY-MM-DD HH:MM — ingest — <source-title> — created N pages, updated M pages
```

### 8. Refresh hot.md

Replace `## Recent Changes` with the just-ingested source + the entities touched. Keep `hot.md` ≤ 500 words total — drop the oldest entry if needed.

### 9. Confirm to the user

Compact summary:
- Source filed at `wiki/sources/<slug>.md`
- Entities/concepts created: list with wikilinks
- Entities/concepts updated: list with wikilinks
- One-line takeaway from the source

## Anti-patterns

- Don't dump the full source text into the wiki. The wiki is your synthesis, not the archive. (If the user wants the original archived, suggest a `.raw/` folder for that.)
- Don't create pages with no body beyond the title. If you can't write 2 sentences about an entity, skip it — it'll resurface naturally if it matters.
- Don't ingest before step 3 (page plan). Surfacing the plan first saves rework.
- Don't use `Write`/`Edit` natively — always go through the router so this works cross-project.
- Don't fabricate frontmatter dates. If the source has no date, omit the field.

## Quirks

- Wikilinks in Obsidian: `[[Page Name]]` or `[[Page Name|alias]]`. The path is relative to the vault root and Obsidian resolves it.
- For ambiguous wikilinks across folders, use the full path: `[[concepts/Bayesian Inference]]`.
- If the source is huge (book chapter, long paper), break it into multiple ingest passes — one entity at a time. Don't try to do everything in one turn.

## Batch mode

If the user gives multiple sources in one go ("ingest all these PDFs"), use the `wiki-ingest` sub-agent in `agents/wiki-ingest.md` to fan out — one agent per source, parallel. The orchestrator (you) waits for all to return, then writes a single consolidated log entry and one hot.md refresh.
