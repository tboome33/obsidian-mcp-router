# 12 · Hooks et automatisations

Les hooks sont la partie **déterministe** du système : là où une consigne dans un CLAUDE.md peut être oubliée par le modèle, un hook s'exécute **à chaque fois**, mécaniquement. Le router en livre neuf, cross-platform (Node), branchés automatiquement dans `~/.claude/settings.json` au bootstrap d'un vault (depuis v0.18.2 — opt-out avec `setup-vault.mjs --no-hooks`). Ils vivent dans [`hooks/`](../../hooks/).

La philosophie, apprise à l'usage : **une convention seule ne règle pas un problème de rappel**. Le patron qui marche est convention (le « quoi ») + hook (l'enforcement). Chaque hook ci-dessous existe parce qu'un oubli réel s'est produit.

## `session-auto-journal` — la mémoire automatique des sessions

**Le besoin.** Les sessions Claude qui ne sont pas archivées sont perdues : trois semaines plus tard, impossible de savoir ce qui a été décidé et pourquoi.

**Ce que ça fait.** À la fin de chaque session, écrit automatiquement un journal détaillé sous `wiki-meta/Sessions/` et une récap de deux lignes dans `wiki-meta/journal.md`. Une réconciliation **auto-réparante** rattrape les sessions qui se seraient terminées sans journal.

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

**Ce que ça fait.** À chaque prompt substantiel, remonte les décisions tranchées dont le sujet recoupe le prompt : titre, verdict en une ligne, périmètre, chemin pour lire la page entière.

Quatre garde-fous, chacun délibéré :

- **Déterministe d'abord.** Filtrage par statut puis recouvrement de tokens — aucun embedding, aucun appel modèle. Le chemin chaud de chaque prompt est le mauvais endroit pour l'un comme pour l'autre, et une sélection qu'on ne peut pas expliquer est une sélection qu'on ne peut pas déboguer le jour où elle remonte la mauvaise page. Le statut compte `accepted` **et** les synonymes hérités que le linter tolère encore (`decided`, `active`, `shipped`…) : une décision tranchée mais pas encore normalisée reste tranchée, et l'ignorer serait exactement l'échec que le hook prévient.
- **Le vocabulaire omniprésent est démoté.** Dans un repo « router », le mot *router* est dans presque toutes les décisions : matché seul, il les remonterait toutes. Les tokens portés par une grosse part du corpus ne comptent donc plus **quand ils apparaissent dans les champs périphériques** (périmètre, projet, tags, nom de fichier). Dans le titre ou le verdict ils comptent toujours — un vault focalisé doit pouvoir répondre sur son sujet central.
- **Échu ≠ silencieux, échu ≠ contraignant.** Une décision passée sa date `review_after:` est quand même affichée, marquée « à réévaluer » — et une date illisible aussi : une faute de frappe ne doit pas promouvoir en silence une décision périssable au rang de contrainte permanente.
- **Deux axes de temps, deux marqueurs.** Depuis v0.96.0, une décision qui déclare une fenêtre d'application (`valid_from` / `valid_through`) est aussi remontée avec un marqueur 📅 quand cette fenêtre n'est pas ouverte au jour courant : close, pas encore ouverte, ou illisible. Une fenêtre en vigueur n'ajoute rien — dans un bloc de prose, l'état normal doit rester silencieux, sinon le marqueur qui compte cesse d'être lu. Le 📅 est **distinct** du ⏳ ci-dessus, et une décision passée les deux affiche les deux : « réexamine ce jugement » et « la période qu'il couvrait est finie » ne se disent pas pareil, et un seul symbole pour les deux effacerait la distinction sur la page même où elle a été écrite. Le hook lit ces deux champs dans le **texte brut** du frontmatter et non dans l'objet qu'il en tire : son lecteur est orienté ligne — il tourne avant toute installation de dépendances — et aplatirait une clé imbriquée en fenêtre réelle, ou une borne portant un bloc en fenêtre absente. Deux inversions, dans deux directions opposées.
- **Une forme non décodée se refuse, elle ne se déclare pas absente.** Ce lecteur brut ne connaît qu'une seule forme de borne : un scalaire simple sur la ligne de la clé, nu ou cité, avec un commentaire final éventuel. Tout le reste a une troisième issue, distincte de « valeur » et de « absent » : *cette forme, je ne la décode pas*. Le marqueur 📅 ne s'affiche alors pas — mais rien n'affirme non plus que la fenêtre est ouverte, et c'est là toute la différence : une borne illisible et une borne absente ne sont pas la même affirmation, et une seule des deux autorise à agir. Le prix de ce refus est mesuré, pas supposé. Sur une grille de **225 assemblages** des formes YAML légales, chacun comparé au frontmatter qu'Obsidian lui-même en tire : **aucune fenêtre fausse**, et **48 refus sur des pages où Obsidian lit une date propre** — dont **39 bornes écrites en scalaire de bloc** (`valid_from: |`, la date sur la ligne d'en dessous). Celles-là restent refusées exprès : les lire demanderait de suivre l'indentation et le *chomping*, c'est-à-dire de réimplémenter YAML dans un hook qui tourne sans dépendances. Une clé **citée** (`"valid_from":`) est en revanche la même clé que la graphie nue, et se lit comme elle. Sur la flotte réelle — **3848 blocs de frontmatter** — aucun refus.
- **Donnée citée, jamais instruction.** Une page de vault est du contenu utilisateur, et un contenu lu par un agent ne doit jamais pouvoir le piloter — sinon le vault devient une surface d'injection de prompt. Le bloc injecté le dit explicitement et demande de **signaler** un désaccord, pas d'obéir ni de contredire en silence. Le cadrage vit en tête ET en pied de bloc, et seules les entrées (le texte contrôlé par les pages) peuvent être coupées — jamais le cadrage, jamais au milieu d'une entrée.

