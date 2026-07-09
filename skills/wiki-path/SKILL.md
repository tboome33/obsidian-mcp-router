---
name: wiki-path
description: Find the shortest chain of links between TWO wiki pages ("how are A and B connected?"). Use when the user says "how is X connected to Y", "what's the path between X and Y", "how do X and Y relate", "shortest path from X to Y", "/wiki-path", "quel rapport entre X et Y", "comment relie-t-on X à Y", "chemin entre X et Y", or wants to understand the link between two specific pages. Do NOT use for one page's neighbourhood — that's `wiki-neighbors`; do NOT use for a full synthesized answer — that's `wiki-query`.
argument-hint: "<from> <to> [--concepts]"
---

# wiki-path

Find the shortest chain of links between **two named pages**, read directly from the persisted knowledge graph — "the brain's GPS". Deterministic graph lookup, no LLM synthesis. Reference: [[page-neighbors-roadmap]] item W-B.

## Pre-condition

The knowledge graph must exist: `wiki-meta/graph/knowledge-graph.json`. If the tool call fails with "No knowledge graph at ...", offer to run `/wiki-graph` first, then retry.

## Steps

### 1. Parse the request

- `from`, `to` (both required) — page names, unique path suffixes, or exact vault-relative paths.
- `maxDepth` (optional, default 6, cap 20) — only raise this if the user explicitly asks for a deeper search; the default is generous for most vaults.
- `nodeTypes` — default `["article"]` (path runs through pages only). If the user's phrasing suggests they want "how are these related through a shared idea" (e.g. two pages with no obvious direct link but a common theme), pass `nodeTypes: ["article", "entity", "topic"]` to allow bridging through a shared concept or index topic — but only after a default-mode search comes back empty, or if the user explicitly asks for "concept" / "topic" bridging up front.

### 2. Call the tool

```
mcp__obsidian-router__wiki_path({ vault, from, to, maxDepth?, nodeTypes?, edgeTypes? })
```

### 3. Handle the outcomes

- **Graph missing** → offer `/wiki-graph`, then retry.
- **Ambiguous `from`/`to`** (error lists candidates) → show the candidates, ask the user to pick.
- **Endpoint not found** → say so plainly; suggest checking the name or searching the wiki for it.
- **`found: false` (`path: null`)** — this is a **legitimate answer, not an error**. Say the two pages aren't connected (within `maxDepth` hops via the requested edge/node types). If you searched in default mode (`nodeTypes: ["article"]`), offer to retry with the shared-concept bridge (`nodeTypes: ["article","entity","topic"]`) before concluding there's truly no relationship.

### 4. Present the result

Render the path as an arrow chain of `[[wikilinks]]` (by name), in order from `from` to `to`:

> [[Project — obsidian-mcp-router]] → [[Crawl4AI]] → [[license-audit]]

Mention the hop count (`length`). If the path passes through a non-`article` node (an entity/topic — the shared-concept bridge case), call that out explicitly so the user understands *why* the two pages are linked (e.g. "connected via the shared concept **OAuth**").

## When NOT to use

- Exploring **one** page's connections broadly (not to a specific second page) → `/wiki-neighbors`.
- A synthesized, cited answer to a broader question → `/wiki-query`.
- The graph doesn't exist yet → run `/wiki-graph` first.

## Anti-patterns

- Don't treat "no path found" as a failure to report apologetically — two pages can legitimately be unrelated; state it plainly.
- Don't silently widen `nodeTypes` to bridge via a shared concept without telling the user you did, and why the intermediate node isn't a page.
- Don't pick a candidate for the user on an ambiguous `from`/`to` — surface the list and let them choose.
- Don't confuse this with `wiki-neighbors` — direction doesn't matter here (traversal is undirected); it does over there.

## Quirks

- Traversal is **undirected** — a link read either way still counts as a connection (contrast `wiki-neighbors`, where forward/backward matter).
- `from === to` returns the trivial one-page path (length 0) — not an error.
- `graphAnalyzedAt` in the response indicates graph freshness — flag it if it looks stale relative to recent vault activity.
