---
description: Regenerate stale or missing digest sidecars in `wiki-meta/digests/`. Companion to `/wiki-lint --deep` which detects which digests are stale. (Skill `wiki-refresh-digests` handles natural-language triggers.)
---

Invoke the `wiki-refresh-digests` skill on the target vault.

Default behaviour:
- Refreshes ONLY stale digests (page hash mismatch) + creates missing digests for pages that don't have one. Up-to-date digests are skipped.
- `--all` to force-regenerate every digest (use after a router upgrade that changed the digest format).
- `--for <page-path>` to refresh only one specific page's digest.
- For batches >20 pages, asks for confirmation first (rate-limit caution).

See `/wiki-lint --deep` to surface which digests need refreshing in the first place.
