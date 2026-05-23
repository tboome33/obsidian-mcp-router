# Changelog

All notable changes to `obsidian-mcp-router` (the npm package + Claude Code plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [Unreleased]

Nothing pending right now.

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
