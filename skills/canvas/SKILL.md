---
name: canvas
description: Create or modify Obsidian canvas (.canvas) files — visual layout layer where wiki pages, images, PDFs, and free-form text cards are arranged spatially. Supports adding nodes, defining zones (labeled regions), and laying out content with auto-positioning. Use when the user says "create a canvas", "add to canvas", "/canvas", "visualize this on a canvas", "make a canvas of <topic>", "add image to canvas", "add note to canvas", or any phrasing about visual/spatial organization of vault content.
---

# canvas

Obsidian's `.canvas` files are JSON. This skill writes them programmatically with sensible auto-layout so you don't have to hand-position nodes.

## .canvas format primer

A canvas file is a JSON object:

```json
{
  "nodes": [
    {
      "id": "<unique-id>",
      "type": "file|text|link|group",
      "x": <int>, "y": <int>,
      "width": <int>, "height": <int>,
      "color": "1-6 or #hex"   // optional
      // type-specific fields below
    }
  ],
  "edges": [
    {
      "id": "<unique-id>",
      "fromNode": "<node-id>",
      "fromSide": "top|right|bottom|left",
      "toNode": "<node-id>",
      "toSide": "top|right|bottom|left",
      "label": "<optional>"
    }
  ]
}
```

Type-specific fields:
- `type: "file"` → adds `"file": "<vault-relative-path>"` (any file: .md, .png, .pdf, etc.)
- `type: "text"` → adds `"text": "<markdown content>"`
- `type: "link"` → adds `"url": "<https://...>"`
- `type: "group"` → adds `"label": "<zone label>"`, `"background": "<optional>"`

## Operations

### `canvas-new <name>`
Create a new canvas at `wiki/canvases/<slug>.canvas` (extension is `.canvas` only — Obsidian renders these with a canvas icon in the file tree). Empty `nodes` and `edges` arrays.

### `canvas-add-text <canvas> <text>`
Append a text node. Auto-position: rightmost node's `x + width + 50`, same `y`. Default size 300×120.

### `canvas-add-file <canvas> <path>`
Append a file node. Auto-detect size based on file type:
- Markdown: 400×300
- Image (.png/.jpg/.webp): 400×400
- PDF: 600×800
- Other: 400×300

### `canvas-add-link <canvas> <url>`
Append an external link card. Default size 400×120.

### `canvas-zone <canvas> <label>`
Add a `group` node. Default size 800×600. Position: below or right of the rightmost group, with a 50px gap.

### `canvas-add-to-zone <canvas> <zone-label> <node>`
Place the new node WITHIN the bounding box of the named zone. Useful for organized layouts ("add this image to the 'References' zone").

### `canvas-list <canvas>`
Read the canvas file, list all nodes with their type/label/file/text-preview. Read-only.

### `canvas-capture-recent-images <canvas> [folder]`
Add the most recently modified image files from a vault folder (default: `_attachments/`) as file nodes to the named canvas. Useful for capturing a batch of generated images into a visual board. Optional `count` parameter — defaults to the 8 most recent.

## Pre-conditions

1. Target vault is online.
2. For mutating ops: target canvas file path is determined (or being created).

## Steps

### 1. Resolve the canvas path

If the user gave a name without folder, default to `wiki/canvases/<slug>.canvas` (note: extension is `.canvas`, not `.md`). Slugify the name.

### 2. Read the existing canvas (or initialize)

```
mcp__obsidian-router__get_file({ vault, path: "<canvas-path>" })
```

If 404 → initialize with `{ "nodes": [], "edges": [] }` and proceed.
If found → parse JSON. If parse fails, bail — don't trash a malformed canvas.

### 3. Compute node positions

Auto-layout heuristics (in order):

1. **First node**: place at (0, 0).
2. **Subsequent nodes (no zone target)**: rightmost existing node's `x + width + 50`, same `y` as the rightmost. Wrap to a new row at y + 500 every 4 nodes.
3. **Zone target**: place inside the zone's bounding box, top-left within the zone, offset 30,30. If multiple nodes go in the same zone, stack vertically with 30px gap.
4. **Group node (zone)**: place below the bottommost existing node row, or right of the rightmost zone if multiple zones already exist.

### 4. Generate IDs

Random 16-char hex string per node. Don't reuse IDs.

### 5. Write the modified canvas

Always overwrite the entire file (canvases are small, atomic write is safer than patch). Use `mcp__obsidian-router__write_file` with explicit content.

### 6. Confirm to the user

Tell the user what was added and where to open it:
> ✅ Added text node to `wiki/canvases/<name>.canvas`. Open it in Obsidian to view.

## Anti-patterns

- Don't try to use `patch_file` on a canvas — JSON is too brittle to patch by string. Read-modify-write the whole file.
- Don't generate a canvas with hundreds of nodes from a single command. If the user asks "put my whole vault on a canvas", clarify first — that's almost certainly the wrong tool.
- Don't add file nodes pointing to files that don't exist in the vault. Use `mcp__obsidian-router__list_files` first to verify.
- Don't auto-create edges. Let the user draw connections in Obsidian's UI.

## Output format

For each operation:
> ✅ `canvas <op>` on `<canvas-path>`:
> - <what was added>
> - position: (<x>, <y>), size: <w>×<h>
> Open in Obsidian to view.
