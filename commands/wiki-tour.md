---
description: Generate a guided, pedagogical reading tour through a vault (or one of its sections/topics) — an ordered walkthrough computed from the knowledge graph's link topology, output as a standalone markdown page + the graph's tour[] field. Deterministic ordering, LLM narrative. (Skill `wiki-tour` handles natural-language triggers.)
---

Invoke the `wiki-tour` skill on the target vault.

Default behaviour:
- Pre-req: the knowledge graph `wiki-meta/graph/knowledge-graph.json` must exist (run `/wiki-graph` first if not).
- Calls the read-only `build_wiki_tour` MCP tool → a **deterministic ordered step skeleton** from the graph's link topology (fan-in/backlinks for importance, entry points boosted for index/MOC names, one step per index.md section). Then Claude writes the **pedagogical narrative** (the *why* of each step).
- Output **both**: a standalone markdown tour page in `wiki-meta/tours/` (readable in Obsidian now, nodes linked as `[[wikilinks]]`) + the graph's `tour[]` field (for the future dashboard / native viewer #2b).

Options:
- `[scope]` → tour one section/topic (by index.md heading) or a path substring — ideal for a multi-project vault (e.g. `/wiki-tour Dedibox`). Omit for a whole-vault tour. A scoped tour writes only the markdown (doesn't overwrite the full-graph `tour[]`).

5-15 steps, each highlighting 1-5 nodes. Deterministic order (overview → topics by importance); only the narrative varies. See [understand-anything-roadmap](http://127.0.0.1:27142/open/wiki%2FDivers%2FUnderstand-Anything%2Funderstand-anything-roadmap.md) #3.
