---
description: |
  Ingest a source (URL, file, or pasted text) into the wiki — extracts entities and concepts, files them as cross-referenced wiki pages, and updates index/log/hot. Single source or batch (multiple sources fan out via the wiki-ingest sub-agent). Use after the wiki is scaffolded.

  EN triggers: "ingest this URL", "absorb this article", "file this in the wiki", "process this source", "add this to my knowledge base", "ingest all of these".
  FR triggers : "ingère cette URL", "absorbe cet article", "file ça dans le wiki", "traite cette source", "ajoute ça à ma base de connaissances", "ingère tout ça".

  Example / Exemple:
    EN: "ingest https://example.com/post into my Recherche wiki"
    FR: "ingère https://example.com/article dans mon wiki Recherche"
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
3. Update `wiki/index.md`, `wiki/log.md`, `wiki/hot.md` after each successful ingestion.
4. Be selective — don't create a page for every passing mention.
