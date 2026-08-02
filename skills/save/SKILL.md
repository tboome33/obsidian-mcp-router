---
name: save
description: File the current Claude conversation (or a specific insight from it) as a structured wiki note. Auto-detects the right type (decision, answer, session-log, technique, ADR), writes appropriate frontmatter, places the file in the correct wiki folder, and updates catalog.md, journal.md, hot.md. Use when the user says "save this", "save that answer", "/save", "file this conversation", "keep this", "save as note", or any phrasing implying the current chat output should land in their knowledge base.
---

# save

The most-used wiki skill. Turn the current conversation into a wiki page in seconds, with the right frontmatter and links so future queries find it.

## When to use

- "save this" / "save that answer" — file the current turn or a recent thread as a polished, type-classified document
- "/save <name>" — file with an explicit slug instead of inferred one
- "save this decision" / "ADR this" — file as a decision/ADR with that frontmatter type

> ⚠️ **`/save` no longer files to `wiki-meta/Sessions/`** (router v0.12.8+; was `wiki/Sessions/` in v0.12.4–v0.12.7). That folder is owned by the **`session-auto-journal.mjs` hook** which writes one chronological file per Claude Code session automatically AND auto-appends a 2-line summary (objectif + résultat) to `wiki-meta/journal.md` at SessionEnd. Use `/save` for **polished, type-classified outputs** that deserve a permanent document — decisions, answers, references, techniques, ADRs, ideas. If the user says "save this session" or "save the whole conversation", redirect: the auto-journal already captures the raw chronology + a log summary; ask which polished insight they want to extract.

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

If the user says "/save" alone with no qualifier (intending "the whole session"), redirect them: *"The auto-journal already captures the chronology in `wiki-meta/Sessions/<today>-...md` AND a 2-line summary in `wiki-meta/journal.md`. Which polished insight from this session do you want extracted into a permanent document? (decision / answer / reference / technique / ADR)"*.

If ambiguous, ask one short question. Don't save the wrong thing.

### 2. Infer or accept the slug

- If the user gave a name (`/save my-trading-plan`), slugify it **OKF-safe** (2026-07-29 policy — new notes are born conformant): ASCII-fold accents (`é` → `e`), lowercase kebab-case, charset `[a-z0-9._-]` only, never spaces — the exact pipeline of `slug()` in `src/helpers/filters/slug.mjs`.
- Else, derive a slug from the most representative sentence of what you're saving (3-6 words), same OKF-safe pipeline.
- The server echoes an `okfNameWarning` field on any `write_file`/`move_file`/`execute_template` whose target violates this — treat it as a naming bug to fix immediately (rename to the suggested path), not as noise.

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

If the wiki has a different convention (look at `wiki-meta/catalog.md` structure to detect), match that.

**Group by SUBJECT before type** (2026-07-30): when the vault already holds 2-3 related notes on the same subject, create `wiki/<sujet>/` and file (or `move_file`) them together instead of leaving them scattered in flat type folders — wikilinks resolve by basename, so regrouping is safe. Each directory then gets a generated `index.md` landing page (OKF projection, auto-refreshed) — never write one by hand.

### 4. Compose the frontmatter

```yaml
---
type: <inferred>
title: "<human-readable title, ≤80 chars>"
description: "<ONE sentence saying what the page concludes — see below>"
slug: <slug>
saved_at: <ISO>
tags: [<inferred from content, 2-4 tags>]
sources: []         # if user referenced wiki pages, fill with [[wikilinks]]
related: []         # cross-references to existing wiki pages
source_type: <see below>   # see "Source provenance" in vault CLAUDE.md
---
```

**`description` is mandatory** (see "One-line summary" in the vault `CLAUDE.md`). It is the line the OKF directory indexes publish — `* [Title](file.md) - description` — so a page without one shows up in the vault's own navigation as a bare filename. Nothing downstream will invent it for you: the at-rest projections report the gap rather than synthesizing a sentence, precisely so the omission stays visible and fixable here.

Write what the page **concludes**, not what it is about, in one plain sentence with no markdown and no `[[wikilinks]]` (it is a YAML scalar rendered inline): *"Décision : BM25 plutôt qu'un scorer à embeddings pour le filtre de pertinence"* — not *"Note sur le choix du scorer"*.

Choose `source_type` based on what you're filing:

- `extracted` — a direct citation, a verbatim user statement, or a piece of literal source material the user is preserving.
- `inferred` — content that you (Claude) derived by reading the conversation but that wasn't said verbatim — most `answer` and many `session` notes land here.
- `claude_synthesized` — pure synthesis from you with no direct textual basis in what the user said. Often appropriate for `idea` notes you propose to file, or for `decision` notes where the framing is yours, not the user's words. When in doubt prefer the more conservative tag.

For pages whose paragraphs mix provenance (common for `session` notes — user verbatim + your inferences + your synthesis), set the frontmatter to the dominant kind and mark per-paragraph exceptions with inline callouts `[!extracted]` / `[!inferred]` / `[!claude_synthesized]`.

For `decision` / `adr` / `decision-input` types, add the decision contract (v0.49.0+ — see "Decision pages — frontmatter contract" in the vault `CLAUDE.md`):

```yaml
status: proposed        # proposed | accepted | superseded | rejected — no other value
scope: <perimeter this decision applies to>   # required
context: <1 line>
consequences: <1 line>
supersedes: "[[old-decision]]"   # only when replacing one — see below
affects: ["[[impacted-page]]"]   # directional: re-review these if this is superseded
evidence: ["[[study-or-session]]"]  # what motivated the verdict
review_after: YYYY-MM-DD         # only if the decision depends on a changeable state of the world
```

