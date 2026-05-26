---
name: wiki-export
description: Aggregate a vault's wiki into a single portable file (llms.txt or llms-full.txt per the llmstxt.org standard) for sharing with collaborators or feeding to external LLMs (Perplexity, ChatGPT, Gemini) for grounded Q&A without crawling the vault page-by-page. Use when the user says "export my wiki", "make an llms.txt", "share my wiki", "backup the wiki to a single file", "/wiki-export", or asks for a portable single-file dump of their knowledge base.
---

# wiki-export

Build a single-file portable export of a vault's wiki using the [llmstxt.org](https://llmstxt.org) standard. The export is read-only — never mutates the wiki.

## Two output modes

| Target | Filename | Content | Typical size |
|---|---|---|---|
| `llms` (default) | `llms.txt` | Index format : H1 + blurb + H2 sections + bullet list `[title](path) : description`. **Compact** — links to pages, no bodies. | hundreds of lines |
| `full` | `llms-full.txt` | Same structure as `llms.txt` but **each page body inlined** under its bullet. **Heavy** — full reproduction of the wiki content. | thousands to tens of thousands of lines |

Other targets listed in the roadmap (json, json-ld, graphml, marp) are **deferred** — not implemented in this skill version.

## Pre-conditions

1. Target vault has `wiki-meta/index.md` (the catalog the export structure is derived from). If absent, suggest the `wiki` skill to bootstrap first.
2. Vault is online (call `list_vaults`).

## When to use

- "Export my wiki so I can share it with X" / "make an llms.txt for this vault"
- "I want to consult my wiki from Perplexity / ChatGPT" — feed them the `llms.txt` (compact) or `llms-full.txt` (with full content)
- "Backup the wiki to a single file" — `llms-full.txt` mode
- "Publish my wiki for AI search visibility" — `llms.txt` at the root of a static site

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
indexMd = mcp__obsidian-router__get_file({ vault, path: "wiki-meta/index.md" })
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
  indexMd,         // string — content of wiki-meta/index.md
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

Log the export in `wiki-meta/log.md`:

```
- YYYY-MM-DD HH:MM — wiki-export — <vault> · <target> · <line count> lines · <output path>
```

### 6. Confirm to the user

Compact summary:
- Target (`llms.txt` / `llms-full.txt`)
- Output path (or "returned in chat" if stdout)
- Page counts : N indexed sections, M unindexed pages
- Approximate token count for LLM consumption (chars / 4 is a usable estimate)

## What the helper handles automatically

The pure function `buildLlmsTxt` in `src/helpers/llms-txt-exporter.mjs` does all the heavy lifting :

- **Frontmatter stripping** — removes `---\n...\n---\n` blocks from inlined page bodies (full mode)
- **`[[wikilinks]]` normalisation** — converts to `[label](path.md)` form so external LLMs that don't know Obsidian syntax can still navigate
- **H1 stripping** — when inlining bodies, removes the page's own H1 since the bullet link already provides the title
- **Section ordering** — preserves the order of H2 sections in `index.md`
- **Unindexed bucket** — pages on disk but missing from `index.md` go to a final `## Unindexed` section (sorted alphabetically)
- **Wiki-meta filtering** — `hot.md`, `log.md`, `index.md`, `overview.md` excluded from the Unindexed bucket (those are scaffolding, not content)
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
