---
name: wiki-ingest
description: Read a source (file, URL, or pasted text), extract the entities and concepts that matter, and file them as wiki pages with cross-references. Updates the wiki's index.md, log.md, and hot.md so future sessions can find what was ingested. Use this skill whenever the user says "ingest this", "add this to the wiki", "process this source", "file this article", "absorb this", "ingest <url>", "/wiki-ingest", or drops a file/URL with the implicit intent to incorporate it into their knowledge base.
---

# wiki-ingest

Take a source (URL, local file path, or pasted text) and do the structured work of: pulling it in, identifying what's worth keeping, writing wiki pages for the new entities/concepts, and updating the relevant cross-references — all idempotently so re-ingesting the same source doesn't duplicate.

## Pre-conditions

1. The target vault has a `wiki/` folder with `index.md`, `log.md`, `hot.md`. If not, run the `wiki` skill first.
2. The vault is online (call `list_vaults`).
3. You have one of: a URL, a file path on disk, or text the user pasted.

## When to use

- "ingest this URL" / "absorb this article"
- The user pastes a long block of text and says "file this"
- Batch mode: "ingest all of these" with multiple sources → fan out via the `wiki-ingest` sub-agent (in `agents/wiki-ingest.md`).

## When NOT to use

- The user wants a quick answer without filing → just answer, don't ingest.
- The source is already filed (check `wiki-meta/index.md` for the title or URL) → tell them; offer to refresh instead.
- The "source" is the current conversation → use the `save` skill instead.

## Steps

### 1. Acquire the source content

- **URL**: use the `defuddle` skill (v0.13.2+) — it returns `{markdown, metadata}` with deterministic title/author/published/image/site/lang/description/wordCount/readingMinutes from Schema.org/OG/meta tags. If you bypass defuddle for some reason (e.g. URL is already clean markdown), call `mcp__obsidian-router__extract_page_metadata({url})` directly to get the metadata block — it's the input to step 4's deterministic frontmatter.
- **Local file**: prefer `mcp__obsidian-router__get_file` if the file is inside a vault; else `Read`. No metadata block in this case — fall back to inference.
- **Pasted text**: use what the user gave you. No metadata block — fall back to inference.

If acquisition fails, surface the error and stop. Don't ingest a partial source.

### 2. Extract structure (do this before writing anything)

Identify:

1. **Source metadata**: title, author(s) if known, publication date, URL or path, source type (article, paper, video transcript, code repo, book chapter, conversation, etc.).
2. **Top-level entities** the source is fundamentally ABOUT (e.g., a person, a concept, a project, a place). Usually 1-5.
3. **Supporting concepts** that show up but aren't the main focus (e.g., a method, a tool, a related work). Usually 3-10.
4. **Claims worth recording** — assertions the source makes that someone querying the wiki would later want to look up.

Don't extract everything. The wiki gets cluttered when ingestion is too eager. If a concept is only mentioned in passing, skip it.

### 3. Page plan (decide before writing)

For each entity/concept:

- Does a wiki page already exist for it? Read `wiki-meta/index.md` to check.
  - **Exists** → you'll APPEND a section to that page, not create a new one.
  - **Doesn't exist** → you'll CREATE a new page.
- What folder should it live in? Match the wiki's existing organization (read `wiki-meta/index.md` structure). If unclear, default folders: `concepts/`, `entities/`, `sources/`, `projects/`.

Output a 1-paragraph plan to the user before writing files. They can correct misclassifications cheaply now.

### 4. File the source itself

Create `wiki/sources/<slugified-title>.md` with frontmatter. **For URL sources (v0.13.2+, Phase B obsidian-clipper port)**, the frontmatter is assembled DETERMINISTICALLY from the metadata block returned by `defuddle` (step 1) or `extract_page_metadata` — Claude does NOT infer these fields:

