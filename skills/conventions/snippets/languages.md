## Languages convention (declared per vault)

**Languages of this vault: <languages>**

The line above is this vault's own value: an ordered list of ISO 639-1 codes (`fr`, `en`, `es`, …), written when the convention was installed. It is the ONE line of this section that differs from one vault to another, on purpose — never "correct" it to match another vault, and never replace it with the library's placeholder. The first code is the vault's **primary language**.

Without this convention nothing says which language a page is written in, and the language of the conversation decides by accident. This convention replaces the retired `bilingual` convention, which could only say "French then English" or nothing at all.

### One language — every page in that language

- Write every page — title, headings, body, `description:` sentence, navigation entries — in that language, **whatever the language of the conversation**. A question asked in English in a vault declared `fr` still produces French pages.
- **Quoted prose** from an outside source keeps its original language; add a short gloss in the vault's language when it helps.
- **Technical identifiers stay verbatim**: paths, code, tool names, JSON keys, commands, proper nouns.

### Several languages — one section per language, in the list's order

Every substantive page holds one complete section per language, in the order of the list. For `fr, en`:

```markdown
---
frontmatter (include `language: [fr, en]`)
---

# Title (in the primary language)

> *🇫🇷 Version française ci-dessous · [🇬🇧 English version below](#-english-version)*

---

## 🇫🇷 Version française

[Full content — every section]

---

## 🇬🇧 English version

[Full content — every section, mirroring the first one]
```

Each language section is a `## H2` that starts with the language's flag, alone or followed by the language's name (`🇫🇷 Version française`, `🇬🇧 English version`, `🇪🇸`, …), or that names the language (`Version française`, `English version`, `Versión en español`, …). Never a bare code (`## FR`) and never a flag in front of a topic: the router does not count those as language sections. It recognises fr, en, es, de, it, pt and nl; for other languages the sections are reported as not checked.

- **Every section complete** — no "see the other section", no "primary language only". A reader of one section never needs to scroll to another.
- **Heading levels match** between sections: if the first has `### Architecture`, every other one has `### Architecture` (or its translation) at the same level.
- **Technical identifiers stay verbatim** in every section. **Wikilinks** are language-neutral and work from every section.
- **Short pages** (under ~500 words — entity stubs, single-fact captures) may inline the languages as parallel bullet lists or short paragraphs instead of full sections. Use the section layout once content grows past one screen.
- **When the conversation uses only one language**, still file every section: a faithful translation, never a summary.

### The primary language

The first language of the list governs what exists only once on a page: the `# H1` title, the `description:` sentence, and the frontmatter values that are prose. Navigation files (`catalog.md`, `hot.md`, `journal.md`, `overview.md`, indexes) use the primary language; in a vault with several languages, each entry's description line may add the others after a separator (`FR description · EN description`). Their frontmatter and structural headings stay stable, never translated back and forth.

### Frontmatter `language:`

Every page carries `language:` — the vault's list, or the part of it the page really contains. A code outside the vault's list is a mistake. When a page is written, the router checks both (a warning in the tool's response, never a refusal): a `language:` code outside this list, and — in a vault with several languages — a substantive page without one section per language, or with its sections out of order.
