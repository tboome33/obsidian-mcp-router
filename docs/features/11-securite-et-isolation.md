# 11 · Sécurité et isolation

Un routeur qui voit **tous** vos vaults doit aussi savoir se restreindre : à un seul vault le temps d'une session, à un sous-ensemble pour un utilisateur donné, à la lecture seule pour un invité. Et refuser structurellement les accidents — suppression hallucinée, requête vers le réseau interne, vault sensible servi sur un lien exposé.

## Lock mode — verrouiller la session sur un seul vault

**Le besoin.** Trois situations où le multi-vault devient un risque : travailler sur un vault **sensible** (juridique, médical) sans qu'une écriture parte ailleurs par accident ; une installation **partagée** où chacun doit rester dans son vault ; une longue session d'ingestion où l'assistant ne doit pas « aider » en classant des choses dans un vault voisin.

**Ce que ça fait.** Une fois verrouillé sur un vault :

| Opération | Comportement |
|---|---|
| Appel visant le vault verrouillé | ✅ passe normalement |
| Appel **sans** `vault` explicite | ✅ résolu vers le vault verrouillé (court-circuite la cascade de défaut) |
| Appel visant un **autre** vault | ❌ refusé avec un message explicite |
| Fan-out `vault: "*"` | ❌ refusé |
| `list_vaults` | ✅ fonctionne toujours ; expose `lockedTo` pour afficher l'état |

**Comment l'utiliser.** Trois portes d'entrée :

1. **Langage naturel / slash command** : *« verrouille sur tradingview »*, *« je ne veux travailler que sur tradingview »* — ou `/obsidian-router:lock tradingview` (volatile), `--persist` pour survivre au redémarrage.
2. **Outil MCP** : `lock_vault({ vault: "tradingview" })`, avec `persist: true` pour enregistrer le verrou sur la liaison du workspace — l'endroit que relit un redémarrage — et écrire l'indice portable dans le `.env`.
3. **Variable d'env au démarrage** : `OBSIDIAN_ROUTER_LOCKED=tradingview` **depuis l'hôte** (déclaration du serveur MCP, shell) — le router démarre déjà verrouillé. La même ligne dans le `.env` d'un projet ne verrouille plus : verrouiller est la façon la plus forte de choisir où atterrissent les écritures, donc un fichier qui voyage avec un clone peut le proposer, pas l'imposer.

Déverrouiller : *« déverrouille les vaults »* — `/obsidian-router:unlock` (ou `unlock_vaults`, `persist: true` pour lever le verrou sur la liaison **et** nettoyer le `.env`). Changer de cible : re-verrouiller directement — le nouveau lock remplace l'ancien atomiquement.

**À savoir.** `persist: true` est **refusé quand le répertoire courant est votre home** : c'est presque toujours un lancement de Claude Code depuis `~` par erreur, et créer un `~/.env` surprendrait. Le lock en mémoire s'applique quand même pour la session.

## Multi-tenant — un router partagé, des droits par instance

**Le besoin.** Héberger le router derrière un hub (MCPHub, proxy) pour plusieurs utilisateurs : chacun ne doit voir que **ses** vaults, certains ne doivent pas pouvoir écrire, et on veut savoir **qui** a écrit quoi.

**Ce que ça fait.** Trois variables d'environnement indépendantes et composables — sans aucune, le comportement mono-utilisateur est inchangé :

| Variable | Effet |
|---|---|
| `OBSIDIAN_ROUTER_ALLOWED_VAULTS=a,b,c` | **Whitelist** : l'instance ne voit que ces vaults. Appliquée avant la résolution du vault par défaut, donc le défaut tombe dans le sous-ensemble autorisé. |
| `OBSIDIAN_ROUTER_READONLY=true` | **Lecture seule** : les 8 outils d'écriture sont retirés de la liste des outils **et** refusés à l'appel — même un client qui connaît le nom de l'outil et l'appelle directement est bloqué. |
| `OBSIDIAN_ROUTER_USER_ID=<slug>` | **Audit** : chaque écriture réussie ajoute une ligne horodatée `[claude-write by <slug>] … <outil> path="…"` au `wiki-meta/journal.md` du vault touché. Best-effort : un échec d'audit ne bloque jamais l'écriture. |

