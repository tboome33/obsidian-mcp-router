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

**Never answer either question by hand.** Both live in `<plugin-root>/src/helpers/claude-md-conventions.mjs`, and both were wrong before v0.94.3 — measurably so:

```javascript
import {
  resolveClaudeMd, detectConventions, findConventionSection,
  isConventionInstalled, removeConvention, verifyRemoval, planConventionPicker,
} from '<plugin-root>/src/helpers/claude-md-conventions.mjs';
```

Two rules the helper enforces and a hand-rolled check does not:

1. **Fence-aware.** A `## ` line inside a fenced code block is an example, not a heading. The `bilingual` and `path-disambiguation` snippets both DISPLAY `## ` lines inside a ```` ```markdown ```` block. A `content.includes("## <heading>")` test reports a convention that is merely quoted as installed; a cut that stops at "the next `## `" stops inside the example, leaves two thirds of the section behind, and severs the fence — which swallows the rest of the document at render time. That happened on a real vault on 2026-09-11.
2. **Exact identity, never resemblance.** `## Bilingual convention (FR + EN, FR primary) — mes ajouts` is the USER's section, not the convention. A prefix or substring match calls it installed, and `remove` then deletes their writing. Matching is exact after trimming and stripping ATX closing hashes (`## Foo ##` is `Foo`), at column 0, **and at the identity's own level**: a `# ` H1 spelled like a convention is a document title, and treating it as the convention makes its "section" run to the end of the file.

A convention's section runs from its heading to the next heading **of the same level or higher** — its own `###` subsections belong to it, and an `#` H1 below ends it. Identity is narrow, the boundary is wide: a heading the user indented, or wrote setext-style (underlined with `===`), still stops the cut. A missed boundary deletes more than the convention.

**The scanner has one documented blind spot**: fences are tracked at column 0 only, so a heading-looking line inside an INDENTED fenced block is read as a heading. Every attempt to widen that broke a witness from the v0.92.0 lot (a scanner that opens a fence it cannot close hides the rest of the file). A repository test scans the whole snippet library and fails if such a line ever appears there. If you meet one in a user's `CLAUDE.md`, say so and stop — do not cut.

## Where the vault's conventions file lives

There is no single path. The fleet audit that produced `CLAUDE_MD_CANDIDATES` found three, and they are searched in this order:

1. `CLAUDE.md` — the standard Claude Code location
2. `wiki-meta/CLAUDE.md`
3. `Documentation/CLAUDE.md` — what the reference template ships

**This matters more than it looks.** A vault provisioned from the template has `Documentation/CLAUDE.md` and NO root file. A naive `get_file("CLAUDE.md")` 404s, the skill concludes "not installed", and `install` appends a SECOND conventions file at the root — two sets of rules, one of which nobody reads.

So: probe the candidates (one `list_files` on the vault root, plus `wiki-meta/` and `Documentation/` if present), pass what exists to `resolveClaudeMd`, and use its answer for `install`, `remove` AND `list`. When two candidates exist it returns `ambiguous: true` **and `path: null`** — there is nothing to act on by design; name the files in `present` to the user and let them choose. If nothing exists, create at `createAt` (the vault root) and say where you put it.

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
| `log-discipline.md` | `log-discipline` | `## Log discipline — index mince + détail dans wiki-meta/Sessions/` |
| `prompt-status.md` | `prompt-status` | `## Prompt lifecycle — \`status\` frontmatter on \`type: prompt\` pages` |

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
4. For each vault: resolve its conventions file (see above), read it, and call `detectConventions(content, catalogue)` with the globbed library. Mark ✅ or ❌ from `installed`. A vault with no conventions file at all is "nothing installed", not an error.
5. Render as a markdown table, and name the file each column was read from — on a fleet where the path differs per vault, a status table that hides which file it read is a status table nobody can check.

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
   - Resolve its conventions file and read it via `get_file`
   - `isConventionInstalled(content, heading)` → if true, SKIP and report "already in place"
   - If false, `append_to_file` with the snippet content, prefixed by `\n` to ensure section separation
4. Report a summary: `N installed, M already in place, K failed`.

**Say "already in place", never "installed", for a skip.** Reported per file, "already installed" reads as a benign detail; reported as a total, it reads as "your configuration was applied". A run that installed nothing must say so in the first line — a user who picked six conventions and got six no-ops believes they configured a vault that was already configured for them.

### `remove <convention-id> [on <vault>] [--all]` — strip a convention

