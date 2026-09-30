# 13 · Installation et administration

Tout ce qui installe, crée, attache, diagnostique, synchronise et met à jour — le cycle de vie du router et des vaults. La plupart de ces opérations sont conversationnelles : décrivez ce que vous voulez, la skill correspondante déroule la procédure.

## `/meta-setup` — installer le router sur une machine

**Le besoin.** Le premier quart d'heure : cloner, lier le binaire, enregistrer le MCP, sans se tromper dans les fichiers de config de Claude.

**Ce que ça fait.** Déroule l'installation complète : clone du repo, `npm install` + `npm link`, enregistrement du binaire dans `~/.claude.json` (user scope), et vérifications. Détecte aussi un budget de listing de skills trop petit (symptôme : *« Skill listing will be truncated »* au démarrage) et propose la correction (`skillListingBudgetFraction: 0.05`).

**Comment l'utiliser.**

> « installe le router sur cette machine », « setup obsidian-mcp-router » — ou `/obsidian-router:meta-setup`

**À savoir.** L'installation a deux moitiés : le **serveur MCP** (les ~40 outils) et le **plugin Claude Code** (les slash commands + skills). Le plugin s'active **par workspace**, pas globalement — il coûte ~10k tokens de contexte par session, qu'on ne veut payer que là où on utilise Obsidian. Détail pas à pas : section Install du [README](../../README.md).

## Le vault de référence — le modèle de tous les autres

**Le besoin.** Chaque nouveau vault a besoin du même socle : plugins (Local REST API, bridge, Smart Connections, Templater), snippets CSS, docs racine. Le refaire à la main à chaque vault ne passe pas à l'échelle.

**Ce que ça fait.** Un vault spécial enregistré comme **référence** détient le jeu canonique de plugins et de config ; `setup-vault.mjs` le clone dans chaque nouveau vault. Bootstrap en une commande depuis le squelette livré :

```bash
node scripts/setup-vault.mjs --bootstrap-reference <chemin>
```

(scaffolde le squelette [`templates/reference-vault-skeleton/`](../../templates/reference-vault-skeleton/) et télécharge le plugin bridge). Procédure complète et dépannage : [`docs/reference-vault-setup.md`](../reference-vault-setup.md).

## `/meta-attach-vault` — le wizard de création et d'attachement

**Le besoin.** « Configure Obsidian pour ce projet » recouvre en réalité une dizaine d'étapes : créer ou choisir le vault, provisionner les plugins, scaffolder le wiki, lier le workspace, ajuster le `.gitignore`, choisir les conventions. On veut un guichet unique.

**Ce que ça fait.** Un wizard interactif qui couvre les trois scénarios — attacher un vault à un workspace de code (le cas dominant), bootstrapper un vault autonome, enregistrer un vault distant. Depuis v0.35.0, la création est **defaults-first** : le moteur calcule un plan complet par défaut, l'affiche en une ligne, et vous l'acceptez tel quel (le chemin heureux = une seule interaction) ou ajustez n'importe quel point (nom · emplacement · source du template · plugins · thème · mode wiki).

**Comment l'utiliser.**

> « configure Obsidian pour ce projet », « attache un vault à ce workspace », « connecte mon vault distant » — ou `/obsidian-router:meta-attach-vault`