```yaml
---
type: source
title: "<metadata.title or <title> tag>"
url: <canonical URL>
ingested_at: <ISO timestamp now>
authors: [<metadata.author>]    # may be array if multiple; otherwise single string
published: <metadata.published>  # ISO YYYY-MM-DD if available, else absent
lang: <metadata.lang>            # e.g. "en", "fr-FR" — if detected
image: <metadata.image>          # cover image URL if available, else absent
site: <metadata.site>            # publisher / site name if available, else absent
description: <metadata.description>  # 1-line summary from og:description / meta
word_count: <metadata.wordCount>     # int
reading_minutes: <metadata.readingMinutes>  # int (ceil(wordCount/220))
has_latex: <metadata.hasLatex>       # bool, Phase D (v0.13.10+) — only emit when true; omit when false to keep frontmatter tight
assets_count: <N>                    # int, Phase E (v0.14.x+) — only emit when --save-assets was used AND at least 1 asset was saved; omit otherwise
related_source: "[[<parent-slug>]]"  # ONLY if this ingestion is a child of a link-following parent (Phase C, v0.13.3+). Omit otherwise.
tags: [<source-type>, <topic-tags>]
source_type: extracted    # see "Source provenance" in vault CLAUDE.md
---
```

**Anti-pattern**: do NOT fabricate or re-infer `title` / `author` / `published` / `lang` / `image` / `site` / `description` when the metadata block returned a non-null value. The whole point of the v0.13.2 pipeline is to make these deterministic. Use `slug(title, {maxLen:80})` from `src/helpers/filters/slug.mjs` to generate the filename — never improvise.

**Asset preservation (Phase E, v0.14.x+)**: opt-in via `--save-assets` flag (NOT default — costs bandwidth + disk). When the user passes the flag for a URL source:

