# Remote Obsidian, remote Claude: the setup behind `view-agent-direct`

> 🇫🇷 *[Version française ci-dessous.](#-version-française)*

Clicking a note link in a Claude chat and landing in Obsidian **on that note** is ordinary when Claude,
Obsidian and your browser share one machine. This guide is for the less usual setup that
`view-agent-direct` was written for:

- **Obsidian runs on a server**, one container per vault, and you use it **in a browser** (web-streamed
  desktop, e.g. the Selkies-based `linuxserver/obsidian` image);
- **Claude runs on another machine** (a VM, a workstation) that you reach over **SSH** or a remote
  session, and it writes to the vaults through [obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router);
- a **private network** (WireGuard or any VPN) links your PC, Claude's machine and the server.

All addresses and names below are examples (`192.0.2.0/24` is reserved for documentation).

## 1. The picture

```
 reader's PC 192.0.2.20                     Claude's machine 192.0.2.30
 ┌───────────────────────────┐   SSH /      ┌──────────────────────────────┐
 │ chat UI (terminal/app)    │ ───────────▶ │ Claude Code + obsidian-mcp-   │
 │ browser                   │   remote     │ router (MCP)                  │
 └───────────┬───────────────┘   session    └──────────────┬───────────────┘
             │ private network (WireGuard)                  │ REST (write notes)
             │                                              │ GET /view  (mint a link)
             ▼                                              ▼
 vault server 192.0.2.1 ─────────────────────────────────────────────────────
   view-agent-direct :27200            container obsidian-alice
     /view  ← router                     Selkies GUI  :3001 (HTTPS)  → published 192.0.2.1:3001
     /go    ← reader's browser           Local REST API + bridge :27123 → published 192.0.2.1:27180
```

What happens on a click:

1. Claude writes a note; the router calls `GET /view?vault=alice&note=…` on the agent and puts the returned
   **signed** `/go` link in its answer (`viewLink`).
2. You click it **on your PC**: your browser, not Claude's machine, follows `http://192.0.2.1:27200/go?…`.
3. The agent checks the signature, asks the bridge's `/ping` for its click-to-open prefix, runs
   `docker exec obsidian-alice curl http://127.0.0.1:27123/mcp-router-bridge/open/<note>` (`/open/<note>`
   for a bridge older than 0.10.0 — the route only answers **its own loopback**), then answers `302` to the vault's GUI.
4. Your browser shows the streamed Obsidian, already on the note.

## 2. Why the usual answers do not work here

| Usual answer | Why it fails in this setup |
|---|---|
| An `obsidian://open?…` link | It opens the Obsidian **installed on the machine where you click**. Here Obsidian is not on your PC: it is on the server. |
| Calling the bridge's `/open` route from outside | The route is **loopback-only by design**. Even from the server itself, a Docker-published port shows the Docker bridge address, not loopback: `403 loopback only`. Do not relax that guard. |
| A tunnel (Cloudflare quick tunnel, the other provider of this repo) | Works, but adds a public hostname and a moving part for nothing when a private network already reaches the GUI. |

`view-agent-direct` is the small piece that turns "the router knows the vault" into "the reader's browser
lands on the note", without relaxing anything.

## 3. One Obsidian per vault, in a container

A minimal Compose service per vault (adapt to the image's README; pin a version rather than `latest`):

```yaml
services:
  obsidian-alice:
    container_name: obsidian-alice # fixed name: the agent and `docker exec` use it
    image: lscr.io/linuxserver/obsidian:<pinned-version>
    shm_size: "1gb"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - CUSTOM_USER=alice          # the GUI's own login: keep it
      - PASSWORD=<from a secret file, never in git>
    volumes:
      - ./config-alice:/config     # Obsidian settings, plugins
      - /srv/vaults/alice:/vaults/alice
    ports:
      - "192.0.2.1:3001:3001"      # GUI (HTTPS), on the PRIVATE address only
      - "192.0.2.1:27180:27123"    # Local REST API (HTTP), private address only
    restart: unless-stopped
```

Inside that Obsidian, open the vault and install:

- **Local REST API** — enable its non-encrypted HTTP server (default port `27123`) and keep its API key;
  the router uses it to read and write notes.
- **obsidian-mcp-router-bridge** — provides the `/open` route that navigates Obsidian (loopback-only).

Checks and traps, learnt the hard way:

- **Publish on the private address only** (`192.0.2.1:…`), never `0.0.0.0` on a public host. If you also
  filter with iptables' `DOCKER-USER` chain, remember it runs **after** Docker's DNAT: match the
  **container** port (`3001`, `27123`), not the published one.
- **Blurry text** with a low CRF: the browser sends a scaled-down resolution. Enable resizing and HiDPI in
  Selkies (`SELKIES_ENABLE_RESIZE=true`, no CSS scaling) and set the real DPI.
- **Black or frozen screen** on older Selkies generations: never JPEG together with "Turbo".
- **Full-colour 4:4:4** means software decoding in the browser: heavier on the reader's PC.
- **A `latest` tag never updates by itself**: check the running version before tuning, pull on purpose,
  and clear the site's data in the browser after a Selkies generation change (settings are remembered).
- **Sidecars sharing the container's network** (`network_mode: service:obsidian-alice`) lose their network
  when the main container is recreated, silently: recreate them too.
- Run `bash deploy/preflight-direct.sh 27180` on the server (the REST port as **published** on the host): it
  finds the container, its REST port inside the container and the values to put in the agent's config.

## 4. Install `view-agent-direct` on the vault server

Follow [README → Direct provider](../README.md#direct-provider-no-tunnel). In short:

- `bind` = the server's **private** address (`192.0.2.1`), `self_url` = how **your PC** reaches the agent
  (`http://192.0.2.1:27200`): the reader's browser follows `/go`, so binding to loopback breaks every click.
- Two secrets: `view-agent.token` (only the router may mint links) and `link.secret` (signs `/go` links).
- Either declare each vault in `vaults` (`open_mode: docker-exec`, `container`, `open_port`, `public_url`),
  or let **detection** classify the vaults the router hints at (`detect`, see the README): the one running
  container publishing the vault's REST port on this host → `docker-exec` + GUI redirect. A declared
  vault always wins over detection.
- The agent runs `docker exec`: its user is in the `docker` group, which is **root-equivalent**. Keep the
  agent on the private network and its port firewalled to your PCs and Claude's machine.

## 5. Point the router at the agent (Claude's machine)

In the environment of the MCP server (for Claude Code: the `env` block of `~/.claude/settings.json`):

```
OBSIDIAN_ROUTER_VIEW_AGENT_URL=http://192.0.2.1:27200
OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN=<content of view-agent.token>
```

Restart the Claude session: the router reads these at start. From then on, every note write in a remote vault
returns a `viewLink`, and `get_view_link` gives one on demand.

## 6. Working through SSH or a remote session

- The link is shown in **your** chat UI, and **your** browser follows it: your PC must reach the agent over the
  private network. Claude's machine only needs to reach `/view`.
- A link is signed, stable and credential-free: it can stay in the chat history. Anyone who can reach the agent
  and holds the link can navigate that vault's Obsidian (the GUI still asks for its own login).
- A token pasted in a chat is exposed: rotate it.
- What a detected link guarantees: at click time, the agent re-checks that the same container name with the
  same mounts (what Docker mounts where) answers on that port — before navigating and again right before the
  redirect — and refuses (`409`) otherwise. A detected vault (container or desktop) is only ever handed out
  through such a checked link, even without a note. A click waits at most ~18 s in the worst case (two Docker
  checks of 5 s each around the navigation), normally well under a second. It does not prove the vault's content, and a container replaced between that last check and
  the moment your browser loads the GUI cannot be caught: keep the GUI's own login.

## 7. The desktop case, side by side

A vault opened in the **desktop** Obsidian of your PC (not in a container) is the usual setup: the link
must open **your** Obsidian. `view-agent-direct` handles it with `open_mode: "obsidian-uri"` (or detection with
`detect.desktop_hosts` plus the router's `obsidian_name` hint): `/go` checks the signature and the path,
then answers `302 obsidian://open?vault=<name>&file=<note>`. Only useful from the PC running that Obsidian;
the heading anchor is not carried.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `400 unknown vault` from `/view` | Not declared, and detection could not classify it (no hint, host neither local nor desktop). The error says why. |
| `400 … indeterminate` from `/view` | The router names the server by a host NAME while a container publishes the port on an explicit address: the agent cannot tell which one the name means. Put an IP in the vault's `baseUrl` on the router side. |
| `409` on click | What Docker shows behind the link changed since it was made: another container on that port, other folders mounted (or the same ones swapped) under the same container name, or the vault is now declared in the config. The link refuses to open anything else; ask for a fresh link. The check covers what is mounted where, not the vault's content. |
| `502` page "could not be navigated (bridge HTTP 403)" | The bridge refused the call: it came from outside the container's loopback. Check `open_mode`, `container`, `open_port` (the REST port **inside** the container). |
| `502` page "bridge HTTP 404" | The bridge works but the note is not found in the vault Obsidian has open (moved, renamed, or another vault open). The page links to the GUI for a declared vault only. |
| `502` page "bridge HTTP 401" | The click-to-open route is not registered: bridge plugin missing or disabled, bridge < 0.2.0, Local REST API < 4.0.0, or Local REST API 5.4.0 with bridge < 0.10.0 (5.4.0 reserves `/open/`) — or Obsidian needs a reload. |
| `502` page with a connection error | Local REST API's HTTP server is off, or `open_port` is wrong. The note is not opened; the page links to the GUI for a declared vault only. |
| The click hangs | Your PC cannot reach the agent: private network down, `bind`/`self_url` on loopback, firewall. |
| `obsidian://` does nothing | Clicked from a machine without that desktop Obsidian, or the vault name in Obsidian differs from `obsidian_vault`. |

---

## 🇫🇷 Version française

Cliquer sur un lien de note dans une conversation avec Claude et arriver dans Obsidian **sur cette note** est
banal quand Claude, Obsidian et le navigateur sont sur la même machine. Ce guide décrit l'installation moins
courante pour laquelle `view-agent-direct` a été écrit :

- **Obsidian tourne sur un serveur**, un conteneur par vault, utilisé **dans un navigateur** (bureau streamé,
  par exemple l'image `linuxserver/obsidian`, basée sur Selkies) ;
- **Claude tourne sur une autre machine** (une VM, un poste) jointe en **SSH** ou par une session distante, et
  écrit dans les vaults via [obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router) ;
- un **réseau privé** (WireGuard ou un autre VPN) relie le PC, la machine de Claude et le serveur.

Toutes les adresses et tous les noms sont des exemples (`192.0.2.0/24` est réservé à la documentation).

### 1. Le schéma

Voir le schéma de la version anglaise ci-dessus. Le trajet d'un clic :

1. Claude écrit une note ; le router appelle `GET /view?vault=alice&note=…` sur l'agent et met le lien `/go`
   **signé** renvoyé dans sa réponse (`viewLink`).
2. Tu cliques **sur ton PC** : c'est ton navigateur, pas la machine de Claude, qui suit
   `http://192.0.2.1:27200/go?…`.
3. L'agent vérifie la signature, demande au `/ping` du bridge son préfixe click-to-open, lance
   `docker exec obsidian-alice curl http://127.0.0.1:27123/mcp-router-bridge/open/<note>` (`/open/<note>` pour un
   bridge antérieur à 0.10.0 — la route ne répond qu'à **sa propre boucle locale**), puis répond `302` vers la GUI du vault.
4. Le navigateur affiche l'Obsidian streamé, déjà sur la note.

### 2. Pourquoi les solutions habituelles ne marchent pas ici

- **Un lien `obsidian://open?…`** ouvre l'Obsidian **installé sur la machine où l'on clique**. Ici, Obsidian
  n'est pas sur ton PC mais sur le serveur.
- **Appeler `/open` du bridge depuis l'extérieur** : la route n'accepte **que la boucle locale**, par
  conception. Même depuis le serveur, un port publié par Docker présente l'adresse du pont Docker :
  `403 loopback only`. Ne pas assouplir cette garde.
- **Un tunnel** (Cloudflare, l'autre fournisseur de ce dépôt) : ça marche, mais ajoute un nom public et une
  pièce mobile inutiles quand un réseau privé atteint déjà la GUI.

### 3. Un Obsidian par vault, en conteneur

Reprendre le service Compose de la version anglaise (épingler une version plutôt que `latest`), puis, dans cet
Obsidian, installer **Local REST API** (activer son serveur HTTP non chiffré, port `27123` par défaut ; garder la
clé d'API pour le router) et **obsidian-mcp-router-bridge** (route `/open`, boucle locale seulement).

Vérifications et pièges vécus :

- **Publier sur l'adresse privée seulement** (`192.0.2.1:…`), jamais `0.0.0.0` sur un hôte public. La chaîne
  iptables `DOCKER-USER` s'applique **après** le DNAT de Docker : viser le port **du conteneur**.
- **Texte flou** malgré un CRF bas : le navigateur envoie une résolution réduite. Activer le redimensionnement
  et le HiDPI de Selkies (`SELKIES_ENABLE_RESIZE=true`, sans mise à l'échelle CSS) et régler le vrai DPI.
- **Écran noir ou figé** sur les anciennes générations de Selkies : jamais JPEG avec « Turbo ».
- **Couleur complète 4:4:4** = décodage logiciel dans le navigateur, plus lourd pour le PC.
- **Un tag `latest` ne se met jamais à jour seul** : vérifier la version avant de régler, mettre à jour
  volontairement, et vider les données du site dans le navigateur après un changement de génération.
- **Les conteneurs qui partagent le réseau du conteneur Obsidian** (`network_mode: service:…`) perdent leur
  réseau, sans erreur, quand il est recréé : les recréer aussi.
- `bash deploy/preflight-direct.sh 27180` sur le serveur (le port REST **publié** sur l'hôte) trouve le
  conteneur, son port REST interne et les valeurs à mettre dans la config de l'agent.

### 4. Installer `view-agent-direct` sur le serveur des vaults

Suivre [README → Direct provider](../README.md#direct-provider-no-tunnel). En bref :

- `bind` = l'adresse **privée** du serveur, `self_url` = l'adresse par laquelle **ton PC** joint l'agent : le
  navigateur suit `/go`, donc un agent en boucle locale casse tous les clics.
- Deux secrets : `view-agent.token` (seul le router fabrique des liens) et `link.secret` (signe les liens `/go`).
- Déclarer chaque vault dans `vaults`, ou laisser la **détection** classer ceux que le router signale : le seul
  conteneur actif qui publie le port REST du vault sur cet hôte → `docker-exec` + redirection vers la GUI. Un
  vault déclaré l'emporte toujours sur la détection.
- L'agent lance `docker exec` : son utilisateur est dans le groupe `docker`, ce qui **équivaut à root**. Garder
  l'agent sur le réseau privé et son port filtré aux PC et à la machine de Claude.

### 5. Brancher le router sur l'agent (machine de Claude)

Dans l'environnement du serveur MCP (pour Claude Code : le bloc `env` de `~/.claude/settings.json`), poser
`OBSIDIAN_ROUTER_VIEW_AGENT_URL=http://192.0.2.1:27200` et `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN` (le contenu de
`view-agent.token`), puis redémarrer la session Claude. Chaque écriture dans un vault distant renvoie alors un
`viewLink`, et `get_view_link` en donne un à la demande.

### 6. Travailler en SSH ou en session distante

- Le lien s'affiche dans **ton** interface et **ton** navigateur le suit : ton PC doit joindre l'agent par le
  réseau privé. La machine de Claude n'a besoin que de joindre `/view`.
- Un lien est signé, stable et sans identifiant : il peut rester dans l'historique. Quiconque joint l'agent et
  détient le lien peut faire naviguer l'Obsidian de ce vault (la GUI demande toujours son propre identifiant).
- Un jeton collé dans une conversation est exposé : le changer.
- Ce que garantit un lien détecté : au clic, l'agent revérifie que le même nom de conteneur, avec les mêmes
  montages (ce que Docker monte où), répond sur ce port — avant de naviguer, puis juste avant la redirection —
  et refuse (`409`) sinon. Un vault détecté (conteneur ou bureau) n'est donné que par un tel lien vérifié, même
  sans note. Un clic attend au pire ~18 s (deux vérifications Docker de 5 s autour de la navigation),
  normalement bien moins d'une seconde.
  Cela ne prouve pas le contenu du vault, et un conteneur remplacé entre cette dernière vérification et le
  chargement de la GUI par le navigateur ne peut pas être intercepté : garder l'identifiant propre de la GUI.

### 7. Le cas du bureau, en contrepoint

Un vault ouvert dans l'Obsidian **de bureau** du PC est le cas habituel : le lien doit ouvrir **ton** Obsidian.
`view-agent-direct` le gère avec `open_mode: "obsidian-uri"` (ou par détection, avec `detect.desktop_hosts` et
l'indice `obsidian_name` du router) : `/go` vérifie signature et chemin, puis répond
`302 obsidian://open?vault=<nom>&file=<note>`. Utile seulement depuis le PC où tourne cet Obsidian ; l'ancre de
titre n'est pas transmise.

### 8. Dépannage

| Symptôme | Cause probable |
|---|---|
| `400 unknown vault` sur `/view` | Vault non déclaré, et la détection n'a pas pu le classer (pas d'indice, hôte ni local ni de bureau). Le message dit pourquoi. |
| `400 … indeterminate` sur `/view` | Le router désigne le serveur par un NOM d'hôte alors qu'un conteneur publie le port sur une adresse précise : l'agent ne peut pas savoir laquelle le nom désigne. Mettre une IP dans le `baseUrl` du vault côté router. |
| `409` au clic | Ce que Docker montre derrière le lien a changé depuis sa création : un autre conteneur sur ce port, d'autres dossiers montés (ou les mêmes permutés) sous le même nom de conteneur, ou le vault est désormais déclaré dans la config. Le lien refuse d'ouvrir autre chose ; demander un nouveau lien. Le contrôle porte sur ce qui est monté où, pas sur le contenu du vault. |
| Page `502` « could not be navigated (bridge HTTP 403) » | Le bridge a refusé l'appel : il ne venait pas de la boucle locale du conteneur. Vérifier `open_mode`, `container`, `open_port` (le port REST **dans** le conteneur). |
| Page `502` « bridge HTTP 404 » | Le bridge fonctionne, mais la note est introuvable dans le vault ouvert par Obsidian (déplacée, renommée, ou autre vault ouvert). La page renvoie vers la GUI pour un vault déclaré seulement. |
| Page `502` « bridge HTTP 401 » | La route click-to-open n'est pas enregistrée : plugin bridge absent ou désactivé, bridge < 0.2.0, Local REST API < 4.0.0, ou Local REST API 5.4.0 avec un bridge < 0.10.0 (la 5.4.0 réserve `/open/`) — ou Obsidian à recharger. |
| Page `502` avec une erreur de connexion | Serveur HTTP de Local REST API coupé, ou `open_port` faux. La note n'est pas ouverte ; la page renvoie vers la GUI pour un vault déclaré seulement. |
| Le clic ne répond pas | Le PC ne joint pas l'agent : réseau privé coupé, `bind`/`self_url` en boucle locale, pare-feu. |
| `obsidian://` ne fait rien | Clic depuis une machine sans cet Obsidian de bureau, ou nom du vault dans Obsidian différent d'`obsidian_vault`. |
