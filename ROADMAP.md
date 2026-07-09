# Roadmap

A living list of what's coming next, ordered roughly by priority.

## ✅ v0.39.0 — `pdf_to_images`: render PDF pages for the model to SEE (shipped 2026-07-09)

New tool `pdf_to_images` renders a local PDF's pages to PNG images and returns them as **MCP image content blocks**, so the model can visually SEE a page — complementing the text-extracting `pdf_to_markdown` / `pdf_to_markdown_docling`. Rendering via **pypdfium2** (PDFium/Google, BSD) + Pillow, both already in `.venv-docling` (the Docling extra) — NOT poppler (GPL) or MuPDF (AGPL). Delivers the borrowings-roadmap §2.14 idea.

- **Image delivery, finally proven.** The router's first non-text tool result: `wrapResult` gained an `isMcpContentPayload` pass-through so a ready `{content:[{type:'image',…}]}` payload survives untouched. The base64-image-delivery contract that `video_to_markdown` (claude-watch §2.11) flagged as unproven is now real and tested.
- **Bounded by design.** Images are token-expensive → hard caps: `max_pages` default 8 / ceiling 30, `scale` 2.0 clamped 0.5–4.0, per-image 12 MB + total 24 MB (refused before the read). Same "don't ship megabytes of base64" lesson as Docling's placeholder default.
- **Sandbox + injection guards** reused from the conversion family (`MD_ALLOWED_PATHS`, `--` argv separator). TDD: 24 new tests; full suite 2070 green. Verified end-to-end: rendered a real 6-page PDF and viewed the page.

## ✅ v0.37.1 — Docling: placeholder image export + local-path validation (shipped 2026-07-08)

`pdf_to_markdown_docling` now runs Docling with `--image-export-mode placeholder` by default. Docling's default (`embedded`) inlines every figure as a base64 data-URI — on an illustrated PDF that dwarfs the text (a 4-page course sheet → 3.3 MB output, 99.6% base64, for ~14 KB of real text) and can hit the `MAX_OUTPUT_BYTES` cap for no readable gain. Figures now become `<!-- image -->` markers: text-only, vault-friendly, ×228 smaller on that document; table structure and reading order are still reconstructed. `buildDoclingArgs` + regression test in `tests/docling-markdownify.test.mjs`.

