# 1 · Routage multi-vault

C'est la raison d'être du projet : au lieu d'enregistrer un serveur MCP par vault Obsidian (un process, un port, une clé API à chaque fois), vous enregistrez **un seul** serveur qui connaît tous vos vaults et route chaque appel vers le bon.

## Un seul serveur MCP pour tous les vaults

**Le besoin.** Dès qu'on a plus d'un vault Obsidian — un pour le trading, un pour la famille, un pour un projet de dev, un distant sur un serveur — la configuration « un MCP par vault » devient ingérable : il faut dupliquer l'entrée dans `~/.claude.json` pour chaque vault, retenir quel port correspond à quoi, et changer de contexte sans arrêt.

**Ce que ça fait.** Le router est un process unique, enregistré une fois en user scope, qui lit `~/.claude/obsidian-mcp-router/config.json` au démarrage et expose automatiquement tous les vaults qui y figurent. Chaque outil accepte un paramètre `vault` ; le router transmet l'appel HTTPS au plugin Local REST API de la bonne instance Obsidian. Locaux ou distants, tous les vaults sont traités de la même façon.

**Comment l'utiliser.** Une fois installé (voir [fiche 13](13-installation-et-administration.md)), il n'y a rien à faire : parlez d'un vault par son nom (*« cherche X dans le vault tradingview »*) ou laissez le vault par défaut faire le travail. Pour vérifier ce que le router voit :

> « liste mes vaults » — ou `/obsidian-router:discover-list-vaults`

**À savoir.** Chaque vault cible doit avoir le plugin **Local REST API** installé et activé. C'est le seul prérequis universel ; les autres plugins (bridge, Smart Connections, Templater) ne servent qu'à des features précises, indiquées fiche par fiche.

## Le paramètre `vault` et le fan-out cross-vault (`vault: "*"`)

**Le besoin.** Parfois on sait exactement dans quel vault chercher ; parfois on veut demander « où ai-je noté ça ? » sans se souvenir du vault.

**Ce que ça fait.** Tout outil accepte `vault: "<nom>"` pour cibler un vault précis, ou omet le paramètre pour utiliser le vault par défaut. Les outils de recherche (`search`, `search_smart`) acceptent en plus `vault: "*"` : le router interroge alors **tous** les vaults en parallèle et agrège les résultats.

**Comment l'utiliser.**

> « cherche "money management" dans tous mes vaults »

```jsonc
// search — fan-out sur tous les vaults :
{ "vault": "*", "query": "money management" }

// search_smart — fan-out sémantique :
{ "vault": "*", "query": "qu'est-ce que j'ai appris cette semaine ?" }
```

**À savoir.** Le fan-out est refusé quand le router est verrouillé sur un vault (voir [lock mode, fiche 11](11-securite-et-isolation.md)).

## Résolution du vault par défaut

**Le besoin.** Quand un appel omet `vault`, le router doit en choisir un — et le bon choix dépend du contexte : le même *« cherche mes notes sur X »* doit viser le vault trading quand vous travaillez sur le projet trading, et le vault recherche quand vous êtes dans un repo de recherche.

**Ce que ça fait.** Le router résout le défaut par une cascade, priorité décroissante :

