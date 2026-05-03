# obsidian-mcp-router

> *🇬🇧 English version below — [🇫🇷 version française](#-version-française)*

> An MCP server that routes Claude tool calls to **multiple** Obsidian vaults — local or remote — over the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

Instead of registering one MCP per vault (one process, one port, one API key), this router exposes a single MCP that knows about every vault you've configured. Each tool takes a `vault` parameter (or uses your default), and the router fans out the HTTPS call to the right Obsidian instance.

## Why

If you keep more than one Obsidian vault — a personal wiki, a research vault, a vault on your NAS, a vault behind a Cloudflare Tunnel — you don't want to register a separate MCP server per vault and switch context every time. This router is one process that knows about all of them and routes each tool call to the right one based on a `vault` parameter.

What you get:

- **One MCP entry** in `~/.claude.json` (user scope) → all vaults visible from any Claude Desktop/Code session.
- **Local + remote vaults**, treated identically. Add a vault running on your QNAP, your iPad over Tailscale, or a headless VPS by dropping its URL + API key into the config.
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

The repo doubles as a **Claude Code plugin marketplace** that exposes 17 slash commands under the `/obsidian-router:*` namespace:

**14 wrappers**, one per MCP tool, organised in 5 categories:

| Category | Commands |
|---|---|
| `discover` | `/obsidian-router:discover-list-vaults`, `/obsidian-router:discover-list-files` |
| `read` | `/obsidian-router:read-get`, `:read-search`, `:read-search-smart`, `:read-frontmatter` |
| `write` | `/obsidian-router:write-create-or-replace`, `:write-append`, `:write-patch`, `:write-frontmatter-set`, `:write-frontmatter-merge` |
| `manage` | `/obsidian-router:manage-move`, `/obsidian-router:manage-delete` (with confirm guard) |
| `template` | `/obsidian-router:template-execute` |

**3 conversational helpers** for setup and diagnostics (auto-trigger on natural language too):

- `/obsidian-router:meta-setup` — bootstrap the router on a fresh machine
- `/obsidian-router:meta-add-vault` — interactive flow to add a vault (local or remote)
- `/obsidian-router:meta-status` — health-check of every configured vault with fix hints

Type `/obsidian-router:` in Claude Code → the autocomplete shows everything grouped by category. Install steps are in the [Install](#install) section below.

## Prerequisites

| Plugin (per vault) | Required for | Where to get it |
|---|---|---|
| **Local REST API** | All tools | Community plugins → "Local REST API" by Adam Coddington |
| **MCP Router Bridge** | `search_smart`, `execute_template` | Install from [`tboome33/obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) — registers the `/search/smart` and `/templates/execute` REST routes that this router calls. |
| **Smart Connections** | `search_smart` | Community plugins → "Smart Connections" — the embeddings backend |
| **Templater** | `execute_template` | Community plugins → "Templater" by SilentVoid13 |

You also need:

- **Node.js ≥ 18**
- At least one vault provisioned in `~/.claude/obsidian-mcp-router/config.json`. If you've never set this up, run `npm run setup-vault -- "<vault-path>"` from a clone of this repo, or invoke [`scripts/setup-vault.mjs`](./scripts/setup-vault.mjs) directly — it'll bootstrap the config interactively. Schema reference: [`examples/config.example.json`](./examples/config.example.json).

## Install

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

Add the marketplace + enable the plugin in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "obsidian-mcp-router-marketplace": {
      "source": {
        "source": "github",
        "repo": "tboome33/obsidian-mcp-router"
      }
    }
  },
  "enabledPlugins": {
    "obsidian-router@obsidian-mcp-router-marketplace": true
  }
}
```

Restart Claude Code. Type `/obsidian-router:` — the 17 slash commands should appear in autocomplete.

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

The 17 plugin commands above are domain-agnostic on purpose — they work for any vault. If you want **macros** that chain multiple tools or bake in your vault's conventions (daily notes, capture inbox, weekly rollups, etc.), build them as your own slash commands in `~/.claude/commands/<name>.md` — not as PRs on this repo. The router stays neutral; the macros are yours.

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

> Serveur MCP qui aiguille les appels d'outils Claude vers **plusieurs** vaults Obsidian — locaux ou distants — via le plugin [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api).

Au lieu d'enregistrer un MCP par vault (un process, un port, une clé API), ce router expose un **seul** MCP qui connaît tous les vaults que tu as configurés. Chaque outil prend un paramètre `vault` (ou utilise ton vault par défaut), et le router fait suivre l'appel HTTPS vers la bonne instance Obsidian.

### Pourquoi

Si tu maintiens plusieurs vaults Obsidian — un wiki perso, un vault de recherche, un vault sur ton NAS, un vault derrière un Cloudflare Tunnel — tu ne veux pas enregistrer un serveur MCP par vault et changer de contexte à chaque fois. Ce router est **un seul** process qui les connaît tous et route chaque appel d'outil vers le bon en fonction d'un paramètre `vault`.

Ce que tu obtiens :

- **Une seule entrée MCP** dans `~/.claude.json` (user scope) → tous les vaults sont visibles depuis n'importe quelle session Claude Desktop ou Code.
- **Vaults locaux et distants traités à l'identique**. Tu ajoutes un vault qui tourne sur ton QNAP, ton iPad via Tailscale, ou un VPS headless en posant simplement son URL + sa clé API dans le config.
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

Le repo est aussi un **marketplace de plugin Claude Code** qui expose 17 slash commands sous le namespace `/obsidian-router:*` :

**14 wrappers**, un par outil MCP, organisés en 5 catégories :

| Catégorie | Commandes |
|---|---|
| `discover` | `/obsidian-router:discover-list-vaults`, `:discover-list-files` |
| `read` | `/obsidian-router:read-get`, `:read-search`, `:read-search-smart`, `:read-frontmatter` |
| `write` | `/obsidian-router:write-create-or-replace`, `:write-append`, `:write-patch`, `:write-frontmatter-set`, `:write-frontmatter-merge` |
| `manage` | `/obsidian-router:manage-move`, `:manage-delete` (avec garde confirm) |
| `template` | `/obsidian-router:template-execute` |

**3 helpers conversationnels** pour le setup et le diagnostic (auto-déclenchés par langage naturel aussi) :

- `/obsidian-router:meta-setup` — bootstrap du router sur une machine neuve
- `/obsidian-router:meta-add-vault` — flux interactif pour ajouter un vault (local ou distant)
- `/obsidian-router:meta-status` — health-check de tous les vaults avec hints de fix

Tape `/obsidian-router:` dans Claude Code → l'autocomplete montre tout par catégorie. Étapes d'install dans la section [Installation](#installation) ci-dessous.

### Prérequis

| Plugin (par vault) | Requis pour | Où l'obtenir |
|---|---|---|
| **Local REST API** | Tous les outils | Community plugins → "Local REST API" par Adam Coddington |
| **MCP Router Bridge** | `search_smart`, `execute_template` | À installer depuis [`tboome33/obsidian-mcp-router-bridge`](https://github.com/tboome33/obsidian-mcp-router-bridge) — enregistre les routes REST `/search/smart` et `/templates/execute` que ce router appelle. |
| **Smart Connections** | `search_smart` | Community plugins → "Smart Connections" — moteur d'embeddings |
| **Templater** | `execute_template` | Community plugins → "Templater" par SilentVoid13 |

Il te faut aussi :

- **Node.js ≥ 18**
- Au moins un vault provisionné dans `~/.claude/obsidian-mcp-router/config.json`. Si tu n'as jamais fait ce setup, lance `npm run setup-vault -- "<vault-path>"` depuis un clone de ce repo, ou invoque [`scripts/setup-vault.mjs`](./scripts/setup-vault.mjs) directement — il bootstrappe la config interactivement. Référence du schéma : [`examples/config.example.json`](./examples/config.example.json).

### Installation

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

Ajoute le marketplace + active le plugin dans `~/.claude/settings.json` :

```json
{
  "extraKnownMarketplaces": {
    "obsidian-mcp-router-marketplace": {
      "source": {
        "source": "github",
        "repo": "tboome33/obsidian-mcp-router"
      }
    }
  },
  "enabledPlugins": {
    "obsidian-router@obsidian-mcp-router-marketplace": true
  }
}
```

Redémarre Claude Code. Tape `/obsidian-router:` — les 17 slash commands doivent apparaître dans l'autocomplete.

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

Les 17 commandes du plugin sont agnostiques du domaine. Si tu veux des **macros** qui enchaînent plusieurs outils ou intègrent les conventions de ton vault (daily notes, capture inbox, rollups hebdo…), construis-les séparément comme slash commands dans `~/.claude/commands/<name>.md` — pas en PR sur ce repo. Le routeur reste neutre, les macros restent à toi.

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
