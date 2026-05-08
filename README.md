<p align="center">
  <img src="./docs/assets/logo.png" alt="obsidian-mcp-router — multi-vault MCP server" width="540">
</p>

<p align="center">
  <a href="https://github.com/tboome33/obsidian-mcp-router/actions/workflows/test.yml"><img src="https://github.com/tboome33/obsidian-mcp-router/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520.18.1-brightgreen.svg" alt="node"></a>
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.8.4-blueviolet.svg" alt="version"></a>
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
| Cross-vault | every tool accepts `vault: "*"` for fan-out |

Semantic search (`search_smart`) and Templater execution (`execute_template`) require the [`obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) plugin to be installed in each target vault — it registers the matching `/search/smart` and `/templates/execute` routes on Local REST API. Everything else works against the standard Local REST API endpoints alone.

## Slash commands & skills (Claude Code plugin)

The repo doubles as a **Claude Code plugin marketplace** that exposes **30 slash commands** under the `/obsidian-router:*` namespace. Type `/obsidian-router:` in Claude Code → the autocomplete shows everything. Every slash command also auto-triggers on natural-language phrasing (EN + FR) so you rarely have to remember the exact name — just describe what you want.

> 📄 **Quick reference PDF** (router overview + setup + config + every slash command with NL trigger phrases) — [English](./docs/quick-reference-en.pdf) · [Français](./docs/quick-reference-fr.pdf). 5 pages, accessible font sizes for printing or screen reference.

### 🔧 14 MCP wrappers — one per router tool

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

### 🩺 3 conversational helpers

| Command | Effect | Trigger phrasings |
|---|---|---|
| `/obsidian-router:meta-setup` | Bootstrap the router on a fresh machine (clone, npm link, register MCP) | *"install the router"*, *"bootstrap obsidian-mcp-router on this machine"* / *"installe le router"*, *"setup obsidian-mcp-router sur cette machine"* |
| `/obsidian-router:meta-add-vault` | Interactive flow to add a vault (local via `setup-vault.mjs`, or remote) | *"add a vault to the router"*, *"connect my remote vault"* / *"ajoute un vault au router"*, *"connecte mon vault distant"* |
| `/obsidian-router:meta-status` | Health-check every vault with per-issue fix hints | *"diagnose the router"*, *"are my vaults reachable"* / *"diagnostique le router"*, *"mes vaults sont-ils accessibles"* |

### 📚 10 knowledge-management commands (Karpathy-style LLM-wiki)

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

Plus one Obsidian-specific reference skill (no slash command — knowledge surfaced when other skills run): `obsidian-markdown` (Obsidian Flavored Markdown reference for wikilinks, embeds, callouts, properties, etc.). Note that `obsidian-bases` is BOTH a reference skill AND has its own slash command above — other skills consult it when they need to generate `.base` files, and you can also invoke it directly.

**Two parallel sub-agents** for batch work:
- `wiki-ingest` agent — fan out one source per agent, parallel
- `wiki-lint` agent — read-only diagnostic in a separate context

**Hooks** (cross-platform Node, opt-in via `~/.claude/settings.json`):
- `SessionStart` / `PostCompact` — load `wiki/hot.md` into context
- `PostToolUse` — auto-commit `wiki/`, `.raw/`, `.vault-meta/` to git after writes
- `Stop` — prompt to refresh `wiki/hot.md` if files changed

The hooks ship in [`hooks/`](./hooks/) — copy the entries you want into `~/.claude/settings.json`. Reference: [`hooks/hooks.json`](./hooks/hooks.json).

**🆕 Auto-enrichment (v0.8.2, Phase 1)** — Claude proactively suggests wiki saves at three natural moments: **validation** (you say "OK" / "valide" → inline pin), **result obtained** (commit pushed, tests green → digest of candidates), and **topic switch** (mandatory checkpoint before Claude responds to the new topic). Domain-agnostic: works for development, personal life, research, family planning, anything.

**Four modes** (`/obsidian-router:auto-mode <Mode>` to switch, `--persist` to write to `.env`):

| Mode | Behavior | Best for |
|---|---|---|
| `ClaudeAsk` (default) | Propose, always confirm | Discovering the feature · long mixed-importance sessions · vaults where false positives would hurt · the calibration period (1-2 weeks) before trusting auto-save |
| `Hybrid` | Auto-save type-safe items (facts, URLs, preferences); ask on high-stakes (decisions, ADRs, rules, techniques) | Power-user sweet spot after calibration · active dev with frequent URL ingestion · research where citations pile up but conclusions need vetting |
| `FullAuto` | Auto-save everything; audit log in `wiki/log.md` + sensitivity filter (never auto-save credentials/medical/financial) + hard cap (degrades to `ClaudeAsk` after 5 saves/session) | High-trust sessions · personal journal / family chronicle · long unsupervised flows (autoresearch, batch ingestion) · solo brain-dumps where the wiki IS the conversation log |
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
- A **reference vault** registered with the router. It holds the canonical plugin set + config that `setup-vault.mjs` clones into every new vault. One-time setup procedure: [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md).

## Install

> 📘 **Reference vault required for `setup-vault.mjs`** — to bootstrap new vaults via the script (which most users will want), you first need a one-time-configured reference vault holding the canonical plugin set. See [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) for the full procedure (which plugins, the `mcp-router-bridge` folder-vs-id naming gotcha, registration with `--init-reference`).

Two pieces to install: the **MCP server** (the router itself, exposes the 14 tools to Claude) and the **plugin** (exposes `/obsidian-router:*` slash commands).

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

**Then enable the plugin per-workspace**, NOT globally. The plugin loads ~30 slash commands and ~12 skills (~10k context tokens per session) — you only want that overhead on workspaces that actually use Obsidian. For each vault directory and each app workspace that consumes the router, drop a `.claude/settings.json` file at the workspace root:

```json
{
  "enabledPlugins": {
    "obsidian-router@obsidian-mcp-router-marketplace": true
  }
}
```

For vaults bootstrapped via `setup-vault.mjs`, this file is **cloned automatically** from `.template/.claude/settings.json` — you don't have to write it by hand. For non-vault workspaces (dev repos that work with vault content), copy the snippet above into `<workspace>/.claude/settings.json`.

Restart Claude Code. From a workspace with the plugin enabled, type `/obsidian-router:` — the 30 slash commands should appear. From a workspace without, the namespace stays clean.

> **Why not enable it globally?** If you put `enabledPlugins` in `~/.claude/settings.json` instead of per-workspace, the plugin loads in EVERY Claude Code session — random scripts, debug sessions, unrelated repos — paying ~10k tokens for commands those sessions will never use. Project-scope keeps the budget tight.

> **Bump the skill-listing budget (recommended).** The router contributes ~30 skills to Claude Code's skill listing. On a default install (`skillListingBudgetFraction: 0.01`, i.e. 1% of the context window), this often pushes the listing past the budget — descriptions are truncated, and natural-language triggering for `/save`, `/wiki`, `/autoresearch` etc. silently breaks. **Recommended**: raise to `0.05` in `~/.claude/settings.json` (~6k extra tokens per session). The diagnostic message *"Skill listing will be truncated — N descriptions dropped"* at session start is the symptom this fixes.
>
> ```json
> { "skillListingBudgetFraction": 0.05 }
> ```
>
> The bundled `meta-setup` skill detects an under-budgeted setup and offers to apply this change interactively.

You can also use the bundled `meta-setup` skill to walk through both steps interactively: just ask Claude *"set up the obsidian-mcp-router on this machine"*.

### CLI flags

```bash
obsidian-mcp-router --version
obsidian-mcp-router --help
obsidian-mcp-router --config /custom/path/config.json
obsidian-mcp-router --no-watch     # disable hot-reload of the config file
```

By default, the router watches the config file and reloads automatically when it changes — useful when paired with `setup-vault.mjs` adding new vaults, or with the future `Obsidian Cloudflare Tunnel` plugin auto-writing tunnel URLs into `remoteVaults`.

### Building your own macros on top (advanced)

The 30 plugin commands above are domain-agnostic on purpose — they work for any vault. If you want **macros** that chain multiple tools or bake in your vault's conventions (daily notes, capture inbox, weekly rollups, etc.), build them as your own slash commands in `~/.claude/commands/<name>.md` — not as PRs on this repo. The router stays neutral; the macros are yours.

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

More tools (CLI flags, hot config reload, skills) are on the roadmap — see [ROADMAP.md](./ROADMAP.md).

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
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.8.4-blueviolet.svg" alt="version"></a>
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
| Cross-vault | tous les outils acceptent `vault: "*"` pour fan-out |

La recherche sémantique (`search_smart`) et l'exécution Templater (`execute_template`) nécessitent que le plugin [`obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) soit installé dans chaque vault cible — il enregistre les routes correspondantes `/search/smart` et `/templates/execute` sur Local REST API. Tout le reste fonctionne contre les endpoints standards de Local REST API seuls.