Three rules that are NOT negotiable:

1. **Write `proposed`, never `accepted`.** You propose; the human accepts. Say so explicitly in your output: *"filed as `proposed` — tell me when you want it flipped to `accepted`"*. Never self-validate a decision, in any auto-enrichment mode.
2. **`supersedes:` is a two-file edit.** Adding `supersedes: "[[old]]"` REQUIRES flipping `[[old]]` to `status: superseded` in the same turn (`set_frontmatter`). Skipping that leaves two contradictory decisions both reading as live — the exact failure the discipline prevents.
3. **Never rewrite an accepted verdict.** If the user changed their mind, create a NEW decision page with `supersedes:` — don't edit the old one beyond its status. Its original context is what explains why it was decided that way.

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
- **For `decision` / `adr`**: `# <Title>` → `## Context` → `## Decision` → `## Consequences` → `## Alternatives considered`. The conversation likely already had this implicitly. The alternatives section is what the code and the PRD can never contain — if genuinely no option was weighed, write "**No serious alternative**" plus why (an external constraint, a licence, a third-party limit); an absent section is what's forbidden, not an honestly empty one.
- **For `technique` / `runbook`**: `# <Title>` → `## Prerequisites` → `## Steps` → `## Gotchas` → optional `## See also`. Step-by-step procedure with prerequisites and gotchas inline.
- **For `idea`**: `# <Title>` → `## The idea` → `## Why it matters` → `## Concrete first step`. The nucleus of the idea, why it matters, what would make it concrete.

If the content is genuinely too thin to support 2 `## H2` sections, push back to the user: *"This is too brief for a standalone page — append as a line to `wiki/facts.md` instead?"* Don't produce a flat single-section note that defeats Outline navigation.

End with a `## See also` section linking to wiki pages mentioned during the conversation: `[[Page A]]`, `[[Page B]]`.

### 6. Write to the vault — as ONE bundle (v0.66.0+, borrowing C2)

A save is not one write: it is the page **plus** the journal line **plus** the `hot.md` refresh (steps 8 below). A crash between them leaves a journal entry for a page that does not exist, or a page nobody logged. Group them into a single `write_bundle` call so the whole save either lands or does not:

```
mcp__obsidian-router__write_bundle({
  vault: <name>,
  steps: [
    { op: "write",  path: "wiki/<folder>/<slug>.md", content: <frontmatter + body>, ifNew: true },
    { op: "append", path: "wiki-meta/journal.md",    content: "- YYYY-MM-DD HH:MM — save — …\n" },
    { op: "write",  path: "wiki-meta/hot.md",        content: <rewritten hot>, ifMatch: <its contentSha256> }
  ]
})
```

Read the `outcome` field before reporting anything: `applied` means the whole save landed; `rolled-back` means **nothing** did (say what failed, do not claim a partial save); `rolled-back-partial` means some files are still dirty — name them from `rollback.paths`.

Put `ifMatch` on the shared files (`hot.md`, `catalog.md`) with the `contentSha256` you got when you read them: every precondition is checked before the first write, so a parallel session's edit refuses the whole save instead of overwriting them.

If the `write` step reports a conflict on `ifNew: true`, the slug-suffix logic from step 2 should have prevented it — bail and tell the user.

**Leave step 7 (backlinks) OUT of the bundle.** Its `patch_file` → 404 → `append_to_file` fallback relies on a step *failing*, which inside a bundle rolls the whole save back. Either resolve the branch first (read the target, pick the right op, then bundle it) or run the backlinks separately after the bundle applied.

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

### 8. Update catalog.md, journal.md, hot.md

- `catalog.md` — **usually nothing to do.** The catalog is a *map of maps*: one entry per directory, pointing at that directory's generated `index.md`. A new page in an existing directory is picked up by the generated index automatically — appending a row here is what grew one vault's catalog to 70 KB / 115 rows and made it unreadable in a single tool call. Touch it **only** when the page creates a **new directory** under `wiki/`: then add one area block (italic one-liner + markdown link `[<dir>](../wiki/<dir>/index.md)` — never a wikilink, since every index shares the `index` basename and Obsidian would resolve it ambiguously). Promoting a page into "Read first" is a deliberate editorial call, not a mechanical step.
- `journal.md` — `- YYYY-MM-DD HH:MM — save — wiki/<folder>/<slug>.md — <type>: <one-line summary>`
- `hot.md` — replace `## Recent Changes` to mention this save

These two are **steps of the bundle from step 6**, not separate calls afterwards — that grouping is the whole point. Only a `catalog.md` edit (rare: a genuinely new directory) is a judgement call worth its own write.

### 8b. Optional cross-link to the active session journal (v0.12.8+)

If `~/.claude/obsidian-mcp-router/session-journals/<session-id>.json` exists (the current Claude Code session is being journaled by the `session-auto-journal.mjs` hook), propose to suffix the `journal.md` save entry with a wikilink back to the session file. Format:

```
- YYYY-MM-DD HH:MM — save — wiki/<folder>/<slug>.md — <type>: <summary> · session [[<session-basename-sans-md>]]
```

The basename is the journal file under `wiki-meta/Sessions/` (e.g. `2026-05-24-1103-obsidian-mcp-router-8f4`). This lets a reader of `journal.md` jump from the polished save document to the raw chronology of the session that produced it. Optional — only do it if the conversation context made it clear which session this save belongs to. Skip silently if the state JSON doesn't exist (session journaling not active or hook disabled).

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
