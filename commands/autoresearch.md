---
description: Run an autonomous web-fed research loop on a topic — iterates web-search → defuddle → wiki-ingest until questions close. (Skill `autoresearch` handles natural-language triggers.)
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
