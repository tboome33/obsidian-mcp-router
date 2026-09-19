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
- une liaison que le fichier tient dans une forme **incohérente** — un vault deux fois dans `also`, le principal listé comme son propre secondaire, un secondaire dans les deux paliers, un palier qui nomme un vault sans rôle, un champ mal formé, ou **aucun principal utilisable** à côté de secondaires ou d'un verrou : même raison. Le refus nomme chaque faute et **épelle la liaison entière à repasser**, verrou compris, avec les paliers que le routeur conserverait. La lecture indulgente continue de router la session (un vault dans les deux paliers est lu verrouillé, la direction sûre) ; elle ne décide plus de ce qui peut être proposé. Et le oui d'une proposition frappée avant qu'une main ne rende le fichier incohérent est refusé de même, sans rien écrire : l'identifiant, dérivé de la lecture réparée, ne voit pas un doublon — le contrôle, lui, le voit. Seule une entrée **absente ou vide** vaut « aucune liaison » et propose un principal. Un secondaire que **cette** session ne sait pas atteindre (retiré du fichier, ou fourni par l'environnement d'une autre session) est **nommé et conservé**, jamais retiré par une réparation ni motif de refuser une proposition : une réparation garde ce qui était là, et seul un principal que personne ne peut lier bloque. Et parce qu'elle garde tout, la réparation épelée peut se lire, une fois normalisée, comme la liaison que l'entrée incohérente voulait dire : le routeur **réécrit quand même le fichier** — une entrée qu'il a dû réparer pour la lire n'est jamais « inchangée » — sans quoi le doublon restait sur disque derrière un succès annoncé, et l'accès suivant rendait le même diagnostic. Le succès qui conserve un secondaire que cette session ne sait pas résoudre le dit (`notLoadedHere` dans la réponse : déclaré, palier gardé, « Unknown vault » d'ici) au lieu de le promettre « adressable par son nom » ; un vault que la configuration **désactive** (`disabledVaults`) est refusé comme désactivé — ni « non listé », ni « à enregistrer », rien qu'un redémarrage lève — à l'accès, à la confirmation et dans le diagnostic ; et le diagnostic distingue un secondaire conservé que le fichier désactive, un que le fichier a retiré mais que cette session sert encore jusqu'au prochain démarrage, et un que personne n'a. L'appel de réparation épelé porte **`ifBindingDigest`**, l'empreinte de l'entrée **telle que le fichier la tient, octet pour octet** (l'ordre des clés mis à part) : `confirm_workspace_binding` ne l'applique que si le fichier tient encore exactement cette entrée-là, et refuse sans rien écrire si une autre session l'a changée — ou supprimée — entre-temps ; la même idée que l'identifiant de proposition, pour la réparation. Cette réparation **conserve les paliers** des secondaires qui restent secondaires, même quand l'entrée n'avait pas de principal, et **ne peut pas promouvoir** en principal un secondaire que l'entrée tient en lecture seule stricte : le texte dit ce qu'elle garde, et cet appel-là est refusé ;
- un vault que le fichier **déclare déjà** alors que cette session n'a pas rechargé : rien à accepter, l'autre session l'a lié — relancez, ou redémarrez ;
- un vault que le fichier de configuration ne liste pas — jamais enregistré, ou retiré depuis le démarrage de cette session, local **ou distant** : il ne peut pas être inscrit dans une liaison, donc le proposer reviendrait à vous tendre un oui qui butera sur un mur. Seule exception, voulue : un distant que l'**environnement** fournit (`VAULT_*`), que le fichier ne liste jamais et que chaque démarrage refournit ;
- un déploiement partagé — `OBSIDIAN_ROUTER_READONLY` à une valeur vraie, ou `OBSIDIAN_ROUTER_ALLOWED_VAULTS`, ou `OBSIDIAN_ROUTER_USER_ID` renseignés — où aucun verbe d'acceptation n'existe : proposer serait envoyer contre un mur ;
- `list_vaults`, qui est un **inventaire et non une offre** : une proposition naît d'un accès, sans quoi vingt vaults non déclarés deviendraient vingt questions d'un coup.

**Et le refus se lit dans le fichier, pas dans la mémoire de la session.** Deux routers partagent ici une seule configuration : un non enregistré dans l'une arrête l'autre **avant** qu'elle propose, et un non repris cesse de la faire taire. Protéger l'écriture seule serait trop tard — la question aurait déjà été reposée.

**Sans `vaultReach`, rien de tout cela ne change quoi que ce soit** : l'interrupteur est absent par défaut, il n'y a alors aucun refus d'atteignabilité, donc aucune proposition.

**Une limite dite plutôt que masquée.** Le chat Desktop démarre dans le dossier de l'application et n'appartient à aucun projet — mais ce dossier et un projet honnête encore non lié sont, pour le routeur, la même chose : un répertoire sans entrée au registre. Plutôt qu'une heuristique qui se tromperait dans les deux sens, une proposition qui créerait une **première** liaison **nomme le répertoire** qu'elle lierait et invite à refuser si ce n'est pas un projet.

## Les garde-fous anti-accident, en travers de toutes les features

Une série de protections plus petites, décrites dans leurs fiches respectives mais rassemblées ici parce qu'elles forment une politique cohérente :

- **Suppression confirmée** — `delete_file` exige `confirm: true` explicite ; la slash command impose un aperçu avant confirmation ([fiche 3](03-ecriture-et-edition.md)).
- **Garde anti-SSRF** — les outils de conversion d'URL refusent les hôtes privés et loopback : impossible de s'en servir pour sonder votre réseau interne ([fiche 6](06-ingestion-web.md)).
- **Bac à sable de lecture** — `MD_ALLOWED_PATHS` restreint les répertoires que les outils de conversion de fichiers peuvent lire ([fiche 5](05-conversion-de-documents.md)).
- **Provisioning borné** — `provision_vault` refuse de créer un vault hors des racines connues, et les outils wizard sont **local-only** (masqués sur les déploiements gated) ([fiche 13](13-installation-et-administration.md)).
- **Secrets jamais logués** — une variable `VAULT_*` malformée est signalée sans jamais logger sa valeur (qui peut contenir la clé API) ; les secrets des configs générées sont des placeholders, jamais inventés.
- **Écritures gated** — le mode `FullAuto` de l'auto-enrichissement embarque un filtre de sensibilité (jamais de credentials/médical/financier auto-sauvés) et un plafond par session ([fiche 7](07-wiki-gestion-de-connaissances.md)).
