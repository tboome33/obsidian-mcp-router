---
description: Find the shortest chain of links between TWO wiki pages ("how are A and B connected?") from the knowledge graph. Undirected traversal, explicit null path when unconnected (not an error). Deterministic, no LLM. (Skill `wiki-path` handles natural-language triggers.)
---

Invoke the `wiki-path` skill between the two given pages.

Default behaviour:
- Pre-req: the knowledge graph `wiki-meta/graph/knowledge-graph.json` must exist (run `/wiki-graph` first if not).
- Calls the read-only `wiki_path` MCP tool: resolves both endpoints (same rules as `wiki-neighbors` — an ambiguous name is refused with candidates), then finds the shortest **undirected** chain of links between them.
- If the two pages aren't connected, the tool returns `found: false` / `path: null` — a legitimate answer, not an error.

Arguments:
- `<from> <to>` (required) — page names, unique path suffixes, or exact vault-relative paths.
- `[--concepts]` — widen the path to also bridge through shared concepts/topics (`nodeTypes: ["article","entity","topic"]`) instead of pages only — useful when two pages have no direct link but share an underlying idea.

See [page-neighbors-roadmap](http://127.0.0.1:27163/open/wiki%2Fobsidian-mcp-router%2Fpage-neighbors-roadmap.md) item W-B.
