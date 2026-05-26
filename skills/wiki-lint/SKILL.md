---
name: wiki-lint
description: Health-check a wiki vault. Finds orphan pages (no inbound links), dead wikilinks (point to non-existent pages), missing frontmatter fields, stale claims, empty sections, and pages absent from index.md. Produces a structured report with severity tiers and proposes concrete fixes — but does not auto-apply them unless the user confirms. Use when the user says "lint the wiki", "health check", "audit my wiki", "find orphans", "what's broken in the wiki", "/wiki-lint", or after a long ingestion session to catch drift.
---

# wiki-lint

Read-only diagnostic. Surfaces problems and suggests fixes; never mutates the wiki without explicit confirmation.

## Modes

The skill has two modes :

- **Default (structural)** — runs Checks A through H. Cheap, scans page metadata + wikilinks + citations only. The right mode for routine health checks.
- **`--deep` (v0.15.0+, roadmap item #7')** — also runs Checks I through L, which read the **digest sidecars** (`wiki-meta/digests/<page-slug>.md`) in bulk to detect cross-page redundancies, contradictions, and missing wikilinks. More expensive (reads N digests + N² comparisons in the worst case). Use after a long ingestion session or when you suspect the wiki has drifted.

Trigger phrases :
- "lint the wiki" / "health check" / "audit my wiki" → default mode
- "deep lint" / "find redundant concepts" / "detect contradictions" / "wiki-lint --deep" → deep mode
- "lint the wiki and fix what you can" → default mode with auto-fix offered for ERRORs

A related skill, `wiki-refresh-digests`, regenerates stale digests detected by Check I (see `skills/wiki-refresh-digests/SKILL.md`).

## Pre-conditions

1. Target vault has `wiki/` scaffolding.
2. Vault is online.
3. **For `--deep` mode only** : `wiki-meta/digests/` directory exists with at least one digest. If empty / missing, gracefully report "no digests to deep-lint; run `wiki-ingest` to generate digests, or `/wiki-refresh-digests` to backfill existing pages".

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

#### Check H: claim-range-validity (v0.15.0+, roadmap item #1)

Scan every wiki page body for line-range citation markers of the form `^[<filename>:<start>-<end>]`, `^[<filename>#L<start>-L<end>]`, `^[<filename>:<line>]`, or the paragraph-level fallback `^[<filename>]`. For each marker with a range :

1. **Resolve the cited file** — try `sources/<filename>` first (the convention), then `<filename>` at vault root if not found. If neither exists → WARNING `cited-source-not-found`.
2. **Parse the range** — accept colon-style `:42-58` and GitHub-style `#L42-L58` (semantically equivalent). Reject malformed ranges (non-numeric, missing parts).
3. **Validate the range** :
   - `start > 0` and `end > 0` — both must be positive integers (line 0 doesn't exist) → WARNING `claim-range-zero-or-negative`
   - `end >= start` — `8-3` is invalid → WARNING `claim-range-inverted`
   - `end <= sourceLineCount` — range can't extend past the source's actual length → WARNING `claim-range-overflow` with detail "source has N lines"

All Check H findings are **WARNING-level**, not ERROR. Source files can legitimately shorten over time (refactor, edit, summarisation), and we don't want lint to fail loudly on routine maintenance. The user reads the warnings and decides whether to refresh the citing page, refresh the source, or accept the drift.

Single-line citations `^[file.md:42]` and paragraph-level fallbacks `^[file.md]` are also validated — single-line is just the special case where start == end; paragraph-level needs only the cited-source-not-found check (no range to validate).

**Performance note** : Check H reads each cited source file once to get its line count. Cache the line counts per source within a single lint run to avoid re-reading the same source multiple times when several pages cite it.

### 2b. Deep checks (v0.15.0+, `--deep` mode only)

The following 4 checks are gated behind the `--deep` flag because they involve reading every digest in `wiki-meta/digests/` and doing pairwise comparisons. Cheap individually, but N² in page count — typical vault (100 pages) → 5000 comparisons, fine ; large vault (1000 pages) → 500k comparisons, may take a few seconds.

#### Check I (deep): digest staleness

For each digest file in `wiki-meta/digests/`, parse it with `parseDigest` from `src/helpers/digest-generator.mjs`. Compare the stored `page_hash` against a fresh `computePageHash(currentPageContent)` of the page the digest is for (`digest.for` field). On mismatch → WARNING `digest-stale` with detail "page edited since digest was generated ; run `/wiki-refresh-digests` to update".

If the page referenced by `digest.for` no longer exists (page deleted), surface that as ERROR `orphaned-digest` and suggest removing the digest file too.

#### Check J (deep): redundant concepts across pages

Load all digests. For each pair of digests `(A, B)`, compute `conceptOverlap(A, B)` via `src/helpers/digest-generator.mjs` (Jaccard similarity over the concepts arrays). Thresholds :

- **Overlap ≥ 0.7** → ERROR `concept-overlap-strong` : "pages X and Y share concepts [list] — likely candidates for merge"
- **Overlap 0.4..0.7** → WARNING `concept-overlap-moderate` : "pages X and Y share concepts [list] — consider cross-linking or partial merge"

Report only pairs where the OVERLAP is above the WARNING threshold, not all 5000+ pairs.

#### Check K (deep): contradiction signals

**Conservative heuristic only**. LLMs detect contradictions poorly when given prose ; the deterministic heuristic here flags only HIGH-confidence cases to avoid false positives that would erode trust in the linter.

For each pair of digests with `conceptOverlap ≥ 0.5` (i.e. they're about overlapping topics), scan their `claims` arrays for direct negation patterns :

- One page asserts `"X is Y"` and another asserts `"X is not Y"` (or `"X is never Y"` / `"X cannot be Y"`)
- One asserts `"always do X"` and another asserts `"never do X"` / `"avoid X"`
- One asserts `"X is the only way to Y"` and another asserts `"X is one of several ways to Y"`

The heuristic is regex-based — match `(\\b\\w+\\b) is (\\w+)` in page A against `\\1 is (?:not|never)? \\2` in page B (and symmetric variants). Surface ONLY exact matches, never fuzzy paraphrases — false positives are worse than false negatives here.

Severity : WARNING `contradiction-suspected`. Always document the limitation in the report : "naive heuristic, likely misses many contradictions ; treat as a starting point not a guarantee".

#### Check L (deep): missing wikilinks

For each pair of digests with `conceptOverlap ≥ 0.4` (i.e. they share at least some topics), check whether either page wikilinks to the other. Specifically :

1. Read page A's content, parse `[[...]]` wikilinks. If page B's basename is in the wikilinks → OK.
2. Same in reverse for page B → page A.
3. If NEITHER page references the other → WARNING `missing-wikilink` : "pages X and Y share concepts [list] but don't reference each other ; consider adding `[[X]]` or `[[Y]]` to the other page".

This check often surfaces genuine knowledge-graph gaps that humans miss when adding new pages incrementally.

### 3. Render the report

Group findings by severity:

- **Errors** (broken state): dead wikilinks, stale index entries pointing to nonexistent files, **Check J `concept-overlap-strong`** (deep), **Check I `orphaned-digest`** (deep)
- **Warnings** (degraded state): orphans, missing index entries, frontmatter gaps, empty sections, Check H claim-range issues (cited-source-not-found, claim-range-zero-or-negative, claim-range-inverted, claim-range-overflow), **Check I `digest-stale`** (deep), **Check J `concept-overlap-moderate`** (deep), **Check K `contradiction-suspected`** (deep, conservative heuristic), **Check L `missing-wikilink`** (deep)
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
