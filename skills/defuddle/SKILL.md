---
name: defuddle
description: Strip noise (ads, navigation, cookie banners, related-post widgets, comment threads, footers) from a webpage and return clean readable markdown — typically saving 40-60% of tokens vs. fetching the raw page. Use as a preprocessor for wiki-ingest or autoresearch when the source is a webpage with heavy chrome. Triggered by "defuddle <url>", "clean this page", "fetch and clean <url>", "/defuddle", "strip the noise from <url>", or implicitly inside autoresearch when fetching commercial/blog pages.
---

# defuddle

Cheap content cleaning before ingestion. Worth the extra step on most webpages — almost free in tokens after, much cheaper to ingest, and the wiki page that comes out is more readable.

## When to use

- Before `wiki-ingest` on a URL that's a typical webpage (blog post, news article, documentation site).
- Inside `autoresearch` for any HTML fetch.
- The user pastes a URL and says "what does this say" — defuddle it then summarize.

## When NOT to use

- The URL is already a clean source (raw markdown, GitHub raw, RSS feed, JSON API).
- The URL is a PDF or video — defuddle is for HTML.
- The user wants the raw HTML for some specific reason.

## Steps

### 1. Fetch the page

Use `WebFetch` with a prompt like:
> Return the main article content as clean markdown. Drop navigation, ads, cookie banners, related posts, comment sections, social media widgets, footer boilerplate, and "subscribe to our newsletter" callouts. Preserve: the article title, author, publication date if visible, headings, body paragraphs, code blocks, lists, blockquotes, inline links to relevant resources (drop tracking-only links), images that are part of the content (note their captions if any).

WebFetch's underlying small model is good at this kind of selective extraction. Trust its output.

### 2. Validate the output

Quick sanity checks:
- Length: if the cleaned output is < 200 chars or > 50K chars, something probably went sideways. Surface to the user with the URL and offer to retry or fall back to raw fetch.
- Title presence: a defuddled article should start with an H1 (the title) or a clear opening paragraph. If it starts mid-sentence, defuddle was too aggressive — flag and offer raw.

### 2.5 Extract deterministic metadata (v0.13.2+, Phase B obsidian-clipper port)

After defuddle returns clean markdown, ALSO call `mcp__obsidian-router__extract_page_metadata({url})` (or `{html}` if you already have the raw HTML cached) to pull structured metadata that the LLM should NOT have to infer:

- `title`, `author`, `published`, `image` (cover), `site` (publisher), `lang`, `description`
- `wordCount`, `readingMinutes` (derived)

This populates the source-page frontmatter deterministically downstream (see `wiki-ingest` step 4). The extractor parses Schema.org JSON-LD + OpenGraph + meta tags in priority order; values that come back as `null` mean none of those signals were present, and the consumer falls back to inferring from the body — but only as last resort.

**Why two calls (defuddle + extract_page_metadata) instead of one combined tool**: clean separation of concerns. `defuddle` strips chrome and returns prose; `extract_page_metadata` parses structured signals from the same URL. Each is independently useful, and a future client could call only one.

**Anti-pattern**: do NOT infer `title` / `author` / `published` when the meta extractor has returned non-null values for those fields. The whole point of the extractor is to make these deterministic — re-inferring undoes that.

### 3. Hand off to the consumer

Defuddle is rarely a terminal action. The output is the input to the next skill. Return an object `{markdown, metadata}` (the markdown from step 1, the metadata from step 2.5) so the consumer doesn't have to re-fetch:

- If invoked from `wiki-ingest`: return `{markdown, metadata}` so wiki-ingest can assemble deterministic frontmatter (step 4 of that skill) before Claude touches the body.
- If invoked from `autoresearch`: same.
- If invoked directly by the user ("defuddle <url>"): show them the cleaned content + a compact metadata header (title / author / published / wordCount), ask "ingest this?" — if yes, hand off to `wiki-ingest`.

**Optional relevance filter (v0.47.0+, Crawl4AI W-A)**: if the consumer has an explicit **topic** for this page (a targeted ingest, an autoresearch question), it can narrow the cleaned markdown to the on-topic blocks with `mcp__obsidian-router__filter_relevant_blocks({markdown, query: <topic>})` — a cheap BM25 second pass, no re-fetch. Defuddle strips *chrome*; this strips *off-topic content*. Leave it to the consumer (wiki-ingest step 1.6 already does this); don't filter inside defuddle, which has no notion of the caller's topic.

## Caching (optional, not required for v1)

If the same URL gets defuddled multiple times in a session, cache the result in `wiki/.raw/defuddle-cache/<sha256-of-url>.md`. Skip if already cached and < 1 hour old. Keeps autoresearch loops cheap when they revisit the same domains.

## Anti-patterns

- Don't defuddle and then DUMP the cleaned content as a wiki page directly. The wiki should hold the synthesis, not the raw cleaned source. Use `wiki-ingest` after defuddle to get proper synthesis.
- Don't defuddle internal vault content — the router already returns clean markdown.
- Don't defuddle when the user explicitly wants the raw HTML (e.g., "what does the HTML structure of this page look like").

## Output format (when invoked directly)

> ✅ Defuddled `<url>` — kept ~<N>%, dropped chrome.
>
> ```markdown
> # <title>
>
> <body>
> ```
>
> Ingest this into the wiki? (`wiki-ingest <url>` or "yes")
