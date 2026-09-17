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

### Validité temporelle — ne garder que ce qui s'applique

**Le besoin.** Certaines pages ne disent vrai que pendant une période : un tarif 2026, une procédure valable jusqu'à une migration, une règle qui n'entre en vigueur qu'au mois prochain. Une page peut le déclarer dans son frontmatter avec `valid_from` et `valid_through` (bornes **incluses**, voir [Dater une connaissance](07-wiki-gestion-de-connaissances.md#dater-une-connaissance--valid_from-et-valid_through) en fiche 07). `search_smart` sait alors dire de chaque résultat où il en est — et, si on le lui demande, ne rendre que ce qui s'applique.

**Deux paramètres, tous deux facultatifs.**

| paramètre | à quoi ça sert |
|---|---|
| `asOf` | le **jour de référence**, en `YYYY-MM-DD`. Par défaut, aujourd'hui en UTC. Résolu **une seule fois** pour tout l'appel, de sorte que deux résultats de la même réponse ne sont jamais classés sur deux jours différents. Une valeur illisible fait échouer l'appel plutôt que de le faire retomber en silence sur aujourd'hui. |
| `validityStates` | la **liste des états à garder**, parmi `in-force`, `not-yet-in-force`, `no-longer-in-force`, `unreadable`. Omis — ou liste vide, qui veut dire la même chose — rien n'est filtré : chaque résultat est simplement annoté. |

```jsonc
{
  "vault": "tradingview",
  "query": "règles de break-even",
  "validityStates": ["in-force"],
  "asOf": "2026-12-31"
}
```

**Trois sortes de résultat ne sont JAMAIS écartées**, même quand on demande `["in-force"]` :

| le résultat… | pourquoi il reste |
|---|---|
| ne déclare **aucune** fenêtre | une page qui ne dit rien sur sa durée ne prétend pas être périmée. Le silence n'est pas une date, et l'immense majorité des pages d'un vault sont dans ce cas. |
| déclare une fenêtre **illisible** (`unreadable`) | « je n'ai pas su lire cette borne » n'est pas « cette borne est dépassée ». Écarter sur un doute reviendrait à cacher une page à cause d'une faute de frappe. |
| n'a **pas pu être lu** (`validityUnverified`) | la page était hors budget, injoignable, ou son chemin n'a pas résolu. On ne sait pas, donc on ne retire pas. |

Autrement dit, le filtre ne retire que ce qu'il a **vraiment lu** et dont l'état est **certain** — et cet état ne fait pas partie de la liste demandée. C'est la règle de fond de toute la fonctionnalité : **aucune page n'est cachée par défaut**, et la seule façon d'en écarter une est de le demander explicitement.

**Ce que la réponse ajoute.** Deux blocs, jamais l'un sans l'autre quand le filtre est demandé :

```jsonc
"validitySummary": {
  "asOf": "2026-09-15",        // le jour retenu, une fois pour tout l'appel
  "annotatedEntries": 5,        // combien de résultats RENDUS portent une fenêtre
  "inspectedPages": 12,         // pages réellement lues pour établir ces fenêtres
  "unverifiedPages": 0,         // pages connues mais non établies (budget, lecture)
  "budgetExhausted": false,     // le plafond de lectures a-t-il été atteint
  "revisionCoherence": "not-verified"
},
"validityFilter": {
  "states": ["in-force"],
  "excludedHits": 20,           // écartés par le FILTRE
  "cutByLimit": 0,              // admissibles, mais coupés par `limit`
  "moreCandidates": "unknown"   // reste-t-il des candidats non examinés ?
}
```

`excludedHits` et `cutByLimit` sont nommés séparément exprès : une page courte a deux causes possibles, et le lecteur a besoin de savoir laquelle.

`moreCandidates` répond à une question d'existence, pas à un décompte. Sur le tier local il vaut `true` ou `false`, parce que l'index sait combien de chunks étaient éligibles. Sur le tier **sémantique** il vaut `"unknown"` : Smart Connections ne dit pas combien de candidats il avait, donc prétendre « il n'y a rien d'autre » serait une affirmation que rien ne soutient. En fan-out (`vault: "*"`), un vault injoignable rend la réponse globale `"unknown"` — **sauf si un autre vault établit déjà qu'il reste des candidats**, auquel cas la réponse est `true` : une question d'existence est tranchée par la première réponse positive, et un corpus que personne n'a lu ne peut pas défaire une certitude, seulement empêcher d'en former une négative.

