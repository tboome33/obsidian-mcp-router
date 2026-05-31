# Deploy — Obsidian vault as a container on the Dedibox (vault-hosting Phase 1)

> Runbook for running an Obsidian vault as a `linuxserver/obsidian` (Selkies) container on a host
> (the Dedibox), wired back to the router via a `VAULT_*` env line. This is the **keystone** of the
> [vault-hosting roadmap](../../) — one container serves three things from a single plain-markdown
> `/config`: **LiveSync** (→ CouchDB), the **Local REST API** (→ router/MCPHub), and the
> **Selkies GUI** (→ web viewer in a browser tab).
>
> Generate every artifact below with `scripts/gen-obsidian-deploy.mjs` — never hand-write the
> `VAULT_*` JSON (the generator's output is round-trip-tested against the router's parser).

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

It prints: a **docker-compose service**, an **nginx REST proxy** block, an optional **nginx GUI
proxy** block, and the **`VAULT_*` env line** — plus notes (placeholders to replace, security
reminders).

---

## Modes

| Mode | baseUrl the router uses | nginx access control | For |
|---|---|---|---|
| `wg` | `http://10.8.0.x:<port>` | `allow 10.8.0.0/24; deny all;` | **sensitive / medical / family memory** |
| `lan` | `http://192.168.0.x:<port>` | `allow 192.168.0.0/16; allow 127.0.0.1; deny all;` | non-sensitive, same LAN |
| `public` | `https://<domain>` | none (bearer apiKey is the gate) | **non-medical** public access |

> 🔒 **Security guard**: `--mode public --sensitive` is **refused** by the generator. A sensitive
> vault must be `wg`. Don't override `--sensitive` unless the vault truly holds no protected data.

---

## Deploy steps (run on the Dedibox, after review)

1. **Generate** the artifacts for the vault (above). Copy the three blocks.
2. **Create the config dir** + drop the vault's markdown there (or let LiveSync fetch it — see
   "Onboarding" below):
   ```bash
   mkdir -p /srv/vaults/tribu
   ```
3. **Compose**: paste the service block into `docker-compose.yml`, then:
   - Replace `PASSWORD=<password>` with a real GUI password.
   - `docker compose up -d obsidian-tribu`
4. **First boot via the GUI** (browser → `https://<dedibox>:3001`, basic-auth with the password):
   - Install the **Local REST API** community plugin → copy its API key.
   - Install the **Self-hosted LiveSync** plugin (for sync — see Onboarding).
   - Install the **mcp-router-bridge** plugin (for `/search/smart`, click-to-open).
   - Set the Local REST API to listen on the right port + `bindingHost: 0.0.0.0` (so nginx can
     reach it inside the Docker network), enable insecure HTTP if using plain HTTP behind nginx.
5. **`VAULT_*`**: take the generated line, replace `<token>` with the real Local REST API key from
   step 4, and add it to the router instance's env in `mcp_settings.json` (server-side; never paste
   the key into a chat). `docker restart mcphub`.
6. **nginx**: paste the REST proxy block (and GUI block if used) into the NPM config / a `*.conf`,
   obtain the Let's Encrypt cert (public mode), `nginx -t && nginx -s reload`.
7. **Verify** (see Acceptance test below).

---

## Onboarding sync (push a local vault → Dedibox) — LiveSync Setup URI

The canonical copy lives in `/config` on the Dedibox; every device keeps a local copy synced via
CouchDB (already deployed — `couchdb.kiviri.fr`, WG-only). To seed it:

1. **Pick ONE source-of-truth device** (the device that currently has the real vault content —
   e.g. your PC). ⚠️ Only one device initializes, or you merge two trees.
2. On that device, in **Self-hosted LiveSync** settings → point at `https://couchdb.kiviri.fr`,
   DB `vault_<name>`, set the **E2EE passphrase** (or none — see the E2EE↔viewer tradeoff below).
3. Run **"Initialize remote database"** → pushes the local vault into CouchDB.
4. **Copy the Setup URI** (LiveSync → "Copy setup URI") — an encrypted `obsidian://setuplivesync?…`
   string containing URL + credentials + passphrase.
5. On the **other devices** (incl. the Dedibox container): paste the Setup URI → **"Fetch from
   remote"** → pulls the vault down. Now all copies sync bi-directionally.

> **E2EE ↔ server-side viewer tradeoff**: if you enable the LiveSync E2EE passphrase, CouchDB only
> sees encrypted chunks — but the Dedibox container still has a **plaintext `/config`** (it holds
> the passphrase), so the GUI viewer + REST API work. The protection for that plaintext copy is
> **disk-at-rest encryption + auth (WG/bearer)**, not E2EE. A vault that must be server-blind
> (no viewer, no REST) should be sync-only between your devices and NOT deployed as a container.

---

## Acceptance test (proves the keystone)

```bash
# 1. GUI viewer loads in a browser (no local install)
open https://<dedibox>:3001/          # → Obsidian desktop in the tab

# 2. LiveSync ↔ CouchDB: edit a note in the GUI, confirm a new _rev in Fauxton
curl -k -u admin:*** https://couchdb.kiviri.fr/vault_tribu | grep doc_count

# 3. Local REST API answers (401 without key = alive; 200 with bearer)
curl -k -H "Authorization: Bearer <token>" https://<api-host>/vault/  # via WG/nginx

# 4. nginx Access List (wg mode): from the internet → blocked; from WG → ok
curl -k https://tribu-api.kiviri.fr/        # internet → 403 / connection refused
# (from a WG client) → 401/200
```

---

## Rollback

```bash
docker compose down obsidian-tribu     # stop the container (data persists in /config)
# remove the VAULT_* line from mcp_settings.json + docker restart mcphub
# remove/disable the nginx server block + nginx -s reload
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
