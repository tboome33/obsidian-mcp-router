---
description: Strip noise (ads, nav, cookie banners, comment threads, footers) from a webpage and return clean readable markdown — saves 40-60% tokens before ingestion. Typically chained with wiki-ingest or invoked inside autoresearch. Use directly to inspect what a page boils down to.
---

Invoke the `defuddle` skill on the URL.

After defuddle:
- Validate output (length sanity, title presence)
- Hand off to `wiki-ingest` if invoked from a chain
- Or show the cleaned content to the user and ask "ingest this?" if invoked directly

Only for HTML pages. For PDFs, raw markdown, GitHub raw, RSS, or JSON APIs, fetch directly without defuddling.
