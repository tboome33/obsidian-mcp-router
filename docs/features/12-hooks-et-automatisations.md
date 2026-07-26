# 12 · Hooks et automatisations

Les hooks sont la partie **déterministe** du système : là où une consigne dans un CLAUDE.md peut être oubliée par le modèle, un hook s'exécute **à chaque fois**, mécaniquement. Le router en livre neuf, cross-platform (Node), branchés automatiquement dans `~/.claude/settings.json` au bootstrap d'un vault (depuis v0.18.2 — opt-out avec `setup-vault.mjs --no-hooks`). Ils vivent dans [`hooks/`](../../hooks/).

La philosophie, apprise à l'usage : **une convention seule ne règle pas un problème de rappel**. Le patron qui marche est convention (le « quoi ») + hook (l'enforcement). Chaque hook ci-dessous existe parce qu'un oubli réel s'est produit.

## `session-auto-journal` — la mémoire automatique des sessions

**Le besoin.** Les sessions Claude qui ne sont pas archivées sont perdues : trois semaines plus tard, impossible de savoir ce qui a été décidé et pourquoi.

**Ce que ça fait.** À la fin de chaque session, écrit automatiquement un journal détaillé sous `wiki-meta/Sessions/` et une récap de deux lignes dans `wiki-meta/log.md`. Une réconciliation **auto-réparante** rattrape les sessions qui se seraient terminées sans journal.

## `hot-cache-load` — le contexte récent, chargé d'office

**Le besoin.** Chaque nouvelle session repart de zéro ; il faut que Claude retrouve immédiatement où en étaient les sujets chauds sans qu'on lui répète.

**Ce que ça fait.** Au démarrage de session (et après un compactage de contexte), charge `wiki-meta/hot.md` — le cache des ~10 derniers sujets touchés — directement dans le contexte de Claude. Fonctionne aussi en mode *workspace-bound* : un repo de code associé à un vault reçoit le hot.md **du vault**, étiqueté comme tel.

## `hot-cache-update-prompt` — le cache ne peut pas être oublié

**Le besoin.** Le hot.md n'a de valeur que s'il est tenu à jour — or « pense à rafraîchir le cache » est exactement le genre de consigne qu'un modèle oublie en fin de session.

**Ce que ça fait.** Garde déterministe : si la session a écrit une note `wiki/`, le hook **bloque la fin du tour** (exit 2) tant que `wiki-meta/hot.md` n'a pas été rafraîchi. Par vault, borné à la session courante. Opt-out : `OBSIDIAN_ROUTER_NO_HOT_CACHE_GUARD`.

## `wiki-autocommit` — le wiki sous git, sans y penser

**Le besoin.** Un wiki est un actif : il faut un historique et une possibilité de retour arrière, sans imposer une discipline git manuelle sur des notes.

**Ce que ça fait.** Après les écritures, commite automatiquement `wiki/`, `wiki-meta/`, `.raw/` et `.vault-meta/` dans le git du vault.

## `wiki-query-first-nudge` — vérifier le wiki avant de répondre

**Le besoin.** Le pire gaspillage d'une base de connaissances : poser une question dont la réponse **y est déjà**, et recevoir une réponse réinventée (et parfois contradictoire) à la place.

**Ce que ça fait.** À chaque prompt substantiel, injecte un rappel poussant Claude à consulter le wiki (index, pages pertinentes, recherche sémantique) avant de composer sa réponse. Injecte aussi les **règles de résolution de chemins** en mode workspace-bound : les chemins absolus réels du workspace et du vault, pour empêcher les chemins fantômes qui mélangent les deux racines. Opt-out : `OBSIDIAN_ROUTER_NO_WIKI_QUERY_FIRST=true`.

## `decisions-recall` — ce qui est déjà tranché revient de lui-même

