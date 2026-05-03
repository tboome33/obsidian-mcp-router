# Remote vaults

The router treats local and remote Obsidian vaults the same way: it just calls HTTPS endpoints. The only difference is **who runs Obsidian**.

## Use cases

- **iPad / mobile vault** exposed over LAN or Tailscale. Obsidian on iOS supports community plugins as of v1.4+, so Local REST API works there too.
- **NAS-hosted vault** (e.g. a QNAP/Synology running Obsidian via Docker or directly).
- **Office ↔ Home machine** — keep a single client that can read either machine's vault.
- **Headless VPS** — Obsidian running in an Xvfb container behind a reverse proxy. Niche but workable.

## Step 1 — expose the Local REST API beyond localhost

By default, the Local REST API plugin only listens on `127.0.0.1`. To expose it to your LAN:

1. Open Obsidian on the host machine.
2. Settings → Community plugins → Local REST API → **enable "Bind to non-localhost"** (or set `bindIp` to `0.0.0.0` in `data.json`).
3. Open the firewall on the chosen port (e.g. 27125).
4. From another machine, verify with `curl -k https://<host>:27125/`.

> ⚠️ **Security**: any device on your LAN that hits `https://<host>:27125/` and presents the API key gets full read-write access to your vault. For a trusted home LAN this is fine. For anything else, see "Step 3 — production".

## Step 2 — add the vault to the router

Edit `~/.claude/obsidian-mcp-router/config.json` and add an entry to `remoteVaults`:

```json
{
  ...,
  "remoteVaults": [
    {
      "name": "qnap",
      "description": "Vault on the QNAP NAS",
      "baseUrl": "https://192.168.0.11:27125",
      "apiKey": "<copy from that vault's .obsidian/plugins/obsidian-local-rest-api/data.json>",
      "tlsInsecure": true,
      "timeoutMs": 10000
    }
  ]
}
```

Restart Claude Desktop. Run `list_vaults` to confirm the new vault is online.

## Step 3 — production

If the vault is reachable from outside your LAN (over the public Internet, or even over an untrusted Wi-Fi), do not rely on the plugin's self-signed cert + Bearer token alone. Put it behind a reverse proxy with:

- **Real TLS** (Caddy or Nginx with Let's Encrypt).
- **mTLS** or an additional layer (oauth2-proxy, Cloudflare Access, Tailscale Funnel).

Then in the router config, set `tlsInsecure: false` and `baseUrl` to the public URL. The Bearer token from the plugin acts as a second factor behind the proxy.

## Step 4 — Tailscale (recommended for personal use)

The simplest secure setup for personal multi-device access:

1. Install Tailscale on every machine that runs an Obsidian vault and on your client(s).
2. In the plugin, bind to `0.0.0.0` (or to the Tailscale IP specifically).
3. Reach the vault at `https://<machine>.tailnet.local:27125` — Tailscale handles auth + encryption transparently.
4. In the router config, use that hostname and keep `tlsInsecure: true` (the plugin's self-signed cert is fine inside Tailscale because the network itself is authenticated).

This avoids the reverse-proxy boilerplate and works across mobile, desktop, and NAS.

## Latency considerations

`list_vaults` reports `latencyMs` per vault. Use this to spot misbehaving links. Typical numbers:

| Path | Expected latency |
|---|---|
| localhost | 1–5 ms |
| LAN (Wi-Fi 5) | 10–30 ms |
| Tailscale LAN | 15–50 ms |
| Tailscale WAN (relay) | 80–200 ms |
| Direct Internet (VPS) | 30–100 ms |

If a remote vault consistently exceeds 500 ms, increase its `timeoutMs` to 10–15 s, or check whether Obsidian is doing something expensive on every request (e.g., re-indexing).
