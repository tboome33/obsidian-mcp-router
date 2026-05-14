# Changelog

All notable changes to `obsidian-mcp-router` (the npm package + Claude Code plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

For per-version detail (architecture decisions, alternatives considered, deferred work), see [ROADMAP.md](./ROADMAP.md). This file is the user-facing summary.

## [Unreleased]

Nothing pending right now.

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
