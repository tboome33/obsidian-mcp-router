# Changelog

All notable changes to `obsidian-mcp-router` (the npm package + Claude Code plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [Unreleased]

Nothing pending right now.

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
