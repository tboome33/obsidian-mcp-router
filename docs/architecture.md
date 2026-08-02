# Architecture

## High level

```
┌─────────────┐
│   Claude    │
│  Desktop /  │
│    Code     │
└──────┬──────┘
       │ stdio (MCP)
       ▼
┌──────────────────────┐
│ obsidian-mcp-router  │   src/index.mjs
│   (Node process)     │
│                      │
│  reads config.json   │   src/registry.mjs
│  fan-out HTTPS       │   src/rest-client.mjs
└──┬────────┬────────┬─┘
   │        │        │
   ▼        ▼        ▼
:27xxx   :27xxx   <remote URL>
vault A  vault B   QNAP / VPS / tunnel
(REST)   (REST)    (REST over LAN/WAN)
```

The router is a **stateless fan-out**: every MCP tool call is translated into one or more HTTPS calls against the appropriate Obsidian Local REST API instances. There is no database, no note cache, no copy of vault content inside the process. The only state that survives between calls is session-scoped **control state** — the single-vault lock (`lock_vault`) and the auto-enrichment mode — plus whatever derived artifacts some tools write **into the vault itself** (e.g. the knowledge-graph JSON produced by `build_wiki_graph`), where they stay visible and reconstructible.

## Data flow for a typical call

1. Claude calls a tool, e.g. `get_file({ vault: "tradingview", path: "Sessions/2025-05-02.md" })`.
2. `src/tools/get-file.mjs` looks up the vault in the registry by name.
3. `src/rest-client.mjs` issues `GET https://127.0.0.1:<port>/vault/Sessions/2025-05-02.md` with the vault's API key as a Bearer token.
4. Obsidian's Local REST API plugin responds with the file content.
5. The router wraps the result in an MCP `content` block and returns it.

## Registry resolution

`src/registry.mjs` is the only piece that knows about config sources. Three of them, merged in order:

1. **`portRegistry`** — local vaults. Their API key is read from each vault's `.obsidian/plugins/obsidian-local-rest-api/data.json`, so **the router is always in sync with what `setup-vault.mjs` provisioned** — no separate database to keep aligned.
2. **`remoteVaults`** — explicit `{ name, baseUrl, apiKey, ... }` entries, taken verbatim.
3. **`VAULT_<NAME>` env vars** — a vault defined entirely in an env var (JSON), editable from a hub dashboard (e.g. MCPHub). Merged last; overrides any same-name vault.

Each source produces `vault` descriptors:

```ts
{
  name: string;
  type: 'local' | 'remote';
  baseUrl: string;
  apiKey: string | null;
  tlsInsecure: boolean;
  timeoutMs: number;        // 5000 local, 10000 remote by default
  path?: string;            // only for local vaults
  description?: string;
  missingApiKey?: boolean;
}
```

Vaults listed in `disabledVaults` are skipped (and reported as such by `list_vaults`). Scoped/multi-tenant instances additionally apply the `OBSIDIAN_ROUTER_ALLOWED_VAULTS` whitelist and, when `OBSIDIAN_ROUTER_ENFORCE_WG_OR_LOOPBACK=true`, refuse to start if a served vault's baseUrl host is neither loopback nor inside the WireGuard mesh.

The **default vault** is resolved by a 5-tier cascade (highest first): `OBSIDIAN_ROUTER_DEFAULT_VAULT` env var → `VAULT_PATH` auto-detection from the workspace `.env` → `config.defaultVault` → first healthy local vault → first active vault of any type.

## Tool surface

The router's catalog holds **48 MCP tools**: vault discovery & session control (5), reading & search (4), the local BM25 search index (1), writing & surgical editing (8), Templater execution (1), document conversion to markdown (12), web-ingestion helpers (4), the source ledger (2), wiki graph & context (5), OKF projections (1), links & navigation (3), and the vault-creation wizard (2). The full, human-readable feature guide lives in [`docs/features/`](features/README.md); the compact per-tool tables are in the [README](../README.md).

The counter above is checked in CI: `contracts/skill-capabilities.json` declares what every skill reads, writes and requires, and `npm run validate` fails when this sentence, the skills' own pages, and the tool catalog disagree. See [Skill capability contracts](../README.md#skill-capability-contracts-contractsskill-capabilitiesjson).

Three runtime gates shrink the exposed surface per deployment (`computeExposedTools` in `src/index.mjs`):

- `OBSIDIAN_ROUTER_READONLY` hides every write tool;
- `get_view_link` only appears when a view-agent is configured (`OBSIDIAN_ROUTER_VIEW_AGENT_URL`);
- gated/multi-tenant deployments hide the local-only provisioning tools (`provision_vault`).

Each tool accepts an optional `vault` argument; when omitted, the router uses the resolved default vault (or the locked vault when single-vault isolation is on). The special value `vault: "*"` is supported by `search` and triggers a fan-out across every vault in parallel using `Promise.allSettled` (a single offline vault doesn't fail the whole call).

## Why no caching?

Notes change. Aggressive caching means stale reads, which silently corrupts Claude's context. The Local REST API is fast enough on localhost that caching is unnecessary; for remote vaults, the user-perceptible latency comes from the network, not from re-reading the file.

The corollary for derived data: anything the router *does* precompute (knowledge-graph JSON, digests) is written **into the vault** as a normal, visible, reconstructible file — never held as hidden process state. Tools that read those artifacts (e.g. `build_wiki_tour`, `get_page_neighbors`) say so explicitly rather than pretending to be live.

## TLS handling

The Local REST API plugin ships with a self-signed cert (regenerated when the user clicks "Regenerate certificate" in settings). On `127.0.0.1`, this is fine — but Node refuses self-signed certs by default. Each vault has a `tlsInsecure` boolean; when true, the router uses an `undici.Agent` with `connect: { rejectUnauthorized: false }`.

For remote vaults exposed over a real TLS cert (e.g., behind Caddy with Let's Encrypt), set `tlsInsecure: false`. For an offline LAN vault with a self-signed cert, leave it `true` (you trust the network anyway).

## Process model

The router is a single Node process spawned by Claude over stdio. No HTTP server of its own. No background workers. Every tool call is short-lived and independent. If the process crashes, Claude restarts it on the next call.

The same process can also run as a scoped instance behind a hub (MCPHub, `mcpo`, a custom proxy) for multi-tenant deployments — it still speaks stdio; the hub owns the network transport, authentication and per-user scoping (see the README's "scoped instance" env vars).
