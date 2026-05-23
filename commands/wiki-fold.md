---
description: Roll up wiki-meta/log.md entries into a structurally-idempotent fold page — extractive summarization with backlinks to children. (Skill `wiki-fold` handles natural-language triggers.)
---

Invoke the `wiki-fold` skill on the target vault.

Window resolution (in order):
1. Explicit count: "fold the last 32 entries" → window=32
2. Explicit time: "fold this week" → 7-day window from now
3. Default: last 16 entries

Always:
- Pure extractive (verb counts, target counts) — no invented themes.
- Deterministic file path: re-running the same window produces a byte-equivalent fold at the same path.
- Update `wiki-meta/index.md` to add a row under `## Folds`.
- Append the fold operation to `wiki-meta/log.md`.
