# Roadmap

A living list of what's coming next, ordered roughly by priority.

## ✅ v0.2 — Semantic search (shipped)

Implemented `search_smart` against `POST /search/smart` — a route registered by the companion bridge plugin (`obsidian-mcp-router-bridge`) on top of Local REST API. The router talks pure HTTPS to it; no native binary involved.

- ✅ `search_smart(vault, query, folders?, excludeFolders?, limit?)` — semantic search with cosine scores and breadcrumbs
- ✅ Cross-vault fan-out via `vault: "*"`
- ✅ Graceful error when the target vault lacks the `smart-connections` plugin

The same approach unlocks `/templates/execute` for v0.3.

## ✅ v0.3 — Write operations + Templater (shipped)

The CRUD surface is complete. All writes go through standard Local REST API plugin endpoints; Templater execution goes through the bridge plugin's `/templates/execute` route.

- ✅ `write_file(vault, path, content, ifNew?)` — `PUT /vault/<path>` (create or replace)
- ✅ `append_to_file(vault, path, content, requireExisting?)` — `POST /vault/<path>`
- ✅ `patch_file(vault, path, operation, targetType, target, content, ...)` — `PATCH /vault/<path>` for surgical edits to `heading` / `block` / `frontmatter` targets
- ✅ `delete_file(vault, path, confirm)` — `DELETE /vault/<path>` with explicit confirm guard
- ✅ `execute_template(vault, name, arguments?, createFile?, targetPath?)` — `POST /templates/execute` via the bridge plugin. Templates access router-injected args via `tp.mcpTools.prompt("key")`.

Quirks discovered and documented inline:
- `/templates/execute` validator wants `application/json` with a real object — different from `/search/smart` which expects a stringified-JSON in `text/plain`.
- The PATCH `heading` target must be the **full heading path** joined by the delimiter (default `::`), not just the immediate heading name.
- `tp.mcpTools` is added to `tp` directly, not under `tp.user` — diverges from typical Templater user-script convention.

Deferred to v0.4: `move_file` (no native REST endpoint — needs PATCH-rename or a Get+Put+Delete fallback) and frontmatter helpers (read-modify-write convenience around `patch_file`).

## ✅ v0.4.0 — Frontmatter helpers + move_file + better errors (shipped)

The CRUD surface is now feature-complete for everyday use. Errors are categorized so tools can react sensibly to "vault offline" vs "wrong API key" vs "file not found".

- ✅ `move_file(vault, from, to, overwrite?)` — no native endpoint, fallback GET source → PUT destination → DELETE source. Refuses to overwrite by default; warns if source delete fails post-write.
- ✅ `get_frontmatter(vault, path, key?)` — uses the `application/vnd.olrapi.note+json` content-negotiation of Local REST API to get parsed frontmatter (types preserved).
- ✅ `set_frontmatter(vault, path, key, value)` — wraps `patch_file`. All scalar and structured types supported (string, number, bool, null, array, object).
- ✅ `merge_frontmatter(vault, path, values)` — sequential set per key, returns per-key status (NOT atomic — documented).
- ✅ `RestApiError` class with kinds: `unreachable | timeout | unauthorized | forbidden | cf_access | not_found | conflict | server_error | unknown`. Each kind comes with a `hint` field surfaced to MCP clients in the error response.
- ✅ Manual redirect detection (`redirect: 'manual'` in fetch) so Cloudflare Access redirects are caught and reported as `cf_access` instead of leaking the redirect chain.

Quirk fixed: `Content-Type: application/vnd.olrapi.note+json` wasn't recognized as JSON by the rest-client's content negotiation (was matching only literal `application/json`). Now matches `application/<vendor>+json` too.

Quirk fixed: `patch_file` with `targetType: frontmatter` and a non-string non-object value (number, boolean, null) was sending it as `text/markdown` instead of `application/json`, so Obsidian stored it as a string. Now any non-string value goes through JSON, types preserved end-to-end.

## ✅ v0.4.1 — Onboarding skills (shipped)

Two new conversational skills under [`skills/`](./skills/), installable into `~/.claude/skills/`:

