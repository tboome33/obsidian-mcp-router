---
type: index
title: "Wiki Catalog"
description: "The map of maps: one entry per area of the wiki, each pointing at that directory's generated index, plus the pages worth reading first."
---

# Wiki Catalog

> **This is a map of maps, not a list of pages.** One entry per *area* (directory) of `wiki/`, each linking to that directory's **generated `index.md`** — which is exhaustive and updates itself. Alongside it, the few pages worth opening first: the curated part no generator can produce.
>
> **Do NOT add a row per page.** That is what turns a catalog into an unreadable monolith — one vault reached 70 KB / 115 rows before this convention, too large to read in a single tool call. A new page in an existing directory needs **no edit here at all**: the generated index picks it up on the next refresh. Only a **new directory** earns a new entry below.
>
> ⚠️ **Link the indexes with markdown links, never wikilinks.** Obsidian resolves wikilinks by *basename*, and every directory index is named `index.md` — a wikilink would be ambiguous across all of them and get retargeted silently. Use `[Area](../wiki/<dir>/index.md)`. Links to **pages** stay wikilinks: those survive moves.

## Wiki Core

*The vault's private scaffolds. No generated index covers them — `wiki-meta/` stays outside the OKF bundle.*

- [[overview]] — what this wiki covers
- [[hot]] — recent-context cache, rewritten (not appended) each session
- [[journal]] — thin session index, one line per milestone
- [[CLAUDE]] — navigation rules and vault conventions

---

<!--
  One block per area, added when a NEW directory appears under wiki/.
  Copy this shape:

## <emoji> <dir>/ — <what lives here, in a few words>

*<One italic line: what this area is for.>*

📍 **Generated index**: [<dir>](../wiki/<dir>/index.md) (<N> pages)

**Read first:**
- [[<page>]] — why this one before the others
-->

## How to read this wiki

1. **[[hot]]** first — the current state, loaded automatically at session start.
2. **This page** — locate the area.
3. **That area's generated index** — the exhaustive list, one description per page.
4. **The page itself** — and only that one. Progressive disclosure: never load the whole wiki.

For a precise question rather than exploration, use `wiki-query`, which walks this same path automatically.