- **Local install path validated on Windows.** The real self-hoster route — `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` + `npm run install-docling` — was exercised end-to-end: a **1.3 GB** `.venv-docling` (CPU-only torch on Windows/macOS; Linux's default torch wheel bundles CUDA → ~5.5 GB), `resolveDoclingPath` discovers the venv with no `DOCLING_PATH`, and a real conversion returned the placeholder output. README updated with the OS-dependent size + a "figures are not embedded" note.

## ✅ v0.37.0 — Docling opt-in high-fidelity PDF conversion (shipped 2026-07-07)

New in-process conversion tool `pdf_to_markdown_docling` (+ `/pdf-to-markdown-docling` and `/pdf-to-markdown` slash commands). Runs [Docling](https://github.com/docling-project/docling)'s standard pipeline (layout + TableFormer) for PDFs with complex tables / multi-column layouts, where MarkItDown's `pdfminer.six` backend does plain text-stream extraction with no structure (88% vs 82% F1 on document extraction). Scoped to PDF only — DOCX/PPTX/XLSX keep MarkItDown (Docling's models are PDF-first, no demonstrated advantage there).

- **Opt-in, in-process, separate venv.** Mirrors the MarkItDown wrapper (`scripts/install-docling.mjs` ⇄ `scripts/install-markitdown.mjs`, `src/markdownify/docling.mjs` ⇄ `markitdown.mjs`). Postinstall is a NO-OP unless `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` is set before `npm install` (Docling pulls ~1-2 GB of torch/onnxruntime + models, ~10× slower than MarkItDown). Installs into `.venv-docling` — never mixed with the MarkItDown `.venv`.
- **Always listed, degrades gracefully.** The tool is advertised even when Docling isn't installed; a missing binary yields an actionable call-time hint (`OBSIDIAN_ROUTER_ENABLE_DOCLING=1` / `npm run install-docling` / `DOCLING_PATH`). Never fails `npm install`, never crashes at boot. No silent fallback to MarkItDown.
- **Env vars:** `OBSIDIAN_ROUTER_ENABLE_DOCLING` (opt-in gate), `DOCLING_PATH` (system-wide override).
- **Tests:** `tests/docling-markdownify.test.mjs` (resolver, argv `--` injection guard, wrapper happy path via injected runner, ENOENT hint, tool registration) + `tests/install-docling.test.mjs` (opt-in predicate). Full suite green.
- **Docs:** README (capability tables EN+FR, runtime-deps section, env-var table), CHANGELOG, design spec `docs/superpowers/specs/2026-07-07-docling-pdf-integration-design.md`.

## ✅ v0.19.0 — self-healing session reconciliation (shipped 2026-05-29)

Closes the `wiki-meta/log.md` ↔ `wiki-meta/Sessions/` desync. `session-auto-journal` wrote the journal incrementally but *finished* a session (status flip → `closed`, recap, **log.md line**) only in its `SessionEnd` handler. Claude Code does not guarantee `SessionEnd` (abrupt terminal close, kill, crash, OS shutdown), so crashed sessions stayed `status: open` forever with no log line — a Sessions/ file with no chronological summary. Observed on a live vault: 16/16 `closed` sessions logged, 0/11 `open` ones.

- **`hooks/_helpers/session-reconcile.mjs`** — `reconcileVaultSessions()`, the shared routine that both the hook and the backfill script call (single source of truth). Closes stale open orphans in place + backfills their log line; also handles closed-but-unlogged (pre-v0.12.8). Idempotent (dedup by `[[basename]]`), already-logged files fast-skipped (no read).
- **Reconcile on `SessionStart`, not a daemon.** The hook self-heals at the next session start — the cheapest reliable trigger we already own. Alternatives rejected: a background watcher (adds a long-lived process + cross-platform service plumbing for a rare event); reconciling on `Stop`/`PostToolUse` (too frequent, adds per-turn latency).
- **Liveness via the state-JSON mtime, not file mtime.** The per-session state JSON is rewritten on every prompt/tool, so its mtime is a precise "last alive" signal; an open session fresher than the live window (default 120 min, `OBSIDIAN_ROUTER_SESSION_LIVE_WINDOW_MIN`) is left alone so a concurrent terminal isn't clobbered. File mtime was rejected — legit recent writes (sync, edits) would read as "live" and block repair. The current session is additionally protected by path.
- **`backfill-log-from-sessions.mjs --include-open`** (+ `--live-window-minutes`, `--all`) — explicit one-shot repair for existing vaults. Existing closed-only default unchanged.
- **Tests**: `tests/session-reconcile.test.mjs` (19 cases — orphan close+log, liveness skip, current-session skip, closed-unlogged, dedup/idempotence, dry-run, missing scaffolds, hook + backfill integration). Full suite 1518 green.
- **Docs**: CHANGELOG [0.19.0]; hook + script + module headers.

## ✅ v0.16.0 — MCPHub deployment support + family-vault member routing (shipped 2026-05-27)

Tooling + conventions to deploy the router on **MCPHub** in multi-tenant "hybrid bypass" mode (router server-side on a NAS, vault data client-side reached over WireGuard) and to run a **shared family vault** with per-member auto-routing. Validated end-to-end against a live MCPHub on a QNAP: a `write_file` from Claude Code travelled Claude Code → MCPHub → spawned router container → WireGuard tunnel (~137 ms) → Obsidian REST API on the originating PC → file persisted + audit log written. Offline resilience also validated (MCPHub server disabled → graceful `Server not found` while the local router + Obsidian stay fully usable at 56 ms, single-source-of-truth so zero divergence).

- **`scripts/build-mcpb.ps1`** — bundles the router into a `.mcpb` for MCPHub. Robocopy staging (excludes `.git`/`node_modules`/`tests`/`.venv`/`.claude`/`worktrees`/`.vault-meta`/`.env*`/`*.mcpb` **and the gitignored secret config `config.json`/`config.local.json`** so credentials never ship), `npm ci --omit=dev --ignore-scripts` (hermetic — skips the markitdown Python venv postinstall), `manifest.json` with `server-`-prefixed container path + templated env placeholders, `Compress-Archive`. `-Clean` flag for fresh rebuild.
- **`who-is-speaking` skill + slash command** — identifies the family member speaking (matches name/aliases from the vault `CLAUDE.md` table), then `lock_vault` + `set_auto_enrich_mode(Hybrid)` so saves route to `wiki/People/<member>/`. Bilingual triggers, refuses to guess, supports mid-session re-identification.
- **`tribu-routing` installable convention** — codifies the family-member routing pattern (private `wiki/People/<member>/` vs collective `wiki/Family/`, sensitivity guard against auto-saving medical data). Generic + reusable; member list lives per-vault in `CLAUDE.md`.
- **Conventions mapping table** refreshed 8 → 10 (added `claim-citations` + `tribu-routing`).
- **`.gitignore`** excludes `mcpb-staging/` + `*.mcpb`.

Deployment gotchas captured (see CHANGELOG for detail): `MD_ALLOWED_PATHS` is mandatory in multi-tenant mode; the config env var is `OBSIDIAN_ROUTER_CONFIG` (not `_PATH`); remote vault over WG needs `bindingHost: 0.0.0.0` on the originating PC's Local REST API.

Full session record: `mcphub-hybrid-bypass-roadmap` in the companion vault `opsidian-mcp-router et bridge`.

## ✅ v0.15.0 — llm-wiki-compiler emprunts (6 features, shipped 2026-05-27)

Six features inspired by [`atomicstrata/llm-wiki-compiler`](https://github.com/atomicstrata/llm-wiki-compiler) (another standalone Karpathy LLM Wiki implementation, MIT, 1.3k ⭐). Decided one by one with the user after an interactive review of the 7 candidate patterns. **6 accepted + 1 rejected.** See the source roadmap in the linked vault `opsidian-mcp-router et bridge` at `wiki/Divers/LLM-WIKI-COMPILER/llm-wiki-compiler-roadmap.md`.

Shipped this release :

1. **Line-level citations** `^[file.md:42-58]` — markers at paragraph end pointing to exact source lines. New `wiki-lint` Check H (`claim-range-validity`) + new installable convention snippet `claim-citations`. (commit `34c7cbb`)
2. **`wiki-export` skill + `/wiki-export` slash command** — aggregates a vault to `llms.txt` (compact, [llmstxt.org](https://llmstxt.org) standard) or `llms-full.txt` (with page bodies inlined). Helper `src/helpers/llms-txt-exporter.mjs` (pure, no I/O) + 32 tests. JSON/JSON-LD/GraphML/Marp targets deferred. (commit `d883a3b`)
3. **`get_wiki_context_pack` MCP tool with v1 JSON envelope** — structured JSON context for a query, instead of the prose returned by `wiki-query`. Enables non-Claude agents (Cursor, MCPHub multi-agent, scripts) to consume the router programmatically. Versioned v1, additive-only. Dependency-injection pattern for tests. 55 tests. (commit `b84f7bc`, shipped by background Backend Architect agent)
4. **Hash-based incremental ingest** — SHA-256 of source content (post-defuddle for URLs) stored in `wiki-meta/ingest-state.json`. Re-ingesting unchanged source is a no-op (no fetch, no LLM call). URL normalisation strips utm_*/fbclid/gclid/etc. Atomic state file writes. 40 tests. (commit `efd7aac`)
5. **Digest sidecars + `wiki-lint --deep` mode + `/wiki-refresh-digests` skill** — every wiki page gets a compact digest at `wiki-meta/digests/<slug>.md` (concepts/claims/keywords/summary/page-hash). New deep-lint Checks I/J/K/L detect digest staleness, redundant concepts, contradictions, missing wikilinks. Reformulation (user proposal) of llmwiki's two-phase compile pattern as additive sidecars instead of structural refactor. 39 tests. (commit `6106665`)
6. **Consolidation** — version bump 0.14.9 → 0.15.0. (commit `bc07a6b`)

**Tests** : 1165 → **1331 passing** (+166, zero regression).

**Post-ship review+ pass 1 + pass 2 hardening** : multi-agent review (Claude `Code Reviewer` + `codex review` CLI) surfaced 9 IMPORTANT findings (3 SECURITY + 5 logical bugs + 1 perf) + several NITs. All addressed across 5 dedicated fix commits with regression tests :
- `f8cf898` YAML injection safety in `digest-generator` (8 new regressions)
- `c86df4b` Path traversal guard + error handling in `get_wiki_context_pack` (10 new regressions)
- `a4c7558` URL credentials + tokens strip in `ingest-state.normaliseUrl` (9 new regressions)
- `e1f14e7` `digestPathForPage` canonical helper + Check H resolver (9 new regressions)
- `508c135` Wikilink alias + duplicate H2 + corruption recovery (12 new regressions)

Post-hardening test count : **1374 passing** (+43 from pure regressions). Decisions deliberately deferred to a later release : #3 agent-de-veille proactif (depends on #4 + #7' being stable in production first).

Decisions rejected (with reason captured in source roadmap) :
- #2 frontmatter épistémique (`confidence` numeric + `contradictedBy`) — already 80% covered by the existing `source-type` convention with 3 qualitative buckets + native Obsidian callouts.
- #7 two-phase compile structural refactor — replaced by #7' (digest sidecars additive layer, lower cost + risk).

## ✅ v0.12.2 — Verification + multi-location CLAUDE.md rewrite (Session 3, shipped 2026-05-23)

Session 3 ferme l'arc v0.12.0 (3 sessions). Audit complet des 9 vaults migrés, conclusion : aucune dérive textuelle dans les CLAUDE.mds, le path swap de v0.12.1 + l'install précédente de v0.11.6 ont déjà tout aligné. Refresh des conventions = no-op. Verification end-to-end OK (le hook `wiki-query-first-nudge` a fired correctement en mode workspace-bound dans la session de verification).

### Findings audit

- **8/9 vaults** ont une CLAUDE.md, **tous propres** : 0 stale `wiki/<scaffold>.md` paths + 6 mentions workspace-bound (v0.11.6 convention déjà installée).
- **1 vault** (SCI) n'a pas de CLAUDE.md — par choix de Roland (deleted in previous audit).
- **wiki/ dirs** : 7/9 vaults n'en ont plus (cleanés post-migration), 2/9 préservés correctement avec user content (DEDIBOX = `wiki/Refs/`, project-router = `wiki/obsidian-mcp-router/`).
- **CLAUDE.md placements détectés** : 4 vaults sous `Documentation/CLAUDE.md`, 4 vaults sous `wiki-meta/CLAUDE.md`. Pattern non-standard mais cohérent.

### Code changes

- ✅ **`rewriteClaudeMdScaffoldPaths()` étendu** — scan 3 emplacements communs (`<vault>/CLAUDE.md`, `<vault>/wiki-meta/CLAUDE.md`, `<vault>/Documentation/CLAUDE.md`). Returns total replacement count across all copies. Défensif pour les vaults futurs qui auraient un CLAUDE.md non-standard. Idempotent + backward-compatible.
- ✅ **3 nouveaux tests** dans `tests/migrate-wiki-meta.test.mjs` : rewrite dans wiki-meta/CLAUDE.md, dans Documentation/CLAUDE.md, et across multiple copies en une seule run avec count cumulé.

Tests: **434/434 ✅** (was 431 at v0.12.1 ; +3).

### Arc v0.12.0 — closed

3 releases sur 2026-05-23 :
- **v0.12.0** — code refactor (clean break) + templates moved + tests + docs.
- **v0.12.1** — migration script + run sur 10 vaults (9 migrés, 1 skipped).
- **v0.12.2** — verification + multi-location CLAUDE.md fix.

Layout `wiki-meta/` (scaffolds) vs `wiki/` (user content) est désormais la convention établie. Futurs scaffolds + conventions atterrissent dans `wiki-meta/` ; notes utilisateurs restent sous `wiki/`.

## ✅ v0.12.1 — Migration script + run sur les 10 vaults (Session 2, shipped 2026-05-23)

Session 2 du rollout phasé v0.12.0. Ferme la "broken window" laissée à v0.12.0 : les 10 vaults existants étaient sur l'ancien layout `wiki/<scaffold>.md` et les hooks `hot-cache-load` + `wiki-query-first-nudge` y étaient silencieux. Cette release ship le script de migration + run.

- ✅ **`setup-vault.mjs --migrate-wiki-meta <vault-path>`** — migration single vault. Détecte 5 états (`legacy`/`fresh`/`partial`/`empty`/`no-vault`), refuse `partial` avec diagnostic clair, no-op sur `fresh` (sauf `--force`). Pour `legacy` : `mkdir wiki-meta/`, déplace les 4 scaffolds via `git mv` (si vault est un git repo, preserve history + auto-stage) ou `fs.rename` sinon, réécrit `wiki/(hot|index|log|overview)\.md` → `wiki-meta/$1.md` dans le `CLAUDE.md` du vault, append une ligne migration au `wiki-meta/log.md` post-déplacement.
- ✅ **`setup-vault.mjs --migrate-all-wiki-meta`** — form batch sur `portRegistry`. Reporting per-vault + summary final + exit 1 si échec. Flags partagés : `--dry-run` (preview), `--force` (re-rewrite CLAUDE.md sur fresh vaults).
- ✅ **`tests/migrate-wiki-meta.test.mjs`** — 15 tests : branche plain-rename + branche git-mv (avec real `git init` fixtures), CLAUDE.md rewrite (preserve les paths user-content `wiki/Concepts/...`), idempotency, `--force`, `--dry-run`, batch summary, partial-state refusal, empty-state skip, missing-arg + non-existent + empty-portRegistry errors.
- ✅ **Migration tournée sur 10 vaults Roland** : 9 migrés (1 via git, 8 via fs.rename), 1 skipped (Coursera, never bootstrapped via `/obsidian-router:wiki`). Total : 36 scaffolds déplacés + 251 CLAUDE.md path replacements.
- ✅ **Vault cascade** : `router-changelog.md` (nouvelle section v0.12.1 + row TOC) + `wiki-meta/log.md` (auto via migration script). Frontmatter `project-router.md` bumpé.

**Broken-window v0.12.0 fermée** : `hot-cache-load` et `wiki-query-first-nudge` reprennent leur opération normale sur les 9 vaults dès la prochaine session start.

Tests: **431/431 ✅** (was 416 at v0.12.0 ; +15 du nouveau fichier `migrate-wiki-meta.test.mjs`).

Reste pour Session 3 (v0.12.2) :
- Vérification end-to-end (re-test du flow `wiki-query-first-nudge` sur 2-3 vaults migrés)
- Re-install des conventions installables (`wiki-query-first`, `roadmap-discipline`) pour propager les autres updates récentes (le path rewrite des scaffolds est déjà fait par v0.12.1 lui-même)
- Cleanup éventuel (dirs `wiki/` vides s'il y en a)

## ✅ v0.12.0 — Move scaffolds to `wiki-meta/` (Session 1, shipped 2026-05-23)

**BREAKING** — les 4 fichiers `wiki/{hot,index,log,overview}.md` quittent `wiki/` pour `wiki-meta/`. Le contenu utilisateur (notes, people, concepts, …) reste sous `wiki/`. Clean break côté code : aucun fallback vers l'ancien layout.

Trigger Roland 2026-05-23 : *"les 4 fichiers hot, index, log et overview sont dans chaque vault dans le repertoire wiki, j'aimerai les sortir de ce répertoire pour les placer dans un repertoire autre du reste du vault car je trouve que ce sont plus des fichiers de configuration ou une mémoire que le contenu du vault en lui même"*. Le mélange scaffold/contenu encombrait la vue Obsidian — la séparation rend la frontière sémantique visible.

### Rollout phasé (3 sessions)

- ✅ **Session 1 (v0.12.0)** — code refactor + tests verts + templates physiquement déplacés (CETTE entrée).
- 🚧 **Session 2 (v0.12.1)** — `setup-vault.mjs --migrate-wiki-meta <vault>` + `--migrate-all-wiki-meta`. Migration atomique via `git mv` + édition du `CLAUDE.md` de chaque vault. Run sur les 10 vaults de Roland.
- 🚧 **Session 3 (v0.12.2)** — re-install des conventions installables (`wiki-query-first`, `roadmap-discipline`) sur chaque vault pour mettre à jour les paths dans leur `CLAUDE.md` per-vault. Vérification end-to-end.

Entre Session 1 et Session 2, les vaults non migrés sont silencieux côté hooks (`hot-cache-load` et `wiki-query-first-nudge` sortent en exit 0 parce que `wiki-meta/index.md` n'existe pas). Coût accepté du clean break.

### Session 1 — fait

- ✅ **`hooks/_helpers/workspace-vault.mjs` `detectVaultContext()`** — probe `wiki-meta/index.md` au lieu de `wiki/index.md`. Cwd-is-vault ET workspace-bound affectés.
- ✅ **`hooks/hot-cache-load.mjs`** — lit `<vault>/wiki-meta/hot.md`. Marker text en mode workspace-bound mis à jour.
- ✅ **`hooks/wiki-query-first-nudge.mjs`** — les 4 entry points cités dans le nudge sont `wiki-meta/{hot,index,log,overview}.md`. Guidance read mode-aware couvre les DEUX préfixes (`wiki-meta/<scaffold>` pour les meta, `wiki/<page>` pour le contenu utilisateur).
- ✅ **`hooks/hot-cache-update-prompt.mjs`** — trigger scanne `wiki/` ET `wiki-meta/` (git diff + git log sur les 2 paths). Nudge dit "update `wiki-meta/hot.md`".
- ✅ **`hooks/wiki-autocommit.mjs`** — ajout de `wiki-meta` à `trackedDirs`. Sinon scaffold edits (notamment refresh hot.md) tomberaient hors autocommit.
- ✅ **`hooks/vault-link-linter.mjs`** — docstring examples mis à jour ; logique runtime inchangée (le linter matche tout `.md` dans un vault, ne dépend pas du préfixe).
- ✅ **`scripts/setup-vault.mjs --link-workspace`** — validation requiert maintenant `<vault>/wiki-meta/index.md`. Error message pointe vers `--migrate-wiki-meta` (v0.12.1).
- ✅ **`src/index.mjs`** — audit log (USER_ID) écrit dans `<vault>/wiki-meta/log.md`.
- ✅ **`templates/wiki/{hot,index,log,overview}.md`** déplacés vers **`templates/wiki-meta/{...}.md`** (4× `git mv`). Idem pour `templates/reference-vault-skeleton/wiki/{...}` → `wiki-meta/{...}`. `templates/wiki/CLAUDE.md` et `templates/reference-vault-skeleton/CLAUDE.md` restent en place (CLAUDE.md vault-root, pas un scaffold) mais leur CONTENU est rafraîchi.
- ✅ **Bulk sweep** — `wiki/<scaffold>.md` → `wiki-meta/<scaffold>.md` dans `skills/`, `commands/`, `agents/`, `docs/` (64 remplacements sur 17 fichiers).
- ✅ **Tests** — `tests/{wiki-query-first-nudge,hot-cache-load,install-hooks,user-id-audit}.test.mjs` fixtures + assertions mises à jour. `vault-link-linter.test.mjs` et `wiki-fingerprint.test.mjs` inchangés (utilisent `wiki/log.md` comme fichier-fixture générique, pas comme scaffold).
- ✅ **Docs** — `CHANGELOG.md` entrée [0.12.0] + ce ROADMAP entry + `README.md` (refs hot.md + log.md mis à jour FR + EN) + `templates/{reference-vault-skeleton/}CLAUDE.md` body.
- ✅ Manifests bumped : `package.json`, `package-lock.json`, `.claude-plugin/{plugin,marketplace}.json` → 0.12.0.

### Risques connus + état

1. **Broken window entre v0.12.0 et v0.12.1** : les 10 vaults de Roland sont silencieux côté hooks tant que Session 2 ne tourne pas. ✅ Acknowledged par Roland avant ship.
2. **Conventions installées per-vault encore stales** : les CLAUDE.md de chaque vault contiennent encore l'ancien texte de `wiki-query-first` / `roadmap-discipline` qui mentionne `wiki/<scaffold>.md`. Pas critique au runtime (Claude lit l'injection des hooks, pas le CLAUDE.md persistant), mais à corriger en Session 3.
3. **autocommit wiki-meta/ rate les changements anciens** : tout vault qui n'a pas encore `wiki-meta/` ne déclenche pas le tracking dessus. Devient effectif dès que la migration crée le dir.

Tests: **416/416 ✅** (unchanged headcount — refactor pur, fixtures mises à jour).

## ✅ v0.11.6 — Workspace-bound vault mode (shipped 2026-05-23)

Closes the v0.11.5 gap : hooks ne détectaient un vault context QUE quand cwd-IS-vault. Manquait le cas commun : workspace code/dev ASSOCIÉ à un vault. v0.11.6 introduit le mode `workspace-bound` via `OBSIDIAN_ROUTER_DEFAULT_VAULT` dans le `.env` du workspace.

- ✅ **`hooks/_helpers/workspace-vault.mjs`** — module helper partagé (.env autoload + slug resolve + dual-mode context detection). Élimine duplication entre hooks.
- ✅ **`hooks/wiki-query-first-nudge.mjs` dual-mode** — détection cwd-is-vault OR workspace-bound. Nudge mode-aware (Read vs MCP get_file selon le mode). Mentionne explicitement les 4 entry points canoniques (hot/index/log/overview).
- ✅ **`hooks/hot-cache-load.mjs` dual-mode** — charge le hot.md du vault associé en mode workspace-bound, préfixé d'un marqueur HTML-comment expliquant l'origine.
- ✅ **`scripts/setup-vault.mjs --link-workspace` + `--unlink-workspace`** — CLI pour binder un workspace à un vault sans éditer le `.env` à la main. Idempotent, valide slug + presence wiki/index.md.
- ✅ Documentation : convention `wiki-query-first.md` + section globale `~/.claude/CLAUDE.md` refondues pour les 2 modes + 4 entry points + setup procedure.
- ✅ 25 nouveaux tests (10 hot-cache-load + 8 wiki-query-first-nudge workspace-bound + 7 install-hooks --link-workspace). **416/416 ✅**.

Trigger Roland : *"un workspace peut effectivement être un obsidian vault mais pas seulement. Un workspace peut être le développement d'une application complétement en dehors des repertoires du vault MAIS associé à un vault Obsidian"*. Pattern reconnu : la nuance était évidente après coup et le fix mature suit le même blueprint que v0.11.5.

## ✅ v0.11.5 — `wiki-query-first-nudge` UserPromptSubmit hook (shipped 2026-05-23)

Closes the 3rd category of "Claude forgets a context rule at the moment of application" slip (after vault-link-linter v0.11.3 and doc-propagation-checker v0.11.4). New slip: in a vault-bound session, Claude answers user questions without first checking whether the topic has been discussed in the vault wiki. Same defense-in-depth pattern: convention + global CLAUDE.md + deterministic hook.

- ✅ **`hooks/wiki-query-first-nudge.mjs`** — `UserPromptSubmit` hook. Detects vault workspace (`wiki/index.md` present) + substantive prompt (length, slash command, trivial regex) → injects 4-step pre-answer reminder via `additionalContext`.
- ✅ **`skills/conventions/snippets/wiki-query-first.md`** — 7th installable convention (FR + EN).
- ✅ **Global `~/.claude/CLAUDE.md`** — new section for default coverage across all sessions.
- ✅ 15 tests. Activated on Roland's machine: settings.json + 10 vaults installed.

Trigger: Roland 2026-05-23 — *"je veux créer une connexion RDP depuis mon PC maison vers mon PC cabinet via WireGuard"* dans une session DEDIBOX-vault. La session a lu `roadmap_dedibox.md` mais a manqué `wiki/Refs/dedibox-rdp-pc-cabinet.md` qui contenait la procédure exacte. Pattern reconnu : 3e slip de "recall règle context au moment de l'application", désormais codifié avec le même triple (convention + global + hook).

Tests: **391/391** (was 376 at v0.11.4).

## ✅ v0.11.4 — `--install-hooks` family + `doc-propagation-checker` hook + new-hooks tips (shipped 2026-05-23)

Closes Couche 1 + Couche 2 of the "router-as-assistant" vision: hooks shipped on disk but stayed dormant because activating them required hand-editing `~/.claude/settings.json`. This release ships the CLI + interactive prompt + new-hooks notification flow so users can opt in (or extend their selection) without ever touching JSON.

- ✅ **`hooks/doc-propagation-checker.mjs`** — `PostToolUse` hook on `Bash`. After every `git commit`, checks CHANGELOG/ROADMAP/vault-wiki alignment with `package.json` version. Non-blocking (exit 0, stdout nudge). Multi-tier check (repo + vault). 14 tests.
- ✅ **`scripts/setup-vault.mjs --install-hooks`** — idempotent merge of `hooks/hooks.example.json` into `~/.claude/settings.json`. Preserves user-defined non-router hooks. Auto-detects router path. Forward-slash paths for Windows compat. `--select <a,b,c>` for partial install. 14 tests.
- ✅ **`scripts/setup-vault.mjs --uninstall-hooks`** — removes router hooks, preserves user-defined, cleans up empty objects.
- ✅ **`scripts/setup-vault.mjs --hooks-status`** — diagnostic listing each hook with active/inactive status.
- ✅ **`hooks/check-router-update.mjs` extension** — snapshots local `hooks/` listing in cache. On next run, diffs current vs cached. New hooks detected AND not yet wired → 💡 tip appended to update notice listing them + the `--install-hooks --select <names>` command. Works offline (snapshot is local). Same opt-out (`OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true`). 7 tests.
- ✅ **`skills/meta-setup/SKILL.md`** — new "Install router hooks (recommended)" section. Interactive prompt at end of meta-setup with All / Pick / Skip modes. Documents the 6 hooks + their per-hook opt-out env vars.
- ✅ Test count: **376/376 ✅** (was 341 at v0.11.3).

Activation path for existing users : after `/plugin update`, run `node <router-repo>/scripts/setup-vault.mjs --install-hooks` once. Idempotent. Restart Claude Code. Future updates will auto-tip about new hooks at the next 24h check.

**Couche 3 (multi-session followup)** : `meta-config` skill/slash command to toggle individual hooks on/off without JSON or env vars + proactive usage tips ("your wiki has 80 unfolded entries, consider `/wiki-fold`") + auto-detection of conventions installed vs available + onboarding wizard. Tracked in [[router-ux-improvements-roadmap]] when filed.

## ✅ v0.11.3 — `vault-link-linter` Stop hook (shipped 2026-05-23)

Closes the recurring slip where Claude mentions vault files using bare relative paths instead of the click-to-open format documented in `~/.claude/CLAUDE.md`. The convention was loaded into context every session but I'd miss applying it during multi-step recap turns. Memory entries don't solve recall-at-the-right-moment — only a deterministic check OUTSIDE the LLM attention loop does (same pattern as `wiki-autocommit` and `check-router-update`).

- ✅ **`hooks/vault-link-linter.mjs`** — Stop hook (~290 lines incl. comments). Reads transcript, finds `[label](href.md)` markdown links where `href` has no scheme + is relative, verifies each against ACTIVE vault paths on disk (filesystem check = false-positive guard), exits 2 with bilingual FR+EN stderr listing each violation + auto-derived correction (with HTTPS fallback caveat when `enableInsecureServer: false`).
- ✅ **Multi-tenant correctness** — honors `cfg.disabledVaults`, `OBSIDIAN_ROUTER_ALLOWED_VAULTS`, `OBSIDIAN_ROUTER_LOCKED`. Default-vault cascade matches the router's per-process logic: `OBSIDIAN_ROUTER_DEFAULT_VAULT` env → `VAULT_PATH` env → `cfg.defaultVault`. Loads workspace `.env` itself (since the hook is a separate subprocess that doesn't inherit it from the router binary).
- ✅ **Safety guards** — path-traversal rejection (`../` resolves outside vault → skip), recursion guard (`stop_hook_active` true → exit 0), robust to malformed inputs (empty/non-JSON stdin, missing transcript_path → exit 0 silent), `safeDecodeURI` never throws on filenames with literal `%`.
- ✅ Opt-out: `OBSIDIAN_ROUTER_NO_LINT_VAULT_LINKS=true`.
- ✅ Wire-up : added to `Stop` block in `hooks/hooks.example.json` BEFORE `hot-cache-update-prompt.mjs` (order matters — if linter exit-2s, hot-cache's fingerprint isn't written yet, so the hot.md nudge re-fires on the next Stop).
- ✅ 33 tests (13 pass / 16 block / 4 robustness), each named REGRESSION test maps to a specific review finding. Total : 341/341 ✅ (was 308).

Review trail : 3 passes of `/review+` (Reviewer A subagent + codex CLI in parallel). Pass 1 — Reviewer A 2 IMPORTANT (path traversal, 4-space-indented code blocks) + codex 3 P2 (hook order hot-cache/linter, multi-vault collision, decodeURIComponent crash on literal `%`). Pass 2 — Reviewer A "OK to merge" · codex 2 P2 (missing disabledVaults/ALLOWED_VAULTS filtering, per-process default cascade only checking cfg.defaultVault). Pass 3 — codex 2 P2 (workspace `.env` autoload, `OBSIDIAN_ROUTER_LOCKED` isolation). Each finding got a named regression test.

## ✅ v0.11.2 — Template-propagation skill + setup-vault safety hardening (shipped 2026-05-23)

Adds the `/obsidian-router:meta-sync-template` slash command (interactive picker for propagating the reference vault's plugins to other configured vaults) and closes two real safety bugs in `setup-vault.mjs` surfaced while building the skill.

- ✅ `/obsidian-router:meta-sync-template` + skill — interactive picker (online/offline status + `⚠️ needs bootstrap` flagging) over `--sync-all` / `--sync-plugins`. Brings total plugin commands from 30 → 31 (4 meta helpers).
- ✅ **Fix (data-loss)**: `--sync-all` self-skip used a case-sensitive `path.resolve()` compare. On Windows NTFS / macOS APFS, a mis-cased registry entry pointing at the reference vault would slip past the skip and `--force` would `rm -rf` the source mid-copy. Replaced with `samePath()` (new `scripts/path-helpers.mjs` module, backed by `fs.realpathSync.native()`).
- ✅ **Fix (credential-leak)**: first-time `--sync-plugins` copy cloned the reference vault's `obsidian-local-rest-api/data.json` (port + API key) into any target lacking the plugin. New `CREDENTIAL_LEAK_PLUGINS` Set + `data.json`-presence check in both the no-folder and folder-but-no-data.json paths (the latter was a P1 codex finding caught in review pass 2).
- ✅ **Fix (loop survivability)**: `syncPluginsMode()` now supports `throwOnError: true` so `--sync-all` can `try/catch` instead of being killed by a single vault's `process.exit(1)`. Direct CLI invocations keep the exit behavior.
- ✅ **DX**: `OBSIDIAN_ROUTER_CONFIG` env var support in the script (mirrors the router binary's `--config` flag); `writeMcpJson` embeds `--config <path>` in `.mcp.json` when running against a non-default config, so MCP clients launching the router don't fall back to the wrong registry.
- ✅ 16 new tests (`tests/setup-vault-safety.test.mjs`) covering every fix above. Total: 308/308 passing (was 271 at v0.11.1).

Review trail: 2 full passes of `/review+` (Claude Code Reviewer + codex CLI in parallel). 4 BLOCKERS closed (data-loss, credential-leak first-time, credential-leak `--force`-with-missing-data.json, doc-version-mismatch), plus the `throwOnError` refactor, custom-config propagation, and `writeMcpJson` `--config` embedding from codex P2/P3 findings.

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

## ✅ v0.11.1 — `/ultrareview` follow-up: 7 security + correctness fixes (shipped 2026-05-22)

Cloud `/ultrareview` ran 17min after the v0.11.0 commit landed and surfaced 7 valid findings the local `/review+` (Reviewer A subagent + codex CLI, 3 passes) had missed. All addressed before the next session.

- ✅ **bug_018 — DNS rebinding TOCTOU (SSRF, normal)**. The v0.11.0 `assertHostnameNotPrivate` did `dns.lookup` → `isPrivateIp` → then `fetch`, with no IP pinning between the two. An attacker DNS server with TTL=0 could return a public IP at validation time and a private IP (127.0.0.1 / 169.254.169.254 AWS IMDS / RFC1918) at connect time. **Fix**: new `resolveAndAssertPublic()` returns `{ address, family }`; `safeFetch` builds a custom undici `Agent` whose `connect.lookup` callbacks with the pre-resolved address, pinning the connection. Per-redirect-hop pinning preserved.
- ✅ **bug_015 — READONLY bypass on file-input conversion tools (normal)**. The 6 file-input `*_to_markdown` tools were deliberately excluded from `WRITE_TOOL_NAMES` (they don't mutate vault state), but in the multi-tenant deployment topology the README markets (`OBSIDIAN_ROUTER_READONLY=true` + `OBSIDIAN_ROUTER_ALLOWED_VAULTS=*`), a "read-only" guest could call `pdf_to_markdown({ filepath: "/etc/passwd" })` and exfiltrate arbitrary server-host files. **Fix**: new `assertSandboxConsistent()` at `startServer` boot — when any of `OBSIDIAN_ROUTER_READONLY` / `OBSIDIAN_ROUTER_ALLOWED_VAULTS` / `OBSIDIAN_ROUTER_USER_ID` is set, `MD_ALLOWED_PATHS` (or its legacy alias `MD_SHARE_DIR`) becomes **mandatory**. Refuses to start with a clear error pointing to the fix. Single-user setups without those env vars are unaffected.
- ✅ **merged_bug_001 — no HTTP status check + no body size cap (normal)**. (a) v0.11.0 `safeFetch` returned 4xx/5xx responses unchanged — a 404 HTML error page was converted to "# Page Not Found" markdown and shipped to MCP clients as if it were the requested content. (b) `response.arrayBuffer()` buffered the entire response body before any size check, so an attacker-controlled URL could OOM the router with an unbounded body. **Fix**: `safeFetch` throws on `!response.ok` with the status code; new `readBodyWithCap()` streams the body and aborts at 50 MB (matching the existing `maxBuffer` ceiling on markitdown / repomix subprocess output). Also checks `Content-Length` header upfront when present.
- ✅ **bug_003 — Windows `.cmd` execFile broken on Node ≥20.18 (normal)**. CVE-2024-27980 (Node 20.12.0) bans `execFile` of `.cmd` / `.bat` without `{ shell: true }`. v0.11.0 `resolveRepomixPath` preferred `repomix.cmd` on Windows → every `git_repo_to_markdown` call on Windows failed with cryptic EINVAL. **Fix**: new `resolveRepomixCommand()` returns `{ cmd, prefixArgs }`; on Windows it skips the `.cmd` shim and invokes `node node_modules/repomix/bin/repomix.cjs` directly. POSIX path unchanged. `REPOMIX_PATH` env override still wins.
- ✅ **bug_002 — `inferExtensionFromUrl` PDF misclassification (normal)**. `url.endsWith('.pdf')` failed for signed S3 URLs (`?X-Amz-Signature=…`), Google Drive download links (`?export=download`), and `.pdf#page=5` bookmarks — all common in real workflows. PDF bytes were saved to `input.html` and routed through markitdown's HTML converter, producing garbage. **Fix**: parse via `new URL(url).pathname.toLowerCase().endsWith('.pdf')`.
- ✅ **bug_013 — bracketed IPv6 broke `dns.lookup` in `assertHostnameNotPrivate` (nit)**. `new URL('http://[2001:db8::1]/').hostname` returns `[2001:db8::1]` with brackets; `getaddrinfo` rejected the bracketed form with ENOTFOUND. Public IPv6-literal URLs failed with a misleading "DNS lookup failed" error. **Fix**: strip brackets at the top of `assertHostnameNotPrivate` (and short-circuit IP literals entirely via `net.isIP`, saving the DNS round-trip).
- ✅ **bug_017 — `isUnconvertedHtml` missed uppercase `<HTML>` (nit)**. DOCTYPE branch was case-conscious but bare-`<html` check was lowercase-only. Legacy CMS pages, Office HTML export, hand-written HTML all bypassed the SPA-detection safety net. **Fix**: `toLowerCase()` once before all checks.

Tests: 292/292 passing (+3 new tests for `resolveAndAssertPublic`, `resolveRepomixCommand`, `assertSandboxConsistent`, plus inline cases for the upper-case-HTML + PDF-query-string regressions). The `assertSandboxConsistent` test covers all 6 combinations of {READONLY / ALLOWED_VAULTS / USER_ID} × {with/without MD_ALLOWED_PATHS} plus the `MD_SHARE_DIR` legacy alias.

Methodology note: this is the kind of finding distribution that justifies the **3-tier review stack** (`/review+` local + `/ultrareview` cloud). `/review+` (local) caught the foundational bugs in passes 1 & 2 (SSRF textual check, argv injection, TOCTOU tempfile, credential leak in `.claude/settings.local.json`, package-lock not regenerated). `/ultrareview` (cloud, ~17 min) reasoned at a higher level about the **composition** of those fixes with the overall threat model — that DNS validation + fetch is TOCTOU when not IP-pinned, that READONLY's semantics changed silently when file-input tools shipped, that Node 20.12's CVE-2024-27980 means `.cmd` execFile is dead code on Windows. The local reviewers operate on the diff; the cloud reviewer operates on the diff in context.

## 🔮 v0.12 — Port skills d'orchestration en `.claude/workflows/*.js`

**Blocker externe** : feature `workflows` d'Anthropic encore non annoncée officiellement (mai 2026). Le binaire Claude Code l'embarque mais elle est désactivée par défaut (`CLAUDE_CODE_WORKFLOWS=1`). On peut écrire les fichiers dès maintenant à risque assumé, mais l'API peut évoluer avant release stable.

### Why

Les skills d'orchestration actuelles (`autoresearch`, `wiki-ingest` batch, `wiki-query`, `save`, `conventions` propagate) ont en commun un défaut structurel : l'orchestrateur (Claude lui-même) lit les résultats intermédiaires de chaque sub-agent, ce qui (a) consomme des tokens de la session principale à chaque hop, (b) dégrade la qualité de décision à mesure que le contexte se remplit, (c) rend les conditionnels non-déterministes (le LLM oublie ou réinterprète les règles). La feature `workflows` permet de remplacer cette couche par du JS pur où les outputs d'agents passent directement d'agent à agent sans transiter par l'orchestrateur — token tax éliminée, conditionnels garantis, retry auto, pause/resume natifs.

**Insight clé** : l'option `agentType` permet d'invoquer les sub-agents existants du router (`agents/wiki-ingest.md`, `agents/wiki-lint.md`) directement depuis un workflow. **Pas de rewrite des workers** — seule la couche d'orchestration LLM-driven est remplacée par du JS déterministe.

### Top 5 candidats (classés par payoff)

1. **`workflows/autoresearch.js`** — pattern *loop-until-budget*. Boucle web-search → defuddle → `agentType: 'wiki-ingest'` → check `agentType: 'wiki-query'` pour skip si déjà couvert. Gain estimé : ~60% tokens session principale.
2. **`workflows/wiki-ingest-batch.js`** — pattern *fan-out*. N sources en parallèle via `agentType: 'wiki-ingest'`, hot.md refresh une fois en fin.
3. **`workflows/wiki-query.js`** — tiered fallback déterministe (hot → index → drill → semantic) avec early-exit sur confidence score retourné via `schema`.
4. **`workflows/save.js`** — classify → write → `parallel([index, log, hot, backlinks])`. Type/slug déterministes (le LLM ne se contredit pas entre runs).
5. **`workflows/conventions-propagate.js`** — fan-out sur tous les vaults pour install / sync d'une convention donnée.

### Tasks

- [ ] **Attendre annonce officielle Anthropic** (timing inconnu — surveiller le binaire ou la doc Claude Code)
- [ ] Installer le skill `workflow-creator` de Ray Amjad (`~/.claude/skills/workflow-creator/`) comme aide à l'écriture
- [ ] Étendre `skills/meta-status` pour signaler `CLAUDE_CODE_WORKFLOWS` state (set/unset)
- [ ] **Phase 1** — porter `autoresearch` en workflow (le plus rentable, validation du pattern)
- [ ] **Phase 2** — porter `wiki-ingest-batch` (réutilise `agentType: 'wiki-ingest'`)
- [ ] **Phase 3** — porter `wiki-query` (déterminisme + cascade modèle)
- [ ] **Phase 4** — porter `save` et `conventions-propagate`
- [ ] Documenter la migration : quels skills restent skills, quels deviennent workflows, comment l'user choisit

### Ne PAS porter

- ❌ Skills single-shot (`read-get`, `write-append`, `manage-delete`, `lock`, etc.) — 1 tool call, aucune orchestration.
- ❌ `wiki-lint` / `wiki-fold` — déjà déterministes en single-shot.
- ❌ Les hooks — orthogonaux aux workflows, restent sur events Claude Code.

### Trigger

Roland 2026-05-23 : *"Prends connaissance de cette video youtube : https://www.youtube.com/watch?v=c0gVowvMR-g"* (Ray Amjad, *"Anthropic Just Dropped the Update Everyone's Been Waiting For"*). Le skill `workflow-creator` du créateur est sur GitHub : https://github.com/ray-amjad/claude-code-workflow-creator — préview complet de l'API tant qu'Anthropic n'annonce pas officiellement.

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
