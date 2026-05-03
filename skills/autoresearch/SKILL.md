---
name: autoresearch
description: Run an autonomous research loop on a topic. Reads the user's `program.md` if present (objectives + constraints), then iterates web-search → fetch → synthesize → file as wiki pages until depth is reached. Each iteration narrows the gap between what's known (in the wiki) and what's still missing. Use when the user says "research X", "deep dive into X", "investigate X", "find everything about X", "/autoresearch", "build a wiki on X", "go research", or expresses intent for autonomous web-fed knowledge accumulation.
---

# autoresearch

Driven by an explicit research program (`program.md`) so the loop has clear exit criteria. Without a program, it spirals or stops too early.

## Pre-conditions

1. Target vault has `wiki/` scaffolding.
2. WebSearch and WebFetch tools are available (Claude Code provides these).
3. Vault is online.

## Steps

### 1. Get or create the research program

Look for `wiki/programs/<topic-slug>.md`:

```
mcp__obsidian-router__get_file({ vault, path: "wiki/programs/<slug>.md" })
```

If absent → write one based on the user's request, with this structure:

```yaml
---
type: program
topic: "<user-given topic>"
started_at: <ISO>
max_iterations: 5
status: in-progress
---

## Objectives

- <bullet 1>
- <bullet 2>
- <bullet 3>

## Constraints

- <e.g., focus on academic sources, exclude reddit, time-bound to 2020-2026>

## Open Questions

- <q1>
- <q2>

## Filed Sources

(updated by the loop)

## Closed Questions

(moved here when answered, with a wikilink to the synthesizing page)
```

Show the program to the user and ask "looks right? proceed?". Don't run autonomously without confirmation — autoresearch can burn through a lot of tokens.

### 2. The loop

For each iteration (up to `max_iterations`):

#### 2a. Pick the most underspecified open question

Read `program.md`, look at `## Open Questions`. Pick the question least covered by existing wiki pages.

How to gauge coverage: run `mcp__obsidian-router__search_smart({ vault, query: "<question>", limit: 5 })`. If top result has score > 0.65, the wiki has decent coverage — pick a different question or stop.

#### 2b. Search the web

Use WebSearch with a focused query derived from the open question. Don't search broadly ("X") — search specifically for what's missing.

Pick 2-4 most promising results. Score by: source authority (academic > blog > forum), recency (depending on topic), specificity to the question.

#### 2c. Fetch and clean

For each picked result, use `WebFetch` (or invoke the `defuddle` skill first if the page is a noisy webpage). Don't fetch all 4 — fetch in serial, skip if the title shows it's not relevant after fetching the metadata.

#### 2d. File via wiki-ingest

For each useful fetch, invoke the `wiki-ingest` skill (in-process — same conversation, you already know how). It will:
- File the source
- Create/update entity pages
- Update index, log, hot

#### 2e. Update the program

After ingestion, update `program.md`:
- Add filed sources to `## Filed Sources` (with wikilinks)
- If an open question was answered: move it to `## Closed Questions` with the wikilink to the synthesizing page
- Maybe ADD new open questions surfaced by the new sources (the wiki grows organically — this is the point)

#### 2f. Stop conditions

Halt the loop when:
- All `## Open Questions` are closed → success
- `max_iterations` reached → emit "depth limit, here's where we got" report
- The web is returning nothing new (seen this domain before, all sources already filed) → diminishing returns, halt
- A fetch fails repeatedly → bail with diagnostics

### 3. Final report

Compose a short summary turn:
- N sources filed
- M open questions closed
- K open questions remaining (with reasons)
- Path to `program.md` so the user can re-run later or curate

Mark `program.md` `status: completed` (or `paused` if iterations exhausted).

## Anti-patterns

- Don't autoresearch without a program. Open-ended research with an LLM is a recipe for context-burn.
- Don't fetch every search result. Be selective — usually 2-3 of 8 are worth reading.
- Don't summarize the same source from multiple search results. Dedupe by URL before fetching.
- Don't paste full source text into wiki pages. The wiki-ingest skill handles synthesis; respect it.
- Don't skip user confirmation before running. The loop costs real tokens.

## Output format

While running, emit terse progress lines (one per iteration):

```
[1/5] Question: How does X work?
      → Searched: "X mechanism", picked 3/8 results
      → Fetched: <URL1>, <URL2>, <URL3>
      → Filed: [[concepts/X]] (new), [[entities/Y]] (updated), [[sources/Smith2024]]
      → Closed question: ✓
```

Final summary:

```
✅ Autoresearch complete on `<topic>`.
   Iterations used: 4/5
   Sources filed: 11
   Questions closed: 5/5
   Open questions remaining: 0
   Program: wiki/programs/<slug>.md
```
