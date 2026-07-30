# 7 · Wiki et gestion de connaissances

La couche la plus haute du router : transformer un vault Obsidian en **wiki auto-entretenu** — une base de connaissances structurée que le LLM alimente, interroge et maintient au fil des sessions (le modèle « LLM wiki » popularisé par Andrej Karpathy). Toutes les features de cette fiche travaillent sur cette structure.

## La structure : `wiki/` et `wiki-meta/`

Le savoir vit dans deux arborescences séparées :

- **`wiki/`** — vos pages : personnes, concepts, décisions, références, sessions, projets. C'est le contenu.
- **`wiki-meta/`** — les quatre échafaudages qui rendent le wiki navigable par un LLM :
  - `catalog.md` — le **catalogue** de toutes les pages, organisé par dossier. Le point d'entrée de toute recherche.
  - `journal.md` — l'**historique** append-only : une ligne par opération/session, chacune renvoyant vers le détail.
  - `hot.md` — le **cache de contexte récent** : les ~10 derniers sujets touchés, rechargé automatiquement à chaque début de session (via hook, [fiche 12](12-hooks-et-automatisations.md)).
  - `overview.md` — le **résumé exécutif** du vault : périmètre et conventions.

Cette séparation garantit que les fichiers de machinerie ne se mélangent jamais à vos notes.

## `/wiki` — scaffolder le wiki

**Le besoin.** Partir d'un vault vide (ou d'un vault en vrac) et obtenir une structure que Claude saura entretenir seul par la suite.

**Ce que ça fait.** Crée les quatre échafaudages de `wiki-meta/`, la structure `wiki/`, et met à jour le `CLAUDE.md` du vault avec les règles de navigation — pour que chaque session future sache où chercher et où ranger.

**Comment l'utiliser.**

> « scaffold un wiki dans ce vault », « crée ma base de connaissances » — ou `/obsidian-router:wiki`

## `/wiki-ingest` — nourrir le wiki

**Le besoin.** Vous tombez sur un article, un PDF, une vidéo qui mérite d'entrer dans votre base de connaissances — pas comme un copier-coller mort, mais comme des pages **structurées et reliées**.

**Ce que ça fait.** Lit la source (URL, fichier ou texte collé), en extrait les entités et concepts qui comptent, les classe en pages wiki croisées de `[[wikilinks]]`, écrit la page source avec un frontmatter fiable (via `extract_page_metadata`, [fiche 6](06-ingestion-web.md)), puis met à jour `catalog.md`, `journal.md` et `hot.md` pour que les sessions futures retrouvent tout.

**Comment l'utiliser.**

> « ingère cette URL », « absorbe cet article dans le wiki » — ou `/obsidian-router:wiki-ingest`

**À savoir.** Pour un **lot** de sources, un sous-agent `wiki-ingest` dédié permet de paralléliser : un agent par source, et une seule consolidation de `hot.md` à la fin (*« ingère toutes ces URLs »*).

## `/wiki-query` — interroger le wiki (et seulement le wiki)

**Le besoin.** « Qu'est-ce que **mes notes** disent sur X ? » — une réponse ancrée dans ce que vous avez réellement archivé, sans que le modèle aille inventer ou chercher sur le web.

**Ce que ça fait.** Un RAG à trois étages sur le vault : d'abord `hot.md` (contexte récent), puis `catalog.md` (catalogue), puis lecture des pages pertinentes — avec `search_smart` en renfort pour les sujets qui se cherchent par le sens. La réponse cite les pages utilisées. Aucune requête web.

**Comment l'utiliser.**

> « d'après mes notes, … », « que dit mon wiki sur X ? » — ou `/obsidian-router:wiki-query`

## `/save` — archiver la conversation en cours

**Le besoin.** Une session Claude vient de produire quelque chose de précieux — une décision, une explication, une procédure. Si personne ne l'archive, c'est perdu à la fermeture de l'onglet.

**Ce que ça fait.** Range la conversation courante (ou un insight précis) comme note wiki **typée** : la skill détecte s'il s'agit d'une décision, d'une réponse, d'un journal de session, d'une technique ou d'un ADR, écrit le frontmatter adapté, place le fichier dans le bon dossier et met à jour index/log/hot.

**Comment l'utiliser.**

> « sauvegarde ça », « archive cette conversation », « garde cette réponse » — ou `/obsidian-router:save`

## `/autoresearch` — la recherche web autonome

**Le besoin.** « Documente-moi ce sujet » : plusieurs heures de recherche web, de tri et de classement, qu'on aimerait déléguer entièrement.

**Ce que ça fait.** Une boucle autonome bornée par un programme de recherche : recherche web → récupération et nettoyage des sources (avec `defuddle`) → synthèse → classement en pages wiki — puis itération, chaque tour réduisant l'écart entre ce que le wiki sait déjà et ce qui manque, jusqu'à la profondeur demandée.

**Comment l'utiliser.**

> « fais une recherche web sur X et range tout dans le wiki », « investigue X en ligne » — ou `/obsidian-router:autoresearch`

