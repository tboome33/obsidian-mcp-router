---
name: build-search-index
description: |
  Build (or refresh) a vault's LOCAL BM25 search index — a deterministic, plugin-free search tier that works on every vault, including those without Smart Connections. Writes wiki-meta/search-index.json. Idempotent: an unchanged vault is detected by content fingerprint and the write is skipped.

  EN triggers: "build the search index", "index this vault for search", "refresh the local search index", "make search work without Smart Connections", "why does search say no index".
  FR triggers : "construis l'index de recherche", "indexe ce vault", "rafraîchis l'index local", "fais marcher la recherche sans Smart Connections", "la recherche dit qu'il n'y a pas d'index".

  Example / Exemple:
    EN: "build the search index for my kiviri vault"
    FR: "construis l'index de recherche du vault kiviri"
---

# build-search-index

Call the obsidian-router `build_search_index` MCP tool with arguments parsed from $ARGUMENTS.

## Arguments

**Optional**:
- `vault` — vault name. Omit for the default vault.
- `check` — `true` to report whether the stored index is absent / stale / current **without writing**.

## Argument parsing from $ARGUMENTS

- bare vault name → `vault`
- `--check` / "juste vérifier" / "dry run" → `check: true`
- empty → default vault, real build

## What it does

Walks `wiki/` (user content only — `wiki-meta/` scaffolds and the generated OKF projections are excluded), splits every page into chunks, and prefixes each chunk with its **context header**: page title · frontmatter `description` · heading path. That header is indexed with the body, so a query matching a page's title or description still finds its chunks, and every hit can say where it came from.

Deterministic — no LLM, no network, no plugin. The same vault always produces the same index and the same ranking.

## Reporting the result

Relay these fields plainly:
- `indexState` — `absent` (first build) · `stale` (vault changed) · `current` (nothing to do) · `foreign-version`
- `written` — whether a file was actually written. `upToDate: true` + `written: false` is a **success**, not a no-op failure: the fingerprint matched, so nothing needed rewriting. Say "already up to date".
- `stats` — `{ pages, chunks, tokens }`.
- `warnings` — **always surface these verbatim.** In particular:
  - an **EMPTY** index (0 chunks) means nothing indexable was found — a layout problem (no `wiki/` directory, or content lives elsewhere), NOT a successful build. Don't gloss it as "done".
  - `truncated` means the corpus hit the chunk cap and the index does **not** cover the whole vault.

## When to run it

- Once per vault to enable `search_smart`'s `tier: "local"` and its automatic fallback.
- After a large ingestion or import, to pick up the new pages.
- Whenever `search_smart` refuses with "No local search index" or "index is EMPTY".

Re-running costs nothing on an unchanged vault (fingerprint check → no write).

## On failure — remediate, NEVER hand-write the index

- **`skipped: 'page-reads-failed'` / `'enumeration-truncated'`** → the build refused **on purpose**: an index built from a partially-readable tree would silently miss pages, and a search that quietly misses content is worse than one that says it cannot run. Fix the vault access (is Obsidian open? is the REST API up?) and re-run. Never build a partial index.
- **Connection error** → vault closed; `list_vaults`, then ask the user to open it via the `openUri` link.
- Never write `wiki-meta/search-index.json` by hand or with filesystem tools — it is a derived artefact with a content fingerprint; a hand-edit desynchronises it from the vault and the tool will refuse or rebuild it anyway.
