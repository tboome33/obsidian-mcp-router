---
name: wiki-query
description: Answer a question using the wiki vault as the knowledge base. Reads hot.md first (cheap recent context), then index.md to navigate, then drills into specific pages and synthesizes an answer with citations. Optionally files a good answer back as a new wiki page so future queries get a faster path. Use this skill when the user asks "what do you know about X", "based on my wiki, ...", "explain X using my notes", "search the wiki for X", "/wiki-query", or any question that should be grounded in their personal knowledge base instead of the model's general knowledge.
---

# wiki-query

Three-tier retrieval: cheap (hot cache) → cheap (index) → expensive (full pages + semantic search). Stop at the first tier that answers the question. Always cite the wiki pages used.

## Pre-conditions

1. Target vault has `wiki/` scaffolding (`hot.md`, `index.md` minimum). If not, tell the user the wiki isn't set up; offer the `wiki` skill.
2. Vault is online (`list_vaults`).

## Modes

The user may signal a preferred mode:

- **quick** — answer from hot.md alone if possible. Bail to standard if hot doesn't cover it.
- **standard** (default) — hot → index → 1-3 specific pages → synthesize.
- **deep** — hot → index → semantic search across the wiki → 5-10 pages → synthesize → file the answer back as a new wiki page.

If the user didn't say, infer: short factual question = quick; "explain X" = standard; "give me everything you know about X" or "research X" = deep.

## Steps

### Tier 1: hot.md

```
mcp__obsidian-router__get_file({ vault, path: "wiki/hot.md" })
```

Read it. If the cache contains the answer (the question is covered by the recent activity), answer from hot alone. Cite `wiki/hot.md` as source. Stop.

If hot doesn't cover it: don't try to extract anything tangential. Move to tier 2.

### Tier 2: index.md

```
mcp__obsidian-router__get_file({ vault, path: "wiki/index.md" })
```

Scan it for pages whose titles match the question. Pick 1-3 most relevant. If nothing in the index matches, skip to tier 3 (semantic search).

### Tier 3: drill into pages

For each candidate page from tier 2:

```
mcp__obsidian-router__get_file({ vault, path: "wiki/<folder>/<page>.md" })
```

Read in parallel (one tool call per page, all in the same turn).

If the answers are sufficient: synthesize, cite each page used as `[[<page>]]`, return.

If still insufficient → tier 4.

### Tier 4 (deep mode only): semantic search

```
mcp__obsidian-router__search_smart({ vault, query: "<question>", limit: 8 })
```

For each result above score 0.55 that you haven't already read, fetch the page and incorporate. Bridge plugin must be active in the vault for this to work — if you get a 503 with a "missing bridge" hint, fall back to standard `mcp__obsidian-router__search` (keyword search) with `vault: <name>`.

### Step 5: synthesize

Compose the answer:

- Lead with the directly-asked thing in 1-3 sentences.
- Then 1-3 short paragraphs of supporting detail, citing wiki pages inline as `[[PageName]]`.
- End with a `_Sources_` line listing the pages used.

If the wiki didn't have enough to answer:
- Say so explicitly. "The wiki has X, Y but not Z."
- Offer to ingest a source that would fill the gap.
- Don't fall back to general LLM knowledge silently — that defeats the wiki's purpose.

### Step 6 (deep mode only): file the answer back

If the user is in deep mode AND the synthesized answer is non-trivial:

1. Write a new page at `wiki/answers/<slugified-question>.md` (or `wiki/<topic>/<slug>.md` if there's an obvious topical home), with frontmatter:
   ```yaml
   ---
   type: answer
   question: "<original question>"
   answered_at: <ISO>
   sources: [<wikilinks>]
   ---
   ```
2. Body: the synthesized answer.
3. Append to `wiki/index.md` and `wiki/log.md`.
4. Tell the user: "Filed this answer at `wiki/answers/<slug>.md` — future queries on this topic will hit it first."

## Anti-patterns

- Don't read all 4 tiers when tier 1 or 2 sufficed. The whole point is cheap-first.
- Don't pretend the wiki has more than it does. Always cite, and admit gaps.
- Don't use semantic search before checking the index — the index is faster and the user probably named pages on purpose.
- Don't fall back to general knowledge silently. If the wiki lacks coverage, say so and offer to ingest.
- Don't file every answer back. Only do tier-6 in deep mode and only when the answer adds knowledge to the wiki (not when it's a trivial lookup).

## Output format

For a standard query:

> **Short answer** (1-3 sentences).
>
> **Detail.** Paragraph(s) with `[[wikilinks]]` to the pages used.
>
> _Sources: [[Page A]], [[Page B]]_

For a deep query that filed back:

> **Short answer.** ...
>
> **Detail.** ...
>
> _Sources: [[Page A]], [[Page B]]_  
> _Filed answer at `wiki/answers/<slug>.md`._
