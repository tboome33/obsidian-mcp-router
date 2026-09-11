## One-line summary — `description` frontmatter (mandatory for every page)

Every page MUST carry a `description`: **one plain sentence** saying what the page is, in the vault's primary language. Not a topic label ("OKF"), not a restatement of the title — what a reader learns by opening it.

```yaml
description: "L'étude de la norme OKF de Google et notre stratégie : format d'échange aux frontières, jamais format interne."
```

> [!warning] What is optional here is the GUIDANCE, never the field
> This page is the authoring guide. The `description` field itself is a data contract that applies whether or not this convention is installed: `wiki-lint` reports every page under `wiki/` that lacks one (since v0.59.2), `refresh_okf_projections` lists them in `missingDescription`, and the OKF directory indexes publish the sentence. Those are *diagnostics and publication* — nothing rejects a write — but the gap is visible in the vault's own navigation. The scaffolded `CLAUDE.md` states the requirement unconditionally; what you install here is how to write a good one. Measured 2026-09-11: **none of the 16 inspected vaults with a conventions file contained this section**, while the lint applied to their pages.

Why it is mandatory, and why it lives in frontmatter rather than in the body:

- **It is what the OKF projections publish.** `wiki/<dir>/index.md` renders one line per page, `* [Title](file.md) - description`. A page without a `description` degrades to a bare title, and the directory index stops being a map — it becomes a list of filenames.
- **It is never synthesized.** The bundle *exporter* falls back to the body's first sentence, because Google's reference tooling refuses description-less documents. The at-rest projections deliberately do **not**: a machine-written sentence sitting in the vault is indistinguishable from an authored one, and nobody would ever know to correct it. Missing descriptions are reported, not invented.
- **A body lead is not a substitute.** Many pages open with `> **En une phrase** : …`. That is good writing, but it is prose — a generator cannot tell it apart from a methodology callout or a language-switch line. Put the sentence in frontmatter; keep the lead in the body if it helps the human reader.

### Writing one

- One sentence, no markdown, no `[[wikilinks]]`, no line breaks — it is a YAML scalar and it is rendered inline in an index.
- Say what the page **is or concludes**, not what it is *about*: "Décision : BM25 plutôt qu'un scorer à embeddings…" beats "Note sur le choix du scorer".
- Roughly 100-180 characters. Long enough to be informative in an index, short enough to scan a directory of thirty.
- Quote it (`description: "…"`) so a leading `«` or an embedded `:` cannot break the YAML. Avoid backslashes — the reader is a line parser, not a full YAML engine, and will not unescape them.

### How skills enforce this

`save`, `wiki-ingest`, `wiki-query --persist` and `autoresearch` write `description` on every page they create. `wiki-lint` flags pages that lack one, and `refresh_okf_projections` reports them in `missingDescription`.
