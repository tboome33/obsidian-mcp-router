---
description: |
  Health-check the wiki — finds orphan pages, dead wikilinks, index drift, frontmatter gaps, empty sections, and stale hot cache. Reports by severity (error/warning/info) with proposed fixes. Read-only by default; offers interactive auto-fix for ERROR-level findings only with explicit confirmation.

  EN triggers: "lint the wiki", "health check my wiki", "audit my wiki", "find orphan pages", "what's broken in my wiki", "clean up the wiki".
  FR triggers : "lint le wiki", "vérifie la santé du wiki", "audit mon wiki", "trouve les pages orphelines", "qu'est-ce qui cloche dans mon wiki", "fais le ménage dans le wiki".

  Example / Exemple:
    EN: "lint my Recherche wiki and show me dead links"
    FR: "lint mon wiki Recherche et montre les liens morts"
---

Invoke the `wiki-lint` skill on the target vault.

Default behavior:
- Read-only: produce the diagnostic report, no mutations.
- After the report, ask once: "fix the N errors?" — if yes, walk through each ERROR-level finding interactively.
- Never auto-fix WARNINGS (orphans, missing index entries) — those might be intentional.
- Append a log entry **only** when the user accepted at least one ERROR-level auto-fix. Pure dry-runs leave the wiki untouched (read-only contract).

Output format: severity-grouped tables with paths, descriptions, and proposed fixes. End with the lint summary line.
