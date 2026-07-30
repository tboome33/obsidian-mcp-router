---
description: Compact an oversized `wiki-meta/hot.md` back to its cache contract (verified full backup → thin ≤ 350-word state-first rewrite → log trace). Use when the hot-cache guard reports "hot.md HORS LIMITE / OVER LIMIT", or on demand. (Skill `hot-compact` carries the full transactional procedure.)
---

Invoke the `hot-compact` skill.

Optional: a vault name (defaults to the current/locked/default vault) · `--dry-run` (show the proposed thin hot without writing).

The skill handles:
- Size measurement WITHOUT loading a huge hot.md into context (script + the vault's own Local REST API)
- Byte-identical, VERIFIED backup `wiki-meta/hot.full-backup-<date-hhmm>.md` before any overwrite
- Thin state-first rewrite (≤ 350 words / 4 KiB): Key Recent Facts · Recent Changes · Active Threads, pinned (📌) blocks always preserved
- Human preview when it's the vault's first compaction at > 5× the limit
- Concurrency re-check before the final write + traceability line in `wiki-meta/journal.md`
