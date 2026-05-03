---
description: |
  Answer a question grounded in the EXISTING wiki vault — no web fetching. Three-tier retrieval (hot.md → index.md → drill into pages), with semantic search fallback in deep mode. Optionally files good answers back as wiki pages. Use when the user wants the wiki's view, not the model's general knowledge.

  EN triggers: "what do you know about X (from my wiki)", "based on my notes, ...", "explain X using my wiki", "search my wiki for X", "what does my wiki say about X".
  FR triggers : "que dit mon wiki sur X", "d'après mes notes, ...", "explique X à partir de mon wiki", "cherche dans mon wiki sur X", "qu'est-ce que mon wiki dit sur X".

  Example / Exemple:
    EN: "based on my notes, what's my approach to position sizing?"
    FR: "d'après mes notes, c'est quoi mon approche pour la taille de position ?"

  Disambiguation: "research X" alone is ambiguous between this skill (deep wiki query, no web) and `autoresearch` (web-fed). When unclear, ask the user which they want.
---

Invoke the `wiki-query` skill on the user's question.

Mode inference (override with explicit `mode=quick|standard|deep`):
- Short factual question → quick (hot.md only, bail to standard if absent)
- "Explain X" → standard (hot → index → 1-3 pages)
- "Everything about X (from my wiki)" / "give me my wiki's full picture on X" → deep (also semantic search via `mcp__obsidian-router__search_smart`, file the answer back)

If the user says "research X" without qualifying it: that's ambiguous between this skill (deep wiki query, no web) and `autoresearch` (web-fed). Ask which they mean before running.

Always cite wiki pages used as `[[wikilinks]]`. If the wiki lacks coverage, say so explicitly and offer to ingest a source — never silently fall back to general knowledge.
