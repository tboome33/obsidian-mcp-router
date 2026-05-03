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

## ✅ v0.4.0 — Frontmatter helpers + move_file + better errors (shipped)

The CRUD surface is now feature-complete for everyday use. Errors are categorized so tools can react sensibly to "vault offline" vs "wrong API key" vs "file not found".

- ✅ `move_file(vault, from, to, overwrite?)` — no native endpoint, fallback GET source → PUT destination → DELETE source. Refuses to overwrite by default; warns if source delete fails post-write.
- ✅ `get_frontmatter(vault, path, key?)` — uses the `application/vnd.olrapi.note+json` content-negotiation of Local REST API to get parsed frontmatter (types preserved).
- ✅ `set_frontmatter(vault, path, key, value)` — wraps `patch_file`. All scalar and structured types supported (string, number, bool, null, array, object).
- ✅ `merge_frontmatter(vault, path, values)` — sequential set per key, returns per-key status (NOT atomic — documented).
- ✅ `RestApiError` class with kinds: `unreachable | timeout | unauthorized | forbidden | cf_access | not_found | conflict | server_error | unknown`. Each kind comes with a `hint` field surfaced to MCP clients in the error response.
- ✅ Manual redirect detection (`redirect: 'manual'` in fetch) so Cloudflare Access redirects are caught and reported as `cf_access` instead of leaking the redirect chain.

Quirk fixed: `Content-Type: application/vnd.olrapi.note+json` wasn't recognized as JSON by the rest-client's content negotiation (was matching only literal `application/json`). Now matches `application/<vendor>+json` too.

Quirk fixed: `patch_file` with `targetType: frontmatter` and a non-string non-object value (number, boolean, null) was sending it as `text/markdown` instead of `application/json`, so Obsidian stored it as a string. Now any non-string value goes through JSON, types preserved end-to-end.

## ✅ v0.4.1 — Onboarding skills (shipped)

Two new conversational skills under [`skills/`](./skills/), installable into `~/.claude/skills/`:

- ✅ `obsidian-router-add-vault` — disambiguates local vs remote, gathers required fields, runs `setup-vault.mjs` for local vaults, edits `config.json` directly for remote vaults, optionally pings the new vault for live verification, refuses to leak secrets to logs.
- ✅ `obsidian-router-status` — calls `list_vaults`, renders a markdown table with online/offline/missingApiKey, then for each unhealthy vault produces a fix hint mapped to the root cause (offline-local vs offline-remote vs cf_access vs unauthorized vs slow).

## ✅ v0.4.2 — Hot reload + small DX (shipped)

The router stops being a "boot once and forget" black box. It now reflects config edits live, supports custom config locations for testing, and lets you mute a vault without deleting its entry.

- ✅ `--config <path>` / `-c <path>` CLI flag for non-default config locations. Also reads `OBSIDIAN_ROUTER_CONFIG` env var. `--help` and `--version` flags added for hygiene.
- ✅ Two ways to disable a vault:
  - Global `disabledVaults: [name1, name2]` array (works for local + remote)
  - Per-remote-vault `enabled: false` flag (only in `remoteVaults` entries)
- ✅ File-watcher on the config file (`fs.watch` with 500ms debounce). When the file changes, the registry reloads atomically — current registry stays in place if the new one fails to parse. Disabled with `--no-watch` or `OBSIDIAN_ROUTER_NO_WATCH` env var. The watcher is `unref()`ed so it never holds the process alive past stdin closure.

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

- **Cross-vault Smart Connections**: collapse the per-vault `obsidian-mcp-router-bridge` integration into a router-level facade so `search_smart` returns merged ranked results across multiple vaults at once (currently a fan-out with per-vault scores).
- **Cross-vault Templater**: same idea for template execution — a single template available from any vault via the router.
- **Operation log**: per-vault append-only log of mutations the router performed, for audit and undo.
- **Read-only mode**: per-vault flag that rejects all write tools (useful for a "reference" vault you don't want Claude editing).
- **Vault federation**: aggregate multiple local-only vaults into a virtual "super-vault" for cross-vault links and search.
