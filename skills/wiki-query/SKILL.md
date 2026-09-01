---
name: wiki-query
description: Answer a question using ONLY the existing wiki vault as the knowledge base — no web search, no general LLM knowledge. Reads hot.md first (cheap recent context), then catalog.md to navigate, then drills into specific pages, then optionally semantic-searches the wiki, and synthesizes an answer with citations. Use when the user asks "what do you know about X", "based on my wiki, ...", "explain X using my notes", "search the wiki for X", "from my notes, ...", "/wiki-query". Do NOT use when the user wants new information from the web — that's `autoresearch`.
---

# wiki-query

Three-tier retrieval: cheap (hot cache) → cheap (index) → expensive (full pages + semantic search). Stop at the first tier that answers the question. Always cite the wiki pages used.

## Pre-conditions

1. Target vault has `wiki/` scaffolding (`hot.md`, `catalog.md` minimum). If not, tell the user the wiki isn't set up; offer the `wiki` skill.
2. Vault is online (`list_vaults`).

## Modes

The user may signal a preferred mode:

- **quick** — answer from hot.md alone if possible. Bail to standard if hot doesn't cover it.
- **standard** (default) — hot → index → 1-3 specific pages → synthesize.
- **deep** — hot → index → semantic search across the wiki → 5-10 pages → synthesize → file the answer back as a new wiki page.

If the user didn't say, infer: short factual question = quick; "explain X" = standard; "give me everything you know about X (from my wiki)" = deep.

**Disambiguation note**: "research X" is ambiguous — it could mean either (a) "tell me what my wiki has about X" (deep wiki-query) or (b) "go find new information about X on the web" (autoresearch). When the user says "research X" alone, ASK which they mean. Don't guess.

## Steps

### Tier 1: hot.md

```
mcp__obsidian-router__get_file({ vault, path: "wiki-meta/hot.md" })
```

Read it. If the cache contains the answer (the question is covered by the recent activity), answer from hot alone. Cite `wiki-meta/hot.md` as source. Stop.

If hot doesn't cover it: don't try to extract anything tangential. Move to tier 2.

### Tier 2: catalog.md — IDF-weighted candidate ranking

```
mcp__obsidian-router__get_file({ vault, path: "wiki-meta/catalog.md" })
```

