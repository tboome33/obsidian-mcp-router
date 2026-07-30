---
name: wiki-tour
description: Generate a guided, pedagogical reading tour through a vault — an ordered walkthrough that takes a newcomer from "what is this?" to "I get how it fits together", computed from the knowledge graph's link topology. Use when the user says "give me a tour of this vault", "where do I start", "walk me through my notes", "onboarding path", "/wiki-tour", "fais-moi visiter le vault", "parcours guidé", "par où commencer", or wants a learning path through a vault or one of its projects/topics.
argument-hint: "[scope] (section/topic/path — omit for whole-vault)"
---

# wiki-tour

Build a **guided tour** through a vault: an ordered sequence of steps that teaches the vault's structure in a sensible reading order, derived from the **knowledge graph's link topology** (fan-in/backlinks, entry points, catalog.md sections). Reference: [[understand-anything-roadmap]] item #3.

Same split as `/wiki-graph`: the **topology + step ordering is deterministic** (the `build_wiki_tour` tool); **you (Claude) write the pedagogical narrative** — the *why* of each step.

## Pre-condition

The knowledge graph must exist: `wiki-meta/graph/knowledge-graph.json`. If it doesn't, run `/wiki-graph` first (the tool will tell you). Richer tours come from a richer graph — suggest `/wiki-refresh-digests` + `/wiki-graph` if the vault has few digests.

## Steps

### 1. Resolve scope

- No arg → whole-vault tour.
- `scope` arg → one section/topic (by catalog.md heading) or a path substring. For a multi-project vault, tour one project at a time (e.g. `/wiki-tour Dedibox`). If unsure which scopes exist, read `wiki-meta/catalog.md` section headings and offer a menu.

### 2. Compute the deterministic skeleton

```
mcp__obsidian-router__build_wiki_tour({ vault, scope?, maxSteps? })
```

Returns: ordered `steps[]` — each with `order`, a default `title`, and `nodes[]` (`{id, name, summary}`) — plus `entryPoints[]` and `totalArticles`. The skeleton is: an **overview step** (the entry points — highest fan-in, boosted for index/MOC names) then **one step per catalog.md section** (its top articles by backlink count), then a trailing "other notable pages" step for unindexed hubs.

If it warns `no-articles-in-scope` / `no-tour-steps`, tell the user the scope is empty and offer alternatives.

### 3. Write the pedagogical narrative (LLM — your job)

For each skeleton step, write:
- A **clear step title** (refine the default if needed).
- A **2-4 sentence description**: what this step covers, *why it matters*, and how it connects to the previous step — building a coherent "what is this → how it works" arc. Ground it in the `nodes[].summary` provided; don't invent.
- Follow the vault's language convention (bilingual FR+EN if the vault is bilingual — see its `CLAUDE`).
- Optionally a `languageLesson`-style aside for domain concepts, if useful.

Keep it 5-15 steps. Each step highlights 1-5 nodes (the skeleton already caps this).

### 4. Output — BOTH

1. **Standalone markdown tour page** (usable in Obsidian *today*): write to `wiki-meta/tours/<scope-or-vault>-tour.md` with frontmatter (`type: tour`, `scope`, `generated_at`) + an ordered list of steps, each linking its nodes as `[[wikilinks]]` (so the reader clicks through). This is the immediately-useful artifact.
2. **Graph `tour[]` field** (for the future dashboard / #2b viewer): read `wiki-meta/graph/knowledge-graph.json`, set its `tour` to the narrated steps (`[{order, title, description, nodeIds}]`), write it back. Keep the rest of the graph intact. *(Only when scope = whole-vault — a scoped tour shouldn't overwrite the full-graph tour; for a scoped tour, write only the markdown.)*

### 5. Confirm

Report: scope, step count, output path, and a one-line preview of the arc (step titles).

## When NOT to use

- A single page's neighbours → `get_wiki_context_pack`.
- A portable text dump → `wiki-export`.
- The graph doesn't exist yet → `/wiki-graph` first.

## Anti-patterns

- Don't invent step content — narrate from the `nodes[].summary` the tool returns.
- Don't reorder the deterministic skeleton arbitrarily — its order (overview → topics by importance) is the pedagogical spine; refine titles/descriptions, not the sequence, unless you have a clear pedagogical reason (then say why).
- Don't overwrite the whole-graph `tour[]` from a *scoped* tour.
- Don't exceed ~15 steps — a tour is a curated path, not a table of contents (that's `catalog.md`).

## Quirks

- Deterministic skeleton: same graph ⇒ same step order (only your narrative varies).
- `scope` matches a catalog.md section name, a layer id, or a path substring — first match wins.
- Entry points are boosted for names like `index`/`overview`/`MOC`/`sommaire`; otherwise highest backlink count wins.
