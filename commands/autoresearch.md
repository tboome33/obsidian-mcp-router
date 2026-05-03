---
description: |
  Run an autonomous WEB-fed research loop on a topic — driven by an explicit research program (objectives, constraints, open questions). Iterates web-search → fetch → defuddle → synthesize → file as wiki pages, until depth is reached or all questions are closed. Always asks for confirmation before starting (the loop costs real tokens).

  EN triggers: "research X on the web", "go research X online", "deep dive online into X", "find new info on the web about X", "build a wiki on X from web sources", "investigate X online".
  FR triggers : "fais une recherche web sur X", "va chercher sur X en ligne", "deep dive en ligne sur X", "trouve de nouvelles infos en ligne sur X", "construis un wiki sur X depuis le web", "investigue X en ligne".

  Example / Exemple:
    EN: "go research transformer architectures and build a wiki on them"
    FR: "fais une recherche web sur les architectures transformers et construis-moi un wiki"

  Disambiguation: "research X" alone is ambiguous between this skill (web-fed) and `wiki-query` (existing wiki, no web). When unclear, ask the user which they want before running.
---

Invoke the `autoresearch` skill.

Required: a topic or research goal. The skill will create or load `wiki/programs/<topic-slug>.md` (the research program) and show it to the user before running.

Loop bounded by `max_iterations` (default 5) to prevent runaway. Each iteration:
1. Pick the most underspecified open question (lowest `search_smart` coverage).
2. Web search for that specific question.
3. Defuddle and fetch top 2-3 results.
4. Hand off to `wiki-ingest` to file each useful source.
5. Update `program.md` (move closed questions, add filed sources, maybe add new questions).

Stop conditions:
- All open questions closed
- max_iterations reached
- Diminishing returns (no new domains in search results)

Final output: report with sources filed, questions closed/remaining, link to `program.md`.
