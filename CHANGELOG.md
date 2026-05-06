# Changelog

All notable changes to `obsidian-mcp-router` (the npm package + Claude Code plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [Unreleased]

Nothing pending right now.

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
