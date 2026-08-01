---
description: Build or refresh a vault's LOCAL BM25 search index (wiki-meta/search-index.json) — a deterministic, plugin-free search tier that works on every vault, including those without Smart Connections. Idempotent (fingerprint check → no rewrite). (Skill `build-search-index` handles natural-language triggers.)
---

Invoke the `build-search-index` skill on the target vault.

Default behaviour:
- Calls the `build_search_index` MCP tool: walks `wiki/` (excluding the generated OKF projections and all of `wiki-meta/`), chunks every page, prefixes each chunk with its **context header** (page title · frontmatter `description` · heading path), and writes `wiki-meta/search-index.json`.
- **Deterministic — no LLM, no network, no plugin.** Same vault ⇒ same index ⇒ same ranking.
- **Idempotent**: the index carries a content fingerprint of the corpus; an unchanged vault is detected and the write is skipped (`upToDate: true, written: false` — that is success).

Options:
- `--check` → report whether the stored index is `absent` / `stale` / `current` WITHOUT writing.

Why it exists: most of the fleet has no Smart Connections, so `search_smart`'s semantic tier cannot serve it. Once this index exists, `search_smart` falls back to it automatically (labelled, never blended with semantic scores) and `tier: "local"` can request it outright.

Fail-closed by design: if any page fails to read, or the enumeration is truncated, the build **refuses** rather than producing an index that silently omits content.

Surface `warnings` verbatim — an **EMPTY** (0-chunk) index means nothing indexable was found (wrong vault layout), not a successful build.
