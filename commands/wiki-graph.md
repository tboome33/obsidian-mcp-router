---
description: Build a typed knowledge graph (Understand-Anything-compatible knowledge-graph.json) from a vault's wiki — articles/entities/claims/sources/topics + relationships — written to wiki-meta/graph/ + a .understand-anything/ copy for the UA dashboard. Deterministic, no LLM. (Skill `wiki-graph` handles natural-language triggers.)
---

Invoke the `wiki-graph` skill on the target vault.

Default behaviour:
- Calls the `build_wiki_graph` MCP tool: enumerates `wiki/**` content pages + `wiki-meta/digests/**`, reads `.wikiignore` + `wiki-meta/index.md`, assembles a typed graph (UA schema verbatim), validates it, and writes **two** files:
  - `wiki-meta/graph/knowledge-graph.json` (canonical source of truth)
  - `.understand-anything/knowledge-graph.json` (derived copy read by Understand-Anything's `/understand-dashboard`)
- **Deterministic — no LLM.** Maps digest concepts/claims → entity/claim nodes, wikilinks → related edges, referenced sources (frontmatter `sources:`/`^[citations]`/`![[embeds]]`) → source nodes + cites edges, index.md sections → topics + layers.

Options:
- `--dry-run` → build + validate + report counts WITHOUT writing.
- `--no-ua-copy` → skip the `.understand-anything/` copy (canonical only).

Key invariant: a file a page *references* becomes a `source` node **even if it's in `.wikiignore`** — exclusion means "not content", not "invisible".

Viewing: install Understand-Anything (`Lum1104/Understand-Anything`) and run `/understand-dashboard <vault-path>` — it reads the derived copy directly. (A native in-Obsidian viewer is roadmap #2b.)

The LLM enrichment (builds_on/contradicts discovery, auto-generating missing digests) and Louvain community detection are roadmap follow-ons — see [understand-anything-roadmap](http://127.0.0.1:27142/open/wiki%2FDivers%2FUnderstand-Anything%2Funderstand-anything-roadmap.md) #1.
