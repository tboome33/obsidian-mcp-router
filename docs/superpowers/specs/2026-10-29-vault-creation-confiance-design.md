# Créer, enregistrer et faire confiance à un vault sans aucune commande — cahier des charges

- **Statut :** proposition, version 5, à relire par Roland. Rien n'est implémenté. La phase S0 des skills (§4.10) est
  faite : décisions D9 à D12 tranchées, deux mesures faites, contrats fixés.
- **Historique :**
  - v1 du 2026-10-29 ;
  - v2 du même jour, avec les réponses de Roland sur E1 à E4 ;
  - v3 du 2026-10-30 : les vaults tiers, une seule question « de confiance ou tiers ? », et le wizard possible dans le
    chat comme dans le panneau ;
  - v4 du 2026-10-30 : scan obligatoire d'un vault tiers par REA et SkillSpector plus une relecture par IA (E5), et
    les skills apportés par un vault, détectés, scannés et activables par workspace depuis la tuile du vault (E6,
    §4.8) ;
  - v5 du 2026-10-30 : phase S0 des skills. Roland tranche D9 à D12 (les quatre recommandations) ; mesures du
    rechargement des skills par Claude Code et du dossier courant du routeur ; contrats d'empreinte, de plafonds, de
    demande signée et de machine d'états (§4.10), revus par Codex en lecture seule en 7 tours (rejet aux tours 1 à
    4 et 6, acceptation aux tours 5 et 7 ; 39 constats nouveaux traités en tout : 12, 10, 7, 5, 3, 2, puis 0). Deux décisions nouvelles : D14 et D15.
    La spec est désormais suivie par git, sur la branche des skills.
- **Origine :** l'ajout de LihFolk Vault V1 au conteneur `obsidian-commun` (28/10). Il a demandé un compose modifié à la
  main, un clic « Faire confiance » dans la fenêtre, des étapes root reportées, et deux scripts pour le PC de Nicolas.
- **Convention :** un fait marqué « vérifié » a été lu dans le code, ou sur la page d'Obsidian citée, le 2026-10-29 ou
  le 2026-10-30. Tout le reste est marqué **À VÉRIFIER** et fait partie de la phase 0.

## 1. Ce que Roland demande

| # | Exigence |
|---|---|
| E1 | **Créer** un vault depuis le modèle du routeur, avec les plugins du squelette. Tous les plugins sont connus, donc la confiance est accordée sans question. La création se fait **en local** (PC) ou **à distance** (conteneur Obsidian), et le vault est enregistré dans le routeur à la fin. |
| E2 | **Enregistrer un vault existant.** Le wizard demande d'abord s'il s'agit d'un **vault de confiance** ou d'un **vault tiers**, et explique les deux (§2). |
| E2a | **Vault tiers :** il reste en **mode restreint**, et le wizard prévient des risques. Si l'utilisateur sort du mode restreint, **seul le plugin Local REST API with MCP est actif par défaut**. Les autres ne s'activent qu'à la main, un par un. |
| E2b | **Vault de confiance :** le wizard rappelle la condition, « aucun plugin tiers non vérifié ». Le vault n'est enregistré comme vault de confiance que si elle est remplie. |
| E3 | Chaque parcours se lance **par une slash command, en langage naturel, ou depuis le panneau des vaults** (mod Claude, barre latérale droite). Le wizard peut s'afficher **dans le chat ou dans le panneau** : les deux doivent être possibles. |
| E4 | L'utilisateur ne tape **aucune commande** de terminal : ni permission, ni script de configuration, ni clé à copier. |
| E5 | **Un vault tiers est scanné avant tout enregistrement.** Le scan est obligatoire et complet : REA pour le code des plugins, SkillSpector pour les skills, puis une **relecture par IA** de tout ce qui a été analysé et de ce que les deux outils ont signalé. Si REA ou SkillSpector manque, le wizard s'arrête et explique comment l'installer : sans eux, ni import ni enregistrement. |
| E6 | **Les skills d'un vault sont détectés, scannés, et activables par workspace.** La tuile du vault montre par un indicateur que le vault contient des skills. Une icône ouvre leur liste, avec leur contenu et le résultat du scan. Chaque skill s'active ou se désactive pour le workspace auquel le vault est lié ; activé, il est injecté dans ce workspace (§4.8). |

Une décision qui contredit l'une de ces exigences est fausse.

**Le mode restreint n'est pas une protection** (Roland, 2026-10-30). On en sort toujours, sinon le vault ne sert à rien.
La protection d'un vault tiers vient donc du scan fait **avant** l'enregistrement (E5). Le mode restreint d'E2a ne sert
plus que de salle d'attente pendant ce scan.

**Vocabulaire.** On dit **vault tiers**, jamais « vault externe » : « externe » se confondait avec « vault distant »
(dans un conteneur). Les deux notions sont indépendantes : un vault local peut être tiers, un vault distant peut être de
confiance.

## 2. Vault de confiance, vault tiers : les définitions montrées à l'utilisateur

Le wizard affiche ces définitions au moment de la question, mot pour mot ou presque.

### 2.1 Ce que dit Obsidian (vérifié le 2026-10-30, https://obsidian.md/help/plugin-security)

- Obsidian **ne peut pas limiter les droits** d'un plugin. Un plugin a les mêmes droits qu'Obsidian : il peut lire et
  modifier les fichiers de l'ordinateur, se connecter à Internet et installer d'autres programmes.
- Les plugins de **l'annuaire communautaire officiel** respectent les règles des développeurs d'Obsidian. Obsidian
  **analyse automatiquement chaque version** (failles, qualité du code, logiciels malveillants). La **relecture
  humaine** ne continue que pour les plugins populaires, mis en avant ou signalés. Obsidian recommande malgré tout un
  audit de sécurité indépendant avant d'utiliser un plugin.
- Par défaut, Obsidian est en **mode restreint** : aucun code tiers ne s'exécute. Les plugins installés restent dans le
  vault, mais Obsidian les ignore.
- **Non dit par ces pages :** si les plugins installés **hors de l'annuaire** (copie à la main, BRAT, plugin fait
  maison) sont analysés. On considère donc qu'ils ne le sont pas.

### 2.2 Trois niveaux de plugins

| Niveau | Ce que c'est | Ce qu'on en sait |
|---|---|---|
| **Vérifié** | Un plugin du squelette du routeur, avec l'empreinte exacte enregistrée dans le catalogue (§4.4), ou un plugin que Roland a déclaré de confiance et dont l'empreinte est enregistrée. | On sait exactement quel code tourne. |
| **De l'annuaire** | Un plugin de l'annuaire officiel d'Obsidian, mais pas dans notre catalogue, ou dans une autre version. | Analysé automatiquement par Obsidian, rarement relu par un humain. |
| **Hors annuaire** | Un plugin absent de l'annuaire officiel : fait maison, installé par BRAT, copié à la main. | Personne ne l'a vérifié. C'est le niveau dont il faut se méfier. |

**Point à noter :** le squelette contient lui-même BRAT (`obsidian42-brat`), qui sert justement à installer des plugins
hors annuaire. Voir la décision D8.

### 2.3 Les deux sortes de vaults

> **Vault de confiance.** Un vault créé avec le modèle du routeur, ou qui ne contient que des plugins **vérifiés** :
> ceux du modèle, et éventuellement des plugins que vous avez vous-même déclarés de confiance. Le routeur le contrôle :
> un seul plugin non vérifié, et le vault ne peut pas être enregistré comme vault de confiance.
>
> **Vault tiers.** Un vault qui contient au moins un plugin que le routeur ne connaît pas : récupéré chez quelqu'un
> d'autre, téléchargé, ou d'origine inconnue. Ses plugins peuvent faire n'importe quoi sur la machine qui l'ouvre. Il
> reste en mode restreint. Si vous en sortez, seul Local REST API s'active, et les autres plugins attendent que vous
> les activiez vous-même, un par un.

## 3. Ce qui existe déjà (vérifié dans le code)

| Brique | Où | Ce qu'elle fait | Limite pour E1 à E4 |
|---|---|---|---|
| `plan_vault` / `provision_vault` | `src/index.mjs`, `scripts/setup-vault.mjs` | Crée un vault **local** depuis le squelette : plugins, port et clé neufs, liaison au workspace, test de l'API (`probe`). Le plan est scellé (`approvedPlanSha256`). | Le test reste rouge tant que personne n'a cliqué sur « Trust author and enable plugins ». Aucune création à distance. |
| Squelette | `templates/reference-vault-skeleton/.obsidian/` | `community-plugins.json` liste 13 plugins, dont les deux obligatoires `obsidian-local-rest-api` et `mcp-router-bridge` (`REQUIRED_PLUGINS`). | Seuls 4 dossiers de plugins sont présents dans `plugins/`. Les autres sont téléchargés ou copiés à la création : **À VÉRIFIER** d'où ils viennent. |
| `register_remote_vault` | `src/index.mjs` | Écrit une entrée `remoteVaults` dans la config du routeur. | La clé `apiKey` doit être passée en argument, donc par la conversation. |
| `unregister_vault` | `src/index.mjs` | Retire un vault de la config. | — |
| Panneau des vaults | `hooks/vault-panel/` | Mod de la barre latérale droite. A déjà une entrée « + Ajouter un vault » (`add.open`, `nav.add`). | Ne crée pas de vault et ne sait rien de la confiance. |
| `/obsidian-router:meta-attach-vault` | `commands/meta-attach-vault.md` | Wizard en conversation pour rattacher ou créer un vault local. | Local seulement, sans contrôle des plugins. |
| `add-vault.sh` | `docs/deploy/remote-vault/` | Déploie un vault dans **son propre** conteneur : compose, `.env`, règles `DOCKER-USER`. | À lancer en root sur le serveur. Ne connaît pas le conteneur commun à plusieurs fenêtres. Le clic de confiance reste manuel. |
| view-agent | `view-agent/` | Service sur la Dedibox, joignable par WireGuard, qui fabrique les liens d'ouverture. | Modèle à suivre pour un agent serveur à actions limitées. |

## 4. Architecture proposée

### 4.1 Un seul wizard, deux affichages

Le wizard est écrit **une seule fois**, sous forme de données : une suite d'étapes, chacune avec son texte, ses choix,
ses avertissements et l'appel au routeur qu'elle déclenche. Ces données vivent dans le routeur et sont servies par un
outil MCP (nom provisoire `vault_wizard`), qui reçoit les réponses déjà données et renvoie l'étape suivante.

Deux affichages lisent ces mêmes données :

- **Dans le chat :** la slash command ou le skill appelle `vault_wizard`, et Claude pose les questions dans la
  conversation. Claude peut expliquer et répondre à une question imprévue, mais il ne peut ni sauter une étape ni
  changer un avertissement : c'est l'outil qui décide de l'étape suivante.
- **Dans le panneau :** le mod appelle le même outil et dessine chaque étape comme un écran : texte, choix, boutons
  « Suivant » et « Annuler ».

**Le choix entre les deux** (décision D1) : le panneau propose « continuer dans le chat » à chaque étape, et le chat
propose « ouvrir dans le panneau ». Comme l'état du wizard est gardé par le routeur, on peut passer de l'un à l'autre en
cours de route sans rien perdre.

**Pourquoi un seul wizard :** si le chat et le panneau avaient chacun leur propre version, un avertissement corrigé
d'un côté resterait faux de l'autre. Ici, un test vérifie que les deux affichages montrent les mêmes étapes, dans le
même ordre et avec les mêmes textes.

### 4.2 Points d'entrée

| Porte | E1 — créer | E2 — enregistrer un vault existant |
|---|---|---|
| Panneau | bouton « + Nouveau vault » | bouton « + Ajouter un vault » |
| Slash command | `/obsidian-router:vault-new` | `/obsidian-router:vault-add` |
| Langage naturel | « crée un vault Recettes » | « ajoute le vault que Nicolas a déposé », « enregistre mon vault Y » |

Les noms des commandes sont provisoires. E2 n'a plus qu'une porte : la question « de confiance ou tiers ? » est posée
dans le wizard, pas dans le choix du bouton.

### 4.3 Un agent de vaults sur chaque hôte de conteneurs

Le routeur tourne sur le PC et ne détient **jamais** d'accès root. Les actions qui demandent des droits sur le serveur
sont confiées à un **agent de vaults** (`vault-agent`), installé une seule fois sur l'hôte. Claude fait cette
installation avec l'accord de Roland, par la procédure SSH existante. Ensuite, plus personne n'a de commande à lancer.

