# Changelog

All notable changes to `obsidian-mcp-router` (the npm package + Claude Code plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [Unreleased]

Nothing pending right now.

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
