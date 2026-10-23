# Remote Obsidian vault over WireGuard — deployment kit

English below, [Français plus bas](#français).

Files in this folder:

| File | What it is |
|---|---|
| `README.md` | This guide. |
| `docker-compose.yml` | Template for one vault in one container. |
| `vault.env.example` | Commented example of the `.env` the template reads. |
| `add-vault.sh` | Creates a vault container and its firewall rules, in one command. |
| `PROMPT.md` | A prompt to paste into Claude Code running on the server, to do all of this for you. |

---

## English

### What you get

- An Obsidian vault running on a Linux server, inside a Docker container (`lscr.io/linuxserver/obsidian`).
- Obsidian in your browser. The container streams its desktop with **Selkies** (the page title says "Selkies"). It serves HTTPS on container port 3001; port 3000 only redirects to it.
- The Obsidian **Local REST API** plugin exposed on its own port, so the **obsidian-mcp-router** on your PC can read and write the vault from Claude Code.
- Nothing public. Both ports listen on the server's **WireGuard** address only, and the firewall drops anything that does not come through the tunnel.
- Two locks: a user and password in front of the web UI, and the plugin's API key in front of the REST API.
- The notes stay on the host, in a folder you choose (a local disk or a mounted network share). The container only holds Obsidian's own settings.

The addresses used in this guide match the reference setup. Change them if yours differ.

| Machine | WireGuard address |
|---|---|
| Server (runs the containers) | `10.8.0.1` |
| Your PC (runs Claude Code and the router) | `10.8.0.10` |
| Tunnel subnet | `10.8.0.0/24` |

| Vault | Web UI (host → container) | REST API (host = container) |
|---|---|---|
| 1st | `10.8.0.1:3001 → 3001` | `10.8.0.1:27180` |
| 2nd | `10.8.0.1:3002 → 3001` | `10.8.0.1:27181` |
| … | one UI port per vault | one API port per vault |

### Prerequisites

- A Linux server (Debian or Ubuntu in the examples) with root access over SSH. Count about 1.5–2 GB of RAM per vault container.
- Docker Engine with the `docker compose` plugin.
- A WireGuard tunnel between the server and your PC. If you have none, step 1 sets it up.
- `iptables` on the server (present on Debian/Ubuntu; with nftables it is the `iptables-nft` front end, which works).
- On your PC: Claude Code with the **obsidian-router** plugin installed.

### Step by step

#### 1. WireGuard

Downloads for every platform: <https://www.wireguard.com/install/>.

**On the server:**

```bash
apt update && apt install -y wireguard
umask 077
wg genkey | tee /etc/wireguard/server.key | wg pubkey > /etc/wireguard/server.pub
```

Create `/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <content of /etc/wireguard/server.key>

# Your PC
[Peer]
PublicKey = <public key of your PC>
AllowedIPs = 10.8.0.10/32
```

Open UDP 51820 on the server (`ufw allow 51820/udp` if you use ufw, and in your hosting provider's firewall if it has one). Then:

```bash
systemctl enable --now wg-quick@wg0
wg show
```

**On your PC.** Install the client, then create a tunnel with this content.

- **Windows / macOS**: install the WireGuard app from the link above. Click "Add empty tunnel". The app generates a key pair and shows the public key: put it in the server's `[Peer]` block. Paste the rest below the generated `PrivateKey` line.
- **Linux**: `apt install wireguard` (or your distribution's package), generate keys as on the server, write `/etc/wireguard/wg0.conf`, then `wg-quick up wg0`.

```ini
[Interface]
PrivateKey = <private key of your PC>
Address = 10.8.0.10/24

[Peer]
PublicKey = <content of /etc/wireguard/server.pub>
Endpoint = <public IP or hostname of the server>:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25
```

`AllowedIPs = 10.8.0.0/24` sends only tunnel traffic through WireGuard. Your normal internet traffic is not affected.

After editing the server's peer list, run `systemctl restart wg-quick@wg0` on the server. Activate the tunnel on the PC and check: `ping 10.8.0.1`.

#### 2. Docker

Follow the official guide for your distribution: <https://docs.docker.com/engine/install/>. Then check:

```bash
docker compose version
```

#### 3. Files layout

Copy this folder to the server, for example to `/root/remote-vault/`. `add-vault.sh` must stay next to `docker-compose.yml`. Each vault ends up in its own compose project:

```
/opt/obsidian-vaults/
  notes/
    docker-compose.yml      copy of the template
    .env                    the vault's settings (mode 600, holds the UI password)
    config-notes/           Obsidian's settings inside the container (/config)
    firewall.rules          the DOCKER-USER rules of this vault
/srv/vaults/notes/          the notes themselves (your choice; can be a network share)
```

Inside the container, the vault is at `/vaults/<slug>`.

#### 4. `vault.env`

Read `vault.env.example`. It lists every variable the template uses: `VAULT_SLUG`, `WG_IP`, `UI_PORT`, `API_PORT`, `VAULT_DIR`, `CUSTOM_USER`, `PASSWORD`, `PUID`, `PGID`, `TZ`.

You do not need to write the `.env` yourself: `add-vault.sh` writes it from its arguments. Edit the example only if you prefer to run `docker compose` by hand.

#### 5. Run `add-vault.sh`

As root on the server:

```bash
cd /root/remote-vault
chmod +x add-vault.sh
./add-vault.sh --dry-run Notes 3001 27180 /srv/vaults/notes   # shows what it would do
./add-vault.sh Notes 3001 27180 /srv/vaults/notes             # does it
```

Arguments: `<Name> <ui-port> <api-port> <vault-dir>`. The script:

1. checks the arguments (ports 1–65535, a safe name, an absolute folder);
2. asks for the web UI password (or reads it from the `PASSWORD` environment variable) and never prints it;
3. creates `/opt/obsidian-vaults/<slug>/` with the `.env` and the compose file;
4. starts the container (`docker compose up -d`);
5. adds the firewall rules (step 8) and installs a unit that re-applies them at boot;
6. prints what is left to do by hand.

Optional variables: `WG_IP`, `WG_IFACE`, `WG_NET`, `CUSTOM_USER`, `PUID`, `PGID`, `TZ`, `BASE_DIR`. See the top of the script.

#### 6. The "Trust author" click

Open `https://10.8.0.1:3001/` from your PC. Accept the self-signed certificate and log in with the UI user and password.

In Obsidian, open the folder `/vaults/<slug>` as a vault. If the vault already has plugins, Obsidian asks whether you trust its author: click **"Trust author and enable plugins"**. For a new, empty vault, go to Settings → Community plugins → **Turn on community plugins**.

This click is needed once per vault. Until it is done, the REST API answers nothing.

#### 7. Set the REST plugin port and binding

Install and enable the **Local REST API** community plugin, then open its settings. Its own `data.json` decides where it listens:

```
<vault-dir>/.obsidian/plugins/obsidian-local-rest-api/data.json
```

| Key | Value |
|---|---|
| `insecurePort` | your `API_PORT` (e.g. `27180`), for plain HTTP |
| `enableInsecureServer` | `true` |
| `port` | the HTTPS port; use your `API_PORT` here instead if you prefer HTTPS |
| binding host (Settings → Advanced, `bindingHost` in `data.json`) | `0.0.0.0` |
| `apiKey` | the key; copy it for step 9 |

Two rules matter:

- The port the plugin listens on **must equal** `API_PORT`, because the container publishes `API_PORT:API_PORT`.
- The plugin **must listen on `0.0.0.0`**. On `127.0.0.1` it only answers inside the container, and Docker cannot reach it.

HTTP is acceptable here: the traffic already runs inside the encrypted WireGuard tunnel. If you choose HTTPS, the plugin uses a self-signed certificate (see step 9).

Restart the container after editing the file: `docker restart obsidian-<slug>`.

#### 8. Firewall rules

Ports published by Docker **bypass ufw**. Filtering has to happen in the `DOCKER-USER` iptables chain. `add-vault.sh` adds four rules per vault:

```bash
# UI, published 3001 -> 3001 (or 3002 -> 3001 for the 2nd vault)
iptables -I DOCKER-USER -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst 10.8.0.1 --ctorigdstport 3001 -j DROP
iptables -I DOCKER-USER -i wg0 -s 10.8.0.0/24 -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst 10.8.0.1 --ctorigdstport 3001 -j RETURN
# REST API, same port on both sides
iptables -I DOCKER-USER -p tcp --dport 27180 -m conntrack --ctdir ORIGINAL --ctorigdst 10.8.0.1 -j DROP
iptables -I DOCKER-USER -i wg0 -s 10.8.0.0/24 -p tcp --dport 27180 -m conntrack --ctdir ORIGINAL --ctorigdst 10.8.0.1 -j RETURN
```

`-I` inserts at the top, so the `RETURN` added second ends up above its `DROP`. Tunnel traffic passes, everything else is dropped.

The script checks each rule with `iptables -C` before adding it, so running it twice adds nothing. It saves the rules in `/opt/obsidian-vaults/<slug>/firewall.rules`. The unit `obsidian-vaults-firewall.service` re-applies all of them at boot and whenever Docker restarts.

Validate each rule two ways:

```bash
iptables -L DOCKER-USER -v -n --line-numbers   # the counters of the RETURN rules grow when you use the vault
```

Then try from a source that must be blocked. A container on the server reaches `10.8.0.1` without going through `wg0`, so it is a good test:

```bash
docker run --rm alpine wget -T 5 -qO- http://10.8.0.1:27180/   # must time out
iptables -L DOCKER-USER -v -n --line-numbers                    # the DROP counter of 27180 has grown
```

Also try the ports on the server's public IP from outside the tunnel (a phone on mobile data): they must not answer. A rule that never counts anything is a rule that does not match.

#### 9. Register the vault in the router

In Claude Code on your PC (obsidian-router v0.106.0 or later), open the **Vaults** pane → **⚙ Administration** → **Register a vault**:

- choose **Remote (over WireGuard)** — the button stays refused until the console sees your tunnel up (its **WireGuard** line says "on");
- name, IP address `10.8.0.1`, REST API port `27180`, **HTTP**, web UI port `3001`, and the API key from step 7;
- **Register**.

The pane calls the router tool `register_remote_vault` with `baseUrl` `http://10.8.0.1:27180` and writes `(UI :3001)` into the vault's description, which is what makes its 🌐 and 🪟 buttons open the web UI. If you chose **HTTPS**, the `baseUrl` is `https://10.8.0.1:27180` with `tlsInsecure: true`, because the plugin's certificate is self-signed. The key goes straight into your own router config; the pane clears it from its form once sent. The same console takes a vault out again (**Take a vault out of the router**), once no workspace is bound to it.

#### 10. Check from the PC

```bash
curl http://10.8.0.1:27180/
```

It must answer JSON containing `"status": "OK"`. Then, in Claude Code, `list_vaults` must show the vault online.

### Troubleshooting

**The REST API answers nothing (connection reset or timeout).**
Check in this order. The "Trust author and enable plugins" click was done (step 6). The plugin is enabled. It listens on `0.0.0.0`, not `127.0.0.1`. Its port in `data.json` equals `API_PORT`. You restarted the container after changing `data.json`. Inside the server: `docker exec obsidian-<slug> sh -c 'ss -ltn'` shows the port.

**A UI firewall rule never matches.**
`DOCKER-USER` sees packets **after** Docker's DNAT. The destination port there is the **container** port (3001), not the host port. For a UI published `3002 → 3001`, `--dport 3002` never matches. Use `-m conntrack --ctorigdstport 3002`: it matches the port the client really asked for. API rules can use `--dport` because both sides are equal. Add `--ctdir ORIGINAL` to every conntrack rule: the origin fields are the same on the container's replies, so without it the reply to a tunnel client hits the DROP and the web UI never answers.

**ufw says the port is closed, yet it is reachable.**
Expected: Docker's published ports skip ufw's chains. Filter in `DOCKER-USER`. Binding the ports to `WG_IP` (as the template does) already keeps them off the public interface.

**After a reboot, the vault is empty.**
If `VAULT_DIR` is a network share (CIFS, NFS) that mounts late, the container may start before it and bind an empty folder. Restart the container once the share is up. To make it automatic, add a unit that runs after the mount, for example `/etc/systemd/system/obsidian-notes-after-mount.service`:

```ini
[Unit]
Description=Restart obsidian-notes once its share is mounted
Requires=srv-vaults-notes.mount docker.service
After=srv-vaults-notes.mount docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker restart obsidian-notes

[Install]
WantedBy=multi-user.target
```

The mount unit name comes from the path: `systemd-escape -p --suffix=mount /srv/vaults/notes`. Enable it with `systemctl enable obsidian-notes-after-mount.service`.

**The web UI is a black or frozen screen.**
The image needs `shm_size: "1gb"` (already in the template). Check `PUID`/`PGID` own `config-<slug>/` and `VAULT_DIR`.

**Docker cannot start the container: "cannot assign requested address".**
The WireGuard interface is not up, so `WG_IP` does not exist yet on the host. Start `wg-quick@wg0` first. To be safe at boot, add `After=wg-quick@wg0.service` to Docker with `systemctl edit docker`.

**`http://…:3001` does not work.**
Port 3001 in the container is HTTPS. Use `https://`. Port 3000 (HTTP) only redirects to HTTPS and is not published by the template.

### Option: one container per person

The kit runs **one container per vault**. A study of this setup suggests another layout worth considering:

- **one container per person**, holding all of that person's vaults: one Obsidian window per vault, each window's REST plugin on its own port;
- **one shared container** for the shared vaults.

It means fewer containers and about **2 GB less RAM** in the reference setup. The catch: when the container restarts, every Obsidian window must reopen with its vault, or the matching REST port stays silent. **Test that before switching**: restart the container and check each API port with `curl`. The firewall rules stay the same (one rule pair per published port). The router side does not change: each vault is still one remote vault with its own port.

---

## Français

### Ce que vous obtenez

- Un vault Obsidian qui tourne sur un serveur Linux, dans un conteneur Docker (`lscr.io/linuxserver/obsidian`).
- Obsidian dans votre navigateur. Le conteneur diffuse son bureau avec **Selkies** (le titre de la page est « Selkies »). Il sert du HTTPS sur le port 3001 du conteneur ; le port 3000 ne fait que rediriger vers lui.
- Le plugin Obsidian **Local REST API** exposé sur son propre port, pour que l'**obsidian-mcp-router** de votre PC lise et écrive dans le vault depuis Claude Code.
- Rien de public. Les deux ports n'écoutent que sur l'adresse **WireGuard** du serveur, et le pare-feu jette tout ce qui ne passe pas par le tunnel.
- Deux verrous : un utilisateur et un mot de passe devant l'interface web, et la clé d'API du plugin devant l'API REST.
- Les notes restent sur l'hôte, dans un dossier de votre choix (disque local ou partage réseau monté). Le conteneur ne garde que les réglages d'Obsidian.

Les adresses du guide sont celles de l'installation de référence. Adaptez-les si les vôtres diffèrent.

| Machine | Adresse WireGuard |
|---|---|
| Serveur (fait tourner les conteneurs) | `10.8.0.1` |
| Votre PC (Claude Code et le router) | `10.8.0.10` |
| Sous-réseau du tunnel | `10.8.0.0/24` |

| Vault | Interface web (hôte → conteneur) | API REST (hôte = conteneur) |
|---|---|---|
| 1er | `10.8.0.1:3001 → 3001` | `10.8.0.1:27180` |
| 2e | `10.8.0.1:3002 → 3001` | `10.8.0.1:27181` |
| … | un port UI par vault | un port API par vault |

### Prérequis

- Un serveur Linux (Debian ou Ubuntu dans les exemples) avec un accès root en SSH. Comptez 1,5 à 2 Go de RAM par conteneur de vault.
- Docker Engine avec le plugin `docker compose`.
- Un tunnel WireGuard entre le serveur et votre PC. Si vous n'en avez pas, l'étape 1 le met en place.
- `iptables` sur le serveur (présent sur Debian/Ubuntu ; avec nftables, c'est la façade `iptables-nft`, qui fonctionne).
- Sur votre PC : Claude Code avec le plugin **obsidian-router**.

### Pas à pas

#### 1. WireGuard

Téléchargements pour toutes les plateformes : <https://www.wireguard.com/install/>.

**Sur le serveur :**

```bash
apt update && apt install -y wireguard
umask 077
wg genkey | tee /etc/wireguard/server.key | wg pubkey > /etc/wireguard/server.pub
```

Créez `/etc/wireguard/wg0.conf` :

```ini
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <contenu de /etc/wireguard/server.key>

# Votre PC
[Peer]
PublicKey = <clé publique de votre PC>
AllowedIPs = 10.8.0.10/32
```

Ouvrez UDP 51820 sur le serveur (`ufw allow 51820/udp` si vous utilisez ufw, et dans le pare-feu de votre hébergeur s'il en a un). Puis :

```bash
systemctl enable --now wg-quick@wg0
wg show
```

**Sur votre PC.** Installez le client, puis créez un tunnel avec ce contenu.

- **Windows / macOS** : installez l'application WireGuard depuis le lien ci-dessus. Cliquez « Add empty tunnel » (« Ajouter un tunnel vide »). L'application génère une paire de clés et affiche la clé publique : mettez-la dans le bloc `[Peer]` du serveur. Collez le reste sous la ligne `PrivateKey` générée.
- **Linux** : `apt install wireguard` (ou le paquet de votre distribution), générez les clés comme sur le serveur, écrivez `/etc/wireguard/wg0.conf`, puis `wg-quick up wg0`.

```ini
[Interface]
PrivateKey = <clé privée de votre PC>
Address = 10.8.0.10/24

[Peer]
PublicKey = <contenu de /etc/wireguard/server.pub>
Endpoint = <IP publique ou nom du serveur>:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25
```

`AllowedIPs = 10.8.0.0/24` n'envoie dans WireGuard que le trafic du tunnel. Votre trafic internet habituel n'est pas touché.

Après avoir modifié la liste des pairs du serveur, lancez `systemctl restart wg-quick@wg0` sur le serveur. Activez le tunnel sur le PC et vérifiez : `ping 10.8.0.1`.

#### 2. Docker

Suivez le guide officiel pour votre distribution : <https://docs.docker.com/engine/install/>. Puis vérifiez :

```bash
docker compose version
```

#### 3. Organisation des fichiers

Copiez ce dossier sur le serveur, par exemple dans `/root/remote-vault/`. `add-vault.sh` doit rester à côté de `docker-compose.yml`. Chaque vault a son propre projet compose :

```
/opt/obsidian-vaults/
  notes/
    docker-compose.yml      copie du modèle
    .env                    réglages du vault (mode 600, contient le mot de passe UI)
    config-notes/           réglages d'Obsidian dans le conteneur (/config)
    firewall.rules          règles DOCKER-USER de ce vault
/srv/vaults/notes/          les notes elles-mêmes (au choix ; peut être un partage réseau)
```

Dans le conteneur, le vault est dans `/vaults/<slug>`.

#### 4. `vault.env`

Lisez `vault.env.example`. Il liste toutes les variables du modèle : `VAULT_SLUG`, `WG_IP`, `UI_PORT`, `API_PORT`, `VAULT_DIR`, `CUSTOM_USER`, `PASSWORD`, `PUID`, `PGID`, `TZ`.

Inutile d'écrire le `.env` vous-même : `add-vault.sh` l'écrit à partir de ses arguments. Ne modifiez l'exemple que si vous préférez lancer `docker compose` à la main.

#### 5. Lancer `add-vault.sh`

En root sur le serveur :

```bash
cd /root/remote-vault
chmod +x add-vault.sh
./add-vault.sh --dry-run Notes 3001 27180 /srv/vaults/notes   # montre ce qu'il ferait
./add-vault.sh Notes 3001 27180 /srv/vaults/notes             # le fait
```

Arguments : `<Nom> <port-ui> <port-api> <dossier-du-vault>`. Le script :

1. vérifie les arguments (ports 1–65535, nom sûr, chemin absolu) ;
2. demande le mot de passe de l'interface web (ou le lit dans la variable d'environnement `PASSWORD`) et ne l'affiche jamais ;
3. crée `/opt/obsidian-vaults/<slug>/` avec le `.env` et le fichier compose ;
4. démarre le conteneur (`docker compose up -d`) ;
5. ajoute les règles de pare-feu (étape 8) et installe une unité qui les réapplique au démarrage ;
6. affiche ce qui reste à faire à la main.

Variables facultatives : `WG_IP`, `WG_IFACE`, `WG_NET`, `CUSTOM_USER`, `PUID`, `PGID`, `TZ`, `BASE_DIR`. Voir l'en-tête du script.

#### 6. Le clic « Trust author »

Ouvrez `https://10.8.0.1:3001/` depuis votre PC. Acceptez le certificat auto-signé et connectez-vous avec l'utilisateur et le mot de passe de l'interface.

Dans Obsidian, ouvrez le dossier `/vaults/<slug>` comme vault. Si le vault a déjà des plugins, Obsidian demande si vous faites confiance à son auteur : cliquez **« Trust author and enable plugins »**. Pour un vault neuf et vide : Paramètres → Plugins communautaires → **Activer les plugins communautaires**.

Ce clic est nécessaire une fois par vault. Tant qu'il n'est pas fait, l'API REST ne répond rien.

#### 7. Régler le port et l'écoute du plugin REST

Installez et activez le plugin communautaire **Local REST API**, puis ouvrez ses réglages. C'est son propre `data.json` qui décide où il écoute :

```
<dossier-du-vault>/.obsidian/plugins/obsidian-local-rest-api/data.json
```

| Clé | Valeur |
|---|---|
| `insecurePort` | votre `API_PORT` (ex. `27180`), pour du HTTP simple |
| `enableInsecureServer` | `true` |
| `port` | le port HTTPS ; mettez-y votre `API_PORT` à la place si vous préférez HTTPS |
| hôte d'écoute (Réglages → Advanced, `bindingHost` dans `data.json`) | `0.0.0.0` |
| `apiKey` | la clé ; copiez-la pour l'étape 9 |

Deux règles comptent :

- Le port d'écoute du plugin **doit être égal** à `API_PORT`, car le conteneur publie `API_PORT:API_PORT`.
- Le plugin **doit écouter sur `0.0.0.0`**. Sur `127.0.0.1`, il ne répond qu'à l'intérieur du conteneur, et Docker ne peut pas l'atteindre.

Le HTTP est acceptable ici : le trafic passe déjà dans le tunnel WireGuard chiffré. Si vous choisissez HTTPS, le plugin utilise un certificat auto-signé (voir étape 9).

Redémarrez le conteneur après avoir modifié le fichier : `docker restart obsidian-<slug>`.

#### 8. Règles de pare-feu

Les ports publiés par Docker **contournent ufw**. Le filtrage se fait dans la chaîne iptables `DOCKER-USER`. `add-vault.sh` ajoute quatre règles par vault :

```bash
# UI, publiée 3001 -> 3001 (ou 3002 -> 3001 pour le 2e vault)
iptables -I DOCKER-USER -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst 10.8.0.1 --ctorigdstport 3001 -j DROP
iptables -I DOCKER-USER -i wg0 -s 10.8.0.0/24 -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst 10.8.0.1 --ctorigdstport 3001 -j RETURN
# API REST, même port des deux côtés
iptables -I DOCKER-USER -p tcp --dport 27180 -m conntrack --ctdir ORIGINAL --ctorigdst 10.8.0.1 -j DROP
iptables -I DOCKER-USER -i wg0 -s 10.8.0.0/24 -p tcp --dport 27180 -m conntrack --ctdir ORIGINAL --ctorigdst 10.8.0.1 -j RETURN
```

`-I` insère en tête : le `RETURN` ajouté en second se retrouve donc au-dessus de son `DROP`. Le trafic du tunnel passe, le reste est jeté.

Le script vérifie chaque règle avec `iptables -C` avant de l'ajouter : le relancer n'ajoute rien. Il enregistre les règles dans `/opt/obsidian-vaults/<slug>/firewall.rules`. L'unité `obsidian-vaults-firewall.service` les réapplique toutes au démarrage et à chaque redémarrage de Docker.

Validez chaque règle de deux façons :

```bash
iptables -L DOCKER-USER -v -n --line-numbers   # les compteurs des règles RETURN montent quand vous utilisez le vault
```

Puis testez depuis une source qui doit être bloquée. Un conteneur du serveur atteint `10.8.0.1` sans passer par `wg0` : c'est un bon test.

```bash
docker run --rm alpine wget -T 5 -qO- http://10.8.0.1:27180/   # doit expirer
iptables -L DOCKER-USER -v -n --line-numbers                    # le compteur du DROP de 27180 a monté
```

Essayez aussi les ports sur l'IP publique du serveur depuis l'extérieur du tunnel (un téléphone en données mobiles) : ils ne doivent pas répondre. Une règle qui ne compte jamais rien est une règle qui ne correspond à rien.

#### 9. Enregistrer le vault dans le router

Dans Claude Code sur votre PC (obsidian-router v0.106.0 ou plus), ouvrez le panneau **Vaults** → **⚙ Administration** → **Enregistrer un vault** :

- choisissez **Distant (par WireGuard)** — l'enregistrement est refusé tant que la console ne voit pas votre tunnel actif (sa ligne **WireGuard** dit « actif ») ;
- nom, adresse IP `10.8.0.1`, port de l'API REST `27180`, **HTTP**, port de l'interface web `3001`, et la clé API de l'étape 7 ;
- **Enregistrer**.

Le panneau appelle l'outil du router `register_remote_vault` avec la `baseUrl` `http://10.8.0.1:27180` et écrit `(UI :3001)` dans la description du vault : c'est ce qui permet à ses boutons 🌐 et 🪟 d'ouvrir l'interface web. Si vous avez choisi **HTTPS**, la `baseUrl` est `https://10.8.0.1:27180` avec `tlsInsecure: true`, car le certificat du plugin est auto-signé. La clé va directement dans votre propre config du router ; le panneau l'efface de son formulaire après l'envoi. La même console retire un vault (**Retirer un vault du router**), une fois qu'aucun workspace n'y est lié.

#### 10. Vérifier depuis le PC

```bash
curl http://10.8.0.1:27180/
```

La réponse doit être un JSON contenant `"status": "OK"`. Ensuite, dans Claude Code, `list_vaults` doit montrer le vault en ligne.

### Dépannage

**L'API REST ne répond rien (connexion réinitialisée ou délai dépassé).**
Vérifiez dans cet ordre. Le clic « Trust author and enable plugins » a été fait (étape 6). Le plugin est activé. Il écoute sur `0.0.0.0`, pas `127.0.0.1`. Son port dans `data.json` est égal à `API_PORT`. Vous avez redémarré le conteneur après avoir modifié `data.json`. Sur le serveur : `docker exec obsidian-<slug> sh -c 'ss -ltn'` montre le port.

**Une règle de pare-feu de l'UI ne correspond jamais.**
`DOCKER-USER` voit les paquets **après** le DNAT de Docker. Le port de destination y est le port du **conteneur** (3001), pas celui de l'hôte. Pour une UI publiée `3002 → 3001`, `--dport 3002` ne correspond jamais. Utilisez `-m conntrack --ctorigdstport 3002` : il correspond au port réellement demandé par le client. Les règles d'API peuvent utiliser `--dport`, car les deux côtés sont égaux. Ajoutez `--ctdir ORIGINAL` à chaque règle conntrack : les champs d'origine sont les mêmes sur les réponses du conteneur, et sans lui la réponse à un client du tunnel tombe sur le DROP : l'interface web ne répond jamais.

**ufw dit que le port est fermé, et pourtant il répond.**
C'est normal : les ports publiés par Docker sautent les chaînes d'ufw. Filtrez dans `DOCKER-USER`. Lier les ports à `WG_IP` (comme le fait le modèle) les tient déjà hors de l'interface publique.

**Après un redémarrage, le vault est vide.**
Si `VAULT_DIR` est un partage réseau (CIFS, NFS) monté tard, le conteneur peut démarrer avant lui et monter un dossier vide. Redémarrez le conteneur une fois le partage monté. Pour l'automatiser, ajoutez une unité qui s'exécute après le montage, par exemple `/etc/systemd/system/obsidian-notes-after-mount.service` :

```ini
[Unit]
Description=Restart obsidian-notes once its share is mounted
Requires=srv-vaults-notes.mount docker.service
After=srv-vaults-notes.mount docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker restart obsidian-notes

[Install]
WantedBy=multi-user.target
```

Le nom de l'unité de montage vient du chemin : `systemd-escape -p --suffix=mount /srv/vaults/notes`. Activez-la avec `systemctl enable obsidian-notes-after-mount.service`.

**L'interface web est noire ou figée.**
L'image a besoin de `shm_size: "1gb"` (déjà dans le modèle). Vérifiez que `PUID`/`PGID` possèdent `config-<slug>/` et `VAULT_DIR`.

**Docker ne démarre pas le conteneur : « cannot assign requested address ».**
L'interface WireGuard n'est pas montée, donc `WG_IP` n'existe pas encore sur l'hôte. Démarrez d'abord `wg-quick@wg0`. Pour être tranquille au démarrage, ajoutez `After=wg-quick@wg0.service` à Docker avec `systemctl edit docker`.

**`http://…:3001` ne marche pas.**
Le port 3001 du conteneur est en HTTPS. Utilisez `https://`. Le port 3000 (HTTP) ne fait que rediriger vers HTTPS et n'est pas publié par le modèle.

### Option : un conteneur par personne

Le kit fait tourner **un conteneur par vault**. Une étude de cette installation propose une autre organisation à considérer :

- **un conteneur par personne**, qui contient tous ses vaults : une fenêtre Obsidian par vault, le plugin REST de chaque fenêtre sur son propre port ;
- **un conteneur partagé** pour les vaults partagés.

Cela fait moins de conteneurs et environ **2 Go de RAM en moins** dans l'installation de référence. Le point à vérifier : au redémarrage du conteneur, chaque fenêtre Obsidian doit se rouvrir avec son vault, sinon le port REST correspondant reste muet. **Testez-le avant de basculer** : redémarrez le conteneur et vérifiez chaque port d'API avec `curl`. Les règles de pare-feu restent les mêmes (une paire de règles par port publié). Côté router, rien ne change : chaque vault reste un vault distant avec son propre port.