1. **`OBSIDIAN_ROUTER_DEFAULT_VAULT`** (variable d'env) — override explicite par projet. Placez-la dans le `.env` du workspace.
2. **`VAULT_PATH`** (variable d'env) — auto-détection. Si le chemin correspond à un vault du `portRegistry`, ce vault devient le défaut. `setup-vault.mjs` écrit cette variable dans le `.env` de chaque vault bootstrappé, donc ouvrir Claude Code **dans** un dossier de vault « marche tout seul ».
3. **`config.defaultVault`** — le défaut global de `config.json`.
4. Premier vault local joignable, puis premier vault actif — les filets historiques.

Le router charge automatiquement le `.env` du répertoire courant au démarrage : aucun outillage supplémentaire n'est nécessaire.

**Comment l'utiliser.** Trois cas concrets :

- **Votre projet EST un vault** — rien à faire : le `.env` écrit au bootstrap contient `VAULT_PATH`, l'auto-détection fait le reste.
- **Votre projet n'est pas un vault mais travaille avec un** — ajoutez une ligne au `.env` du projet :
  ```
  OBSIDIAN_ROUTER_DEFAULT_VAULT=recherche
  ```
- **Votre projet est un vault mais vous voulez un autre défaut** — la même ligne dans le `.env` du vault : le niveau 1 gagne sur l'auto-détection.

Pour vérifier ce que le router a choisi : *« liste mes vaults »* — la réponse contient un champ `defaultVault`.

**À savoir.** Si `OBSIDIAN_ROUTER_DEFAULT_VAULT` pointe un nom inconnu (typo, vault désactivé), le router ne plante pas : il retombe sur les niveaux suivants et émet un avertissement clair sur stderr listant les vaults actifs.

## Vaults distants

**Le besoin.** Un vault qui tourne sur un NAS, un serveur dédié ou derrière un tunnel doit être aussi simple à utiliser qu'un vault local.

**Ce que ça fait.** La section `remoteVaults` de `config.json` déclare un vault par son URL et sa clé API — le router ne fait aucune différence de traitement ensuite :

```jsonc
"remoteVaults": [
  { "name": "qnap", "baseUrl": "https://192.168.0.11:27125", "apiKey": "...", "tlsInsecure": true }
]
```

`tlsInsecure: true` accepte un certificat auto-signé (typique du plugin Local REST API) ; `extraHeaders` permet de passer des en-têtes supplémentaires, par exemple des service tokens Cloudflare Access.

**Comment l'utiliser.** Guide complet : [`docs/remote-vaults.md`](../remote-vaults.md). Pour exposer un vault via un tunnel Cloudflare (avec authentification optionnelle) : [`docs/cloudflare-tunnel.md`](../cloudflare-tunnel.md). Pour générer une configuration de déploiement serveur complète (container + nginx + ligne `VAULT_*`) : voir `gen-obsidian-deploy` dans la [fiche 13](13-installation-et-administration.md).

## Définir un vault par variable d'environnement (`VAULT_<NAME>`)

**Le besoin.** Sur un déploiement type MCPHub, on veut pouvoir ajouter ou modifier un vault depuis le dashboard du serveur — sans SSH ni édition de fichier.

**Ce que ça fait.** Une variable `VAULT_<NAME>` contenant la config du vault en JSON constitue une **troisième source de configuration**, fusionnée après `portRegistry` et `remoteVaults` (elle écrase un vault du même nom). Champs requis : `name`, `baseUrl`, `apiKey` (le token nu — le router ajoute lui-même `Authorization: Bearer`). Optionnels : `description`, `tlsInsecure`, `timeoutMs`.

```bash
VAULT_NOTES={"name":"notes","baseUrl":"http://192.168.0.10:27124","apiKey":"<token>"}
```

**À savoir.** Le parsing est défensif : une entrée malformée est ignorée avec un avertissement qui nomme la variable fautive **sans jamais logger la valeur** (elle peut contenir la clé API). Une variable cassée ne fait jamais tomber les autres. C'est opt-in : sans `VAULT_*`, rien ne change.

## Désactiver un vault temporairement

**Le besoin.** Masquer un vault (expérimental, en maintenance, archivé) sans perdre sa configuration.

**Ce que ça fait.** Deux mécanismes :

```jsonc
// Blacklist globale, par nom (vaults locaux ET distants) :
"disabledVaults": ["template", "experimental-vps"],

// Ou flag par vault distant :
"remoteVaults": [ { "name": "qnap", "...": "...", "enabled": false } ]
```

Les vaults désactivés n'apparaissent plus dans `list_vaults` et ne sont plus pingés, mais restent visibles dans le log de démarrage (`N disabled: ...`) pour ne pas être oubliés.

## Rechargement à chaud de la configuration

**Le besoin.** Ajouter un vault (via `setup-vault.mjs` ou à la main) sans devoir redémarrer le router ni relancer sa session Claude.

**Ce que ça fait.** Par défaut, le router surveille `config.json` et se recharge automatiquement quand le fichier change. Le nouveau vault est visible au prochain `list_vaults`.

**Comment l'utiliser.** Rien à faire — c'est le comportement par défaut. Pour le désactiver : lancer le binaire avec `--no-watch`.

## Flags CLI

Le binaire accepte quelques flags utiles au diagnostic et aux configurations non standard :

```bash
obsidian-mcp-router --version
obsidian-mcp-router --help
obsidian-mcp-router --config /chemin/custom/config.json
obsidian-mcp-router --no-watch     # désactive le hot-reload de la config
```
