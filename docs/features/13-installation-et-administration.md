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

**À savoir.** Le wizard fonctionne depuis **n'importe quel harness LLM**, pas seulement Claude Code : les deux outils MCP `plan_vault` (lecture seule, calcule le plan) et `provision_vault` (l'applique) sont appelables par tout agent — playbook dans [`docs/vault-wizard.md`](../vault-wizard.md). En direct au CLI : `node scripts/setup-vault.mjs "<chemin>" --dry-run --json` pour prévisualiser, puis sans `--dry-run` pour appliquer. Garde-fous : outils local-only (masqués sur les déploiements gated), chemins hors racines connues refusés, secrets toujours régénérés (jamais copiés d'un vault source).

## `scripts/setup-vault.mjs` — le couteau suisse CLI

Le script qui sous-tend le wizard est utilisable directement, avec des sous-commandes pour l'administration courante :

| Commande | Effet |
|---|---|
| `setup-vault.mjs "<chemin>"` | Bootstrapper/provisionner un vault (plugins clonés depuis la référence, `.env`, wiki, hooks). `--dry-run --json` pour prévisualiser, `--help` pour tous les flags. |
| `--bootstrap-reference <chemin>` | Créer le vault de référence depuis le squelette livré. |
| `--link-workspace <workspace> <vault>` | Associer un repo de code à un vault (écrit `OBSIDIAN_ROUTER_DEFAULT_VAULT` dans le `.env` du workspace — le mode « workspace-bound »). `--unlink-workspace` pour retirer. |
| `--sync-all` | Propager snippets/plugins de la référence vers **tous** les vaults (idempotent ; `--force` re-clone). |
| `--install-hooks` / `--hooks-status` / `--no-hooks` | Gérer les hooks ([fiche 12](12-hooks-et-automatisations.md)). |
| `--status` | État des lieux (aussi : `npm run status`). |
| `--migrate-wiki-meta` | Migrer un vault ancien vers la structure `wiki-meta/` (scaffolds séparés du contenu). |

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
- **`--attach` et `--sync-plugins` n'écrivent pas dans le vault.** `--attach` ne touche que le workspace ; `--sync-plugins` / `--sync-from-github` propagent des plugins. Aucun n'entretient les index — c'est délibéré. **Si un futur flux de sync se met à muter `wiki/`, il devra entretenir les deux index**, sans quoi il recréera exactement la dérive que ces quatre moments existent pour absorber.

## `/meta-status` — le diagnostic

**Le besoin.** « Ça ne marche pas » a une dizaine de causes possibles : Obsidian fermé, plugin REST désactivé, clé API manquante, port changé, vault désactivé. Il faut un diagnostic qui **nomme** la cause et le remède.

**Ce que ça fait.** Pingue chaque vault configuré et rapporte en ligne/hors ligne/problème d'auth, avec une suggestion de correction **par type de problème**.

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
| `bilingual` | Pages substantielles FR + EN. |
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