- **Écoute :** WireGuard seulement, comme le view-agent. Authentification par un jeton propre à l'agent, distinct des
  clés des vaults.
- **Actions fermées :** une liste courte, sans commande libre ni chemin libre.
  - `create_vault(name, template_version)` : copie le squelette dans la racine des vaults ;
  - `open_window(name, mode)` : ouvre le vault dans une **nouvelle** fenêtre du conteneur commun, sans jamais
    réutiliser une fenêtre existante. `mode` vaut `trusted` ou `restricted` ;
  - `inspect_plugins(name)` : renvoie la liste des plugins et leurs empreintes (§4.5) ;
  - `trust(name, enabled_plugins)` : sort du mode restreint en n'activant que la liste donnée (§4.6) ;
  - `issue_key(name)` : renvoie l'adresse et la clé de l'API au routeur, par le canal authentifié ;
  - `firewall_sync()` : pose les règles `DOCKER-USER` du nouveau port.
- **Privilèges :** décision D3 (§7).
- **Journal :** chaque action est tracée avec qui l'a demandée, quand et le résultat. Les clés n'y figurent jamais.

### 4.4 Le catalogue des plugins vérifiés

Le catalogue est versionné dans `contracts/` et a deux parties :

- **Le squelette :** identifiant, version, et empreinte SHA-256 de `main.js` et de `manifest.json`. Il est calculé
  depuis le squelette à chaque release, et `npm run validate` échoue s'il ne correspond plus.
- **Les ajouts de Roland :** les plugins qu'il déclare de confiance, chacun avec son empreinte. Ils sont rangés dans la
  config du routeur, pas dans le dépôt, car ils sont propres à son installation. Le wizard propose cet ajout seulement
  après avoir montré le niveau du plugin (§2.2). Il ne le propose jamais pour un plugin hors annuaire sans un second
  avertissement.

### 4.5 Le contrôle des plugins d'un vault

`inspect_plugins` (à distance) ou une lecture locale renvoie, pour chaque plugin présent dans `.obsidian/plugins/` :
son identifiant, son auteur, sa version, son dépôt (lus dans `manifest.json`), son empreinte, s'il est listé comme
actif, et son niveau (§2.2).

Pour classer un plugin **de l'annuaire** ou **hors annuaire**, le routeur compare son identifiant à la liste publique
de l'annuaire d'Obsidian (`community-plugins.json` du dépôt `obsidianmd/obsidian-releases`). **À VÉRIFIER :** un
identifiant présent dans l'annuaire ne prouve pas que le code installé est celui de l'annuaire. Seule une comparaison
avec l'empreinte de la release GitHub officielle le prouve (décision D4).

**Écart à la règle « jamais le disque » :** cette lecture a lieu avant que l'API du vault tourne. Elle est limitée à
`.obsidian/community-plugins.json` et `.obsidian/plugins/*/{manifest.json,main.js}`, en lecture seule, jamais les
notes. L'exception doit être écrite dans `AGENTS.md` et dans le skill concerné, sinon elle n'est pas autorisée.

### 4.6 La confiance et le mode restreint

**Hypothèse à vérifier avant tout le reste (phase 0) :** le choix « faire confiance à ce vault » n'est pas dans un
fichier du vault. Il serait rangé dans le `localStorage` d'Obsidian, sous une clé du type `enable-plugin-<appId>`,
dans le profil Electron. `community-plugins.json`, lui, dit seulement *quels* plugins sont actifs une fois la confiance
accordée. Si l'hypothèse est fausse, cette section est à refaire.

Le routeur sait donc faire deux gestes distincts :

1. **Choisir les plugins actifs.** Il écrit `community-plugins.json` **avant** d'accorder la confiance. Un plugin
   absent de cette liste ne s'exécute jamais, même hors du mode restreint.
2. **Accorder la confiance**, c'est-à-dire sortir du mode restreint :
   - **Dans un conteneur :** l'agent lance Obsidian avec `--remote-debugging-port`, joignable **uniquement à
     l'intérieur du conteneur**. Il écrit la clé de confiance pour le nouveau vault seul, puis recharge **sa fenêtre
     seulement**. Les autres vaults ne sont pas interrompus.
   - **Sur le PC :** décision D2 (§7).

**Interdit :** publier le port de débogage hors du conteneur, ou l'ouvrir sur le WireGuard. Il donne le contrôle total
d'Obsidian, donc de tous les vaults de l'instance.

**Conséquence à afficher dans le wizard :** en mode restreint, aucun plugin ne tourne, Local REST API compris. Un vault
tiers resté en mode restreint est donc enregistré mais **injoignable** par le routeur (`offline`).

### 4.7 Récupération de la clé sans passer par le chat

Les parcours finissent par `issue_key` (à distance) ou par la lecture du `data.json` de Local REST API (sur le PC). La
clé va directement dans la config du routeur. Elle n'apparaît jamais dans un argument d'outil, une réponse, un écran du
panneau ni un journal. `register_remote_vault` reçoit une variante sans `apiKey`, qui délègue la récupération de la
clé.

### 4.8 Les skills et les consignes apportés par un vault

**Pourquoi.** Un vault n'apporte pas que des notes et des plugins. LihFolk Vault V1 (examiné le 2026-10-30) contient
16 skills dans `.claude/skills/`, des copies dans `31 AI Skills for Roblox/`, un `CLAUDE.md` et un `AGENTS.md`
identiques qui disent à l'IA d'utiliser le vault « de sa propre initiative », et des `.txt` qui invitent à lancer un
installateur. Aujourd'hui, quand on passe par le routeur, **rien de cela n'est pris en compte** : Claude Code ne charge
les skills que depuis le disque, dans le dossier où il est lancé (vérifié pour le cas courant ; le cas d'un vault
rangé dans un sous-dossier du workspace est **À VÉRIFIER**). C'est sûr, mais un bon vault ne peut pas apporter ses
skills. Le §4.8 comble ce manque sans perdre le contrôle.

**1. Détecter.** À l'enregistrement, puis à chaque démarrage de session, le routeur fait l'inventaire du vault :
- les skills : tout dossier contenant un `SKILL.md`, d'abord sous `.claude/skills/`, puis ailleurs dans le vault ;
- les fichiers de consignes : `CLAUDE.md`, `AGENTS.md` et les autres fichiers d'instructions pour agents à la racine ;
- pour chacun : nom, description (frontmatter), liste des fichiers, et une **empreinte** SHA-256 calculée sur le
  dossier entier, pas seulement sur `SKILL.md`.

**Le chemin : une route du bridge.** L'API REST ne sert pas les dossiers qui commencent par un point (vérifié le
2026-10-30 dans le code du bridge, `src/handlers/smart-env-core.mjs` : c'est la raison d'être de sa route
`GET /smart-env/sources`, qui lit `.smart-env/multi/` par `vault.adapter`). Le plugin **MCP Router Bridge**
(`tboome33/obsidian-mcp-router-bridge`, v0.10.0) reçoit donc une route sur le même modèle :

- `GET /mcp-router-bridge/skills` : liste des skills de `.claude/skills/`, avec pour chacun le nom, la description, la
  liste des fichiers, leur contenu et leur empreinte SHA-256 ; plus les fichiers de consignes de la racine ;
- **lecture seule**, protégée par la clé de l'API comme la lecture des notes (pas une route sans clé comme `/open`) ;
- **un seul dossier caché nommé dans le code**, `.claude/skills/`, comme `.smart-env/multi/` pour la route existante.
  Pas de route générale « lire un fichier caché » : c'est la règle que le bridge s'est déjà donnée ;
- un plafond d'octets lus par requête, comme la route existante, puisque le code tourne dans l'interface d'Obsidian.

Ce chemin marche à l'identique pour un vault local et un vault du conteneur : pas besoin d'action de l'agent, ni de
lecture du disque.

**Le routeur ne croit pas le bridge sur parole.** Il recalcule lui-même l'empreinte de chaque fichier à partir du
contenu reçu. Et dans un vault tiers, le bridge présent dans le vault n'est utilisé que si son empreinte est celle du
catalogue (décision D5) : un bridge modifié pourrait cacher un skill.

**Dans Obsidian aussi.** Le bridge affiche les skills du vault dans son onglet de réglages : nom, description, contenu,
empreinte, verdict du scan, et les interrupteurs par workspace lié. Les interrupteurs existent donc à **trois
endroits** : le panneau du mod, le chat, et les réglages du bridge (décision D13, tranchée).

**2. Scanner.** Chaque skill trouvé passe par le scan d'E5 :
- SkillSpector sur le dossier du skill ;
- la relecture par IA de **chaque fichier en entier**, et de chaque alerte de SkillSpector. La relecture de LihFolk a
  trouvé deux points que l'analyse automatique avait manqués : `obsidian-cli` apprend à Claude à exécuter du
  JavaScript dans Obsidian (`obsidian eval`), et les skills Roblox font lire des dizaines de notes, dont le texte devient
  une consigne pour Claude ;
- les **notes que le skill fait lire** (sa liste « Read these vault notes ») et les fichiers de consignes de la racine,
  à la recherche d'instructions piégées (portée : décision D11) ;
- le résultat est une **fiche par skill** : ce qu'il fait, ce qu'il touche (commandes, réseau, installations, fichiers
  hors du vault), les alertes, un verdict, la date du scan et l'empreinte scannée.

Un skill est classé **à risque** quand il fait exécuter du code (`eval`, scripts), installe quelque chose (`npm install`
sans version fixée, par exemple), modifie la configuration de Claude, ou agit sans qu'on le lui demande. Un skill à
risque demande une seconde confirmation pour être activé.

**3. Montrer, dans la tuile du vault** (panneau des vaults) :
- un **indicateur** quand le vault contient des skills : leur nombre, et une couleur selon l'état le plus grave (scanné
  sans alerte, alertes, à risque, pas encore scanné, modifié depuis le scan) ;
- une **icône** qui ouvre la liste des skills. Pour chacun : nom, description, verdict, la fiche du scan, et le
  **contenu complet** de ses fichiers, en lecture seule ;
- un **interrupteur par skill**, pour le workspace auquel le vault est lié. Tous sont **désactivés** au départ ;
- la même liste, en lecture seule, pour les fichiers de consignes de la racine. Ils ne sont jamais injectés : ils sont
  montrés pour que l'utilisateur sache ce que le vault demanderait à une IA ouverte dans son dossier.

La liste est aussi accessible dans le chat (E3), par une slash command ou en langage naturel, avec les mêmes données.

**4. Injecter.** Activer un skill le copie dans `.claude/skills/` du workspace lié (emplacement : décision D9) :
- sous un nom préfixé par le vault (`lihfolk--roblox-debugging`), pour ne jamais écraser un skill existant ;
- avec un manifeste du routeur (`.claude/skills/.vault-skills.json`) qui note, pour chaque copie : vault d'origine,
  chemin source, empreinte approuvée, date, verdict du scan ;
- adapté pour lire le vault **par le routeur** et non par le disque (décision D10) ;
- un skill **déjà injecté qui change dans le vault** n'est pas mis à jour en silence (décision D12).

Désactiver supprime la copie et sa ligne du manifeste. Le routeur ne touche jamais un skill du workspace qu'il n'a pas
injecté lui-même : seules les entrées du manifeste lui appartiennent. Délier le vault du workspace propose de retirer
ses skills.

**Mesuré le 2026-10-30 (§4.10.1) :** Claude Code prend en compte un skill ajouté ou retiré pendant la session,
**à condition** que `.claude/skills/` ait existé au démarrage de la session. Sinon, il faut relancer. La tuile affiche
« actif » ou « actif au prochain démarrage » selon ce cas.

**Ce que le routeur ne fait jamais :** lancer l'installateur d'un vault (`install-ai.ps1`…), écrire dans le dossier
personnel `~/.claude/` ou dans le `CLAUDE.md` global, installer l'outil qu'un skill réclame (`npm install -g knap`).
Si un skill a besoin d'un outil, la fiche le dit ; son installation reste une décision séparée, à une version fixée.

### 4.9 Amendements après la revue Codex du 2026-10-30 (skills, livrés en premier)