- ✅ `obsidian-router-add-vault` — disambiguates local vs remote, gathers required fields, runs `setup-vault.mjs` for local vaults, edits `config.json` directly for remote vaults, optionally pings the new vault for live verification, refuses to leak secrets to logs.
- ✅ `obsidian-router-status` — calls `list_vaults`, renders a markdown table with online/offline/missingApiKey, then for each unhealthy vault produces a fix hint mapped to the root cause (offline-local vs offline-remote vs cf_access vs unauthorized vs slow).

## ✅ v0.4.2 — Hot reload + small DX (shipped)

The router stops being a "boot once and forget" black box. It now reflects config edits live, supports custom config locations for testing, and lets you mute a vault without deleting its entry.

- ✅ `--config <path>` / `-c <path>` CLI flag for non-default config locations. Also reads `OBSIDIAN_ROUTER_CONFIG` env var. `--help` and `--version` flags added for hygiene.
- ✅ Two ways to disable a vault:
  - Global `disabledVaults: [name1, name2]` array (works for local + remote)
  - Per-remote-vault `enabled: false` flag (only in `remoteVaults` entries)
- ✅ File-watcher on the config file (`fs.watch` with 500ms debounce). When the file changes, the registry reloads atomically — current registry stays in place if the new one fails to parse. Disabled with `--no-watch` or `OBSIDIAN_ROUTER_NO_WATCH` env var. The watcher is `unref()`ed so it never holds the process alive past stdin closure.

## ✅ v0.5.0 — Rebrand cleanup, integrated setup scripts, runtime hardening (shipped)

Removed all references to the previously-required jacksteamdev/mcp-tools dependency and consolidated the multi-vault provisioning into the router repo itself.

