<p align="center">
  <img src="./docs/assets/logo.png" alt="obsidian-mcp-router — multi-vault MCP server" width="540">
</p>

<p align="center">
  <a href="https://github.com/tboome33/obsidian-mcp-router/actions/workflows/test.yml"><img src="https://github.com/tboome33/obsidian-mcp-router/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520.19.0-brightgreen.svg" alt="node"></a>
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.89.0-blueviolet.svg" alt="version"></a>
</p>

# obsidian-mcp-router

> *🇬🇧 English version below — [🇫🇷 version française](#-version-française)*

> An MCP server that routes Claude tool calls to **multiple** Obsidian vaults — local or remote — over the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

Instead of registering one MCP per vault (one process, one port, one API key), this router exposes a single MCP that knows about every vault you've configured. Each tool takes a `vault` parameter (or uses your default), and the router fans out the HTTPS call to the right Obsidian instance.

## Why

If you keep more than one Obsidian vault — local or remote, in any combination — you don't want to register a separate MCP server per vault and switch context every time. This router is one process that knows about all of them and routes each tool call to the right one based on a `vault` parameter.

What you get:

- **One install** — the Claude Code plugin ships and launches the server (one `~/.claude.json` entry on dev setups) → all vaults visible from any Claude Desktop/Code session.
- **Local + remote vaults**, treated identically. Drop the URL + API key into the config; the router doesn't care where the vault actually runs.
- **Cross-vault search**: pass `vault: "*"` to the `search` tool to fan-out across every vault in parallel.

## Capabilities

| Tool surface | Coverage |
|---|---|
| Vault discovery | `list_vaults`, `list_files` |
| Reads | `get_file`, `search`, `search_smart`, `get_frontmatter` |
| Writes | `write_file`, `append_to_file`, `patch_file`, `delete_file`, `set_frontmatter`, `merge_frontmatter` — `write_file`/`patch_file`/`delete_file`/`merge_frontmatter` accept **`ifMatch`**: replay `get_file`'s `contentSha256` and the write is refused with a 409 if the file changed since you read it (optimistic concurrency — stops parallel sessions from silently clobbering each other) |
| File management | `move_file` (also accepts `ifMatch`, checked against the source) |
| Templater | `execute_template` |
| Router state | `lock_vault`, `unlock_vaults`, `set_auto_enrich_mode` |
| Vault provisioning | `plan_vault`, `provision_vault` — defaults-first vault-creation wizard engine |
| Conversion | `pdf_to_markdown`, `docx_to_markdown`, `xlsx_to_markdown`, `pptx_to_markdown`, `image_to_markdown`, `audio_to_markdown`, `youtube_to_markdown`, `bing_search_to_markdown`, `webpage_to_markdown`, `git_repo_to_markdown`, plus `pdf_to_markdown_docling` (opt-in high-fidelity PDF via [Docling](https://github.com/docling-project/docling), MIT) — port of [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT). Also `pdf_to_images` (render PDF pages to PNG the model can *see*) and `filter_relevant_blocks` (BM25 relevance filter over already-acquired markdown). |
| Web/page metadata | `extract_page_metadata`, `propose_linked_sources`, `download_page_assets` |
| Wiki maintenance & sources | `write_bundle` (journaled multi-file bundle — all-or-nothing apply with rollback), `refresh_okf_projections` (regenerate the generated OKF navigation), `build_search_index` (local BM25 search tier, works on every vault), `record_source` / `audit_sources` (provenance ledger for ingested content) |
| Context & graph | `get_wiki_context_pack`, `build_wiki_graph`, `build_wiki_tour`, `get_page_neighbors`, `wiki_path`, `find_boundary_pages`, `find_twin_pages`, `build_open_link`, `open_in_obsidian`, `get_view_link` |
| Cross-vault | every tool accepts `vault: "*"` for fan-out |

Semantic search (`search_smart`), Templater execution (`execute_template`) and click-to-open links (`build_open_link`, `open_in_obsidian`, the auto-emitted `clickToOpenUrl` on write results) require the [`obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) plugin to be installed in each target vault — it registers the matching `/search/smart`, `/templates/execute` and `/open/*` routes on Local REST API. Bridge **≥ 0.7.0** also registers `PUT /vault-cas/*`, which makes `ifMatch` writes **atomic** (read-compare-write inside the Obsidian process); without it, `ifMatch` still works everywhere through a checked — but non-atomic — GET-compare fallback. Bridge **≥ 0.9.0** additionally serves `GET /smart-env/sources` — the Smart Connections vector store, a dot-directory Local REST API itself will not serve — which is what lets `find_twin_pages` run against a **remote** vault; and its loopback-only `GET /ping?v=<vault>` answers 200 only for the vault actually listening on that port, the one-click self-test behind click-to-open port checks. The conversion tools require Python 3.10+ on `PATH` plus an explicit `npm run install-markitdown` (opt-in) — see the **Conversion tools — runtime dependencies** section below. Everything else works against the standard Local REST API endpoints alone.

## Deployment modes

The router runs in two modes, controlled entirely by environment variables — **no code change**, **no separate binary**:

### Local mode (default)

No env vars set. Single process, stdio MCP transport, launched by the Claude Code plugin (or registered once in `~/.claude.json` user scope on dev setups). The router sees every vault listed in `~/.claude/obsidian-mcp-router/config.json`. This is what you get when you follow the install steps below.

### Multi-tenant mode (opt-in)

Three independent env vars turn the router into a scoped instance — useful when you run multiple copies behind a hub (MCPHub, `mcpo`, a custom proxy) and want each instance to expose a different subset of vaults to a different user.

| Env var | What it does | Default when unset |
|---|---|---|
| `OBSIDIAN_ROUTER_ALLOWED_VAULTS=a,b,c` | Whitelist of vault names this instance sees. Comma-separated, spaces tolerated. Vaults outside the list are moved to `skipped[]` with reason `"not in OBSIDIAN_ROUTER_ALLOWED_VAULTS whitelist"`. Applied **before** default-vault resolution, so `defaultVault` falls through to the filtered set. | All vaults visible |
| `VAULT_<NAME>=<JSON>` | A vault defined entirely in an env var (JSON) — editable from the MCPHub dashboard. A 3rd config source merged after `portRegistry` + `remoteVaults` (overrides any same-name vault). Required: `name`, `baseUrl`, `apiKey` (the **bare token**). Optional: `description`, `tlsInsecure`, `timeoutMs`. Malformed entries are skipped with a redacted warning. See "[`VAULT_*` env-var config](#vault_-env-var-config-dashboard-editable)" below. | (none) |
| `OBSIDIAN_ROUTER_READONLY=true` | Disable write tools. The 15 write tools (`write_file`, `append_to_file`, `patch_file`, `set_frontmatter`, `merge_frontmatter`, `move_file`, `delete_file`, `execute_template`, `download_page_assets`, `build_wiki_graph`, `provision_vault`, `refresh_okf_projections`, `write_bundle`, `record_source`, `build_search_index`) are filtered from `ListTools` **and** refused at `CallTool` time — even when a client knows the name and calls it directly. Truthy tokens: `true` / `1` / `yes` / `on` (case-insensitive). | Write tools enabled |
| `OBSIDIAN_ROUTER_USER_ID=<slug>` | Audit log: every **successful** write call appends a line `[claude-write by <slug>] YYYY-MM-DD HH:MM — <tool> path="<path>"` to the touched vault's `wiki-meta/journal.md`. Best-effort (audit failure logs to stderr, never blocks the write). Uses the REST client directly to avoid the recursion that would happen via the `append_to_file` tool wrapper. Setting it also marks the deployment as **gated**, which hides the local-only `plan_vault` / `provision_vault` tools. | No audit log |

The three vars compose freely: an instance can be scoped to one vault (`ALLOWED_VAULTS=karine`) AND read-only (`READONLY=true`) AND attribute writes (`USER_ID=karine-guest`). Setting none = local mode exactly.

Concrete deployment example (MCPHub `mcp_settings.json` entry):

```json
"obsidian-router-roland": {
  "command": "obsidian-mcp-router",
  "env": {
    "OBSIDIAN_ROUTER_ALLOWED_VAULTS": "roland,tribu,projects",
    "OBSIDIAN_ROUTER_USER_ID": "roland"
  }
}
```

See `wiki/obsidian-mcp-router sur Dedibox et MCPHub/` in the project's meta vault for the complete multi-tenant deployment recipe (bundle `.mcpb`, MCPHub Keys with Access Scope, NPM front, Self-hosted LiveSync, etc.).

### Served mode — reaching the local router from a remote session

A remote Claude Code session (a dev box over SSH) can't just run the router: 11 of its modules legitimately touch the vaults' **disk**, so porting it ships it half-broken. Instead the router stays home and is **served** over an authenticated streamable-HTTP endpoint, reached through the existing SSH tunnel:

```bash
node scripts/serve-http.mjs [--port 27300] [--session-timeout-min 240]
```

It binds `127.0.0.1` only (deliberately not configurable), requires a bearer token on **every** verb (`OBSIDIAN_ROUTER_HTTP_TOKEN`, or `~/.claude/obsidian-mcp-router/serve-http.token`), and refuses to start without one. Each MCP session gets **its own child router process**, so a vault lock taken by one session is invisible to another — exactly the isolation stdio sessions already have.

| Flag | What it does | Default |
|---|---|---|
| `--port <n>` | Listen port on loopback. | `27300` |
| `--session-timeout-min <n>` | Idle threshold before a session is reaped and its child killed. Minimum 1. | **240** (4 h) |

**Why the timeout defaults to four hours and not thirty minutes.** A dropped tunnel is not a `DELETE` — without reaping, vanished clients leave zombie children (six were measured in the 2026-08-28 spike), so the reaper is mandatory. But its *scale* matters more than its existence: a threshold shorter than an ordinary human pause harvests **live** sessions. With a 30-minute threshold, a multi-hour session loses the router mid-flight while the user is merely running a script on their own machine — and Claude Code does not restore an MCP server that dies mid-session, so the tools are gone for the rest of the sitting. The two failure modes are not comparable: too short costs the user their tools for hours with no in-session recovery, too long costs one dormant child process until the threshold. Lower it if you serve many clients from one host and dormant children are your dominant cost.

**An expired session answers `404`, and that is on purpose.** The server never silently respawns a child for an unknown session id. It would look seamless and it would be a lie: the per-session state (vault lock, auto-enrichment mode, the once-per-session conformance pass) would have reset under an id the client believes is stable. Recovering from the `404` by re-initializing is the client's job.

## Slash commands & skills (Claude Code plugin)

The repo doubles as a **Claude Code plugin marketplace** that exposes **51 slash commands** under the `/obsidian-router:*` namespace. Type `/obsidian-router:` in Claude Code → the autocomplete shows everything. Every slash command also auto-triggers on natural-language phrasing (EN + FR) so you rarely have to remember the exact name — just describe what you want.

> 📄 **Quick reference PDF** (router overview + setup + config + every slash command with NL trigger phrases) — [English](./docs/quick-reference-en.pdf) · [Français](./docs/quick-reference-fr.pdf). Printable, accessible font sizes — for paper or screen reference.

> 📖 **Feature guide (prose, by category)** — the tables in this README are a reference card; for a readable walkthrough of every feature (the need it answers, what it does, how to use it), see [`docs/features/`](./docs/features/README.md) (13 categorized pages, French).

### 🔧 17 MCP wrappers — one per core vault tool

#### `discover/` (2)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:discover-list-vaults` | List every configured vault (local + remote) with online/offline/latency, default-vault, lock state | *"list my vaults"*, *"are my vaults online"* / *"liste mes vaults"*, *"mes vaults sont-ils en ligne"* |
| `/obsidian-router:discover-list-files` | List files and subdirectories of a vault path | *"list files in Sessions"*, *"what's in <folder>"* / *"liste les fichiers de Sessions"*, *"qu'est-ce qu'il y a dans <dossier>"* |

#### `read/` (4)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:read-get` | Read a file in full (markdown + frontmatter + meta); returns `contentSha256`, the `ifMatch` token for conditional writes | *"show me X"*, *"open the file X"* / *"montre-moi X"*, *"ouvre le fichier X"* |
| `/obsidian-router:read-search` | Plain-text (substring) search with surrounding context | *"find <text> in my vault"*, *"grep for X"* / *"trouve <texte> dans mon vault"*, *"grep <X>"* |
| `/obsidian-router:read-search-smart` | Semantic search via Smart Connections (cosine scores + breadcrumbs) | *"find notes about X"*, *"semantic search for X"* / *"trouve mes notes sur X"*, *"recherche sémantique sur X"* |
| `/obsidian-router:read-frontmatter` | Read frontmatter (whole object or one key, types preserved) | *"what's the status of X"*, *"show me the metadata of X"* / *"quel est le statut de X"*, *"montre les méta de X"* |

#### `write/` (6)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:write-create-or-replace` | PUT — create a new file or replace an existing one; optional `ifMatch` = atomic compare-and-swap (refused if the file changed since you read it) | *"create a note X"*, *"save this as X.md"* / *"crée une note X"*, *"enregistre ça comme X.md"* |
| `/obsidian-router:write-append` | POST — append to an existing file (auto-creates if missing) | *"append to my journal"*, *"add a line to X"* / *"ajoute à X"*, *"rajoute à la fin de X"* |
| `/obsidian-router:write-patch` | Surgical PATCH on heading / block / frontmatter | *"edit the X section in Y"*, *"replace the content under X"* / *"édite la section X dans Y"*, *"remplace le contenu sous X"* |
| `/obsidian-router:write-frontmatter-set` | Set/replace a single frontmatter key | *"set status to closed on X"*, *"tag this with X"* / *"passe le statut de X à closed"*, *"tag ça avec X"* |
| `/obsidian-router:write-frontmatter-merge` | Apply multiple frontmatter updates in sequence | *"on X set status=closed outcome=tp1"* / *"sur X mets status=closed outcome=tp1"* |
| `/obsidian-router:write-bundle` | Journaled multi-file bundle — all-or-nothing apply with rollback | *"write these 4 pages atomically"* / *"écris ces pages d'un bloc"* |

#### `manage/` (2)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:manage-move` | Move or rename a file (GET → PUT → DELETE); optional `ifMatch` guards the source | *"rename X to Y"*, *"move X into <folder>"* / *"renomme X en Y"*, *"déplace X dans <dossier>"* |
| `/obsidian-router:manage-delete` | Delete a file (two-step confirm guard; optional `ifMatch` refuses if it changed since read) | *"delete X"* (preview), *"yes confirm=true"* (proceed) / *"supprime X"* puis *"oui confirm=true"* |

#### `template/` (1)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:template-execute` | Execute a Templater template (preview or save) | *"render Templates/X.md with arg1=v1"*, *"run the daily template"* / *"rends Templates/X.md avec arg1=v1"*, *"exécute le template daily"* |

#### `convert/` (2)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:pdf-to-markdown` | Convert a local PDF to markdown via the bundled MarkItDown CLI (fast, plain-text extraction) | *"convert this PDF to markdown"*, *"markdown of X.pdf"* / *"convertis ce PDF en markdown"*, *"markdown de X.pdf"* |
| `/obsidian-router:pdf-to-markdown-docling` | High-fidelity PDF → markdown via Docling (layout + table-structure recognition, ~10× slower — needs the opt-in Docling install) | *"convert this PDF with docling"*, *"high-fidelity conversion of X.pdf"* / *"convertis ce PDF avec docling"*, *"conversion haute fidélité de X.pdf"* |

### 🔒 3 router-state commands (lock + auto-enrichment)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:lock` | Restrict the router to a single vault for the session (volatile or `--persist` to write to `.env`) | *"lock to tradingview"*, *"I only want to work on tradingview"*, *"isolate to tradingview permanently"* / *"verrouille sur tradingview"*, *"je ne veux travailler que sur tradingview"*, *"verrouille sur tradingview de manière permanente"* |
| `/obsidian-router:unlock` | Lift the lock and restore multi-vault routing (`--persist` to also clean `.env`) | *"unlock vaults"*, *"give me back access to all vaults"* / *"déverrouille les vaults"*, *"je veux pouvoir avoir accès à tous les vaults"* |
| `/obsidian-router:auto-mode` | Set the wiki auto-enrichment mode (`ClaudeAsk` / `Hybrid` / `FullAuto` / `off`); `--persist` writes to `.env`, except `FullAuto` — see below | *"switch to Hybrid mode"*, *"save everything automatically"* (→ FullAuto), *"stop auto-saving"* (→ off) / *"passe en mode Hybrid"*, *"sauve tout automatiquement"*, *"arrête de sauver auto"* |

See [Lock mode (single-vault isolation)](#lock-mode-single-vault-isolation) and the auto-enrichment callout below for the full designs and concrete use cases.

### 🩺 7 conversational helpers

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:meta-setup` | Walk through the MANUAL install (clone, npm link, register MCP) — dev path; normal installs get the server from the plugin | *"install the router"*, *"bootstrap obsidian-mcp-router on this machine"* / *"installe le router"*, *"setup obsidian-mcp-router sur cette machine"* |
| `/obsidian-router:meta-attach-vault` | Interactive wizard to attach a vault to a workspace (default), bootstrap a standalone vault, or register a remote vault. Provisions plugins + scaffolds wiki + binds `.env` + edits `.gitignore` + conventions picker. | *"set up Obsidian for this project"*, *"attach a vault to this workspace"*, *"connect my remote vault"* / *"configure Obsidian pour ce projet"*, *"attache un vault à ce workspace"*, *"connecte mon vault distant"* |
| `/obsidian-router:meta-status` | Health-check every vault with per-issue fix hints | *"diagnose the router"*, *"are my vaults reachable"* / *"diagnostique le router"*, *"mes vaults sont-ils accessibles"* |
| `/obsidian-router:meta-sync-template` | Propagate the reference vault's plugins/snippets/docs to one or more vaults (interactive picker) | *"sync the template to all vaults"*, *"push reference plugins to X"* / *"synchronise le template vers tous les vaults"*, *"pousse les plugins de référence vers X"* |
| `/obsidian-router:sync-from-github` | Update one vault or the whole fleet directly from the GitHub skeleton (plugins, themes, snippets, docs) — no local dev repo needed. Same guards as `--sync-plugins` plus hardened archive extraction | *"sync my vaults from github"*, *"update the fleet from github"* / *"synchronise mes vaults depuis github"*, *"mets à jour la flotte depuis github"* |
| `/obsidian-router:meta-audit-bridge-readiness` | Audit click-to-open readiness across vaults (bridge ≥0.2.0, REST API ≥4.0.0, insecure HTTP, live `/open` probe) | *"audit bridge readiness"*, *"is click-to-open ready"* / *"audite la disponibilité du bridge"*, *"le click-to-open est-il prêt"* |
| `/obsidian-router:conventions` | Install / remove / status / propagate CLAUDE.md conventions (source-type, bilingual, heading-hierarchy, ...) across vaults | *"install source-type convention on X"*, *"list conventions"* / *"installe la convention source-type sur X"*, *"liste les conventions"* |

### 📚 24 knowledge-management commands (Karpathy-style LLM-wiki)

A small workflow on top of the router for an LLM-maintained, structured markdown knowledge base where pages reference each other and grow with use.

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:wiki` | Scaffold `wiki/` inside a vault (index, log, hot, overview + CLAUDE.md update) | *"set up a wiki"*, *"scaffold a knowledge base"* / *"scaffold un wiki"*, *"crée une base de connaissances"* |
| `/obsidian-router:wiki-ingest` | Ingest a source (URL/file/text) → entity & concept pages + cross-refs | *"ingest this URL"*, *"absorb this article"* / *"ingère cette URL"*, *"absorbe cet article"* |
| `/obsidian-router:wiki-query` | Three-tier RAG (hot.md → catalog.md → drill into pages), wiki-only (no web) | *"based on my notes, ..."*, *"what does my wiki say about X"* / *"d'après mes notes, ..."*, *"que dit mon wiki sur X"* |
| `/obsidian-router:wiki-lint` | Health check (orphans, dead wikilinks, index drift, frontmatter gaps) | *"lint the wiki"*, *"audit my wiki"* / *"lint le wiki"*, *"audit mon wiki"* |
| `/obsidian-router:wiki-fold` | Idempotent rollup of log entries under `wiki/folds/` | *"fold the log"*, *"roll up recent activity"* / *"compacte le journal"*, *"résume l'activité wiki de cette semaine"* |
| `/obsidian-router:hot-compact` | Compact an oversized `wiki-meta/hot.md` back to its cache contract (verified full backup → thin state-first rewrite → log trace) | *"compact the hot cache"*, *"hot.md is over limit"* / *"compacte le hot"*, *"hot.md dépasse la limite"* |
| `/obsidian-router:save` | File the current conversation as a typed wiki note (session/answer/decision/ADR/...) | *"save this"*, *"file this conversation"* / *"sauvegarde ça"*, *"archive cette conversation"* |
| `/obsidian-router:decision-consolidate` | Compress a settled decision page to its essentials and move the full deliberation history to a verified archive note | *"consolidate this decision"*, *"archive the deliberation of X"* / *"consolide cette décision"*, *"archive la délibération de X"* |
| `/obsidian-router:autoresearch` | Autonomous web→synth→file loop bounded by a research program | *"research X on the web"*, *"go investigate X online"* / *"fais une recherche web sur X"*, *"investigue X en ligne"* |
| `/obsidian-router:canvas` | Create/edit Obsidian `.canvas` files (visual layer for wiki pages, images, PDFs) | *"create a canvas for X"*, *"add to my canvas"* / *"crée un canvas pour X"*, *"ajoute à mon canvas"* |
| `/obsidian-router:defuddle` | Strip noise from webpages (ads, nav, footers) before ingestion | *"defuddle <url>"*, *"clean this page"* / *"nettoie cette page"*, *"extrais la version lisible de <url>"* |
| `/obsidian-router:obsidian-bases` | Create/edit Obsidian `.base` files (database-like views over frontmatter) | *"create a base for X"*, *"task tracker base"* / *"crée une base pour X"*, *"base task tracker"* |
| `/obsidian-router:wiki-graph` | Build a typed knowledge-graph JSON from the vault (Understand-Anything schema; feeds the native graph viewer) | *"build the wiki graph"*, *"generate the knowledge graph"* / *"construis le graphe du wiki"*, *"génère le knowledge graph"* |
| `/obsidian-router:wiki-tour` | Generate an ordered pedagogical reading tour from the vault's link topology | *"give me a tour of this vault"*, *"where do I start"* / *"fais-moi un tour du vault"*, *"par où je commence"* |
| `/obsidian-router:wiki-neighbors` | Show one page's neighbours from the knowledge graph — what it links to, what links to it (backlinks), or both | *"what links to X"*, *"show me the backlinks of X"* / *"quelles pages sont liées à X"*, *"voisins de X"* |
| `/obsidian-router:wiki-path` | Find the shortest chain of links between two pages ("how are A and B connected?") | *"how is X connected to Y"*, *"path between X and Y"* / *"quel rapport entre X et Y"*, *"chemin entre X et Y"* |
| `/obsidian-router:wiki-export` | Export the vault as a portable single file (`llms.txt` / `llms-full.txt`) or as an **OKF knowledge bundle** (Google's Open Knowledge Format v0.1, shareable with any OKF-aware agent) | *"export the wiki as llms.txt"*, *"export as an OKF bundle"* / *"exporte le wiki en llms.txt"*, *"exporte en bundle OKF"* |
| `/obsidian-router:okf-export` | Export a wiki subset as a shareable **OKF v0.1 knowledge bundle** — slugified filenames, relative links, per-folder indexes, conformance self-checked, optional agent README | *"export this folder as an OKF bundle"*, *"publish my wiki as a knowledge bundle"* / *"exporte ce dossier en bundle OKF"*, *"publie mon wiki en bundle"* |
| `/obsidian-router:okf-projections` | Regenerate the **generated OKF navigation** inside `wiki/` — root `index.md` (`okf_version` only), one `index.md` per directory, newest-first `log.md`; auto-refreshed ~15 s after each write once initialised; `--check` = drift report | *"refresh the OKF projections"*, *"rebuild the wiki indexes"* / *"rafraîchis les projections OKF"*, *"regénère les index du wiki"* |
| `/obsidian-router:okf-check` | Validate an OKF bundle (ours or third-party) against the Open Knowledge Format v0.1 conformance rules — one of the ecosystem's first OKF validators | *"validate this OKF bundle"*, *"is this bundle conformant?"* / *"valide ce bundle OKF"*, *"ce bundle est-il conforme ?"* |
| `/obsidian-router:build-search-index` | Build/refresh the local BM25 search index — a plugin-free search tier that works on every vault, idempotent | *"build the search index"* / *"construis l'index de recherche"* |
| `/obsidian-router:wiki-boundary` | Rank heavily-linked-but-thin "frontier" pages — the ones worth writing next | *"what should I write next"* / *"pages frontière du wiki"* |
| `/obsidian-router:wiki-refresh-digests` | Regenerate the per-page digest sidecars (concepts/claims/keywords) used by `wiki-lint --deep` and the graph | *"refresh the digests"*, *"rebuild page digests"* / *"rafraîchis les digests"*, *"régénère les digests de page"* |
| `/obsidian-router:who-is-speaking` | Identify the current family member in a shared vault and lock routing per-member | *"who is speaking"*, *"it's Karine"* / *"qui parle"*, *"c'est Karine"* |

Plus one Obsidian-specific reference skill (no slash command — knowledge surfaced when other skills run): `obsidian-markdown` (Obsidian Flavored Markdown reference for wikilinks, embeds, callouts, properties, etc.). Note that `obsidian-bases` is BOTH a reference skill AND has its own slash command above — other skills consult it when they need to generate `.base` files, and you can also invoke it directly.

**Two parallel sub-agents** for batch work:
- `wiki-ingest` agent — fan out one source per agent, parallel
- `wiki-lint` agent — read-only diagnostic in a separate context

**Hooks** — **11 cross-platform Node hooks**. The split: installing the plugin activates exactly three of them (`hot-cache-load` + `decisions-recall` + `workspace-briefing`, declared in `hooks/hooks.json`); the other eight fire only when wired via `setup-vault.mjs` — vault bootstrap auto-wires them into `~/.claude/settings.json` (opt out with `--no-hooks`), or run `node scripts/setup-vault.mjs --install-hooks` standalone. See [Which hooks the plugin turns on by itself](#which-hooks-the-plugin-turns-on-by-itself):
- `session-auto-journal` — auto-journals each Claude session under `wiki-meta/Sessions/` + a 2-line recap to `wiki-meta/journal.md` (self-healing reconciliation)
- `hot-cache-load` — loads `wiki-meta/hot.md` into context at SessionStart / PostCompact
- `hot-cache-update-prompt` — deterministic guard: **blocks the turn** (exit 2) until `wiki-meta/hot.md` is refreshed when this session wrote a `wiki/` note (per-vault, transcript-scoped; opt-out `OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD`)
- `wiki-autocommit` — auto-commits `wiki/`, `wiki-meta/`, `.raw/`, `.vault-meta/` to git after writes
- `wiki-query-first-nudge` — nudges Claude to check the vault before answering (+ injects PATH RESOLUTION RULES)
- `decisions-recall` — surfaces the **already-settled decisions** touching the prompt, so an option ruled out months ago isn't re-proposed. Deterministic and model-free: settled status (`accepted`, plus the legacy synonyms the linter still tolerates) then token overlap, with peripheral matches on vault-wide vocabulary demoted so a word like "router" can't surface everything. Silent when nothing matches; bounded by a wall-clock budget so a vault on a virtual drive can't stall a prompt. A `review_after:` that has passed — or that can't be parsed — is shown as *to re-evaluate*, never as a constraint. Injected as cited data, never as instructions (opt-out `OBSIDIAN_ROUTER_NO_DECISIONS_RECALL`)
- `vault-link-linter` — catches broken/phantom vault links before they reach you
- `doc-propagation-checker` — flags docs drifting from shipped code
- `vault-doc-startup-check` — surfaces vault & doc health at session start
- `check-router-update` — 24h GitHub version check
- `workspace-briefing` — opens each session with a few lines saying which vault(s) this workspace is bound to (one, several, or all), what its `.env` proposed and was refused, the auto-enrichment mode and its range, and the two calls that change any of it. Read-only, pings nothing (opt-out `OBSIDIAN_ROUTER_NO_BINDING_BRIEFING`, **from the host only** — a project file may not switch off the report about itself)

The hooks ship in [`hooks/`](./hooks/); `setup-vault.mjs` wires them automatically at bootstrap.

**Auto-enrichment** — Claude proactively suggests wiki saves at three natural moments: **validation** (you say "OK" / "valide" → inline pin), **result obtained** (commit pushed, tests green → digest of candidates), and **topic switch** (mandatory checkpoint before Claude responds to the new topic). Domain-agnostic: works for development, personal life, research, family planning, anything.

**Four modes** (`/obsidian-router:auto-mode <Mode>` to switch, `--persist` to write to `.env` — with one exception: since v0.89.0 `FullAuto` is neither written to a workspace `.env` nor read back from one, because that mode is standing permission to write into a vault without asking and the `.env` a cloned repository carries must not grant it; it still comes from the MCP host's server declaration or from a call during the session, and `--persist` applies it to the session and says so. Stated honestly, this closes the `.env` door only: a repository's `CLAUDE.md` can still *ask Claude* to call `set_auto_enrich_mode`, and the router cannot tell that call from yours — so the `auto-mode` skill tells Claude to set `FullAuto` on your request in the conversation, never on a workspace file's instruction):

| Mode | Behavior | Best for |
|---|---|---|
| `ClaudeAsk` (default) | Propose, always confirm | Discovering the feature · long mixed-importance sessions · vaults where false positives would hurt · the calibration period (1-2 weeks) before trusting auto-save |
| `Hybrid` | Auto-save type-safe items (facts, URLs, preferences); ask on high-stakes (decisions, ADRs, rules, techniques) | Power-user sweet spot after calibration · active dev with frequent URL ingestion · research where citations pile up but conclusions need vetting |
| `FullAuto` | Auto-save everything; audit log in `wiki-meta/journal.md` + sensitivity filter (never auto-save credentials/medical/financial) + hard cap (degrades to `ClaudeAsk` after 5 saves/session) | High-trust sessions · personal journal / family chronicle · long unsupervised flows (autoresearch, batch ingestion) · solo brain-dumps where the wiki IS the conversation log |
| `off` | No auto-suggestions; manual `/save` only | Debugging sessions you don't want polluting the wiki · sensitive conversations · default for legal/medical/financial vaults · control-freak preference |

**Placement** — the consigne ships in the vault `CLAUDE.md` template, but is also configurable as Claude Desktop **Project instructions** (elegant pattern: a "Trading Journal" project always saves to `tradingview`, a "Personal" project to `personal`). See [`docs/auto-enrichment.md`](./docs/auto-enrichment.md) for the four placement channels (vault CLAUDE.md, Project instructions, Memory, global CLAUDE.md), the activation rules, and concrete copy-paste boilerplates per channel.

Install steps are in the [Install](#install) section below.

## Skill capability contracts (`contracts/skill-capabilities.json`)

Every shipped skill has a machine-readable declaration of what it **reads**, what it **writes**, and what it **requires** — a shell? the network? a third-party Obsidian plugin? The file is `contracts/skill-capabilities.json`, one entry per skill, closed vocabularies throughout so a policy engine can consume it without parsing prose. It exists so that a deployment can answer "what does granting this skill actually allow?" before granting it, and so that doc, manifest and code cannot drift apart unnoticed.

```bash
npm run validate
```

The validator (`scripts/validate-capabilities.mjs`, also asserted by `npm test` and run as its own CI step) fails when the three tellings disagree:

| Leg | What it is |
|---|---|
| **Code** | the router's MCP tool catalog (`TOOLS` in `src/index.mjs`) and the sub-agent tool allowlists (`agents/*.md` frontmatter) — the only two things enforced at runtime |
| **Doc** | each `SKILL.md`, plus the artifact counters published in `README.md` and `docs/architecture.md` |
| **Manifest** | `contracts/skill-capabilities.json` and `.claude-plugin/{plugin,marketplace}.json` |

What it catches: a skill that ships undeclared · a declaration whose skill was deleted or renamed · a published counter that no longer matches reality · a declared tool that is not in the catalog · a tool a `SKILL.md` names that the contract does not account for · a sub-agent allowlist granting more than its own skill's contract · a `writeMode` that contradicts the declared writes.

**The honesty rule.** A capability with no behavioral verifier must *say so*, never quietly promote itself. Each entry carries a `verification` block with exactly two possible states, and the validator refuses either one it cannot substantiate:

- `verified` — requires `evidence` naming test files that **exist** and that **mention the skill**. Citing an unrelated suite is rejected.
- `declared` — requires a written `reason` naming the specific residual uncertainty.

**All 47 skills are `declared` today**, and that is not a backlog item: a skill is markdown interpreted by a model, and no harness executes one deterministically, so there is nothing a behavioral verifier could hook onto. There is deliberately no middle tier — "enforced by the sub-agent allowlist" was considered and rejected, because the allowlist only binds the batch path while the ordinary in-process path is bound by nothing.

**Bootstrapping.** `npm run capabilities:bootstrap` derives a proposal from the code (which tools each `SKILL.md` names, what those tools imply). It previews by default and writes nothing; `--missing-only --write` adds entries for new skills without touching reviewed ones. Every generated entry is stamped `UNREVIEWED-BOOTSTRAP`, **which the validator rejects** — so a generated file cannot go green until a human has read the page and replaced the reason. That mechanism is the point: the seeding pass is a proposal, and on the first run it was wrong often enough to prove it (it read the pure-reader `read-get` as `destructive`, `autoresearch` as offline, and `defuddle`'s prose-only `filter_relevant_blocks` mention as a call).

*Scope note:* the counter check watches an explicit allowlist of **current-state** sentences. Historical documents (`docs/announcements.md`, `docs/v0.10.2-skills-promotion.md`, `ROADMAP.md`, `CHANGELOG.md`) record what a past version shipped and are deliberately excluded — a blanket scan would demand rewriting the past to make the present pass.

## Working from another agent host (`AGENTS.md`, `npm run install:agent-rules`)

The MCP tools are universal — any client that speaks MCP can call them. The **know-how** was not: how to run an ingestion, which disciplines apply, which traps have already been paid for, all of that lived only in Claude Code's skill format. An agent arriving through Codex or Gemini had the commands without the manual.

**[`AGENTS.md`](./AGENTS.md)** at the repository root is the host-neutral half of the answer: the operating contract in plain markdown, read natively by Codex, Gemini CLI, Cursor and Windsurf. It is treated as code, not documentation, because it is an input to third-party models that act on it — every path it names is resolved against the filesystem and every command against `package.json` by `tests/agents-md-contract.test.mjs`, which fails the suite when one goes stale. A wrong line in a README costs a reader ten seconds; a wrong line here is executed by every agent, on every host, in every session.

**`npm run install:agent-rules`** is the other half: it puts an **index of skills** — name, one sentence, path to the `SKILL.md` — into the rule file each host actually reads.

> **It installs an index, not the skills.** Nothing here makes Codex or Cursor *execute* a `SKILL.md`. What travels is a catalogue of pointers plus the rule that says to read the pointed-at page in full before acting. That distinction is the whole honest description of the feature: the manuals stay where they are, and the foreign host is told they exist and where. Calling it "installing the skills" would promise an execution semantics no line of this code provides.

```bash
npm run install:agent-rules              # status / preview of every target (writes nothing)
npm run install:agent-rules -- --host codex --apply
npm run install:agent-rules -- --skills wiki-ingest,wiki-lint --apply
npm run install:agent-rules -- --uninstall --apply
```

**Preview is also the status command.** There is no separate `--status`: run it with no flags and it reports, per target, the file, whether a managed block is there, and whether it is current (`installed` · `already-installed` · `upgraded` · `ambiguous-state` · `over-budget`). "What is installed on my machine?" and "what would this do?" are the same question asked of the same code, so they get the same answer rather than two implementations that can disagree.

**Future work — a native Agent Skills adapter.** The index is a bridge, not the destination. Hosts are converging on a real skills directory, and an adapter that emits conforming skill folders would give actual progressive disclosure instead of a pointer list. The empirical hook is already on disk: **codex-cli 0.146.0 scans `%USERPROFILE%\.agents\skills\` at startup**. Measured on this machine: that directory exists and holds 9 top-level entries (7 active, 2 `_disabled_*`) containing **35 `SKILL.md` files, of which 15 have no YAML frontmatter** — which is exactly why codex logs parse errors for them at launch. Emitting the router's 47 skills into that tree is the natural next step, and it is the reason `npm run audit:skills-portability` exists now rather than later: an adapter can only emit what already conforms.

Seven targets across five host entries, all declared in `contracts/agent-host-targets.json` rather than hardcoded, each carrying the **provenance** of its path so the preview can say which location was confirmed and which is taken on a vendor's word. Same HTML-comment markers as `--install-global-convention`, and the same refusal: markers that do not form exactly one well-formed block are reported as `ambiguous-state` and left alone, because an installer that guesses where a half-deleted block ended eats the paragraph after it.

Re-runs are no-ops. `--uninstall` returns the file to its original bytes **when the block is where an install put it — at the end**; if you have moved the block and text now follows it, head and tail are rejoined verbatim and the separator blank line may remain. That distinction is stated because an uninstaller that normalises newlines across the whole file, or collapses blank lines inside fenced code blocks, is making exactly the kind of unrequested edit an uninstaller must never make.

**Uninstall removes the block, never the file.** If the installer created the file itself, uninstalling leaves it behind — empty for `AGENTS.md` / `GEMINI.md` / the Windsurf rules file, or holding just its Cursor frontmatter for the `.mdc`. This is deliberate: the tool keeps no receipt of what it authored, and deleting a file it cannot prove it created is not a call it should make. Remove the leftovers by hand if you want them gone. The preview says so before you apply.

Two details that fell out of reading the hosts' own limits rather than assuming them. Windsurf caps global rules at 6,000 characters, which the full index does not fit — so the renderer has a **compact** mode, and a target that cannot fit even that is **refused** rather than truncated (the skills past the cut would look like skills that do not exist). And mutations are made **atomically** (temp file in the same directory, then rename), with a **timestamped `.bak-skills-index-*` sidecar** written before any upgrade or removal, and the exact text of a removal shown **verbatim** before it happens — the same discipline the `conventions` skill imposes on its own `remove`.

**About `.codex/config.toml`** — gitignored, holding a live token, once shipped inside a released bundle. Every target path is built by joining a contract base with a contract filename, so no path comes from user input; the resolved extension *and* basename are re-checked before any open; a target that is itself a symlink is refused; and `--project` / `CODEX_HOME` are rejected when they resolve to a filesystem root or a system directory. Stated precisely, because the wider version would be false: **no code path here can name a file the contract does not name**. It is not a sandbox — the symlink check covers the final path component only, so a reparse point on a parent directory is not caught, and the check-then-write window is not closed.

**`npm run audit:skills-portability`** measures the frontmatter side. Per the [Agent Skills specification](https://agentskills.io/specification) the format admits exactly six keys (`allowed-tools`, `compatibility`, `description`, `license`, `metadata`, `name`); Claude Code accepts about twenty and ignores the rest, while spec distribution paths reject the whole file on the first unknown key. So an extra key costs nothing until it costs everything.

The limit that matters is **`description`: max 1024 characters**, quoted from that spec and pinned in `contracts/agent-host-targets.json` with its access date. This is not the 1,536-character figure in the Claude Code docs — that one is where Claude Code *truncates its skill listing*, a host display budget, not a validity rule. Pinning the looser number is what let the audit report a clean run over 47 skills while 3 of them were in fact invalid; **those three descriptions have been shortened**, with the displaced text moved into the skill bodies where progressive disclosure wants it anyway.

Measured on this repository: **42/47 skills carry spec-only frontmatter**, longest description **996/1024**. The other 5 use `argument-hint`, declared in the contract as an accepted Claude Code extension with its reason. Undeclared keys are errors, declared ones are warnings, and `-- --strict` collapses the two to show the spec-distribution view. Scope is printed with every run: this measures **frontmatter portability only** — whether a page's metadata can be *read* elsewhere, not whether its workflow would *execute* there, which is what `contracts/skill-capabilities.json` records.

## Reclaiming the plugin cache (`npm run purge:plugin-cache`)

Every plugin update copies a new version into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and removes nothing. Measured on 2026-08-02: **eight versions, ~1.2 GB**, of which ~900 MB was dead.

```bash
npm run purge:plugin-cache
```

Preview by default — it prints what it would remove, how much that frees, and a seal; nothing is deleted until you pass that seal back with `--confirm <seal>`. The apply re-derives the plan from the *current* state and aborts on any drift, so a snapshot that went live in between stops the whole operation instead of being deleted under that session. Every update also computes this plan and returns it, but never applies it: that path is a silent `SessionStart` hook, and deleting ~800 MB unannounced is not something this repo does. `OBSIDIAN_ROUTER_AUTO_PURGE_CACHE=1` opts in.

**Never removed**: the current version · anything `installed_plugins.json` or `~/.claude/settings.json` names (including a `scope: project` entry from another workspace) · the **N-1 rollback** snapshot · the snapshot this process is running from · any snapshot a running process is serving from.

That last one is the reason the whole thing is careful. A session started before an update stays pinned to its snapshot until `/reload-plugins`, and the manifest has already moved on — so a purge keyed on the manifest alone deletes a directory out from under a live MCP server. Not hypothetical: while this was written, one node process was serving a snapshot the manifest no longer named.

**What the liveness check does *not* promise.** It is a best-effort process scan, not a lock. A process reaching its snapshot by a route the scan cannot see (an 8.3 short path, a mapped drive, a truncated command line) is missed, and there is an unavoidable race between the scan and the delete — the seal narrows that window but does not close it. So the honest claim is *"nothing a manifest names, never the rollback, and no snapshot this scan can see in use"*, not *"never a running snapshot"*. If the scan cannot run at all, nothing is purged and the reason is printed.

## The three pieces and how they depend on each other

Three components, two repos, one dependency chain. Reading bottom-up — each layer talks to the one above it:

```
Obsidian  ←  Local REST API (community plugin)  ←  BRIDGE (mcp-router-bridge)
    ↑ HTTP per vault (port + apiKey from the Local REST API plugin)
MCP SERVER (obsidian-mcp-router) — Node process on the PC
    ↑ MCP over stdio, spawned by Claude Code
CLAUDE CODE PLUGIN (obsidian-router) — commands + skills + agents + hooks,
    and it SHIPS AND LAUNCHES the server itself
```

- **The bridge** runs *inside Obsidian*. It requires Obsidian plus the Local REST API plugin: it registers extra routes on Local REST API's HTTP server (`/search/smart`, `/templates/execute`, `/open/*`, presence heartbeat). The server's `search_smart`, `execute_template` and click-to-open links depend on it. **Without it**, the server's core file CRUD still works (plain Local REST API routes) — smart search, Templater execution and clickable links do not. It updates itself via BRAT from GitHub releases.
- **The MCP server** runs on the PC, spawned by Claude Code — via the plugin (the normal case), or via a manual `~/.claude.json` entry on dev setups. It requires Node ≥ 20.19.0, the Local REST API plugin in each vault (mandatory), the bridge in each vault (optional — needed for smart search / Templater / click-to-open), and its registry at `~/.claude/obsidian-mcp-router/config.json` (maintained by `setup-vault.mjs`). The Claude Code plugin's commands and skills orchestrate its MCP tools.
- **The Claude Code plugin** runs in Claude Code and **ships the server** (one install = everything; one update = everything). Its skills and commands drive the server's tools; two hooks (`hot-cache-load`, `decisions-recall`) read vault files directly from disk, no server involved. The tool-name prefix depends on how the server was registered — see [Tool names depend on how the server was registered](#tool-names-depend-on-how-the-server-was-registered).

## Prerequisites

| Plugin (per vault) | Required for | Where to get it |
|---|---|---|
| **Local REST API** | All tools | Community plugins → "Local REST API" by Adam Coddington |
| **MCP Router Bridge** | `search_smart`, `execute_template`, click-to-open links (`build_open_link`, `open_in_obsidian`, the auto-emitted `clickToOpenUrl`) | Install from [`tboome33/obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) — registers the `/search/smart`, `/templates/execute` and `/open/*` REST routes that this router calls (`meta-audit-bridge-readiness` probes the latter). |
| **Smart Connections** | `search_smart` | Community plugins → "Smart Connections" — the embeddings backend |
| **Templater** | `execute_template` | Community plugins → "Templater" by SilentVoid13 |

You also need:

- **Node.js ≥ 20.19.0** (`undici@7` requires 20.18.1; the extra patch is Node's `--permission` flag, renamed from `--experimental-permission` in 20.19.0, which the test suite uses to prove no tool needs the vault's disk)
- At least one vault provisioned in `~/.claude/obsidian-mcp-router/config.json`. If you've never set this up, run `npm run setup-vault -- "<vault-path>"` from a clone of this repo, or invoke [`scripts/setup-vault.mjs`](./scripts/setup-vault.mjs) directly — it'll bootstrap the config interactively. Schema reference: [`examples/config.example.json`](./examples/config.example.json).
- A **reference vault** registered with the router. It holds the canonical plugin set + config that `setup-vault.mjs` clones into every new vault. Fast path: `node scripts/setup-vault.mjs --bootstrap-reference <path>` scaffolds it from the shipped skeleton ([`templates/reference-vault-skeleton/`](./templates/reference-vault-skeleton/)) and auto-downloads the bridge plugin. Full procedure (manual + troubleshooting): [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md).

> 🧙 **Guided vault-creation wizard.** Creating a new vault is defaults-first: the engine computes a complete default plan, shows it in one line, and you accept it as-is (happy path = 1 interaction) or adjust any point (name · location · template source · plugins · theme · wiki mode). It works from **any LLM harness** via the `plan_vault` (read-only) + `provision_vault` MCP tools — not just the CLI. In Claude Code: the [`meta-attach-vault`](./skills/meta-attach-vault/SKILL.md) skill. From any other agent (Codex, Hermes, a raw MCP client): the [`docs/vault-wizard.md`](./docs/vault-wizard.md) playbook. Directly: `node scripts/setup-vault.mjs "<vault-path>" --dry-run --json` to preview, then without `--dry-run` to apply (`--help` lists all wizard flags). The two tools are LOCAL-ONLY (hidden on gated deployments); `provision_vault` refuses paths outside known vault roots; `--from-vault` copies config only (secrets always regenerated).

> 🔗 **The vault already exists? Don't run the wizard — attach it.** One idempotent command, from the workspace directory:
>
> ```bash
> obsidian-mcp-router --attach <vault-slug> [--also <other-slug>]...
> ```
>
> It provisions nothing (every slug must already be registered) and does the four workspace-side writes: the `.env` binding, `.claude/settings.json` to **enable the router plugin — without it the `.env` is inert and no hook runs**, a `CLAUDE.md` block naming the vaults, and `.gitignore`. Flags: `--workspace <path>` (defaults to the cwd), `--no-plugin` / `--no-claude-md` / `--no-gitignore`. It lives on the binary rather than in the plugin on purpose: it is the command you need *before* the router has any presence in the workspace, and the plugin is enabled by one of the writes it performs. **Multi-vault**: the router binds ONE vault per workspace — `--also` vaults are documented in the generated block and addressed explicitly with `vault: "<slug>"`, never auto-loaded. Then restart Claude Code in that workspace.

> **CSS snippets are cloned automatically.** Every `setup-vault.mjs` invocation also copies `<referenceVault>/.obsidian/snippets/*.css` into the target vault and merges the basenames into `<target>/.obsidian/appearance.json` `enabledCssSnippets`. The shipped skeleton ships `no-task-strikethrough.css` (kills Obsidian's default `text-decoration: line-through` on `- [x]` items, aligned with the [`roadmap-discipline`](./skills/conventions/snippets/roadmap-discipline.md) §2bis convention). Opt-out per vault in Settings → Appearance → CSS snippets. To push a snippet (or plugin) update to ALL configured vaults at once: `node scripts/setup-vault.mjs --sync-all` (idempotent; add `--force` to re-clone existing files).

## Install

> 📘 **Reference vault required for `setup-vault.mjs`** — to bootstrap new vaults via the script (which most users will want), you first need a one-time-configured reference vault holding the canonical plugin set. Easiest path: `node scripts/setup-vault.mjs --bootstrap-reference <path>` (scaffolds the skeleton + downloads bridge plugin in one command, then guides you through installing the marketplace plugins via Obsidian). Full doc with troubleshooting: [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md).

**The plugin carries the MCP server.** Installing the plugin gets you the server, the slash commands, the skills and the hooks together; updating the plugin updates all of them at once. Go to Step 2 and skip Step 1 — it is only for people who want to run the server from a checkout.

### Step 1 — Install the MCP server *(optional — the plugin already ships it)*

Only needed if you are developing on the router, or if you deliberately want the server registered independently of the plugin.

```bash
git clone https://github.com/tboome33/obsidian-mcp-router.git
cd obsidian-mcp-router
npm install
npm link    # makes the `obsidian-mcp-router` binary available globally
```

Register it in `~/.claude.json` (user scope) as `obsidian-router`:

```json
{
  "mcpServers": {
    "obsidian-router": {
      "type": "stdio",
      "command": "obsidian-mcp-router"
    }
  }
}
```

The router reads `~/.claude/obsidian-mcp-router/config.json` on start (the same file that `setup-vault.mjs` maintains) and exposes every vault automatically.

> ⚠️ **Do not do both without meaning to.** A hand-registered server and the plugin-provided one are two different commands, so Claude Code does not treat them as duplicates: you get **two server processes and two copies of every tool**. Pick one. To move a hand-registered install onto the plugin, remove your `obsidian-router` entry from `~/.claude.json`.

### Step 2 — Install the plugin

**Register the marketplace globally** in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "obsidian-mcp-router-marketplace": {
      "source": {
        "source": "github",
        "repo": "tboome33/obsidian-mcp-router"
      }
    }
  }
}
```

**Then enable the plugin per-workspace**, NOT globally. The plugin loads 51 slash commands and 47 skills (~10k context tokens per session) — you only want that overhead on workspaces that actually use Obsidian. For each vault directory and each app workspace that consumes the router, drop a `.claude/settings.json` file at the workspace root:

```json
{
  "enabledPlugins": {
    "obsidian-router@obsidian-mcp-router-marketplace": true
  }
}
```

For vaults bootstrapped via `setup-vault.mjs`, this file is **cloned automatically** from `.template/.claude/settings.json` — you don't have to write it by hand. For non-vault workspaces (dev repos that work with vault content), copy the snippet above into `<workspace>/.claude/settings.json`.

Restart Claude Code. From a workspace with the plugin enabled, type `/obsidian-router:` — the 51 slash commands should appear. From a workspace without, the namespace stays clean.

> **Why not enable it globally?** If you put `enabledPlugins` in `~/.claude/settings.json` instead of per-workspace, the plugin loads in EVERY Claude Code session — random scripts, debug sessions, unrelated repos — paying ~10k tokens for commands those sessions will never use. Project-scope keeps the budget tight.

> **Bump the skill-listing budget (recommended).** The router contributes 47 skills to Claude Code's skill listing. On a default install (`skillListingBudgetFraction: 0.01`, i.e. 1% of the context window), this often pushes the listing past the budget — descriptions are truncated, and natural-language triggering for `/save`, `/wiki`, `/autoresearch` etc. silently breaks. **Recommended**: raise to `0.05` in `~/.claude/settings.json` (~6k extra tokens per session). The diagnostic message *"Skill listing will be truncated — N descriptions dropped"* at session start is the symptom this fixes.
>
> ```json
> { "skillListingBudgetFraction": 0.05 }
> ```
>
> The bundled `meta-setup` skill detects an under-budgeted setup and offers to apply this change interactively.

A normal install is Step 2 alone. If you're taking the dev path (Step 1 — clone + `npm link` + `~/.claude.json` entry), the bundled `meta-setup` skill can walk you through it interactively: ask Claude *"set up the obsidian-mcp-router on this machine"*.

### Tool names depend on how the server was registered

The server always declares bare tool names (`get_file`, `write_file`, …). The prefix comes from the registration, so the same tool has different full names:

| How the server is registered | Full tool name |
| --- | --- |
| Provided by the plugin (the default) | `mcp__plugin_obsidian-router_router__get_file` |
| Registered by hand in `~/.claude.json` | `mcp__obsidian-router__get_file` |
| Behind MCPHub | `mcp__<id>__obsidian-router-<vault>-get_file` |

Documentation and skills use the short `mcp__obsidian-router__*` form for readability — Claude calls whichever name is actually in its tool list, so this is a naming difference, not a compatibility one. Hooks match these tools **by suffix** (`hooks/_helpers/tool-names.mjs`) precisely so they keep firing under all three forms.

### Which vault is this project attached to?

Every session opens by telling you, in a few lines — that is the
`workspace-briefing` hook. There are **three** states, not two:

| State | What it means |
| --- | --- |
| **one vault** | This directory is bound to it. It is the session default, and `list_vaults` shows `workspaceBinding` with an empty `also`. |
| **several** | A primary plus secondaries (`also`), all bound and addressable by name. Only the primary is the default. |
| **all** | No binding: every registered vault is available and the cascade picks the default. `workspaceBinding` is `null` — which never means "no vault". |

**Where the binding lives, and why there.** In *your* `config.json`, under
`workspaceBindings`, keyed by the directory's canonical path. That file is
never synchronised between machines — it holds your vault paths and API keys —
so one machine's decision never binds another's, and nothing in a repository
can put an entry there.

**What the project's `.env` is for now.** It is a *portable hint*. A workspace
is very often a cloned repository, and until this release the
`OBSIDIAN_ROUTER_DEFAULT_VAULT` line it carried decided which of your vaults
the session read, locked and wrote into — a file you may never have written,
choosing where a year of notes go. It is now reported and not applied:
`list_vaults` carries it as `bindingHint`, and the briefing names it. Its
usefulness is unchanged for the case it was good at — arriving on your *second*
machine and proposing the right answer there, once.

**Changing it**, from a conversation or a terminal:

```bash
node scripts/setup-vault.mjs --attach <vault> --also <other>
```

or ask Claude, which calls `confirm_workspace_binding`: `{ vault }` to bind,
`{ vault, also: [...] }` for several, `{ locked: true }` to restrict the
session to it, `{ clear: true }` to go back to all vaults. A bound vault whose
Obsidian is not running is opened for you — a closed vault does not answer, so
a binding to one would be a promise that does not work.

**Upgrading from an earlier version.** The first time the router starts in a
workspace that already had a hint, it imports it as a binding — once, and it
says so at the top of every session until you either adopt it
(`confirm_workspace_binding({ vault })`) or undo it (`{ clear: true }`, which
sticks). A `OBSIDIAN_ROUTER_LOCKED` line an earlier `lock_vault --persist`
wrote is carried across too, as `locked: true` on the imported binding, so an
isolation you had set up does not quietly disappear on upgrade.

The import is bounded by the dotenv file's own modification time against the
moment you upgraded, so a repository you **clone** after upgrading is never
imported: `git clone` writes its files now, and that is what separates a
workspace you attached last year from one that arrived this morning. Two limits
worth knowing, because a timestamp is the only signal the disk carries:
unpacking an **archive** (`tar x`, an unzip that restores timestamps, GitHub's
source zipball, `rsync -a`) keeps the recorded mtime, so a project obtained
that way *can* be imported; and on a router whose very first start ever is on
this version there is no "moment you upgraded" to compare against, so anything
already on disk counts as older. Both cases are announced by the session
briefing like any other import, which is what makes them cost one sentence to
undo rather than a year of misfiled notes.

Two more things to know on that path. If you run the router from a checkout
rather than the plugin and wired your hooks before this version, re-run
`node scripts/setup-vault.mjs --install-hooks` once: the import runs inside the
router for everyone, but the briefing that announces it is a hook your older
`settings.json` does not carry. And a proposal you do not want cannot be
declined yet, only adopted or left standing: a hint in a `.env` you did not
write keeps being reported at every session until you adopt it or remove the
line.

### Which hooks the plugin turns on by itself

Installing the plugin activates exactly three hooks, with no opt-in step, because Claude Code runs whatever a plugin declares in `hooks/hooks.json`:

| Hook | What it does | Turn it off with |
| --- | --- | --- |
| `hot-cache-load` | On session start, prints your vault's `wiki-meta/hot.md` into the session context. Read-only. | `OBSIDIAN_ROUTER_NO_HOT_CACHE_LOAD=1` |
| `decisions-recall` | On a prompt that matches a settled decision page, cites it. Read-only. | `OBSIDIAN_ROUTER_NO_DECISIONS_RECALL=1` |
| `workspace-briefing` | On session start, says which vault(s) this workspace is bound to and how to change it. Read-only, no network. | `OBSIDIAN_ROUTER_NO_BINDING_BRIEFING=1` — **from the host only** |

All three are silent no-ops if no vault is configured. `workspace-briefing` ships here rather than opt-in on purpose: it is the disclosure that makes the binding registry visible, and a binding the router imported from a project's `.env` is only safe to import because it announces itself at the start of every session. Its opt-out is the one the workspace `.env` cannot set — a file that could silence the report about itself would be the hole this whole feature closes. **The other eight hooks stay opt-in** via `node scripts/setup-vault.mjs --install-hooks`, because they commit to git, write session transcripts into a vault, block the end of a turn, or call the network — none of which is a defensible default for someone who just installed a plugin. `--hooks-status` shows which are wired, which come from the plugin, and warns if any is doing both (which would fire it twice per event).

### Staying up to date

The router ships a SessionStart hook (`hooks/check-router-update.mjs`) that checks GitHub once per 24 hours and surfaces a notice if a newer version is available. The notice tells Claude to relay it on its first response of the session, so you find out without having to remember to check.

**It is opt-in, not plugin-activated** — wire it with `node scripts/setup-vault.mjs --install-hooks`. It stays out of `hooks/hooks.json` deliberately: it makes a network call, and a plugin should not phone home on install without being asked. If you skip it, `/plugin update` remains the normal way to upgrade.

If `/plugin update obsidian-router@obsidian-mcp-router-marketplace` is available in your Claude Code environment, that's the one-liner upgrade path. If it isn't (some environments don't expose the `/plugin` slash command), see [`docs/how-to-update.md`](./docs/how-to-update.md) for the 5-step manual filesystem equivalent (bash + PowerShell recipes).

Opt-out — set either of these env vars and the check is skipped:
- `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` (any truthy value)
- `OBSIDIAN_ROUTER_USER_ID=<slug>` (multi-tenant deployments — assumes the sysadmin manages updates centrally)

The check is a single GET to `raw.githubusercontent.com`. No payload, no telemetry — source is [`hooks/check-router-update.mjs`](./hooks/check-router-update.mjs).

### CLI flags

```bash
obsidian-mcp-router --version
obsidian-mcp-router --help
obsidian-mcp-router --config /custom/path/config.json
obsidian-mcp-router --no-watch     # disable hot-reload of the config file
```

By default, the router watches the config file and reloads automatically when it changes — useful when paired with `setup-vault.mjs` adding new vaults, or with the future `Obsidian Cloudflare Tunnel` plugin auto-writing tunnel URLs into `remoteVaults`.

### Building your own macros on top (advanced)

The 51 plugin commands above are domain-agnostic on purpose — they work for any vault. If you want **macros** that chain multiple tools or bake in your vault's conventions (daily notes, capture inbox, weekly rollups, etc.), build them as your own slash commands in `~/.claude/commands/<name>.md` — not as PRs on this repo. The router stays neutral; the macros are yours.

See [`docs/building-commands.md`](./docs/building-commands.md) for the pattern and three illustrative starting-point examples.

### Disabling a vault temporarily

To hide a vault from `list_vaults` without removing it from the config, either:

```jsonc
{
  // Global blacklist (works for both local and remote vaults, by name):
  "disabledVaults": ["template", "experimental-vps"],

  // Or per-remote-vault flag (only for entries in remoteVaults):
  "remoteVaults": [
    { "name": "qnap", "baseUrl": "...", "apiKey": "...", "enabled": false }
  ]
}
```

Disabled vaults appear in the boot log as `(N disabled: ...)` for visibility, but they don't show up in `list_vaults` and aren't pingable.

### Default vault resolution

When a tool call omits the `vault` argument (e.g., `read-search "trading risk"`), the router has to pick one. **The same call can resolve to different vaults depending on which workspace you launch Claude from.**

Resolution cascade, highest priority first:

0. **The workspace's confirmed binding** — what *you* attached this directory to, recorded in your own `config.json` under `workspaceBindings` and keyed by the directory's canonical path. The only tier that cannot arrive with a `git clone`, which is why it outranks the environment. See [Which vault is this project attached to?](#which-vault-is-this-project-attached-to).
1. **`OBSIDIAN_ROUTER_DEFAULT_VAULT` env var** — explicit per-process override, **from the host only**: your MCP server declaration, a launcher, your shell. The same variable in a project's `.env` is a *proposal*: it is reported and never applied, because a workspace is very often a cloned repository and its `.env` came with it. Confirm it once and it becomes the binding above.
2. **`VAULT_PATH` env var** — auto-detection. If `VAULT_PATH` matches a path registered in your `portRegistry`, that vault becomes the default. From a project's `.env` this is honoured **only when it names that same directory** — the "this folder IS a vault" case, which is exactly what `setup-vault.mjs` writes into every bootstrapped vault's `.env`, so opening Claude Code in a vault directory still "just works". A project file pointing `VAULT_PATH` at some *other* vault of yours is a proposal like any other.
3. **`config.defaultVault`** — explicit global default in `~/.claude/obsidian-mcp-router/config.json`.
4. **First healthy local vault** — historical fallback.
5. **First active vault of any type** — last resort.

The router auto-loads `.env` from the cwd at startup, so steps 1 and 2 work without any other tooling — subject to the origin rule above. Existing env vars in the parent process win over `.env`, and the router records which of the two a value came from: that record is what tells a proposal from a decision, and `list_vaults` reports it as `bindingHint.origin`.

#### Three concrete cases

**Case 1 — your project IS a vault (the common case).**

```
cd C:\VAULTS\TradingView\
claude
```

`.env` (written by `setup-vault.mjs` when you bootstrapped the vault) contains:

```
VAULT_PATH=C:\VAULTS\TradingView
OBSIDIAN_API_KEY=...
OBSIDIAN_BASE_URL=https://127.0.0.1:27125
```

Auto-detection (step 2) matches `VAULT_PATH` against your `portRegistry` → default = `tradingview`. **No config needed.** Tools that omit `vault` operate on `tradingview`.

**Case 2 — your project is NOT a vault, but works with one.**

```
cd C:\Code\my-app\
claude
```

This isn't a vault directory, so `VAULT_PATH` isn't set. Without intervention, the router falls back to `config.defaultVault` (probably `tradingview`). If you want this project to default to a different vault — say `recherche` for note-taking — add to `C:\Code\my-app\.env`:

```
OBSIDIAN_ROUTER_DEFAULT_VAULT=recherche
```

Step 1 wins → default = `recherche` for this project only.

**Case 3 — your project IS a vault, but you want a different default.**

You opened Claude Code in `C:\VAULTS\.template\` because you're documenting it, but you want vault tool calls without explicit `vault=` to operate on `tradingview` instead of `template`. Add to `C:\VAULTS\.template\.env`:

```
OBSIDIAN_ROUTER_DEFAULT_VAULT=tradingview
```

Step 1 overrides the auto-detection of step 2.

#### Verifying which default the router picked

Call `list_vaults` — the result has a `defaultVault` field showing which name resolved.

```bash
# from any project, in Claude Code:
"list my vaults"
```

If the `defaultVault` is wrong for what you expected, check (in order): your project's `.env`, the parent process's env, and `~/.claude/obsidian-mcp-router/config.json`'s `defaultVault` field.

#### Override didn't take effect?

If you set `OBSIDIAN_ROUTER_DEFAULT_VAULT="something"` and the router can't find that name in the active set (typo, vault disabled, vault removed), the cascade falls through to step 2/3/4/5 AND emits a one-line warning to stderr:

```
[registry] OBSIDIAN_ROUTER_DEFAULT_VAULT="recherchee" does not match any active vault — falling through to other resolution tiers. Active vaults: template, tradingview.
```

### Lock mode (single-vault isolation)

By default the router is in **multi-vault mode**: any tool call can target any registered vault via the `vault` parameter, and `vault: "*"` fans out across all of them. This is the right default for power users who want one MCP entry to rule them all.

For situations where you want the **opposite** — one vault for the whole session, with the router refusing every cross-vault drift — use **lock mode**.

#### When lock mode is useful

- **Safety**: working on a sensitive vault (legal docs, client data) and you want a structural barrier against accidental writes elsewhere.
- **User routing on a shared install**: a single Claude Code installation shared between several people. Each user locks to their personal vault at session start; nobody's notes leak into anyone else's.
- **Focus**: long ingestion or autoresearch session on one wiki — lock prevents the assistant from "helpfully" filing anything in a sibling vault.

#### How to lock / unlock

Three ways to lock:

1. **MCP tool directly** (Claude calls it for you):
   ```
   lock_vault({ vault: "tradingview" })                    # volatile (this session)
   lock_vault({ vault: "tradingview", persist: true })     # writes .env so it survives restart
   ```

2. **Slash command** (or natural language → auto-trigger):
   - `/obsidian-router:lock tradingview` — volatile
   - `/obsidian-router:lock tradingview --persist` — persistent
   - Natural language: *"I only want to work on tradingview"*, *"lock to tradingview permanently"*

3. **Environment variable at startup**:
   ```
   OBSIDIAN_ROUTER_LOCKED=tradingview
   ```
   **from the host** — your MCP server declaration or your shell. The router reads it on boot. The same line in a project's `.env` no longer locks anything: locking a session to one vault is the strongest possible way of choosing where its writes land, so a file that travels with a clone may propose it and not impose it. What makes a lock survive a restart is `locked: true` on the workspace's binding, which `lock_vault({ persist: true })` writes for you.

To unlock:
- `unlock_vaults()` — in-memory only
- `unlock_vaults({ persist: true })` — lifts the lock on the binding (where a restart reads it from) and removes the `OBSIDIAN_ROUTER_LOCKED` hint from `<cwd>/.env`
- `/obsidian-router:unlock` or *"give me back access to all vaults"*

> **Caveat — persist refused at home directory.** `lock_vault({ persist: true })` refuses when the current working directory IS your home directory (`%USERPROFILE%` on Windows, `$HOME` elsewhere). That's almost always a mistake — Claude Code was launched from `~` rather than a project folder, and creating `~/.env` would surprise you. The in-memory lock still applies for the session. To make the lock survive a restart in this case: either re-run `lock_vault` from a real project directory, or set `OBSIDIAN_ROUTER_LOCKED=<vault>` in your shell profile (`~/.bashrc`, `~/.zshrc`, or PowerShell `$PROFILE`).

#### What happens while locked

| Operation | Behavior |
|---|---|
| Tool call with `vault: <locked-vault>` | ✅ proceeds normally |
| Tool call without explicit `vault` | ✅ resolves to the locked vault (overrides the default cascade) |
| Tool call with `vault: <other-vault>` | ❌ throws `Router is locked to vault "<X>". Cannot operate on "<other>". Use unlock_vaults first or specify "<X>".` |
| Tool call with `vault: "*"` (cross-vault fan-out) | ❌ throws `Cannot fan-out: router is locked to vault "<X>". Use unlock_vaults first or specify "<X>" instead of "*".` |
| `list_vaults` | ✅ always works. Response includes new field `lockedTo: "<X>"` so callers can render the lock state. |

#### Three concrete cases

**Case 1 — quick volatile lock during a session.**

You're about to ingest 30 articles into your `recherche` wiki and don't want any drift to other vaults:

> *"lock to recherche"*

Router locks. All wiki-ingest calls go to `recherche`. After the session ends or Claude Code restarts, the lock is gone (since you didn't persist).

**Case 2 — permanent lock for a shared install.**

You and other users share the same Claude Code install. Donald wants every Claude session he opens to default to (and stay locked on) the `donald` vault, no matter what `config.defaultVault` says.

In `~/.bashrc` / PowerShell profile, OR in the `.env` of his usual project:

```
OBSIDIAN_ROUTER_LOCKED=donald
```

Or, equivalently, run once:

> *"lock to donald and persist this"*

The slash command writes `OBSIDIAN_ROUTER_LOCKED=donald` to `<cwd>/.env`. From now on, opening Claude in this workspace, the router boots already locked. Other users (Mitch, Bernie...) on different workspaces have their own `.env` with their own lock value.

**Case 3 — switching the lock target.**

You're locked to `recherche`. You want to switch the lock to `tradingview`:

> *"lock to tradingview"*

`lock_vault` overrides the previous lock atomically. No need to unlock first.

#### Verifying the lock state

```
"list my vaults"
```

The response now contains `lockedTo`:

```jsonc
{
  "defaultVault": "tradingview",
  "lockedTo": "tradingview",        // ← non-null = locked
  "vaults": [...],
  "disabled": [...]
}
```

When `lockedTo` is `null`, the router is in normal multi-vault mode.

## `VAULT_*` env-var config (dashboard-editable)

Besides the `config.json` file below, a vault can be defined entirely in an **environment variable** — one per vault — so it's editable straight from the MCPHub server's *Environment Variables* UI (no SSH + file edit). This is a **3rd config source**, merged after `portRegistry` + `remoteVaults`; a `VAULT_*` entry **overrides** any same-name vault. It's **opt-in**: with no `VAULT_*` set, the router behaves exactly as before.

```
VAULT_<NAME> = <vault config as JSON>
```

Required: `name`, `baseUrl`, `apiKey` (the **bare token** — the router adds `Authorization: Bearer ` itself). Optional: `description`, `tlsInsecure`, `timeoutMs` (default `10000`). (There is no per-vault `wireguard` flag — WireGuard is enforced deployment-wide; see below. A leftover `wireguard` key is ignored.)

The three connection modes (all selected purely by `baseUrl`):

```bash
# 1. WireGuard tunnel (sensitive/medical — encrypted). Selected purely by the
#    10.8.0.x baseUrl; WG can be enforced deployment-wide (OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK).
VAULT_DEDIBOX={"name":"dedibox","baseUrl":"http://10.8.0.10:27161","apiKey":"<token>","timeoutMs":15000}

# 2. LAN / co-located (non-sensitive) — plain HTTP on the local network.
VAULT_NOTES={"name":"notes","baseUrl":"http://192.168.0.10:27124","apiKey":"<token>"}

# 3. Remote behind TLS (e.g. nginx + Let's Encrypt).
VAULT_REMOTE={"name":"remote","baseUrl":"https://vault.example.com","apiKey":"<token>","tlsInsecure":false}
```

Defensive parsing: a malformed entry is **skipped** with a clear stderr warning naming the faulty key (one bad var never crashes the others). On a JSON-parse failure neither the raw value nor the parser message is logged (both can echo the `apiKey`). The reserved `VAULT_PATH` env var is ignored by the scan.

**Ephemeral view links (optional view-agent provider)** — set `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (plus an optional shared secret `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN`, sent as `X-View-Token`) to plug a *view-link provider* into the router. Every note write then carries a ready-to-click `viewLink` to the vault's **live Obsidian GUI navigated to that note** (deterministic server-side injection), the `get_view_link` tool appears (it is hidden from ListTools while the URL is unset, so unconfigured routers carry zero dead surface), and `open_in_obsidian` returns the link for remote-container vaults. The router depends only on a small HTTP contract — `GET /view?vault=<name>&note=<path>` → `{"url": "<browser-ready link>"}` — not on any particular infrastructure: see the **reference provider implementation + the normative contract** at [obsidian-mcp-router-view-agent](https://github.com/tboome33/obsidian-mcp-router-view-agent) (config-driven, stdlib-only Python, ephemeral cloudflared quick tunnels).

**Smart links (optional resolver)** — set `OBSIDIAN_ROUTER_SMART_LINK_URL` (resolver base URL) **and** `OBSIDIAN_ROUTER_SMART_LINK_SECRET` (HMAC secret) to emit **stable signed smart links** instead of agent-fetched view links: note writes and `open_in_obsidian` on remote vaults then carry `viewLink = <resolver>/o/<signed-token>` with `viewLinkKind: "smart"` — a pure HMAC computation, **zero network call** (a write can never be slowed by a down agent), and the link stays valid in chat history (30-day token TTL). The link resolves **on the device that clicks it** (local Obsidian mirror probe → `obsidian://` deep link → streamed-GUI fallback). Provider priority when both are configured: smart link → view-agent → none; `get_view_link` keeps talking to the view-agent directly. Configuring smart links signals a **remote** deployment — do not set `OBSIDIAN_ROUTER_SMART_LINK_*` on a purely local router, or `open_in_obsidian` will hand back a link (`opened:false`, `delivered:"link"`) instead of navigating your local Obsidian. The resolver reference implementation + contracts live in the private saas repo (`obsidian-mcp-router-saas`).

**Deployment-wide transport guard** — set `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK=true` (typically on a multi-tenant MCPHub instance) to make the router **refuse to start** if any served vault's `baseUrl` host is neither loopback (`127.0.0.1`/`::1`/`localhost`) nor inside the `10.8.0.0/24` WireGuard mesh. This is a **boot-time config check on the configured baseUrls** — it does *not* require the WireGuard tunnel to be up, and **loopback passes** (so it is not "WireGuard-only"). Fail-closed — a vault can never be silently served over an exposed link; the check runs after the `OBSIDIAN_ROUTER_ALLOWED_VAULTS` whitelist. Opt-in; unset = no enforcement (local mode unchanged). *(`OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` is still accepted as a deprecated alias; prefer the current name — the old one wrongly implies "WG must be up".)*

### Generating a host deployment (`gen-obsidian-deploy`)

To run a vault as a `linuxserver/obsidian` (Selkies) container on a host (e.g. a server) — serving LiveSync, the Local REST API, and a browser-tab GUI from one plain-markdown `/config` — use the generator instead of hand-writing the JSON above:

```bash
node scripts/gen-obsidian-deploy.mjs --name tribu --rest-port 27145 --mode wg --wg-host 10.8.0.1
```

It prints a docker-compose service, an nginx reverse-proxy block (with a self-healing resolver-variable `proxy_pass`), and the `VAULT_*` line — the latter is **round-trip-tested** against this router's `parseEnvVaults`, so it can't drift. Modes: `wg` (WireGuard-only, for sensitive/medical), `lan`, `public` (HTTPS+bearer; refused for `--sensitive` vaults). Pass `--tls-insecure` to emit `tlsInsecure: true` (an `https` baseUrl behind a self-signed / internal-CA cert). Secrets default to placeholders — never invented. See [`deploy/dedibox-obsidian/`](./deploy/dedibox-obsidian/) for the full runbook (incl. LiveSync Setup-URI onboarding).

## Config

The router reads the existing config maintained by [`scripts/setup-vault.mjs`](./scripts/setup-vault.mjs), and adds three optional fields on top:

```jsonc
{
  // --- written by setup-vault.mjs (don't edit by hand) ---
  "referenceVault": "C:\\VAULTS\\.template",
  "portStart": 27124,
  "portRegistry": {
    // Two ports per vault — see "Port bookkeeping" below.
    // The legacy shape (a bare number) is still read.
    "C:\\VAULTS\\.template":    { "https": 27124, "http": 27134 },
    "C:\\VAULTS\\TradingView":  { "https": 27125, "http": 27135 }
  },

  // --- router-specific (optional, edit freely) ---
  "vaultNames": {
    "C:\\VAULTS\\.template": "template",
    "C:\\VAULTS\\TradingView": "tradingview"
  },
  "remoteVaults": [
    {
      "name": "qnap",
      "baseUrl": "https://192.168.0.11:27125",
      "apiKey": "...",
      "tlsInsecure": true
    }
  ],
  "defaultVault": "tradingview"
}
```

See [`examples/config.example.json`](./examples/config.example.json) for a complete example with comments, [`docs/remote-vaults.md`](./docs/remote-vaults.md) for the full guide on adding remote vaults, and [`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md) for the recipe to expose a vault over a Cloudflare Tunnel with optional Cloudflare Access auth (service tokens supported via the `extraHeaders` field).

### Running the router without the vaults' disks

A router that only speaks REST — on a dev box, in a container, behind a hub — cannot read the vaults' files. Measured on 2026-08-31 across all 50 tools in isolated processes: **the only universal disk dependency is credential resolution.** For a *local* vault (a `portRegistry` entry) the router reads the API key out of the vault's own `data.json` before any tool runs. Move that key into the config and the dependency disappears — no tool in the tested set needs vault disk any more.

`scripts/gen-remote-config.mjs` performs that move:

```bash
node scripts/gen-remote-config.mjs --vault roland --vault tribu
```

| Flag | What it does |
|---|---|
| `--vault <slug>` | Vault to export. **Repeatable, and required** — there is no implicit "whole fleet". |
| `--all` | The whole fleet, after announcing how many keys that is. |
| `--host <host>` | Default `127.0.0.1` — the remote end of the SSH tunnel. A non-loopback, non-WireGuard host is flagged, because the global `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK` guard would refuse to start. |
| `--format json\|env` | A config file, or `VAULT_<NAME>=<json>` lines. |
| `--out <file>` | Write cleartext; the file is **created** at mode `0600`. |
| `--print-secrets` | Allow cleartext on stdout — for piping into a secret store. |

**The defaults are cautious on purpose, because a config carrying N keys grants read *and write* access to N vaults to every process that can read it.** On a machine that also runs code agents, that is a real privilege escalation. So: output is **redacted by default** (same shape, `<apiKey>` placeholders — reviewable, pasteable, committable); the selection is explicit; `--out` **refuses** to write inside the repository, inside any vault, or over a file with looser permissions; and no key is ever logged, truncated or quoted in an error message.

Keys are read **from disk**, never through the plugin's API — that same `data.json` also holds the vault's TLS private key, and only the one field ever leaves the file.

### Port bookkeeping — two ports per vault

Every vault runs **two** servers: the TLS REST API on `https`, and a plaintext HTTP server on `http` (its `insecurePort`) — the one the bridge's `/open/<path>` route answers on, and therefore the one every click-to-open link in your notes is pinned to.

A registry that records only the HTTPS port lets the allocator hand a brand-new vault a port **already bound by another vault's plaintext server**. That is not theoretical: nine such collisions were measured across a 27-vault fleet, one of them leaving a vault permanently unreachable (a TLS call landing on a plaintext listener returns `ERR_SSL_WRONG_VERSION_NUMBER`). The usual symptom is quieter and worse to diagnose — the second vault to start fails to bind and just looks *offline*, with no error anywhere.

So both ports are recorded, and both spaces are checked before either is handed out.

| Command | What it does |
|---|---|
| `node scripts/setup-vault.mjs --check-ports [--json]` | Read-only report: duplicate ports across both spaces, plus registry-vs-`data.json` drift. Exits `1` on a real collision, so a scheduled task can alert on it. |
| `node scripts/setup-vault.mjs --sync-port-registry [--dry-run]` | Records each vault's plaintext port in the registry, read from its own `data.json`. Takes a timestamped backup of `config.json` first. |
| `node scripts/setup-vault.mjs --status` | Prints **both** ports per vault, and flags collisions at the bottom. |

Three rules the implementation keeps, and that you should keep too if you edit `config.json` by hand:

- **An existing `insecurePort` is never renumbered.** Those numbers live in click-to-open links already written in your notes. When a conflict has to be resolved, the **HTTPS** port is the one that moves.
- **`http` is never guessed as `https + 10`.** That offset is the convention applied to *newly provisioned* vaults, not a property of the fleet — 15 of the 27 vaults measured on 2026-08-30 escape it. When a vault's `data.json` can't be read, its `http` is recorded as `null`, meaning *unknown*, and `--sync-port-registry` fills it in later.
- **Migration is non-destructive.** The legacy shape is still read, converting is idempotent, no key is dropped, no HTTPS port moves, and the pre-migration file is kept as `config.json.portRegistry-<timestamp>.bak`.

## Tools exposed

| Tool | Description |
|---|---|
| `list_vaults` | Catalogue of all configured vaults with online status + latency. Always call this first. |
| `list_files` | List files in a directory of a specific vault. |
| `get_file` | Read full file content (markdown + frontmatter). |
| `search` | Plain-text (substring) search. Pass `vault: "*"` to fan-out across all vaults. |
| `search_smart` | Semantic (meaning-based) search via Smart Connections embeddings. Returns ranked chunks with cosine scores and breadcrumbs. Requires `obsidian-mcp-router-bridge` + `smart-connections` plugins enabled in the target vault. Supports `vault: "*"` for cross-vault semantic search. On the semantic tier it also returns a **`freshness`** block naming the hits whose page has been modified since it was indexed (see below). |
| `write_file` | Create a new file or replace the entire content of an existing one. Pass `ifNew: true` to refuse to overwrite. |
| `append_to_file` | Append content at the end of a file. Auto-creates the file unless `requireExisting: true`. |
| `patch_file` | Surgical edit by `heading` / `block` / `frontmatter` target — insert under a heading without rewriting the whole file, replace a block by id, update a single frontmatter key. |
| `delete_file` | Permanently delete a file. Requires explicit `confirm: true` to guard against hallucinated deletes. |
| `execute_template` | Execute a Templater template, optionally writing the rendered result to a new file. Arguments are exposed in the template via `tp.mcpTools.prompt("key")`. |
| `move_file` | Move or rename a file. Implemented as GET source → PUT destination → DELETE source. Pass `overwrite: true` to replace an existing destination. |
| `get_frontmatter` | Read frontmatter (whole object or one key). Returns parsed values — numbers, booleans, arrays preserved. |
| `set_frontmatter` | Set/replace one frontmatter property. Type preserved (string/number/bool/null/array/object). |
| `merge_frontmatter` | Apply multiple frontmatter updates in sequence (non-atomic — see ROADMAP for atomic alternative). |
| `lock_vault` / `unlock_vaults` | Restrict the router to a single vault for the session (single-vault isolation). See the **Lock mode** section. |
| `set_auto_enrich_mode` | Switch the wiki auto-enrichment mode between `ClaudeAsk` / `Hybrid` / `FullAuto` / `off`. |
| `plan_vault` | **Read-only.** Plan the creation of a NEW local vault: returns computed defaults + a structured questionnaire (the 5 wiki modes, themes installed in the source, registered vaults to copy config from, plugin profiles) + warnings — without writing anything. Feeds the guided wizard; chain with `provision_vault`. Local-only (absent on gated deployments). |
| `provision_vault` | Create a NEW local vault in one call from the wizard answers (typically `plan_vault` defaults + adjustments). Returns a step-by-step report + port, insecurePort, openUri and probe result. Refuses paths outside the known vault roots unless `allowOutsideRoots: true`; `--from-vault` copies config only (credentials excluded, port + API key regenerated). Local-only. |
| `pdf_to_markdown` · `docx_to_markdown` · `xlsx_to_markdown` · `pptx_to_markdown` · `image_to_markdown` · `audio_to_markdown` | Convert a local file to markdown via the bundled `markitdown` Python CLI. Image OCR and audio transcription require the `[all]` extras (opt-in: `npm run install-markitdown`). Returns markdown text only — chain with `write_file` to persist. |
| `pdf_to_markdown_docling` | Convert a local PDF to markdown via **Docling**'s standard pipeline (layout detection + TableFormer table-structure recognition). Higher fidelity than `pdf_to_markdown` on complex tables / multi-column layouts, at ~10× the CPU cost. **Opt-in** — requires the Docling extra (see *Conversion tools — runtime dependencies*). PDF only; for office formats keep `pdf_to_markdown`. |
| `pdf_to_images` | **Render** a local PDF's pages to PNG images, returned as MCP image blocks so the model can visually **see** a page (not just read its text). Renders with **pypdfium2** (BSD) + Pillow from the same `.venv-docling` as Docling — returns an actionable install hint if absent. Params: `filepath`, `first_page`, `max_pages` (default 8, cap 30), `scale` (≈144 DPI). Hard page/byte caps bound token cost. Does not write to any vault. |
| `youtube_to_markdown` · `bing_search_to_markdown` · `webpage_to_markdown` | Convert a remote URL to markdown via `markitdown`. URL must be http(s); private/loopback hosts are refused (SSRF guard). For JS-heavy SPAs prefer the `defuddle` skill (headless browser). `webpage_to_markdown` additionally accepts an opt-in `relevanceQuery` to BM25-filter the result to on-topic blocks (see `filter_relevant_blocks`) — output stays a string with a one-line stats comment appended. |
| `git_repo_to_markdown` | Bundle a git repository (file tree + source code) into a single markdown document via `repomix`. Accepts a full URL or the `owner/repo` shorthand. Pass `compress: true` for ~70% size reduction via Tree-sitter. |
| `extract_page_metadata` | Deterministic page-metadata extractor (JSON-LD + OpenGraph + meta tags + title) — feeds non-fabricated frontmatter for ingestion. |
| `propose_linked_sources` | Heuristic-scored `<a href>` follower that proposes recursive-ingestion candidates (top-N, same-domain / related-section boosts). |
| `download_page_assets` | Download a page's images into the vault (image preservation during web ingestion). |
| `build_open_link` | Build a ready-to-paste click-to-open markdown link (`http://127.0.0.1:<insecurePort>/open/<path>`) for one or many vault files. Read-only. |
| `open_in_obsidian` | Open a note in the running Obsidian (and raise its window) by calling the bridge `/open` route **server-side** — no browser. The browser-free counterpart to a click-to-open link, for clients (e.g. Claude Desktop) that otherwise proxy clicked links through a browser. Optional `anchor` scrolls to a heading. Navigation-only. |
| `get_wiki_context_pack` | Return a structured JSON context envelope for a query (primaryPages / semanticChunks / graphNeighbors / citations) so non-Claude agents can consume the vault programmatically. |
| `build_wiki_graph` | Assemble the vault into a typed knowledge-graph JSON (Understand-Anything schema: 21 node / 35 edge types). Writes `wiki-meta/graph/knowledge-graph.json` + a derived `.understand-anything/` copy. |
| `build_wiki_tour` | Generate a deterministic, ordered pedagogical reading tour from the knowledge-graph link topology. Read-only. |
| `get_page_neighbors` | Return the neighbours of ONE page from the knowledge graph — the pages it links to (`forward`), the pages that link to it (`backward`), or both — out to `depth` hops. Defaults to page↔page links; widen `nodeTypes` to surface the concepts/sources a page also touches. An ambiguous page name is refused with the list of candidates. Two optional structural enrichments (`includeSameFolder`, `includeSharedTags`) surface non-linked siblings — same directory, or a shared real tag — at zero extra cost. Read-only. |
| `wiki_path` | Find the shortest chain of links between TWO pages ("how are A and B connected?"). Undirected traversal; returns the ordered list of pages hop by hop, or an explicit null path when they are not connected (not an error). Widen `nodeTypes` (e.g. `["article","entity","topic"]`) for "connected via a shared concept" paths. Read-only. |
| `find_boundary_pages` | Rank the wiki's "frontier" pages — the crossroads many pages link to that stay thin inside — from the persisted graph. Score = inbound links damped by length (`inbound / (1 + words/100)`: full weight on an empty page, halved at 100 words, a tenth at 900), ×1 to ×2 for staleness; same graph ⇒ same ranking (recency is measured against the graph's own build stamp, not a clock). Pages typed `redirect`/`source`/`answer` are held out by default and the count held out is reported. The score PROPOSES ATTENTION, it does not establish importance — index and hub pages legitimately surface near the top. Refuses on a graph built before the feature rather than scoring every page as empty. Read-only. |
| `find_twin_pages` | Find QUASI-TWIN pages — pairs so close in meaning the vault has probably written one subject twice, splitting its links and updates between two half-complete pages. Compares the per-page vectors Smart Connections already stores on disk (`.smart-env/multi/`) by cosine, every page against every other. THE THRESHOLD IS DERIVED FROM THE VAULT'S OWN DISTRIBUTION and reported with the answer — a fixed cosine cut does not transfer (measured: 0.95 selects 93 pairs on one vault, 398 on another). Stale index entries, generated `index.md`/`log.md` projections and `redirect`/`source`/`answer` pages are held out, each with its count. A pair PROPOSES A READING, never a merge; every row carries the evidence (same folder, same basename, shared links, already linked) needed to dismiss it. Without embeddings the answer is `available: false` with a reason AND NO `pairs` key — deliberately NOT the same answer as `found: 0`. Works on remote vaults too (their bridge must be ≥ 0.9.0, which serves the vector store over `GET /smart-env/sources`; an older bridge answers `bridge-route-absent`). Read-only. |
| `filter_relevant_blocks` | BM25 relevance second-pass over markdown you ALREADY have (no fetch, no LLM, deterministic). Drops blocks unrelated to a `query` topic — an ingestion knows *why* it fetched a page, so it can strip intros/bios/digressions before synthesis. Frontmatter and headings always kept; a code block follows the relevance of the prose that introduces it. Safety nets: empty query → strict no-op; <4 scorable blocks → untouched; would drop >70% → returns the original intact. Reuses the router's own tokeniser + IDF. Read-only. Borrowed from [Crawl4AI](https://github.com/unclecode/crawl4ai) (W-A). |

See [ROADMAP.md](./ROADMAP.md) for what's next.

### Conversion tools — runtime dependencies

The `*_to_markdown` family is a JS/ESM port of [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT) — see `NOTICE` for the full credit. The actual file → markdown conversion is performed by Microsoft's `markitdown` Python CLI:

- **Python 3.10+** is required, and the install is **explicit** — run `npm run install-markitdown`. The script auto-detects Python on `PATH`, creates a local `.venv` at the repo root, and installs `markitdown[all]>=0.1.5`. If Python is missing it prints a warning and exits cleanly; the rest of the router works either way.
- There is deliberately no npm `postinstall`: the plugin carries the server, so a `postinstall` would mean every third party who installs the plugin silently building a ~100 MB Python virtualenv they never asked for — rebuilt on every plugin update, since each plugin version lives in its own directory. The conversion tools are opt-in; everything else works without Python.
- **You can find out before a tool call fails.** Every `list_vaults` response carries a `conversionToolbox` block — `available`, `via` (`bundled-venv` / `env-override` / `path`), `path`, `verified`, `optedOut`, `toolsAffected`, `toolsDegraded`, and a `hint` naming the command for *this* install — except where the install path contains characters a shell would reinterpret, in which case the hint deliberately falls back to generic wording rather than emit something unsafe to paste. `verified: false` means the answer was taken on your word rather than measured (a bare command name that `execFile` resolves through `PATH` at call time, or a UNC path that is unsafe to stat on this hot path) — read it as "configured", not "ready". `meta-status` renders it as one line. It runs **no subprocess** — but "no subprocess" is not the same as free: it stats a bounded slice of `PATH` synchronously, so a `PATH` entry on a **disconnected mapped drive or dead network mount** can make that call wait for an OS timeout. UNC entries are skipped; a dead `Z:\` looks like a local path and cannot be. The scan is also capped (64 KB of `PATH`, 128 entries), so on a pathological `PATH` it under-reports rather than over-promises. It is a *stat*, not a trial run, so a green tick is not a guarantee either: a POSIX file whose execute bit belongs to another user, or a Windows `.exe` that is not a valid image, still fails at spawn. The authoritative answer is always the conversion call itself.
- `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` makes the install script a no-op **and** silences that hint, for scripted environments and for anyone who has already answered the question.
- To use a system-wide install instead of the bundled venv: `pipx install "markitdown[all]"` and set `MARKITDOWN_PATH=/abs/path/to/markitdown`.
- `git_repo_to_markdown` uses `repomix` (Node, bundled as a normal npm dependency — no extra setup), so it is **unaffected** by all of the above. `youtube_to_markdown` falls back to yt-dlp captions when markitdown is absent — which keeps it working only where yt-dlp itself is installed, another thing the router does not install for you.

**High-fidelity PDF via Docling (opt-in).** `pdf_to_markdown_docling` uses [Docling](https://github.com/docling-project/docling) (IBM / LF AI & Data Foundation, MIT) instead of MarkItDown — its layout + TableFormer models reconstruct table structure and reading order that MarkItDown's `pdfminer.six` backend loses, at ~10× the CPU cost. Docling pulls torch/onnxruntime + model weights, so it is **not** installed by default. Disk footprint depends on the OS's default torch wheel: **~1.3 GB on Windows/macOS** (CPU-only torch) vs **~5.5 GB on Linux** (its default wheel bundles CUDA libraries, unused on a CPU-only box). The models (layout + TableFormer + OCR, a few hundred MB) download on first conversion into the Hugging Face cache (`HF_HOME`).

- Enable it with `OBSIDIAN_ROUTER_ENABLE_DOCLING=1 npm run install-docling` — that creates a separate `.venv-docling` and runs `pip install docling` (standard pipeline; no VLM/ASR extras). Needs Python 3.10+.
- To use a system-wide install instead: `pipx install docling` and set `DOCLING_PATH=/abs/path/to/docling`.
- `pdf_to_markdown_docling` stays listed even when Docling isn't installed; calling it then returns an actionable install hint. `pdf_to_markdown` (MarkItDown) is unaffected and remains the default fast path. Docling is PDF-only here — DOCX/PPTX/XLSX keep using MarkItDown.
- **Figures are not embedded.** The tool runs Docling with `--image-export-mode placeholder`, so each picture becomes a `<!-- image -->` marker instead of an inline base64 data-URI. The output stays text-only and small — an illustrated PDF that comes back as ~3 MB of base64 in Docling's default `embedded` mode is ~15 KB here — at the cost of dropping the figure images (table structure and reading order are still reconstructed).

Optional sandbox env vars:

| Variable | Purpose |
|---|---|
| `MARKITDOWN_PATH` | Absolute path to the `markitdown` executable. Override when not using the bundled venv. |
| `REPOMIX_PATH` | Absolute path to the `repomix` executable. Override when not using the bundled `node_modules/.bin/repomix`. |
| `YTDLP_PATH` | Absolute path to the `yt-dlp` executable, used by `youtube_to_markdown`'s caption fallback (when MarkItDown's YouTube path fails). When unset, `yt-dlp` is looked up on `PATH`; the fallback degrades with a clear install hint if it's absent. |
| `OBSIDIAN_ROUTER_VIDEO_SUBLANGS` | yt-dlp `--sub-langs` value for the caption fallback (default `en.*,en`). Widen to fetch other subtitle languages. |
| `MD_ALLOWED_PATHS` | `:`-separated (POSIX) or `;`-separated (Windows) list of directories the conversion tools are allowed to read. When unset (default), any absolute path is fair game. When set, the file-input conversion tools reject paths outside the listed directories. |
| `MD_SHARE_DIR` | Legacy single-directory alias for `MD_ALLOWED_PATHS`, kept for backward compatibility with markdownify-mcp setups. Prefer `MD_ALLOWED_PATHS`. |
| `OBSIDIAN_ROUTER_SKIP_MARKITDOWN` | Set to exactly `1` to make `npm run install-markitdown` a no-op **and** silence the "not installed" hint in `list_vaults` / `meta-status`. |
| `OBSIDIAN_ROUTER_ENABLE_DOCLING` | Set to `1` **before install** to opt into the Docling backend for `pdf_to_markdown_docling` (creates `.venv-docling`, `pip install docling`). Any other value → the tool is listed but errors with an install hint at call time. |
| `DOCLING_PATH` | Absolute path to the `docling` executable. Override when not using the bundled `.venv-docling`. |

**What a spawned tool can see (v0.87.0+).** Every external program the MCP server and its hooks run — markitdown, Docling, the `pdf_to_images` render script, repomix, yt-dlp, git, npm, the `python --version` probe, the provisioning engine — receives an environment built for that tool from a list of **named** variables, never the router's own `process.env` and never a prefix rule. The base is what the OS needs to start a process (`PATH`, `HOME`, the temp and profile roots, `SystemRoot`/`ComSpec`/`PATHEXT` on Windows, the XDG roots on POSIX), plus, per tool, what it actually reads: proxies and CA bundles (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, …) for the networked ones, `HF_HOME` / `TORCH_HOME` / `DOCLING_ARTIFACTS_PATH` for Docling, the commit identity, `GIT_CONFIG_GLOBAL` and the SSH/GPG agent sockets for git and repomix, `npm_config_cache` and the chatter knobs for npm. Filtering is **by name, not by where a value came from**: a variable on a tool's list reaches it whether the shell or the MCP host set it — and, since v0.87.0, a **workspace `.env` can only set the keys the router's own writers put there** — `OBSIDIAN_ROUTER_DEFAULT_VAULT`, `OBSIDIAN_ROUTER_LOCKED`, `OBSIDIAN_ROUTER_AUTO_ENRICH`, `VAULT_PATH`, `MD_ALLOWED_PATHS`, `MD_SHARE_DIR` and the `OBSIDIAN_ROUTER_NO_*` opt-outs, each listed by name in `src/helpers/workspace-dotenv.mjs`. The two sandbox keys are one setting a workspace file may only **narrow**: its value is taken only when the host set neither and the instance is not gated (`READONLY`, `ALLOWED_VAULTS`, `USER_ID`), withheld and named otherwise. And since v0.89.0 one accepted key has a value it may not carry: `OBSIDIAN_ROUTER_AUTO_ENRICH` is fine, but a value that **canonicalises** to `FullAuto` — `FullAuto`, `fullauto`, `FULLAUTO`, `full`, `full-auto`, `auto` — is refused when it comes from a workspace file, because that is the one mode that turns a file travelling with a cloned repository into standing permission to write into a vault without asking again. The key stays accepted and `ClaudeAsk`, `Hybrid` and `off` still work from a file; the refused value is named on the router's stderr with what to do instead, and surfaced to Claude as `autoEnrichModeRefused` on `list_vaults` — a separate field, never an origin, because a value that was refused is not the source of the default that replaced it. `FullAuto` still comes from the MCP host's server declaration, or from a `set_auto_enrich_mode` call during the session; for the same reason, `set_auto_enrich_mode` with `persist: true` refuses to write that one mode into the file while still applying it to the session. This is the accepted option 4 of the decision recorded as `liaison-workspace-vault-hors-depot`. Every hook loads the file before reading its opt-out, so a `NO_*` there is honoured by the hook it names. Every other key in that file is ignored (the router names them once on its stderr, which is the MCP log; the hooks stay silent), so a cloned repository's `.env` cannot point git, Node, a proxy, a tool override — or the router's own config, view agent or smart-link endpoint — anywhere. Host-level settings such as `OBSIDIAN_ROUTER_CONFIG`, `OBSIDIAN_ROUTER_VIEW_AGENT_URL` or `OBSIDIAN_ROUTER_SMART_LINK_SECRET` belong in the MCP host's server declaration or in the launcher of a served instance, never in a workspace file. `PYTHONIOENCODING=utf-8` is fixed for the five Python children — before v0.87.0 a piped Python stdout on Windows used the ANSI code page, and accented characters came back as `�`. Refused everywhere, whatever a list says: anything that runs a command or injects code (`NODE_OPTIONS`, `GIT_SSH_COMMAND`, `GIT_CONFIG_VALUE_n`, `LD_PRELOAD`, `PYTHONPATH`, `PYTHONWARNINGS`, `PSModulePath`, …), redirects a repository or a registry (`GIT_DIR`, `npm_config_registry`), or looks like a credential (`*TOKEN*`, `*SECRET*`, `*_API_KEY`, `npm_config__authToken`, …). Fifteen spawns keep the full environment on purpose and are pinned by file, count and command in the test: the release tooling run from the developer's own shell (`build-mcpb`, `bump-version`, `create-release`, `export-gate`), the two interactive installers, and the three desktop-app launchers (`cmd /c start`, `open`, `xdg-open`). The conversion tools also run in a private, empty temp directory rather than in the workspace, so a `yt-dlp.conf` or `repomix.config.json` sitting in a repository can no longer reconfigure them; a relative `MARKITDOWN_PATH`-style override is resolved against the router's cwd before the spawn. The full tables live in `src/helpers/subprocess-env.mjs`; a test spawns a real executable through the production entry points to prove nothing else gets through.

**Which of your settings a project's file chose (v0.88.0+).** A workspace `.env` can still legitimately name one of your **registered** vaults — that is what `setup-vault --link-workspace`, `lock_vault --persist` and `auto-mode --persist` write there. But a workspace is very often a cloned repository, and its `.env` travels with it: nothing distinguished *you* setting the binding from *the repository* carrying one. `list_vaults` now answers that question directly, with `defaultVaultSource`, `lockSource` and `autoEnrichModeSource`, each `{ origin, variable }`. `origin` is `"binding"` when the confirmed workspace binding in your own config chose it — the tier that outranks the environment, because it is the only one that cannot have arrived with a `git clone` — `"workspace-dotenv"` when this project's own file chose it, `"host"` when the value was already in the environment (the MCP host's server declaration, a launcher, a shell), `"runtime"` when a tool call in this session set it, `"config"` when it comes from the router's `config.json`, `"first-healthy"` / `"first-active"` when nobody chose and the resolution cascade fell back to a vault, `"default"` when nothing set it, `"unset"` when there is no value, and `"unknown"` when the router cannot say — a guess is never dressed up as a fact. A variable that was set but **rejected** — a typo, a vault that no longer exists — is never reported as the source of what replaced it. The boot line says the same thing in one sentence when a workspace file chose any of the three. Nothing here changes what is allowed, and what is allowed is the short list above: a vault chosen from the ones you had already registered, the auto-enrichment mode from three of its four valid values (never `FullAuto`, since v0.89.0 — see the next paragraph), `VAULT_PATH`, a **narrowing** of the conversion sandbox, and the enumerated `OBSIDIAN_ROUTER_NO_*` opt-outs — never an endpoint, never a credential, never the router's own config. It changes what can be *said* — an assistant can now tell you "this repository's file chose the vault this session reads" instead of applying it silently. Moving that binding out of the repository altogether is the accepted decision this implements the first half of (`liaison-workspace-vault-hors-depot` in the project vault).

**And one thing a project's file can no longer choose at all (v0.89.0+).** The mode a file could put you in *silently* was also the one worth refusing outright, so the same decision's accepted option 4 does exactly that: `FullAuto` from a workspace `.env` is not applied, in any of its spellings. `autoEnrichModeSource` keeps reporting what actually took effect — `"default"`, or `"host"` if you set the mode yourself — and a **fourth** field, `autoEnrichModeRefused`, says what the file asked for and did not get: `{ value, canonical, origin, variable, reason }`, or `null` in the normal case. The two are separate on purpose: a refused value chose nothing, so naming it as a source would credit a file for the default that replaced it. A `FullAuto` you set yourself, in the MCP host's server declaration or your shell, is untouched — it reads as `"host"` and works — and a file that merely repeats it is not reported as refused, because nothing was refused. `set_auto_enrich_mode` is symmetrical: `persist: true` writes `ClaudeAsk`, `Hybrid` and `off` to `<cwd>/.env` as before, and for `FullAuto` it applies the mode to the session and returns `persistRefused` instead of writing a line the next start-up would ignore.

## Usage examples

Once the router is registered in Claude, you'd typically prompt Claude in natural language and let it pick the right tool. The shapes below show the JSON arguments each tool accepts — handy when authoring custom workflows or when reviewing what Claude actually called.

### Discovery — start every session here

```jsonc
// list_vaults — no args. Returns every vault with online/latency/missingApiKey.
{}
```

```jsonc
// list_files — explore a directory.
{ "vault": "tradingview", "directory": "Sessions" }
// Or list root if you omit directory:
{ "vault": "tradingview" }
```

### Read

```jsonc
// get_file — full markdown content + frontmatter as text.
{ "vault": "tradingview", "path": "Sessions/2026-04-29.md" }
```

```jsonc
// search — substring match, with surrounding context.
{ "vault": "tradingview", "query": "AL2SI", "contextLength": 80 }
// Cross-vault fan-out:
{ "vault": "*",          "query": "money management" }
```

```jsonc
// search_smart — semantic similarity (Smart Connections embeddings).
// Returns chunks with cosine scores and breadcrumbs.
{
  "vault": "tradingview",
  "query": "rules for breakeven and trailing stop",
  "folders": ["Formations", "Indicators"],
  "excludeFolders": [".trash"],
  "limit": 10
}
// Cross-vault semantic fan-out:
{ "vault": "*", "query": "what did I learn this week?" }
```

#### Freshness — when a semantic hit is older than the page it names

Smart Connections embeds a note on its own schedule. A note edited afterwards
still answers with its **previous** vector, and until v0.83.0 nothing said so:
a stale hit and a current one arrived looking identical.

On the semantic tier `search_smart` now returns a `freshness` block, and
`get_wiki_context_pack` annotates each chunk plus raises
`semantic-results-possibly-stale`. Each page gets one verdict:

| Verdict | Means |
|---|---|
| `fresh` | No evidence it differs from what was indexed. |
| `changed` | It does differ — a different byte size (proof), or a moved mtime. `sizeEvidence` says which. |
| `touched` | The mtime moved but the size is **proven identical** — a same-length edit, or a sync client touching the clock. Reported apart because it is weaker evidence. |
| `page-missing` | The page this hit names is not on disk any more. |
| `not-indexed` | No store record for it at all. |
| `unknown` | We could not tell — always with a `reason`. |

The comparison is the note's mtime and size against the ones Smart Connections
recorded **at import** (`last_import`), so it is like-for-like rather than a
heuristic. It reads the local `.smart-env` store directly and therefore works
only on a vault whose disk this machine has: a remote vault answers
`checkable: false` with a `reason` and **no warning** — never a false positive.
The block always says whether it looked, because "no warning" and "nothing to
check" are different facts.

#### Session logs are excluded by default

Omit `excludeFolders` and semantic search leaves out `wiki-meta/Sessions` — the
chronological session journals the `log-discipline` convention parks there.
That folder is **41.6% of the indexed pages across this fleet** (1212 of 2915;
498 of 803 on the router's own vault), it is raw log by construction, and no
navigational path (hot → catalog → page) ever visits it.

The default was measured, not guessed: `.trash` and `Templates` exist on none of
the 23 vaults, and `wiki-meta/graph`, `wiki-meta/digests` and
`wiki-meta/presence` hold nothing the index carries — so none of them ships. A
default that excludes nothing is worse than no default: it reads as protection.

Because the cut is large it is never silent. Every response carries
`folderExclusion` with the folders, `chosenBy` (`caller` or `default`) and
`excludedHits`; if the page still comes back short, `shortPage` says so rather
than letting it look full. Pass `excludeFolders` explicitly to replace the
default, `excludeFolders: []` to exclude nothing, or set
`OBSIDIAN_ROUTER_DEFAULT_EXCLUDE_FOLDERS` (comma-separated; empty disables it)
for a vault whose conventions differ. The BM25 tier applies the same exclusion,
so a fallback never surfaces what the tier it replaced was hiding.

#### `webpage_to_markdown` — inline links as footnotes

Pass `citations: true` and a captured page's inline links move out of the prose
into numbered footnotes with a `## References` list at the end — one footnote per
**destination**, numbered by first appearance, starting above any footnote the
page already uses. Left alone: links inside code or HTML comments, images,
wikilinks, and non-http targets (an in-document `#anchor` is navigation, not a
citation). Without the flag the output is **byte-identical** to before.

Combined with `relevanceQuery`, the filter runs **first**: markers and
definitions then match one-to-one, with no orphan reference to a block the
reader can no longer see.

#### `get_wiki_context_pack` — provenance on every item

Each entry of the pack now carries `source`: `index` (ranked out of
`wiki-meta/catalog.md`), `graph` (a wikilink from a page that was read), or
`semantic` (a Smart Connections chunk). The envelope declares the closed
vocabulary in `provenance`, naming which half is authoritative — navigation
is primary, the semantic tier is augmentation. When the navigational half comes
back **empty** while semantic chunks did not, the pack raises
`answer-relies-on-semantic-only`: that answer has no navigational anchor and
must not be the sole support for a factual claim.

### Write

```jsonc
// write_file — create or replace.
{
  "vault": "tradingview",
  "path": "Trades/2026-05-02 - GLE Long.md",
  "content": "---\nstatus: open\nticker: GLE\n---\n\n# GLE Long\n\nEntry: ..."
}
// Refuse to overwrite if file exists:
{ "vault": "tradingview", "path": "...", "content": "...", "ifNew": true }
```

```jsonc
// append_to_file — useful for journals/logs.
{
  "vault": "tradingview",
  "path": "Sessions/2026-05-02.md",
  "content": "\n## 14:32 — TSLA breakout invalidé\n\nStop touché à 178.40\n"
}
```

```jsonc
// patch_file — surgical edit, no full rewrite.
// Insert under a heading (use full heading path with :: delimiter):
{
  "vault": "tradingview",
  "path": "Sessions/2026-05-02.md",
  "operation": "append",
  "targetType": "heading",
  "target": "Session 2026-05-02::Trades du jour",
  "content": "- TSLA: stopped out -1.2%\n"
}
// Update a single frontmatter key:
{
  "vault": "tradingview",
  "path": "Trades/2026-05-02 - GLE Long.md",
  "operation": "replace",
  "targetType": "frontmatter",
  "target": "status",
  "content": "closed"
}
// Replace a block by id:
{
  "vault": "tradingview",
  "path": "Indicators/ATP/notes.md",
  "operation": "replace",
  "targetType": "block",
  "target": "atp-config",
  "content": "Updated config for v2.3"
}
```

```jsonc
// delete_file — guarded. confirm: true is mandatory.
{ "vault": "tradingview", "path": "_scratch/old.md", "confirm": true }
```

### Templater

```jsonc
// execute_template — render and optionally save.
// Template file must exist in the vault. Args are accessible inside the
// template via tp.mcpTools.prompt("key") — note: directly under tp,
// NOT under tp.user.
{
  "vault": "tradingview",
  "name": "Templates/Trade.md",
  "arguments": {
    "ticker": "AAPL",
    "direction": "long",
    "entry": "175.20",
    "stop": "172.50"
  },
  "createFile": true,
  "targetPath": "Trades/2026-05-02 - AAPL Long.md"
}
// Render only (preview), don't save:
{
  "vault": "tradingview",
  "name": "Templates/Trade.md",
  "arguments": { "ticker": "AAPL" }
}
```

## TLS

The Local REST API plugin generates a self-signed certificate by default. For localhost vaults, set `tlsInsecure: true` (the default for vaults loaded from `portRegistry`). For remote vaults behind a real TLS cert (e.g., a reverse proxy with Let's Encrypt), set `tlsInsecure: false`.

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). No usage restrictions.

---

## 🇫🇷 Version française

<p align="center">
  <img src="./docs/assets/logo.png" alt="obsidian-mcp-router — serveur MCP multi-vaults" width="540">
</p>

<p align="center">
  <a href="https://github.com/tboome33/obsidian-mcp-router/actions/workflows/test.yml"><img src="https://github.com/tboome33/obsidian-mcp-router/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520.19.0-brightgreen.svg" alt="node"></a>
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.89.0-blueviolet.svg" alt="version"></a>
</p>

> Serveur MCP qui aiguille les appels d'outils Claude vers **plusieurs** vaults Obsidian — locaux ou distants — via le plugin [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api).

Au lieu d'enregistrer un MCP par vault (un process, un port, une clé API), ce router expose un **seul** MCP qui connaît tous les vaults que tu as configurés. Chaque outil prend un paramètre `vault` (ou utilise ton vault par défaut), et le router fait suivre l'appel HTTPS vers la bonne instance Obsidian.

### Pourquoi

Si tu maintiens plusieurs vaults Obsidian — locaux ou distants, dans n'importe quelle combinaison — tu ne veux pas enregistrer un serveur MCP par vault et changer de contexte à chaque fois. Ce router est **un seul** process qui les connaît tous et route chaque appel d'outil vers le bon en fonction d'un paramètre `vault`.

Ce que tu obtiens :

- **Une seule installation** — le plugin Claude Code embarque et lance le serveur (une entrée `~/.claude.json` sur les setups de dev) → tous les vaults sont visibles depuis n'importe quelle session Claude Desktop ou Code.
- **Vaults locaux et distants traités à l'identique**. Pose l'URL + la clé API dans le config ; le router se moque d'où le vault tourne réellement.
- **Recherche cross-vault** : passe `vault: "*"` à l'outil `search` pour lancer la recherche sur tous les vaults en parallèle.

### Capacités

| Surface d'outils | Couverture |
|---|---|
| Découverte | `list_vaults`, `list_files` |
| Lectures | `get_file`, `search`, `search_smart`, `get_frontmatter` |
| Écritures | `write_file`, `append_to_file`, `patch_file`, `delete_file`, `set_frontmatter`, `merge_frontmatter` |
| Gestion de fichiers | `move_file` |
| Templater | `execute_template` |
| État du router | `lock_vault`, `unlock_vaults`, `set_auto_enrich_mode` |
| Provisionnement de vault | `plan_vault`, `provision_vault` — moteur du wizard de création de vault (défauts d'abord) |
| Conversion | `pdf_to_markdown`, `docx_to_markdown`, `xlsx_to_markdown`, `pptx_to_markdown`, `image_to_markdown`, `audio_to_markdown`, `youtube_to_markdown`, `bing_search_to_markdown`, `webpage_to_markdown`, `git_repo_to_markdown`, plus `pdf_to_markdown_docling` (opt-in high-fidelity PDF via [Docling](https://github.com/docling-project/docling), MIT) — port de [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT). Aussi `pdf_to_images` (rend les pages d'un PDF en PNG que le modèle peut *voir*) et `filter_relevant_blocks` (filtre de pertinence BM25 sur du markdown déjà acquis). |
| Métadonnées web/page | `extract_page_metadata`, `propose_linked_sources`, `download_page_assets` |
| Maintenance du wiki & sources | `write_bundle` (bundle multi-fichiers journalisé — application tout-ou-rien avec rollback), `refresh_okf_projections` (régénère la navigation OKF générée), `build_search_index` (index BM25 local, marche sur tous les vaults), `record_source` / `audit_sources` (registre de provenance du contenu ingéré) |
| Contexte & graphe | `get_wiki_context_pack`, `build_wiki_graph`, `build_wiki_tour`, `get_page_neighbors`, `wiki_path`, `find_boundary_pages`, `find_twin_pages`, `build_open_link`, `open_in_obsidian`, `get_view_link` |
| Cross-vault | tous les outils acceptent `vault: "*"` pour fan-out |

La recherche sémantique (`search_smart`), l'exécution Templater (`execute_template`) et les liens click-to-open (`build_open_link`, `open_in_obsidian`, le `clickToOpenUrl` auto-émis sur les résultats d'écriture) nécessitent que le plugin [`obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) soit installé dans chaque vault cible — il enregistre les routes correspondantes `/search/smart`, `/templates/execute` et `/open/*` sur Local REST API. Le bridge **≥ 0.7.0** enregistre aussi `PUT /vault-cas/*`, qui rend les écritures `ifMatch` **atomiques** (lecture-comparaison-écriture dans le process Obsidian) ; sans lui, `ifMatch` marche partout via un repli vérifié mais non atomique. Le bridge **≥ 0.9.0** sert en plus `GET /smart-env/sources` — le magasin de vecteurs Smart Connections, un dot-répertoire que Local REST API refuse lui-même de servir — ce qui permet à `find_twin_pages` de tourner sur un vault **distant** ; et son `GET /ping?v=<vault>` (loopback seul) ne répond 200 que pour le vault qui écoute réellement sur ce port — l'auto-test en un clic derrière les vérifications de ports du click-to-open. Les outils de conversion nécessitent Python 3.10+ sur le `PATH` plus un `npm run install-markitdown` explicite (opt-in) — voir la section anglaise « Conversion tools — runtime dependencies ». Tout le reste fonctionne contre les endpoints standards de Local REST API seuls.

### Modes de déploiement

Le router tourne en deux modes, pilotés uniquement par variables d'environnement — **aucun changement de code**, **aucun binaire séparé** :

- **Mode local (défaut)** : aucune variable posée. Un seul process stdio ; le router voit tous les vaults de `~/.claude/obsidian-mcp-router/config.json`.
- **Mode multi-tenant (opt-in)** : des variables indépendantes qui composent librement —
  - `OBSIDIAN_ROUTER_ALLOWED_VAULTS=a,b,c` — whitelist des vaults que cette instance voit ;
  - `VAULT_<NOM>=<JSON>` — un vault défini entièrement en variable d'env (voir la section [Config `VAULT_*`](#config-vault_-en-variable-denvironnement-éditable-depuis-le-dashboard)) ;
  - `OBSIDIAN_ROUTER_READONLY=true` — masque de `ListTools` **et** refuse au `CallTool` les **15 outils d'écriture** (`write_file`, `append_to_file`, `patch_file`, `set_frontmatter`, `merge_frontmatter`, `move_file`, `delete_file`, `execute_template`, `download_page_assets`, `build_wiki_graph`, `provision_vault`, `refresh_okf_projections`, `write_bundle`, `record_source`, `build_search_index`) ;
  - `OBSIDIAN_ROUTER_USER_ID=<slug>` — journal d'audit de chaque écriture réussie dans le `wiki-meta/journal.md` du vault touché (masque aussi les outils local-only `plan_vault` / `provision_vault`).

Tableau détaillé, exemple d'entrée MCPHub et recette de déploiement complète : voir la section anglaise « [Deployment modes](#deployment-modes) ».

#### Mode servi — atteindre le router local depuis une session distante

Une session Claude Code distante ne peut pas simplement lancer le router : 11 de ses modules touchent légitimement le **disque** des vaults, donc le porter reviendrait à le livrer à moitié cassé. Le router reste donc à la maison et se fait **servir** sur un point d'entrée streamable-HTTP authentifié, atteint par le tunnel SSH existant :

```bash
node scripts/serve-http.mjs [--port 27300] [--session-timeout-min 240]
```

Il n'écoute que sur `127.0.0.1` (délibérément non configurable), exige un jeton bearer sur **chaque** verbe (`OBSIDIAN_ROUTER_HTTP_TOKEN`, ou `~/.claude/obsidian-mcp-router/serve-http.token`), et refuse de démarrer sans jeton. Chaque session MCP obtient **son propre processus router enfant** : un verrou de vault pris par une session est invisible pour une autre — exactement l'isolation qu'ont déjà les sessions stdio.

| Drapeau | Effet | Défaut |
|---|---|---|
| `--port <n>` | Port d'écoute sur la loopback. | `27300` |
| `--session-timeout-min <n>` | Seuil d'inactivité avant récolte de la session et arrêt de son enfant. Minimum 1. | **240** (4 h) |

**Pourquoi le seuil vaut quatre heures et non trente minutes.** Un tunnel qui tombe n'est pas un `DELETE` : sans récolte, les clients disparus laissent des enfants zombies (six mesurés lors du spike du 2026-08-28) — le moissonneur est donc obligatoire. Mais son *échelle* compte plus que son existence : un seuil plus court qu'une pause humaine ordinaire récolte des sessions **vivantes**. Avec un seuil de 30 minutes, une séance de plusieurs heures perd le router en plein vol pendant que l'utilisateur exécute simplement un script sur son poste — et Claude Code ne rétablit pas un serveur MCP tombé en cours de session : les outils manquent pour le reste de la séance. Les deux modes d'échec ne se valent pas : trop court coûte à l'utilisateur ses outils pendant des heures, sans récupération possible depuis la session ; trop long coûte un processus enfant dormant jusqu'au seuil. À abaisser si vous servez beaucoup de clients depuis un seul hôte et que les enfants dormants deviennent le coût dominant.

**Une session périmée répond `404`, et c'est voulu.** Le serveur ne fait jamais renaître un enfant en silence sur un identifiant de session inconnu. Ce serait transparent, et ce serait un mensonge : l'état par session (verrou de vault, mode d'auto-enrichissement, conformité « une fois par session ») aurait été réinitialisé sous un identifiant que le client croit stable. Se remettre du `404` en se ré-initialisant, c'est le travail du client.

### Slash commands & skills (plugin Claude Code)

Le repo est aussi un **marketplace de plugin Claude Code** qui expose **51 slash commands** sous le namespace `/obsidian-router:*`. Tape `/obsidian-router:` dans Claude Code → l'autocomplete montre tout. Chaque slash command s'auto-déclenche aussi sur du langage naturel (EN + FR), donc tu n'as quasiment jamais à retenir le nom exact — décris simplement ce que tu veux.

> 📄 **PDF de référence rapide** (vue d'ensemble du router + setup + config + chaque slash command avec phrases déclencheuses en langage naturel) — [Français](./docs/quick-reference-fr.pdf) · [English](./docs/quick-reference-en.pdf). Imprimable, fontes lisibles — pour papier ou consultation écran.

> 📖 **Guide des features (en prose, par catégorie)** — les tables de ce README sont un aide-mémoire ; pour une explication lisible de chaque feature (le besoin auquel elle répond, ce qu'elle fait, comment l'utiliser), voir [`docs/features/`](./docs/features/README.md) (13 fiches classées par catégorie, en français).

#### 🔧 17 wrappers MCP — un par outil de base du vault

##### `discover/` (2)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:discover-list-vaults` | Liste tous les vaults configurés (local + remote) avec online/offline/latence, vault par défaut, état du lock | *"liste mes vaults"*, *"mes vaults sont-ils en ligne"* / *"list my vaults"*, *"are my vaults online"* |
| `/obsidian-router:discover-list-files` | Liste fichiers et sous-dossiers d'un chemin de vault | *"liste les fichiers de Sessions"*, *"qu'est-ce qu'il y a dans <dossier>"* / *"list files in Sessions"*, *"what's in <folder>"* |

##### `read/` (4)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:read-get` | Lit un fichier en intégralité (markdown + frontmatter + meta) | *"montre-moi X"*, *"ouvre le fichier X"* / *"show me X"*, *"open the file X"* |
| `/obsidian-router:read-search` | Recherche keyword full-text (substring) avec contexte | *"trouve <texte> dans mon vault"*, *"grep <X>"* / *"find <text> in my vault"*, *"grep for X"* |
| `/obsidian-router:read-search-smart` | Recherche sémantique via Smart Connections (cosine + breadcrumbs) | *"trouve mes notes sur X"*, *"recherche sémantique sur X"* / *"find notes about X"*, *"semantic search for X"* |
| `/obsidian-router:read-frontmatter` | Lit le frontmatter (objet entier ou une clé, types préservés) | *"quel est le statut de X"*, *"montre les méta de X"* / *"what's the status of X"*, *"show me the metadata of X"* |

##### `write/` (6)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:write-create-or-replace` | PUT — crée ou remplace un fichier | *"crée une note X"*, *"enregistre ça comme X.md"* / *"create a note X"*, *"save this as X.md"* |
| `/obsidian-router:write-append` | POST — append à un fichier (auto-création si absent) | *"ajoute à X"*, *"rajoute à la fin de X"* / *"append to my journal"*, *"add a line to X"* |
| `/obsidian-router:write-patch` | PATCH chirurgical sur heading / block / frontmatter | *"édite la section X dans Y"*, *"remplace le contenu sous X"* / *"edit the X section in Y"*, *"replace the content under X"* |
| `/obsidian-router:write-frontmatter-set` | Set/remplace une seule clé du frontmatter | *"passe le statut de X à closed"*, *"tag ça avec X"* / *"set status to closed on X"*, *"tag this with X"* |
| `/obsidian-router:write-frontmatter-merge` | Applique plusieurs updates de frontmatter en séquence | *"sur X mets status=closed outcome=tp1"* / *"on X set status=closed outcome=tp1"* |
| `/obsidian-router:write-bundle` | Bundle multi-fichiers journalisé — application tout-ou-rien avec rollback | *"écris ces 4 pages d'un bloc"* / *"write these pages atomically"* |

##### `manage/` (2)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:manage-move` | Déplace ou renomme un fichier (GET → PUT → DELETE) | *"renomme X en Y"*, *"déplace X dans <dossier>"* / *"rename X to Y"*, *"move X into <folder>"* |
| `/obsidian-router:manage-delete` | Supprime un fichier (avec garde confirm en deux étapes) | *"supprime X"* (preview), *"oui confirm=true"* (proceed) / *"delete X"* puis *"yes confirm=true"* |

##### `template/` (1)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:template-execute` | Exécute un template Templater (preview ou save) | *"rends Templates/X.md avec arg1=v1"*, *"exécute le template daily"* / *"render Templates/X.md with arg1=v1"*, *"run the daily template"* |

##### `convert/` (2)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:pdf-to-markdown` | Convertit un PDF local en markdown via le CLI MarkItDown embarqué (rapide, extraction texte brut) | *"convertis ce PDF en markdown"*, *"markdown de X.pdf"* / *"convert this PDF to markdown"*, *"markdown of X.pdf"* |
| `/obsidian-router:pdf-to-markdown-docling` | PDF → markdown haute fidélité via Docling (mise en page + structure de tableaux, ~10× plus lent — nécessite l'install Docling opt-in) | *"convertis ce PDF avec docling"*, *"conversion haute fidélité de X.pdf"* / *"convert this PDF with docling"*, *"high-fidelity conversion of X.pdf"* |

#### 🔒 3 commandes d'état du router (lock + auto-enrichissement)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:lock` | Restreint le router à un seul vault pour la session (volatile ou `--persist` pour écrire dans `.env`) | *"verrouille sur tradingview"*, *"je ne veux travailler que sur tradingview"*, *"verrouille sur tradingview de manière permanente"* / *"lock to tradingview"*, *"I only want to work on tradingview"*, *"isolate to tradingview permanently"* |
| `/obsidian-router:unlock` | Lève le lock et restaure le routing multi-vault (`--persist` pour aussi nettoyer `.env`) | *"déverrouille les vaults"*, *"je veux pouvoir avoir accès à tous les vaults"* / *"unlock vaults"*, *"give me back access to all vaults"* |
| `/obsidian-router:auto-mode` | Set le mode d'auto-enrichissement wiki (`ClaudeAsk` / `Hybrid` / `FullAuto` / `off`) ; `--persist` écrit dans `.env`, sauf `FullAuto` — voir plus bas | *"passe en mode Hybrid"*, *"sauve tout automatiquement"* (→ FullAuto), *"arrête de sauver auto"* (→ off) / *"switch to Hybrid mode"*, *"save everything automatically"*, *"stop auto-saving"* |

Voir [Mode lock (isolation mono-vault)](#mode-lock-isolation-mono-vault) et le callout auto-enrichissement plus bas pour les designs complets et cas d'usage concrets.

#### 🩺 7 helpers conversationnels

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:meta-setup` | Guide l'installation MANUELLE (clone, npm link, registration MCP) — parcours dev ; une installation normale reçoit le serveur via le plugin | *"installe le router"*, *"setup obsidian-mcp-router sur cette machine"* / *"install the router"*, *"bootstrap obsidian-mcp-router on this machine"* |
| `/obsidian-router:meta-attach-vault` | Wizard interactif pour attacher un vault à un workspace (cas courant), bootstrapper un vault standalone, ou enregistrer un vault distant. Provisionne plugins + scaffolde wiki + lie `.env` + édite `.gitignore` + picker de conventions. | *"configure Obsidian pour ce projet"*, *"attache un vault à ce workspace"*, *"connecte mon vault distant"* / *"set up Obsidian for this project"*, *"attach a vault to this workspace"*, *"connect my remote vault"* |
| `/obsidian-router:meta-status` | Health-check de chaque vault avec hints de fix par catégorie d'erreur | *"diagnostique le router"*, *"mes vaults sont-ils accessibles"* / *"diagnose the router"*, *"are my vaults reachable"* |
| `/obsidian-router:meta-sync-template` | Propage les plugins/snippets/docs du vault de référence vers un ou plusieurs vaults (picker interactif) | *"synchronise le template vers tous les vaults"*, *"pousse les plugins de référence vers X"* / *"sync the template to all vaults"*, *"push reference plugins to X"* |
| `/obsidian-router:sync-from-github` | Met à jour un vault ou toute la flotte directement depuis le squelette GitHub (plugins, thèmes, snippets, docs) — sans repo de développement local. Mêmes gardes que `--sync-plugins` plus extraction d'archive durcie | *"synchronise mes vaults depuis github"*, *"mets à jour la flotte depuis github"* / *"sync my vaults from github"*, *"update the fleet from github"* |
| `/obsidian-router:meta-audit-bridge-readiness` | Audite la disponibilité du click-to-open sur les vaults (bridge ≥0.2.0, REST API ≥4.0.0, HTTP insecure, probe live `/open`) | *"audite la disponibilité du bridge"*, *"le click-to-open est-il prêt"* / *"audit bridge readiness"*, *"is click-to-open ready"* |
| `/obsidian-router:conventions` | Installe / retire / statut / propage les conventions CLAUDE.md (source-type, bilingual, heading-hierarchy, ...) sur les vaults | *"installe la convention source-type sur X"*, *"liste les conventions"* / *"install source-type convention on X"*, *"list conventions"* |

#### 📚 24 commandes de gestion de connaissances (LLM-wiki façon Karpathy)

Un petit workflow par-dessus le router pour une base de connaissances en markdown structuré, maintenue par le LLM, où les pages se référencent entre elles et croissent avec l'usage.

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:wiki` | Scaffold `wiki/` dans un vault (index, log, hot, overview + update CLAUDE.md) | *"scaffold un wiki"*, *"crée une base de connaissances"* / *"set up a wiki"*, *"scaffold a knowledge base"* |
| `/obsidian-router:wiki-ingest` | Ingestion d'une source (URL/fichier/texte) → pages entité & concept + cross-refs | *"ingère cette URL"*, *"absorbe cet article"* / *"ingest this URL"*, *"absorb this article"* |
| `/obsidian-router:wiki-query` | RAG en 3 tiers (hot.md → catalog.md → drill), wiki-only (sans web) | *"d'après mes notes, ..."*, *"que dit mon wiki sur X"* / *"based on my notes, ..."*, *"what does my wiki say about X"* |
| `/obsidian-router:wiki-lint` | Health check (orphelins, wikilinks morts, dérive d'index, frontmatter manquant) | *"lint le wiki"*, *"audit mon wiki"* / *"lint the wiki"*, *"audit my wiki"* |
| `/obsidian-router:wiki-fold` | Rollup idempotent des entrées du log dans `wiki/folds/` | *"compacte le journal"*, *"résume l'activité wiki de cette semaine"* / *"fold the log"*, *"roll up recent activity"* |
| `/obsidian-router:hot-compact` | Recompacte un `wiki-meta/hot.md` hors limite vers son contrat de cache (backup complet vérifié → réécriture mince state-first → trace au log) | *"compacte le hot"*, *"hot.md dépasse la limite"* / *"compact the hot cache"*, *"hot.md is over limit"* |
| `/obsidian-router:save` | File la conversation courante comme note typée (session/answer/decision/ADR/...) | *"sauvegarde ça"*, *"archive cette conversation"* / *"save this"*, *"file this conversation"* |
| `/obsidian-router:decision-consolidate` | Compresse une page de décision tranchée à l'essentiel et déplace l'historique complet de la délibération vers une note d'archive vérifiée | *"consolide cette décision"*, *"archive la délibération de X"* / *"consolidate this decision"*, *"archive the deliberation of X"* |
| `/obsidian-router:autoresearch` | Boucle web→synthèse→file autonome bornée par un programme de recherche | *"fais une recherche web sur X"*, *"investigue X en ligne"* / *"research X on the web"*, *"go investigate X online"* |
| `/obsidian-router:canvas` | Crée/édite des fichiers `.canvas` Obsidian (couche visuelle pour wiki, images, PDFs) | *"crée un canvas pour X"*, *"ajoute à mon canvas"* / *"create a canvas for X"*, *"add to my canvas"* |
| `/obsidian-router:defuddle` | Strip le bruit des pages web (pubs, nav, footers) avant ingestion | *"nettoie cette page"*, *"extrais la version lisible de <url>"* / *"defuddle <url>"*, *"clean this page"* |
| `/obsidian-router:obsidian-bases` | Crée/édite des fichiers `.base` Obsidian (vues database sur frontmatter) | *"crée une base pour X"*, *"base task tracker"* / *"create a base for X"*, *"task tracker base"* |
| `/obsidian-router:wiki-graph` | Construit un knowledge-graph JSON typé depuis le vault (schéma Understand-Anything ; alimente le viewer graphe natif) | *"construis le graphe du wiki"*, *"génère le knowledge graph"* / *"build the wiki graph"*, *"generate the knowledge graph"* |
| `/obsidian-router:wiki-tour` | Génère un parcours de lecture pédagogique ordonné depuis la topologie de liens du vault | *"fais-moi un tour du vault"*, *"par où je commence"* / *"give me a tour of this vault"*, *"where do I start"* |
| `/obsidian-router:wiki-neighbors` | Montre les voisines d'une page depuis le knowledge-graph — ce qu'elle cite, ce qui la cite (backlinks), ou les deux | *"quelles pages sont liées à X"*, *"voisins de X"* / *"what links to X"*, *"show me the backlinks of X"* |
| `/obsidian-router:wiki-path` | Trouve la chaîne de liens la plus courte entre deux pages (« quel rapport entre A et B ? ») | *"quel rapport entre X et Y"*, *"chemin entre X et Y"* / *"how is X connected to Y"*, *"path between X and Y"* |
| `/obsidian-router:wiki-export` | Exporte le vault en fichier unique portable (`llms.txt` / `llms-full.txt`) ou en **bundle OKF** (Open Knowledge Format v0.1 de Google, partageable avec tout agent compatible OKF) | *"exporte le wiki en llms.txt"*, *"exporte en bundle OKF"* / *"export the wiki as llms.txt"*, *"export as an OKF bundle"* |
| `/obsidian-router:okf-export` | Exporte un sous-ensemble du wiki en **bundle OKF v0.1** partageable — noms slugifiés, liens relatifs, index par dossier, conformité auto-vérifiée, README agent optionnel | *"exporte ce dossier en bundle OKF"*, *"publie mon wiki en bundle"* / *"export this folder as an OKF bundle"*, *"publish my wiki as a knowledge bundle"* |
| `/obsidian-router:okf-projections` | Régénère la **navigation OKF générée** dans `wiki/` — `index.md` racine (`okf_version` seul), un `index.md` par répertoire, `log.md` newest-first ; auto-rafraîchie ~15 s après chaque écriture une fois initialisée ; `--check` = rapport de dérive | *"rafraîchis les projections OKF"*, *"regénère les index du wiki"* / *"refresh the OKF projections"* |
| `/obsidian-router:okf-check` | Valide un bundle OKF (le nôtre ou un tiers) contre les règles de conformité Open Knowledge Format v0.1 — l'un des premiers validateurs de l'écosystème | *"valide ce bundle OKF"*, *"ce bundle est-il conforme ?"* / *"validate this OKF bundle"*, *"is this bundle conformant?"* |
| `/obsidian-router:build-search-index` | Construit/rafraîchit l'index BM25 local — recherche sans plugin, sur tous les vaults, idempotent | *"construis l'index de recherche"* / *"build the search index"* |
| `/obsidian-router:wiki-boundary` | Classe les pages « frontière » — très liées mais presque vides, celles qui valent d'être écrites | *"qu'est-ce que je devrais écrire ensuite"* / *"frontier pages"* |
| `/obsidian-router:wiki-refresh-digests` | Régénère les digests sidecar par page (concepts/claims/keywords) utilisés par `wiki-lint --deep` et le graphe | *"rafraîchis les digests"*, *"régénère les digests de page"* / *"refresh the digests"*, *"rebuild page digests"* |
| `/obsidian-router:who-is-speaking` | Identifie le membre de la famille courant dans un vault partagé et lock le routing par membre | *"qui parle"*, *"c'est Karine"* / *"who is speaking"*, *"it's Karine"* |

Plus un skill de référence Obsidian (sans slash command — surfacé quand d'autres skills tournent) : `obsidian-markdown` (référence du Obsidian Flavored Markdown : wikilinks, embeds, callouts, properties, etc.). Note : `obsidian-bases` est À LA FOIS un skill de référence ET a sa propre slash command (la ligne au-dessus) — d'autres skills le consultent quand ils ont besoin de générer des fichiers `.base`, et tu peux aussi l'invoquer directement.

**Deux sub-agents parallèles** pour les batches :
- agent `wiki-ingest` — fan-out un agent par source, en parallèle
- agent `wiki-lint` — diagnostic read-only dans un contexte isolé

**Hooks** — **11 hooks Node cross-platform**. La répartition : installer le plugin active exactement trois d'entre eux (`hot-cache-load` + `decisions-recall` + `workspace-briefing`, déclarés dans `hooks/hooks.json`) ; les huit autres ne se déclenchent que s'ils sont câblés via `setup-vault.mjs` — le bootstrap de vault les auto-câble dans `~/.claude/settings.json` (opt-out via `--no-hooks`), ou lance `node scripts/setup-vault.mjs --install-hooks` seul. Voir [Les hooks que le plugin active tout seul](#les-hooks-que-le-plugin-active-tout-seul) :
- `session-auto-journal` — journalise automatiquement chaque session Claude sous `wiki-meta/Sessions/` + un récap 2 lignes dans `wiki-meta/journal.md` (réconciliation auto-réparatrice)
- `hot-cache-load` — charge `wiki-meta/hot.md` dans le contexte au SessionStart / PostCompact
- `hot-cache-update-prompt` — garde déterministe : **bloque le tour** (exit 2) tant que `wiki-meta/hot.md` n'est pas rafraîchi quand la session a écrit une note `wiki/` (par vault, scopé au transcript ; opt-out `OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD`)
- `wiki-autocommit` — auto-commit `wiki/`, `wiki-meta/`, `.raw/`, `.vault-meta/` sur git après les écritures
- `wiki-query-first-nudge` — rappelle à Claude de consulter le vault avant de répondre (+ injecte les PATH RESOLUTION RULES)
- `decisions-recall` — remonte les **décisions déjà tranchées** que le prompt touche, pour qu'une option écartée il y a six mois ne soit pas re-proposée. Déterministe et sans modèle : statut tranché (`accepted`, plus les synonymes legacy que le linter tolère encore) puis recouvrement de tokens, les matchs périphériques sur du vocabulaire omniprésent étant démotés pour qu'un mot comme « router » ne remonte pas tout. Silencieux quand rien ne matche ; borné par un budget wall-clock pour qu'un vault sur lecteur virtuel ne fige pas un prompt. Une `review_after:` échue — ou illisible — est présentée comme *à réévaluer*, jamais comme une contrainte. Injecté comme donnée citée, jamais comme instruction (opt-out `OBSIDIAN_ROUTER_NO_DECISIONS_RECALL`)
- `vault-link-linter` — attrape les liens vault cassés/fantômes avant qu'ils ne t'atteignent
- `doc-propagation-checker` — signale les docs qui dérivent du code shippé
- `vault-doc-startup-check` — surface la santé vault & docs au démarrage de session
- `check-router-update` — check de version GitHub toutes les 24h
- `workspace-briefing` — ouvre chaque session par quelques lignes : à quel(s) vault(s) ce workspace est rattaché (un, plusieurs, ou tous), ce que son `.env` a proposé et s'est vu refuser, le mode d'enrichissement et sa plage, et les deux appels qui changent tout ça. Lecture seule, ne pingue rien (opt-out `OBSIDIAN_ROUTER_NO_BINDING_BRIEFING`, **depuis l'hôte uniquement** — un fichier de projet ne coupe pas le message qui parle de lui)

Les hooks vivent dans [`hooks/`](./hooks/) ; `setup-vault.mjs` les câble automatiquement au bootstrap.

**Auto-enrichissement** — Claude propose proactivement de saver dans le wiki à trois moments naturels : **validation** (tu dis "OK" / "valide" → pin inline), **résultat obtenu** (commit pushé, tests verts → digest de candidats), et **changement de sujet** (checkpoint obligatoire avant que Claude réponde au nouveau sujet). Agnostique du domaine : marche pour le dev, la vie perso, la recherche, la planification familiale, n'importe quoi.

**Quatre modes** (`/obsidian-router:auto-mode <Mode>` pour switcher, `--persist` pour écrire dans `.env` — avec une exception : depuis la v0.89.0, `FullAuto` n'est ni écrit dans le `.env` d'un workspace ni relu depuis un, parce que ce mode est une autorisation permanente d'écrire dans un vault sans redemander et que le `.env` qu'un dépôt cloné transporte n'a pas à l'accorder ; il vient toujours de la déclaration du serveur dans l'hôte MCP ou d'un appel pendant la session, et `--persist` l'applique à la session en le disant. Pour être honnête sur la frontière : ceci ne ferme que la porte `.env`. Le `CLAUDE.md` d'un dépôt peut toujours *demander à Claude* d'appeler `set_auto_enrich_mode`, et le router ne distingue pas cet appel du tien — c'est pourquoi le skill `auto-mode` dit à Claude de ne poser `FullAuto` que sur ta demande dans la conversation, jamais sur l'instruction d'un fichier du workspace) :

| Mode | Comportement | Pour quel usage |
|---|---|---|
| `ClaudeAsk` (défaut) | Propose, confirme toujours | Découverte de la feature · sessions longues à importance mixte · vaults où les faux positifs coûtent cher à nettoyer · période de calibration (1-2 semaines) avant de faire confiance à l'auto-save |
| `Hybrid` | Auto-save les items type-safe (facts, URLs, préférences) ; ask sur les high-stakes (décisions, ADRs, règles, techniques) | Sweet spot power-user après calibration · dev actif avec ingestion d'URLs fréquente · recherche où les citations s'empilent mais les conclusions doivent être vettées |
| `FullAuto` | Auto-save tout ; audit log dans `wiki-meta/journal.md` + filtre de sensibilité (jamais d'auto-save sur credentials/médical/financier) + hard cap (dégrade en `ClaudeAsk` après 5 saves/session) | Sessions à haute confiance en Claude · journal perso / chronique familiale · flows longs non supervisés (autoresearch, ingestion en batch) · brain-dumps solo où le wiki EST le log de conversation |
| `off` | Pas de suggestions auto ; seul `/save` manuel | Sessions de debug que tu ne veux pas polluer dans le wiki · conversations sensibles · défaut pour les vaults légal/médical/financier · préférence control-freak |

**Placement** — la consigne est shipped dans le `CLAUDE.md` template du vault, mais aussi configurable en **instructions de Project Claude Desktop** (pattern élégant : un Project "Journal Trading" sauve toujours dans `tradingview`, un Project "Personnel" dans `personal`). Voir [`docs/auto-enrichment.md`](./docs/auto-enrichment.md) pour les quatre canaux de placement (CLAUDE.md du vault, instructions de Project, Memory, CLAUDE.md global), les règles d'activation, et des boilerplates copy-paste par canal.

Étapes d'install dans la section [Installation](#installation) ci-dessous.

### Les trois briques et leurs dépendances

Trois composants, deux repos, une seule chaîne de dépendances. À lire de bas en haut — chaque couche parle à celle du dessus :

```
Obsidian  ←  Local REST API (plugin communautaire)  ←  BRIDGE (mcp-router-bridge)
    ↑ HTTP par vault (port + apiKey du plugin Local REST API)
SERVEUR MCP (obsidian-mcp-router) — process Node sur le PC
    ↑ MCP sur stdio, lancé par Claude Code
PLUGIN CLAUDE CODE (obsidian-router) — commandes + skills + agents + hooks,
    et il EMBARQUE ET LANCE le serveur lui-même
```

- **Le bridge** tourne *dans Obsidian*. Il requiert Obsidian plus le plugin Local REST API : il enregistre des routes supplémentaires sur le serveur HTTP de Local REST API (`/search/smart`, `/templates/execute`, `/open/*`, heartbeat de présence). Le `search_smart`, l'`execute_template` et les liens click-to-open du serveur en dépendent. **Sans lui**, le CRUD de fichiers du serveur fonctionne toujours (routes Local REST API standard) — la recherche sémantique, l'exécution Templater et les liens cliquables, non. Il se met à jour via BRAT depuis les releases GitHub.
- **Le serveur MCP** tourne sur le PC, lancé par Claude Code — via le plugin (le cas normal), ou via une entrée manuelle `~/.claude.json` sur les setups de dev. Il requiert Node ≥ 20.19.0, le plugin Local REST API dans chaque vault (obligatoire), le bridge dans chaque vault (optionnel — nécessaire pour recherche sémantique / Templater / click-to-open), et son registre `~/.claude/obsidian-mcp-router/config.json` (maintenu par `setup-vault.mjs`). Les commandes et skills du plugin Claude Code orchestrent ses outils MCP.
- **Le plugin Claude Code** tourne dans Claude Code et **embarque le serveur** (une installation = tout ; une mise à jour = tout). Ses skills et commandes pilotent les outils du serveur ; deux hooks (`hot-cache-load`, `decisions-recall`) lisent les fichiers du vault directement sur disque, sans passer par le serveur. Le préfixe des noms d'outils dépend du mode d'enregistrement du serveur — voir [Les noms d'outils dépendent du mode d'enregistrement](#les-noms-doutils-dépendent-du-mode-denregistrement).

### Prérequis

| Plugin (par vault) | Requis pour | Où l'obtenir |
|---|---|---|
| **Local REST API** | Tous les outils | Community plugins → "Local REST API" par Adam Coddington |
| **MCP Router Bridge** | `search_smart`, `execute_template`, liens click-to-open (`build_open_link`, `open_in_obsidian`, le `clickToOpenUrl` auto-émis) | À installer depuis [`tboome33/obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) — enregistre les routes REST `/search/smart`, `/templates/execute` et `/open/*` que ce router appelle (`meta-audit-bridge-readiness` sonde ces dernières). |
| **Smart Connections** | `search_smart` | Community plugins → "Smart Connections" — moteur d'embeddings |
| **Templater** | `execute_template` | Community plugins → "Templater" par SilentVoid13 |

Il te faut aussi :

- **Node.js ≥ 20.19.0** (`undici@7` exige 20.18.1 ; le patch supplémentaire, c'est le drapeau `--permission` de Node — renommé depuis `--experimental-permission` en 20.19.0 — dont la suite de tests se sert pour prouver qu'aucun outil n'a besoin du disque du vault)
- Au moins un vault provisionné dans `~/.claude/obsidian-mcp-router/config.json`. Si tu n'as jamais fait ce setup, lance `npm run setup-vault -- "<vault-path>"` depuis un clone de ce repo, ou invoque [`scripts/setup-vault.mjs`](./scripts/setup-vault.mjs) directement — il bootstrappe la config interactivement. Référence du schéma : [`examples/config.example.json`](./examples/config.example.json).
- Un **vault de référence** enregistré auprès du router. Il contient le set canonique de plugins + config que `setup-vault.mjs` clone dans chaque nouveau vault. Voie rapide : `node scripts/setup-vault.mjs --bootstrap-reference <path>` scaffolde depuis le skeleton livré ([`templates/reference-vault-skeleton/`](./templates/reference-vault-skeleton/)) et télécharge automatiquement le bridge plugin. Procédure complète (manuelle + troubleshooting) : [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) (en anglais).

> 🔗 **Le vault existe déjà ? Ne lance pas le wizard — attache-le.** Une seule commande idempotente, depuis le dossier du workspace :
>
> ```bash
> obsidian-mcp-router --attach <slug-du-vault> [--also <autre-slug>]...
> ```
>
> Elle ne provisionne rien (chaque slug doit déjà être enregistré) et fait les quatre écritures côté workspace : le binding `.env`, `.claude/settings.json` pour **activer le plugin router — sans quoi le `.env` est inerte et aucun hook ne tourne**, un bloc `CLAUDE.md` qui nomme les vaults, et `.gitignore`. Flags : `--workspace <path>` (défaut : le cwd), `--no-plugin` / `--no-claude-md` / `--no-gitignore`. Elle vit sur le binaire et non dans le plugin, délibérément : c'est la commande dont tu as besoin *avant* que le router existe dans ton workspace, et le plugin est justement activé par l'une de ses écritures. **Multi-vault** : le router lie UN vault par workspace — les vaults `--also` sont documentés dans le bloc généré et s'adressent explicitement par `vault: "<slug>"`, jamais chargés automatiquement. Ensuite, redémarre Claude Code dans ce workspace.

> 🧙 **Wizard guidé de création de vault.** Créer un nouveau vault est defaults-first : le moteur calcule un plan par défaut complet, le montre en une ligne, et tu l'acceptes tel quel (happy path = 1 interaction) ou tu ajustes n'importe quel point (nom · emplacement · source du template · plugins · thème · mode wiki). Il fonctionne depuis **n'importe quel harnais LLM** via les outils MCP `plan_vault` (read-only) + `provision_vault` — pas seulement le CLI. Dans Claude Code : le skill [`meta-attach-vault`](./skills/meta-attach-vault/SKILL.md). Depuis tout autre agent (Codex, Hermes, un client MCP brut) : le playbook [`docs/vault-wizard.md`](./docs/vault-wizard.md). En direct : `node scripts/setup-vault.mjs "<vault-path>" --dry-run --json` pour prévisualiser, puis sans `--dry-run` pour appliquer (`--help` liste tous les flags du wizard). Les deux outils sont LOCAL-ONLY (masqués sur les déploiements gated) ; `provision_vault` refuse les chemins hors des racines de vaults connues ; `--from-vault` copie la config seule (secrets toujours régénérés).

> **Les snippets CSS sont clonés automatiquement.** Chaque invocation de `setup-vault.mjs` copie aussi `<referenceVault>/.obsidian/snippets/*.css` dans le vault target et merge les basenames dans `<target>/.obsidian/appearance.json` `enabledCssSnippets`. Le skeleton ship `no-task-strikethrough.css` (désactive le `text-decoration: line-through` par défaut d'Obsidian sur les items `- [x]`, aligné sur la convention [`roadmap-discipline`](./skills/conventions/snippets/roadmap-discipline.md) §2bis). Opt-out par vault dans Settings → Appearance → CSS snippets. Pour pousser une mise à jour de snippet (ou plugin) à TOUS les vaults configurés d'un coup : `node scripts/setup-vault.mjs --sync-all` (idempotent ; ajoute `--force` pour re-cloner les fichiers existants).

### Installation

> 📘 **Vault de référence requis pour `setup-vault.mjs`** — pour bootstrapper de nouveaux vaults via le script (ce que la plupart des utilisateurs voudront), il faut d'abord un vault de référence configuré une seule fois qui contient le set canonique de plugins. Voie la plus rapide : `node scripts/setup-vault.mjs --bootstrap-reference <path>` (scaffolde le skeleton + télécharge le bridge plugin en une commande, puis te guide pour installer les plugins marketplace via Obsidian). Doc complète avec troubleshooting : [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) (en anglais).

**Le plugin embarque le serveur MCP.** Installer le plugin apporte le serveur, les slash commands, les skills et les hooks ensemble ; le mettre à jour les met tous à jour d'un coup. Va directement à l'étape 2 et saute l'étape 1 — elle ne sert qu'à faire tourner le serveur depuis un clone.

#### Étape 1 — Installer le MCP server *(optionnel — le plugin l'embarque déjà)*

Utile seulement si tu développes sur le router, ou si tu veux délibérément enregistrer le serveur indépendamment du plugin.

```bash
git clone https://github.com/tboome33/obsidian-mcp-router.git
cd obsidian-mcp-router
npm install
npm link    # rend le binaire `obsidian-mcp-router` accessible globalement
```

Enregistre-le dans `~/.claude.json` (user scope) sous le nom `obsidian-router` :

```json
{
  "mcpServers": {
    "obsidian-router": {
      "type": "stdio",
      "command": "obsidian-mcp-router"
    }
  }
}
```

Le router lit `~/.claude/obsidian-mcp-router/config.json` au démarrage (le même fichier maintenu par `setup-vault.mjs`) et expose tous les vaults automatiquement.

> ⚠️ **Ne fais pas les deux sans le vouloir.** Un serveur enregistré à la main et celui fourni par le plugin sont deux commandes différentes : Claude Code ne les considère donc pas comme des doublons, et tu te retrouves avec **deux processus serveur et deux exemplaires de chaque outil**. Choisis-en un. Pour basculer une installation enregistrée à la main vers le plugin, supprime l'entrée `obsidian-router` de `~/.claude.json`.

#### Étape 2 — Installer le plugin

**Enregistre le marketplace globalement** dans `~/.claude/settings.json` :

```json
{
  "extraKnownMarketplaces": {
    "obsidian-mcp-router-marketplace": {
      "source": {
        "source": "github",
        "repo": "tboome33/obsidian-mcp-router"
      }
    }
  }
}
```

**Puis active le plugin par workspace**, PAS globalement. Le plugin charge 51 slash commands et 47 skills (~10k tokens de contexte par session) — tu ne veux ça que sur les workspaces qui font effectivement de l'Obsidian. Pour chaque dossier de vault et chaque workspace d'app qui consomme le router, ajoute un `.claude/settings.json` à la racine du workspace :

```json
{
  "enabledPlugins": {
    "obsidian-router@obsidian-mcp-router-marketplace": true
  }
}
```

Pour les vaults bootstrappés via `setup-vault.mjs`, ce fichier est **cloné automatiquement** depuis `.template/.claude/settings.json` — pas à écrire à la main. Pour les workspaces hors-vault (repos de code qui travaillent avec le contenu d'un vault), copie le snippet ci-dessus dans `<workspace>/.claude/settings.json`.

Redémarre Claude Code. Depuis un workspace où le plugin est activé, tape `/obsidian-router:` — les 51 slash commands doivent apparaître. Depuis un workspace sans, le namespace reste vide.

> **Pourquoi pas en global ?** Si tu mets `enabledPlugins` dans `~/.claude/settings.json` au lieu de per-workspace, le plugin se charge dans CHAQUE session Claude Code — scripts random, sessions de debug, repos sans rapport — payant ~10k tokens pour des commandes que ces sessions n'utiliseront jamais. Le project-scope garde le budget serré.

> **Augmenter le budget de la skill-listing (recommandé).** Le router ajoute 47 skills à la liste exposée à Claude Code. Sur une instance par défaut (`skillListingBudgetFraction: 0.01`, soit 1% de la fenêtre de contexte), ça pousse souvent la liste au-delà du budget — les descriptions sont tronquées et le triggering en langage naturel pour `/save`, `/wiki`, `/autoresearch` etc. casse silencieusement. **Recommandé** : passer à `0.05` dans `~/.claude/settings.json` (~6k tokens supplémentaires par session). Le message *"Skill listing will be truncated — N descriptions dropped"* au démarrage de session est le symptôme que ce réglage corrige.
>
> ```json
> { "skillListingBudgetFraction": 0.05 }
> ```
>
> Le skill `meta-setup` détecte un budget sous-dimensionné et propose d'appliquer ce changement interactivement.

Une installation normale se résume à l'Étape 2. Si tu prends le parcours dev (Étape 1 — clone + `npm link` + entrée `~/.claude.json`), le skill `meta-setup` du plugin peut te guider interactivement : demande à Claude *"setup le obsidian-mcp-router sur cette machine"*.

### Les noms d'outils dépendent du mode d'enregistrement

Le serveur ne déclare que des noms nus (`get_file`, `write_file`, …). Le préfixe vient de l'enregistrement, donc un même outil porte des noms différents :

| Mode d'enregistrement | Nom complet de l'outil |
| --- | --- |
| Fourni par le plugin (le cas par défaut) | `mcp__plugin_obsidian-router_router__get_file` |
| Enregistré à la main dans `~/.claude.json` | `mcp__obsidian-router__get_file` |
| Derrière MCPHub | `mcp__<id>__obsidian-router-<vault>-get_file` |

La documentation et les skills utilisent la forme courte `mcp__obsidian-router__*` par lisibilité — Claude appelle le nom qui figure réellement dans sa liste d'outils, c'est donc une différence de nommage, pas de compatibilité. Les hooks, eux, reconnaissent ces outils **par suffixe** (`hooks/_helpers/tool-names.mjs`) précisément pour continuer à se déclencher sous les trois formes.

### À quel vault ce projet est-il rattaché ?

Chaque session s'ouvre en te le disant, en quelques lignes — c'est le hook
`workspace-briefing`. Il y a **trois** états, pas deux :

| État | Ce que ça veut dire |
| --- | --- |
| **un vault** | Ce dossier y est rattaché. C'est le défaut de la session, et `list_vaults` montre `workspaceBinding` avec un `also` vide. |
| **plusieurs** | Un primaire plus des secondaires (`also`), tous rattachés et adressables par leur nom. Seul le primaire est le défaut. |
| **tous** | Aucune liaison : tous les vaults enregistrés sont disponibles et la cascade choisit le défaut. `workspaceBinding` vaut `null` — ce qui ne veut jamais dire « aucun vault ». |

**Où vit la liaison, et pourquoi là.** Dans *ton* `config.json`, sous
`workspaceBindings`, indexée par le chemin canonique du dossier. Ce fichier
n'est jamais synchronisé entre machines — il porte tes chemins de vaults et tes
clés d'API — donc la décision d'une machine n'engage jamais l'autre, et rien
dans un dépôt ne peut y écrire une entrée.

**À quoi sert le `.env` du projet maintenant.** C'est un *indice portable*. Un
workspace est très souvent un dépôt cloné, et jusqu'à cette version la ligne
`OBSIDIAN_ROUTER_DEFAULT_VAULT` qu'il transportait décidait lequel de tes vaults
la session lisait, verrouillait et remplissait — un fichier que tu n'as
peut-être jamais écrit, choisissant où va une année de notes. Il est désormais
rapporté et non appliqué : `list_vaults` le porte dans `bindingHint`, et le
briefing le nomme. Son utilité reste entière pour ce qu'il faisait bien —
arriver sur ta *seconde* machine et y proposer la bonne réponse, une fois.

**Le changer**, depuis une conversation ou un terminal :

```bash
node scripts/setup-vault.mjs --attach <vault> --also <autre>
```

ou demande à Claude, qui appelle `confirm_workspace_binding` : `{ vault }` pour
rattacher, `{ vault, also: [...] }` pour plusieurs, `{ locked: true }` pour
restreindre la session, `{ clear: true }` pour revenir à tous les vaults. Un
vault rattaché dont Obsidian est fermé est ouvert pour toi — un vault fermé ne
répond pas, donc une liaison vers lui serait une promesse qui ne marche pas.

**Mise à jour depuis une version antérieure.** Au premier démarrage du router
dans un workspace qui avait déjà un indice, il l'importe en liaison — une fois,
et il le dit en tête de chaque session jusqu'à ce que tu l'adoptes
(`confirm_workspace_binding({ vault })`) ou l'annules (`{ clear: true }`, qui
tient). Une ligne `OBSIDIAN_ROUTER_LOCKED` écrite par un ancien
`lock_vault --persist` est reprise elle aussi, en `locked: true` sur la liaison
importée : un cloisonnement que tu avais posé ne disparaît pas en silence.

L'import est borné par la date de modification du `.env` lui-même face au
moment de ta mise à jour : un dépôt **cloné** après n'est donc jamais importé —
`git clone` écrit ses fichiers maintenant, et c'est ce qui sépare un workspace
rattaché l'an dernier d'un dossier arrivé ce matin. Deux limites à connaître,
parce que l'horodatage est le seul signal que porte le disque : **désarchiver**
(`tar x`, un unzip qui restaure les dates, le zip source de GitHub, `rsync -a`)
conserve la date enregistrée, donc un projet obtenu ainsi *peut* être importé ;
et sur un router dont le tout premier démarrage se fait sur cette version, il
n'y a pas de « moment de la mise à jour » à comparer, donc tout ce qui est déjà
sur le disque compte comme antérieur. Les deux cas sont annoncés par le
briefing de session comme n'importe quel import, et c'est ce qui les rend
réparables en une phrase.

Deux choses encore sur ce chemin. Si tu fais tourner le router depuis un
checkout plutôt que le plugin et que tes hooks ont été câblés avant cette
version, relance une fois `node scripts/setup-vault.mjs --install-hooks` :
l'import tourne dans le router pour tout le monde, mais le briefing qui
l'annonce est un hook que ton ancien `settings.json` ne porte pas. Et une
proposition dont tu ne veux pas ne se refuse pas encore, elle s'adopte ou
reste en suspens : un indice dans un `.env` que tu n'as pas écrit est signalé
à chaque session jusqu'à ce que tu l'adoptes ou retires la ligne.

### Les hooks que le plugin active tout seul

Installer le plugin active exactement trois hooks, sans étape d'activation, parce que Claude Code exécute ce qu'un plugin déclare dans `hooks/hooks.json` :

| Hook | Rôle | Désactivation |
| --- | --- | --- |
| `hot-cache-load` | Au démarrage de session, injecte le `wiki-meta/hot.md` du vault dans le contexte. Lecture seule. | `OBSIDIAN_ROUTER_NO_HOT_CACHE_LOAD=1` |
| `decisions-recall` | Sur un prompt qui recoupe une décision actée, la cite. Lecture seule. | `OBSIDIAN_ROUTER_NO_DECISIONS_RECALL=1` |
| `workspace-briefing` | Au démarrage de session, dit à quel(s) vault(s) ce workspace est rattaché et comment en changer. Lecture seule, sans réseau. | `OBSIDIAN_ROUTER_NO_BINDING_BRIEFING=1` — **depuis l'hôte uniquement** |

Les trois sont des no-op silencieux sans vault configuré. `workspace-briefing` est ici plutôt qu'en opt-in par construction : c'est lui qui rend visible le registre de liaisons, et une liaison que le router a importée depuis le `.env` d'un projet n'est sûre à importer que parce qu'elle s'annonce au début de chaque session. Son opt-out est le seul que le `.env` du workspace ne peut pas poser — un fichier capable de couper le message qui parle de lui serait exactement le trou que cette fonctionnalité ferme. **Les huit autres hooks restent opt-in** via `node scripts/setup-vault.mjs --install-hooks` : ils commitent dans git, écrivent les transcriptions de session dans un vault, bloquent la fin d'un tour ou appellent le réseau — rien de tout cela n'est un défaut défendable pour quelqu'un qui vient d'installer un plugin. `--hooks-status` montre lesquels sont câblés, lesquels viennent du plugin, et alerte si l'un fait les deux (il se déclencherait deux fois par événement).

### Rester à jour

Le router ship un hook SessionStart (`hooks/check-router-update.mjs`) qui check GitHub une fois par 24h et émet une notice si une nouvelle version est disponible. La notice demande à Claude de la relayer sur sa première réponse de la session — tu es au courant sans avoir besoin de penser à check.

**Il est opt-in, pas activé par le plugin** — câble-le avec `node scripts/setup-vault.mjs --install-hooks`. Il reste délibérément hors de `hooks/hooks.json` : il fait un appel réseau, et un plugin ne doit pas téléphoner à la maison dès l'installation sans qu'on le lui demande. Si tu t'en passes, `/plugin update` reste la voie normale de mise à jour.

Si `/plugin update obsidian-router@obsidian-mcp-router-marketplace` est disponible dans ton environnement Claude Code, c'est le path one-liner. Sinon (certains environnements n'exposent pas le slash command `/plugin`), voir [`docs/how-to-update.md`](./docs/how-to-update.md) pour l'équivalent filesystem manuel en 5 étapes (recettes bash + PowerShell).

Opt-out — définis une de ces env vars et le check est skippé :
- `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true` (any truthy value)
- `OBSIDIAN_ROUTER_USER_ID=<slug>` (déploiements multi-tenant — assume que le sysadmin gère les updates centralement)

Le check est un seul GET sur `raw.githubusercontent.com`. Pas de payload, pas de télémétrie — source dans [`hooks/check-router-update.mjs`](./hooks/check-router-update.mjs).

### Flags CLI

```bash
obsidian-mcp-router --version
obsidian-mcp-router --help
obsidian-mcp-router --config /chemin/perso/config.json
obsidian-mcp-router --no-watch     # désactive le hot-reload du fichier de config
```

Par défaut, le router surveille le fichier de config et le recharge automatiquement à chaque modification — utile quand `setup-vault.mjs` ajoute de nouveaux vaults, ou quand le futur plugin `Obsidian Cloudflare Tunnel` écrit automatiquement des URLs de tunnel dans `remoteVaults`.

### Construire tes propres macros par-dessus (avancé)

Les 51 commandes du plugin sont agnostiques du domaine. Si tu veux des **macros** qui enchaînent plusieurs outils ou intègrent les conventions de ton vault (daily notes, capture inbox, rollups hebdo…), construis-les séparément comme slash commands dans `~/.claude/commands/<name>.md` — pas en PR sur ce repo. Le routeur reste neutre, les macros restent à toi.

Voir [`docs/building-commands.md`](./docs/building-commands.md) pour le pattern et trois exemples illustratifs.

### Désactiver un vault temporairement

Pour cacher un vault de `list_vaults` sans le retirer de la config, deux options :

```jsonc
{
  // Blacklist globale (fonctionne pour les vaults locaux ET distants, par nom) :
  "disabledVaults": ["template", "vps-experimental"],

  // Ou flag par-remote-vault (uniquement dans remoteVaults) :
  "remoteVaults": [
    { "name": "qnap", "baseUrl": "...", "apiKey": "...", "enabled": false }
  ]
}
```

Les vaults désactivés apparaissent dans le log de démarrage `(N disabled: ...)` pour visibilité, mais n'apparaissent pas dans `list_vaults` et ne sont pas pingés.

### Résolution du vault par défaut

Quand un appel d'outil omet l'argument `vault` (ex: `read-search "gestion du risque"`), le router doit en choisir un. **Le même appel peut résoudre vers des vaults différents selon le dossier depuis lequel tu lances Claude.**

Cascade de résolution, par ordre de priorité décroissant :

0. **La liaison confirmée du workspace** — ce à quoi *tu* as rattaché ce dossier, enregistré dans ton propre `config.json` sous `workspaceBindings` et indexé par le chemin canonique du dossier. Le seul niveau qui ne peut pas être arrivé avec un `git clone`, et c'est pour ça qu'il passe devant l'environnement. Voir [À quel vault ce projet est-il rattaché ?](#à-quel-vault-ce-projet-est-il-rattaché-).
1. **Variable d'env `OBSIDIAN_ROUTER_DEFAULT_VAULT`** — override explicite par process, **depuis l'hôte uniquement** : ta déclaration de serveur MCP, un lanceur, ton shell. La même variable dans le `.env` d'un projet est une *proposition* : elle est rapportée et jamais appliquée, parce qu'un workspace est très souvent un dépôt cloné et que son `.env` est venu avec. Confirme-la une fois et elle devient la liaison ci-dessus.
2. **Variable d'env `VAULT_PATH`** — auto-détection. Si `VAULT_PATH` correspond à un chemin enregistré dans `portRegistry`, ce vault devient le default. Depuis le `.env` d'un projet, honoré **seulement s'il nomme ce même dossier** — le cas « ce dossier EST un vault », précisément ce que `setup-vault.mjs` écrit dans le `.env` de chaque vault qu'il bootstrap : lancer Claude Code dans le dossier d'un vault marche donc toujours tout seul. Un fichier de projet pointant `VAULT_PATH` vers un *autre* de tes vaults est une proposition comme une autre.
3. **`config.defaultVault`** — default global explicite dans `~/.claude/obsidian-mcp-router/config.json`.
4. **Premier vault local en bonne santé** — fallback historique.
5. **Premier vault actif quel que soit le type** — dernier recours.

Le router charge automatiquement le `.env` du cwd au démarrage, donc les étapes 1 et 2 fonctionnent sans outillage supplémentaire — sous réserve de la règle d'origine ci-dessus. Les variables d'env déjà présentes dans le process parent gagnent sur le `.env`, et le router **enregistre laquelle des deux** a porté la valeur : c'est ce constat qui distingue une proposition d'une décision, et `list_vaults` le rapporte dans `bindingHint.origin`.

#### Trois cas concrets

**Cas 1 — ton projet EST un vault (le cas le plus commun).**

```
cd C:\VAULTS\TradingView\
claude
```

Le `.env` (écrit par `setup-vault.mjs` lors du bootstrap) contient :

```
VAULT_PATH=C:\VAULTS\TradingView
OBSIDIAN_API_KEY=...
OBSIDIAN_BASE_URL=https://127.0.0.1:27125
```

L'auto-détection (étape 2) matche `VAULT_PATH` contre ton `portRegistry` → default = `tradingview`. **Aucune config nécessaire.** Les outils qui omettent `vault` opèrent sur `tradingview`.

**Cas 2 — ton projet n'est PAS un vault, mais il bosse avec un.**

```
cd C:\Code\mon-app\
claude
```

Ce dossier n'est pas un vault, donc `VAULT_PATH` n'est pas défini. Sans intervention, le router retombe sur `config.defaultVault` (probablement `tradingview`). Si tu veux que ce projet utilise un autre vault par défaut — disons `recherche` pour la prise de notes — ajoute dans `C:\Code\mon-app\.env` :

```
OBSIDIAN_ROUTER_DEFAULT_VAULT=recherche
```

L'étape 1 gagne → default = `recherche` pour ce projet uniquement.

**Cas 3 — ton projet EST un vault, mais tu veux un autre default.**

Tu as ouvert Claude Code dans `C:\VAULTS\.template\` parce que tu documentes ce vault, mais tu veux que les appels d'outils sans `vault=` explicite tapent sur `tradingview` plutôt que `template`. Ajoute dans `C:\VAULTS\.template\.env` :

```
OBSIDIAN_ROUTER_DEFAULT_VAULT=tradingview
```

L'étape 1 override l'auto-détection de l'étape 2.

#### Vérifier quel default le router a choisi

Appelle `list_vaults` — le résultat a un champ `defaultVault` qui indique le nom résolu.

```bash
# depuis n'importe quel projet dans Claude Code :
"liste mes vaults"
```

Si le `defaultVault` n'est pas celui que tu attendais, vérifie dans l'ordre : le `.env` de ton projet, les variables d'env du process parent, et le champ `defaultVault` dans `~/.claude/obsidian-mcp-router/config.json`.

#### Override qui n'a pas pris ?

Si tu mets `OBSIDIAN_ROUTER_DEFAULT_VAULT="quelque-chose"` et que le router ne trouve pas ce nom dans l'ensemble actif (faute de frappe, vault désactivé, vault supprimé), la cascade retombe sur les étapes 2/3/4/5 ET écrit un avertissement d'une ligne sur stderr :

```
[registry] OBSIDIAN_ROUTER_DEFAULT_VAULT="recherchee" does not match any active vault — falling through to other resolution tiers. Active vaults: template, tradingview.
```

### Mode lock (isolation mono-vault)

Par défaut le router est en **mode multi-vault** : chaque appel d'outil peut cibler n'importe quel vault enregistré via le paramètre `vault`, et `vault: "*"` fait du fan-out sur tous. C'est le bon défaut quand tu veux qu'une seule entrée MCP serve tout le monde.

Pour les situations où tu veux **l'inverse** — un seul vault pour toute la session, le router refusant tout débordement — utilise le **mode lock**.

#### Quand le mode lock est utile

- **Sécurité** : tu travailles sur un vault sensible (documents juridiques, données client) et tu veux une barrière structurelle contre les écritures accidentelles ailleurs.
- **Routing par utilisateur sur une install partagée** : un seul Claude Code partagé entre plusieurs personnes. Chacun verrouille sur son vault perso au début de session ; les notes des uns ne fuitent pas chez les autres.
- **Concentration** : longue session d'ingestion ou d'autoresearch sur un wiki — le lock empêche l'assistant de classer "utilement" des trucs dans un vault frère.

#### Comment lock / unlock

Trois façons de verrouiller :

1. **Outil MCP direct** (Claude l'appelle pour toi) :
   ```
   lock_vault({ vault: "tradingview" })                    # volatile (cette session)
   lock_vault({ vault: "tradingview", persist: true })     # écrit dans .env, survit aux restarts
   ```

2. **Slash command** (ou langage naturel → auto-déclenchement) :
   - `/obsidian-router:lock tradingview` — volatile
   - `/obsidian-router:lock tradingview --persist` — persistant
   - Langage naturel : *"je ne veux travailler que sur tradingview"*, *"verrouille sur tradingview de manière permanente"*

3. **Variable d'env au démarrage** :
   ```
   OBSIDIAN_ROUTER_LOCKED=tradingview
   ```
   **depuis l'hôte** — ta déclaration de serveur MCP ou ton shell. Le router la lit au boot. La même ligne dans le `.env` d'un projet ne verrouille plus rien : verrouiller une session sur un vault est la façon la plus forte de choisir où atterrissent ses écritures, donc un fichier qui voyage avec un clone peut le proposer, pas l'imposer. Ce qui fait survivre un verrou à un redémarrage, c'est `locked: true` sur la liaison du workspace — ce que `lock_vault({ persist: true })` écrit pour toi.

Pour déverrouiller :
- `unlock_vaults()` — en mémoire uniquement
- `unlock_vaults({ persist: true })` — lève le verrou sur la liaison (l'endroit que relit un redémarrage) et retire l'indice `OBSIDIAN_ROUTER_LOCKED` du `<cwd>/.env`
- `/obsidian-router:unlock` ou *"redonne-moi accès à tous les vaults"*

> **Caveat — persist refusé au home directory.** `lock_vault({ persist: true })` refuse si le répertoire courant EST ton home (`%USERPROFILE%` sur Windows, `$HOME` ailleurs). C'est presque toujours une erreur — Claude Code a été lancé depuis `~` plutôt que depuis un dossier de projet, et créer `~/.env` te surprendrait. Le lock en mémoire reste actif pour la session. Pour rendre le lock persistant dans ce cas : soit relance `lock_vault` depuis un vrai dossier de projet, soit pose `OBSIDIAN_ROUTER_LOCKED=<vault>` dans ton profil shell (`~/.bashrc`, `~/.zshrc`, ou PowerShell `$PROFILE`).

#### Ce qui se passe pendant le lock

| Opération | Comportement |
|---|---|
| Appel d'outil avec `vault: <vault-locké>` | ✅ procède normalement |
| Appel d'outil sans `vault` explicite | ✅ résout vers le vault locké (override la cascade default) |
| Appel d'outil avec `vault: <autre-vault>` | ❌ throw `Router is locked to vault "<X>". Cannot operate on "<autre>". Use unlock_vaults first or specify "<X>".` |
| Appel d'outil avec `vault: "*"` (fan-out cross-vault) | ❌ throw `Cannot fan-out: router is locked to vault "<X>". Use unlock_vaults first or specify "<X>" instead of "*".` |
| `list_vaults` | ✅ marche toujours. Réponse inclut un nouveau champ `lockedTo: "<X>"` pour que les callers puissent rendre l'état du lock. |

#### Trois cas concrets

**Cas 1 — lock volatile rapide pendant une session.**

Tu vas ingérer 30 articles dans ton wiki `recherche` et tu ne veux aucune dérive vers d'autres vaults :

> *"verrouille sur recherche"*

Le router lock. Tous les `wiki-ingest` partent vers `recherche`. À la fin de la session (ou au restart de Claude Code), le lock disparaît (puisque pas persisté).

**Cas 2 — lock permanent pour une install partagée.**

Plusieurs utilisateurs partagent la même install Claude Code. Donald veut que chaque session Claude qu'il ouvre se positionne (et reste verrouillée) sur son vault `donald`, peu importe ce que dit `config.defaultVault`.

Dans son `.env` du projet habituel :

```
OBSIDIAN_ROUTER_LOCKED=donald
```

Ou, équivalent, lancer une fois :

> *"verrouille sur donald de manière permanente"*

La slash command écrit `OBSIDIAN_ROUTER_LOCKED=donald` dans `<cwd>/.env`. Désormais, en ouvrant Claude dans ce workspace, le router boot déjà locké. Les autres utilisateurs (Mitch, Bernie...) sur d'autres workspaces ont leur propre `.env` avec leur propre valeur de lock.

**Cas 3 — changer la cible du lock.**

Tu es locké sur `recherche`. Tu veux basculer le lock sur `tradingview` :

> *"verrouille sur tradingview"*

`lock_vault` override le lock précédent atomiquement. Pas besoin d'unlocker avant.

#### Vérifier l'état du lock

```
"liste mes vaults"
```

La réponse contient maintenant `lockedTo` :

```jsonc
{
  "defaultVault": "tradingview",
  "lockedTo": "tradingview",        // ← non-null = locked
  "vaults": [...],
  "disabled": [...]
}
```

Quand `lockedTo` est `null`, le router est en mode multi-vault normal.

### Config `VAULT_*` en variable d'environnement (éditable depuis le dashboard)

En plus du fichier `config.json` ci-dessous, un vault peut être défini entièrement dans une **variable d'environnement** — une par vault — donc éditable directement depuis l'UI *Environment Variables* du serveur MCPHub (sans SSH ni édition de fichier). C'est une **3ᵉ source de config**, mergée après `portRegistry` + `remoteVaults` ; une entrée `VAULT_*` **écrase** tout vault de même nom. C'est **opt-in** : sans aucune `VAULT_*`, le router se comporte exactement comme avant.

```
VAULT_<NOM> = <config du vault en JSON>
```

Requis : `name`, `baseUrl`, `apiKey` (le **token seul** — le router ajoute `Authorization: Bearer ` lui-même). Optionnel : `description`, `tlsInsecure`, `timeoutMs` (défaut `10000`). Il n'y a **pas** de flag `wireguard` par-vault — WireGuard est enforced au niveau **déploiement** (voir ci-dessous) ; une clé `wireguard` résiduelle est ignorée. Les trois modes de connexion sont choisis uniquement par `baseUrl` (tunnel WireGuard `10.8.0.x` / LAN / distant TLS — cf. exemples de la section EN « `VAULT_*` env-var config »).

Parsing défensif : une entrée malformée est **ignorée** avec un warning stderr clair nommant la clé fautive (une mauvaise var ne fait jamais planter les autres). Sur un échec de parse JSON, ni la valeur brute ni le message du parser ne sont loggés (les deux peuvent contenir l'`apiKey`). La variable réservée `VAULT_PATH` est ignorée par le scan.

**Liens de lecture éphémères (provider view-agent optionnel)** — poser `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (+ secret partagé optionnel `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN`, envoyé en `X-View-Token`) branche un *provider de view-links* sur le router. Chaque écriture de note porte alors un `viewLink` prêt à cliquer vers le **GUI Obsidian live du vault, navigué sur la note** (injection déterministe côté serveur), le tool `get_view_link` apparaît (masqué de ListTools tant que l'URL n'est pas posée : zéro surface morte sans l'infra), et `open_in_obsidian` renvoie le lien pour les vaults distants en conteneur. Le router ne dépend que d'un petit contrat HTTP — `GET /view?vault=<nom>&note=<chemin>` → `{"url": "<lien prêt navigateur>"}` — d'aucune infrastructure particulière : voir l'**implémentation de référence + le contrat normatif** sur [obsidian-mcp-router-view-agent](https://github.com/tboome33/obsidian-mcp-router-view-agent) (config-driven, Python stdlib, quick tunnels cloudflared éphémères).

**Smart links (résolveur optionnel)** — poser `OBSIDIAN_ROUTER_SMART_LINK_URL` (URL de base du résolveur) **et** `OBSIDIAN_ROUTER_SMART_LINK_SECRET` (secret HMAC) fait émettre des **smart links signés et stables** à la place des view-links demandés à l'agent : les écritures de notes et `open_in_obsidian` sur vault distant portent alors `viewLink = <résolveur>/o/<token-signé>` avec `viewLinkKind: "smart"` — un calcul HMAC pur, **zéro appel réseau** (une écriture ne peut jamais être ralentie par un agent down), et le lien reste valable dans l'historique du chat (TTL du token : 30 jours). Le lien se résout **sur le device qui clique** (sonde du miroir Obsidian local → deep link `obsidian://` → GUI streamé en dernier recours). Priorité des providers quand les deux sont configurés : smart link → view-agent → rien ; `get_view_link` continue de parler directement au view-agent. Configurer les smart links signale un déploiement **remote** — ne posez pas `OBSIDIAN_ROUTER_SMART_LINK_*` sur un router purement local, sinon `open_in_obsidian` rendrait un lien (`opened:false`, `delivered:"link"`) au lieu de naviguer votre Obsidian local. L'implémentation de référence du résolveur + les contrats vivent dans le repo saas privé (`obsidian-mcp-router-saas`).

**Garde de transport au niveau déploiement** — poser `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK=true` (typiquement sur une instance MCPHub multi-tenant) fait **REFUSER le démarrage** du router si un vault servi a un `baseUrl` dont l'hôte n'est ni loopback (`127.0.0.1`/`::1`/`localhost`) ni dans le mesh WireGuard `10.8.0.0/24`. C'est un **check de config au boot sur les baseUrls configurés** — il n'exige *pas* que le tunnel WireGuard soit up, et le **loopback passe** (donc ce n'est pas « WireGuard-only »). Fail-closed — un vault ne peut jamais être servi silencieusement sur un lien exposé ; le check tourne après la whitelist `OBSIDIAN_ROUTER_ALLOWED_VAULTS`. Opt-in ; variable absente = aucun enforce (mode local inchangé). *(`OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` reste accepté comme alias déprécié ; préférez le nom actuel — l'ancien laisse croire à tort que « WG doit être up ».)*

### Config

Le router lit la config existante maintenue par [`scripts/setup-vault.mjs`](./scripts/setup-vault.mjs), et ajoute trois champs optionnels par-dessus :

```jsonc
{
  // --- écrits par setup-vault.mjs (ne pas éditer à la main) ---
  "referenceVault": "C:\\VAULTS\\.template",
  "portStart": 27124,
  "portRegistry": {
    // Two ports per vault — see "Port bookkeeping" below.
    // The legacy shape (a bare number) is still read.
    "C:\\VAULTS\\.template":    { "https": 27124, "http": 27134 },
    "C:\\VAULTS\\TradingView":  { "https": 27125, "http": 27135 }
  },

  // --- spécifiques au router (optionnels, modifiables librement) ---
  "vaultNames": {
    "C:\\VAULTS\\.template": "template",
    "C:\\VAULTS\\TradingView": "tradingview"
  },
  "remoteVaults": [
    {
      "name": "qnap",
      "baseUrl": "https://192.168.0.11:27125",
      "apiKey": "...",
      "tlsInsecure": true
    }
  ],
  "defaultVault": "tradingview"
}
```

Voir [`examples/config.example.json`](./examples/config.example.json) pour un exemple complet commenté, [`docs/remote-vaults.md`](./docs/remote-vaults.md) pour le guide complet d'ajout d'un vault distant, et [`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md) pour la recette d'exposition d'un vault via Cloudflare Tunnel avec auth optionnelle Cloudflare Access (service tokens supportés via le champ `extraHeaders`).

#### Faire tourner le routeur sans les disques des vaults

Un routeur qui ne parle que REST — machine de dev, conteneur, derrière un hub — ne peut pas lire les fichiers des vaults. Mesuré le 2026-08-31 sur les 50 outils, en processus isolés : **la seule dépendance universelle au disque est la résolution de la clé d'API.** Pour un vault *local* (une entrée de `portRegistry`), le routeur va chercher la clé dans le `data.json` du vault avant que le moindre outil ne s'exécute. Déplacez cette clé dans la config et la dépendance disparaît — plus aucun outil de l'échantillon éprouvé n'a besoin du disque.

`scripts/gen-remote-config.mjs` fait ce déplacement :

```bash
node scripts/gen-remote-config.mjs --vault roland --vault tribu
```

| Drapeau | Effet |
|---|---|
| `--vault <slug>` | Vault à exporter. **Répétable, et obligatoire** — il n'y a pas de « tout le parc » implicite. |
| `--all` | Tout le parc, après avoir annoncé combien de clés cela représente. |
| `--host <hôte>` | Défaut `127.0.0.1` — le bout du tunnel SSH côté distant. Un hôte ni loopback ni WireGuard est signalé : la garde globale `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK` refuserait de démarrer. |
| `--format json\|env` | Un fichier de config, ou des lignes `VAULT_<NOM>=<json>`. |
| `--out <fichier>` | Écrire en clair ; le fichier est **créé** en `0600`. |
| `--print-secrets` | Autoriser le clair sur stdout — pour tuyauter vers un magasin de secrets. |

**Les défauts sont prudents à dessein : une config portant N clés donne à tout processus capable de la lire un accès complet en lecture *et en écriture* aux N vaults.** Sur une machine où tournent aussi des agents de code, c'est une élévation de privilège réelle. Donc : sortie **rédigée par défaut** (même forme, marque-place `<apiKey>` — relisible, collable, versionnable) ; sélection explicite ; `--out` **refuse** d'écrire dans le dépôt, dans un vault, ou par-dessus un fichier aux permissions plus larges ; et aucune clé n'est jamais journalisée, tronquée ni citée dans un message d'erreur.

Les clés sont lues **sur le disque**, jamais via l'API du plugin — ce même `data.json` contient aussi la clé privée TLS du vault, et seul le champ nécessaire quitte le fichier.

#### Comptabilité des ports — deux ports par vault

Chaque vault fait tourner **deux** serveurs : l'API REST en TLS sur `https`, et un serveur HTTP en clair sur `http` (son `insecurePort`) — celui que sert la route `/open/<chemin>` du bridge, donc celui auquel est épinglé chaque lien click-to-open écrit dans vos notes.

Un registre qui ne mémorise que le port HTTPS laisse l'allocateur attribuer à un nouveau vault un port **déjà tenu par le serveur en clair d'un autre**. Ce n'est pas théorique : neuf collisions de ce type ont été relevées sur un parc de 27 vaults, dont une rendait un vault définitivement injoignable (un appel TLS qui atterrit sur un serveur en clair rend `ERR_SSL_WRONG_VERSION_NUMBER`). Le symptôme habituel est plus discret et plus pénible à diagnostiquer : le second vault à démarrer n'arrive pas à se lier au socket et paraît simplement *hors ligne*, sans erreur nulle part.

Les deux ports sont donc enregistrés, et les deux espaces sont vérifiés avant d'attribuer l'un ou l'autre.

| Commande | Effet |
|---|---|
| `node scripts/setup-vault.mjs --check-ports [--json]` | Rapport en lecture seule : doublons de ports dans les deux espaces, plus la dérive registre-vs-`data.json`. Sort en `1` sur une vraie collision, pour qu'une tâche planifiée puisse alerter. |
| `node scripts/setup-vault.mjs --sync-port-registry [--dry-run]` | Enregistre le port en clair de chaque vault dans le registre, lu depuis son propre `data.json`. Sauvegarde horodatée de `config.json` d'abord. |
| `node scripts/setup-vault.mjs --status` | Affiche **les deux** ports par vault, et signale les collisions en bas. |

Trois règles que l'implémentation respecte — et que vous devriez respecter aussi si vous éditez `config.json` à la main :

- **Un `insecurePort` existant n'est jamais renuméroté.** Ces numéros vivent dans les liens click-to-open déjà écrits dans vos notes. Quand un conflit doit être résolu, c'est le port **HTTPS** qui bouge.
- **`http` n'est jamais deviné comme `https + 10`.** Cet offset est la convention appliquée aux vaults **nouvellement provisionnés**, pas une propriété du parc — 15 des 27 vaults mesurés le 2026-08-30 y échappent. Quand le `data.json` d'un vault n'est pas lisible, son `http` est enregistré à `null`, c'est-à-dire *inconnu*, et `--sync-port-registry` le complétera plus tard.
- **La migration est non destructive.** L'ancienne forme est toujours lue, la conversion est idempotente, aucune clé n'est perdue, aucun port HTTPS ne bouge, et le fichier d'avant migration est conservé sous `config.json.portRegistry-<horodatage>.bak`.

### Outils exposés

| Outil | Description |
|---|---|
| `list_vaults` | Catalogue de tous les vaults configurés avec leur état online + latence. À appeler en premier. |
| `list_files` | Liste les fichiers d'un répertoire d'un vault donné. |
| `get_file` | Lit le contenu complet d'un fichier (markdown + frontmatter). |
| `search` | Recherche texte simple (substring). Passe `vault: "*"` pour lancer la recherche sur tous les vaults en parallèle. |
| `search_smart` | Recherche sémantique (par sens) via les embeddings de Smart Connections. Retourne les chunks classés avec scores cosinus et breadcrumbs (chemin de titres). Nécessite les plugins `obsidian-mcp-router-bridge` + `smart-connections` activés dans le vault cible. Supporte `vault: "*"` pour la recherche sémantique cross-vaults. |
| `write_file` | Crée un fichier ou remplace son contenu intégral. Passe `ifNew: true` pour refuser l'écrasement. |
| `append_to_file` | Ajoute du contenu en fin de fichier. Crée le fichier si absent (sauf si `requireExisting: true`). |
| `patch_file` | Édition chirurgicale par cible `heading` / `block` / `frontmatter` — insérer sous un titre sans réécrire tout le fichier, remplacer un bloc par id, modifier une clé de frontmatter. |
| `delete_file` | Suppression définitive. Exige `confirm: true` pour éviter les suppressions accidentelles. |
| `execute_template` | Exécute un template Templater, écrit optionnellement le rendu dans un nouveau fichier. Les arguments sont accessibles dans le template via `tp.mcpTools.prompt("clé")`. |
| `move_file` | Déplace ou renomme un fichier. Implémenté en GET source → PUT destination → DELETE source. Passe `overwrite: true` pour remplacer une destination existante. |
| `get_frontmatter` | Lit le frontmatter (objet complet ou une clé). Retourne les valeurs typées — nombres, booléens, tableaux préservés. |
| `set_frontmatter` | Définit/remplace une propriété de frontmatter. Type préservé (string/number/bool/null/array/object). |
| `merge_frontmatter` | Applique plusieurs mises à jour de frontmatter en séquence (non-atomique — voir ROADMAP pour l'alternative atomique). |
| `lock_vault` / `unlock_vaults` | Restreint le router à un seul vault pour la session (isolation mono-vault). Voir la section **Mode lock**. |
| `set_auto_enrich_mode` | Bascule le mode d'auto-enrichissement wiki entre `ClaudeAsk` / `Hybrid` / `FullAuto` / `off`. |
| `plan_vault` | **Read-only.** Planifie la création d'un NOUVEAU vault local : retourne les défauts calculés + un questionnaire structuré (les 5 modes wiki, les thèmes installés dans la source, les vaults enregistrés dont copier la config, les profils de plugins) + avertissements — sans rien écrire. Alimente le wizard guidé ; enchaîner avec `provision_vault`. Local uniquement (absent des déploiements gated). |
| `provision_vault` | Crée un NOUVEAU vault local en un appel depuis les réponses du wizard (typiquement les défauts de `plan_vault` + ajustements). Retourne un rapport étape par étape + port, insecurePort, openUri et résultat de probe. Refuse les chemins hors des racines de vaults connues sauf `allowOutsideRoots: true` ; `--from-vault` copie la config seule (credentials exclus, port + clé API régénérés). Local uniquement. |
| `pdf_to_markdown` · `docx_to_markdown` · `xlsx_to_markdown` · `pptx_to_markdown` · `image_to_markdown` · `audio_to_markdown` | Convertit un fichier local en markdown via le CLI Python `markitdown`. OCR image et transcription audio nécessitent les extras `[all]` (opt-in : `npm run install-markitdown`). Retourne du texte markdown — chaîne avec `write_file` pour persister. |
| `pdf_to_markdown_docling` | Convertit un PDF local en markdown via le pipeline standard de **Docling** (détection de mise en page + reconnaissance de structure de tableau TableFormer). Plus haute fidélité que `pdf_to_markdown` sur les tableaux complexes / mises en page multi-colonnes, à ~10× le coût CPU. **Opt-in** — nécessite l'extra Docling (voir la section anglaise « Conversion tools — runtime dependencies »). PDF uniquement ; pour les formats bureautiques, garder `pdf_to_markdown`. |
| `pdf_to_images` | **Rend** les pages d'un PDF local en images PNG, renvoyées comme blocs image MCP pour que le modèle **voie** une page (pas seulement son texte). Rendu via **pypdfium2** (BSD) + Pillow, du même `.venv-docling` que Docling — renvoie un hint d'install si absent. Paramètres : `filepath`, `first_page`, `max_pages` (défaut 8, plafond 30), `scale` (≈144 DPI). Plafonds durs de pages/octets pour borner le coût en tokens. N'écrit dans aucun coffre. |
| `youtube_to_markdown` · `bing_search_to_markdown` · `webpage_to_markdown` | Convertit une URL distante en markdown via `markitdown`. URL http(s) uniquement ; hôtes privés/loopback refusés (garde SSRF). Pour les SPA JS-lourdes, préfère le skill `defuddle` (navigateur headless). `webpage_to_markdown` accepte en plus un `relevanceQuery` opt-in pour filtrer le résultat aux blocs pertinents par BM25 (cf. `filter_relevant_blocks`) — la sortie reste une string avec un commentaire de stats d'une ligne en fin. |
| `git_repo_to_markdown` | Bundle un dépôt git (arbre de fichiers + code source) en un seul document markdown via `repomix`. Accepte une URL complète ou le raccourci `owner/repo`. Passe `compress: true` pour ~70% de réduction via Tree-sitter. |
| `extract_page_metadata` | Extracteur déterministe de métadonnées de page (JSON-LD + OpenGraph + meta tags + titre) — alimente un frontmatter non-fabriqué pour l'ingestion. |
| `propose_linked_sources` | Suit les `<a href>` avec scoring heuristique pour proposer des candidats d'ingestion récursive (top-N, boosts même-domaine / section Related). |
| `download_page_assets` | Télécharge les images d'une page dans le vault (préservation des images lors de l'ingestion web). |
| `build_open_link` | Construit un lien markdown click-to-open prêt à coller (`http://127.0.0.1:<insecurePort>/open/<path>`) pour un ou plusieurs fichiers du vault. Read-only. |
| `open_in_obsidian` | Ouvre une note dans l'Obsidian en cours (et ramène sa fenêtre au premier plan) en appelant la route `/open` du bridge **côté serveur** — sans navigateur. Le pendant sans-navigateur d'un lien click-to-open, pour les clients (ex. Claude Desktop) qui sinon proxifient les clics de liens via un navigateur. `anchor` optionnel pour scroller à un titre. Navigation seule. |
| `get_wiki_context_pack` | Retourne une enveloppe de contexte JSON structurée pour une requête (primaryPages / semanticChunks / graphNeighbors / citations) afin que des agents non-Claude consomment le vault programmatiquement. |
| `build_wiki_graph` | Assemble le vault en un knowledge-graph JSON typé (schéma Understand-Anything : 21 types de nœuds / 35 d'arêtes). Écrit `wiki-meta/graph/knowledge-graph.json` + une copie dérivée `.understand-anything/`. |
| `build_wiki_tour` | Génère un parcours de lecture pédagogique déterministe et ordonné depuis la topologie de liens du knowledge-graph. Read-only. |
| `get_page_neighbors` | Retourne les voisines d'UNE page depuis le knowledge-graph — celles qu'elle cite (`forward`), celles qui la citent (`backward`), ou les deux — jusqu'à `depth` sauts. Par défaut des liens page↔page ; élargir `nodeTypes` pour faire apparaître les concepts/sources que la page touche aussi. Un nom de page ambigu est refusé avec la liste des candidats. Deux enrichissements structurels optionnels (`includeSameFolder`, `includeSharedTags`) font apparaître des voisines non liées — même dossier, ou un tag réel partagé — à coût nul. Read-only. |
| `wiki_path` | Trouve la chaîne de liens la plus courte entre DEUX pages (« quel rapport entre A et B ? »). Parcours non-orienté ; retourne la liste ordonnée des pages saut par saut, ou un chemin null explicite si elles ne sont pas connectées (pas une erreur). Élargir `nodeTypes` (ex. `["article","entity","topic"]`) pour des chemins « par concept partagé ». Read-only. |
| `find_boundary_pages` | Classe les pages « frontière » du wiki — les carrefours vers lesquels tout le monde pointe et qui restent maigres — depuis le graphe persisté. Score = liens entrants amortis par la longueur (`inbound / (1 + mots/100)` : poids plein sur une page vide, moitié à 100 mots, un dixième à 900), ×1 à ×2 selon l'ancienneté ; même graphe ⇒ même classement (la récence se mesure contre l'horodatage du graphe, pas contre l'horloge). Les pages typées `redirect`/`source`/`answer` sont écartées par défaut, et le nombre écarté est rapporté. Le score PROPOSE L'ATTENTION, il n'établit pas l'importance — les pages d'index et de hub remontent légitimement en tête. Refuse sur un graphe antérieur à la fonctionnalité plutôt que de compter toutes les pages comme vides. Read-only. |
| `find_twin_pages` | Repère les pages QUASI-JUMELLES — les paires si proches que le vault a probablement écrit deux fois le même sujet, répartissant liens et mises à jour entre deux pages incomplètes. Compare par cosinus les vecteurs par page que Smart Connections stocke déjà sur disque (`.smart-env/multi/`), chaque page contre chaque autre. LE SEUIL EST DÉRIVÉ DE LA DISTRIBUTION PROPRE AU VAULT et affiché avec la réponse — un seuil cosinus fixe ne se transfère pas (mesuré : 0,95 sélectionne 93 paires sur un vault, 398 sur un autre). Entrées d'index périmées, projections générées (`index.md`/`log.md`) et pages `redirect`/`source`/`answer` sont écartées, chaque compte étant rapporté. Une paire PROPOSE UNE LECTURE, jamais une fusion ; chaque ligne porte les indices (même dossier, même basename, liens communs, déjà liées) qui permettent de l'écarter. Sans embeddings la réponse est `available: false` avec un motif ET SANS clé `pairs` — délibérément PAS la même réponse que `found: 0`. Marche aussi sur les vaults distants (leur bridge doit être ≥ 0.9.0, qui sert le magasin de vecteurs via `GET /smart-env/sources` ; un bridge plus ancien répond `bridge-route-absent`). Read-only. |
| `filter_relevant_blocks` | 2ᵉ passe de pertinence BM25 sur du markdown que tu as DÉJÀ (aucun fetch, aucun LLM, déterministe). Écarte les blocs hors-sujet vis-à-vis d'une `query` — une ingestion sait *pourquoi* elle a récupéré une page, donc elle peut retirer intros/bios/digressions avant la synthèse. Frontmatter et titres toujours conservés ; un bloc de code suit la pertinence de la prose qui l'introduit. Garde-fous : requête vide → no-op strict ; < 4 blocs scorables → intact ; filtrerait > 70 % → renvoie l'original intact. Réutilise le tokeniseur + l'IDF du router. Read-only. Emprunté à [Crawl4AI](https://github.com/unclecode/crawl4ai) (W-A). |

Voir [ROADMAP.md](./ROADMAP.md) pour la suite.

### Exemples d'usage

Une fois le router enregistré dans Claude, tu prompteras Claude en langage naturel et il choisira le bon outil. Les payloads ci-dessous montrent les arguments JSON que chaque outil accepte — utile pour écrire des workflows custom ou pour vérifier ce que Claude a réellement appelé.

#### Découverte — à appeler au début de chaque session

```jsonc
// list_vaults — pas d'argument. Retourne chaque vault avec online/latency/missingApiKey.
{}
```

```jsonc
// list_files — explorer un répertoire.
{ "vault": "tradingview", "directory": "Sessions" }
// Ou la racine si tu omets directory :
{ "vault": "tradingview" }
```

#### Lecture

```jsonc
// get_file — contenu markdown complet + frontmatter en texte brut.
{ "vault": "tradingview", "path": "Sessions/2026-04-29.md" }
```

```jsonc
// search — recherche substring avec contexte.
{ "vault": "tradingview", "query": "AL2SI", "contextLength": 80 }
// Fan-out cross-vaults :
{ "vault": "*",          "query": "money management" }
```

```jsonc
// search_smart — similarité sémantique (embeddings Smart Connections).
// Retourne des chunks avec scores cosinus et breadcrumbs.
{
  "vault": "tradingview",
  "query": "règles de breakeven et trailing stop",
  "folders": ["Formations", "Indicators"],
  "excludeFolders": [".trash"],
  "limit": 10
}
// Fan-out sémantique cross-vaults :
{ "vault": "*", "query": "qu'est-ce que j'ai appris cette semaine ?" }
```

##### Fraîcheur — quand un résultat sémantique est plus vieux que la page qu'il nomme

Smart Connections calcule le vecteur d'une note à son propre rythme. Une note
éditée ensuite répond encore avec son vecteur **précédent**, et jusqu'à la
v0.83.0 rien ne le disait : un résultat périmé et un résultat à jour arrivaient
identiques.

Sur le tier sémantique, `search_smart` renvoie désormais un bloc `freshness`, et
`get_wiki_context_pack` annote chaque chunk et lève
`semantic-results-possibly-stale`. Un verdict par page :

| Verdict | Signification |
|---|---|
| `fresh` | Aucune preuve d'écart avec ce qui a été indexé. |
| `changed` | Il y a écart — taille en octets différente (preuve), ou mtime déplacé. `sizeEvidence` dit lequel. |
| `touched` | Le mtime a bougé mais la taille est **prouvée identique** — édition de même longueur, ou client de synchro qui touche l'horloge. Rapporté à part, car la preuve est plus faible. |
| `page-missing` | La page nommée par ce résultat n'est plus sur le disque. |
| `not-indexed` | Aucun enregistrement de store pour elle. |
| `unknown` | On n'a pas pu savoir — toujours avec une `reason`. |

La comparaison porte sur le mtime et la taille de la note face à ceux que Smart
Connections a enregistrés **à l'import** (`last_import`) : c'est du comparable à
comparable, pas une heuristique. Elle lit le store `.smart-env` local, donc ne
fonctionne que sur un vault dont cette machine a le disque : un vault distant
répond `checkable: false` avec une `reason` et **aucun avertissement** — jamais
de faux positif. Le bloc dit toujours s'il a regardé, parce que « pas
d'avertissement » et « rien à vérifier » sont deux faits différents.

##### Les journaux de session sont exclus par défaut

Sans `excludeFolders`, la recherche sémantique laisse de côté
`wiki-meta/Sessions` — les journaux chronologiques que la convention
`log-discipline` range là. Ce dossier représente **41,6 % des pages indexées du
parc** (1212 sur 2915 ; 498 sur 803 pour le vault du routeur lui-même), c'est du
log brut par construction, et aucun chemin de navigation (hot → catalog → page)
n'y passe.

Le défaut est **mesuré, pas deviné** : `.trash` et `Templates` n'existent sur
aucun des 23 vaults, et `wiki-meta/graph`, `wiki-meta/digests`,
`wiki-meta/presence` ne portent rien que l'index contienne — aucun des quatre
n'est livré. Un défaut qui n'exclut rien est pire que pas de défaut : il se lit
comme une protection.

Parce que la coupe est grosse, elle n'est jamais silencieuse. Chaque réponse
porte `folderExclusion` — les dossiers, `chosenBy` (`caller` ou `default`),
`excludedHits` — et si la page revient quand même courte, `shortPage` le dit au
lieu de la laisser paraître pleine. Passez `excludeFolders` explicitement pour
remplacer le défaut, `excludeFolders: []` pour n'exclure rien, ou réglez
`OBSIDIAN_ROUTER_DEFAULT_EXCLUDE_FOLDERS` (séparé par virgules ; vide = désactivé)
pour un vault dont les conventions diffèrent. Le tier BM25 applique la même
exclusion : un repli ne fait jamais remonter ce que le tier remplacé cachait.

##### `webpage_to_markdown` — les liens inline en notes de bas de page

Avec `citations: true`, les liens inline d'une page capturée sortent de la prose
et deviennent des notes numérotées, avec une liste `## References` à la fin —
une note par **destination**, numérotée par première apparition, en démarrant
au-dessus des notes que la page utilise déjà. Laissés tranquilles : les liens
dans du code ou un commentaire HTML, les images, les wikilinks, et les cibles
non-http (une ancre `#section` est de la navigation, pas une citation). Sans le
drapeau, la sortie est **identique à l'octet** près.

Combiné à `relevanceQuery`, le filtre passe **d'abord** : marqueurs et
définitions se correspondent alors un pour un, sans référence orpheline vers un
bloc que le lecteur ne voit plus.

##### `get_wiki_context_pack` — la provenance sur chaque élément

Chaque entrée du pack porte désormais `source` : `index` (classée depuis
`wiki-meta/catalog.md`), `graph` (un wikilink d'une page effectivement lue) ou
`semantic` (un chunk Smart Connections). L'enveloppe déclare le vocabulaire
fermé dans `provenance` et dit quelle moitié fait autorité — la navigation est
primaire, le sémantique est une augmentation. Quand la moitié navigationnelle
revient **vide** alors que des chunks sémantiques existent, le pack lève
`answer-relies-on-semantic-only` : cette réponse n'a aucun ancrage de
navigation et ne doit pas être l'unique support d'une affirmation factuelle.

#### Écriture

```jsonc
// write_file — crée ou remplace.
{
  "vault": "tradingview",
  "path": "Trades/2026-05-02 - GLE Long.md",
  "content": "---\nstatus: open\nticker: GLE\n---\n\n# GLE Long\n\nEntrée: ..."
}
// Refuser l'écrasement si le fichier existe :
{ "vault": "tradingview", "path": "...", "content": "...", "ifNew": true }
```

```jsonc
// append_to_file — utile pour journaux/logs.
{
  "vault": "tradingview",
  "path": "Sessions/2026-05-02.md",
  "content": "\n## 14:32 — TSLA breakout invalidé\n\nStop touché à 178.40\n"
}
```

```jsonc
// patch_file — édit chirurgicale, pas de réécriture intégrale.
// Insertion sous un heading (chemin complet avec délimiteur ::) :
{
  "vault": "tradingview",
  "path": "Sessions/2026-05-02.md",
  "operation": "append",
  "targetType": "heading",
  "target": "Session 2026-05-02::Trades du jour",
  "content": "- TSLA: stop touché -1.2%\n"
}
// Modifier une seule clé de frontmatter :
{
  "vault": "tradingview",
  "path": "Trades/2026-05-02 - GLE Long.md",
  "operation": "replace",
  "targetType": "frontmatter",
  "target": "status",
  "content": "closed"
}
// Remplacer un bloc par id :
{
  "vault": "tradingview",
  "path": "Indicators/ATP/notes.md",
  "operation": "replace",
  "targetType": "block",
  "target": "atp-config",
  "content": "Config mise à jour pour v2.3"
}
```

```jsonc
// delete_file — protégé. confirm: true obligatoire.
{ "vault": "tradingview", "path": "_scratch/old.md", "confirm": true }
```

#### Templater

```jsonc
// execute_template — rend et sauvegarde optionnellement.
// Le template doit exister dans le vault. Les arguments sont accessibles
// dans le template via tp.mcpTools.prompt("clé") — note : directement sous
// tp, PAS sous tp.user.
{
  "vault": "tradingview",
  "name": "Templates/Trade.md",
  "arguments": {
    "ticker": "AAPL",
    "direction": "long",
    "entry": "175.20",
    "stop": "172.50"
  },
  "createFile": true,
  "targetPath": "Trades/2026-05-02 - AAPL Long.md"
}
// Rendu seul (preview), sans sauvegarder :
{
  "vault": "tradingview",
  "name": "Templates/Trade.md",
  "arguments": { "ticker": "AAPL" }
}
```

### TLS

Le plugin Local REST API génère un certificat auto-signé par défaut. Pour les vaults localhost, mets `tlsInsecure: true` (c'est le défaut pour les vaults chargés depuis `portRegistry`). Pour les vaults distants derrière un vrai certificat TLS (par exemple un reverse proxy avec Let's Encrypt), mets `tlsInsecure: false`.

### Licence

Apache 2.0 — voir [LICENSE](./LICENSE) et [NOTICE](./NOTICE). Aucune restriction d'usage.