1. **Resolve the vault's absolute path FIRST** via `mcp__obsidian-router__list_vaults`. Pick the entry whose `name` matches the target vault and read its `path` field (e.g. `C:\\VAULTS\\my-vault` or `/Users/me/Obsidian/my-vault`). Concatenate that with `/wiki/.assets/<source-slug>/` to get the absolute `outputDir`. **Do NOT** concatenate the workspace cwd with `wiki/...` — in workspace-bound mode (code repo associated with a separate vault), cwd ≠ vault root and that produces a non-existent path. This is the path-disambiguation trap codified in the global CLAUDE.md.
2. Then call `mcp__obsidian-router__download_page_assets({url, outputDir})`. The tool downloads `<img>` / `<source srcset>` / `![](url)` references SSRF-safely, skips icons under 1 KB and oversized files over 10 MiB, and caps at 200 image URLs per page (configurable via `maxAssets`).
3. The response is a manifest `{extracted, attempted, downloaded[], skipped[], errors[], urlMap}`. Use `urlMap` (an object `{ remoteUrl: savedFilename }`) to rewrite the markdown body — find each `![alt](remoteUrl)` and `<img src="remoteUrl">` reference and replace the URL with the local path `.assets/<source-slug>/<savedFilename>` (relative to vault root).
4. Set `assets_count: <downloaded.length>` in the source-page frontmatter. Omit the field if zero assets were saved (consistency with the "emit only meaningful values" convention used for `has_latex`).
5. If the manifest has non-empty `errors` (typically a few CDN images that 404'd or got blocked by a referrer check), mention this in the `## Summary` section as "N referenced images failed to mirror". Don't fail the ingestion — partial preservation is the point.
6. **Default is `--save-assets=false`** — don't save assets when the user hasn't explicitly asked. The markdown will keep remote `![](url)` references, which Obsidian renders inline when the user has internet access (fine for most reading flows). Saving assets is for archival use cases (offline reading, source preservation, link-rot insurance).

**Highlights persistence (Phase F, v0.14.4+)**: opt-in. When the user provides highlights — typically by pasting a structured list like `text="..." color=yellow note="..."` or supplying a JSON array — preserve them in dual format so they survive both as human-readable Obsidian callouts AND machine-readable frontmatter for future round-trip / re-hydration.

1. **Normalize the input** via the helper `src/helpers/highlights-format.mjs::normalizeHighlight`. Each highlight needs `text` (mandatory); `color` defaults to `yellow`; `id` is generated from `sha256(text|xpath)` if missing (so re-ingesting the same page is idempotent — same content → same id). Other fields (`note`, `xpath`, `offset_start`, `offset_end`) are optional.
2. **Call `serializeHighlights(normalized)`** — returns `{normalized, calloutBlocks, frontmatterYaml}`.
3. **Insert a `## Highlights` H2 section** in the body, just before `## Sources`, with the `calloutBlocks` content. Each callout looks like `> [!highlight] color=<color>` followed by the quoted text and `> ^<id>` block anchor (so other notes can link to it via `[[<page>#^<id>]]`).
4. **Add `highlights:` to the frontmatter** with the array `frontmatterYaml` produces — schema-compatible with obsidian-clipper for future ingestion round-trip.
5. **Idempotence rule**: if the source page already has a `## Highlights` section AND a `highlights:` frontmatter array, treat the frontmatter as the source of truth. Use `parseHighlights(frontmatter.highlights)` to load existing entries, merge with new ones by `id` (dedupe via id), then re-serialize fully. Don't append callouts manually — re-render from the merged normalized array. This avoids divergence between the body and the frontmatter when users add highlights across multiple sessions.
6. **Default is highlights-off** — don't fabricate or invent highlights when the user hasn't asked. This is an explicit-input feature, not an auto-extraction one (the browser-extension auto-extraction case is documented in [[obsidian-clipper]] section "Extension navigateur router-aware" as 🔮 deferred).

**LaTeX preservation (Phase D, v0.13.10+)**: when `metadata.hasLatex === true`:
1. Emit `has_latex: true` in frontmatter (so Obsidian's LaTeX plugin / KaTeX MathBlock renders it).
2. In the body, **preserve all `$...$` and `$$...$$` blocks verbatim** — never reformat `$x^2$` as `x²`, never strip `$$\sum_n a_n$$`, never paraphrase a formula into prose.
3. **MathML auto-conversion (v0.14.6, Phase D.2)** — when the page has `<math>...</math>` blocks (typical Wikipedia rendering), `webpage_to_markdown` automatically converts each block to dollar-delimited LaTeX BEFORE markitdown sees it. This means: Wikipedia equations now SURVIVE in the markdown body as inline `$LaTeX$` or block `$$LaTeX$$` strings — you don't need to mention "the original page contains rendered equations" anymore; the equations are there, just preserve them verbatim like any other math.
4. The `latexSignals` block from `extract_page_metadata` tells you WHICH kind of math is present (MathML count, KaTeX/MathJax flags, dollar-delimiter counts) so you can decide whether `has_latex: true` is well-founded or a false positive from a currency-heavy page that tripped the heuristic.
5. **Audit field `mathmlLatex` (v0.14.6+)** — if you need to verify or surface the equations that were extracted from MathML, `extract_page_metadata` returns a `mathmlLatex: [{latex, display}]` array listing each converted equation. Useful when the page has many equations and you want to spot-check that the conversion produced sensible LaTeX. Not required for routine ingestion — the equations are already inlined in the markdown body via the auto-conversion above.

**Fallback**: if the source is a local file or pasted text (no metadata block), infer title and structural fields from the content as before. The `published` / `lang` / `image` / `site` fields are omitted from the frontmatter when no signal exists (do NOT emit `null` or empty string — just leave the line out).

The source page itself is `extracted` — the body is a faithful summary/quote of an external document. For entity/concept pages spawned from this source (step 5), the provenance varies — use `inferred` when Claude derived the page from cues in the source, `claude_synthesized` when the page is pure synthesis with no direct textual basis. When in doubt, prefer the more conservative tag (`claude_synthesized` over `inferred`, `inferred` over `extracted`).

Body structure (heading hierarchy is MANDATORY — see vault `CLAUDE.md` section "Note structure"):

- `# <title>` — exactly one H1 at the top (matches the frontmatter title).
- `## Summary` — 1-2 paragraph summary of what the source says.
- `## Key Claims` — 3-7 bulleted claims (each ≤2 lines, factual, citable).
- `## Related` — wikilinks to the entity/concept pages you're about to create or update.

Never produce a flat body without H2 sections — Outline plugin relies on the structure for navigation.

Use `mcp__obsidian-router__write_file` with `ifNew: true`. If a page with this slug already exists, **stop and ask** — never silently overwrite.

### 4.5 Propose linked sources (v0.13.3+, Phase C obsidian-clipper port)

For URL sources, after the source page is filed but BEFORE you start the entity/concept extraction in step 5, scan the page's body for hyperlinks worth proposing for **recursive ingestion**. This is the user-in-the-loop "Ask mode" of link-following ingestion — you don't follow links autonomously, you present candidates and let the user pick.

**Skip this step if**:
- The source is a local file or pasted text (no `<a href>` to scan — no candidates).
- The user explicitly said "don't follow links" / "skip linked sources" / "just ingest this one page".
- This ingestion is ALREADY a child of a parent link-following ingestion (avoid recursive depth — Phase C is Level 1 / depth 1 only).

**Procedure**:

1. **Call the MCP tool** `mcp__obsidian-router__propose_linked_sources({url})` — it returns a JSON payload `{baseUrl, count, candidates: [{href, text, contextSnippet, score, sourceSection, sameDomain}]}`. The candidates are already sorted by score descending and capped at 30. Scoring : `+2` same domain, `+3` in a "Related"/"See also"/"Voir aussi" section, `-5` social/boilerplate hostname.

2. **If `count === 0`**, skip silently (no candidates worth presenting) and move on to step 5.

3. **Present the top 10-15 candidates** to the user, format:
   ```
   La page mentionne <count> liens hypertextes connexes. Veux-tu aussi en ingérer ?
   
   [ ] 1. <text>
            · score <score> · <sourceSection or "body"> · <href>
            · "<contextSnippet>"
   [ ] 2. ...
   
   Réponds avec les numéros à ingérer (ex: "1, 3, 5"), "tous", ou "aucun".
   ```
   Truncate `contextSnippet` to ~60 chars for readability. Highlight `sameDomain: true` and `sourceSection != null` visually (e.g. bold or emoji prefix).

4. **Wait for user response**. Accept :
   - `"1, 3, 5"` / `"1 3 5"` / `"1-3"` → ingest those indices
   - `"tous"` / `"all"` → ingest all candidates shown
   - `"aucun"` / `"none"` / no response / "skip" → skip, continue to step 5
   - Free text reformulation → re-present with the user's filter applied

5. **For each retained candidate**, fan-out via the **`wiki-ingest` sub-agent** (`agents/wiki-ingest.md`) — one sub-agent per URL, parallel execution. Pass through the `parent_source_slug` so each child knows its parent. The sub-agent does the full ingestion of its URL but **MUST NOT** itself trigger step 4.5 again (Level 1 = depth 1; no recursion).

6. **For each child source page created**, add `related_source: [[<parent-source-slug>]]` to its frontmatter. This is the link back to the parent that initiated the recursive ingestion.

7. **Update the parent source page** with a new section `## Linked sources` listing the child wikilinks:
   ```markdown
   ## Linked sources
   
   These sources were ingested in the same session via link-following from this page:
   
   - [[sources/<child1-slug>]] — <child1-title>
   - [[sources/<child2-slug>]] — <child2-title>
   ```
   Use `mcp__obsidian-router__patch_file` with `operation: append`, `targetType: heading`, `target: "Linked sources"` (or `append_to_file` to create the heading if it doesn't exist).

8. **Log a consolidated entry** in `wiki-meta/log.md`: `- YYYY-MM-DD HH:MM — ingest+links — <parent-title> + N linked sources`.

**Anti-patterns** :
- Do NOT auto-follow links without user confirmation. Level 2 ("auto-follow with cap") is explicitly deferred to a future phase — Level 1 is **ask mode only**.
- Do NOT chain `propose_linked_sources` recursively (child's children, grandchildren) — depth limit is 1 in Phase C. If the user wants depth 2+, they can re-trigger the skill on a child page.
- Do NOT skip the `related_source` frontmatter on children — that's the only mechanism that traces the tree of linked ingestions for later navigation.
- Do NOT ingest candidates with `score < 0` without explicit user opt-in (they're in the social/boilerplate blocklist for a reason).

### 5. Create or update entity/concept pages

For each entity/concept identified in step 2:

- **New page**: `mcp__obsidian-router__write_file` with frontmatter `type: entity` (or `concept`), `tags`, **and `source_type`** (`extracted` if the page is a literal quote/citation, `inferred` if derived by reading the source, `claude_synthesized` if pure synthesis — see step 4 note and vault CLAUDE.md "Source provenance" section). For paragraphs of mixed provenance inside the body, use inline callouts `[!extracted]` / `[!inferred]` / `[!claude_synthesized]`. Body MUST follow the heading hierarchy: one `# <title>` H1, then for `concept` use `## Definition` / `## Why it matters` / `## Related` / `## Sources`; for `entity` use `## Context` / `## Notes` / `## Sources`. End the body with a `## Sources` H2 that wikilinks to the source page you just filed.

- **Existing page**: use `mcp__obsidian-router__patch_file` to:
  - Append a bullet under `## Sources` — fully-specified call:
    ```
    patch_file({
      vault, path,
      operation: "append",
      targetType: "heading",
      target: "Sources",
      content: "- [[sources/<slug>]]"
    })
    ```
    If the `## Sources` section doesn't exist yet, fall back to `append_to_file` with the heading + bullet inline.
  - Append a new section `## From <source-title>` containing the new claims/insights — use `append_to_file` (creates or appends), not `patch_file` (which targets an EXISTING heading).
  - Don't rewrite existing content. The wiki is append-only at the section level.

### 6. Update index.md

Use `patch_file` with `operation: append`, `targetType: heading`, `target: "<section-name>"` (e.g., `target: "Sources"` for source pages, `target: "Concepts"` for concept pages) to add rows for any newly created pages. Keep the index alphabetized within each section.

If the section heading doesn't exist in `index.md` yet, fall back to `append_to_file` and write `\n## <section>\n\n- [[<page>]]\n`. The `wiki` skill scaffolds the standard sections, so this fallback is rare.

### 7. Append to log.md

```
- YYYY-MM-DD HH:MM — ingest — <source-title> — created N pages, updated M pages
```

### 8. Refresh hot.md

Replace `## Recent Changes` with the just-ingested source + the entities touched. Keep `hot.md` ≤ 500 words total — drop the oldest entry if needed.

### 9. Confirm to the user

Compact summary:
- Source filed at `wiki/sources/<slug>.md`
- Entities/concepts created: list with wikilinks
- Entities/concepts updated: list with wikilinks
- One-line takeaway from the source

## Anti-patterns

- Don't dump the full source text into the wiki. The wiki is your synthesis, not the archive. (If the user wants the original archived, suggest a `.raw/` folder for that.)
- Don't create pages with no body beyond the title. If you can't write 2 sentences about an entity, skip it — it'll resurface naturally if it matters.
- Don't ingest before step 3 (page plan). Surfacing the plan first saves rework.
- Don't use `Write`/`Edit` natively — always go through the router so this works cross-project.
- Don't fabricate frontmatter dates. If the source has no date, omit the field. (v0.13.2+: the metadata block from `defuddle` / `extract_page_metadata` is the deterministic source of truth — never re-infer fields it already populated.)

## Quirks

- Wikilinks in Obsidian: `[[Page Name]]` or `[[Page Name|alias]]`. The path is relative to the vault root and Obsidian resolves it.
- For ambiguous wikilinks across folders, use the full path: `[[concepts/Bayesian Inference]]`.
- If the source is huge (book chapter, long paper), break it into multiple ingest passes — one entity at a time. Don't try to do everything in one turn.

## Batch mode

If the user gives multiple sources in one go ("ingest all these PDFs"), use the `wiki-ingest` sub-agent in `agents/wiki-ingest.md` to fan out — one agent per source, parallel. The orchestrator (you) waits for all to return, then writes a single consolidated log entry and one hot.md refresh.
