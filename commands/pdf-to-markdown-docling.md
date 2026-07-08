---
description: Convert a local PDF to markdown via Docling's standard pipeline (layout + table-structure recognition — higher fidelity than MarkItDown on complex tables/layouts, ~10x slower). Requires the opt-in Docling install.
---

Invoke the `pdf_to_markdown_docling` MCP tool on the given file path.

Required argument: `filepath` (absolute path to the PDF).

Returns markdown text only — it does NOT write to any vault. To persist, chain with `write_file`, or hand off to `wiki-ingest`.

Docling reconstructs table structure and reading order that MarkItDown's `pdfminer.six` backend loses, at ~10x the CPU cost. It is an **opt-in** extra: it only works if the router was installed with `OBSIDIAN_ROUTER_ENABLE_DOCLING=1` (or `npm run install-docling` was run afterwards). If Docling is not installed, the tool returns an actionable install hint — fall back to `/obsidian-router:pdf-to-markdown` (MarkItDown). For fast/simple PDFs or non-PDF office files, prefer `/obsidian-router:pdf-to-markdown`.

Figures come back as `<!-- image -->` placeholders (Docling runs with `--image-export-mode placeholder`), not embedded images — the output stays text-only and lightweight. Table structure and reading order are still reconstructed.
