<p align="center">
  <img src="./docs/assets/logo.png" alt="obsidian-mcp-router — multi-vault MCP server" width="540">
</p>

<p align="center">
  <a href="https://github.com/tboome33/obsidian-mcp-router/actions/workflows/test.yml"><img src="https://github.com/tboome33/obsidian-mcp-router/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520.18.1-brightgreen.svg" alt="node"></a>
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.37.0-blueviolet.svg" alt="version"></a>
</p>

# obsidian-mcp-router

> *🇬🇧 English version below — [🇫🇷 version française](#-version-française)*

> An MCP server that routes Claude tool calls to **multiple** Obsidian vaults — local or remote — over the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

Instead of registering one MCP per vault (one process, one port, one API key), this router exposes a single MCP that knows about every vault you've configured. Each tool takes a `vault` parameter (or uses your default), and the router fans out the HTTPS call to the right Obsidian instance.

## Why

If you keep more than one Obsidian vault — local or remote, in any combination — you don't want to register a separate MCP server per vault and switch context every time. This router is one process that knows about all of them and routes each tool call to the right one based on a `vault` parameter.

What you get:

- **One MCP entry** in `~/.claude.json` (user scope) → all vaults visible from any Claude Desktop/Code session.
- **Local + remote vaults**, treated identically. Drop the URL + API key into the config; the router doesn't care where the vault actually runs.
- **Cross-vault search**: pass `vault: "*"` to the `search` tool to fan-out across every vault in parallel.

## Capabilities

| Tool surface | Coverage |
|---|---|
| Vault discovery | `list_vaults`, `list_files` |
| Reads | `get_file`, `search`, `search_smart`, `get_frontmatter` |
| Writes | `write_file`, `append_to_file`, `patch_file`, `delete_file`, `set_frontmatter`, `merge_frontmatter` |
| File management | `move_file` |
| Templater | `execute_template` |
| Router state | `lock_vault`, `unlock_vaults`, `set_auto_enrich_mode` |
| Conversion (v0.11+) | `pdf_to_markdown`, `docx_to_markdown`, `xlsx_to_markdown`, `pptx_to_markdown`, `image_to_markdown`, `audio_to_markdown`, `youtube_to_markdown`, `bing_search_to_markdown`, `webpage_to_markdown`, `git_repo_to_markdown`, plus `pdf_to_markdown_docling` (opt-in high-fidelity PDF via [Docling](https://github.com/docling-project/docling), MIT) — port of [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT). |
| Web/page metadata | `extract_page_metadata`, `propose_linked_sources`, `download_page_assets` |
| Context & graph | `get_wiki_context_pack`, `build_wiki_graph`, `build_wiki_tour`, `build_open_link` |
| Cross-vault | every tool accepts `vault: "*"` for fan-out |

Semantic search (`search_smart`) and Templater execution (`execute_template`) require the [`obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) plugin to be installed in each target vault — it registers the matching `/search/smart` and `/templates/execute` routes on Local REST API. The conversion tools require Python 3.10+ on `PATH` so the postinstall can install `markitdown[all]` into a local `.venv` — see the **Conversion tools — runtime dependencies** section below. Everything else works against the standard Local REST API endpoints alone.

## Deployment modes

The router runs in two modes, controlled entirely by environment variables — **no code change**, **no separate binary**:

### Local mode (default, v0.8.x compatible)

No env vars set. Single binary, stdio MCP transport, registered once in `~/.claude.json` user scope. The router sees every vault listed in `~/.claude/obsidian-mcp-router/config.json`. This is what you get when you follow the install steps below — it's how the project has worked since day one.

### Multi-tenant mode (v0.9.0+, opt-in)

Three independent env vars turn the router into a scoped instance — useful when you run multiple copies behind a hub (MCPHub, `mcpo`, a custom proxy) and want each instance to expose a different subset of vaults to a different user.

| Env var | What it does | Default when unset |
|---|---|---|
| `OBSIDIAN_ROUTER_ALLOWED_VAULTS=a,b,c` | Whitelist of vault names this instance sees. Comma-separated, spaces tolerated. Vaults outside the list are moved to `skipped[]` with reason `"not in OBSIDIAN_ROUTER_ALLOWED_VAULTS whitelist"`. Applied **before** default-vault resolution, so `defaultVault` falls through to the filtered set. | All vaults visible |
| `VAULT_<NAME>=<JSON>` | A vault defined entirely in an env var (JSON) — editable from the MCPHub dashboard. A 3rd config source merged after `portRegistry` + `remoteVaults` (overrides any same-name vault). Required: `name`, `baseUrl`, `apiKey` (the **bare token**). Optional: `description`, `tlsInsecure`, `timeoutMs`. Malformed entries are skipped with a redacted warning. See "[`VAULT_*` env-var config](#vault_-env-var-config-dashboard-editable)" below. | (none) |
| `OBSIDIAN_ROUTER_READONLY=true` | Disable write tools. The 8 write tools (`write_file`, `append_to_file`, `patch_file`, `set_frontmatter`, `merge_frontmatter`, `move_file`, `delete_file`, `execute_template`) are filtered from `ListTools` **and** refused at `CallTool` time — even when a client knows the name and calls it directly. Truthy tokens: `true` / `1` / `yes` / `on` (case-insensitive). | Write tools enabled |
| `OBSIDIAN_ROUTER_USER_ID=<slug>` | Audit log: every **successful** write call appends a line `[claude-write by <slug>] YYYY-MM-DD HH:MM — <tool> path="<path>"` to the touched vault's `wiki-meta/log.md`. Best-effort (audit failure logs to stderr, never blocks the write). Uses the REST client directly to avoid the recursion that would happen via the `append_to_file` tool wrapper. | No audit log |

The three vars compose freely: an instance can be scoped to one vault (`ALLOWED_VAULTS=karine`) AND read-only (`READONLY=true`) AND attribute writes (`USER_ID=karine-guest`). Setting none = v0.8.x behavior exactly.

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

See `wiki/obsidian-mcp-router sur Dedibox et MCPHub/` in the [opsidian-mcp-router et bridge meta vault](https://github.com/tboome33/obsidian-mcp-router#related-repos) for the complete multi-tenant deployment recipe (bundle `.mcpb`, MCPHub Keys with Access Scope, NPM front, Self-hosted LiveSync, etc.).

## Slash commands & skills (Claude Code plugin)

The repo doubles as a **Claude Code plugin marketplace** that exposes **40 slash commands** under the `/obsidian-router:*` namespace. Type `/obsidian-router:` in Claude Code → the autocomplete shows everything. Every slash command also auto-triggers on natural-language phrasing (EN + FR) so you rarely have to remember the exact name — just describe what you want.

> 📄 **Quick reference PDF** (router overview + setup + config + every slash command with NL trigger phrases) — [English](./docs/quick-reference-en.pdf) · [Français](./docs/quick-reference-fr.pdf). 5 pages, accessible font sizes for printing or screen reference.

### 🔧 14 MCP wrappers — one per core vault tool

#### `discover/` (2)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:discover-list-vaults` | List every configured vault (local + remote) with online/offline/latency, default-vault, lock state | *"list my vaults"*, *"are my vaults online"* / *"liste mes vaults"*, *"mes vaults sont-ils en ligne"* |
| `/obsidian-router:discover-list-files` | List files and subdirectories of a vault path | *"list files in Sessions"*, *"what's in <folder>"* / *"liste les fichiers de Sessions"*, *"qu'est-ce qu'il y a dans <dossier>"* |

#### `read/` (4)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:read-get` | Read a file in full (markdown + frontmatter + meta) | *"show me X"*, *"open the file X"* / *"montre-moi X"*, *"ouvre le fichier X"* |
| `/obsidian-router:read-search` | Plain-text (substring) search with surrounding context | *"find <text> in my vault"*, *"grep for X"* / *"trouve <texte> dans mon vault"*, *"grep <X>"* |
| `/obsidian-router:read-search-smart` | Semantic search via Smart Connections (cosine scores + breadcrumbs) | *"find notes about X"*, *"semantic search for X"* / *"trouve mes notes sur X"*, *"recherche sémantique sur X"* |
| `/obsidian-router:read-frontmatter` | Read frontmatter (whole object or one key, types preserved) | *"what's the status of X"*, *"show me the metadata of X"* / *"quel est le statut de X"*, *"montre les méta de X"* |

#### `write/` (5)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:write-create-or-replace` | PUT — create a new file or replace an existing one | *"create a note X"*, *"save this as X.md"* / *"crée une note X"*, *"enregistre ça comme X.md"* |
| `/obsidian-router:write-append` | POST — append to an existing file (auto-creates if missing) | *"append to my journal"*, *"add a line to X"* / *"ajoute à X"*, *"rajoute à la fin de X"* |
| `/obsidian-router:write-patch` | Surgical PATCH on heading / block / frontmatter | *"edit the X section in Y"*, *"replace the content under X"* / *"édite la section X dans Y"*, *"remplace le contenu sous X"* |
| `/obsidian-router:write-frontmatter-set` | Set/replace a single frontmatter key | *"set status to closed on X"*, *"tag this with X"* / *"passe le statut de X à closed"*, *"tag ça avec X"* |
| `/obsidian-router:write-frontmatter-merge` | Apply multiple frontmatter updates in sequence | *"on X set status=closed outcome=tp1"* / *"sur X mets status=closed outcome=tp1"* |

#### `manage/` (2)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:manage-move` | Move or rename a file (GET → PUT → DELETE) | *"rename X to Y"*, *"move X into <folder>"* / *"renomme X en Y"*, *"déplace X dans <dossier>"* |
| `/obsidian-router:manage-delete` | Delete a file (with two-step confirm guard) | *"delete X"* (preview), *"yes confirm=true"* (proceed) / *"supprime X"* puis *"oui confirm=true"* |

#### `template/` (1)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:template-execute` | Execute a Templater template (preview or save) | *"render Templates/X.md with arg1=v1"*, *"run the daily template"* / *"rends Templates/X.md avec arg1=v1"*, *"exécute le template daily"* |

### 🔒 3 router-state commands (lock + auto-enrichment)

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:lock` | Restrict the router to a single vault for the session (volatile or `--persist` to write to `.env`) | *"lock to tradingview"*, *"I only want to work on tradingview"*, *"isolate to tradingview permanently"* / *"verrouille sur tradingview"*, *"je ne veux travailler que sur tradingview"*, *"verrouille sur tradingview de manière permanente"* |
| `/obsidian-router:unlock` | Lift the lock and restore multi-vault routing (`--persist` to also clean `.env`) | *"unlock vaults"*, *"give me back access to all vaults"* / *"déverrouille les vaults"*, *"je veux pouvoir avoir accès à tous les vaults"* |
| `/obsidian-router:auto-mode` | Set the wiki auto-enrichment mode (`ClaudeAsk` / `Hybrid` / `FullAuto` / `off`); `--persist` writes to `.env` | *"switch to Hybrid mode"*, *"save everything automatically"* (→ FullAuto), *"stop auto-saving"* (→ off) / *"passe en mode Hybrid"*, *"sauve tout automatiquement"*, *"arrête de sauver auto"* |

See [Lock mode (single-vault isolation)](#lock-mode-single-vault-isolation) and the auto-enrichment callout below for the full designs and concrete use cases.

### 🩺 6 conversational helpers

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:meta-setup` | Bootstrap the router on a fresh machine (clone, npm link, register MCP) | *"install the router"*, *"bootstrap obsidian-mcp-router on this machine"* / *"installe le router"*, *"setup obsidian-mcp-router sur cette machine"* |
| `/obsidian-router:meta-attach-vault` | Interactive wizard to attach a vault to a workspace (default), bootstrap a standalone vault, or register a remote vault. Provisions plugins + scaffolds wiki + binds `.env` + edits `.gitignore` + conventions picker. | *"set up Obsidian for this project"*, *"attach a vault to this workspace"*, *"connect my remote vault"* / *"configure Obsidian pour ce projet"*, *"attache un vault à ce workspace"*, *"connecte mon vault distant"* |
| `/obsidian-router:meta-status` | Health-check every vault with per-issue fix hints | *"diagnose the router"*, *"are my vaults reachable"* / *"diagnostique le router"*, *"mes vaults sont-ils accessibles"* |
| `/obsidian-router:meta-sync-template` | Propagate the reference vault's plugins/snippets/docs to one or more vaults (interactive picker) | *"sync the template to all vaults"*, *"push reference plugins to X"* / *"synchronise le template vers tous les vaults"*, *"pousse les plugins de référence vers X"* |
| `/obsidian-router:meta-audit-bridge-readiness` | Audit click-to-open readiness across vaults (bridge ≥0.2.0, REST API ≥4.0.0, insecure HTTP, live `/open` probe) | *"audit bridge readiness"*, *"is click-to-open ready"* / *"audite la disponibilité du bridge"*, *"le click-to-open est-il prêt"* |
| `/obsidian-router:conventions` | Install / remove / status / propagate CLAUDE.md conventions (source-type, bilingual, heading-hierarchy, ...) across vaults | *"install source-type convention on X"*, *"list conventions"* / *"installe la convention source-type sur X"*, *"liste les conventions"* |

### 📚 15 knowledge-management commands (Karpathy-style LLM-wiki)

A small workflow on top of the router for an LLM-maintained, structured markdown knowledge base where pages reference each other and grow with use.

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:wiki` | Scaffold `wiki/` inside a vault (index, log, hot, overview + CLAUDE.md update) | *"set up a wiki"*, *"scaffold a knowledge base"* / *"scaffold un wiki"*, *"crée une base de connaissances"* |
| `/obsidian-router:wiki-ingest` | Ingest a source (URL/file/text) → entity & concept pages + cross-refs | *"ingest this URL"*, *"absorb this article"* / *"ingère cette URL"*, *"absorbe cet article"* |
| `/obsidian-router:wiki-query` | Three-tier RAG (hot.md → index.md → drill into pages), wiki-only (no web) | *"based on my notes, ..."*, *"what does my wiki say about X"* / *"d'après mes notes, ..."*, *"que dit mon wiki sur X"* |
| `/obsidian-router:wiki-lint` | Health check (orphans, dead wikilinks, index drift, frontmatter gaps) | *"lint the wiki"*, *"audit my wiki"* / *"lint le wiki"*, *"audit mon wiki"* |
| `/obsidian-router:wiki-fold` | Idempotent rollup of log entries under `wiki/folds/` | *"fold the log"*, *"roll up recent activity"* / *"compacte le journal"*, *"résume l'activité wiki de cette semaine"* |
| `/obsidian-router:save` | File the current conversation as a typed wiki note (session/answer/decision/ADR/...) | *"save this"*, *"file this conversation"* / *"sauvegarde ça"*, *"archive cette conversation"* |
| `/obsidian-router:autoresearch` | Autonomous web→synth→file loop bounded by a research program | *"research X on the web"*, *"go investigate X online"* / *"fais une recherche web sur X"*, *"investigue X en ligne"* |
| `/obsidian-router:canvas` | Create/edit Obsidian `.canvas` files (visual layer for wiki pages, images, PDFs) | *"create a canvas for X"*, *"add to my canvas"* / *"crée un canvas pour X"*, *"ajoute à mon canvas"* |
| `/obsidian-router:defuddle` | Strip noise from webpages (ads, nav, footers) before ingestion | *"defuddle <url>"*, *"clean this page"* / *"nettoie cette page"*, *"extrais la version lisible de <url>"* |
| `/obsidian-router:obsidian-bases` | Create/edit Obsidian `.base` files (database-like views over frontmatter) | *"create a base for X"*, *"task tracker base"* / *"crée une base pour X"*, *"base task tracker"* |
| `/obsidian-router:wiki-graph` | Build a typed knowledge-graph JSON from the vault (Understand-Anything schema; feeds the native graph viewer) | *"build the wiki graph"*, *"generate the knowledge graph"* / *"construis le graphe du wiki"*, *"génère le knowledge graph"* |
| `/obsidian-router:wiki-tour` | Generate an ordered pedagogical reading tour from the vault's link topology | *"give me a tour of this vault"*, *"where do I start"* / *"fais-moi un tour du vault"*, *"par où je commence"* |
| `/obsidian-router:wiki-export` | Export the vault as a portable single file (`llms.txt` / `llms-full.txt`) or as an **OKF knowledge bundle** (Google's Open Knowledge Format v0.1, shareable with any OKF-aware agent) | *"export the wiki as llms.txt"*, *"export as an OKF bundle"* / *"exporte le wiki en llms.txt"*, *"exporte en bundle OKF"* |
| `/obsidian-router:okf-export` | Export a wiki subset as a shareable **OKF v0.1 knowledge bundle** — slugified filenames, relative links, per-folder indexes, conformance self-checked, optional agent README | *"export this folder as an OKF bundle"*, *"publish my wiki as a knowledge bundle"* / *"exporte ce dossier en bundle OKF"*, *"publie mon wiki en bundle"* |
| `/obsidian-router:okf-check` | Validate an OKF bundle (ours or third-party) against the Open Knowledge Format v0.1 conformance rules — one of the ecosystem's first OKF validators | *"validate this OKF bundle"*, *"is this bundle conformant?"* / *"valide ce bundle OKF"*, *"ce bundle est-il conforme ?"* |
| `/obsidian-router:wiki-refresh-digests` | Regenerate the per-page digest sidecars (concepts/claims/keywords) used by `wiki-lint --deep` and the graph | *"refresh the digests"*, *"rebuild page digests"* / *"rafraîchis les digests"*, *"régénère les digests de page"* |
| `/obsidian-router:who-is-speaking` | Identify the current family member in a shared vault and lock routing per-member | *"who is speaking"*, *"it's Karine"* / *"qui parle"*, *"c'est Karine"* |

Plus one Obsidian-specific reference skill (no slash command — knowledge surfaced when other skills run): `obsidian-markdown` (Obsidian Flavored Markdown reference for wikilinks, embeds, callouts, properties, etc.). Note that `obsidian-bases` is BOTH a reference skill AND has its own slash command above — other skills consult it when they need to generate `.base` files, and you can also invoke it directly.

**Two parallel sub-agents** for batch work:
- `wiki-ingest` agent — fan out one source per agent, parallel
- `wiki-lint` agent — read-only diagnostic in a separate context

**Hooks** — **9 cross-platform Node hooks, auto-wired into `~/.claude/settings.json` at vault bootstrap since v0.18.2** (opt out with `setup-vault.mjs --no-hooks`):
- `session-auto-journal` — auto-journals each Claude session under `wiki-meta/Sessions/` + a 2-line recap to `wiki-meta/log.md` (self-healing reconciliation)
- `hot-cache-load` — loads `wiki-meta/hot.md` into context at SessionStart / PostCompact
- `hot-cache-update-prompt` — deterministic guard: **blocks the turn** (exit 2) until `wiki-meta/hot.md` is refreshed when this session wrote a `wiki/` note (per-vault, transcript-scoped; opt-out `OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD`)
- `wiki-autocommit` — auto-commits `wiki/`, `wiki-meta/`, `.raw/`, `.vault-meta/` to git after writes
- `wiki-query-first-nudge` — nudges Claude to check the vault before answering (+ injects PATH RESOLUTION RULES)
- `vault-link-linter` — catches broken/phantom vault links before they reach you
- `doc-propagation-checker` — flags docs drifting from shipped code
- `vault-doc-startup-check` — surfaces vault & doc health at session start
- `check-router-update` — 24h GitHub version check

The hooks ship in [`hooks/`](./hooks/); `setup-vault.mjs` wires them automatically at bootstrap.

**🆕 Auto-enrichment (v0.8.2, Phase 1)** — Claude proactively suggests wiki saves at three natural moments: **validation** (you say "OK" / "valide" → inline pin), **result obtained** (commit pushed, tests green → digest of candidates), and **topic switch** (mandatory checkpoint before Claude responds to the new topic). Domain-agnostic: works for development, personal life, research, family planning, anything.

**Four modes** (`/obsidian-router:auto-mode <Mode>` to switch, `--persist` to write to `.env`):

| Mode | Behavior | Best for |
|---|---|---|
| `ClaudeAsk` (default) | Propose, always confirm | Discovering the feature · long mixed-importance sessions · vaults where false positives would hurt · the calibration period (1-2 weeks) before trusting auto-save |
| `Hybrid` | Auto-save type-safe items (facts, URLs, preferences); ask on high-stakes (decisions, ADRs, rules, techniques) | Power-user sweet spot after calibration · active dev with frequent URL ingestion · research where citations pile up but conclusions need vetting |
| `FullAuto` | Auto-save everything; audit log in `wiki-meta/log.md` + sensitivity filter (never auto-save credentials/medical/financial) + hard cap (degrades to `ClaudeAsk` after 5 saves/session) | High-trust sessions · personal journal / family chronicle · long unsupervised flows (autoresearch, batch ingestion) · solo brain-dumps where the wiki IS the conversation log |
| `off` | No auto-suggestions; manual `/save` only | Debugging sessions you don't want polluting the wiki · sensitive conversations · default for legal/medical/financial vaults · control-freak preference |

**Placement** — the consigne ships in the vault `CLAUDE.md` template, but is also configurable as Claude Desktop **Project instructions** (elegant pattern: a "Trading Journal" project always saves to `tradingview`, a "Personal" project to `personal`). See [`docs/auto-enrichment.md`](./docs/auto-enrichment.md) for the four placement channels (vault CLAUDE.md, Project instructions, Memory, global CLAUDE.md), the activation rules, and concrete copy-paste boilerplates per channel.

Install steps are in the [Install](#install) section below.

## Prerequisites

| Plugin (per vault) | Required for | Where to get it |
|---|---|---|
| **Local REST API** | All tools | Community plugins → "Local REST API" by Adam Coddington |
| **MCP Router Bridge** | `search_smart`, `execute_template` | Install from [`tboome33/obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) — registers the `/search/smart` and `/templates/execute` REST routes that this router calls. |
| **Smart Connections** | `search_smart` | Community plugins → "Smart Connections" — the embeddings backend |
| **Templater** | `execute_template` | Community plugins → "Templater" by SilentVoid13 |

You also need:

- **Node.js ≥ 20.18.1** (required by `undici@7`)
- At least one vault provisioned in `~/.claude/obsidian-mcp-router/config.json`. If you've never set this up, run `npm run setup-vault -- "<vault-path>"` from a clone of this repo, or invoke [`scripts/setup-vault.mjs`](./scripts/setup-vault.mjs) directly — it'll bootstrap the config interactively. Schema reference: [`examples/config.example.json`](./examples/config.example.json).
- A **reference vault** registered with the router. It holds the canonical plugin set + config that `setup-vault.mjs` clones into every new vault. Fast path: `node scripts/setup-vault.mjs --bootstrap-reference <path>` scaffolds it from the shipped skeleton ([`templates/reference-vault-skeleton/`](./templates/reference-vault-skeleton/)) and auto-downloads the bridge plugin. Full procedure (manual + troubleshooting): [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md).

> 🧙 **Guided vault-creation wizard (v0.35.0+).** Creating a new vault is defaults-first: the engine computes a complete default plan, shows it in one line, and you accept it as-is (happy path = 1 interaction) or adjust any point (name · location · template source · plugins · theme · wiki mode). It works from **any LLM harness** via the `plan_vault` (read-only) + `provision_vault` MCP tools — not just the CLI. In Claude Code: the [`meta-attach-vault`](./skills/meta-attach-vault/SKILL.md) skill. From any other agent (Codex, Hermes, a raw MCP client): the [`docs/vault-wizard.md`](./docs/vault-wizard.md) playbook. Directly: `node scripts/setup-vault.mjs "<vault-path>" --dry-run --json` to preview, then without `--dry-run` to apply (`--help` lists all wizard flags). The two tools are LOCAL-ONLY (hidden on gated deployments); `provision_vault` refuses paths outside known vault roots; `--from-vault` copies config only (secrets always regenerated).

> **CSS snippets are cloned automatically.** Since v0.10.1, every `setup-vault.mjs` invocation also copies `<referenceVault>/.obsidian/snippets/*.css` into the target vault and merges the basenames into `<target>/.obsidian/appearance.json` `enabledCssSnippets`. The shipped skeleton ships `no-task-strikethrough.css` (kills Obsidian's default `text-decoration: line-through` on `- [x]` items, aligned with the [`roadmap-discipline`](./skills/conventions/snippets/roadmap-discipline.md) §2bis convention). Opt-out per vault in Settings → Appearance → CSS snippets. To push a snippet (or plugin) update to ALL configured vaults at once: `node scripts/setup-vault.mjs --sync-all` (idempotent; add `--force` to re-clone existing files).

## Install

> 📘 **Reference vault required for `setup-vault.mjs`** — to bootstrap new vaults via the script (which most users will want), you first need a one-time-configured reference vault holding the canonical plugin set. Easiest path: `node scripts/setup-vault.mjs --bootstrap-reference <path>` (scaffolds the skeleton + downloads bridge plugin in one command, then guides you through installing the marketplace plugins via Obsidian). Full doc with troubleshooting: [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md).

Two pieces to install: the **MCP server** (the router itself, exposes the 35 tools to Claude) and the **plugin** (exposes `/obsidian-router:*` slash commands).

### Step 1 — Install the MCP server

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

**Then enable the plugin per-workspace**, NOT globally. The plugin loads ~40 slash commands and ~39 skills (~10k context tokens per session) — you only want that overhead on workspaces that actually use Obsidian. For each vault directory and each app workspace that consumes the router, drop a `.claude/settings.json` file at the workspace root:

```json
{
  "enabledPlugins": {
    "obsidian-router@obsidian-mcp-router-marketplace": true
  }
}
```

For vaults bootstrapped via `setup-vault.mjs`, this file is **cloned automatically** from `.template/.claude/settings.json` — you don't have to write it by hand. For non-vault workspaces (dev repos that work with vault content), copy the snippet above into `<workspace>/.claude/settings.json`.

Restart Claude Code. From a workspace with the plugin enabled, type `/obsidian-router:` — the 40 slash commands should appear. From a workspace without, the namespace stays clean.

> **Why not enable it globally?** If you put `enabledPlugins` in `~/.claude/settings.json` instead of per-workspace, the plugin loads in EVERY Claude Code session — random scripts, debug sessions, unrelated repos — paying ~10k tokens for commands those sessions will never use. Project-scope keeps the budget tight.

> **Bump the skill-listing budget (recommended).** The router contributes ~39 skills to Claude Code's skill listing. On a default install (`skillListingBudgetFraction: 0.01`, i.e. 1% of the context window), this often pushes the listing past the budget — descriptions are truncated, and natural-language triggering for `/save`, `/wiki`, `/autoresearch` etc. silently breaks. **Recommended**: raise to `0.05` in `~/.claude/settings.json` (~6k extra tokens per session). The diagnostic message *"Skill listing will be truncated — N descriptions dropped"* at session start is the symptom this fixes.
>
> ```json
> { "skillListingBudgetFraction": 0.05 }
> ```
>
> The bundled `meta-setup` skill detects an under-budgeted setup and offers to apply this change interactively.

You can also use the bundled `meta-setup` skill to walk through both steps interactively: just ask Claude *"set up the obsidian-mcp-router on this machine"*.

### Staying up to date

The plugin ships a SessionStart hook (`hooks/check-router-update.mjs`, since v0.10.3) that checks GitHub once per 24 hours and surfaces a notice if a newer version is available. The notice tells Claude to relay it on its first response of the session, so you find out without having to remember to check.

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

The 38 plugin commands above are domain-agnostic on purpose — they work for any vault. If you want **macros** that chain multiple tools or bake in your vault's conventions (daily notes, capture inbox, weekly rollups, etc.), build them as your own slash commands in `~/.claude/commands/<name>.md` — not as PRs on this repo. The router stays neutral; the macros are yours.

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

1. **`OBSIDIAN_ROUTER_DEFAULT_VAULT` env var** — explicit per-process override. Set this in your project's `.env` to force a specific default regardless of cwd.
2. **`VAULT_PATH` env var** — auto-detection. If `VAULT_PATH` matches a path registered in your `portRegistry`, that vault becomes the default. `setup-vault.mjs` writes this into every bootstrapped vault's `.env`, so opening Claude Code in a vault directory "just works" with that vault as default.
3. **`config.defaultVault`** — explicit global default in `~/.claude/obsidian-mcp-router/config.json`.
4. **First healthy local vault** — historical fallback.
5. **First active vault of any type** — last resort.

The router auto-loads `.env` from the cwd at startup, so steps 1 and 2 work without any other tooling. Existing env vars in the parent process win over `.env`.

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
   in the workspace's `.env`. The router reads it on boot. Permanent until removed.

To unlock:
- `unlock_vaults()` — in-memory only
- `unlock_vaults({ persist: true })` — also removes `OBSIDIAN_ROUTER_LOCKED` from `<cwd>/.env`
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

**Ephemeral view links (optional view-agent provider)** — set `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (plus an optional shared secret `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN`, sent as `X-View-Token`) to plug a *view-link provider* into the router. Every note write then carries a ready-to-click `viewLink` to the vault's **live Obsidian GUI navigated to that note** (≥ 0.29.0, deterministic server-side injection), the `get_view_link` tool appears (≥ 0.28.0 — it is hidden from ListTools while the URL is unset, so unconfigured routers carry zero dead surface), and `open_in_obsidian` returns the link for remote-container vaults (≥ 0.30.0). The router depends only on a small HTTP contract — `GET /view?vault=<name>&note=<path>` → `{"url": "<browser-ready link>"}` — not on any particular infrastructure: see the **reference provider implementation + the normative contract** at [obsidian-mcp-router-view-agent](https://github.com/tboome33/obsidian-mcp-router-view-agent) (config-driven, stdlib-only Python, ephemeral cloudflared quick tunnels).

**Smart links (optional resolver)** — set `OBSIDIAN_ROUTER_SMART_LINK_URL` (resolver base URL) **and** `OBSIDIAN_ROUTER_SMART_LINK_SECRET` (HMAC secret) to emit **stable signed smart links** instead of agent-fetched view links: note writes and `open_in_obsidian` on remote vaults then carry `viewLink = <resolver>/o/<signed-token>` with `viewLinkKind: "smart"` — a pure HMAC computation, **zero network call** (a write can never be slowed by a down agent), and the link stays valid in chat history (30-day token TTL). The link resolves **on the device that clicks it** (local Obsidian mirror probe → `obsidian://` deep link → streamed-GUI fallback). Provider priority when both are configured: smart link → view-agent → none; `get_view_link` keeps talking to the view-agent directly. Configuring smart links signals a **remote** deployment — do not set `OBSIDIAN_ROUTER_SMART_LINK_*` on a purely local router, or `open_in_obsidian` will hand back a link (`opened:false`, `delivered:"link"`) instead of navigating your local Obsidian. The resolver reference implementation + contracts live in the private saas repo (`obsidian-mcp-router-saas`).

**Deployment-wide transport guard** — set `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK=true` (typically on a multi-tenant MCPHub instance) to make the router **refuse to start** if any served vault's `baseUrl` host is neither loopback (`127.0.0.1`/`::1`/`localhost`) nor inside the `10.8.0.0/24` WireGuard mesh. This is a **boot-time config check on the configured baseUrls** — it does *not* require the WireGuard tunnel to be up, and **loopback passes** (so it is not "WireGuard-only"). Fail-closed — a vault can never be silently served over an exposed link; the check runs after the `OBSIDIAN_ROUTER_ALLOWED_VAULTS` whitelist. Opt-in; unset = no enforcement (local mode unchanged). This replaces the former per-vault `wireguard` flag. *(Renamed from `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` in v0.27.0 — that name wrongly implied "WG must be up"; the old name still works as a deprecated alias.)*

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
    "C:\\VAULTS\\.template": 27124,
    "C:\\VAULTS\\TradingView": 27125
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

## Tools exposed

| Tool | Description |
|---|---|
| `list_vaults` | Catalogue of all configured vaults with online status + latency. Always call this first. |
| `list_files` | List files in a directory of a specific vault. |
| `get_file` | Read full file content (markdown + frontmatter). |
| `search` | Plain-text (substring) search. Pass `vault: "*"` to fan-out across all vaults. |
| `search_smart` | Semantic (meaning-based) search via Smart Connections embeddings. Returns ranked chunks with cosine scores and breadcrumbs. Requires `obsidian-mcp-router-bridge` + `smart-connections` plugins enabled in the target vault. Supports `vault: "*"` for cross-vault semantic search. |
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
| `pdf_to_markdown` · `docx_to_markdown` · `xlsx_to_markdown` · `pptx_to_markdown` · `image_to_markdown` · `audio_to_markdown` | Convert a local file to markdown via the bundled `markitdown` Python CLI. Image OCR and audio transcription require the `[all]` extras (installed by default at postinstall). Returns markdown text only — chain with `write_file` to persist. |
| `pdf_to_markdown_docling` | Convert a local PDF to markdown via **Docling**'s standard pipeline (layout detection + TableFormer table-structure recognition). Higher fidelity than `pdf_to_markdown` on complex tables / multi-column layouts, at ~10× the CPU cost. **Opt-in** — requires the Docling extra (see *Conversion tools — runtime dependencies*). PDF only; for office formats keep `pdf_to_markdown`. |
| `youtube_to_markdown` · `bing_search_to_markdown` · `webpage_to_markdown` | Convert a remote URL to markdown via `markitdown`. URL must be http(s); private/loopback hosts are refused (SSRF guard). For JS-heavy SPAs prefer the `defuddle` skill (headless browser). |
| `git_repo_to_markdown` | Bundle a git repository (file tree + source code) into a single markdown document via `repomix`. Accepts a full URL or the `owner/repo` shorthand. Pass `compress: true` for ~70% size reduction via Tree-sitter. |
| `extract_page_metadata` | Deterministic page-metadata extractor (JSON-LD + OpenGraph + meta tags + title) — feeds non-fabricated frontmatter for ingestion. |
| `propose_linked_sources` | Heuristic-scored `<a href>` follower that proposes recursive-ingestion candidates (top-N, same-domain / related-section boosts). |
| `download_page_assets` | Download a page's images into the vault (image preservation during web ingestion). |
| `build_open_link` | Build a ready-to-paste click-to-open markdown link (`http://127.0.0.1:<insecurePort>/open/<path>`) for one or many vault files. Read-only. |
| `open_in_obsidian` | Open a note in the running Obsidian (and raise its window) by calling the bridge `/open` route **server-side** — no browser. The browser-free counterpart to a click-to-open link, for clients (e.g. Claude Desktop) that otherwise proxy clicked links through a browser. Optional `anchor` scrolls to a heading. Navigation-only. |
| `get_wiki_context_pack` | Return a structured JSON context envelope for a query (primaryPages / semanticChunks / graphNeighbors / citations) so non-Claude agents can consume the vault programmatically. |
| `build_wiki_graph` | Assemble the vault into a typed knowledge-graph JSON (Understand-Anything schema: 21 node / 35 edge types). Writes `wiki-meta/graph/knowledge-graph.json` + a derived `.understand-anything/` copy. |
| `build_wiki_tour` | Generate a deterministic, ordered pedagogical reading tour from the knowledge-graph link topology. Read-only. |

More tools (CLI flags, hot config reload, skills) are on the roadmap — see [ROADMAP.md](./ROADMAP.md).

### Conversion tools — runtime dependencies

The `*_to_markdown` family is a JS/ESM port of [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT) — see `NOTICE` for the full credit. The actual file → markdown conversion is performed by Microsoft's `markitdown` Python CLI:

- **Python 3.10+** is required. The router's npm postinstall script (`scripts/install-markitdown.mjs`) auto-detects Python on `PATH`, creates a local `.venv` at the repo root, and installs `markitdown[all]>=0.1.5`. If Python is missing, the postinstall prints a warning and exits cleanly — the rest of the router still works.
- Skip the postinstall with `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` or `npm install --ignore-scripts`. Re-run manually any time with `npm run install-markitdown`.
- To use a system-wide install instead of the bundled venv: `pipx install "markitdown[all]"` and set `MARKITDOWN_PATH=/abs/path/to/markitdown`.
- `git_repo_to_markdown` uses `repomix` (Node, bundled as a normal npm dependency — no extra setup).

**High-fidelity PDF via Docling (opt-in).** `pdf_to_markdown_docling` uses [Docling](https://github.com/docling-project/docling) (IBM / LF AI & Data Foundation, MIT) instead of MarkItDown — its layout + TableFormer models reconstruct table structure and reading order that MarkItDown's `pdfminer.six` backend loses, at ~10× the CPU cost. Docling pulls ~1-2 GB of torch/onnxruntime + model weights, so it is **not** installed by default:

- Enable it by setting `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` **before** `npm install` — the postinstall then creates a separate `.venv-docling` and runs `pip install docling` (standard pipeline; no VLM/ASR extras). Re-run any time with the env var set: `npm run install-docling`. Needs Python 3.10+.
- To use a system-wide install instead: `pipx install docling` and set `DOCLING_PATH=/abs/path/to/docling`.
- `pdf_to_markdown_docling` stays listed even when Docling isn't installed; calling it then returns an actionable install hint. `pdf_to_markdown` (MarkItDown) is unaffected and remains the default fast path. Docling is PDF-only here — DOCX/PPTX/XLSX keep using MarkItDown.

Optional sandbox env vars:

| Variable | Purpose |
|---|---|
| `MARKITDOWN_PATH` | Absolute path to the `markitdown` executable. Override when not using the bundled venv. |
| `REPOMIX_PATH` | Absolute path to the `repomix` executable. Override when not using the bundled `node_modules/.bin/repomix`. |
| `YTDLP_PATH` | Absolute path to the `yt-dlp` executable, used by `youtube_to_markdown`'s caption fallback (when MarkItDown's YouTube path fails). When unset, `yt-dlp` is looked up on `PATH`; the fallback degrades with a clear install hint if it's absent. |
| `OBSIDIAN_ROUTER_VIDEO_SUBLANGS` | yt-dlp `--sub-langs` value for the caption fallback (default `en.*,en`). Widen to fetch other subtitle languages. |
| `MD_ALLOWED_PATHS` | `:`-separated (POSIX) or `;`-separated (Windows) list of directories the conversion tools are allowed to read. When unset (default), any absolute path is fair game. When set, the file-input conversion tools reject paths outside the listed directories. |
| `MD_SHARE_DIR` | Legacy single-directory alias for `MD_ALLOWED_PATHS`, kept for backward compatibility with markdownify-mcp setups. Prefer `MD_ALLOWED_PATHS`. |
| `OBSIDIAN_ROUTER_SKIP_MARKITDOWN` | Set to `1` to skip the venv creation at postinstall. |
| `OBSIDIAN_ROUTER_ENABLE_DOCLING` | Set to `1` **before install** to opt into the Docling backend for `pdf_to_markdown_docling` (creates `.venv-docling`, `pip install docling`). Any other value → the tool is listed but errors with an install hint at call time. |
| `DOCLING_PATH` | Absolute path to the `docling` executable. Override when not using the bundled `.venv-docling`. |

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
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520.18.1-brightgreen.svg" alt="node"></a>
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.37.0-blueviolet.svg" alt="version"></a>
</p>

> Serveur MCP qui aiguille les appels d'outils Claude vers **plusieurs** vaults Obsidian — locaux ou distants — via le plugin [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api).

Au lieu d'enregistrer un MCP par vault (un process, un port, une clé API), ce router expose un **seul** MCP qui connaît tous les vaults que tu as configurés. Chaque outil prend un paramètre `vault` (ou utilise ton vault par défaut), et le router fait suivre l'appel HTTPS vers la bonne instance Obsidian.

### Pourquoi

Si tu maintiens plusieurs vaults Obsidian — locaux ou distants, dans n'importe quelle combinaison — tu ne veux pas enregistrer un serveur MCP par vault et changer de contexte à chaque fois. Ce router est **un seul** process qui les connaît tous et route chaque appel d'outil vers le bon en fonction d'un paramètre `vault`.

Ce que tu obtiens :

- **Une seule entrée MCP** dans `~/.claude.json` (user scope) → tous les vaults sont visibles depuis n'importe quelle session Claude Desktop ou Code.
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
| Conversion (v0.11+) | `pdf_to_markdown`, `docx_to_markdown`, `xlsx_to_markdown`, `pptx_to_markdown`, `image_to_markdown`, `audio_to_markdown`, `youtube_to_markdown`, `bing_search_to_markdown`, `webpage_to_markdown`, `git_repo_to_markdown`, plus `pdf_to_markdown_docling` (opt-in high-fidelity PDF via [Docling](https://github.com/docling-project/docling), MIT) — port de [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) (MIT). |
| Métadonnées web/page | `extract_page_metadata`, `propose_linked_sources`, `download_page_assets` |
| Contexte & graphe | `get_wiki_context_pack`, `build_wiki_graph`, `build_wiki_tour`, `build_open_link` |
| Cross-vault | tous les outils acceptent `vault: "*"` pour fan-out |

La recherche sémantique (`search_smart`) et l'exécution Templater (`execute_template`) nécessitent que le plugin [`obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) soit installé dans chaque vault cible — il enregistre les routes correspondantes `/search/smart` et `/templates/execute` sur Local REST API. Tout le reste fonctionne contre les endpoints standards de Local REST API seuls.

### Slash commands & skills (plugin Claude Code)

Le repo est aussi un **marketplace de plugin Claude Code** qui expose **40 slash commands** sous le namespace `/obsidian-router:*`. Tape `/obsidian-router:` dans Claude Code → l'autocomplete montre tout. Chaque slash command s'auto-déclenche aussi sur du langage naturel (EN + FR), donc tu n'as quasiment jamais à retenir le nom exact — décris simplement ce que tu veux.

> 📄 **PDF de référence rapide** (vue d'ensemble du router + setup + config + chaque slash command avec phrases déclencheuses en langage naturel) — [Français](./docs/quick-reference-fr.pdf) · [English](./docs/quick-reference-en.pdf). 5 pages, fontes lisibles pour impression ou consultation écran.

#### 🔧 14 wrappers MCP — un par outil de base du vault

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

##### `write/` (5)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:write-create-or-replace` | PUT — crée ou remplace un fichier | *"crée une note X"*, *"enregistre ça comme X.md"* / *"create a note X"*, *"save this as X.md"* |
| `/obsidian-router:write-append` | POST — append à un fichier (auto-création si absent) | *"ajoute à X"*, *"rajoute à la fin de X"* / *"append to my journal"*, *"add a line to X"* |
| `/obsidian-router:write-patch` | PATCH chirurgical sur heading / block / frontmatter | *"édite la section X dans Y"*, *"remplace le contenu sous X"* / *"edit the X section in Y"*, *"replace the content under X"* |
| `/obsidian-router:write-frontmatter-set` | Set/remplace une seule clé du frontmatter | *"passe le statut de X à closed"*, *"tag ça avec X"* / *"set status to closed on X"*, *"tag this with X"* |
| `/obsidian-router:write-frontmatter-merge` | Applique plusieurs updates de frontmatter en séquence | *"sur X mets status=closed outcome=tp1"* / *"on X set status=closed outcome=tp1"* |

##### `manage/` (2)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:manage-move` | Déplace ou renomme un fichier (GET → PUT → DELETE) | *"renomme X en Y"*, *"déplace X dans <dossier>"* / *"rename X to Y"*, *"move X into <folder>"* |
| `/obsidian-router:manage-delete` | Supprime un fichier (avec garde confirm en deux étapes) | *"supprime X"* (preview), *"oui confirm=true"* (proceed) / *"delete X"* puis *"yes confirm=true"* |

##### `template/` (1)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:template-execute` | Exécute un template Templater (preview ou save) | *"rends Templates/X.md avec arg1=v1"*, *"exécute le template daily"* / *"render Templates/X.md with arg1=v1"*, *"run the daily template"* |

#### 🔒 3 commandes d'état du router (lock + auto-enrichissement)

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:lock` | Restreint le router à un seul vault pour la session (volatile ou `--persist` pour écrire dans `.env`) | *"verrouille sur tradingview"*, *"je ne veux travailler que sur tradingview"*, *"verrouille sur tradingview de manière permanente"* / *"lock to tradingview"*, *"I only want to work on tradingview"*, *"isolate to tradingview permanently"* |
| `/obsidian-router:unlock` | Lève le lock et restaure le routing multi-vault (`--persist` pour aussi nettoyer `.env`) | *"déverrouille les vaults"*, *"je veux pouvoir avoir accès à tous les vaults"* / *"unlock vaults"*, *"give me back access to all vaults"* |
| `/obsidian-router:auto-mode` | Set le mode d'auto-enrichissement wiki (`ClaudeAsk` / `Hybrid` / `FullAuto` / `off`) ; `--persist` écrit dans `.env` | *"passe en mode Hybrid"*, *"sauve tout automatiquement"* (→ FullAuto), *"arrête de sauver auto"* (→ off) / *"switch to Hybrid mode"*, *"save everything automatically"*, *"stop auto-saving"* |

Voir [Mode lock (isolation mono-vault)](#mode-lock-isolation-mono-vault) et le callout auto-enrichissement plus bas pour les designs complets et cas d'usage concrets.

#### 🩺 6 helpers conversationnels

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:meta-setup` | Bootstrap du router sur une machine neuve (clone, npm link, registration MCP) | *"installe le router"*, *"setup obsidian-mcp-router sur cette machine"* / *"install the router"*, *"bootstrap obsidian-mcp-router on this machine"* |
| `/obsidian-router:meta-attach-vault` | Wizard interactif pour attacher un vault à un workspace (cas courant), bootstrapper un vault standalone, ou enregistrer un vault distant. Provisionne plugins + scaffolde wiki + lie `.env` + édite `.gitignore` + picker de conventions. | *"configure Obsidian pour ce projet"*, *"attache un vault à ce workspace"*, *"connecte mon vault distant"* / *"set up Obsidian for this project"*, *"attach a vault to this workspace"*, *"connect my remote vault"* |
| `/obsidian-router:meta-status` | Health-check de chaque vault avec hints de fix par catégorie d'erreur | *"diagnostique le router"*, *"mes vaults sont-ils accessibles"* / *"diagnose the router"*, *"are my vaults reachable"* |
| `/obsidian-router:meta-sync-template` | Propage les plugins/snippets/docs du vault de référence vers un ou plusieurs vaults (picker interactif) | *"synchronise le template vers tous les vaults"*, *"pousse les plugins de référence vers X"* / *"sync the template to all vaults"*, *"push reference plugins to X"* |
| `/obsidian-router:meta-audit-bridge-readiness` | Audite la disponibilité du click-to-open sur les vaults (bridge ≥0.2.0, REST API ≥4.0.0, HTTP insecure, probe live `/open`) | *"audite la disponibilité du bridge"*, *"le click-to-open est-il prêt"* / *"audit bridge readiness"*, *"is click-to-open ready"* |
| `/obsidian-router:conventions` | Installe / retire / statut / propage les conventions CLAUDE.md (source-type, bilingual, heading-hierarchy, ...) sur les vaults | *"installe la convention source-type sur X"*, *"liste les conventions"* / *"install source-type convention on X"*, *"list conventions"* |

#### 📚 15 commandes de gestion de connaissances (LLM-wiki façon Karpathy)

Un petit workflow par-dessus le router pour une base de connaissances en markdown structuré, maintenue par le LLM, où les pages se référencent entre elles et croissent avec l'usage.

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:wiki` | Scaffold `wiki/` dans un vault (index, log, hot, overview + update CLAUDE.md) | *"scaffold un wiki"*, *"crée une base de connaissances"* / *"set up a wiki"*, *"scaffold a knowledge base"* |
| `/obsidian-router:wiki-ingest` | Ingestion d'une source (URL/fichier/texte) → pages entité & concept + cross-refs | *"ingère cette URL"*, *"absorbe cet article"* / *"ingest this URL"*, *"absorb this article"* |
| `/obsidian-router:wiki-query` | RAG en 3 tiers (hot.md → index.md → drill), wiki-only (sans web) | *"d'après mes notes, ..."*, *"que dit mon wiki sur X"* / *"based on my notes, ..."*, *"what does my wiki say about X"* |
| `/obsidian-router:wiki-lint` | Health check (orphelins, wikilinks morts, dérive d'index, frontmatter manquant) | *"lint le wiki"*, *"audit mon wiki"* / *"lint the wiki"*, *"audit my wiki"* |
| `/obsidian-router:wiki-fold` | Rollup idempotent des entrées du log dans `wiki/folds/` | *"compacte le journal"*, *"résume l'activité wiki de cette semaine"* / *"fold the log"*, *"roll up recent activity"* |
| `/obsidian-router:save` | File la conversation courante comme note typée (session/answer/decision/ADR/...) | *"sauvegarde ça"*, *"archive cette conversation"* / *"save this"*, *"file this conversation"* |
| `/obsidian-router:autoresearch` | Boucle web→synthèse→file autonome bornée par un programme de recherche | *"fais une recherche web sur X"*, *"investigue X en ligne"* / *"research X on the web"*, *"go investigate X online"* |
| `/obsidian-router:canvas` | Crée/édite des fichiers `.canvas` Obsidian (couche visuelle pour wiki, images, PDFs) | *"crée un canvas pour X"*, *"ajoute à mon canvas"* / *"create a canvas for X"*, *"add to my canvas"* |
| `/obsidian-router:defuddle` | Strip le bruit des pages web (pubs, nav, footers) avant ingestion | *"nettoie cette page"*, *"extrais la version lisible de <url>"* / *"defuddle <url>"*, *"clean this page"* |
| `/obsidian-router:obsidian-bases` | Crée/édite des fichiers `.base` Obsidian (vues database sur frontmatter) | *"crée une base pour X"*, *"base task tracker"* / *"create a base for X"*, *"task tracker base"* |
| `/obsidian-router:wiki-graph` | Construit un knowledge-graph JSON typé depuis le vault (schéma Understand-Anything ; alimente le viewer graphe natif) | *"construis le graphe du wiki"*, *"génère le knowledge graph"* / *"build the wiki graph"*, *"generate the knowledge graph"* |
| `/obsidian-router:wiki-tour` | Génère un parcours de lecture pédagogique ordonné depuis la topologie de liens du vault | *"fais-moi un tour du vault"*, *"par où je commence"* / *"give me a tour of this vault"*, *"where do I start"* |
| `/obsidian-router:wiki-export` | Exporte le vault en fichier unique portable (`llms.txt` / `llms-full.txt`) ou en **bundle OKF** (Open Knowledge Format v0.1 de Google, partageable avec tout agent compatible OKF) | *"exporte le wiki en llms.txt"*, *"exporte en bundle OKF"* / *"export the wiki as llms.txt"*, *"export as an OKF bundle"* |
| `/obsidian-router:okf-export` | Exporte un sous-ensemble du wiki en **bundle OKF v0.1** partageable — noms slugifiés, liens relatifs, index par dossier, conformité auto-vérifiée, README agent optionnel | *"exporte ce dossier en bundle OKF"*, *"publie mon wiki en bundle"* / *"export this folder as an OKF bundle"*, *"publish my wiki as a knowledge bundle"* |
| `/obsidian-router:okf-check` | Valide un bundle OKF (le nôtre ou un tiers) contre les règles de conformité Open Knowledge Format v0.1 — l'un des premiers validateurs de l'écosystème | *"valide ce bundle OKF"*, *"ce bundle est-il conforme ?"* / *"validate this OKF bundle"*, *"is this bundle conformant?"* |
| `/obsidian-router:wiki-refresh-digests` | Régénère les digests sidecar par page (concepts/claims/keywords) utilisés par `wiki-lint --deep` et le graphe | *"rafraîchis les digests"*, *"régénère les digests de page"* / *"refresh the digests"*, *"rebuild page digests"* |
| `/obsidian-router:who-is-speaking` | Identifie le membre de la famille courant dans un vault partagé et lock le routing par membre | *"qui parle"*, *"c'est Karine"* / *"who is speaking"*, *"it's Karine"* |

Plus un skill de référence Obsidian (sans slash command — surfacé quand d'autres skills tournent) : `obsidian-markdown` (référence du Obsidian Flavored Markdown : wikilinks, embeds, callouts, properties, etc.). Note : `obsidian-bases` est À LA FOIS un skill de référence ET a sa propre slash command (la ligne au-dessus) — d'autres skills le consultent quand ils ont besoin de générer des fichiers `.base`, et tu peux aussi l'invoquer directement.

**Deux sub-agents parallèles** pour les batches :
- agent `wiki-ingest` — fan-out un agent par source, en parallèle
- agent `wiki-lint` — diagnostic read-only dans un contexte isolé

**Hooks** — **9 hooks Node cross-platform, auto-câblés dans `~/.claude/settings.json` au bootstrap du vault depuis v0.18.2** (opt-out via `setup-vault.mjs --no-hooks`) :
- `session-auto-journal` — journalise automatiquement chaque session Claude sous `wiki-meta/Sessions/` + un récap 2 lignes dans `wiki-meta/log.md` (réconciliation auto-réparatrice)
- `hot-cache-load` — charge `wiki-meta/hot.md` dans le contexte au SessionStart / PostCompact
- `hot-cache-update-prompt` — garde déterministe : **bloque le tour** (exit 2) tant que `wiki-meta/hot.md` n'est pas rafraîchi quand la session a écrit une note `wiki/` (par vault, scopé au transcript ; opt-out `OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD`)
- `wiki-autocommit` — auto-commit `wiki/`, `wiki-meta/`, `.raw/`, `.vault-meta/` sur git après les écritures
- `wiki-query-first-nudge` — rappelle à Claude de consulter le vault avant de répondre (+ injecte les PATH RESOLUTION RULES)
- `vault-link-linter` — attrape les liens vault cassés/fantômes avant qu'ils ne t'atteignent
- `doc-propagation-checker` — signale les docs qui dérivent du code shippé
- `vault-doc-startup-check` — surface la santé vault & docs au démarrage de session
- `check-router-update` — check de version GitHub toutes les 24h

Les hooks vivent dans [`hooks/`](./hooks/) ; `setup-vault.mjs` les câble automatiquement au bootstrap.

**🆕 Auto-enrichissement (v0.8.2, Phase 1)** — Claude propose proactivement de saver dans le wiki à trois moments naturels : **validation** (tu dis "OK" / "valide" → pin inline), **résultat obtenu** (commit pushé, tests verts → digest de candidats), et **changement de sujet** (checkpoint obligatoire avant que Claude réponde au nouveau sujet). Agnostique du domaine : marche pour le dev, la vie perso, la recherche, la planification familiale, n'importe quoi.

**Quatre modes** (`/obsidian-router:auto-mode <Mode>` pour switcher, `--persist` pour écrire dans `.env`) :

| Mode | Comportement | Pour quel usage |
|---|---|---|
| `ClaudeAsk` (défaut) | Propose, confirme toujours | Découverte de la feature · sessions longues à importance mixte · vaults où les faux positifs coûtent cher à nettoyer · période de calibration (1-2 semaines) avant de faire confiance à l'auto-save |
| `Hybrid` | Auto-save les items type-safe (facts, URLs, préférences) ; ask sur les high-stakes (décisions, ADRs, règles, techniques) | Sweet spot power-user après calibration · dev actif avec ingestion d'URLs fréquente · recherche où les citations s'empilent mais les conclusions doivent être vettées |
| `FullAuto` | Auto-save tout ; audit log dans `wiki-meta/log.md` + filtre de sensibilité (jamais d'auto-save sur credentials/médical/financier) + hard cap (dégrade en `ClaudeAsk` après 5 saves/session) | Sessions à haute confiance en Claude · journal perso / chronique familiale · flows longs non supervisés (autoresearch, ingestion en batch) · brain-dumps solo où le wiki EST le log de conversation |
| `off` | Pas de suggestions auto ; seul `/save` manuel | Sessions de debug que tu ne veux pas polluer dans le wiki · conversations sensibles · défaut pour les vaults légal/médical/financier · préférence control-freak |

**Placement** — la consigne est shipped dans le `CLAUDE.md` template du vault, mais aussi configurable en **instructions de Project Claude Desktop** (pattern élégant : un Project "Journal Trading" sauve toujours dans `tradingview`, un Project "Personnel" dans `personal`). Voir [`docs/auto-enrichment.md`](./docs/auto-enrichment.md) pour les quatre canaux de placement (CLAUDE.md du vault, instructions de Project, Memory, CLAUDE.md global), les règles d'activation, et des boilerplates copy-paste par canal.

Étapes d'install dans la section [Installation](#installation) ci-dessous.

### Prérequis

| Plugin (par vault) | Requis pour | Où l'obtenir |
|---|---|---|
| **Local REST API** | Tous les outils | Community plugins → "Local REST API" par Adam Coddington |
| **MCP Router Bridge** | `search_smart`, `execute_template` | À installer depuis [`tboome33/obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) — enregistre les routes REST `/search/smart` et `/templates/execute` que ce router appelle. |
| **Smart Connections** | `search_smart` | Community plugins → "Smart Connections" — moteur d'embeddings |
| **Templater** | `execute_template` | Community plugins → "Templater" par SilentVoid13 |

Il te faut aussi :

- **Node.js ≥ 20.18.1** (required by `undici@7`)
- Au moins un vault provisionné dans `~/.claude/obsidian-mcp-router/config.json`. Si tu n'as jamais fait ce setup, lance `npm run setup-vault -- "<vault-path>"` depuis un clone de ce repo, ou invoque [`scripts/setup-vault.mjs`](./scripts/setup-vault.mjs) directement — il bootstrappe la config interactivement. Référence du schéma : [`examples/config.example.json`](./examples/config.example.json).
- Un **vault de référence** enregistré auprès du router. Il contient le set canonique de plugins + config que `setup-vault.mjs` clone dans chaque nouveau vault. Voie rapide : `node scripts/setup-vault.mjs --bootstrap-reference <path>` scaffolde depuis le skeleton livré ([`templates/reference-vault-skeleton/`](./templates/reference-vault-skeleton/)) et télécharge automatiquement le bridge plugin. Procédure complète (manuelle + troubleshooting) : [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) (en anglais).

> **Les snippets CSS sont clonés automatiquement.** Depuis v0.10.1, chaque invocation de `setup-vault.mjs` copie aussi `<referenceVault>/.obsidian/snippets/*.css` dans le vault target et merge les basenames dans `<target>/.obsidian/appearance.json` `enabledCssSnippets`. Le skeleton ship `no-task-strikethrough.css` (désactive le `text-decoration: line-through` par défaut d'Obsidian sur les items `- [x]`, aligné sur la convention [`roadmap-discipline`](./skills/conventions/snippets/roadmap-discipline.md) §2bis). Opt-out par vault dans Settings → Appearance → CSS snippets. Pour pousser une mise à jour de snippet (ou plugin) à TOUS les vaults configurés d'un coup : `node scripts/setup-vault.mjs --sync-all` (idempotent ; ajoute `--force` pour re-cloner les fichiers existants).

### Installation

> 📘 **Vault de référence requis pour `setup-vault.mjs`** — pour bootstrapper de nouveaux vaults via le script (ce que la plupart des utilisateurs voudront), il faut d'abord un vault de référence configuré une seule fois qui contient le set canonique de plugins. Voie la plus rapide : `node scripts/setup-vault.mjs --bootstrap-reference <path>` (scaffolde le skeleton + télécharge le bridge plugin en une commande, puis te guide pour installer les plugins marketplace via Obsidian). Doc complète avec troubleshooting : [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) (en anglais).

Deux composants à installer : le **MCP server** (le router lui-même, expose les 35 outils à Claude) et le **plugin** (expose les slash commands `/obsidian-router:*`).

#### Étape 1 — Installer le MCP server

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

**Puis active le plugin par workspace**, PAS globalement. Le plugin charge ~40 slash commands et ~39 skills (~10k tokens de contexte par session) — tu ne veux ça que sur les workspaces qui font effectivement de l'Obsidian. Pour chaque dossier de vault et chaque workspace d'app qui consomme le router, ajoute un `.claude/settings.json` à la racine du workspace :

```json
{
  "enabledPlugins": {
    "obsidian-router@obsidian-mcp-router-marketplace": true
  }
}
```

Pour les vaults bootstrappés via `setup-vault.mjs`, ce fichier est **cloné automatiquement** depuis `.template/.claude/settings.json` — pas à écrire à la main. Pour les workspaces hors-vault (repos de code qui travaillent avec le contenu d'un vault), copie le snippet ci-dessus dans `<workspace>/.claude/settings.json`.

Redémarre Claude Code. Depuis un workspace où le plugin est activé, tape `/obsidian-router:` — les 40 slash commands doivent apparaître. Depuis un workspace sans, le namespace reste vide.

> **Pourquoi pas en global ?** Si tu mets `enabledPlugins` dans `~/.claude/settings.json` au lieu de per-workspace, le plugin se charge dans CHAQUE session Claude Code — scripts random, sessions de debug, repos sans rapport — payant ~10k tokens pour des commandes que ces sessions n'utiliseront jamais. Le project-scope garde le budget serré.

> **Augmenter le budget de la skill-listing (recommandé).** Le router ajoute ~39 skills à la liste exposée à Claude Code. Sur une instance par défaut (`skillListingBudgetFraction: 0.01`, soit 1% de la fenêtre de contexte), ça pousse souvent la liste au-delà du budget — les descriptions sont tronquées et le triggering en langage naturel pour `/save`, `/wiki`, `/autoresearch` etc. casse silencieusement. **Recommandé** : passer à `0.05` dans `~/.claude/settings.json` (~6k tokens supplémentaires par session). Le message *"Skill listing will be truncated — N descriptions dropped"* au démarrage de session est le symptôme que ce réglage corrige.
>
> ```json
> { "skillListingBudgetFraction": 0.05 }
> ```
>
> Le skill `meta-setup` détecte un budget sous-dimensionné et propose d'appliquer ce changement interactivement.

Tu peux aussi utiliser le skill `meta-setup` du plugin pour qu'il te guide à travers les deux étapes : demande à Claude *"setup le obsidian-mcp-router sur cette machine"*.

### Rester à jour

Le plugin ship un hook SessionStart (`hooks/check-router-update.mjs`, depuis v0.10.3) qui check GitHub une fois par 24h et émet une notice si une nouvelle version est disponible. La notice demande à Claude de la relayer sur sa première réponse de la session — tu es au courant sans avoir besoin de penser à check.

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

Les 40 commandes du plugin sont agnostiques du domaine. Si tu veux des **macros** qui enchaînent plusieurs outils ou intègrent les conventions de ton vault (daily notes, capture inbox, rollups hebdo…), construis-les séparément comme slash commands dans `~/.claude/commands/<name>.md` — pas en PR sur ce repo. Le routeur reste neutre, les macros restent à toi.

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

1. **Variable d'env `OBSIDIAN_ROUTER_DEFAULT_VAULT`** — override explicite par process. À mettre dans le `.env` de ton projet pour forcer un default spécifique indépendamment du cwd.
2. **Variable d'env `VAULT_PATH`** — auto-détection. Si `VAULT_PATH` correspond à un chemin enregistré dans `portRegistry`, ce vault devient le default. `setup-vault.mjs` écrit cette variable dans le `.env` de chaque vault qu'il bootstrap, donc lancer Claude Code dans le dossier d'un vault « ça marche tout seul » avec ce vault en default.
3. **`config.defaultVault`** — default global explicite dans `~/.claude/obsidian-mcp-router/config.json`.
4. **Premier vault local en bonne santé** — fallback historique.
5. **Premier vault actif quel que soit le type** — dernier recours.

Le router charge automatiquement le `.env` du cwd au démarrage, donc les étapes 1 et 2 fonctionnent sans outillage supplémentaire. Les variables d'env déjà présentes dans le process parent gagnent sur le `.env`.

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
   dans le `.env` du workspace. Le router la lit au boot. Permanent jusqu'à suppression.

Pour déverrouiller :
- `unlock_vaults()` — en mémoire uniquement
- `unlock_vaults({ persist: true })` — retire aussi `OBSIDIAN_ROUTER_LOCKED` du `<cwd>/.env`
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

**Liens de lecture éphémères (provider view-agent optionnel)** — poser `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (+ secret partagé optionnel `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN`, envoyé en `X-View-Token`) branche un *provider de view-links* sur le router. Chaque écriture de note porte alors un `viewLink` prêt à cliquer vers le **GUI Obsidian live du vault, navigué sur la note** (≥ 0.29.0, injection déterministe côté serveur), le tool `get_view_link` apparaît (≥ 0.28.0 — masqué de ListTools tant que l'URL n'est pas posée : zéro surface morte sans l'infra), et `open_in_obsidian` renvoie le lien pour les vaults distants en conteneur (≥ 0.30.0). Le router ne dépend que d'un petit contrat HTTP — `GET /view?vault=<nom>&note=<chemin>` → `{"url": "<lien prêt navigateur>"}` — d'aucune infrastructure particulière : voir l'**implémentation de référence + le contrat normatif** sur [obsidian-mcp-router-view-agent](https://github.com/tboome33/obsidian-mcp-router-view-agent) (config-driven, Python stdlib, quick tunnels cloudflared éphémères).

**Smart links (résolveur optionnel)** — poser `OBSIDIAN_ROUTER_SMART_LINK_URL` (URL de base du résolveur) **et** `OBSIDIAN_ROUTER_SMART_LINK_SECRET` (secret HMAC) fait émettre des **smart links signés et stables** à la place des view-links demandés à l'agent : les écritures de notes et `open_in_obsidian` sur vault distant portent alors `viewLink = <résolveur>/o/<token-signé>` avec `viewLinkKind: "smart"` — un calcul HMAC pur, **zéro appel réseau** (une écriture ne peut jamais être ralentie par un agent down), et le lien reste valable dans l'historique du chat (TTL du token : 30 jours). Le lien se résout **sur le device qui clique** (sonde du miroir Obsidian local → deep link `obsidian://` → GUI streamé en dernier recours). Priorité des providers quand les deux sont configurés : smart link → view-agent → rien ; `get_view_link` continue de parler directement au view-agent. Configurer les smart links signale un déploiement **remote** — ne posez pas `OBSIDIAN_ROUTER_SMART_LINK_*` sur un router purement local, sinon `open_in_obsidian` rendrait un lien (`opened:false`, `delivered:"link"`) au lieu de naviguer votre Obsidian local. L'implémentation de référence du résolveur + les contrats vivent dans le repo saas privé (`obsidian-mcp-router-saas`).

**Garde de transport au niveau déploiement** — poser `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK=true` (typiquement sur une instance MCPHub multi-tenant) fait **REFUSER le démarrage** du router si un vault servi a un `baseUrl` dont l'hôte n'est ni loopback (`127.0.0.1`/`::1`/`localhost`) ni dans le mesh WireGuard `10.8.0.0/24`. C'est un **check de config au boot sur les baseUrls configurés** — il n'exige *pas* que le tunnel WireGuard soit up, et le **loopback passe** (donc ce n'est pas « WireGuard-only »). Fail-closed — un vault ne peut jamais être servi silencieusement sur un lien exposé ; le check tourne après la whitelist `OBSIDIAN_ROUTER_ALLOWED_VAULTS`. Opt-in ; variable absente = aucun enforce (mode local inchangé). Remplace l'ancien flag `wireguard` par-vault. *(Renommé depuis `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` en v0.27.0 — ce nom laissait croire à tort que « WG doit être up » ; l'ancien nom marche encore comme alias déprécié.)*

### Config

Le router lit la config existante maintenue par [`scripts/setup-vault.mjs`](./scripts/setup-vault.mjs), et ajoute trois champs optionnels par-dessus :

```jsonc
{
  // --- écrits par setup-vault.mjs (ne pas éditer à la main) ---
  "referenceVault": "C:\\VAULTS\\.template",
  "portStart": 27124,
  "portRegistry": {
    "C:\\VAULTS\\.template": 27124,
    "C:\\VAULTS\\TradingView": 27125
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
| `pdf_to_markdown` · `docx_to_markdown` · `xlsx_to_markdown` · `pptx_to_markdown` · `image_to_markdown` · `audio_to_markdown` | Convertit un fichier local en markdown via le CLI Python `markitdown`. OCR image et transcription audio nécessitent les extras `[all]` (installés par défaut au postinstall). Retourne du texte markdown — chaîne avec `write_file` pour persister. |
| `pdf_to_markdown_docling` | Convertit un PDF local en markdown via le pipeline standard de **Docling** (détection de mise en page + reconnaissance de structure de tableau TableFormer). Plus haute fidélité que `pdf_to_markdown` sur les tableaux complexes / mises en page multi-colonnes, à ~10× le coût CPU. **Opt-in** — nécessite l'extra Docling (voir la section dépendances de conversion). PDF uniquement ; pour les formats bureautiques, garder `pdf_to_markdown`. |
| `youtube_to_markdown` · `bing_search_to_markdown` · `webpage_to_markdown` | Convertit une URL distante en markdown via `markitdown`. URL http(s) uniquement ; hôtes privés/loopback refusés (garde SSRF). Pour les SPA JS-lourdes, préfère le skill `defuddle` (navigateur headless). |
| `git_repo_to_markdown` | Bundle un dépôt git (arbre de fichiers + code source) en un seul document markdown via `repomix`. Accepte une URL complète ou le raccourci `owner/repo`. Passe `compress: true` pour ~70% de réduction via Tree-sitter. |
| `extract_page_metadata` | Extracteur déterministe de métadonnées de page (JSON-LD + OpenGraph + meta tags + titre) — alimente un frontmatter non-fabriqué pour l'ingestion. |
| `propose_linked_sources` | Suit les `<a href>` avec scoring heuristique pour proposer des candidats d'ingestion récursive (top-N, boosts même-domaine / section Related). |
| `download_page_assets` | Télécharge les images d'une page dans le vault (préservation des images lors de l'ingestion web). |
| `build_open_link` | Construit un lien markdown click-to-open prêt à coller (`http://127.0.0.1:<insecurePort>/open/<path>`) pour un ou plusieurs fichiers du vault. Read-only. |
| `open_in_obsidian` | Ouvre une note dans l'Obsidian en cours (et ramène sa fenêtre au premier plan) en appelant la route `/open` du bridge **côté serveur** — sans navigateur. Le pendant sans-navigateur d'un lien click-to-open, pour les clients (ex. Claude Desktop) qui sinon proxifient les clics de liens via un navigateur. `anchor` optionnel pour scroller à un titre. Navigation seule. |
| `get_wiki_context_pack` | Retourne une enveloppe de contexte JSON structurée pour une requête (primaryPages / semanticChunks / graphNeighbors / citations) afin que des agents non-Claude consomment le vault programmatiquement. |
| `build_wiki_graph` | Assemble le vault en un knowledge-graph JSON typé (schéma Understand-Anything : 21 types de nœuds / 35 d'arêtes). Écrit `wiki-meta/graph/knowledge-graph.json` + une copie dérivée `.understand-anything/`. |
| `build_wiki_tour` | Génère un parcours de lecture pédagogique déterministe et ordonné depuis la topologie de liens du knowledge-graph. Read-only. |

D'autres outils (flags CLI, hot reload de la config, skills) sont sur la roadmap — voir [ROADMAP.md](./ROADMAP.md).

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