**Comment l'utiliser.** Un exemple d'instance scoped dans la config d'un hub :

```json
"obsidian-router-karine": {
  "command": "obsidian-mcp-router",
  "env": {
    "OBSIDIAN_ROUTER_ALLOWED_VAULTS": "karine",
    "OBSIDIAN_ROUTER_READONLY": "true",
    "OBSIDIAN_ROUTER_USER_ID": "karine-guest"
  }
}
```

## Garde de transport — jamais un vault sensible sur un lien exposé

**Le besoin.** Sur un déploiement serveur, une erreur de configuration ne doit pas pouvoir servir un vault médical ou juridique sur une URL publique non chiffrée.

**Ce que ça fait.** `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK=true` fait **refuser le démarrage** du router si l'hôte du `baseUrl` d'un vault servi n'est ni loopback (`127.0.0.1`/`::1`/`localhost`) ni dans le mesh WireGuard `10.8.0.0/24`. C'est un contrôle **fail-closed** à l'amorçage, sur la configuration : un vault ne peut jamais être servi silencieusement sur un lien exposé. Le contrôle passe après la whitelist `ALLOWED_VAULTS`.

**À savoir.** Opt-in : non défini = aucun changement en local. L'ancien nom `OBSIDIAN_ROUTER_REQUIRE_WIREGUARD` fonctionne encore comme alias déprécié.

## Un vault atteint sans être déclaré — le refus propose, vous tranchez

**Le besoin.** Avec `vaultReach: "declared"`, un vault n'est joignable que depuis un workspace qui le déclare, en principal ou en secondaire. Le refus existait déjà ; ce qu'il ne savait pas faire, c'était dire **quoi faire ensuite** sous une forme que l'assistant ne puisse pas déformer. Une phrase du genre « rattachez ce workspace au vault » se traduit naturellement en `confirm_workspace_binding({ vault: X })` — un appel qui **remplace** le principal et perd tous les secondaires.

**Ce que ça fait.** Le refus porte désormais un objet, `bindingProposal` :

| Champ | Ce qu'il dit |
|---|---|
| `proposedRole` | `primary` si ce workspace n'a aucune liaison, `secondary` s'il en a déjà une |
| `currentPrimary` | le principal en vigueur, quand il y en a un |
| `grants` | ce que le oui accorde, en toutes lettres |
| `willOpen` | si accepter ouvrira le vault dans Obsidian |
| `accept` / `refuse` | l'appel exact, prêt à recopier |

L'objet est rendu **dans le texte d'abord**, puis dans `_meta` : tout client MCP lit le texte, alors que `_meta` est un passthrough que la spécification autorise un client à ignorer.

**Dire oui.** `confirm_workspace_binding({ accept: "<proposalId>" })`. L'identifiant est dérivé de l'état de la liaison — workspace, vault, rôle, empreinte — donc il ne résout que contre la liaison pour laquelle il a été frappé. Si une autre session a ajouté un secondaire, changé un palier ou effacé la liaison entre-temps, le oui est refusé sans rien écrire. **Réordonner les secondaires n'est pas un changement** : l'empreinte les trie, et le contrôle qui applique le oui les trie aussi, pour que les deux moitiés ne puissent pas donner deux sens différents aux mêmes mots.

Après un refus, relancez l'appel et **lisez ce qui revient**. Ce sera une proposition neuve, ou une réussite si l'autre session a déjà lié ce vault, ou un refus sans proposition si elle l'a refusé ou si la liaison est à réparer. La session se rafraîchit depuis le fichier avant de répondre — sauf si ce fichier est illisible à cet instant, auquel cas elle s'en tient au dernier état qu'elle a **vu**, jamais à un état plus ancien. Laquelle des trois réponses, cela dépend de ce que l'autre session a fait.

