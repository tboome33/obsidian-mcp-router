---
description: Create or modify Obsidian canvas (.canvas) files — the visual layout layer for wiki pages, images, PDFs, and free-form text cards. Supports add-text, add-file, add-link, add-zone, add-to-zone, list, and capture-recent-images-from-banana. Auto-positions new nodes so you don't have to hand-place them.
---

Invoke the `canvas` skill.

Sub-operations:
- `/canvas new <name>` → create at `wiki/canvases/<slug>.canvas`
- `/canvas add text <canvas> <text>` → append a text card
- `/canvas add file <canvas> <vault-relative-path>` → append a file/note/image/PDF node
- `/canvas add link <canvas> <url>` → append an external link card
- `/canvas zone <canvas> <label>` → add a labeled group region
- `/canvas add to zone <canvas> <zone-label> <node>` → place inside a zone
- `/canvas list <canvas>` → read-only inspection of the canvas
- `/canvas capture recent images <canvas> [folder]` → add the most recently modified image files from a vault folder (default `_attachments/`) as file nodes to the canvas

Canvas file format is JSON; the skill always read-modify-writes the entire file (atomic) since JSON is brittle to patch.

Auto-layout: rightmost+50px for new sibling nodes, wrap rows at 4-wide. Zones go below or right of existing zones.