**À savoir.** La boucle coûte de vrais tokens. Si votre « recherche X » est ambigu, Claude doit demander : réponse depuis le wiki existant → `wiki-query` ; aller chercher du **neuf** sur le web → `autoresearch`.

## Auto-enrichissement — le wiki qui se remplit tout seul

**Le besoin.** Le point faible de toute base de connaissances : on oublie d'y verser ce qu'on apprend. Les meilleures notes sont celles qu'on n'a jamais écrites.

**Ce que ça fait.** Claude propose (ou effectue) des sauvegardes wiki à trois moments naturels de la conversation : quand vous **validez** quelque chose (« OK », « valide »), quand un **résultat** est obtenu (commit poussé, tests verts), et au **changement de sujet** (checkpoint avant de passer à autre chose). Quatre modes règlent le niveau d'autonomie :

| Mode | Comportement | Quand le choisir |
|---|---|---|
| `ClaudeAsk` (défaut) | Propose, demande toujours confirmation | Découverte de la feature ; période de calibration ; vaults où un faux positif coûte cher. |
| `Hybrid` | Sauve seul les éléments sûrs (faits, URLs, préférences) ; demande pour les décisions/ADR/règles | Le sweet spot après calibration. |
| `FullAuto` | Sauve tout seul — avec journal d'audit dans `journal.md`, filtre de sensibilité (jamais de credentials/médical/financier) et plafond de sécurité (redevient `ClaudeAsk` après 5 sauvegardes/session) | Journal personnel, chroniques familiales, longues sessions non supervisées. |
| `off` | Aucune suggestion ; `/save` manuel uniquement | Sessions de debug, conversations sensibles, vaults juridiques/médicaux. |

**Comment l'utiliser.**

> « passe en mode Hybrid », « sauve tout automatiquement » (→ FullAuto), « arrête de sauver auto » (→ off) — ou `/obsidian-router:auto-mode <Mode>`, avec `--persist` pour l'écrire dans le `.env` du workspace

**À savoir.** La consigne d'auto-enrichissement peut vivre à quatre endroits (CLAUDE.md du vault, instructions de Projet Claude Desktop, Memory, CLAUDE.md global) — le guide détaillé avec les boilerplates à copier-coller est dans [`docs/auto-enrichment.md`](../auto-enrichment.md).

## `/wiki-lint` — le contrôle santé

**Le besoin.** Un wiki qui grandit dérive : pages orphelines que rien ne référence, wikilinks morts, catalogue en retard sur la réalité, frontmatter incomplet.

**Ce que ça fait.** Scanne le wiki et produit un rapport structuré par niveaux de gravité : orphelines, liens morts, dérive de l'index, champs de frontmatter manquants, sections vides, affirmations périmées. **Lecture seule par défaut** — les corrections sont proposées, jamais appliquées sans votre accord.

**Comment l'utiliser.**

> « lint le wiki », « audit mon wiki », « qu'est-ce qui est cassé dans le wiki ? » — ou `/obsidian-router:wiki-lint`

**À savoir.** Un sous-agent `wiki-lint` (read-only) peut exécuter le diagnostic dans un contexte séparé — pratique après une grosse session d'ingestion. Le mode `--deep` s'appuie sur les digests de pages (ci-dessous).

## `/wiki-refresh-digests` — les résumés par page

**Le besoin.** Les analyses profondes (lint `--deep`, graphe) ont besoin d'un condensé par page — concepts, affirmations, mots-clés — sans relire tout le vault à chaque fois.

**Ce que ça fait.** Régénère les fichiers « digest » associés à chaque page, consommés par `wiki-lint --deep` et le graphe de connaissances ([fiche 8](08-graphe-de-connaissances.md)).

**Comment l'utiliser.**

> « rafraîchis les digests », « régénère les digests de page » — ou `/obsidian-router:wiki-refresh-digests`

## `/wiki-fold` — compacter l'historique

**Le besoin.** `journal.md` s'allonge indéfiniment ; au bout de quelques mois, « qu'est-ce qui s'est passé récemment ? » devient illisible.

**Ce que ça fait.** Roule les entrées du log en pages de synthèse sous `wiki/folds/` — résumé extractif avec backlinks vers les entrées d'origine. L'opération est **structurellement idempotente** : relancer le fold ne duplique rien.

**Comment l'utiliser.**

> « compacte le journal », « résume l'activité wiki de cette semaine » — ou `/obsidian-router:wiki-fold`

## `/who-is-speaking` — le vault familial

**Le besoin.** Un vault partagé (famille, petite équipe) où plusieurs personnes parlent au même Claude : les notes de Karine ne doivent pas atterrir dans l'espace de Roland.

**Ce que ça fait.** Identifie qui parle et verrouille le routage sur l'espace de ce membre pour la suite de la session.

**Comment l'utiliser.**

> « qui parle ? », « c'est Karine » — ou `/obsidian-router:who-is-speaking`

**À savoir.** Pour l'isolation par vault entier (plutôt que par membre), voir le lock mode en [fiche 11](11-securite-et-isolation.md) ; pour l'attribution des écritures dans un déploiement partagé, voir `OBSIDIAN_ROUTER_USER_ID` dans la même fiche.
