---
description: |
  Strip noise (ads, nav, cookie banners, comment threads, footers) from a webpage and return clean readable markdown — saves 40-60% tokens before ingestion. Typically chained with wiki-ingest or invoked inside autoresearch.

  EN triggers: "clean this page", "defuddle <url>", "strip the noise from <url>", "fetch and clean <url>", "give me the readable version of <url>".
  FR triggers : "nettoie cette page", "extrais la version lisible de <url>", "récupère le contenu propre de <url>", "récupère et nettoie <url>", "donne-moi la version lisible de <url>".

  Example / Exemple:
    EN: "defuddle https://news-site.com/article-with-heavy-chrome and show me what's left"
    FR: "defuddle https://site-news.com/article-avec-chrome-lourd et montre ce qui reste"
---

Invoke the `defuddle` skill on the URL.

After defuddle:
- Validate output (length sanity, title presence)
- Hand off to `wiki-ingest` if invoked from a chain
- Or show the cleaned content to the user and ask "ingest this?" if invoked directly

Only for HTML pages. For PDFs, raw markdown, GitHub raw, RSS, or JSON APIs, fetch directly without defuddling.
