# The `/view` provider contract

This document is the **normative contract** between [obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router) and a *view-link provider*. The router is coupled to **this HTTP contract only** — not to any particular implementation, host, or tunneling technology. This repo ships two providers — `view-agent.py`, the reference (container GUIs + Cloudflare quick tunnels), and `view-agent-direct.py` (signed links to a GUI the reader can already reach, no tunnel; see [Providers without a tunnel](#providers-without-a-tunnel)); anything that honours this page can replace it (a future web app could serve signed per-note magic links through the very same contract).

The router consumes the contract from `src/helpers/view-link.mjs` (`fetchViewLink`), in two modes:

| Mode | Trigger | Timeout |
|---|---|---|
| **Explicit** | the `get_view_link` MCP tool | 25 s |
| **Eager** | auto-injection of a `viewLink` field into every note-write result | **6 s** + a circuit-breaker |

A provider is configured on a router instance with two environment variables:

```
OBSIDIAN_ROUTER_VIEW_AGENT_URL    required — base URL of the provider (no path)
OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN  optional — shared secret, sent as X-View-Token
```

When `OBSIDIAN_ROUTER_VIEW_AGENT_URL` is unset, the whole feature is invisible: `get_view_link` is not even listed, and writes carry no `viewLink`.

---

## Request

```
GET {base}/view?vault=<name>&note=<path>
```

| Part | Required | Semantics |
|---|---|---|
| `vault` (query) | yes | The **canonical vault name** as the router resolved it. The provider decides which vault names it serves. |
| `note` (query) | no | Vault-relative note path (URL-encoded by the router, e.g. `Voyages%2Ftrip.md`). When present, the provider SHOULD make the vault's UI show that note **no later than when the user follows the returned `url`** — either before responding (the reference does) or on click (a provider whose `url` points back at itself). Best-effort: a navigation failure MUST NOT fail the response. |
| `rest` (query) | no | *Vault hint.* The origin of the vault's Local REST API **as the router reaches it**: `scheme://host:port`, nothing else (no credentials, no path). See [Vault hints](#vault-hints). |
| `obsidian_name` (query) | no | *Vault hint.* The vault's name **inside Obsidian**, the label `obsidian://open?vault=` expects (it often differs from the router's canonical name). |
| `X-View-Token` (header) | no | Present iff the router instance has `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN` set. A provider that enforces a token MUST answer `401` on a missing/wrong value. |

The router never sends a body, never uses another method, and never appends extra path segments.

### Vault hints

Optional, additive: a provider that does not know them ignores them, and a router that does not send them gets today's behaviour. They let a provider serve a vault nobody declared to it, by classifying it from what the router already knows:

- the router sends only what it holds **without a secret**: the REST origin (never the API key, never userinfo) and the Obsidian label when it knows one;
- a provider MUST treat hints as claims to classify, never as commands: validate them, never put them into a command line (at most map a validated value onto a fixed choice, such as the scheme picking `http` or `https`), and answer a **4xx** with an explicit `error` when they do not let it classify the vault — never a guessed link;
- a provider's own configuration for a vault always wins over the hints;
- a provider that carries hints into a link it will act on later MUST sign them with the rest of the link.

`view-agent-direct.py` uses `rest` to tell a vault served by a container on its own host (the one container publishing that port) from one opened in a reader's desktop Obsidian (the host is in its `detect.desktop_hosts`), and `obsidian_name` to build the `obsidian://` link for the latter.

## Success response

`200` with a JSON object:

| Field | Type | Required | Semantics |
|---|---|---|---|
| `url` | string, non-empty | **yes** | A **browser-ready** URL the user can click with nothing to type. If the target UI is behind basic-auth, bake the credentials in (`https://user:pass@host/`). A provider MAY return a URL that is only routable from the private network the reader is on (VPN/WireGuard), and MAY leave a single GUI sign-in prompt to the GUI itself when it holds no credentials to bake in. This is the only field the router validates. |
| `idle_timeout_s` | number | recommended | Seconds before the link dies (inactivity window for a tunnel, fixed lifetime for a signed link). Echoed by `get_view_link` as `expiresInSeconds`. **Omit it** when the link does not expire — never send a value that would announce a false expiry. |
| *anything else* | — | no | Ignored by the router (the reference impl also returns `raw_url`, `vault`, `note` for debugging). |

## Error responses

Return JSON `{"error": "<human-readable reason>"}` — the router surfaces `.error` in its diagnostics. The **status-code class is semantically load-bearing** for the router's eager-path circuit-breaker:

| Class | Meaning to the router | Examples |
|---|---|---|
| **4xx** | *Per-vault / permanent* condition. Does **NOT** trip the circuit-breaker — one unsupported vault must never suppress links for healthy vaults. | `400` unknown vault · `401` bad/missing token |
| **5xx** | *Provider-health* failure (transient). Counts toward the breaker (3 consecutive transient failures → the router skips eager calls for 60 s). | `502` tunnel failed to start · `500` anything unexpected |

Transport errors and timeouts are treated like 5xx (transient).

## Timing expectations

- A **warm** target (tunnel/session already up) should answer **well under 1 s** — the eager path rides on every note write.
- A **cold** start may take ~15–25 s (cloudflared handshake **plus edge registration** — see below). That exceeds the 6 s eager timeout: the write then carries a `viewLinkError` instead of a link, and the next call (or an explicit `get_view_link`, 25 s budget) gets the now-warm tunnel. This is expected and acceptable.
- Keep targets warm with a generous idle window (the reference default is 1800 s) so at most the **first** link of a conversation pays the cold start.
- **The returned `url` MUST be routable when returned.** cloudflared prints the quick-tunnel URL on *allocation*, seconds before the edge actually *registers* the connection — a user clicking inside that window gets Cloudflare error 1033 (field bug, 2026-06-10). The reference implementation waits for the local `Registered tunnel connection` log line (config `register_wait_s`, default 30 s, + `register_grace_s`, default 1.5 s) before returning. Providers must NOT readiness-probe the public URL from the host instead: an egress quirk (e.g. broken IPv6) turns the probe into a false judge that kills healthy tunnels.

## Health endpoint (optional, recommended)

```
GET {base}/health   →  200 {"ok": true, ...}
```

Not used by the router; useful for cron-based crash recovery and monitoring (the reference launcher curls it before deciding to relaunch). Because it is token-free, it must leak nothing actionable — the reference impl returns the served vault names and an active-tunnel **count**, never the live tunnel URLs (those are exactly the unguessable hostnames the token gate protects).

## Security expectations on a provider

1. **Listen on a private network only** (loopback or a VPN/WireGuard interface) and firewall the port accordingly. The router reaches you over that private hop.
2. **Support the token gate** so that only the router — not every host on the private network — can mint links.
3. **Keep exposure ephemeral**: what must not last is the *exposure* of the vault UI, not the link itself. A provider that opens a path to the UI (a tunnel) closes it after an idle window, behind an unguessable hostname. A provider whose UI is already private (reachable only over the private network, behind its own auth) MAY return stable links, provided they are signed so that nobody else can forge one. Either way, a provider must never turn a vault UI into a permanently exposed service.
4. **Never log or echo secrets** (tokens, GUI passwords, API keys) anywhere except inside the returned `url` itself.

## Providers without a tunnel

When the reader can already reach the vault's GUI over the private network (e.g. a web-streamed Obsidian over WireGuard), a tunnel adds nothing. `view-agent-direct.py` shows the pattern:

- `/view` returns a link **to the provider itself**, `{self_url}/go?v=<vault>&n=<note>[&h=<anchor>][&e=<exp>]&s=<sig>`, where `sig` is an HMAC-SHA256 over vault, note, anchor and expiry. For a configured vault, minting is pure computation, well under the 6 s eager budget. For a detected vault it also inspects Docker (two fixed commands) within a 5 s deadline that includes waiting for the inventory lock, each command getting at most 2.5 s of what is left; a slower or busy Docker yields an error (`503`), never a guessed link. `/view` does not navigate unless `navigate_on_view` is set, which adds up to 8 s and is off by default. The link stays valid in the chat history (`e` only when a lifetime is configured).
- On click, `/go` verifies the signature in constant time, navigates Obsidian, then answers `302` to the GUI. `/go` is followed by the reader's browser, not the router: it has no 6 s budget. For a detected vault it re-detects before navigating and again before the redirect, each with its own 5 s deadline, around a navigation bounded at 8 s — at most ~18 s in the worst case, well under a second normally. A failed navigation yields an explicit error page, never a silent redirect; it links to the GUI for a configured vault only (a detected vault's GUI port may have been reused).
- Navigation calls the bridge's click-to-open route **from the loopback of the machine or container that runs Obsidian** (`docker exec <container> curl http://127.0.0.1:<port><prefix>...`), where `<prefix>` is the one the bridge announces in `GET /ping` (`openPrefix`: `/mcp-router-bridge/open/` on bridge 0.10.0+, since Local REST API 5.4.0 reserves `/open/`; `/open/` for an older bridge). The route is loopback-only by design, and a Docker-published port presents the Docker bridge IP instead of loopback, so calling it from the host gets `403`.
- Navigating on click rather than on `/view` is what the relaxed `note` rule above allows: the eager path calls `/view` on every note write, and navigating there would make Obsidian jump on each write.
- For a vault it was not configured with, the [vault hints](#vault-hints) travel in the link (`&r=…&o=…`) under the same signature, and `/go` classifies the vault again on click, so a recreated container is found again and a vanished one gets an explicit error page. A detected vault always gets such a signed `/go` link, even without a note (container or desktop); a raw GUI URL or `obsidian://` URI is returned without a note for configured vaults only, as before.

The reader's browser must reach the provider (it follows `/go`), so the private-network and firewall rule covers the reader's machine as well as the router's host.

## Worked example

```
GET http://192.0.2.10:27200/view?vault=alice&note=Notes%2Fhello.md
X-View-Token: 3f9c…

200 {"url": "https://obsidian:s3cret@random-words.trycloudflare.com/",
     "raw_url": "https://random-words.trycloudflare.com",
     "vault": "alice", "note": "Notes/hello.md", "idle_timeout_s": 1800}
```

The router then returns that `url` as `get_view_link`'s `url` field, as the `viewLink` field auto-injected into note-write results (router ≥ 0.29.0), and from `open_in_obsidian` for remote vaults (router ≥ 0.30.0).
