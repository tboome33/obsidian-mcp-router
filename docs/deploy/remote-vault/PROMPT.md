# Prompt for Claude Code on the server

Use this when you want Claude Code to do the server side for you.

1. Copy this folder (`docs/deploy/remote-vault/`) to the server, e.g. `/root/remote-vault/`.
2. Open an SSH session on the server and start Claude Code there, in that folder.
3. Fill in the values between `<…>` below, then paste the prompt (English or French).

The prompt never asks you to type a secret into the chat. Passwords and private keys stay on the server.

---

## English

```text
You are running on a Linux server over SSH, as root or with sudo. Your job is to set up a remote Obsidian vault reachable only over WireGuard, using the kit in this folder (README.md, docker-compose.yml, vault.env.example, add-vault.sh). Read README.md first and follow it.

My values:
- WireGuard: server address 10.8.0.1/24, my PC 10.8.0.10, subnet 10.8.0.0/24, interface wg0, UDP port 51820.
- My PC's WireGuard public key: <PC_PUBLIC_KEY, or "none yet">
- Server public endpoint: <PUBLIC_IP_OR_HOSTNAME>
- First vault: name <Name>, UI port 3001, API port 27180, notes folder <ABSOLUTE_VAULT_DIR>.
- Web UI user: <UI_USER>. I will type the UI password myself when add-vault.sh asks for it.

Do this, in order, and verify each step with evidence before going on:
1. Look around: OS and version, whether Docker, the docker compose plugin, WireGuard and iptables are installed, whether wg0 already exists, what listens on 3001 and 27180, and whether /opt/obsidian-vaults already exists. Report what you find before changing anything.
2. Install what is missing (Docker from the official docs for this distribution, wireguard from the package manager). Evidence: `docker compose version`, `wg --version`.
3. WireGuard: if wg0 does not exist, generate the server key pair in /etc/wireguard (mode 600) and write /etc/wireguard/wg0.conf with my values. If my PC's public key is "none yet", leave a clearly marked placeholder in the [Peer] block and tell me exactly where to paste it. Then write, for me to copy, the client config for my PC with placeholders for its private key and the server's public key filled in. Enable wg-quick@wg0. Open UDP 51820 if a host firewall is active. Evidence: `wg show` (without private keys), `ip -4 addr show wg0`.
4. Deploy the first vault: run `./add-vault.sh --dry-run ...` first and show me the output, then run it for real. Let me type the password at the prompt; do not pass it on the command line. Evidence: `docker ps` shows obsidian-<slug> running, `ss -ltn` shows 10.8.0.1:3001 and 10.8.0.1:27180 listening, `curl -sk -o /dev/null -w '%{http_code}' https://10.8.0.1:3001/` answers (401 is fine: basic auth).
5. Firewall: check the DOCKER-USER rules the script added: `iptables -L DOCKER-USER -v -n --line-numbers`. Explain the order (RETURN for wg0 above each DROP) and that the UI rule uses --ctorigdstport. Check that obsidian-vaults-firewall.service is enabled.
6. If the notes folder is on a network share, add the restart-after-mount unit from README.md (Troubleshooting) and show me it is enabled.
7. After I tell you I did the trust click and set the REST plugin (step 6 and 7 of README.md), check: the plugin's data.json in the vault folder has the right port and binding host 0.0.0.0 (show only those keys, never apiKey), and `curl -s http://10.8.0.1:27180/` returns JSON with "status": "OK". Then show the DOCKER-USER counters again: the RETURN rules must have counted packets. Prove the DROP works too: `docker run --rm alpine wget -T 5 -qO- http://10.8.0.1:27180/` must time out and the DROP counter for 27180 must grow (ask me before pulling the alpine image).

Rules:
- Never print a secret: no private key, no password, no apiKey, no .env content. Show key names, file modes and lengths instead.
- Ask me before anything destructive or hard to undo: deleting or overwriting files, replacing an existing wg0.conf, removing containers or volumes, flushing or deleting iptables rules, changing SSH or ufw settings, rebooting. Never run `iptables -F`.
- Do not change anything outside what this setup needs.
- If a check fails, stop, show the evidence, and propose a fix.

When done, give me a short report: what you installed or changed (with paths), the evidence for each step, and a checklist of what I must still do by hand:
- put my PC's public key in the server's wg0.conf (if it was a placeholder) and activate the tunnel on my PC;
- open https://10.8.0.1:3001/, open /vaults/<slug> as a vault, click "Trust author and enable plugins" (or turn on community plugins for a new vault);
- install the Local REST API plugin, set its port to 27180 and binding host to 0.0.0.0, restart the container;
- in Claude Code on my PC: obsidian-router "Vaults" pane > Administration > register a remote vault: host 10.8.0.1, port 27180, the API key, description "UI :3001";
- from my PC: `curl http://10.8.0.1:27180/` must answer "status": "OK".
```

---

## Français

```text
Tu tournes sur un serveur Linux via SSH, en root ou avec sudo. Ta mission : installer un vault Obsidian distant joignable uniquement par WireGuard, avec le kit de ce dossier (README.md, docker-compose.yml, vault.env.example, add-vault.sh). Lis d'abord README.md (section « Français ») et suis-le.

