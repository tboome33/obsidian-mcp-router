---
description: Ingest a source (URL, file, or pasted text) into the wiki — extracts entities/concepts, files them as cross-referenced pages. (Skill `wiki-ingest` handles natural-language triggers.)
---

Invoke the `wiki-ingest` skill on the source(s) provided.

Source forms accepted:
- URL: `wiki-ingest https://...`
- Local file: `wiki-ingest /path/to/file.md`
- Multiple in one go: `wiki-ingest url1 url2 url3` → fan out via sub-agent
- Pasted text: the user pastes a block and says "ingest this"

For URLs, prefer running the `defuddle` skill first if the page looks like a typical webpage with chrome (blog post, news article, docs site).

Always:
1. Show the page plan (what entities/concepts will be created or updated) BEFORE writing files.
2. Use `mcp__obsidian-router__write_file` and `patch_file` (multi-vault aware), not native Write/Edit.
3. Update `wiki-meta/index.md`, `wiki-meta/log.md`, `wiki-meta/hot.md` after each successful ingestion.
4. Be selective — don't create a page for every passing mention.
