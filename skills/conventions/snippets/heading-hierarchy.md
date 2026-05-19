## Note structure — headings hierarchy (mandatory)

Every wiki page MUST have a proper heading hierarchy so the **Outline** plugin can navigate it. Without this, the Outline panel is empty and long notes become unscannable.

- **Exactly one `# H1`** at the top — matches the note's `title:` frontmatter (or a clean rephrasing of the filename). The H1 is the note's name. If the body needs to start with prose, put the `# H1` line ABOVE that prose anyway.
- **`## H2`** for main sections (Context, Decision, See also, etc.). Use these to chunk the body. In bilingual pages, the `## 🇫🇷 Version française` and `## 🇬🇧 English version` are themselves H2.
- **`### H3`** for sub-sections inside an `## H2`. Only when a section is long enough to need internal navigation.
- **Never skip levels.** No `### H3` without a `## H2` above. No `#### H4` without an `### H3`.
- **Length rule.** Any note > 200 words MUST have at least 2 `## H2` sections. Outline navigation depends on this — a wall of text with only an H1 defeats the whole point.

### Type-specific minimums

When generating content of these types, use AT LEAST these `## H2` sections (add more if the content warrants):

| Type | Required `## H2` sections |
|---|---|
| `session` | `## Prompt`, `## What happened`, `## Outcome`, optional `## See also` |
| `answer` | `## Question`, `## Answer`, optional `## See also` |
| `decision` / `adr` / `decision-input` | `## Context`, `## Decision`, `## Consequences`, optional `## Alternatives considered` |
| `technique` / `runbook` | `## Prerequisites`, `## Steps`, `## Gotchas`, optional `## See also` |
| `idea` | `## The idea`, `## Why it matters`, `## Concrete first step` |
| `fact` (standalone page > 100 words) | `## What`, `## Why it matters`, `## Source` |
| `person` | `## Context`, `## Notes`, `## Interactions` |
| `concept` | `## Definition`, `## Why it matters`, `## Related` |
| `reference` / `url` ingestion | `## Summary`, `## Key takeaways`, `## Source` |
| `project` | `## Goal`, `## Status`, `## Open questions`, optional `## Log` |
| `project-anatomy` | `## What this project does`, `## Architecture in brief`, `## Folder layout`, `## Current state`, `## Related links` |

### Anti-patterns to refuse

- Don't dump a wall of paragraphs under a single `# H1`. If the content can't be split into 2 `## H2` sections, the note is probably either too short (file it as a one-liner in `wiki/facts.md` instead) or the wrong granularity (split into 2 notes).
- Don't start at `## H2` thinking the filename "serves as H1" — Outline still needs the explicit `# H1` for the top-level anchor.
- Don't use **bold** as a faux-heading. Bold text doesn't appear in Outline.

### How skills enforce this

`save`, `wiki-ingest`, `wiki-query --persist`, and `autoresearch` are all expected to apply this structure when generating content. If a user's input is genuinely too thin to support 2 H2 sections, the skill should push back: *"This conversation is too brief for a standalone page — append as a line to `wiki/facts.md` instead?"* — rather than producing a flat single-section note that defeats Outline.
