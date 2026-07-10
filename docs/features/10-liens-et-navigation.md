# 10 · Liens et navigation

Quand Claude cite une note, ce lien doit **ouvrir la note dans Obsidian d'un clic** — pas afficher un chemin mort à copier-coller. Cette famille de features couvre tous les cas : vault local avec navigateur, vault local sans navigateur, vault distant dans un container.

## Click-to-open — un clic dans le chat ouvre Obsidian

**Le besoin.** Un chemin de fichier écrit en texte dans une réponse de chat n'est pas cliquable — ou pire, devient un lien cassé. Le résultat : friction à chaque citation de note.

**Ce que ça fait.** Le plugin **bridge** (≥ 0.2.0) expose une route `GET /open/<chemin>` sur le serveur HTTP local de Local REST API. Un lien markdown `[label](http://127.0.0.1:<port>/open/<chemin-encodé>)` collé dans le chat devient cliquable : le clic passe par le navigateur, atteint le bridge, qui fait naviguer Obsidian vers le fichier — et l'onglet navigateur se referme tout seul. Un paramètre `?h=<Titre>` fait défiler jusqu'à une section précise. La route est **loopback-only et navigation-only** : elle ne lit, n'écrit et n'exécute rien.

**Comment l'utiliser.** Vous n'avez normalement rien à faire : **tous les outils qui touchent un fichier** (`write_file`, `get_file`, `patch_file`, `search`…) retournent déjà l'URL prête (`clickToOpenUrl`), et Claude la colle dans ses réponses.

## `build_open_link` — fabriquer un lien sans toucher au fichier

**Le besoin.** Citer une note qu'aucun outil n'a lue ni écrite dans la session (une référence croisée, une cible de wikilink) — sans composer l'URL à la main, source d'erreurs d'encodage et de mauvais port.

**Ce que ça fait.** Construit l'URL click-to-open (et le lien markdown prêt à coller) pour un fichier — ou **un lot** de fichiers en un seul appel — sans lecture ni écriture. Gère l'encodage, lit le bon port par vault, accepte une ancre de section.

**Comment l'utiliser.**

```jsonc
{ "paths": ["wiki/references/router-agents.md", "wiki/Decisions/okf.md"] }
{ "path": "wiki/projects/roadmap.md", "anchor": "Phase 2" }
```

**À savoir.** Retourne une URL nulle quand le vault est distant ou que le serveur HTTP du bridge n'est pas activé — dans ce cas, voir `open_in_obsidian` ou les smart links ci-dessous.

## `open_in_obsidian` — ouvrir sans navigateur

**Le besoin.** Certains clients (Claude Desktop notamment) font transiter les liens cliqués par un navigateur, ce qui ajoute une étape parasite. Et parfois on veut juste dire *« ouvre-moi cette note »* — sans lien du tout.

**Ce que ça fait.** Appelle la route `/open` du bridge **côté serveur** : Obsidian navigue vers la note et sa fenêtre passe au premier plan, sans navigateur du tout. Une `anchor` optionnelle défile jusqu'à un titre. C'est le pendant sans-navigateur du click-to-open. Navigation uniquement — rien n'est modifié.

**Comment l'utiliser.**

> « ouvre cette note dans Obsidian », « montre-moi la section Installation de X dans Obsidian »

**À savoir.** Sur un vault **distant** (container), il ne peut pas lever une fenêtre locale : il retourne alors un lien (`opened: false, delivered: "link"`) — voir les deux mécanismes suivants.

## View links — le lien vers l'interface d'un vault distant

**Le besoin.** Un vault qui tourne dans un container sur un serveur a une interface Obsidian **dans le navigateur** (GUI streamée). Quand Claude y écrit une note, on veut un lien qui ouvre cette interface, déjà positionnée sur la note.

**Ce que ça fait.** En configurant `OBSIDIAN_ROUTER_VIEW_AGENT_URL` (plus un secret partagé optionnel), le router interroge un *view-link provider* et attache à chaque écriture de note un `viewLink` prêt à cliquer vers l'interface live du vault, naviguée sur la note. L'outil `get_view_link` apparaît alors (il est masqué tant que rien n'est configuré — pas de surface morte).

**À savoir.** Le router ne dépend que d'un petit contrat HTTP (`GET /view?vault=…&note=…` → `{"url": …}`), pas d'une infrastructure précise. Implémentation de référence : [obsidian-mcp-router-view-agent](https://github.com/tboome33/obsidian-mcp-router-view-agent) (Python stdlib, tunnels cloudflared éphémères).

## Smart links — des liens signés, stables, sans appel réseau

**Le besoin.** Les view links ont deux limites : générer le lien appelle un agent (une écriture peut être ralentie par un agent en panne), et le lien expire avec le tunnel — un lien dans l'historique de chat d'il y a trois semaines est mort.

**Ce que ça fait.** En configurant `OBSIDIAN_ROUTER_SMART_LINK_URL` + `OBSIDIAN_ROUTER_SMART_LINK_SECRET`, chaque écriture émet un lien signé HMAC vers un résolveur (`<resolver>/o/<token>`) : **calcul pur, zéro appel réseau** au moment de l'écriture, et le lien reste valide 30 jours dans l'historique. Le lien se résout **sur l'appareil qui clique** : mirroir Obsidian local détecté → deep link `obsidian://` ; sinon → interface streamée.

**À savoir.** Quand les deux mécanismes sont configurés, priorité : smart link → view-agent → rien. Configurer les smart links signale un déploiement **distant** — ne les activez pas sur un router purement local, sinon `open_in_obsidian` rendra un lien au lieu de naviguer votre Obsidian.

## `/meta-audit-bridge-readiness` — vérifier que tout ça marche

**Le besoin.** Le click-to-open dépend de plusieurs conditions par vault (version du bridge, version de Local REST API, serveur HTTP activé) ; quand un lien ne s'ouvre pas, il faut savoir **lequel** des maillons manque.

**Ce que ça fait.** Audite chaque vault : bridge ≥ 0.2.0, Local REST API ≥ 4.0.0, serveur HTTP non chiffré activé, et une **sonde live** qui confirme que la route `/open/*` est réellement enregistrée en mémoire.

**Comment l'utiliser.**

> « audite la disponibilité du bridge », « le click-to-open est-il prêt ? » — ou `/obsidian-router:meta-audit-bridge-readiness`

**À savoir.** Le lien HTTP (port `insecurePort`) est préféré au HTTPS parce que certains antivirus (Bitdefender, ESET, Kaspersky) tuent silencieusement les connexions HTTPS loopback à certificat auto-signé — symptôme : le clic ne fait rien, sans aucun message. La route `/open` étant navigation-only et loopback-only, HTTP y est sans risque.