1. Same snippet resolution as install.
2. Same vault resolution.
3. For each target vault:
   - Resolve its conventions file and read it via `get_file`.
   - `findConventionSection(content, heading)` — if `found` is false, SKIP and report "not installed".
   - The section it returns IS the boundary: heading line through the line before the next heading of the same level or higher (or EOF). Do NOT re-derive it by scanning for `## ` yourself; that rule is what destroyed a file on 2026-09-11.
   - `removeConvention(content, heading)` — and **read its `reason`**. It refuses rather than guessing: `not-installed`, `duplicate-identity` (the heading appears more than once), `no-such-occurrence`. On a duplicate, show the user every occurrence with its line number (`lines`) and ask which is theirs; cutting the first copy blind would report success on a file where the convention is still installed. Their answer goes straight back in — `removeConvention(content, heading, { occurrence: 2 })` — and the verification below is then told `expectAbsent: false`, because a copy is meant to remain. A refusal you cannot answer would be a dead end.
   - **MANDATORY backup before write** (IMP-4 from `/review+` 2026-05-21) — see "Safety guards" below.
   - **Verify the proposed content BEFORE writing it**, with the helper, not by eye:
     ```javascript
     const { ok, problems } = verifyRemoval({ before, after, heading, catalogue });
     ```
     Its primary question is strict: is the result exactly `before` with the located byte range removed? Anything else — a trimmed seam, an edited preamble, a swallowed personal section — fails, including damage to text no catalogue knows about. It then asks a second, independent question: is every convention that was installed *before* still installed with byte-identical text? (That one catches a range located wrongly, since a severed fence hides everything below it.) If `ok` is false, ABORT and show `problems`. Do not invent your own check — counting fence lines for parity, the obvious invention, is not a balance test (a four-backtick block may legitimately contain a literal triple-backtick line).
   - Then `write_file` with the verified content.
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

### `pick` — the state-aware picker (what `meta-attach-vault` delegates to)

A picker that has not read the target is a picker that lies. Before showing anything:

1. Resolve and read the vault's conventions file (empty string if there is none).
2. `detectConventions(content, catalogue)` → the real state.
3. Show every option with the installed ones **already checked** and labelled *"déjà en place"* / *"already in place"*. That single change removes the whole first defect: the user stops "choosing" things that are already there.
4. Feed the answer to `planConventionPicker({ content, catalogue, selected })`, which sorts every convention into four buckets:

| bucket | meaning | action |
|---|---|---|
| `install` | checked, absent | append the snippet |
| `keep` | checked, present | nothing — report "already in place" |
| `remove` | **unchecked, present** | **ask** (see below) |
| `skip` | unchecked, absent | nothing, silently |

5. Print `plan.plan` **before acting** — it counts intentions, and says so. Report `plan.unknown` if the answer named an id the library does not ship, and `plan.duplicates` if a convention appears twice in the file. The CLOSING summary of the run is built from what actually happened (installed / already in place / removed / **declined** / failed), never from the plan: a user who declined both removals must not be told "2 to remove".

**The catalogue you plan with must be exactly the options you displayed.** If the library ships a ninth convention and the picker only showed eight, the ninth lands in `remove` — and the confirmation then says "you did not check these" about a checkbox the user never saw. One collection, displayed and planned.

**The `remove` bucket is the whole point, and it is an INTENTION, not an action.** Unchecking is ambiguous — it can mean "do not install this" as easily as "delete what is there" — so resolve it by asking, never by guessing in either direction:

> Ces conventions sont **déjà présentes** dans le fichier de conventions du vault (`Documentation/CLAUDE.md`) et tu ne les as pas cochées : `bilingual`, `auto-enrichment`. Je retire leurs sections de ce fichier ? (elles restent en place si tu dis non)

On a yes, go through `remove` in full — verbatim preview, sidecar backup and `verifyRemoval` included. On a no, say that **their sections stay in this file**. What must never happen again is the third possibility: saying nothing, and leaving a rule the user believes they turned off governing the vault. `auto-enrichment` governs automatic saves.

**Say what you are actually doing: removing a section from THIS file.** Several of these conventions also exist in the user's global `~/.claude/CLAUDE.md`; deleting the vault's local copy does not switch the global rule off, and a session already open will not see the change either (conventions are read at session start). Nothing here observes whether a rule is *in force* — only what a file contains. Promising "désactivée" when you delivered "retirée de ce fichier" is the same class of lie as reporting a skip as an install.

### Add a new convention to the library

1. Create `<plugin-root>/skills/conventions/snippets/<new-id>.md` with the H2 heading as first line and the convention content below.
2. Update this skill's "Mapping" table above (optional documentation).
3. The skill auto-picks it up on next invocation via `Glob`.

## Anti-patterns

- **Don't hardcode the list of conventions** — `Glob` the snippets dir every time so newly-added conventions appear automatically.
- **Don't rely on full-file equality to detect "already installed"** — users may have edited the convention content in their vault's CLAUDE.md. Match on the H2 heading only.
- **Don't read "already installed" as "up to date".** They are different questions, and the gap between them is measurable: on 2026-09-11, five of the eight conventions installed in the reference vault had drifted from their snippets, two of them losing a whole rule. `install` is right to skip a present section — silently rewriting a user's edits would be worse — but say *"present; not compared"* rather than letting a skip read as agreement. The comparison is a separate, read-only check (`src/helpers/convention-drift.mjs`, and `wiki-lint`'s Check Q); it reports which lines differ and never decides which side is right, because drift runs in both directions — one snippet is deliberately anonymised for distribution, and one vault-side copy is deliberately newer than its snippet.
- **Don't detect with `includes()` and don't cut at "the next `## `"** — both ignore fenced blocks, and the snippets contain fenced `## ` examples. Use `claude-md-conventions.mjs` for both.
- **Don't assume the conventions file is at the vault root** — resolve it. The template ships it under `Documentation/`, and guessing wrong creates a second one.
- **Don't report a skip as an install, and don't let an unchecked-but-present convention pass in silence** — those are the two halves of the same lie, and the second one leaves a rule running that the user thinks they turned off.
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
