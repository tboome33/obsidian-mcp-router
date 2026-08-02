---
name: wiki-fold
description: Roll up the wiki's journal.md entries into structured fold pages — like 2^k log compaction. Reads the last 2, 4, 8, 16... entries and writes a fold page that summarizes them by extractive summarization (no invention), with backlinks to children. Idempotent at the structural level — re-running with the same window produces a byte-equivalent fold. Use when the user says "fold the log", "rollup recent activity", "compact the log", "/wiki-fold", or after many ingestions when journal.md is becoming too long to read directly.
---

# wiki-fold

Append-only rollup of `journal.md` into hierarchical summary pages stored under `wiki/folds/`. Inspired by log-structured systems: small windows fold into bigger ones over time, and the log itself stays linear forever.

## When to use

- `journal.md` has grown past ~100 entries and needs structural summarization.
- The user wants a "what happened in the last week / month" report.
- After a multi-source ingestion session: roll up the new entries into one fold page.

## Pre-conditions

1. Target vault has `wiki-meta/journal.md`.
2. Vault is online.

## Steps

### 1. Read the log

```
mcp__obsidian-router__get_file({ vault, path: "wiki-meta/journal.md" })
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

### 4.5. Topology-equality short-circuit (v0.8.10, T1.C)

Before writing the fold page, **read what's already on disk at the target path** and compare with the fold body you're about to write:

```
mcp__obsidian-router__get_file({ vault, path: "wiki/folds/<window-id>.md" })
```

If the existing file content is **byte-equivalent to the new body** (after canonicalisation — normalize CRLF to LF, strip trailing whitespace per line, collapse trailing blank lines), then skip the write entirely:

- **DO NOT** call `write_file`
- **DO NOT** update `catalog.md` (the fold is already there)
- **DO NOT** append to `journal.md` (no operation actually happened)
- **DO** tell the user: *"Fold for `<window-id>` is already up to date — no changes written."*

Why: the idempotency contract is structural (deterministic naming + sorted output + ISO timestamps), but auto-commit hooks (`PostToolUse`) don't know that — they'll commit a no-op write as a real commit and pollute `git log` with empty fold churn over time. The short-circuit enforces the contract operationally.

This is a port of graphify's `_canonical_topology_for_compare` pattern (`watch.py` rebuild path) — they apply the same "skip write if topology-canonical matches" check to graph.json regeneration. Same intent: idempotency you can trust at the disk level.

If the existing file does NOT exist, or its content differs after canonicalisation, proceed to step 5 normally.

The router exposes `contentIsUnchanged(filePath, newContent)` in `src/helpers/wiki-fingerprint.mjs` for tools that need to perform this check programmatically. As a skill (driven by Claude reading files via MCP), apply the same logic by hand: fetch the existing content, normalise both sides, compare.

### 5. Write the fold page

Frontmatter:
```yaml
---
type: fold
window: <description>
entries_covered: <N>
first_entry: <ISO>
last_entry: <ISO>
---
```

**No `generated_at` field** — that's a wall-clock value and would break the byte-equivalence guarantee. The window is fully described by the deterministic fields above; you can always reconstruct *when* the fold was emitted by looking at the `wiki-meta/journal.md` entry written in step 7.

Body sections:

- **Summary** — 2-4 lines, extractive: "Between <first_entry> and <last_entry>, the wiki saw N operations: <verb counts>. Most touched pages: <top 3 targets>."
- **By verb** — for each verb, a bulleted list of target+reason pairs.
- **By page** — for each target page touched, a bulleted list of operations.
- **Linked children** — wikilinks back to all source/answer/entity pages mentioned in the entries. So the fold is a navigation hub.

### 6. Update catalog.md

Under a `## Folds` section (create it if missing), add a row pointing at the new fold page.

### 7. Append to journal.md

```
- YYYY-MM-DD HH:MM — fold — folds/<window-id>.md — rolled up <N> entries from <first> to <last>
```

Note: the fold itself becomes a log entry, but it doesn't appear inside its own window (the timestamp is after the window's last_entry).

### 7.5 Steps 5-7 are ONE bundle (v0.66.0+, borrowing C2)

The "write+index+log triplet" this skill already names as a unit should also *behave* as one. A fold page listed in `catalog.md` but never logged — or logged and never written — is a fold you cannot trust to be complete, and the idempotency contract above depends on the three staying in agreement.

```
mcp__obsidian-router__write_bundle({
  vault, steps: [
    { op: "write",  path: "wiki/folds/<window-id>.md", content: <fold page> },
    { op: "patch",  path: "wiki-meta/catalog.md", operation: "append", targetType: "heading",
                    target: "Folds", content: "- [[folds/<window-id>]]", ifMatch: <catalog contentSha256> },
    { op: "append", path: "wiki-meta/journal.md", content: "- YYYY-MM-DD HH:MM — fold — …\n" }
  ]
})
```

`catalog.md` is a shared file: pass its `contentSha256` as `ifMatch` so a parallel session's edit refuses the fold instead of being overwritten. If the `## Folds` heading does not exist yet, decide that **before** building the bundle (use an `append` step with the heading inline) — a bundle step must never be one you expect to fail. Re-check `outcome` before printing step 8: a `rolled-back` fold wrote nothing at all.

### 8. Output

> ✅ Folded N entries from `<first>` to `<last>` into `wiki/folds/<window-id>.md`.
> Top verbs: ingest (X), query-filed (Y), lint (Z).
> Top pages touched: [[Page A]] (n), [[Page B]] (n).

## Idempotency contract

Re-running the same fold (same window definition) produces a byte-equivalent file at the same path. Achieved by:
- Deterministic window-id from window definition
- Sorted output sections (sort by count desc, then alphabetically)
- ISO timestamps in `first_entry` / `last_entry` are pulled from the source log entries (not wall-clock)
- No wall-clock fields anywhere in the fold body (the "when was this fold emitted" answer lives in `wiki-meta/journal.md`, not in the fold itself)

**Operational enforcement (v0.8.10, T1.C)**: step 4.5 reads the existing file and skips the write+index+log triplet if the body is byte-equivalent after canonicalisation. The structural design + the operational check together mean: re-running `/wiki-fold` with the same window costs one read and zero writes.

Use `mcp__obsidian-router__write_file` (no `ifNew` flag — idempotent overwrite is fine here, that's the point) for the actual write in step 5, AFTER step 4.5 has cleared it.

## Anti-patterns

- Don't invent themes. "This week the user worked on machine learning topics" is interpretive — keep it strictly extractive: list verb counts and targets.
- Don't fold log entries that are already inside an existing fold's window. Check existing fold pages first; if today's window overlaps a previous fold's window, expand the window or shift it.
- Don't auto-fold on a schedule unless the user opts in via a hook. This is a manual rollup tool.

## Future enhancement (not implemented in v1)

Hierarchical folds: a fold-of-folds. After 8 individual folds exist, one meta-fold rolls them up. The pattern compounds well but adds complexity — defer until there's a real need.
