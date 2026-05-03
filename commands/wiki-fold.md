---
description: |
  Roll up the wiki's log.md entries into a structurally-idempotent fold page under wiki/folds/ — extractive summarization (no invention) with backlinks to children. Defaults to the last 16 log entries; accepts explicit count or time-bounded windows.

  EN triggers: "fold the log", "roll up recent activity", "compact the log", "summarize this week's wiki activity", "fold the last 32 entries".
  FR triggers : "compacte le journal", "compacte le log", "fais un récapitulatif de l'activité récente", "résume l'activité wiki de cette semaine", "compacte les 32 dernières entrées du journal".

  Example / Exemple:
    EN: "fold this week's log entries"
    FR: "compacte les entrées du journal de cette semaine"
---

Invoke the `wiki-fold` skill on the target vault.

Window resolution (in order):
1. Explicit count: "fold the last 32 entries" → window=32
2. Explicit time: "fold this week" → 7-day window from now
3. Default: last 16 entries

Always:
- Pure extractive (verb counts, target counts) — no invented themes.
- Deterministic file path: re-running the same window produces a byte-equivalent fold at the same path.
- Update `wiki/index.md` to add a row under `## Folds`.
- Append the fold operation to `wiki/log.md`.
