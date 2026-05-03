---
description: File the current Claude conversation (or a specific insight from it) as a structured wiki note with appropriate type frontmatter (session, answer, decision, ADR, technique, idea). Auto-routes to the right wiki folder, builds cross-links, and updates index/log/hot. The most-used wiki workflow — do it at the end of any substantive session.
---

Invoke the `save` skill.

Argument forms:
- `/save` alone → file the whole conversation as type `session`
- `/save <slug>` → file with explicit slug
- `/save as decision` / `/save as adr` / `/save as technique` / `/save as idea` → file with that type
- "save this answer" / "save that" → file the most recent substantive answer as type `answer`

Always:
- Distill, don't dump the raw transcript.
- Pick the right folder by type (`sessions/`, `answers/`, `decisions/`, `techniques/`, `ideas/`).
- Cross-link to existing wiki pages mentioned in the conversation, AND update those pages with backlinks.
- Update `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`.

Push back if the conversation has nothing worth saving — don't make junk pages.
