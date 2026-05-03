---
description: |
  Permanently delete a file. Requires explicit confirm=true on a second invocation — first call shows a preview and refuses, second call with confirm=true proceeds. Designed against accidental deletes from hallucinated tool calls.

  EN triggers: "delete X", "remove the file X", "trash X", "wipe X", "get rid of X.md".
  FR triggers : "supprime X", "efface le fichier X", "mets X à la corbeille", "vire X", "débarrasse-moi de X.md".

  Confirmation triggers (only after a preview, only for the SAME path that was just previewed — don't loosen the guard):
    EN: "yes confirm=true", "go ahead", "confirm delete X", "yes delete it".
    FR : "oui confirm=true", "vas-y", "confirme la suppression de X", "oui supprime".

  Example / Exemple:
    EN: "delete Sessions/old-test.md" → preview, then "yes confirm=true"
    FR: "supprime Sessions/old-test.md" → preview, puis "oui confirm=true"
---

# manage-delete

Call the obsidian-router `delete_file` MCP tool with arguments parsed from $ARGUMENTS.

Required:
- `path` — file path relative to vault root.
- `confirm` — must be EXACTLY `true`. Any other value blocks the deletion.

Optional:
- `vault` — omit for default.

Argument parsing:
- bare path → `path`. **DO NOT** auto-set confirm=true. The first call should fail with the guard message; only set confirm=true when the user re-issues the command with explicit confirmation.
- `<path> --yes` or `<path> confirm=true` → set confirm=true

Safety protocol:
1. First invocation without `confirm=true`:
   - Show the user the path that's about to be deleted
   - Optionally call `get_file` to show a preview (first 10 lines) so they know what they're deleting
   - Ask: "Confirm delete? Re-run with `confirm=true` to proceed."
   - DO NOT call delete_file with confirm=true on the user's behalf.

2. Second invocation with `confirm=true`:
   - Call the tool
   - Report `vault`, `path`, `deleted: true`

If the user clearly types `confirm=true` from the start, you can call directly — but err on the side of confirming.

This guard exists because Claude can hallucinate delete calls in long sessions. The protocol gives the user one more chance to catch it.
