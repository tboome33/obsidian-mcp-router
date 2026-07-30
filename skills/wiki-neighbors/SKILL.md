---
name: wiki-neighbors
description: Show the neighbours of ONE wiki page from the knowledge graph — the pages it links to, the pages that link to it (backlinks), or both, at a configurable hop depth. Use when the user says "what links to X", "who links to X", "show me the backlinks of X", "what does X link to", "neighbours of X", "what's connected to X", "/wiki-neighbors", "quelles pages sont liées à X", "qui pointe vers X", "voisins de X", "qu'est-ce que X cite", or wants to explore one page's immediate connections. Do NOT use for the path between TWO specific pages — that's `wiki-path`; do NOT use for a full synthesized answer to a question — that's `wiki-query`.
argument-hint: "<page> [direction: both|forward|backward] [depth]"
---

# wiki-neighbors

Look up the neighbourhood of **one page** directly from the persisted knowledge graph — no page-body scraping, no LLM synthesis. This is a deterministic graph lookup: give a page, get back the pages it cites (`forward`), the pages that cite it (`backward`, i.e. backlinks), or both. Reference: [[page-neighbors-roadmap]] item W-A.

## Pre-condition

The knowledge graph must exist: `wiki-meta/graph/knowledge-graph.json`. If the tool call fails with "No knowledge graph at ...", tell the user and offer to run `/wiki-graph` first (or run it yourself if they confirm), then retry.

## Steps

### 1. Parse the request

- `page` (required) — a page name, a unique path suffix, or the exact vault-relative path. If the user only names a topic loosely ("what links to the OAuth page"), use their best guess as `page`; the tool's own resolver will refuse with candidates if it's ambiguous (see step 3).
- `direction` (optional, default `both`) — infer from phrasing: "what links TO X" / "backlinks of X" → `backward`; "what does X link to" / "what X cites" → `forward`; "neighbours of X" / "what's connected to X" → `both`.
- `depth` (optional, default 1) — "direct neighbours" → 1; "neighbours of neighbours" / "2 hops" → 2. Cap at 4 — if the user asks for more, tell them 4 is the ceiling and explain why (graph fan-out grows fast).
- `nodeTypes` (optional, default `["article"]`) — pages only by default. If the user asks "what concepts does X mention" or "what does X cite as a source", pass `nodeTypes: ["entity"]` or `["source"]` instead/in addition.

### 2. Call the tool

```
mcp__obsidian-router__get_page_neighbors({ vault, page, direction, depth, nodeTypes?, edgeTypes?, maxNeighbors? })
```

### 3. Handle the three special cases

- **Graph missing** (error mentions `build_wiki_graph`) → offer to run `/wiki-graph`, then retry the lookup.
- **Ambiguous page** (error says "is ambiguous" + lists candidate paths) → show the candidates to the user and ask them to pick one (or re-run with the exact path).
- **Page not found** → say so plainly; suggest checking `wiki-meta/catalog.md` for the right name, or offer a `search`/`search_smart` to locate it.

### 4. Present the result

Group by direction if `both` was used (the response doesn't separate them — you compute that from `viaEdgeType`/whichever hop set you asked for, or just present the flat list if direction was already narrowed). Use `[[wikilinks]]` (by page name) so the user can click through in Obsidian. For each neighbour, the hop distance and node type are useful context — surface them when depth > 1 or when `nodeTypes` was widened.

If `truncated: true`, say so explicitly ("showing the closest 50 of 214 neighbours — narrow with `direction` or ask for a specific `nodeTypes`") — never present a truncated list as if it were complete.

Example shape (adapt to what's actually returned — don't invent neighbours):

> **[[Crawl4AI]]** — 2 pages link to it (backlinks):
> - [[Crawl4AI-roadmap]]
> - [[roadmap-emprunts]]

## When NOT to use

- The relationship between **two named** pages ("how are A and B connected") → `/wiki-path`.
- A synthesized, cited answer to a broader question → `/wiki-query`.
- Exploring a whole vault/section as a reading path → `/wiki-tour`.
- The graph doesn't exist yet → run `/wiki-graph` first.

## Anti-patterns

- Don't silently widen `nodeTypes` beyond `["article"]` without telling the user — they asked about pages; concepts/sources showing up unannounced is confusing.
- Don't re-fetch each neighbour's full page body just to answer this — the graph lookup already has name/path/type; only fetch a page if the user asks to read it.
- Don't present a `truncated` list as exhaustive.
- Don't pick a candidate for the user on an ambiguous name — surface the list and let them choose (the tool deliberately refuses to guess).

## Quirks

- `direction` matters here (unlike `wiki-path`, which is undirected) — `forward` and `backward` can return different sets.
- Default `nodeTypes: ["article"]` — the graph's `related` edges also connect a page to concepts/claims it mentions; widen `nodeTypes` on purpose to see those.
- `depth` capped at 4, `maxNeighbors` capped at 200 (default 50, flagged via `truncated`).
- `graphAnalyzedAt` in the response tells you how stale the graph might be — if it looks old and the vault has since changed a lot, suggest re-running `/wiki-graph`.
