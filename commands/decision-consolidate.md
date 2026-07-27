---
description: Consolidate a SETTLED decision page — compress the body to canon (verdict byte-intact, alternatives as a table) and move the deliberation chronicle to a verified `archives/` note excluded from recall and search. Never on a `proposed` page; never erases the why. (Skill `decision-consolidate` carries the full transactional procedure.)
---

Invoke the `decision-consolidate` skill.

Arguments: a decision page path or basename (required) · a vault name (defaults to the current/locked/default vault) · `--dry-run` (show what stays / what moves, write nothing).

The skill handles:
- Eligibility gate: `accepted` / `superseded` / `rejected` only — a `proposed` page is refused (its deliberation is the working material)
- Archive-first transaction: `<folder>/archives/<slug>-deliberation.md` (`type: decision-archive`) written and VERIFIED before the page is touched
- Canonical compact rewrite: verdict byte-intact, minimal why, alternatives table, `consolidated:` marker, mandatory `## Historique` wikilink to the archive
- Post-check: decision lint green (no `consolidated-*` findings) + thin `log.md` trace
