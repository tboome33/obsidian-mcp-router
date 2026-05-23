---
name: wiki-lint
description: Health-check a wiki vault. Finds orphan pages (no inbound links), dead wikilinks (point to non-existent pages), missing frontmatter fields, stale claims, empty sections, and pages absent from index.md. Produces a structured report with severity tiers and proposes concrete fixes — but does not auto-apply them unless the user confirms. Use when the user says "lint the wiki", "health check", "audit my wiki", "find orphans", "what's broken in the wiki", "/wiki-lint", or after a long ingestion session to catch drift.
---

# wiki-lint

Read-only diagnostic. Surfaces problems and suggests fixes; never mutates the wiki without explicit confirmation.

## Pre-conditions

1. Target vault has `wiki/` scaffolding.
2. Vault is online.

## Steps

### 1. Inventory the wiki

```
mcp__obsidian-router__list_files({ vault, directory: "wiki" })
```

Build a flat set of every page path under `wiki/`. Read `wiki-meta/index.md` and parse the catalog into a separate set.

### 2. Run checks in parallel

For each check, accumulate findings. Don't bail on the first issue — surface the whole set.

#### Check A: orphan pages
A page is orphan if NO other page wikilinks to it (excluding self-references and the page being its own index entry). Build the inbound-link set by reading every page and parsing `[[wikilinks]]`. Pages with `type: source` or `type: answer` in frontmatter are exempt — those are reachable via the index.

#### Check B: dead wikilinks
A wikilink is dead if `[[Target]]` points to a page that doesn't exist. Resolve aliases (`[[Target|Alias]]`) and folder-prefixed forms (`[[concepts/Foo]]`). If a link looks dead, double-check by trying both with and without the `.md` extension and against alias frontmatter.

#### Check C: index drift
- Pages on disk under `wiki/` but missing from `wiki-meta/index.md` → "missing in index"
- Rows in `wiki-meta/index.md` pointing at pages that don't exist → "stale index entry"

#### Check D: frontmatter gaps
Every wiki page should have `type:` set. Sources should have `url:` (or `path:`) and `ingested_at:`. Answers should have `question:` and `answered_at:`. Missing fields are warnings, not errors.

#### Check E: empty sections
Pages with section headings followed by no body until the next heading. Surface them — they're usually placeholders that were forgotten.

#### Check F: log consistency
`wiki-meta/log.md` should be append-only, monotonically increasing timestamps. Out-of-order or duplicate timestamps are a smell (manual edit?). Surface them as info-level.

#### Check G: hot.md staleness
If `hot.md` `## Last Updated` is more than 7 days old, flag it. Real-world: hot caches go stale fast and become misleading.

### 3. Render the report

Group findings by severity:

- **Errors** (broken state): dead wikilinks, stale index entries pointing to nonexistent files
- **Warnings** (degraded state): orphans, missing index entries, frontmatter gaps, empty sections
- **Info** (informational): log out-of-order entries, hot.md staleness

For each finding:
- The path or wikilink involved
- 1-line description
- A proposed fix (concrete, applyable)

Render as markdown tables grouped by severity. Total counts at the top.

### 4. Offer to fix

For ERROR-level findings only, offer to auto-fix:
- Dead wikilinks → suggest the closest existing page (Levenshtein), let the user pick or skip
- Stale index entries → offer to remove the row

For WARNING-level findings, do NOT offer auto-fix. The orphan might be intentional; the missing index entry might be a genuine omission you don't want to cement.

The user must explicitly say "fix the errors" or "yes fix dead links" before any mutation.

### 5. Append to log.md (only when mutations happened)

This skill is **read-only by default**. A pure dry-run does NOT touch `log.md` — that would be a hidden mutation contradicting the read-only contract.

Append a log entry **only** if the user accepted at least one ERROR-level auto-fix in step 4:

```
- YYYY-MM-DD HH:MM — lint — accepted N fix(es) — <comma-separated list of fixed paths>
```

For dry-runs, surface the report in your reply and stop. The user can re-run later to capture the fix history if they want.

## Anti-patterns

- Don't auto-fix without permission. The user might have intentional orphans (drafts, archives).
- Don't fabricate "stale claims" — claim staleness needs a domain signal you can't have. Limit yourself to structural checks.
- Don't read every page sequentially. Use `Promise.allSettled`-style parallel `get_file` calls when feasible (the router supports concurrent requests).
- Don't recurse infinitely on broken wikilink suggestions. If the closest match is below a similarity threshold (~0.6), say "no good candidate" rather than suggesting noise.

## Output format

```
🔍 Wiki lint — vault `<name>` — N pages scanned

ERRORS (X)
| Type | Where | Detail | Fix |
|---|---|---|---|
| dead wikilink | wiki/concepts/Bayes.md | `[[Frequentism]]` → not found | Did you mean `[[Frequentist Inference]]`? |
| ... | ... | ... | ... |

WARNINGS (Y)
| Type | Where | Detail |
|---|---|---|
| orphan | wiki/notes/old-thing.md | no inbound links | (review and delete or link, your call) |
| ... | ... | ... |

INFO (Z)
| Type | Where | Detail |
|---|---|---|
| hot stale | wiki-meta/hot.md | Last Updated 12 days ago | run wiki-fold or refresh hot manually |

Run `/obsidian-router:wiki-lint --fix-errors` to apply the X error fixes (interactive).
```
