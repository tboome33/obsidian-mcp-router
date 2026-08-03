---
description: Rank the wiki's "frontier" pages — the crossroads many pages link to that stay thin inside — to decide where research would pay off. Read-only, deterministic, no LLM. The score proposes attention, not importance. (Skill `wiki-boundary` handles natural-language triggers.)
---

Invoke the `wiki-boundary` skill.

Default behaviour:
- Pre-req: the knowledge graph `wiki-meta/graph/knowledge-graph.json` must exist AND carry substance measurements (run `/wiki-graph` first if the tool refuses).
- Calls the read-only `find_boundary_pages` MCP tool: one query over the persisted graph, no page reads, nothing written.
- Score = inbound links damped by length (`inbound / (1 + words/100)`: full weight on an empty page, halved at 100 words, a tenth at 900), multiplied ×1 → ×2 for staleness. Same graph ⇒ same ranking, always.
- Pages typed `redirect` / `source` / `answer` are held out by default (thin is their job); the count held out is always reported.
- **On a vault you have not run this on before, calibrate the exemptions first** — those defaults are one vault's vocabulary, and they are what keeps the ranking meaningful. Measured: DEDIBOX's top hit was a migration stub typed `index`, which the defaults do not catch.
- Report `graphAnalyzedAt` — a stale graph ranks pages that may no longer exist.

Arguments:
- `[--limit N]` — how many pages to show (default 10, ceiling 100).
- `[--min-inbound N]` — ignore pages with fewer inbound links (default 1).
- `[--exempt-types a,b,c]` — REPLACES the default exemption list, so pass the defaults plus your additions.
- `[--all-types]` — score every page, exemptions off. Expect migration stubs to dominate.
- `[--as-of YYYY-MM-DD]` — measure recency against this date instead of the graph's build stamp.

Always state that the score **proposes attention, it does not establish importance**, and that index/hub pages legitimately appear near the top.

See [roadmap-emprunts](http://127.0.0.1:27163/open/wiki%2FDivers%2FEmprunts%2Froadmap-emprunts.md) §2.17 item C10.
