# Deploy — Obsidian vault as a container on the Dedibox (vault-hosting Phase 1)

> Runbook for running an Obsidian vault as a `linuxserver/obsidian` (Selkies) container on a host
> (the Dedibox), wired back to the router via a `VAULT_*` env line. This is the **keystone** of the
> vault-hosting roadmap — one container serves three things from a single plain-markdown
> `/config`: **LiveSync** (→ CouchDB), the **Local REST API** (→ router/MCPHub), and the
> **Selkies GUI** (→ web viewer in a browser tab).
>
> Generate every artifact with `scripts/gen-obsidian-deploy.mjs` — never hand-write the `VAULT_*`
> JSON (the generator's output is round-trip-tested against the router's parser).

> ⚠️ **NOT auto-deployed.** These artifacts are generated + reviewed; a human runs the actual
> `docker compose up` / nginx reload on the Dedibox after review (prod = medical infra).

---

## TL;DR — generate artifacts for one vault

```bash
# WireGuard-only (sensitive / family memory) — the default, safest mode
node scripts/gen-obsidian-deploy.mjs \
  --name tribu --rest-port 27145 --mode wg --wg-host 10.8.0.1 \
  --gui-domain tribu.kiviri.fr --description "Mémoire IA famille"

# Public HTTPS (non-medical only — the generator REFUSES --sensitive here)
node scripts/gen-obsidian-deploy.mjs \
  --name coursera --rest-port 27161 --mode public --api-domain coursera.kiviri.fr

# JSON output (for scripting)
node scripts/gen-obsidian-deploy.mjs --name tribu --rest-port 27145 --mode wg --json
```

It prints: a **docker-compose service**, an **nginx REST proxy** (public mode only), an optional
**nginx GUI proxy** (any mode, if `--gui-domain` given), and the **`VAULT_*` env line** — plus
notes (placeholders to replace, security reminders).

---

## The network model (important)

The REST port and the GUI are exposed differently, and the **baseUrl must match how the REST port
is published** (or the router can't reach the vault):

| Mode | REST port published on | Router reaches REST via | nginx REST block? | GUI |
|---|---|---|---|---|
| `wg` | `<wgHost>:<restPort>` (WG interface) | `http://10.8.0.x:<port>` **directly over the tunnel** | **no** (direct) | nginx + WG ACL + self-signed cert |
| `lan` | `<lanHost>:<restPort>` (LAN interface) | `http://192.168.0.x:<port>` directly | **no** (direct) | nginx + LAN ACL + self-signed cert |
| `public` | `127.0.0.1:<restPort>` (loopback) | `https://<domain>` → nginx → container | **yes** (Let's Encrypt, bearer is the gate) | nginx + Let's Encrypt |

- **GUI host port is unique per vault** (`guiPort`, default `restPort + 1000` → e.g. `28145`), so
  multiple vaults never collide on `:3001`. It's published on `127.0.0.1` and nginx terminates TLS.
- **nginx → container** uses a resolver-variable `proxy_pass` (`set $upstream … ; resolver
  127.0.0.11 valid=10s;`) so it self-heals when the container's Docker IP shuffles (the 2026-05-29
  502 class). This assumes nginx (NPM) shares a Docker network with the obsidian container.

> 🔒 **Security guard**: a `--sensitive` vault may **only** be `--mode wg` (the generator refuses
> `public` AND `lan`). WG mode binds REST to the WireGuard interface — unreachable off-tunnel.

---

## Deploy steps (run on the Dedibox, after review)

1. **Generate** the artifacts for the vault (above). Copy the blocks you got.
2. **Create the config dir** (or let LiveSync seed it — see "Onboarding"):
   ```bash
   mkdir -p /srv/vaults/tribu
   ```
3. **Compose**: paste the service block into `docker-compose.yml`. Replace `PASSWORD=<password>`
   with a real GUI password, then `docker compose up -d obsidian-<name>`.
4. **First boot via the GUI** (browser → the GUI domain, or `https://127.0.0.1:<guiPort>` locally;
   basic-auth with the password):
   - Install the **Local REST API** community plugin → copy its API key.
   - In its settings, set `bindingHost: 0.0.0.0` so the published port is reachable on the WG/LAN
     interface (wg/lan) or by nginx over the Docker network (public), and enable the insecure HTTP
     server on `<restPort>` (TLS is handled by WG encryption or by nginx).
   - Install **Self-hosted LiveSync** (sync — see Onboarding) and **mcp-router-bridge**
     (`/search/smart`, click-to-open).
5. **`VAULT_*`**: take the generated line, replace `<token>` with the real Local REST API key from
   step 4, and add it to the router instance's env in `mcp_settings.json` (server-side; never paste
   the key into a chat). `docker restart mcphub`.
