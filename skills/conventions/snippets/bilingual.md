## Bilingual convention (FR + EN, FR primary)

The user works in both French and English. Every substantive page in this vault MUST be bilingual, with **French first, English second**. This matches the router project DNA (README, skill triggers, slash command descriptions are all FR + EN).

### Page layout

```markdown
---
frontmatter (include `language: [fr, en]` and `tags: [..., bilingual]`)
---

# Title (kept in the language most natural — usually French for native FR concepts, English for technical proper nouns like "graphify")

> *🇫🇷 Version française ci-dessous · [🇬🇧 English version below](#-english-version)*

---

## 🇫🇷 Version française

[Full French content — every section]

---

## 🇬🇧 English version

[Full English content — every section, mirroring the French structure]
```

### Rules

- **Both sections complete** — no "see git history" shortcuts, no "FR only" cheats. The reader of one section should never need to scroll to the other to get the full picture.
- **Section heading levels match** between FR and EN. If the FR has `### Architecture`, the EN has `### Architecture` (or its English equivalent). Don't shift levels between languages.
- **Technical identifiers stay verbatim** in both versions: `nx.compose`, NetworkX, tree-sitter, `_score_nodes`, file paths, code blocks, JSON schemas. Don't translate them.
- **Quoted prose** (from external sources) stays in the original language; add a brief translated gloss inline if needed.
- **Wikilinks** are language-neutral (page titles are usually English/technical); they work identically from both sections.
- **Internal anchors**: `#-version-française` and `#-english-version` headers use the leading-emoji `## 🇫🇷` / `## 🇬🇧` convention. Obsidian/markdown anchor-slugging produces `#-version-française` and `#-english-version` respectively.

### Short pages (under ~500 words)

For very short pages (entity stubs, single-fact captures), FR + EN can be inlined as parallel bullet lists or short paragraphs instead of two full sections. Use the two-section layout once content grows past one screen.

### Navigation files (`index.md`, `hot.md`, `log.md`, `overview.md`)

These don't need full two-section layout. Instead:
- Frontmatter and structural section headers stay in English for stability.
- Each entry's description line is bilingual: `FR description · EN description` or two short lines.
- `log.md` entries use a bilingual summary: title in English (stable), one-line FR + EN body.

### When the user writes only in one language

Default to following the user's language for the current turn, but always file new wiki pages bilingually. If the conversation was 100 % English, the FR section is still written (faithful translation). If 100 % French, the EN section is still written.
