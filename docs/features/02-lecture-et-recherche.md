# 2 · Lecture et recherche

Tout ce qui permet d'**explorer et de lire** le contenu des vaults sans rien modifier. C'est par là que commence chaque session : découvrir ce qui existe, retrouver une note, la lire.

## `list_vaults` — le point de départ de chaque session

**Le besoin.** Avant de lire ou d'écrire quoi que ce soit, il faut savoir quels vaults existent, lesquels sont joignables (Obsidian ouvert ? plugin REST actif ?), et lequel servira de défaut.

**Ce que ça fait.** Retourne le catalogue de tous les vaults configurés avec, pour chacun : état en ligne/hors ligne, latence, clé API manquante ou non, et un lien `obsidian://` prêt à cliquer pour ouvrir le vault. La réponse porte aussi les champs globaux `defaultVault` (le vault que résoudrait un appel sans `vault`), `lockedTo` (non-null si le router est verrouillé, voir [fiche 11](11-securite-et-isolation.md)) et `disabled` (les vaults masqués).

**Comment l'utiliser.**

> « liste mes vaults », « mes vaults sont-ils en ligne ? » — ou `/obsidian-router:discover-list-vaults`

**À savoir.** Si le vault par défaut est hors ligne, c'est généralement qu'Obsidian n'est pas lancé sur la machine cible, ou que le plugin Local REST API y est désactivé. `list_vaults` est le réflexe de diagnostic numéro un.

## `list_files` — explorer l'arborescence

**Le besoin.** Voir ce que contient un dossier du vault avant de décider quoi lire, ou vérifier où une note a été rangée.

**Ce que ça fait.** Liste les fichiers et sous-dossiers d'un répertoire du vault (ou de la racine si on omet le répertoire).

**Comment l'utiliser.**

> « liste les fichiers du dossier Sessions », « qu'est-ce qu'il y a dans wiki/Decisions ? » — ou `/obsidian-router:discover-list-files`

```jsonc
{ "vault": "tradingview", "directory": "Sessions" }
```

## `get_file` — lire une note en entier

**Le besoin.** Lire le contenu complet d'une note : le corps markdown, mais aussi son frontmatter et ses métadonnées.

**Ce que ça fait.** Retourne le fichier complet — markdown, frontmatter parsé, métadonnées — plus une URL click-to-open prête à coller (voir [fiche 10](10-liens-et-navigation.md)) pour ouvrir la note dans Obsidian d'un clic.

**Comment l'utiliser.**

> « montre-moi la note Sessions/2026-04-29 », « ouvre le fichier X » — ou `/obsidian-router:read-get`

```jsonc
{ "vault": "tradingview", "path": "Sessions/2026-04-29.md" }
```

## `search` — recherche plein texte

**Le besoin.** Retrouver une chaîne exacte — un ticker, un nom propre, un bout de commande — quel que soit le fichier où elle se trouve.

**Ce que ça fait.** Recherche par sous-chaîne dans tout le vault et retourne chaque occurrence avec son contexte environnant (longueur réglable). Accepte `vault: "*"` pour chercher dans **tous** les vaults en parallèle.

**Comment l'utiliser.**

> « trouve AL2SI dans mon vault », « grep "money management" dans tous mes vaults » — ou `/obsidian-router:read-search`

```jsonc
{ "vault": "tradingview", "query": "AL2SI", "contextLength": 80 }
{ "vault": "*", "query": "money management" }
```

**À savoir.** C'est une recherche **littérale** : elle trouve ce qui est écrit tel quel. Pour chercher par sens (« mes notes sur la gestion du risque » sans que ces mots exacts apparaissent), utilisez `search_smart` ci-dessous.

## `search_smart` — recherche sémantique

**Le besoin.** Retrouver des notes par leur **sens**, pas par leurs mots : *« mes règles de break-even et de stop suiveur »* doit remonter la bonne note même si elle parle de « sécurisation de position » sans jamais employer ces termes.

**Ce que ça fait.** Interroge les embeddings du plugin Smart Connections et retourne des extraits (chunks) classés par similarité cosinus, avec le fil d'Ariane de chaque extrait (fichier → section). On peut restreindre à certains dossiers (`folders`), en exclure (`excludeFolders`), limiter le nombre de résultats, et faire un fan-out sémantique cross-vault avec `vault: "*"`.

**Comment l'utiliser.**

> « trouve mes notes sur X », « recherche sémantique sur les stops suiveurs » — ou `/obsidian-router:read-search-smart`

```jsonc
{
  "vault": "tradingview",
  "query": "règles de break-even et de trailing stop",
  "folders": ["Formations", "Indicators"],
  "limit": 10
}
```

**À savoir.** Deux plugins requis dans le vault cible : **obsidian-mcp-router-bridge** (qui expose la route `/search/smart` sur Local REST API) et **Smart Connections** (le backend d'embeddings). Sans eux, l'outil explique ce qui manque. Réflexe utile : recherche littérale → `search` ; recherche par sens → `search_smart`.

## `get_frontmatter` — lire les métadonnées d'une note

**Le besoin.** Consulter le statut, les tags ou n'importe quelle propriété d'une note sans charger tout son contenu.

**Ce que ça fait.** Retourne le frontmatter complet — ou une seule clé si on la nomme — avec les **types préservés** : les nombres restent des nombres, les booléens des booléens, les listes des listes. Pas de conversion sauvage en chaînes de caractères.

**Comment l'utiliser.**

> « quel est le statut de la note X ? », « montre les méta de X » — ou `/obsidian-router:read-frontmatter`

**À savoir.** Pour *modifier* le frontmatter, voir `set_frontmatter` / `merge_frontmatter` dans la [fiche 3](03-ecriture-et-edition.md).
