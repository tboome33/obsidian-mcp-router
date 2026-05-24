---
name: save
description: File the current Claude conversation (or a specific insight from it) as a structured wiki note. Auto-detects the right type (decision, answer, session-log, technique, ADR), writes appropriate frontmatter, places the file in the correct wiki folder, and updates index.md, log.md, hot.md. Use when the user says "save this", "save that answer", "/save", "file this conversation", "keep this", "save as note", or any phrasing implying the current chat output should land in their knowledge base.
---

# save

The most-used wiki skill. Turn the current conversation into a wiki page in seconds, with the right frontmatter and links so future queries find it.

## When to use

- "save this" / "save that answer" — file the current turn or a recent thread as a polished, type-classified document
- "/save <name>" — file with an explicit slug instead of inferred one
- "save this decision" / "ADR this" — file as a decision/ADR with that frontmatter type

> ⚠️ **`/save` no longer files to `wiki-meta/Sessions/`** (router v0.12.8+; was `wiki/Sessions/` in v0.12.4–v0.12.7). That folder is owned by the **`session-auto-journal.mjs` hook** which writes one chronological file per Claude Code session automatically AND auto-appends a 2-line summary (objectif + résultat) to `wiki-meta/log.md` at SessionEnd. Use `/save` for **polished, type-classified outputs** that deserve a permanent document — decisions, answers, references, techniques, ADRs, ideas. If the user says "save this session" or "save the whole conversation", redirect: the auto-journal already captures the raw chronology + a log summary; ask which polished insight they want to extract.

## When NOT to use

- The user asks "save the file" referring to an actual file on disk → that's `Write`/`Edit`, not this skill
- The conversation has nothing worth saving (small talk, errors, abandoned attempt) → push back gently: "this conversation doesn't have a clear takeaway — what specifically should I save?"
- The user wants to ingest an external source → that's `wiki-ingest`

## Pre-conditions

1. Target vault has `wiki/` scaffolding (use `wiki` skill first if not).
2. Vault is online.

## Steps

### 1. Identify what to save

Three flavors (the `session` flavor is **deprecated** — auto-journal hook owns chronological capture since v0.12.4):

- **Specific answer** — "save that answer". Capture the most recent substantive answer from you, with enough context for it to make sense alone. Type: `answer`.
- **Specific insight** — "save this decision" / "save this technique" / "ADR this". The user is pointing at a discrete thing. Type matches what they said (`decision`, `technique`, `idea`, `runbook`, `adr`).
- **Reference / runbook** — "save this as a ref" or the conversation produced a how-to. Type: `reference`.

If the user says "/save" alone with no qualifier (intending "the whole session"), redirect them: *"The auto-journal already captures the chronology in `wiki-meta/Sessions/<today>-...md` AND a 2-line summary in `wiki-meta/log.md`. Which polished insight from this session do you want extracted into a permanent document? (decision / answer / reference / technique / ADR)"*.

If ambiguous, ask one short question. Don't save the wrong thing.

### 2. Infer or accept the slug

- If the user gave a name (`/save my-trading-plan`), slugify it: lowercase, kebab-case, drop non-alphanumeric.
- Else, derive a slug from the most representative sentence of what you're saving (3-6 words).

Check if `wiki/<folder>/<slug>.md` already exists. If yes:
- Add a numeric suffix (`-2`, `-3`) and tell the user.
- OR ask: "There's already a page at this slug — overwrite, append, or new with suffix?"

### 3. Choose the folder

Default folders by type:
- `answer` → `wiki/answers/`
- `decision` / `adr` → `wiki/decisions/`
- `technique` / `runbook` → `wiki/techniques/`
- `reference` → `wiki/refs/`
- `idea` → `wiki/ideas/`
- Else → `wiki/notes/` as fallback

**Never** route to `wiki-meta/Sessions/` — that folder is owned by `session-auto-journal.mjs` (router v0.12.8+; was `wiki/Sessions/` in v0.12.4–v0.12.7). If a `session` type slips through somehow, treat it as `answer` or `reference` and pick the more appropriate folder.

If the wiki has a different convention (look at `wiki-meta/index.md` structure to detect), match that.

### 4. Compose the frontmatter

```yaml
---
type: <inferred>
title: "<human-readable title, ≤80 chars>"
slug: <slug>
saved_at: <ISO>
tags: [<inferred from content, 2-4 tags>]
sources: []         # if user referenced wiki pages, fill with [[wikilinks]]
related: []         # cross-references to existing wiki pages
source_type: <see below>   # see "Source provenance" in vault CLAUDE.md
---
```

Choose `source_type` based on what you're filing:

- `extracted` — a direct citation, a verbatim user statement, or a piece of literal source material the user is preserving.
- `inferred` — content that you (Claude) derived by reading the conversation but that wasn't said verbatim — most `answer` and many `session` notes land here.
- `claude_synthesized` — pure synthesis from you with no direct textual basis in what the user said. Often appropriate for `idea` notes you propose to file, or for `decision` notes where the framing is yours, not the user's words. When in doubt prefer the more conservative tag.

