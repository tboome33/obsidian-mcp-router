---
name: wiki-export
description: Export a vault's wiki either as a single portable file (llms.txt or llms-full.txt per the llmstxt.org standard) or as an OKF knowledge bundle (Google's Open Knowledge Format v0.1 — a shareable directory of markdown files any AI agent can consume). Use when the user says "export my wiki", "make an llms.txt", "share my wiki", "export as OKF", "make an OKF bundle", "publish my wiki as a bundle", "backup the wiki to a single file", "/wiki-export", or asks for a portable dump of their knowledge base.
---

# wiki-export

Build a portable export of a vault's wiki — a single [llmstxt.org](https://llmstxt.org) file, or a multi-file [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) (OKF v0.1) bundle. The export is read-only on the wiki — it never mutates content pages (OKF output lands under `wiki-meta/exports/`).

## Three output modes

| Target | Output | Content | Typical size |
|---|---|---|---|
| `llms` (default) | `llms.txt` | Index format : H1 + blurb + H2 sections + bullet list `[title](path) : description`. **Compact** — links to pages, no bodies. | hundreds of lines |
| `full` | `llms-full.txt` | Same structure as `llms.txt` but **each page body inlined** under its bullet. **Heavy** — full reproduction of the wiki content. | thousands to tens of thousands of lines |
| `okf` | `wiki-meta/exports/okf/<bundle-name>/` (directory) | A conformant **OKF v0.1 knowledge bundle** : one markdown file per page (slugified names, wikilinks → relative markdown links, mapped frontmatter), one `index.md` per folder, a newest-first `log.md`, optional agent README. Ready to `git init` + push and be consumed by any OKF-aware agent. | one file per exported page + indexes |

Other targets listed in the roadmap (json, json-ld, graphml, marp) are **deferred** — not implemented in this skill version.

## Pre-conditions

1. Target vault has `wiki-meta/catalog.md` (the catalog the export structure is derived from). If absent, suggest the `wiki` skill to bootstrap first.
2. Vault is online (call `list_vaults`).

## When to use

- "Export my wiki so I can share it with X" / "make an llms.txt for this vault"
- "I want to consult my wiki from Perplexity / ChatGPT" — feed them the `llms.txt` (compact) or `llms-full.txt` (with full content)
- "Backup the wiki to a single file" — `llms-full.txt` mode
- "Publish my wiki for AI search visibility" — `llms.txt` at the root of a static site
- "Export this folder as an OKF bundle" / "share my wiki as a knowledge bundle other agents can mount" — `okf` target. This is the format for **agent-to-agent knowledge sharing** (the Cole Medin bundle pattern) : the recipient pastes one prompt and their agent consumes the bundle directly.

## When NOT to use

- The user wants a single page exported → use `get_file` directly.
- The user wants a graph visualisation → not in scope (deferred targets).
- The user wants to migrate the wiki to another tool → this is an export, not a migration. Suggest a manual copy of `wiki/` instead.

## Steps

### 1. Resolve target + paths

Default target: `llms` (compact). Accept `--target llms` or `--target full` from the user.

Output path (default): `wiki-meta/exports/<vault-slug>-<target>.<ISO-date>.txt` inside the target vault. The user can also ask for stdout (return the string in the chat) for piping into another tool.

If the user asks for one of the deferred targets (`json`, `json-ld`, `graphml`, `marp`), tell them it's not implemented yet and point at the roadmap.

### 2. Load index + pages

```
indexMd = mcp__obsidian-router__get_file({ vault, path: "wiki-meta/catalog.md" })
```

Then list all files under `wiki/` (and `wiki-meta/` for overview-style files), filtering to `.md` only:

```
files = mcp__obsidian-router__list_files({ vault, directory: "wiki" }) // recurse
```

For each file path, fetch its content:

```
pages = [
  { path, content: get_file({vault, path}) }
  for path in files
]
```

