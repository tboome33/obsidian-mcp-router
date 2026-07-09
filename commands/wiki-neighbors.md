---
description: Show the neighbours of ONE wiki page from the knowledge graph — pages it links to (forward), pages that link to it (backward/backlinks), or both, at a configurable hop depth. Deterministic, no LLM. (Skill `wiki-neighbors` handles natural-language triggers.)
---

Invoke the `wiki-neighbors` skill on the target page.

Default behaviour:
- Pre-req: the knowledge graph `wiki-meta/graph/knowledge-graph.json` must exist (run `/wiki-graph` first if not).
- Calls the read-only `get_page_neighbors` MCP tool: resolves the page (exact path, bare name, or unique suffix — an ambiguous name is refused with the candidate list, never silently guessed), then returns its neighbours by `direction` and `depth`.
- **Pages only by default** (`nodeTypes: ["article"]`) — the graph's `related` edges also connect a page to the concepts/claims it mentions; widen `nodeTypes` (e.g. `["entity"]`) to surface those instead.
- Results are capped (`maxNeighbors`, default 50) with a `truncated` flag when trimmed.

Arguments:
- `<page>` (required) — page name, unique path suffix, or exact vault-relative path.
- `[direction]` — `forward` (what it links to), `backward` (what links to it / backlinks), or `both` (default).
- `[depth]` — hop radius, default 1, capped at 4.

See [page-neighbors-roadmap](http://127.0.0.1:27163/open/wiki%2Fobsidian-mcp-router%2Fpage-neighbors-roadmap.md) item W-A.
