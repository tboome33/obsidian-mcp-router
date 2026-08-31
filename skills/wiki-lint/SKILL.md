---
name: wiki-lint
description: Health-check a wiki vault. Finds orphan pages (no inbound links), dead wikilinks (point to non-existent pages), missing frontmatter fields, stale claims, empty sections, and pages absent from catalog.md. Produces a structured report with severity tiers and proposes concrete fixes — but does not auto-apply them unless the user confirms. Use when the user says "lint the wiki", "health check", "audit my wiki", "find orphans", "what's broken in the wiki", "/wiki-lint", or after a long ingestion session to catch drift.
---

# wiki-lint

Read-only diagnostic. Surfaces problems and suggests fixes; never mutates the wiki without explicit confirmation.

## Modes

The skill has three modes :

- **Default (structural)** — runs Checks A through H. Cheap, scans page metadata + wikilinks + citations only. The right mode for routine health checks.
- **`--deep` (v0.15.0+, roadmap item #7')** — also runs Checks I through L (plus Check J-bis, C11, which needs no digest — it reads the Smart Connections vector store and reports itself unavailable where there is none), which read the **digest sidecars** (`wiki-meta/digests/<full-vault-path>` — NESTED layout mirroring `wiki/`, review+ pass 3+ hardening) in bulk to detect cross-page redundancies, contradictions, and missing wikilinks. More expensive (reads N digests + N² comparisons in the worst case). Use after a long ingestion session or when you suspect the wiki has drifted. **Enumeration MUST recurse** — `list_files({directory:'wiki-meta/digests'})` returns immediate children only ; walk the tree to get every `.md` underneath.
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

Build a flat set of every page path under `wiki/`. Read `wiki-meta/catalog.md` and parse the catalog into a separate set.

### 2. Run checks in parallel

For each check, accumulate findings. Don't bail on the first issue — surface the whole set.

#### Check A: orphan pages
A page is orphan if NO other page wikilinks to it (excluding self-references and the page being its own index entry). Build the inbound-link set by reading every page and parsing `[[wikilinks]]`. Pages with `type: source` or `type: answer` in frontmatter are exempt — those are reachable via the index.

#### Check A-bis: source ledger — stale, unreviewed, single-origin (v0.64.0+, borrowing C6)

Call `mcp__obsidian-router__audit_sources` once. It is read-only and needs no arguments beyond the vault.

Report, in the **info** tier unless noted:
- **`stale[]`** — sources past their refresh horizon, worst overdue first. Each is a *"go re-check this"*, not an error. Surface the count and the top few with their `overdueDays`.
- **`unreviewed[]` / `disputed[]`** — review gaps. `disputed` is worth a **warning** tier: the vault is resting on contested material.
- **`invalid[]`** — malformed entries. **Warning**: these are silently excluded from every other count, so an unreported `invalid` means the audit you just showed is narrower than it looks.
- **`origins.count` vs `total`** — how many genuinely independent publishers the whole ledger represents. A vault with 40 sources and 3 origins is worth mentioning out loud.

If `ledgerPresent: false`, say so **plainly and without alarm**: the ledger is filled forward by ingestion, so an absent one means *"nothing has been recorded yet"*, **not** *"this vault has no sources"*. Never present it as a defect of the pages.

**Per-page verdicts (opt-in, on request):** for a specific page, `audit_sources({ page })` returns whether it is corroborated by at least 2 distinct origins, with `excluded` listing what did NOT count and why (synthetic output, retired entries, unvouched local files). Do **not** run this across every page by default — it is a reviewer's question, not a lint sweep, and a low origin count is frequently legitimate.

Never write to the ledger from a lint run. Lint reports; `record_source` (ingestion) is the only writer.

#### Check A-ter: frontier pages — heavily linked, thin inside (v0.69.0+, borrowing C10)

Call `mcp__obsidian-router__find_boundary_pages({ vault, limit: 10 })` once. Read-only, one graph read, nothing written.

Report in the **info** tier and **never above it**. A crossroads that is thin is not a defect: nothing is broken, nothing needs fixing, and a lint report that raised it to a warning would be telling the user to repair something that may be exactly right. Show the top few with their `inbound` / `substanceWords` / `ageDays`, and always state the count in `exempted` — a ranking that silently dropped 31 pages reads as "I looked at everything" when it did not.

Skip the check without alarm when:
- the tool reports no graph → *"no knowledge graph yet; run `/wiki-graph` to enable frontier detection"*. This is not a wiki defect.
- the tool refuses for want of substance measurements → the graph predates the feature; same offer, same absence of alarm.
- `graphAnalyzedAt` is old → still report, but say how old the snapshot is. A stale graph ranks pages that may have been rewritten or deleted since.

**Two notions of "inbound link" coexist in this report, deliberately.** Check A above re-parses every page, so it counts wikilinks written in **frontmatter** (`related:`, `superseded_by:`); `find_boundary_pages` uses the knowledge graph, which parses page **bodies** only. Measured on the router's own vault (140 articles): they agree on 117 pages, and on the 23 that differ the graph always counts fewer. The graph's set is a strict **subset** of Check A's, so the two can never contradict — a page credited with inbound links by the frontier check can never be reported as an orphan by Check A. Don't "reconcile" the numbers if a reader notices the gap; explain it.

#### Check B: dead wikilinks
A wikilink is dead if `[[Target]]` points to a page that doesn't exist. Resolve aliases (`[[Target|Alias]]`) and folder-prefixed forms (`[[concepts/Foo]]`). If a link looks dead, double-check by trying both with and without the `.md` extension and against alias frontmatter.

#### Check C: catalog drift (map-of-maps semantics since v0.59.4)
`wiki-meta/catalog.md` is a **map of maps**: one entry per *directory*, each linking to that directory's generated `index.md`. It is deliberately **not** a page-by-page list, so do **not** report a page as "missing in index" merely because it has no row — page-level exhaustiveness is the generated indexes' job, and their freshness is Check L's. Reporting per-page gaps here would push the catalog straight back to the 70 KB / 115-row monolith the map-of-maps convention exists to undo.

What to check instead:
- A directory exists under `wiki/` but no catalog entry links to its `index.md`, and no parent-area entry covers it → **"area missing from the catalog"** (warning). Sub-directories of an area covered by that area's entry are fine — the parent index lists them.
- A catalog link points at an `index.md` that doesn't exist → **"stale area entry"** (error): a directory was renamed or removed.
- A catalog wikilink points at a page that doesn't exist → **"stale curated entry"** (error).
- An index is referenced with a **wikilink** rather than a markdown path link → **"ambiguous index link"** (error). Every directory index shares the `index` basename; a wikilink resolves by basename and Obsidian will retarget it silently. This is the exact failure the `index`→`catalog` rename was performed to prevent.

#### Check D: frontmatter gaps
Every wiki page should have `type:` set. Sources should have `url:` (or `path:`) and `ingested_at:`. Answers should have `question:` and `answered_at:`. Missing fields are warnings, not errors.

**`description:` is checked here too (v0.59.2+)** — every page under `wiki/` must carry a one-sentence `description` (see "One-line summary" in the vault `CLAUDE.md`). It matters more than the other gaps because it is *published*: the OKF directory indexes render `* [Title](file.md) - description`, so a page without one appears in the vault's own navigation as a bare filename. Report each offender with its path so it can be fixed at the source — and do NOT offer to auto-fill it from the body, even in `--fix` mode. The at-rest projections deliberately refuse to synthesize descriptions; a lint that quietly does it instead would reintroduce exactly the machine-written sentences that refusal exists to keep out of the vault. `refresh_okf_projections` reports the same set in `missingDescription`, so the two agree.

#### Check E: empty sections
Pages with section headings followed by no body until the next heading. Surface them — they're usually placeholders that were forgotten.

#### Check F: log consistency
`wiki-meta/journal.md` should be append-only, monotonically increasing timestamps. Out-of-order or duplicate timestamps are a smell (manual edit?). Surface them as info-level.

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

- **Overlap ≥ 0.7** → ERROR `concept-overlap-strong` : "pages X and Y share concepts [list] — read both, they may be covering one subject twice"
- **Overlap 0.4..0.7** → WARNING `concept-overlap-moderate` : "pages X and Y share concepts [list] — worth a look at how the two divide the subject"

The severities above are unchanged (`concept-overlap-strong` stays ERROR — see the severity list in step 3). Only the WORDING is: a lint finding reports what it measured and hands the judgement back. What to do about two overlapping pages — leave them, cross-link them, rewrite one, combine them — is a decision about MEANING that no overlap coefficient can make, and phrasing it as an instruction was inviting the reader to act on a number. Same posture as Check J-bis below; the two sit two paragraphs apart and must not contradict each other.

Report only pairs where the OVERLAP is above the WARNING threshold, not all 5000+ pairs.

#### Check J-bis (deep): quasi-twin pages by cosine (v0.72.0+, C11)

Check J compares CONCEPT LISTS (Jaccard over the digests' `concepts` arrays). Check J-bis is the same question asked of the **embedding space** instead: two pages can be the same page written twice and share almost no concept vocabulary, because two sessions name things differently. Where the vault has Smart Connections vectors, cosine sees that; Jaccard cannot.

```
mcp__obsidian-router__find_twin_pages({ vault, limit: 10 })
```

Read-only, one pass over the vector store, nothing written. Works on a **remote** vault too since v0.82.0 — the store is read through the bridge's `GET /smart-env/sources` (requires obsidian-mcp-router-bridge 0.9.0+ on the machine running that vault). Measured on the router's own vault, the disk and remote runs return the same pairs, the same threshold and the same exclusion counts; the remote run costs ~6× the wall clock, because the whole store crosses the wire.

**Report in the *info* tier and never above it.** Two pages that resemble each other are not a broken state: a templated series, a decision and its record, a page deliberately split from its "gotchas" companion all look alike and are all correct. This is a deliberate divergence from Check J, which raises `concept-overlap-strong` to ERROR — do not inherit that severity here, and never phrase a finding as a merge instruction. Show, per pair, the similarity and the four evidence columns (`sameFolder`, `sameBasename`, `sharedLinks`, `linked`); they are what lets a reader dismiss a false positive in one glance.

**Always state the derived threshold and the corpus it came from.** The cut is computed from *this* vault's own distribution — `threshold.similarity`, `threshold.medianSimilarity`, `threshold.sensitivity` — and it does not transfer to another vault. A report that shows pairs without the threshold that produced them is unauditable. Raise or lower `sensitivity` (higher = stricter) until the list is a length the user will actually read.

**A scoped run answers a scoped question.** Passing `folders` narrows the corpus *and* the distribution the cut comes from, so **the same pair can be reported by a whole-vault run and absent from a folder-scoped one** (measured on the router's vault: whole wiki → cut 0.9326, 4 pairs ; `folders: ['wiki/obsidian-mcp-router/Features']` → cut 0.9613, 0 pairs). That is correct — *"unusual for this section"* and *"unusual for this vault"* are different questions — but say which one you asked, and quote the cut. `restrictTo` behaves differently on purpose: it filters pairs **after** the cut is derived, so it never changes a pair's verdict, only whether it is shown.

**Always state `excluded`.** The tool holds out indexed paths whose page is gone from disk (`notOnDisk` — routinely a third of the store), generated projections, and pages typed `redirect`/`source`/`answer`. A list of pairs that silently ignored a third of the corpus reads as "I compared everything" when it did not.

**Always state the COVERAGE, in the numbers the tool gives you.** `available: true` does NOT mean the whole vault was analysed — only the pages that carried a vector were compared, and on a vault indexed a while ago that can be far fewer. Quote `coverage.statement` verbatim, or render `coverage.comparedPages` / `coverage.eligiblePages` in the "N of M" form: *"112 of 187 eligible pages carried a vector and were compared"*. Never present an exhaustive comparison of the 4 vectorised pages as coverage of the 10 pages that exist.

**Always state the FRESHNESS.** `freshness.caveat` says it: these similarities come from an index **snapshot**, not from the pages as they are now. A page edited since the last indexing pass still carries its previous vector, and **this answer does not check which pages those are** (`freshness.perPageStaleness: "unknown"`) — it compares vectors, not timestamps. Say so in the report; an unqualified similarity reads as a statement about the pages today. (`search_smart` *does* check, per hit, and returns a `freshness` block naming the pages edited since indexing — reach for it when the freshness of a specific page matters.)

**`available: false` IS NOT "no twins", and `available` is THE discriminator.** Branch on it. Ten reasons arrive as a response with `available: false`, a `reason`, and **no `pairs` key at all**:

| `reason` | what it means |
|---|---|
| `no-embeddings` | no Smart Connections index (or no indexed page survives the exclusions) |
| `no-wiki` | nothing under `wiki/` |
| `corpus-too-small` | fewer than 30 comparable pairs (≈ 9 pages) — a median+MAD would describe nothing |
| `no-spread` | at least half the pairs share one similarity; no outlier cut can be derived |
| `bridge-route-absent` | remote vault, and nothing served the store route (404) — usually a bridge older than 0.9.0, **tell the user to upgrade it**, though a proxy masking auth or not routing the path looks identical |
| `store-truncated` | the bridge sent only a prefix of the store (it hit its own budget) |
| `store-inconsistent` | the store response's own header contradicts its body — counts that do not balance, or fewer records/bytes than claimed |
| `store-unreachable` | the store could not be fetched at all — network, auth, timeout |
| `wiki-enumeration-incomplete` | the vault's file list did not come back whole, so no exclusion count can be trusted |
| `wiki-read-incomplete` | pages were lost between the walk and the read — a pair needs BOTH halves, so a ranking from what arrived would hide twins rather than report none |

An **eleventh** way to decline is a **thrown refusal**, `too-many-pages` (`err.kind: "validation"`, `err.reason: "too-many-pages"`), when the corpus is past `maxPages` — there is no response body at all. Scope with `folders`, or raise `maxPages` knowingly.

Report any of these as *"this check is unavailable on this vault, because …"* — never as a clean bill of health. `result.pairs?.length ?? 0` would read every one of them as "no twins", which is exactly why the key is absent rather than empty; the absence is defence in depth, the field to read is `available`.

The last six arise on a vault reached **over the network** (one exception: `wiki-read-incomplete` can also fire on a local vault, when every candidate page was deleted between the walk and the read — the detail then says the store is fine). The first of them is the one worth acting on: `bridge-route-absent` names a plugin the operator can upgrade, not a fact about topology. Do not report it as "this vault has no index" — that is a different reason with a different fix. The honest fallback line: *"Check J (concept overlap) still runs wherever digests exist; cosine needs embeddings, and this vault has none."* Only `available: true` with `found: 0` means the vault was examined and nothing stood out.

**Known false-positive mode, worth saying out loud in the report:** the vectors are whole-page and the model's window is 512 tokens, so pages that share a template score very high on their common head. Measured on a real vault, two course sheets scored cosine 0.9914 with a 5-word-shingle overlap of 0.064. When `sameBasename` is true across sibling folders, say so — it is usually a series, not a duplication.

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

### 2b-bis. Check L: OKF projections drift (v0.59.0+)

Call `mcp__obsidian-router__refresh_okf_projections({ vault, check: true })`.

- `upToDate: true` → ✅ nothing to report.
- `written[]`/`deleted[]` non-empty → **drift** (INFO severity): the generated `wiki/index.md` / per-directory indexes / `wiki/log.md` no longer match the tree. Fix = re-run without `check` (safe: pure regeneration).
- `conflicts[]` non-empty → **WARN**: a hand-written file squats a reserved projection path (`index.md`/`log.md` under `wiki/`). Never auto-fix — surface it and let the user rename the page (the basenames are reserved by OKF; see the 2026-07-30 catalog/journal decision).
- `skipped: not-initialized` → the vault predates volet ② — offer to initialise (one tool call).

Projection files are excluded from Checks A/B (orphans/dead-links): they are generated navigation, not content — recognisable by their `> Generated by obsidian-mcp-router` marker line.

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
   - **ERRORS** = the decision layer actively misleads : `status-missing`, `status-invalid` (carries a `suggestion` when the value is a known legacy one — `active`/`decided` → `accepted`, `captured`/`awaiting-validation` → `proposed`), `supersedes-self`, `supersedes-target-missing`, `supersedes-target-not-decision`, `supersedes-target-not-superseded` (two decisions read as live at once), `supersedes-cycle`.
   - **WARNINGS** = degraded but usable : `superseded-without-successor` (nothing claims it AND it has no `superseded_by:`), `superseded-by-not-reciprocated` (the named in-vault successor doesn't point back), `affects-target-missing`, `scope-missing`, `review-after-invalid`, `review-after-expired`, `alternatives-missing` / `alternatives-empty` (v0.50.0+ — the "what we ruled out" section, EN or FR heading; only checked when you passed `content`, never for frontmatter-only input).
   - **INFO** = `evidence-missing`.
4. **Corpus scope caveat.** Every cross-page rule resolves only against the pages you passed in. If you lint a subfolder, say so in the report — `supersedes-target-missing` may just mean the target lives outside the slice. That asymmetry is also why `superseded-without-successor` is a warning, not an error.

Auto-fix posture (step 4): `status-invalid` **with** a `suggestion` is the one decision finding worth offering to fix (a mechanical `set_frontmatter`). Never auto-fix `supersedes-target-not-superseded` silently — flipping the target's status is a semantic act the human should confirm, since it retires a decision.

### 3. Render the report

Group findings by severity:

- **Errors** (broken state): dead wikilinks, stale index entries pointing to nonexistent files, **Check J `concept-overlap-strong`** (deep), **Check I `orphaned-digest`** (deep), **Check N** decision errors (`status-missing`, `status-invalid`, `supersedes-*`)
- **Warnings** (degraded state): orphans, missing index entries, frontmatter gaps, empty sections, Check H claim-range issues (cited-source-not-found, claim-range-zero-or-negative, claim-range-inverted, claim-range-overflow), **Check I `digest-stale`** (deep), **Check J `concept-overlap-moderate`** (deep), **Check K `contradiction-suspected`** (deep, conservative heuristic), **Check L `missing-wikilink`** (deep), **Check N** `superseded-without-successor` / `affects-target-missing` / `scope-missing` / `review-after-*`
- **Info** (informational): log out-of-order entries, hot.md staleness, **Check N** `evidence-missing`, **Check A-ter** frontier pages (never above info — a thin crossroads is not a defect), **Check J-bis** quasi-twin pairs (never above info — resemblance is not a defect, and the check proposes a reading, never a merge)

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

### 5. Append to journal.md (only when mutations happened)

This skill is **read-only by default**. A pure dry-run does NOT touch `journal.md` — that would be a hidden mutation contradicting the read-only contract.

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