Use `Promise.allSettled` style parallel fetches if the router supports it (it does — concurrent `get_file` is safe).

### 3. Call the exporter

```javascript
import { buildLlmsTxt } from 'src/helpers/llms-txt-exporter.mjs';

const output = buildLlmsTxt({
  vaultName,       // string — vault display name
  indexMd,         // string — content of wiki-meta/catalog.md
  pages,           // [{ path, content }]
  mode: 'index' | 'full',
  summary,         // optional override; otherwise derived from overview.md
});
```

`buildLlmsTxt` is pure (no I/O) and deterministic — same input always produces same output, byte-for-byte. This makes it easy to round-trip test and to diff between exports of the same vault over time.

### 4. Write to disk (or return)

If output path requested:

```
mcp__obsidian-router__write_file({ vault, path: outputPath, content: output })
```

Auto-create the `wiki-meta/exports/` directory if it doesn't exist (write_file handles this).

If stdout requested, return the `output` string directly in the chat reply for the user to copy.

### 5. Append a log entry

Log the export in `wiki-meta/journal.md`:

```
- YYYY-MM-DD HH:MM — wiki-export — <vault> · <target> · <line count> lines · <output path>
```

### 6. Confirm to the user

Compact summary:
- Target (`llms.txt` / `llms-full.txt`)
- Output path (or "returned in chat" if stdout)
- Page counts : N indexed sections, M unindexed pages
- Approximate token count for LLM consumption (chars / 4 is a usable estimate)

## OKF target flow (`--target okf`)

The OKF target exports a **subset** of the wiki as a standalone knowledge bundle. Decision on record (2026-07-03, vault page `okf-interop`) : OKF is our **exchange format at the edges** — the vault's internal structure never changes ; everything the standard requires is regenerated on the way out.

### O1. Scope the subset

Ask the user (or infer from their request) which pages to export : a folder (`wiki/Divers/`), a tag filter, or the whole `wiki/` tree. `wiki-meta/` is ALWAYS excluded — hot cache, digests, session journals are private working data and must never leave the vault.

### O2. Gather pages + options

Fetch the selected pages (`list_files` + parallel `get_file`, same as step 2). Options :
- `bundleName` — output folder name, default : slugified vault name
- `--readme-agent` — also emit a self-installing README (agent onboarding prompt, the Cole Medin pattern). Recommended when the bundle will be shared publicly.
- `summary` — one-sentence bundle blurb ; derive from `wiki-meta/overview.md` when absent.

### O3. Build the bundle

```javascript
import { buildOkfBundle } from 'src/helpers/okf-bundle-exporter.mjs';

const { files, report } = buildOkfBundle({
  vaultName,               // bundle title
  pages,                   // [{ path, content }] — the scoped subset
  now: new Date().toISOString(),  // injected clock (helper is pure)
  summary,                 // optional blurb
  includeAgentReadme: true // when --readme-agent
});
```

`buildOkfBundle` is pure and deterministic. It returns every file of the bundle (`files: [{ path, content }]`) plus a `report` you MUST surface to the user : `renamed` (reserved-name and slug collisions), `dangling` (links to pages outside the export — legal per the spec, but the user should know), `anchorsDropped` (heading/block anchors have no OKF equivalent), `embeds` (demoted to plain links ; assets are not exported), `warnings` (pages missing `type`).

### O4. Self-check conformance

```javascript
import { checkOkfConformance } from 'src/helpers/okf-conformance-checker.mjs';
const check = checkOkfConformance(files);
```

`check.conformant` must be `true` (zero errors) before writing anything. Surface warnings/info counts in the final summary. If errors appear, that's a bug in the export — report it, don't ship a broken bundle.

### O5. Write the bundle into the vault

Write each file under `wiki-meta/exports/okf/<bundleName>/` via `write_file`. Tell the user the bundle directory is self-contained : they can copy it anywhere, `git init && git push` it, or hand the folder to any OKF-aware agent.

