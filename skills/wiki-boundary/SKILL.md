---
name: wiki-boundary
description: Rank the "frontier" pages of a wiki — the crossroads many pages link to that stay thin inside — so you can decide where research would pay off most. Use when the user says "what should I write about next", "where are the gaps", "which pages need work", "find the thin hub pages", "boundary pages", "/wiki-boundary", "sur quoi devrais-je travailler", "où sont les trous du wiki", "quelles pages sont maigres". Do NOT use to find pages nobody links to — those are orphans, `wiki-lint` Check A. Do NOT use to answer a question from the wiki — that's `wiki-query`.
argument-hint: "[--limit N] [--all-types] [--min-inbound N] [--as-of YYYY-MM-DD]"
---

# wiki-boundary

Deterministic ranking of the pages everybody links to that have little in them. Borrowing **C10** of [[roadmap-emprunts]] §2.17. Read-only, no LLM: one query over the persisted knowledge graph.

> **The score proposes attention. It does not establish importance.**
> A high score says exactly one thing: *many pages point here, and there is not much here when you arrive.* That is a reason to look, never a verdict on the page, its author, or its priority. Say this out loud when you present results — it is the whole contract.

## Pre-condition

The knowledge graph must exist AND be recent enough to carry substance measurements: `wiki-meta/graph/knowledge-graph.json`. If the tool refuses with *"no substance measurements"*, the graph predates this feature — offer to run `/wiki-graph`, then retry.

**Always look at `graphAnalyzedAt` in the result.** The graph is a snapshot. A month-old graph ranks pages that may have been rewritten, moved or deleted since. If it is more than a couple of weeks old, say so before presenting the list, and offer to rebuild.

## Steps

### 1. Call the tool

```
mcp__obsidian-router__find_boundary_pages({ vault, limit: 10 })
```

Arguments, all optional:
- `--limit N` → `limit` (default 10, ceiling 100).
- `--min-inbound N` → `minInbound` (default 1). Raise it on a big vault to keep only real crossroads.
- `--all-types` → `exemptTypes: []`, scoring every page including the ones held out by default. Use only when the user explicitly asks to see everything; warn them that migration stubs and capture records will dominate.
- `--as-of YYYY-MM-DD` → `asOf`. By default recency is measured against the graph's own build stamp, which makes the ranking a pure function of the graph file.

### 2. Read the numbers before presenting them

The result carries everything needed to audit itself:

| Field | What it tells you |
|---|---|
| `pages[]` | the ranking: `score`, `linkPressure`, `recencyMultiplier`, `inbound`, `substanceWords`, `ageDays` |
| `measure` | the formula and its three constants, verbatim |
| `exempted` | how many pages were held out, and of which types — **never present a ranking without mentioning this** |
| `excluded` | pages with no substance measurement, and pages below `minInbound` |
| `withoutRecency` | pages with no usable age — `updated:` missing or unparseable, **or** the graph carrying no reference date at all. Scored ×1 rather than assumed stale |
| `ranked` vs `limit` | how much of the list you are showing |

### 3. Present it honestly

Render a short table — path, score, inbound, words, age — then **three sentences of interpretation, not more**. Good interpretation names the specific reason a page might deserve work ("11 pages point at `graphify`, it holds 719 words, and nobody has touched it in 77 days"). Bad interpretation restates the score.

Then say what the list cannot tell you, in plain words:

- **Index and hub pages will legitimately appear near the top.** A page whose job is to point elsewhere is thin by design, and the score cannot tell that from a page that is thin by neglect. Expect to dismiss one or two at a glance — that is the tool working as intended, not failing.
- **A thin page is very often fine.** A definition, a deliberate index, a disambiguation page. Read before acting.
- **Low scores across the board mean the vault is in good shape.** Say so rather than manufacturing urgency from the top of a flat list.

### 4. Offer the next step, don't take it

If a page genuinely looks under-served, the natural follow-up is `/autoresearch` **to open a research programme on that page's topic** — see the wiring note below. Propose it; never launch it. Autoresearch costs real tokens and needs its own confirmation.

## How this relates to autoresearch

`/autoresearch` already picks its own questions: it reads `## Open Questions` from a programme and takes the least-covered one, gauged with `search_smart`. **This skill does not replace that and must not be wired into it.** It sits one storey UP: autoresearch chooses *which question inside a programme*, this chooses *which page deserves a programme at all*. Feeding boundary scores into the question picker would break a mechanism that works.

## How this relates to wiki-lint

`wiki-lint` reports boundary pages as an **info** section, never a warning. A crossroads that is thin is not a defect — nothing is broken, nothing needs fixing, and the lint report must not imply otherwise.

Note that the two count inbound links differently and that this is deliberate: lint Check A re-parses every page (and so sees wikilinks written in **frontmatter**), while this skill uses the graph (which parses page bodies only). The graph's set is a strict subset, so a page credited with inbound links here can never be called an orphan there — the two never contradict.

## Anti-patterns

- **Don't present the score as a priority list.** It proposes attention; the human decides importance.
- **Don't hide the exemptions.** A ranking that silently dropped 31 pages reads as "I looked at everything" when it did not.
- **Don't rank a stale graph without saying so.** Check `graphAnalyzedAt` first.
- **Don't rewrite a page because it scored high.** Read it. Thin is frequently correct.
- **Don't chain into `/autoresearch` automatically.**

## Output format

```
🧭 Frontier pages — vault `<name>` — graph built <date>

| # | Page | Score | Inbound | Words | Age |
|---|---|---|---|---|---|
| 1 | wiki/…/graphify.md | 1.63 | 11 | 719 | 77d |
| 2 | … | | | | |

Held out: 31 pages (29 redirect, 2 source) — thin by design.
Ranked 103 of 140 articles; 6 have no inbound links (orphans are Check A's subject).

Score = inbound links damped by length (`inbound / (1 + words/100)`: full weight on an empty page, halved at 100 words, a tenth at 900), ×1 to ×2 for staleness.
It proposes attention, not importance.
```
