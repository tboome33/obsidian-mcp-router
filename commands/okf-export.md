---
description: Export a wiki subset as a shareable OKF knowledge bundle (Google's Open Knowledge Format v0.1) — slugified filenames, relative markdown links, per-folder indexes, newest-first log, conformance self-checked. (Skill `wiki-export` handles the flow via its `okf` target.)
---

Invoke the `wiki-export` skill with `--target okf`.

Arguments (all optional): `[scope] [--name <bundle-name>] [--readme-agent] [--vault <slug>]`
- `scope` — what to export: a folder (`wiki/Divers`), a tag filter (`#trading`), or nothing for the whole `wiki/` tree. When ambiguous, ask the user which subset they want to share BEFORE fetching pages.
- `--name` — bundle folder name; default: slugified vault name.
- `--readme-agent` — also emit the self-installing README (agent onboarding prompt, Cole Medin pattern). Recommend it when the bundle will be published.

Default behaviour:
- Output: a complete OKF v0.1 bundle under `wiki-meta/exports/okf/<name>/` inside the vault — one file per page + one `index.md` per folder + newest-first `log.md`. Self-contained: the user can copy it anywhere, `git init && git push` it, or hand it to any OKF-aware agent.
- `wiki-meta/` content (hot, digests, sessions, graph) is NEVER exported — private working data.
- The vault itself is untouched (read-only on `wiki/`; the export lands under `wiki-meta/exports/`).
- Conformance self-check (`checkOkfConformance`) MUST pass with zero errors before writing anything — an error means an exporter bug, report it instead of shipping a broken bundle.
- Always surface the export report: renamed files (reserved names, slug collisions), dangling links (legal — "not-yet-written knowledge"), dropped anchors, demoted embeds.

Decision context: OKF is our **exchange format at the edges** — internal vault structure never changes (vault page `okf-interop`, 2026-07-03).