Roland veut livrer les skills **avant** le reste de la spec. Codex (lecture seule, 16 constats, rapport dans la session
du 2026-10-30) a relevé ce qui ne tenait pas dans ce cas. Ces points sont normatifs et priment sur §4.8 en cas d'écart.

1. **Périmètre de la première livraison.** Seulement les vaults **déjà enregistrés et joignables**, dont l'API REST et
   le bridge répondent. Pas d'enregistrement, pas de changement de confiance, pas de scan REA des plugins, pas
   d'agent de vaults, pas de `issue_key`. **Approuver des skills ne vaut pas conformité à E5** : la fiche le dit.
2. **Le workspace visé** est celui du processus routeur courant (son `process.cwd()`, `src/registry.mjs:744`) avec sa
   liaison confirmée (`src/helpers/workspace-bindings.mjs:265`). Le routeur refuse tout chemin de destination fourni
   par l'appelant. Comportement défini pour : vault primaire, secondaire, secondaire en pause (refus), workspace non
   lié (refus), routeur distant (refus : il ne peut pas écrire dans le workspace du client).
3. **Qui scanne.** Le routeur n'a ni client SkillSpector ni modèle de langage. L'orchestration revient à **l'assistant
   hôte** (Claude) : le routeur prend un **instantané en quarantaine** (copie hors du workspace, hors de tout dossier de
   skills), l'assistant appelle SkillSpector et fait la relecture dans un **sous-agent isolé** qui traite le contenu
   comme une donnée, puis le routeur enregistre le rapport, lié à l'empreinte de l'instantané. Un clic dans le panneau
   ou dans Obsidian sur un skill pas encore scanné le met en « scan à faire », lancé à la prochaine session de chat.
   SkillSpector absent ou modèle indisponible : refus d'approuver, avec le moyen d'installer (E5).
4. **Où vit l'accord.** Dans la configuration de l'utilisateur (à côté de `config.json`, comme les liaisons), jamais
   dans le projet : un workspace cloné peut arriver avec un faux manifeste. Le `.vault-skills.json` du workspace n'est
   qu'un **reçu**. Le routeur ne retire un skill que s'il figure dans le registre utilisateur **et** que le contenu
   installé a l'empreinte enregistrée ; un reçu sans entrée au registre est ignoré.
5. **Découverte, première livraison.** Seulement `.claude/skills/*/SKILL.md` (route du bridge) et les fichiers de
   consignes de la racine (`CLAUDE.md`, `AGENTS.md`, lus par l'API REST). Les copies ailleurs dans le vault (comme
   `31 AI Skills for Roblox/skills/`) sont signalées, pas proposées. L'inventaire distingue : vide, bridge trop ancien,
   vault hors ligne, inventaire incomplet (non approuvable).
6. **Copie confinée.** Identifiants de dossier générés par le routeur ; chaque chemin relatif validé (pas d'absolu, de
   lecteur, d'UNC, de `..`, de flux alternatifs Windows, de collision de casse) ; liens symboliques, jonctions et
   fichiers spéciaux refusés ; confinement réel vérifié côté source et destination ; création sans écrasement,
   préparation dans un dossier temporaire puis mise en place atomique. On copie **exactement** l'inventaire approuvé,
   scripts compris, et on n'exécute rien, ni au scan ni à l'installation.
7. **D9 précisée.** L'entrée `.gitignore` est explicitement autorisée et ne couvre que le dossier géré par le routeur.
   Si la destination est déjà suivie par git, le routeur refuse et le dit.
8. **Limites.** Plafonds définis en phase 0 pour : taille d'un fichier, taille totale, taille de la réponse, nombre de
   fichiers, profondeur, durée ; encodages et types acceptés. Un instantané tronqué ou illisible n'est pas approuvable.
9. **Empreinte.** Format d'arbre versionné : chemins relatifs canoniques triés, taille et SHA-256 des octets exacts
   de chaque fichier, fins de ligne conservées. Le registre garde l'empreinte de la source, celle de l'artefact
   installé, la version de l'adaptation (D10), l'identifiant du rapport et l'empreinte de la revue
   (`vsk-review-v1`, §4.10.7), qui couvre aussi les notes relues. On scanne et on installe le même instantané.
10. **D10 précisée.** L'en-tête du routeur va **après** le frontmatter YAML, jamais avant. Il ne garantit pas qu'un skill
    marche : un skill qui dépend du disque (chemins en dur, scripts) est classé « à adapter ». L'artefact installé est
    relu et a sa propre empreinte.
11. **Dépendances.** Un skill approuvé peut lire une note modifiée plus tard. L'accord enregistre les notes relues
    (D11) ; leur modification fait repasser le skill en « à revoir ». Le scan est une évaluation bornée, pas une
    garantie durable, et la fiche le dit. D11 et D12 doivent être tranchées avant le code.
12. **Une seule machine d'états, côté routeur** (inconnu, scan à faire, scanné, à risque, approuvé, installé, modifié
    depuis l'accord, redémarrage requis…), avec un même schéma de commandes et de résultats pour les trois surfaces.
    Les aperçus de contenu sont affichés comme du texte inerte. La tuile s'appuie sur `tile()`
    (`hooks/vault-panel/register.tsx:449`), primaire et secondaires.
13. **Livraison dans le dépôt.** Nouveaux outils déclarés dans `contracts/skill-capabilities.json`, gardes « local
    seulement » et « écriture », skill et slash command déclarés, `npm run audit:skills-portability`, puis `npm test`,
    `npm run validate`, `npm run gate`. Tests adverses obligatoires : rejeu, manifeste forgé, traversée de chemin,
    liens, instantané incomplet, dépendance modifiée, sessions concurrentes, appel direct sur un déploiement partagé.

### 4.10 Phase S0 des skills : mesures et contrats (2026-10-30)

Cette section est normative. Elle prime sur §4.8 et §4.9 là où elle est plus précise. Chaque mesure dit comment elle a
été faite, pour pouvoir la refaire après une mise à jour de Claude Code.

#### 4.10.1 Mesure : Claude Code voit-il un skill ajouté ou retiré en cours de session ?

**Méthode.** Claude Code 2.1.314, lancé sans interface (`claude -p`, sortie `stream-json`) dans deux dossiers jetables,
chacun un dépôt git vide. Dans chaque session, l'agent appelle l'outil `Skill`, crée un skill avec Bash, attend 5
secondes, rappelle `Skill`, supprime un skill, attend 5 secondes, rappelle `Skill`. Le verdict est lu dans les
résultats d'outils du journal `stream-json`, pas dans le résumé de l'agent.

| Cas | `.claude/skills/` au démarrage | Skill ajouté pendant la session | Skill supprimé pendant la session |
|---|---|---|---|
| A | existe, avec `probe-a` | `probe-b` : **chargé** (« Launching skill: probe-b ») | `probe-a` : **oublié** (« Unknown skill: probe-a ») |
| B | n'existe pas | `probe-b` : **pas chargé** (« Unknown skill: probe-b ») | sans objet |

**Contrôle dans une vraie session de l'app.** Cette session-ci (app Desktop, onglet Code, même version) a été lancée
dans un worktree sans `.claude/skills/`. Un skill créé pendant la session est resté inconnu, deux fois, à quelques
minutes d'écart : même résultat que le cas B. Le cas A n'a pas été refait dans l'app.

**Ce qui en découle, dans les configurations mesurées seulement.**
- Une session dont `.claude/skills/` existait au démarrage voit un skill ajouté ou retiré ensuite ; une session dont
  ce dossier n'existait pas au démarrage ne le voit pas. Le cas A n'a pas été refait dans l'app Desktop.
- Le routeur **ne peut pas savoir** si une session donnée voit déjà un skill installé : il ne connaît ni le dossier de
  chaque session (§4.10.2) ni son heure de démarrage, et il peut avoir été relancé en cours de session. La première
  livraison affiche donc toujours `activation: "next-session"`, avec ce texte : « actif au prochain démarrage d'une
  session dans <dossier> ; une session déjà ouverte dans ce dossier peut le voir dès maintenant si son dossier
  `.claude/skills/` existait à son démarrage ». Pas d'état « actif » affirmé sans preuve.
- Le routeur ne crée **jamais** `.claude/skills/` à l'avance pour gagner ce rechargement : il n'écrit dans le
  workspace que pour une installation demandée.

**Deux autres mesures, même méthode.**
- **Un skill rangé dans un sous-dossier n'est pas chargé.** `.claude/skills/vault-group/probe-d/SKILL.md` est resté
  inconnu, sous `probe-d` comme sous `vault-group:probe-d`. Le « dossier géré par le routeur » de D9 ne peut donc pas
  être un seul sous-dossier : c'est un **préfixe réservé** de noms de dossiers (§4.10.5).
- **Un skill répond à deux noms** : celui de son dossier et le `name` de son frontmatter. Le dossier
  `vault--lih--probe-c`, dont le frontmatter dit `name: probe-c-frontname`, a été lancé sous les deux noms. Le
  frontmatter seul pourrait donc entrer en collision avec un skill de l'utilisateur. L'adaptation D10 réécrit le `name`
  de la copie installée pour qu'il soit égal au nom du dossier (§4.10.3).

#### 4.10.2 Mesure : quel est le dossier courant du routeur ?

**Méthode.** Le routeur expose son propre `process.cwd()` dans `list_vaults`, champ `sessionHooks.workspace`
(`src/tools/list-vaults.mjs`, fonction `safeHooksStatus`, valeur brute, non canonisée). On compare cette valeur au
dossier de la session qui a lancé le routeur.

| Lancement | Dossier de la session | `process.cwd()` du routeur | Comment c'est mesuré |
|---|---|---|---|
| Terminal, `claude -p`, dossier ordinaire | dossier jetable | **le même dossier** | `list_vaults` appelé par la session, lu dans son journal `stream-json` |
| Terminal, `claude -p`, dans un worktree git | le worktree | **le worktree** | idem |
| App Desktop, onglet Code, session en worktree | le worktree `.claude/worktrees/band-order-48603f` | **le dépôt principal** `I:\DEVELOPPEMENT\obsidian-mcp-router` | `list_vaults` appelé dans cette session |
| App Claude Desktop, côté chat | — | **non mesuré** | sa config (`claude_desktop_config.json`) ne déclare aucun serveur MCP aujourd'hui (0 entrée) |

**Le cas Desktop + worktree est confirmé par deux autres signes.** Le hook de démarrage, lancé dans le dossier de la
session, a dit « This workspace has no binding » ; le routeur, lui, a rendu la liaison du dépôt principal. Et
`sessionHooks.status` vaut `not-observed` : le hook a écrit son signal de vie sous la clé du worktree, et le routeur
l'a cherché sous celle du dépôt principal. Chaque session a bien son propre processus routeur : 6/6 processus du
routeur installé comme plugin avaient chacun un `claude.exe` parent différent (liste des processus `node.exe` du
2026-10-30). Ce n'est pas un routeur partagé.

**Ce qui en découle.** Dans une session Desktop en worktree, `process.cwd()` n'est **pas** le dossier de la session.
Une installation dans `process.cwd()` irait dans le dépôt principal, que la session ne voit pas. Règle retenue pour la
première livraison, en attendant la décision D14 :
- le routeur installe toujours dans `process.cwd()` et refuse tout chemin fourni par l'appelant (§4.9 point 2,
  inchangé) ;
- chaque résultat, chaque écran et chaque fiche **nomme le dossier visé en entier**, pour que l'écart se voie ;
- l'activation est toujours annoncée « au prochain démarrage » (§4.10.1).

#### 4.10.3 Contrat : l'empreinte d'arbre `vsk-tree-v1`

Une **empreinte d'arbre** résume en un seul code tous les fichiers d'un skill : leurs chemins, leurs tailles et leurs
octets exacts. Si un octet change, ou si un fichier est ajouté, retiré ou renommé, l'empreinte change **en pratique** :
SHA-256 est résistant aux collisions, ce qui veut dire qu'on ne sait pas fabriquer deux contenus de même empreinte. Ce
n'est pas une impossibilité mathématique.

1. **Fichiers pris en compte :** tous les fichiers ordinaires sous le dossier du skill, à toute profondeur permise
   (§4.10.4). Les dossiers vides ne comptent pas. Un lien symbolique, une jonction ou un fichier spécial rend
   l'instantané **non approuvable** (`link-or-special`) ; il n'est jamais suivi.
