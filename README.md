# obsidian-mcp-router

> *🇬🇧 English version below — [🇫🇷 version française](#-version-française)*

> An MCP server that routes Claude tool calls to **multiple** Obsidian vaults — local or remote — over the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

Instead of registering one MCP per vault (one process, one port, one API key), this router exposes a single MCP that knows about every vault you've configured. Each tool takes a `vault` parameter (or uses your default), and the router fans out the HTTPS call to the right Obsidian instance.

## Why

The default Obsidian MCP setup ([jacksteamdev/mcp-tools](https://github.com/jacksteamdev/mcp-tools)) binds one MCP server process to one vault via env vars (`VAULT_PATH`, `OBSIDIAN_API_KEY`, `OBSIDIAN_BASE_URL`). If you have multiple vaults, you need multiple MCP entries — one per scope/project — and you can only ever reach one vault at a time per Claude session.

This router replaces that with:

- **One MCP entry** in `~/.claude.json` (user scope) → all vaults visible from any Claude Desktop/Code session.
- **Local + remote vaults**, treated identically. Want to query an Obsidian vault running on your QNAP, your iPad over Tailscale, or a headless VPS? Just add the URL + API key to the config.
- **Cross-vault search**: pass `vault: "*"` to the `search` tool to fan-out across every vault in parallel.

## How it differs from `mcp-tools`

| | jacksteamdev/mcp-tools | obsidian-mcp-router |
|---|---|---|
| Vaults per MCP process | 1 | N |
| Setup per vault | new MCP entry per scope | 1 line in config.json |
| Remote vaults | requires per-vault MCP + env tweaks | first-class citizen |
| Semantic search (Smart Connections) | yes (native binary) | yes (via the same `mcp-tools` API extension, no binary dependency) |
| Templater execution | yes | yes (`execute_template` tool) |
| File writes (create / append / patch / delete) | yes | yes |
| Cross-vault operations | no | yes (`search` with `vault: "*"`) |

The router talks to the same Local REST API endpoints that `mcp-tools` does — including the `mcp-tools` API extension's own routes (`/search/smart`, `/templates/execute`). So semantic search and Templater execution work natively without keeping the `mcp-tools` MCP registered alongside.

## Companion skills

The repo ships three skills under [`skills/`](./skills/) that you can install into `~/.claude/skills/` (copy or symlink) to get conversational helpers:

- **`obsidian-router-setup`** — bootstrap the router on a fresh machine (clone, npm link, register in `~/.claude.json`).
- **`obsidian-router-add-vault`** — interactive flow to add a new vault (local via `setup-vault.mjs`, or remote with name + baseUrl + apiKey).
- **`obsidian-router-status`** — diagnostic of all configured vaults with per-issue fix hints.

Once installed, you can trigger them by saying things like *"check the status of my vaults"* or *"add my QNAP vault to the router"*.

## Prerequisites

| Plugin (per vault) | Required for | Where to get it |
|---|---|---|
| **Local REST API** | All tools | Community plugins → "Local REST API" by Adam Coddington |
| **MCP Tools** | `search_smart`, `execute_template` | Community plugins → "MCP Tools" by Jack Steam — provides the API extension routes the router calls |
| **Smart Connections** | `search_smart` | Community plugins → "Smart Connections" — the embeddings backend |
| **Templater** | `execute_template` | Community plugins → "Templater" by SilentVoid13 |

You also need:

- **Node.js ≥ 18**
- At least one vault provisioned in `~/.claude/mcp-obsidian/config.json`. If you've never set this up, install [`setup-vault.mjs`](https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/setup-vault.md) (referenced from the router but lives in your local Claude home) or paste the schema by hand — see [`examples/config.example.json`](./examples/config.example.json).

## Install

```bash
git clone https://github.com/tboome33/obsidian-mcp-router.git
cd obsidian-mcp-router
npm install
npm link    # makes the `obsidian-mcp-router` binary available globally
```

Then register it in `~/.claude.json` (user scope):

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "stdio",
      "command": "obsidian-mcp-router"
    }
  }
}
```

That's it. The router reads `~/.claude/mcp-obsidian/config.json` on start (the same file that `setup-vault.mjs` already maintains) and exposes every vault automatically.

### CLI flags

```bash
obsidian-mcp-router --version
obsidian-mcp-router --help
obsidian-mcp-router --config /custom/path/config.json
obsidian-mcp-router --no-watch     # disable hot-reload of the config file
```

By default, the router watches the config file and reloads automatically when it changes — useful when paired with `setup-vault.mjs` adding new vaults, or with the future `Obsidian Cloudflare Tunnel` plugin auto-writing tunnel URLs into `remoteVaults`.

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

The router reads the existing config maintained by [`setup-vault.mjs`](https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/setup-vault.md), and adds three optional fields on top:

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
| `search_smart` | Semantic (meaning-based) search via Smart Connections embeddings. Returns ranked chunks with cosine scores and breadcrumbs. Requires `mcp-tools` + `smart-connections` plugins enabled in the target vault. Supports `vault: "*"` for cross-vault semantic search. |
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

Le setup MCP Obsidian par défaut ([jacksteamdev/mcp-tools](https://github.com/jacksteamdev/mcp-tools)) verrouille un process MCP sur un vault unique via des variables d'environnement (`VAULT_PATH`, `OBSIDIAN_API_KEY`, `OBSIDIAN_BASE_URL`). Avec plusieurs vaults, il te faut plusieurs entrées MCP — une par scope/projet — et tu ne peux toucher qu'**un seul** vault à la fois par session Claude.

Ce router remplace tout ça par :

- **Une seule entrée MCP** dans `~/.claude.json` (user scope) → tous les vaults sont visibles depuis n'importe quelle session Claude Desktop ou Code.
- **Vaults locaux et distants traités à l'identique**. Tu veux interroger un vault Obsidian qui tourne sur ton QNAP, ton iPad via Tailscale, ou un VPS headless ? Tu ajoutes simplement l'URL + la clé API dans le config.
- **Recherche cross-vault** : passe `vault: "*"` à l'outil `search` pour lancer la recherche sur tous les vaults en parallèle.

### Différences avec `mcp-tools`

| | jacksteamdev/mcp-tools | obsidian-mcp-router |
|---|---|---|
| Vaults par process MCP | 1 | N |
| Ajout d'un nouveau vault | nouvelle entrée MCP par scope | 1 ligne dans `config.json` |
| Vaults distants | nécessite un MCP dédié + tweaks env | natif |
| Recherche sémantique (Smart Connections) | oui (binaire natif) | oui (via la même extension API `mcp-tools`, sans dépendance au binaire) |
| Exécution de Templater | oui | oui (outil `execute_template`) |
| Écritures (create / append / patch / delete) | oui | oui |
| Opérations cross-vault | non | oui (`search` avec `vault: "*"`) |

Le router parle aux mêmes endpoints du Local REST API que `mcp-tools` — y compris les routes ajoutées par l'extension API du plugin `mcp-tools` (`/search/smart`, `/templates/execute`). La recherche sémantique et l'exécution Templater fonctionnent donc nativement sans avoir à conserver le MCP `mcp-tools` enregistré en parallèle.

### Skills compagnons

Le repo livre trois skills dans [`skills/`](./skills/) que tu peux installer dans `~/.claude/skills/` (copy ou symlink) pour avoir des helpers conversationnels :

- **`obsidian-router-setup`** — bootstrap du router sur une machine neuve (clone, npm link, enregistrement dans `~/.claude.json`).
- **`obsidian-router-add-vault`** — flux interactif pour ajouter un vault (local via `setup-vault.mjs`, ou distant avec name + baseUrl + apiKey).
- **`obsidian-router-status`** — diagnostic de tous les vaults configurés avec hints de fix par type d'erreur.

Une fois installés, tu déclenches en disant des choses comme *"vérifie le statut de mes vaults"* ou *"ajoute mon vault QNAP au router"*.

### Prérequis

| Plugin (par vault) | Requis pour | Où l'obtenir |
|---|---|---|
| **Local REST API** | Tous les outils | Community plugins → "Local REST API" par Adam Coddington |
| **MCP Tools** | `search_smart`, `execute_template` | Community plugins → "MCP Tools" par Jack Steam — fournit les extensions API que le router appelle |
| **Smart Connections** | `search_smart` | Community plugins → "Smart Connections" — moteur d'embeddings |
| **Templater** | `execute_template` | Community plugins → "Templater" par SilentVoid13 |

Il te faut aussi :

- **Node.js ≥ 18**
- Au moins un vault provisionné dans `~/.claude/mcp-obsidian/config.json`. Si tu n'as jamais fait ce setup, installe [`setup-vault.mjs`](https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/setup-vault.md) (référencé par le router mais vit dans ton home Claude local) ou colle le schéma à la main — voir [`examples/config.example.json`](./examples/config.example.json).

### Installation

```bash
git clone https://github.com/tboome33/obsidian-mcp-router.git
cd obsidian-mcp-router
npm install
npm link    # rend le binaire `obsidian-mcp-router` accessible globalement
```

Puis enregistre-le dans `~/.claude.json` (user scope) :

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "stdio",
      "command": "obsidian-mcp-router"
    }
  }
}
```

C'est tout. Le router lit `~/.claude/mcp-obsidian/config.json` au démarrage (le même fichier déjà maintenu par `setup-vault.mjs`) et expose tous les vaults automatiquement.

### Flags CLI

```bash
obsidian-mcp-router --version
obsidian-mcp-router --help
obsidian-mcp-router --config /chemin/perso/config.json
obsidian-mcp-router --no-watch     # désactive le hot-reload du fichier de config
```

Par défaut, le router surveille le fichier de config et le recharge automatiquement à chaque modification — utile quand `setup-vault.mjs` ajoute de nouveaux vaults, ou quand le futur plugin `Obsidian Cloudflare Tunnel` écrit automatiquement des URLs de tunnel dans `remoteVaults`.

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

Le router lit la config existante maintenue par [`setup-vault.mjs`](https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/setup-vault.md), et ajoute trois champs optionnels par-dessus :

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
| `search_smart` | Recherche sémantique (par sens) via les embeddings de Smart Connections. Retourne les chunks classés avec scores cosinus et breadcrumbs (chemin de titres). Nécessite les plugins `mcp-tools` + `smart-connections` activés dans le vault cible. Supporte `vault: "*"` pour la recherche sémantique cross-vaults. |
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
