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

### Optional — `insecurePort`, and when it buys you anything (v0.79.0)

Thirteen tools return a `clickToOpenUrl`: `http://127.0.0.1:<insecurePort>/open/<path>`, a link that opens the note in Obsidian. For a local vault the router reads that port out of the vault's own `data.json`. A remote vault has no disk to read, so the field can be declared instead:

```json
{ "name": "qnap", "baseUrl": "https://127.0.0.1:27125", "apiKey": "…", "insecurePort": 27135 }
```

Copy the value from that vault's `data.json` (`insecurePort`, and only if `enableInsecureServer` is `true`). `gen-remote-config.mjs` will do it for you, but only when asked: `--with-click-to-open`. It is deliberately not the default, and the next two paragraphs are why.

**What declaring it means.** The emitted link is always `http://127.0.0.1:<insecurePort>/…`, never the vault's `baseUrl` host. The bridge's `/open` route accepts only loopback source IPs (see the vault decision `click-to-open-access-modes`), and that request comes from *your browser*, not from the router. So whether a click works depends on one thing: **is the person reading the chat sitting at the machine running that vault's Obsidian?** The router cannot see your topology, and `baseUrl` does not answer this — it describes how the *router* reaches the REST API, over a tunnel or a mesh, which is a different hop entirely.

**Declaring `insecurePort` is your assertion that the loopback your readers resolve is the host running that vault's Obsidian.** The shape where that holds is a single workstation running Obsidian, with the router or the remote session reaching it through a tunnel anchored on that same workstation. Omit it on a multi-machine or shared deployment and no link is ever emitted.

**If the assertion is wrong**, the click reaches the reader's own loopback and finds nothing — or finds an *unrelated local service*, and hands it the note's path and heading. `/open` never returns file content, so what the note **says** is never disclosed. But a path can name a person or a condition, and that is a real disclosure to whatever owns that port on that machine. Weigh it before turning the flag on for a vault whose filenames are themselves sensitive.

### Verify the assertion in one click

The router cannot check this for you — it observes its own hop to the REST API, never the browser that will do the clicking. But **you** can check it, from the machine that matters, using a property the bridge already has.

`/open` applies two guards in order: the source IP must be loopback (else `loopback only`), then the path must be non-empty and non-traversing (else `path traversal refused`). So a request with an **empty** path passes the first and dies on the second:

```
http://127.0.0.1:27163/open/
```

Open it **from the browser that will actually dereference your links** — not necessarily the machine you are looking at, if you read through a remote desktop or on a phone.

| What you see | What it means |
|---|---|
| **403 `path traversal refused`** | ✅ a bridge answered — your links will reach it from here |
| an unfamiliar page, an error, or nothing | ❌ not the bridge. Do not use the flag for this vault |

That error message is the identity proof available to you: **only the bridge says it, and only to a loopback caller.** `gen-remote-config.mjs --with-click-to-open` prints one such link per exported port. Open it once, on the machine where you read your chat responses, and the assumption stops being an assumption.

**What it does not prove.** It establishes that *a* bridge is listening on that port from that machine — not that it is *this vault's* bridge. That distinction is not theoretical here: this project measured nine port collisions on a 27-vault fleet (v0.77.0), and a neighbouring vault's bridge would answer the same message and then open the wrong vault's notes. If your fleet has ever collided (`setup-vault.mjs --check-ports`), follow up by opening one real note link and checking that the note you expected is the one that opens.

The port number itself is not a secret: it is not an authentication credential, writing it into a config opens or binds nothing, and it is only *useful* to a process already on the Obsidian host's loopback — which can find it by scanning a couple of hundred ports in milliseconds. The same file already carries that vault's bearer key, which is strictly more powerful. The risk above is about the *reader's* machine, not about the port.

One more consequence: `build_open_link` normally *verifies* a path against the local disk and corrects or refuses a wrong one. It cannot do that for a vault with no disk, so its result carries **`pathVerified: false`** and a `verification` sentence. The URL is well-formed; it is not proof the file exists.

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
