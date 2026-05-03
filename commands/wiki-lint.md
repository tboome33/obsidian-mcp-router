---
description: Health-check the wiki — finds orphan pages, dead wikilinks, index drift, frontmatter gaps, empty sections, and stale hot cache. Reports by severity (error/warning/info) with proposed fixes. Read-only by default; offers interactive auto-fix for ERROR-level findings only with explicit confirmation.
---

Invoke the `wiki-lint` skill on the target vault.

Default behavior:
- Read-only: produce the diagnostic report, no mutations.
- After the report, ask once: "fix the N errors?" — if yes, walk through each ERROR-level finding interactively.
- Never auto-fix WARNINGS (orphans, missing index entries) — those might be intentional.
- Always append a log entry summarizing the lint pass.

Output format: severity-grouped tables with paths, descriptions, and proposed fixes. End with the lint summary line.
