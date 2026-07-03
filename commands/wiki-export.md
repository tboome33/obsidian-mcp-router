---
description: Export the wiki to a single portable file (llms.txt compact OR llms-full.txt with bodies) per the llmstxt.org standard, for sharing with humans or feeding to external LLMs (Perplexity, ChatGPT) for grounded Q&A. (Skill `wiki-export` handles natural-language triggers.)
---

Invoke the `wiki-export` skill on the target vault.

Default behaviour:
- Target = `llms` (compact `llms.txt`). Override with `--target full` for `llms-full.txt` (page bodies inlined), or `--target okf` for an **OKF knowledge bundle** (Open Knowledge Format v0.1 — dedicated command: `/obsidian-router:okf-export`).
- Output = `wiki-meta/exports/<vault>-<target>-<ISO-date>.txt` inside the vault (OKF target: a directory under `wiki-meta/exports/okf/<name>/`). Override with `--stdout` to return the content in the chat instead (llms targets only).
- Read-only: never mutates wiki pages. Only writes the export file(s) + appends a log entry.

Other targets listed in the [llm-wiki-compiler-roadmap](http://127.0.0.1:27142/open/wiki%2FDivers%2FLLM-WIKI-COMPILER%2Fllm-wiki-compiler-roadmap.md) (`json`, `json-ld`, `graphml`, `marp`) are deferred — not implemented yet.

Use cases:
- Share your wiki with a collaborator who doesn't have Obsidian.
- Paste `llms.txt` into Perplexity / ChatGPT for grounded Q&A on your vault.
- Backup the wiki to a single portable archive.
- Publish at site root for AI search visibility (norme [llmstxt.org](https://llmstxt.org)).
