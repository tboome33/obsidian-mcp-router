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

The router cannot check this for you — it observes its own hop to the REST API, never the browser that will do the clicking. But **you** can, from the machine that matters, using a route the bridge already serves:

```
GET /ping?v=<vault name>   → 200 {"pong":true} if the name matches
                           → 404, empty body, if it does not
```

It is loopback-guarded like `/open`, so one request settles two questions at once: **the bridge answers from this machine, and it is this vault's bridge.**

`gen-remote-config.mjs --with-click-to-open` prints one such link per exported vault. Open it **from the browser that will actually dereference your links** — not necessarily the machine you are looking at, if you read through a remote desktop or on a phone.

| What you see | What it means |
|---|---|
| **200 `{"pong":true}`** | ✅ this vault's bridge answers here. Your links will work |
| **404** | ❌ a bridge answers on that port — but a **different vault's**. Port collision: run `setup-vault.mjs --check-ports` |
| nothing, an error, an unfamiliar page | ❌ not a bridge at all |

The 404 case is why the check is worth running: this project measured nine port collisions on a 27-vault fleet (v0.77.0), and a neighbouring bridge will happily accept your links and then open the wrong vault's notes.

> The name in `?v=` is the vault's **folder name** (what Obsidian calls it), which is not always what the router's config calls it — on this fleet 4 of 23 differ. The generator emits the folder name; if you build the URL by hand, use that.

The port number itself is not a secret: it is not an authentication credential, writing it into a config opens or binds nothing, and it is only *useful* to a process already on the Obsidian host's loopback — which can find it by scanning a couple of hundred ports in milliseconds. The same file already carries that vault's bearer key, which is strictly more powerful. The risk above is about the *reader's* machine, not about the port.

One more consequence: `build_open_link` normally *verifies* a path against the local disk and corrects or refuses a wrong one. It cannot do that for a vault with no disk, so its result carries **`pathVerified: false`** and a `verification` sentence. The URL is well-formed; it is not proof the file exists.

## `find_twin_pages` on a remote vault (v0.82.0)

`find_twin_pages` compares every page against every other by cosine, using the vectors Smart Connections keeps in `<vault>/.smart-env/multi/`. That is a **dot-directory the Local REST API does not serve** — and not by oversight: measured on a real vault, Obsidian's own `vault.getFiles()` returns zero entries under `.smart-env`, so nothing in the core API can see it.

The bridge can, because it is a plugin and has `vault.adapter`. It serves those records at:

```
GET /smart-env/sources     (Bearer-authenticated, like reading a note)
```

so the tool now works on a networked vault. **This needs obsidian-mcp-router-bridge 0.9.0+ on the machine running that vault**; against an older one the tool answers `available: false, reason: "bridge-route-absent"` and tells you to upgrade.

What the route sends is the store's whole-note record lines and nothing else — the bridge does not parse a record or look at a vector, so the router remains the single definition of what the store means. Both paths then run the *same* comparison. Measured on this project's own vault, disk and remote return identical pairs, an identical derived threshold (0.9325587591708842) and identical exclusion counts.

The cost is real and worth knowing before you point it at a vault across a slow link:

| | this vault |
|---|---|
| store on disk | 166 MB |
| sent (whole-note records only) | 22.3 MB |
| **on the wire, gzipped** | **4.3 MB** |
| wall clock, loopback | 3.5 s (vs 0.6 s on disk) |

Compression is negotiated automatically and the router's HTTP client inflates it transparently — there is nothing to configure. If the store is larger than the bridge will send in one response, the tool answers `store-truncated` rather than comparing a prefix of your vault and calling the result "no twins".

## Step 3 — production

If the vault is reachable from outside your LAN (over the public Internet, or even over an untrusted Wi-Fi), do not rely on the plugin's self-signed cert + Bearer token alone. Put it behind a reverse proxy with:

- **Real TLS** (Caddy or Nginx with Let's Encrypt).
- **mTLS** or an additional layer (oauth2-proxy, Cloudflare Access, Tailscale Funnel).

Then in the router config, set `tlsInsecure: false` and `baseUrl` to the public URL. The Bearer token from the plugin acts as a second factor behind the proxy.

## Step 4 — WireGuard or Tailscale (recommended for personal use)

Both are the same idea — an authenticated mesh, so the plugin's self-signed cert is fine and there is no reverse-proxy boilerplate to run. They are **both** first-class transports here; **neither is required to use the other**. Pick WireGuard when you already run your own mesh (this project's own `10.8.0.0/24` is one), or Tailscale when you would rather not manage keys yourself.

**WireGuard.** Every machine on the mesh reaches every other by its WireGuard IP — no port-forwarding, no public DNS. In the router config, use that IP as `baseUrl`'s host (`https://10.8.0.5:27125`) and keep `tlsInsecure: true` (the mesh itself is the authentication boundary; the plugin's self-signed cert only needs to stop a passive eavesdropper, which WireGuard already does one layer down). `hostPassesTransportGuard` (`src/helpers/remote-config.mjs`) already recognizes `10.8.0.0/24` and loopback as passing `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK` without extra configuration — a host outside that mesh (and not loopback) is flagged, not silently accepted.

**Tailscale.**

