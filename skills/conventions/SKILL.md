---
name: conventions
description: Manage CLAUDE.md conventions across Obsidian vaults — install, remove, check status, or propagate conventions like source-type / bilingual / heading-hierarchy / auto-enrichment. Triggers (EN) `install source-type convention on smile`, `list conventions on this vault`, `what conventions are installed`, `sync source-type to all vaults`, `remove bilingual convention from vault X`. Triggers (FR) `installe la convention source-type sur smile`, `liste les conventions disponibles`, `quelles conventions sont actives sur ce vault`, `propage la convention source-type à tous les vaults`, `retire la convention bilingue du vault X`.
---

# conventions

Manage the named conventions that ship in vault-root `CLAUDE.md` files — install, remove, check status, or propagate to many vaults at once. A "convention" is a self-contained `## H2` section of `CLAUDE.md` (e.g. `## Source provenance — \`source_type\` frontmatter`) that tells Claude how to behave for that vault. The router ships a library of these as markdown snippets; this skill is the installer / detector / synchronizer.

## Pre-conditions

1. Target vault(s) are online — call `list_vaults` first.
2. The plugin install ships the convention snippets at `<plugin-root>/skills/conventions/snippets/*.md`. You'll need to read these to know what's available.

## When to use

- *"install source-type on this vault"* / *"installe la convention source-type ici"*
- *"list conventions"* / *"quelles conventions sont disponibles"*
- *"what's installed on vault X"* / *"quelles conventions sont actives sur X"*
- *"sync source-type to all vaults"* / *"propage source-type partout"*
- *"remove bilingual from vault Y"* / *"retire bilingual de Y"*

## When NOT to use

- The user wants to write a CUSTOM convention not in the snippet library → file it as a regular snippet first (see "Add a new convention" below).
- The user wants to overwrite the entire CLAUDE.md → use `wiki` skill (re-scaffold) instead.
- The user wants to remove a section they hand-wrote (not from the library) → it's their content, don't touch via this skill.

## How a convention is identified

Each convention snippet starts with a unique `## H2` heading. That heading is the **convention's stable identity** — used both to detect "is this convention installed in the target CLAUDE.md?" and to remove it cleanly. The snippet filename (`source-type.md`) is the **convention id** used in slash command arguments.

Mapping (initial library shipped with this skill):

| Snippet file | Convention id | Identifying H2 heading |
|---|---|---|
| `source-type.md` | `source-type` | `## Source provenance — \`source_type\` frontmatter` |
| `bilingual.md` | `bilingual` | `## Bilingual convention (FR + EN, FR primary)` |
| `heading-hierarchy.md` | `heading-hierarchy` | `## Note structure — headings hierarchy (mandatory)` |
| `auto-enrichment.md` | `auto-enrichment` | `## Auto-enrichment (4 modes — \`ClaudeAsk\` / \`Hybrid\` / \`FullAuto\` / \`off\`)` |
| `roadmap-discipline.md` | `roadmap-discipline` | `## Roadmap discipline — création + maintenance dans le vault courant` |
| `default-vault-health-check.md` | `default-vault-health-check` | `## Default vault health check at session start` |
| `wiki-query-first.md` | `wiki-query-first` | `## Wiki-query-first reflex — check the vault BEFORE answering` |
| `path-disambiguation.md` | `path-disambiguation` | `## Workspace-bound path disambiguation — NEVER mix cwd path with vault subpath` |
| `claim-citations.md` | `claim-citations` | `## Claim-level citations — line-range markers (v0.15.0+, complements \`source-type\`)` |
| `tribu-routing.md` | `tribu-routing` | `## Family-member auto-routing — identify the speaker, route saves to wiki/People/<member>/` |