Score and rank index entries against the question using the algorithm below (the same one the router's `src/helpers/idf-score.mjs` module exposes for tools that need to score programmatically — keep the algorithm in sync so machine and skill agree).

**Step 2a — Tokenise the query.** Lowercase, split on non-letter/non-digit runs, drop tokens with length ≤2. Example: *"What does my wiki say about position sizing?"* → `[what, does, wiki, say, about, position, sizing]`. (Don't drop `wiki` / `does` etc. manually — IDF will down-weight them automatically.)

**Step 2b — Score each candidate page from the index.** For each query token, evaluate the page's title (and optionally its source folder, with ×0.5 weight):

- **Exact match** (token equals title, case-insensitive) → contribute **1000 × IDF(token)**
- **Prefix match** (title starts with token) → contribute **100 × IDF(token)**
- **Substring match** (title contains token) → contribute **1 × IDF(token)**
- No match → 0

For IDF: estimate `idf(token) ≈ log(1 + N / (1 + df(token)))` where N is the total number of index entries and df(token) is how many of those entries contain the token. You don't need to compute it precisely — the relative ordering matters far more than the absolute values. Tokens that look common across the index ("notes", "wiki", "page", common project names) get low weight; tokens that look rare get high weight.

**Step 2c — Pick seeds (dynamic count).** Sort candidates by score descending.

- If the top score is **more than 5× the runner-up**, drill into ONLY the top page. A dominant match is unambiguous; pulling in weak runner-ups dilutes the answer.
- Otherwise, drill into the top **3** candidates (or fewer if there aren't 3 with non-zero scores).

If all scores are 0 → nothing in the index matched; skip to tier 4 (semantic search).

Why all this rigor: the previous heuristic ("scan for matching titles, pick 1-3") had two failure modes — (a) it gave equal weight to common and rare query terms, so a question about "user kelly criterion" ranked "user notes" alongside "kelly criterion" instead of putting Kelly first; (b) it always pulled 3 candidates even when one was clearly dominant, producing incoherent multi-page synthesis. IDF + dominant-match cutoff fix both.

### Tier 3: drill into pages

For each candidate page from tier 2:

```
mcp__obsidian-router__get_file({ vault, path: "wiki/<folder>/<page>.md" })
```

Read in parallel (one tool call per page, all in the same turn).

If the answers are sufficient: synthesize, cite each page used as `[[<page>]]`, return.

If still insufficient → tier 4.

### Tier 4 (deep mode only): semantic search

```
mcp__obsidian-router__search_smart({ vault, query: "<question>", limit: 8 })
```

**Read `tier` in the response BEFORE reading the scores.** The default is `tier: "auto"`, and when the semantic tier cannot serve this vault the tool *silently and deliberately* answers from the local BM25 index instead — `tier: "local-bm25"`, `scoreScale: "bm25"`, plus a `fallback` block saying so. BM25 scores are **not** cosine scores and are not on the same scale, so:

- `tier: "semantic"` → the 0.55 cut below applies, and a `freshness` block accompanies the hits **when there are hits and the vault's disk is on this machine** (a remote vault answers `checkable: false`; an empty result set carries none, because there is nothing to assess).
- `tier: "local-bm25"` → **do not apply 0.55**; rank by relative order within the response, and expect no `freshness` block (the local tier carries its own `index.freshness`, which means something else). If the index is missing, the tool refuses with a message naming `build_search_index` — that refusal is the actionable answer, not an error to work around.

For each result above score 0.55 (semantic tier only) that you haven't already read, fetch the page and incorporate. If the tool *throws* rather than falling back — an auth failure, a timeout, an unreachable vault — that is a real failure: report it, and use `mcp__obsidian-router__search` (keyword) if you still need coverage.

**The semantic tier is an AUGMENTATION, and this is a rule, not a preference.** Tiers 1-3 (hot → catalog → drill) are *navigation*: they answer from the vault's own map, and they are authoritative. Tier 4 answers by similarity of meaning, which is genuinely useful on notes and genuinely fallible. Two consequences you must honour:

- **Never let a semantic chunk be the sole support for a factual claim.** Fetch the page it names and read it. A cosine score is a reason to *look*, not evidence of what a page says. If you cannot open the page, say the claim is unverified rather than citing the chunk.
- **Read the `freshness` block the response carries** (v0.83.0+). Smart Connections embeds a note on its own schedule, so a hit whose page reads `changed` or `touched` reflects the *index*, not the page as it is now — open it before quoting it. `page-missing` means the page is gone entirely: do not cite it. A `checkable: false` block means the check could not run (typically a vault whose disk this machine does not have) — that is **not** evidence the results are current.

**Cite at the section, not just the page.** A semantic hit carries `breadcrumbs` — the heading path of the chunk inside its page. Use it: *"per [[page]] § Seuils"* is checkable in seconds; *"per [[page]]"* on a 400-line page is not. Keep the page-level citation format below, and add the section whenever the claim came from a chunk.

The clickable URL is **not on the hit**: `search_smart` returns one `clickToOpenLinks` map at the TOP LEVEL of the response, keyed by path (`clickToOpenLinks["wiki/a.md"]`). Look the path up there. A hit with no `path` at all (some bridge payloads carry text only) cannot be opened or verified — say so rather than citing it.

### Step 5: synthesize (with confidence-aware citations)

Compose the answer:

- Lead with the directly-asked thing in 1-3 sentences.
- Then 1-3 short paragraphs of supporting detail, citing wiki pages inline as `[[PageName]]`.
- **Annotate each citation with the source page's `source_type`** (read it from the frontmatter when you drilled in). Format: `[[PageName]] (extracted)` / `[[PageName]] (inferred)` / `[[PageName]] (synthesized)`. If the page's body has inline provenance callouts (`[!extracted]` etc.) and the paragraph you're citing carries one, use that finer-grained value instead of the page-level frontmatter. If a page has no `source_type` at all (pre-v0.8.8 pages), annotate as `(unmarked)`.
- End with a `_Sources_` line listing the pages used WITH their provenance, so the reader can see at a glance how grounded the answer is.

Example output line:
> Per [[graphify-deep-dive]] (extracted), graphify's confidence taxonomy is `{EXTRACTED, INFERRED, AMBIGUOUS}` — but per [[2026-05-18-graphify-roadmap]] (synthesized), our adaptation skips the `confidence_score` field for now.

The reader instantly knows: the taxonomy claim is grounded in a faithful summary of graphify's source code; the skip-decision is Claude's synthesis. Different trust levels.

If the wiki didn't have enough to answer:
- Say so explicitly. "The wiki has X, Y but not Z."
- Offer to ingest a source that would fill the gap.
- Don't fall back to general LLM knowledge silently — that defeats the wiki's purpose.

### Step 6 (deep mode only): file the answer back

If the user is in deep mode AND the synthesized answer is non-trivial:

1. Write a new page at `wiki/answers/<slugified-question>.md` (or `wiki/<topic>/<slug>.md` if there's an obvious topical home), with frontmatter:
   ```yaml
   ---
   type: answer
   question: "<original question>"
   answered_at: <ISO>
   sources: [<wikilinks>]
   ---
   ```
2. Body: the synthesized answer.
3. Append to `wiki-meta/catalog.md` and `wiki-meta/journal.md`.
4. Tell the user: "Filed this answer at `wiki/answers/<slug>.md` — future queries on this topic will hit it first."

## Anti-patterns

- Don't read all 4 tiers when tier 1 or 2 sufficed. The whole point is cheap-first.
- Don't pretend the wiki has more than it does. Always cite, and admit gaps.
- Don't use semantic search before checking the index — the index is faster and the user probably named pages on purpose.
- **Don't answer out of semantic chunks alone.** If tiers 1-3 produced nothing and only tier 4 has content, say the answer rests on similarity with no navigational anchor, and open the pages before claiming anything about them. (`get_wiki_context_pack` raises `answer-relies-on-semantic-only` for exactly this shape.)
- **Don't cite a chunk whose page reads `changed`, `touched` or `page-missing` without opening the page.** The chunk describes the index; the page is the fact.
- Don't fall back to general knowledge silently. If the wiki lacks coverage, say so and offer to ingest.
- Don't file every answer back. Only do tier-6 in deep mode and only when the answer adds knowledge to the wiki (not when it's a trivial lookup).

## Output format

For a standard query:

> **Short answer** (1-3 sentences).
>
> **Detail.** Paragraph(s) with `[[wikilinks]]` to the pages used.
>
> _Sources: [[Page A]] (extracted), [[Page B]] § Seuils (inferred)_

**Cite as precisely as you actually looked.** The `_Sources_` line carries, for each
page: its provenance (`source_type`), and — when the claim came from a semantic
chunk rather than from reading the whole page — the **section** that chunk's
`breadcrumbs` named. `[[page]] § Seuils` is checkable in seconds; `[[page]]` on a
400-line note sends the reader hunting.

**When there are no `breadcrumbs`, cite the page.** Not every bridge payload carries
them, and inventing a section would be worse than omitting one. The rule is "as
precisely as you looked", not "always a section": if you opened the page and read it
whole, the page IS the right citation, and adding a section you did not use would be
precision theatre.

For a deep query that filed back:

> **Short answer.** ...
>
> **Detail.** ...
>
> _Sources: [[Page A]] (extracted), [[Page B]] § Formule (synthesized)_  
> _Filed answer at `wiki/answers/<slug>.md`._
