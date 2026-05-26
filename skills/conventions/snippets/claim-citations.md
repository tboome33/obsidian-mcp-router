## Claim-level citations — line-range markers (v0.15.0+, complements `source-type`)

The `source_type` convention tells you WHICH source contributed to a page (`extracted` / `inferred` / `claude_synthesized`). The `claim-citations` convention adds line-precision : it tells you WHICH LINES of that source justify a specific paragraph.

Useful when sources are long (papers, transcripts, code files, docs >100 lines) and a reader wants to verify a claim in seconds rather than re-reading the whole source.

### Canonical format

Append a marker at the END of the paragraph that makes the cited claim :

```markdown
PKCE replaces the client secret for public OAuth clients, preventing
interception attacks on the authorisation code. ^[oauth-howto.md:42-58]
```

Forms accepted :

| Form | Example | When to use |
|---|---|---|
| **Colon-style range** (canonical) | `^[file.md:42-58]` | Default. Use everywhere. |
| **GitHub-style range** | `^[file.md#L42-L58]` | Only when the source is GitHub-hosted AND you want the marker to render as a GitHub deep link in some downstream tool. Semantically equivalent to the colon form. |
| **Single line** | `^[file.md:42]` | Citation is one line. |
| **Paragraph-level fallback** | `^[file.md]` | Source is short OR has no stable line numbering (rendered HTML, dynamic content). Equivalent to pre-v0.15.0 behaviour. |

### When to use line-range vs paragraph-level

| Use line-range for | Use paragraph-level for |
|---|---|
| Papers (each section is paginated) | Short articles, blog posts |
| Transcripts (each turn has a position) | Summaries |
| Code files (functions live at known lines) | Dynamic HTML / SPA dumps |
| Long-form docs ≥100 lines | Tweets, single-paragraph posts |

### When to skip the marker entirely

When `source_type: extracted` already says "this whole page is from one source" via the frontmatter, the marker is redundant — the frontmatter does the job at the page level. Add markers only when individual paragraphs of an `inferred` or `claude_synthesized` page want to point to specific source passages.

### How skills use it

- **`wiki-ingest`** emits markers in step 5 (entity/concept pages) when the source is long enough to warrant line precision. See `skills/wiki-ingest/SKILL.md` step 5.
- **`wiki-lint`** validates markers via Check H (`claim-range-validity`) — flags cited-source-not-found, range-zero-or-negative, range-inverted, range-overflow. All WARNING-level (sources legitimately shorten over time, no need to fail loudly). See `skills/wiki-lint/SKILL.md` Check H.
- **`wiki-query`** can surface the cited range when answering a question to help the user verify a claim quickly.

### Rule of thumb when in doubt

Prefer the more conservative form. Paragraph-level (`^[file.md]`) over a fabricated range. False precision is worse than no precision — it implies a verifiability the reader will discover is missing.
