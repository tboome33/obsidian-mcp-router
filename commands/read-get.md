---
description: |
  Read the full content of a file from a vault (markdown + frontmatter).

  EN triggers: "show me X", "open the file X", "read X", "what's in X.md", "fetch X".
  FR triggers : "montre-moi X", "ouvre le fichier X", "lis X", "qu'est-ce qu'il y a dans X.md", "récupère X".

  Example / Exemple:
    EN: "show me Sessions/2026-05-03.md"
    FR: "ouvre Sessions/2026-05-03.md"
---

# read-get

Call the obsidian-router `get_file` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `path` — file path relative to vault root (e.g. `Sessions/2026-05-02.md`).

Optional:
- `vault` — vault name. If omitted, the router uses its default vault.

Argument parsing:
- bare path → `path`
- `<vault>/<path>` if first segment matches a known vault name → split into `vault` + `path`
- `vault=X path=Y` (key=value)
- if user just says "the daily note" or similar without a clear path, ask for the path

If `path` is missing, refuse to call the tool and ask the user for it.

After fetching, render the markdown content. If the file has frontmatter, format it as a YAML code block at the top followed by the body. Don't truncate unless the file is huge (>2000 lines), in which case show the first 200 lines and offer to fetch more on request.
