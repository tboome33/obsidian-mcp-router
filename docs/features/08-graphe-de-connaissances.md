# 8 · Graphe de connaissances

Un wiki, ce sont des pages **et** les liens entre elles. Ces outils matérialisent cette topologie en un graphe typé, puis l'exploitent : visualiser les communautés, générer un parcours de lecture, demander « qu'est-ce qui est lié à X ? » ou « quel rapport entre A et B ? ».

## `build_wiki_graph` — construire le graphe

**Le besoin.** Le graphe natif d'Obsidian montre des liens, mais sans sémantique : impossible d'y distinguer une page d'un concept, une source d'une décision, ni de voir les regroupements réels du vault.

**Ce que ça fait.** Assemble tout le vault en un graphe de connaissances **typé** (schéma Understand-Anything : 21 types de nœuds, 35 types d'arêtes) et l'écrit dans `wiki-meta/graph/knowledge-graph.json`. Les regroupements (`layers[]`) sont calculés par détection de communautés **Louvain** — la structure réelle des liens, pas la table des matières de l'index — de façon totalement déterministe : même vault, même fichier octet pour octet. La taxonomie manuelle du `catalog.md` n'est pas perdue : elle coexiste sous forme de nœuds `topic` (curatée) à côté des communautés (découvertes).

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

## `find_boundary_pages` — les pages « frontière »

**Le besoin.** Certaines pages sont des carrefours : tout le monde pointe vers elles, mais elles restent maigres. Ce sont les endroits où écrire rapporte le plus — encore faut-il les repérer autrement qu'au flair.

**Ce que ça fait.** Classe les pages par **pression de liens rapportée à la substance**, avec un coup de pouce pour l'ancienneté :

```
score = liens entrants / (1 + mots/100) × (1 + min(âge, 365)/365)
```

Le score, ce sont les **liens entrants amortis par la longueur** — et non, malgré le raccourci tentant, « des liens entrants par tranche de 100 mots » : le `1 +` du dénominateur fait qu'une page vide garde son compte entier au lieu de diviser par zéro, et qu'une page de 100 mots est divisée par deux plutôt que laissée intacte. Le tout multiplié par ×1 (page éditée le jour de la construction du graphe, ou date inconnue) jusqu'à ×2 (rien depuis un an). Lecture seule, une seule lecture de fichier, aucun LLM : **même graphe ⇒ même classement, toujours** — la récence se mesure contre l'horodatage du graphe lui-même, pas contre l'horloge.

**Comment l'utiliser.**

> « sur quoi devrais-je écrire ? », « où sont les trous du wiki ? » — ou `/obsidian-router:wiki-boundary`

**Ce que le score prétend, et ce qu'il ne prétend pas.** Il **propose l'attention**, il n'établit **pas** l'importance. Un score élevé dit une seule chose : beaucoup de pages pointent ici, et il n'y a pas grand-chose une fois arrivé.

**La limite, assumée par écrit.** La « substance » est un **compte de mots de prose**, et c'est un proxy franchement faible : il récompense le bavardage, punit la densité, ne distingue pas 89 mots de vraie définition de 89 mots de texte de redirection, et compte double les pages bilingues FR+EN. Il est livré tel quel plutôt qu'une formule à cinq coefficients que personne ne saurait régler — avec deux garde-fous qui le rendent utilisable :

1. **Le biais est choisi.** Sur-compter la substance (le code, les tableaux, les listes de liens comptent comme des mots) produit des faux **négatifs** — une page maigre qu'on ne signale pas. Sous-compter produirait des faux **positifs** — une page saine qu'on envoie retravailler. Pour une liste de suggestions, le silence est l'erreur la moins chère.
2. **La politique d'exemption pèse plus lourd que la formule.** Mesuré sur le vault du router : sans exemptions, **12 des 20 premiers étaient des `type: redirect`** — tous exactement 89 mots du même texte type, maigres *par construction*. Aucun raffinement du compte de mots ne les sépare du vrai contenu ; seul le `type:` déclaré le fait. `redirect` / `source` / `answer` sont donc écartés par défaut (les deux derniers reprennent verbatim les exemptions du Check A de `wiki-lint`), et **le nombre de pages écartées est toujours rapporté** — une exemption silencieuse se lirait comme « j'ai tout regardé ».

**À savoir.** Les pages d'index et les pages-hub remontent légitimement en tête : une page dont le métier est de pointer ailleurs est maigre par construction, et le score ne sait pas distinguer ça d'une page maigre par négligence. En attendre une ou deux à écarter d'un coup d'œil fait partie du fonctionnement normal.

Un graphe construit avant cette fonctionnalité ne porte aucune mesure de substance : l'outil **refuse** plutôt que de traiter toutes les pages comme vides — un classement par liens entrants bruts qui aurait l'air d'avoir mesuré la maigreur. `graphAnalyzedAt` voyage avec chaque réponse, parce qu'un graphe périmé classe des pages qui n'existent peut-être plus.

## `get_wiki_context_pack` — le vault consommable par d'autres agents

**Le besoin.** Un agent qui n'est pas Claude Code (un script, un autre LLM, un pipeline) veut exploiter le vault : il lui faut du contexte **structuré**, pas une conversation.

**Ce que ça fait.** Pour une requête donnée, retourne une enveloppe JSON structurée : `primaryPages` (les pages centrales), `semanticChunks` (les extraits pertinents), `graphNeighbors` (le voisinage graphe) et `citations` — tout ce qu'il faut pour répondre en citant ses sources, en un seul appel programmatique.

**Comment l'utiliser.** Appel MCP direct depuis n'importe quel client — c'est précisément sa raison d'être :

```jsonc
{ "vault": "recherche", "query": "gestion du risque en swing trading" }
```