2. **Chemin canonique de chaque fichier :** relatif au dossier du skill, segments séparés par `/`. **Seul un
   sous-ensemble ASCII portable est accepté** : chaque segment correspond à `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`.
   Ce choix ferme d'un coup les pièges de l'Unicode : normalisations différentes entre Windows et macOS, demi-paires
   de substitution (*lone surrogates*) qu'un encodage UTF-8 remplace silencieusement par U+FFFD, majuscules et
   minuscules qui ne se correspondent pas une à une (`σ` et `ς`), variantes en exposant des noms réservés
   (`COM¹`). Mesuré le 2026-10-30 : les 21/21 fichiers rangés dans les 16 skills de LihFolk respectent ce motif (le
22e fichier, une licence, est posé à la racine de `.claude/skills/`, hors de tout skill), et les 16/16 noms de dossier
respectent celui de §4.10.4. Le nom tel qu'il est lu (octets bruts du
   bridge) est comparé au motif ; il n'est jamais converti ni corrigé.
3. **Chemins refusés en plus** (`bad-path`) : segment `.` ou `..` (déjà exclus par le motif, vérifiés quand même) ;
   segment terminé par un point ; nom réservé de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM0` à `COM9`, `LPT0` à
   `LPT9`, `CONIN$` et `CONOUT$` exclus par le motif), seul ou suivi d'une extension, sans distinction de casse ;
   chemin complet de plus de 240 octets. **Collisions** (`path-collision`) : les chemins sont rangés dans un arbre
   dont chaque nœud est un segment mis en minuscules ASCII, et chaque nœud garde l'orthographe exacte vue la première
   fois. Sont des collisions : deux fichiers sur le même nœud ; un fichier et un dossier sur le même nœud (`A` fichier
   et `a/b`) ; un même nœud de dossier atteint avec deux orthographes différentes (`Assets/a.md` et `assets/b.md`).
   Deux fichiers différents dans un même dossier écrit pareil (`assets/a.md`, `assets/b.md`) ne sont pas une collision.
4. **Ligne d'un fichier :** `<chemin>` TAB `<taille en octets, en décimal>` TAB `<SHA-256 des octets exacts, 64
   caractères hexadécimaux en minuscules>` LF. Les octets ne sont jamais transformés : fins de ligne, BOM et encodage
   sont conservés tels quels.
5. **Ordre :** lignes triées par ordre des octets UTF-8 du chemin (pas l'ordre alphabétique de la langue).
6. **Texte haché :** `vsk-tree-v1` LF, puis les lignes. **Empreinte :** SHA-256 de ce texte, écrite
   `vsk-tree-v1:<64 hex>`. Le préfixe de version change si une seule règle de cette liste change.
7. **Ce que le registre garde** (§4.9 point 9) : l'empreinte de la source (l'instantané scanné), l'empreinte de
   l'artefact installé (même format, calculée sur la copie adaptée), la version de l'adaptation (`vsk-adapt-v1`) et
   l'identifiant du rapport de scan.
8. **L'adaptation `vsk-adapt-v1`** (D10) ne touche que `SKILL.md` : le champ `name` du frontmatter est remplacé par le
   nom du dossier installé (§4.10.1), et l'en-tête du routeur est inséré juste après la ligne `---` qui ferme le
   frontmatter. Un `SKILL.md` sans frontmatter YAML valide n'est pas adaptable : le skill est « non approuvable »
   (`no-frontmatter`). Un skill qui dépend du disque (chemins en dur, scripts) reste approuvable, mais sa fiche porte
   le drapeau `needsAdaptation` (« à adapter »), montré avant l'accord. Tous les autres fichiers sont copiés octet pour
   octet. L'artefact adapté est calculé **avant** l'accord et montré avec son empreinte : l'utilisateur approuve la
   paire (source, artefact), pas la source seule.
9. **Valeurs de texte hors chemins** (nom du vault, clé du workspace, dans les demandes signées de §4.10.6) : elles
   doivent être de l'Unicode bien formé (`String.prototype.isWellFormed()` vrai) **avant** toute normalisation ou tout
   encodage ; sinon refus (`ill-formed-text`). Aucune conversion avec perte n'est permise nulle part.

Le bridge renvoie ses propres empreintes, mais le routeur **recalcule tout** à partir des octets reçus et compare. Un
écart rend l'inventaire « incomplet », donc non approuvable (`digest-mismatch`).

#### 4.10.4 Contrat : les plafonds `vsk-limits-v1`

Valeurs fixées après mesure des 16 skills de LihFolk Vault V1 (lecture des seules tailles de fichiers, le 2026-10-30,
pas de leur contenu) : le plus gros fichier fait 13 526 octets, le plus gros skill 21 344 octets, aucun skill n'a plus
de 4 fichiers, aucun n'a de sous-dossier plus profond qu'un niveau ; en tout, 22 fichiers (21 `.md`, 1 `.txt`) et
131 955 octets, aucun lien symbolique. Les plafonds laissent une large marge.

| Plafond | Valeur | Dépassé : ce qui se passe |
|---|---|---|
| Taille d'un fichier | 256 Kio (262 144 octets) | skill « non approuvable », raison `file-too-large` |
| Taille totale d'un skill | 1 Mio | `skill-too-large` |
| Nombre de fichiers d'un skill | 64 | `too-many-files` |
| Profondeur sous le dossier du skill | 4 niveaux de sous-dossiers | `too-deep` |
| Nombre de skills par vault | 64 | inventaire « incomplet », `too-many-skills` |
| Entrées d'un même dossier (fichiers, dossiers, liens), lues en flux et comptées avant tout tri | 1024 | dans un skill : skill « non approuvable », `too-many-entries` ; à la racine de `.claude/skills/` : inventaire « incomplet », `too-many-entries` |
| Entrées de la racine qui ne sont pas des skills, listées dans la réponse | 256 | les suivantes sont comptées (`othersOmitted`), pas listées : rien n'est perdu en silence |
| Taille de la réponse du bridge | 8 Mio | inventaire « incomplet », `response-too-large` |
| Durée du parcours dans le bridge | 5 secondes | inventaire « incomplet », `timeout` |
| Attente de la réponse par le routeur | 15 secondes | vault « injoignable » pour cet inventaire |
| Nom de dossier du skill dans le vault | `^[a-z0-9][a-z0-9-]{0,63}$` | skill listé mais « non approuvable », `bad-skill-id` |

**Encodages et types acceptés.** Tous les fichiers sont transportés en base64, donc sans conversion. Un fichier n'est
**relisible** que s'il est de l'UTF-8 valide sans octet nul (un BOM UTF-8 est permis et conservé) : la relecture par IA
ne sait pas lire autre chose. Un skill qui contient un fichier non relisible est listé, mais « non approuvable »
(`unreadable-file`). Aucune liste d'extensions : c'est le contenu qui décide, pas le nom.

**Jamais de troncature silencieuse.** Un plafond atteint donne toujours une raison explicite et un état non
approuvable. Un instantané partiel n'est jamais haché comme s'il était complet.

#### 4.10.5 Contrat : où et sous quel nom la copie est installée

- **Dossier :** `<process.cwd()>/.claude/skills/vault--<vault>--<skill>/`, où `<vault>` est un identifiant court tiré
  du nom du vault (minuscules ASCII, chiffres et tirets, 24 caractères au plus) et `<skill>` le nom de dossier validé
  (§4.10.4). Le préfixe `vault--` est **réservé au routeur**.
- **Un dossier, un seul propriétaire.** Le registre garde, pour chaque workspace, la table « nom de dossier →
  (vault, skill) ». Deux vaults dont les identifiants courts coïncident, avec le même nom de skill, visent le même
  dossier : la seconde installation est refusée (`destination-collision`), jamais traitée comme une mise à jour. Le fait
  qu'un dossier figure au registre ne vaut autorisation que pour **son** propriétaire.
- **Modèle de menace de l'écriture.** Ce que le routeur doit tenir en échec : un contenu arrivé par le vault ou par un
  dépôt cloné (liens symboliques, jonctions, noms piégés déjà présents sur le disque). Ce qu'il ne peut pas tenir en
  échec : un autre programme qui tourne **en même temps, avec les droits de l'utilisateur**, et remplace un dossier
  entre deux opérations. Node n'offre pas, sous Windows, d'opérations relatives à un descripteur de dossier
  (`openat`) ; et un tel programme peut de toute façon écrire lui-même dans `.claude/skills/`. Ce cas est hors du
  périmètre et la fiche le dit. Le routeur réduit quand même la fenêtre et borne les dégâts :
  - **Ancêtres sûrs :** le workspace, `.claude/` et `.claude/skills/` doivent être de vrais dossiers, sans lien
    symbolique ni jonction : le chemin réel (`fs.realpathSync.native`) de chacun doit être égal à son chemin écrit.
    Sinon refus (`unsafe-ancestor`). La vérification est faite avant **et après** chaque création, renommage ou
    suppression ; un écart constaté après arrête tout et le signale.
  - **Fichiers temporaires :** tout fichier ou dossier temporaire a un nom tiré au hasard (16 octets, 32 hex) et est
    créé **de façon exclusive** (`fs.mkdirSync` sur un nom neuf, `fs.openSync(…, 'wx')` pour un fichier) ; il est
    ensuite écrit par le descripteur obtenu, jamais rouvert par son nom. Un nom déjà présent, même planté par un
    dépôt cloné sous forme de lien, fait échouer la création au lieu d'être suivi.
  - **Hors de `.claude/skills/` :** les dossiers de préparation et de retrait sont rangés dans `.claude/`
    (`.claude/.vault-staging-<32 hex>/`, `.claude/.vault-retired-<32 hex>/`), pas dans `.claude/skills/` : Claude Code
    charge tout dossier de `.claude/skills/` qui contient un `SKILL.md` (§4.10.1), et un dossier à moitié préparé ne
    doit jamais être chargé. Les deux sont sur le même volume que la destination, donc un renommage est atomique.
  - **Première installation :** préparation dans un dossier de préparation, vérification de l'empreinte de
    l'artefact préparé, puis un seul renommage vers le dossier final, qui ne doit pas exister. Le registre n'est
    écrit qu'après ce renommage.
  - **Un seul verrou pour tout.** Toute écriture dans le workspace et dans le registre pour un workspace donné se fait
    sous un **verrou inter-processus** (fichier verrou à côté du registre, dans la config de l'utilisateur), pris
    avant la première étape et rendu après la dernière, y compris pendant une reprise. Deux routeurs du même
    workspace (§4.10.2) ne peuvent donc jamais mener deux remplacements, ou un remplacement et une reprise, en même
    temps.
  - **Remplacement d'une version installée** (même propriétaire, §4.10.7), dans cet ordre :
    1. préparer et vérifier la nouvelle version dans un dossier de préparation ;
    2. vérifier l'ancienne copie fichier par fichier contre le registre (sinon `tampered`, rien n'est touché) ;
    3. écrire dans le registre un **journal** de l'entrée, `replacing`, qui contient : l'ancienne et la nouvelle
       empreinte, la **liste complète des fichiers** de chacune avec leurs empreintes, et les deux noms temporaires ;
    4. renommer l'ancienne copie vers un dossier de retrait ;
    5. renommer la nouvelle version vers le dossier final ;
    6. dans une seule écriture du registre : valider la nouvelle installation, et transformer le journal en
       `cleanup-pending`, qui garde le nom du dossier de retrait et la liste des fichiers de l'ancienne version ;
    7. supprimer le dossier de retrait fichier par fichier selon cette liste (règle du retrait ci-dessous), puis
       effacer `cleanup-pending`.
    Un échec à l'étape 5 remet l'ancienne copie en place (renommage inverse) et efface le journal.
  - **Reprise après un arrêt brutal**, au démarrage, sous le verrou, pour chaque journal trouvé. Chaque frontière
    entre deux étapes a sa réponse :

    | Journal | Ce que montre le disque | Ce que fait le routeur |
    |---|---|---|
    | `replacing` | final = ancienne version, retrait absent (arrêt avant l'étape 4) | supprime la préparation selon la liste de la nouvelle version, efface le journal : rien n'a changé |
    | `replacing` | final absent, retrait = ancienne version (arrêt entre 4 et 5) | remet l'ancienne copie en place, supprime la préparation, efface le journal |
    | `replacing` | final = nouvelle version (arrêt entre 5 et 6) | fait l'étape 6, puis l'étape 7 |
    | `cleanup-pending` | retrait présent, vide ou déjà disparu | reprend l'étape 7 (nettoyage reprenable, ci-dessous) |
    | l'un ou l'autre | tout autre état (fichier en trop, en moins ou différent) | l'entrée passe `tampered`, le journal est gardé, rien n'est supprimé |

    « Final = ancienne version » veut dire : chaque fichier a l'empreinte de la liste ancienne, et il n'y en a pas
    d'autre. De même pour la nouvelle version.
  - **Nettoyage reprenable.** Le nettoyage d'un dossier de retrait ou de préparation qui appartient à un journal peut
    être interrompu puis repris : un fichier de la liste **déjà absent** est accepté (il a été supprimé avant
    l'arrêt), un dossier déjà disparu aussi. Chaque fichier encore présent doit avoir l'empreinte de la liste ; un
    fichier en trop ou différent arrête tout (`tampered`). Le journal n'est effacé qu'une fois le dossier disparu.
  - **Un journal à la fois.** Tant qu'une entrée a un journal (`replacing` ou `cleanup-pending`), toute nouvelle
    installation, tout retrait et tout `forget` de cette entrée est refusé (`cleanup-pending`). Seule exception pour
    `forget` : quand aucun des dossiers temporaires nommés dans le journal n'existe plus sur le disque (l'utilisateur
    les a supprimés lui-même), il n'y a plus rien à nettoyer et l'entrée peut être oubliée. Dans tous les autres
    cas, le routeur tente d'abord de finir le nettoyage, et ne passe à la suite qu'une fois le journal effacé. Un
    journal n'est donc jamais écrasé par un autre, ni perdu par un `forget`.
  - **Retrait jamais récursif :** le routeur supprime un à un les fichiers nommés dans l'entrée du registre, après
    avoir vérifié que chacun est un fichier ordinaire, sous le dossier visé, avec son empreinte enregistrée ; puis il
    retire les dossiers devenus vides. Un fichier en trop, en moins ou différent arrête le retrait (`tampered`). Même
    dans le pire cas, il ne peut supprimer que des fichiers dont il connaît l'empreinte exacte.
- **`.gitignore` :** trois lignes, ajoutées si elles manquent : `/.claude/skills/vault--*/`,
  `/.claude/.vault-staging-*/` et `/.claude/.vault-retired-*/` (un dossier temporaire laissé par un arrêt brutal ne
  doit pas non plus partir dans un commit). Le routeur ne touche à aucune autre ligne.
  - **La ligne ne suffit pas, l'effet se vérifie.** Un dépôt cloné peut contenir la même ligne suivie d'une négation
    (`!/.claude/skills/vault--x/`), ou un `.gitignore` plus profond qui l'annule : chez git, la dernière règle qui
    correspond l'emporte. **Avant d'écrire le moindre octet** (avant de créer la préparation, et avant tout
    renommage vers le retrait), puis de nouveau avant le renommage final, le routeur demande donc à git lui-même,
    dans le workspace : `git check-ignore -q --no-index -- <chemin>` pour **chaque** chemin final des fichiers à
    installer (ils n'existent pas encore : git juge le chemin, pas le fichier), pour les chemins de ces mêmes
    fichiers dans le dossier de préparation, et, lors d'un remplacement, pour les chemins de **tous les fichiers de
    l'ancienne version** (liste du registre) dans le dossier de retrait. Chaque dossier est vérifié contre la liste
    des fichiers qu'il va recevoir, avant de les recevoir. Un seul chemin non exclu donne un refus (`not-ignored`) et rien
    n'est installé. Si le workspace n'est pas un dépôt git, il n'y a rien à publier par erreur : la vérification est
    sautée, et le résultat le dit. Le fichier doit être absent ou un fichier ordinaire (vérifié par `lstat`, jamais par `stat`) ;
  un lien ou un fichier spécial donne un refus (`unsafe-gitignore`).
  - **Absent :** création exclusive (`fs.openSync(…, 'wx')`) ; s'il est apparu entre-temps, on repart du cas suivant.
  - **Présent :** le routeur lit le fichier, écrit le nouveau contenu (l'ancien, octet pour octet, plus la ligne) dans
    un fichier temporaire du même dossier, créé de façon exclusive sous un nom tiré au hasard (règle des fichiers
    temporaires ci-dessus), revérifie juste avant de renommer que `.gitignore` a toujours la même
    taille, la même date et la même empreinte, puis renomme le temporaire par-dessus. Un écart donne un refus
    (`gitignore-conflict`) : rien n'est écrasé, l'utilisateur relance. **Risque résiduel assumé :** une modification
    faite par un éditeur dans les quelques millisecondes entre la dernière vérification et le renommage serait perdue.
    La fiche le dit ; si ce risque n'est pas acceptable, voir D15 (§4.10.8).
- **Refus :** si `git ls-files` montre un fichier suivi sous ce dossier (`tracked-destination`), ou si un dossier
  `vault--…` du même nom existe sans figurer au registre de l'utilisateur (`unregistered-destination`).
- **Un dossier `vault--…` absent du registre** (copié à la main, arrivé par un clone) est signalé, jamais supprimé ni
  mis à jour par le routeur. **Limite assumée :** le routeur ne peut pas empêcher Claude Code de le charger. Claude
  Code charge tout dossier de `.claude/skills/` présent au démarrage, quel que soit son nom (§4.10.1) : un dépôt cloné
  qui apporte des skills les fait charger, avec ou sans routeur. Le préfixe ne crée pas de frontière de sécurité ; la
  seule protection contre un dépôt douteux est de ne pas lui faire confiance dans Claude Code. La tuile affiche ces
  dossiers en rouge, « présents mais pas installés par le routeur — Claude Code les charge quand même ».

#### 4.10.6 Contrat : la demande signée `vsk-req-v1` (D13)

Une demande est ce que le bridge envoie quand on clique un interrupteur dans Obsidian. Elle est signée avec un secret
que le routeur donne au bridge pour sa session. La signature prouve que la demande vient d'un code qui connaît ce
secret ; elle **ne prouve pas** qu'un humain a cliqué (§7, D13). C'est pourquoi un clic hors environnement de confiance
ne fait que créer une demande en attente.

**Sessions, une par processus routeur.** Chaque processus routeur tire à son démarrage un identifiant d'instance
(16 octets aléatoires, 32 hex). À l'ouverture d'une session, il tire un secret de 32 octets (`crypto.randomBytes`) et un
identifiant de session de 16 octets, et les envoie au bridge par une route protégée par la clé de l'API, avec son
identifiant d'instance et la clé de son workspace. Le bridge garde **plusieurs** sessions à la fois, en mémoire
seulement, jamais sur le disque, rangées par identifiant d'instance : 8 au plus, chacune oubliée après 24 heures sans
contact. Quand les 8 places sont prises par des sessions encore vivantes, une nouvelle ouverture est **refusée**
(`bridge-sessions-full`) : aucune session vivante n'est évincée pour faire de la place, sinon quiconque connaît la clé
de l'API pourrait chasser les vrais routeurs en ouvrant des sessions en boucle.
- **Remplacement :** une session n'est remplacée que par la même instance, et la demande de remplacement doit être
  signée avec le secret de la session courante. Une autre instance, même pour le même workspace, ouvre sa propre
  session à côté ; elle ne peut pas évincer celle d'une autre instance.
- **Distribution :** un interrupteur cliqué dans Obsidian concerne un workspace précis (D13). **Au moment du clic**,
  le bridge fige une fois pour toutes l'intention : `id`, `issuedAt`, `expiresAt`, `snapshot`, `review`, `rev` et
  `action`. Il fabrique ensuite une demande **par session vivante de ce workspace**, toutes avec ces mêmes valeurs ;
  seuls `session` et la signature diffèrent. Ni une nouvelle tentative ni un envoi tardif ne relisent l'état : une
  intention figée sur la révision N ne peut jamais s'appliquer à la révision N+1. Plusieurs routeurs sur
  le même workspace (cas mesuré en §4.10.2) partagent le même registre et la même révision (ci-dessous) : le premier qui
  applique la demande fait avancer la révision, les autres la refusent comme périmée (`stale`). L'effet est appliqué
  une seule fois.

**Identités signées.** Le champ `vault` porte le nom du vault **exactement** tel qu'il est écrit dans la config du
routeur, sans normalisation. Le routeur refuse d'utiliser cette fonction pour un vault dont le nom, une fois mis en NFC
et en minuscules, est égal à celui d'un autre vault enregistré (`ambiguous-vault`) : deux noms qui s'affichent pareil
ne peuvent pas désigner deux vaults. Le champ `workspace` porte la clé canonique du workspace telle que la produit
`canonicalWorkspaceKey` (`src/helpers/workspace-bindings.mjs`), la même fonction que celle des liaisons, sans autre
transformation.

**Texte signé.** Douze lignes, dans cet ordre exact, séparées par LF, sans LF final, chacune `clé=valeur` :

```
v=vsk-req-v1
session=<32 hex minuscules>
id=<32 hex minuscules, aléatoire, unique>
issuedAt=<date UTC, format AAAA-MM-JJTHH:MM:SS.mmmZ>
expiresAt=<même format>
vault=<nom du vault exact, UTF-8, encodé en pourcentage>
workspace=<clé canonique du workspace, UTF-8, encodée en pourcentage>
skill=<nom de dossier validé>
snapshot=<vsk-tree-v1:64 hex>
review=<vsk-review-v1:64 hex, ou - pour action=disable>
rev=<révision du triplet sur laquelle la demande a été construite, entier décimal sans zéro initial>
action=<enable | disable>
```

- **Encodage en pourcentage :** chaque octet hors de `A-Z a-z 0-9 - . _ ~` devient `%XX` (hexadécimal en
  majuscules). Ainsi aucune valeur ne peut contenir `=` ni LF, et deux demandes différentes ne peuvent pas donner le
  même texte.
- **Signature :** HMAC-SHA-256 du texte (octets UTF-8) avec le secret de session, en 64 hex minuscules. Comparaison à
  temps constant (`crypto.timingSafeEqual`).
- **Durées :** `expiresAt - issuedAt` vaut au plus 120 secondes ; une avance d'horloge de 30 secondes au plus est
  tolérée sur `issuedAt`.
- **Refus, chacun avec sa raison :** version inconnue, ligne manquante, en trop ou hors d'ordre (`malformed`) ;
  session qui n'est pas la session courante (`wrong-session`) ; signature fausse (`bad-signature`) ; expirée
  (`expired`) ; identifiant déjà vu dans la session (`replay`) ; empreinte de l'instantané ou de la revue différente
  de celles de l'état courant (`snapshot-mismatch`) ; workspace différent du `process.cwd()` canonique du routeur
  (`wrong-workspace`).
- **Ordre, par une révision par triplet.** Le registre garde pour chaque triplet (vault, skill, workspace) une
  **révision**, un entier qui augmente de 1 à **chaque** changement de cet triplet : commande du panneau ou du chat
  (`approve`, `install`, `uninstall`, `revoke`, `forget`, `record-scan`), demande appliquée, constat d'inventaire qui
  change l'état. Le bridge lit la révision courante dans l'état que lui sert le routeur et la met dans la demande
  (`rev`). Une demande dont la révision n'est pas **égale** à la révision courante est refusée (`stale`). Ainsi, une
  demande en retard ne peut jamais défaire une décision plus récente, qu'elle ait été prise par une autre demande ou
  dans le panneau ou le chat. Les identifiants de demandes **appliquées** sont aussi notés dans le registre, partagé
  par tous les routeurs du workspace ; les identifiants vus sont gardés pendant toute la session du routeur
  (`replay`).
- **Une demande en attente n'est pas une autorisation.** Quand le clic vient d'un environnement qui n'est pas de
  confiance (§7, D13), la demande est mise en file (`queued`) et affichée comme une **proposition** dans le panneau et
  le chat. Elle expire de la file 15 minutes après son `issuedAt` (`expired`). La confirmer, c'est envoyer une
  **commande neuve** (`approve`, `install` ou `uninstall`, §4.10.7), avec les empreintes attendues, depuis le panneau
  ou le chat ; le routeur revérifie alors tout à ce moment-là. La demande d'origine ne sert qu'à préremplir cette
  commande, jamais à l'exécuter.
- **Acquittement :** pour chaque demande lue, le routeur renvoie au bridge `{ id, outcome, reason? }`, où `outcome`
  vaut `applied`, `queued` ou `refused`, puis `expired` ou `superseded` quand une demande en file sort de la file sans
  avoir été confirmée. `reason` est **obligatoire** pour `refused` (un code de la liste fermée de §4.10.7) et
  **absent** pour toutes les autres issues.

#### 4.10.7 Contrat : la machine d'états `vsk-state-v1`

L'état d'un skill est calculé **par le routeur seul**, pour un triplet (vault, skill, workspace). Les trois surfaces
(panneau, chat, réglages du bridge) affichent ce que le routeur renvoie ; aucune ne calcule un état elle-même.

**Deux axes indépendants.** Ce que le vault propose et ce qui est installé dans le workspace évoluent séparément : un
vault peut passer hors ligne pendant qu'une copie approuvée reste en place, et une copie peut être modifiée à la main
pendant qu'un nouveau scan est en cours. L'état est donc un couple, recalculé à chaque inventaire à partir de faits
(dernier inventaire, rapports de scan, registre des accords, octets présents dans le workspace). Rien n'y est
« collant » : quand le vault revient en ligne, l'axe source se recalcule tout seul.

**Axe source** — le skill tel que le vault le propose maintenant :

| État | Ce que ça veut dire | Couleur |
|---|---|---|
| `unavailable` | vault hors ligne, bridge absent ou trop ancien (`reason`) | gris |
| `absent` | vault joignable et inventaire complet, mais ce skill n'y figure plus (dossier ou `SKILL.md` retiré) | orange si installé, sinon caché |
| `unreviewable` | skill listé mais non approuvable (`reason` : plafond, lien, nom, fichier non relisible, inventaire incomplet…) | gris |
| `unscanned` | aucun rapport de scan pour l'empreinte actuelle de la source | gris |
| `scan-pending` | un scan a été demandé pour l'empreinte actuelle ; il sera fait à la prochaine session de chat | gris |
| `scanned` | revue à jour pour l'empreinte actuelle, verdict `clean` ou `alerts` | vert ou orange |
| `risky` | revue à jour pour l'empreinte actuelle, verdict « à risque » (§4.8) | rouge |
| `review-stale` | une revue existe pour l'empreinte actuelle, mais une note qu'elle a relue (D11) a changé depuis : il faut rescanner | orange |
| `approved` | accord enregistré pour le triplet (source, artefact, revue) actuel, et la revue est toujours à jour | vert |

**La revue a sa propre empreinte.** Un scan enregistré produit une **revue** : le rapport (fiche, alertes, verdict) et
la liste des notes relues, chacune avec l'empreinte SHA-256 de son contenu au moment du scan. Son empreinte `review`
est le SHA-256 d'un texte canonique : `vsk-review-v1` LF, l'empreinte de la source, l'identifiant du rapport,
l'empreinte du rapport, puis une ligne `<chemin de la note encodé en pourcentage>` TAB `<sha256>` par note relue,
triées par octets ; elle s'écrit `vsk-review-v1:<64 hex>`. Une revue est **à jour** tant que chaque note relue a encore la même empreinte ; elle est
contrôlée à chaque inventaire, pour un skill approuvé comme pour un skill installé.

**Axe installation** — ce qui est dans le dossier du workspace :

| État | Ce que ça veut dire | Couleur |
|---|---|---|
| `none` | rien d'installé par le routeur pour ce skill | — |
| `installed` | copie présente, empreinte de l'artefact égale à celle du registre ; `activation` vaut `next-session` (§4.10.1) | vert |
| `tampered` | copie présente, empreinte différente de celle du registre : le routeur ne la retire pas et ne la met pas à jour | rouge |
| `missing` | le registre dit « installé » mais le dossier a disparu | orange |

**Drapeaux**, calculés seulement quand l'installation vaut `installed` :
- `sourceChanged` : l'empreinte de la source approuvée pour la copie installée n'est plus celle de la source actuelle,
  ou la source est `absent` (D12 : la copie reste, avertissement orange). Si la source est `unavailable`, le drapeau
  vaut `unknown`.
- `reviewNeeded` : la revue sur laquelle repose la copie installée n'est plus à jour (D11 ; la copie reste,
  avertissement orange).
- `pendingRequest` : une demande venue d'Obsidian attend en file (§4.10.6). Ce n'est qu'un affichage.

La couleur de la tuile est la plus grave parmi les deux axes et les drapeaux de tous les skills du vault, dans
l'ordre : rouge, orange, gris, vert.

**Commandes : chacune nomme les empreintes qu'elle attend.** Une commande ne s'applique que si les empreintes qu'elle
porte sont **encore** celles de l'état courant, comparées sous le verrou du registre, au moment de l'écriture. Sinon
refus (`stale-digest`). Ainsi, un accord donné en regardant l'instantané A ne peut jamais approuver un instantané B
arrivé entre-temps.

Chaque entrée du registre a un **identifiant d'entrée** `entryId` (16 octets aléatoires, 32 hex), tiré à sa création
et jamais réutilisé, et la **révision** du triplet (§4.10.6), qui augmente à chaque changement. Toute commande qui
change quelque chose porte la révision qu'elle a lue (`rev`) ; celles qui agissent sur une entrée existante portent
aussi son `entryId`. Une commande retardée ne peut donc jamais agir sur un état plus récent que celui qu'elle a vu,
même si cet état a la même catégorie (par exemple de nouveau `tampered` après une réparation).

| `op` | Champs obligatoires | État exigé | Effet | Refus propres |
|---|---|---|---|---|
| `inventory` | — | — | relit le vault et recalcule les deux axes | `offline`, `bridge-missing`, `bridge-too-old`, `unreachable` |
| `request-scan` | `rev`, `snapshot` | source `unscanned`, `scanned`, `risky` ou `review-stale` | source → `scan-pending` | `not-eligible` |
| `record-scan` | `rev`, `snapshot`, `reportId` | source `scan-pending` pour ce `snapshot` | enregistre la revue (rapport + notes relues) | `not-eligible`, `scanner-missing`, `reviewer-unavailable` |
| `approve` | `rev`, `snapshot`, `artifact`, `review` ; `confirmRisk: true` si `risky` | source `scanned` ou `risky`, revue à jour | enregistre l'accord pour le triplet | `not-eligible`, `risk-not-confirmed` |
| `install` | `rev`, `snapshot`, `artifact`, `review` | source `approved` pour ce triplet ; installation `none`, ou `installed` d'une version plus ancienne du même propriétaire | installation → `installed` ; une copie plus ancienne est remplacée selon le protocole de remplacement (§4.10.5) | `not-approved`, `tampered`, `destination-collision`, `unsafe-ancestor`, `unsafe-gitignore`, `gitignore-conflict`, `not-ignored`, `tracked-destination`, `unregistered-destination`, `cleanup-pending` |
| `uninstall` | `rev`, `entryId`, `installed` | installation `installed` | retire la copie ; permis quel que soit l'axe source | `not-eligible`, `tampered`, `cleanup-pending` |
| `revoke` | `rev`, `entryId`, `snapshot`, `artifact`, `review` | un accord existe pour ce triplet | retire l'accord ; ne touche pas une copie installée (il faut `uninstall`) | `not-eligible` |
| `forget` | `rev`, `entryId` | installation `missing` ou `tampered`, sans journal en cours (sauf l'exception de « Un journal à la fois », §4.10.5) | retire cette entrée du registre, sans toucher aucun fichier | `not-eligible`, `cleanup-pending` |

Pour chaque ligne, les champs portés sont comparés aux valeurs **courantes** sous le verrou du registre : une
révision ou une empreinte différente donne `stale-digest`, un identifiant d'entrée inconnu ou remplacé donne
`not-eligible`. Chaque commande appliquée fait avancer la révision de 1 dans la même écriture. Une copie `tampered` n'est jamais
retirée ni remplacée par le routeur : l'utilisateur la supprime lui-même, puis `forget`. Il n'existe pas de commande
qui exécute une demande en file : la confirmer, c'est envoyer `approve`, `install` ou `uninstall` (§4.10.6). Toute
erreur du système de fichiers pendant une écriture donne `io-error`, et la vérification d'après (§4.10.5) dit ce qui a
été fait ou non.

**Gardes, avant tout le reste.**
- Pour toutes les commandes : routeur en mode local, pas un déploiement partagé (`not-local`).
- Pour `inventory`, `request-scan`, `record-scan`, `approve`, `install` : workspace lié (`workspace-unbound`) ; vault
  primaire ou secondaire de cette liaison (`vault-not-bound`) et non en pause (`vault-paused`) ; nom de vault non
  ambigu (`ambiguous-vault`, §4.10.6).
- Pour `uninstall`, `revoke`, `forget` : seulement une entrée du registre pour **ce** workspace. Ni la liaison ni la
  pause ne sont exigées : un vault délié ou mis en pause ne doit pas empêcher de retirer ce qu'il a laissé.

**Schéma commun.** Une commande est `{ v: "vsk-cmd-v1", op, vault, skill, rev?, entryId?, snapshot?, artifact?,
review?, installed?, reportId?, confirmRisk? }`, avec les champs obligatoires du tableau. Un résultat est
`{ v: "vsk-res-v1", ok, source, installation, flags, rev, activation?, target, reason?, snapshot?, artifact?,
review?, installed? }`. `reason` est présent si et seulement si `ok` est faux, et `target` est le dossier visé en
entier (§4.10.2). Le contenu des fichiers est toujours rendu comme du texte inerte,
jamais comme du Markdown ni du HTML.

**Liste fermée des raisons (`reason`).** Toute raison renvoyée en est une ; un test vérifie qu'aucune autre n'est
émise.
- Inventaire et vault : `offline`, `bridge-missing`, `bridge-too-old`, `unreachable`, `timeout`,
  `response-too-large`, `too-many-skills`, `digest-mismatch`.
- Skill non approuvable : `file-too-large`, `skill-too-large`, `too-many-files`, `too-many-entries`, `too-deep`,
  `bad-skill-id`, `bad-path`, `path-collision`, `link-or-special`, `unreadable-file`, `no-frontmatter`.
  `link-or-special` couvre aussi un fichier à plusieurs liens durs (`nlink > 1`) : un lien dur vers un fichier hors
  du vault serait sinon lu comme un fichier ordinaire. `too-many-entries` sert aussi d'inventaire « incomplet » quand
  la racine de `.claude/skills/` dépasse son plafond d'entrées.
- Commandes : `stale-digest`, `not-eligible`, `not-approved`, `risk-not-confirmed`, `scanner-missing`,
  `reviewer-unavailable`, `tampered`, `not-local`, `workspace-unbound`, `vault-not-bound`, `vault-paused`,
  `ambiguous-vault`, `io-error`.
- Installation : `destination-collision`, `unsafe-ancestor`, `unsafe-gitignore`, `gitignore-conflict`,
  `not-ignored`, `tracked-destination`, `unregistered-destination`, `cleanup-pending`.
- Demandes signées : `bridge-sessions-full`, `ill-formed-text`, `malformed`, `wrong-session`, `bad-signature`, `expired`, `replay`, `stale`,
  `snapshot-mismatch`, `wrong-workspace`.

`applied`, `queued`, `refused`, `expired` et `superseded` sont des **issues** d'acquittement (§4.10.6). Seul
`expired` est aussi une raison : celle d'une demande refusée parce qu'elle est arrivée déjà expirée. Une demande en file est `superseded` quand une commande ou une demande plus récente est appliquée au même
triplet (vault, skill, workspace) avant qu'elle soit confirmée.

#### 4.10.8 Décision nouvelle pour Roland : D14

**D14 — Session Desktop en worktree : où installer ?** La mesure §4.10.2 montre que, dans l'onglet Code de l'app
Desktop, une session en worktree a un routeur dont le dossier courant est le dépôt principal.

- **Option A : toujours `process.cwd()`, en affichant le dossier.** Simple et sans chemin venu de l'appelant. Dans une
  session en worktree, le skill est installé dans le dépôt principal : il sert aux sessions qui y sont lancées, pas à
  celle-ci.
- **Option B : accepter le dossier de la session s'il est un worktree enregistré du dépôt de `process.cwd()`.** Le
  routeur le vérifie lui-même avec `git worktree list --porcelain`, lancé dans `process.cwd()`. Le skill arrive dans
  la bonne session (au prochain démarrage, le dossier `.claude/skills/` d'un worktree neuf n'existant pas au départ).
  Un chemin vient de l'appelant, mais il n'est accepté que s'il figure dans la liste de git.
- **Recommandation : A pour la première livraison**, B ensuite si le besoin se confirme. A ne demande aucune
  exception à la règle « pas de chemin fourni par l'appelant ».

#### 4.10.9 Décision nouvelle pour Roland : D15

**D15 — `.gitignore` ou `.git/info/exclude` ?** La revue Codex a montré qu'on ne peut pas modifier `.gitignore` sans un
petit risque d'effacer une modification faite au même instant par un éditeur (§4.10.5).

- **Option A : `.gitignore`, comme décidé en D9**, avec le refus `gitignore-conflict` et le risque résiduel écrit
  dans la fiche. La ligne est visible dans le dépôt et partagée avec l'équipe, qui voit que ces dossiers sont gérés.
- **Option B : `.git/info/exclude`.** C'est le fichier d'exclusion **local** de git : il n'est jamais suivi ni
  partagé, et aucun éditeur ne l'ouvre en temps normal, donc le risque disparaît presque. Le dépôt n'est pas modifié du
  tout. En contrepartie, un collègue ne voit pas la règle, et un workspace qui n'est pas un dépôt git n'a pas ce
  fichier (rien à exclure alors, de toute façon).
- **Dans les deux cas**, l'effet est vérifié par `git check-ignore` avant chaque installation (§4.10.5) : une règle
  du dépôt qui annule l'exclusion fait refuser l'installation (`not-ignored`). C'est d'autant plus nécessaire avec B,
  car les règles de `.git/info/exclude` passent **après** celles des `.gitignore` du dépôt.
- **Recommandation : B.** Elle sert mieux le but de D9 (« pas publié avec le code par erreur ») sans toucher un
  fichier du projet. C'est un changement de D9 : il demande l'accord de Roland.

## 5. Les parcours, du point de vue de l'utilisateur

### E1 — Créer depuis le modèle

1. Panneau « + Nouveau vault », `/obsidian-router:vault-new` ou « crée un vault Recettes ».
2. Le wizard demande : le nom, **local** ou **conteneur** (et lequel), le mode wiki, et s'il faut lier le workspace
   courant.
3. `plan_vault` montre le plan scellé. L'utilisateur valide.
4. En local, `provision_vault`. Dans un conteneur, `create_vault` puis `open_window(trusted)` par l'agent.
5. Contrôle : les plugins copiés ont les empreintes du catalogue. Si oui, confiance accordée sans question. Sinon,
   arrêt, avec la liste des écarts : le squelette a été altéré.
6. Clé récupérée, vault enregistré **comme vault de confiance**, test de l'API au vert, panneau mis à jour.

### E2 — Enregistrer un vault existant

1. Panneau « + Ajouter un vault », `/obsidian-router:vault-add` ou langage naturel. Le wizard demande où est le vault.
2. Le routeur lit ses plugins **sans les exécuter** (§4.5).
3. **La question :** le wizard affiche les deux définitions du §2.3 et demande « Ce vault est-il un vault de confiance
   ou un vault tiers ? ». Il montre en même temps le résultat du contrôle, par exemple « 11 plugins vérifiés, 2 de
   l'annuaire, 1 hors annuaire ».

#### E2a — Vault tiers

4. **Avertissement :**
   > Les plugins de ce vault peuvent lire et modifier les fichiers de votre ordinateur, se connecter à Internet et
   > installer des programmes. Obsidian ne peut pas les en empêcher. Le vault va être ouvert en mode restreint : aucun
   > plugin ne tourne, et le routeur ne pourra pas le lire tant que vous n'en sortez pas.
5. Le vault est ouvert dans une nouvelle fenêtre, en mode restreint. Le wizard montre le tableau des plugins, avec le
   niveau de chacun.
6. Le wizard propose deux choix :
   - **Rester en mode restreint.** Le vault est enregistré, mais `offline` pour le routeur.
   - **Sortir du mode restreint.** Le routeur réécrit `community-plugins.json` pour n'activer que Local REST API with
     MCP (décision D5 pour le bridge), puis accorde la confiance. Tous les autres plugins restent installés mais
     désactivés.
7. Clé récupérée, vault enregistré **comme vault tiers**, en **lecture seule stricte** par défaut pour le workspace qui
   le lie.
8. **Activer un autre plugin** se fait ensuite à la main, un par un, dans Obsidian. Le wizard rappelle le niveau de
   chaque plugin désactivé, et il n'en active aucun lui-même.

#### E2b — Vault de confiance

4. **Rappel :**
   > Un vault de confiance ne doit contenir aucun plugin tiers non vérifié. Je l'ai contrôlé.
5. Selon le contrôle :
   - **Tous les plugins sont vérifiés :** confiance accordée si elle ne l'est pas déjà, clé récupérée, vault enregistré
     **comme vault de confiance**.
   - **Au moins un plugin n'est pas vérifié :** le vault **n'est pas** enregistré comme vault de confiance. Le wizard
     liste les plugins en cause et propose deux sorties :
     - l'enregistrer comme **vault tiers** (E2a) ;
     - pour un plugin **de l'annuaire**, le déclarer de confiance (§4.4), après avoir montré son niveau. Pour un
       plugin **hors annuaire**, ce choix n'est proposé qu'après un second avertissement (décision D8).

**Le choix de l'utilisateur ne suffit jamais.** Répondre « de confiance » ne fait pas sauter le contrôle : c'est le
contrôle qui décide. Répondre « tiers » pour un vault entièrement vérifié est toujours permis : c'est le choix le plus
prudent.

## 6. Sécurité

- Le routeur ne détient jamais d'accès root. L'agent n'expose que la liste fermée du §4.3.
- Le port de débogage d'Obsidian n'est jamais joignable hors du conteneur.
- La confiance n'est jamais accordée en bloc : seulement quand tous les plugins sont vérifiés (E1, E2b), ou avec le
  seul Local REST API actif (E2a).
- Aucune clé ne passe par la conversation ni par le panneau.
- Ouvrir un vault ne réutilise jamais une fenêtre existante. C'est ce qui a coupé games.kiviri.fr le 28/10.
- Un skill d'un vault n'est jamais **chargé comme skill** sans scan et sans accord, et l'accord est lié à l'empreinte
  d'un instantané. Exception assumée : la relecture par IA lit forcément son contenu ; elle se fait dans un contexte
  isolé, qui le traite comme une donnée (§4.9, point 3).
- Le routeur n'écrit dans le workspace que dans les dossiers `vault--…` qu'il gère sous `.claude/skills/`, dans ses
  dossiers temporaires `.claude/.vault-staging-…/` et `.claude/.vault-retired-…/`, et dans l'entrée de `.gitignore`
  autorisée par D9 (§4.9, point 7 ; §4.10.5).
- Ces outils sont réservés au mode local, comme `provision_vault`. Ils sont absents des déploiements partagés (MCPHub).

## 7. Décisions à prendre par Roland

Chaque décision liste les options, ce qu'elles impliquent concrètement, et une recommandation. La recommandation n'est
pas une décision.

### D1 — Où le wizard s'ouvre par défaut

Les deux affichages existent (§4.1). La question est seulement : lequel s'ouvre en premier ?

- **Option A : celui de la porte.** Le bouton du panneau ouvre le wizard dans le panneau. La slash command et le
  langage naturel l'ouvrent dans le chat.
- **Option B : toujours le chat**, avec un bouton « ouvrir dans le panneau ».
- **Option C : toujours le panneau**, avec un bouton « continuer dans le chat ». Si le panneau est fermé, il s'ouvre.
- **Recommandation : A.** C'est ce que l'utilisateur attend de l'endroit où il a cliqué ou tapé.

### D2 — Le clic de confiance sur le PC

Sur le PC, Obsidian est déjà ouvert par Roland, sans port de débogage. Trois options :

- **Option A : relancer Obsidian avec le port de débogage.** Le routeur ferme Obsidian et le relance avec
  `--remote-debugging-port`, sur `127.0.0.1` seulement.
  - Aucun clic.
  - Toutes les fenêtres Obsidian du PC se ferment puis se rouvrent. Une note en cours de frappe peut perdre les
    dernières secondes de saisie.
  - Tant qu'Obsidian tourne ainsi, n'importe quel programme du PC peut le piloter, donc lire et modifier tous les
    vaults locaux. Il faut le relancer sans ce port juste après, donc une seconde fermeture.
- **Option B : un seul clic guidé.** Le wizard ouvre le vault et dit exactement où cliquer. Le test de l'API attend
  le clic et le détecte tout seul.
  - Aucun risque ajouté, aucune fenêtre fermée.
  - Un clic, contre l'exigence E4 au sens strict.
- **Option C : écrire la confiance quand Obsidian est fermé.** Si Obsidian ne tourne pas, le routeur écrit la clé de
  confiance dans le profil avant de l'ouvrir. Si Obsidian tourne, retour à l'option B.
  - Aucun clic quand Obsidian est fermé.
  - Écrire dans la base interne d'Obsidian dépend de sa version et peut casser à une mise à jour. **À VÉRIFIER** en
    phase 0.
- **Recommandation : C, avec B en repli.** C'est la seule option sans risque ajouté. Elle évite le clic quand c'est
  possible.

### D3 — Les droits de l'agent sur le serveur

L'agent doit pouvoir modifier le compose, ouvrir une fenêtre dans le conteneur et poser une règle de pare-feu. Trois
modèles :

- **Option A : groupe `docker` + `sudo` limité à un script fixe pour le pare-feu.**
  - Simple à installer.
  - Être dans le groupe `docker` revient presque à être root : on peut lancer un conteneur qui monte `/`. Si l'agent
    est compromis, le serveur l'est aussi.
- **Option B : agent sans droits + exécuteur root séparé.** L'agent dépose une demande, au format fixe, dans un
  dossier. Un petit service root, déclenché par systemd, la vérifie et l'exécute.
  - Si l'agent est compromis, l'attaquant ne peut que déposer des demandes de la liste fermée.
  - Deux composants à écrire et à tester. Une action prend une à deux secondes de plus.
- **Option C : agent root.**
  - Le plus simple.
  - Un défaut dans l'agent donne le serveur entier. Contraire à la règle « sécurité non négociable ».
- **Recommandation : B.** C'est le seul modèle où une faille de l'agent ne donne pas le serveur.

### D4 — Un plugin dont l'identifiant est connu, mais pas l'empreinte

Exemple : le vault contient Local REST API 3.2.0, le catalogue connaît 3.1.0. Ou bien un plugin de l'annuaire dont le
code a été modifié localement.

- **Option A : le traiter comme non vérifié.** En E2b, le vault est refusé comme vault de confiance.
  - Le plus sûr : une version modifiée peut contenir n'importe quoi.
  - Chaque mise à jour d'un plugin bloque l'enregistrement tant que le catalogue n'a pas suivi.
- **Option B : l'accepter avec un avertissement.**
  - Pratique.
  - Un plugin trafiqué qui garde son nom passe le contrôle.
- **Option C : accepter seulement les versions publiées.** Le routeur compare l'empreinte à celle de la release
  officielle du plugin sur GitHub, celle qu'Obsidian a analysée.
  - Sûr et pratique : une mise à jour officielle passe, un code modifié non.
  - Demande un accès réseau au moment du contrôle, et ne marche pas pour un plugin hors annuaire.
- **Recommandation : A pour démarrer**, C dans un second temps.

### D5 — En sortant du mode restreint (E2a), le bridge est-il actif aussi ?

Tu as écrit « seul le plugin Local REST API with MCP ». Le squelette en a deux obligatoires : `obsidian-local-rest-api`
et `mcp-router-bridge`.

- **Option A : Local REST API seul.** Le routeur lit et écrit les notes. Le bridge est désactivé, donc pas
  d'ouverture d'une note depuis un lien cliquable, ni ce que le bridge apporte d'autre au routeur.
- **Option B : Local REST API et le bridge.** Le bridge est notre plugin, donc vérifié. Toutes les fonctions du
  routeur marchent.
- **Recommandation : B**, à condition que le bridge du vault ait l'empreinte du catalogue. Sinon, A.

### D6 — Les hôtes de l'agent

- **Option A : Dedibox et QNAP.** Le QNAP sert de banc d'essai, et la Dedibox n'est touchée qu'après.
- **Option B : Dedibox seule.** Moins à installer, mais chaque essai se fait en production.
- **Recommandation : A**, conforme à la règle « QNAP = dev, Dedibox = prod ».

### D7 — Un vault déposé par Nicolas ou Amélie

- **Option A : toujours vault tiers.** Mode restreint, Local REST API seul.
- **Option B : le contrôle décide.** La question « de confiance ou tiers ? » est posée comme pour tout vault, et le
  contrôle des plugins tranche.
- **Recommandation : B.** C'est le contenu du vault qui compte, pas la personne qui l'a déposé.

### D8 — Les plugins hors annuaire, y compris BRAT

BRAT est dans notre squelette. Il sert à installer des plugins **hors annuaire**, donc non analysés par Obsidian. Un
vault de confiance qui contient BRAT peut donc, plus tard, recevoir un plugin non vérifié sans passer par le routeur.

- **Option A : garder BRAT dans le squelette.** On s'en sert pour nos propres plugins en développement. Le routeur
  refait le contrôle à chaque démarrage de session, et signale un plugin apparu depuis l'enregistrement.
- **Option B : retirer BRAT du squelette.** Un vault créé par le modèle ne peut plus installer de plugin hors annuaire
  aussi facilement. Nos plugins en développement s'installent alors autrement.
- **Option C : BRAT présent mais désactivé par défaut.** On l'active à la main quand on en a besoin.
- **Pour un plugin hors annuaire déclaré de confiance par Roland :** autorisé seulement après un second avertissement,
  et seulement avec son empreinte. Une nouvelle version le fait repasser en « non vérifié ».
- **Recommandation : C**, plus le contrôle à chaque démarrage de session de l'option A.

### D9 — Où sont copiés les skills activés — **TRANCHÉE le 2026-10-30 : option A**

**Décision de Roland (2026-10-30) :** option A, telle que précisée par §4.9 point 7. La copie va dans `.claude/skills/`
du workspace, dans le dossier géré par le routeur ; une ligne `.gitignore` ne couvre que ce dossier ; si la destination
est déjà suivie par git, le routeur refuse et le dit. Le dossier visé exactement est fixé en §4.10.5.

- **Option A : dans `.claude/skills/` du workspace**, avec une ligne ajoutée au `.gitignore` du workspace.
  - Le skill ne sert que dans ce workspace, comme demandé. Il n'est pas publié avec le code par erreur.
  - Un collègue qui clone le dépôt ne l'a pas : il doit l'activer lui-même, avec son propre scan.
- **Option B : dans `.claude/skills/` du workspace, suivi par git.**
  - L'équipe partage les mêmes skills.
  - Le skill d'un vault tiers entre dans l'historique du dépôt, et un collègue le charge sans passer par le scan.
- **Option C : dans le dossier personnel `~/.claude/skills/`.**
  - Contraire à E6 : le skill servirait dans tous les projets.
- **Recommandation : A.**

### D10 — Les skills écrits pour lire le vault sur le disque — **TRANCHÉE le 2026-10-30 : option B**

**Décision de Roland (2026-10-30) :** option B, telle que précisée par §4.9 point 10. L'en-tête du routeur est placé
**après** le frontmatter YAML, jamais avant. Un skill qui dépend du disque (chemins en dur, scripts) est classé « à
adapter ». L'artefact installé a sa propre empreinte, et l'en-tête porte un numéro de version (§4.10.3).

Les skills de LihFolk cherchent le vault dans « le dossier qui contient ce `.claude` », puis dans la variable
`ROBLOX_VAULT`, puis demandent. Copiés dans un workspace, ils ne trouvent plus le vault : il est derrière le routeur.

- **Option A : copier tel quel.** Le skill demandera le chemin, ou échouera.
- **Option B : ajouter un en-tête du routeur.** Le routeur ajoute en tête du `SKILL.md` copié un court paragraphe :
  « Ce vault est accessible par le routeur sous le nom X. Lis-le avec les outils du routeur (`search`, `get_file`…),
  pas sur le disque. » Le reste du skill n'est pas modifié.
  - Le skill marche sans retouche manuelle. L'empreinte approuvée reste celle de l'original, l'en-tête est généré.
  - L'en-tête est un texte du routeur, testé une fois pour toutes, pas une réécriture du skill.
- **Option C : ne pas adapter, mais signaler.** La fiche dit « ce skill lit le disque » et l'utilisateur adapte à la
  main, comme pour les copies de Crea-Jeu.
- **Recommandation : B.**

### D11 — Jusqu'où la relecture par IA lit les notes — **TRANCHÉE le 2026-10-30 : option C**

**Décision de Roland (2026-10-30) :** option C. La relecture par IA lit en entier les notes que les skills font lire et
les fichiers de consignes de la racine ; une recherche automatique de formules d'injection, sans IA, passe sur toutes
les notes. Les notes relues sont enregistrées comme dépendances de l'accord (§4.9 point 11).

Un vault comme LihFolk compte environ 810 notes et 1,8 million de mots. Les relire toutes coûte cher à chaque scan.

- **Option A : toutes les notes.** Le plus complet. Coûteux, et à refaire à chaque changement.
- **Option B : les notes que les skills font lire, plus les fichiers de consignes de la racine.** Ce sont les seules
  dont le texte devient une consigne pour Claude du fait du skill.
  - Coût limité. Une note lue plus tard par une recherche ordinaire n'est pas couverte.
- **Option C : B, plus une recherche automatique de formules d'injection dans toutes les notes** (« ignore les
  instructions précédentes », « exécute », adresses de serveurs inconnus…), sans relecture par IA.
- **Recommandation : C.**

### D12 — Un skill injecté qui change dans le vault — **TRANCHÉE le 2026-10-30 : option B**

**Décision de Roland (2026-10-30) :** option B. La copie approuvée reste en place et continue de servir ; la tuile
avertit « modifié depuis l'accord ». La nouvelle version n'est installée qu'après un nouveau scan et un nouvel accord.
La même règle vaut quand une note dépendante change (D11) : la copie reste, le skill passe « à revoir ».

- **Option A : désactivation automatique.** La copie est retirée et la tuile signale « modifié, à rescanner ».
- **Option B : la copie reste, avec un avertissement.** L'ancienne version approuvée continue de servir.
- **Option C : mise à jour automatique** si le nouveau scan ne trouve rien.
- **Recommandation : B.** La copie en place est celle qui a été approuvée, donc la garder ne fait courir aucun risque
  nouveau. La nouvelle version n'est injectée qu'après scan et accord.

### D13 — Activer un skill depuis Obsidian — **TRANCHÉE le 2026-10-30**

**Décision de Roland :** Obsidian affiche les skills, et les interrupteurs sont à trois endroits, à égalité : le
panneau du mod, le chat, et les réglages du plugin MCP Router Bridge dans Obsidian
(`tboome33/obsidian-mcp-router-bridge`, identifiant `mcp-router-bridge`, confirmé par Roland le 2026-10-30).

**Ce que la décision doit respecter.** Tout ce qui est écrit dans un vault peut avoir été préparé par son auteur : un
vault tiers pourrait arriver avec un fichier qui dit « skills activés ». Un interrupteur d'Obsidian ne doit donc
compter que s'il a été **cliqué pendant la session**, par l'utilisateur.

**Ce qu'un jeton ne peut pas prouver (revue Codex du 2026-10-30, constats 2 à 4).** La v4 affirmait que l'auteur d'un
vault tiers ne connaît pas la clé de l'API. C'est faux : §4.7 *récupère* une clé existante, sans la renouveler, et le
routeur lit `restData.apiKey` (`src/registry.mjs:368`) ; un vault distribué peut garder une clé que son auteur connaît.
Et surtout, un jeton de session ne prouve pas qu'un humain a cliqué : un bridge modifié, ou tout autre plugin actif
dans la même fenêtre Obsidian, reçoit le jeton et peut signer de fausses demandes. Le mécanisme corrigé :

1. **L'accord vit dans la configuration de l'utilisateur**, hors du vault et hors du projet (§4.9, point 4). Les
   réglages du bridge l'affichent, ils ne le stockent pas.
2. **Un clic dans Obsidian n'active directement que dans un environnement d'exécution de confiance** : le vault est
   un vault de confiance au sens d'E2b (tous ses plugins actifs vérifiés), le bridge actif a l'empreinte du catalogue,
   et la clé de l'API a été émise par le routeur (pas reprise du vault). Sinon, le clic dans Obsidian crée une
   **demande en attente**, que l'utilisateur confirme dans le panneau ou le chat. Les trois endroits gardent leurs
   interrupteurs ; seul leur effet diffère selon ce que le routeur peut garantir.
3. **Le protocole de demande** : chaque processus routeur ouvre sa propre session (identifiant de session tiré au
   hasard, gardé en mémoire par le bridge) ; chaque demande porte un identifiant unique, une date d'expiration courte,
   le workspace, le skill, l'empreinte de l'instantané scanné et l'action ; elle est signée (HMAC-SHA-256 sur un
   encodage canonique défini en phase 0). Le routeur refuse une demande rejouée, expirée, d'une autre session, ou dont
   l'empreinte n'est plus celle de l'accord ; il acquitte chaque demande traitée ; deux demandes contraires sur le même
   skill sont appliquées dans l'ordre de leur horodatage. Toutes les routes (session, état, file de demandes) exigent
   la clé de l'API.
4. **Un skill « à risque »** demande toujours une confirmation dans le panneau ou le chat, même depuis un
   environnement de confiance.
5. **Un fichier de demandes trouvé dans le vault est ignoré**, quel que soit son contenu.

**À VÉRIFIER en phase 6 :** le délai entre le clic dans Obsidian et sa prise en compte par le routeur (lecture à la
demande ou à intervalle).

## 8. Plan

| Phase | Contenu | Critère de fin |
|---|---|---|
| 0 | Essai sur un vault jetable du QNAP : trouver où est rangée la confiance, l'écrire par le protocole de débogage, recharger une seule fenêtre. Mesurer aussi l'option C de D2. | L'API du vault jetable répond 200 sans clic, et un autre vault de la même instance n'a pas été interrompu (mesuré). |
| 1 | Catalogue des plugins dans `contracts/`, calculé depuis le squelette, contrôlé par `npm run validate`. Contrôle des plugins (§4.5) et niveaux (§2.2). | Une empreinte modifiée dans le squelette fait échouer `validate`. Un plugin hors annuaire est classé comme tel. |
| 2 | Agent de vaults (Python stdlib, comme le view-agent), selon D3, avec sa suite de tests, installé sur le QNAP. | Les 6 actions sont testées. Une action hors liste est refusée. |
| 3 | Outil `vault_wizard` (les étapes sous forme de données), skill et slash commands, affichage dans le chat : E2b, puis E1 (local puis distant), puis E2a. | Un parcours complet par cas, sur un vrai serveur, sans aucune commande tapée. |
| 4 | Affichage du wizard dans le panneau des vaults, passage chat ↔ panneau en cours de route. | Un test montre que les deux affichages présentent les mêmes étapes, dans le même ordre, avec les mêmes textes. Un parcours commencé dans le panneau se termine dans le chat. |
| 5 | Déploiement sur la Dedibox, puis réenregistrement de LihFolk et de games.kiviri.fr par l'agent. | 9/9 vaults du conteneur commun enregistrés par l'agent, sans qu'aucune clé soit affichée. |
| 6 | Skills des vaults (§4.8 et §4.9, livrés en premier ; découpage détaillé dans la roadmap `vault-skills-roadmap` du vault du routeur) : route `GET /mcp-router-bridge/skills` dans le bridge (avec ses tests et une nouvelle version du bridge), inventaire, scan (SkillSpector + relecture IA), indicateur et liste dans la tuile, interrupteurs, injection avec manifeste, interrupteurs dans l'onglet du bridge avec jeton de session (D13), dont un test qui montre qu'un fichier de demandes glissé dans le vault n'active rien. Phase 0 étendue d'abord : Claude Code charge-t-il un skill ajouté en cours de session ? | Sur LihFolk : 16/16 skills listés avec leur fiche ; un skill activé est chargé dans le workspace lié et lit le vault par le routeur ; un octet modifié dans le vault fait passer la tuile à « modifié, à rescanner » (mesuré). |

Ce document n'est pas listé dans `contracts/export-allowlist.json`, comme les autres specs de `docs/superpowers/` : il
n'est pas publié.