**`revisionCoherence` vaut toujours `not-verified`**, et c'est une information, pas un défaut : la fenêtre décrit la page telle qu'elle était **au moment de la requête**, pas la révision d'où l'extrait a été tiré. C'est écrit dans chaque réponse plutôt que laissé à deviner.

**Le tier sémantique adresse des blocs, pas des fichiers.** Smart Connections renvoie des chemins de la forme `Page.md#Titre#Sous-titre#{1}` : ce n'est pas un fichier, et le demander tel quel à Obsidian donne un 404. Le router en extrait donc la page avant de lire la fenêtre — sinon la moitié des résultats sémantiques auraient été rapportés « non vérifiables » alors que leur page déclare parfaitement sa validité. Une conséquence visible : vingt extraits d'un même document comptent pour **une** page dans `inspectedPages`, et coûtent **une** lecture.

**Quand le chemin est ambigu, le router ne devine pas.** Un `#` est légal dans un nom de fichier et `.md` est légal dans un titre de section, donc une chaîne comme `a.md#b.md` désigne soit un fichier portant ce nom, soit la section `b.md` de la page `a.md` — et rien dans la chaîne ne permet de trancher. Dans ce cas le router **ne lit rien** : le résultat est marqué `validityUnverified`, donc annoté d'aucune fenêtre et **jamais écarté par le filtre**. On perd l'annotation, jamais le résultat. C'est un choix délibéré : une fenêtre attribuée à la mauvaise page pourrait faire disparaître un résultat pour une date qui ne le concerne pas, ce qui est exactement ce que ce lot interdit. Le cas ne se produit que sur le tier sémantique — un chemin du tier local sort d'un index construit sur de vrais noms de fichiers, il est donc exact et lu tel quel.

**`search` ne porte pas ces champs.** La recherche plein texte rend des occurrences littérales, pas des pages, et ne lit aucun frontmatter ; lui greffer une validité aurait signifié lire une note par occurrence. Pour une recherche datée, passer par `search_smart`.

## `get_frontmatter` — lire les métadonnées d'une note

**Le besoin.** Consulter le statut, les tags ou n'importe quelle propriété d'une note sans charger tout son contenu.

**Ce que ça fait.** Retourne le frontmatter complet — ou une seule clé si on la nomme — avec les **types préservés** : les nombres restent des nombres, les booléens des booléens, les listes des listes. Pas de conversion sauvage en chaînes de caractères.

**Comment l'utiliser.**

> « quel est le statut de la note X ? », « montre les méta de X » — ou `/obsidian-router:read-frontmatter`

**Trois états, pas deux.** Un frontmatter vide et un frontmatter *illisible* rendaient tous deux `{}`, et rien ne permettait de les distinguer : « cette note ne déclare rien » et « je n'ai pas réussi à lire ce qu'elle déclare » sont pourtant des affirmations très différentes sur une page. Le retour porte donc `frontmatterStatus` :

| valeur | ce que ça veut dire |
|---|---|
| `absent` | la note n'ouvre sur aucun bloc `---` — il n'y a rien à lire |
| `ok` | le bloc a été lu (y compris un bloc volontairement vide) |
| `invalid` | il y a bien un bloc, et le parseur YAML d'Obsidian n'en a tiré aucune propriété |

Dans le cas `invalid`, un champ `parseError` nomme la cause probable et la voie de réparation. Obsidian affiche ces pages avec la bannière « Invalid properties ».

**Réparer un bloc invalide se fait par réécriture complète**, avec `write_file` et son `ifMatch`. Ni `patch_file` ni `set_frontmatter` n'y arrivent : pour modifier une propriété, il faut d'abord parser le bloc — c'est exactement ce que le défaut empêche, et l'appel remonte une erreur de l'API Local REST plutôt qu'une réparation.

**À savoir.** Pour *modifier* le frontmatter, voir `set_frontmatter` / `merge_frontmatter` dans la [fiche 3](03-ecriture-et-edition.md). À l'écriture, `write_file` et `write_bundle` signalent d'eux-mêmes un bloc qui paraît malformé (`frontmatterWarning`) — un avertissement, jamais un refus : la détection est heuristique, et bloquer une écriture légitime coûterait plus cher que de laisser passer un cas douteux.
