## Source provenance — `source_type` frontmatter (mandatory for substantive pages, since 2026-05-18 v0.8.8)

Every substantive page MUST declare where its content came from. Without this, a reader (you, me, future-Claude, or a wiki-query consumer) cannot tell whether an assertion is a verbatim citation, a reasonable inference from a source, or pure synthesis by Claude. That gap silently erodes trust in the whole wiki.

Three values, vocabulary borrowed from graphify's `EXTRACTED / INFERRED / AMBIGUOUS` taxonomy :

| Value | Meaning | When to use |
|---|---|---|
| `extracted` | Verbatim or near-quote from a source (a user statement, an article, a pasted document). Maximum reliability — reader can trust the wording came from outside. | `wiki-ingest` source pages; user-quoted statements; literal citations. |
| `inferred` | Claude derived this by reading the source/conversation, but it isn't written verbatim. Medium reliability — a reasonable interpretation that someone else might have phrased differently. | Most `answer` notes; most `wiki-ingest` entity/concept pages spawned from a source; summaries. |
| `claude_synthesized` | Pure synthesis by Claude with no direct textual basis. Low reliability for "what does the source say?" but full agency on "what does Claude think?". | `idea` notes proposed by Claude; framings/restatings; opinion pieces. |

### Where to declare it

- **Frontmatter level** (covers the whole page) : `source_type: extracted | inferred | claude_synthesized`. Required on every page of type `source`, `answer`, `decision`, `decision-input`, `reference`, `reference-deep-dive`, `technique`, `idea`. Optional but encouraged on `session`, `concept`, `entity`.
- **Inline callout** (covers a specific paragraph, overrides the page-level default) : `> [!extracted]`, `> [!inferred]`, `> [!claude_synthesized]`. Use when a single page mixes provenance.

### Rule of thumb when in doubt

Prefer the more conservative tag. `claude_synthesized` over `inferred`, `inferred` over `extracted`. False humility is cheap; false confidence corrodes the wiki.

### How skills use it

- **`wiki-ingest`** writes `source_type: extracted` on source pages and `source_type: inferred` or `claude_synthesized` on spawned entity/concept pages depending on how directly the source supported them.
- **`save`** writes the dominant `source_type` based on what's being saved.
- **`wiki-query`** includes provenance in its citations : *"per [[my-note]] (extracted)"* vs *"per [[my-note]] (synthesized)"*. Pre-v0.8.8 pages without the field render as `(unmarked)`.