Mes valeurs :
- WireGuard : serveur 10.8.0.1/24, mon PC 10.8.0.10, sous-réseau 10.8.0.0/24, interface wg0, port UDP 51820.
- Clé publique WireGuard de mon PC : <CLE_PUBLIQUE_PC, ou « pas encore »>
- Adresse publique du serveur : <IP_PUBLIQUE_OU_NOM>
- Premier vault : nom <Nom>, port UI 3001, port API 27180, dossier des notes <CHEMIN_ABSOLU_DU_COFFRE>.
- Utilisateur de l'interface web : <UTILISATEUR_UI>. Je taperai moi-même le mot de passe quand add-vault.sh le demandera.

Fais ceci, dans l'ordre, et prouve chaque étape avant de passer à la suivante :
1. Fais l'état des lieux : OS et version, présence de Docker, du plugin docker compose, de WireGuard et d'iptables, existence de wg0, ce qui écoute sur 3001 et 27180, existence de /opt/obsidian-vaults. Rends-moi compte avant de modifier quoi que ce soit.
2. Installe ce qui manque (Docker selon la doc officielle pour cette distribution, wireguard par le gestionnaire de paquets). Preuve : `docker compose version`, `wg --version`.
3. WireGuard : si wg0 n'existe pas, génère la paire de clés du serveur dans /etc/wireguard (mode 600) et écris /etc/wireguard/wg0.conf avec mes valeurs. Si la clé publique de mon PC est « pas encore », laisse un emplacement bien signalé dans le bloc [Peer] et dis-moi exactement où la coller. Écris ensuite, pour que je la copie, la config client de mon PC, avec un emplacement pour sa clé privée et la clé publique du serveur déjà remplie. Active wg-quick@wg0. Ouvre UDP 51820 si un pare-feu d'hôte est actif. Preuve : `wg show` (sans clés privées), `ip -4 addr show wg0`.
4. Déploie le premier vault : lance d'abord `./add-vault.sh --dry-run ...` et montre-moi la sortie, puis lance-le pour de vrai. Laisse-moi taper le mot de passe à l'invite ; ne le passe pas en ligne de commande. Preuve : `docker ps` montre obsidian-<slug> en marche, `ss -ltn` montre 10.8.0.1:3001 et 10.8.0.1:27180 en écoute, `curl -sk -o /dev/null -w '%{http_code}' https://10.8.0.1:3001/` répond (401 est normal : authentification basique).
5. Pare-feu : contrôle les règles DOCKER-USER ajoutées par le script : `iptables -L DOCKER-USER -v -n --line-numbers`. Explique l'ordre (RETURN pour wg0 au-dessus de chaque DROP) et pourquoi la règle de l'UI utilise --ctorigdstport. Vérifie que obsidian-vaults-firewall.service est activé.
6. Si le dossier des notes est sur un partage réseau, ajoute l'unité de redémarrage après montage décrite dans README.md (Dépannage) et montre-moi qu'elle est activée.
7. Quand je te dis que j'ai fait le clic de confiance et réglé le plugin REST (étapes 6 et 7 du README), vérifie : le data.json du plugin dans le dossier du vault a le bon port et l'hôte d'écoute 0.0.0.0 (montre seulement ces clés, jamais apiKey), et `curl -s http://10.8.0.1:27180/` renvoie un JSON avec "status": "OK". Puis remontre les compteurs DOCKER-USER : les règles RETURN doivent avoir compté des paquets. Prouve aussi que le DROP marche : `docker run --rm alpine wget -T 5 -qO- http://10.8.0.1:27180/` doit expirer et le compteur du DROP de 27180 doit monter (demande-moi avant de télécharger l'image alpine).

Règles :
- N'affiche jamais un secret : ni clé privée, ni mot de passe, ni apiKey, ni contenu de .env. Montre plutôt les noms de clés, les droits des fichiers et les longueurs.
- Demande-moi avant toute action destructive ou difficile à annuler : supprimer ou écraser des fichiers, remplacer un wg0.conf existant, supprimer des conteneurs ou des volumes, vider ou supprimer des règles iptables, modifier SSH ou ufw, redémarrer. Ne lance jamais `iptables -F`.
- Ne modifie rien en dehors de ce que cette installation exige.
- Si une vérification échoue, arrête-toi, montre la preuve et propose une correction.

À la fin, fais-moi un rapport court : ce que tu as installé ou modifié (avec les chemins), la preuve de chaque étape, et la liste de ce qu'il me reste à faire à la main :
- mettre la clé publique de mon PC dans wg0.conf du serveur (si c'était un emplacement vide) et activer le tunnel sur mon PC ;
- ouvrir https://10.8.0.1:3001/, ouvrir /vaults/<slug> comme vault, cliquer « Trust author and enable plugins » (ou activer les plugins communautaires pour un vault neuf) ;
- installer le plugin Local REST API, régler son port sur 27180 et son hôte d'écoute sur 0.0.0.0, redémarrer le conteneur ;
- dans Claude Code sur mon PC : panneau « Vaults » d'obsidian-router > Administration > enregistrer un vault distant : hôte 10.8.0.1, port 27180, la clé d'API, description « UI :3001 » ;
- depuis mon PC : `curl http://10.8.0.1:27180/` doit répondre "status": "OK".
```
