---
name: wiki-graph
description: Build a typed knowledge graph (Understand-Anything-compatible JSON) from a vault's wiki — articles, entities, claims, sources, topics, and their relationships — so it can be visualised in an interactive graph dashboard. Use when the user says "build the knowledge graph", "graph my vault", "make a knowledge-graph.json", "visualise my wiki as a graph", "/wiki-graph", "construis le graphe de connaissance", "graphe du vault", or wants to explore their wiki's structure visually / feed it to Understand-Anything's dashboard.
argument-hint: "[vault] [--dry-run]"
---

# wiki-graph

Assemble a **typed knowledge graph** from a vault's wiki and write it as JSON. The graph uses the **Understand-Anything schema verbatim** (`Lum1104/Understand-Anything`) so it can be visualised directly in that plugin's dashboard — see "Viewing it" below. Reference: [[understand-anything-roadmap]] item #1.

This skill is the **deterministic core** (`--deterministic-only` semantics): it maps existing vault data into a graph with **no LLM calls**. The LLM enrichment layers (auto-generating missing digests, discovering `builds_on`/`contradicts` edges) and Louvain community detection are roadmap follow-ons, not in this version.

## What it produces

A `knowledge-graph.json` written to **two locations**:

| Path | Role |
|---|---|
| `wiki-meta/graph/knowledge-graph.json` | **Canonical** source of truth — read by the future native viewer, agents, `get_wiki_context_pack`. |
| `.understand-anything/knowledge-graph.json` | **Derived copy** — read directly by Understand-Anything's `/understand-dashboard` (zero extra step). |

Both files are byte-identical. The derived copy is regenerated each run.

## How the graph is built (deterministic)

| Vault data | → Graph |
|---|---|
| each `wiki/` page | `article` node (with `knowledgeMeta`: wikilinks, frontmatter) |
| digest `concepts` (`wiki-meta/digests/`) | `entity` nodes (deduped globally) + `related` edges |
| digest `claims` | `claim` nodes (page-namespaced) + `related` edges |
| `[[wikilinks]]` between pages | `related` edges |
| **referenced sources** — frontmatter `sources:`, `^[file:42-58]` citations, `![[x.pdf]]` embeds | `source` nodes (lightweight, unparsed) + `cites` edges |
| `wiki-meta/index.md` sections | `topic` nodes + `categorized_under` edges + `layers[]` |

**Key invariant (the binaries rule):** a file a page *references* becomes a `source` node **even if it matches `.wikiignore`**. `.wikiignore` excludes files from becoming *content* (`article` nodes / lint / export), NOT from being *referenceable* as sources. So you can always trace a page back to its PDF/image and click through to it.

## Pre-conditions

1. Vault is online (`list_vaults`).
2. Vault has a `wiki/` directory with content pages. Richer graphs come from richer digests — if few pages have digests under `wiki-meta/digests/`, suggest running `/wiki-refresh-digests` first for fuller entity/claim extraction.

## Steps

### 1. Resolve vault + options

- `vault` — target vault (default vault if omitted).
- `--dry-run` → pass `dryRun: true` to preview counts WITHOUT writing.
- `--no-ua-copy` → pass `writeUnderstandAnythingCopy: false` to skip the `.understand-anything/` copy.

### 2. (Optional) dry-run preview

For a first build or a big vault, preview first:

```
mcp__obsidian-router__build_wiki_graph({ vault, dryRun: true })
```

Report the counts (nodes/edges by type) so the user can sanity-check before writing.

### 3. Build + write

```
mcp__obsidian-router__build_wiki_graph({ vault })
```

The tool enumerates `wiki/**` + `wiki-meta/digests/**`, reads `.wikiignore` + `wiki-meta/index.md`, builds the graph, **validates it against the schema** (refuses to write an invalid graph), and writes the two files.

### 4. Report

Surface the returned summary:
- `counts` — pages, digests, nodes, edges, layers + per-type breakdown
- `written` — the two paths
- `warnings` — e.g. `index-not-found`, `no-content-pages-found`, `page-enumeration-truncated`, `understand-anything-copy-failed`

### 5. Log

Append to `wiki-meta/log.md`:

```
- YYYY-MM-DD HH:MM — wiki-graph — <vault> · <nodes> nodes / <edges> edges / <layers> layers
```

## Viewing it (the interop — roadmap #2a)

The derived `.understand-anything/knowledge-graph.json` is written where Understand-Anything's dashboard expects it. To explore the graph interactively:

1. Install the Understand-Anything plugin (`/plugin marketplace add Lum1104/Understand-Anything` → `/plugin install understand-anything`).
2. Run `/understand-dashboard <vault-path>` — it reads our JSON directly (no need to run `/understand-knowledge`; we already produced the graph).

A native in-Obsidian viewer (`obsidian-mcp-router-graph`) is the roadmap #2b deliverable — until it ships, the UA dashboard is the visualisation path.

## When NOT to use

- A single page's links → use `get_wiki_context_pack` (it returns `graphNeighbors` for a query) instead of building the whole graph.
- A portable text dump for an external LLM → use `wiki-export` (`llms.txt`).
- Code-repo analysis → out of scope (that's Understand-Anything's `/understand` on the code side).

## Anti-patterns

- Don't hand-edit the generated JSON — it's derived; re-run the skill instead.
- Don't add `wiki-meta/graph/` or `.understand-anything/` as *content* sources — they're derived artifacts, excluded by the default `.wikiignore`.
- Don't expect `builds_on`/`contradicts` edges yet — those need the LLM enrich pass (roadmap #1 step 3), not in this deterministic version.

## Quirks

- Deterministic given fixed input: same vault state ⇒ same graph (only `project.analyzedAt` varies by run).
- Enumeration is bounded (5000 files / depth 12); a `*-enumeration-truncated` warning means the vault exceeded a bound.
- `layers[]` currently come from `index.md` sections. Louvain community detection (roadmap #4, folded into #1) will enrich them later.
