# Roadmap

A living list of what's coming next, ordered roughly by priority.

## ✅ v0.2 — Semantic search (shipped)

Reverse-engineered the `mcp-tools` plugin's API extension to Local REST API to discover the `POST /search/smart` endpoint, then implemented `search_smart` directly against that HTTPS surface — **no dependency on the `mcp-server.exe` binary**.

- ✅ `search_smart(vault, query, folders?, excludeFolders?, limit?)` — semantic search with cosine scores and breadcrumbs
- ✅ Cross-vault fan-out via `vault: "*"`
- ✅ Graceful error when the target vault lacks the `smart-connections` plugin

The same approach unlocks `/templates/execute` for v0.3.

## ✅ v0.3 — Write operations + Templater (shipped)

The router can now fully replace `mcp-tools` for day-to-day usage. All writes go through the same Local REST API plugin endpoints; Templater execution goes through the `mcp-tools` extension.

- ✅ `write_file(vault, path, content, ifNew?)` — `PUT /vault/<path>` (create or replace)
- ✅ `append_to_file(vault, path, content, requireExisting?)` — `POST /vault/<path>`
- ✅ `patch_file(vault, path, operation, targetType, target, content, ...)` — `PATCH /vault/<path>` for surgical edits to `heading` / `block` / `frontmatter` targets
- ✅ `delete_file(vault, path, confirm)` — `DELETE /vault/<path>` with explicit confirm guard
- ✅ `execute_template(vault, name, arguments?, createFile?, targetPath?)` — `POST /templates/execute` via the mcp-tools extension. Templates access router-injected args via `tp.mcpTools.prompt("key")`.

Quirks discovered and documented inline:
- `/templates/execute` validator wants `application/json` with a real object — different from `/search/smart` which expects a stringified-JSON in `text/plain`.
- The PATCH `heading` target must be the **full heading path** joined by the delimiter (default `::`), not just the immediate heading name.
- `tp.mcpTools` is added to `tp` directly, not under `tp.user` — diverges from typical Templater user-script convention.

Deferred to v0.4: `move_file` (no native REST endpoint — needs PATCH-rename or a Get+Put+Delete fallback) and frontmatter helpers (read-modify-write convenience around `patch_file`).

## v0.4 — Quality of life

- [ ] `move_file(vault, from, to)` — likely PATCH-rename if Local REST API supports it, else GET → PUT → DELETE fallback
- [ ] Frontmatter helpers — read/update single keys without remembering PATCH header semantics
- [ ] `obsidian-router-add-vault` skill — interactive flow to add a remote vault
- [ ] `obsidian-router-status` skill — diagnostic ping of all vaults, surface which are offline
- [ ] `--config <path>` CLI flag for non-default config locations
- [ ] Friendlier errors when a vault is offline (current: 5s timeout then a verbose stack)
- [ ] Per-vault `enabled: false` flag to hide a vault from `list_vaults` without removing it
- [ ] Cache config reads with file-watcher so `list_vaults` reflects edits without restart

## v0.5 — Cloudflare Tunnel companion plugin

A separate **Obsidian community plugin** that provisions a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for the local vault's REST API. Goal: the user clicks a button in Obsidian, the vault becomes reachable from anywhere via a stable HTTPS URL, with optional auth.

### Why

Today, the only secure ways to reach a remote Obsidian vault are:
- Tailscale (great, but requires Tailscale on every client)
- Reverse proxy + Let's Encrypt (works, but needs a public IP and DNS)
- VPN (heavy, configurable per OS)

Cloudflare Tunnel gives you a public HTTPS URL on `*.trycloudflare.com` (or your own domain) without opening any firewall port, without static IPs, and with optional Cloudflare Access in front. For a personal "iPad reads laptop's vault from a café" workflow, this is the lowest-friction option.

### Sketch

The plugin would:

1. Bundle (or download) the `cloudflared` binary on first activation, with platform detection.
2. Expose Obsidian Local REST API on `127.0.0.1:<port>`.
3. Spawn `cloudflared tunnel --url https://localhost:<port> --no-tls-verify` (because the plugin's cert is self-signed inside the tunnel — Cloudflare terminates real TLS at the edge).
4. Capture the assigned public URL (e.g. `https://random-words.trycloudflare.com`) and surface it in the plugin settings panel with copy-to-clipboard.
5. Optional: enable Cloudflare Access policies (email-pinned, OTP, or service-token auth) declaratively from the plugin settings.
6. Optional: write the tunnel URL + API key into `obsidian-mcp-router`'s `config.json` `remoteVaults` array, so the router picks it up automatically on next restart.

### Auth modes to support

| Mode | Use case |
|---|---|
| **None** (Bearer token only) | Trusted personal usage, ephemeral demos. Risky if URL leaks. |
| **Cloudflare Access — email OTP** | Personal multi-device, no enterprise plan needed (free tier supports up to 50 users). |
| **Cloudflare Access — service token** | Headless clients (CI, scripts, the router on another machine). |
| **Cloudflare Zero Trust mTLS** | Paranoid mode for shared/team vaults. |

### Where it lives

A separate repo: `tboome33/obsidian-cloudflare-tunnel-plugin`. Built with the standard Obsidian plugin template, written in TypeScript, distributed via the Community Plugins store once stable.

### Why a plugin and not a script

- Keep the user in the Obsidian UI (no terminal dance).
- Plugin lifecycle ties tunnel start/stop to Obsidian start/stop — no orphan processes.
- Surface tunnel URL right where it's needed.
- Settings panel is the natural home for auth configuration.

## v1.0 — Stable release

Criteria:
- All Local REST API endpoints covered or deliberately excluded
- Skill-based install validated on a fresh machine
- README polished, contribution guide
- Repo public on GitHub
- Possibly published as `@tboome33/obsidian-mcp-router` on npm

## Beyond v1.0 — Possible directions

- **Smart Connections proxy**: proxy `mcp-server.exe` (the jacksteamdev binary) through the router so semantic search becomes available across all vaults too.
- **Templater proxy**: same idea for template execution.
- **Operation log**: per-vault append-only log of mutations the router performed, for audit and undo.
- **Read-only mode**: per-vault flag that rejects all write tools (useful for a "reference" vault you don't want Claude editing).
- **Vault federation**: aggregate multiple local-only vaults into a virtual "super-vault" for cross-vault links and search.
