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
:27124   :27125   <remote URL>
template TradingView   QNAP / iPad / VPS
(REST)    (REST)        (REST over LAN/WAN)
```

The router is a **stateless fan-out**: every MCP tool call is translated into one or more HTTPS calls against the appropriate Obsidian Local REST API instances. There is no caching, no persistence, no state between calls.

## Data flow for a typical call

1. Claude calls a tool, e.g. `get_file({ vault: "tradingview", path: "Sessions/2025-05-02.md" })`.
2. `src/tools/get-file.mjs` looks up the vault in the registry by name.
3. `src/rest-client.mjs` issues `GET https://127.0.0.1:27125/vault/Sessions/2025-05-02.md` with the vault's API key as a Bearer token.
4. Obsidian's Local REST API plugin responds with the file content.
5. The router wraps the result in an MCP `content` block and returns it.

## Registry resolution

`src/registry.mjs` is the only piece that knows about config files. It produces a list of `vault` descriptors:

```ts
{
  name: string;
  type: 'local' | 'remote';
  baseUrl: string;
  apiKey: string | null;
  tlsInsecure: boolean;
  timeoutMs: number;
  path?: string;          // only for local vaults
  description?: string;
  missingApiKey?: boolean;
}
```

Local vaults are derived from `portRegistry`. Their API key is read from each vault's `.obsidian/plugins/obsidian-local-rest-api/data.json`. This means **the router is always in sync with what `setup-vault.mjs` provisioned** — no separate database to keep aligned.

Remote vaults are taken verbatim from the `remoteVaults` array.

## Tool surface

The router exposes 4 MVP tools (more on the roadmap). Each tool accepts an optional `vault` argument; when omitted, the router uses `config.defaultVault`. The special value `vault: "*"` is supported by `search` and triggers a fan-out across every vault in parallel using `Promise.allSettled` (a single offline vault doesn't fail the whole call).

## Why no caching?

Notes change. Aggressive caching means stale reads, which silently corrupts Claude's context. The Local REST API is fast enough on localhost that caching is unnecessary; for remote vaults, the user-perceptible latency comes from the network, not from re-reading the file.

If we ever cache, it should be opt-in per-tool with a TTL exposed in the tool's input schema.

## TLS handling

The Local REST API plugin ships with a self-signed cert (regenerated when the user clicks "Regenerate certificate" in settings). On `127.0.0.1`, this is fine — but Node refuses self-signed certs by default. Each vault has a `tlsInsecure` boolean; when true, the router uses an `undici.Agent` with `connect: { rejectUnauthorized: false }`.

For remote vaults exposed over a real TLS cert (e.g., behind Caddy with Let's Encrypt), set `tlsInsecure: false`. For an offline LAN vault with a self-signed cert, leave it `true` (you trust the network anyway).

## Process model

The router is a single Node process spawned by Claude over stdio. No HTTP server of its own. No background workers. Every tool call is short-lived and independent. If the process crashes, Claude restarts it on the next call.
