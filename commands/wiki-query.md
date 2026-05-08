---
description: Answer a question grounded in the EXISTING wiki vault (no web fetching) — three-tier retrieval with optional semantic search. (Skill `wiki-query` handles natural-language triggers.)
---

Invoke the `wiki-query` skill on the user's question.

Mode inference (override with explicit `mode=quick|standard|deep`):
- Short factual question → quick (hot.md only, bail to standard if absent)
- "Explain X" → standard (hot → index → 1-3 pages)
- "Everything about X (from my wiki)" / "give me my wiki's full picture on X" → deep (also semantic search via `mcp__obsidian-router__search_smart`, file the answer back)

If the user says "research X" without qualifying it: that's ambiguous between this skill (deep wiki query, no web) and `autoresearch` (web-fed). Ask which they mean before running.

Always cite wiki pages used as `[[wikilinks]]`. If the wiki lacks coverage, say so explicitly and offer to ingest a source — never silently fall back to general knowledge.