6. **nginx** (GUI always; REST only in public mode): for **wg/lan** generate the self-signed cert
   the GUI block references (`openssl` one-liner is in the generated comment), or use your own CA.
   For **public**, obtain the Let's Encrypt cert. Paste the block(s), `nginx -t && nginx -s reload`.
7. **Verify** (see Acceptance test below).

---

## Onboarding sync (push a local vault → Dedibox) — LiveSync Setup URI

The canonical copy lives in `/config` on the Dedibox; every device keeps a local copy synced via
CouchDB (`couchdb.kiviri.fr`, WG-only). To seed it:

1. **Pick ONE source-of-truth device** (the one with the real vault content — e.g. your PC).
   ⚠️ Only one device initializes, or you merge two trees.
2. On that device, in **Self-hosted LiveSync** → point at `https://couchdb.kiviri.fr`, DB
   `vault_<name>`, set the **E2EE passphrase** (or none — see tradeoff below).
3. Run **"Initialize remote database"** → pushes the local vault into CouchDB.
4. **Copy the Setup URI** (LiveSync → "Copy setup URI") — an encrypted
   `obsidian://setuplivesync?…` string with URL + credentials + passphrase.
5. On the **other devices** (incl. the Dedibox container): paste the Setup URI → **"Fetch from
   remote"** → pulls the vault down. All copies now sync bi-directionally.

> **E2EE ↔ server-side viewer tradeoff**: if you enable the LiveSync E2EE passphrase, CouchDB only
> sees encrypted chunks — but the Dedibox container still has a **plaintext `/config`** (it holds
> the passphrase), so the GUI viewer + REST API work. The protection for that plaintext copy is
> **disk-at-rest encryption + auth (WG/bearer)**, not E2EE. A vault that must be server-blind
> (no viewer, no REST) should be sync-only between your devices and NOT deployed as a container.

---

## Acceptance test (proves the keystone)

```bash
# 1. GUI viewer loads in a browser (no local install) → Obsidian desktop in the tab
#    https://tribu.kiviri.fr  (or https://127.0.0.1:<guiPort> on the host)

# 2. LiveSync ↔ CouchDB: edit a note in the GUI, confirm a new _rev in Fauxton
curl -k -u admin:*** https://couchdb.kiviri.fr/vault_tribu | grep doc_count

# 3. Local REST API answers. wg/lan: from a WG/LAN client directly; public: via nginx.
#    401 without key = alive; 200 with bearer.
curl -H "Authorization: Bearer <token>" http://10.8.0.1:27145/vault/   # wg, from a WG peer

# 4. Access control: wg → only reachable on the tunnel; public REST → bearer required.
curl http://192.168.0.x:27145/   # wg vault from the LAN → connection refused (bound to WG only)
```

---

## Rollback

```bash
docker compose down obsidian-<name>    # stop the container (data persists in /config)
# remove the VAULT_* line from mcp_settings.json + docker restart mcphub
# remove/disable the nginx server block(s) + nginx -s reload
```

Nothing destructive: `/config` keeps the markdown; removing the `VAULT_*` line makes the router fall
back to its previous source for that vault (or drop it).

---

## Files

- `scripts/gen-obsidian-deploy.mjs` — the generator (pure + tested).
- `.env.example` — the variables you'll fill per vault.
- `examples/` — committed sample outputs (`tribu` wg, `coursera` public) for reference.
- Tests: `tests/gen-obsidian-deploy.test.mjs` (incl. round-trip through the router's `parseEnvVaults`).

See the full plan in the vault: **vault-hosting-roadmap** (Phase 1 = this) and the tech context in
**docker-obsidian-selkies-sealskin**.
