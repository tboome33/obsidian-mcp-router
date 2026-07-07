---
description: Convert a local PDF to markdown via the bundled MarkItDown Python CLI (fast, lightweight — plain text extraction, no table-structure recognition). For complex tables/layouts prefer /obsidian-router:pdf-to-markdown-docling.
---

Invoke the `pdf_to_markdown` MCP tool on the given file path.

Required argument: `filepath` (absolute path to the PDF).

Returns markdown text only — it does NOT write to any vault. To persist, chain with `write_file`, or hand off to `wiki-ingest`.

MarkItDown is fast (~12s / 100 pages) but its PDF backend (`pdfminer.six`) extracts the text stream with no layout or table analysis. For PDFs with complex tables or multi-column layouts, use `/obsidian-router:pdf-to-markdown-docling` instead (higher fidelity, ~10x slower, requires the opt-in Docling install).