For pages whose paragraphs mix provenance (common for `session` notes — user verbatim + your inferences + your synthesis), set the frontmatter to the dominant kind and mark per-paragraph exceptions with inline callouts `[!extracted]` / `[!inferred]` / `[!claude_synthesized]`.

For `decision` type, add:
```yaml
status: proposed | accepted | rejected | superseded
context: <1 line>
consequences: <1 line>
```

For `session`, add:
```yaml
prompt: "<user's opening prompt or summary of intent>"
duration_messages: <count>
```

### 5. Write the body

This is the part that requires care. Don't dump the raw transcript verbatim. Distill.

**Heading hierarchy is MANDATORY** — see the vault `CLAUDE.md` section "Note structure — headings hierarchy". TL;DR: one `# H1` matching the title at top, then proper `## H2` sections (never skip levels, never use bold as faux-heading). Outline panel relies on it.

- **For `answer`**: `# <Title>` → `## Question` → `## Answer` → optional `## See also`. Future-you might read this in 6 months without context.
- **For `session`**: `# <Title>` → `## Prompt` → `## What happened` → `## Outcome` → optional `## See also`. 200-500 words across the H2 sections.
- **For `decision` / `adr`**: `# <Title>` → `## Context` → `## Decision` → `## Consequences` → optional `## Alternatives considered`. The conversation likely already had this implicitly.
- **For `technique` / `runbook`**: `# <Title>` → `## Prerequisites` → `## Steps` → `## Gotchas` → optional `## See also`. Step-by-step procedure with prerequisites and gotchas inline.
- **For `idea`**: `# <Title>` → `## The idea` → `## Why it matters` → `## Concrete first step`. The nucleus of the idea, why it matters, what would make it concrete.

If the content is genuinely too thin to support 2 `## H2` sections, push back to the user: *"This is too brief for a standalone page — append as a line to `wiki/facts.md` instead?"* Don't produce a flat single-section note that defeats Outline navigation.

End with a `## See also` section linking to wiki pages mentioned during the conversation: `[[Page A]]`, `[[Page B]]`.

### 6. Write to the vault

```
mcp__obsidian-router__write_file({
  vault: <name>,
  path: "wiki/<folder>/<slug>.md",
  content: <frontmatter + body>,
  ifNew: true
})
```

If `ifNew: true` returns conflict, the slug-suffix logic from step 2 should have prevented this — bail and tell the user.

### 7. Cross-link related pages

For each `[[wikilink]]` in your body, also UPDATE that target page to add a backlink. Fully-specified call:

```
patch_file({
  vault, path: "wiki/<target>.md",
  operation: "append",
  targetType: "heading",
  target: "Backlinks",
  content: "- [[<your-new-page>]]"
})
```

If `## Backlinks` doesn't exist on the target page, the `patch_file` call returns 404 (heading-not-found). Fall back to `append_to_file` with the heading and bullet inline:

```
append_to_file({
  vault, path: "wiki/<target>.md",
  content: "\n## Backlinks\n\n- [[<your-new-page>]]\n"
})
```

This is the "compounding" property: every saved page becomes more findable from the pages it touches.

### 8. Update index.md, log.md, hot.md

- `index.md` — append a row under the section matching the type
- `log.md` — `- YYYY-MM-DD HH:MM — save — wiki/<folder>/<slug>.md — <type>: <one-line summary>`
- `hot.md` — replace `## Recent Changes` to mention this save

### 8b. Optional cross-link to the active session journal (v0.12.8+)

If `~/.claude/obsidian-mcp-router/session-journals/<session-id>.json` exists (the current Claude Code session is being journaled by the `session-auto-journal.mjs` hook), propose to suffix the `log.md` save entry with a wikilink back to the session file. Format:

```
- YYYY-MM-DD HH:MM — save — wiki/<folder>/<slug>.md — <type>: <summary> · session [[<session-basename-sans-md>]]
```

The basename is the journal file under `wiki-meta/Sessions/` (e.g. `2026-05-24-1103-obsidian-mcp-router-8f4`). This lets a reader of `log.md` jump from the polished save document to the raw chronology of the session that produced it. Optional — only do it if the conversation context made it clear which session this save belongs to. Skip silently if the state JSON doesn't exist (session journaling not active or hook disabled).

### 9. Output

> ✅ Saved to `wiki/<folder>/<slug>.md` (type: `<type>`).
> Title: <title>
> Tags: <tags>
> Cross-linked: [[Page A]], [[Page B]]
> Find it later via `wiki-query` or by searching the index.

## Anti-patterns

- Don't save trivial stuff. If the conversation was "what's 2+2", don't make a wiki page out of it.
- Don't dump raw conversation. Distill. The wiki is your synthesis, not a transcript archive.
- Don't invent cross-links. Only `[[wikilink]]` to pages that exist (verify via `list_files` or by reading the index).
- Don't skip the backlink updates — they're what make the wiki searchable laterally.
- Don't fabricate decisions. If the user says "save this decision" but no clear decision was made, ask them to articulate it first.