(Other snippets may exist — always `Glob` the snippets dir to get the live list, don't hardcode beyond a fallback.)

## Steps

### Resolving the snippets directory

The snippets live in the plugin install at `<plugin-root>/skills/conventions/snippets/`. Find the plugin root via `${CLAUDE_PLUGIN_ROOT}` env var if available, otherwise look in `~/.claude/plugins/` for a folder containing `skills/conventions/snippets/`. Once found, `Glob` it for `*.md`.

If you can't find the snippets dir, fall back to reading `<router-clone>/templates/wiki/CLAUDE.md` and extracting H2 sections from there.

### `list` — show available conventions + status

1. `Glob` the snippets directory for `*.md`.
2. For each snippet, read the first 10 lines to get the H2 heading (the convention's identity).
3. Resolve the target vault(s):
   - If user said *"on vault X"* → just that vault
   - If user said *"on all vaults"* → call `list_vaults`, filter to `online: true`
   - Default (no vault specified) → the current default vault from `list_vaults`
4. For each (convention × vault) pair: read the vault's `CLAUDE.md`, check if the H2 heading is present (`includes()`), mark ✅ or ❌.
5. Render as a markdown table.

Example output:

```
## Conventions status

Vault: smile
- ✅ source-type          (installed)
- ❌ bilingual            (not installed)
- ✅ heading-hierarchy    (installed)
- ❌ auto-enrichment      (not installed)
```

For multi-vault status, render one row per vault with checkmark columns.

### `install <convention-id> [on <vault>] [--all]` — add a convention

1. Resolve the snippet: read `<plugin-root>/skills/conventions/snippets/<convention-id>.md`. If 404, tell user "no such convention" + show `list` output.
2. Resolve target vault(s):
   - `--all` → all online vaults from `list_vaults`
   - `on <vault>` → that specific vault
   - Default → the current default vault
3. For each target vault:
   - Read its `CLAUDE.md` via `get_file`
   - Check if the snippet's H2 heading already appears in the content → if yes, SKIP and report "already installed"
   - If no, `append_to_file` with the snippet content, prefixed by `\n` to ensure section separation
4. Report a summary: `N installed, M skipped (already present), K failed`.

### `remove <convention-id> [on <vault>] [--all]` — strip a convention

1. Same snippet resolution as install.
2. Same vault resolution.
3. For each target vault:
   - Read its `CLAUDE.md` via `get_file`.
   - Find the snippet's H2 heading.
   - If not present, SKIP and report "not installed".
   - If present, find the section boundaries: from the H2 line through the line before the NEXT H2 heading (or EOF if it's the last section).
   - **MANDATORY backup before write** (IMP-4 from `/review+` 2026-05-21) — see "Safety guards" below.
   - `write_file` with the content minus that section.
4. Report summary, INCLUDING the path of every sidecar backup created (so the user can rollback by hand if needed).

### Safety guards on `remove` (mandatory, IMP-4)

**Why these guards exist** — the H2-heading match strips the section between `## <heading>` and the next `## ` line. If the user has hand-edited the convention's section in their vault's `CLAUDE.md` (extended it with personal rules, inline examples, etc.), `remove` would wipe all their customisations along with the convention. The guards make destructive intent explicit and rollback trivial.

**MANDATORY for every remove call (single-vault or `--all`):**

1. **Preview before write**: after locating the section to remove, show the user the EXACT content that will be deleted (between code fences) BEFORE calling `write_file`. Do NOT abbreviate; do NOT just say "the source-type convention section". The user must see verbatim what disappears.
2. **Sidecar backup**: write a copy of the current `CLAUDE.md` to `CLAUDE.md.bak-<convention-id>-<YYYY-MM-DD-HHmmss>` (in the same vault directory) BEFORE the `write_file` that strips the section. Use `write_file` with the original full content; the timestamped name guarantees no clobber. If the backup write fails, ABORT the remove (don't continue to the destructive step).
3. **Explicit `confirm: true` on `--all`**: when the operation targets multiple vaults (`--all` or any multi-vault resolution), require an explicit `confirm: true` argument in the slash command invocation. Without it, refuse and tell the user to add `confirm: true` after they've reviewed the preview. Single-vault `remove` can proceed after preview (one vault, low blast radius).
4. **Backups are NOT auto-cleaned**. Leave the `.bak-*` files in place — they're the user's safety net. Mention their paths in the final summary so the user can rm them manually after verifying the convention removal is what they wanted.

**Failure mode policy**: if any guard fails (preview can't be rendered, backup write fails, confirm:true missing on --all), STOP for that vault. Continue with other vaults in a multi-vault operation only if their guards pass independently. Report each vault's outcome separately.

### `sync-all-vaults <convention-id>` — bulk install with smart skip

Convenience alias for `install <convention-id> --all`. Same logic, with a clearer report grouping vaults by status (online + installed, online + just-installed, offline + skipped, online + failed).

### Add a new convention to the library

1. Create `<plugin-root>/skills/conventions/snippets/<new-id>.md` with the H2 heading as first line and the convention content below.
2. Update this skill's "Mapping" table above (optional documentation).
3. The skill auto-picks it up on next invocation via `Glob`.

## Anti-patterns

- **Don't hardcode the list of conventions** — `Glob` the snippets dir every time so newly-added conventions appear automatically.
- **Don't rely on full-file equality to detect "already installed"** — users may have edited the convention content in their vault's CLAUDE.md. Match on the H2 heading only.
- **Don't auto-restart Claude or Obsidian** — the user does it. Tell them the convention takes effect at the next Claude session start (since CLAUDE.md is read at session start).
- **Don't propagate to offline vaults** — they'll fail with `ECONNREFUSED`. List them explicitly in the report so the user knows to come back later.
- **Don't strip whitespace at the section boundary on remove** — the snippet starts with `\n## H2`, the previous section probably ends with `\n\n`. Leaving the trailing newlines is fine; Obsidian renders the same.

## Examples

User: *"installe source-type sur smile"*
→ install source-type on=smile → read snippets/source-type.md → read smile's CLAUDE.md → check if "## Source provenance" present → it's not → append → report "✅ installed on smile"

User: *"liste les conventions disponibles"*
→ list (no vault specified) → glob snippets → list the 4 conventions with their identifying H2 → for default vault, check status of each

User: *"sync source-type partout"*
→ sync-all-vaults source-type → list_vaults online → loop install on each → group result by status

User: *"quelles conventions sont actives sur ce vault"*
→ list on=<current default> → check each convention's H2 presence in the CLAUDE.md → table

## Output format

Always end with a brief next-step suggestion:
- After install: *"convention takes effect on the next Claude session opened on this vault. Run `/obsidian-router:conventions list` to verify."*
- After remove: *"convention removed from N vault(s). Next Claude session on these vaults will skip the convention."*
- After list: no special suggestion, just the table.
