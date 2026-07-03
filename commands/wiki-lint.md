---
description: Health-check the wiki — orphans, dead wikilinks, index drift, frontmatter gaps. Read-only by default with optional auto-fix. (Skill `wiki-lint` handles natural-language triggers.)
---

Invoke the `wiki-lint` skill on the target vault.

Modes: default (structural checks A-H) · `--deep` (digest-based checks I-L) · `--okf <path>` (Check M: validate an OKF knowledge bundle — dedicated command: `/obsidian-router:okf-check`).

Default behavior:
- Read-only: produce the diagnostic report, no mutations.
- After the report, ask once: "fix the N errors?" — if yes, walk through each ERROR-level finding interactively.
- Never auto-fix WARNINGS (orphans, missing index entries) — those might be intentional.
- Append a log entry **only** when the user accepted at least one ERROR-level auto-fix. Pure dry-runs leave the wiki untouched (read-only contract).

Output format: severity-grouped tables with paths, descriptions, and proposed fixes. End with the lint summary line.
