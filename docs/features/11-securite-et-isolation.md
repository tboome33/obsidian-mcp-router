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
2. **Outil MCP** : `lock_vault({ vault: "tradingview" })`, avec `persist: true` pour écrire dans le `.env`.
3. **Variable d'env au démarrage** : `OBSIDIAN_ROUTER_LOCKED=tradingview` dans le `.env` du workspace — le router démarre déjà verrouillé.

Déverrouiller : *« déverrouille les vaults »* — `/obsidian-router:unlock` (ou `unlock_vaults`, `persist: true` pour aussi nettoyer le `.env`). Changer de cible : re-verrouiller directement — le nouveau lock remplace l'ancien atomiquement.

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

## Les garde-fous anti-accident, en travers de toutes les features

Une série de protections plus petites, décrites dans leurs fiches respectives mais rassemblées ici parce qu'elles forment une politique cohérente :

- **Suppression confirmée** — `delete_file` exige `confirm: true` explicite ; la slash command impose un aperçu avant confirmation ([fiche 3](03-ecriture-et-edition.md)).
- **Garde anti-SSRF** — les outils de conversion d'URL refusent les hôtes privés et loopback : impossible de s'en servir pour sonder votre réseau interne ([fiche 6](06-ingestion-web.md)).
- **Bac à sable de lecture** — `MD_ALLOWED_PATHS` restreint les répertoires que les outils de conversion de fichiers peuvent lire ([fiche 5](05-conversion-de-documents.md)).
- **Provisioning borné** — `provision_vault` refuse de créer un vault hors des racines connues, et les outils wizard sont **local-only** (masqués sur les déploiements gated) ([fiche 13](13-installation-et-administration.md)).
- **Secrets jamais logués** — une variable `VAULT_*` malformée est signalée sans jamais logger sa valeur (qui peut contenir la clé API) ; les secrets des configs générées sont des placeholders, jamais inventés.
- **Écritures gated** — le mode `FullAuto` de l'auto-enrichissement embarque un filtre de sensibilité (jamais de credentials/médical/financier auto-sauvés) et un plafond par session ([fiche 7](07-wiki-gestion-de-connaissances.md)).
