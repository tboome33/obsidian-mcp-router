# Exposing a vault through a Cloudflare Tunnel

This guide walks you through making a local Obsidian vault reachable from anywhere over HTTPS via a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), with optional authentication via Cloudflare Access. Once the tunnel is up, the router on any other machine can talk to the vault as if it were local.

There are three levels of polish, from "5 minutes, no account" to "rock-solid setup with auth in front":

- [Level 0 — Quick Tunnel (no Cloudflare account, ephemeral URL)](#level-0--quick-tunnel)
- [Level 1 — Named Tunnel (your own domain, stable URL)](#level-1--named-tunnel)
- [Level 2 — Named Tunnel + Cloudflare Access (auth)](#level-2--named-tunnel--cloudflare-access)

If you don't want to deal with cloudflared yourself, the future [Obsidian Cloudflare Tunnel plugin](https://github.com/tboome33) (project codename: `Obsidian - Plugin - Cloudflare Tunnel`) will automate all of this from inside Obsidian. See the router's [ROADMAP.md](../ROADMAP.md) v0.5 for the planned UX.

---

## Level 0 — Quick Tunnel

**You get**: a `https://<random-words>.trycloudflare.com` URL that lasts as long as `cloudflared` runs.
**You give**: nothing. No Cloudflare account, no domain.
**Caveat**: URL changes every restart. Anyone who has the URL **and** your API key can read/write your vault. Treat it as a one-shot demo URL.

### On the host machine (the one running Obsidian)

```bash
# Install cloudflared
winget install --id Cloudflare.cloudflared       # Windows
brew install cloudflared                          # macOS
sudo apt install cloudflared                      # Debian/Ubuntu

# Make sure Obsidian is open and the Local REST API plugin is active
# (port 27124+ for the first vault — check ~/.claude/mcp-obsidian/config.json
# or Obsidian Settings → Local REST API).

# Start an ephemeral tunnel pointing at the vault's REST API
cloudflared tunnel --url https://localhost:27125 --no-tls-verify
```

`--no-tls-verify` is required because the Local REST API plugin generates a self-signed cert for `localhost`. The hop between cloudflared and Cloudflare's edge is still proper TLS — only the local hop on `127.0.0.1` is the self-signed one.

cloudflared prints a public URL on startup, e.g.:

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://violet-bear-running-shoes.trycloudflare.com                                       |
+--------------------------------------------------------------------------------------------+
```

### On the client machine (the one running Claude/the router)

Edit `~/.claude/mcp-obsidian/config.json` and add:

```json
{
  ...,
  "remoteVaults": [
    {
      "name": "tradingview-tunnel",
      "baseUrl": "https://violet-bear-running-shoes.trycloudflare.com",
      "apiKey": "<copy from the host's data.json>",
      "tlsInsecure": false,
      "timeoutMs": 15000
    }
  ]
}
```

Restart Claude. The router now sees the vault. Test with `list_vaults` — you should get `online: true` with a latency around 30-150 ms (Cloudflare edge round-trip).

---

## Level 1 — Named Tunnel

**You get**: a stable URL on your own domain, e.g. `https://vault.mydomain.com`. Survives restarts.
**You need**: a free Cloudflare account and a domain whose nameservers are managed by Cloudflare. Free domains (.tk, .ml) work; you can also buy a `.com` for ~$10/year through Cloudflare Registrar.

### One-time setup on the host

```bash
# 1. Authenticate cloudflared with your Cloudflare account
#    Opens a browser for OAuth, stores cert at ~/.cloudflared/cert.pem
cloudflared tunnel login

# 2. Create a named tunnel — pick any short name
cloudflared tunnel create vault-tradingview
# Tunnel <UUID> created with credentials at ~/.cloudflared/<UUID>.json

# 3. Route DNS to the tunnel (Cloudflare creates a CNAME record for you)
cloudflared tunnel route dns vault-tradingview vault.mydomain.com
```

### Persistent ingress config

Create `~/.cloudflared/config.yml` (or `%USERPROFILE%\.cloudflared\config.yml` on Windows):

```yaml
tunnel: <UUID-from-step-2>
credentials-file: <full-path-to-the-json-from-step-2>

ingress:
  - hostname: vault.mydomain.com
    service: https://localhost:27125
    originRequest:
      noTLSVerify: true   # local self-signed cert — see Level 0 note
  - service: http_status:404
```

### Run as a service

So the tunnel survives reboots:

```bash
# Windows (run as Administrator)
cloudflared service install
sc start Cloudflared

# macOS
sudo cloudflared service install

# Linux (systemd)
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### Wire up the router

```json
{
  ...,
  "remoteVaults": [
    {
      "name": "tradingview-remote",
      "baseUrl": "https://vault.mydomain.com",
      "apiKey": "<from the host's data.json>",
      "tlsInsecure": false,
      "timeoutMs": 10000
    }
  ]
}
```

`tlsInsecure: false` because Cloudflare presents a real Let's Encrypt cert at the edge.

> **Security note**: at this level, anyone who guesses your URL **and** has the API key has full read/write access to your vault. The URL isn't enumerable (Cloudflare doesn't index it), and the API key is 64 hex characters of randomness, so brute-force isn't realistic — but if either leaks, you should rotate the key by regenerating the Local REST API plugin's data.json. Add Level 2 if you want defense in depth.

---

## Level 2 — Named Tunnel + Cloudflare Access

**You get**: an authentication layer in front of your tunnel. Browser users get email-based magic links, and machine clients (the router) authenticate with a service token.
**You need**: Cloudflare Zero Trust enabled (free tier supports up to 50 users).

### One-time Zero Trust setup

1. Sign in at https://one.dash.cloudflare.com/
2. The first time, Cloudflare asks you to pick a team subdomain — e.g. `mydomain.cloudflareaccess.com`. Doesn't matter, just pick something.
3. Free tier is auto-selected; confirm.

### Create an Access application

In the Zero Trust dashboard:

1. **Access → Applications → Add an application → Self-hosted**.
2. **Application name**: `Obsidian Vault Tradingview` (or whatever).
3. **Application domain**: `vault.mydomain.com`.
4. **Identity providers**: keep "One-time PIN" enabled (the default email-OTP flow). You can add Google/GitHub/etc. later.
5. **Save**.

### Add a policy

Now decide who can access:

1. Click into the application → **Policies → Add a policy**.
2. **Action**: Allow.
3. **Configure rules**: Include → Emails → `you@example.com`. Repeat for any device-owners.
4. **Save**.

At this point, opening `https://vault.mydomain.com` in a browser triggers an OTP email. After you authenticate, you get a JWT cookie that's checked on every subsequent request.

### Generate a service token (for the router)

The router is headless — it can't follow an email magic link. It uses a service token instead:

1. **Access → Service Auth → Service Tokens → Create Service Token**.
2. **Name**: `obsidian-mcp-router-laptop` (or per-machine).
3. **Save** — Cloudflare shows you two values **once**: a Client ID and a Client Secret. Copy both immediately, they won't be shown again.

Back in your application's policies:

1. **Add a policy** → Action: Service Auth.
2. **Include → Service Token → pick the one you just created**.
3. **Save**.

### Wire up the router with the service token

```json
{
  ...,
  "remoteVaults": [
    {
      "name": "tradingview-remote",
      "baseUrl": "https://vault.mydomain.com",
      "apiKey": "<from the host's data.json>",
      "tlsInsecure": false,
      "timeoutMs": 10000,
      "extraHeaders": {
        "CF-Access-Client-Id":     "abc123def456.access",
        "CF-Access-Client-Secret": "<the secret you copied above>"
      }
    }
  ]
}
```

The router now sends those two headers on every request. Cloudflare Access validates them at the edge and lets the request through to your vault. From a browser you still log in with email OTP — same URL, two parallel auth methods.

### Verifying the policy works

Try to hit the URL **without** any auth first:

```bash
curl -i https://vault.mydomain.com/
# Expected: HTTP 302 redirect to <team>.cloudflareaccess.com login page
```

Then with the service token:

```bash
curl -i \
  -H "CF-Access-Client-Id: abc123def456.access" \
  -H "CF-Access-Client-Secret: <secret>" \
  -H "Authorization: Bearer <api-key>" \
  https://vault.mydomain.com/
# Expected: HTTP 200 with the Local REST API root response
```

If the first call returns 200 without auth, the policy isn't enforcing. Double-check the application domain matches exactly.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `cloudflared` exits immediately on launch | Bad config.yml syntax, or port not reachable | Run `cloudflared --no-autoupdate tunnel run --loglevel debug <name>` and read the error |
| Quick Tunnel URL works for a minute then dies | The free Quick Tunnels have a session limit and Cloudflare may rate-limit | Move to a Named Tunnel |
| Browser gets 521 errors | Local REST API isn't running on the configured port | Check Obsidian is open and the plugin is enabled |
| Router gets `Unable to connect` on a tunnel URL | Tunnel down OR DNS not propagated | `cloudflared tunnel info <name>`, `nslookup vault.mydomain.com` |
| Router gets HTTP 302 to `cloudflareaccess.com` | Cloudflare Access policy active but service token headers missing or wrong | Verify `extraHeaders` matches the token pair, and that the service-auth policy includes that token |
| 502 Bad Gateway | cloudflared can't reach `localhost:27125` | Either the port changed (check `data.json`) or another process is bound there |

## Future: the plugin

Everything described above is "level 1 / level 2 manual". Phase 5 of the [`obsidian-mcp-router` roadmap](../ROADMAP.md) and the dedicated `Obsidian - Plugin - Cloudflare Tunnel` project will package all of this into a one-click flow inside Obsidian: install plugin → click "Enable tunnel" → optionally pick auth mode → done. The plugin will also auto-write the `remoteVaults` entry into the router's config when both run on the same machine.
