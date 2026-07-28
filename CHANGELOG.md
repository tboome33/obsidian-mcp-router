# Changelog

All notable changes to `obsidian-mcp-router` (the npm package + Claude Code plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [Unreleased]

## [0.55.1] — 2026-07-29 — review+ pass on Lot 3: the pre-seed `--force` data-loss bug, and a test file that never ran

Formal `/review+` pass on v0.55.0 (Claude Code Reviewer + codex, two rounds each). Codex converged on the gunzip-headroom inconsistency; the Code Reviewer found what the pre-commit adversarial pass had missed — everything AROUND the extractor.

### Fixed

- **BLOCKER — `--force` from a config pre-seed destroyed installed plugins.** The skeleton ships manifest-less `data.json`-only dirs (bridge, icon-folder, quiet-outline); under `--sync-from-github --force` the anti-downgrade guard failed open on the unreadable SOURCE manifest, `rmSync` deleted the real plugin (manifest + main.js) and only the pre-seed's `data.json` came back — fleet-wide with `--all --force`, living `.template` included. Two layers now: `isTargetPluginNewer` protects the target when only the source manifest is missing, and the sync loop never refreshes a manifest-target from a manifest-less source (a manifest-less TARGET still refreshes — it isn't an installed plugin). Verified live: a v9.9.9 bridge with `main.js` survives `--force`.
- **Circular allowlist.** The network vetting read its "curated" list from the archive itself — a hostile archive enlarged its own allowlist. `NETWORK_PLUGIN_ALLOWLIST` is now pinned in code; the archive's list only selects within it, and a non-default `--repo` requires an explicit `--trust-repo` acknowledgement (it ships executable plugin code under trusted names).
- **`.claude/` no longer cloned from network sources** — its `settings.json` can carry hooks (shell commands), i.e. network bytes into an executable config while plugins get vetted.
- **Windows smuggling classes in `safeJoin`**: NTFS Alternate Data Streams (`a.txt:evil` lands under a DIFFERENT name than the one validated — proven on this machine) and reserved device names (`CON`, `COM1`…) are rejected.
- **Dead test file resurrected.** `tests/setup-vault-themes.test.mjs` imported `setup-vault.mjs`, whose top-level CLI dispatch printed the help and `process.exit(0)`'d DURING import — its 16 assertions (the whole anti-downgrade suite) were a false green since v0.52.0, counted as one passing test. The dispatch is now wrapped in `cliMain()` behind an entrypoint guard (`samePath(import.meta.url, argv[1])`); the suite gained the 16 real tests.
- Smaller hardening: gunzip headroom derived from `maxEntries` (codex finding — a fixed 16 MB margin rejected valid 20k-entry archives), decompression-bomb errors wrapped readably, old-style `type '0' + trailing slash` directories honored, `quiet` + source-override refused outright, `--repo` documented in the help, SKILL claims aligned (no more « exclusivement » — `--repo` exists, gated, and the skill never passes it unprompted).

### Tests

- +5 targz cases (ADS/devices, wrapped bomb, old-style dirs, 17k-entry structural headroom), +1 anti-downgrade pre-seed case — plus the 16 resurrected ones. Full suite **2456**, 0 failures. E2E re-verified through the wrapped dispatch against the real GitHub tarball.

## [0.55.0] — 2026-07-28 — Lot 3: `/sync-from-github` — a machine with no dev repo pulls the template straight from GitHub

Lot 3 of the template-distribution roadmap, plus the first task the `brat-dans-template-vivant` decision ordered: **BRAT 2.0.8 is now installed and ENABLED in the living `.template` vault** (`data.json` wired to the bridge repo + hot-reload, `updateAtStartup`), so the next `meta-sync-template` hands it to every existing vault and the bridge self-updates from GitHub releases from then on.

### Added

- **`--sync-from-github` mode** in `setup-vault.mjs` — downloads the repo tarball from `codeload.github.com` (size-capped, HTTPS-only redirects, wall-guarded), extracts `templates/reference-vault-skeleton` to a temp dir, and applies it to one vault or `--all` through the exact same pipeline as `--sync-plugins`: `syncPluginsMode` gained a `sourceVault`/`sourceLabel` override, so the credential-leak refusal, the BRAT anti-downgrade guard, per-theme clones, appearance fill-if-absent and root-doc sync all apply unchanged. `--ref <branch|tag>` and `--repo <owner/name>` are validated before any URL is built.
- **`src/helpers/targz-extract.mjs`** — dependency-free hardened extractor: path-traversal aborts the WHOLE extraction (absolute paths, `..` segments, backslash tricks, Windows trailing-dot/space components), links are never materialized (skipped and reported), entry-count and total-byte caps govern the gunzip output too, GNU longnames supported, base-256 numeric fields refused explicitly.
- **`sync-from-github` skill + slash command** — picker over the configured fleet, faithful reporting of the four outcome categories (synced / refreshed / kept-newer / refused-for-safety), and the standing rule that safety refusals are guarantees to respect, never errors to bypass.

### Security — adversarial review before commit (2 agents, 15 verified findings, all addressed or consciously accepted)

- **Network archives are not a trusted plugin store**: under `--sync-from-github`, source plugin dirs are vetted — curated allowlist (skeleton's own `community-plugins.json` ∪ REQUIRED_PLUGINS), strict lowercase name hygiene, manifest-id-matches-folder when a manifest exists, and manifest-less dirs allowed only without executable code (the Lot 2 config-pre-seed pattern).
- **Credential guard normalization**: `CREDENTIAL_LEAK_PLUGINS` was an exact case-sensitive match while Windows resolves paths case-insensitively — `Obsidian-Local-REST-API ` (case + trailing space) dodged the guard yet wrote into the real folder. Lookup now normalizes.
- **Bomb caps actually govern**: every entry's payload (pax/longname/dir metadata included) counts toward `maxTotalBytes`, and the gunzip `maxOutputLength` derives from the caller's limit (a ~575 KB download could previously decompress to half a GB).
- **Parser desyncs closed**: directory entries declaring a payload advance past it; truncated archives fail strictly; a crafted final entry can no longer extract clamped content silently.
- **CLI hardening**: `--ref`/`--repo` refuse flag-like or missing values, unknown flags fail instead of becoming vault paths, `--all` + explicit paths is an error instead of silently syncing the whole fleet, and the `--all` config load happens before any download (no leaked temp dir).
- Consciously accepted (documented): idle-timeout rather than wall-clock download deadline (host is pinned by default), and the pre-existing subcommand-position footgun shared with `--sync-all`.

### Tests

- `tests/targz-extract.test.mjs` — 18 cases: synthesized ustar archives (real checksums) covering happy path, GNU longnames, pax skip, every traversal variant, link smuggling, caps (including metadata payloads), base-256 refusal, dir-desync, truncation, repo/ref validation. E2E verified twice against the real GitHub tarball (2.1 MB → 404 files → 4 curated plugins + Blue Topaz applied to a throwaway vault; hardened flag parsing exercised live). Full suite **2437**, 0 failures.

## [0.54.1] — 2026-07-28 — the linter now reads « Alternatives considérées »

Found by running the pilot consolidation against the real vault, minutes after v0.54.0: the canonical compact form that `decision-consolidate` prescribes writes its table under `## Alternatives considérées` — the natural French for "alternatives considered" — and `ALTERNATIVES_HEADINGS` knew `envisagées` and `écartées` but not `considérées`. Every consolidated page would have shipped with a false `alternatives-missing` warning: the skill's own canon tripping the skill's own linter.

### Fixed

- **`ALTERNATIVES_HEADINGS`** in `src/helpers/decision-lint.mjs` gains `alternatives considerees` / `alternative consideree` (normalized forms — accents are stripped before matching, decorated variants still count via the prefix rule). Full suite **2420**, 0 failures.

## [0.54.0] — 2026-07-28 — decisions can be consolidated: compress + archive, never erase

Roland's ask, verbatim: keep only the final decision and erase the deliberation that "pollutes the context and can mislead an LLM". The accepted contract (meta-vault decision `consolidation-sans-amnesie`, 2026-07-28) keeps the ADR payload intact by splitting the two: **the WHY stays on the page, the CHRONICLE moves out** — into an `archives/` note (`type: decision-archive`) that humans can still browse in Obsidian but that no LLM surface resurfaces by default. Nothing is erased; git keeps every byte anyway.

### Added

- **`decision-consolidate` skill + slash command** — transactional consolidation of a SETTLED decision page (`accepted` / `superseded` / `rejected`, never `proposed` — its deliberation is the working material). Archive written and VERIFIED first (`<page-folder>/archives/<slug>-deliberation.md`), then the page rewritten to canon: verdict **byte-intact**, minimal why, alternatives as a table, `consolidated:` marker, mandatory `## Historique` wikilink to the archive. Piloted on the meta vault's `adr-modes-ecriture` (13.6 KiB of double-banner history compressed, chronicle archived).
- **`search_smart` excludes archived deliberation by default** — hits under an `archives/` folder are dropped by a path-segment test (no extra REST round-trips on the hot path), the response carries `archivesExcluded: N` so the cut is never silent, and the page is overfetched before filtering so exclusion cannot shrink the result set below `limit`. Opt back in with `includeArchives: true`. New helper `src/helpers/archive-filter.mjs`; a folder merely *named* `mes-archives` or a page `archives.md` does not match.
- **Decision lint rule 6 — `consolidated:` coherence** (`src/helpers/decision-lint.mjs`): `consolidated-invalid` (not an ISO date), `consolidated-proposed` (a proposed page must never be consolidated), `consolidated-without-history-link` (no `## Historique` / `## History` section carrying the wikilink to the archive — the one pointer that keeps "compressed" from degrading into "erased"). New exported `findHistorySection()`.
- **Recall exclusion locked by tests** — `type: decision-archive` is deliberately absent from `DECISION_TYPES` on BOTH sides of the contract pair (recall core + lint). New tests pin the three type sets and feed the recall walker an archive note that *mimics* a decision (same tokens, decision-ish fields): the type gate, not luck, is what keeps it out.

### Tests

- `tests/search-archive-filter.test.mjs` (12 cases: segment matching incl. backslashes/anchors/near-miss names, drop+count, overfetch trim, includeArchives pass-through, bridge error shape), rule-6 suite + `findHistorySection` suite in `tests/decision-lint.test.mjs`, archive fixtures in `tests/decisions-recall.test.mjs`. Full suite **2419**, 0 failures.

## [0.53.0] — 2026-07-27 — `npm run release` publishes the backlog, not just the current version

v0.48.0 ended a drift where 40 versions shipped with pushed commits, no tags and no releases. The tooling it introduced worked — for one rhythm: bump, commit, push, repeat. It had a blind spot for the other one, which is the rhythm actually used here: **let several versions accumulate locally, then push the lot**.

Yesterday that blind spot bit. Five commits, five tags, five CHANGELOG entries — `npm run release` pushed the branch, **one** tag, published **one** release, and left four tags local and four holes in the Releases page. Backfilled by hand; the page then showed v0.52.0 as "Latest" because GitHub ranks by creation date and the backfill ran newest-last. Exactly the drift the tooling exists to prevent, arriving through the door it left open.

### Changed

- **`scripts/create-release.mjs` publishes the whole backlog.** It now collects every version that has a CHANGELOG entry **and** a local tag reachable from HEAD **and** no GitHub release, pushes each tag, and publishes them **oldest-first** so the Releases chronology matches the version order.
- **`--latest` lands on the highest version overall**, computed by semver across pending *and* already-published releases — not on whichever release happened to be created last. Backfilling an old version can no longer steal the badge from a newer one.
- **The 108 CHANGELOG entries with no tag are not resurrected.** Requiring a local tag is what excludes them: without a tag there is no commit to release. Requiring *reachable from HEAD* excludes tags belonging to another branch.
- **Guards kept, calibrated per version**: the current version still fails hard on a stub CHANGELOG entry or an uncommitted bump; an older version in the backlog whose notes are a stub is skipped with a warning rather than failing the whole run — its missing notes are not this run's fault, and blocking would strand the versions after it.

### Added

- **Tests** — `parseChangelogVersions`, `selectPendingReleases` (backlog ordering, untagged versions not resurrected, already-published skipped, tag-without-notes skipped, `v` prefix tolerated) and `highestVersion` (semver, not lexicographic: `0.9.0` < `0.52.1`). Full suite **2393**, 0 failures. Replayed against yesterday's exact state, the new selection returns the full `v0.51.0 → v0.52.1` batch with `--latest` on v0.52.1.
## [0.52.1] — 2026-07-27 — a cross-vault successor is not a local page

Found by linting the real vault. A decision retired in favour of one living in **another vault** (`superseded_by: "kiviri:wiki/…"`) was resolved by basename against the local corpus, matched a same-named page there, and was then reported as a broken reciprocity — a requirement that cannot be met across vaults by construction.

### Fixed

- **`isExternalReference()`** in `src/helpers/decision-lint.mjs` — a reference carrying a `slug:` prefix *before any path separator* explicitly names another vault and is left unresolved. A colon inside a note name (`[[Titre: sous-titre]]`) is not one, and `http(s):` is excluded. Full suite **2383**, 0 failures.
## [0.52.0] — 2026-07-26 — template idéal Lot 2: themes propagate, `--theme` applies, BRAT never downgraded

Lot 2 of the template-distribution roadmap (the `template-distribution-roadmap` page in the meta vault). The skeleton already carried Blue Topaz + BRAT + `app.json` defaults (committed `f804151`, reconciled item by item before this work); what was missing was everything that makes those reach vaults: BRAT wasn't even ENABLED in the skeleton's `community-plugins.json`, themes never propagated on bootstrap or sync, the wizard's `--theme` choice was recorded-but-blocked, and a template sync could silently DOWNGRADE a plugin BRAT had auto-updated in a user vault.

### Added

- **`cloneThemes(source, target, force)`** — theme propagation on EVERY path (bootstrap from reference/skeleton/from-vault + `--sync-plugins`/`--sync-all`). Per-theme granularity: an existing theme dir is skipped unless `--force`, and a theme that exists only in the target is NEVER deleted (the old from-vault behavior wiped the whole `themes/` dir on `--force`).
- **`syncAppearanceDefaults(source, target)`** — fresh vaults inherit the template's `appearance.json` (cssTheme / light-dark scheme / accentColor); an existing `appearance.json` is never touched, not even with `--force` — the theme is a per-user preference, not template state.
- **`applyThemeChoice(target, theme)`** — the wizard's `--theme` is now APPLIED: writes `cssTheme` (merge-style, only that key), validates the theme folder exists in the target first, `"obsidian-default"` → `""`. The `plan_vault` planner drops the `theme-blocked` warning and lists an apply step; `provision_vault`'s schema description updated.
- **`isTargetPluginNewer(src, dst)` anti-downgrade guard** — BRAT auto-updates GitHub plugins (bridge, hot-reload) inside user vaults, so sync/`--force` now compares `manifest.json` versions and NEVER replaces a newer installed copy (locked decision 2026-06-19). Fail-open on missing/unparseable manifests. Reported per-vault as `Kept N plugin(s) at the target's NEWER version`.
- **Skeleton completions** — `obsidian42-brat` added to `community-plugins.json` (vendored since `f804151` but never enabled → BRAT never loaded); non-secret `data.json` vendored for `obsidian-quiet-outline` + `obsidian-icon-folder` (per the Lot 2 curation rule: config yes, history/UI-state no — `realclaudian`'s `tabManagerState`, `recent-files`' history and `smart-connections`' install-state are deliberately NOT shipped).
- **NOTICE** — MIT redistribution credits for the two vendored components: Blue Topaz (© 2020 whyt-byte, authors WhyI & Pkmer) and BRAT (© 2024 TfTHacker), with upstream URLs and vendor paths.
- **Tests** — `tests/setup-vault-themes.test.mjs` (16 cases): per-theme skip/force/target-only-preserved, appearance fill-if-absent, `--theme` apply/refuse/default, anti-downgrade newer/equal/older/fail-open. Full suite **2382 tests**, 0 failures.

### Changed

- `setupVault()` prefers the SOURCE vault's `app.json` (skeleton and `--from-vault` carry their own defaults) before falling back to the configured reference vault's.
- Stale comments refreshed: the skeleton-contents doc block (still claimed "no plugin binaries"), `--bootstrap-reference` next-steps (BRAT is in place and auto-updates the bridge at startup).
## [0.51.2] — 2026-07-26 — long frontmatter values were being truncated everywhere

Found by using the thing. Back-filling the reference vault's decision corpus (roadmap Phase 2bis) produced `decision:` one-liners long enough that Obsidian's YAML writer folded them onto continuation lines — the normal representation of a long quoted scalar. The recall block then displayed them **cut mid-sentence and starting with a stray quote**.

The gap was in the minimal frontmatter readers, and it was not confined to the hook: the shared `parseFrontmatter` in `src/helpers/llms-txt-exporter.mjs` had it too, which means **every export built on it** (llms.txt, OKF bundles, page metadata) has been carrying truncated `title:` / `description:` values whenever they were long enough to wrap.

### Fixed

- **Folded quoted scalars are read in full** — in `hooks/_helpers/decisions-recall-core.mjs` and in `src/helpers/llms-txt-exporter.mjs`. Continuation lines are consumed until the quote closes (escape-aware), and parsing resumes cleanly on the next key. Single-line scalars are untouched. Tests pin both readers.
- **A lone `~` is no longer escaped.** Strikethrough needs `~~`, so escaping every tilde only printed backslashes through ordinary values like "~36 tools" — the same over-caution already reverted for `_`. Only the doubled form is neutralized now.

### Changed

- **`decision-input` pages are no longer asked what they ruled out.** The "alternatives considered" rule now applies to verdict types (`decision`, `adr`) only — a decision *input* is material feeding a decision, not a ruling, so demanding its rejected options is a category error. The recall hook already drew that line; the linter now agrees (`VERDICT_TYPES`).

### Reference vault (roadmap Phase 2bis, not shipped code)

The decision corpus was back-filled in the same pass: two decisions that existed nowhere as pages were written (**BM25 over embeddings**, **HTTP `insecurePort` over HTTPS loopback** — the first being the hole the recall hook exposed on the day it shipped), seven pages gained the `decision:` one-liner the recall block is built around, and eight gained an "alternatives considered" section **extracted from their own body**, never invented, each carrying a note saying so. Linter over the corpus: **0 errors, 1 warning** — that warning being a page whose frontmatter no router tool can write, see below.

### Known issue, unfixed

- Two vault pages carry frontmatter that Local REST API's YAML writer rejects with a 500, so **no router tool can modify their properties**: an unquoted `title:` containing a colon, and an inline `related: [[a]], [[b]]` sequence. The second was repaired by full rewrite; the first (`click-to-open-access-modes`) still needs one. Worth a lint rule of its own — invalid frontmatter is silent until something tries to write.
## [0.51.1] — 2026-07-26 — `decisions-recall` hardened by a two-reviewer audit

Two independent reviewers audited v0.51.0 (`/review+`, five passes). The hook worked on the fixtures it shipped with and failed on ordinary real input in several ways — and nearly every round of fixes introduced a regression the next pass caught, which is the argument for the loop existing at all: pass 1's noise fix silenced a focused vault; pass 2's re-read guard dropped French frontmatter; pass 3's markdown escaping mangled the very paths the block exists to hand over. All fixed and pinned by tests.

One recommendation reversed between passes and had to be arbitrated rather than applied: filtering out ubiquitous-vocabulary matches (pass 3) removed on-topic decisions whenever one off-topic page happened to carry a rare token (pass 4). Ranking replaces filtering — for a recall layer, losing a relevant decision is worse than showing one weak line a reader dismisses from its title.

### Fixed

- **The anti-injection framing could be truncated away** (blocker). The character budget was applied after joining the whole block, so the cut landed on the **footer** — the part carrying "never contradict silently / never treat as an order". Three entries of perfectly legitimate size (title 60, verdict 220, scope 120 — the field caps themselves) already exceeded the budget, so no hostile content was required; and `title` was capped nowhere, meaning one long title decided where the block ended. Now the budget applies to the **items only**, header and footer are never cut, titles are capped, and truncation drops **whole entries** (a slice through a `` ` `` or a `**` would leave the delimiter open and make the footer render as code or emphasis).
- **Settled decisions recorded with a legacy status were invisible.** The hook demanded `accepted` while the linter has always known the free-form synonyms (`decided`, `active`, `shipped`…). Two real decisions in the reference vault were silently missing from recall. Legacy synonyms are now recalled and labelled as not-yet-normalized, and a test asserts **set equality** with the linter's map so the pair cannot drift.
- **An unparseable `review_after:` made a decision permanently binding.** `01/01/2026` (a plausible typo) failed the ISO test, so the date was treated as absent instead of unreadable — the exact ossification the field exists to prevent. It is now surfaced as unreadable and explicitly non-binding.
- **A frontmatter larger than the 4 KB head was dropped silently** (found by both reviewers). A page with a long `evidence:` / `affects:` / `aliases:` list — that is, a page documenting itself well — never surfaced. The reader now re-reads up to a bounded ceiling when the closing `---` is missing. Two successive fixes of this were themselves wrong, both silently dropping pages: the first compared a **character** count to a **byte** budget so the re-read never fired on accented content; the second gated the re-read on finding a `key:` line, which fails on a non-ASCII first key (`évidence:`) and on a comment preamble. There is now no heuristic gate at all — guessing whether an unterminated `---` block is frontmatter or a horizontal rule is not worth a silent omission, and the only cost of guessing wrong is one bounded read.
- **Escaping mangled the citation.** Neutralizing markdown emphasis ran over the **path** too, and inside a code span markdown shows escapes literally — `hot\_cache.md` identifies no file, while the block instructs the agent to read exactly that path. Code-span values (path, raw status) are now emitted verbatim, safe because backtick removal already prevents closing the span. A path too long to cite drops its entry rather than emitting a truncated, invalid reference. And `_` is no longer escaped anywhere: CommonMark forbids intraword emphasis with underscores, so `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` cannot open anything — escaping it only degraded every entry in a domain where snake_case is everywhere.
- **A UTF-8 BOM hid the whole frontmatter**, and **an unclosed HTML comment in a page field could swallow the rest of the block**, footer included. Both neutralized.
- **Vault-wide vocabulary drowned the signal.** `router`, in a router repo, matched nearly every decision and spent two of three slots on noise. Ubiquitous tokens are now demoted in peripheral fields (scope, project, tags, filename), and — when any candidate matched on distinctive vocabulary — the merely-ubiquitous matches are dropped rather than spending slots. Two earlier attempts were wrong in opposite directions: demoting everywhere made a focused vault go silent on its own subject (five decisions about embeddings, a question about embeddings, zero results), while demoting only peripheral fields let the noise back in through titles when the project name is a title prefix. A title match stays eligible — it is topical by definition — but it no longer out-competes a real one.
- **Page-controlled markdown could still corrupt the framing.** An unmatched `**` or `_` in a title or verdict opened emphasis that ran on and visually absorbed the footer. Emphasis markers are now escaped (not stripped), along with control and format characters; angle brackets are entity-encoded. And every rendered field — including the **path**, which a deeply nested filename could otherwise use to inject thousands of characters on every matching prompt — is capped, which is what makes a single entry bounded by construction.

### Changed

- **Bounded in wall-clock, not file count.** A vault on a virtual drive (Google Drive File Stream et al.) costs ~30× a local one per file, and a file cap makes recall depend on directory traversal order — thousands of ordinary notes before the decisions folder and nothing surfaces. A deadline degrades in proportion to how slow the storage actually is; the file cap survives only as a runaway backstop. When the scan is cut short the block says so, and `OBSIDIAN_ROUTER_HOOK_DEBUG=true` reports it on stderr along with any swallowed error (the hook still exits 0 in every case).
- **`decision-input` is linted but never recalled** — material feeding a decision is not a verdict.
- **Likely decision directories are walked first** (`decisions/`, `adr/`, `wiki/`). A deadline bounds the walk but does not by itself remove the dependency on traversal order — on slow storage the budget can run out before the decisions folder is ever reached. Visiting the conventional locations up front makes the cut land on the unlikely part of the tree instead.
- Skipped directories match case-insensitively (`.smart-env` and `.claudian` added). README (EN + FR), `docs/features/12` and the hooks' own header comments describe the shipped behaviour rather than the first draft's.
- **Tests: 29 → 66** on this hook (full suite **2374**, 0 failures). The additions are the cases that broke in the wild — BOM, CRLF, oversized frontmatter, legacy status, unreadable review date, single-token noise, focused-vault regression, hostile title, unclosed comment, balanced-delimiter truncation, deadline with partial results returned. Two pre-existing tests were rewritten: one asserted that truncation *existed* using a fixture too small to reach the budget (which is how the blocker slipped through), the other checked the deadline flag with a clock so coarse the walk never started.
## [0.51.0] — 2026-07-26 — `decisions-recall`: the settled decisions come back on their own

The last two releases made the decision layer **complete and checkable**. It was still **passive**: nothing presented a decision to an agent before it acted, so nothing actually stopped the loop the whole practice exists to break — a new session, a different agent, or the same one after a context reset starts blank and re-proposes an approach that was ruled out months ago. Writing the decision down is necessary and insufficient. This release is where the practice starts paying.

Phase 3 of the vault-side ADR roadmap, and the tenth hook in the router: a convention is a nudge, and nudge ≠ enforce — the same lesson that already turned `vault-link-linter` and `wiki-query-first-nudge` into hooks rather than paragraphs.

### Added

- **`hooks/decisions-recall.mjs`** (UserPromptSubmit) — on every substantive prompt, surfaces the `accepted` decisions whose subject overlaps it: title, one-line verdict, scope, and the path to read the full page. Dual-mode like `wiki-query-first-nudge` (workspace-is-vault and workspace-bound-to-a-vault). Silent when nothing matches, so ordinary prompts pay nothing; exits 0 on any error, because a recall hook that breaks the session it was meant to help is worse than one that misses a decision.
- **`hooks/_helpers/decisions-recall-core.mjs`** — the pure half (scan, select, format), testable without spawning a process and dependency-free, since hooks must run in a fresh checkout before `npm install`.
- **Tests** — `tests/decisions-recall.test.mjs` (29 cases): the core (tokenizing with accent folding and a stopword floor, the minimal frontmatter reader, the bounded walker, selection, formatting) plus a spawned-shell layer for the wiring, the prompt filters and the opt-out. Full suite **2337 tests**, 0 failures.

Three design properties, each deliberate and each covered by a test:

- **Deterministic first.** Candidates are filtered by `status: accepted`, then ranked by plain token overlap against title, verdict, scope, project, tags and basename. No embeddings, no model call: the hot path of every prompt is the wrong place for either, and a selection you cannot explain is one you cannot debug the day it surfaces the wrong page. `proposed` decisions are not binding and `superseded` / `rejected` ones must never be shown as constraints — surfacing a retired decision is precisely the failure the layer prevents.
- **Expired is neither silent nor binding.** Past its `review_after:` date a decision is still shown, flagged **due for re-evaluation**. Hiding it loses the context; presenting it as a constraint ossifies a ruling whose conditions have changed. That is the anti-ossification rule made operational.
- **Cited data, never instructions.** Vault pages are user content, and content an agent reads must never be able to direct it — otherwise the vault becomes a prompt-injection surface. The injected block says so explicitly, and asks the agent to *flag* disagreement rather than obey or silently contradict.

### Changed

- **`hooks/hooks.example.json`** wires the hook into `UserPromptSubmit` (so `setup-vault.mjs --install-hooks` picks it up), README (EN + FR) goes from 9 to **10 hooks**, and `docs/features/12-hooks-et-automatisations.md` gains its section.

### Field note from the first real run

Fired against the reference vault with *"could we replace the filter with an embeddings scorer?"*, the hook surfaced the mcphub smart-routing decision — correctly, via its `embeddings` tag — and, just as informatively, **nothing about BM25**: that verdict has never been written as a decision page, it lives diluted in a roadmap. The recall layer is exactly as good as the decisions actually recorded, which is the argument for the qualification charter, not against the hook. Second observation: the surfaced page carries no `title:` or `decision:` frontmatter, so its recall entry is thin — those two fields are what make a recall block readable at a glance.
## [0.50.0] — 2026-07-26 — the field that justifies the practice becomes checkable ("alternatives considered")

v0.49.0 gave decision pages a frontmatter contract; this one closes the part that frontmatter cannot express. A decision record without its **rejected options** is a decorated changelog: the code holds the path taken and never the paths refused, the PRD holds the goal and never the trade-off, and a session that reads only those two re-proposes what was ruled out months ago. The convention already said the section mattered — nothing verified it, so nothing prevented it from quietly disappearing.

Phase 2 of the vault-side ADR roadmap (`adr-implementation-roadmap`). Calibrated as a **warning**, deliberately: an absent section leaves the decision layer incomplete, not lying — unlike a broken supersession chain, which makes two contradictory decisions both read as live. Errors are reserved for states that actively mislead, and a check that fails a whole existing corpus on day one is a check people learn to ignore.

### Added

- **Rule 5 in `decision-lint.mjs`** — `alternatives-missing` when a decision body carries no "what we ruled out" section, and `alternatives-empty` when the heading is there but nothing follows it. The second matters more than it looks: the escape hatch has to be **written**. "No serious alternative" plus the reason (an external constraint, a licence, a third-party limit) is a valid answer; a bare heading satisfies a naive "is the section present?" check while carrying exactly zero of the information the section exists for.
- **`findAlternativesSection(body)`**, exported — returns `{found, empty, heading}` and recognizes both languages of a bilingual vault (`## Alternatives considered`, `## Options écartées`, `## Pourquoi pas autre chose`, `## Alternatives envisagées`, `## Options rejetées`), the decorated bilingual form (`## Alternatives considered · Options écartées`), H2 or H3, and treats a subsection under the heading as content. Heading matching normalizes accents and punctuation, so `## Options écartées :` and `## Options ecartees` both count.
- **Tests** — 14 more cases (52 in the file), covering each heading variant, the written escape hatch, the empty-heading case, the trailing-section case, and the guarantee below. Full suite **2308 tests**, 0 failures.

### Changed

- **Body rules never fire on frontmatter-only input.** `lintDecisions` now tracks whether a page was given as `content` (parseable body) or as pre-parsed `frontmatter`; rule 5 is skipped entirely for the latter. A body rule that reports a missing section against a body it was never handed would make the frontmatter-only calling mode unusable — and that mode is what a caller uses when it already holds the metadata.
- **`heading-hierarchy` convention** — `## Alternatives considered` moves from optional to **required** in the type-minimums table for `decision` / `adr` / `decision-input`, with the rationale, the escape hatch and the accepted French headings spelled out next to it.
- **`wiki-lint` Check N** documents the two new warnings, including the "only checked when you passed `content`" caveat.

### Known state of the reference vault

- A read-only sweep of the vault's seven decision pages found **none** carrying an alternatives section — they predate the contract, and the new rule will flag all seven at the next lint. They were **not** back-filled: inventing options that were never weighed would be fabricating the historical record, which is the one thing a decision log cannot survive. Filling them is a pass to run with the human who made the calls. Related finding: the single page in the vault that *does* document its rejected options (`click-to-open-access-modes`) carries no frontmatter at all, so the decision layer cannot see it — typing it is a one-line fix worth making.
## [0.49.0] — 2026-07-26 — the decision layer gets a contract (normalized statuses + bidirectional `supersedes:`)

A wiki records what is known and what happened; it has never recorded **what is settled** in a machine-checkable way. Decision pages existed (`type: decision` / `adr` / `decision-input`, a `save` flow, heading conventions), but their `status` was free-form — `active`, `decided`, `captured`, a hand-written "(awaiting-validation)" — so nothing could tell a live decision from a retired one, and nothing noticed when a superseding decision left its predecessor still reading as accepted. That is the failure mode the ADR practice exists to prevent: a new session (or a different agent) re-proposes an option that was ruled out months ago, because the ruling was never written in a form anything could query.

This release ships the frontmatter contract and its deterministic checker. It is Phase 1 of the vault-side ADR roadmap (`adr-implementation-roadmap`), whose Phase 0 — the qualification charter that decides *what even deserves* a decision file — was written first, deliberately: normalized statuses don't improve a poorly-fed taxonomy.

### Added

- **`src/helpers/decision-lint.mjs`** — pure-functional linter for the decision layer of a wiki. Validates four rules: (1) `status` present and one of `proposed` | `accepted` | `superseded` | `rejected`, with legacy values (`active`, `decided`, `captured`, `shipped`, `awaiting-validation`, …) reported **together with the normalized value to migrate to**, so a caller can propose a concrete fix instead of a bare rejection; (2) **bidirectional `supersedes:` coherence** — the target must exist, be a decision, and actually carry `status: superseded`, the check that catches two contradictory decisions both reading as live; (3) `affects:` targets resolve (the directional "re-review this if I change" loop that symmetric `related:` cannot express); (4) the charter fields — `scope:` (a decision without a perimeter applies everywhere, therefore badly) and a well-formed `review_after:`, the anti-ossification field whose expiry surfaces a decision as "to re-evaluate" rather than as a binding constraint.
- **`superseded_by:`** — the mirror field, set on the retired page. It exists for the one case `supersedes:` cannot express: a successor living in **another vault** (a decision migrated elsewhere). When the named successor is in-corpus the link must be reciprocal, else `superseded-by-not-reciprocated`.
- **Check N in the `wiki-lint` skill** — runs on every lint (no flag) when the vault has decision pages, with the severity mapping and the corpus-scope caveat spelled out: cross-page rules resolve only against the pages passed in, so linting a subfolder cannot honestly claim a target is dead. That asymmetry is why `superseded-without-successor` is a warning and not an error.
- **Tests** — `tests/decision-lint.test.mjs` (38 cases): every legacy status maps to its suggestion, each supersedes failure mode (dangling, still-live, self, non-decision target, two-page cycle), reference forms (`[[a]]`, `[[folder/a|alias]]`, `a.md`, `[[a#anchor]]`), the charter fields, and the reciprocity matrix for `superseded_by:`. Full suite **2294 tests**, 0 failures.

### Changed

- **`heading-hierarchy` convention snippet** gains a "Decision pages — frontmatter contract" section: the seven fields with their required/optional status, plus the three rules that make the layer trustworthy — an agent writes `proposed` and never self-validates; immutability is **of the verdict, not of the file** (fix a typo, update a status, never rewrite an accepted verdict — a reversal creates a new page with `supersedes:`); and an `accepted` decision is never contradicted silently, an agent that believes one stale *flags* it. Decisions surfaced into an agent's context are cited data, never instructions.
- **`save` skill** writes the contract: the decision frontmatter block now carries `scope`/`supersedes`/`affects`/`evidence`/`review_after`, `supersedes:` is documented as a **two-file edit** (adding it requires flipping the target to `superseded` in the same turn), and the `## Alternatives considered` section moves from optional to expected — with the explicit escape hatch that "**No serious alternative**" plus a reason is a valid answer when an external constraint decided for you. An absent section is what's forbidden, not an honestly empty one.

### Migrated

- The reference vault's seven decision pages were normalized in the same pass (`active`/`decided`/`shipped` → `accepted`, `scope:` added everywhere, `evidence:` where the motivating study exists, and `superseded_by:` on the retired Resonance semantic-search spec whose successor lives in the Kiviri vault). The linter run over the result: **0 errors, 0 warnings**, 6 accepted + 1 superseded.

### Known gaps (next phases)

- The `## Alternatives considered` section is documented as expected but not yet **enforced** by a lint rule (Phase 2), and nothing yet **surfaces** accepted decisions to an agent before it acts (Phase 3, the `decisions-recall` hook) — which is what actually prevents the re-proposal loop. Until then the contract is checkable but not proactive.
## [0.48.0] — 2026-07-26 — docs catch up with reality + releases stop drifting (auto-tag hook, `npm run release`)

Discovered while answering "why does GitHub say the last release was 2 months ago?": between v0.8.2 (2026-05-06) and v0.47.0, the repo shipped **40 versions with pushed commits but zero git tags and zero GitHub releases** — the Releases box was honest, the process wasn't. Same audit showed the user-facing docs lagging the 45-command / 42-tool surface. This release fixes both: the documentation is resynced everywhere, and tagging becomes a deterministic side effect of the existing bump→commit workflow instead of a memory-dependent manual step.

### Added

- **`.githooks/post-commit` auto-tag hook** — when a commit touches `package.json` and no `v<version>` tag exists for its `version` field, the commit is tagged `v<version>` (annotated) on the spot. Fail-open (a post-commit hook must never break a commit); merge commits skipped by design. Lives next to the existing gitleaks `pre-commit` in the versioned `.githooks/` directory.
- **`ensureHooksPath()` in `scripts/bump-version.mjs`** — every real (non-dry-run) bump re-ensures `git config core.hooksPath = .githooks`, so the hook is armed on any clone the moment it bumps; nothing to remember, nothing to drift. The CLI now ends with the 3-step flow (write CHANGELOG → commit auto-tags → `npm run release`).
- **`npm run release`** (`scripts/create-release.mjs`) — pushes the current branch + tag and creates the GitHub release (or idempotently updates it on re-run) with notes extracted from this file's entry for the version. Guards: refuses while the entry still contains the bump `TODO` stub, refuses when the bump isn't committed, self-heals a missing tag on the bump commit, `--dry-run` previews. Requires the `gh` CLI.
- **Tests** — `tests/create-release.test.mjs` (12 cases): `extractChangelogSection` (middle/last entry, subsections, multi-em-dash titles, non-stub headings, literal version matching) + `ensureHooksPath` (unset → set, no-op when wired, rewires foreign paths, fail-open outside a repo). Full suite **2253 tests**, 0 failures.

### Changed

- **README (EN + FR) resynced with the shipped surface** — counts corrected everywhere (40→**45 slash commands**, 35→**42 MCP tools**, ~39→**42 skills**, wrappers 14→**16**, knowledge-management 17→**20**); new `convert/` wrapper section (`pdf-to-markdown`, `pdf-to-markdown-docling`) and `hot-compact` row added; `plan_vault`, `provision_vault`, `pdf_to_images`, `filter_relevant_blocks`, `open_in_obsidian` added to the **Capabilities** and **Tools exposed** tables (both languages).
- **Quick-reference PDFs regenerated after 2 months of drift** — `docs/quick-reference-{en,fr}.html` fully rewritten from the v0.8.11-era content ("31 slash commands") to v0.48.0: 45 commands in 4 category tables, the 42 tools grouped in one page, multi-tenant env vars, `wiki-meta/` layout, wizard-first setup path. PDFs re-rendered via Chrome headless and propagated to the reference vault (`.template/Documentation/`).
- **CONTRIBUTING.md release process** rewritten around the new flow (bump arms the hook → commit auto-tags → `npm run release` publishes); the manual `git tag` step that caused the drift is gone.
## [0.47.0] — 2026-07-17 — `filter_relevant_blocks`: BM25 relevance second-pass over already-acquired markdown (Crawl4AI W-A)

When the router ingests a web page it usually knows *why* — the user asked about a specific topic, or an `autoresearch` loop is chasing a question. But a defuddled article still carries off-topic blocks (lifestyle intro, author bio, newsletter callout, digressions), and today all of it flows into synthesis: tokens wasted, noise in the wiki page. This release borrows Crawl4AI's pattern (`PruningContentFilter` → `BM25ContentFilter` on the same fetched HTML) as **borrowing #1 / workflow W-A**: a **second pass** — a topical-relevance filter — applied to markdown the caller **already holds**, with **no re-fetch, no LLM, no new dependency**, fully deterministic. Our first pass (chrome stripping) is already done by defuddle/MarkItDown; this adds the relevance pass on top. Implemented on Opus 4.8, gated through `/review+` (Claude Code Reviewer + codex) before ship. Design detail: the vault roadmap `bm25-filter-implementation-roadmap` (§4 frozen spec).

### Added

- **`filter_relevant_blocks` MCP tool** (`src/tools/filter-relevant-blocks.mjs`) — `{ markdown, query, threshold?, includeScores? }` → `{ markdown, filtered, stats, scores? }`. Read-only (no vault I/O, no `vault` arg), so it stays exposed under `OBSIDIAN_ROUTER_READONLY`, and it is **not** in `WRITE_TOOL_NAMES`. Usable by any skill on content it already has (defuddle output, pasted text, a file read).
- **Pure helper `src/helpers/bm25-filter.mjs`** — `segmentBlocks()` + `bm25FilterBlocks()`. Standard BM25 (k1=1.2, b=0.75) that **imports** the router's existing `tokenise` + `computeIdf` from `idf-score.mjs` (not a copy); IDF is computed over the document's own scored blocks. Deliberate deviation documented in-code: the repo's smoothed IDF `log(1 + N/(1+df))` is always ≥ 0, unlike textbook BM25 IDF which goes negative for very common terms.
  - **Segmentation**: leading YAML frontmatter kept verbatim; fenced code (``` / ~~~) is one block including internal blank lines; ATX headings are their own block and are **always** kept (a filtered-out section still shows its heading); a code block follows the relevance of the prose that introduces it, and never inherits relevance across a heading boundary.
  - **Guards (never throws — always degrades to a no-op)**: an empty/low-signal `query` → strict no-op (byte-identical output); fewer than 4 scorable blocks → untouched; a filter that would drop >70% of the content (or a query that matches nothing) → returns the **original intact** with `usedFallback: true`. Same `usedFallback` philosophy as `defuddle-extract`.
- **Opt-in `relevanceQuery` (+ `relevanceThreshold`) on `webpage_to_markdown`** — applies the same filter to the converted page in-process, no re-fetch. **Non-regression guaranteed**: without `relevanceQuery` the output is byte-identical to before (the string contract every existing caller depends on); with it, the output stays a markdown string and the filter stats are appended as a single trailing HTML comment.
- **Skill wiring** — `wiki-ingest` gains a step 1.6 that runs the filter after defuddle **only when the ingestion has an explicit theme** (and continues silently on the original if the guard trips); `defuddle` documents the option in its hand-off. The freshness hash stays computed on the pre-filter markdown, so change-detection is unaffected by what a given theme keeps.
- **Tests** — `tests/bm25-filter.test.mjs` + `tests/filter-relevant-blocks.test.mjs` (37 cases): segmentation edge cases, all guard boundaries (exactly-3 → no-op, exactly-70% → filters), byte-identity of every no-op path, a numerically-pinned BM25 score, Unicode/French, determinism, null/undefined-safe input, and the `webpage_to_markdown` string contract via a `_deps.convert` seam. Full suite **2242 tests**, 0 failures.
- **`/review+` gate findings, all resolved before ship**: CRLF input now normalized on the filter path; code-block relevance no longer inherited across headings; `threshold` accepts a numeric string; `bm25FilterBlocks(null)` degrades instead of throwing; guard-boundary and math tests hardened.

## [0.46.0] — 2026-07-14 — hot-cache size limit goes dynamic (single token unit, sober role/threads band)

The hot-cache size discipline (v0.44.0) was a STATIC, two-unit test: block when `words > 500` **OR** `bytes > 6 KiB`, with a separate 1000-word hard cap. Three numbers in two units that aren't directly comparable — Hermès flagged the incoherence (1000 words ≈ 750 tokens, so a token-denominated soft target and a word-denominated hard cap describe contradictory spaces). This release collapses the SEMANTIC size decision onto ONE unit — estimated tokens, what context actually costs — and lets the enforced limit breathe within a NARROW band around the proven ~500-word anchor, driven by only two defensible signals: the vault's role and the number of active threads. Design pressure-tested with three independent voices (Claude + Codex + Hermès); the vault design note `hot-cache-dynamic-limit-design` records the full reasoning, including what was deliberately dropped.

### Added

- **Token-based dynamic budget in `src/helpers/hot-size.mjs`** (additive layer — the historical word/byte functions stay in place and tested):
  - `estimateTokens(text) = ceil(max(chars/4, words×1.3))` — the SINGLE measurement unit. `chars/4` dominates on real (dense) hot content and replaces the old bytes dimension; `words×1.3` is only a conservative floor for char-sparse text; `chars = text.length` (JS code units, NOT UTF-8 bytes) so accented FR isn't over-counted.
  - `computeHotBudget()` / `hotStatus()` — the enforced limit = `clamp(BASE × role + activeThreads×20, floor, ceil)`, an explicit `hot-limit-tokens:` frontmatter override honored up to a fixed absolute cap. Compaction target = 0.7 × limit (hysteresis). No LLM, no I/O — a pure, auditable function of the file text.
  - `parseHotMode()` (vault role from `mode:`/`type:` frontmatter) and `countActiveThreads()` (bullets under `## Active Threads`, capped at 5).

### Changed

- **Calibration to REAL hots.** Measuring live vault hots showed pointer-dense content (markdown + accents + `[[wikilinks]]`/URLs) runs **~1.8 tokens/word**, not the generic 1.3 (398 w → 728 t; 492 w → 889 t). So the proven "500-word" rule, expressed honestly in tokens, is **~900 tokens — NOT 650**: `BASE_LIMIT_TOKENS = 900`, absolute cap `1800` (~1000 words), band `[774, 1224]`. Anchoring at 650 would have false-flagged every healthy hot on disk.
- **The two hooks now decide via `hotStatus`**: `hot-cache-update-prompt.mjs` (Stop guard) blocks only when over the enforced token limit; `hot-cache-load.mjs` (SessionStart injection) bounds by a token-derived byte budget and banners in token language. Guard/loader/`hot-compact` still measure through the ONE shared module, so they can never disagree.
- **Deliberately NOT used** (Hermès's substance): raw edit velocity (measures editorial noise, not the facts worth caching) and a session-frequency term (its sign is disputed — Codex reads it as budget-decreasing, Hermès as budget-increasing). Only vault role + active-thread count drive the modest band.
- `templates/wiki-meta/hot.md` contract line updated to token language. Full suite: **2205 tests** (`tests/hot-size.test.mjs` token battery + band invariant; `tests/hot-cache-load.test.mjs` injection budget).
- **Version resync**: `.claude-plugin/plugin.json` + `marketplace.json` had drifted to v0.44.0; bumped back in sync with `package.json` at v0.46.0.

## [0.45.0] — 2026-07-14 — `build_open_link` verifies the path on disk (no more dead links)

`build_open_link` only URL-encoded whatever path it was handed — garbage in, garbage out. A wrong path (an invented sub-folder, a typo) produced a perfectly-formed URL that 404s at the bridge, indistinguishable from a good one; the chat-link linter/guard exempt well-formed http links, so nothing caught it. Real incident: a link to `wiki/Projects/KIVIRI/SaaS/kiviri-v2-secrets.md` when the file lives at `wiki/Projects/KIVIRI/kiviri-v2-secrets.md`. Diagnosed + design pressure-tested with codex (read-only) on 2026-07-14.

### Changed

- **`build_open_link` now VERIFIES the path against the local vault on disk before emitting a URL** — fail-closed. New helper `src/helpers/resolve-vault-path.mjs::resolveVaultPathOnDisk()` (filesystem-only, mirrors how `click-to-open.mjs` reads `data.json` — no REST call, works offline):
  - exact path exists → normal result;
  - exact miss, **unique** basename match → auto-corrected to the real path (result carries `corrected: true` + `requestedPath`);
  - exact miss, **no** match → single mode THROWS a clear error; batch marks that entry with `error: 'not_found'` + null URL (good entries still resolve);
  - exact miss, **ambiguous** basename (≥2 files) → THROWS / `error: 'ambiguous'` + the candidates — never silently picks one;
  - basename walk truncated on a huge vault → `resolution_incomplete` (never a false not_found/unique);
  - remote vault → `unverifiable`, prior behaviour kept (null URL — remote vaults have no local disk to stat).
- Net guarantee: **no success branch of `build_open_link` reaches the URL builder without a vault-proven path** → the caller can no longer walk away with a dead link. 16 tests (`tests/build-open-link.test.mjs`, `tests/resolve-vault-path.test.mjs`).
- Complements `mcp-router-bridge` v0.5.1, whose `/open` self-heals a wrong-folder path by basename at click time (covers hand-composed / historical links too).
- **Known follow-ups** (codex audit, not fixed here): `move_file` (from===to), `merge_frontmatter` (all-ops-failed), `execute_template` (build from `result.path`) can still emit a URL after a no-op/failure; and the port cache in `click-to-open.mjs` never invalidates on a `data.json` port change.

## [0.44.0] — 2026-07-12 — hot-cache size discipline: bounded injection, guard enforcement, `/hot-compact`

The hot cache (`wiki-meta/hot.md`) finally gets its size ENFORCED. Its own header rule says "< 500 words, overwritten on update — a cache, not a journal", but nothing checked it: the freshness guard (v0.25.0) pushed every wiki-writing session to ADD an entry and nothing ever removed one — an add-only ratchet. The oldest vault's hot silently grew to 129 KB / ~17.8k words (35×), injected into EVERY session start on that vault (~35k tokens burned before any work). Diagnosed 2026-07-12; design pressure-tested with codex the same day; the 129 KB pilot compaction (full backup → 3.3 KB state-first rewrite) was human-approved before this mechanism shipped.

### Added

- **`src/helpers/hot-size.mjs` — the single source of truth for hot sizing.** Words + UTF-8 bytes counting, OR-based over-limit test (> 500 words OR > 6 KiB — words track the semantic promise, bytes catch URL/id-heavy content), compaction targets with hysteresis (≤ 350 words AND ≤ 4 KiB — compacting to 499 would re-trigger immediately), per-vault frontmatter override (`hot-limit-words` / `hot-limit-bytes`, clamped to 1000 words / 12 KiB — an EXPLICIT exception, never implicit growth), block-aware bounded selection (splits prologue vs dated entries, auto-detects newest-first vs append-at-bottom ordering by comparing entry dates, keeps whole blocks from the RECENT side, emits an omission marker — never a mid-line cut), and the bilingual oversize banner. Loader, guard and compaction skill all measure through THIS module so they can never disagree (a disagreement would loop). 26 unit tests (`tests/hot-size.test.mjs`).
- **`/obsidian-router:hot-compact` (skill + command) — the deterministic compaction procedure.** Strict order: measure WITHOUT loading a huge hot into context (script + the vault's own Local REST API) → byte-identical backup `wiki-meta/hot.full-backup-<date-hhmm>.md` VERIFIED by size comparison before any overwrite → thin state-first rewrite (Key Recent Facts · Recent Changes · Active Threads; pinned 📌 blocks always preserved) → concurrency re-check before the final write → traceability line in `log.md`. Human preview required for a vault's FIRST compaction at > 5× the limit; autonomous afterwards (the verified backup makes it reversible).

### Changed

- **`hooks/hot-cache-load.mjs` — bounded injection.** An over-limit hot is no longer injected verbatim: the hook now injects an actionable oversize banner + a bounded excerpt (newest entries first, whole blocks, ≤ the 6 KiB budget; absolute cap 16 KiB whatever the override). Within-limits hots are injected verbatim as before. The hook still never MODIFIES the vault — the rewrite is the session's job. 3 new integration tests.
- **`hooks/hot-cache-update-prompt.mjs` — the guard now enforces SIZE, and its message stops feeding the ratchet.** Two independent violations, both scoped to vaults THIS session touched (a session unrelated to a vault is never blocked for inherited debt): STALE (wiki/ note written, hot not refreshed — as before, but the message now says "REWRITE the current state, don't just stack another entry", the very wording that manufactured the 129 KB file) and OVERSIZED (hot.md on disk exceeds its limits → the block demands `/obsidian-router:hot-compact`). Passing is stateless: a successful compaction brings the file under limits, so the next check clears — no receipt bookkeeping. Fail-open everywhere (unreadable hot → skip, never block).

Full suite: 2171 tests green (2142 + 29 new).

- TODO
## [0.43.0] — 2026-07-10 — `get_page_neighbors` A5: same-folder + shared-tag enrichment

### Added

- **`get_page_neighbors` — two opt-in structural enrichments: `includeSameFolder` and `includeSharedTags`.** The link-based neighbours (`neighbors[]`) only surface pages connected by an actual wikilink — but two pages can be obviously related without ever linking to each other: siblings filed in the same folder, or pages sharing a topical tag. Both signals were already sitting on every article node (`filePath`, `tags`) from the very first knowledge-graph build, so surfacing them costs zero extra graph traversal or network calls. `includeSameFolder: true` adds `sameFolderNeighbors[]` — other pages whose directory prefix matches the resolved page's. `includeSharedTags: true` adds `sharedTagNeighbors[]` — pages sharing at least one REAL tag (the universal `article` tag every page carries is excluded, or every page in the vault would "match" every other page), each entry listing which tags matched via `sharedTags`. Both are **off by default** (existing responses are unchanged), scoped to `article`-type pages regardless of the caller's `nodeTypes`, and capped/flagged the same way as the main neighbour list (`sameFolderTruncated`/`sameFolderTotalFound`, `sharedTagTruncated`/`sharedTagTotalFound`) — no silent truncation. Implements the **A5** appoint of the page-neighbors roadmap, the one item left over from W-A. TDD: 15 new tests (10 helper-level in `tests/graph-neighbors.test.mjs`, 5 tool-level in `tests/get-page-neighbors.test.mjs`); full suite green (2142). Validated end-to-end against the live vault graph (e.g. `Crawl4AI`'s one same-folder sibling, and its 50 tag-sharing pages via the near-universal `bilingual` tag — a useful reminder that shared-tag enrichment is only as discriminating as the vault's own tagging habits).

## [0.42.1] — 2026-07-10 — `docs/features/`: the feature guide, in prose, by category

### Added

- **`docs/features/` — a readable, categorized guide to every feature.** The README documents the whole surface in compact tables — fine as a reference card, hard to read when discovering the project or deciding *whether* a feature fits a need. The new folder reorganizes the same material into 13 category pages (multi-vault routing · read/search · write/edit · templates & Obsidian content · document conversion · web ingestion · wiki/knowledge management · knowledge graph · export/interop (OKF, llms.txt) · links & navigation · security & isolation · hooks · install & administration) plus an index. Every feature follows the same prose structure: **the need it answers → what it actually does → how to use it** (natural-language phrasing, slash command, and raw MCP-call JSON where useful) **→ gotchas** (prerequisites, known traps like the `patch_file` full-heading-ancestry rule or the `tp.mcpTools.prompt` Templater footgun). Written in French (the requesting user's language); an English mirror can follow the quick-reference precedent (`-en`/`-fr`) if needed. Both READMEs (EN + FR) gained a pointer callout next to the quick-reference-PDF one. Docs-only — no server or plugin code changed.

## [0.42.0] — 2026-07-09 — `wiki-neighbors` / `wiki-path` skills — natural-language discovery for the page-neighbors tools

### Added

- **Skills + slash commands for `get_page_neighbors` and `wiki_path`.** The two MCP tools shipped in v0.40.0/v0.41.0 were reachable only by a direct tool call — unlike their closest siblings `build_wiki_graph`/`build_wiki_tour`, which each ship a skill + `/obsidian-router:*` slash command with documented natural-language trigger phrasings. That asymmetry meant a user (or a fresh Claude session) had no discoverable "just ask" entry point into page-neighbourhood/path lookups. This release closes the gap: **`skills/wiki-neighbors/SKILL.md`** + **`commands/wiki-neighbors.md`** (triggers: "what links to X", "show me the backlinks of X" / "quelles pages sont liées à X", "voisins de X") and **`skills/wiki-path/SKILL.md`** + **`commands/wiki-path.md`** (triggers: "how is X connected to Y", "path between X and Y" / "quel rapport entre X et Y", "chemin entre X et Y"), following the exact `wiki-graph`/`wiki-tour` pattern (pre-condition check, ambiguity/not-found/no-path handling, wikilink-formatted output, "when not to use" + anti-patterns + quirks sections). README: two new rows in both the EN and FR "knowledge-management commands" tables (now 17, up from 15). No server code changed — this is a Claude Code plugin-only addition (skills/commands ship with the plugin, not with the `.mcpb` MCP-server bundle), so no MCPHub redeploy is needed for this release.

## [0.41.0] — 2026-07-09 — `wiki_path`: the shortest link chain between two pages

### Added

- **`wiki_path` — "how are page A and page B connected?"** The companion to `get_page_neighbors` (0.40.0): where that tool explores the neighbourhood of one page, this one finds the shortest chain of links **between two** pages and returns the route hop by hop — the "brain GPS" for a wiki. It reuses the exact graph-loading + page-resolution core W-A introduced, so both endpoints resolve the same three ways (exact path / bare name / unique suffix, ambiguity refused with candidates), and it reads the same persisted `wiki-meta/graph/knowledge-graph.json` (run `build_wiki_graph` / `/wiki-graph` first).

  Two semantics matter here and differ from `get_page_neighbors` on purpose. (1) Traversal is **undirected** — a link read either way still connects the two topics, which is the sensible reading of "how are these related?" (whereas neighbours care about link direction). (2) When the two pages are genuinely unconnected, that is **not an error**: the tool returns `found: false` with an explicit `path: null` — two pages can simply be unrelated. `maxDepth` (default 6, ceiling 20) bounds the search; a shortest path longer than it is reported as no path. `from === to` yields the trivial one-page path (length 0). By default the route runs through pages only (`nodeTypes: ["article"]`); widen it to e.g. `["article","entity","topic"]` for "connected via a **shared concept**" paths — often the interesting answer to "what relates A and B?" — with the endpoints always reachable regardless of their own type.

  The traversal (`computePath`, an undirected level-order BFS with parent reconstruction) shipped and was fully tested in 0.40.0's shared helper; this release adds only the thin tool shell (`src/tools/wiki-path.mjs`, same read-validate-delegate-sanitize shape as `get_page_neighbors`) plus its registration. TDD: 11 new tool tests (`tests/wiki-path.test.mjs`); Codex review verdict CLEAN; full suite green (2127). Validated end-to-end against the live vault graph (a real 2-hop route `project-router → Crawl4AI → license-audit`, the trivial self-path, and a `maxDepth: 1` boundary). Completes item W-B of the page-neighbors roadmap (W-C — semantically-enriched neighbours — stays deferred).

## [0.40.0] — 2026-07-09 — `get_page_neighbors`: query one page's neighbourhood in the graph

### Added

- **`get_page_neighbors` — ask the knowledge graph for the neighbours of ONE wiki page.** Until now there was no direct way to answer "which pages are related to X?": `get_wiki_context_pack`'s `graphNeighbors[]` only works off the pages a text query already surfaced (you can't point it at a specific page), and `build_wiki_graph` builds the whole graph but gives you no way to interrogate it locally. The new tool closes that gap — give it a page and it returns the pages that page links to (`forward`), the pages that link to it (`backward`, i.e. backlinks), or both, out to a configurable hop `depth`. It reads the **persisted** `wiki-meta/graph/knowledge-graph.json` that `build_wiki_graph` already wrote — deliberately NOT re-scraping wikilinks from page bodies the way `graphNeighbors[]` does — so it inherits the builder's ambiguity resolution and its backlink bookkeeping for free (run `build_wiki_graph` / `/wiki-graph` first; a missing graph yields an actionable "run it first" message, same as `build_wiki_tour`).

  Three design points earned during a second-pass review of the roadmap, and enforced in code: (1) the graph's `related` edges connect a page not just to other pages but also to the **concepts and claims** it mentions, so the tool filters by **node type** (`nodeTypes`, default `["article"]`) — otherwise "the neighbours of X" would return a mix of pages, concepts and sources; widen it (e.g. `["entity"]`) to instead ask "which concepts does this page mention?". (2) A crossroads page at depth 2 can fan out to hundreds of neighbours, so results are **capped** (`maxNeighbors`, default 50, hard ceiling 200) with a `truncated` flag. (3) An **ambiguous** page name (two `dup.md` in different folders) is **refused with the list of candidate paths** rather than silently resolving to the first — the deliberate difference from the builder's internal resolver, which must pick one to lay down an edge. Output is deterministic (sorted by hop distance then id) and carries `graphAnalyzedAt` so the caller can judge the graph's freshness. Read-only.

  The maths lives in a pure, dependency-injected helper (`src/helpers/graph-neighbors.mjs` — a directed BFS with visited-on-enqueue for minimal hop distances, edge-type + node-type filtering, and the three-step page resolver ported from `wiki-graph-builder.mjs`), with the tool shell (`src/tools/get-page-neighbors.mjs`) mirroring `build_wiki_tour`'s read-validate-delegate-sanitize shape. Because the neighbours query and the upcoming `wiki_path` query (roadmap W-B) share the same graph-loading + page-resolution core, the helper also lands its sibling `computePath` (an UNDIRECTED shortest-path BFS) now — fully tested here, exposed by the `wiki_path` tool in the next release. TDD: 46 new tests (`tests/graph-neighbors.test.mjs`, `tests/get-page-neighbors.test.mjs`); an adversarial Codex correctness pass caught and fixed a `computePath` node-type-filter edge case before ship; full suite green (2116). Implements item W-A of the page-neighbors roadmap.

## [0.39.0] — 2026-07-09 — `pdf_to_images`: render PDF pages for the model to SEE

### Added

- **`pdf_to_images` — render a local PDF's pages to PNG images, returned as MCP image content blocks so the model can visually SEE a page** (not just read its text via `pdf_to_markdown` / `pdf_to_markdown_docling`). Rendering uses **pypdfium2** (Google's PDFium, BSD — the engine behind Chrome's PDF viewer) + Pillow, deliberately NOT poppler (GPL system binary) or MuPDF (AGPL, incompatible with the router's Apache-2.0). Both packages already ship inside the opt-in `.venv-docling`, so a user who enabled Docling gets `pdf_to_images` for free; otherwise the tool returns an actionable install hint. Params: `filepath` (required), `first_page` (default 1), `max_pages` (default 8, hard cap 30), `scale` (default 2.0 ≈ 144 DPI, clamped 0.5–4.0). Because every rendered page is a base64 image billed against the model's context, the tool enforces hard page-count and per-image (12 MB) / total (24 MB) byte caps — refused BEFORE an over-cap file is read into memory (same discipline as Docling's on-disk output cap). **Core plumbing:** `wrapResult` now passes a ready MCP `{content:[…]}` payload through untouched (via the new `isMcpContentPayload`) instead of JSON-stringifying it — `pdf_to_images` is the router's first tool to return non-text (image) content; every existing text/object-returning tool is unaffected. New: `scripts/render-pdf-images.py`, `src/markdownify/pdf-images.mjs`, `pdfToImagesTool` in `src/tools/convert.mjs`, env var `PDF_IMAGES_PYTHON`. TDD: 24 new tests in `tests/pdf-images.test.mjs`; full suite green (2070). Implements the borrowings-roadmap §2.14 idea (pypdfium2, base64 delivery).

## [0.38.0] — 2026-07-09 — `build_wiki_graph`: layers are now Louvain communities

### Added

- **`src/helpers/louvain.mjs` — deterministic Louvain community detection.** A dependency-free, pure implementation of the Louvain modularity-maximisation algorithm (local-moving + aggregation levels) that partitions an undirected weighted graph into communities. It is built to be **byte-stable**: nodes are indexed in code-unit id order (not locale-sensitive `localeCompare`), edges are folded in a canonical `(min-endpoint, max-endpoint, weight)` order so parallel/mixed-orientation edges sum the same regardless of input order, and community-gain ties are broken toward *staying put* then by lowest index — no `Math.random`, no clock. Exposes `detectCommunities(nodeIds, edges, { resolution })` and a `modularity(...)` utility. Correctness (gain formula, the `2m` normalisation, the aggregation self-loop bookkeeping, and every determinism property) was verified across four adversarial Codex review passes. Tests: `tests/louvain.test.mjs` (23 cases, including the canonical two-triangles-with-a-bridge structure, weighted graphs, and order-independence).

### Changed

- **`build_wiki_graph` — `layers[]` now reflects the graph's real community structure, not the `index.md` sections.** Previously each `index.md` heading became one layer. That is a hand-written table of contents, and many nodes (entities, claims, sources, unlisted pages) landed in no layer at all — so it could not drive "colour by community" in the graph viewer, which needs every node assigned to exactly one group. The builder now runs Louvain over the whole graph and emits one layer per detected community, each named after its most-connected member (usually a topic or a hub page) and tagged `method: "louvain"`. **The `index.md` taxonomy is not lost** — it still produces the `topic` nodes and `categorized_under` edges it always did; the two groupings now coexist and complement each other (curated taxonomy vs. discovered clusters). Community detection stays fully deterministic, so the written `knowledge-graph.json` remains byte-stable for a given vault. `src/helpers/wiki-graph-builder.mjs` (new `buildLayers` helper + a `communityResolution` option, default `1`). Roadmap item #1 step 2.5 of the Understand-Anything borrowings.

## [0.37.1] — 2026-07-08 — Docling: placeholder image export (no base64 bloat)

### Changed

- **`pdf_to_markdown_docling` now defaults to `--image-export-mode placeholder`.** Docling's default (`embedded`) inlines every figure as a base64 data-URI: on an illustrated PDF the images dwarf the text and can blow the `MAX_OUTPUT_BYTES` cap for no readable gain — real case: a 4-page SVT course sheet → **3.3 MB output, 99.6% base64, for ~14 KB of actual text**. `buildDoclingArgs` now passes `--image-export-mode placeholder`, so each figure becomes a `<!-- image -->` marker and the same PDF yields **14.6 KB** of vault-friendly text (×228 smaller) — hierarchy, the comparison table (TableFormer), and UTF-8 accents all preserved. Externalizing images as files (`referenced` mode) stays out of scope: it would require persisting the output dir, which the single-file read-back in `readProducedMarkdown` does not do. New regression test in `tests/docling-markdownify.test.mjs`; `src/markdownify/docling.mjs`.

## [0.37.0] — 2026-07-07 — Docling opt-in high-fidelity PDF conversion

### Added

- **`pdf_to_markdown_docling` — opt-in high-fidelity PDF → markdown via Docling.** A new conversion tool (and `/pdf-to-markdown-docling` slash command) that runs [Docling](https://github.com/docling-project/docling)'s standard pipeline (layout detection + TableFormer table-structure recognition) instead of MarkItDown's `pdfminer.six` backend — reconstructing tables and reading order that MarkItDown loses (benchmarks: 88% vs 82% F1), at ~10× the CPU cost. **Opt-in and in-process**, mirroring the MarkItDown pattern: a *separate* `.venv-docling` is created at postinstall ONLY when `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` is set before install (or via `npm run install-docling`); `pip install docling` pulls ~1-2 GB of torch/onnxruntime + models. The tool is always listed — an uninstalled Docling yields an actionable call-time hint, never a startup failure. Scope is **PDF only** (DOCX/PPTX/XLSX/web keep MarkItDown, where Docling shows no advantage). New: `scripts/install-docling.mjs`, `src/markdownify/docling.mjs`, `resolveDoclingPath` in `src/markdownify/utils.mjs`, `pdfToMarkdownDocling` in `src/tools/convert.mjs`, `commands/pdf-to-markdown.md` + `commands/pdf-to-markdown-docling.md`, env vars `OBSIDIAN_ROUTER_ENABLE_DOCLING` / `DOCLING_PATH`. Tests: `tests/docling-markdownify.test.mjs` + `tests/install-docling.test.mjs`. Design spec: `docs/superpowers/specs/2026-07-07-docling-pdf-integration-design.md`.

### Fixed

- **`vault-link-linter` — wrong-port false positive on multi-vault path collision.** Pass 2 resolved the vault owning a click-to-open URL by **path only** (default vault first, then `portRegistry` insertion order). Scaffold paths (`wiki-meta/index.md`, `wiki-meta/log.md`, …) exist in **every** bootstrapped vault, so a perfectly correct URL was flagged `[wrong-port]` against whichever vault sorted first — with a suggested "fix" pointing at the **wrong vault's** port (incident 2026-07-06: a valid `http://127.0.0.1:27134/open/wiki-meta%2Findex.md` link to vault `RECHERCHES ETUDES SUP` was "corrected" to `27161`, the `.template` reference vault's port). The URL's port is now the primary disambiguation signal: new `findOwningVaults()` returns **all** owner vaults, and the URL is accepted if **any** of them actually serves the actual port for the scheme (`http` → `insecurePort` + `enableInsecureServer`; `https` → `port`). Only when no owner serves the port is the violation raised, with the suggestion built against the **first owner with a readable `data.json`** (not blindly the first owner — a registry-first vault like `.template` may have no Local REST API plugin configured at all). 5 new regression tests (`wrong-port multi-vault collision`), including the still-blocks guards (port matching no vault; port matching a vault whose insecure server is disabled; first owner missing `data.json` entirely). Adversarial multi-agent review of the fix confirmed one accepted tradeoff (documented in the hook's header): when a colliding path's URL port matches a *non-intended* owner vault, the link is now accepted rather than flagged — unavoidable without more context, and strictly better than resurrecting the original false-positive.

### Changed

- **Reference vault skeleton — richer default config (propagates via `meta-sync-template`).** `templates/reference-vault-skeleton/.obsidian/`: set a default theme (Blue Topaz / moonstone base) + reading-mode default (`defaultViewMode: preview`, `livePreview: false`), and enabled 6 UX community plugins in `community-plugins.json` (`realclaudian`, `image-converter`, `obsidian-icon-folder`, `recent-files-obsidian`, `rich-text-editor`, `obsidian-style-settings`). Dev-only plugins (`hot-reload`, `obsidian42-brat`) were deliberately excluded so they don't propagate to end-user/family vaults. New vaults provisioned from the skeleton — and existing vaults synced via `meta-sync-template` — inherit these.

- **Skills `write-*` / `manage-*` — concise "On failure" section (no silent FS fallback).** When a router call fails, the skill mandates remediation instead of a silent fallback to direct-filesystem tools: connection error (`ECONNREFUSED`/timeout) → `list_vaults` + **ask the user to open the vault** via the clickable `openUri` link and wait; validation/API error (HTTP 4xx, e.g. `invalid-target`) → fix the call or use a coarser ROUTER tool (`write_file`, `append_to_file`) — never `Read`/`Edit`/`Write` on the vault's real path. Applied to `write-patch`, `write-append`, `write-create-or-replace`, `write-frontmatter-set`, `write-frontmatter-merge`, `manage-move`, `manage-delete`. Each block is a tight 3-liner (imperative rule + the two failure classes); the full rationale and message template live once in the `default-vault-health-check` convention (canonical source) to avoid maintenance drift across the 7 skills. Requested by Roland 2026-07-05 after an FS-fallback incident in a DEDIBOX session.
- **Convention `default-vault-health-check` — new "Échec en cours de session" section (canonical source for the rule above).** The installable snippet covers mid-session failures with the two-class remediation (connection → open-the-vault prompt; validation → fix the call), the full rationale (FS writes bypass Local REST API, lose the authoritative `clickToOpenUrl`, skip the router guard rails), and a new anti-pattern line banning the silent FS fallback. The per-skill blocks point here.

## [0.36.0] — 2026-07-03 — Vault wizard W3: `meta-attach-vault` v2 (defaults-first) + harness-agnostic playbook

Layer 2 of the guided vault-creation wizard — the frontends. The wizard is now defaults-first end-to-end: compute a complete plan, show it in one line, accept as-is (happy path = 1 interaction) or adjust any single point, provision in one call.

### Changed

- **`meta-attach-vault` skill → v2 (defaults-first).** The workspace-first flow now calls **`plan_vault`** to compute the default plan + questionnaire, presents it as a one-liner ("Plan proposé: … · OK tel quel, ou ajuster ?"), collects only the adjustments the user wants (each point individually, the 5 wiki modes shown with their explanations), then provisions in ONE **`provision_vault`** call with `open: true` + `probe: true`. Preserves the existing didactics — git pedagogy, credential-safety rationale, the conventions picker, the workspace `.gitignore` edit — and adds the automated tail (programmatic Obsidian open + health probe). A `--dry-run`/CLI fallback keeps it working on older or gated routers where the tools are hidden.

### Added

- **`docs/vault-wizard.md`** — the harness-agnostic playbook: the manual an agent WITHOUT a skill system (Codex, Hermes, a raw MCP client…) reads to drive the same `plan_vault` → present → adjust → `provision_vault` flow. Documents the 5 wiki modes, the security gates (LOCAL-ONLY, path-restricted), the tool-input ↔ CLI-flag mapping, and the layer-0 fallback.
- **README** — a "Guided vault-creation wizard" callout in Prerequisites pointing at the skill, the playbook, and the CLI.

### Tests

- Docs/skill phase — no new engine code; full suite stays **1998** green.

## [0.35.0] — 2026-07-03 — Vault wizard W2: `plan_vault` + `provision_vault` MCP tools (harness-agnostic) + security gates

Layer 1 of the guided vault-creation wizard: the wizard becomes usable from ANY MCP client (Claude, Codex, Hermes, a raw MCP call…), not just the CLI. Both tools drive the SAME layer-0 engine (`scripts/setup-vault.mjs`), so there's one source of truth for provisioning.

### Added

- **`plan_vault` (read-only)** — returns the computed defaults + a structured questionnaire (the 5 wiki modes each with an explanation, the themes actually installed in the source vault, the registered vaults you can copy config from, the plugin profiles) + warnings + ordered steps, WITHOUT writing anything. Runs the engine in `--dry-run --json` and shapes the result. New `src/tools/plan-vault.mjs`. The wizard lives in this data — any harness LLM drives the conversation, then calls `provision_vault`.
- **`provision_vault`** — creates a vault in one call from a set of answers; returns a step report + `port`, `insecurePort`, `openUri`, `probeResult`. New `src/tools/provision-vault.mjs`. Shared engine bridge `src/helpers/vault-wizard-engine.mjs` (compose flags → spawn `setup-vault.mjs` → parse the `##PROVISION_RESULT##` marker the engine now emits on a real `--json` run).
- **`scripts/vault-plan.mjs`**: exported `WIKI_MODES` (the 5 modes + descriptions), `availableThemes`, `copyableVaults`; `buildProvisionPlan` now enriches `context` with `copyableVaults` + `availableThemes` for the questionnaire.

### Security (non-negotiable — spec §7.3)

- **Both tools are LOCAL-ONLY**: absent from the tool list AND refused at CallTool when `OBSIDIAN_ROUTER_USER_ID` is set (a gated MCPHub/Tribu deployment) — same pattern as the `MD_ALLOWED_PATHS` sandbox. `provision_vault` writes to the local filesystem, so it must never be reachable from a shared/multi-tenant router. New `LOCAL_ONLY_TOOL_NAMES` gate in `computeExposedTools` + the CallTool guard.
- **`provision_vault` refuses any target path outside the known vault roots** (config `vaultsRoot` + `portRegistry` roots) unless `allowOutsideRoots: true` — no remote-driven arbitrary `mkdir`/write. The gate reuses the engine's own `path-outside-known-roots` computation, so the CLI and the tool agree.
- **`--from-vault` credential exclusions** (`workspace.json` + secret `data.json` never copied, port + API key regenerated) apply regardless of the calling layer. `provision_vault` never wires the user's global `~/.claude/settings.json` hooks (`hooksWired: false`) — an MCP call must not silently mutate global config.

### Tests

- **`tests/plan-vault.test.mjs`** (3) + **`tests/provision-vault.test.mjs`** (6, incl. the path gate refuse+override, the gated-hidden gate, and a `--from-vault` secret-exclusion check). Full suite **1981 → 1990** green.

## [0.34.0] — 2026-07-03 — Vault wizard W1: engine flags (`--dry-run/--json`, `--name`, `--from-vault`, `--plugins`, `--wiki-mode`, `--claude-workspace`, `--open`, `--probe`, `--git-init`)

Layer 0 of the guided vault-creation wizard (spec + plan under `docs/superpowers/`). Every flag is ADDITIVE — a plain `setup-vault.mjs <path>` bootstrap is byte-identical to before (the entire prior test suite stays green).

### Added

- **`--dry-run [--json]`** — build the complete provisioning plan (resolved name/slug/path/source/plugins/theme/wiki-mode + ordered steps + warnings) WITHOUT touching the filesystem. New pure planning module `scripts/vault-plan.mjs` (`buildProvisionPlan`, `resolveSourceVault`, `resolvePluginProfile`, `knownVaultRoots`, `isPathWithinRoots`) — imported by the CLI and (next, W2) by the `plan_vault` MCP tool, so the wizard lives in the plan DATA, not any harness. `--json` emits the machine-readable plan consumed by the `meta-attach-vault` skill's pre-flight.
- **`--name "<Display>"`** — display name → lowercased slug; writes `vaultNames` when it differs from the path basename; the plan flags slug collisions against the registry.
- **`--from-vault <slug|path>` [`--with-folder-tree`]** — clone config ONLY from an existing vault (plugins, snippets, appearance, `.smart-env`, root `CLAUDE.md`). `workspace.json` and credentialed `data.json` are never copied; the REST API port + API key are always regenerated. `--with-folder-tree` recreates the source's `wiki/` folder tree EMPTY — structure without a single note.
- **`--from-skeleton`** — scaffold from the shipped skeleton + download the bridge (delegates to the existing `--bootstrap-reference` flow, whose distinct end-state — a skeleton to finish in Obsidian — is intentional: the skeleton ships no marketplace plugin binaries).
- **`--bare`** — minimal vault: the 2 REQUIRED plugins only.
- **`--plugins recommended|minimal|custom:a,b,c`** — plugin profile (default `recommended` = the source's enabled set, per the W0 derive-from-source refactor).
- **`--wiki-mode personal|research|business|code|domain` [`--wiki-sections "A,B,C"`]** — seed `index.md`/`overview.md` per mode. `domain` lays out the sections the frontend passes explicitly (engine stays 100% deterministic — no AI). No `--wiki-mode` → the generic template, unchanged.
- **`--claude-workspace`** — enable the router plugin in the bound workspace's `.claude/settings.json` (idempotent merge, preserves other keys; needs `--link-workspace`). Verifies the global marketplace registration read-only and guides the user rather than blind-writing global settings.
- **`--open`** — launch Obsidian on the new vault via `obsidian://open`.
- **`--probe [--probe-timeout N]`** — poll the REST port for a health verdict (non-zero exit if red; expected red until the user clicks "Trust author and enable plugins").
- **`--git-init`** — `git init` + initial commit inside the new vault (off by default — vaults often live on Google Drive / iCloud).

### Blocked / deferred

- **`--theme "<name>"`** is parsed and recorded in the plan but NOT applied — the `cssTheme` write lands with the in-flight Lot 2 Blue Topaz chantier. A real run warns rather than silently ignoring the choice.

### Tests

- **`tests/vault-plan.test.mjs`** (15) + **`tests/setup-vault-wizard-flags.test.mjs`** (16) — the latter includes a `--from-vault` security suite (zero secret copied, `workspace.json` excluded, no note content, folder-tree only with the flag) and a backward-compat plain-bootstrap proof. Full suite **1943 → 1974** green.

## [0.33.1] — 2026-07-03 — Vault wizard W0: clone `Documentation/` root docs + derive the plugin list from the source

Prerequisite fixes for the guided vault-creation wizard (spec `docs/superpowers/specs/2026-07-03-vault-wizard-design.md`, plan `docs/superpowers/plans/2026-07-03-vault-wizard.md`), landed as their own release before any wizard feature. No behavior change for existing invocations.

### Fixed

- **`cloneRootDocs` clones the reference's `Documentation/` folder.** The reference vault (`.template`) reorganized its human docs (quick-reference PDFs, `SETUP.md`, the vault-facing `CLAUDE.md`) from the vault root into `Documentation/`, but `ROOT_FILES_TO_CLONE` still listed the individual PDFs at root — so a fresh vault silently cloned only `.claude`. The list is now `['README.md', 'Documentation', '.claude']`: the reference's whole docs folder is cloned (the dir-aware recursive copy was already in place), `README.md` still covers the shipped skeleton (which keeps its README at root and has no `Documentation/`), and non-existent entries are skipped so the list is a safe union across source shapes.

### Changed

- **Plugin clone list is now DERIVED from the source vault's `community-plugins.json`.** New pure helper `scripts/plugin-resolver.mjs` (`resolvePluginsToClone(referenceVault, requiredPlugins)`) reads the reference's own enabled-plugin list and unions it with `REQUIRED_PLUGINS`. This replaces the hardcoded `OPTIONAL_PLUGINS`/`PLUGINS_TO_CLONE` constants, which drifted out of sync with the skeleton's `community-plugins.json` ("activated but never cloned" — plugins added to the skeleton were enabled but absent from the constant). Any plugin the reference enables now propagates automatically; `REQUIRED_PLUGINS` stays the only hard list (a physically-missing required plugin still fails loudly). `--sync-plugins` was already reference-dir-listing-based and is unchanged. The helper is a separate pure module (like `path-helpers.mjs`) so it is unit-testable without triggering `setup-vault.mjs`'s top-level CLI dispatch.

### Tests

- **`tests/setup-vault-plugins-derived.test.mjs`** (6 cases) + **`tests/setup-vault-root-docs.test.mjs`** (2 cases). Full suite **1935 → 1943** green — the entire prior suite stays green, proving zero behavior change for existing `setup-vault.mjs` invocations.

## [0.33.0] — 2026-07-03 — OKF interop: export any wiki subset as an Open Knowledge Format bundle + conformance validator

First brick of the OKF interoperability commitment (see the vault page `okf-interop`): Google's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) (spec v0.1) formalizes the Karpathy LLM-wiki pattern the router has implemented all along. Decision on record: **OKF is the exchange format at the edges** — the vault's internal structure (wikilinks, `wiki-meta/` scaffolds, newest-last log) never changes; everything the standard requires is regenerated at export time. Import (`mount`/`ingest`) and the headless-app integration are the next bricks.

### Added

- **`wiki-export --target okf`** — export a scoped subset of a vault's wiki as a conformant OKF v0.1 knowledge bundle under `wiki-meta/exports/okf/<name>/`, ready to `git init` + push and be consumed by any OKF-aware agent. New pure helper **`src/helpers/okf-bundle-exporter.mjs`** (`buildOkfBundle`, deterministic, injected clock): filename slugification to Google's reference-implementation charset (no spaces/accents — `Cours 2 - Réseaux.md` → `cours-2-reseaux.md`) with full link remapping; `[[wikilink]]`/`![[embed]]` → **relative** markdown links (the spec recommends root-absolute `/x.md`, but Google's own reference agent forbids leading `/` — we side with the implementation); frontmatter mapping emitting the **four keys Google's tooling requires in practice** (`type`, `title`, `description`, `timestamp` — the spec alone requires only `type`), `url`→`resource`, newest known date → `timestamp`, `description` synthesized from the first paragraph when missing, unmapped keys (e.g. `source_type`) preserved as legal OKF extensions; one `index.md` per directory grouped by `type` (`* [Title](file.md) - description`), bundle-root index carrying only `okf_version: '0.1'`; newest-first `log.md`; reserved-name (`index.md`/`log.md` as content pages, §3.1) and slug-collision renames; optional self-installing agent README (`--readme-agent`, the Cole Medin bundle pattern). Dangling links to non-exported pages are kept and reported — legal OKF ("not-yet-written knowledge", §5.3). Heading/block anchors and embeds are lossy conversions and are reported, never silent.
- **`wiki-lint --okf <path>`** — Check M: validate any bundle (our exports or third-party clones) against the spec's **three conformance rules** via the new pure helper **`src/helpers/okf-conformance-checker.mjs`** (`checkOkfConformance`). Google ships no standalone validator — this is one of the ecosystem's first. Severity calibrated to OKF's permissive-consumption philosophy: rule violations are errors; spec-by-example deviations (index heading level, bullet marker, log order) are warnings; reference-implementation compat gaps (filename charset, the 4-key requirement) are warnings/info.
- **Slash commands `/obsidian-router:okf-export` + `/obsidian-router:okf-check`** — thin dedicated entry points for the two flows above (exporting a bundle and validating one are distinct intents with their own arguments); the existing `/wiki-export` and `/wiki-lint` commands cross-reference them. Plugin surface: 38 → **40 commands** (README counts synced EN + FR).

### Tests

- **`tests/okf-bundle-exporter.test.mjs`** + **`tests/okf-conformance-checker.test.mjs`** (61 new cases), including the cross-check that every exporter-produced bundle passes the conformance checker with zero errors. Full suite **1838 → 1899** green.

## [0.32.0] — 2026-06-18 — Hot Reload propagation + `--force` preserves plugin `data.json`

The router half of the bridge v0.5.0 click-to-open foreground work: make pjeby's [Hot Reload](https://github.com/pjeby/hot-reload) propagate to vaults "like the bridge", so `deploy:all` live-reloads the bridge in every open vault with no manual "Reload app" per instance. Plus a `--force` data-loss fix surfaced by that work's `/review+`.

### Added

- **`hot-reload` in `OPTIONAL_PLUGINS`.** `setup-vault.mjs` now clones pjeby's Hot Reload from the reference vault (when present) and enables it in the target's `community-plugins.json`, exactly like the other optional plugins. Combined with the `.hotreload` marker the bridge's `deploy.mjs` drops into its own folder (bridge v0.5.0+), a Hot-Reload-equipped vault auto-reloads the bridge whenever its `main.js` changes on disk — i.e. on every `deploy:all`. Propagation rides the existing recursive plugin copy (`fs.cpSync`), which carries the dotfile marker. *Not* added to the shipped `reference-vault-skeleton/community-plugins.json`: Hot Reload is GitHub-only (not in the marketplace) and the skeleton ships no binaries, so a skeleton entry would just be enabled-but-absent; propagation is via the clone-from-reference path instead.

### Fixed

- **`setupVault` (`--force`) now preserves each plugin's `data.json`.** The full-bootstrap clone loop did a bare `rmSync` + re-clone with no preservation, so re-running `setup-vault.mjs <vault> --force` (a documented repair action) silently reset per-vault plugin settings to the reference's defaults. Now that the bridge's `data.json` holds real user settings (the v0.5.0 `foregroundViaProtocol` toggle, plus the presence heartbeat config), that clobber would lose them. The loop now reads → preserves → writes-back `data.json` on a `--force` re-clone for every non-credential plugin — matching what `syncPluginsMode` already did (the two paths had diverged). The REST API's `data.json` stays exempt (it's intentionally re-derived by the port/apiKey adoption logic). Caught by `/review+`.

## [0.31.3] — 2026-06-17 — doc-drift detector: hardening + a regression test that actually guards

`/review+` follow-up to v0.31.2 (Code Reviewer + codex). codex caught that the v0.31.2 regression test didn't actually test the fix.

### Fixed

- **`doc-drift-detector` gate hardened** — the `wiki/<projectSlug>/` existence check now also requires it to be a directory (`statSync().isDirectory()`, parity with `listCatalogBasenames`), and `detectDocDrift`'s JSDoc documents the early-return precondition.

### Tests

- **The v0.31.2 regression test now actually guards the regression.** Its fixture string accidentally contained the current version token (`v2.0.0`), so the old `index-version` regex matched it and the test passed even *without* the gate — testing nothing. The fixture is now version-token-free; **verified empirically** (gate disabled → test fails with the `index-version` issue; gate restored → green). Full suite 1838 green.

## [0.31.2] — 2026-06-17 — doc-drift detector: scope to vaults that document the project

### Fixed

- **`doc-drift-detector` no longer flags unrelated vaults.** The SessionStart `vault-doc-startup-check` reports the first candidate vault with drift; once the project's own vault was up to date, the loop fell through and the `index-version` check flagged an *unrelated* router-scaffolded vault (e.g. a TradingView vault) for "wiki-meta/index.md doesn't mention vX.Y.Z" — it never does, it has zero router content. The detector now gates on `wiki/<projectSlug>/` existing: a vault that doesn't host the project's wiki folder returns no drift. Checks #1/#3/#4 were already guarded by their project-specific pages existing; #2 (index) was the only leak. +1 regression test (`doc-drift-detector.test.mjs`).

## [0.31.1] — 2026-06-17 — youtube_to_markdown: yt-dlp caption fallback

### Added

- **`youtube_to_markdown` yt-dlp caption fallback** (`src/markdownify/youtube-fallback.mjs`). MarkItDown's YouTube path (page scrape + youtube-transcript-api) returns "fetch failed" on videos that DO have captions; on primary failure the tool now extracts captions via `yt-dlp` (`--skip-download`, native VTT/SRT, parsed in-process — no ffmpeg needed) and assembles a markdown transcript. Contract unchanged — plain markdown string, no vault writes (yt-dlp writes only to a private mkdtemp, cleaned up). New env vars **`YTDLP_PATH`** + **`OBSIDIAN_ROUTER_VIDEO_SUBLANGS`** (default `en.*,en`); the fallback degrades with a clear install hint when yt-dlp is absent.

### Security

- The yt-dlp fallback is bounded to real YouTube **video** URLs: it extracts a canonical 11-char video id and hands yt-dlp a freshly-rebuilt `https://www.youtube.com/watch?v=<id>` — **never the caller's raw URL**. This closes the SSRF surface (open-redirect `youtube.com/redirect?q=…`, query-param smuggling, playlist fan-out) that a host-only check would leave open. Subprocess hardening mirrors the existing converters: `execFile` (never `shell:true`), `--` separator, `maxBuffer`, `AbortSignal.timeout`, plus a 10 MB cap on the caption-file read (yt-dlp writes outside the stdout `maxBuffer`). Surfaced + closed across a 4-pass `/review+` (Code Reviewer + codex review).

### Tests

- **`tests/youtube-fallback.test.mjs`** (new, 23 cases — node:test + dependency-injection seams). Full suite **1814 → 1837** green.

## [0.31.0] — 2026-06-10 — Smart links: durable per-note links with device-side resolution

The multi-device answer to "which open-link do I give?" — local mirror vs streamed GUI. The server can never know which device will click (the same chat is read from a desktop with a synced mirror AND a phone), so the choice moves to click time: the router emits ONE stable https smart link per note; a tiny resolver page (private saas repo) probes the clicking device's OWN loopback for a live mirror (presence heartbeats from the bridge v0.4.0, replicated by LiveSync), falls back to an `obsidian://` deep link, then to the streamed GUI via the view-agent (tunnel mounted lazily at that moment). Full design: vault note `smart-link-resolver`.

### Added

- **`src/helpers/smart-link.mjs`** — HMAC-SHA256 token (`base64url(JSON{v,n,exp}) + '.' + base64url(sig)`, 30-day default TTL, timing-safe verify) + smart-link URL builder + `smartLinkEnabled(env)` gating on **`OBSIDIAN_ROUTER_SMART_LINK_URL`** + **`OBSIDIAN_ROUTER_SMART_LINK_SECRET`**. The token format is contract-pinned cross-repo (the resolver pins the same literal test vector; byte-exact + cross-verify proven at integration).
- **Smart link takes priority over the view-agent everywhere a `viewLink` is produced** (v0.29.0 write auto-injection + `open_in_obsidian` remote path): when configured, the `viewLink` field carries the smart URL with `viewLinkKind: 'smart'` — a pure local HMAC computation, **zero network call on writes** (faster, immune to a dead agent). Without the env vars, behaviour is byte-identical to v0.30.1 (`viewLinkKind: 'agent'` on the agent path). The `viewLink` field name is unchanged — zero breaking change for memory-directive consumers.
- **Boot-time warning when smart links are HALF-configured** (exactly one of the two env vars set — likely a typo): stderr notice instead of a silent fallback.

### Tests

- **`tests/smart-link.test.mjs`** (new) — build/verify round-trip, expiry/tamper rejection, strict canonical token shape (malleability hardening), URL shape, gating, and the pinned cross-implementation vector; plus smart-priority / never-throws / existence-check / env-off-regression coverage across **`tests/view-link.test.mjs`** and **`tests/open-in-obsidian.test.mjs`**. Full suite **1772 → 1814** green.

## [0.30.1] — 2026-06-09 — `open_in_obsidian`: honour the anchor contract on the remote view-link path

`/review+` follow-up to v0.30.0 (Code Reviewer + codex, convergent finding). The remote view-link path of `open_in_obsidian` silently dropped a requested `anchor`, even though the schema/description advertise heading scroll. An Obsidian heading is not deep-linkable through the tunnel (the GUI opens on the note), so the behaviour can't be honoured remotely — but it must not be silent.

### Fixed

- **`open_in_obsidian` no longer silently drops `anchor` on the remote view-link path.** It now echoes the anchor with **`anchorApplied: false`** (remote viewLink) / **`anchorApplied: true`** (local bridge navigate, when honoured) — a symmetric, predictable contract — plus a hint stating the note opens at the top. The tool description states the limitation. A comment documents the deliberate long timeout on the user-initiated view-agent call (allows a cold cloudflared tunnel; the eager write path uses a short timeout + circuit-breaker instead). **No behaviour change for the common no-anchor "show me a note" case.**

### Tests

- **`tests/open-in-obsidian.test.mjs`** — +1 (view-agent + anchor → `viewLink` + `anchorApplied:false`). Full suite **1771 → 1772** green.
## [0.30.0] — 2026-06-09 — `open_in_obsidian` returns a `viewLink` for remote-container vaults

Closes the READ side of the view-link story. The v0.29.0 `viewLink` auto-injection only fires on note WRITES; a pure "show me / open note X" is a read, so it produced no link — and in the field the AI reached for `open_in_obsidian` (browser-less local navigate), which can't work for a remote container vault (the user has no local Obsidian to raise) and gave up instead of falling through to `get_view_link`. Now `open_in_obsidian` itself returns a view-link when a view-agent is configured, so "show me a note" yields the link whichever of the two "open" tools the AI picks.

### Changed

- **`open_in_obsidian` returns a `viewLink` when `OBSIDIAN_ROUTER_VIEW_AGENT_URL` is set.** For a remote-container deployment it asks the view-agent for an ephemeral browser link to the live GUI on the note (the agent also navigates the container's Obsidian there) instead of the bridge `/open` navigate the user couldn't see. **Best-effort + non-breaking**: if the view-agent is unreachable it falls through to the original bridge navigate; with no view-agent configured the behaviour is byte-identical to before (local deployments unaffected). Uses the shared `fetchViewLink` (throwOnError:false). The tool description is updated so the AI knows it yields a link for remote vaults.

### Tests

- **`tests/open-in-obsidian.test.mjs`** — +2 (view-agent configured → `viewLink`, no bridge `/open`; view-agent unreachable → falls through to the bridge) + a `beforeEach` that clears the env so the existing bridge-path tests stay isolated. Full suite **1769 → 1771** green.

### Notes

- The deterministic complement to v0.29.0's write-time injection: writes fabricate the link in their result; "open/show" reads now fabricate it via `open_in_obsidian`. Both "open a note" tools (`get_view_link`, `open_in_obsidian`) now yield a view-link on a remote deployment — the user gets the link regardless of which one the AI reaches for.
## [0.29.0] — 2026-06-09 — deterministic `viewLink` on note writes (Option B) + view-link exposure gating

Makes the ephemeral read-link **deterministic**. Instead of relying on the AI to remember to call `get_view_link` (a prompt nudge that, in the field, the AI skipped — it told Roland "no public link" when `clickToOpenUrl` came back null for a remote vault), the router now **attaches a `viewLink` to the result of every note write**, server-side. The write *fabricates* the link; the AI only has to relay it. Born from Roland 2026-06-09 ("B même si transitoire je veux que ça fonctionne parfaitement"). Same view-agent transport as `get_view_link`; both now share `src/helpers/view-link.mjs`.

### Added

- **Deterministic `viewLink` auto-injection** on the 6 note-write tools (`write_file`, `append_to_file`, `patch_file`, `set_frontmatter`, `merge_frontmatter`, `move_file` — the `VIEW_LINK_TOOLS` set). A central hook in the CallTool dispatch (next to the audit-log block) calls `viewLinkForWrite({ vaultName: result.vault, note: result.to || result.path })` after a successful write and merges `{ viewLink }` into the result. **Never breaks a write**: gated by `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (silent + zero latency when unset), skips `wiki-meta/` housekeeping (no link, no wasted tunnel), and on a configured-but-failing agent returns a discreet `{ viewLinkError }` instead of throwing. Excludes `delete_file` (note gone) + non-note writes.
- **`src/helpers/view-link.mjs`** — shared transport. `fetchViewLink(...)` (pure, used by `get_view_link` with `throwOnError: true`) + `viewLinkForWrite(...)` (spread-ready `{ viewLink } | { viewLinkError } | {}`, never throws). `get_view_link` refactored onto it (no behaviour change).

### Changed

- **Exposure gating (geste 1 of the "provider model")** — `get_view_link` is now **hidden from ListTools when `OBSIDIAN_ROUTER_VIEW_AGENT_URL` is unset**, via the new pure, testable `computeExposedTools(tools, { readonly, viewAgentConfigured })` (which also subsumes the existing READONLY filter). A published router without the optional view-agent infra carries **zero dead/confusing view-link tool** — the feature is invisible until you bring your own provider. The router is coupled to a `/view` **contract**, not to any specific host.
- **`get_view_link` description broadened** so the AI reaches for it whenever the user asks for a link to read/see/open a note (not only right after a write), and is explicitly told that a null `clickToOpenUrl` (remote vault) means "call get_view_link", not "there is no public link" — the exact failure observed in the field.

### Tests

- **`tests/view-link.test.mjs`** (transport + `viewLinkForWrite` never-throws / gating / skip-wiki-meta) + **`tests/view-link-wiring.test.mjs`** (`VIEW_LINK_TOOLS` membership + `computeExposedTools` gating matrix). Full suite **1741 → 1761** green.

### Notes

- The companion view-agent's idle-timeout was raised (15 → 30 min) so consecutive writes in a conversation reuse a warm tunnel — only the first write of a cold conversation pays the ~15 s `cloudflared` cold-start. Deployment infra (Dedibox), not part of the npm package.
## [0.28.0] — 2026-06-08 — `get_view_link` tool — ephemeral one-click "view link" to a vault's live Obsidian GUI

New MCP tool `get_view_link({ vault?, note? })` that returns an ephemeral, ready-to-click browser link to **view** a vault's live Obsidian GUI, navigated to a specific note, with HTTP basic-auth baked into the URL (the user types nothing). The interim answer — before the headless web app's per-note magic-links — to Roland's "every memory the AI writes should come with a one-click read link" (2026-06-08). The router calls a small **view-agent** service (on the Dedibox, where the GUIs live) over WireGuard; the agent starts an on-demand `cloudflared` quick tunnel to the container's Selkies GUI, navigates Obsidian to the note (Local REST API `/open`), and returns the URL. Tunnels auto-close after an idle timeout, so the GUI is never permanently exposed.

### Added

- **`get_view_link` MCP tool** (`src/tools/get-view-link.mjs`). Read-only wrt vault content (it only spins a tunnel + moves the UI) → **excluded from `WRITE_TOOL_NAMES`** (stays exposed under `OBSIDIAN_ROUTER_READONLY`). Resolves the vault through the registry (honours the default-vault cascade), then issues `GET <agent>/view?vault=&note=`. Optional `note` opens the GUI on that file; omit `vault` for the default vault.
- **Two config env vars** (per router instance): `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (required, e.g. `http://10.8.0.1:27200`) and `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN` (optional shared secret, sent as `X-View-Token`). An unset URL makes the tool throw a clear "not configured" error rather than failing obscurely.

### Tests

- **`tests/get-view-link.test.mjs`** (8 tests, added to the `npm test` list) — happy path (vault/note query, auth-in-URL passthrough, idle-timeout echo), token header, trailing-slash base, and errors (unset config, non-string note, view-agent error status, unreachable agent).

### Notes

- The companion **view-agent** (python stdlib + `cloudflared`) runs on the Dedibox, bound to the WireGuard IP only, with cron `@reboot` + `*/2` crash-recovery. It is deployment infrastructure for the Tribu MCPHub instance, not part of the npm package.
## [0.27.0] — 2026-06-04 — rename `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` → `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK` (clearer; old name kept as a deprecated alias)

The v0.26.0 env var `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` was misleading on two counts: **"REQUIRE"** implied the WireGuard tunnel had to be *up* (it's a boot-time config check on the configured baseUrls, not a runtime probe), and the name hid that **loopback also passes** (so it's not "WireGuard-only"). Renamed to `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK`, which says exactly what passes. Born from Roland 2026-06-04 ("le flag REQUIRE_WIREGUARD n'est pas assez explicite, il m'a induit en erreur").

### Changed

- **Renamed `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` → `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK`.** Identical behavior (refuse to start if any *served* vault's `baseUrl` host is neither loopback nor in `10.8.0.0/24`). The boot error message + docstring now state it's a **config check that does not require the tunnel to be up**, and list loopback (`127.0.0.1`/`::1`/`localhost`) explicitly.
- **Backward-compatible alias.** The old `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` is still honored: `loadRegistry` reads `ENFORCE_WG_OR_LOOPBACK ?? REQUIRE_WIREGUARD` (new name wins when both are set). Using the old name logs a **one-time** (once-per-process) deprecation warning to stderr — latched so a `config.json` hot-reload doesn't re-spam it (review+ pass 1). **No existing deployment breaks.**

### Tests

- **`tests/vault-env-config.test.mjs`** — the global-guard tests migrated to the new name + 3 added (deprecated alias still triggers the guard; new name takes precedence over the alias; deprecation warning fires once per process, not on every reload). Full suite **1730 → 1733**.

## [0.26.0] — 2026-06-03 — global WireGuard enforcement (per-vault `wireguard` flag removed)

Replaces the per-vault `wireguard` boolean — wrong granularity (WireGuard is a *deployment-wide* invariant, not a per-vault attribute) and unused in production — with a **global boot-time enforcement**. Born from Roland 2026-06-03 ("on sait que dans MCPHub WireGuard doit être activé, point final"): a per-vault opt-in flag contradicts a uniform invariant. The `VAULT_*` descriptor now reduces to 3 fields (`name`/`baseUrl`/`apiKey`) on an MCPHub deployment — `tlsInsecure`/`https` only apply to the local-HTTPS-loopback case, not the http-over-WG hop.

### Added

- **`OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` env var.** When truthy (`true`/`1`/`yes`/`on`), `loadRegistry` **refuses to start** (throws, naming the offenders — baseUrl shown, never apiKey) if any *served* vault's `baseUrl` host is neither loopback (`127.0.0.1`/`::1`/`localhost`) nor inside the `10.8.0.0/24` WireGuard mesh. Fail-closed; loopback exempt (co-located vault transits no network); runs **after** the `OBSIDIAN_ROUTER_ALLOWED_VAULTS` whitelist (a non-WG vault filtered out doesn't trip it). Opt-in — unset = no enforcement, local mode byte-identical. Helpers `isTruthyEnv` + `hostIsWireguardOrLoopback` (exposed in `_internals`).

### Removed

- **Per-vault `wireguard` flag.** Dropped from the `VAULT_*` / `remoteVaults` descriptor and from `parseEnvVaults` (with its per-vault "host outside 10.8.0.x" warning). A leftover `wireguard` key in a JSON entry is now silently ignored. `scripts/gen-obsidian-deploy.mjs` no longer emits the field (the `wg`-mode `10.8.0.x` host validation stays — it keeps a generated `wg` baseUrl inside the mesh so it passes the global enforce).

### Tests

- **`tests/vault-env-config.test.mjs`** — per-vault-flag tests replaced by "leftover key ignored" + 4 global-enforcement integration tests (refuse on non-WG served vault, pass on WG/loopback, offender filtered by ALLOWED_VAULTS doesn't trip, unset = no-op) + unit tests for `hostIsWireguardOrLoopback` / `isTruthyEnv`. `tests/gen-obsidian-deploy.test.mjs` round-trip assertions updated. Full suite 1722 → **1728**.

## [0.25.0] — 2026-06-03 — hot-cache freshness GUARD (deterministic, default-on for all vaults)

Turns the `hot-cache-update-prompt` Stop hook from a soft *nudge* into a deterministic **guard**: if a session writes a note under a vault's `wiki/` but never refreshes that vault's `wiki-meta/hot.md`, the turn is **blocked (exit 2)** until hot.md is refreshed — so the recent-context cache stays current *by construction*. Same enforcement pattern as `vault-link-linter` / the user-level `chat-link-guard`. Born from Roland 2026-06-03 ("le hot doit toujours être à jour"): the nudge was advisory, so hot.md drifted stale whenever it wasn't acted on. The hook is already wired in the `Stop` event of every vault's `~/.claude/settings.json`, so the new behavior is **live for all vaults with zero re-wiring**.

### Changed

- **`hooks/hot-cache-update-prompt.mjs` rewritten as a blocking guard.** Was: `git diff`/`git log` detection + a stdout nudge (exit 0, never blocked). Now: **transcript-scoped** detection (this session's `tool_use` calls) + **exit 2** when a vault has a `wiki/` write but no `wiki-meta/hot.md` refresh. Transcript-scoped on purpose — git would also flag a *concurrent* session's uncommitted changes or a manual Obsidian edit (neither fixable by this Claude → false blocks), and Roland runs concurrent sessions on the same vaults; it also drops the git dependency. Trigger is `wiki/` **notes only** — pure `wiki-meta/` scaffold edits (index/log/overview) don't trigger, since the hot refresh is the satisfying action. **Per-vault**: each vault is judged independently; a vault whose root can't be resolved is skipped (fail-open). Recursion guard via `stop_hook_active`; opt-out `OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD=true`; fails **open** on any error. Filename + Stop-event wiring unchanged → no `settings.json` churn across the 10 deployed vaults.

### Added

- **`src/helpers/hot-staleness.mjs`** — pure, dependency-free classification logic (`extractWriteToolUses`, `classifyToolUse`, `pathKind`, `findStaleVaults`). All I/O (router config, platform) is injected by the hook, so the decision layer is unit-tested without touching the filesystem or spawning a subprocess.

### Tests

- **`tests/hot-cache-guard.test.mjs`** (29 tests) — pure layer (write-tool detection incl. MCPHub-namespaced names, path kinds, per-vault staleness, built-in `Edit` ↔ MCP cross-matching on the same vault, Windows case-insensitive root matching, unresolvable-vault fail-open) + the hook end-to-end via `spawnSync` (exit 2 on stale, exit 0 on refreshed / scaffold-only / opt-out / recursion-guard / no-transcript). Full suite 1680 → **1709**.

## [0.24.0] — 2026-06-02 — `open_in_obsidian` tool (browser-free "open this note")

A new MCP tool that opens a note in the running Obsidian — and raises its window — **without a browser**. Born from a long click-to-open debugging session: in **Claude Desktop**, every clicked link is routed through a `claude.ai` proxy that opens it in a browser tab, so a click-to-open *link* can never be browser-free there. Calling the bridge server-side sidesteps that entirely.

### Added

- **`open_in_obsidian(vault?, path, anchor?)`** (`src/tools/open-in-obsidian.mjs` + `openInObsidian` in `src/rest-client.mjs`). Calls the bridge plugin's public `/open` route **server-side** (router process → loopback HTTP → bridge), so Obsidian navigates to the file and the bridge raises its window with **zero browser involved**. The browser-free counterpart to a click-to-open *link*: clients that proxy clicked links through a browser (notably Claude Desktop) can't avoid a browser tab on an http link, but this tool never touches it. Works the same in Claude Code CLI and Claude Desktop (both speak MCP). Optional `anchor` scrolls to a heading (same `?h=` mechanism as click-to-open, reusing `encodeVaultPath` + `normalizeAnchor`). **Navigation-only** (no content write) → allowed under `OBSIDIAN_ROUTER_READONLY`. Requires `mcp-router-bridge` ≥ 0.2.0 + Obsidian running for the vault; a missing file / down Obsidian surfaces a categorized tool error. MCP tool count 34 → 35.

### Tests

- **`tests/open-in-obsidian.test.mjs`** (7 tests) — a local HTTP server records the request target; asserts the tool fires `GET /open/<encoded-path>` (+ `?h=<heading>` when an anchor is given, leading `#` stripped, whitespace→none), validates `path` / `anchor`, and propagates an unreachable-Obsidian error.

## [0.23.0] — 2026-06-02 — `log-discipline` convention (thin log index + `Sessions/` detail)

A convention/docs release. Adds an installable convention that codifies the **thin-index** model for `wiki-meta/log.md`: every entry is a short bilingual summary linking to a detailed journal in `wiki-meta/Sessions/`, instead of multi-paragraph detail pasted under a log `## H2`. No `src/` runtime change.

### Added

- **`log-discipline` installable convention** (`skills/conventions/snippets/log-discipline.md`, id `log-discipline`; install per-vault via `/obsidian-router:conventions install log-discipline`). Codifies: a log entry is `## YYYY-MM-DD — <topic> · [[YYYY-MM-DD-<slug>]]` + a one-sentence FR/EN lead; the full detail lives in `wiki-meta/Sessions/<date>-<slug>.md` (frontmatter `type: session-log`, ending in `## Voir aussi / See also`); append-only, **newest at the bottom**. It documents that the `session-auto-journal` hook and `/save` already emit thin entries — the only behaviour it corrects is Claude pasting fat multi-paragraph detail under a log `## H2`. The `skills/conventions/SKILL.md` mapping table grows 10 → 11.
- **Wiki scaffold `templates/wiki-meta/log.md` now documents the curated `## H2` milestone format.** New vaults bootstrap with a note describing the thin-`## H2` + `Sessions/`-link model alongside the one-line operation log, and point at the `log-discipline` convention.

### Fixed

- **`bump-version.mjs` now syncs the README version badge too.** The shields.io badge in `README.md` (EN + FR) drifted repeatedly — stuck at v0.10.3, then v0.19.1, while `package.json` moved on — because `npm run bump` only rewrote the three JSON version files and the badge had to be hand-edited (and was forgotten). The bump script now treats the README badge as a fourth target via a dedicated, idempotent `updateReadmeBadge()` that **throws if the badge is missing** (so a rename surfaces loudly instead of silently no-op'ing). Re-synced the badge to the current 0.22.0. +7 tests in `tests/bump-version.test.mjs`.

## [0.22.0] — 2026-06-02 — click-to-open heading anchors (`build_open_link` `anchor`)

Deep-linking for click-to-open: a generated link can now land on a specific heading inside a note and surface it in the file tree. Pairs with **bridge plugin v0.3.0** (which reads `?h=` and runs the treeview reveal). Router-side this is purely additive — links without an anchor are byte-identical to before.

### Added

- **`build_open_link` — optional `anchor` (single mode).** Pass `anchor: "Installation"` → the tool emits `…/open/<path>?h=Installation`; the bridge (≥ 0.3.0) scrolls to that heading on open and reveals + selects the note in the file-explorer tree. **Read-only** — Obsidian headings are their own anchor, nothing is written into the note. Leading `#` optional; spaces/accents URL-encoded; the anchor travels as a **query param** (a `#fragment` is never sent to the server). Rejected with `paths` (an anchor is per-target). Result echoes the normalized `anchor` and the `clickToOpenUrl`/`markdownLink` carry the `?h=`.
- **`buildClickToOpenUrl(vault, path, { anchor })` + exported `normalizeAnchor()`** (`src/helpers/click-to-open.mjs`). The shared helper (used by every write/get/patch tool's `clickToOpenUrl` field) gained `opts.anchor`; fully backward compatible — no opts → identical URL.

### Fixed

- **`vault-link-linter` tolerates anchored URLs.** The wrong-port pass now splits the `?h=` query before resolving the file — otherwise an anchored URL never resolved to a real file and its port was silently left unchecked — and PRESERVES the anchor in the suggested correction.
- **Markdown-safe URL encoding (`encodeUriMarkdownSafe`).** `encodeURIComponent` leaves `(` / `)` literal, so a heading like `Step 1) Setup` — or a pre-existing file named `foo (draft).md` — produced a `markdownLink` whose `[..](..)` destination terminated early at the `)`. Both parens are now percent-encoded (`%28`/`%29`) in `encodeVaultPath` (fixes the pre-existing path case too) and in the anchor; the linter's `composeSuggestion` mirrors it. Transparent server-side (`decodeURIComponent`), byte-identical for paren-free paths (codex review finding).

### Tests

- +18 across `tests/click-to-open-helper.test.mjs`, `tests/build-open-link.test.mjs`, `tests/vault-link-linter.test.mjs` (anchor encoding, `#`-strip, whitespace→no-query, batch rejection, backward-compat, and wrong-port-with-anchor preservation). Full suite: **1662 green**. The companion bridge v0.3.0 adds its first 13 tests (`parseOpenParams`).

## [0.21.1] — 2026-06-02 — linter catches bare relative vault paths; `--tls-insecure` generator flag

A hooks + tooling release. Headline: a **fix to the `vault-link-linter` Stop hook** so it finally catches the bare-relative-path class of broken vault link — the recurring "you wrote `` `wiki-meta/index.md` `` and it renders as a dead `<cwd>/wiki-meta/index.md` link" bug. Plus the previously-unreleased `--tls-insecure` generator flag. `src/` runtime is untouched.

### Fixed

- **`vault-link-linter` (Stop hook) now catches BARE RELATIVE vault paths** — the exact class of broken link reported repeatedly. The linter previously flagged only markdown-link hrefs (`[x](wiki/y.md)`, the `bare-path` kind) and absolute cwd+vault phantom paths (`cwd-vault-mix`); a **bare relative token** like `wiki-meta/index.md` slipped through twice over: (a) `stripCode()` deleted inline-code spans *before* any detection ran, so the dominant backtick-wrapped form was invisible, and (b) no pass scanned bare relative tokens. Yet the Claude Code renderer clickifies such tokens against the workspace **cwd**, so in workspace-bound mode (cwd ≠ vault) they render as a dead `<cwd>/wiki-meta/index.md` link. New **Pass 4 (`bare-vault-path`)** scans both inline-code spans and bare prose for `wiki/`- and `wiki-meta/`-prefixed relative `.md` paths and blocks (exit 2) when the path resolves to a real file in a vault **other than the cwd**. Three gates keep it zero-false-positive: *resolves-to-a-real-vault-file* + *vault-is-not-the-cwd* + *not-a-real-local-file* — so repo files (`README.md`, `src/x.mjs`), fenced code examples, and cwd-is-vault mode are all left alone. The hook's `build_open_link` companion (and the MCP write/get/patch tools' `clickToOpenUrl` field) give the correct URL to emit.

### Added

- **`gen-obsidian-deploy` — `--tls-insecure` flag.** The generator now emits `tlsInsecure: true` into the `VAULT_*` line on request (default stays `false` = verify). For an `https` baseUrl served behind a self-signed / internal-CA cert the router can't validate — e.g. a self-signed nginx placed in front of the REST API. The router already honored `tlsInsecure` on `VAULT_*` entries (v0.20.0); previously the generator hard-coded `false`, so this exposes the existing capability. Round-trips through `parseEnvVaults` (asserted in tests).

### Tests

- **`tests/vault-link-linter.test.mjs`** — +11 cases for the new `bare-vault-path` pass: backtick-wrapped + bare-prose detection, the wrong-prefix / fenced-code / cwd-is-vault / non-resolving exemptions, no-double-flag-with-Pass-1, dedupe, and the exact 2026-06-01 backtick-wrapped `wiki-meta/` regression. Full suite: **1644 green**.

## [0.21.0] — 2026-06-01 — deploy generator for Obsidian-on-host containers (vault-hosting Phase 1)

A tooling-only release: a generator that turns one vault descriptor into the artifacts needed to run that vault as a `linuxserver/obsidian` (Selkies) container on a host (e.g. the Dedibox) and wire it back to the router via a `VAULT_*` env line. Pure functions, fully tested, **secret-safe**. No runtime/router behavior changes — `src/` is untouched, so this is additive and risk-free for existing deployments. Groundwork for the vault-hosting roadmap (Obsidian-in-browser via Selkies + Sealskin, replacing the old xrdp/Guacamole plan).

### Added

- **`scripts/gen-obsidian-deploy.mjs`** — generates, from one vault descriptor: (1) a docker-compose **service** (`linuxserver/obsidian`, `/config` = plain-markdown vault, `shm_size: 1gb`, optional hardening that disables the in-GUI terminal/sudo); (2) an **nginx GUI reverse-proxy** block (any mode, WebSocket upgrade, per-mode IP ACL, always-present cert directives) for the Selkies web viewer, plus an **nginx REST proxy** in `public` mode; (3) the **`VAULT_<NAME>=<JSON>`** env line for the router. **Network model:** the REST port is published on the interface the router actually uses — `wg`→the WireGuard host, `lan`→the LAN host (both reached directly, no nginx for REST), `public`→loopback (nginx + Let's Encrypt proxies it). The GUI host port is **unique per vault** (`guiPort`, default `restPort+1000`) so vaults don't collide on `:3001`. nginx→container uses a **resolver-variable `proxy_pass`** (self-heals on container IP-shuffle — the 502 class from the 2026-05-29 incident). **Security guard:** a `--sensitive` vault may only be `--mode wg` (refuses `public` AND `lan`). **Secret-safe:** `apiKey`/`password` default to `<token>`/`<password>` placeholders — never invented, never logged into the notes. Pure functions + a CLI.
- **`deploy/dedibox-obsidian/`** — deploy scaffold: a README runbook (network model, deploy steps, LiveSync **Setup URI** onboarding for pushing a local vault → CouchDB, the E2EE↔viewer tradeoff, acceptance test, rollback), `.env.example`, and committed example outputs (`tribu` wg, `coursera` public).

### Tests

- **`tests/gen-obsidian-deploy.test.mjs`** (56 tests) — validation (incl. the sensitive+public AND sensitive+lan refusals, derived-guiPort range check), per-mode baseUrl/bind/nginx/compose coherence, GUI-port uniqueness, YAML magic-scalar quoting, CLI `--no-harden`, `renderPlanText` (no literal `null` block in wg/lan), secret-safety across compose+nginx, and the headline guarantee: **the generated `VAULT_*` line round-trips through the router's real `parseEnvVaults`** (registry.mjs), so the generator can't drift from what the router accepts. Full suite: **1630 green**.

### Notes

- Shaped by an in-repo `review+` pass (Code Reviewer + codex). Fixes applied before first publish: REST baseUrl/bind coherence per mode (a loopback bind with a WG/LAN baseUrl would have been unreachable), always-emit nginx cert directives (so blocks are `nginx -t`-loadable), per-mode GUI ACL, unique GUI host port, the `sensitive`-requires-`wg` guard, and the `--no-harden` CLI flag.

## [0.20.0] — 2026-05-31 — `VAULT_*` dashboard config, structured errors, MCP Resources

Three additive, opt-in steps toward an MCPHub-editable, more MCP-mature router (Phases 1-3 of the `router-saas` roadmap). All backward-compatible: with no `VAULT_*` env var set, the registry behaves byte-identically to 0.19.x — local mode is untouched.

### Added

- **`VAULT_*` env-var vault config — a 3rd config source** (`src/registry.mjs`). One env var per vault, `VAULT_<NAME>=<JSON>`, editable directly from the MCPHub server's Environment Variables UI — no more SSH + `config.json` edit. Required: `name`, `baseUrl`, `apiKey` (the **bare token**; the router adds `Authorization: Bearer ` itself). Optional: `description`, `wireguard`, `tlsInsecure`, `timeoutMs`. Merged after `portRegistry` + `remoteVaults`; a `VAULT_*` entry **overrides** any same-name vault from those sources (the existing portRegistry-vs-remoteVaults order is untouched). Defensive + non-fatal: a malformed entry is skipped with a clear stderr warning naming the faulty key — one bad var can't take down the other vaults. **Security:** on a JSON-parse failure neither the raw value nor the parser's error message is logged (both can echo the `apiKey`); on a missing-field failure the parsed object is redacted via `redactSecrets()`. A `wireguard:true` vault whose `baseUrl` host is outside the `10.8.0.x` WireGuard range raises a warning. `VAULT_PATH` is excluded from the scan (it's the tier-2 default-vault hint, not a vault config).
- **Structured tool errors — `errorCategory` + `isRetryable`** (`src/error-classify.mjs`, wired into `src/index.mjs`; MCP standard #4). Every tool error result now carries a machine-readable classification in `_meta` (and `Category:` / `Retryable:` lines in the readable text): `transient` (unreachable / timeout / 5xx → retryable), `permission` (401 / 403 / Cloudflare Access / read-only / vault lock), `validation` (404 / 409 / unknown vault), or `unknown`. Lets an agent auto-retry a transient WireGuard drop instead of failing the whole call.
- **MCP Resources** (`src/resources.mjs`; MCP standard #6). Declares `capabilities.resources` and adds `ListResources` / `ReadResource` handlers exposing the wiki catalogue **read-only**: per active vault, `wiki-meta/index.md` + `wiki-meta/overview.md`, plus a synthetic router-wide `obsidian-router://_catalog` (vault names + type + baseUrl — **never** apiKeys). URI scheme `obsidian-router://<vault>/<id>`. Read-only by nature → safe on `OBSIDIAN_ROUTER_READONLY=true` instances. Cuts agent discovery cost versus looping `list_files` / `list_vaults`.

### Tests

- `tests/vault-env-config.test.mjs`, `tests/structured-errors.test.mjs`, `tests/mcp-resources.test.mjs` — parse / merge / override / retro-compat, the full `kind` → category taxonomy, and resource URI / list / read logic.

## [0.19.1] — 2026-05-30 — fix: `build_open_link` schema 400'd the Anthropic API (top-level `oneOf`)

`build_open_link` shipped (v0.14.9) a top-level `oneOf` in its `input_schema` to encode the `path` xor `paths` contract. It's valid JSON Schema, but the **Anthropic Messages API rejects `oneOf` / `allOf` / `anyOf` at the top level of any tool's `input_schema`** — even alongside `type: object`. Any client that inlines the full router catalogue into a `tools` request (e.g. **MCPHub**) therefore got a hard `400 tools.<N>.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`, failing the whole request. Direct Claude Code sessions were unaffected — MCP tools are loaded on demand there, so the schema is never inlined.

### Fixed

- **Removed the top-level `oneOf` from `build_open_link`'s `input_schema`** (`src/index.mjs`). The `path` xor `paths` mutual exclusion is unchanged — it was already enforced at runtime (`src/tools/build-open-link.mjs` rejects both/neither with a clear error) and documented in the tool description. Only the redundant, API-incompatible schema-level encoding is gone.

### Added

- **Catalogue-wide regression guard** (`tests/tools-click-to-open-integration.test.mjs`) — replaces the old `build_open_link`-specific `oneOf`-presence assertion with a programmatic check over `_internals.TOOLS` asserting that **no** tool's `input_schema` carries a top-level `oneOf` / `allOf` / `anyOf`. Composition keywords nested inside a property (e.g. `patch_file`'s `content.oneOf`) remain allowed — only the schema root is checked.

## [0.19.0] — 2026-05-29 — self-healing session reconciliation (log.md ↔ Sessions/ no longer depends on SessionEnd)

Fixes a structural desync between the per-session journal (`wiki-meta/Sessions/*.md`) and the chronological `wiki-meta/log.md`: sessions whose **`SessionEnd` hook never fired** (terminal closed abruptly, process killed, crash, OS shutdown — Claude Code does not guarantee `SessionEnd`) were left `status: open` forever with **no log.md line**, while every cleanly-closed session had one. Reported on a real vault with 27 session files: all 16 `closed` had a log entry, all 11 `open` did not. The old `backfill-log-from-sessions` script couldn't repair them either — it skipped any non-`closed` session.

Root cause: the per-session closure (status flip, recap, **log.md append**) lived **only** in the `SessionEnd` handler. The fix stops depending on a single fragile event.

### Added

- **`hooks/_helpers/session-reconcile.mjs`** — shared, self-healing reconciliation routine (`reconcileVaultSessions`), the single source of truth used by both the hook and the backfill script. For each stale, non-live **open** orphan it closes the journal in place (`status: closed` + a `## Recap (reconciled — no SessionEnd)` block + `ended-at` + `closed-by: reconciliation`, best-effort counts from the lingering state JSON, else reconstructed from the file body) **and** backfills its `log.md` line. It also backfills **closed-but-unlogged** sessions (the pre-v0.12.8 case). Idempotent (dedup by `[[basename]]`); already-logged files are fast-skipped without even being read, so a healthy vault adds ~zero startup cost.
- **`session-auto-journal` now self-heals on every `SessionStart`.** After ensuring the current session's journal it reconciles prior orphans for the associated vault. The per-session closure + log line therefore no longer require `SessionEnd` to fire — the *next* session start cleans up whatever the last crash left behind. Applies to all existing and future vaults (they share the one global hook).
- **`backfill-log-from-sessions.mjs --include-open`** — explicit one-shot repair for existing vaults: reconciles orphaned open sessions in addition to the default closed-only log backfill. `--all --include-open` sweeps every configured vault. New `--live-window-minutes N` tunes the liveness guard.
- **`OBSIDIAN_ROUTER_SESSION_LIVE_WINDOW_MIN`** (default `120`) — env override for the liveness window in the hook.

### Fixed

- **Orphaned `open` sessions are now closed + logged** instead of accumulating silently. A **liveness guard** (the session's state-JSON mtime) prevents clobbering a session still running in another terminal: an open session whose state JSON was touched within the live window (default 120 min) is left alone, and the *current* session is additionally protected by path. Truly-dead orphans (stale or no state JSON) are reconciled.

### Notes

- Reconciliation operates only on `type: session` files (the auto-journal output); manual `/save` documents under `Sessions/` carrying other types are never touched. Backfilled log lines are tagged `<!-- backfilled YYYY-MM-DD -->`; auto-reconciled ones via the hook are tagged `<!-- reconciled YYYY-MM-DD (no SessionEnd) -->`.

## [0.18.2] — 2026-05-29 — bootstrap auto-wires hooks (no more dormant guards)

Follow-up to 0.18.1 that removes the *deeper* root cause behind the recurring phantom-link bug: the deterministic guards shipped on disk but stayed **dormant** until someone ran `--install-hooks` by hand — an opt-in, skippable step. A `vault-link-linter` / `wiki-query-first-nudge` that isn't wired catches and prevents nothing.

### Changed

- **`setup-vault.mjs <vault>` now auto-wires all router hooks** into `~/.claude/settings.json` at the end of a *successful* bootstrap (covers the one-shot `<vault> --link-workspace <ws>` attach too). Idempotent (skips already-present hooks → no churn on re-bootstrap), best-effort (a missing `hooks.example.json` or unwritable `settings.json` **warns** but never aborts the completed bootstrap), and only runs on success (an unsafe-target refusal exits earlier, so nothing is wired for a failed run). The standalone `--install-hooks` subcommand stays the explicit path for re-wiring / `--select` subsets; a standalone `--link-workspace` re-link is intentionally NOT covered (its vault was already wired at its own bootstrap).

### Added

- **`--no-hooks` flag** (and `OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS=1` env) to opt out of the auto-wiring.

### Fixed

- **CI green again on Linux + the GitHub Windows runners.** Three test-only portability bugs reddened CI (run [#26660425820](https://github.com/tboome33/obsidian-mcp-router/actions/runs/26660425820): 11 failures on `windows-latest`, 1 on `ubuntu-latest`) while passing on the dev box — `core.autocrlf=input` gives an LF checkout, plus a pre-existing `C:\tmp` directory; the third only manifests on POSIX. `tests/` only — no product behavior change. (Commit `ba1941a`, shipped ahead of the feature above in this same release.)
  - `tests/download-page-assets.test.mjs` — the `html branch end-to-end` and `v0.14.7 defuddle-first` blocks hardcoded `C:\tmp\…` as the download `outputDir`. `downloadAssets` requires the outputDir's *parent* to already exist (it refuses to bootstrap arbitrary trees), and `C:\tmp` is absent on the GitHub Windows runner. Switched both to `path.join(os.tmpdir(), …)`, whose parent is guaranteed to exist on every runner.
  - `tests/tools-click-to-open-integration.test.mjs` — the `build_open_link` schema test's block-boundary regex ended in a bare `\n`, which cannot match `},\r\n` on a CRLF (`autocrlf=true`) Windows checkout, so the tool block was "not found". Normalize CRLF→LF before matching.
  - `tests/vault-link-linter.test.mjs` — the "exact Roland 2026-05-29 path shape" regression hardcoded a `\`-separated path that is only meaningful on Windows; on POSIX a literal `\` is a filename char, so the linter (correctly) didn't flag it and the test wrongly expected exit 2. Build the incident path with the platform's own separators — the real mixed-separator repro on Windows (where the incident happened), the POSIX-native equivalent on Linux.

### Docs

- **meta-setup skill**: corrected the stale "**6 hooks**" → **9 hooks** (added the missing `session-auto-journal`, `vault-doc-startup-check`, `wiki-query-first-nudge` rows + fixed `wiki-autocommit`'s matcher count to 8), and documented the new auto-wire-at-bootstrap default.

## [0.18.1] — 2026-05-29 — fix: `vault-link-linter` catches cwd+vault "phantom" paths

Patch. The `vault-link-linter` Stop hook gains a **third violation kind**, `cwd-vault-mix`, closing the blind spot behind a recurring broken-link bug. In workspace-bound sessions, Claude would emit an absolute path that concatenates the workspace cwd with a vault-internal subpath — e.g. `I:\DEVELOPPEMENT\obsidian-mcp-router\wiki\…\graph-viewer-survey.md` — a phantom that does not exist, because the vault lives at a *different* absolute root (`C:\VAULTS\opsidian-mcp-router et bridge`). The two share near-identical basenames (`obsidian-mcp-router` vs `opsidian-mcp-router et bridge`), which is what made the confusion sticky. (Reminder: the hooks only fire once wired into `~/.claude/settings.json` via `node scripts/setup-vault.mjs --install-hooks` — a dormant linter catches nothing.)

### Fixed

- **`hooks/vault-link-linter.mjs` — new `cwd-vault-mix` detection.** Pre-0.18.1 these paths slipped through twice over: an absolute Windows path's drive letter (`I:`) reads as a URL scheme so the bare-path pass skipped it, and prose tokens outside markdown links were never scanned at all. The new pass re-scans BOTH markdown-link hrefs AND bare prose for absolute paths, gated by four zero-false-positive conditions — (1) resolves under the workspace cwd, (2) first segment below the cwd is `wiki`/`wiki-meta`, (3) does NOT exist on disk, (4) the vault-relative tail DOES resolve to a real file in an active vault — and emits the correct click-to-open URL. Absolute links to genuine non-vault files (`C:\Users\me\notes.md`) and real local files under the cwd are left untouched. The candidate scan runs *before* the "no candidates → exit" guard so it isn't short-circuited by Pass 1/2 finding nothing.
- **+8 tests** — markdown-link + bare-prose phantom blocking, link/bare dedup, the exact incident path shape (mixed separators), and the four negative gates (tail unresolved, non-wiki segment, different root, real local file).

## [0.18.0] — 2026-05-29 — guided tours (`build_wiki_tour` + `/wiki-tour`)

Understand-Anything borrowings, roadmap item #3. Generates a **guided, pedagogical reading tour** through a vault from the knowledge graph's link topology — an ordered walkthrough that takes a newcomer from "what is this?" to "I get how it fits". Same deterministic-core / LLM-narrate split as #1: the step ordering is deterministic; Claude writes the per-step narrative. Backward compatible (purely additive: one new read-only tool + one new skill + one new helper).

### Added

- **`build_wiki_tour` MCP tool** (`src/tools/build-wiki-tour.mjs`) — **read-only** (NOT in `WRITE_TOOL_NAMES`). Reads `wiki-meta/graph/knowledge-graph.json` (from `build_wiki_graph`) and returns a deterministic ordered **tour skeleton**: an overview step (entry points) + one step per `index.md` section (top articles by backlink count) + a trailing step for unindexed hubs. Each step carries node `name` + `summary` so the caller can narrate. `scope` restricts to one section/topic/path; actionable errors when the graph is missing/malformed (point at `/wiki-graph`).
- **`/wiki-tour` skill + slash command** — orchestrates: ensure graph → `build_wiki_tour` skeleton → Claude writes the pedagogical narrative → writes a standalone markdown tour in `wiki-meta/tours/` (nodes linked as `[[wikilinks]]`, readable in Obsidian today) **and** the graph's `tour[]` field (for the future dashboard / native viewer #2b). Whole-vault or scoped (`/wiki-tour Dedibox`). Bilingual FR/EN triggers.
- **`src/helpers/wiki-tour-topology.mjs`** — pure, deterministic topology analyser: fan-in (backlinks) / fan-out over the `related` wikilink web, entry-point scoring (boosted for `index`/`overview`/`MOC`/`sommaire` names), `scope` resolution (layer id/name or path substring), and the ordered step skeleton. Byte-stable for a fixed graph.
- **+17 tests** (topology determinism / fan-in / entry-points / scope / edge-cases + the tool's DI-mocked read/parse/error paths).

## [0.17.0] — 2026-05-29 — knowledge-graph builder (`build_wiki_graph` + `/wiki-graph`) + `.wikiignore`

First slice of the **Understand-Anything** borrowings (Phase 1 #1 deterministic core + #5) — see `understand-anything-roadmap` in the companion vault. Assembles a vault's wiki into a typed **knowledge-graph JSON using the Understand-Anything schema verbatim** (`Lum1104/Understand-Anything`), so it can be visualised directly in that plugin's dashboard. Deterministic — no LLM in this slice (the LLM enrich + Louvain layers are deferred follow-ons). Backward compatible: purely additive (one new read/write tool + one new skill + one new helper trio); no behavior change for existing setups.

### Added

- **`build_wiki_graph` MCP tool** (`src/tools/build-wiki-graph.mjs`) — enumerates `wiki/**` content pages + `wiki-meta/digests/**`, reads an optional `.wikiignore` + `wiki-meta/index.md`, assembles a typed graph, **validates it against the schema** (refuses to write an invalid graph), and writes it to **two** locations: the canonical `wiki-meta/graph/knowledge-graph.json` (source of truth) + a derived `.understand-anything/knowledge-graph.json` (read directly by Understand-Anything's `/understand-dashboard` — zero extra step). `dryRun` previews counts without writing. In `WRITE_TOOL_NAMES` (hidden under `OBSIDIAN_ROUTER_READONLY`).
- **`/wiki-graph` skill + slash command** — natural-language wrapper (FR/EN triggers) around the tool, with the interop instructions for viewing the graph in Understand-Anything's dashboard.
- **`src/helpers/wiki-graph-schema.mjs`** — the UA-compatible vocabulary (21 node types / 35 edge types), canonical ID builders (`article:`/`entity:`/`topic:`/`claim:`/`source:`), `emptyGraph`, and a thorough `validateGraph` (dup-id, dangling-edge, self-edge, weight-bounds, complexity, layer membership).
- **`src/helpers/wiki-graph-builder.mjs`** — the pure, deterministic assembler: pages → `article` nodes; digest concepts/claims → `entity`/`claim` nodes; `[[wikilinks]]` → `related` edges; **referenced sources** (frontmatter `sources:`, `^[file:42-58]` citations, `![[x.pdf]]` binary embeds) → lightweight `source` nodes + `cites` edges; `index.md` sections → `topic` nodes + `categorized_under` edges + `layers[]`. Byte-stable for fixed input (timestamps injected).
- **`.wikiignore` support** (`src/helpers/wiki-ignore.mjs`) — gitignore-syntax exclusion (documented subset, no new dep) of noise (config, trash, derived sidecars, binary attachments) from the graph/lint/export tooling, with built-in defaults + `!`-negation + a commented starter generator.
- **The "source référencée" invariant** — a file a page *references* becomes a `source` node **even if it matches `.wikiignore`**. `.wikiignore` governs *content enumeration* (what becomes an `article` node), NOT *reference resolution* — so you can always trace a page to its PDF/image and click through to it.
- **+118 tests** (4 new suites: schema, ignore, builder, tool) covering determinism, the invariant, schema validity, topics/layers, and the review regressions below.

### Security / hardening (from the pre-ship adversarial review)

- **ReDoS guard in the `.wikiignore` matcher** — a `.wikiignore` is attacker-influenced vault content; a crafted pattern (`a` + 40×`*` + `b`) compiled to N adjacent `.*` groups → ~80s event-loop freeze. Fixed by collapsing consecutive-star runs to a single quantifier + caps (pattern length, `**`-run count, total wildcard count) with fail-safe drop + warnings.
- **Path-traversal guard** — the tool's `pagesDir` argument now reuses the canonical `isSafeVaultRelativePath` (rejects leading `/`, drive letters, UNC, `..`, control chars) instead of a weaker bespoke check.
- **Output sanitisation** — the written graph JSON is run through `sanitizeResponse` (vault content is attacker-influenced and the JSON is consumed by external dashboards/agents); **prototype-pollution keys** (`__proto__`/`constructor`/`prototype`) are stripped from embedded frontmatter.
- **Bounded read concurrency** — page/digest reads are batched (no unbounded `Promise.allSettled` connection storm on large vaults); enumeration bounded by depth/file caps with truncation warnings.

### Fixed (review regressions, now test-guarded)

- `project.analyzedAt` was silently always `""` (the injected timestamp was dropped by a param-name mismatch) — now populated.
- Two claims sharing their first 8 words collapsed to one node — claim IDs now carry a content hash.
- Graph was input-order-dependent on basename collisions — inputs are now sorted by path (order-independent, deterministic).
- Block-list `sources:`/`tags:` YAML (the form Obsidian's Properties UI writes) parsed as empty → no source nodes; `parseFrontmatter` now collects block sequences.
- A citation to an existing content page minted a duplicate `source:` node — now resolves to a `related` article edge.

## [0.16.0] — 2026-05-27 — MCPHub deployment support + family-vault member routing

Ships the tooling and conventions to deploy the router on **MCPHub** in multi-tenant "hybrid bypass" mode (router server-side, vault data client-side reached over WireGuard) and to run a **shared family vault** with per-member auto-routing. Validated end-to-end against a live MCPHub instance on a QNAP NAS: a `write_file` call from Claude Code travelled Claude Code → MCPHub → spawned router container → WireGuard tunnel (~137 ms) → Obsidian REST API on the originating PC → file persisted on disk + audit log written. See `mcphub-hybrid-bypass-roadmap` in the companion vault for the full session record.

### Added

- **`scripts/build-mcpb.ps1`** — PowerShell script that bundles the router into a `.mcpb` archive for MCPHub upload. Cleans a staging dir, robocopies source (excluding `.git`, `node_modules`, `tests`, `.venv`, `.claude`, `worktrees`, `.vault-meta`, `.env*`, `*.mcpb`, `*.log`, **and the gitignored secret config `config.json`/`config.local.json` so local API keys never ship in the bundle**), runs `npm ci --omit=dev --ignore-scripts` (hermetic — skips all lifecycle scripts, so the markitdown Python venv postinstall never runs and the bundle starts cleanly on a Python-less Linux container), writes `manifest.json` with the `server-`-prefixed container path + templated env-var placeholders, and `Compress-Archive`s the result. Re-runnable with `-Clean`.
- **`who-is-speaking` skill + `/obsidian-router:who-is-speaking` slash command** — identifies the family member speaking in a shared vault by matching their name/aliases against the vault's `CLAUDE.md` member table, then locks the router to that vault (`lock_vault`) and sets `Hybrid` auto-enrich mode (`set_auto_enrich_mode`) so subsequent auto-saves route to `wiki/People/<member>/`. Bilingual FR+EN triggers. Refuses to guess on no-match; supports mid-session re-identification without unlocking.
- **`tribu-routing` installable convention** (`skills/conventions/snippets/tribu-routing.md`) — codifies the family-member auto-routing pattern: identify the speaker at session start, route private saves to `wiki/People/<member>/` and collective saves to `wiki/Family/`, with an explicit sensitivity guard against auto-saving medical data. Generic + reusable across any shared/multi-user vault (not hardcoded to a specific family — the member list lives in the consuming vault's `CLAUDE.md`).

### Changed

- **`skills/conventions/SKILL.md`** mapping table refreshed from 8 → 10 documented conventions (added the previously-undocumented `claim-citations` from v0.15.0 + the new `tribu-routing`).
- **`.gitignore`** now excludes `mcpb-staging/` and `*.mcpb` (regenerable build artifacts, ~36 MB).

### Deployment notes (discovered during the live MCPHub validation)

- **`MD_ALLOWED_PATHS` is mandatory in multi-tenant mode.** When any of `OBSIDIAN_ROUTER_READONLY` / `OBSIDIAN_ROUTER_ALLOWED_VAULTS` / `OBSIDIAN_ROUTER_USER_ID` is set, the v0.11.1 `assertSandboxConsistent()` boot guard refuses to start without `MD_ALLOWED_PATHS` (or its legacy alias). Point it at an empty sandbox dir even when the conversion tools are unused.
- **The config env var is `OBSIDIAN_ROUTER_CONFIG`, not `OBSIDIAN_ROUTER_CONFIG_PATH`.** (A doc in the companion vault had the wrong name; the build script now emits the correct placeholder.)
- **Remote vault over WireGuard** is configured via the standard `remoteVaults[]` config entry (`baseUrl: http://<wg-ip>:<insecurePort>`, the vault's `apiKey`). The originating PC must set `bindingHost: 0.0.0.0` in its Local REST API `data.json` so the API listens on the WG interface, not just loopback.

Backward compatible: no runtime behavior change for existing local-only setups. The new skill + convention are opt-in; the build script is a dev tool.
## [0.15.1] — 2026-05-27 — `/review+` hardening on v0.15.0 (4 review passes + 9 fix commits)

Post-v0.15.0 `/review+` produced **9 IMPORTANT findings** in pass 1 (3 SECURITY + 5 logical correctness + 1 perf), then converged through 4 review passes with 9 hardening commits. Both reviewers (Claude `Code Reviewer` subagent + `codex review` CLI) concluded **OK to merge** at pass 5 — codex empirically verified all 25 secret-param patterns are caught (0 missed, 0 false-positives).

### Security fixes (3)

- **YAML injection in `digest-generator.serialiseDigest`** (convergent Reviewer A + B) — `digest.for` was written raw allowing `digest.for = "foo.md\nclaims: [INJECTED]"` to smuggle YAML lines into frontmatter. The `needsQuoting` regex also missed backslashes, control chars, YAML-reserved scalars (`yes`/`no`/`true`/`false`/`null`/`~`), alias/anchor/tag leading chars (`*foo`/`&foo`/`!foo`), and numeric-looking strings. Fix : new `needsYamlQuoting()` policy with 7 explicit rejection categories + `quoteYamlScalar()` + `escapeYamlDoubleQuoted()`. `digest.for` and `generated_at` now quoted ; `pageHash` hex-validated. Care taken to AVOID the `[ -\\]` regex range pitfall — structural chars listed EXPLICITLY. **+8 regression tests** including "ordinary paths stay UNQUOTED" guard.

- **Path traversal in `get_wiki_context_pack`** (Reviewer B) — a poisoned `wiki-meta/index.md` containing `[[../../etc/passwd]]`, `[[/etc/x]]`, `[[C:\Windows\...]]`, or URL-like `[[file://...]]` would have its target shipped verbatim to `getNote()` and on to the Obsidian REST API. Fix : new exported helper `isSafeVaultRelativePath(p)` rejects POSIX absolute / Windows drive-letter / UNC / `..`-as-segment / control chars / URL-like (both `scheme://` and opaque `javascript:`/`data:`/`mailto:` forms). The drill loop calls it BEFORE `getNote()`. **+10 regression tests** including an integration test that proves `getNote` is NEVER called on a `..` path.

- **URL credentials + tokens leak in `normaliseUrl`** (Reviewer B, hardened across passes 1 → 4 → 5) — `normaliseUrl()` was persisting `https://user:pass@host/?token=...&access_token=...` to `wiki-meta/ingest-state.json`. The state file became a credential leak vector. Fix : `parsed.username = '' ; parsed.password = ''` (drops basic auth in userinfo) + new `SECRET_PARAMS` blocklist (25 names : token/access_token/refresh_token/id_token/api_key/apikey/apptoken/key/secret/client_secret/signature/sig/auth/authorization/password/passwd/pwd/code/state/nonce/session/sessionid/sid/jsessionid/phpsessid) + new `TRACKING_PARAM_PREFIXES` for prefix-matched families (`utm_`, `x-amz-`, `x-goog-`, `oly_`, `vero_`). **Pass 4 + 5 hardening** : on parse failure, the previously-raw return now detects basic-auth userinfo OR secret query params via `SECRET_PARAMS_RE` generated dynamically from `SECRET_PARAMS` (single source of truth — Pass 4 caught that a hand-curated regex was missing `refresh_token`/`client_secret`/`authorization`/etc.). Returns `null` sentinel forcing callers to surface the error. **+14 regression tests** (9 in Pass 2 + 5 in Pass 4) covering each previously-leaking param family.

### Logical correctness fixes (6)

- **Check H source resolver** — `wiki-lint` Check H tried `sources/<filename>` but `wiki-ingest` writes to `wiki/sources/<slug>.md`. Check H would never resolve. Fix : `wiki/sources/<filename>` first (canonical), then page-relative, then bare `<filename>` as legacy fallback. Also rejects `..` / absolute paths in cited targets (new `cited-source-unsafe-path` WARNING).

- **Digest path naming consistency** (B IMPORTANT + Pass 3 collision fix) — `wiki-ingest` and `wiki-refresh-digests` derived the digest path differently, producing different filenames for the same page. **Pass 3** : new `digestPathForPage(pageRelPath)` canonical helper used by both skills. **Pass 4** : initial flatten-with-dashes mapping (`/` → `-`) was collision-prone (`wiki/A/B.md` and `wiki/A-B.md` both → `wiki-A-B.md`) — switched to NESTED mapping mirroring the source path. Collision-free by construction. Skills updated for recursive enumeration. **+10 regression tests** including the dash-vs-slash collision lock-in.

- **Silent error swallowing in `get_wiki_context_pack`** (convergent Reviewer A + B) — all `getNote()` errors collapsed to "missing page" placeholder, conflating real failures (timeout/auth/5xx) with legitimate 404s. Fix : capture first non-not-found error per candidate, emit `page-read-failed` warning when non-404 blocks resolution. `Promise.allSettled` rejections get `primary-page-drill-failed` warning. **+2 integration tests** locking in : 503 emits warning, 404 does NOT (preserves dead-wikilink as routine).

- **Sibling-parser drift on bare-anchor wikilinks** (Reviewer A IMPORTANT, Pass 3) — `parseIndexEntries` in `get_wiki_context_pack` accepted `[[#OnlyAnchor]]` and emitted entries with empty label, polluting IDF scoring + triggering wasted REST probes. The sibling `llms-txt-exporter.parseIndex` already skipped this. Fix : aligned both parsers with same early-skip on empty page slug. **+1 regression test**.

- **Wikilink alias drop in `llms-txt-exporter.parseIndex`** (Reviewer B) — regex `[^\]|]+?` silently dropped `[[foo|Alias]]`. `[[Foo#Bar|Section]]` became `Foo#Bar.md`. Fix : accept full `[[target]]` then strip `|alias` / `#section` / `^block-ref` decorations after. **+5 regression tests** for the 4 accepted forms + bare-anchor rejection.

- **Multiple H2 silent overwrite + corrupted-state silent recovery** (Reviewer A) — `parseDigest` silently kept only the last `## Summary` when duplicates appeared (data loss). `loadIngestState` returned `{}` on corruption (would overwrite the broken file with fresh empty state on next save — erasing history invisibly). Fix : `parseDigest` throws on duplicate H2 ; `loadIngestState` backs up corrupted file as `<path>.corrupted-<timestamp>` + writes stderr warning before returning `{}`. **+4 regression tests** (2 duplicate-H2 + 2 backup-on-corruption).

### Performance / consistency (1)

- **`wiki-lint --deep` N² perf documentation** (convergent Reviewer A + B) — the new Checks I/J/K/L do pairwise digest comparison, N² in page count. Documented prominently in skill prose ("typical 100 pages → 5000 comparisons fine ; 1000 pages → 500k may take a few seconds"). No code change ; user expectation calibration.

### NITs addressed inline

- `escapeYamlDoubleQuoted` JSDoc no longer overclaims control-char coverage.
- `normaliseUrl` JSDoc `@returns` synced to `{string|null}` with explanation of the three return modes.
- `skills/wiki-ingest/SKILL.md` file-layout example updated to NESTED structure + recursive-glob note.
- `skills/wiki-refresh-digests/SKILL.md` + `skills/wiki-lint/SKILL.md` `--deep` mode updated to instruct recursive enumeration (NESTED mapping consequence).

### Doc propagation

- `package-lock.json` synced from 0.14.7 → 0.15.0 → 0.15.1 (was lagging).
- `ROADMAP.md` gained a v0.15.0 + v0.15.1 section (was last at v0.12.2).

### `/review+` audit trail

| Pass | Reviewer A | Reviewer B | Convergent | Action |
|---|---|---|---|---|
| 1 | 6 IMP + 9 NIT | 9 IMP + 1 NIT | YAML + error swallowing + N² guard + parser drift | 7 fix commits (`f8cf898`..`9f0ddf4`) |
| 2 | OK to merge + 1 IMP + 3 NIT carry-over | À corriger : 1 IMP collision + 2 PARTIAL + 2 NIT | digest path collision + URL parse-fail leak | 2 fix commits (`60ee772` + `997fb7b`) |
| 3 | — (informal verification) | — | — | (inferred — convergence point) |
| 4 | OK to merge + 1 IMP (skill drift on NESTED) + 1 NIT | À corriger : 1 IMP parse-fail regex too narrow | parse-fail leak alignment | 2 fix commits (`3bad5bd` + `9aa3a77`) |
| 5 | (deemed converged at pass 4) | **OK to merge** (empirical : 25/25 SECRET_PARAMS catch) | — | bump v0.15.1 |

### Tests

- **1387/1387 passing** (was 1331 at v0.15.0, +56 hardening regressions across 4 files).
- New: 8 YAML safety + 10 path traversal + 14 URL credential strip + 10 digest-path/parsers + 2 page-read-failed + 12 misc parser robustness.

### Pages liées

- [[llm-wiki-compiler-roadmap]] — source roadmap of the v0.15.0 features being hardened here
- [[router-changelog#v0.15.0 — 2026-05-27]] — feature catalog of the underlying release

## [0.15.0] — 2026-05-27 — llm-wiki-compiler emprunts (6 features parallèles)

Six features décidées un par un avec Roland après ingestion de la fiche [llm-wiki-compiler](https://github.com/atomicstrata/llm-wiki-compiler) (un autre CLI implémentant le pattern Karpathy LLM Wiki en standalone). Roadmap source : `wiki/Divers/LLM-WIKI-COMPILER/llm-wiki-compiler-roadmap.md` (vault `opsidian-mcp-router et bridge`). Total : **+166 tests** (1165 → 1331), 6 commits parallélisés (1 agent Backend Architect en background + 4 features foreground), aucun refactor structurel.

### Added

- **Line-level citations** — `^[file.md:42-58]` markers now supported in wiki pages to pinpoint which lines of a source justify a given paragraph. `wiki-ingest` SKILL.md instructs Claude to emit them when sources are long enough to warrant it (papers, transcripts, code, docs >100 lines); `wiki-lint` adds a new Check H (`claim-range-validity`) that validates the cited source exists, end ≥ start, lines > 0, range doesn't overflow the source. All findings are WARNING-level (sources legitimately shorten over time, no need to fail loudly). New convention snippet `skills/conventions/snippets/claim-citations.md` installable via `/obsidian-router:conventions install claim-citations`. Roadmap item #1 from llm-wiki-compiler-roadmap.

- **`wiki-export` skill + `/wiki-export` slash command** — aggregates a vault's wiki into a portable single file conforming to the [llmstxt.org](https://llmstxt.org) standard. Two modes: `llms.txt` (compact index with links + descriptions) and `llms-full.txt` (same structure but with each page body inlined). Use cases: share your wiki with a collaborator who doesn't have Obsidian; paste into external LLMs (Perplexity, ChatGPT, Gemini) for grounded Q&A; backup to a single portable archive; publish at site root for AI search visibility. Pure helper `src/helpers/llms-txt-exporter.mjs` (deterministic, no I/O) + 32 tests. Other targets listed in roadmap (`json`, `json-ld`, `graphml`, `marp`) deferred. Roadmap item #5 from llm-wiki-compiler-roadmap.

- **`get_wiki_context_pack` MCP tool (v1 JSON envelope)** — structured JSON context for a query, instead of the prose returned by `wiki-query` skill. Enables non-Claude agents (Cursor, MCPHub multi-agent workflows, custom scripts) to consume the router's vault knowledge programmatically. Returns a single envelope with `version: "v1"`, `query`, `vault`, `primaryPages[]` (IDF-ranked from `wiki-meta/index.md`, drilled in parallel, summary + source_type + snippet), `semanticChunks[]` (from `search_smart` — degrades gracefully to `[]` + warning when Smart Connections is missing), `graphNeighbors[]` (wikilinks extracted from primary page bodies, deduped, primary basenames excluded), `citations[]` (from each page's `sources:` frontmatter), `warnings[]` (vault-offline / smart-connections-not-available / index-not-found / no-primary-page-matched), and `suggestedActions[]` (empty in v1 — reserved for later). Schema is additive-only: existing fields never change shape in v1. New tool `src/tools/get-wiki-context-pack.mjs` + 55 tests. Roadmap item #6 from llm-wiki-compiler-roadmap.

- **Hash-based incremental ingest** — `wiki-ingest` now computes SHA-256 of source content (post-defuddle for URLs to normalise away ads/timestamps/tracking pixels) and stores it in `wiki-meta/ingest-state.json` per vault. Re-ingesting a source with identical content is a fast no-op (no fetch, no LLM call) — Claude surfaces "already ingested with identical content, skipping" and exits. Re-ingesting a source whose content has evolved upstream triggers a re-ingest with a "source has evolved since `<date>`" flag, suggesting `/wiki-refresh --diff`. URL normalisation strips `utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_cid`, `mc_eid`, etc. (case-insensitive), sorts remaining query params for stable hashing, lowercases host, strips default ports and fragment, normalises trailing slash. Atomic state file writes (tmp + rename) so a crash mid-write can't corrupt the JSON. New helper `src/helpers/ingest-state.mjs` (computeSourceHash, normaliseUrl, getStatePath, loadIngestState, saveIngestState, checkSourceFreshness, recordIngest) + 40 tests. Substrate for the future agent-de-veille (#3) which will scan ingest-state.json to detect upstream-changed sources. Roadmap item #4 from llm-wiki-compiler-roadmap.

- **Digest sidecars + `wiki-lint --deep` mode + `/wiki-refresh-digests` skill** — every wiki page (except sources and meta scaffolds) now gets a compact digest at `wiki-meta/digests/<page-slug>.md` generated at ingest time. The digest contains concepts, claims, keywords, summary, and a page-hash for staleness detection — frontmatter + Summary + Notable sections, all parseable. New `wiki-lint --deep` mode reads all digests in bulk to detect : Check I `digest-stale` (page edited since digest generated → WARNING) or `orphaned-digest` (page deleted → ERROR), Check J `concept-overlap-strong`/`moderate` (Jaccard ≥0.7 / 0.4..0.7 between two pages' concepts → ERROR / WARNING merge candidates), Check K `contradiction-suspected` (conservative regex heuristic on claims arrays → WARNING, documented as best-effort starting point not guarantee), Check L `missing-wikilink` (pages share concepts but don't reference each other → WARNING). Companion skill `wiki-refresh-digests` (`/wiki-refresh-digests`) regenerates stale or missing digests — default mode refreshes only stale + missing, `--all` force-regenerates everything, `--for <path>` refreshes one specific page. New helper `src/helpers/digest-generator.mjs` (computePageHash, generateDigestSkeleton, parseDigest, serialiseDigest, isDigestStale, conceptOverlap, sharedConcepts) + 39 tests. This is the reformulation (Roland's idea) of llmwiki's two-phase compile pattern : instead of refactoring `wiki-ingest` to extract concepts globally upfront (risky, structural refactor), we keep `wiki-ingest` single-pass and add cheap digest sidecars + bulk deep-lint detection. Substrate for the future agent-de-veille (#3) self-review pass. Roadmap item #7' from llm-wiki-compiler-roadmap.

## [0.14.9] — 2026-05-26 — `/review+` hardening on v0.14.8 (4 passes, A+B converged)

Post-v0.14.8 `/review+` produced 5 IMPORTANT + 2 NIT in pass 1, then converged through 4 passes (Code Reviewer subagent + `codex review` CLI, both reviewers OK to merge by pass 4). All findings addressed in this release.

### Adressed — IMPORTANT (5)

- **Negative-cache invalidation** (Reviewer A IMP-1) — `src/helpers/click-to-open.mjs`. The per-vault cache used to store `{ port: null, enabled: false }` on misses, pinning the failure for the lifetime of the process. Onboarding scenario (user starts the router BEFORE flipping `enableInsecureServer: true`) would never produce a URL until session restart. Fix: only cache successful reads (`enabled && port !== null`). Cheap sync re-read on every miss until the bridge is configured, then fast-path cache for the lifetime of the success.
- **Walker MAX_DEPTH 10 → 20** (Reviewer A IMP-2) — `src/helpers/click-to-open-walker.mjs`. Fan-out `search_smart` shape (`{ perVault: [{ vault, chunks: [{ source: { path } }] }] }`) stacks ~8-10 levels and the old budget was silently clipping deep hits. New budget stays stack-safe and zero-cost on small payloads.
- **Path-traversal segment guard** (Reviewer A IMP-3 + Reviewer B P3 convergent, pass-2 + pass-3 refinement) — `src/helpers/click-to-open-walker.mjs`. Initial fix `v.includes('..')` over-rejected legitimate filenames like `wiki/release..notes.md`. Replaced in pass 3 with `/(?:^|[\\/])\.\.(?:[\\/]|$)/` — matches `..` only as a complete path segment (bordered by `/`, `\`, start, or end). Verified against 6 reject + 4 accept cases.
- **UNC + extended-length path rejection** (Reviewer B P2) — `src/helpers/click-to-open-walker.mjs`. Without this, `\\server\share\note.md` was normalised by `encodeVaultPath` (slashes collapsed, leading slashes stripped) into a plausible-looking but wrong URL for `server/share/note.md`. Now rejected at `isLikelyVaultPath` alongside drive-letter and POSIX absolute paths.
- **move_file dual URL on partial failure** (Reviewer A IMP-4 + Reviewer B P3 pass-3) — `src/tools/move-file.mjs`. When `moveFileFromTo` returns `{ moved: true, sourceDeleted: false }` (PUT OK, DELETE source KO), the source FILE is still on disk. New `clickToOpenUrlSource` field emits a SECOND URL pointing at the source so the LLM can surface both — "copied to [foo](dest), cleanup [foo](source)". Pass-3 refinement: gated on BOTH `result.moved === true` AND `sourceDeleted === false` to exclude the same-path no-op `moveFileFromTo(vault, foo, foo)` which returns `{ moved: false, sourceDeleted: false }` (harmless, no warning needed).
- **Schema `oneOf` mutual exclusion for `build_open_link`** (Reviewer B P2) — `src/index.mjs`. The `build_open_link` tool schema now encodes the `path` xor `paths` contract via JSON Schema `oneOf`. MCP clients that validate inputs catch `{}` and `{ path, paths }` before invoking the tool; runtime handler still validates for defence-in-depth + clearer errors.

### Adressed — NIT (2)

- **Markdown label escape** (Reviewer B P3) — `src/helpers/click-to-open.mjs`. `buildClickToOpenMarkdownLink` was producing malformed `[foo]bar](url)` for vault filenames like `foo]bar.md`. New `escapeMarkdownLabel` helper escapes `\`, `[`, `]` per CommonMark spec.
- **Cross-impl drift guard hook ↔ helper** (Reviewer A NIT-5) — `tests/wiki-query-first-nudge.test.mjs`. The hook inlines `readInsecurePort` (zero-deps on `src/`) and the helper has its own `readInsecurePortConfig`. New matrix test exercises 7 patho-cases (happy / disabled / port-string / out-of-range / port-0 / enableInsecureServer-missing / port-missing) and asserts hook and helper agree on every rejection condition. Locks the two implementations together against future drift.

### Tests

- **1165/1165 passing** (was 1144 at v0.14.8, +21 hardening tests).
- New: cache miss-no-cache + missing-data.json-retry semantics (2), markdown escape (4 cases), UNC + extended-length rejection (2), `..` segment-aware accept-cases (1 with 4 sub-paths) + reject-cases (1 with 6 sub-paths), MAX_DEPTH realistic fan-out (1), `oneOf` schema presence (1), `move_file` dual-URL gate (1 covering both conditions), hook↔helper cross-impl matrix (7 cases).

### `/review+` audit trail

| Pass | A findings | B findings | Convergent | Action |
|---|---|---|---|---|
| 1 | 4 IMP + 1 NIT | 2 P2 + 1 P3 | Walker `..`/UNC (IMP-3 ≈ P2) | Fixed all 5 IMP + escape NIT in pass 2 |
| 2 | NIT-1 (`..` over-rejects) + 2 cosmetic NITs | P3 (same as NIT-1) | `..` substring over-rejects | Refined to segment-aware regex in pass 3 |
| 3 | OK to merge | P3 (`move_file` same-path no-op) | — | Gated on `moved:true && sourceDeleted:false` in pass 4 |
| 4 | OK to merge | No regressions | Both converged | Ship |

## [0.14.8] — 2026-05-26 — click-to-open determinism: tool results + helper tool + hardened hook

Closes a recurring bug where the LLM cited vault files as bare paths (`wiki/Divers/foo.md`) in chat replies. The Claude Code renderer auto-clickifies these by prepending the cwd path, producing either `<cwd>/wiki/...` (a non-existent path in workspace-bound mode) or a filesystem link that opens in the OS file viewer instead of Obsidian (in cwd-is-vault mode). Roland flagged this 10+ times — the previous "memory + CLAUDE.md rule + hook nudge" approach failed because the LLM still had to *compose* the URL by hand (port lookup, encoding) and *remember* the rule. This release removes both failure modes with a three-layer fix.

### Layer 1 — every vault-touching tool result carries `clickToOpenUrl`

The LLM never composes a URL by hand. It copies the field verbatim from the tool result it just received.

#### Added

- **`src/helpers/click-to-open.mjs`** (NEW, ~150 LOC) — exports `buildClickToOpenUrl(vault, filePath)`, `buildClickToOpenMarkdownLink(vault, filePath, label?)`, `encodeVaultPath(p)`, and `_resetCache()` (test helper). Reads `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json`, extracts `insecurePort`, validates `enableInsecureServer: true`, returns `http://127.0.0.1:<port>/open/<url-encoded-path>` or `null`. Path encoding normalises `\\` to `/`, strips leading slashes, encodes via `encodeURIComponent` (slashes → `%2F`, spaces → `%20`, accents → percent-encoded UTF-8). Per-vault cache keyed by `vault.path` avoids re-reading data.json on every call (notable for `merge_frontmatter` which loops `set_frontmatter`). Returns `null` (never throws) when the bridge isn't ready — remote vault, missing/broken data.json, insecure server disabled, port out of range — so the caller spreads the field conditionally and the tool result still works without a URL.
- **`src/helpers/click-to-open-walker.mjs`** (NEW, ~90 LOC) — exports `collectClickToOpenLinks(vault, payload)` for search-style responses. Recursively walks the payload (bounded depth 10 to handle cycles), collects every string at keys `filename` / `path` / `file`, rejects URLs and absolute filesystem paths, dedupes, and returns `{ clickToOpenLinks: { "<path>": "<url>", ... } }` or `{}` so spreading is a no-op. Sibling-map design (rather than mutating hit objects) preserves upstream shape contracts.

#### Changed (9 tools now emit `clickToOpenUrl`, 2 emit `clickToOpenLinks`)

- **`src/tools/write-file.mjs`**, **`get-file.mjs`**, **`append-to-file.mjs`**, **`patch-file.mjs`**, **`set-frontmatter.mjs`**, **`merge-frontmatter.mjs`**, **`get-frontmatter.mjs`** — append `clickToOpenUrl` to the result object via `...(url && { clickToOpenUrl })` so absent when the bridge is unavailable.
- **`src/tools/move-file.mjs`** — URL targets the **destination** path, not the source (source no longer exists after the move).
- **`src/tools/execute-template.mjs`** — URL emitted only when `createFile: true` AND `targetPath` is set (the render-only path has no file to open).
- **`src/tools/search.mjs`**, **`search-smart.mjs`** — both per-vault and fan-out (`vault: "*"`) modes now include `clickToOpenLinks` at the response top level (or per-vault sub-object). The walker collects paths from both Local REST API's `[{filename, matches: [...]}]` shape and Smart Connections' `{chunks: [{path, score, excerpt}]}` shape uniformly.

### Layer 2 — `build_open_link` MCP tool for files the LLM didn't just touch

When the LLM cites a wikilink target without having fetched it (`[[graphify]]`, `[[project-router]]`), it calls `build_open_link` to get the URL — still no manual composition.

#### Added

- **`src/tools/build-open-link.mjs`** (NEW, ~60 LOC) — `buildOpenLinkTool(registry, { vault?, path? | paths? })`. Single mode returns `{ vault, path, clickToOpenUrl, markdownLink }`. Batch mode (`{ paths: [...] }`) returns `{ vault, links: [{ path, clickToOpenUrl, markdownLink }, ...] }` for citing N notes in one call. Rejects on both `path` and `paths` provided (ambiguous), or neither (no work). Per-slot non-empty-string validation in batch mode (a typo at `paths[3]` becomes a clear "paths[3] must be a non-empty string" error instead of a silent `null` URL).
- **TOOLS schema + TOOL_HANDLERS entry** in `src/index.mjs` — read-only tool (no vault I/O beyond the per-vault data.json port lookup), so excluded from `WRITE_TOOL_NAMES`.

### Layer 3 — hook injects the rule + pre-computed URL prefix

The hook now reads data.json at fire time and embeds the literal URL prefix in the nudge — the LLM sees `http://127.0.0.1:27142/open/` ready to use, no port lookup ever.

#### Changed

- **`hooks/wiki-query-first-nudge.mjs`** — new `chatLinkBlock` injected in BOTH `cwd-is-vault` and `workspace-bound` modes (the bare-path bug exists in both). The block contains:
  - The pre-computed URL prefix `http://127.0.0.1:<insecurePort>/open/` read live from `<vaultPath>/.obsidian/plugins/obsidian-local-rest-api/data.json` at fire time.
  - An explicit `NEVER write the path as bare text like wiki/Divers/foo.md` rule, with mode-aware explanation of WHY (cwd+vault mix → 404 in workspace-bound, OS file viewer → wrong app in cwd-is-vault).
  - Three numbered paths to get a URL without composing: (a) read `clickToOpenUrl` from a tool result you already have, (b) read `clickToOpenLinks` map from search/search_smart results, (c) call `build_open_link` for cross-references.
  - Concrete WRONG/RIGHT chat-reply examples using a REAL path from the current vault.
  - "Roland has flagged this exact bug 10+ times" framing to anchor the rule in user reality.
- **DEGRADED variant** of the block when the bridge isn't reachable (missing data.json, JSON broken, `enableInsecureServer: false`, invalid port): falls back to `obsidian://open?vault=...&file=...` URI inline-code guidance and points at the data.json setup as the fix.

### Tests

- **`tests/click-to-open-helper.test.mjs`** (NEW, 24 tests) — encoding (slashes / spaces / accents / backslash-to-slash / leading-slash strip / preserved punctuation), happy path (URL with configured port), null-return conditions (remote vault, null vault, no path, no filePath, `enableInsecureServer:false`, port missing / out of range / non-integer, missing data.json, corrupt JSON), markdown-link helper (default label = basename without ext, explicit label, null when URL unavailable, backslash-path basename), cache behaviour (subsequent calls hit cache, `_resetCache` forces fresh read).
- **`tests/click-to-open-walker.test.mjs`** (NEW, 15 tests) — Local REST API search shape, smart-connections chunks shape, mixed `filename`/`path` at any depth, dedupe, rejected candidates (URLs, absolute POSIX/Windows paths, empty strings, non-strings), edge cases (empty/null payloads, remote vault, depth-limited cycles).
- **`tests/build-open-link.test.mjs`** (NEW, 8 tests) — single mode happy path, null URL when insecure server disabled (no `markdownLink` in result), batch mode happy path, empty paths array, per-slot validation errors, mutual-exclusion of `path` and `paths`, missing-args error.
- **`tests/tools-click-to-open-integration.test.mjs`** (NEW, ~25 tests) — static wiring check (every vault-touching tool source imports the helper AND emits `clickToOpenUrl`), `build_open_link` registration in `TOOLS` / `TOOL_HANDLERS` / imports, end-to-end smoke (single + batch round-trip through a real tempdir vault with data.json). Static wiring chosen over ESM mocking because ESM exports are frozen — `mock.method` fails with "Cannot redefine property" on imported functions.
- **`tests/wiki-query-first-nudge.test.mjs`** — added 4 tests for the new chat link block: bridge-reachable case (URL prefix injected literally + WRONG/RIGHT examples + `build_open_link` mention + Roland-10+ framing), missing data.json → DEGRADED variant, `enableInsecureServer:false` → DEGRADED, cwd-is-vault uses the "filesystem link → wrong app" WRONG example (different from workspace-bound's "cwd+vault mix → 404").

**Total: 1144/1144 passing** (was 1055 at v0.14.7, +89 tests).

### Why this fix is definitive

| Pre-v0.14.8 failure mode | v0.14.8 mitigation |
|---|---|
| LLM composes URL by hand → encoding errors | Tool result carries `clickToOpenUrl` ready to copy |
| LLM forgets the click-to-open format entirely | Hook injects rule + pre-computed URL prefix every prompt |
| Cross-reference to a file LLM didn't fetch → no URL | `build_open_link` batch tool builds URLs for any path |
| Bare `wiki/...` path in chat → auto-clickified by Claude Code | Hook explicitly forbids with WRONG/RIGHT examples |
| Bridge not reachable → silent failure | DEGRADED hook variant + tool result simply omits the URL field |

The residual gap: Claude Code has no pre-output validation hook that could block a chat message containing a bare path. The fix makes the "right path" (use the URL from the tool result) much easier than the "wrong path" (compose by hand). Combined with the deterministic prompt-submit injection, the bug should disappear in practice.

## [0.14.7] — 2026-05-25 — Phase E.2 · intelligent asset filter + Phase D.2 `/review+` hardening

Two threads land together because Phase D.2's `/review+` hardening was already on the branch when Phase E.2 wrapped up. Both ship in v0.14.7.

### Phase E.2 — intelligent asset filter (defuddle-first + alt/figure + dimensions)

Closes the deferred Phase E.2 from v0.14.2: `download_page_assets` now filters relevant images from page noise **before** any byte hits the network. Three filters stack, all enabled by default and individually overridable:

1. **`defuddleFirst: true`** — runs [kepano/defuddle](https://github.com/obsidianmd/obsidian-clipper)'s article-body extractor on the HTML *before* image scanning. Everything outside `<article>` / `<main>` (nav, header, sidebar, footer, ad rails, share-button bars, related-article widgets) is stripped at zero network cost.
2. **`requireAltOrFigure: true`** — keeps only images with a non-empty `alt` attribute OR wrapped in `<figure>`. Filters decorative icons and social-share glyphs that defuddle let through.
3. **`minWidth: 100, minHeight: 100`** — post-fetch dimension check. Parses PNG / JPEG / GIF / WebP (VP8 / VP8L / VP8X) magic bytes and SVG `width` / `height` / `viewBox` text. Unknown formats (BMP, TIFF, ICO, AVIF) get a free pass ("can't verify → keep") rather than false-positive skip.

Result on a representative page (header logo + nav icon + 2 article images + 1 decorative + 1 ad banner + 1 share button): **7 sources → 2 download candidates**, zero wasted fetches.

#### Added

- **`npm install defuddle@^0.18.1`** — kepano's content extractor, MIT, the same library obsidian-clipper uses. Imported via `defuddle/node` entry which uses linkedom — works in pure Node, no jsdom required.
- **`src/helpers/defuddle-extract.mjs`** (NEW) — thin async wrapper around `defuddle/node`. Single export `extractMainContent(html, opts)` returning `{content, title?, author?, image?, wordCount?, usedFallback}`. Defensive: pathological input, defuddle throws, or empty-content results → `usedFallback: true` and caller falls back to raw HTML.
- **`extractImagesWithMeta(content, baseUrl)` in `src/helpers/asset-downloader.mjs`** (NEW) — single-pass HTML tokenizer that returns `[{url, alt, isFigure}]`. Tracks `<figure>` depth via a counter (O(n), no per-match lastIndexOf scans). Handles nested figures correctly. Markdown `![alt](url)` participates with `isFigure: false`.
- **`extractImageUrls`** (existing) is now a back-compat facade over `extractImagesWithMeta` that maps to URL strings. All pre-v0.14.7 callers stay green.
- **`decodeImageDimensions(buffer, contentType)` in `src/helpers/asset-downloader.mjs`** (NEW) — pure function. Parses magic bytes for PNG / JPEG (SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15) / GIF87a + GIF89a / WebP VP8/VP8L/VP8X. SVG parses `width="…px"` + `height="…px"` from the first 8 KiB, falls back to `viewBox` when the explicit attrs are missing or use em/% units. Returns `null` for unknown formats — callers treat this as "can't verify → keep".
- **`downloadOne` new options `minWidth`, `minHeight`** (default 0 at the helper level — disabled). The dimension decoder runs only when at least one is set, so legacy callers pay zero CPU. New skip reason `'too-small-dimensions'` and skipped entries include `dimensions: {width, height}` for visibility.
- **`download_page_assets` MCP tool new inputs**:
  - `defuddleFirst: boolean` (default `true`)
  - `requireAltOrFigure: boolean` (default `true`)
  - `minWidth: number` (default `100`)
  - `minHeight: number` (default `100`)

  Plus two new fields in the response payload: `defuddled: boolean` (did defuddle run successfully?) and `afterRelevanceFilter: number` (count after the alt/figure filter, before maxAssets cap). The `attempted` field still exists with the same meaning.
- **33 new tests** in `tests/asset-downloader.test.mjs` and `tests/download-page-assets.test.mjs`:
  - 10 for `extractImagesWithMeta` (alt-text presence / absence / single-quoted, figure depth-counter including nested figures, markdown `![]()` integration, dedup-keeps-first-occurrence)
  - 9 for `decodeImageDimensions` (PNG / GIF87a+89a / JPEG SOF0 / WebP VP8X / SVG with width-height / SVG viewBox fallback / unknown BMP / too-short buffer / non-buffer input)
  - 5 for `downloadOne` + `downloadAssets` dimension filter (skip-below-threshold, pass-above-threshold, decoder-not-called-when-disabled, unknown-format-kept, downloadAssets-threads-through)
  - 9 for the MCP tool wrapper (TOOL_DEFINITION schema, defuddleFirst=true default strips outside-article, defuddleFirst=false bypasses, fallback when defuddle empties content, requireAltOrFigure default skips empty alt, figure-wrapped kept, false disables, minWidth/minHeight validation, response shape always includes new fields)

#### Changed

- **`src/tools/download-page-assets.mjs`** — input pipeline restructured to: fetch HTML → (optionally) defuddle → `extractImagesWithMeta` → relevance filter → `maxAssets` cap → `downloadAssets`. The defuddle step is best-effort with raw-HTML fallback. All new behaviors are smart-by-default with individual override flags.
- **`extractImageUrls` is now a 2-line facade** over `extractImagesWithMeta`. Behavior is unchanged from v0.14.2-v0.14.6 (verified by all pre-existing tests passing).
- **TOOL_DEFINITION description** rewritten to lead with the relevance behavior so Claude picks the right defaults without reading the schema.

#### Backward compatibility

- Pre-v0.14.7 callers that set `defuddleFirst: false, requireAltOrFigure: false, minWidth: 0, minHeight: 0` get **identical** behavior to v0.14.2-v0.14.6. The new defaults change BEHAVIOR but not API shape — the response gains two extra fields (`defuddled`, `afterRelevanceFilter`) that pre-existing consumers can safely ignore.
- `extractImageUrls` signature unchanged. Internal refactor is invisible.
- `downloadOne` / `downloadAssets` new options default to 0 (disabled) at the helper level — only the MCP tool turns them on by default at 100×100. Direct helper callers are unaffected.

#### Phase E status update

Phase E is now **complete end-to-end**:
- v0.14.2 — MVP byte-size filtering ✅
- v0.14.3 — `/review+` hardening ✅
- v0.14.7 — Intelligent relevance filters (defuddle + alt/figure + dimensions) ✅

The Phase E.2 deferred work from v0.14.2 (dimension parsing) and the implicit Phase E.3 (defuddle-first relevance) are both shipped.

### Phase D.2 `/review+` hardening (concurrent thread)

`mini-/review+` on commit 74ff782 (Phase D.2 MathML→LaTeX) found ZERO P1, two P2, three P3. The two P2 + two of three P3 are addressed below; P3-2 (duplicated MathML conversion between `webpageToMarkdown` and `extract_page_metadata`) is acknowledged as acceptable double work (≈1 ms per Wikipedia page).

#### Fixed

- **P2-1 — JSDoc fantôme**: the `convertMathmlBlocksInHtml` doc claimed a `<dl><dd><math>` parent-block heuristic for display detection that was never implemented (real code checks only the `display=` attribute). Removed the false claim; clarified that Wikipedia emits `display="block"` explicitly so the attribute check alone is sufficient.
- **P2-2 — UTF-8 round-trip non-idempotent on non-UTF-8 charsets**: `Buffer.from(buf.toString('utf-8'), 'utf-8')` inflates Windows-1252 / Latin-1 / ISO-8859-* bytes to U+FFFD when they're invalid UTF-8 sequences, corrupting accented characters in surrounding prose on a converted page. Mitigation: `markitdown.mjs::toMarkdown` now extracts `contentType` and `charset` from the response headers and passes both through to the `transformContent` hook's `ctx` argument. The `mathPreservingTransform` in `convert.mjs` adds two safety gates: (1) skip the transform unless `contentType` is `text/html` / `application/xhtml+xml` / `application/xml` / unset (PDFs, images, audio, video etc. now skip the UTF-8 round-trip entirely); (2) skip the transform if `charset` is set to anything other than UTF-8 / ASCII. Either gate failing → return `null` → markitdown uses the original buffer untouched. Math conversion is sacrificed in those edge cases in exchange for not corrupting surrounding content.
- **P3-1 — Double regex evaluation on close-tag scan**: `convertMathmlBlocksInHtml` was running `.search()` then `.slice().match()` against the same `/<\/math\s*>/i` regex to extract close-tag index AND length — two passes per block. Switched to a single `.exec()` call that returns `.index` + `[0].length` in one shot. No behavior change, one fewer regex per `<math>` block on math-heavy pages.
- **P3-3 — Test gap**: +2 hardening regression tests in `tests/latex-preserver.test.mjs`:
  - **PDF-like binary input** with accidental `<math` byte sequence (no matching `</math>` close in the bounded forward scan window) → `count=0`, html unchanged, conversions array empty. Locks in the no-corruption guarantee for non-HTML responses flowing through `webpage_to_markdown`.
  - **Display attribute variants**: `display="BLOCK"` (uppercase), `display = "block"` (whitespace around `=`), `display='block'` (single-quoted) — all three correctly detected as block math. Note: unquoted `display=block` (valid HTML5 but invalid XML) is NOT tested because `mathml-to-latex` uses xmldom which rejects unquoted attributes — real-world emitters (Wikipedia, MathJax, KaTeX) always quote.

#### Skipped (acknowledged NIT)

- **P3-2 — Duplicated MathML conversion**: a single `wiki-ingest` pass calls both `webpageToMarkdown` (which converts) and `extract_page_metadata` (which converts AGAIN to populate `mathmlLatex`). Cost bounded to ~1 ms per Wikipedia page. Worth refactoring only if a hotspot emerges; until then, the cleaner data flow (each tool independently consumes raw HTML, no implicit shared state) wins over the small perf gain.

### Test count: **1055/1055 passing** (was 1020 at v0.14.6; +33 Phase E.2 + 2 Phase D.2 hardening).

## [0.14.6] — 2026-05-25 — Phase D.2 · MathML → LaTeX conversion (Wikipedia equations now survive)

Closes the deferred Phase D.2 from v0.13.10: MathML `<math>...</math>` blocks in fetched HTML are now **converted to dollar-delimited LaTeX BEFORE markitdown runs**, so Wikipedia equations, arxiv abstracts with rendered formulas, and any math-heavy page with native MathML now survive the HTML→markdown conversion as inline `$LaTeX$` or block `$$LaTeX$$` strings.

Previous behavior (v0.13.10 detection-only): `has_latex: true` was set in frontmatter, but the actual equations were stripped by markitdown along with the `<math>` tags. The skill had to tell Claude "the original page contains rendered equations" without being able to surface them.

New behavior: the equations are inlined in the markdown body as text. LaTeX-Suite, KaTeX, MathJax, and any standard Obsidian math renderer can pick them up natively. No more "equations vanished during ingestion" — Wikipedia is now first-class.

### Added

- **`npm install mathml-to-latex@^1.5.0`** — pure JavaScript MathML→LaTeX converter, MIT, ~635 KiB unpacked. One transitive dep (`@xmldom/xmldom`). Stable lib (10 releases since 2020), API is a single `MathMLToLaTeX.convert(mathmlString) → string`.
- **`convertMathmlBlocksInHtml(html)` in `src/helpers/latex-preserver.mjs`** — pure helper:
  - Finds every `<math>...</math>` block via non-backtracking open-tag scan + bounded forward search for `</math>` (max 100 KiB span per block — matches the v0.13.11 hardening pattern that took pathological input from 1900 ms → 1.8 ms).
  - For each block, calls `MathMLToLaTeX.convert(mathmlSrc)` and replaces in-place:
    - `display="block"` → `\n\n$$<latex>$$\n\n` (centered equation, blank lines around for markdown safety)
    - default (inline / no display) → `$<latex>$` (inline math)
  - Skips blocks where the lib returns an empty string (malformed MathML, unsupported elements) — leaves the original `<math>` tags untouched rather than emit broken `$$$$`.
  - Returns `{html, count, skipped, conversions: [{mathml, latex, display, converted}]}` for both substitution (use the modified HTML) and audit (inspect what was extracted).
  - Replacement runs in reverse-index order so earlier offsets stay valid during string mutation.
- **`tests/latex-preserver.test.mjs`** — **+9 new tests** for the converter:
  - Simple inline `<math>` → `$x^{2} + y$`
  - `display="block"` `<math>` → `$$\frac{1}{2}$$`
  - Multiple blocks all converted (3 blocks, mixed inline/block)
  - Empty conversion result → original `<math>` left in place
  - No `<math>` in input → HTML returned unchanged (fast path)
  - Empty / null / undefined input safe (no throw)
  - Unclosed `<math>` (page truncated mid-equation) → skipped silently
  - **HARDENING perf test**: 50k unmatched `<math ` tokens finish in < 1000 ms (typically < 200 ms)
  - Wikipedia-style integration test: surrounding prose preserved, equation inlined

### Changed

- **`src/markdownify/markitdown.mjs::toMarkdown`** — new optional `transformContent(buffer, {url, extension}) → Promise<Buffer|string|null>` parameter. When provided, the callback runs on the fetched response body before it lands in the temp file that markitdown converts. Returning `null` means "no change, use original buffer" (the no-op path stays cheap). String returns are coerced to UTF-8 Buffers. The hook is opt-in — existing callers see no behavior change.
- **`src/tools/convert.mjs::webpageToMarkdown`** — now passes a `mathPreservingTransform` callback to `toMarkdown`. The transform decodes the fetched HTML as UTF-8, runs `convertMathmlBlocksInHtml`, and returns the modified HTML when at least one MathML block was successfully converted (else returns `null` for the no-op fast path). Pages without `<math>` blocks pay only a regex scan cost (no behavioral change).
- **`src/tools/extract-page-metadata.mjs`** — handler now exposes `mathmlLatex: [{latex, display}]` in its response when MathML blocks are present. Lets the wiki-ingest skill spot-check the conversion OR surface the extracted equations as a `## Équations` section. When no MathML present, `mathmlLatex: []` (consistent shape, easy to test for).
- **`skills/wiki-ingest/SKILL.md`** — Phase D section updated:
  - Removed instruction "mention that the original page contains rendered equations" (no longer needed — equations are now in the markdown body).
  - Added instruction explaining the new auto-conversion: preserve `$LaTeX$` / `$$LaTeX$$` strings in the body verbatim like any other math.
  - Added pointer to the new `mathmlLatex` audit field for callers that want to verify the conversion.

### Test count: **1020/1020 passing** (was 1011 at v0.14.5; +9 Phase D.2).

### Backward compatibility

- The new dep `mathml-to-latex` is purely additive. No existing API changes shape; `webpageToMarkdown` continues to return the same markdown string (just now with equations preserved).
- The `transformContent` hook is opt-in; existing `toMarkdown` callers without the parameter behave identically to before.
- `extract_page_metadata` adds a new field `mathmlLatex` (always present, defaults to `[]`). Pre-existing fields are unchanged.
- Pages without `<math>` blocks: no behavior change. The transform is a no-op for them (single regex scan, returns null = "use original buffer").
- The skill update is instructional — no fanout to existing source pages required.

### Phase D status update

Phase D is now **complete end-to-end**:
- v0.13.10 — Detection (`has_latex` frontmatter flag) ✅
- v0.14.6 — MathML conversion (equations in body) ✅

Equation image substitution (`<img alt="$..."` patterns from legacy Wikipedia / Pandoc HTML) remains deferred — rare enough in modern content to wait for a concrete trigger.

## [0.14.5] — 2026-05-25 — Phase F · Highlights persistence (obsidian-clipper port)

Phase F of the [[obsidian-clipper]] borrowing roadmap. Adds **dual-format highlight serialization** so the `wiki-ingest` skill can preserve user-selected text spans as BOTH human-readable Obsidian `[!highlight]` callouts AND machine-readable frontmatter YAML array. The two views are kept in sync — frontmatter is the source of truth, callouts are presentation.

This release is the **format layer only**. Manual input flow (the user pastes structured highlights into the ingest prompt) ships now. Automatic extraction (browser-extension overlay → bridge endpoint → re-hydration when opening a source page) stays deferred as Phase G — the format here is schema-compatible with obsidian-clipper so a future bridge round-trip is straightforward.

### Added

- **`src/helpers/highlights-format.mjs`** (NEW) — pure helper module, no deps. Five exported functions plus a frozen color list:
  - `normalizeHighlight(raw)` — canonical-shape converter. Mandatory `text`, optional `color` (default `yellow`) / `note` / `xpath` / `offset_start` / `offset_end`. Stable id: prefers caller-supplied (must match `^[A-Za-z][A-Za-z0-9-]*$`, the Obsidian block-id shape), else generates `h-<sha256(text|xpath)[:8]>`. Same `(text, xpath)` → same id → idempotent re-ingestion.
  - `renderCallout(highlight)` — emits an Obsidian `[!highlight] color=<X>` callout block. Multi-line text gets `> ` prefix per line, blank inner lines become bare `>` (Obsidian-paragraph-break-inside-callout). Trailing `> ^<id>` block anchor lets other notes link to the highlight via `[[<page>#^<id>]]`.
  - `renderFrontmatterArray(highlights)` — emits the YAML `highlights:` array. Conservative YAML scalar quoting: bare unquoted only for the allowlist `[A-Za-z0-9_./- ]+` (no reserved indicators, no whitespace edges); everything else double-quoted with `\` `"` `\n` `\r` `\t` escapes. Round-trip safe.
  - `serializeHighlights(rawArray)` — top-level wrapper. Returns `{normalized, calloutBlocks, frontmatterYaml}`. Empty/null/undefined input is safe (returns empty content + `highlights: []`).
  - `parseHighlights(frontmatterValue)` — read-side. Coerces each entry through `normalizeHighlight` so partial hand-edits get the canonical shape back. Non-array input throws.
  - `RECOGNIZED_COLORS` — frozen list of supported callout colors (`yellow`, `pink`, `blue`, `green`, `orange`, `purple`, `red`). Documentational only — we don't enforce.
- **`tests/highlights-format.test.mjs`** (NEW, 33 tests). Covers: normalization defaults + edge cases (missing text throws, blank text throws, non-object input throws, trimmed text, stable id derivation, explicit id preservation, invalid id replacement, color lowercasing, integer offset coercion); callout rendering (single-line, multi-line with `> ` prefix per line, blank-line handling, note inclusion, color from highlight not hardcoded, id always at end); frontmatter array rendering (empty → `highlights: []`, full fields, multi-line text escape, double-quote + backslash escape, reserved-YAML-char quoting, multiple highlights); top-level serialize wrapper; round-trip parse; RECOGNIZED_COLORS frozenness.

### Changed

- **`skills/wiki-ingest/SKILL.md`** — new "Highlights persistence (Phase F, v0.14.4+)" section (6 instructions) explaining the dual-format flow:
  1. Normalize input via `normalizeHighlight`.
  2. Call `serializeHighlights(normalized)`.
  3. Insert `## Highlights` H2 section before `## Sources` with the `calloutBlocks`.
  4. Add `highlights:` to frontmatter with the YAML array.
  5. Idempotence rule: existing frontmatter is source of truth — `parseHighlights → merge by id → re-serialize fully`. Don't append callouts manually.
  6. Default is highlights-off — don't fabricate / auto-extract (browser-extension auto-extraction stays in [[obsidian-clipper]] section "Extension navigateur router-aware" as deferred Phase G/🔮).

### Test count: **1011/1011 passing** (was 978 at v0.14.4; +33 from Phase F).

### Backward compatibility

- Phase F is opt-in via user-provided highlights. Existing ingestion flows without highlights are unchanged.
- No new MCP tool — `wiki-ingest` consumes the helper directly. No public API surface added.
- No npm dependencies. Pure Node + crypto for sha256.
- Frontmatter schema (`highlights:` array shape) is compatible with obsidian-clipper's own format so a future round-trip (clipper export → router import OR vice-versa) preserves structure.

### Deferred to Phase G (if bridge re-hydration demand surfaces)

- **Bridge endpoint** `GET /highlights/render?vault=X&path=Y` that reads the frontmatter `highlights:` array and returns positioned HTML overlay using the stored `xpath` + `offset_start`/`offset_end`.
- **Obsidian plugin layer** — inject the overlay when a source page opens so the highlights appear in-context, not just as callouts at the bottom.
- **XPath compatibility tests** — validate the stored xpath round-trips across 5+ different source sites (browser DOM normalization varies).
- **Browser-extension auto-extract** (🔮) — capture the user's selection in-browser and POST to the router, eliminating the manual paste flow.

## [0.14.4] — 2026-05-25 — `/review+` micro-hardening on v0.14.3 (P3-a + P3-b polish)

Second-pass mini-/review+ on commit `dfb65be` found ZERO P1/P2 — fixes from v0.14.3 close the issues cleanly per direct execution probes (nested brackets work as documented, ReDoS-free, P2-1 stat guards correctly handle ENOENT/non-dir, etc.). Three P3 nits remained, two worth landing.

### Changed

- **P3-a — `downloadAssets` JSDoc now documents `_statFn`.** `src/helpers/asset-downloader.mjs`. The injection seam was added in v0.14.3 and used in tests, but the `@param` block didn't list it. Future contributors might miss the test-stub pattern. Added: `@param {Function} [opts._statFn]` with explanation of the parent-exists + isDirectory() guards it backs.

### Added

- **P3-b — Shared-fixture lock-step regression test pins extract / rewrite regex parity.** `tests/asset-downloader.test.mjs`. The two markdown `![alt](url)` matchers (one in `extractImageUrls`, one in `rewriteAssetUrls`) MUST accept the same set of inputs — otherwise a future edit to only one would leave stale remote URLs for downloaded assets, or rewrite URLs we never extracted. New test loops 7 fixtures (simple alt, empty alt, multi-word, nested brackets, double-nested alt, with-title, wikilink-style) through extract → build map → rewrite, asserts every extracted URL is gone from the rewritten output. Catches drift in either regex automatically.

### Skipped (acknowledged NIT)

- **P3-c — `Number.isFinite` accepts `Number.MAX_SAFE_INTEGER` for `maxBytes`.** Not exploitable (`safeFetchBinary` enforces its own per-buffer cap regardless), and a hard upper bound would be opinionated. Documented here so the question doesn't get re-asked. Defensible to leave.

### Test count: **978/978 passing** (was 977 at v0.14.3; +1 lock-step regression).

### Backward compatibility

- Documentation-only change in `asset-downloader.mjs` JSDoc.
- New test doesn't touch any code path — purely additive.

## [0.14.3] — 2026-05-25 — `/review+` hardening on Phase E v0.14.2 (asset download)

`mini-/review+` on commit ddc6ecc surfaced 2 P2 correctness/security findings and 3 P3 polish items. All fixed with 9 new regression tests pinning the behaviors.

### Fixed

- **P2-1 — `downloadAssets` could silently write into arbitrary system directories when `MD_ALLOWED_PATHS` is unset.** `src/helpers/asset-downloader.mjs::downloadAssets`. With the env-var sandbox off, `assertPathAllowed` is a no-op, so a hostile MCP caller could pass an `outputDir` like `/etc/cron.d` — `fs.mkdir(..., {recursive: true})` silently succeeded against the existing dir and image writes would clobber unrelated system files. **Fix:** two new guards.
  - Pre-mkdir: stat the PARENT dir and refuse if it doesn't exist (ENOENT). Prevents bootstrapping arbitrary directory trees like `/etc/cron.d/whatever-attacker-wants/`.
  - Post-mkdir: stat the resolved path and assert `isDirectory()`. Catches symlink-to-file races and the `mkdir -p` edge case where a pre-existing symlink resolves to a non-directory target.
  - Both wired through a new `_statFn` injection seam so tests can drive ENOENT / file-not-dir / happy-path branches deterministically.

- **P2-2 — `extractImageUrls` and `rewriteAssetUrls` silently dropped markdown images whose alt text contained nested brackets** (e.g. `![Photo of [Eiffel tower]](url)`). `src/helpers/asset-downloader.mjs:105` + `:405`. The pre-fix regex `\[[^\]]*\]` bailed on the inner `[`, so the whole image reference was invisible: extract didn't queue it for download, and rewrite didn't replace it. Real impact: Wikipedia-style alt with `[citation needed]` markers, blogs with bracketed-attribution patterns. **Fix:** swap to `(?:\[[^\]]*\]|[^\]])*` (one level of nested-bracket balanced matching) in BOTH regexes — extract + rewrite must stay in sync or we'd download images we can't rewrite, leaving stale remote URLs.

### Changed

- **P3-1 — `pickAssetFilename` now strips LEADING dots** from the sanitized URL segment. Pre-fix, `/...png` yielded the literal filename `...png` and `/.png` yielded `.png`, both of which are hidden files on POSIX (`ls` hides them by default — surprising the user). The strip happens BEFORE the pure-dots check, so `/..` → `` → sha256 fallback (which is correct for an unnamed asset). 3-line fix in `pickAssetFilename`.

- **P3-2 — Skill `wiki-ingest` Phase E instructions now explain how to resolve the vault absolute path.** Pre-fix, the skill told Claude to call `download_page_assets({outputDir: "<vault-absolute-path>/.assets/..."})` without saying how to obtain `<vault-absolute-path>`. In workspace-bound mode (code repo associated with a separate vault), concatenating cwd with `wiki/...` produces a non-existent path — the well-known trap codified in the global CLAUDE.md. Added a 1-line resolution recipe at step 1: "Resolve via `list_vaults` and pick the entry's `path` field, then concatenate with `/wiki/.assets/<source-slug>/`."

- **P3-3 — MCP tool `download_page_assets` now validates numeric arguments explicitly.** `src/tools/download-page-assets.mjs`. Pre-fix, passing `maxAssets: 0` silently produced an empty no-op (`extracted: 24, attempted: 0, downloaded: []`) — the caller couldn't tell whether the tool was broken or whether the cap was the cause. New explicit validators reject `maxAssets / concurrency` ≤ 0 or non-integer, and `minBytes / maxBytes` outside their valid ranges, with clear error messages including the offending value.

### Added

- **9 new regression tests** across `tests/asset-downloader.test.mjs` (5) and `tests/download-page-assets.test.mjs` (4):
  - HARDENING P2-1 (file-as-dir guard): parent-missing rejection, file-not-dir rejection.
  - HARDENING P2-2 (nested brackets): extractImageUrls + rewriteAssetUrls both accept `![alt with [nested]](url)`.
  - HARDENING P3-1 (leading-dot trim): `...png`, `.png`, and `..` → safe filename / sha256 fallback.
  - HARDENING P3-3 (numeric validation): `maxAssets: 0`, `maxAssets: -5`, `maxAssets: 1.5`, `concurrency: 0`.

### Test count: **977/977 passing** (was 968 at v0.14.2; +9 hardening).

### Backward compatibility

- All fixes are additive guards on existing code paths. The only call-site change is the `_statFn` injection in `downloadAssets` — defaults to `fs.stat`, so existing callers keep working.
- The numeric validators in the MCP tool are stricter than pre-fix — any client that was relying on `maxAssets: 0` to silently skip downloading will now see a clear error instead. This is a pinning-the-correct-behavior change, not a regression: nobody should be passing those values intentionally.
- The nested-bracket regex fix is purely additive: pre-fix the affected images were INVISIBLE to the tool. Post-fix they're processed. No change for images that were already working.

## [0.14.2] — 2026-05-25 — Phase E · Asset download (obsidian-clipper port)

Phase E of the [[obsidian-clipper]] borrowing roadmap. Adds **opt-in image asset preservation** to the ingestion pipeline so `wiki-ingest --save-assets` can mirror a page's images into the vault (typically `<vault>/wiki/.assets/<source-slug>/`) and rewrite the markdown body to reference local paths. Without this, ingested pages keep remote `![](url)` references that rot over time or become unreachable offline.

**Default-off** — saving assets costs bandwidth + disk + a write-tool exposure surface, so the opt-in flag stays opt-in. Reading flows stay unchanged.

### Added

- **`src/helpers/safe-fetch-binary.mjs`** (NEW) — SSRF-safe binary fetcher, sibling of `safe-fetch-html.mjs`. Same pinned-IP undici dispatcher + manual redirect re-SSRF per hop + body-size cap + timeout, but returns `{buffer, contentType, finalUrl}` instead of `{html, finalUrl}`. Default cap 10 MiB per asset (vs 5 MiB for HTML — images can be larger). Acknowledged duplication with `safe-fetch-html.mjs` documented; a future refactor could extract a private `_safe-fetch-core.mjs`.
- **`src/helpers/asset-downloader.mjs`** (NEW) — pure helper module with 5 exports:
  - `extractImageUrls(content, baseUrl)` — quote-aware HTML `<img src>` + `<source srcset>` (first URL only) + markdown `![alt](url)` extraction. Resolves relative URLs against `baseUrl`. Skips `data:` / `blob:` / `javascript:` URIs. Dedupes.
  - `pickAssetFilename(url, buffer, contentType, usedNames)` — sanitizes URL path segment (`[A-Za-z0-9._-]` only, ≤80 chars), refuses `.`/`..`/`...`, forces extension from Content-Type (overrides `.html`/`.exe` sneaky URL extensions), falls back to `sha256(buffer).slice(0,16) + ext` on empty/collision.
  - `downloadOne(url, outputDir, opts)` — single-asset wrapper with size filtering (`minBytes` default 1024 to skip icons, `maxBytes` default 10 MiB).
  - `downloadAssets(urls, outputDir, opts)` — bulk wrapper with bounded parallelism (`concurrency` default 4). Creates `outputDir` recursively. Returns `{downloaded[], skipped[], errors[], urlMap}`.
  - `rewriteAssetUrls(content, urlMap, opts)` — pure markdown/HTML rewriter. Quote-aware. Preserves markdown title text. Handles protocol-relative `//host/path` references. Leaves un-mapped URLs alone (failed downloads stay remote).
- **`src/tools/download-page-assets.mjs`** (NEW) — MCP tool wrapper. Accepts `{url|html, baseUrl, outputDir, minBytes, maxBytes, concurrency, maxAssets}`. Validates absolute `outputDir`, refuses outside `MD_ALLOWED_PATHS` sandbox, caps URLs at `maxAssets` (default 200) to prevent attacker-page DoS. Returns serialized `urlMap` object (plain object, not Map — JSON transport).
- **`tests/asset-downloader.test.mjs`** (NEW, 33 tests) — extraction (HTML quote variants, srcset, markdown, relative resolution, dedup, data-URI skip, baseUrl-required guard), filename picking (content-type ext override, sha256 fallback, collision avoidance, 80-char cap, double-ext prevention), download flow (happy path, too-small skip, fetch errors, abs-path guard), bulk (dedup across batch, mixed results, concurrency cap respected — verified via in-flight peak counter), rewrite (markdown title preservation, HTML quote-style preservation, un-mapped left alone, protocol-relative remap, trailing-slash trimming).
- **`tests/download-page-assets.test.mjs`** (NEW, 13 tests) — TOOL_DEFINITION shape, input validation (XOR url/html, missing baseUrl, missing/relative outputDir), html-branch end-to-end without network (urlMap serialization to plain object, maxAssets cap respected, baseUrl passthrough), wiring into src/index.mjs (boot-time cross-check, WRITE_TOOL_NAMES inclusion).
- **`src/index.mjs`** — registered `download_page_assets` in TOOLS + TOOL_HANDLERS + WRITE_TOOL_NAMES (8 → 9 write tools). `tests/readonly.test.mjs` bumped count assertion accordingly.

### Changed

- **`skills/wiki-ingest/SKILL.md`** — frontmatter template extended with `assets_count: <N>` (emit only when `--save-assets` was used AND ≥1 asset saved). New "Asset preservation (Phase E, v0.14.x+)" section with 5 instructions:
  1. Call `mcp__obsidian-router__download_page_assets({url, outputDir: "<vault>/.assets/<source-slug>/"})` after metadata + LaTeX extraction.
  2. Use the returned `urlMap` to rewrite `![alt](remoteUrl)` and `<img src="remoteUrl">` references in the body to local paths.
  3. Set `assets_count` frontmatter (omit if zero, consistency with `has_latex`).
  4. Mention non-empty `errors` in `## Summary` (don't fail the ingestion — partial preservation is the point).
  5. Default is `--save-assets=false` — only run when user explicitly asks.

### Test count: **968/968 passing** (was 922 at v0.14.1; +33 asset-downloader + 13 download-page-assets = +46 from Phase E).

### Backward compatibility

- Opt-in flag. `wiki-ingest` without `--save-assets` behaves exactly as v0.14.1 — markdown keeps remote `![](url)` references.
- `download_page_assets` MCP tool is read-only-safe (excluded from listing under `OBSIDIAN_ROUTER_READONLY=true`) via WRITE_TOOL_NAMES.
- No npm dependencies added. Pure Node + the existing `undici` dispatcher pattern from `safe-fetch-html.mjs`.

### Deferred to Phase E.2 (if user demand)

- Image dimension parsing to skip icons by width/height instead of size threshold. Needs format-specific decoders for PNG (bytes 16-24), JPEG (SOF markers), GIF (bytes 6-10), WebP (VP8/VP8L chunks), SVG (XML parse).
- `<picture>` / `srcset` multi-resolution selection (we currently take the first `<source srcset>` entry; the caller can post-filter).
- Non-image asset types (video, audio, animated GIF retained but only as image-type).
- Image format conversion / re-encoding (e.g. WebP→PNG for older Obsidian themes that don't render WebP).

## [0.14.1] — 2026-05-25 — `/review+` hardening pass on the v0.14.0 auto-update path

Six review passes (Claude `Code Reviewer` agent + `codex review` CLI in parallel) on commit 5300e0d surfaced one silent BLOCKER, four IMPORTANT correctness/security findings, and one test-isolation gap. All fixed with regression tests pinning the behaviors.

### Fixed

- **BLOCKER — `installed_plugins.json` v2 array schema silently dropped mutations.** The current Claude Code schema is `plugins["<plugin>@<marketplace>"] = [{ scope, installPath, version, ... }, ...]` (array of scoped install entries, not a single object). The old `findInstalledEntry` returned the array; `entry.installPath = X` then attached non-index properties that `JSON.stringify` drops. Net effect: `tryAutoUpdate` reported success but `installed_plugins.json` stayed unchanged → Claude Code kept loading the old cache version after `/reload-plugins`. Renamed to `findInstalledEntries`, now matches every entry whose `installPath` resolves to the current cache dir (handles multi-scope user+project installs that share the same on-disk cache version) and refuses to guess when the array has multiple unrelated entries.
- **BLOCKER — `npm install` ran `postinstall` from freshly-pulled upstream code.** This repo declares `postinstall: node scripts/install-markitdown.mjs`. Without `--ignore-scripts`, every auto-update silently executed arbitrary upstream lifecycle scripts from a SessionStart hook with the user's privileges — supply-chain footgun on every release. Now passes `--ignore-scripts`; the bundled Python venv that markitdown needs is detected separately (see next item) and surfaced to the user as a remediation tip.
- **IMPORTANT — markitdown breakage detection after `--ignore-scripts`.** Skipping `postinstall` means the new cache dir gets no `.venv/`, and `resolveMarkitdownPath` (`src/markdownify/utils.mjs`) cascades from `<projectRoot>/.venv` to bare `markitdown` on PATH → ENOENT for users on the bundled venv. New helper `detectMarkitdownStatus` distinguishes `ok` / `will-break` / `never-installed` and honors both override flags (`MARKITDOWN_PATH` and `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1`, matching what the notice promises). The success notice now includes a one-liner recovery command when `will-break`, instead of silently breaking the conversion tools after `/reload-plugins`.
- **IMPORTANT — copy step skipped against an empty/corrupt cache dir.** Before: `if (!fs.existsSync(newCacheDir))` skipped the entire copy if a previous partial run had left an empty dir; `npm install` then ran against nothing and failed opaquely. Now: re-copies unless `package.json` exists AND already reports `newVersion`; uses `cpSync(..., { force: true })` so the repair actually overwrites stale leftovers.
- **IMPORTANT — `rewriteSettingsHookPaths` ate its own result + missed mixed-separator paths.** Two issues: (a) caller discarded the `{changed}` return, so the user never knew when pinned hook paths weren't updated; (b) the two hardcoded separator variants (`/cache/...` and `\cache\...`) missed real-world mixed paths like `C:\Users\u/.claude/plugins/cache/mp/pl/0.1.0/...`. Now a single separator-agnostic regex (`[\\/]+`) handles all three styles, preserves the existing separator pattern via capture group, and uses a lookahead `(?=[\\/])` so versions that are prefixes of others (`0.1.0` vs `0.1.0-beta.1`) aren't accidentally rewritten. Result shape is now `{changed, settingsExists}`, propagated up to the success notice, which surfaces an honest 2-step remediation (delete stale entries → re-run `--install-hooks`) when the rewrite was skipped — because `--install-hooks` alone only appends missing hooks, it does NOT rewrite existing stale paths.
- **NIT — test regex with no-op escape + unescaped dots.** `new RegExp(newCacheRel.replace(/\//g, '\\/'))` was a no-op (forward slashes don't need escaping in the RegExp constructor) and unescaped dots made the match looser than intended. Replaced with explicit `.includes()` assertions on both the new path AND the absence of the old path.
- **NIT — markitdown integration tests leaked ambient env.** `tryAutoUpdate` hardcodes `process.env`, so a CI/dev machine with `MARKITDOWN_PATH` or `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` set would short-circuit those two tests to `ok`. Now isolated in a nested `describe` with `before`/`after` env save+restore.

### Added (regression tests)

18 new tests covering the fixes: v2-schema mutation persistence (3 cases including multi-scope-same-installPath), `--ignore-scripts` enforcement, partial-run cache-dir repair, mixed-separator paths + prefix-version isolation, `settingsExists` flag propagation, `detectMarkitdownStatus` for all 5 paths (override / new venv / will-break / never-installed / both override flags). Total test count: 904 → 922.

### Deferred (filed for follow-up, not addressed in this pass)

- Defense-in-depth path-traversal check on `parseMarketplaceCachePath` (unreachable in practice — `pluginRoot` always comes from `__dirname` of the hook).
- `dryRun` write-then-restore in `bump-version.mjs` (sem-clean refactor: split helpers so disk writes only happen outside dry-run).
- Synchronous auto-update inside the SessionStart hook can theoretically freeze for `NPM_INSTALL_TIMEOUT_MS` (180 s) on first-time installs of large dep trees — would need a "applying in background, pickup next session" architecture.

## [0.14.0] — 2026-05-25 — Opt-in auto-update + version-sync script

Closes the "skill updates never reach Nicolas's workspace until he runs `/plugin update`" gap. Two related changes:

1. **`scripts/bump-version.mjs`** — new helper that bumps the version in all three files Claude Code's marketplace mechanism reads (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — both `metadata.version` and `plugins[0].version`) in one command, plus inserts a CHANGELOG stub. Idempotent (re-running on same version is a no-op), refuses to downgrade. Fixes the silent-drift bug where `package.json` was at v0.13.x for several releases but `plugin.json` + `marketplace.json` stayed at v0.12.7 — meaning `/plugin update` on downstream installs was a no-op even when a new version had shipped. Run as `npm run bump <new-version>` or `node scripts/bump-version.mjs <new-version>`.

2. **`hooks/check-router-update.mjs` — opt-in auto-update mode** (env var `OBSIDIAN_ROUTER_AUTO_UPDATE=true`). When set + a newer version is detected on GitHub, the SessionStart hook replicates what `/plugin update` does internally: `git pull --ff-only` in the marketplace clone, copy the new version into `~/.claude/plugins/cache/.../<new-version>/`, `npm install --omit=dev`, update `installed_plugins.json` atomically, and rewrite pinned hook paths in `~/.claude/settings.json` (Claude Code does NOT do this rewrite on `/plugin update` — confirmed via docs: "When a plugin updates mid-session, hook commands keep using the previous version's path. Run `/reload-plugins` to switch."). After success, emits a "🆙 Auto-updated v… → v…, run `/reload-plugins` or restart" notice. Fails silently on any error (dev install, dirty marketplace, npm failure, missing `installed_plugins.json`, etc.) and falls back to the standard manual notice with the failure reason inline.

### Added

- **`scripts/bump-version.mjs`** (NEW, exported functions: `bumpAll`, `updateJsonVersion`, `insertChangelogStub`) — version-sync script with `--dry-run` and `--no-changelog` flags. CLI exits 0 on success / 1 on bad args or invalid semver / downgrade refusal.
- **`src/helpers/plugin-auto-update.mjs`** (NEW, exported: `tryAutoUpdate`, `parseMarketplaceCachePath`, `rewriteSettingsHookPaths`) — pure-ish helpers (filesystem + subprocess) extracted from the hook so tests can drive them with fixtures + stubbed `gitRun` / `npmRun` runners.
- **`tests/bump-version.test.mjs`** (NEW, 22 tests) — happy path, idempotency, downgrade refusal, invalid semver, desync handling (the actual production bug this script exists to fix), dry-run, CHANGELOG insertion + idempotency, fallback to `# Changelog` heading when `[Unreleased]` absent, malformed-file errors, CLI exit codes.
- **`tests/plugin-auto-update.test.mjs`** (NEW, 21 tests) — `parseMarketplaceCachePath` matrix, full `tryAutoUpdate` happy path with fake `<HOME>/.claude/plugins/` tree + stubbed git/npm, each bail-out path (dev install, dirty marketplace, missing .git, version mismatch, npm failure, missing/malformed `installed_plugins.json`, nested `plugins:` schema, copy idempotency), `rewriteSettingsHookPaths` for both `/cache/.../<v>/` and `\cache\...\<v>\` variants, defensive array walking.
- **`npm run bump <version>`** — convenience npm script alias for the bump-version CLI.
- **`docs/how-to-update.md`** — new "Path C — Auto-update (opt-in)" section in both EN and FR sections, documenting the env var, the 5-step replication of `/plugin update`, the safety guards (skip on dev install / dirty / divergent / version mismatch / npm failure / missing `installed_plugins.json`), the one-session lag, and the `/reload-plugins` interaction.

### Changed

- **`.claude-plugin/plugin.json`** + **`.claude-plugin/marketplace.json`** — bumped from stale v0.12.7 (silently behind for 7 releases) to v0.14.0 via the new bump-version script. After this release, all 3 files stay in lock-step.
- **`hooks/check-router-update.mjs`** — refactored to import `tryAutoUpdate` from `src/helpers/plugin-auto-update.mjs`. When `OBSIDIAN_ROUTER_AUTO_UPDATE` is set + an update is available, calls the helper before composing the notice; on success, emits the "auto-updated" notice instead of the manual one; on failure, falls back to the manual notice with the failure reason embedded.

### Test count: **867/867 passing** (was 824 at v0.13.9 + ~21 from v0.13.10 LaTeX; +43 from the two new test files).

### Backward compatibility

- Auto-update is **opt-in via env var**. Users who don't set `OBSIDIAN_ROUTER_AUTO_UPDATE` see exactly the v0.13.x behavior (manual notice + `/plugin update`).
- `bump-version.mjs` refuses to downgrade — accidentally typing a lower version errors out with a clear message instead of corrupting state.
- The settings.json hook-path rewrite is best-effort: a failure (read error, parse error, write error) returns `changed: false` silently. The auto-update as a whole still reports success because the rest of `/plugin update`'s work has been done — the consequence of a missed rewrite is just that hooks keep firing from the old version dir until the user re-runs `setup-vault.mjs --install-hooks`.
- Dev installs (npm link, repo checkouts outside `~/.claude/plugins/cache/`) detect themselves via `parseMarketplaceCachePath` and skip auto-update unconditionally. Roland's local dev workflow is unchanged.

## [0.13.10] — 2026-05-25 — Phase D · LaTeX preservation MVP (obsidian-clipper port)

Phase D of the [[obsidian-clipper]] borrowing roadmap. Adds **LaTeX/math detection** to the ingestion pipeline so `wiki-ingest` can set `has_latex: true` in source-page frontmatter and instruct Claude to preserve `$...$` / `$$...$$` blocks verbatim instead of reformatting them to Unicode or stripping them. Without this, Wikipedia pages with MathML, blogs using KaTeX, and arxiv abstracts all lose their math during ingestion.

**MVP scope** — detection-only. This release flags pages that contain math; preservation in the body is enforced by the wiki-ingest skill telling Claude not to touch `$...$`. MathML→LaTeX conversion and equation-image substitution are deferred to Phase D.2 (would need the `mathml-to-latex` npm dep, opt-in based on user demand).

### Added

- **`src/helpers/latex-preserver.mjs`** (NEW) — pure helper module, no deps. Two complementary detectors:
  - `detectLatexInHtml(html)` — runs on raw HTML. Returns `{hasLatex, signals: {mathml, katex, mathjax, dataLatex, dollarInline, dollarBlock}}`. Catches MathML `<math>` tags, KaTeX script/CSS/class hooks, MathJax script/config/class hooks, `data-latex`/`data-tex`/`data-math` attributes (Mathjax-3 SSR, Pandoc HTML), and `$...$` body text (with `<script>`/`<style>` stripping to avoid false positives in stylesheets).
  - `detectLatexInMarkdown(md)` — runs on extracted markdown. Returns `{hasLatex, inlineCount, blockCount}`. Filters out currency (`$5.99`, `$JPY`) by requiring LaTeX-looking content (backslash command, `^`/`_`, Greek letter) inside `$...$`. Skips fenced code blocks (```` ``` ```` and `~~~`) entirely so shell prompts and regex don't pollute.
  - `hasLatex` threshold: any of MathML / KaTeX / MathJax / data-latex signals, OR ≥1 `$$` block, OR ≥2 inline `$...$` pairs (1 isolated pair could be currency mention).
- **`tests/latex-preserver.test.mjs`** (NEW, 29 tests). Covers: currency rejection ($5.99/$JPY), Greek letters / backslash commands / sub-superscripts inside `$...$`, fenced code block skipping (`` ``` `` + `~~~`), MathML tag counting, KaTeX/MathJax detection via script src + class hooks + config, data-latex/data-tex counting, `<script>`/`<style>` text isolation, combined-signals integration (Wikipedia-style MathML + KaTeX-rendered blog).

### Changed

- **`src/tools/extract-page-metadata.mjs`** — handler now calls `detectLatexInHtml` on the fetched HTML and augments the response with `hasLatex: bool` and `latexSignals: {mathml, katex, mathjax, dataLatex, dollarInline, dollarBlock}`. TOOL_DEFINITION description updated to mention math detection. **+2 regression tests** in `tests/extract-page-metadata.test.mjs` verifying the new fields (plain HTML → `false`, MathML → `true`, KaTeX-rendered → `true`).
- **`skills/wiki-ingest/SKILL.md`** — Step 4 frontmatter template extended with `has_latex: <metadata.hasLatex>` (emit only when true to keep frontmatter tight). New section "LaTeX preservation (Phase D, v0.13.10+)" instructing Claude to:
  1. Emit `has_latex: true` in frontmatter when metadata says so (Obsidian/KaTeX MathBlock will render).
  2. Preserve `$...$` and `$$...$$` blocks **verbatim** in the body — never reformat `$x^2$` as `x²`, never strip `$$\sum_n a_n$$`, never paraphrase formulas.
  3. If markitdown stripped MathML, mention in `## Summary` that "the original page contains rendered equations" — never fabricate replacement LaTeX from descriptions.
  4. Use `latexSignals` to decide whether `has_latex: true` is well-founded or a false positive (currency-heavy page that tripped the heuristic).

### Test count: **855/855 passing** (was 824 at v0.13.9; +29 latex-preserver + 2 extract-page-metadata Phase D regressions).

### Backward compatibility

- Detection is purely additive. `extract_page_metadata` continues to return the same payload shape with **two new fields appended** (`hasLatex`, `latexSignals`) — pre-existing callers ignore them.
- `wiki-ingest` skill change is instructional only (markdown procedure). Existing source pages without `has_latex` continue to work; new ingestions augment frontmatter when math is detected.
- No npm dependencies added. The `mathml-to-latex` package mentioned in the original Phase D plan is deferred to Phase D.2 (conversion-mode, opt-in).

### Deferred to Phase D.2 (if user demand surfaces)

- `mathml-to-latex` npm dep + `htmlMathmlToLatex(html)` helper to replace `<math>...</math>` blocks with `$$...LaTeX...$$` before markitdown converts.
- `htmlImageEquationsToLatex(html)` to detect `<img alt="$..."` patterns (Wikipedia legacy renderer, Pandoc) and substitute with the source LaTeX.
- Post-process markdown to re-inject dropped LaTeX from a pre-conversion HTML LaTeX-extraction pass.

## [0.13.9] — 2026-05-25 — Fresh-machine click-to-open: 3 setup gaps closed

Closes the three structural gaps that made a fresh-machine install **fail to produce working click-to-open links out of the box**, even though the bridge plugin, Local REST API, and the convention all existed. Trigger: Roland asking *"pourquoi ce n'est pas configuré d'office sur une nouvelle machine quand j'installe le routeur ?!"* (2026-05-25).

The three gaps and their fixes:

1. **Vaults bootstrapped before v0.10.x stay HTTPS-only** — `patchRestApiData()` writes `insecurePort` + `enableInsecureServer: true` at bootstrap time, but `--sync-plugins --force` deliberately preserves `data.json` for credential safety, so it doesn't backfill those fields. Without them, vaults fall back to HTTPS-only, which Bitdefender / ESET / Kaspersky silently drop. → **New mode `--upgrade-insecure-server[-all]`**: patches ONLY those two fields, preserves apiKey + port + cert + everything else. Idempotent. Respects user-set `insecurePort` even if it collides with another vault (surface, don't mutate). Batch mode iterates `portRegistry` and detects collisions across vaults when allocating fresh.

2. **The global `~/.claude/CLAUDE.md` convention isn't propagated** — the "Obsidian vault links" section that tells Claude to emit `http://127.0.0.1:<insecurePort>/open/<path>` lives in the user's private global CLAUDE.md, which is per-machine. On a fresh machine Claude generates `obsidian://` URIs (filtered by Claude Code CLI on click) or `https://` (dropped by Bitdefender), so the user gets dead links. → **New mode `--install-global-convention <name>`** + companion `--list-global-conventions`. Appends a snippet shipped under `templates/global-claude-md-snippets/` to `~/.claude/CLAUDE.md` with HTML-comment markers (`<!-- BEGIN obsidian-mcp-router:<name> -->` … `<!-- END ... -->`) for idempotency. Re-runs are no-ops; `--force` replaces the marker block while preserving surrounding user edits. Initial snippet shipped: `obsidian-vault-links`.

3. **`meta-setup` skill doesn't discover vaults** — installing the router (`meta-setup`) does `npm link` + Claude Code registration but touches no vault. The user must manually run `setup-vault.mjs <path>` for each pre-existing vault, easy to skip. → **New mode `--discover-vaults [--bootstrap-all]`**: scans well-known per-OS locations (`C:/VAULTS`, `~/Documents/Obsidian`, `~/Obsidian`, iCloud `Mobile Documents/iCloud~md~obsidian/Documents`, Google Drive desktop `<drive>:\Mon Drive\VAULTS` etc.) for directories with `.obsidian/`, classifies each as `reference` | `registered` | `candidate` | `partial`. `--bootstrap-all` then bootstraps every candidate sequentially. `--no-default-scan` + `--scan-dir <path>` (repeatable) let the caller target a custom root.

### Added

- **`scripts/setup-vault.mjs`** (new functions + CLI modes):
  - `upgradeInsecureServer(vaultPath, opts)` — patch `insecurePort` + `enableInsecureServer` surgically. Behavior matrix: sane+true → no-op; sane+false → flip bool; unset → allocate (collision-avoid in batch). Modes: `--upgrade-insecure-server <path>` and `--upgrade-insecure-server-all`, both with `--dry-run`.
  - `installGlobalConvention(name, opts)` + `listGlobalConventions()` — append a shipped snippet to `~/.claude/CLAUDE.md` with HTML-comment markers. Modes: `--install-global-convention <name>` (with `--force` and `--dry-run`), `--list-global-conventions`.
  - `discoverVaults(opts)` + `defaultScanLocations()` + `classifyVault()` — scan well-known + extra dirs, classify each found vault. Modes: `--discover-vaults` (with `--bootstrap-all`, `--dry-run`, `--scan-dir <path>` repeatable, `--no-default-scan`).
- **`templates/global-claude-md-snippets/obsidian-vault-links.md`** (NEW) — the canonical click-to-open formatting convention, shipped as a re-installable snippet for `--install-global-convention`.
- **`tests/upgrade-insecure-server.test.mjs`** (NEW, 12 tests) — single + batch modes, idempotency, dry-run, collision-avoidance, edge cases (missing data.json, corrupt JSON, missing port, self-collision).
- **`tests/install-global-convention.test.mjs`** (NEW, 9 tests) — first-time install, append to existing CLAUDE.md, idempotency, `--force` upgrade preserving surrounding content, dry-run, snippet-not-found, missing-END-marker refusal.
- **`tests/discover-vaults.test.mjs`** (NEW, 10 tests) — detection by `.obsidian/`, classification (candidate/registered/reference/partial), `--scan-dir` extension, `--no-default-scan` isolation, `--bootstrap-all` dry-run, edge cases (no reference vault, 0 candidates).

### Test count: **824/824 passing** (was 793 at v0.13.8; +31 from the 3 new test files).

### Backward compatibility

- All 3 new modes are opt-in; no behavior change for existing `setup-vault.mjs <path>`, `--sync-plugins`, `--sync-all`, or `--bootstrap-reference` paths.
- `--upgrade-insecure-server[-all]` never bumps a sane existing `insecurePort` (even on collision) — surface the collision via report, never mutate.
- `--install-global-convention` never overwrites content outside marker blocks; re-running is always safe.
- `--discover-vaults` is read-only by default; only `--bootstrap-all` writes.

## [0.13.8] — 2026-05-24 — A.1 hardening pass 2 (codex post-commit on 300f161)

Second hardening pass on the A.1 filter library. Originally targeted for v0.13.7 but a concurrent session shipped `vault-doc-startup-check` (f81d9de) under that number first — this work re-tags to v0.13.8.

mini-`/review+` on `300f161` (v0.13.6 A.1 hardening) caught **2 additional P2 findings** that the v0.13.6 round had missed. **Codex pattern continues to pay off** — every post-commit pass on this Phase A→C series has surfaced real bugs:

| commit | codex post-commit findings |
|---|---|
| `ae1986c` v0.13.0 | 5 P2 (sanitize bypass, TZ shift, reserved-name leak, HTML entities, JSON-LD type regex) |
| `caa9463` v0.13.3 | 1 P1 + 4 P2 (wrapResult double-wrap, dedup, entity decode in href, quoted `>` in tag-open) |
| `493adce` v0.13.4 | 1 P1 (Node-20+ `lookup.opts.all` array convention — fetch URL totalement cassé en prod) |
| `599514d` v0.13.5 | codex hit OpenAI quota; Reviewer A found 3 P1/P2 (date_modify month roll, duration token boundary, strip_md unanchored) |
| `300f161` v0.13.6 | **this commit** — 2 P2 (duration whitelist, strip_md indent) |

### Changed

- **`src/helpers/filters/duration.mjs` G (P2)** — letter-whitelist precondition. The v0.13.6 lookbehind/lookahead boundary was insufficient for formats like `'hh:mm'`: `mm` was preceded by `:` (non-letter) and followed by end-of-string (non-letter), so it still matched → result `'hh:01'` instead of preserved `'hh:mm'`. **Fix**: pre-pass over format — if ANY letter is outside the canonical token set `Hms` (case-sensitive), bail out and return format literal. More predictable than the v0.13.6 boundary-only approach.
  - **Trade-off / behavioral change**: a marginal v0.13.6 capability is lost. Pre-v0.13.8 `duration('3600', 'H total')` → `'1 total'` (the lone `H` was tokenized between non-letter delimiters). Post-v0.13.8: `'H total'` literal (because `total` has non-Hms letters → bail). Test updated.
  - **Net benefit**: `'hh:mm'`, `'MM:SS'`, `'H:mm sec'`, etc. all behave predictably now (literal preserved instead of partial replacement).
- **`src/helpers/filters/strip_md.mjs` H (P2)** — table indent tolerance per markdown spec. Pre-v0.13.8 the strict `/^\|...` regex missed valid indented table rows like `  | col1 | col2 |`. Markdown allows 0-3 leading spaces (or a tab) before block-level syntax. **Fix**: `/^[ \t]{0,3}\|.*\|\s*$/gm`. 4+ leading spaces = code block (preserved as-is, not stripped as table).

### Added

- **`tests/filters-wave1-rest.test.mjs`** (+2 regression cases): lowercase `hh:mm` / `MM:SS` formats preserved as literals (whitelist-bail), indented tables (0-3 spaces / 1 tab) stripped, deeply-indented `    |...|` preserved as code block.

### Note on commit `e9d5e82`

The commit title and body reference v0.13.7. That was the intent at commit time — the concurrent v0.13.7 shipping was discovered post-commit. The code in `e9d5e82` is the actual content of v0.13.8 (this entry). No `git revert` / amend needed — the commit history reflects the order of events, this CHANGELOG entry is the canonical version mapping.

### Backward compatibility

- `duration` whitelist change is a behavioral change for formats with non-Hms letters. Only `'H total'` test case was affected and updated to assert the new (stricter, more predictable) behavior.
- `strip_md` indent fix is a pure bug fix — previously valid indented tables were missed.
- Phase D LaTeX cumulatively shifts to **v0.13.9**.

### Test count: **793/793 passing** (was 769 at v0.13.6; +24 includes the 2 v0.13.8 regressions + tests from the concurrent v0.13.7 work).

## [0.13.7] — 2026-05-24

**Doc drift detection promoted from "happens to fire on commit" to "fires at every SessionStart"** — closes the recurring gap where the wiki documentation lagged the repo state across multiple commits because the user (or Claude) didn't see the per-commit nudge in time.

Triggered by Roland on 2026-05-24 after manually catching 8 stale versions in `wiki/obsidian-mcp-router/router-changelog.md` (the wiki was at v0.12.2 while the repo had shipped v0.12.10): *"trouve une solution pour ne plus jamais oublier quelque que soit le workspace associé à un vault de mettre à jour la documentation. […] JE VEUX TOUT A JOUR, JE VEUX QUE CE VAULT SE REMPLISSE AU FUR ET A MESURE. QUE LES INFOS SOIENT CONSOLIDEES"*.

### Added

- **`hooks/_helpers/doc-drift-detector.mjs`** (NEW shared helper, ~330 LOC) — factored detection logic shared by two hooks. Detects 4 drift kinds against any (repo, vault) pair:
  - `changelog-version`: wiki `router-changelog.md` doesn't have a `## v<current>` section.
  - `changelog-cumulative`: the last 5 versions from repo `CHANGELOG.md` aren't all in the wiki — **catches the multi-version gap** (8 versions in one go was the trigger case).
  - `index-version`: `wiki-meta/index.md` doesn't mention the current version.
  - `project-router-version`: `wiki/<project>/project-router.md` frontmatter `current-version` ≠ repo version.
  - `catalog-missing`: artifact basenames under `hooks/scripts/skills/commands/agents/templates/` aren't all referenced in the matching catalog page (`router-hooks.md`, `router-cheatsheet.md`, `router-skills.md`, `router-commands.md`, `router-agents.md`, `router-templates.md`).

- **`orderedVaultCandidates(cwd, cfg)` helper** — fixes the pre-v0.13.7 bug in `doc-propagation-checker` where the vault iteration broke on the first match (usually `.template`) and never reached the actual project vault. New priority order: workspace-bound (via `OBSIDIAN_ROUTER_DEFAULT_VAULT` in `<cwd>/.env`) → `cfg.defaultVault` → cwd-basename heuristic → others → `.template` last.

- **`hooks/vault-doc-startup-check.mjs`** (NEW SessionStart hook) — fires at every Claude Code session start, runs the detector against the most relevant vault, surfaces drift as a `VAULT_DOC_STARTUP_DRIFT:` nudge in the SessionStart context. Independent of commit events — catches drift that accumulated over previous sessions (or got missed by `doc-propagation-checker`'s commit-time nudge). Fingerprint dedup at `<cwd>/.vault-meta/doc-drift-startup-fingerprint` prevents re-firing for the same un-actioned drift state.

- **`tests/doc-drift-detector.test.mjs`** (NEW, 22 tests) — unit tests for the 5 detection kinds, vault selection ordering, catalog basename listing, fingerprint stability.

### Changed

- **`hooks/doc-propagation-checker.mjs`** — refactored to delegate vault-side drift detection to `doc-drift-detector.mjs`. Now reports ALL drift kinds (not just `changelog-version`), uses cumulative window check, iterates up to 2 relevant vaults (capped to avoid spam), uses `orderedVaultCandidates` for sane vault priority. Repo-level CHANGELOG/ROADMAP/Unreleased checks unchanged.

- **`hooks/hooks.example.json`** — adds `vault-doc-startup-check.mjs` to the `SessionStart` event (matcher `startup|resume|clear`, alongside the existing `hot-cache-load`, `check-router-update`, `session-auto-journal`).

- **`tests/doc-propagation-checker.test.mjs`** — assertion strings updated to match the new `VAULT_DOC_DRIFT:` nudge format from the shared detector. Test fixture's `package.json name` changed to `obsidian-mcp-router` so the detector finds the matching wiki project folder.

### Backward compatibility

- Both hooks honor the existing `OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true` opt-out env var (one flag for both).
- `vault-doc-startup-check.mjs` additionally supports `OBSIDIAN_ROUTER_NO_DOC_STARTUP_CHECK=true` for selective opt-out (e.g. silence SessionStart while keeping the commit-time check).
- Vaults without `wiki/<project>/router-changelog.md` are silently skipped — the hook never crashes on partial wiki scaffolding.
- Test count: **791/791 passing** (+22 new doc-drift-detector tests, +1 reused assertion in propagation-checker).

### What this closes

The user's exact pain — never again missing the wiki update for a shipped commit, regardless of which workspace+vault pair you're working in. The drift is surfaced **at the start of every session**, not just at commit time, so even if the user re-opens a session 3 days later without committing, they see the accumulated drift report and can consolidate before doing anything else.

## [0.13.6] — 2026-05-24 — A.1 hardening (3 correctness bugs from mini-review+ on 599514d)

Hardening pass on the 12 newly-shipped Wave-1 filters. mini-`/review+` on commit `599514d` (v0.13.5 A.1 completion) caught **3 silent correctness bugs** in the adapted-from-Clipper filters — all reproduced by exec. Fixed before Phase D LaTeX starts (which now shifts to v0.13.7 cumulatively).

Note: codex pass hit its OpenAI usage limit on this review (HTTP 403 quota exceeded), so only Reviewer A's findings are included here. The findings are concrete (proven by exec), high-quality, and all P1/P2 — no need to wait for codex retry.

### Changed

- **`src/helpers/filters/date_modify.mjs` F1 (P1, silent correctness)** — month and year shifts now CLAMP the day to the last valid day of the target month, instead of letting JS `Date.setMonth` roll over. Pre-v0.13.6:
  - `date_modify('2026-01-31', '+1 month')` → `'2026-03-03'` ❌ (Feb 28 + 3, silent overflow)
  - `date_modify('2024-02-29', '+1 year')` → `'2025-03-01'` ❌ (Feb 29 non-existent in non-leap year 2025)
  Post-v0.13.6:
  - `date_modify('2026-01-31', '+1 month')` → `'2026-02-28'` ✅
  - `date_modify('2024-02-29', '+1 year')` → `'2025-02-28'` ✅
  - `date_modify('2024-02-29', '+4 years')` → `'2028-02-29'` ✅ (next leap year preserved)
  Implementation: new private `shiftMonthClamped(date, monthDelta)` helper — sets day to 1 first (always valid), shifts month, then clamps day to last-day-of-new-month.

- **`src/helpers/filters/duration.mjs` F2 (P1, silent correctness)** — token replacement now requires non-letter boundaries on both sides. Pre-v0.13.6 the unbounded `replace(/HH|H|mm|m|ss|s/g, …)` matched mid-word. Reproduced:
  - `duration('3600', 'Hours')` → `'1our0'` ❌ (the `H` of `Hours` matched, replaced by `1`, the `s` matched, replaced by `0`)
  - `duration('3690', 'hh:mm')` → `'hh:01'` ❌ (the `mm` matched even though it sat after `:` after `h` which is a letter)
  Post-v0.13.6:
  - `duration('3600', 'Hours')` → `'Hours'` ✅ (no match — `H` is followed by a letter)
  - `duration('3690', 'hh:mm')` → `'hh:mm'` ✅ (no match — `mm` is preceded by `:` then `h` non-token; the regex correctly rejects)
  Implementation: `/(?<![A-Za-z])(HH|H|mm|m|ss|s)(?![A-Za-z])/g` with lookbehind+lookahead boundaries.

- **`src/helpers/filters/strip_md.mjs` F3 (P2, silent erasure)** — table-stripping regex now anchored to full table lines. Pre-v0.13.6 the unanchored `\|.*\|/g` (port-of-Clipper-bug) matched any line with 2+ pipes:
  - `strip_md('see this | a | b | row')` → `'see this  row'` ❌ (middle erased)
  - Math notation `P(A|B)` would have its middle wiped if it had a 2nd pipe in the same line.
  Post-v0.13.6: anchored `/^\|.*\|\s*$/gm` — only matches lines that start AND end with `|`. Body text with arbitrary pipes is preserved:
  - `strip_md('Conditional P(A|B) is...')` → `'Conditional P(A|B) is...'` ✅
  - `strip_md('run \`ls | grep foo\` to filter')` → preserves the pipe ✅
  - Real table lines (`| col1 | col2 |`) still stripped ✅. We diverge from Clipper here intentionally — their unanchored version is a correctness bug they may want to fix upstream eventually.

### Added

- **`tests/filters-wave1-rest.test.mjs`** (+7 regression cases): Jan31+1month clamp, leap-year +1year clamp, leap-to-leap +4years preservation, mid-month sanity check, literal letters in duration format preserved, canonical duration formats still work, body pipes preserved, real table lines still stripped.

### Backward compatibility

- All 3 fixes are bug fixes — they produce **correct** outputs where pre-v0.13.6 produced silently wrong ones. No client that relied on the buggy behavior is at risk except in the F3 case where a body containing 2+ pipes would no longer be (erroneously) stripped. That's a feature, not a regression.
- Phase D LaTeX cumulatively shifts: original v0.13.3 → v0.13.4 (Phase C insert) → v0.13.5 (Phase C hardening) → v0.13.6 (A.1 complete) → **v0.13.7** (this hardening) → eventually Phase D.

### Test count: **769/769 passing** (was 762 at v0.13.5; +7 regression tests).

## [0.13.5] — 2026-05-24 — A.1 completion (12 remaining Wave-1 filters) + critical Node-20+ fetch fix

Two changes bundled here:

1. **Codex P1 (CRITICAL) — `safe-fetch-html.mjs` lookup callback fixed for Node 20+**. The mini-`/review+` on commit `493adce` (v0.13.4 hardening) caught that the pinned-IP custom `lookup` callback returned `(null, address, family)` scalar — but on Node 20+ where `autoSelectFamily` is on by default, undici calls `lookup(host, opts, cb)` with `opts.all === true` and expects the callback to receive an **array** of `{address, family}` records (happy-eyeballs v2). Returning scalar in that branch made undici fail with `ERR_INVALID_IP_ADDRESS` before connecting, so **every URL-input fetch through `extract_page_metadata` and `propose_linked_sources` was broken in production**. Tests didn't catch it because they used the `html` input branch (no fetch). Fix: handle both calling conventions in the same callback.

2. **A.1 completion** — the remaining 12 Wave-1 filters shipped (the 5 pivots landed in v0.13.0 — see `safe_name`, `slug`, `kebab`, `wikilink`, `date`). The filter library is now complete at 17/17 Wave-1 filters. Wave 2 (33 more filters) stays Phase H backlog.

### Added

- **`src/helpers/filters/decode_uri.mjs`** — `decodeURIComponent` with safe fallback on malformed input. Direct port from Clipper.
- **`src/helpers/filters/length.mjs`** — count chars (string) / items (JSON array) / keys (JSON object). Returns string per Clipper convention. Direct port.
- **`src/helpers/filters/strip_tags.mjs`** — strip HTML tags with optional allow-list. Decodes common entities. Direct port.
- **`src/helpers/filters/strip_md.mjs`** — strip markdown formatting (links, bold, italic, headers, code, lists, blockquotes, tables, wikilinks, etc.). Direct port.
- **`src/helpers/filters/blockquote.mjs`** — prefix each line with `> ` (nested arrays → nested depth). Direct port.
- **`src/helpers/filters/callout.mjs`** — wrap content in Obsidian callout `> [!type] title\n> body` with fold marker. Direct port.
- **`src/helpers/filters/footnote.mjs`** — JSON array → `[^N]: item`, JSON object → `[^kebab-key]: value`. Direct port.
- **`src/helpers/filters/image.mjs`** — URL (or JSON of URLs) → markdown `![alt](url)` syntax. Adapted port (inline `escapeMd` for the 4 syntactic chars, no upstream `escapeMarkdown` dep).
- **`src/helpers/filters/table.mjs`** — JSON object / array of objects / array of arrays / flat array → markdown table. Custom headers via param. Direct port.
- **`src/helpers/filters/date_modify.mjs`** — add/subtract a duration from a date. Adapted port — native `Date` arithmetic instead of `dayjs` dep. Calendar-validated (same strategy as `date.mjs` Fix J).
- **`src/helpers/filters/duration.mjs`** — format ISO 8601 duration or bare seconds as `HH:mm:ss`. Adapted port — native arithmetic, no `dayjs/plugin/duration`.
- **`src/helpers/filters/markdown.mjs`** — **simplified** HTML→markdown converter. Clipper's version delegates to `defuddle/full` which the router doesn't bundle (defuddle is invoked separately via WebFetch in the `defuddle` skill). The ported filter covers the common cases (headings, paragraphs, lists, links, images, bold/italic, code, blockquote, entity decode) — sufficient for use cases that don't need full-fidelity conversion. For high-fidelity webpage→markdown, the wiki-ingest skill calls defuddle directly. Documented in the filter's JSDoc.
- **`src/helpers/filters/index.mjs`** updated: 17/17 filters exported by name + included in `FILTERS` map for programmatic lookup.
- **`tests/filters-wave1-rest.test.mjs`** (~50 cases, 3-5 per filter) — happy paths + edge cases + Clipper-parity behavior for each of the 12 new filters.
- **`package.json`** test script extended with the new test file.

### Changed

- **`src/helpers/safe-fetch-html.mjs`** — `lookup` callback now returns an array `[{address, family}]` when `opts.all === true` (Node 20+ `autoSelectFamily` branch) AND scalar `(null, address, family)` when `opts.all` is falsy (legacy / explicitly-disabled branch). Both conventions covered, so the helper works across all undici versions and Node runtimes.

### Backward compatibility

- All 12 new filters are additive — no existing API touched.
- The `safe-fetch-html` lookup fix is a pure bugfix (no API change) — URL-input fetches that were broken now work.

### Test count: **762/762 passing** (was 710 at v0.13.4; +52 new tests: ~50 filter cases).

## [0.13.4] — 2026-05-24 — Phase C hardening (mini-review+ findings on caa9463)

Hardening pass triggered by `mini-/review+` on the freshly-landed v0.13.3 commit (`caa9463`). Both reviewers (Claude Code Reviewer subagent + codex) flagged 1 P1 SSRF gap + 4 P2 + 4 P3 — same pattern as the v0.13.0 → v0.13.1 cycle (post-commit codex sees integration-level bugs that piecewise pre-commit review misses). All P1 + P2 fixed before Phase D LaTeX starts (which shifts to v0.13.5 again).

**Phase D LaTeX version shift** (cumulative): originally v0.13.3 in initial roadmap → v0.13.4 after Phase C insertion → **v0.13.5** after this hardening. Roadmap follow-up still tracked in vault.

### Changed

#### Security

- **SSRF TOCTOU closed for both extract_page_metadata and propose_linked_sources MCP tools** (codex P1). Pre-v0.13.4 the 2-stage guard (`validateUrl` sync + `assertHostnameNotPrivate` async DNS) had a TOCTOU window between the DNS check and undici's getaddrinfo at connect time. A DNS-rebinding host or one with mixed public/private answers could pass the check and then have undici resolve/connect to a private IP. Now closed via a **pinned-IP undici Dispatcher** (the same pattern `src/markdownify/markitdown.mjs safeFetch` has carried since v0.11.1): `Agent({connect: {lookup: (_h, _o, cb) => cb(null, address, family)}})` ensures the connector cannot re-resolve. Per-hop re-pin in the redirect loop, so chained redirects through hostile DNS still get refused at the final hop.

#### MCP wire-format

- **Handler wrapResult double-wrap fixed for both tools** (codex P2 — CRITICAL). Pre-v0.13.4 both `handleExtractPageMetadata` and `handleProposeLinkedSources` returned a pre-wrapped `{content: [{type:'text', text: JSON.stringify(...)}]}` shape. But the router's `wrapResult` in src/index.mjs re-wraps every handler's return value, so MCP clients saw the actual response text as `{"content":[{"type":"text","text":"<original payload>"}]}` — a nested envelope instead of the documented payload. Tests didn't catch it because they called the handlers directly (bypassing the dispatcher). Fix: handlers return the **raw payload object** now. Tests updated + 2 regression tests added (one per tool) that assert `!('content' in result)`.

#### link-extractor.mjs heuristic bugs

- **Dedup keeps highest-scoring duplicate** (convergent finding: Reviewer A P2 + codex P2). Pre-v0.13.4: same canonical href appearing in body AND in a Related section was dropped first-wins, losing the +3 bonus. Now a `Map<canonical, candidate>` keeps the candidate with the higher score per canonical href.
- **href HTML entities decoded BEFORE URL normalization** (codex P2). Pre-v0.13.4: `<a href="/search?q=a&amp;b=2">` produced canonical URL `https://…/search?q=a&amp;b=2`, so the downstream request would have param `amp;b` instead of `b`. Now `decodeEntities(rawHref)` runs first.
- **Quoted `>` in attribute before href no longer truncates the tag-open slice** (codex P2). Pre-v0.13.4: `<a title="2 > 1" href="/x">` was sliced at the inner `>`, missing the `href` entirely. Fix: use a quote-aware `A_OPEN_RE` sub-match instead of `indexOf('>')`.
- **Social blocklist recognizes `www.*` / `m.*` / `mobile.*` prefixes** (Reviewer A P3). Pre-v0.13.4: `https://www.twitter.com/x` scored 0 instead of -5. Now hostnames are normalized (`.replace(/^(www|m|mobile)\./, '')`) before set lookup.
- **`headingMatchesRelated` is Unicode-NFC-normalized** (Reviewer A P3). A heading like `"À lire aussi"` arriving in NFD form (combining-grave detached) now matches the NFC keyword `"à lire aussi"` in the lookup table.

#### Refactor

- **`src/helpers/safe-fetch-html.mjs`** — extracted shared SSRF-safe fetch helper (DRY-cleanup that had been tracked as TODO since v0.13.2). Both `extract_page_metadata` and `propose_linked_sources` now use it. Returns `{html, finalUrl}` so callers know the post-redirect canonical URL (needed for same-domain scoring in link-extractor).
- **`src/helpers/pkg-version.mjs`** — extracted shared package-version read + `USER_AGENT` string (Reviewer A P3). Eliminates the drift between the per-tool hardcoded UA strings (`0.13.0-dev`, `0.13.1`, `0.13.3` were all in play across releases). `src/index.mjs` now imports `PKG_VERSION` from this helper instead of doing its own JSON.parse inline.

#### Skill / sub-agent depth-1 enforcement

- **`agents/wiki-ingest.md`** — added explicit anti-pattern: "Don't trigger link-following step 4.5 of the wiki-ingest skill. Depth limit is 1 in Phase C: parent triggers step 4.5, children (you) don't recurse." (Reviewer A P3 — pre-v0.13.4 the depth-1 promise was only enforced by the orchestrator skill instruction; sub-agents could technically re-trigger step 4.5. Now explicit in the sub-agent prompt.)

### Added

- **`tests/extract-page-metadata.test.mjs`** (+1 regression case): handler returns raw payload, not pre-wrapped envelope.
- **`tests/propose-linked-sources.test.mjs`** (+1 regression case): same as above for propose tool.
- **`tests/link-extractor.test.mjs`** (+5 regression cases): dedup-max-wins, href entity decode, quoted-`>` in tag-open, www.*/m./mobile.* social blocklist normalization, Unicode-NFC heading match.

### Backward compatibility

- **MCP wire-format change** is technically a "fix to a bug" but it IS a behavioral change for clients that were JSON-parsing the (broken) double-wrapped response. Any client that relied on parsing `JSON.parse(content[0].text)` to get `{"content":[...]}` and digging into the nested text was already broken. Documented in the breaking-change section of the wiki-ingest skill upgrade notes.
- **Sub-agent skip of step 4.5** is additive — sub-agents that ignored step 4.5 (any pre-v0.13.4 sub-agent) continue to work; the explicit instruction just hardens the soft enforcement that was already implicit.

### Test count: **710/710 passing** (was 703 at v0.13.3; +7 hardening regression tests).

## [0.13.3] — 2026-05-24 — obsidian-clipper Phase C (link-following ingestion, Level 1 "Ask mode")

Phase C of the obsidian-clipper feature-borrowing roadmap. Extends URL ingestion to **propose related hyperlinks** from the page body for recursive ingestion, ranked by heuristic score (same-domain +2, "Related"/"See also" section +3, social/boilerplate hostname -5). The user picks which candidates to also ingest — Level 1 "Ask mode" only, no auto-follow. Fan-out via the existing `wiki-ingest` sub-agent. Frontmatter `related_source: [[parent-slug]]` traces the parent-child tree.

**Inserted before LaTeX preservation** per Roland's request 2026-05-24 — link-following adds value to ALL URL ingestions, LaTeX is niche to math pages. Original Phase C (LaTeX) becomes Phase D, and downstream phases shift by one letter.

**Why Level 1 only**: 3 ambition levels were scoped (Ask mode, Auto-follow with cap, Smart LLM selection). Level 1 is the safe foundation — user always validates the candidate list before any extra fetch happens. Levels 2 and 3 are deferred to dedicated phases if usage patterns justify (e.g. "I always pick same-domain links" → graduate to Level 2 auto-follow with same-domain cap).

### Added

- **`src/helpers/link-extractor.mjs`** — `extractLinks(html, baseUrl, opts)` parses `<a href>` from HTML with heuristic scoring. Strips semantic boilerplate (`<nav>`, `<footer>`, `<aside>`, `<header>`) before scan. Quote-aware tag matcher + backreference attribute extractor (cf. Phase A finding E lessons). Hard-skips fragment-only, `mailto:`, `tel:`, `javascript:`, `data:`, `file:`, `ftp:`. Dedup by canonical href (lowercased hostname, no fragment, trailing-slash stripped). HTML entities decoded + agentic-injection markers neutralized on display text (cf. Phase A findings B#C + A#15). Output sorted by score descending, capped at `maxCandidates` (default 30).
- **`src/tools/propose-linked-sources.mjs`** — MCP tool wrapper around the extractor. Accepts `{url}` (fetched via undici with SSRF guards + redirect re-SSRF per hop, max 5 hops) or `{html, baseUrl}` (raw input, no I/O). Returns `{baseUrl, count, candidates}` JSON-stringified in the standard MCP content block.
- **`extract_page_metadata` + `propose_linked_sources`** both registered in `src/index.mjs` TOOL_REGISTRY (TOOLS + TOOL_HANDLERS dispatch). Boot-time cross-check validates the wiring. Both excluded from `WRITE_TOOL_NAMES` (no vault mutation).
- **`skills/wiki-ingest/SKILL.md`** new step 4.5 "Propose linked sources" (between file source step 4 and entity extraction step 5). Full procedure documented: call `propose_linked_sources`, present top 10-15 to user, accept input formats ("1, 3, 5" / "tous" / "aucun"), fan-out via existing `wiki-ingest` sub-agent (1 per retained URL, parallel), set child frontmatter `related_source: [[parent]]`, append parent page's `## Linked sources` section, consolidated log entry. Hard depth limit of 1 (sub-agents MUST NOT trigger step 4.5 themselves).
- **`skills/wiki-ingest/SKILL.md`** frontmatter spec updated with the `related_source: "[[parent-slug]]"` field (optional, only set on children of a link-following parent).
- **`tests/link-extractor.test.mjs`** (42 cases) — Karpathy fixture (Related section + cross-domain), Wikipedia fixture (See also section + External links un-bonus), degraded (no links), TRICKY fixture (nav strip + scheme skips + dedup canonical + single-quoted href + apostrophe-in-text + injection neutralizer post-decode), robustness (empty/null html, invalid baseUrl, maxCandidates cap, image-only anchor skip), scoring (social blocklist, same-domain bonus, cross-domain plain), `_internals` smoke tests for splitByHeadings + resolveAndNormalize + headingMatchesRelated + matchesSocialBlocklist.
- **`tests/propose-linked-sources.test.mjs`** (14 cases) — TOOL_DEFINITION shape, input XOR validation (url + html mutually exclusive, html requires baseUrl), hermetic html branch (full scoring, maxCandidates cap, empty page), URL SSRF refusal (non-http(s), loopback, malformed), wiring boot-time check (TOOLS + TOOL_HANDLERS contain `propose_linked_sources`, not in WRITE_TOOL_NAMES).
- **`package.json`** test script extended with both new test files.

### Anti-patterns documented in skill

- Do NOT auto-follow links without user confirmation (Level 2 deferred).
- Do NOT chain `propose_linked_sources` recursively in sub-agents (depth limit = 1 in Phase C).
- Do NOT skip the `related_source` frontmatter on children (mechanism that traces the tree).
- Do NOT ingest candidates with `score < 0` without explicit user opt-in (blocklist).

### Synergy with the 🔮 router-aware browser extension idea

Phase C lays the conceptual foundations of recursive ingestion that a future browser extension would exploit natively (the extension has DOM access — link extraction is trivial, and the parent-child relation model in frontmatter is what the extension would write). See [[obsidian-clipper#-idée-à-étudier--extension-navigateur-router-aware]] in the vault brainstorming.

### Backward compatibility

- Step 4.5 is additive — existing wiki-ingest invocations (without explicit link-following) skip it silently (no candidates → no UI, no user prompt).
- Frontmatter `related_source` is OPTIONAL — root sources (not children of a link-following parent) omit the field entirely.
- The new MCP tools (`propose_linked_sources`, `extract_page_metadata` from v0.13.2) are read-only and excluded from `WRITE_TOOL_NAMES`, so `OBSIDIAN_ROUTER_READONLY` deployments stay useful.

### Deferred to future phases

- **Level 2 (auto-follow with cap)** — flag opt-in `--follow-links depth=1 max-pages=5 same-domain=true`. Activatable if usage patterns show systematic user choices.
- **Level 3 (smart LLM selection)** — per-link LLM judgment via `extract_page_metadata` light pre-scoring. Probably a v0.14.x candidate.
- **Recursive depth > 1** — Phase C is depth-1 only. Higher depth needs more design (cycle detection, budget enforcement, UX).

### Test count: **703/703 passing** (was 647 at v0.13.2; +56 new tests: 42 link-extractor + 14 propose-linked-sources).

## [0.13.2] — 2026-05-24 — obsidian-clipper Phase B (pipeline upgrade)

Phase B of the obsidian-clipper feature-borrowing roadmap. Wires the v0.13.0 helpers into the actual ingestion pipeline: registers `extract_page_metadata` as a real MCP tool, updates the `defuddle` skill to call it alongside the markdown cleanup, and updates the `wiki-ingest` skill to assemble source-page frontmatter DETERMINISTICALLY from the extracted metadata before Claude touches the body. End of the "fabricated dates / missed author" pain documented in the wiki-ingest skill anti-patterns.

### Added

- **`extract_page_metadata` MCP tool registered** in `src/index.mjs` TOOL_REGISTRY (TOOLS array + TOOL_HANDLERS dispatch). Input schema accepts `url` (fetched via undici with SSRF guards + redirect handling, max 5 hops) OR `html` (raw, no I/O). Output is a JSON-stringified `{title, author, published, image, site, lang, description, wordCount, readingMinutes}` block. Excluded from `WRITE_TOOL_NAMES` since it doesn't touch any vault — `OBSIDIAN_ROUTER_READONLY` keeps it exposed. The boot-time TOOLS/TOOL_HANDLERS cross-check validates the wiring automatically.
- **`tests/extract-page-metadata.test.mjs`** (13 cases): TOOL_DEFINITION shape, handler input validation (mutually-exclusive `url`/`html`, neither required, both forbidden), hermetic `html` input branch (full metadata, no-metadata fallback, body override), URL SSRF refusal (non-http(s) scheme, private IP literal, malformed), boot-time wiring cross-check (TOOLS/TOOL_HANDLERS contain the new entry).
- **`package.json`** test script extended with `tests/extract-page-metadata.test.mjs`.

### Changed

- **`skills/defuddle/SKILL.md`**: new step 2.5 "Extract deterministic metadata" — after defuddle returns clean markdown, the skill ALSO calls `extract_page_metadata` on the same URL. Output of the skill is now `{markdown, metadata}` instead of just `markdown`. Added explicit rationale ("why two calls instead of one combined tool: clean separation of concerns") and anti-pattern ("do NOT infer title/author/published when the meta extractor returned non-null").
- **`skills/wiki-ingest/SKILL.md`** step 1 (acquire): URL inputs now route through `defuddle` (v0.13.2+) which returns the metadata block, or directly call `extract_page_metadata` if the URL is already clean. Local files / pasted text still fall back to Claude inference (no metadata signal available).
- **`skills/wiki-ingest/SKILL.md`** step 4 (file source): frontmatter for URL sources is now assembled DETERMINISTICALLY from the metadata block. New mandatory fields when present: `published`, `lang`, `image`, `site`, `description`, `word_count`, `reading_minutes`. The slug filename uses `slug(title, {maxLen:80})` from the v0.13.0 filter library. Anti-pattern updated: do NOT re-infer fields the metadata block populated.

### Backward compatibility

- The `webpageToMarkdown` MCP tool (`src/tools/convert.mjs`) is **unchanged** — still returns a markdown string for backward compat. Pipeline composition lives in the skills, not in the tool layer. This was a deliberate scope decision vs. the roadmap's initial `{markdown, metadata}` shape proposal: simpler, no breaking change, no `flat: true` legacy flag needed.
- Local file / pasted text inputs to `wiki-ingest` continue to use the pre-v0.13.2 inference path (no metadata block available — no signal to be deterministic about).
- The `extract_page_metadata` tool returns a hermetic JSON-stringified payload; downstream consumers that JSON.parse the `content[0].text` get the structured object.

### Test count: **647/647 passing** (was 634 at v0.13.1; +13 integration tests for the new tool + wiring).

## [0.13.1] — 2026-05-24 — Phase A hardening (post-commit `/review+` findings)

Post-commit hardening pass triggered by `/review+` on the freshly-landed v0.13.0 commit. The 5-pass pre-commit cycle had cleared all P1/P2 it found, but a fresh post-commit review surfaced 5 new findings + 3 NITs that the pre-commit passes had missed (the post-commit codex saw the commit as a unit, not piecewise). All fixed before Phase B starts (which will be v0.13.2 — original roadmap shifted by one patch level).

### Changed

- **`src/tools/extractPageMetadata.mjs` → `src/tools/extract-page-metadata.mjs`** (N2): renamed to align with the kebab-case convention of every other file in `src/tools/`. Tool definition exported name (`extract_page_metadata`) unchanged. Done via `git mv` so history is preserved.
- **`src/tools/extract-page-metadata.mjs:32`** (N1): User-Agent string `0.13.0-dev` → `0.13.1` (now matches the shipped package version). The pre-v0.13.1 dev-suffix was a development leftover.
- **`src/tools/extract-page-metadata.mjs:23-29` JSDoc** (N3): "registration ships with Phase A.4" corrected to "Phase B (v0.13.2, defuddle skill upgrade)". The original JSDoc referenced an intermediate plan that changed; this one matches the actual roadmap now.
- **`src/helpers/meta-extractor.mjs` normalizeDate** (codex O, P2): added ISO-date-prefix calendar validation. Pre-v0.13.1 V8 silently rolled invalid days forward — `article:published_time="2026-02-31"` produced fabricated `2026-03-03` in frontmatter. Now the round-trip check rejects calendar-invalid prefixes; raw input flows through `cleanScalar` (which neutralizes any embedded injection markup).
- **`src/helpers/filters/date.mjs`** (codex P, P2): extended pass-5 calendar-validation from `YYYY-MM-DD` date-only to ALSO cover ISO datetimes with a `T` separator (`YYYY-MM-DDTHH:mm:ss…`). `date('2026-02-31T00:00:00Z')` now returns the input unchanged instead of V8-rolled `'2026-03-03'`.
- **`src/helpers/meta-extractor.mjs:155-165` JSON-LD type regex** (codex Q, P2): relaxed from `type="application/ld+json"` strict to `type\s*=\s*["']application/ld+json[^"']*["']` so the extractor handles spec-legal variations: whitespace around `=` and charset/profile parameters (`type="application/ld+json; charset=utf-8"`). Pages using either valid variation no longer silently bypass JSON-LD extraction.
- **`src/helpers/meta-extractor.mjs` parseMetaTagAttrs** (codex S, P3): attribute-name boundary changed from `\b` to `(?:^|\s)`. The `\b` boundary was satisfied between `-` and `c` in `data-content`, so a tag like `<meta property="og:title" content="Real" data-content="Draft">` had `data-content` shadowing `content` and surfaced `"Draft"` as the title. The leading whitespace/start-of-tag boundary fixes the false-match.

### Added

- **`NOTICE`** (codex R, P2 — license compliance): added MIT attribution section for the obsidian-clipper port (5 filter files + meta-extractor pattern). Mirrors the existing markdownify-mcp / Karpathy LLM-wiki credit sections — same format, full MIT license text, file-by-file mapping with explicit note that `slug.mjs` is homegrown and the SSRF/injection hardenings in meta-extractor are original to this project. Without this section, redistributing the package would have been MIT-noncompliant.
- **`tests/filters-date.test.mjs`** (+2 cases): ISO datetime with invalid day rejected; valid ISO datetime passes through.
- **`tests/meta-extractor.test.mjs`** (+7 cases): normalizeDate calendar-invalid (date-only + ISO datetime), valid ISO normalization, JSON-LD type with charset parameter, JSON-LD type with whitespace around `=`, data-content does not shadow content, data-property does not shadow property.

### Backward compatibility

- File rename `extractPageMetadata.mjs → extract-page-metadata.mjs` is **internal only** — the file is not yet registered in `TOOL_REGISTRY`, no consumers exist outside tests, no external import path changes.
- All previously-correct inputs still produce identical outputs. The behavioral changes ONLY affect inputs that were previously incorrectly accepted (calendar-invalid dates, JSON-LD type variants, data-* attributes).

### Test count: **634/634 passing** (was 625 at v0.13.0; +9 hardening regression tests).

## [0.13.0] — 2026-05-24 — obsidian-clipper Phase A (foundation)

Phase A of the obsidian-clipper feature-borrowing roadmap (see [[obsidian-clipper-roadmap]] in the associated vault). Adds the deterministic helpers that will be consumed by Phase B (`wiki-ingest` skill upgrade) to fix the "fabricated dates / missed author" pain documented in the [[wiki-ingest]] skill anti-patterns. Zero behavioral change in existing skills — these helpers are purely additive.

**Shipped after a 5-pass `/review+` cycle** (Claude Code Reviewer subagent × codex × 5 rounds). Pass log:
- Pass 1: 1 BLOCKER (SSRF), 4 IMPORTANT prouvés (sanitize bypass, TZ-bug, reserved-name leak, HTML entities), 4 IMPORTANT secondaires, 7 NITs.
- Pass 2: codex pass 2 found 3 nouveaux P2 (tier-scoring, quote-delimiter, redirect handling) + 1 P3 (slug truncate trim).
- Pass 3: 4 codex fixes + 1 regression repair (META_TAG_RE quote-aware).
- Pass 4: codex pass 4 found 2 P1 (published bypass sanitize, cleanScalar non-string bypass) + 2 P2 (date calendar-invalid roll-forward, tests not wired in `npm test`).
- Pass 5: 4 codex pass-4 fixes + codex pass 5 found 2 P2 (blank fallback short-circuit, array-wrapped @graph not flattened) — both fixed.
- All P1 + P2 findings resolved. Some NITs deferred to Phase A.4 hardening (see roadmap "Follow-ups").

### Added

#### Filter library (5 of 17 planned Wave 1 filters)

- **`src/helpers/filters/safe_name.mjs`** — port from `obsidian-clipper/src/utils/filters/safe_name.ts` (MIT). Sanitizes a string for cross-OS filename safety. Modes: `windows` / `mac` / `linux` / default (conservative union). Reserved-name re-check post-truncate to catch `'CON '` → `'_CON'` (pre-pass-1 bug surfaced by codex).
- **`src/helpers/filters/kebab.mjs`** — direct port. `fooBar baz_qux` → `foo-bar-baz-qux`.
- **`src/helpers/filters/wikilink.mjs`** — simplified port (Clipper's JSON-input branch dropped — no consumer in the router). `wikilink('foo', 'Bar')` → `[[foo|Bar]]`.
- **`src/helpers/filters/date.mjs`** — port WITHOUT `dayjs` dep, native `Date` only. Compatible format-token subset (YYYY, MM, DD, HH, mm, ss + 1-2 digit variants). Local-calendar construction for date-only `YYYY-MM-DD` inputs to avoid the UTC-midnight TZ shift (pre-pass-1 bug: `date("2026-05-24")` returned `'2026-05-23'` under `TZ=America/New_York`). Calendar-validation against real days-per-month + leap-year rule rejects `'2026-13-01'` and `'2026-02-31'` rather than silently rolling over (pre-pass-5 bug).
- **`src/helpers/filters/slug.mjs`** — NOT a port (Clipper has no slug filter — relies on `safe_name | kebab` chained in templates). Pipeline: NFKD ASCII-fold + Obsidian-markup strip + non-alphanum→`-` + collapse + lowercase + maxLen (default 80). Re-trim `-` post-truncate to honor the no-trailing-hyphen contract (pre-pass-3 bug).
- **`src/helpers/filters/index.mjs`** — re-exports + map `FILTERS` for programmatic lookup.

#### Deterministic metadata extractor

- **`src/helpers/meta-extractor.mjs`** — `extractMetadata(html, body?)` parses Schema.org JSON-LD + OpenGraph + meta tags + `<title>` in priority order (strict article types before generic page-shell). Computes `wordCount` + `readingMinutes` from body or stripped-HTML. Returns `{title, author, published, image, site, lang, description, wordCount, readingMinutes}`. Pure regex parsing (no DOMParser dep, no jsdom/cheerio/linkedom). Hardened over 5 review passes:
  - SSRF-safe via callers — extractor itself is pure (no I/O)
  - HTML entities decoded before sanitize (named: `amp/lt/gt/quot/apos/nbsp` + numeric `&#NNN;` + hex `&#xHH;`)
  - Prompt-injection markers neutralized in scalar fields (subset of `src/helpers/sanitize.mjs` agentic-marker blocklist, inlined dep-free)
  - Non-string JSON-LD values (arrays, objects) stringified BEFORE the sanitize pipeline (not after)
  - `published` field wrapped in `cleanScalar` so malicious `article:published_time` doesn't bypass sanitize
  - `META_TAG_RE` quote-aware: handles `>` inside `content="..."` (e.g. `content="<tool_use>"`)
  - `parseMetaTagAttrs` uses backreference quote-delimiter so apostrophes inside double-quoted values are preserved (`<meta content="Bob's post">` → `"Bob's post"`)
  - `pickArticleNode` tier-scoring: strict ARTICLE_TYPES (Article, NewsArticle, BlogPosting, …) preferred over generic fallbacks (WebPage, CreativeWork)
  - `extractJsonLd` flattens `@graph` wrappers both at top-level AND inside top-level array elements
  - `pickNonBlank` helper for fallback chains so a defined-but-blank higher-priority signal doesn't short-circuit lower-priority tiers

#### MCP tool wrapper

- **`src/tools/extractPageMetadata.mjs`** — wraps `extractMetadata` as MCP tool. Accepts `{url}` (fetched via `undici`) or `{html}` (raw input). **NOT YET registered** in `src/index.mjs` TOOL_REGISTRY — registration is part of Phase B (skill integration). Hardened:
  - SSRF defense via `validateUrl()` + `assertHostnameNotPrivate()` from `src/markdownify/utils.mjs` (re-used existing helpers; no new code surface)
  - Manual redirect loop with re-SSRF at each hop (max 5 hops, matches `curl`/`fetch` defaults). Per-hop re-validation handles `evil.com → http://attacker.com → http://127.0.0.1/...` chains
  - Timeout 10s via AbortController, body size cap 5 MiB
  - Documented residual DNS-rebinding TOCTOU as Phase A.4 hardening (mitigation = custom undici dispatcher pinning the connect target; cf. `safeFetch` pattern in markdownify)

#### Tests

- **`tests/filters-safe-name.test.mjs`** (24 cases incl. 5 pass-1 regressions + 1 pass-5 regression for Windows reserved-name leak)
- **`tests/filters-kebab.test.mjs`** (7 cases)
- **`tests/filters-wikilink.test.mjs`** (9 cases)
- **`tests/filters-date.test.mjs`** (17 cases incl. 1 pass-1 TZ-independence regression + 6 pass-5 calendar-validation regressions)
- **`tests/filters-slug.test.mjs`** (13 cases incl. 1 pass-3 truncate-on-sep regression)
- **`tests/meta-extractor.test.mjs`** (51 cases incl. 5 pass-1 regressions for entity decode + injection neutralize + pickArticleNode strict, 6 pass-3 regressions for tier-scoring + quote-aware + apostrophe + angle-bracket, 3 pass-4 regressions for published bypass + non-string bypass + object stringify, 5 pass-5 regressions for blank fallback + array-wrapped @graph)

### Changed

- **`package.json`**: version `0.12.10` → `0.13.0` (minor bump — additive features, zero break). `test` script extended with the 6 new test files (regression: codex pass 4 flagged that pre-pass-5 the new tests weren't exercised by CI).

### Backward compatibility

- All new files are additive — no existing skill / tool / helper modified.
- `wiki-ingest` and `defuddle` skills are untouched — they'll consume these helpers in Phase B (v0.13.1) per the roadmap.
- `extractPageMetadata` is created but NOT registered in TOOL_REGISTRY — no new MCP tool exposed to clients yet.

### Follow-ups for Phase A.4 hardening (tracked in vault [[obsidian-clipper-roadmap]])

- A#3 slug NFKD codepoints — currently literal in the source, fragile to NFC normalization on save. Fix needs an editor that supports `̀-ͯ` escape rewriting.
- A#4 catastrophic backtracking defense-in-depth — cap `extractTitleTag` regex body.
- A#6 undici `bodyTimeout` / `headersTimeout` natifs in addition to `AbortController.signal`.
- NIT pass-4 `extractHtmlLang` / `extractTitleTag` chain to `cleanScalar` for defense-in-depth.
- NIT pass-5 `cleanScalar` `String(v)` try/catch for exotic objects with throwing toString (negligible risk in JSON.parse pipeline, but harden if helper externalizes).

### Test count: **625/625 passing** (was 528 at v0.12.10; +97 new tests across 6 new test files).

## [0.12.10] — 2026-05-24

`/review+` hardening pass on v0.12.8's session-log auto-append. Two reviewers: Code Reviewer subagent (5 IMPORTANT + 3 NIT) + `codex review --commit 91a0070` (4 additional findings — 3 IMPORTANT + 1 NIT). All 9 actionable findings addressed with 21 regression tests. Test suite: **506/506 passing** (was 485 after v0.12.9; +21 tests: 6 hook sanitize/multiline/tz + 1 migration B1 + 14 backfill).

### Fixed

- **Markdown injection in log.md entries** (`hooks/session-auto-journal.mjs:545-560` + `scripts/backfill-log-from-sessions.mjs:155-170` — Reviewer A A1): v0.12.8 only escaped `|`; a user prompt containing `[[evil]]`, `<!-- hidden`, or starting with `- ` could spawn parasitic wikilinks, hide subsequent log lines under an HTML comment, or break the entry's bullet structure. New `sanitizeForLogEntry()` helper in the hook (and a mirrored inline function in the backfill script) inserts U+200B zero-width space inside `[[` / `]]` / `<!--` / `-->` tokens (invisible in Obsidian rendered + source view) and backslash-escapes a leading markdown structural char. Pipe escape from v0.12.8 preserved.

- **Spam in log.md on re-running `--migrate-sessions-to-wiki-meta` with conflicts** (`scripts/setup-vault.mjs:606` — Reviewer A B1): if a vault had `both-overlap` state with conflict files left in source, every re-run produced a new `migrate` line in log.md (`0 sessions moved, M skipped`). Now the log append is gated by `result.sessionsMoved.length > 0` — empty-action runs stay silent.

- **EXDEV fallback opacity** (`scripts/setup-vault.mjs:534-557` — Reviewer A E2): the cross-device fallback (copy-then-unlink per file) had no rollback if a mid-loop failure left the source partially drained. Error message now lists the files already moved and explicitly invites a re-run to resume (`--migrate-sessions-to-wiki-meta` is idempotent — the second pass hits `both-overlap` cleanly).

- **`git mv` argument fragility with paths containing spaces** (`scripts/setup-vault.mjs:578-583` — Reviewer A E1): the per-file branch of `migrateSessionsToWikiMeta` used `path.join('wiki', 'Sessions', f)` which produces backslash paths on Windows. Git accepts both but forward-slash is unambiguous and matches git's internal textual rename semantics — switched to template literals `wiki/Sessions/${f}` for portability.

- **Multiline Bash hints stretched log entries beyond 2 lines** (`hooks/session-auto-journal.mjs:537-545` — codex P2-1): if the first Bash tool call of a session was a heredoc or multi-line script, its embedded `\n` chars leaked into the `first bash: ...` portion of the result, breaking the parseable 2-line entry contract. Collapse all whitespace runs to single spaces with `.replace(/\s+/g, ' ').trim()` before applying the 60-char truncate.

- **Timezone mix between log date and time near local midnight** (`hooks/session-auto-journal.mjs:566-573` + `scripts/backfill-log-from-sessions.mjs:158-166` — codex P2-2): date came from `endedAt.slice(0, 10)` (UTC) while time came from `t.getHours()` (local). In Europe/Paris at 00:30 local, this produced `2026-05-24 00:30` for a session that actually ran on the 25th, breaking sort order and disagreeing with the journal filename. Now both date and time derive from the same local-tz `Date` instance (matches the filename convention from v0.12.4).

- **`OBSIDIAN_ROUTER_CONFIG` env var ignored by backfill script** (`scripts/backfill-log-from-sessions.mjs:37-49` — codex P2-3): the hardcoded `CONFIG_PATH` bypassed the env override that `setup-vault.mjs` and the hooks honor. Multi-profile or CI users hit the wrong config silently. Now resolved via `resolveConfigPath()` mirroring the setup-vault pattern.

- **`fm.prompt` documented as a backfill fallback but never used** (`scripts/backfill-log-from-sessions.mjs:128-135` — codex P3): the script's header listed `prompt:` as the fallback after `firstUserPrompt:` but the code skipped it, falling through to the chrono scan and then the historical-fallback message. Migrated/manual session notes with only `prompt:` lost their objective. Added the fallback in the right order.

### Added (regression tests)

- **`tests/backfill-log-from-sessions.test.mjs`** (NEW, 15 tests) — covers the entire script that had zero test coverage at v0.12.8: nominal backfill (with wikilink + objective + result), idempotence, `--dry-run` no-write guarantee, open-session skip, recap-absent fallback, no-firstUserPrompt fallback, chrono extraction rescue, 3 markdown-injection sanitize cases (`[[evil]]`, leading `- `, `<!--`), missing `--vault` arg error, unknown-slug error, missing log.md silent skip, `fm.prompt` fallback, `OBSIDIAN_ROUTER_CONFIG` env honored. Added to `npm test` runner.

- **`tests/session-auto-journal.test.mjs`** (+6 tests in new `v0.12.9 review+ pass 1 regressions` describe): `[[wikilink]]` injection neutralized, leading `- ` escaped, `<!--` neutralized, multiline bash hint collapsed (codex P2-1), local-tz date/time consistency (codex P2-2), pipe escape regression (preserves v0.12.8 behavior).

- **`tests/migrate-sessions-to-wiki-meta.test.mjs`** (+1 test): B1 regression — re-running on `both-overlap` with conflicts does not duplicate the log.md `migrate` line.

### Deferred to follow-up (NIT, tracked but out of scope)

- **A2** — validate `--vault <path>` against `portRegistry` in `backfill-log-from-sessions.mjs` (currently accepts any absolute existing dir; safe because `appendFileSync` only targets `wiki-meta/log.md`).
- **A3** — document YAML scalar-only limitation of the backfill script's `parseFrontmatter` (acceptable in practice — hook only writes scalars).
- **D4** — extract a shared `parseFrontmatter` helper under `hooks/_helpers/` (3 ad-hoc implementations exist now: hook, backfill, migrate script).

## [0.12.9] — 2026-05-24

Extends `hooks/vault-link-linter.mjs` to detect **click-to-open URLs with the wrong port** — the original v0.11.3 implementation only caught the "bare-path missing scheme" case and skipped any href that already had an `http(s)://` prefix (assumed correct). That assumption let through URLs like `http://127.0.0.1:27143/open/...` when the target vault's actual `insecurePort` was `27142` — silently broken links that look right but hit nothing.

Motivation: 2026-05-24 incident with Roland on the `opsidian-mcp-router et bridge` vault. Claude generated 4 click-to-open links with port `27143` instead of `27142` (memorized port from a different vault, never re-read the target vault's `data.json`). Convention in `~/.claude/CLAUDE.md` already said "never guess the port" — but conventions rely on attention. This release moves the enforcement OUTSIDE the LLM attention loop into the deterministic Stop hook, in the same spirit as `wiki-autocommit` and `vault-link-linter`'s original purpose.

### Changed

- **`hooks/vault-link-linter.mjs`**: adds a 2nd scan pass `CLICK_TO_OPEN_PATTERN` matching `[label](http(s)://127.0.0.1:<port>/open/<encoded-path>)`. For each match, resolves the owning vault from the path, reads the vault's `.obsidian/plugins/obsidian-local-rest-api/data.json`, and compares the URL's port against `insecurePort` (for `http://`) or `port` (for `https://`). On mismatch, emits a `[wrong-port]` violation with the canonical correction. Also flags `http://` URLs targeting vaults that have `enableInsecureServer: false` (the insecure server isn't listening regardless of port match).
- **Stderr message reworked**: now distinguishes the two violation kinds with `[bare-path]` and `[wrong-port]` tags, splits the preamble into a per-kind breakdown (`N vault link(s) missing format` + `M click-to-open URL(s) with the wrong port`), and adds a dedicated explainer line for wrong-port cases showing `used port X, expected Y for <scheme> (vault Z)`. The "Why" paragraph at the bottom now mentions both failure modes and reiterates the per-vault nature of the port (never reuse from another vault/session).
- **`composeSuggestion(label, decodedHref, info)` helper extracted** in the hook — centralizes the URL-building logic (encoding + http-vs-https branching) so both violation kinds emit consistent fixes.

### Added

- **`tests/vault-link-linter.test.mjs`** (+8 new tests in new `wrong-port detection (v0.12.8)` describe block — header references v0.12.8 because the design started there, but the change lands in v0.12.9): correct-http-port passes, wrong-http-port blocks (with `used 27143, expected 27142` in stderr), correct-https-port passes, wrong-https-port blocks (mixing up `port` vs `insecurePort`), http-with-disabled-insecureServer blocks (suggests HTTPS fallback), mixed bare-path + wrong-port (both kinds listed with tags), wrong-port URL with unresolvable path silently skips, stderr names the vault basename.

### Backward compatibility

- The hook stays opt-out via the existing `OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true` env var (unchanged from v0.11.3).
- All 33 pre-existing tests for the hook still pass — only one was edited (the "multiple bare-path links" test had matched on the old wording `2 vault file` which was replaced by `2 violation(s)` + per-kind breakdown; the test now asserts both `2 violation(s)` and `2 vault link(s) missing` to verify the count survives the reword).
- URLs that were already correct (matching the vault's actual port) are unaffected — they continue to pass silently. Only port-mismatched URLs newly trigger exit 2.

### Test count: **484/484 passing** (was 476 at v0.12.8; +8 wrong-port tests).

## [0.12.8] — 2026-05-24

Adopts the Karpathy "Indexing and logging" pattern to the v0.12.4 `session-auto-journal.mjs` hook: **`wiki-meta/log.md` now receives a 2-line summary per session at SessionEnd**, with a wikilink back to the detailed journal file. Also relocates `Sessions/` from `wiki/` to `wiki-meta/` (cohérent avec la séparation v0.12.0 scaffolds vs user content). Motivation: 2026-05-24 conversation where Roland linked to [Karpathy's wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) and asked for "un résumé de ce qui a été fait dans la session avec l'objectif de départ et le résultat" in log.md, with the detail living in the corresponding session file.

### Changed

- **`hooks/session-auto-journal.mjs`**: writes session journals to `<vault>/wiki-meta/Sessions/<date>-<HHMM>-<workspace>-<sessionid>.md` (was `<vault>/wiki/Sessions/...` in v0.12.4–v0.12.7). The folder move makes the auto-generated journal a scaffold (under `wiki-meta/`), not user content — consistent with the v0.12.0 layout. Hook header documents the version history of the path.
- **`templates/wiki-meta/log.md`**: added `session` and `migrate` to the verbs list + 2-line note documenting the 2-line auto-generated entry format and pointing to `/save` for LLM-polish upgrades.
- **`skills/save/SKILL.md`**: 4 doc edits — bumps the `wiki/Sessions/` references to `wiki-meta/Sessions/` and the version `v0.12.4+ → v0.12.8+`. New optional step 8b: when `/save` is invoked during an active journaled session, propose to suffix the save's log.md entry with ` · session [[<session-basename>]]` for cross-navigation between polished doc and raw chronology.

### Added

- **Auto-append to `wiki-meta/log.md` at SessionEnd** (hook): every session now lands a single 2-line entry in the log, format `- YYYY-MM-DD HH:MM — session — [[<basename>]] — <objectif>\n  → <résultat one-line>`. The objective is the first user prompt of the session (captured at the first `UserPromptSubmit`, truncated to 120 chars); the result is heuristic — counters (writes / bash / mcp writes / files) + first bash highlight + duration. Idempotent via basename grep on log.md (prevents dup on re-trigger). Silent skip when log.md is absent (wiki scaffold's responsibility). 0 API call, 0 dep — the heuristic recap from v0.12.4 already collects all the data needed. Quality-curious users can upgrade specific entries via `/save` (LLM-polish path documented in step 9 of save SKILL.md, planned for v0.12.9).
- **`firstUserPrompt` state capture**: hook now tracks the first non-empty user-prompt's first line at `UserPromptSubmit` (truncated to 120 chars, bounded). Used by `buildLogLineSummary()` to produce the "objectif" half of the log.md entry. Persisted in the per-session state JSON so it survives the cross-event boundary.
- **`scripts/setup-vault.mjs --migrate-sessions-to-wiki-meta <vault>`** + **`--migrate-all-sessions-to-wiki-meta`**: opt-in migration tool for vaults whose `Sessions/` still lives under `wiki/`. Detects 4 states (legacy, fresh, both-overlap, empty). Uses `git mv` when `.git/` is present, falls back to `fs.renameSync` then per-file copy+unlink for cross-device cases. Idempotent. Per-file dedup on overlap (refuses to clobber existing files in target, leaves conflicts in source for manual review). Appends a `migrate` line to `wiki-meta/log.md` documenting the move. Reuses the structural pattern of v0.12.1's `--migrate-wiki-meta` for consistency.
- **`scripts/backfill-log-from-sessions.mjs`** (+ `npm run backfill-log` shortcut): opt-in one-shot script that walks a vault's `wiki-meta/Sessions/*.md` (closed sessions only), reconstructs an objective/résultat pair from each session's frontmatter + auto-recap block, and appends missing log.md entries in chronological order (sorted by `started-at`). Idempotent via basename grep. Marks backfilled entries with an HTML comment `<!-- backfilled YYYY-MM-DD -->` for audit trail. Useful for vaults whose Sessions/ predate v0.12.8.
- **`tests/migrate-sessions-to-wiki-meta.test.mjs`** (7 new tests): plain rename, git mv branch, fresh (already-migrated), both-overlap merge with conflict, empty (skipped), non-existent vault, --dry-run.
- **`tests/session-auto-journal.test.mjs`** (+3 new tests in new `v0.12.8 log.md auto-append` describe block): SessionEnd appends a parseable line with verb/wikilink/objective/result, idempotent dedup, silent-skip when log.md absent.

### Backward compatibility

- Vaults with `wiki/Sessions/` (DEDIBOX as of writing) continue to work — new sessions write to the new `wiki-meta/Sessions/` location (auto-created), while the legacy folder stays as-is until the opt-in `--migrate-sessions-to-wiki-meta` is run. No code reads the legacy path anymore.
- Vaults without the hook installed (or with opt-out `OBSIDIAN_ROUTER_NO_SESSION_JOURNAL=true`) are unaffected.
- Vaults without `wiki-meta/log.md` (rare — wiki scaffold not yet run) silently skip the log.md append; the journal file itself is still written normally.

### Test count: **476/476 passing** (was 466 at v0.12.7; +10 tests: 3 hook log.md + 7 migration).

## [0.12.7] — 2026-05-24

UX overhaul of the vault-attach flow. Three main changes: (1) renamed `meta-add-vault` to `meta-attach-vault` because the dominant case is attaching a vault to an existing code/dev workspace, not raw vault registration. (2) `setup-vault.mjs` now scaffolds the `wiki/` + `wiki/sessions/` + `wiki-meta/{index,hot,overview,log}.md` structure inline at provisioning time, so a freshly-bootstrapped vault is immediately ready for workspace-bound mode (the `--link-workspace` flow requires `wiki-meta/index.md` to exist — pre-v0.12.7 this was a separate manual `/obsidian-router:wiki` step). (3) `--link-workspace <ws-path>` is now also a flag of the main bootstrap subcommand, so `setup-vault.mjs <vault-path> --link-workspace <cwd>` does the provisioning + binding in one shot (single permission prompt vs. two separate invocations). The new wizard is **didactic by design**: every Bash call is preceded by a 2-3 line explanation in chat, and Bash `description` arguments are full-sentence intentions in the user's language (not cryptic command labels).

Motivation: 2026-05-24 conversation with Roland. He reported cryptic permission prompts during vault setup ("Check template vault layout vs new vault" / "Provision SchoolMouv vault (install plugins, scaffolds, register in router config)") that didn't explain what was about to happen, noted that scaffolds had to be created in a second step, and that he generally builds workspace-first (vault is created FOR a code project, not standalone). The fix codifies workspace-first as the default flow, bundles the scaffolds + workspace-link into provisioning, and adds a conventions picker step so the new vault inherits the globally-active behavior rules without a separate `/obsidian-router:conventions install` round-trip.

### Added

#### `scaffoldWikiMeta()` in `setup-vault.mjs` (creates wiki structure inline)

- New helper function `scaffoldWikiMeta(vaultPath)` (`scripts/setup-vault.mjs:772`): creates `wiki/`, `wiki/sessions/`, and the 4 `wiki-meta/{index,hot,overview,log}.md` scaffolds from `templates/wiki-meta/`, substituting `{{TIMESTAMP}}` and `{{VAULT_PATH}}` placeholders. Idempotent — existing files are preserved.
- Called from `setupVault()` (right before `writeEnvFile`) so every `setup-vault.mjs <vault-path>` invocation produces a vault that's immediately bind-ready for workspace-bound mode.
- `--force` is intentionally NOT honored — scaffolds become user content (the wiki accretes notes, log gets entries, hot.md tracks recent work). `--force` on existing wiki state would wipe user work. Doc-block on the function explains the deliberate divergence from `cloneRootDocs` / `cloneSmartEnv` / `cloneSnippets` behavior.
- Does NOT touch `CLAUDE.md` — that's owned by the `meta-attach-vault` conventions-picker step (and by the `/obsidian-router:wiki` skill for the wiki block).

#### Inline `--link-workspace <ws-path>` flag on the main bootstrap subcommand

- New helper `linkWorkspaceToVault({ workspacePath, vaultPath, vaultSlug, opts })` (`scripts/setup-vault.mjs:700`): performs the validation + `.env` upsert that was previously inlined in the standalone CLI handler. Hoisted to module scope so it can be called from BOTH the standalone `--link-workspace <ws> <slug>` subcommand AND the inline `--link-workspace <ws>` flag of `setup-vault.mjs <vault-path>`.
- Similarly hoisted `upsertEnvVarSync` and `removeEnvVarSync` to module scope (were nested inside the CLI dispatcher) — same logic, just reusable. Sync (mirrors `src/tools/lock.mjs` async equivalent), regex-escapes keys, preserves trailing newline.
- New CLI arg-parsing branch (`scripts/setup-vault.mjs:2092`): when `--link-workspace <ws-path>` appears in the main bootstrap subcommand, parse the value, **skip the consumed positional** (regression guard: `args.find(a => !a.startsWith('--'))` would have stolen `<ws-path>` as the vault arg otherwise), and pass `linkWorkspace: <ws-path>` to `setupVault()`. Slug is derived from the vault path via the same `defaultNameFromPath()` the router uses at runtime, so the `.env` line and the runtime resolution agree.
- Standalone `--link-workspace <ws> <slug>` subcommand (CLI dispatcher) refactored to call the new helper instead of inlining the logic — net: removed ~60 lines of duplication.
- Help text (`--help`) updated with the new flag.

#### `meta-attach-vault` skill (replaces `meta-add-vault`)

- New skill at `skills/meta-attach-vault/SKILL.md` with three flows behind one wizard:
  - **Workspace-first (default, ~95% of cases)** — context detection (`.git/`? `.obsidian/`? `OBSIDIAN_ROUTER_DEFAULT_VAULT` already set?) → if no `.git/`, **plain-words explanation of what git is for** (versioning, secrets protection, sharing) + offered `git init` → vault path proposal (default `C:\VAULTS\<basename-cwd-as-is>`, modifiable, with garde-fou explaining why it lives OUTSIDE the workspace) → **single** `setup-vault.mjs <vault-path> --link-workspace <cwd>` call (provisions + binds in one prompt) → workspace `.gitignore` edit (idempotent, under `# obsidian-mcp-router` marker comment) → **conventions picker via `AskUserQuestion multiSelect`** with 4 recommended (`roadmap-discipline`, `default-vault-health-check`, `wiki-query-first`, `path-disambiguation`) + 4 opt-in (`source-type`, `bilingual`, `heading-hierarchy`, `auto-enrichment`) installed via `/obsidian-router:conventions install <id>` (not raw `append_to_file` — preserves the H2-heading idempotency guard) → final reminders with the `openUri` field from `list_vaults` (pre-encoded for spaces/accents, no hand-composed `obsidian://` URI).
  - **Standalone (rare)** — same as workspace-first but skips git/linking/gitignore steps. For vaults that aren't tied to any project (personal journal style).
  - **Remote (existing flow, preserved)** — register a vault that already runs elsewhere (NAS, VPS, Cloudflare Tunnel). No change from the v0.12.6 `meta-add-vault` remote flow.
- **Style rules baked into the skill** — every Bash call gets a 2-3 line pre-flight explanation in chat (what's about to run, why, what files will be touched) + a full-sentence `description` argument in FR/EN matching the user's language (e.g., `"Provisionner le vault SchoolMouv ET lier le workspace mon-projet : installer les plugins Obsidian, allouer un port, générer une clé API, scaffolder wiki/wiki-meta/, écrire .env + .mcp.json, enregistrer dans ~/.claude/obsidian-mcp-router/config.json, et ajouter OBSIDIAN_ROUTER_DEFAULT_VAULT=schoolmouv dans mon-projet/.env"`). Replaces the v0.12.6 anti-pattern of cryptic command-label descriptions surfaced through the permission prompt.

#### `meta-attach-vault` slash command

- New `commands/meta-attach-vault.md` mirrors the skill: documents the three flows, the new triggers (EN + FR), and the wizard's 7 wired-up steps for workspace-first.

#### Regression tests (6, in `tests/scaffold-wiki-meta.test.mjs`)

- `scaffoldWikiMeta — fresh bootstrap creates wiki/, wiki/sessions/, and 4 wiki-meta scaffolds` — end-to-end CLI spawn, asserts directory structure + 4 scaffolds present + placeholders substituted + log.md has the initial scaffold entry.
- `scaffoldWikiMeta — re-bootstrapping preserves existing scaffolds (idempotent)` — user marker injected before re-run survives the second bootstrap.
- `--link-workspace — bootstrap + writes OBSIDIAN_ROUTER_DEFAULT_VAULT to workspace .env` — verifies the slug derivation matches the vault basename and the `.env` line is correctly upserted.
- `--link-workspace — non-existent workspace path → fails fast` — guard against silent failures.
- `--link-workspace — without a value → fails fast with explicit error` — CLI parsing guard.
- `--link-workspace — positional vault arg is not stolen by --link-workspace value` — regression guard for the `args.find()` consumption bug.

### Changed

- **Skill renamed**: `skills/meta-add-vault/SKILL.md` → `skills/meta-attach-vault/SKILL.md` (skill deleted on disk; the new skill carries all the old trigger phrases plus new attach-flavored ones to preserve muscle memory).
- **Command renamed**: `commands/meta-add-vault.md` → `commands/meta-attach-vault.md`.
- **References updated** across the codebase: `README.md` (lines 140 + 826 entry tables), `docs/quick-reference-fr.html` (line 306), `docs/quick-reference-en.html` (line 306), `docs/announcements.md` (line 25 commands list), `commands/meta-setup.md` (cross-reference), `commands/meta-sync-template.md` (companion-commands list), `skills/meta-setup/SKILL.md` (cross-reference), `skills/meta-sync-template/SKILL.md` (don't section + companion-skills list), `skills/auto-mode/SKILL.md` (push-back-if hint), `.claude-plugin/marketplace.json` (descriptions × 2), `.claude-plugin/plugin.json` (description). Historical mentions in `CHANGELOG.md` are preserved as-is.
- **Marketplace + plugin manifests bumped** to `0.12.7` from `0.12.2` (the manifests were lagging behind the package version — synced as part of this release).
- **Test count**: 459/459 passing (453 pre-existing + 6 new in `tests/scaffold-wiki-meta.test.mjs`). `package.json` test script updated to include the new file.

### Migration

Existing scripts and muscle memory:
- The natural-language triggers from `meta-add-vault` (*"add a vault to the router"*, *"ajoute un vault au router"*, etc.) all match the new skill — no relearning required.
- The slash command `/obsidian-router:meta-add-vault` no longer exists. Use `/obsidian-router:meta-attach-vault`.
- Existing vaults bootstrapped via pre-v0.12.7 `setup-vault.mjs` keep working. They just won't have the scaffolds auto-created; run `/obsidian-router:wiki` on them to add the scaffolds (same as before).
- The conventions picker in the wizard is opt-in per convention — users who want to skip can deselect all 8 and configure later via `/obsidian-router:conventions install <id>`.
- The standalone `setup-vault.mjs --link-workspace <ws> <slug>` subcommand still works for re-linking an existing vault to a different workspace (or first-time binding after a pre-v0.12.7 bootstrap).

### `/review+` hardening (3 passes, Code Reviewer subagent + codex)

`/review+` ran 3 passes (Code Reviewer subagent + `codex review` per pass), surfacing 6 findings across passes 1 and 2; all addressed with 7 regression tests added.

- **[IMPORTANT — pass 1 codex P2 #2]** Early validation of `--link-workspace` path in `setupVault()`. Pre-fix, an invalid `--link-workspace` value only failed AFTER plugins were cloned + port allocated + `config.json` updated, leaving an orphan registry entry. Fix validates the workspace path BEFORE any mutation. Regression test snapshot the `portRegistry` and vault dir absence on refusal.
- **[IMPORTANT — pass 1 codex P2 #1 → refined in pass 2]** Legacy `wiki/<scaffold>.md` layout guard before `scaffoldWikiMeta()`. Initial pass-1 fix used `detectVaultMigrationState() === 'legacy' || 'partial'` placed before the scaffold call — pass 2 codex caught two issues: (a) the guard still fired AFTER plugin clone (same anti-pattern as #2 above), and (b) `'partial'` also matches the benign repair case of "some `wiki-meta/*.md` exist, no legacy files" which `scaffoldWikiMeta` handles idempotently. Pass-2 fix moved the guard to right after `mkdirSync(abs)` and narrowed the refusal condition to `legacyScaffolds.length > 0` (any of the 4 `wiki/<scaffold>.md` present). Regression test asserts no side-effects on refusal + the partial-meta-only state is repaired, not refused.
- **[IMPORTANT — pass 1 codex P2 #3]** Inline `--link-workspace` slug derivation now honors `cfg.vaultNames[abs]` before falling back to `defaultNameFromPath(abs)`. Pre-fix, an existing vault with a custom name configured would get the basename written to the workspace `.env` and the workspace-bound hooks (which resolve `vaultNames[vp] || defaultNameFromPath(vp)`) would fail to find the binding. Regression test pre-registers a custom `vaultNames` entry and asserts the `.env` content uses the custom name.
- **[IMPORTANT — pass 1 Reviewer A #1]** Rebind warning in `linkWorkspaceToVault()`. Pre-fix, overwriting an existing `OBSIDIAN_ROUTER_DEFAULT_VAULT=<old-slug>` with a new slug was silent — exactly the UX antipattern this commit set out to fix. Now reads the previous value (handles quoted/unquoted/whitespace edge cases), warns if different. Two regression tests: rebind to different slug → warns, re-bind to same slug → silent.
- **[NIT — pass 1 Reviewer A #5]** Missing wiki-meta scaffold template now triggers a `warn()` instead of silent `continue` — guards against drift if `WIKI_META_SCAFFOLDS` gains an entry without a matching template file.
- **[NIT — pass 1 Reviewer A #4]** Fixture-vault label changed from `REF-KEY-DO-NOT-LEAK` to `fixture-test-key-not-real` (cosmetic — avoids secret-scanner false-positives).

Final test count: **466/466 passing** (453 pre-existing + 6 v0.12.7 base + 7 review+ regression tests). Both reviewers concluded "OK to merge" at pass 3 with zero new findings.

## [0.12.6] — 2026-05-23

`/review+` hardening pass over v0.12.4's `session-auto-journal` hook (the path-disambiguation work landed independently as v0.12.5 — this release is the parallel review audit's output). Two-pass audit (Code Reviewer subagent + `codex review --commit`) surfaced 7 priority findings on pass 1 + 1 fresh finding on pass 2 (codex caught that the first fallback fix still collided — see the last "Fixed" bullet for the iteration). All 8 addressed with 7 regression tests. Test count: **453/453 passing** (was 452 after v0.12.5 + 1 fresh fallback-collision test added in this pass).

### Fixed

- **Filename collision in same minute** (`hooks/session-auto-journal.mjs:261` — codex P2 #1): two distinct sessions for the same workspace started within the same minute resolved to the same `journalPath` because the filename was `<date>-<HHMM>-<workspace>.md`. The second session then appended into the first session's file. Filename now includes an 8-char session-id discriminator: `<date>-<HHMM>-<workspace>-<sessionIdShort>.md`.
- **`rewriteFrontmatter` silent no-op when `status:` was absent** (`hooks/session-auto-journal.mjs:430-437` — Reviewer A #1): the regex `.replace(/^status:.*$/m, ...)` was a no-op if the `status:` key had been stripped (manual edit or upstream bug) — the journal stayed `open` forever. Now falls back to appending `\nstatus: closed`.
- **`mcp__obsidian-router__execute_template` not journaled** (`hooks/session-auto-journal.mjs:204` + matchers — codex P2 #2): `execute_template` with `createFile: true` is a write tool per `src/index.mjs`'s `WRITE_TOOL_NAMES`, but the journal hook and `hooks.example.json` matchers omitted it. Added to both the in-hook `LOGGED_TOOLS` Set and the two relevant matcher blocks (wiki-autocommit + session-auto-journal).
- **`move_file` + `execute_template` recap missed endpoints** (`hooks/session-auto-journal.mjs:373` — codex P3 #3): the MCP-write branch read only `tool_input.path`, but `move_file` uses `from`/`to` and `execute_template` uses `targetPath`. Now collects `path | from | to | targetPath`.
- **User prompts > 100 KB corrupting the journal** (`hooks/session-auto-journal.mjs:318` — Reviewer A #5): user pasting a large dump into a prompt ballooned the journal beyond render capacity. Now truncated at 100 KB with a marker pointing to Claude Code's transcript for the full content.
- **Doc/wiring drift on the `SessionStart` matcher** (`hooks/hot-cache-load.mjs:26` — Reviewer A #2): inline doc still described `startup|resume`, but `hooks.example.json` was widened to `startup|resume|clear` in v0.12.4. Aligned with a note explaining the widening.
- **Fallback `session_id` lost entropy at `slice(0, 8)`** (`hooks/session-auto-journal.mjs:235-242` — Reviewer A pass 2 + codex pass 2 P3): the v0.12.4 fallback `unknown-${Date.now()}` survived `String(sessionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)` as the literal `unknown1` — only the first digit of the timestamp. A first attempt at the fix used `fallback-${randomUUID()}`, but codex caught that `fallback` is exactly 8 chars → `slice(0, 8)` consumed the whole prefix and never sampled the UUID, so two fallback sessions still collided on the same suffix. Final fix: use a raw `randomUUID()` as the fallback, no prefix — the first 8 alphanum chars are then 32 bits of UUID entropy.

### Regression tests added (7, in `tests/session-auto-journal.test.mjs`)

- `codex P2 #1` — distinct session_ids never collide on filename
- `Reviewer A IMPORTANT #2` — SessionEnd closes frontmatter even when `status:` was removed
- `Reviewer A IMPORTANT #5` — user prompts > 100 KB are truncated with a marker
- `codex P2 #2` — `execute_template` (with createFile) is logged + `targetPath` added to state.files
- `codex P3 #3` — `move_file` adds both `from` and `to` to state.files
- `codex pass 2 P3` — fallback session_id (Claude Code omits one) does not collide on filename
- `Reviewer A IMPORTANT #7` — SessionStart 2x with same session_id is idempotent on the journal file

### Deferred to follow-up (NIT, tracked but out of scope)

- Casing `wiki/Sessions/` vs `wiki/sessions/` on case-sensitive filesystems (Linux ext4 / case-sensitive APFS) — needs a convention decision rather than a code-only fix.
- `MAX_PROMPT_BYTES = 100_000` could be made env-overridable (`OBSIDIAN_ROUTER_JOURNAL_MAX_PROMPT_BYTES`) — 2-line change, deferred until real demand.
- `appendFileSync` non-atomic multi-process — documented inline; only a real issue if Claude Code dispatches concurrent events for the same session_id, which it doesn't today.

## [0.12.5] — 2026-05-23

Closes a recurring path-confusion footgun in workspace-bound mode: when the workspace cwd and the associated vault share the same basename (e.g. `C:\Users\rolan\DEDIBOX` ↔ `C:\VAULTS\DEDIBOX`), Claude could generate filesystem paths that concatenate the cwd path with a vault-internal subpath (`wiki/`, `wiki-meta/`) — producing non-existent paths. The pre-existing `wiki-query-first-nudge` hook already warned `cwd ≠ vault` but didn't give the two absolute paths concretely or forbid the mix explicitly. v0.12.5 enriches the hook with a dynamic `PATH RESOLUTION RULES` block + ships a matching installable convention + a backup section in the global user CLAUDE.md.

### Added

#### Hook enhancement (deterministic, fires at every prompt-submit)

- **New `PATH RESOLUTION RULES` block** in `hooks/wiki-query-first-nudge.mjs`, emitted only when `ctx.mode === 'workspace-bound'`. The block resolves the two absolute roots dynamically from the running context:
  - `cwd` (workspace path, from hook input)
  - `ctx.vaultPath` (associated vault path, from `OBSIDIAN_ROUTER_DEFAULT_VAULT` resolution)

  and renders them inline with concrete WRONG/RIGHT examples that use the *actual* paths of the current session (not generic placeholders). Plus an ordered preference list: wikilink `[[basename]]` → click-to-open link → filesystem path (only when explicitly asked, double-checked).
- **`defaultNameFromPath` now imported** from `hooks/_helpers/workspace-vault.mjs` to compute the shared basename for the explanation text (e.g. "they share the same basename `dedibox` but live under different parents").
- In `cwd-is-vault` mode, the new block is suppressed entirely — there's only one root in that mode, no confusion possible.

#### Installable convention (visible in vault CLAUDE.md)

- **New convention snippet** `skills/conventions/snippets/path-disambiguation.md` (~3 KB) — install via `/obsidian-router:conventions install path-disambiguation`. Same content as the hook's PATH RESOLUTION RULES block but in static markdown form, so any contributor opening a CLAUDE.md sees the rule even without the hook running.
- **Mapping table updated** in `skills/conventions/SKILL.md` — adds `path-disambiguation` to the documented library.

#### Global user CLAUDE.md (backup layer)

- **New section "Workspace-bound path disambiguation — NEVER mix cwd path with vault subpath (universel)"** added to `~/.claude/CLAUDE.md` after the `Wiki-query-first reflex` section. Same content as the snippet, applies by default to every session whether or not the hook fires (covers opt-out via `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true`, settings.json missing hook entry, or hook silent failure).

### Why

Roland's verbatim trigger: *"avant tu m'as créé ce lien : `C:\Users\rolan\DEDIBOX/Stack/host.md` !!!!!!! lui c'est de la merde"* followed by *"c'est insupportable que tu ignores des regles, je ne veux plus que ça arrive, trouve moi une solution perenne pour tous les vaults"*.

The previous protection (wiki-query-first nudge with "cwd is a code/dev project, not the vault itself") was too generic — it told Claude the cwd and vault are different but didn't show the concrete paths side-by-side or forbid the trap pattern explicitly. With both paths visible (`C:\Users\rolan\DEDIBOX` next to `C:\VAULTS\DEDIBOX`) and a WRONG/RIGHT example using the actual session paths, the LLM has zero excuse to mix them — the trap is named, shown, and a safer default (wikilink `[[basename]]`) is recommended.

Three layers of defense in depth, mirroring the `roadmap-discipline` v0.10.1 + `wiki-query-first` v0.11.6 patterns:
1. **Hook** (deterministic, fires at every prompt-submit) — most reliable layer
2. **Installable convention** (per-vault, visible in CLAUDE.md) — useful when sharing a vault or for contributors who turned off the hook
3. **Global user CLAUDE.md** (every session) — backup for opt-out / hook failure

### Backward compatible

- **Hook change is additive** — same JSON output shape, just longer `additionalContext` payload (workspace-bound mode only). cwd-is-vault sessions get the identical pre-v0.12.5 nudge.
- **Convention is opt-in** — vaults that don't install `path-disambiguation` see no change. The hook still injects the rule at prompt-submit for them via the global CLAUDE.md layer.
- **No API change** — no new tools, no schema changes, no env vars added.
- The hook can still be disabled per-session via `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true` (in which case only the global CLAUDE.md layer protects).
- Test added: `tests/wiki-query-first-nudge.test.mjs` covers the new block (cwd-is-vault: no block emitted; workspace-bound: block present with both paths + WRONG/RIGHT example).

## [0.12.4] — 2026-05-23

Adds automatic per-session journaling to the router. Splits "what happened during a session" (now auto-captured chronologically) from "what's worth keeping as a polished document" (still `/save`-triggered). Triggered by Roland noticing the `wiki/Sessions/` folder in the DEDIBOX vault and wanting full-auto journaling everywhere instead of manual `/save` for chronology.

### Added

- **`hooks/session-auto-journal.mjs`** — multi-event hook that auto-writes one journal file per Claude Code session under `<vault>/wiki/Sessions/<YYYY-MM-DD>-<HHMM>-<workspace-slug>.md`. Dispatches on `hook_event_name`:
  - **`SessionStart`** (matcher `startup|resume|clear`): creates the file with frontmatter `type: session, status: open, session-id, workspace, cwd, started-at`. Records state in `~/.claude/obsidian-mcp-router/session-journals/<session-id>.json` for cross-event continuity.
  - **`UserPromptSubmit`**: appends `## HH:MM:SS — User prompt` with the prompt verbatim. Lazy-creates the journal if SessionStart wasn't wired or fired.
  - **`PostToolUse`** (matcher restricted to write-flavored tools — `Write|Edit|MultiEdit|Bash|mcp__obsidian-router__write_file|patch_file|append_to_file|set_frontmatter|merge_frontmatter|delete_file|move_file`): appends `### HH:MM:SS — tool: <name>` with concise args. Reads intentionally skipped (too noisy).
  - **`SessionEnd`**: inserts a heuristic recap at the top of the journal (counts of prompts/tools, files touched, bash highlights, duration, vault), rewrites frontmatter `status: closed` + `ended-at` + `duration`, deletes the state JSON.
- Vault target follows the same dual-mode resolution as `hot-cache-load`: cwd-is-vault writes under `<cwd>/wiki/Sessions/`, workspace-bound writes under the linked vault's `wiki/Sessions/`. No association → silent skip.
- Opt-out per-session: `OBSIDIAN_ROUTER_NO_SESSION_JOURNAL=true`.
- **`tests/session-auto-journal.test.mjs`** — 10 tests covering SessionStart creation, lazy creation on UserPromptSubmit, Write/Bash logging, Read silencing, full SessionEnd flow (recap + frontmatter rewrite + state cleanup), workspace-bound vault target, no-vault silent skip, opt-out env var, unknown-event forward-compat.

### Changed

- **`skills/save/SKILL.md`** — `/save` no longer routes any flavor to `wiki/Sessions/`. The "whole conversation as session note" flavor is deprecated and now redirects: *"the auto-journal captures the chronology; which polished insight from this session do you want extracted into a permanent document?"*. `/save` keeps its job (polished, type-classified documents in `decisions/` / `answers/` / `refs/` / `techniques/` / `adrs/` / `ideas/`).
- **`hooks/hooks.example.json`** — adds `session-auto-journal.mjs` to `SessionStart`, `UserPromptSubmit`, `PostToolUse` (with the write-tool matcher), and the new `SessionEnd` event slot. `SessionStart` matcher widened from `startup|resume` to `startup|resume|clear` to also journal across context-clear events.

### Why this split

Manual `/save` produces high-polish notes (structured frontmatter, narrative sections, cross-links) but requires Roland's discipline to invoke at the right moment. Auto-journal produces low-polish but high-coverage chronological capture: every session lands a file, no exceptions. The two complement each other: the journal is the raw "what happened", `/save` outputs are the curated "what mattered". A `/save`-produced document can backlink to its session journal for context recovery (e.g. *"this decision was made during [[2026-05-23-2200-obsidian-mcp-router]]"*).

### Recap quality (current limit)

The SessionEnd recap is **heuristic-only** for v0.12.4: counts + files touched + bash highlights + duration. No LLM call. Considered shipping LLM-driven extractive recap but rejected for v1 — it requires `ANTHROPIC_API_KEY` in the workspace `.env`, adds API call latency at SessionEnd, and the heuristic recap already covers ~80% of the "what happened" scan-read use case. LLM-driven recap is a planned v0.12.5 feature behind the opt-in env var, with heuristic fallback when absent.

### Test count: **444/444 passing** (was 434 at v0.12.3; +10 session-auto-journal tests).

## [0.12.3] — 2026-05-23

Hardens the click-to-open feature against silent drift. Triggered by an audit discovery that **8/10 vaults** had been running with a stale bridge plugin (v0.1.1, no `/open/*` route) AND a too-old Local REST API plugin (v3.6.1, no `addPublicRoute()` method) for over a week — both states invisible to the existing `meta-status` diagnostic, which only checks the router → vault HTTP ping. Roland's request: *"je veux que le routeur soit infaillible"*.

### Added

- **`scripts/meta-audit-bridge-readiness.mjs`** — read-only audit of every vault in `portRegistry` for click-to-open readiness. Four checks per vault:
  1. `mcp-router-bridge` plugin ≥ v0.2.0 installed (route handler exists on disk)
  2. `obsidian-local-rest-api` plugin ≥ v4.0.0 installed (exposes `addPublicRoute()`)
  3. `enableInsecureServer: true` + `insecurePort` set in LRA's `data.json` (HTTP server listening)
  4. **Live probe**: `GET http://127.0.0.1:<insecurePort>/open/<nonexistent>.md` returns 404 (route registered) vs 401 (auth-middleware catch-all = route never registered, usually because Obsidian holds stale code in memory)

  The live probe (#4) is the key contribution: static manifest checks alone cannot detect "files on disk are correct but Obsidian hasn't reloaded since the sync". Output is a compact ANSI-coloured table + per-failure remediation hints. Flags: `--json` (machine-readable for skill / CI consumers), `--vault <slug-or-path>` (single-vault audit). Exit code 0 if all ready, 1 if any vault is not ready, 2 on script error.

- **`skills/meta-audit-bridge-readiness/SKILL.md`** — natural-language wrapper for the audit. Triggers (EN) `audit my click-to-open links`, `which vaults need a reload`, `check bridge readiness`. Triggers (FR) `audite les liens cliquables`, `vérifie le bridge sur tous les vaults`, `quels vaults ont besoin d'un reload`.
- **`commands/meta-audit-bridge-readiness.md`** — slash command (`/obsidian-router:meta-audit-bridge-readiness`).
- **`npm run audit:bridge-readiness`** — `package.json` script entry for direct CLI use.

### Why this matters

`meta-status` (existing) checks the router can reach each vault (HTTP ping `/`). `meta-audit-bridge-readiness` (new) is its complement: it checks the *clickable links* you put in chat actually work, end-to-end including in-memory route registration. The two diagnostics together cover the full surface of "is the router working for me?" — connectivity AND feature-level readiness.

### Test count: **434/434 passing** (unchanged from v0.12.2 — the new audit script is integration-tested via the smoke run during shipping, which exercised the live probe against all 10 configured vaults).

## [0.12.2] — 2026-05-23

Session 3 of the v0.12.0 phased rollout. Closes the three-session arc with verification + a defensive code improvement to the migration script.

### Audit result on Roland's 9 migrated vaults (post-v0.12.1)

Scanned every `CLAUDE.md` found within 2 levels of each vault root. Result:

| Vault | CLAUDE.md location | Stale `wiki/<scaffold>.md` | `wiki-meta/` refs | workspace-bound mentions |
|---|---|---|---|---|
| .template | `Documentation/CLAUDE.md` | 0 | 25 | 6 |
| TradingView | `Documentation/CLAUDE.md` | 0 | 25 | 6 |
| Roland | `wiki-meta/CLAUDE.md` | 0 | 15 | 6 |
| SCI DU SOURIRE | (none) | — | — | — |
| portfolio.nicolasgalzy.fr | `wiki-meta/CLAUDE.md` | 0 | 25 | 6 |
| Smile | `wiki-meta/CLAUDE.md` | 0 | 25 | 6 |
| portfolio.ameliegalzy.fr | `Documentation/CLAUDE.md` | 0 | 25 | 6 |
| DEDIBOX | `wiki-meta/CLAUDE.md` | 0 | 25 | 6 |
| opsidian-mcp-router et bridge | `wiki-meta/CLAUDE.md` | 0 | 25 | 6 |

**Findings**:
- 8/9 vaults have a `CLAUDE.md`. The 9th (`SCI`) intentionally has none (deleted in a previous audit).
- **All 8 are already current**: 0 stale `wiki/<scaffold>.md` paths + 6 workspace-bound mentions = the v0.11.6 convention text is present in every vault.
- The "convention refresh" task originally planned for Session 3 is therefore a **no-op** — the path swap in v0.12.1 already cleaned scaffold paths, and the v0.11.6 install (run at the time) put the workspace-bound section in place across the fleet.
- `wiki/` directories: 7 are gone (auto-cleaned post-migration), 2 (DEDIBOX + project-router) correctly preserved for user content (Refs/, Decisions/, project notes).
- The `wiki-query-first-nudge` hook fired correctly in workspace-bound mode in the verification session — end-to-end functionality confirmed.

### Changed

- **`scripts/setup-vault.mjs` `rewriteClaudeMdScaffoldPaths(vaultPath)`** — extended from "vault root only" to scan three common locations: `<vault>/CLAUDE.md`, `<vault>/wiki-meta/CLAUDE.md`, `<vault>/Documentation/CLAUDE.md`. Rewrites scaffold paths in every copy found, returns the total replacement count across all. Defensive enhancement triggered by the Session 3 audit (the migration's path rewrite would otherwise miss Roland's vaults where CLAUDE.md is not at root). Idempotent and backward-compatible: vaults with CLAUDE.md at root continue to work exactly as before.
- **`tests/migrate-wiki-meta.test.mjs`** — 3 new tests for the multi-location branch: rewrite in `wiki-meta/CLAUDE.md`, rewrite in `Documentation/CLAUDE.md`, rewrite across two CLAUDE.md copies at once with summed count.

### Test count: **434/434 passing** (was 431 at v0.12.1; +3 multi-location tests).

### Phased rollout v0.12.0 — closed

Three releases over 2026-05-23:
- **v0.12.0** — code refactor (hooks + scripts + src all probe `wiki-meta/`), templates moved, tests + docs updated. Clean break, no fallback.
- **v0.12.1** — `setup-vault.mjs --migrate-wiki-meta` + batch form. Ran on Roland's 10 vaults: 9 migrated (1 git mv, 8 fs rename), 1 skipped (Coursera, never bootstrapped).
- **v0.12.2** — verification + multi-location CLAUDE.md rewrite.

The vault layout (`wiki-meta/` for scaffolds, `wiki/` for user content) is now the established convention. Future scaffolds and conventions land in `wiki-meta/`; user notes stay under `wiki/`.

## [0.12.1] — 2026-05-23

Session 2 of the v0.12.0 phased rollout: ships the migration tooling and runs it across the 10 existing vaults. Closes the broken-window state left at v0.12.0 (hooks were silent on vaults still using the legacy `wiki/<scaffold>.md` layout).

### Added

- **`scripts/setup-vault.mjs --migrate-wiki-meta <vault-path>`** — single-vault migration. Detects state (`legacy` / `fresh` / `partial` / `empty` / `no-vault`), refuses on `partial` with a clear diagnostic, no-ops on `fresh` (unless `--force`). For `legacy`: ensures `wiki-meta/` exists, moves the 4 scaffolds via `git mv` if the vault is a git repo (preserves history + auto-stages) or `fs.rename` otherwise, rewrites `wiki/(hot|index|log|overview)\.md` → `wiki-meta/$1.md` in the vault's root `CLAUDE.md`, and appends a migration-line to the (now-moved) `wiki-meta/log.md`.
- **`scripts/setup-vault.mjs --migrate-all-wiki-meta`** — batch form. Iterates over `cfg.portRegistry`, runs the same migration on each vault, reports a per-vault status summary at the end. Exits non-zero if any vault fails. Shared flags: `--dry-run` (preview without writes), `--force` (re-rewrite CLAUDE.md on already-migrated vaults — useful if a previous migration crashed mid-flight).
- **`tests/migrate-wiki-meta.test.mjs`** (NEW) — 15 tests covering: plain-rename branch, git-mv branch (with real `git init` fixtures), CLAUDE.md scaffold-path rewrite (preserving non-scaffold `wiki/...` user-content paths), idempotency, `--force` re-rewrite, `--dry-run` no-op, batch summary aggregation, batch `--dry-run`, partial-state refusal, empty-state skip, missing-arg error, non-existent path failure, empty-portRegistry batch failure.

### Migrated on Roland's machine (9 vaults)

Ran `--migrate-all-wiki-meta` against the 10 vaults in `portRegistry`. Result:

```
✓ C:\VAULTS\.template                                — fs    rename, 31 CLAUDE.md replacements
✓ C:\VAULTS\TradingView                              — fs    rename, 31 CLAUDE.md replacements
✓ P:\Mon Drive\VAULTS\Roland                         — fs    rename, 17 CLAUDE.md replacements
✓ P:\Mon Drive\SCI DU SOURIRE VAULT OBSIDIAN         — fs    rename, 17 CLAUDE.md replacements
✓ M:\Mon Drive\VAULTS\portfolio.nicolasgalzy.fr      — fs    rename, 31 CLAUDE.md replacements
✓ C:\VAULTS\Smile                                    — fs    rename, 31 CLAUDE.md replacements
✓ M:\Mon Drive\VAULTS\portfolio.ameliegalzy.fr       — fs    rename, 31 CLAUDE.md replacements
✓ C:\VAULTS\DEDIBOX                                  — fs    rename, 31 CLAUDE.md replacements
✓ C:\VAULTS\opsidian-mcp-router et bridge            — git mv,  31 CLAUDE.md replacements

— C:\VAULTS\Coursera                                 — skipped (empty state, never bootstrapped via /obsidian-router:wiki)
```

The broken-window status from v0.12.0 is now closed: `hot-cache-load` and `wiki-query-first-nudge` resume normal operation on these 9 vaults next session start.

### Test count: **431/431 passing** (was 416 at v0.12.0; +15 from `migrate-wiki-meta.test.mjs`).

### What's left for Session 3 (v0.12.2)

The convention snippets installed in per-vault CLAUDE.md (`wiki-query-first`, `roadmap-discipline`) still contain old `wiki/<scaffold>.md` references in their prose. v0.12.1's `--migrate-wiki-meta` already swept those (the regex is unconditional on the 4 scaffold filenames anywhere in CLAUDE.md), so most are fixed. Session 3 will re-install the latest snippet versions to pick up other recent changes + run a verification sweep across the fleet.

## [0.12.0] — 2026-05-23

**BREAKING** (vault layout): the 4 wiki scaffolds — `hot.md`, `index.md`, `log.md`, `overview.md` — move out of `wiki/` into a sibling `wiki-meta/` directory. User content stays under `wiki/` (people, concepts, sessions, decisions, references, projects, …). This is a clean break — there is **no fallback** to the old layout in the code. Vaults still on `wiki/<scaffold>.md` will appear "empty" to the hooks (silent exit) until migrated.

Roland's motivation: the 4 scaffolds are conceptually META (catalog + recent-context cache + operation log + executive summary) — visually mixing them with user notes under a single `wiki/` clutters Obsidian's file tree. The split makes the boundary semantic: open `wiki-meta/` for system files, `wiki/` for content.

### Phased rollout (Session 1 = THIS release, Sessions 2 & 3 ship after)

- **Session 1 (v0.12.0)** — code refactor + tests green + templates moved. Existing vaults are NOT touched.
- **Session 2 (v0.12.1, planned)** — `setup-vault.mjs --migrate-wiki-meta <vault>` + `--migrate-all-wiki-meta`. Atomic `git mv` of the 4 files + edit of the vault's `CLAUDE.md`. Run on all bootstrapped vaults.
- **Session 3 (v0.12.2, planned)** — re-install the convention snippets (`wiki-query-first`, `roadmap-discipline`) on each vault so their per-vault `CLAUDE.md` references catch up to the new paths.

Between Session 1 and Session 2, vaults still on the old layout cause the `hot-cache-load` and `wiki-query-first-nudge` hooks to silent-exit (detection probe `wiki-meta/index.md` fails). Accept this as the cost of clean break; alternative was carrying fallback logic indefinitely.

### Changed

- **`hooks/_helpers/workspace-vault.mjs` `detectVaultContext()`** — scaffold-detection probe switched from `wiki/index.md` to `wiki-meta/index.md`. Both `cwd-is-vault` and `workspace-bound` modes affected.
- **`hooks/hot-cache-load.mjs`** — reads `<vault>/wiki-meta/hot.md` instead of `<vault>/wiki/hot.md`. Marker text (workspace-bound mode) updated accordingly.
- **`hooks/wiki-query-first-nudge.mjs`** — nudge enumerates the 4 entry points as `wiki-meta/hot.md`, `wiki-meta/index.md`, `wiki-meta/log.md`, `wiki-meta/overview.md`. Mode-aware read guidance covers both `wiki-meta/<scaffold>` and `wiki/<page>` so Claude knows the split.
- **`hooks/hot-cache-update-prompt.mjs`** — trigger now scans `wiki/` AND `wiki-meta/` (`git diff` / `git log` against both paths). Refresh nudge text says "update `wiki-meta/hot.md`".
- **`hooks/wiki-autocommit.mjs`** — added `wiki-meta` to `trackedDirs` array. Otherwise scaffold edits (notably the hot.md refresh) would silently fall outside autocommit coverage.
- **`hooks/vault-link-linter.mjs`** — docstring examples updated; runtime logic unchanged (the linter already handles any `.md` inside a vault).
- **`scripts/setup-vault.mjs --link-workspace`** — validation now requires `<vault>/wiki-meta/index.md`. Error message points at `--migrate-wiki-meta` (v0.12.1) for vaults on the legacy layout.
- **`src/index.mjs`** — audit log (`OBSIDIAN_ROUTER_USER_ID`) appends to `<vault>/wiki-meta/log.md` instead of `<vault>/wiki/log.md`.
- **`templates/wiki/{hot,index,log,overview}.md`** physically moved to **`templates/wiki-meta/{...}.md`** (4× `git mv`). Same for `templates/reference-vault-skeleton/wiki/{...}` → `wiki-meta/{...}` — the `wiki/` subdir under the skeleton is removed. `templates/wiki/CLAUDE.md` and `templates/reference-vault-skeleton/CLAUDE.md` stay where they are (vault-root CLAUDE.md, not a scaffold) but their CONTENT was updated to reference `wiki-meta/` for the 4 scaffolds and to explain the split.
- **All `skills/` SKILL.md, `commands/`, `agents/`** mentioning the 4 scaffolds — bulk-swept (`wiki/<scaffold>.md` → `wiki-meta/<scaffold>.md`, 64 replacements across 17 files).
- **Convention snippets** (`skills/conventions/snippets/wiki-query-first.md`, `roadmap-discipline.md`, `auto-enrichment.md`) — same sweep. Note: per-vault installed copies of these snippets need re-install via Session 3 to pick up the new paths.

### Test count: **416/416 passing** (unchanged headcount — refactor + fixture path updates, no new tests this session).

### Migration note for vault owners

If your vault was bootstrapped before v0.12.0, the hooks `hot-cache-load` and `wiki-query-first-nudge` will be silent for that vault until you migrate. Quickest workaround pending the v0.12.1 script:

```bash
cd /path/to/your/vault
mkdir wiki-meta
git mv wiki/hot.md wiki-meta/hot.md
git mv wiki/index.md wiki-meta/index.md
git mv wiki/log.md wiki-meta/log.md
git mv wiki/overview.md wiki-meta/overview.md
# Then edit CLAUDE.md to swap the 4 wiki/<scaffold>.md refs for wiki-meta/<scaffold>.md
```

The automated `setup-vault.mjs --migrate-wiki-meta <vault-path>` ships in v0.12.1 and handles the CLAUDE.md edits too.

## [0.11.6] — 2026-05-23

Closes the v0.11.5 gap Roland surfaced: the new `wiki-query-first-nudge` hook only detected vault context when cwd ITSELF contained `wiki/index.md`, missing the common case where the workspace is a code/dev project ASSOCIATED with a vault (e.g. `I:\DEVELOPPEMENT\obsidian-mcp-router` ↔ vault `opsidian-mcp-router et bridge`). v0.11.6 introduces **workspace-bound mode**: hooks resolve an associated vault via `OBSIDIAN_ROUTER_DEFAULT_VAULT` in the workspace `.env`, and operate against THAT vault's wiki when cwd has none. Also closes the related gap on `hot-cache-load` (now reads associated vault's `wiki/hot.md` with a marker).

### Added

- **`hooks/_helpers/workspace-vault.mjs`** — new shared helper module. Exports `loadWorkspaceDotenv(cwd)`, `readRouterConfig()`, `routerConfigPath()`, `defaultNameFromPath(p)`, `resolveVaultBySlug(cfg, slug)`, `detectVaultContext(cwd, cfg)`. Pure functions where possible; I/O isolated to dotenv autoload + config read. Eliminates 3-way duplication of the same code across hooks. Used by `wiki-query-first-nudge.mjs` and `hot-cache-load.mjs`.
- **`hooks/wiki-query-first-nudge.mjs` — dual-mode detection (v0.11.6)** — refactored to use `detectVaultContext()`. Returns one of `cwd-is-vault` / `workspace-bound` / null. Nudge text now mode-aware: in cwd-is-vault mode, instructs `Read("wiki/<file>")` (filesystem); in workspace-bound, instructs `mcp__obsidian-router__get_file({ vault: "<slug>", path: "wiki/<file>" })` (cwd has no wiki/). Nudge text explicitly enumerates the 4 canonical wiki entry points (hot/index/log/overview) with their purpose.
- **`hooks/hot-cache-load.mjs` — workspace-bound mode (v0.11.6)** — refactored to use `detectVaultContext()`. In cwd-is-vault mode, prints `cwd/wiki/hot.md` (original behavior). In workspace-bound mode, prints the ASSOCIATED vault's `wiki/hot.md`, prefixed with an HTML-comment marker explaining the workspace ≠ vault setup and instructing Claude to use `mcp__obsidian-router__get_file` for further wiki reads (since `Read` on `wiki/X.md` would fail with ENOENT in workspace-bound). Silent exit when neither mode applies or when the resolved vault has `wiki/index.md` but no `wiki/hot.md` yet.
- **`scripts/setup-vault.mjs --link-workspace <workspace-path> <vault-slug>`** — new CLI command to bind a code workspace to a vault. Writes `OBSIDIAN_ROUTER_DEFAULT_VAULT="<slug>"` (auto-quoted when slug contains spaces) into the workspace's `.env`. Validates: workspace path exists + is a directory, vault-slug exists in `portRegistry`, vault has `wiki/index.md`. Preserves other `.env` keys via the same dotenv merge logic used by `lock_vault`. Idempotent.
- **`scripts/setup-vault.mjs --unlink-workspace <workspace-path>`** — symmetric remove. Strips ONLY the `OBSIDIAN_ROUTER_DEFAULT_VAULT=` line, preserves all others. Silent no-op if .env absent or key not set.
- **`tests/hot-cache-load.test.mjs`** (NEW) — 10 tests covering both modes (cwd-is-vault regression + workspace-bound activation, marker presence, stdin cwd field, env var fallback, silent on unresolvable slug, silent when vault has no hot.md yet, cwd-is-vault precedence over .env link).
- **`tests/wiki-query-first-nudge.test.mjs`** extended with 8 new tests (+ workspace-bound suite): nudge mentions 4 entry points, mode label is "cwd-is-vault", workspace-bound activation, MCP get_file instructions in workspace-bound nudge, silent on unresolvable slug, silent without .env or env var, process.env wins over .env file.
- **`tests/install-hooks.test.mjs`** extended with 8 new tests for `--link-workspace` / `--unlink-workspace`: write to fresh .env, quote spacy slugs, preserve other keys, fail on unknown slug / vault without wiki/index.md / non-existent workspace path, remove preserves other lines, no-op without .env.
- **`skills/conventions/snippets/wiki-query-first.md`** — refreshed to document both modes + setup procedure (`--link-workspace`) + 4 entry points.
- **`~/.claude/CLAUDE.md` global "Wiki-query-first reflex (universel)"** — same updates mirrored.

### Total test count: **416/416 passing** (was 391 at v0.11.5).

### Activation for Roland's setup

Run from the router repo for each code workspace that's associated with a vault:
```bash
cd <router-repo>
node scripts/setup-vault.mjs --link-workspace . "opsidian-mcp-router et bridge"
# (already run on I:\DEVELOPPEMENT\obsidian-mcp-router during this session)

# Repeat for other code workspaces (SMILE, PORTFOLIO-NICOLAS, etc.)
```

After restart, hot-cache-load auto-prints the associated vault's hot.md (with marker), and wiki-query-first-nudge fires with mode-aware instructions.

### Trigger

Roland 2026-05-23: *"un workspace peut être effectivement un obsidian vault mais pas seulement. Un workspace peut être le développement d'une application complétement en dehors des repertoires du vault MAIS associé à un vault Obsidian. Tu comprends la nuance ?"* — followed by *"les points d'entrée des vaults associés à un workspace : hot, index, log et overview seront t'ils bien pris en compte ?"*. Both gaps closed in this release.

## [0.11.5] — 2026-05-23

Closes the 3rd category of "Claude forgets a context rule at the moment of application" slip Roland has caught this year (after vault-link-linter v0.11.3 for clickable vault links and doc-propagation-checker v0.11.4 for post-commit doc drift). The new slip: in a vault-bound session, Claude answers user questions without first checking whether the topic has been discussed/documented in the vault wiki — wasting prior research, decisions, and references. Codified following the same 3-layer pattern: installable convention + global CLAUDE.md section + deterministic hook.

### Added

- **`hooks/wiki-query-first-nudge.mjs`** — new `UserPromptSubmit` hook. Fires BEFORE Claude sees the user's prompt. When the workspace is an Obsidian vault (detected by presence of `wiki/index.md`) AND the prompt looks substantive (not trivial follow-up, slash command, single-word ack), injects a reminder into Claude's context via `additionalContext` field (UserPromptSubmit spec). Reminder includes the 4-step pre-answer flow: (1) read `wiki/index.md`, (2) read relevant page directly, (3) `search_smart` for semantic-fit topics, (4) cite notes with click-to-open links. Conservative filtering: skips on length < 20 chars, slash command, regex match against trivial pattern (`oui|non|ok|d'?accord|merci|thanks|yes|no|continue|next|skip|pass|cancel|nevermind|nm`), and obviously empty prompts. 30s timeout respected (hook is ~10ms). Opt-out: `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true`.
- **`skills/conventions/snippets/wiki-query-first.md`** — 7th installable convention (bilingual FR + EN). Detailed procedure, skip-conditions, anti-patterns, audit trail with Roland's DEDIBOX/RDP example. Installable via `/obsidian-router:conventions install wiki-query-first` on any vault.
- **Global `~/.claude/CLAUDE.md` section "Wiki-query-first reflex"** — mirrors the convention as a globally-applied rule so it covers ALL sessions even without per-vault install. Same defense-in-depth pattern as `default-vault-health-check` (v0.10.0) and `roadmap-discipline` (v0.10.1).
- **`tests/wiki-query-first-nudge.test.mjs`** — 15 tests covering: 10 silent cases (non-vault, empty/short/trivial prompt, slash command, opt-out env var, empty/malformed stdin, "OK"/"Continue" single-word) + 5 inject cases (substantive question, imperative, opt-out env var name visible in nudge, `CLAUDE_PROJECT_DIR` fallback, borderline-trivial with question mark > 20 chars).
- **`hooks/hooks.example.json`** — new `UserPromptSubmit` block wired with the new hook.
- **`skills/conventions/SKILL.md`** — convention mapping table extended 6 → 7 rows.

### Activation

Already done in this session's continuation: the hook is wired in Roland's `~/.claude/settings.json` `UserPromptSubmit` block. The convention is installed on all 10 configured vaults. The global CLAUDE.md section is in place. Fires from the next Claude Code restart onward.

### Total test count: **391/391 passing** (was 376 at v0.11.4).

### Trigger

Roland 2026-05-23 observed in a DEDIBOX-vault session: he asked *"je veux créer une connexion RDP depuis mon PC maison vers mon PC cabinet via WireGuard"*. That session read `roadmap_dedibox.md` but missed `wiki/Refs/dedibox-rdp-pc-cabinet.md` which contained the exact procedure. He had to point manually: *"tu es allé consulter ceci `wiki/Refs/dedibox-rdp-pc-cabinet`?"*. The wiki-query-first reflex would have caught it — a `search_smart` on "RDP cabinet WireGuard" would have surfaced the note immediately. Pattern recognized: 3rd "context rule recall" slip this year, all 3 now codified with the same defense-in-depth approach.

### Future enhancement (Couche 3 — multi-session)

The `meta-config` skill (Phase 4.1) will let the user toggle these per-prompt hooks on/off without env vars or JSON editing. Tracked in [[router-ux-improvements-roadmap]].

## [0.11.4] — 2026-05-23

Closes the "router-as-assistant" UX gap: hooks shipped on disk but stayed dormant because activating them required hand-editing `~/.claude/settings.json`. v0.11.4 ships a `--install-hooks` CLI family + `meta-setup` interactive prompt + new-hooks tips in the daily update check, so the user can opt in (or extend their selection) without ever touching JSON. Roland: *"il faut guider l'utilisateur pour qu'il active tout cela : mise à jour de la doc, git réguliers, liens valides vers les notes... Je veux que obsidian-router devienne un vrai assistant"* — this release closes Couche 1 + Couche 2 of that vision.

### Added

- **`hooks/doc-propagation-checker.mjs`** — `PostToolUse` hook on `Bash`. After every `git commit` (matched via `/(?:^|[\s;&|])git\s+commit\b/` to catch compound shell commands and amend variants), checks that the repo's documentation surface is aligned with `package.json` version. Emits a prompt-style stdout nudge (NOT a block — exit 0 always) when drift is detected, listing concrete actions. Checks: (1) `CHANGELOG.md` has a `## [X.Y.Z]` section for the current version; (2) `ROADMAP.md` has a `## ✅ vX.Y.Z` section; (3) `CHANGELOG.md` `[Unreleased]` doesn't have substantive content when the current version section already exists (suggests forgotten promotion); (4) vault wiki `router-changelog.md` mentions the current version (multi-tier check: iterates `portRegistry`, finds first vault containing the project wiki, scans). Recognizes the project's "Nothing pending right now." placeholder so it doesn't false-positive on empty `[Unreleased]`. Built in response to recurring slip pattern: Claude ships a feat commit, bumps `package.json`, but forgets to propagate to CHANGELOG/ROADMAP/vault wiki — caught manually 2× before being codified. Same spirit as `vault-link-linter`: deterministic check OUTSIDE the LLM attention loop. Opt-out: `OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true`. 14 tests in `tests/doc-propagation-checker.test.mjs` (6 silent / 8 nudge).
- **`scripts/setup-vault.mjs --install-hooks`** — merges `hooks/hooks.example.json` into `~/.claude/settings.json`. Idempotent (re-run safe — detection by hook script basename). Preserves user-defined non-router hooks. Auto-detects this router's absolute path via `import.meta.url` and uses forward slashes in JSON for Windows compatibility (escape-free). Replaces the `<router-repo>` placeholder transparently. Layout: appends new matcher blocks alongside existing ones rather than merging into them — Claude Code unions all blocks under the same event name at runtime, so this is functionally equivalent and avoids regex-matching matcher strings.
- **`scripts/setup-vault.mjs --install-hooks --select <a,b,c>`** — partial install. Comma-separated hook basenames, with or without `.mjs` extension. Skips hooks not in the list AND hooks already installed (still idempotent).
- **`scripts/setup-vault.mjs --uninstall-hooks`** — removes ALL router hooks from `~/.claude/settings.json` (detected by path containing `obsidian-mcp-router/hooks/`). Preserves user-defined hooks. Cleans up empty matcher blocks + empty event arrays + empty `hooks` object so the file stays tidy.
- **`scripts/setup-vault.mjs --hooks-status`** — diagnostic. Lists every hook in `hooks/hooks.example.json` with `✓ active` or `○ inactive` based on `~/.claude/settings.json` presence. Reports the settings file path + the resolved router repo path for transparency.
- **`hooks/check-router-update.mjs` v0.11.4 extension** — on top of the once-per-day version-update notice, the hook now snapshots the local `hooks/` listing in `~/.claude/obsidian-mcp-router/.last-version-check.json`. On the next run, diffs the current local listing vs the snapshot. If new hooks appeared (= the user updated and got new hooks) AND those hooks aren't already wired in `~/.claude/settings.json`, appends a 💡 tip to the notice listing them + the one-line `--install-hooks --select <names>` command to activate. Tip is Claude-CLI-style and gets relayed by Claude on the first response. Snapshot is computed offline (no GitHub dep), so the tip fires even when offline. Same opt-out: `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` silences both the version notice and the tip.
- **`skills/meta-setup/SKILL.md` — "Install router hooks (recommended)" section** — interactive prompt at the end of meta-setup proposing `--install-hooks` with 3 modes (All / Pick / Skip). Documents the 6 hooks + their per-hook opt-out env vars. Mentions `--hooks-status` for verification.
- **`tests/install-hooks.test.mjs`** — 14 integration tests covering the full `--install-hooks` / `--uninstall-hooks` / `--hooks-status` matrix: fresh install, merge into existing, idempotency, --select partial + with/without .mjs, --select fails on missing value, forward-slash paths in JSON, placeholder replacement, uninstall preserves user-defined, uninstall cleans up empty objects, status reports correctly on empty/full/partial.
- **`tests/check-router-update-tips.test.mjs`** — 7 integration tests for the snapshot/tip logic: first run (no tip, snapshot stored), no diff (silent), diff detected (tip), already-wired (no tip), multiple new hooks (correct slug list), snapshot updated after run, opt-out env var silences.

Total test count: **376/376 passing** (was 355).

### Fixed (this release)

- Nothing — pure feature add.

### Activation path for existing v0.11.3 users

The hooks didn't auto-activate before because `~/.claude/settings.json` is user-controlled. After updating to v0.11.4:

1. Run `node <router-repo>/scripts/setup-vault.mjs --install-hooks` once. Idempotent — safe to re-run.
2. Restart Claude Code so it picks up the new hooks.
3. The next session-start `check-router-update` hook will start snapshotting your local `hooks/` listing. Any future router update that adds hooks will surface a 💡 tip on the next 24h check.

Future enhancement (Couche 3 — multi-session): a `meta-config` skill or slash command to toggle individual hooks on/off without touching JSON or env vars, plus proactive usage tips ("your wiki has 80 unfolded entries, consider `/wiki-fold`"). Tracked in [[router-ux-improvements-roadmap]].

## [0.11.3] — 2026-05-23

Closes a recurring slip: the "Obsidian vault links" convention from `~/.claude/CLAUDE.md` that, after every `git commit` (matched via `/(?:^|[\s;&|])git\s+commit\b/` to catch compound shell commands and amend variants), checks that the repo's documentation surface is aligned with `package.json` version. Emits a prompt-style stdout nudge (NOT a block — exit 0 always) when drift is detected, listing concrete actions. Checks: (1) `CHANGELOG.md` has a `## [X.Y.Z]` section for the current version; (2) `ROADMAP.md` has a `## ✅ vX.Y.Z` section; (3) `CHANGELOG.md` `[Unreleased]` doesn't have substantive content when the current version section already exists (suggests forgotten promotion); (4) vault wiki `router-changelog.md` mentions the current version (multi-tier check: iterates `portRegistry`, finds first vault containing the project wiki, scans). Recognizes the project's "Nothing pending right now." placeholder so it doesn't false-positive on empty `[Unreleased]`. Built in response to recurring slip pattern: Claude ships a feat commit, bumps `package.json`, but forgets to propagate to CHANGELOG/ROADMAP/vault wiki — caught manually 2× in this session. Same spirit as `vault-link-linter` (v0.11.3): deterministic check OUTSIDE the LLM attention loop. Opt-out: `OBSIDIAN_ROUTER_NO_DOC_PROPAGATION_CHECK=true`. Wire-up: added to `PostToolUse` block in `hooks/hooks.example.json` matching `Bash`.
- **`tests/doc-propagation-checker.test.mjs`** — 14 tests (6 silent / 8 nudge). Silent: non-Bash tool, non-git-commit command, aligned CHANGELOG+ROADMAP, opt-out env var, no package.json, malformed stdin. Nudge: missing CHANGELOG version section, missing ROADMAP version section, stale Unreleased when version section exists, no double-nudge when version section is missing (user mid-flow), vault wiki check, opt-out env var discoverable in stderr, compound shell commands (`git add . && git commit ...`), git commit variants (`--amend`, `-a`, `-am`). Total test count: **355/355 passing** (was 341).

## [0.11.3] — 2026-05-23

Closes a recurring slip: the "Obsidian vault links" convention from `~/.claude/CLAUDE.md` (vault file mentions must use markdown links pointing to the bridge plugin's `/open/<path>` endpoint, not bare relative paths) — although loaded into Claude's context every session, sometimes isn't triggered at recap time (cognitive bottleneck during multi-step turns). This release ships a `Stop` hook that enforces the convention deterministically OUTSIDE the LLM attention loop, same spirit as `wiki-autocommit` and `check-router-update`.

### Added

- **`hooks/vault-link-linter.mjs`** — new `Stop` hook that enforces the "Obsidian vault links" convention from `~/.claude/CLAUDE.md` (click-to-open markdown links pointing at the `obsidian-mcp-router-bridge` plugin's `/open/<path>` endpoint, instead of bare relative paths that aren't clickable in Claude Code). The hook reads the transcript, finds `[label](href.md)` links where `href` has no scheme and is relative, verifies each candidate against `portRegistry` vault paths on disk (filesystem check = false-positive avoidance), and if any verified-as-vault-file mentions remain, exits 2 with a bilingual stderr listing each violation + the corrected form (auto-derives the right `insecurePort` from each owning vault's `obsidian-local-rest-api/data.json`, with HTTPS fallback caveat when `enableInsecureServer: false`). Claude Code re-runs the turn so the user only sees the corrected response. Strips fenced code blocks and inline code before scanning to avoid flagging examples. Recursion guard via `stop_hook_active`. Opt-out via `OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true` (truthy: `true`/`1`/`yes`/`on`). Wire-up: added to `Stop` block in `hooks/hooks.example.json` alongside `hot-cache-update-prompt.mjs` (both run on every Stop event). Built after recurring observation that the convention — though loaded into Claude's context via the global CLAUDE.md — sometimes doesn't trigger at the moment of application (LLM attention bottleneck during multi-step recap turns); the hook is a deterministic check outside the LLM attention loop, same spirit as `wiki-autocommit` and `check-router-update`.
- **`tests/vault-link-linter.test.mjs`** — 33 tests covering: 13 pass cases (no links, http/https/obsidian scheme already correct, code-block stripping incl. 4-space-indented, path not in any vault, path-traversal escape attempts, recursion guard, opt-out env var, missing config, absolute paths) + 16 block cases (bare-path link, multiple violations, percent-encoded href, FR+EN preamble, opt-out env var name in stderr, code-block stripping respected, HTTPS fallback when insecureServer disabled, REGRESSION tests for: filename with literal `%`, multi-vault `defaultVault` preference, `disabledVaults` filtering, `OBSIDIAN_ROUTER_ALLOWED_VAULTS` whitelist, `OBSIDIAN_ROUTER_DEFAULT_VAULT` env override, `VAULT_PATH` env path-based default, workspace `.env` autoload, `OBSIDIAN_ROUTER_LOCKED` lock-mode isolation) + 4 robustness tests (empty stdin, non-JSON stdin, missing transcript_path, no assistant messages). Total test count: **341/341 passing** (was 308).

#### Multi-tenant correctness (vault-link-linter)

The linter honors the same active-vault filtering and default-resolution cascade as the router itself, so it never lints against vaults the router would refuse to expose:

- **Workspace `.env` autoload** — the hook runs as a separate Node subprocess invoked by Claude Code, so it does NOT inherit the workspace `.env` the router binary loads itself. The hook now loads `$CLAUDE_PROJECT_DIR/.env` (or `cwd()/.env`) at startup with standard dotenv semantics (file values fill only UNSET keys; `process.env` always wins). Without this, the multi-vault cascade below would always fall back to tier 3 in vault-bootstrapped workspaces (where `VAULT_PATH` lives only in `.env`).
- **`cfg.disabledVaults`** entries (accepted as slug NAME or absolute PATH per v0.5.0+ convention) are excluded from linting.
- **`OBSIDIAN_ROUTER_ALLOWED_VAULTS=a,b,c`** env var (v0.9.0+ multi-tenant whitelist) restricts linting to the listed slugs.
- **`OBSIDIAN_ROUTER_LOCKED=<slug>`** (v0.8.0+ single-vault isolation) restricts linting to ONLY the locked vault. If the locked slug doesn't match any active vault, the linter skips entirely (the router would refuse to resolve too — no safe suggestion to make).
- **Default-vault resolution** for the URL-suggestion bias follows the router's per-process cascade: (1) `OBSIDIAN_ROUTER_DEFAULT_VAULT` env (slug) — explicit per-process override; (2) `VAULT_PATH` env (absolute path) — auto-detected by `setup-vault.mjs` in each bootstrapped vault's `.env`; (3) `cfg.defaultVault` (slug) — global fallback.

## [0.11.2] — 2026-05-23

Adds `/obsidian-router:meta-sync-template` (template propagation skill) and closes two real safety bugs in `setup-vault.mjs` discovered while building the skill — one data-loss path (case-sensitive reference self-skip on Windows NTFS) and one credential-leak path (first-time copy of `obsidian-local-rest-api` cloned the reference's `data.json` into targets).

### Added

- **`/obsidian-router:meta-sync-template`** + companion **`skills/meta-sync-template/SKILL.md`** — interactive slash command that propagates the reference (`.template`) vault's plugins, snippets, and root docs to one or more configured vaults. Lists every vault in `portRegistry` with online status (via the router's `list_vaults`), flags vaults missing `obsidian-local-rest-api` upfront with `⚠️ needs bootstrap`, lets the user pick **all**, a **subset** (comma-separated numbers/names/abs-paths), or **cancel**, then asks whether to pass `--force`. Uses `npm run setup-vault -- --sync-all` for the all-vaults case (the script handles iteration + reference skip + credential-leak protection internally) and loops `setup-vault.mjs "<path>" --sync-plugins` for subsets. Propagates `OBSIDIAN_ROUTER_CONFIG` to spawned subprocesses when the active config is non-default. Brings total commands shipped by the plugin from 30 → 31 (4 meta helpers now: `meta-setup` / `meta-add-vault` / `meta-status` / `meta-sync-template`).
- **`scripts/path-helpers.mjs`** — pure module exporting `samePath()` and `canonicalPath()`. Backed by `fs.realpathSync.native()` (resolves on-disk casing on Windows NTFS, follows symlinks on POSIX) with a per-platform fallback for non-existent paths (`win32` and `darwin` lowercase, `linux` exact). Used by every same-path compare in `setup-vault.mjs` so case-different registry entries can't sneak past safety checks.

### Fixed

- **`scripts/setup-vault.mjs:1056` — `--sync-all` case-sensitive self-skip (data-loss)**: the previous check `path.resolve(a) === path.resolve(b)` treated `C:\VAULTS\.template` and `c:\vaults\.template` as unequal even though Windows NTFS resolves them to the same physical directory. A reference vault registered with mismatched casing in `portRegistry` would slip past the skip and, with `--force`, the per-vault sync would `rm -rf` the source's own plugin folder before re-copying from the now-empty source. Replaced with `samePath()` (regression test in `tests/setup-vault-safety.test.mjs`).
- **`scripts/setup-vault.mjs:syncPluginsMode` — top-level reference guard**: explicit `samePath(abs, cfg.referenceVault)` at the entry of `syncPluginsMode()`. A direct invocation `node scripts/setup-vault.mjs "<reference>" --sync-plugins --force` is now refused with a clear error message instead of silently destroying the template's plugins. Belt-and-suspenders with the `--sync-all` self-skip fix above.
- **`scripts/setup-vault.mjs:syncPluginsMode` — credential-leak avoidance**: `syncPluginsMode()` now refuses to copy any plugin listed in `CREDENTIAL_LEAK_PLUGINS` (currently `obsidian-local-rest-api`) into a target that lacks its own `data.json`. This covers BOTH cases: the obvious first-time copy (plugin folder absent), and the subtler `--force` refresh case (plugin folder present but `data.json` never written because the plugin was installed but never activated — see codex P1 in the review trail). Without these guards, the wholesale copy would clone the reference's `data.json` (port + API key) into the target — every target would share the same key, and the bound port would conflict on bind. Refused plugins are surfaced via a `warn()` in normal mode and a `[obsidian-mcp-router] WARNING:` line in `--quiet` mode (yes, even `--quiet` — credential-leak avoidance must not be silenced for hooks). Existing-plugin re-clones with `--force` AND existing `data.json` are unaffected — the preservation branch already protected that path.
- **`scripts/setup-vault.mjs:syncPluginsMode` — `throwOnError` opt-in for bulk callers**: when called from `--sync-all` with `opts.throwOnError: true`, error paths that previously called `fail()` (which does `process.exit(1)`) now throw instead, so a single failing vault no longer tears down the whole `--sync-all` loop. Direct CLI invocation keeps the legacy exit behavior (non-zero exit on failure). Closes the latent risk flagged by Reviewer A I1 in the review trail.
- **`scripts/setup-vault.mjs` — honors `OBSIDIAN_ROUTER_CONFIG`**: previously hard-coded `$HOME/.claude/obsidian-mcp-router/config.json`. Now reads `OBSIDIAN_ROUTER_CONFIG` first, consistent with the router binary's `--config` flag. Defaults unchanged when the env var is unset.
- **`scripts/setup-vault.mjs:writeMcpJson` — embeds `--config <path>` for non-default configs**: when the bootstrap is running against a custom config (env var or CLI flag), the generated `.mcp.json` now passes `--config <path>` to the router so MCP clients (Claude Code, Claude Desktop) launch the router against the same config the user bootstrapped against. Previously the spawned router would silently fall back to the default config and report the freshly-registered vault as missing.

### Tests

- **`tests/setup-vault-safety.test.mjs`** — 16 new tests (7 unit tests for `samePath()` + 9 integration tests spawning `setup-vault.mjs` with temp fixtures via `OBSIDIAN_ROUTER_CONFIG`). Coverage: case-insensitive same-path matches, non-existent path handling, refusal to target reference (same and mis-cased), credentialed-plugin skip on first-time AND on `--force` with missing target `data.json` (codex P1 regression), `data.json` preservation across normal `--force` re-clone, `--quiet` warning visibility, `--sync-all` self-skip on same-casing AND mis-cased reference entries, `--sync-all` loop survives a single failing vault (Reviewer A I1 regression). Total test count: **308/308 passing** (was 271).

## [0.10.3] — 2026-05-22

Closes the "I didn't know there was an update" gap. Ships a SessionStart hook that, at most once per 24 hours, checks GitHub for a newer router version and emits a notice as session context — Claude relays it on the first response, so the user finds out without having to remember to check. Combined with a dedicated [`docs/how-to-update.md`](./docs/how-to-update.md) bilingual guide covering both `/plugin update` and the 5-step manual filesystem path (for environments where `/plugin` is unavailable).

### Added

- **`hooks/check-router-update.mjs`** — SessionStart hook (110 lines, vanilla Node `https` — no new deps). Reads installed version from the plugin's own `package.json`, fetches `https://raw.githubusercontent.com/tboome33/obsidian-mcp-router/main/package.json`, compares with [`semver-compare`](./src/helpers/semver-compare.mjs), emits a markdown notice to stdout when GitHub is ahead. Cached in `~/.claude/obsidian-mcp-router/.last-version-check.json` with a 24h TTL — within the throttle window the cached notice is replayed (so the user keeps seeing it across sessions without spamming GitHub). **Fails silently** on any error (network, parse, cache I/O) — never disturbs the user. **3-second timeout** on the HTTPS request so offline sessions get at most a 3s session-start delay.
- **`src/helpers/semver-compare.mjs`** — tiny semver parser + comparator (`parseSemver(v)`, `compareSemver(a, b)`). Narrow on purpose: handles `X.Y.Z` and `X.Y.Z-prerelease`, returns 0 on unparseable input (safe fallback — caller treats "can't compare" as "up to date" rather than surfacing a fake update notice). Includes the `0.10 > 0.9` numeric-not-lexicographic rule and the `1.0.0-alpha < 1.0.0` prerelease-is-older convention.
- **`tests/semver-compare.test.mjs`** — 17 new tests covering parse (basic, `v` prefix, prerelease, whitespace, double-digit segments, unparseable, non-string), compare (equal, major/minor/patch dominance, the v0.10-vs-v0.9 trap, prerelease ordering, unparseable fallback). Total test count: **271/271** passing (was 254).
- **`docs/how-to-update.md`** — bilingual EN+FR update guide. Covers: (1) the three discovery paths (built-in hook, GitHub Watch on Releases, periodic blind check), (2) the two application paths (`/plugin update` slash command for environments that have it, 5-step manual filesystem recipe for those that don't — both bash and PowerShell variants), (3) why updates aren't fully auto-applied (Claude Code design choice: plugin authors don't control auto-install — security tradeoff), (4) troubleshooting (notice persists, skipping a release, dev install ahead of main, offline behavior). Linked from README EN+FR under a new "Staying up to date" / "Rester à jour" subsection.
- **`hooks/hooks.example.json`** — the `SessionStart` block now wires up both `hot-cache-load.mjs` AND `check-router-update.mjs`. Fresh installs via the `meta-setup` skill pick up both. Existing setups that hand-rolled their hooks file need to add the second entry (documented in `docs/how-to-update.md`).
- **README sections** — new "Staying up to date" (EN, line ~277) and "Rester à jour" (FR, line ~939) subsections under Install, between `meta-setup` walkthrough and `CLI flags`. Briefly explain the hook, point at `docs/how-to-update.md` for the manual recipe, document the opt-out env vars.

### Opt-out

Either of these env vars skips the check entirely:

- `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` (truthy: `true` / `1` / `yes` / `on`)
- `OBSIDIAN_ROUTER_USER_ID=<slug>` (the multi-tenant audit-log var from v0.9.0 — its presence indicates a multi-tenant deployment where the sysadmin manages updates centrally; the per-user notice would be noise)

### Why

User-facing problem: a user installs the router on day 1 (say v0.8.6), the router gains 4 versions worth of features and fixes over 8 days, and the user has **no way to know** unless they actively go check the repo. There's no badge, no notif, no command that says "you're behind". This is a real UX gap — Claude Code's plugin system currently relies on the user manually running `/plugin update <name>` as a periodic blind check.

Three options for the plugin author to address this:
1. **Hook that notifies** — what v0.10.3 ships. Minimal effort, opt-out, fails silent.
2. **Custom MCP tool** — Claude could invoke `check_router_update` itself. Overkill for what's essentially a static comparison.
3. **README mention only** — pushes the responsibility entirely onto the user. Not enough on its own.

This release goes with (1) + the README mention as a fallback for users who landed via GitHub before installing.

### Privacy

The check is a single anonymous HTTPS GET to `raw.githubusercontent.com/tboome33/obsidian-mcp-router/main/package.json` with the User-Agent `obsidian-mcp-router/check-router-update`. No payload sent. No telemetry. No collection. The cache file (`~/.claude/obsidian-mcp-router/.last-version-check.json`) is local-only — it stores `{ checkedAt: <ms>, notice: <string|null>, installedAtCheck: <version> }`. The hook source is 110 lines of vanilla Node, auditable in [`hooks/check-router-update.mjs`](./hooks/check-router-update.mjs).

### Tests

- 271/271 passing — 254 from v0.10.2 + 17 new `semver-compare.test.mjs` cases.
- `package.json` `test` script extended with `tests/semver-compare.test.mjs`.

### Backward compatible

- The hook is opt-out, not opt-in by default — but a user that doesn't update `hooks.example.json` after v0.10.3 won't get the check (because their personal `hooks.json` still only references `hot-cache-load.mjs`). To activate retroactively on an existing setup, copy the second entry from the shipped `hooks.example.json` into your `~/.claude/settings.json` (or the project-scope equivalent).
- No tool surface change, no MCP-protocol change.
- The `semver-compare` helper is a new module; nothing else in the runtime imports it yet (only the hook does).

## [0.10.2] — 2026-05-22

Discovery hygiene fix for the Claude Code skills panel + marketplace/plugin version sync. The Claude Code "Compétences" UI iterates over both `skills/` and `commands/`, but only items with a real `skills/<name>/SKILL.md` render cleanly — command-only items produce a misleading `Plugin not found: obsidian-router@obsidian-mcp-router-marketplace` error. **All 17 previously command-only entries are now promoted to proper skills**, so every entry the panel surfaces has a backing SKILL.md and the error disappears entirely.

### Added — 17 new skills (1 SKILL.md per previously command-only entry)

**Router-state (3)**:
- **`skills/auto-mode/SKILL.md`** — mode-decision rules (when to pick `ClaudeAsk` / `Hybrid` / `FullAuto` / `off`), bilingual NL phrase → mode mapping, disambiguation of *"stop asking me"* (could mean `off` OR `FullAuto` OR `Hybrid`), homedir refusal caveat, persist defaults inference from *"de manière permanente"*.
- **`skills/lock/SKILL.md`** — single-vault isolation, EN+FR triggers, push-back when already locked to a different vault, homedir refusal caveat.
- **`skills/unlock/SKILL.md`** — lift the lock, EN+FR triggers, gentle no-op surfacing when not locked, info-level reporting when `persist=true` but `.env` had nothing to remove.

**Discovery (2)**:
- **`skills/discover-list-files/SKILL.md`** — list files in a vault directory, vault-prefix path parsing, >50-entry summarization.
- **`skills/discover-list-vaults/SKILL.md`** — list configured vaults (active + disabled), render adaptation based on whether the user asked about active / disabled / both, status-line + table format.

**Read (4)**:
- **`skills/read-get/SKILL.md`** — fetch a file (markdown + frontmatter), `<vault>/<path>` shorthand, frontmatter-as-YAML rendering, large-file truncation policy.
- **`skills/read-frontmatter/SKILL.md`** — read frontmatter (whole object or single key), type-preserving render (number/boolean/array/null/object distinctions kept).
- **`skills/read-search/SKILL.md`** — plain-text substring search, cross-vault fan-out via `vault=*`, suggestion to fall back to `read-search-smart` for semantic queries.
- **`skills/read-search-smart/SKILL.md`** — Smart Connections semantic search, pre-req check (bridge + smart-connections plugins must be installed and indexed), 503-handling.

**Write (5)**:
- **`skills/write-append/SKILL.md`** — append to file, auto-create unless `requireExisting=true`, use-case guidance (journals vs surgical edits → `write-patch`).
- **`skills/write-create-or-replace/SKILL.md`** — create or full-replace, overwrite-confirm safety prompt (preview top 10 lines before clobbering unless user said "overwrite" / "remplace").
- **`skills/write-patch/SKILL.md`** — surgical heading/block/frontmatter edit, FULL heading path footgun (must be `Section::Sub`, not just `Sub`), idempotency flag, common quick patterns.
- **`skills/write-frontmatter-set/SKILL.md`** — single-key set, type inference from $ARGUMENTS (numeric / boolean / null / array / object), `--no-create` flag.
- **`skills/write-frontmatter-merge/SKILL.md`** — multi-key set, non-atomicity warning (partial failures reported per-key), alternative for true atomicity (read + modify + `write-create-or-replace`).

**Manage (2)**:
- **`skills/manage-delete/SKILL.md`** — two-step confirm guard against hallucinated deletes (first call previews + refuses, second call with `confirm=true` actually deletes).
- **`skills/manage-move/SKILL.md`** — move/rename via GET → PUT → DELETE fallback (no native REST endpoint), partial-failure mode reporting (`sourceDeleted: false` + warning).

**Template (1)**:
- **`skills/template-execute/SKILL.md`** — Templater dispatch with the `tp.mcpTools` vs `tp.user.mcpTools` footgun explained with WRONG/RIGHT examples, 503-when-Templater-missing handling.

### Changed

- **All 17 corresponding `commands/<name>.md` files** slimmed to short dispatchers pointing to their skill (same pattern as `commands/autoresearch.md` / `commands/save.md`). The skill is now the source of truth for the rich content; the command file is just the slash-command entry point with a 2-3 line dispatch hint.
- **`.claude-plugin/marketplace.json`** marketplace `metadata.version` and plugin `version` bumped 0.8.6 → 0.10.2. Out of sync with `package.json` since v0.8.6 shipped on 2026-05-14 — the marketplace/plugin manifests now track the package version so `/plugin update` users don't stay on a stale cache.
- **`.claude-plugin/plugin.json`** `version` bumped 0.8.6 → 0.10.2 for the same reason.

### Why

Roland surfaced the bug via screenshot of the Claude Code skills panel: the bottom half of the list showed entries (`auto-mode`, `discover-list-files`, `lock`, `manage-delete`, etc.) with a "Plugin not found" error in the right pane. Root cause investigation showed the plugin is correctly installed at v0.8.6 — the error is the UI's wording for "no `SKILL.md` file found for this entry in the plugin's `skills/` folder". An initial scoped fix only promoted the 4 most NL-trigger-heavy commands, but on Roland's *"je ne veux aucune erreur d'affichage, débrouille toi"* the scope expanded to **all 17** previously command-only entries. Now every entry the panel iterates over has a backing SKILL.md → zero "Plugin not found" errors.

### Backward compatible

- All 17 slash commands (`/obsidian-router:auto-mode`, `/obsidian-router:discover-list-files`, `/obsidian-router:write-patch`, etc.) still work identically — each command file delegates to the matching skill which holds the prior rich content.
- The NL triggers (EN + FR) are preserved verbatim in every skill description, so phrasings like *"passe en mode Hybrid"* / *"liste les fichiers du dossier Sessions"* / *"trouve mes notes sur la taille de position"* / *"supprime Sessions/old-test.md"* continue to fire as before.
- No MCP tool changed. This is a pure plugin-content reorganization (skills/ and commands/).

## [0.10.1] — 2026-05-21

Extends the `roadmap-discipline` convention with a new **section 2bis** that forbids `~~strikethrough~~` on completed roadmap items, AND ships a matching Obsidian CSS snippet that kills the *default* Obsidian rendering style which paints `- [x]` items with line-through styling — defeating the whole convention visually. Both pieces shipped together: the markdown-level rule + the rendering-level fix.

### Added

#### Convention (markdown-level)

- **Section 2bis "Lisibilité — JAMAIS de strikethrough sur les items livrés"** in `skills/conventions/snippets/roadmap-discipline.md` — explicit no-strikethrough rule, retroactive cleanup directive (mention + ask before stripping `~~...~~` from existing roadmaps), and rationale (`- [x]` is the universal markdown convention; strikethrough is decorative noise on top of an already-signaled-as-complete item).
- **Anti-pattern entry** in the same snippet listing strikethrough on shipped items as a forbidden formatting move.
- **Source-trail line** updated to record the v0.10.1 addition with Roland's verbatim trigger phrase.

#### CSS snippet (rendering-level)

- **New file** `templates/reference-vault-skeleton/.obsidian/snippets/no-task-strikethrough.css` — disables `text-decoration: line-through` on `- [x]` items across all 3 Obsidian render modes (Reading view, Live Preview, Source). Covers default + Minimal + Prism + AnuPpuccin theme conventions via `.task-list-item.is-checked`, `.HyperMD-task-line-checked`, and the `--checklist-done-decoration` CSS variable used by theme authors.
- **New file** `templates/reference-vault-skeleton/.obsidian/appearance.json` — pre-enables the snippet via `"enabledCssSnippets": ["no-task-strikethrough"]` on every freshly-bootstrapped reference vault.
- **`cloneSnippets()` + `enableSnippetsInAppearance()`** functions added to `scripts/setup-vault.mjs`. Every `setup-vault.mjs <path>` and `setup-vault.mjs <path> --sync-plugins` invocation now copies `<referenceVault>/.obsidian/snippets/*.css` into the target vault and merges each basename into `<target>/.obsidian/appearance.json` `enabledCssSnippets`. Idempotent: existing snippets are skipped unless `--force`, and an already-enabled basename is not duplicated. Even when the `.css` file is skipped (already present), the `appearance.json` patch still runs — so a vault with the file on disk but not enabled gets fixed automatically on next sync.
- **New CLI option `--sync-all`** in `scripts/setup-vault.mjs` — iterates `portRegistry` and runs `--sync-plugins` on every configured vault in one go (skipping the reference vault itself and any path that's gone missing). Adds `--force` for re-cloning plugins + snippets when the reference vault's content has been updated. Useful for bulk operations like "push a new snippet to every vault" or "refresh every vault to the latest reference plugin versions".

#### HTTP server convention (click-to-open links)

- **`patchRestApiData()` in `scripts/setup-vault.mjs` now applies the `insecurePort = port + 10` + `enableInsecureServer = true` convention** documented in the user's global `CLAUDE.md` (section "Obsidian vault links — v2 click-to-open"). Every freshly-bootstrapped vault gets a working HTTP server on loopback for the bridge's GET `/open/<path>` click-to-open route, so markdown links like `[note](http://127.0.0.1:<port+10>/open/<path>)` open the file in Obsidian on a single click. Each vault gets a unique HTTP port (HTTPS port + 10) so multiple vaults can have HTTP enabled simultaneously without socket collision on the plugin's default `27123`.
- **Why this lives in the script and not the skeleton**: the Local REST API plugin generates its own `data.json` at first launch (with insecure server disabled by default), so the skeleton can't ship the desired config — only `patchRestApiData()`, which runs AFTER the user has launched Obsidian once, can enforce the convention. Pre-v0.10.1 the script set `apiKey` / `port` / `bindingHost` but left `insecurePort` and `enableInsecureServer` at the plugin defaults, leaving every bootstrapped vault unable to serve click-to-open links — silent footgun, only surfaced when Roland tried a generated link and nothing happened.
- **Why HTTP and not HTTPS**: Bitdefender, ESET, Kaspersky (and other AV/EDR products doing HTTPS inspection) silently drop self-signed loopback TLS connections — the request never reaches the plugin, and the browser shows no cert-warning prompt. Plain HTTP on `127.0.0.1` sidesteps the inspection layer entirely. Safe because the `/open/*` route is navigation-only (it calls `workspace.openLinkText`, no read/write/exec); the routes that DO read/write/search files still require the apiKey on the HTTPS port.
- **Retroactive fix for vaults bootstrapped before v0.10.1**: run `setup-vault.mjs <path> --regenerate` (which forces a fresh `patchRestApiData()` call) on each vault, then reload Obsidian on that vault for the plugin to pick up the new config. The `--regenerate` flag also rotates the apiKey — if you want to preserve the existing apiKey, edit `data.json` by hand and set `"insecurePort": <port>+10, "enableInsecureServer": true`.

### Why

Two-layer fix because two layers of the system were producing the same bad visual:
1. **Markdown convention layer** — past sessions wrote `- [x] ~~feature livrée~~` thinking strikethrough emphasised "done". §2bis bans this.
2. **Obsidian default rendering layer** — even with clean markdown (`- [x] feature livrée` without `~~...~~`), the default Obsidian stylesheet applies `text-decoration: line-through` to checked task items. Visually identical to layer 1's anti-pattern. The CSS snippet kills that automatic styling so what the user types is what the user reads.

Roadmaps are re-read constantly during a project's lifecycle to understand "what got done, when, with what commit". Strikethrough hides keywords, breaks grep/Ctrl+F at the human level, and makes long completed-phase blocks visually painful. The checked box `- [x]` already carries 100% of the "done" semantics — no decorative overlay needed, whether the strike comes from the markdown source or from the renderer.

### Backward compatible

- **Convention** is a pure documentation extension. Vaults that already installed `roadmap-discipline` before v0.10.1 keep working — they get the older 5-step rule. To pull in section 2bis, run `/obsidian-router:conventions install roadmap-discipline` again on the target vault: the H2-presence check will detect "already installed" and skip… so prefer `remove` then `install` (the safety-guarded path), or hand-edit the existing CLAUDE.md to append section 2bis directly.
- **CSS snippet** is opt-out per vault — a user can disable it in `Settings → Appearance → CSS snippets` if they prefer the Obsidian default rendering. Existing vaults bootstrapped before v0.10.1 don't automatically receive the snippet at upgrade time: run `setup-vault.mjs <path> --sync-plugins` (or `--force`) to pull it in retroactively, or copy the file by hand from the skeleton.
- The global `~/.claude/CLAUDE.md` has already been updated with the same section 2bis at the time of the v0.10.1 release.

## [0.10.0] — 2026-05-21

Adds a top-level `defaultVaultStatus` field to the `list_vaults` response, and a matching installable convention (`default-vault-health-check`) that tells Claude to surface a natural-language warning with a clickable `obsidian://open?vault=<name>` link when the default vault is offline at session start. Triggered by Roland's observation that an Obsidian app closed at the start of a session produced cryptic `ECONNREFUSED` errors on the first write tool call, with no actionable hint that "open Obsidian" was the fix.

### Added

- **`defaultVaultStatus` field in `list_vaults`** (`src/tools/list-vaults.mjs`) — top-level summary of the default vault's reachability:
  ```js
  {
    name: 'roland',                                    // router slug
    obsidianName: 'Roland',                            // basename, exact case → for obsidian:// URI
    type: 'local',
    online: false,
    error: 'ECONNREFUSED ...',                         // null when online
    missingApiKey: false,
    openUri: 'obsidian://open?vault=Roland',           // pre-built + URL-encoded
    path: 'P:\\Mon Drive\\VAULTS\\Roland',
  }
  ```
  Returns `null` when no default vault is resolved (empty registry / no cascade match) or when the resolved name doesn't match any active vault (pathological post-load mutation — let the consumer surface the inconsistency).
- **`pathBasename(p)` helper** (`src/registry.mjs`) — exact-case basename, cross-platform Windows/POSIX detection identical to `defaultNameFromPath` but **preserves on-disk casing** because the `obsidian://` URI handler can be case-sensitive about the vault label. Exported as a named export (also visible via `_internals`).
- **`buildDefaultVaultStatus(name, pingedResults)` helper** (`src/tools/list-vaults.mjs`) — pure URI/status composition factored out so unit tests can exercise it without network I/O. Handles spaces, accents, and special characters in `obsidianName` via `encodeURIComponent`.
- **New convention snippet** `skills/conventions/snippets/default-vault-health-check.md` — install on any vault via `/obsidian-router:conventions install default-vault-health-check`. The snippet tells Claude to call `list_vaults` at session start, read `defaultVaultStatus`, and if `online: false` compose a natural-language warning with three options (open Obsidian via the `openUri` link, switch vault for the session, or ignore). The snippet auto-installs on every freshly-bootstrapped vault (it's in the library directory that `setup-vault.mjs` clones).
- **Mapping table updated** in `skills/conventions/SKILL.md` — adds the 6th convention to the documented library (`source-type`, `bilingual`, `heading-hierarchy`, `auto-enrichment`, `roadmap-discipline`, **`default-vault-health-check`**).
- **17 new tests** in `tests/registry.test.mjs` — 8 cases for `pathBasename` (Windows / POSIX / UNC / leading-dot / edge cases) + 9 cases for `buildDefaultVaultStatus` (online / offline / missingApiKey / null cases / remote vault / spaces / accents / UNC). Total test count: **254/254** passing (was 237).

### Why

Without this, the typical session-start flow was: user launches Claude Code, asks Claude to write a note, Claude calls `write_file` without `vault:`, the router resolves to the default vault, the default vault is offline (Obsidian closed) → `ECONNREFUSED 127.0.0.1:27124`. The user sees a cryptic network error and doesn't know "open Obsidian" is the fix.

The new architecture is **three layers of defense in depth**:
1. **Router code** (`defaultVaultStatus` field) exposes the truth — is the default vault reachable, and what's the clickable `obsidian://` URI to fix it.
2. **Installable convention** materializes the rule in a vault's `CLAUDE.md` for local visibility (useful when sharing a vault with collaborators).
3. **Global `~/.claude/CLAUDE.md`** carries a copy of the rule so it applies by default to every session, even on vaults that haven't installed the snippet locally.

### Backward compatible

- **Additive response field** — `defaultVaultStatus` is a new top-level field. Existing clients that read only `vaults[]` / `defaultVault` / `disabled[]` / `lockedTo` / `autoEnrichMode` continue to work unchanged. No field renamed or removed.
- **No tool surface change** — same 18 tools, same arguments, same schemas.
- **No env-var contract change** — all v0.9.x env vars (`OBSIDIAN_ROUTER_ALLOWED_VAULTS`, `OBSIDIAN_ROUTER_READONLY`, `OBSIDIAN_ROUTER_USER_ID`, etc.) behave identically.
- **Convention is opt-in per vault** — existing vaults stay unaffected until they explicitly install the snippet (or use the global CLAUDE.md copy).

## [0.9.1] — 2026-05-21

Ships a new installable convention — `roadmap-discipline` — that codifies the rule "every roadmap lives in the current vault, and gets updated in the same session as the shipping commits that close its items". Triggered by recurring drift observed on the mcphub-deployment-roadmap (sessions shipping v0.8.12 / v0.9.0 without flipping the corresponding `- [ ]` to `- [x]`).

### Added

- **New convention snippet** `skills/conventions/snippets/roadmap-discipline.md` — install on any vault via `/obsidian-router:conventions install roadmap-discipline`, or auto-install on every freshly-bootstrapped vault (the snippet is in the library directory that `setup-vault.mjs` clones).
- **Mapping table updated** in `skills/conventions/SKILL.md` — adds the 5th convention to the documented library (`source-type`, `bilingual`, `heading-hierarchy`, `auto-enrichment`, **`roadmap-discipline`**).

### Why

The convention codifies a three-part discipline:
1. **Creation**: when the user asks for a roadmap, it MUST be created in the current vault (not in `~/.claude/plans/`, not inline-chat, not in the code repo). Path conventions per vault folder pattern.
2. **Maintenance**: every commit that closes a roadmap checkbox must toggle the box, update the phase header (`✅ · livré <date> (v<version>)`), refresh `updated:`, update the "Ordre d'attaque" section, and append a log.md line.
3. **Pre-flight check**: before announcing "Phase X done" in the chat, re-read the roadmap and verify every relevant checkbox is `- [x]`.

A copy of the rule also lives in `~/.claude/CLAUDE.md` (user-global) so it applies to every session by default, even on vaults that haven't installed the snippet locally.

### Backward compatible

- No code change. Pure documentation snippet addition.
- Existing vaults are unaffected until they explicitly run `/obsidian-router:conventions install roadmap-discipline`.

## [0.9.0] — 2026-05-21

Phase 1 of the multi-tenant MCPHub deployment project (see `wiki/obsidian-mcp-router sur Dedibox et MCPHub/mcphub-deployment-roadmap.md` in the meta vault). Three **opt-in** env vars turn the router into a scoped instance suitable for running behind a hub (MCPHub, `mcpo`, a custom gateway) with one router-server-entry per user. Setting no env vars is fully rétrocompat with v0.8.12 — the router behaves exactly as before.

### Added

- **`OBSIDIAN_ROUTER_ALLOWED_VAULTS=a,b,c`** (`src/registry.mjs`) — whitelist of vault names this instance sees. Comma-separated, spaces tolerated. Vaults outside the list go to `skipped[]` with reason `"not in OBSIDIAN_ROUTER_ALLOWED_VAULTS whitelist"`. Applied **before** default-vault resolution, so `defaultVault` falls through to the filtered set instead of pointing at a wiped vault (risk R3 from the pre-Phase-1 audit). 6 new tests in `tests/registry.test.mjs`.
- **`OBSIDIAN_ROUTER_READONLY=true`** (`src/index.mjs`) — disable the 8 write tools (`write_file`, `append_to_file`, `patch_file`, `set_frontmatter`, `merge_frontmatter`, `move_file`, `delete_file`, `execute_template`). Two-layer guard: write tools are filtered out of `ListTools` AND refused at `CallTool` time, so a client that already knows a tool name and calls it directly is still rejected. Truthy tokens: `true` / `1` / `yes` / `on` (case-insensitive). New test file `tests/readonly.test.mjs` (14 tests).
- **`OBSIDIAN_ROUTER_USER_ID=<slug>`** (`src/index.mjs`) — audit log: every **successful** write tool call appends a line `[claude-write by <slug>] YYYY-MM-DD HH:MM — <tool> path="<path>"` to the touched vault's `wiki/log.md`. Path is extracted via `pickAuditPath(name, args)` which knows the field shape per tool (`args.path` for most, `args.to` for `move_file`, `args.targetPath` for `execute_template`). Best-effort: a failed audit append logs the cause to stderr but never blocks the original write. **Recursion guard**: the audit append uses `restAppendToFile` (REST client) directly, NOT the `append_to_file` tool wrapper — going through the wrapper would loop infinitely. New test file `tests/user-id-audit.test.mjs` (13 tests).
- **New named exports** from `src/index.mjs`: `isReadonlyMode`, `pickAuditPath`, `formatAuditLine`, `_internals` (with `TOOLS`, `TOOL_HANDLERS`, `WRITE_TOOL_NAMES`, `PKG_VERSION`).

### Changed

- **README.md** gains a "Deployment modes" section documenting Local (default, v0.8.x compatible) vs Multi-tenant (opt-in via env vars). Concrete `mcp_settings.json` example for MCPHub deployments.

### Tests

- 237/237 passing — 204 from v0.8.12 + 6 (ALLOWED_VAULTS) + 14 (READONLY) + 13 (USER_ID).
- `package.json` `test` script extended with `tests/readonly.test.mjs` and `tests/user-id-audit.test.mjs`.

### Backward compatible

- All three env vars are opt-in. Unset = exact v0.8.12 behavior.
- No tool surface change for clients that don't set the env vars.
- No MCP-protocol change.
- The audit-log behavior only writes when `USER_ID` is set. The `restAppendToFile` direct call is internal — clients see the same tool semantics.

### Sources

- `wiki/obsidian-mcp-router sur Dedibox et MCPHub/2026-05-21-codex-audit.md` (precondition: TOOL_REGISTRY refactor done in v0.8.12 → see CHANGELOG).
- `wiki/obsidian-mcp-router sur Dedibox et MCPHub/mcphub-deployment-roadmap.md` Phase 1.1 / 1.2 / 1.3 / 1.4.

## [0.8.12] — 2026-05-21

Pre-Phase-1 cleanup: addresses every IMPORTANT and four NIT findings from the `/review+ --mode=snapshot --target=main` audit run during the 2026-05-20 night session (see `wiki/obsidian-mcp-router sur Dedibox et MCPHub/2026-05-21-review-plus-results.md` in the meta vault). Goal: leave the codebase in a clean state before the v0.9.0 multi-tenant env vars (Phase 1) land.

### Changed

- **IMP-3 — unified tool dispatch (`src/index.mjs`)**. Replaced the static `TOOLS` array + manual `switch (name)` dispatch with `TOOLS` + a paired `TOOL_HANDLERS` map plus a **boot-time cross-check** that throws if the two surfaces drift. Pre-v0.8.12 a typo in a `case` would silently surface as `"Unknown tool"` at runtime; now any drift is a structural error at module load. Precondition for v0.9.0's `OBSIDIAN_ROUTER_READONLY` filtering to be uncircumventable.
- **IMP-2 — handshake version (`src/index.mjs`)**. The MCP `Server` constructor used a hardcoded `version: '0.8.2'` that hadn't been bumped since v0.8.2. Now reads from `package.json` at module load (`PKG_VERSION` constant). Can't drift again.
- **IMP-1 — sanitize wire-up extended (`src/tools/list-files.mjs`, `src/tools/get-frontmatter.mjs`)**. Both tools now wrap their return values in `sanitizeResponse(...)` for consistency with `search` / `search_smart` / `get_file`. Closes a gap where a vault-attacker-controlled path or frontmatter scalar could embed ANSI escapes or agentic markup. `sanitizeResponse` preserves non-string types (numbers / bools / arrays in frontmatter) intact.
- **IMP-7 — fingerprint presence marker (`src/helpers/wiki-fingerprint.mjs`)**. `computeFingerprint` now hashes a presence byte (`'1'` for present, `'0'` for missing) BEFORE the canonical body, so an empty-then-deleted file no longer collides with an unchanged-empty file. The hot-cache hook re-fires correctly on the delete now. New test: `IMP-7 regression — empty file vs missing file produce DIFFERENT fingerprints`.
- **IMP-5 — broader injection-tag blocklist (`src/helpers/sanitize.mjs`)**. Added bare-tag variants to `INJECTION_TAGS`: `function_calls`, `function_results`, `invoke`, `parameter`, `env`, `claudeMd`, `currentDate`, `userEmail`. Pre-v0.8.12 the pattern `antml:[a-z_-]+` covered the Anthropic-prefixed family but not the bare variants that show up in Claude Code system reminders without prefix.
- **IMP-4 — conventions `remove` safety guards (`skills/conventions/SKILL.md`, `commands/conventions.md`)**. The skill now mandates: (1) preview of the section to be removed BEFORE write, (2) sidecar backup `CLAUDE.md.bak-<id>-<timestamp>` in the same vault directory, (3) explicit `confirm:true` argument required when targeting `--all` vaults. Backups are never auto-cleaned. Closes a destructive-data risk where users with hand-edited convention sections would lose their customisations on remove.
- **IMP-6 — pickSeeds fallback policy (`src/helpers/idf-score.mjs`)**. `pickSeeds` and `rankAndPick` gained an `opts.fallbackOnAllZero` argument: `'first-n'` (default, pre-v0.8.12 behavior — returns first N candidates) or `'none'` (returns `[]`). Lets call sites that prefer "no result" over "confidently-wrong result" opt out of the silent fallback. JSDoc on `rankAndPick` warns about the trap. Pre-v0.8.12 callers stay rétrocompat.

### Fixed

- **NIT-2 — IDF tokenise tests consolidated (`tests/idf-score.test.mjs`)**. The previously-confusing pair of conflicting tests (`"numbers count as tokens"` saying `tokenise('v0.8.9 released 2026') === ['released', '2026']` and a separate describe-block saying `tokenise('v0.8.9') === []`) is now a coherent narrative with cross-references. The dev-noise comment `"Fix the version-tokens test which I miscounted above"` is gone.
- **NIT-3 — writeFingerprint failures are visible (`src/helpers/wiki-fingerprint.mjs`)**. The silent catch on disk write failures now logs the cause (with `err.code`) to stderr. Behaviour stays non-throwing (the hook degrades to "re-prompt every time" rather than crashing), but the root cause is greppable in logs now.
- **NIT-4 — commands/conventions.md mirrors SKILL safety (`commands/conventions.md`)**. The destructive-remove warning that lived only in the SKILL.md is now also visible in the slash command's documentation, so a user reading `/help` sees the safety guards before invoking `remove`.
- **NIT-5 — defaultIdf throws on empty corpus (`src/helpers/idf-score.mjs`)**. `defaultIdf(0)` previously returned `Math.log(1) = 0`, which silently zeroed every downstream score and surfaced as confidently-wrong drill via the all-zero `pickSeeds` fallback. Now throws a targeted error: misuse is caught at the call site instead of corrupting answers downstream.

### Tests

- 204/204 passing — 198 from v0.8.11 + 6 new tests (1 for IMP-7 regression, 1 for IMP-5 bare-tag neutralisation, 3 for IMP-6 fallbackOnAllZero, 1 for NIT-5 defaultIdf throws). No skipped, no flaky.
- `package.json` `test` script unchanged (same 4 test files: `registry.test.mjs`, `sanitize.test.mjs`, `idf-score.test.mjs`, `wiki-fingerprint.test.mjs`).

### Backward compatible

- All changes are additive or fail-louder. No tool surface change, no MCP-protocol change.
- `defaultIdf(0)` now throws instead of returning 0 — technically a behavior change, but no documented caller passed `0` (the function is meant to be called with a real corpus size).
- `pickSeeds` default behavior is unchanged when `fallbackOnAllZero` is omitted (stays `'first-n'`).
- The `TOOL_HANDLERS` cross-check would throw at module load if you had monkey-patched `TOOLS` from a fork; otherwise transparent.

### Sources

- Code Reviewer Claude pass: `wiki/obsidian-mcp-router sur Dedibox et MCPHub/2026-05-21-review-plus-results.md` (in the meta vault) — verdict "OK to merge with 7 IMPORTANT fixes before Phase 1", 0 BLOCKER.
- Codex pre-Phase-1 audit (codex:rescue sub-agent): converging on the same IMP-3 finding (`TOOLS` static dispatch fragility) — `wiki/obsidian-mcp-router sur Dedibox et MCPHub/2026-05-21-codex-audit.md`.

## [0.8.11] — 2026-05-18

### Added

- **New skill `conventions`** (`skills/conventions/SKILL.md`) + **new slash command `/obsidian-router:conventions`** (`commands/conventions.md`) — manage CLAUDE.md conventions across vaults via `install` / `remove` / `list` / `sync-all-vaults` sub-commands. Solves the recurring problem of "I added a new convention to the template — how do I propagate it to my N existing vaults without rewriting each CLAUDE.md by hand?". Mirror the `auto-mode` and `lock` patterns for consistency: single command, bilingual NL triggers (FR + EN).
- **Convention snippet library** (`skills/conventions/snippets/*.md`) — initial set of 4 conventions shipped, each a self-contained markdown section with a unique `## H2` heading used for both identification (detect-already-installed) and clean removal :
  - `source-type.md` — the `extracted` / `inferred` / `claude_synthesized` provenance vocabulary (added in v0.8.8 to `templates/wiki/CLAUDE.md`; this snippet lets you install it on any vault retroactively)
  - `bilingual.md` — the FR + EN bilingual convention (FR primary)
  - `heading-hierarchy.md` — the mandatory H1 / H2 / H3 rules + type-specific minimums table
  - `auto-enrichment.md` — the 4-mode auto-save dial (ClaudeAsk / Hybrid / FullAuto / off), including activation conditions, 3 triggers, sensitivity filter, hard cap
- **Extensibility** — adding a new convention = creating one new file under `skills/conventions/snippets/<id>.md`. The skill `Glob`s the directory on every invocation, so newly-added snippets appear immediately without a code change to the skill body itself.

### Why

- Before this skill, propagating a new CLAUDE.md convention required either : (a) manually copy-pasting from `templates/wiki/CLAUDE.md` to every vault's CLAUDE.md, or (b) re-scaffolding via `/obsidian-router:wiki` per vault (which works but is heavy-handed). Both options scaled poorly to the 9-vault setup.
- Today during this session we manually patched 5 vaults with the `source-type` convention. With this skill, the same operation is one slash command : `/obsidian-router:conventions sync-all-vaults source-type`.
- The H2-heading-based identification means the skill is **idempotent** — re-running install on a vault that already has the convention skips silently. And **non-destructive on uninstall** — only the exact section is removed, user customisations elsewhere in CLAUDE.md are untouched.

### Documentation / convention change (no code change in this repo)

- **Click-to-open links in chat** — when the bridge plugin (`tboome33/obsidian-mcp-router-bridge`) is ≥ v0.2.0, Claude formatting rule in `~/.claude/CLAUDE.md` emits markdown links of the form `[label](https://127.0.0.1:<vault-port>/open/<url-encoded-path>)` instead of the previous inline-code `obsidian://` URI format. A click in Claude Code's terminal dispatches the http URL → browser hits the bridge's new `GET /open/<path>` public-route → bridge calls `app.workspace.openLinkText` → Obsidian navigates to the file → tab auto-closes. No copy-paste. Falls back to the inline-code `obsidian://` format when the bridge is too old or the endpoint returns 404.
- Bridge plugin v0.2.0 adds the `GET /open/<path>` route via Local REST API's `addPublicRoute()` (loopback-only, no auth — security analysis in the bridge's `CHANGELOG.md` and `README.md#click-to-open`).
- Router-side: no code change for click-to-open. The convention update lives in the user's global `~/.claude/CLAUDE.md`; no router release is required for it, but users who want click-to-open must update the bridge to ≥ v0.2.0 in each vault.

### Backward compatible

- The new skill + command are purely additive (no breaking changes).
- Vaults without the new skill installed still work as before.
- No version bump required on bridge or any other component.

## [0.8.10] — 2026-05-18

Third (and last) of three graphify-borrowed Tier 1 patches (see [`ROADMAP.md`](./ROADMAP.md) and the wiki page [`2026-05-18-graphify-roadmap`](./wiki/decisions/2026-05-18-graphify-roadmap.md) item T1.C). Closes the Tier 1 train by enforcing **topology-equality short-circuits** on two derivative-content code paths so re-running with the same input costs zero writes and zero commits.

### Added

- **`src/helpers/wiki-fingerprint.mjs`** — port of graphify's `_canonical_topology_for_compare` pattern (`watch.py` rebuild path) to JS:
  - `canonicalise(text)` — normalise CRLF → LF, strip trailing whitespace per line, collapse trailing blank lines, ensure trailing newline. Narrow on purpose: preserves leading whitespace (matters for markdown lists), internal blank lines, internal whitespace.
  - `canonicalHash(text)` — SHA-256 truncated to 128 bits (32 hex chars) of the canonicalised text. Deterministic across runs.
  - `contentIsUnchanged(filePath, newContent)` — fastest path for "should I skip this write?"; returns true iff the existing file canonicalises to the same hash as `newContent`. Returns false if the file is missing.
  - `computeFingerprint(cwd, relativePaths)` — single fingerprint for a SET of files (sorted, deduplicated, missing files treated as empty). Used by the hot-cache hook to dedup re-prompts.
  - `readFingerprint(filePath)` / `writeFingerprint(filePath, fp)` — sidecar I/O for the dedup state. Silent-fail on write (degrades to pre-v0.8.10 re-prompt behaviour).
- **`tests/wiki-fingerprint.test.mjs`** — 37 cases covering canonicalisation invariants, hash determinism, content-unchanged file I/O, set-fingerprint order-independence + dedup + missing-file handling, sidecar read/write round-trip, malformed-fingerprint rejection, and an integration scenario walking the full hot-cache dedup loop. 198/198 total tests passing.

### Changed

- **`hooks/hot-cache-update-prompt.mjs`** — after detecting wiki changes, computes a fingerprint of the substantive (non-`hot.md`) changed files. If the fingerprint matches what was stored after the previous fire (in `.vault-meta/hot-prompt-fingerprint`), exits silently. Stores the new fingerprint after each fire. Breaks the re-prompt loop that happened when Claude saw the nudge but didn't refresh `hot.md` — the next Stop hook used to fire again with identical state. Whitespace-only edits to wiki files also no longer trigger re-prompts (canonical equivalence is the dedup key).
- **`skills/wiki-fold/SKILL.md`** — new step 4.5 ("Topology-equality short-circuit") instructs the skill to read the existing fold page, canonicalise both bodies, and **skip the write + index update + log entry triplet** if they match byte-for-byte. The "Idempotency contract" section now reads as a two-part guarantee: structural (deterministic naming + sorted output + ISO timestamps) AND operational (the step-4.5 short-circuit enforces it at the disk level). Re-running `/wiki-fold` with the same window now costs one read and zero writes.

### Why

- The PostToolUse auto-commit hook commits every write that touches `wiki/`. Without the short-circuits, two no-op patterns polluted `git log` over time:
  1. `/wiki-fold` re-runs with the same window produced byte-equivalent fold pages but `write_file` still touched the file, the auto-commit recorded a commit, and `git log` accumulated empty "no-op fold" entries. Worse: the auto-commit log was sometimes the ONLY entry between meaningful work, making the history harder to scan.
  2. The Stop hook re-fired the hot.md refresh nudge on every conversation turn that touched wiki/, even when state was identical to what it had just prompted about. Claude rightly ignored the duplicate nudges, but they cluttered the conversation transcript with `WIKI_CHANGED` noise.
- graphify hit the exact same family of issues and solved both with the canonical-equality pattern (`_canonical_topology_for_compare` for the graph file, `topology-equality post-rebuild check` for skipping clustering re-runs). The pattern transfers verbatim — only the format-specific canonicalisation differs (their JSON-sorting → our markdown line-stripping).

### Tests

- 198/198 passing — 161 from v0.8.9 + 37 new wiki-fingerprint cases.
- `package.json` `test` script extended to include `tests/wiki-fingerprint.test.mjs`.

### Backward compatible

- The fingerprint helper is a new module. `hooks/hot-cache-update-prompt.mjs` imports it via relative path `../src/helpers/wiki-fingerprint.mjs` — works for users who installed via `git clone` + `npm link` (the canonical setup); also works for `npm install` distribution because `src/` is in `package.json` `files`.
- The wiki-fold skill change is purely additive (a new step 4.5 between existing steps 4 and 5). Folds without changes now produce a "no changes written" output instead of a write-cycle, but the wire shape of the result is the same.
- `.vault-meta/hot-prompt-fingerprint` is a sidecar file the user can safely delete to reset the dedup state (next Stop hook will then re-fire as before). Recommended `.gitignore` entry: `.vault-meta/`.
- No tool surface change, no MCP-protocol change, no breaking change.

## [0.8.9] — 2026-05-18

Second of three graphify-borrowed Tier 1 patches (see [`ROADMAP.md`](./ROADMAP.md) and the wiki page [`2026-05-18-graphify-roadmap`](./wiki/decisions/2026-05-18-graphify-roadmap.md) item T1.B). Adds IDF-weighted candidate scoring with dynamic seed selection — the algorithm that ranks pages against a free-text query and prevents weak-runner-up dilution.

### Added

- **`src/helpers/idf-score.mjs`** — port of graphify's `_compute_idf` + `_score_nodes` + `_pick_seeds` (`graphify/serve.py:300-325`) to pure JS:
  - `tokenise(text)` — lowercase + Unicode-aware non-word split + filter tokens ≤ 2 chars.
  - `computeIdf(documents)` — corpus-wide `idf(t) = log(1 + N / (1 + df(t)))`. Suppresses noise terms like `user`, `error`, `the` that appear in many documents.
  - `scoreCandidates({ query, candidates, idf })` — three-tier per-term scoring: exact ×1000, prefix ×100, substring ×1. `secondaryLabel` field matched at ×0.5 weight (use for folder paths / breadcrumbs). Returns candidates sorted by score descending.
  - `pickSeeds(scored, { maxSeeds=3, dominanceRatio=5 })` — returns the top candidate only when its score is more than 5× the runner-up (graphify's fix for issue #897 — dominant matches shouldn't be diluted by weak runner-ups). Otherwise returns up to `maxSeeds`.
  - `rankAndPick({ query, candidates, idf })` — one-shot convenience wrapping the three above.
- **`tests/idf-score.test.mjs`** — 40 cases covering tokenisation (Unicode, version strings, snake_case), IDF formula correctness + iterable input, exact/prefix/substring score tiers, secondary-label half-weight, alias support, IDF down-weighting of common terms, dynamic seed cutoff at exact ratio boundary, all-zeros fallback, and a regression test for graphify issue #897. 161/161 total tests passing.
- **`skills/wiki-query/SKILL.md`** — tier 2 ("index.md") rewritten as a three-step IDF-weighted ranking + dynamic-seed cutoff procedure that Claude follows when picking 1-3 candidate pages to drill into. Tier 5 ("synthesize") now requires confidence-aware citations using the `source_type` frontmatter introduced in v0.8.8 (`(extracted)` / `(inferred)` / `(synthesized)` annotations on every wikilink in the rendered answer).

### Why

- The previous `wiki-query` tier-2 selection ("scan for matching titles, pick 1-3 most relevant") had two recurring failure modes:
  1. **Equal weight per query token.** A question containing one common term ("user") and one rare term ("kelly") gave both equal weight, so a wiki with a `user notes` page and a `kelly criterion` page would surface both equally rather than recognising that "kelly" is the discriminating term. IDF down-weights common terms automatically.
  2. **Always-3-candidate drill.** Even when one page clearly dominated, the skill drilled into two more weak matches and the synthesis became muddled. Dominant-match-only cutoff (graphify's `_pick_seeds`) fixes this — if the top scores >5× the runner-up, drill into ONLY the top.
- The helper is the canonical implementation that T2.A (`wiki-neighbors`), T2.B (`wiki-path`), T2.C (`wiki-explain`), and T3.A (`wiki-export-graph` search bar) will all import for endpoint resolution and result ranking. Shipping it now means those downstream tools don't need to re-implement.
- Combined with v0.8.8's `source_type` vocabulary, the wiki-query answer now tells the reader at a glance whether each cited claim is grounded (`extracted`), interpreted (`inferred`), or synthesised (`synthesized`). Different trust levels become visible without manual frontmatter reading.

### Tests

- 161/161 passing — 121 from v0.8.8 + 40 new IDF-score cases.
- `package.json` `test` script extended to include `tests/idf-score.test.mjs`.

### Backward compatible

- The helper is a new module; nothing imports it yet from the main router runtime. Only `wiki-query` skill (instructions to Claude) consumes it conceptually.
- No tool surface change, no MCP-protocol change, no breaking change.
- v0.8.8's `source_type` annotations from `wiki-query` citations gracefully degrade to `(unmarked)` for pre-v0.8.8 pages without the frontmatter field.

## [0.8.8] — 2026-05-18

First of three graphify-borrowed Tier 1 patches (see [`ROADMAP.md`](./ROADMAP.md) and the wiki page [`2026-05-18-graphify-roadmap`](./wiki/decisions/2026-05-18-graphify-roadmap.md) item T1.A for the design rationale). Two independent additions packaged together because they both address source-provenance hygiene.

### Added

- **`sanitizeLabel()` / `sanitizeContent()` / `sanitizeResponse()` helpers** in new `src/helpers/sanitize.mjs`. Strip ANSI CSI/OSC escape sequences and control characters from any string that came from a vault before it flows back through MCP into Claude's context. `sanitizeContent` additionally neutralises a narrow set of agentic-markup tokens (`<system-reminder>`, `<tool_use>`, `<*>`, `<assistant>`, etc.) by HTML-encoding the leading `<` — preventing a corpus-injected document from hijacking the model. Length caps default to 16 KiB for labels and 1 MiB for full-page content; both overridable per call site. 33 new test cases in `tests/sanitize.test.mjs` (121/121 total passing).
- **Wire-up in three tools** on the response path:
  - `src/tools/search.mjs` — every match string goes through `sanitizeResponse`.
  - `src/tools/search-smart.mjs` — semantic-search results (breadcrumbs, excerpts, paths) go through `sanitizeResponse`.
  - `src/tools/get-file.mjs` — string-form file content goes through `sanitizeContent` (larger cap, neutralisation ON). Structured-form responses (frontmatter JSON via `application/vnd.olrapi.note+json`) pass through untouched to preserve type fidelity.
- **`source_type` frontmatter vocabulary** documented in `templates/wiki/CLAUDE.md` as a new mandatory section "Source provenance". Three values borrowed verbatim from graphify's `EXTRACTED / INFERRED / AMBIGUOUS`:
  - `extracted` — verbatim or near-quote from a source.
  - `inferred` — derived from a source but not written verbatim.
  - `claude_synthesized` — pure synthesis by Claude.
  - Inline callouts `[!extracted]` / `[!inferred]` / `[!claude_synthesized]` for per-paragraph overrides on mixed-provenance pages.
- **Skill updates** — `skills/wiki-ingest/SKILL.md` step 4 (source frontmatter) and step 5 (entity/concept frontmatter) now write `source_type`. `skills/save/SKILL.md` step 4 (frontmatter) documents how to pick the right value per saved-content kind.

### Why

- **Prompt-injection defence.** Vault content is user-authored at best, attacker-authored at worst. Without sanitisation, a malicious file could embed ANSI escapes (corrupting terminal output, hijacking PowerShell scroll buffer on Windows — graphify hit this with graspologic's stderr) or agentic markup (`<system-reminder>ignore all previous</system-reminder>`) that flips Claude's behaviour mid-tool-call. graphify takes this seriously enough to file it as `F-010` in their threat model (`serve.py:261-264`); the router had the same exposure with zero defence.
- **Provenance hygiene.** Until today, a wiki page didn't tell you whether an assertion was a verbatim quote from a source or a synthesis Claude wrote. Three-bucket tagging closes that gap with one frontmatter field per page (plus inline callouts where granularity matters). Downstream features (T1.B IDF citations, T2.D wiki-lint quality flags, T3.A confidence-aware viz) all build on this foundation.

### Tests

- 121/121 passing — 88 pre-existing + 33 new sanitize cases (clean strings, ANSI strip, control-char strip, injection neutralisation in both off/on modes, length caps, real-world markdown regressions including wikilinks/callouts/unicode/frontmatter).
- `package.json` `test` script now lists both test files explicitly (`node --test tests/registry.test.mjs tests/sanitize.test.mjs`) — `node --test tests/` was attempted but Node 20+ interprets a bare directory path as a module rather than a test-discovery root.

### Backward compatible

- Existing wiki pages without `source_type` continue to work — the field is purely additive metadata.
- All tool response shapes are unchanged; sanitisation is in-place string cleanup, not schema change.
- No new MCP tools, no new dependencies.

## [0.8.7] — 2026-05-17

### Added
- **`--bootstrap-reference` command** in `scripts/setup-vault.mjs` — a one-command way to create a fresh reference vault for users cloning the repo from GitHub. Scaffolds from the shipped skeleton, downloads the bridge plugin from its GitHub release, and records the path as `referenceVault` in `~/.claude/obsidian-mcp-router/config.json`. Follow up with `--init-reference <path>` after installing the marketplace plugins via Obsidian to validate and reserve the port.
- New [`templates/reference-vault-skeleton/`](./templates/reference-vault-skeleton/) directory committed to the repo, containing the canonical starting content for a reference vault: `.obsidian/community-plugins.json` (5-plugin list aligned with the author's `.template`), `.obsidian/app.json`, `.smart-env/smart_env.json` (transformers embedding model, API key field empty for safety), `.claude/settings.json` (Claude Code project settings that enable the `obsidian-router` plugin in this vault), `CLAUDE.md` (LLM-wiki navigation rules), `wiki/{index,log,hot,overview}.md` (Karpathy LLM-wiki scaffolding), and a `README.md` documenting what's in and what's intentionally out.
- New "Fast path" section at the top of [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) — points new users at `--bootstrap-reference` first; the existing manual procedure remains as the long-form reference for customization and troubleshooting.

### Why
- Before this change, anyone cloning the repo had no path to acquire the author's reference vault — `.template` lives only on the author's machine for licensing + secrets reasons (plugin `main.js` files are third-party copyrighted artifacts under MIT/GPL-3.0, and `obsidian-local-rest-api/data.json` contains a TLS cert + private key + API key in cleartext). The manual procedure required ~6 steps with the `mcp-router-bridge` folder-vs-id naming gotcha tripping up most first-time users.
- The fast path turns onboarding into one command + one Obsidian session (click "Install" on the 4 plugin prompts Obsidian raises from the shipped `community-plugins.json`) + one `--init-reference` finalizer. The plugin selection ships in the skeleton's `community-plugins.json` so the consumer's vault matches the author's set by default.

### Plugin acquisition strategy
- The **bridge plugin** (only required plugin not in Obsidian's marketplace) is auto-downloaded from `github.com/tboome33/obsidian-mcp-router-bridge/releases/latest/download/{main.js,manifest.json}` via Node's built-in `https` module — no new dependency.
- The **four marketplace plugins** (Local REST API, Smart Connections, Templater, Quiet Outline) are installed through Obsidian itself when the user opens the freshly-scaffolded vault: Obsidian sees their IDs in `.obsidian/community-plugins.json` without matching folders under `.obsidian/plugins/` and prompts to install.

## [0.8.6] — 2026-05-14

### Added
- **`obsidian-quiet-outline`** added to `OPTIONAL_PLUGINS` in `scripts/setup-vault.mjs`. Quiet Outline is a community plugin that replaces the core Obsidian Outline with a much better sidebar — searchable headings, collapse/expand, drag-to-resize, sync with scroll, markdown rendering of heading text. Newly bootstrapped vaults (and existing vaults synced via `--sync-plugins`) will now clone it from `.template` automatically.
- Operator note: install Quiet Outline once in `.template` via Obsidian's community plugin browser (or drop `main.js` + `manifest.json` + `styles.css` from the [v0.5.12 release](https://github.com/guopenghui/obsidian-quiet-outline/releases/tag/0.5.12) into `.template/.obsidian/plugins/obsidian-quiet-outline/`), then enable it in `.template/.obsidian/community-plugins.json`. From that point on the plugin propagates with the rest.

### Why
- Core Outline plugin is minimal — no search, no collapse, must re-open the panel on every note change unless pinned. On the user's typical wiki note (1500-4500 words, 10-15 H2, 10-20 H3), this gets unwieldy. Quiet Outline fixes the ergonomics without changing the underlying convention (still relies on H1/H2/H3 hierarchy from v0.8.5 consigne).

## [0.8.5] — 2026-05-08

### Added
- **Mandatory heading-hierarchy consigne** in `templates/wiki/CLAUDE.md` (and the personal-mode customization in `.template/CLAUDE.md`). Every wiki page must have exactly one `# H1` at top + at least two `## H2` sections if > 200 words. Type-specific minimums per `type` frontmatter (`session` → Prompt/What happened/Outcome, `decision` → Context/Decision/Consequences, `concept` → Definition/Why it matters/Related, `reference` → Summary/Key takeaways/Source, etc.). The skill pushes back when content is too thin: file as a one-liner in `wiki/facts.md` instead of producing a flat single-section page.
- Light reinforcement of the rule in `skills/save/SKILL.md` step 5 ("Write the body") and `skills/wiki-ingest/SKILL.md` step 4 (source filing) + step 5 (entity/concept pages) — both now spell out the H2 sections per type and reference the CLAUDE.md rule.
- New [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) — step-by-step guide to creating the reference vault that `setup-vault.mjs` clones from. Covers required vs. optional plugins, the `mcp-router-bridge` folder-vs-id naming gotcha (folder must be `mcp-router-bridge` to match the manifest id, even though the GitHub repo is `obsidian-mcp-router-bridge`), update workflow, and troubleshooting. Linked from the README install requirements (EN + FR).

### Fixed
- `scripts/setup-vault.mjs` — required-plugin check at line 64 now expects `mcp-router-bridge` (the actual plugin id from the upstream `manifest.json`) instead of `obsidian-mcp-router-bridge` (the GitHub repo name). Aligns with the canonical Obsidian convention that folder name must match the manifest id. Pre-existing vaults with the divergent name keep working — only newly bootstrapped vaults are affected.

### Why (headings hierarchy)
- Obsidian's **Outline** panel (and any heading-aware navigation) is empty on flat pages with only an H1 + paragraphs. Long notes become unscannable. Auto-generated content from `/save`, `/wiki-ingest`, etc. previously varied in structure; now it must obey a documented hierarchy.
- Documented in the vault consigne so the rule applies cross-skill (and to manual Claude conversations bound to the vault), not just the explicit skill invocations.

## [0.8.4] — 2026-05-08

### Added
- **`meta-setup` skill** now guides users through raising `skillListingBudgetFraction` in `~/.claude/settings.json` from the default 1% to 5% (recommended for router users — see below). Detects under-budgeted setups, asks for confirmation, merges the change without touching unrelated keys, and handles the Windows UTF-8 BOM edge case.
- README install section (EN + FR) — new callout explaining the recommendation, the symptom (`Skill listing will be truncated — N descriptions dropped`) it fixes, and pointing at `meta-setup` for interactive application.

### Why
- The router contributes ~30 skills (slash commands + skills) to Claude Code's skill listing. On a default install (`skillListingBudgetFraction: 0.01`), the budget is exceeded once router + Anthropic defaults + any other plugin are loaded, and skills like `/save`, `/wiki`, `/autoresearch` get truncated or dropped — silently breaking natural-language triggering.
- Recommended bump to `0.05` (5%) costs ~6k extra tokens per session and keeps the full listing intact. Existing users seeing the warning can apply the same fix manually or via `meta-setup`.

## [0.8.3] — 2026-05-08

### Changed
- **Skill listing budget cleanup** — trimmed descriptions of 13 slash commands that duplicate a skill of the same name (`autoresearch`, `canvas`, `defuddle`, `meta-add-vault`, `meta-setup`, `meta-status`, `obsidian-bases`, `save`, `wiki`, `wiki-fold`, `wiki-ingest`, `wiki-lint`, `wiki-query`). The skill now owns the rich natural-language triggering description; the command keeps only a one-line palette label that points back to the skill. Saves ~1500 tokens of skill-listing budget per session, eliminates the per-entry-cap warning that previously dropped 46 descriptions on busy setups.
- No behavioral change: slash commands still invoke the same skill body, natural-language triggers still resolve through the corresponding skill.

## [0.8.2] — 2026-05-03

### Added
- **Wiki auto-enrichment Phase 1** — 4-mode dial (`ClaudeAsk` / `Hybrid` / `FullAuto` / `off`) with runtime toggle and `.env` persistence (`OBSIDIAN_ROUTER_AUTO_ENRICH`). Mirrors the v0.8.0 lock-mode architecture.
- New MCP tool `set_auto_enrich_mode({ mode, persist? })` with case-insensitive + alias canonicalization (`ask`/`auto`/`semi`/`none`).
- New slash command `/obsidian-router:auto-mode <Mode>` with bilingual NL triggers + per-mode use-case bullets in the description.
- New `validateAutoEnrichMode(candidate, context)` helper exported from `src/index.mjs` — fall-through-with-warning on invalid env var (mirrors `validateLock`).
- `list_vaults` response gains 5th field `autoEnrichMode`.
- New [`docs/auto-enrichment.md`](./docs/auto-enrichment.md) (EN+FR) — full guide with use cases per mode + 4 placement channels.
- New `templates/wiki/CLAUDE.md` consigne with mode-dependent behavior at each of the 3 triggers (validation pin / result digest / topic-switch checkpoint).
- New `commands/auto-mode.md` slash command (Phase 1 toggle).
- New bilingual quick-reference PDFs ([FR](./docs/quick-reference-fr.pdf), [EN](./docs/quick-reference-en.pdf)) — 5 pages each, accessible 11pt fonts.
- `setup-vault.mjs` now clones `quick-reference-{fr,en}.pdf` into bootstrapped vaults via `ROOT_FILES_TO_CLONE`.

### Fixed
- **Critical (post-push, Codex audit)** — `set_auto_enrich_mode({ mode: "off", persist: true })` now writes `OBSIDIAN_ROUTER_AUTO_ENRICH=off` literally to `.env` instead of removing the line. Previously the line was deleted, but startup defaulted absent values to `ClaudeAsk` — silently re-enabling auto-suggestions on sensitive vaults at next restart. The success message was also lying ("off across restarts" → false).
- `commands/auto-mode.md` NL trigger ambiguity: phrases like "stop asking me" no longer auto-map to `FullAuto`; the command now disambiguates between `off` / `Hybrid` / `FullAuto` before invocation.
- `templates/wiki/CLAUDE.md` Trigger 2/3 FullAuto branches now explicitly restate the sensitivity filter gate (was implicit, easy to misread).
- Tests for `lock_vault` + `set_auto_enrich_mode` homedir refusal now assert that `~/.env` was NOT created/mutated when the call was rejected (parity fix).

### Tests
- 88/88 passing.

## [0.8.1] — 2026-05-03

### Added
- **Wiki auto-enrichment Phase 0** — Claude proactively suggests wiki saves at 3 triggers: validation pin (inline `🔖`), result-obtained digest, topic-switch checkpoint. Mode hardcoded to `ClaudeAsk` (always confirm).
- `templates/wiki/CLAUDE.md` ships the consigne; future vaults scaffolded via `/obsidian-router:wiki` get it automatically.
- README EN+FR callout with link to the placement guide.

### Note
- Plugin-side update only (no npm router package change). Existing vaults need to re-pull the consigne section into their own `CLAUDE.md`.

## [0.8.0] — 2026-05-03

### Added
- **Lock mode (single-vault isolation)** — `lock_vault({ vault, persist? })` and `unlock_vaults({ persist? })` MCP tools. While locked, every tool call to a different vault throws; cross-vault fan-out (`vault: "*"`) is refused; calls without explicit `vault` resolve to the locked one.
- New `OBSIDIAN_ROUTER_LOCKED=<vault>` env var, read at startup, written by `lock_vault({ persist: true })`.
- New slash commands `/obsidian-router:lock` and `/obsidian-router:unlock` with bilingual NL triggers.
- `list_vaults` response gains 4th field `lockedTo: <name>|null`.
- New `validateLock(candidate, vaults, context)` helper exported from `src/index.mjs`.
- New `applyLockGuard()` exported helper that monkey-patches `registry.resolveVault()` so every existing tool call site inherits the check.
- README EN+FR: new "Lock mode" section with three concrete cases (volatile, permanent for shared install, switching target).
- Tests: 19 new cases covering set/unset, persist round-trip, homedir refusal, hot-reload preserve.

### Fixed
- **Critical** — `samePath()` Windows case-insensitive comparison so a homedir refusal can't be bypassed by typing `C:\Users\donald` vs `C:\Users\Donald`.
- `upsertDotenvVar` now updates the FIRST occurrence (matches the reader convention in `bin/obsidian-mcp-router.mjs`).
- Hot-reload preserves the lock state across config reloads, but revalidates so disabling the locked vault drops the lock instead of bricking.

## [0.7.1] — 2026-05-02

### Added
- `list_vaults` exposes disabled vaults — `disabled: [{ name, type, reason }]` field surfacing what was skipped by `disabledVaults` config.

## [0.7.0] — 2026-05-02

### Added
- Per-workspace default vault resolution — 5-tier cascade: `OBSIDIAN_ROUTER_DEFAULT_VAULT` env > `VAULT_PATH` env auto-detection > `config.defaultVault` > first healthy local > first active.
- `setup-vault.mjs` writes `VAULT_PATH=<path>` into each bootstrapped vault's `.env` so opening Claude Code in a vault directory "just works".

## [0.6.0] — 2026-04-30

### Added
- Knowledge management skill stack (10 commands): `/wiki`, `/wiki-ingest`, `/wiki-query`, `/wiki-lint`, `/wiki-fold`, `/save`, `/autoresearch`, `/canvas`, `/defuddle`, `/obsidian-bases`.

## [0.5.0] — 2026-04-29

### Added
- Rebrand cleanup, integrated setup scripts, runtime hardening.

## [0.4.x] — 2026-04-28

### Added
- v0.4.0: frontmatter helpers (`get_frontmatter`, `set_frontmatter`, `merge_frontmatter`), `move_file`, `RestApiError` typed error class with categorized `kind` + `hint` fields.
- v0.4.1: onboarding skills (`meta-setup`, `meta-add-vault`, `meta-status`).
- v0.4.2: hot config reload (router watches `~/.claude/obsidian-mcp-router/config.json` and re-loads on changes).

## [0.3.0] — 2026-04-27

### Added
- Write operations (`write_file`, `append_to_file`, `patch_file`, `delete_file`) and Templater execution (`execute_template`) — all via the bridge plugin.

## [0.2.0] — 2026-04-26

### Added
- Semantic search (`search_smart`) via the bridge plugin's `/search/smart` route.

## [0.1.0] — 2026-04-25

### Added
- Initial release: `list_vaults`, `list_files`, `get_file`, `search` MCP tools over the Local REST API plugin. Multi-vault routing via `vault` parameter or default-vault resolution.

---

Full per-version implementation notes (architecture decisions, alternatives considered, deferred Phase 2/3 work, etc.) live in [ROADMAP.md](./ROADMAP.md).