1. Install Tailscale on every machine that runs an Obsidian vault and on your client(s).
2. In the plugin, bind to `0.0.0.0` (or to the Tailscale IP specifically).
3. Reach the vault at `https://<machine>.tailnet.local:27125` — Tailscale handles auth + encryption transparently.
4. In the router config, use that hostname and keep `tlsInsecure: true` (the plugin's self-signed cert is fine inside Tailscale because the network itself is authenticated).

Either way this avoids the reverse-proxy boilerplate and works across mobile, desktop, and NAS. A domain name in front of a real, publicly-trusted TLS certificate (Step 3, above) is the third option, equally valid — it is what you want when the reader is a device you cannot enroll in your own mesh (a family member's own account, a machine you do not administer).

## Concurrent writers — `ifMatch` on a shared vault

Opening a vault to more than one machine makes the common case a vault reachable from **more than one workspace**, not just more than one person sitting at a keyboard — a knowledge base two projects both write to is exactly the shape this document's own use cases (NAS, office ↔ home, multi-device) encourage. `write_file`'s `ifMatch` (a `contentSha256` from `get_file`, checked as an atomic compare-and-swap) is how two writers on the same note avoid silently overwriting each other — without it, the second write simply wins and the first is gone with no error and no trace beyond `wiki-meta/journal.md`.

**The concrete scenario.** Roland and his son both have this vault registered — Roland's session on his desktop, his son's on his own machine, both reaching the same `remoteVaults` entry over WireGuard. Neither knows the other is mid-edit. If both sessions call `write_file` on the same page within the same few seconds, whichever request the vault's REST API processes second overwrites the first outright, unless that second call passed `ifMatch` from a `get_file` taken before its own edit — in which case it gets a 409 conflict instead of a silent loss, and can re-read and retry.

**What holds today — and it is no longer advice.** On a vault this router's own binding registry sees attached to **more than one workspace**, a write with no precondition is **refused**, not merely discouraged. The requirement is computed, never declared: there is no switch to set and nothing to keep up to date, because the registry already knows which workspaces name which vault. A vault only one workspace declares is unaffected — it writes exactly as it did before, `ifMatch` optional — with one honest exception: if the router cannot read its own config at that moment, it answers "unknown" and refuses like a shared vault rather than guessing "nobody".

Four details worth knowing before you meet the refusal:

- **What satisfies it.** `ifMatch` (the `contentSha256` a `get_file` returned — `get_frontmatter` returns none) on `write_file`, `append_to_file`, `patch_file`, `set_frontmatter`, `merge_frontmatter`, `move_file` and `delete_file`; `ifNew: true` on `write_file` when you are creating a note that must not exist yet — a compare-and-swap against absence, checked by the router with a read just before the PUT, and the reason creating pages on a shared vault stays possible. A `write_bundle` needs one **per step** (`ifMatch`, or `ifNew: true` on a write step — both checked before its first write, so a stale bundle refuses whole), or the `approvedPlanSha256` a `preview: true` call returned, which pins every target. `delete_file` likewise accepts its preview seal in place of `ifMatch`. `execute_template` with `createFile: true` is create-only at the bridge (an existing `targetPath` is refused with a 409 before rendering), so it passes as it is. `download_page_assets` passes with `createOnly: true`: every asset is then written create-only, an existing name falls through to the content-hash name, and an asset already there is reported rather than overwritten. A `write_bundle` **recovery run** passes with `expect: { "<path>": "<currentSha256>" | null }` for every path it will restore, copied from the `recover: true` listing.
- **A file that does not exist yet.** `append_to_file` and `patch_file` cannot be guarded by `ifMatch` on an absent file (there is nothing to have read); create it first with `write_file` + `ifNew: true`, then append or patch.
- **`openVaults` counts as shared by hypothesis.** Such a vault is reachable from every workspace without being declared by any, so the count cannot see it and its readership is not knowable. It always requires a precondition — whether the name sits in the config file or in the registry this session loaded.
- **Where to look before you write.** `list_vaults` reports `writesRequireIfMatch` and `sharingReason` per vault (`multi-workspace`, `open-vault`, or `registry-unreadable`), so a session can know in advance rather than by being refused.

Tools that regenerate a derived artifact from the vault's own content (`build_wiki_graph`, `build_search_index`, `refresh_okf_projections`) are exempt: there is no "content I read" to pin, and two sessions racing produce the same file from the same source. `record_source` is exempt because it already does its own compare-and-swap on the shared ledger. `provision_vault` and `register_remote_vault` address no note in an existing vault.

**The honest limit, stated with the mechanism rather than left implicit.** These checks protect writes that go through the router **from each other**. An edit already saved in Obsidian's own editor on the host machine IS caught — its hash differs from what you read; a save that lands after the check is not, and an Obsidian Sync / LiveSync replica never passes through the REST API this router calls at all. And only `write_file` + `ifMatch` (directly, or as a `write_bundle` write step) against a bridge that serves `/vault-cas/` is a true atomic compare-and-swap; every other check — the GET-compare fallback on an older bridge, the checks behind `ifNew`, `approvedPlanSha256`, `expect`, and the per-file guards of the other tools — runs just before the write, which narrows the window to one round trip rather than closing it. Two narrower limits, for the same reason: `move_file`'s precondition guards the **source**, so with `overwrite: true` the destination can still be replaced (the default, `overwrite: false`, refuses an existing destination outright); and the router's own maintenance writes — the audit line, the first-contact repair, the projections refresh — carry no precondition, being regenerations rather than edits.

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
