---
name: wiki-lint
description: Health-check a wiki vault. Finds orphan pages (no inbound links), dead wikilinks (point to non-existent pages), missing frontmatter fields, stale claims, empty sections, and pages absent from index.md. Produces a structured report with severity tiers and proposes concrete fixes — but does not auto-apply them unless the user confirms. Use when the user says "lint the wiki", "health check", "audit my wiki", "find orphans", "what's broken in the wiki", "/wiki-lint", or after a long ingestion session to catch drift.
---

# wiki-lint

Read-only diagnostic. Surfaces problems and suggests fixes; never mutates the wiki without explicit confirmation.

## Modes

The skill has three modes :

- **Default (structural)** — runs Checks A through H. Cheap, scans page metadata + wikilinks + citations only. The right mode for routine health checks.
- **`--deep` (v0.15.0+, roadmap item #7')** — also runs Checks I through L, which read the **digest sidecars** (`wiki-meta/digests/<full-vault-path>` — NESTED layout mirroring `wiki/`, review+ pass 3+ hardening) in bulk to detect cross-page redundancies, contradictions, and missing wikilinks. More expensive (reads N digests + N² comparisons in the worst case). Use after a long ingestion session or when you suspect the wiki has drifted. **Enumeration MUST recurse** — `list_files({directory:'wiki-meta/digests'})` returns immediate children only ; walk the tree to get every `.md` underneath.
- **`--okf <path>` (v0.33.0+)** — runs Check M ONLY : validates an **OKF knowledge bundle** (Google's Open Knowledge Format v0.1) against the spec's three conformance rules. The path is either a bundle exported by `wiki-export --target okf` (`wiki-meta/exports/okf/<name>/` inside a vault) or any local directory / cloned repo containing a third-party bundle. This mode doesn't lint the wiki itself.

Trigger phrases :
- "lint the wiki" / "health check" / "audit my wiki" → default mode
- "deep lint" / "find redundant concepts" / "detect contradictions" / "wiki-lint --deep" → deep mode
- "lint the wiki and fix what you can" → default mode with auto-fix offered for ERRORs
- "validate this OKF bundle" / "is this bundle conformant" / "check OKF conformance" / "wiki-lint --okf <path>" → OKF mode

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

1. **Resolve the cited file** — the canonical location is `wiki/sources/<slug>.md` (see `wiki-ingest` step 4). Try in order : (a) `wiki/sources/<filename>`, (b) path relative to the citing page's folder (for sibling-references), (c) `<filename>` at vault root (legacy fallback). If none resolves → WARNING `cited-source-not-found`. **Reject** any cited path containing `..` segments or absolute roots (`/`, `C:\`, `\\server\`) — emit `cited-source-unsafe-path` WARNING instead and do NOT attempt the fetch (review+ pass 2 hardening : a malicious source citation must not become a vault-escape vector).
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

For each digest file (enumerate `wiki-meta/digests/` **recursively** — see Modes section), parse it with `parseDigest` from `src/helpers/digest-generator.mjs`. Compare the stored `page_hash` against a fresh `computePageHash(currentPageContent)` of the page the digest is for (`digest.for` field). On mismatch → WARNING `digest-stale` with detail "page edited since digest was generated ; run `/wiki-refresh-digests` to update".

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

### 2c. Check M (--okf mode only): OKF bundle conformance (v0.33.0+)

Validates a bundle against the Open Knowledge Format v0.1 conformance rules (SPEC.md §9). Google ships no standalone validator — this check is one of the ecosystem's first.

1. **Collect the bundle files.** For a bundle inside a vault (`wiki-meta/exports/okf/<name>/`) : recursive `list_files` + parallel `get_file`. For a local directory outside a vault : read from disk. Build `[{ path, content }]` with bundle-relative posix paths (strip the bundle root prefix).
2. **Run the checker** :

```javascript
import { checkOkfConformance } from 'src/helpers/okf-conformance-checker.mjs';
const result = checkOkfConformance(files);
// → { conformant, errors, warnings, info, stats }
```

3. **Severity mapping** (calibrated to OKF's permissive-consumption philosophy — deliberate, don't tighten it) :
   - **ERRORS** = violations of the three conformance rules only : `frontmatter-missing` (rule 1), `type-missing` (rule 2), `index-frontmatter-forbidden` / `index-frontmatter-extra-keys` / `log-date-not-iso` (rule 3).
   - **WARNINGS** = deviations the spec shows by example but never marks MUST : `index-heading-level`, `index-bullet-marker`, `index-bullet-form`, `index-unexpected-content`, `log-not-newest-first`, `log-frontmatter-unexpected` ; plus compat signals : `filename-charset` (Google's reference tooling rejects spaces/accents), `wikilink-syntax` (Obsidian-only links in bodies).
   - **INFO** = `reference-impl-keys` (Google's reference implementation wants `type`+`title`+`description`+`timestamp`), `okf-version-missing`, `root-index-missing`, `readme-without-frontmatter`.
4. **Verdict line** : `✅ conformant OKF v0.1` when zero errors, `❌ NOT conformant` otherwise — then the standard severity tables. A bundle with warnings is still conformant ; say so explicitly (consumers MUST tolerate those deviations).

This check is read-only like everything else in the skill. Do NOT offer to auto-fix a third-party bundle (it's someone else's artifact) ; for bundles produced by our own `wiki-export --target okf`, an error means an exporter bug — report it as such.

### 2d. Check N: decision-layer coherence (v0.49.0+)

Runs on every lint (no flag needed) whenever the vault has pages typed `decision` / `adr` / `decision-input`. Validates the frontmatter contract those pages must satisfy — see "Decision pages — frontmatter contract" in the vault `CLAUDE.md`.

1. **Collect the pages.** You already have the inventory from step 1 ; you need each page's frontmatter. Pass `[{ path, content }]`, or `[{ path, frontmatter }]` if you already read the frontmatter. Include NON-decision pages too — `affects:` legitimately points at specs, user stories and plain notes, and a page missing from the input reads as a dead target.
2. **Run the checker** :

```javascript
import { lintDecisions } from 'src/helpers/decision-lint.mjs';
const result = lintDecisions(pages, { today: '<YYYY-MM-DD>' });
// → { ok, errors, warnings, info, stats: { pages, decisions, byStatus } }
```

3. **Severity mapping** :
   - **ERRORS** = the decision layer actively misleads : `status-missing`, `status-invalid` (carries a `suggestion` when the value is a known legacy one — `active`/`decided` → `accepted`, `captured`/`awaiting-validation` → `proposed`, and since the 2026-07-28 token rename `superseded` → `replaced`), `replaces-self`, `replaces-target-missing`, `replaces-target-not-decision`, `replaces-target-not-replaced` (two decisions read as live at once), `replaces-cycle`.
   - **WARNINGS** = degraded but usable : `replaced-without-successor` (nothing claims it AND it has no `replaced_by:`), `replaced-by-not-reciprocated` (the named in-vault successor doesn't point back), `legacy-field-duplicate` (both `replaces:` and its pre-rename alias set), `affects-target-missing`, `scope-missing`, `review-after-invalid`, `review-after-expired`, `alternatives-missing` / `alternatives-empty` (v0.50.0+ — the "what we ruled out" section, EN or FR heading; only checked when you passed `content`, never for frontmatter-only input).
   - **INFO** = `evidence-missing`.
4. **Corpus scope caveat.** Every cross-page rule resolves only against the pages you passed in. If you lint a subfolder, say so in the report — `replaces-target-missing` may just mean the target lives outside the slice. That asymmetry is also why `replaced-without-successor` is a warning, not an error.
5. **Legacy tokens.** The pre-rename tokens (`supersedes` / `superseded` / `superseded_by`) are still read: the status errors with a `replaced` suggestion, the fields are honoured as aliases with an INFO `legacy-field-name` hint. An unmigrated vault lints usefully, it just gets nudged.

Auto-fix posture (step 4): `status-invalid` **with** a `suggestion` is the one decision finding worth offering to fix (a mechanical `set_frontmatter`). Never auto-fix `replaces-target-not-replaced` silently — flipping the target's status is a semantic act the human should confirm, since it retires a decision.

### 3. Render the report

Group findings by severity:

- **Errors** (broken state): dead wikilinks, stale index entries pointing to nonexistent files, **Check J `concept-overlap-strong`** (deep), **Check I `orphaned-digest`** (deep), **Check N** decision errors (`status-missing`, `status-invalid`, `replaces-*`)
- **Warnings** (degraded state): orphans, missing index entries, frontmatter gaps, empty sections, Check H claim-range issues (cited-source-not-found, claim-range-zero-or-negative, claim-range-inverted, claim-range-overflow), **Check I `digest-stale`** (deep), **Check J `concept-overlap-moderate`** (deep), **Check K `contradiction-suspected`** (deep, conservative heuristic), **Check L `missing-wikilink`** (deep), **Check N** `replaced-without-successor` / `affects-target-missing` / `scope-missing` / `review-after-*`
- **Info** (informational): log out-of-order entries, hot.md staleness, **Check N** `evidence-missing`

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