**Un appel qui n'écrit rien laisse votre session tranquille.** Ni le vault par défaut, ni le verrou, ni la liaison — et ce dernier point compte plus qu'il n'en a l'air, puisque c'est la liaison qui décide quels vaults cette session peut atteindre. Ce qui rend l'avis ci-dessus exact n'est donc pas une adoption, c'est que la **proposition est frappée depuis le fichier** : un identifiant mort parce qu'une session parallèle a bougé la liaison est remplacé, sans que rien ne soit installé. Seuls les refus sont repris à vue : rien ne route par eux, et un non posé ailleurs doit être honoré tout de suite.

Et un verrou ne se lève que par qui l'a posé : un `lock_vault` de cette session survit à un changement de liaison, tandis qu'un `lock_vault --persist`, inscrit **sur** la liaison, la suit — c'est le sens même de l'avoir persisté.

L'acceptation **ajoute**. Le vault devient principal si le workspace n'avait rien, sinon il entre dans `also` en lecture seule souple, et chaque secondaire existant garde son palier. C'est précisément ce que `{ vault: X }` ne fait pas.

**Ce qui ne propose jamais rien**, et chacun pour sa raison :

- un vault d'`openVaults`, joignable de partout par construction : l'appel passe, il n'y a rien à proposer ;
- un vault que vous avez **refusé** : le refus n'est plus reproposé, et `retract` est le chemin de retour. Écrire une liaison qui nomme ce vault lève aussi le refus — c'est un effet de bord de l'écriture, pas un raccourci à conseiller : passer `vault` **remplace** le principal et perd les secondaires non repassés ;
- une liaison dont le principal n'existe pas sur cette machine : elle est à **réparer**, pas à étendre ;
- une liaison que le fichier tient dans une forme **incohérente** — un vault deux fois dans `also`, le principal listé comme son propre secondaire, un secondaire dans les deux paliers, un palier qui nomme un vault sans rôle, un champ mal formé, ou **aucun principal utilisable** à côté de secondaires ou d'un verrou : même raison. Le refus nomme chaque faute et **épelle la liaison entière à repasser**, verrou compris, avec les paliers que le routeur conserverait. La lecture indulgente continue de router la session (un vault dans les deux paliers est lu verrouillé, la direction sûre) ; elle ne décide plus de ce qui peut être proposé. Et le oui d'une proposition frappée avant qu'une main ne rende le fichier incohérent est refusé de même, sans rien écrire : l'identifiant, dérivé de la lecture réparée, ne voit pas un doublon — le contrôle, lui, le voit. Seule une entrée **absente ou vide** vaut « aucune liaison » et propose un principal. Un secondaire que **cette** session ne sait pas atteindre (retiré du fichier, ou fourni par l'environnement d'une autre session) est **nommé et conservé**, jamais retiré par une réparation ni motif de refuser une proposition : une réparation garde ce qui était là, et seul un principal que personne ne peut lier bloque. Et parce qu'elle garde tout, la réparation épelée peut se lire, une fois normalisée, comme la liaison que l'entrée incohérente voulait dire : le routeur **réécrit quand même le fichier** — une entrée qu'il a dû réparer pour la lire n'est jamais « inchangée » — sans quoi le doublon restait sur disque derrière un succès annoncé, et l'accès suivant rendait le même diagnostic. Le succès qui conserve un secondaire que cette session ne sait pas résoudre le dit (`notLoadedHere` dans la réponse : déclaré, palier gardé, « Unknown vault » d'ici) au lieu de le promettre « adressable par son nom » ; un vault que la configuration **désactive** (`disabledVaults`) est refusé comme désactivé — ni « non listé », ni « à enregistrer », rien qu'un redémarrage lève — à l'accès, à la confirmation et dans le diagnostic ; et le diagnostic distingue un secondaire conservé que le fichier désactive, un que le fichier a retiré mais dont cette session tient encore le descripteur jusqu'au prochain démarrage (l'accès dépend alors du verrou et du routage), et un que personne n'a. Cette règle « jamais inchangée » ne regarde que **l'entrée écrite** : une liaison incohérente d'un autre workspace de la même config ne force pas la réécriture du fichier (qui tient toutes les clés API) à chaque appel sans rapport ; et une écriture **conserve les champs que cette version ne connaît pas**. `set_secondary_vault_mode` suit la même règle que le verrou, le déverrouillage et la confirmation : il refuse, réparation épelée, de réécrire une entrée que le routeur a dû réparer pour la lire — changer le palier d'un secondaire ne normalise plus le reste en silence. Le succès qui conserve un secondaire irrésolu d'ici dit **laquelle** des absences : désactivé (et encore tenu par cette session, ou non), listé par le fichier mais pas dans le catalogue de cette session, ni listé ni fourni ; le verrou persisté le dit de même pour l'ancien principal qu'il fait passer secondaire. **Tous les writers de l'enregistrement suivent la règle**, pas seulement les outils MCP : l'import de migration au démarrage n'écrase plus une entrée que le routeur a dû réparer pour la lire (verdict non définitif : l'indice est relu une fois l'entrée réparée), et les commandes `--link-workspace` et `--attach` refusent une entrée incohérente en épelant la réparation, refusent de promouvoir un secondaire strict en principal, jugent les noms par le fichier relu sous verrou, et disent ce qu'un déplacement vers un autre principal abandonne. `disabledVaults` désactive **par nom ou par chemin** pour chaque writer et chaque diagnostic, comme pour le chargeur. **Ce que cette liste fait, exactement** (décision du 2026-09-20 — le mot « désactivé » laisse croire davantage) : elle exclut le vault des **chargements suivants** et interdit toute **nouvelle déclaration** de ce vault dans une liaison. Elle **ne révoque pas** l'accès d'une session déjà démarrée qui tient ce vault et que son routage autorise déjà à l'atteindre : celle-ci continue de répondre jusqu'à son redémarrage. Désactiver un vault n'est donc pas une coupure d'accès immédiate, c'est une règle sur ce qui se charge et sur ce qui peut être déclaré — pour couper une session en cours, il faut la redémarrer. La question « le fichier le désactive-t-il encore ? » a **une seule réponse**, partagée par l'accès, l'inventaire et le verrou, avec **trois issues** et non deux : encore désactivé, réactivé depuis le démarrage (il faut redémarrer pour le charger), ou **invérifiable** parce que le fichier n'a pas pu être lu — dit comme tel, plutôt que le verdict du démarrage rendu au présent. `--link-workspace` juge le principal par le fichier relu sous verrou, comme `--attach` ; `--attach` **conserve** un secondaire que l'entrée déclare déjà même si le fichier le désactive depuis, exactement comme la confirmation, et dit quand il **lève le verrou** du workspace en échangeant le principal et un secondaire (aucun nom ne disparaît, mais l'isolation, si) ; et les deux refus disent que l'indice portable du `.env` a déjà été écrit — « rien n'a été enregistré » ne vaut que pour la configuration. `set_secondary_vault_mode` adopte le verrou de la liaison qu'il adopte, mais **seulement si cette session a chargé ce principal** — poser un verrou sur un vault qu'elle ne résout pas refuserait tous les appels jusqu'au déverrouillage, ce que `lock_vault` refuse lui-même —, et il **rapporte** le principal et le verrou d'avant et d'après : un appel sur le palier d'un secondaire peut changer le routage de la session, ce qui ne doit pas être silencieux. L'appel de réparation épelé porte **`ifBindingDigest`**, l'empreinte de l'entrée **telle que le fichier la tient** : `confirm_workspace_binding` ne l'applique que si le fichier tient encore exactement cette entrée-là, et refuse sans rien écrire si une autre session l'a changée — ou supprimée — entre-temps. L'empreinte porte sur la **valeur** de l'entrée, pas sur les octets du fichier : elle est calculée sur une re-sérialisation canonique (clés triées), de sorte qu'une simple remise en forme du `config.json` ne la périme pas, tandis que tout changement de contenu de l'entrée la périme ; la même idée que l'identifiant de proposition, pour la réparation. Cette réparation **conserve les paliers** des secondaires qui restent secondaires, même quand l'entrée n'avait pas de principal, et **ne peut pas promouvoir** en principal un secondaire que l'entrée tient en lecture seule stricte : le texte dit ce qu'elle garde, et cet appel-là est refusé ;
- un vault que le fichier **déclare déjà** alors que cette session n'a pas rechargé : rien à accepter, l'autre session l'a lié — relancez, ou redémarrez ;
- un vault que le fichier de configuration ne liste pas — jamais enregistré, ou retiré depuis le démarrage de cette session, local **ou distant** : il ne peut pas être inscrit dans une liaison, donc le proposer reviendrait à vous tendre un oui qui butera sur un mur. Seule exception, voulue : un distant que l'**environnement** fournit (`VAULT_*`), que le fichier ne liste jamais et que chaque démarrage refournit ;
- un déploiement partagé — `OBSIDIAN_ROUTER_READONLY` à une valeur vraie, ou `OBSIDIAN_ROUTER_ALLOWED_VAULTS`, ou `OBSIDIAN_ROUTER_USER_ID` renseignés — où aucun verbe d'acceptation n'existe : proposer serait envoyer contre un mur ;
- `list_vaults`, qui est un **inventaire et non une offre** : une proposition naît d'un accès, sans quoi vingt vaults non déclarés deviendraient vingt questions d'un coup.

**Et le refus se lit dans le fichier, pas dans la mémoire de la session.** Deux routers partagent ici une seule configuration : un non enregistré dans l'une arrête l'autre **avant** qu'elle propose, et un non repris cesse de la faire taire. Protéger l'écriture seule serait trop tard — la question aurait déjà été reposée.

**Sans `vaultReach`, rien de tout cela ne change quoi que ce soit** : l'interrupteur est absent par défaut, il n'y a alors aucun refus d'atteignabilité, donc aucune proposition.

**Une limite dite plutôt que masquée.** Le chat Desktop démarre dans le dossier de l'application et n'appartient à aucun projet — mais ce dossier et un projet honnête encore non lié sont, pour le routeur, la même chose : un répertoire sans entrée au registre. Plutôt qu'une heuristique qui se tromperait dans les deux sens, une proposition qui créerait une **première** liaison **nomme le répertoire** qu'elle lierait et invite à refuser si ce n'est pas un projet.

## Réparer une liaison — la garantie passe de la phrase au code

**Le besoin.** Jusqu'ici, « une réparation ne perd rien » était une propriété de la **phrase**, pas du programme. Quand le routeur ne savait pas lire l'entrée d'un workspace, il épelait un appel `confirm_workspace_binding` nommant tout ce qu'il fallait garder : chaque secondaire, chaque palier local, `locked: true`. Qui recopiait cet appel ne perdait rien. Qui écrivait le sien perdait ce qu'il avait oublié. La décision du 2026-09-20 (`politique-desactive-et-reparation-des-liaisons`) demande que la garantie devienne une règle du code.

**Ce que ça fait.** Le transformateur qui décide de ce qui sera écrit vit maintenant à un seul endroit et connaît **deux modes** :

| Mode | Ce qu'il fait |
|---|---|
| **remplacement** | le comportement de `confirm_workspace_binding`, inchangé : l'appel nomme la liaison, et un secondaire non renommé disparaît |
| **réparation** | conserve les secondaires de l'entrée, leurs paliers **locaux**, le verrou et les champs inconnus — par règle, pas par mémoire |

La décision a explicitement **écarté** l'option qui aurait imposé de nommer tout retrait dans tous les writers : l'API générale ne casse pas.

**Le défaut que le déplacement referme.** `locked` se déduisait de la lecture **réparée** de l'entrée, qui vaut `null` pour une entrée sans principal utilisable — c'est-à-dire précisément l'entrée qu'une réparation vise. Réparer une telle entrée perdait donc son verrou, et seule la phrase épelée le remettait. Le verrou se reprend désormais de l'entrée **telle qu'écrite**, exactement comme les paliers depuis un tour antérieur.

**Ce qui est conservé, c'est la donnée LOCALE, jamais le palier EFFECTIF.** Le palier effectif d'un secondaire se calcule à la lecture, à partir des listes de la liaison **et** des listes globales de la configuration, le strict l'emportant partout. Figer ce résultat dans l'entrée créerait une restriction locale qui **survivrait à la suppression de la règle globale** qui l'a causée. L'aperçu **affiche** le palier effectif — sans quoi « alsoLocked : aucun » se lit à tort comme « écrivable » au-dessus d'un vault qu'une règle globale tient strict — mais il ne l'écrit nulle part, et il ne fait pas partie du sceau.

**Et conserver `locked: true` en changeant de principal DÉPLACE le verrou** sur un autre vault : ce n'est pas un booléen reporté, c'est une isolation qui change de cible. Le plan et le message le disent.

### L'ancien principal est RÉTROGRADÉ, jamais perdu

`also` ne contient jamais le principal. Lire « ce que l'entrée tient » dans `also` seul manquait donc le nom que l'entrée tient le plus fermement : réparer `{ vault: "notes", also: ["work"] }` vers un autre principal gardait `work` et faisait **disparaître** `notes` — sans que rien le nomme, puisque `notes` n'avait jamais été un secondaire à abandonner.

L'ancien principal rejoint désormais `also`, **en tête**, sans palier propre — exactement ce que `lock_vault --persist` fait depuis toujours quand il inscrit un secondaire comme nouveau principal. Seul le mode `repair` agit ainsi ; `confirm_workspace_binding` remplace comme avant.

**Et ce qui est annoncé est le fait LOCAL.** Un principal est toujours en lecture-écriture ; l'accès d'un secondaire se décide avec les listes de la liaison **et** les listes globales. Sans palier local ni règle globale, il est en lecture seule jusqu'à confirmation de chaque écriture — mais un `alsoWritable` global le rend écrivable, et un `alsoLocked` global le rend strict, où aucune confirmation n'autorise plus rien. Déduire le palier soft de l'absence de palier local, c'est précisément la confusion que `keep()` existe pour empêcher.

Un ancien principal que le fichier ne sait plus lier est conservé lui aussi — un nom que l'entrée tient est gardé — et **signalé** : désactivé et absent reçoivent des remèdes opposés (réenregistrer ne lève rien pour un désactivé), et le texte dit ce que la conservation préserve vraiment : un rattachement **futur** par ce nom, pas une archive inerte.

### Question 4(b), tranchée : non

Un secondaire tenu en lecture seule **stricte** n'est jamais promu principal. La mesure qui a tranché : l'autoriser ne lèverait pas la protection une fois, cela l'**effacerait**.

```
DÉPART    vault=notes  also=["sci"]   alsoLocked=["sci"]
ÉTAPE 1   vault=sci    also=["notes"] alsoLocked=[]        ← sci promu
ÉTAPE 2   vault=notes  also=["sci"]   alsoLocked=[]        ← on revient
```

Mêmes noms, mêmes places, palier strict disparu, et aucun acte ne l'a jamais nommé. La raison est mécanique : un palier qualifie un *rôle de secondaire*, donc il part avec le rôle et ne revient pas avec lui.

Promouvoir un secondaire **soft ou writable** reste permis : `lock_vault --persist` sur un secondaire fait exactement cela, et c'est une fonctionnalité voulue — « j'isole ma session sur mon vault de référence pendant que je travaille dessus ». Le chemin en deux actes pour lever un strict reste ouvert : effacer la liaison, puis la recréer. Il est visible, lui.

## Réparer depuis le terminal — `setup-vault.mjs --repair-binding`

**Le besoin.** Une liaison que le routeur ne sait pas lire était diagnostiquée partout et réparable à un seul endroit : une session MCP dont le **serveur** a ce workspace pour répertoire de travail. Un opérateur au terminal recevait un appel qu'il ne pouvait pas passer. La décision du 2026-09-20 ouvre ce chemin (points 4a et 5).

```
setup-vault.mjs --repair-binding <workspace> [--primary <vault>] [--locked|--no-locked] --dry-run
setup-vault.mjs --repair-binding <workspace> ...  --approved-plan-sha256 <hash>
```

`--primary` n'est nécessaire que si l'entrée ne nomme aucun principal que le fichier sache lier — la seule chose qu'une réparation ne peut pas décider seule, et qu'une personne tranche. Omettre `--locked`/`--no-locked` conserve le verrou tel quel.

**Le `--dry-run` montre le plan** : les anomalies trouvées, ce qui serait écrit (principal, secondaires, paliers locaux, palier effectif, verrou, champs inconnus conservés), ce que l'opération **ne fera pas**, et les conséquences qui se lisent à l'envers si on ne les dit pas — le déplacement du verrou, et le fait que **retirer un secondaire peut rendre l'écriture permise** : `alsoWriteTierFor` rend `null` avant même de consulter les listes globales dès qu'un nom n'est plus dans `also`, et un palier `null` laisse écrire. Un vault tenu en lecture seule stricte, retiré de `also` mais resté joignable autrement, devient **écrivable**.

**L'application exige le sceau** que le `--dry-run` a imprimé — plus strict que les autres flux scellés de ce script, parce qu'une réparation de liaison s'applique par quelqu'un qui a lu ce qu'elle garde. Deux préconditions, deux questions différentes : l'empreinte de l'entrée demande « l'entrée a-t-elle bougé ? », le sceau demande « le plan approuvé est-il encore celui qui va s'appliquer ? ». Les deux, pas l'une pour l'autre.

**Le sceau est lié au WORKSPACE et au FICHIER de configuration**, pas à un vault. Une réparation de liaison n'agit sur aucun vault ; détourner l'identité de vault aurait laissé un plan prévisualisé pour un workspace confirmer une application sur un autre dès que les deux choisissent le même principal. Il couvre **ce que l'opération écrit** : le principal, les secondaires et leurs paliers locaux, le verrou, ce qui est abandonné, les entrées **alias** que l'écriture supprime (avec l'empreinte de leur contenu), les refus qu'elle retire, et les métadonnées de confirmation — `confirmedVia` et la **date**, en valeur. Conséquence à connaître : un sceau ne survit pas au passage de minuit, parce que l'écriture ne stamperait plus la même date.

**Ce qu'elle ne fait jamais** : promouvoir en principal un secondaire tenu en lecture seule stricte (refusé dès le `--dry-run`, avant qu'un sceau existe — question 4(b), tranchée le 2026-09-21 : non) ; enregistrer, ouvrir ou joindre un vault ; toucher au `.env` du workspace ; et **créer** une liaison là où il n'y en a pas — c'est le travail d'`--attach`, qui écrit aussi l'indice `.env`, les réglages du plugin et le bloc CLAUDE.md qu'un workspace lié depuis ici n'aurait jamais.

**Et elle n'affirme rien sur une session déjà démarrée.** Le routeur **surveille** sa configuration et tente un rechargement quand les changements se stabilisent : une session en cours peut donc prendre le changement sans redémarrer. Mais un rechargement qui échoue garde l'état précédent, et la surveillance peut être coupée (`--no-watch`) ou abandonnée après une erreur. Redémarrez la session si vous devez en être sûr.

## Les garde-fous anti-accident, en travers de toutes les features

Une série de protections plus petites, décrites dans leurs fiches respectives mais rassemblées ici parce qu'elles forment une politique cohérente :

- **Suppression confirmée** — `delete_file` exige `confirm: true` explicite ; la slash command impose un aperçu avant confirmation ([fiche 3](03-ecriture-et-edition.md)).
- **Garde anti-SSRF** — les outils de conversion d'URL refusent les hôtes privés et loopback : impossible de s'en servir pour sonder votre réseau interne ([fiche 6](06-ingestion-web.md)).
- **Bac à sable de lecture** — `MD_ALLOWED_PATHS` restreint les répertoires que les outils de conversion de fichiers peuvent lire ([fiche 5](05-conversion-de-documents.md)).
- **Provisioning borné** — `provision_vault` refuse de créer un vault hors des racines connues, et les outils wizard sont **local-only** (masqués sur les déploiements gated) ([fiche 13](13-installation-et-administration.md)).
- **Secrets jamais logués** — une variable `VAULT_*` malformée est signalée sans jamais logger sa valeur (qui peut contenir la clé API) ; les secrets des configs générées sont des placeholders, jamais inventés.
- **Écritures gated** — le mode `FullAuto` de l'auto-enrichissement embarque un filtre de sensibilité (jamais de credentials/médical/financier auto-sauvés) et un plafond par session ([fiche 7](07-wiki-gestion-de-connaissances.md)).