### Slash commands & skills (plugin Claude Code)

Le repo est aussi un **marketplace de plugin Claude Code** qui expose **30 slash commands** sous le namespace `/obsidian-router:*`. Tape `/obsidian-router:` dans Claude Code → l'autocomplete montre tout. Chaque slash command s'auto-déclenche aussi sur du langage naturel (EN + FR), donc tu n'as quasiment jamais à retenir le nom exact — décris simplement ce que tu veux.

> 📄 **PDF de référence rapide** (vue d'ensemble du router + setup + config + chaque slash command avec phrases déclencheuses en langage naturel) — [Français](./docs/quick-reference-fr.pdf) · [English](./docs/quick-reference-en.pdf). 5 pages, fontes lisibles pour impression ou consultation écran.

#### 🔧 14 wrappers MCP — un par outil du router

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

#### 🩺 3 helpers conversationnels

| Commande | Effet | Phrases déclencheuses |
|---|---|---|
| `/obsidian-router:meta-setup` | Bootstrap du router sur une machine neuve (clone, npm link, registration MCP) | *"installe le router"*, *"setup obsidian-mcp-router sur cette machine"* / *"install the router"*, *"bootstrap obsidian-mcp-router on this machine"* |
| `/obsidian-router:meta-add-vault` | Flux interactif pour ajouter un vault (local via `setup-vault.mjs`, ou distant) | *"ajoute un vault au router"*, *"connecte mon vault distant"* / *"add a vault to the router"*, *"connect my remote vault"* |
| `/obsidian-router:meta-status` | Health-check de chaque vault avec hints de fix par catégorie d'erreur | *"diagnostique le router"*, *"mes vaults sont-ils accessibles"* / *"diagnose the router"*, *"are my vaults reachable"* |

#### 📚 10 commandes de gestion de connaissances (LLM-wiki façon Karpathy)

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

Plus un skill de référence Obsidian (sans slash command — surfacé quand d'autres skills tournent) : `obsidian-markdown` (référence du Obsidian Flavored Markdown : wikilinks, embeds, callouts, properties, etc.). Note : `obsidian-bases` est À LA FOIS un skill de référence ET a sa propre slash command (la ligne au-dessus) — d'autres skills le consultent quand ils ont besoin de générer des fichiers `.base`, et tu peux aussi l'invoquer directement.

**Deux sub-agents parallèles** pour les batches :
- agent `wiki-ingest` — fan-out un agent par source, en parallèle
- agent `wiki-lint` — diagnostic read-only dans un contexte isolé

**Hooks** (Node cross-platform, opt-in via `~/.claude/settings.json`) :
- `SessionStart` / `PostCompact` — chargent `wiki/hot.md` dans le contexte
- `PostToolUse` — auto-commit `wiki/`, `.raw/`, `.vault-meta/` sur git après les écritures
- `Stop` — propose de rafraîchir `wiki/hot.md` si des fichiers ont changé

Les hooks vivent dans [`hooks/`](./hooks/) — copie les entrées que tu veux dans `~/.claude/settings.json`. Référence : [`hooks/hooks.json`](./hooks/hooks.json).

**🆕 Auto-enrichissement (v0.8.2, Phase 1)** — Claude propose proactivement de saver dans le wiki à trois moments naturels : **validation** (tu dis "OK" / "valide" → pin inline), **résultat obtenu** (commit pushé, tests verts → digest de candidats), et **changement de sujet** (checkpoint obligatoire avant que Claude réponde au nouveau sujet). Agnostique du domaine : marche pour le dev, la vie perso, la recherche, la planification familiale, n'importe quoi.

**Quatre modes** (`/obsidian-router:auto-mode <Mode>` pour switcher, `--persist` pour écrire dans `.env`) :

| Mode | Comportement | Pour quel usage |
|---|---|---|
| `ClaudeAsk` (défaut) | Propose, confirme toujours | Découverte de la feature · sessions longues à importance mixte · vaults où les faux positifs coûtent cher à nettoyer · période de calibration (1-2 semaines) avant de faire confiance à l'auto-save |
| `Hybrid` | Auto-save les items type-safe (facts, URLs, préférences) ; ask sur les high-stakes (décisions, ADRs, règles, techniques) | Sweet spot power-user après calibration · dev actif avec ingestion d'URLs fréquente · recherche où les citations s'empilent mais les conclusions doivent être vettées |
| `FullAuto` | Auto-save tout ; audit log dans `wiki/log.md` + filtre de sensibilité (jamais d'auto-save sur credentials/médical/financier) + hard cap (dégrade en `ClaudeAsk` après 5 saves/session) | Sessions à haute confiance en Claude · journal perso / chronique familiale · flows longs non supervisés (autoresearch, ingestion en batch) · brain-dumps solo où le wiki EST le log de conversation |
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
- Un **vault de référence** enregistré auprès du router. Il contient le set canonique de plugins + config que `setup-vault.mjs` clone dans chaque nouveau vault. Procédure de setup unique : [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) (en anglais).

### Installation

> 📘 **Vault de référence requis pour `setup-vault.mjs`** — pour bootstrapper de nouveaux vaults via le script (ce que la plupart des utilisateurs voudront), il faut d'abord un vault de référence configuré une seule fois qui contient le set canonique de plugins. Voir [`docs/reference-vault-setup.md`](./docs/reference-vault-setup.md) (en anglais) pour la procédure complète (quels plugins, le piège de nommage `mcp-router-bridge` dossier-vs-id, enregistrement avec `--init-reference`).

Deux composants à installer : le **MCP server** (le router lui-même, expose les 14 outils à Claude) et le **plugin** (expose les slash commands `/obsidian-router:*`).

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

**Puis active le plugin par workspace**, PAS globalement. Le plugin charge ~30 slash commands et ~12 skills (~10k tokens de contexte par session) — tu ne veux ça que sur les workspaces qui font effectivement de l'Obsidian. Pour chaque dossier de vault et chaque workspace d'app qui consomme le router, ajoute un `.claude/settings.json` à la racine du workspace :

```json
{
  "enabledPlugins": {
    "obsidian-router@obsidian-mcp-router-marketplace": true
  }
}
```

Pour les vaults bootstrappés via `setup-vault.mjs`, ce fichier est **cloné automatiquement** depuis `.template/.claude/settings.json` — pas à écrire à la main. Pour les workspaces hors-vault (repos de code qui travaillent avec le contenu d'un vault), copie le snippet ci-dessus dans `<workspace>/.claude/settings.json`.

Redémarre Claude Code. Depuis un workspace où le plugin est activé, tape `/obsidian-router:` — les 30 slash commands doivent apparaître. Depuis un workspace sans, le namespace reste vide.

> **Pourquoi pas en global ?** Si tu mets `enabledPlugins` dans `~/.claude/settings.json` au lieu de per-workspace, le plugin se charge dans CHAQUE session Claude Code — scripts random, sessions de debug, repos sans rapport — payant ~10k tokens pour des commandes que ces sessions n'utiliseront jamais. Le project-scope garde le budget serré.

> **Augmenter le budget de la skill-listing (recommandé).** Le router ajoute ~30 skills à la liste exposée à Claude Code. Sur une instance par défaut (`skillListingBudgetFraction: 0.01`, soit 1% de la fenêtre de contexte), ça pousse souvent la liste au-delà du budget — les descriptions sont tronquées et le triggering en langage naturel pour `/save`, `/wiki`, `/autoresearch` etc. casse silencieusement. **Recommandé** : passer à `0.05` dans `~/.claude/settings.json` (~6k tokens supplémentaires par session). Le message *"Skill listing will be truncated — N descriptions dropped"* au démarrage de session est le symptôme que ce réglage corrige.
>
> ```json
> { "skillListingBudgetFraction": 0.05 }
> ```
>
> Le skill `meta-setup` détecte un budget sous-dimensionné et propose d'appliquer ce changement interactivement.

Tu peux aussi utiliser le skill `meta-setup` du plugin pour qu'il te guide à travers les deux étapes : demande à Claude *"setup le obsidian-mcp-router sur cette machine"*.

### Flags CLI

```bash
obsidian-mcp-router --version
obsidian-mcp-router --help
obsidian-mcp-router --config /chemin/perso/config.json
obsidian-mcp-router --no-watch     # désactive le hot-reload du fichier de config
```

Par défaut, le router surveille le fichier de config et le recharge automatiquement à chaque modification — utile quand `setup-vault.mjs` ajoute de nouveaux vaults, ou quand le futur plugin `Obsidian Cloudflare Tunnel` écrit automatiquement des URLs de tunnel dans `remoteVaults`.

### Construire tes propres macros par-dessus (avancé)

Les 30 commandes du plugin sont agnostiques du domaine. Si tu veux des **macros** qui enchaînent plusieurs outils ou intègrent les conventions de ton vault (daily notes, capture inbox, rollups hebdo…), construis-les séparément comme slash commands dans `~/.claude/commands/<name>.md` — pas en PR sur ce repo. Le routeur reste neutre, les macros restent à toi.

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