### O6. Log + confirm

Append the standard log entry (step 5) with target `okf` + document count. Final summary : bundle path, document count, index count, the report's dangling/renamed/anchor counts, and the conformance verdict.

### OKF anti-patterns

- Don't export `wiki-meta/` content — ever. Private working data.
- Don't copy the vault's `wiki-meta/catalog.md` or `wiki-meta/journal.md` into the bundle — the bundle's `index.md`/`log.md` are REGENERATED in OKF shape (no frontmatter except root `okf_version`, `# Section` headings, `* [Title](file.md) - desc` bullets, newest-first log). The vault scaffolds use a different grammar and would not conform.
- Don't map `source_type` onto `type` (or vice-versa) — orthogonal dimensions : `type` says what the page IS, `source_type` says where its content came from. Both travel side by side (`source_type` is a legal OKF extension key).
- Don't "fix" dangling links by dropping them — a link to a not-exported page is legal OKF ("not-yet-written knowledge", §5.3) and preserves the knowledge graph's shape.

## What the helpers handle automatically

The pure function `buildOkfBundle` in `src/helpers/okf-bundle-exporter.mjs` (OKF target) handles : filename slugification to Google's reference-implementation charset (no spaces/accents) with link remapping, `[[wikilink]]`/`![[embed]]` → relative markdown-link conversion, frontmatter mapping (`url`→`resource`, newest date → `timestamp`, `description` synthesized from the first paragraph when missing, extras preserved), per-directory `index.md` generation grouped by `type`, root `okf_version` declaration, newest-first `log.md`, reserved-name collision renames.

The pure function `buildLlmsTxt` in `src/helpers/llms-txt-exporter.mjs` does all the heavy lifting :

- **Frontmatter stripping** — removes `---\n...\n---\n` blocks from inlined page bodies (full mode)
- **`[[wikilinks]]` normalisation** — converts to `[label](path.md)` form so external LLMs that don't know Obsidian syntax can still navigate
- **H1 stripping** — when inlining bodies, removes the page's own H1 since the bullet link already provides the title
- **Section ordering** — preserves the order of H2 sections in `catalog.md`
- **Unindexed bucket** — pages on disk but missing from `catalog.md` go to a final `## Unindexed` section (sorted alphabetically)
- **Wiki-meta filtering** — `hot.md`, `journal.md`, `catalog.md`, `overview.md` excluded from the Unindexed bucket (those are scaffolding, not content)
- **Summary resolution** — explicit `summary` arg > `wiki-meta/overview.md` first paragraph > generic fallback "Knowledge base for <vault>"
- **Whitespace normalisation** — collapses runs of empty lines, single trailing newline

## Anti-patterns

- Don't try to resolve `[[wikilinks]]` to absolute deployed URLs — the helper doesn't know the deployment context. Relative paths are the right default.
- Don't mutate the wiki during export — this is strictly read-only.
- Don't paginate the output across multiple files — the whole point of llms.txt is "single file the LLM can consume in one fetch". If the vault is huge and `llms-full.txt` exceeds the target LLM's context, switch to `llms.txt` (compact) and let the LLM fetch individual pages on demand.
- Don't strip code blocks, math, or callouts from inlined bodies — they're part of the content. Only frontmatter and the page H1 are stripped.
- Don't include the export file itself in subsequent exports (avoid recursion) — `wiki-meta/exports/` is filtered the same way other wiki-meta scaffolds are.

## Quirks

- The output is deterministic only when the input pages list is stable in order. If `list_files` returns files in a different order across runs, the Unindexed section may reorder (it's sorted alphabetically internally, so this is OK).
- `llms-full.txt` for a 100-page vault can easily reach 100k+ tokens — check the consumer LLM's context window before sharing.
- Pages with type `overview` are preferred as the summary source. If no overview page exists, the function falls back to a generic blurb.
