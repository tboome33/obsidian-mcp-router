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

The router covers the **REST API surface only**. If you need semantic search or Templater execution, keep `mcp-tools` registered alongside for those use cases — both can coexist.

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

See [`examples/config.example.json`](./examples/config.example.json) for a complete example with comments, and [`docs/remote-vaults.md`](./docs/remote-vaults.md) for the full guide on adding remote vaults.

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

More tools (`move_file`, frontmatter helpers, file watchers) are on the roadmap — see [ROADMAP.md](./ROADMAP.md).

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

Le router couvre **uniquement la surface REST API**. Si tu as besoin de la recherche sémantique ou de l'exécution Templater, garde `mcp-tools` enregistré en parallèle pour ces cas — les deux peuvent coexister.

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

Voir [`examples/config.example.json`](./examples/config.example.json) pour un exemple complet commenté, et [`docs/remote-vaults.md`](./docs/remote-vaults.md) pour le guide complet d'ajout d'un vault distant.

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

D'autres outils (`move_file`, helpers frontmatter, file watchers) sont sur la roadmap — voir [ROADMAP.md](./ROADMAP.md).

### TLS

Le plugin Local REST API génère un certificat auto-signé par défaut. Pour les vaults localhost, mets `tlsInsecure: true` (c'est le défaut pour les vaults chargés depuis `portRegistry`). Pour les vaults distants derrière un vrai certificat TLS (par exemple un reverse proxy avec Let's Encrypt), mets `tlsInsecure: false`.

### Licence

Apache 2.0 — voir [LICENSE](./LICENSE) et [NOTICE](./NOTICE). Aucune restriction d'usage.
