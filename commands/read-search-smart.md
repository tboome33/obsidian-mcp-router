---
description: Semantic search via Smart Connections embeddings — ranked chunks with cosine scores and breadcrumbs. Use when the query is conceptual (meaning, not literal substring). (Skill `read-search-smart` handles natural-language triggers + pre-req check.)
---

Invoke the `read-search-smart` skill.

Required: `query`. Optional: `vault` (default or `*` for fan-out), `folders`, `excludeFolders`, `limit` (default 10).

Requires the `obsidian-mcp-router-bridge` and `smart-connections` plugins on the target vault.