Silencieux quand rien ne matche. **Borné en temps** (budget wall-clock) plutôt qu'en nombre de fichiers : un vault sur lecteur virtuel coûte ~30× un vault local par fichier, et un plafond de fichiers y produirait soit une coupe arbitraire, soit un prompt qui traîne.

Un budget de temps ne supprime pas à lui seul la dépendance à l'ordre de traversée — sur un stockage lent, il peut s'épuiser avant d'atteindre le dossier des décisions. C'est pour ça que les dossiers où les décisions vivent conventionnellement (`decisions/`, `adr/`, `wiki/`) sont parcourus **en premier** : la coupe tombe alors sur la partie improbable de l'arborescence. Et quand le scan a été écourté, le bloc le dit au lieu de faire passer une liste partielle pour exhaustive.

Opt-out : `OBSIDIAN_ROUTER_NO_DECISIONS_RECALL=true` ; diagnostic : `OBSIDIAN_ROUTER_HOOK_DEBUG=true` (signale un scan écourté et toute erreur avalée).

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

## `workspace-briefing` — à quoi ce workspace est rattaché, et si ce vault peut répondre

**Le besoin.** Deux questions se posent au démarrage de chaque session, et aucune ne se voyait. *À quel vault ce workspace écrit-il ?* Et : *ce vault est-il seulement capable de répondre à une recherche sémantique ?*

**Ce que ça fait.** Il ouvre la session par quelques lignes : le ou les vaults liés, ce que le `.env` du projet a proposé et s'est vu refuser, le mode d'enrichissement, et les deux appels qui changent tout ça.

Il signale en plus, **en lisant le disque des vaults liés**, les deux états où la recherche sémantique est morte sans que rien d'autre ne le dise :

- **Smart Connections installé mais pas activé** — le dossier du plugin est là, une synchro a rapporté un succès, et Obsidian ne le charge jamais. C'est l'état qui *se lit comme fonctionnel* et ne l'est pas.
- **Smart Connections activé mais index vide** — son magasin `.smart-env/multi` ne contient aucun fichier `.ajson`, ou n'existe pas encore. La sonde vérifie que ces fichiers sont présents, pas qu'ils sont valides ; elle ne peut pas distinguer un magasin jamais construit d'un magasin vidé, et ne prétend pas le faire.

Lire le disque plutôt que passer par HTTP est ce qui fait marcher ce contrôle **Obsidian fermé** — et un vault qu'on n'a pas ouvert est précisément celui dont on ignore que la recherche est cassée. C'est aussi pourquoi il vit dans le hook et jamais dans le serveur : le serveur reste HTTP-only, et c'est **imposé**, pas supposé : le serveur marque son processus avant que la moindre autre partie de son code ne s'exécute, et la sonde refuse de lire le disque dans un processus marqué — ou dans un worker ou un processus enfant qu'il a lancé —, quelle que soit la façon dont elle a été chargée.