**Le besoin.** Une base de connaissances enregistre ce qu'on sait ; la couche décision enregistre ce qui est **tranché** et ce qui a été **écarté**. Mais les deux sont passives : une nouvelle session — ou un autre agent, ou le même après une remise à zéro du contexte — repart d'une page blanche et re-propose une approche rejetée il y a six mois. Écrire la décision est nécessaire et insuffisant : il faut que quelque chose la **présente**, sans qu'on le demande, au moment où le prompt arrive.

**Ce que ça fait.** À chaque prompt substantiel, remonte les décisions `accepted` dont le sujet recoupe le prompt : titre, verdict en une ligne, périmètre, chemin pour lire la page entière.

Trois garde-fous, chacun délibéré :

- **Déterministe d'abord.** Filtrage par statut puis recouvrement de tokens — aucun embedding, aucun appel modèle. Le chemin chaud de chaque prompt est le mauvais endroit pour l'un comme pour l'autre, et une sélection qu'on ne peut pas expliquer est une sélection qu'on ne peut pas déboguer le jour où elle remonte la mauvaise page.
- **Échu ≠ silencieux, échu ≠ contraignant.** Une décision passée sa date `review_after:` est quand même affichée, marquée « à réévaluer ». La cacher perdrait le contexte ; la présenter comme une contrainte ossifierait un arbitrage dont les conditions ont changé.
- **Donnée citée, jamais instruction.** Une page de vault est du contenu utilisateur, et un contenu lu par un agent ne doit jamais pouvoir le piloter — sinon le vault devient une surface d'injection de prompt. Le bloc injecté le dit explicitement et demande de **signaler** un désaccord, pas d'obéir ni de contredire en silence.

Silencieux quand rien ne matche, borné (fichiers scannés, octets par fichier, décisions remontées, caractères injectés). Opt-out : `OBSIDIAN_ROUTER_NO_DECISIONS_RECALL=true`.

## `vault-link-linter` — plus de liens cassés dans les réponses

**Le besoin.** Un chemin de vault cité en texte brut dans une réponse de chat devient un lien cassé au rendu ([fiche 10](10-liens-et-navigation.md) pour le bon format). Ce bug a été signalé de nombreuses fois avant d'être traité par l'enforcement.

**Ce que ça fait.** Scanne les réponses et intercepte les liens de vault cassés ou fantômes **avant** qu'ils n'atteignent l'utilisateur.

## `doc-propagation-checker` — la doc ne dérive pas du code

**Le besoin.** On shippe une feature, on oublie de mettre à jour le README/la roadmap — et trois versions plus tard, la doc décrit un produit qui n'existe plus.

**Ce que ça fait.** Détecte les documents qui dérivent du code livré et le signale pendant la session, tant que le contexte est encore frais.

## `vault-doc-startup-check` — l'état des lieux au démarrage

**Le besoin.** Découvrir en **début** de session qu'un vault est hors ligne ou qu'une doc est en retard — pas au moment où une écriture échoue.

**Ce que ça fait.** Au démarrage de session, fait remonter la santé du vault et des documents.

## `check-router-update` — rester à jour sans y penser

**Le besoin.** Un router installé puis oublié rate les corrections et les nouvelles features.

**Ce que ça fait.** Une fois par 24 h, compare la version installée à celle publiée sur GitHub (un simple GET sur `raw.githubusercontent.com` — aucune télémétrie) et signale en début de session si une mise à jour existe. Opt-out : `OBSIDIAN_ROUTER_NO_UPDATE_CHECK=true`, ou automatiquement en déploiement multi-tenant (`OBSIDIAN_ROUTER_USER_ID` défini — l'admin gère les mises à jour centralement).

## Installer, vérifier, débrancher

- **Installation** : automatique au bootstrap d'un vault (`setup-vault.mjs`). Famille de flags `--install-hooks` pour équiper un setup existant ; `--hooks-status` pour vérifier ce qui est branché ; `--no-hooks` pour s'en passer.
- **Exemple de câblage manuel** : [`hooks/hooks.example.json`](../../hooks/hooks.example.json).
- **Opt-outs individuels** : chaque hook sensible a sa variable d'environnement (listées ci-dessus) — on peut en débrancher un sans perdre les autres.
