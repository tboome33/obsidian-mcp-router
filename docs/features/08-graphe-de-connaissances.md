# 8 · Graphe de connaissances

Un wiki, ce sont des pages **et** les liens entre elles. Ces outils matérialisent cette topologie en un graphe typé, puis l'exploitent : visualiser les communautés, générer un parcours de lecture, demander « qu'est-ce qui est lié à X ? » ou « quel rapport entre A et B ? ».

## `build_wiki_graph` — construire le graphe

**Le besoin.** Le graphe natif d'Obsidian montre des liens, mais sans sémantique : impossible d'y distinguer une page d'un concept, une source d'une décision, ni de voir les regroupements réels du vault.

**Ce que ça fait.** Assemble tout le vault en un graphe de connaissances **typé** (schéma Understand-Anything : 21 types de nœuds, 35 types d'arêtes) et l'écrit dans `wiki-meta/graph/knowledge-graph.json`. Les regroupements (`layers[]`) sont calculés par détection de communautés **Louvain** — la structure réelle des liens, pas la table des matières de l'index — de façon totalement déterministe : même vault, même fichier octet pour octet. La taxonomie manuelle d'`index.md` n'est pas perdue : elle coexiste sous forme de nœuds `topic` (curatée) à côté des communautés (découvertes).

**Comment l'utiliser.**

> « construis le graphe du wiki », « génère le knowledge graph » — ou `/obsidian-router:wiki-graph`

**À savoir.** C'est le prérequis des trois outils d'interrogation ci-dessous : ils lisent le graphe **persisté**, ils ne rescannent pas le vault. Après une grosse session d'écriture, relancez le build pour rafraîchir. Les résultats portent un `graphAnalyzedAt` pour juger de la fraîcheur.

## `build_wiki_tour` — la visite guidée

**Le besoin.** Face à un vault riche (le vôtre après six mois, ou celui de quelqu'un d'autre) : **par où commencer** ? Quel ordre de lecture a du sens ?

**Ce que ça fait.** Génère un parcours de lecture pédagogique, ordonné et déterministe, dérivé de la topologie des liens : les pages fondatrices d'abord, puis ce qui s'appuie dessus. Lecture seule.

**Comment l'utiliser.**

> « fais-moi un tour du vault », « par où je commence ? » — ou `/obsidian-router:wiki-tour`

## `get_page_neighbors` — le voisinage d'une page

**Le besoin.** « Quelles pages sont liées à X ? » — ce que X référence, et surtout ce qui référence X (les backlinks), jusqu'à quelques sauts de distance.

**Ce que ça fait.** Retourne les voisins d'**une** page dans le graphe : `forward` (les pages qu'elle lie), `backward` (les pages qui la lient), ou les deux, jusqu'à `depth` sauts. Par défaut, seuls les liens page↔page comptent (`nodeTypes: ["article"]`) ; élargissez les types (`["entity"]`, `["article","topic"]`…) pour demander plutôt « quels **concepts** cette page mentionne-t-elle ? ». Les résultats sont triés (distance, puis id), plafonnés (`maxNeighbors`, défaut 50) avec un flag `truncated` pour les pages-carrefours.

**Comment l'utiliser.**

> « quelles pages sont liées à X ? », « montre-moi les backlinks de X » — ou `/obsidian-router:wiki-neighbors`

**À savoir.** Un nom de page **ambigu** (deux `notes.md` dans deux dossiers) est refusé avec la liste des candidats — jamais résolu silencieusement vers le premier venu. Lecture seule.

## `wiki_path` — le chemin entre deux pages

**Le besoin.** « Quel rapport entre A et B ? » — deux pages qui n'ont l'air de rien avoir en commun sont souvent reliées par une chaîne d'intermédiaires révélatrice.

**Ce que ça fait.** Trouve la **plus courte chaîne de liens** entre deux pages et la retourne saut par saut. Deux choix de conception à connaître : la traversée est **non orientée** (un lien lu dans un sens ou l'autre relie quand même les deux sujets), et deux pages non connectées ne sont **pas une erreur** — l'outil répond `found: false` avec `path: null`, car deux pages peuvent simplement n'avoir aucun rapport. `maxDepth` (défaut 6) borne la recherche.

**Comment l'utiliser.**

> « quel rapport entre X et Y ? », « chemin entre X et Y » — ou `/obsidian-router:wiki-path`

**À savoir.** Élargir `nodeTypes` (ex. `["article","entity","topic"]`) autorise les chemins « connectés via un **concept partagé** » — souvent la réponse la plus intéressante à « qu'est-ce qui relie A et B ? ». Lecture seule.

## `get_wiki_context_pack` — le vault consommable par d'autres agents

**Le besoin.** Un agent qui n'est pas Claude Code (un script, un autre LLM, un pipeline) veut exploiter le vault : il lui faut du contexte **structuré**, pas une conversation.

**Ce que ça fait.** Pour une requête donnée, retourne une enveloppe JSON structurée : `primaryPages` (les pages centrales), `semanticChunks` (les extraits pertinents), `graphNeighbors` (le voisinage graphe) et `citations` — tout ce qu'il faut pour répondre en citant ses sources, en un seul appel programmatique.

**Comment l'utiliser.** Appel MCP direct depuis n'importe quel client — c'est précisément sa raison d'être :

```jsonc
{ "vault": "recherche", "query": "gestion du risque en swing trading" }
```