Il reste **silencieux** quand le plugin est absent (un vault peut ne pas en vouloir), quand quelque chose est illisible — un refus d'accès, un lecteur réseau déconnecté, un fichier à la place d'un dossier (ne pas voir n'est pas un constat, et un magasin illisible n'est pas un magasin vide) — et il ne parle jamais de Smart Lookup, que le router n'appelle pas. Seuls les vaults *liés* sont sondés, avec un budget de temps dont le vault principal est exempté ; quand il signale quelque chose, il dit aussi combien de vaults liés n'ont pas pu être vérifiés.

**Au moment de la liaison**, c'est le skill `bind-workspace` qui prend le relais : sa dernière étape fait un appel `search_smart` en lecture sur le vault principal — sans présumer qu'il est ouvert, puisque le skill peut lier un vault qu'il n'a jamais pingué ; si l'appel échoue pour une autre raison, rien n'est dit — et, si le bridge répond que Smart Connections n'est pas disponible, dit qu'il faut l'installer **et** l'activer. Il mentionne aussi Smart Lookup, une seule fois, comme une option.

Opt-outs, **depuis l'hôte uniquement** — un fichier de projet ne peut pas couper le message qui parle de lui : `OBSIDIAN_ROUTER_NO_BINDING_BRIEFING` pour tout le briefing, `OBSIDIAN_ROUTER_NO_SEMANTIC_READINESS` pour le seul contrôle sémantique.

## Ce que le plugin active pour tout le monde — et pourquoi pas le reste

Le plugin Claude Code active lui-même trois hooks, déclarés dans [`hooks/hooks.json`](../../hooks/hooks.json) : `hot-cache-load`, `workspace-briefing` et `decisions-recall`. Tous les autres restent **opt-in**.

La règle d'admission est stricte, parce qu'un hook de plugin **n'a pas d'étape d'adhésion** : tout ce qui est listé là tourne chez chaque personne qui installe le plugin. N'y entrent donc que des hooks qui sont en lecture seule, ne font aucun appel réseau, ne sortent jamais en code 2 (ce qui bloquerait le tour de l'utilisateur), et dont on a vérifié qu'ils sont muets pour quelqu'un qui n'a aucun vault configuré.

Le briefing est entré dans cet ensemble avec le lot « registre de liaisons ». C'est lui qui rend visible la liaison workspace→vault, et l'import unique des indications `.env` existantes n'est défendable que parce qu'une liaison mal importée s'annonce à chaque démarrage de session. Livrer l'import à tout le monde et le briefing à quelques-uns, ce serait livrer la confiance sans le contrôle.

Les autres hooks restent opt-in, via `node scripts/setup-vault.mjs --install-hooks`, parce qu'ils committent dans git, écrivent des transcriptions de session dans un vault, bloquent des tours ou appellent le réseau. L'ensemble opt-in complet est dans [`hooks/hooks.example.json`](../../hooks/hooks.example.json).

> ℹ️ **Pourquoi `hooks.json` ne porte aucun commentaire.** Cette justification vivait auparavant dans une clé `_comment` du fichier lui-même. Le chargeur de hooks de Claude Code n'accepte que la clé `hooks` et affichait `unknown key "_comment" ignored` à chaque démarrage de session. Un test vérifie désormais que le fichier ne porte que `hooks`.
>
> Et une précision qui y figurait : `${CLAUDE_PLUGIN_ROOT}` n'est développé par Claude Code **que** dans les fichiers de composants du plugin. Il ne l'est **pas** dans `~/.claude/settings.json` — c'est pourquoi `hooks.example.json` garde le marqueur `<router-repo>` à la place.

## Installer, vérifier, débrancher

- **Installation** : automatique au bootstrap d'un vault (`setup-vault.mjs`). Famille de flags `--install-hooks` pour équiper un setup existant ; `--hooks-status` pour vérifier ce qui est branché ; `--no-hooks` pour s'en passer.
- **Exemple de câblage manuel** : [`hooks/hooks.example.json`](../../hooks/hooks.example.json).
- **Opt-outs individuels** : chaque hook sensible a sa variable d'environnement (listées ci-dessus) — on peut en débrancher un sans perdre les autres.