- ✅ Default config home moved from `~/.claude/mcp-obsidian/config.json` → `~/.claude/obsidian-mcp-router/config.json`
- ✅ `setup-vault.mjs` and `sync-hook.mjs` now ship inside the repo at `scripts/` (previously lived in the user's Claude home dir)
- ✅ Required vault plugins for bootstrap changed from jacksteamdev/mcp-tools to `obsidian-mcp-router-bridge` (the in-house plugin that registers `/search/smart` + `/templates/execute`)
- ✅ Required Node engine bumped to `>=20.18.1` to match `undici@7`
- ✅ `disabledVaults` registry entries accepted as either vault NAME or PATH (friendlier — users rarely remember the auto-generated name)
- ✅ `fs.watch` error handler so a deleted config dir doesn't crash the server (it disables hot-reload and keeps serving the cached registry)
- ✅ `redactSecrets()` for malformed `remoteVaults` log entries — apiKey and extraHeaders are stripped before logging
- ✅ Bridge-missing 404 on `/search/smart` and `/templates/execute` now surfaces a clear "install obsidian-mcp-router-bridge" hint
- ✅ Cross-vault `search` preserves failing vault names (was `vault: "?"` on rejection)

Audited by Claude Code's `code-reviewer` subagent (8 findings, all fixed) and codex CLI second-opinion (8 additional findings, all fixed).

## ✅ v0.6.0 — Knowledge management skill stack (shipped)

Built a complete Karpathy-style LLM-wiki workflow on top of the router's 14 MCP tools, eliminating the need for an external methodology plugin. The router becomes a single-install solution: plumbing + bridge plugin + knowledge management — three repos under tboome33/, no external deps.

- ✅ **11 skills** under `skills/`: `wiki`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-fold`, `save`, `autoresearch`, `canvas`, `defuddle`, `obsidian-bases`, `obsidian-markdown`
- ✅ **9 slash commands** under `commands/` mapping 1:1 to the skills (the two reference skills `obsidian-bases` and `obsidian-markdown` are surfaced when other skills run, no slash command)
- ✅ **2 sub-agents** under `agents/`: `wiki-ingest` for parallel batch ingestion, `wiki-lint` for read-only diagnostic in an isolated context
- ✅ **Hooks** under `hooks/` (cross-platform Node, fixes the bash-only Windows breakage in prior implementations): `SessionStart`/`PostCompact` load `wiki/hot.md`, `PostToolUse` auto-commits wiki changes to git, `Stop` prompts for hot.md refresh after substantive turns
- ✅ **Templates** under `templates/wiki/` for the scaffolding files (`index.md`, `log.md`, `hot.md`, `overview.md`, `CLAUDE.md`)
- ✅ **Multi-vault aware** by default — every skill takes a `vault` parameter and uses `mcp__obsidian-router__*` tools so it works cross-project (claude-obsidian and similar prior implementations assumed a single "current" vault)
- ✅ NOTICE crediting Karpathy's gist as the methodological source (architectural pattern, not copyrighted) and acknowledging the prior independent implementation by AgriciDaniel/claude-obsidian
- ✅ Marketplace plugin description expanded to surface the new namespace
- ✅ README updated with the knowledge-management section listing all 9 commands + skill descriptions

## ✅ v0.7.0 — Per-workspace default vault resolution (shipped)

The default vault is no longer a single global value. The router now resolves it via a 5-tier cascade so the same tool call (without `vault=`) can target different vaults depending on which directory you launched Claude from.

- ✅ `OBSIDIAN_ROUTER_DEFAULT_VAULT` env var — explicit per-process override (highest priority).
- ✅ `VAULT_PATH` env var matched against `portRegistry` — auto-detection. `setup-vault.mjs` already writes `VAULT_PATH=<vault-path>` into every bootstrapped vault's `.env`, so opening Claude Code in a vault directory now picks up that vault as default automatically.
- ✅ `config.defaultVault` — global default in `~/.claude/obsidian-mcp-router/config.json` (existing behavior, preserved as the third tier).
- ✅ First healthy local vault, then any active vault — historical fallbacks preserved as tiers 4 and 5.
- ✅ Tiny inline `.env` loader added in `bin/obsidian-mcp-router.mjs` (no `dotenv` dependency) so the router auto-loads `.env` from cwd at startup. Existing parent-process env vars win over `.env`.
- ✅ Override warning: if `OBSIDIAN_ROUTER_DEFAULT_VAULT` is set to a name that isn't in the active vault set (typo, vault disabled), the cascade falls through and emits a one-line stderr warning naming the active vaults — so the user notices their override didn't take effect.
- ✅ README EN+FR documents the cascade with three concrete cases (project IS a vault, project ISN'T a vault, project IS a vault but you want a different default) plus a "verify which default the router picked" recipe.

Backward compatible: setups without `OBSIDIAN_ROUTER_DEFAULT_VAULT` and without per-project `.env` resolve exactly as before via tiers 3-5.

## ✅ v0.7.1 — `list_vaults` exposes disabled vaults (shipped)

The `list_vaults` MCP tool used to silently filter disabled vaults from its response — they were tracked in the registry's internal `skipped[]` but never surfaced to MCP clients. Users asking *"which vaults are disabled?"* had no programmatic answer.

- ✅ `list_vaults` response gains a `disabled[]` field. Always returned (even when empty), so callers don't have to special-case the missing-field case.
- ✅ Each entry: `{ name, type, reason }`. Disabled vaults are NOT pinged (no point — they're hidden from the MCP surface, pinging would just add noise).
- ✅ Tool description updated to document the new field.
- ✅ `discover-list-vaults` slash command updated:
   - New EN/FR triggers: "which vaults are active", "which vaults are disabled", "show me all vaults including disabled" / equivalent FR.
   - Rendering instructions now adapt to the user's intent (active only, disabled only, or both).
- ✅ Unit test added in `tests/registry.test.mjs` for the `skipped[]` shape.

Backward compatible: existing callers that only read `vaults[]` ignore the new `disabled[]` field with no impact.

## ✅ v0.8.0 — Lock mode (single-vault isolation) (shipped)

The router used to be implicitly multi-vault for the lifetime of every session. There was no way to say "for this session, refuse anything outside vault X" — and that's a real safety/focus need: client data isolation, per-user routing on a shared install, drift-free long ingestion sessions.

- ✅ New runtime state: `registry.lockedVault` (null = normal multi-vault, name = locked).
- ✅ Two new MCP tools:
  - `lock_vault({ vault, persist? })` — set the lock to a specific vault. Refuses unknown/disabled targets with a clear error. With `persist: true`, writes `OBSIDIAN_ROUTER_LOCKED=<vault>` into `<cwd>/.env` so the lock survives restarts.
  - `unlock_vaults({ persist? })` — clear the lock. With `persist: true`, also removes the line from `<cwd>/.env`.
- ✅ Three ways to lock:
  - MCP tool call (Claude does it on natural language triggers)
  - Slash commands `/obsidian-router:lock <vault>` and `/obsidian-router:unlock` with bilingual NL triggers
  - `OBSIDIAN_ROUTER_LOCKED=<vault>` env var read at startup (typically from project `.env`)
- ✅ Enforcement: implemented as a `applyLockGuard()` monkey-patch on `registry.resolveVault` so EVERY existing tool call site inherits the check without refactoring. Fan-out (`vault: "*"`) is checked explicitly at the call site in `search` and `search_smart` (refuses with `Cannot fan-out: router is locked to vault "<X>"`).
- ✅ Lock state survives config hot-reload — when the router reloads `~/.claude/obsidian-mcp-router/config.json`, the runtime lock is preserved on the fresh registry.
- ✅ `list_vaults` response gains a `lockedTo: <name>|null` field — clients can render the lock state alongside the vault list.
- ✅ Boot log now reports `LOCKED to "<vault>"` when the env var is set at startup.
- ✅ README EN+FR: new "Lock mode (single-vault isolation)" section under "Default vault resolution" — three concrete cases (volatile lock, permanent lock for shared install, switching the lock target) plus the verification recipe via `list_vaults`.
- ✅ Tests: new test suite in `tests/registry.test.mjs` covering lockVault/unlockVaults handlers (set, refuse unknown, persist to .env, clear, idempotent unlock, .env line surgery preserving other entries), plus standalone tests for `upsertDotenvVar` / `removeDotenvVar` helpers.

Backward compatible: setups without `OBSIDIAN_ROUTER_LOCKED` env var, and that don't call `lock_vault`, behave identically to v0.7.1.

## ✅ v0.8.1 — Wiki auto-enrichment Phase 0 (shipped)

The wiki used to passively wait for `/save` invocations. Most users (myself included) forget to invoke it at the moments where it would matter most — right after a decision, right after a result is verified, right at the natural cognitive pivot between topics. Phase 0 makes Claude proactively SUGGEST saves at those three moments. User always confirms (mode `ClaudeAsk` is hardcoded for this phase).

The trigger heuristic is built on signals Claude already produces internally — the same instinct that makes it say "ready to commit?" / "tests pass, push?" — so detection is deterministic and cheap.

- ✅ **Trigger 1 — Validation**: when the user says "OK", "valide", "exactement", or formulates a numbered decision, Claude appends an inline marker `🔖 [pin: <type>/"<one-line>"]` to its response. No interruption. Markers accumulate in context until trigger 2 or 3.
- ✅ **Trigger 2 — Result obtained**: when an action sequence succeeds (commit+push done, tests green, deploy succeeded, user expressed satisfaction at a delivered result), Claude co-locates a digest with its natural transition prompt. Format: numbered candidate list, user picks "all" / "none" / numbers / "skip".
- ✅ **Trigger 3 — Topic switch**: when the user pivots ("autre question", "sinon", "by the way", abrupt domain change), Claude pauses BEFORE responding to the new topic. Mandatory checkpoint marking the cognitive pivot.
- ✅ **Activation gating**: the consigne self-gates on "is a vault bound to this session?" — workspace `.env`, `OBSIDIAN_ROUTER_DEFAULT_VAULT`, or explicit user opt-in. If no vault is bound, the entire consigne is ignored.
- ✅ **Generic across domains**: the trigger types (`decision`, `preference`, `rule`, `adr`, `technique`, `fact`, `url`) work for development, personal life, research, family planning — anything you'd put in a wiki.
- ✅ **Sensitivity filter (manual)**: explicit guidance not to propose saves when the conversation contains client names, identifiers, tokens, financial details, or medical info.
- ✅ **Rate limit**: validation pins are unlimited (lightweight, inline). Digests are capped at 1 per 8 conversation turns.
- ✅ **Placement guide**: new [`docs/auto-enrichment.md`](./docs/auto-enrichment.md) (EN+FR) documenting four channels — vault `CLAUDE.md`, Claude Desktop Project instructions, Memory (identity-based routing), and global `~/.claude/CLAUDE.md`. The Project instructions channel is particularly elegant: a Project on Claude.ai/Desktop is the natural unit for "a domain that maps to a vault" (a "Trading Journal" project always saves to `tradingview`, a "Personal" project always saves to `personal`).
- ✅ **Templates updated**: `templates/wiki/CLAUDE.md` now includes the full Phase 0 consigne. Future vault scaffolds via `/obsidian-router:wiki` get it automatically. The `wiki` skill in `skills/wiki/SKILL.md` now reads the canonical content from the template instead of inlining a divergent simpler version.

Breaking: nothing. The consigne self-gates, so if you don't bind a vault to your session, behavior is identical to v0.8.0.

Migration: existing vaults bootstrapped before v0.8.1 don't have the new section in their `CLAUDE.md`. To activate Phase 0 on those vaults, copy the `## Auto-enrichment (Phase 0 — ClaudeAsk mode)` section from [`templates/wiki/CLAUDE.md`](./templates/wiki/CLAUDE.md) and paste at the bottom of the vault's `CLAUDE.md`. Or re-run `/obsidian-router:wiki` and let the skill detect & insert the missing section.

Phase 1 (planned): persistent mode flag in `.env`, `/obsidian-router:auto-mode <Mode>` slash command, `Hybrid` mode (auto-save type-safe items, ask on high-stakes), `FullAuto` mode with audit log + sensitivity filter + daily digest.

## ✅ v0.8.2 — Auto-enrichment Phase 1 (shipped)

Phase 0 (v0.8.1) hardcoded `ClaudeAsk` mode — Claude proposes, user always confirms. That's the safe default for a calibration period, but for power users who've validated the classifier on their content, the friction of confirming every save becomes the next bottleneck. Phase 1 ships the four modes (`ClaudeAsk` / `Hybrid` / `FullAuto` / `off`) with runtime toggle and `.env` persistence — same architecture as lock mode (v0.8.0), so the patterns compose.

- ✅ **New runtime state**: `registry.autoEnrichMode ∈ { ClaudeAsk | Hybrid | FullAuto | off }`. Default `ClaudeAsk` if `OBSIDIAN_ROUTER_AUTO_ENRICH` env var is absent or invalid.
- ✅ **New MCP tool**: `set_auto_enrich_mode({ mode, persist? })`. Validates the mode (rejects unknown with the list of valid values), canonicalizes case-insensitive input + a small alias set (`ask` → `ClaudeAsk`, `auto` / `full-auto` → `FullAuto`, `semi` / `hybride` → `Hybrid`, `none` / `disable` → `off`). With `persist: true`, writes `OBSIDIAN_ROUTER_AUTO_ENRICH=<mode>` into `<cwd>/.env`. Special case: `mode: "off"` with `persist: true` REMOVES the env var line entirely (avoids the ambiguity of an env-var-set-to-"off" needing handling at boot).
- ✅ **New slash command**: `/obsidian-router:auto-mode <Mode>` with bilingual NL triggers (EN: *"switch to Hybrid mode"*, *"save everything automatically"* → FullAuto, *"stop auto-saving"* → off; FR: *"passe en mode Hybrid"*, *"sauve tout automatiquement"*, *"arrête de sauver auto"*). Use cases per mode documented in the command description so Claude can map vague NL ("I want auto-save for this kind of session") to the right mode.
- ✅ **`list_vaults` extended**: response gains a fifth field `autoEnrichMode: <mode>` so callers can render the current mode alongside vault list / lock state.
- ✅ **Validation helper**: `validateAutoEnrichMode(candidate, context)` mirrors `validateLock`'s pattern — falls back to `ClaudeAsk` with a stderr warning when the env var is invalid (typo, removed mode), AND on hot-reload preserve when the in-memory mode is somehow corrupted. Friendly failure mode: never bricks the router on a bad value.
- ✅ **Hot-reload preserves the mode**: when `~/.claude/obsidian-mcp-router/config.json` reloads, the runtime mode survives onto the fresh registry (revalidated on the way through).
- ✅ **Boot log** mentions the mode when non-default: `Auto-enrich mode: <mode>` after the vault summary. Quiet by default for the common case.
- ✅ **Homedir refusal**: same `samePath()` Windows-case-insensitive guard as `lock_vault` — `set_auto_enrich_mode({ persist: true })` from `~` is refused with a friendly error pointing to shell-profile alternatives. The in-memory mode applies regardless.
- ✅ **Consigne updated**: `templates/wiki/CLAUDE.md` now expresses behavior per mode for each of the three triggers (validation pin, result digest, topic-switch checkpoint), plus the FullAuto safety nets (sensitivity filter, hard cap of 5 auto-saves/session degrading to ClaudeAsk, audit log in `wiki/log.md` with `[auto-save]` prefix).
- ✅ **Tests**: 19 new test cases in `tests/registry.test.mjs` covering `canonicalizeMode` (exact / case-insensitive / alias / null / whitespace), `validateAutoEnrichMode` (env + preserved contexts, fall-through on invalid), `setAutoEnrichMode` handler (set, canonicalize, reject unknown, persist, persist-off-removes-line, preserve-other-env-entries), and homedir refusal. Total: 83/83 tests passing.
- ✅ **Documentation**: README EN+FR auto-enrichment callout extended with the 4-mode table + use cases. `docs/auto-enrichment.md` extended with detailed use-case sections per mode (when to pick each, trade-offs, calibration progression: `ClaudeAsk` → `Hybrid` → `FullAuto`).

Backward compatible: setups without `OBSIDIAN_ROUTER_AUTO_ENRICH` env var that don't call `set_auto_enrich_mode` get `ClaudeAsk` (the v0.8.1 default behavior) — identical to before.

Phase 2 (planned): daily digest of yesterday's auto-saves at first interaction of the day; configurable hard cap (per-vault, not hardcoded 5); sensitivity filter learned from user corrections (when user deletes an auto-saved page within X minutes, the classifier remembers the pattern).

## ✅ v0.8.3 → v0.10.0 — see CHANGELOG.md

This ROADMAP.md tracks the original feature plan. Versions v0.8.3 through v0.10.0 shipped substantial work (auto-enrichment Phase 2 polish, conventions library, multi-tenant env vars for MCPHub, `defaultVaultStatus`, etc.) that **isn't backfilled here** — see [`CHANGELOG.md`](./CHANGELOG.md) for the per-version detail. The forward-looking `v0.9` / `v1.0` sections below describe the ORIGINAL planned features (Cloudflare Tunnel, public release), which still apply but ended up downstream of what actually shipped in those slots.

## ✅ v0.10.1 — Roadmap-discipline §2bis + no-task-strikethrough CSS snippet + `--sync-all` (shipped 2026-05-21)

Two-layer fix for the "checked roadmap items get visually striked through" problem: a markdown convention §2bis that forbids `~~...~~` on shipped items, AND an Obsidian CSS snippet that kills the default-renderer line-through styling on `- [x]` task items. Plus tooling to push both to all vaults in one command.

- ✅ Convention `roadmap-discipline` extended with **section 2bis "Lisibilité — JAMAIS de strikethrough sur les items livrés"** ([`skills/conventions/snippets/roadmap-discipline.md`](./skills/conventions/snippets/roadmap-discipline.md)). Forbids `~~...~~` on item text / phase H2 / trailing note. Retroactive cleanup directive (mention + ask before stripping).
- ✅ CSS snippet `no-task-strikethrough.css` shipped in [`templates/reference-vault-skeleton/.obsidian/snippets/`](./templates/reference-vault-skeleton/.obsidian/snippets/no-task-strikethrough.css) — disables `text-decoration: line-through` across all 3 Obsidian modes (Reading view, Live Preview, Source), covers Default + Minimal + Prism + AnuPpuccin themes via standard selectors + `--checklist-done-decoration` CSS variable.
- ✅ Skeleton `appearance.json` ships with `enabledCssSnippets: ["no-task-strikethrough"]` pre-active.
- ✅ `setup-vault.mjs` gains `cloneSnippets()` + `enableSnippetsInAppearance()` — every new vault and every `--sync-plugins` call now copies the snippets and enables them in `appearance.json`. Idempotent.
- ✅ **New CLI option `--sync-all`** in `setup-vault.mjs` — iterates `portRegistry` and runs `--sync-plugins` on every configured vault in one go. Variant `--sync-all --force` for pushing a snippet/plugin update to all vaults at once.
- ✅ Convention copy in user-global `~/.claude/CLAUDE.md` updated with the same §2bis. Wiki [[router-conventions]] catalog page updated FR + EN.

Trigger: Roland *"quand dans une roadmap tu marques que section est déjà réalisée, est ce que tu peux seulement faire un check sur la case à cocher mais ne pas rayer tout le texte sans quoi on a du mal à relire"* followed by *"j'ai encore des textes de rayés"* after discovering Obsidian's default render style was producing the line-through visually even with clean markdown.

Application directe de la règle `roadmap-discipline` v0.10.1 elle-même : cette entrée ROADMAP.md cochée AVANT commit.

## ✅ v0.11.0 — Conversion tools (markdownify-mcp vendor port) (shipped 2026-05-22)

The router gains a 10-tool family that turns binary sources (PDF, DOCX, XLSX, PPTX, image, audio, YouTube transcript, Bing search results, generic webpages, git repos) into clean markdown. JS/ESM port of [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT) — see `NOTICE` for the vendor credit + license text.

**Why ship this inside the router** rather than register markdownify-mcp as a sibling MCP server: the vault is the artifact destination. The router's whole job is "land structured markdown in Obsidian". Conversion is the missing pre-step before `write_file` — and bundling it makes the router useful to **non-Claude MCP clients** (Cursor, Cline, Continue, Goose, custom clients) that have no native PDF/DOCX/audio reading.

- ✅ **10 new MCP tools** (snake_case to match router convention):
  - File inputs: `pdf_to_markdown`, `docx_to_markdown`, `xlsx_to_markdown`, `pptx_to_markdown`, `image_to_markdown`, `audio_to_markdown`
  - URL inputs: `youtube_to_markdown`, `bing_search_to_markdown`, `webpage_to_markdown`
  - Git repos: `git_repo_to_markdown` (via [`repomix`](https://github.com/yamadashy/repomix))
- ✅ **JS/ESM port** of the upstream TypeScript implementation — no Bun, no build step, fits the router's `*.mjs` architecture. Lives at `src/markdownify/utils.mjs`, `src/markdownify/markitdown.mjs`, `src/tools/convert.mjs`.
- ✅ **Postinstall bootstraps the Python venv**: `scripts/install-markitdown.mjs` detects `python3` / `python` (3.10+), creates `<repo>/.venv`, pip-installs `markitdown[all]>=0.1.5`. **Never fails npm install** — if Python is missing or pip can't reach PyPI, logs a clear warning and exits 0. The conversion tools then throw a friendly "markitdown not found" error at call time. Skip with `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` or `npm install --ignore-scripts`.
- ✅ **Inline `private-ip` replacement**: the upstream depends on the `private-ip` npm package for the SSRF guard. The port reimplements it inline (~25 lines, covers loopback / RFC1918 / link-local / CGNAT / `.local` mDNS / `.localhost`) — keeps the router's runtime dep list small.
- ✅ **`MD_ALLOWED_PATHS` sandbox**: opt-in env var that whitelists which directories the file-input conversion tools are allowed to read. `:`-separated on POSIX, `;`-separated on Windows. Unset = no sandbox. Path-segment comparison so `/data/foobar` is NOT inside `/data/foo`.
- ✅ **`MARKITDOWN_PATH` / `REPOMIX_PATH` env vars**: override the bundled venv / `node_modules/.bin` lookups when the user has a system-wide install.
- ✅ **Not classified as write tools**: the 10 conversion tools are NOT in `WRITE_TOOL_NAMES`, so `OBSIDIAN_ROUTER_READONLY=true` deployments keep them exposed (they're read-only by nature — they don't touch any vault).
- ✅ **NOT vault-routed**: conversion tools don't take a `vault` argument; they return the markdown string and let the caller decide where to land it (typically `write_file` or a skill like `wiki-ingest`). Atomic, composable MCP design.
- ✅ **Excluded `get-markdown-file`** from the upstream tool list — redundant with the router's existing `get_file`.
- ✅ **NOTICE updated** with the full MIT license text from markdownify-mcp + Microsoft `markitdown` Python CLI attribution.
- ✅ **11 new unit tests** in `tests/markdownify.test.mjs` covering pure helpers (SSRF guard for loopback/RFC1918/link-local/CGNAT, MD_ALLOWED_PATHS sandbox with path-segment comparison, repo-URL validation, HTML-detection heuristic) and the boot-time TOOLS / TOOL_HANDLERS surface (all 10 tools registered, all 10 have handlers, none classified as write tools). Total: 284/284 passing.
- ✅ **README updated**: new "Conversion tools — runtime dependencies" section documenting Python prerequisite, postinstall flow, env vars, and the bypass options.
- ✅ **`.gitignore`** updated to exclude `.venv/`.

Backward compatible: existing setups that don't call any `*_to_markdown` tool see no behavior change. The 10 new tools surface in `list_tools` but don't conflict with anything. The new `repomix` dep installs alongside the existing two (no peer-dep collisions checked at the npm level).

Trigger: user explicitly asked to absorb the markdownify-mcp tool surface into the router, with three deliberate sub-choices: port to `.mjs` (vs. adding a TS build step or vendoring TS directly), bundle the Python venv at postinstall (vs. requiring manual `pipx install`), and return markdown text only (vs. auto-writing into the vault). Each choice trades upstream-sync ease for router-architecture coherence.

## v0.9 — Cloudflare Tunnel companion plugin

A separate **Obsidian community plugin** that provisions a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for the local vault's REST API. Goal: the user clicks a button in Obsidian, the vault becomes reachable from anywhere via a stable HTTPS URL, with optional auth.

### Why

Today, the only secure ways to reach a remote Obsidian vault are:
- Tailscale (great, but requires Tailscale on every client)
- Reverse proxy + Let's Encrypt (works, but needs a public IP and DNS)
- VPN (heavy, configurable per OS)

Cloudflare Tunnel gives you a public HTTPS URL on `*.trycloudflare.com` (or your own domain) without opening any firewall port, without static IPs, and with optional Cloudflare Access in front. For a personal "iPad reads laptop's vault from a café" workflow, this is the lowest-friction option.

### Sketch

The plugin would:

1. Bundle (or download) the `cloudflared` binary on first activation, with platform detection.
2. Expose Obsidian Local REST API on `127.0.0.1:<port>`.
3. Spawn `cloudflared tunnel --url https://localhost:<port> --no-tls-verify` (because the plugin's cert is self-signed inside the tunnel — Cloudflare terminates real TLS at the edge).
4. Capture the assigned public URL (e.g. `https://random-words.trycloudflare.com`) and surface it in the plugin settings panel with copy-to-clipboard.
5. Optional: enable Cloudflare Access policies (email-pinned, OTP, or service-token auth) declaratively from the plugin settings.
6. Optional: write the tunnel URL + API key into `obsidian-mcp-router`'s `config.json` `remoteVaults` array, so the router picks it up automatically on next restart.

### Auth modes to support

| Mode | Use case |
|---|---|
| **None** (Bearer token only) | Trusted personal usage, ephemeral demos. Risky if URL leaks. |
| **Cloudflare Access — email OTP** | Personal multi-device, no enterprise plan needed (free tier supports up to 50 users). |
| **Cloudflare Access — service token** | Headless clients (CI, scripts, the router on another machine). |
| **Cloudflare Zero Trust mTLS** | Paranoid mode for shared/team vaults. |

### Where it lives

A separate repo: `tboome33/obsidian-cloudflare-tunnel-plugin`. Built with the standard Obsidian plugin template, written in TypeScript, distributed via the Community Plugins store once stable.

### Why a plugin and not a script

- Keep the user in the Obsidian UI (no terminal dance).
- Plugin lifecycle ties tunnel start/stop to Obsidian start/stop — no orphan processes.
- Surface tunnel URL right where it's needed.
- Settings panel is the natural home for auth configuration.

## v1.0 — Stable release

Criteria:
- All Local REST API endpoints covered or deliberately excluded
- Skill-based install validated on a fresh machine
- README polished, contribution guide
- Repo public on GitHub
- Possibly published as `@tboome33/obsidian-mcp-router` on npm

## Beyond v1.0 — Possible directions

- **Cross-vault Smart Connections**: collapse the per-vault `obsidian-mcp-router-bridge` integration into a router-level facade so `search_smart` returns merged ranked results across multiple vaults at once (currently a fan-out with per-vault scores).
- **Cross-vault Templater**: same idea for template execution — a single template available from any vault via the router.
- **Operation log**: per-vault append-only log of mutations the router performed, for audit and undo.
- **Read-only mode**: per-vault flag that rejects all write tools (useful for a "reference" vault you don't want Claude editing).
- **Vault federation**: aggregate multiple local-only vaults into a virtual "super-vault" for cross-vault links and search.