**À savoir.** Le wizard fonctionne depuis **n'importe quel harness LLM**, pas seulement Claude Code : les deux outils MCP `plan_vault` (lecture seule, calcule le plan) et `provision_vault` (l'applique) sont appelables par tout agent — playbook dans [`docs/vault-wizard.md`](../vault-wizard.md). En direct au CLI : `node scripts/setup-vault.mjs "<chemin>" --dry-run --json` pour prévisualiser, puis sans `--dry-run` pour appliquer. Garde-fous : outils local-only (masqués sur les déploiements gated), chemins hors racines connues refusés — jugés sur le chemin réel, liens résolus —, secrets toujours régénérés (jamais copiés d'un vault source). Quand c'est `provision_vault` qui crée le vault, le dossier est épinglé pendant toute la création, il doit être celui que la vérification a approuvé, et la création est refusée si le dossier cible contient déjà un lien, une jonction ou un lien dur (ou un `.git` quand `gitInit` est demandé) ; sous Windows, cela demande un disque NTFS (un vault sur une lettre FAT32 ou de lecteur cloud est refusé par cet outil — le CLI, lancé à la main, n'est pas concerné).

## `scripts/setup-vault.mjs` — le couteau suisse CLI

Le script qui sous-tend le wizard est utilisable directement, avec des sous-commandes pour l'administration courante :

| Commande | Effet |
|---|---|
| `setup-vault.mjs "<chemin>"` | Bootstrapper/provisionner un vault (plugins clonés depuis la référence, `.env`, wiki, hooks). `--dry-run --json` pour prévisualiser, `--help` pour tous les flags. |
| `--bootstrap-reference <chemin>` | Créer le vault de référence depuis le squelette livré. |
| `--link-workspace <workspace> <vault>` | Associer un repo de code à un vault : enregistre la **liaison** dans `workspaceBindings` de votre `config.json` (ce qui décide) et écrit `OBSIDIAN_ROUTER_DEFAULT_VAULT` dans le `.env` du workspace (indice portable pour une autre machine). `--unlink-workspace` pour retirer. |
| `--attach <vault> [--also <autre>]` | Même chose depuis le workspace courant, secondaires compris — les `--also` n'étaient jusqu'ici connus que du `CLAUDE.md`, pas du router. Accepte aussi un vault **distant** (`remoteVaults`), avec `--local-path <dossier>` quand ses fichiers sont sur cette machine, et se termine par un **état final** vérifié (voir ci-dessous). |
| `--repair-binding <workspace>` | **Réparer** une liaison que le router ne sait plus lire, depuis un terminal — le chemin qui n'existait qu'en session MCP. `--dry-run` montre le plan et imprime un sceau ; l'application **exige** ce sceau (`--approved-plan-sha256`). Elle **garde** tout ce que l'entrée tient — secondaires, paliers locaux, verrou, champs inconnus, et l'ancien principal, rétrogradé en tête de `also`. `--primary <vault>` n'est nécessaire que si l'entrée ne nomme aucun principal liable ; `--locked` / `--no-locked` pour décider du verrou. Détail et garde-fous : [fiche 11](11-securite-et-isolation.md). |
| `--sync-all` | Propager snippets/plugins de la référence vers **tous** les vaults (idempotent ; `--force` re-clone). |
| `"<chemin>" --sync-plugins [--dry-run]` | Même chose pour un seul vault ; `--dry-run` détaille le plan plugin par plugin sans rien écrire. `--lang <code>` et `--container` : voir ci-dessous. |
| `obsidian-mcp-router --install-plugins <vault>` | Télécharger le code des plugins qu'un vault active sans l'avoir — plan scellé, voir ci-dessous. |
| `obsidian-mcp-router --plugin-health <vault> [--json]` | Dire, plugin par plugin, ce qui est sur le disque et ce qu'Obsidian a chargé. |
| `--install-hooks` / `--hooks-status` / `--no-hooks` | Gérer les hooks ([fiche 12](12-hooks-et-automatisations.md)). |
| `--status` | État des lieux (aussi : `npm run status`). |
| `--migrate-wiki-meta` | Migrer un vault ancien vers la structure `wiki-meta/` (scaffolds séparés du contenu). |

### Attacher un vault distant — jusqu'à « ready yes »

**Le besoin.** Un vault servi par un Obsidian en conteneur (image linuxserver, Local REST API sur une adresse du réseau local) dont les fichiers sont pourtant sur la machine du router. Avant, `--attach` le refusait (« not in portRegistry »), la synchro annonçait des plugins qu'elle n'avait pas installés, rien ne disait de recharger Obsidian ni d'installer le bridge, les conventions n'étaient jamais proposées, et le bloc `CLAUDE.md` affirmait qu'un `hot.md` inexistant était chargé au démarrage. Chaque étape manquante se découvrait à la main.

**Ce que ça fait.**

- `--attach <nom>` cherche d'abord le nom parmi les vaults locaux, **puis** dans `remoteVaults` (jamais à la place), et lie le workspace au vault distant. Un vault distant qui n'a pas encore de wiki est attaché avec un avertissement, pas refusé.
- `--attach <distant> --local-path <dossier-absolu>` **vérifie** que le dossier est bien ce vault : il compare le contenu d'un même fichier des deux côtés (`wiki-meta/catalog.md` d'abord, sinon une note de la racine, lue par l'API REST). S'ils diffèrent, ou si le dossier n'existe pas, la commande refuse **sans rien écrire** ; si rien ne peut être comparé, le dossier n'est pas enregistré. Vérifié, il est enregistré dans `remoteVaults[].localPath` ([`docs/remote-vaults.md`](../remote-vaults.md) dit ce que ce champ ouvre et n'ouvre pas).
- Le bloc `CLAUDE.md` ne prétend plus que `hot.md` est « auto-chargé » quand il n'existe pas, ou quand le vault est distant sans dossier local vérifié ; `--attach` le signale dans les deux cas.
- La commande se termine par **« État final / Final state »** : le vault et son type, le dossier local, le wiki (catalogue, `hot.md`), les plugins qui ont leur code parmi ceux qu'active le squelette de référence (et lesquels manquent, ou sont activés sans code), le bridge, les conventions installées et celles recommandées encore absentes. Tout cela est **lu sur le disque du vault** — le dossier d'un vault local, ou le `--local-path` vérifié d'un vault distant. Sans disque, plugins et conventions sont affichés `unknown` : la commande ne devine pas.
- S'il manque quelque chose, elle imprime les **prochaines étapes, dans l'ordre** : `--install-plugins` (scellé) → recharger Obsidian + `--plugin-health` → `/obsidian-router:wiki` → le picker de conventions. Elle n'affiche `ready yes` que lorsque plugins, wiki et conventions sont tous vérifiés.

**Comment l'utiliser.** Depuis le workspace, dans un terminal :

```bash
obsidian-mcp-router --attach "<nom>" --local-path <dossier-absolu>
```

`--local-path` seulement si les fichiers du vault sont sur cette machine (le volume d'un conteneur, par exemple). Le wizard `/meta-attach-vault` enchaîne lui-même tout le parcours distant : attach → plugins → wiki → conventions → nouvel attach, jusqu'à `ready yes`.

### Les plugins d'un vault : `--install-plugins` et `--plugin-health`

**Le besoin.** Un vault peut lister un plugin comme activé sans en avoir le code (squelette cloné sans binaires, synchro qui n'a copié que les réglages) : Obsidian n'affiche alors rien du tout. Et faire télécharger du code tiers par un agent qui improvise n'est pas acceptable.

**Ce que ça fait.**

- **`obsidian-mcp-router --plugin-health <vault> [--json] [--offline]`** — lecture seule. Par plugin : code sur le disque, activé, version et, quand l'API REST répond, chargé ou non par Obsidian (`GET /commands/`, plus une sonde de la route `/open/` du bridge). Nomme « enabled without code » et « bridge absent » avec leur remède. Code de sortie `1` quand Local REST API ou le bridge n'a pas son code ; `--offline` saute la vérification en direct.
- **`obsidian-mcp-router --install-plugins <vault> --dry-run`** — résout chaque plugin manquant (ceux que le vault active, plus Local REST API et le bridge) via le registre officiel d'Obsidian (`obsidianmd/obsidian-releases`) et la dernière release GitHub du dépôt, en suivant les dépôts renommés ou déplacés (par exemple `obsidian-style-settings`, désormais sous `community-archive/`) et en montrant où ils ont abouti. Il imprime assets, tailles et destination, puis un **sceau**. L'application exige `--approved-plan-sha256 <sceau>` et refuse si quoi que ce soit a changé entre-temps : il n'existe pas d'application sans sceau. `--only id,id` restreint la liste.
- **Garde-fous** : seuls les plugins de la liste autorisée sont téléchargés ; uniquement en HTTPS, depuis des hôtes GitHub vérifiés à **chaque** redirection ; tailles plafonnées ; l'`id` du manifeste doit correspondre. Un `main.js` existant est conservé sauf `--force` ; `data.json` n'est jamais touché. Le bridge vient de sa propre release GitHub et ne dépend donc plus de BRAT.
- Un vault distant doit avoir un `localPath` : sans lui, les deux commandes refusent et le disent.

**À savoir.** Après une installation, rechargez Obsidian (Ctrl+P → « Reload app without saving » ; dans un conteneur, la même commande dans l'interface web, ou `docker compose restart`), désactivez le mode restreint, puis relancez `--plugin-health`.

### La synchro des plugins dit ce qu'elle a vraiment fait

**Le besoin.** `--sync-plugins`, `--sync-all` et `--sync-from-github` annonçaient « Synced 4 new plugin(s) » alors que trois n'avaient reçu qu'un `data.json`, et ne disaient rien des plugins du marketplace que le squelette active sans les livrer.

**Ce que ça fait.**

- Le rapport a trois colonnes : **code installé** (`main.js` + `manifest.json` présents dans le vault après la copie), **réglages seulement (code encore à installer)**, et **activés sans code**. Les ids restent écrits dans `community-plugins.json`, pour qu'un plugin s'active dès que son code arrive — mais ils ne comptent plus comme synchronisés. Les plugins du marketplace manquants viennent avec les étapes manuelles et `obsidian-mcp-router --install-plugins <vault>`.
- Une **check-list après synchro**, adaptée au vault : recharger Obsidian (palette sur le bureau, ou interface web du conteneur / `docker compose restart`), désactiver le mode restreint, activer les plugins, lancer « Check for updates » de BRAT, vérifier avec `--plugin-health`. `--container` choisit la variante conteneur.
- `--dry-run` détaille chaque vault et chaque plugin : fichiers copiés, code ou réglages seulement, ce qui est sauté et pourquoi, ce qui est activé, ce qui reste sans code, `.smart-env` et documents racine. Nouveau : `<vault> --sync-plugins --dry-run`. Pour `--sync-from-github`, le sceau du plan couvre désormais ce plan par plugin et `--lang` ; il est vérifié après l'extraction de l'archive dans un dossier temporaire et avant de toucher le moindre vault.
- `--lang <code>` choisit le modèle d'embedding d'un `.smart-env` **créé** par la synchro : `en` garde `TaylorAI/bge-micro-v2` ; les autres langues reçoivent le multilingue `onnx-community/embeddinggemma-300m-ONNX` (`zh` : `Xenova/jina-embeddings-v2-base-zh`). Sans `--lang`, la langue que le vault déclare déjà (convention bilingue, réglages de Smart Connections) est utilisée, sinon une indication est affichée. Un `.smart-env` existant n'est jamais écrasé.
- Le `README.md` du squelette livré n'est plus copié dans les vaults (Smart Connections l'indexait comme une note de l'utilisateur). Le `README.md` d'un vault de référence à vous continue de voyager comme avant.

## Conformité des vaults — trois moments, et ce qu'ils ne couvrent pas

**Le besoin.** Un vault géré par le router porte deux artefacts *dérivés* : les projections OKF sous `wiki/` (index racine, un `index.md` par répertoire de contenu, `log.md`) et l'index BM25 local `wiki-meta/search-index.json`. Ni l'un ni l'autre n'a longtemps eu de déclencheur fiable. L'index était un opt-in que rien n'appelait — sur un vault sans Smart Connections, `search_smart` se retrouvait alors **sans aucun étage** et échouait au lieu de dégrader. Les projections, elles, ne sont rafraîchies par le middleware débouncé que sur les écritures **du router** : un répertoire créé à la main dans Obsidian les laisse dérivées jusqu'au prochain contact.

**Ce que ça fait.** Trois moments, chacun avec son périmètre.

| Moment | Qui | Effet |
|---|---|---|
| **Naissance** | `setup-vault.mjs <chemin>` (donc `provision_vault`, `--link-workspace`, la branche bootstrap de `/meta-attach-vault`) | Le vault sort du scaffolder avec ses projections **et** son `wiki-meta/search-index.json`. Sur disque, sans Obsidian ouverte. Idempotent par empreinte : re-scaffolder ne réécrit rien. |
| **Ouverture** | le plugin **bridge**, dans Obsidian | Vérifie la **présence** des fichiers de navigation quand le vault finit de charger, et affiche une Notice s'il en manque. **Détection seule** — le bridge ne génère jamais. Interrupteur par vault, **défaut OFF**. |
| **Contact** | le router, au premier appel d'outil d'une session sur un vault | Rafraîchit les projections dérivées et reconstruit l'index périmé ou absent. Une fois par session et par vault. |
| **Entretien** | le flush débouncé après écriture (~15 s) | Rafraîchit les **deux** artefacts, pas seulement les projections : sans cela l'index réparé au contact serait périmé dès la première écriture de la session et le resterait jusqu'à la session suivante. |

**L'opt-in, c'est le scaffold `wiki-meta/`.** Un vault est « géré par le router » quand il porte `wiki-meta/catalog.md` (ou `wiki-meta/index.md` sur un vault pas encore migré) — l'artefact que le provisionneur écrit. Sans lui : **aucune écriture, aucune Notice, aucun avis**. Les deux moitiés utilisent ce même signal, ce qui rend vraie la phrase de la Notice du bridge (« le routeur répare ») au lieu de simplement l'espérer.

**Déclencheurs du contact.** Seuls les outils qui **ciblent réellement un vault** (ceux dont le schéma déclare `vault`) déclenchent, **en succès comme en échec** — un `search_smart` qui échoue faute d'index est précisément l'appel qui prouve qu'il faut réparer. Sont exemptés : `build_search_index` et `refresh_okf_projections` dans les **deux** modes (un `check: true` promet « sans écrire », et un `apply` répare déjà lui-même), `plan_vault` / `provision_vault` (ils parlent d'un vault qui n'existe pas encore), `lock_vault` / `unlock_vaults`, et tout convertisseur sans cible. `list_vaults` est le cas spécial : il entretient le vault par défaut **seulement si le ping de la même réponse vient de le dire en ligne**.

**Les trous, nommés.** La couverture réelle est **l'union des quatre**, pas une garantie :

- la naissance ne concerne que les vaults **créés après** cette version ;
- l'ouverture ne **signale** rien tant que l'interrupteur du bridge n'est pas allumé, et ne répare jamais ;
- un vault sans scaffold `wiki-meta/` n'est jamais touché — c'est délibéré, et c'est aussi un trou : un vault ajouté à la main dans la config sans provisioning n'aura jamais d'index BM25 ;
- un vault qu'aucune session ne touche reste exactement dans l'état où il est.

**Ce qui n'est jamais écrasé — pour l'état observé au snapshot.** Un fichier **non marqué** posé sur un chemin de projection réservé est du contenu de quelqu'un : signalé comme conflit, laissé intact. Sur le chemin **automatique**, `wiki-meta/search-index.json` est laissé intact dans deux cas : un fichier qui ne se présente pas comme un de nos index, **et** un index d'une **autre génération de router** (deux versions qui se réécrivent mutuellement l'index à chaque session est un ping-pong qui ne converge jamais — la migration de version est un geste explicite). L'appel **explicite** de `build_search_index` garde l'ancien comportement : appeler l'outil, c'est consentir.

**Écritures conditionnelles + non-destruction (les chemins réservés).** La fenêtre entre le snapshot et l'écriture **existe et n'est pas fermable** contre un writer externe (un `PUT /vault` natif — l'écriture par défaut du router lui-même —, l'éditeur Obsidian ouvert, un apply Obsidian Sync/LiveSync) : c'est inhérent à la concurrence optimiste, et le plugin bridge le documente noir sur blanc (« Atomicity — HONEST SCOPE » dans son `vault-cas.ts`). Ce que le chemin automatique **garantit**, ce n'est pas la fermeture de la course, c'est la **non-destruction** : un contenu étranger sur un chemin réservé n'est **jamais perdu sans copie récupérable**. Trois modes, exposés dans le résultat via `protectionMode` :
- `atomic-cooperative` — le `/vault-cas` du bridge sert l'écriture ; une divergence est **refusée** (409) et le fichier étranger est laissé intact. Atomique **seulement entre écritures CAS coopératives**.
- `reduced-getcompare` (défaut sans bridge) — une **relecture tardive** décide : si c'est toujours notre projection, on régénère ; si c'est un fichier étranger, on **copie ses octets dans un sidecar horodaté unique** (`<chemin>.bak-<horodatage>[-n]`, exclu de l'index et des projections) **avant** de régénérer, et le résultat nomme le backup. La fenêtre est **réduite** (à un pas relecture→écriture), **pas fermée** : un fichier qui atterrit *strictement* entre cette relecture et l'écriture est encore écrasé — et là, s'il n'a pas pu être relu, il est perdu. C'est le sous-intervalle résiduel, prouvé par un test dédié.
- `skipped-strict` (`OBSIDIAN_ROUTER_STRICT_RESERVED_CAS=1`, sans bridge) — l'écrasement racy est **sauté** et signalé en conflit-de-capacité : zéro écrasement de fichier étranger, au prix de réparations sautées sur un backend sans CAS.

**Les DELETE ne sont jamais automatiques.** Un `index.md` généré devenu périmé (répertoire vidé) n'est **pas supprimé** au contact/flush — une suppression est irréversible. Il est reporté en `pendingDeletes` et laissé à une action explicite.

**Ce qui n'est jamais supprimé sur une erreur.** Un répertoire dont le **listing échoue** (timeout, 500) est invisible, pas vide — et un plan calculé dessus supprimerait des `index.md` parfaitement valides. Une énumération incomplète interrompt le rafraîchissement : ni écriture, ni suppression.

**Coût.** Le contact n'est pas bloquant, **sauf pour `search_smart`** : c'est le seul appel qui l'attend, une fois par vault et par session, parce qu'un `search_smart` sur un vault dérivé n'a aucun étage de recherche et échouerait sèchement. Pour tous les autres outils, la réparation part après l'appel et bénéficie au **suivant**. Un échec de réparation ne condamne pas la session : le déclencheur suivant retente, dans la limite de 3 tentatives par vault et par session.

**Un seul verrou.** Les quatre chemins de reconstruction — flush débouncé, contact, `refresh_okf_projections`, `build_search_index` — passent par le **même verrou par vault**. Il n'y a jamais deux reconstructions concurrentes du même vault dans un processus router.

**Réglages.**

| Variable | Effet |
|---|---|
| `OBSIDIAN_ROUTER_NO_AUTO_CONFORMANCE=true` | Coupe le moment « contact ». Il est de toute façon désactivé sous `OBSIDIAN_ROUTER_READONLY` (réparer, c'est écrire). |
| `OBSIDIAN_ROUTER_NO_OKF_PROJECTIONS=true` | Coupe la moitié « projections » du flush **et** du contact ; l'index BM25 reste entretenu. |
| `OBSIDIAN_ROUTER_PROJECTIONS_DEBOUNCE_MS=<ms>` | Fenêtre de débounce du flush après écriture (défaut 15 000 ms). |
| `OBSIDIAN_ROUTER_STRICT_RESERVED_CAS=true` | Sur un backend **sans** CAS bridge : saute l'écrasement racy d'un chemin réservé (conflit-de-capacité) au lieu du repli backup-puis-réécriture. Zéro écrasement de fichier étranger, au prix de réparations sautées. Défaut : repli `reduced-getcompare`. |

### Les limites — connues, assumées, non corrigées

Écrites ici plutôt que découvertes plus tard :

- **Fenêtre TOCTOU snapshot → écriture.** Un rafraîchissement énumère l'arborescence, lit les pages, calcule un plan, puis écrit. Une page créée ou supprimée *pendant* cet intervalle n'est pas dans le plan. Le résultat n'est pas corrompu — les projections sont des fonctions pures de l'arbre, donc le prochain passage corrige — mais entre les deux, un index peut décrire un arbre d'il y a trois secondes. Le sceau `approvedPlanSha256` couvre le cas où cela compte vraiment (appliquer un plan qu'on a relu), pas le chemin automatique.
- **La fenêtre sur un chemin RÉSERVÉ est réduite, pas fermée — mais la perte de données l'est.** Les écritures conditionnelles + le backup (décrits plus haut) ramènent le risque à un **sous-intervalle relecture→écriture**, et garantissent qu'un fichier étranger *vu* à la relecture est sauvegardé avant d'être écrasé. Ce qui reste ouvert : un fichier qui atterrit *strictement* dans ce sous-intervalle (après la relecture, avant l'écriture) est écrasé, et comme la relecture ne l'a pas vu, il n'est **pas** sauvegardé. Cette fenêtre résiduelle n'est **pas** proportionnelle à une durée fixe : elle dépend de la latence du vault, d'un proxy, de la charge — on ne l'affirme donc jamais « de l'ordre de la milliseconde ». Vecteur : un client de sync (Obsidian Sync, Dropbox, iCloud, LiveSync) qui pose un fichier pile à cet instant. La fermer *complètement* exigerait que **tout** writer passe par le CAS (l'éditeur Obsidian, le sync, le PUT natif ne le font pas) — structurellement hors de portée du router seul.
- **Le CREATE non-destructif DÉPEND du serveur honorant l'en-tête.** Quand un chemin réservé était *absent* au snapshot, la protection est déléguée au serveur via l'en-tête `Apply-If-Content-Preexists: false` (« crée seulement si absent, sinon 409 »). Sur un Local REST API qui **honore** l'en-tête, un fichier étranger apparu dans la fenêtre fait échouer le CREATE → conflit, fichier étranger intact. Mais sur un backend **ancien ou non conforme qui l'ignore**, le CREATE devient un PUT ordinaire : un fichier étranger apparu dans la fenêtre est **écrasé sans sidecar ni conflit**. Cette garantie-là n'est donc pas la nôtre — elle est celle du serveur ; on ne peut pas la refermer côté router sans rouvrir une autre fenêtre. À côté du sous-intervalle relecture→PUT, c'est la seconde perte possible documentée.
- **Concurrence multi-processus.** Le verrou par vault est un singleton **de processus**. Deux routers sur le même vault (deux sessions Claude, un MCPHub et un local) convergent — chacun recalcule tout depuis l'arbre — mais ne transigent pas : deux écritures peuvent se succéder là où une aurait suffi. Aucune corruption, du travail en double.
- **Deux balayages par passage.** Les projections et l'index BM25 énumèrent et relisent l'arborescence **chacun de leur côté**. C'est une dette d'optimisation assumée (un instantané partagé la rembourserait), pas un défaut de correction : le coût réel est doublé sur un gros vault.
- **« Un processus = une session ».** Le dédoublonnage « une fois par session » est en réalité « une fois par processus router ». C'est exact pour le cas nominal (Claude Code démarre un router par session) et faux pour un router long-vivant partagé : celui-là fait un passage par vault sur toute sa durée de vie, pas un par session cliente.
- **`--attach` et `--sync-plugins` n'écrivent pas dans le vault.** `--attach` ne touche que le workspace et la config du router (la liaison, et un `localPath` vérifié) ; `--sync-plugins` / `--sync-from-github` propagent des plugins et `--install-plugins` en télécharge le code dans `.obsidian/plugins/` — aucun n'écrit sous `wiki/`. Aucun n'entretient les index — c'est délibéré. **Si un futur flux de sync se met à muter `wiki/`, il devra entretenir les deux index**, sans quoi il recréera exactement la dérive que ces quatre moments existent pour absorber.

## `/meta-status` — le diagnostic

**Le besoin.** « Ça ne marche pas » a une dizaine de causes possibles : Obsidian fermé, plugin REST désactivé, clé API manquante, port changé, vault désactivé. Il faut un diagnostic qui **nomme** la cause et le remède.

**Ce que ça fait.** Pingue chaque vault configuré et rapporte en ligne/hors ligne/problème d'auth, avec une suggestion de correction **par type de problème**. Pour chaque vault dont le disque est lisible d'ici (local, ou distant avec `localPath`), il lance aussi `--plugin-health` — « l'API REST répond » ne dit pas « le vault a ses plugins » — et n'applique jamais `--install-plugins` sans que vous ayez vu et approuvé le plan. Il rapporte enfin l'état de la boîte à outils de conversion, yt-dlp compris ([fiche 5](05-conversion-de-documents.md)).

**Comment l'utiliser.**

> « diagnostique le router », « mes vaults sont-ils accessibles ? » — ou `/obsidian-router:meta-status` (aussi : `npm run status`)

## `/meta-sync-template` — propager la référence

**Le besoin.** Vous mettez à jour un plugin ou un snippet CSS dans le vault de référence : les autres vaults doivent en profiter sans re-provisionnement manuel.

**Ce que ça fait.** Un picker interactif liste chaque vault (statut en ligne, présence du plugin REST) et propage plugins/snippets/docs de la référence vers tous ou un sous-ensemble, avec `--force` pour re-cloner l'existant.

**Comment l'utiliser.**

> « synchronise le template vers tous les vaults », « pousse les plugins de référence vers X » — ou `/obsidian-router:meta-sync-template`

## `/conventions` — les règles de travail installables

**Le besoin.** Les règles qui rendent un vault agréable à vivre (bilinguisme, discipline de roadmap, hygiène du log…) doivent être **matérialisées dans le CLAUDE.md du vault** pour s'appliquer à chaque session — et être installables/désinstallables proprement, pas copiées-collées à la main.

**Ce que ça fait.** Installe, retire, liste et propage des conventions prêtes à l'emploi à travers les vaults. Le catalogue livré :

| Convention | Ce qu'elle impose |
|---|---|
| `source-type` | Chaque page déclare l'origine de son contenu (source primaire, inféré…). |
| `languages` | Les langues du vault, déclarées par vault (`fr` ; `fr, en`…) : une seule → tout dans cette langue, quelle que soit la conversation ; plusieurs → une section par langue. Remplace `bilingual` (retirée le 2026-09-26, encore reconnue pour la migration). |
| `heading-hierarchy` | Hiérarchie de titres propre (pas de sauts de niveaux). |
| `claim-citations` | Les affirmations citent leurs sources. |
| `roadmap-discipline` | Roadmaps dans le vault, checkboxes cochées au ship, jamais de texte barré sur les items livrés. |
| `log-discipline` | `journal.md` = index mince ; le détail va dans `Sessions/`. |
| `wiki-query-first` | Consulter le wiki avant de répondre. |
| `path-disambiguation` | Ne jamais mélanger chemin du workspace et chemin du vault. |
| `default-vault-health-check` | Vérifier que le vault par défaut est joignable en début de session. |
| `auto-enrichment` | La consigne d'auto-enrichissement ([fiche 7](07-wiki-gestion-de-connaissances.md)). |
| `tribu-routing` | Routage par membre dans un vault familial. |

**Comment l'utiliser.**

> « installe la convention source-type sur smile », « quelles conventions sont actives sur ce vault ? », « propage source-type à tous les vaults » — ou `/obsidian-router:conventions`

**À savoir.** L'installation passe par l'outil MCP `install_conventions({ vault, ids, dryRun? })` : **une seule écriture** pour plusieurs conventions, nommées par leur id. Les textes sont lus côté serveur dans le paquet — le modèle ne les recopie plus dans ses appels. Le fichier de conventions est résolu par REST (deux candidats présents : refus ; aucun : `CLAUDE.md` est créé). Une convention déjà présente est sautée (`alreadyPresent`), un id inconnu signalé (`unknown`). L'écriture est un compare-and-swap sur les octets lus, donc elle fonctionne sur un vault partagé (`writesRequireIfMatch`), là où l'ancien ajout par `append_to_file` était refusé ; un 409 dit de relancer. Le fichier est relu après écriture : `verified: true` signifie que chaque convention demandée y figure exactement une fois ; `satisfied: false` signale qu'un id nommé était inconnu ou retiré (`retired`, ex. `bilingual`) et n'a donc pas été installé. La convention `languages` porte la valeur du vault : `languages: ["fr", "en"]` est obligatoire pour l'installer (refus avant toute I/O sinon), et `vaultLanguages` dit ce que le fichier déclare. Le mode de l'écriture est dit : `casMode: "atomic"` quand le bridge expose sa route de compare-and-swap ; `"fallback"` sinon — le routeur relit le fichier, compare son hash, puis écrit : une écriture concurrente entre ces deux appels n'est pas exclue, et un vault qui exige l'atomicité doit avoir le bridge. `dryRun: true` avec `ids: []` renvoie la bibliothèque (conventions retirées marquées `retired: true`) et ce qui est détecté. `/meta-attach-vault` et `/obsidian-router:wiki` proposent désormais le picker, pré-coché, à la fin d'un attachement ou d'une création de wiki.

## Mises à jour — `check-router-update` et `/plugin update`

**Le besoin.** Savoir qu'une nouvelle version existe, et l'installer sans casser son setup.

**Ce que ça fait.** Le hook de vérification quotidienne ([fiche 12](12-hooks-et-automatisations.md)) vous prévient en début de session. La mise à jour elle-même : `/plugin update obsidian-router@obsidian-mcp-router-marketplace` quand l'environnement l'expose ; sinon la procédure manuelle en 5 étapes (recettes bash + PowerShell) est dans [`docs/how-to-update.md`](../how-to-update.md).

## `gen-obsidian-deploy` — générer un déploiement serveur

**Le besoin.** Faire tourner un vault en container sur un serveur (LiveSync + API REST + GUI navigateur) demande un docker-compose, un bloc nginx et une ligne de config router **cohérents entre eux** — l'erreur de copier-coller est vite arrivée.

**Ce que ça fait.** Génère les trois d'un coup :

```bash
node scripts/gen-obsidian-deploy.mjs --name tribu --rest-port 27145 --mode wg --wg-host 10.8.0.1
```

Trois modes de réseau : `wg` (WireGuard uniquement — pour le sensible/médical), `lan`, `public` (HTTPS + bearer ; **refusé** pour un vault `--sensitive`). La ligne `VAULT_*` émise est testée en aller-retour contre le parseur du router — elle ne peut pas dériver. Les secrets sont des placeholders, jamais inventés. Runbook complet (dont onboarding LiveSync) : [`deploy/dedibox-obsidian/`](../../deploy/dedibox-obsidian/).

## Construire ses propres macros

**Le besoin.** Les commandes du plugin sont volontairement **agnostiques** — elles marchent pour n'importe quel vault. Vos rituels à vous (daily note, inbox de capture, rollup hebdo) méritent leurs propres commandes.

**Ce que ça fait.** Le patron pour bâtir des slash commands personnelles dans `~/.claude/commands/` qui chaînent les outils du router avec vos conventions, sans forker le projet. Guide et trois exemples de départ : [`docs/building-commands.md`](../building-commands.md).

## Les PDF de référence rapide

Toute la surface du produit — vue d'ensemble, setup, config, chaque slash command avec ses phrases déclencheuses — condensée en 5 pages imprimables : [français](../quick-reference-fr.pdf) · [anglais](../quick-reference-en.pdf).
