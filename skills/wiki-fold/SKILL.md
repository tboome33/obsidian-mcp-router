---
name: wiki-fold
description: Roll up the wiki's log.md entries into structured fold pages — like 2^k log compaction. Reads the last 2, 4, 8, 16... entries and writes a fold page that summarizes them by extractive summarization (no invention), with backlinks to children. Idempotent at the structural level — re-running with the same window produces a byte-equivalent fold. Use when the user says "fold the log", "rollup recent activity", "compact the log", "/wiki-fold", or after many ingestions when log.md is becoming too long to read directly.
---

# wiki-fold

Append-only rollup of `log.md` into hierarchical summary pages stored under `wiki/folds/`. Inspired by log-structured systems: small windows fold into bigger ones over time, and the log itself stays linear forever.

## When to use

- `log.md` has grown past ~100 entries and needs structural summarization.
- The user wants a "what happened in the last week / month" report.
- After a multi-source ingestion session: roll up the new entries into one fold page.

## Pre-conditions

1. Target vault has `wiki/log.md`.
2. Vault is online.

## Steps

### 1. Read the log

```
mcp__obsidian-router__get_file({ vault, path: "wiki/log.md" })
```

Parse it into structured entries. The format from the `wiki` and `wiki-ingest` skills is:
```
- YYYY-MM-DD HH:MM — <verb> — <target(s)> — <reason>
```

If a line doesn't parse, skip it but don't fail.

### 2. Determine the fold window

Default: fold the last 2^k entries where k is chosen so the window is between 8 and 64 entries. The user can override with an explicit window:
- "fold the last 16 entries" → k=4, 16-entry window
- "fold this week" → time-bounded, take all entries with timestamps in the last 7 days
- "fold the last month" → time-bounded, last 30 days

If none of those signals are given, default to the last 16 entries.

### 3. Group entries by verb and target

Extractive grouping (no invention):

- Group by `verb` (ingest, scaffold, lint, fold, query-filed, ...) → count and list distinct targets
- Group by target (which page was touched most often)
- Identify the time span: first timestamp, last timestamp

This is pure aggregation. Don't infer themes that aren't literally there.

### 4. Compute the fold page path

```
wiki/folds/<window-id>.md
```

Where `<window-id>` is:
- For count-based windows: `last-<N>-as-of-<YYYY-MM-DD>`
- For time-based windows: `<YYYY-MM-DD>--<YYYY-MM-DD>`

The deterministic naming is what makes folds idempotent: re-running with the same window writes to the same path.

### 5. Write the fold page

Frontmatter:
```yaml
---
type: fold
window: <description>
entries_covered: <N>
first_entry: <ISO>
last_entry: <ISO>
generated_at: <ISO>
---
```

Body sections:

- **Summary** — 2-4 lines, extractive: "Between <first_entry> and <last_entry>, the wiki saw N operations: <verb counts>. Most touched pages: <top 3 targets>."
- **By verb** — for each verb, a bulleted list of target+reason pairs.
- **By page** — for each target page touched, a bulleted list of operations.
- **Linked children** — wikilinks back to all source/answer/entity pages mentioned in the entries. So the fold is a navigation hub.

### 6. Update index.md

Under a `## Folds` section (create it if missing), add a row pointing at the new fold page.

### 7. Append to log.md

```
- YYYY-MM-DD HH:MM — fold — folds/<window-id>.md — rolled up <N> entries from <first> to <last>
```

Note: the fold itself becomes a log entry, but it doesn't appear inside its own window (the timestamp is after the window's last_entry).

### 8. Output

> ✅ Folded N entries from `<first>` to `<last>` into `wiki/folds/<window-id>.md`.
> Top verbs: ingest (X), query-filed (Y), lint (Z).
> Top pages touched: [[Page A]] (n), [[Page B]] (n).

## Idempotency contract

Re-running the same fold (same window definition) produces a byte-equivalent file at the same path. Achieved by:
- Deterministic window-id from window definition
- Sorted output sections (sort by count desc, then alphabetically)
- ISO timestamps (no timezone surprises)
- Skipping the `generated_at` field's wall-clock time when comparing for "did anything change?"

Use `mcp__obsidian-router__write_file` (no `ifNew` flag — idempotent overwrite is fine here, that's the point).

## Anti-patterns

- Don't invent themes. "This week the user worked on machine learning topics" is interpretive — keep it strictly extractive: list verb counts and targets.
- Don't fold log entries that are already inside an existing fold's window. Check existing fold pages first; if today's window overlaps a previous fold's window, expand the window or shift it.
- Don't auto-fold on a schedule unless the user opts in via a hook. This is a manual rollup tool.

## Future enhancement (not implemented in v1)

Hierarchical folds: a fold-of-folds. After 8 individual folds exist, one meta-fold rolls them up. The pattern compounds well but adds complexity — defer until there's a real need.
