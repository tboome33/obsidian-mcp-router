---
name: write-patch
description: |
  Surgical edit — insert/replace under a specific heading, block id, or frontmatter key. Use when you need to modify ONE section of a long note without rewriting the whole file.

  EN triggers: "edit the X section in Y", "update the heading X", "modify the block X", "replace the content under X", "insert under heading Y".
  FR triggers : "édite la section X dans Y", "mets à jour le titre X", "modifie le bloc X", "remplace le contenu sous X", "insère sous le titre Y".

  Example / Exemple:
    EN: "in Indicators/ATP.md, replace the content under heading 'Module 5::Pendant le trade' with: ..."
    FR: "dans Indicators/ATP.md, remplace le contenu sous le titre 'Module 5::Pendant le trade' par : ..."
---

# write-patch

Call the obsidian-router `patch_file` MCP tool with arguments parsed from $ARGUMENTS.

## Arguments

**Required**:
- `path` — file path relative to vault root.
- `operation` — `append`, `prepend`, or `replace`.
- `targetType` — `heading`, `block`, or `frontmatter`.
- `target` — the target identifier:
    * `heading` → the FULL heading path joined by `::` (e.g. `Section 1::Subsection`). Just the heading name alone won't work; the parent path is required.
    * `block` → the block id without the leading `^` (e.g. `atp-config`).
    * `frontmatter` → the property name (e.g. `status`).
- `content` — new content. String for heading/block; for frontmatter accepts string/number/boolean/array/object (types preserved).

**Optional**:
- `vault` — omit for default.
- `targetDelimiter` — override the heading delimiter (default `::`).
- `createTargetIfMissing` — create the target if absent (heading/frontmatter only).
- `applyIfContentPreexists` — skip if target already contains the content (idempotency).
- `trimTargetWhitespace` — trim whitespace around the target before applying.
- `ifMatch` — a `contentSha256` from a prior `get_file`. Whole-file precondition: the patch is refused with a 409 conflict if the file changed since you read it. (The precondition is checked before patching; the patch itself is not hash-locked — this catches patching stale content, it does not make the patch atomic.)

## Argument parsing from $ARGUMENTS

This tool has many parameters. If $ARGUMENTS doesn't make the intent crystal-clear, ask the user before calling. A typical bare invocation as $ARGUMENTS should be `path=... operation=... targetType=... target=... content=...`.

## Common quick patterns

- **Set a frontmatter key**: `path=X operation=replace targetType=frontmatter target=<key> content=<value>` (consider using `write-frontmatter-set` instead — friendlier wrapper).
- **Append under a heading**: `path=X operation=append targetType=heading target="Section::Sub" content="..."`.
- **Replace a block**: `path=X operation=replace targetType=block target=<block-id> content="..."`.

## On failure — remediate, NEVER fall back to filesystem writes

If the call fails, do NOT silently redo it with direct-filesystem tools (`Read`/`Edit`/`Write` on the vault's real path):
- **Connection error** (`ECONNREFUSED`, timeout) → vault closed; `list_vaults`, then ask the user to open it via the `openUri` link and wait.
- **Validation / API error** (HTTP 4xx, e.g. `invalid-target` = heading not the FULL `::`-joined path) → fix the arguments, or use a coarser router tool (`write_file`, `append_to_file`).

Rationale + message template: the `default-vault-health-check` convention (canonical source).

## Output

After the patch, report what was patched (target type, target, operation).
