# view-agent — obsidian-mcp-router's view-link provider

> **Lives in the router's repository since obsidian-mcp-router v0.104.0**, under `view-agent/`
> (imported with its history from the former standalone repository
> `tboome33/obsidian-mcp-router-view-agent`). It is **not** part of the Claude Code plugin's
> runtime: it is a separate service, deployed on the host where the Obsidian GUIs run.
>
> **Reference implementation** of the [`/view` provider contract](docs/CONTRACT.md) for [obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router) — mints **ephemeral, one-click browser links** to a vault's live Obsidian GUI, navigated to a specific note, credentials baked into the URL.
>
> 🇫🇷 *Implémentation de référence du contrat `/view` du router — fabrique des **liens navigateur éphémères en un clic** vers le GUI Obsidian d'un vault, navigué sur la note demandée, identifiants inclus dans l'URL. [Résumé français ci-dessous.](#-version-française)*

```
Claude (any MCP client)
   │  writes a note / asks to see one
   ▼
obsidian-mcp-router            OBSIDIAN_ROUTER_VIEW_AGENT_URL → this agent
   │  GET /view?vault=alice&note=Notes/hello.md   (+ X-View-Token)
   ▼
view-agent (this repo, on the host where the GUIs live)
   │  1. reuse-or-start a cloudflared quick tunnel to that vault's GUI
   │  2. navigate the GUI's Obsidian onto the note  (bridge click-to-open, prefix from its /ping)
   │  3. reply {"url": "https://user:pass@<random>.trycloudflare.com/"}
   ▼
the user clicks → the live GUI opens ON the note, nothing to type
   (the tunnel auto-closes after the idle window — never permanently exposed)
```

## Why this exists

obsidian-mcp-router (≥ 0.28.0) can hand the user a **read link** whenever the AI writes or opens a note in a remote vault: explicitly via the `get_view_link` tool, automatically as a `viewLink` field on every note-write result (≥ 0.29.0), and from `open_in_obsidian` on remote vaults (≥ 0.30.0). The router doesn't know *how* those links are made — it only speaks the small HTTP contract in [docs/CONTRACT.md](docs/CONTRACT.md). **This repo is one provider of that contract**: it assumes your vaults' Obsidian GUIs run as web-streamed containers (e.g. [`linuxserver/obsidian`](https://github.com/linuxserver/docker-obsidian), Selkies) on the same host, and exposes them on demand through [Cloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/).

Write your own provider instead (different tunneling, a real web app with signed magic links, …) — as long as it honours the contract, the router won't know the difference.

## Two providers — which one?

| | `view-agent.py` (reference) | `view-agent-direct.py` |
|---|---|---|
| Use when | the reader **cannot** reach the GUI: it must be exposed on demand | the reader **already** reaches the GUI over a private network (VPN/WireGuard) |
| Link | `https://user:pass@<random>.trycloudflare.com/`, dies after the idle window | `<agent>/go?…&s=<hmac>`, signed, stable in the chat history (optional TTL) |
| Navigation | on `/view`, before answering | on click (`/go`), from the container's loopback via `docker exec` |
| Needs | `cloudflared` | Docker access to the Obsidian container (or a host-network container) |
| Nothing to type | credentials baked into the URL | the GUI may ask for its own sign-in once |

Both speak the same [contract](docs/CONTRACT.md) on the same port: the router is configured identically for either.

## Requirements

- Python **3.8+** (stdlib only — no pip dependencies)
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on the machine (quick tunnels need no Cloudflare account)
- The vaults' Obsidian GUIs reachable from this machine (typically loopback container ports)
- *(optional, for on-note navigation)* each vault's [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) + [mcp-router-bridge](https://github.com/tboome33/obsidian-mcp-router-bridge) ≥ 0.2.0 (serves the public `/open` route)

## Quickstart

```bash
git clone --depth 1 https://github.com/tboome33/obsidian-mcp-router /tmp/obsidian-mcp-router
sudo cp -r /tmp/obsidian-mcp-router/view-agent /opt/view-agent
cd /opt/view-agent
cp config.example.json config.json        # edit: bind, vaults, GUI creds, REST endpoints
openssl rand -hex 24 > view-agent.token   # optional but recommended (2nd lock)
mkdir -p secrets                          # referenced by *_file entries in config.json
python3 view-agent.py config.json
```

Smoke-test from the machine that runs the router:

```bash
curl http://<agent-host>:27200/health
curl -H "X-View-Token: $(cat view-agent.token)" \
     "http://<agent-host>:27200/view?vault=alice&note=Notes%2Fhello.md"
```

Then configure the router instance:

```
OBSIDIAN_ROUTER_VIEW_AGENT_URL=http://<agent-host>:27200
OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN=<content of view-agent.token>
```

Run it for real with **systemd** ([deploy/view-agent.service](deploy/view-agent.service)) or the **cron launcher** ([deploy/start-view-agent.sh](deploy/start-view-agent.sh), `@reboot` + `*/2` crash recovery).

## Configuration

Everything lives in `config.json` (see [config.example.json](config.example.json) — every key is documented inline). Highlights:

| Key | Default | Notes |
|---|---|---|
| `bind` / `port` | `127.0.0.1` / `27200` | Keep it on a **private** interface (loopback or VPN/WireGuard IP) + firewall the port. |
| `idle_timeout_s` | `1800` | Tunnel auto-close window. Generous = warm tunnels across a conversation. |
| `token_file` | `view-agent.token` | When the file exists, `/view` requires the matching `X-View-Token`. |
| `vaults.<name>.gui_url` | — | The local GUI the tunnel exposes. |
| `vaults.<name>.gui_user` / `gui_password[_file]` | — | Baked into the returned URL (`https://user:pass@…`). |
| `vaults.<name>.open_url` / `open_api_key[_file]` | — | Optional: navigate Obsidian onto the note before replying. |

Secrets referenced as `*_file` are re-read on every use — rotate them without restarting.

## Direct provider (no tunnel)

`view-agent-direct.py` serves the case where the vault's Obsidian GUI (e.g. a Selkies container) is **already** reachable by the reader over a private network. Instead of opening a tunnel, `/view` returns a signed link to the agent itself; on click, `/go` verifies the signature, navigates Obsidian onto the note and redirects to the GUI. Rationale and contract details: [docs/CONTRACT.md → Providers without a tunnel](docs/CONTRACT.md#providers-without-a-tunnel).

**Desktop vaults** (`open_mode: "obsidian-uri"`): a vault served by the reader's own desktop Obsidian has no web GUI and cannot be driven from the agent's host (the bridge's `/open` is loopback-only on that machine). `/go` then verifies the signature and path and answers `302 obsidian://open?vault=<obsidian_vault>&file=<note>`: the reader's Obsidian opens the note itself. Only useful from the machine where that Obsidian runs; the heading anchor is not carried (`obsidian://open` has no heading parameter).

**Vault detection** (`detect`): a vault missing from `vaults` is classified from two optional hints the router adds to `/view` ([contract → Vault hints](docs/CONTRACT.md#vault-hints)): `rest`, the vault's Local REST API origin as the router reaches it, and `obsidian_name`, its label in Obsidian.

| The `rest` host is… | Classification |
|---|---|
| this agent's host (loopback, `bind`, the `self_url` host, `detect.local_hosts`) | the **one** running container publishing that port → `docker-exec` on it (by hex container ID, on the container-side port) + redirect to the host port publishing its GUI (`detect.gui_container_ports`, URL from `detect.gui_url`) |
| in `detect.desktop_hosts` (IP, CIDR or name) | `obsidian-uri` with `obsidian_name` (required) |
| anything else, or the hints are missing/invalid | explicit `4xx`, no link |

Rules: a `vaults` entry always wins; detection needs both `token_file` and a signing secret; the hints travel in the `/go` link under its signature, and `/go` classifies again on click (a recreated container is found, a stopped one gets an explicit error page). Docker is queried only with `docker ps --no-trunc -q` and `docker inspect --type container <ids>`, where every ID is checked to be 64 hex digits first; the inventory is cached `detect.cache_s` seconds (default 10). No port published on the right host, two containers on one port, no GUI port, a remote host not listed: all are `400` with the reason. Docker unreachable, or slower than the 5 s detection deadline (lock wait included), is `503`. A detected vault, even without a note, always gets a signed `/go` link.

Why `docker exec`: the bridge's `/open` route answers loopback callers only. From the host, a Docker-published port presents the Docker bridge IP, so the call gets `403`. The agent therefore runs `curl http://127.0.0.1:<port>/open/...` **inside** the container. With a host-network container, `open_mode: "http"` calls it directly.

```bash
# from the view-agent/ folder of a clone of obsidian-mcp-router:
#   git clone --depth 1 https://github.com/tboome33/obsidian-mcp-router && cd obsidian-mcp-router/view-agent

# 0. on the host running the Obsidian container — read-only checks, prints config values
bash deploy/preflight-direct.sh 27180

# 1. install
sudo useradd -r -s /usr/sbin/nologin -G docker viewagent        # if absent
sudo mkdir -p /opt/view-agent-direct
sudo cp view-agent-direct.py /opt/view-agent-direct/
sudo cp config.direct.example.json /opt/view-agent-direct/config.json   # edit: bind, self_url, vaults
openssl rand -hex 24 | sudo tee /opt/view-agent-direct/view-agent.token >/dev/null
openssl rand -hex 24 | sudo tee /opt/view-agent-direct/link.secret >/dev/null
sudo chown -R viewagent:viewagent /opt/view-agent-direct
sudo chmod 600 /opt/view-agent-direct/view-agent.token /opt/view-agent-direct/link.secret

# 2. service + firewall (the router's host calls /view, the reader's browser follows /go)
sudo cp deploy/view-agent-direct.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now view-agent-direct
sudo ufw allow from <your-vpn-subnet> to any port 27200 proto tcp
```

Configuration keys beyond the reference's `bind` / `port` / `token_file`:

| Key | Default | Notes |
|---|---|---|
| `self_url` | `http://<bind>:<port>` | Base URL under which the **reader's browser** reaches the agent. |
| `link_secret_file` | `link.secret` | HMAC secret for `/go` links. Absent: signed with the token. Both absent: unsigned. |
| `link_ttl_s` | `0` | `0` = stable links. `> 0` = `/go` answers `410` after that many seconds, and `/view` reports it as `idle_timeout_s`. |
| `navigate_on_view` | `false` | `true` also navigates on `/view`, which makes Obsidian jump on every note the router writes. |
| `vaults.<name>.public_url` | — | The GUI as the reader sees it; redirect target. |
| `vaults.<name>.open_mode` | `docker-exec` | `docker-exec` (`container`, `open_port`) · `http` (`open_url`) · `none` · `obsidian-uri` (`obsidian_vault`; no `public_url`). |
| `vaults.<name>.obsidian_vault` | — | `obsidian-uri` only: the vault's name as the reader's desktop Obsidian knows it. |
| `detect.enabled` | `true` | Classify vaults absent from `vaults` from the router's hints. With it, `vaults` may be empty. |
| `detect.desktop_hosts` | `[]` | Hosts whose vaults open in the reader's desktop Obsidian. Empty = no desktop vault is ever detected. |
| `detect.local_hosts` | `[]` | Extra names/IPs for this host (loopback, `bind` and the `self_url` host are implied). |
| `detect.gui_container_ports` | `[3001]` | Container-side GUI port(s), first published one wins. Published on several host ports (a shared container with one origin per vault), the lowest host port is used. |
| `detect.gui_url` | `https://{host}:{port}/` | Reader-side GUI URL; `{host}` = the `rest` host (the `self_url` host when that is loopback). Must be `http(s)://{host}:{port}` plus an optional path: the redirect lands exactly on the host and port whose publication was checked, never a fixed host or a proxy. |
| `detect.cache_s` | `10` | Seconds a Docker inventory is reused (a Docker failure: at most 5 s). |
| `detect.docker_path` / `detect.curl_path` | `docker` / `curl` | Binaries for detected vaults (curl runs inside the container). |
| `vaults.<name>.open_scheme` | `http` | `docker-exec`: `https` when `open_port` is the REST API's TLS port (curl `-k`, on loopback). |

The `/view` answer also reports `open_mode` and `source` (`config`, `container <name>` or `desktop <host>`) for diagnosis.

What the link contains: vault name, note path, optional anchor and expiry, for a detected vault the router's hints (`r` = REST origin, `o` = Obsidian name), and a signature. No credentials. Following it only navigates and redirects to a GUI that is already private and keeps its own auth.

## Security model (defence in depth)

1. **Network** — the agent listens on a private interface only; firewall the port to that network (e.g. `ufw allow from <your-vpn-subnet> to any port 27200 proto tcp`).
2. **Token** — with `view-agent.token` in place, only the router (which holds the same secret) can mint links; other hosts on the private network get `401`.
3. **Ephemeral exposure** — unguessable `*.trycloudflare.com` hostnames that die after the idle window. The GUI is never a permanently exposed service.
4. **GUI auth** — the GUI's own basic-auth remains the last gate while a tunnel is up.

What the returned link contains: the GUI's user/password **in the URL** (that's the point — one click, nothing to type). Treat a minted link like a session cookie: it's as sensitive as the GUI behind it, for as long as the tunnel lives.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

Stdlib-only test suite — boots the real HTTP handler on an ephemeral port with a fake tunnel runner (no cloudflared needed): contract shape, token gate, unknown-vault 400, tunnel reuse, 502 on tunnel failure, idle reaper, `/open` navigation with Bearer auth. The direct provider's suite uses a fake navigator (no Docker needed): signed-link shape, click-time navigation and redirect, bad signature, signed expiry, escaped failure page — and, with a fake `docker` that records every argv, vault detection: container and desktop classification, manual config first, ambiguity and missing-GUI errors, signed hints, validation of Docker's own output.

## Repo layout

```
view-agent.py              the reference agent (single file, stdlib only)
view-agent-direct.py       the tunnel-less provider (single file, stdlib only)
config.example.json        documented config template for view-agent.py  (copy → config.json)
config.direct.example.json documented config template for view-agent-direct.py
docs/CONTRACT.md           the /view provider contract (normative)
deploy/                    systemd units, cron launcher, direct-provider preflight
tests/                     unittest suites (no cloudflared, no Docker required)
```

---

## 🇫🇷 Version française

**Quoi** — l'implémentation de référence du contrat `/view` d'[obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router) : quand l'IA écrit ou ouvre une note d'un vault distant, le router demande à cet agent un **lien navigateur éphémère** vers le GUI Obsidian du vault (conteneur streamé type Selkies), **navigué sur la note**, identifiants inclus dans l'URL — un clic, rien à taper. Le tunnel (Cloudflare quick tunnel) se ferme tout seul après la fenêtre d'inactivité : le GUI n'est jamais exposé en permanence.

**Modèle provider** — le router ne dépend QUE du contrat HTTP documenté dans [docs/CONTRACT.md](docs/CONTRACT.md) (`GET /view?vault=&note=` → `{"url": …}`), pas de cette implémentation. Ce dépôt en est *un* fournisseur possible ; écrivez le vôtre (autre tunneling, web app à magic-links signés…) et le router n'y verra que du feu.

**Sécurité (défense en profondeur)** — ① l'agent n'écoute que sur un réseau **privé** (loopback ou IP VPN/WireGuard, pare-feu sur le port) ; ② **token partagé** optionnel (`view-agent.token` ↔ `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN`, en-tête `X-View-Token`) pour que seul le router puisse fabriquer des liens ; ③ tunnels **éphémères** à hostname imprévisible ; ④ l'auth basique du GUI reste le dernier verrou. Un lien fabriqué se traite comme un cookie de session.

**Second provider, sans tunnel** — `view-agent-direct.py` sert le cas où le lecteur joint **déjà** le GUI par un réseau privé (WireGuard). `/view` rend un lien **signé HMAC** vers l'agent lui-même (`/go?…`), stable dans l'historique du chat ; au clic, l'agent vérifie la signature, navigue Obsidian sur la note (appel `/open` depuis le loopback du conteneur, par `docker exec`) puis redirige vers le GUI. Aucun identifiant dans le lien. Config : `config.direct.example.json` ; contrôles préalables : `deploy/preflight-direct.sh`.

**Vaults de bureau** (`open_mode: "obsidian-uri"`) : un vault servi par l'Obsidian de bureau du lecteur n'a pas de GUI web et ne peut pas être piloté depuis l'hôte de l'agent. `/go` vérifie alors signature et chemin, puis répond `302 obsidian://open?vault=<obsidian_vault>&file=<note>` : c'est l'Obsidian du lecteur qui ouvre la note. Utile seulement depuis la machine où tourne cet Obsidian ; l'ancre de titre n'est pas transmise.

**Détection des vaults** (`detect`) : un vault absent de `vaults` est classé à partir de deux indices optionnels que le router ajoute à `/view` ([contrat → Vault hints](docs/CONTRACT.md#vault-hints)) : `rest`, l'origine de la Local REST API du vault telle que le router la joint, et `obsidian_name`, son nom dans Obsidian. Si l'hôte de `rest` est celui de l'agent (loopback, `bind`, hôte de `self_url`, `detect.local_hosts`), l'agent cherche **le** conteneur en marche qui publie ce port : `docker-exec` sur son ID hexadécimal, port interne, puis redirection vers le port publié de sa GUI (`detect.gui_container_ports`, URL selon `detect.gui_url`) ; si ce port GUI est publié sur plusieurs ports hôte (un conteneur partagé, une origine par vault), le plus petit est retenu. Si l'hôte figure dans `detect.desktop_hosts` (IP, CIDR ou nom), le vault est ouvert dans l'Obsidian de bureau : `obsidian-uri` avec `obsidian_name`, obligatoire. Sinon, ou si les indices manquent ou sont invalides : `400` explicite, jamais de lien deviné. Une entrée `vaults` prime toujours. La détection exige `token_file` et un secret de signature. Les indices voyagent dans le lien `/go` sous sa signature, et `/go` reclasse au clic : un conteneur recréé est retrouvé, un conteneur arrêté donne une page d'erreur explicite. Docker n'est interrogé que par `docker ps --no-trunc -q` puis `docker inspect --type container <ids>`, chaque ID étant d'abord vérifié (64 chiffres hexadécimaux). Deux conteneurs sur un port, pas de port GUI, hôte distant non listé : `400` avec la raison ; Docker injoignable ou plus lent que l'échéance de détection de 5 s (attente du verrou comprise) : `503`. Un vault détecté, même sans note, reçoit toujours un lien `/go` signé. `detect.gui_url` doit être de la forme `http(s)://{host}:{port}` suivie d'un chemin facultatif : la redirection tombe exactement sur l'hôte et le port vérifiés, jamais sur un hôte fixe ou un proxy. Un indice `rest` en `https` fait naviguer en `https` sur la boucle locale du conteneur (`curl -k`) ; pour un vault configuré, c'est `open_scheme: "https"`.

**Démarrage** — `cp config.example.json config.json` (tout y est commenté), `openssl rand -hex 24 > view-agent.token`, `python3 view-agent.py config.json`, puis côté router : `OBSIDIAN_ROUTER_VIEW_AGENT_URL` + `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN`. Déploiement durable via systemd ou cron (`deploy/`). Tests : `python3 -m unittest discover -s tests` (sans cloudflared). **Python 3.8+ stdlib uniquement.**

## License

[Apache-2.0](LICENSE) — same as obsidian-mcp-router.
