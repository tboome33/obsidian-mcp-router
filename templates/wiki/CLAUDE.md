## Wiki Knowledge Base

Path: {{VAULT_PATH}}

When you need context not already in this conversation:

1. Read `wiki/hot.md` first (cheap, recent context).
2. If hot.md doesn't cover it, read `wiki/index.md` to find the relevant page.
3. Drill into specific wiki pages.
4. After substantive work, append a 1-line entry to `wiki/log.md`.
5. After substantive work, refresh `wiki/hot.md` with the latest state.

**Always use the `obsidian-router` MCP tools for vault reads/writes** (`mcp__obsidian-router__get_file`, `mcp__obsidian-router__write_file`, `mcp__obsidian-router__patch_file`, etc.) — they're the multi-vault aware path and work cross-project. Do NOT use Claude's native `Read`/`Write` for vault content; those work only when the project IS the vault.

**Available wiki workflows** (slash commands or natural language):
- `/obsidian-router:wiki-ingest <source>` — file a source
- `/obsidian-router:wiki-query <question>` — answer from the wiki
- `/obsidian-router:save` — file the current conversation
- `/obsidian-router:wiki-lint` — health check
- `/obsidian-router:wiki-fold` — roll up the log
- `/obsidian-router:autoresearch <topic>` — autonomous research loop
- `/obsidian-router:canvas` — visual canvas operations

The wiki pattern (Karpathy LLM-wiki) is documented in `wiki/overview.md`.

---

## Note structure — headings hierarchy (mandatory for every page)

Every wiki page MUST use a proper heading hierarchy so the Outline plugin can navigate it. This is not optional — it's the only way the user can scan a note without scrolling.

- **Exactly one `# H1`** at the top — matches the note's `title:` frontmatter (or a clean rephrasing of the filename). The H1 is the note's name. If the body needs to start with prose, put the `# H1` line ABOVE that prose anyway.
- **`## H2`** — main sections (Context, Decision, See also, etc.). Use these to chunk the body.
- **`### H3`** — sub-sections inside an `## H2`. Only when a section is long enough to need internal navigation.
- **Never skip levels.** No `### H3` without a `## H2` above it. No `#### H4` without an `### H3`.
- **Length rule.** Any note > 200 words MUST have at least 2 `## H2` sections. Outline navigation depends on this — a wall of text with only an H1 defeats the whole point.

### Type-specific minimums

When generating content of these types, use AT LEAST these `## H2` sections (add more if the content warrants):

| Type | Required `## H2` sections |
|---|---|
| `session` | `## Prompt`, `## What happened`, `## Outcome`, optional `## See also` |
| `answer` | `## Question`, `## Answer`, optional `## See also` |
| `decision` / `adr` | `## Context`, `## Decision`, `## Consequences`, optional `## Alternatives considered` |
| `technique` / `runbook` | `## Prerequisites`, `## Steps`, `## Gotchas`, optional `## See also` |
| `idea` | `## The idea`, `## Why it matters`, `## Concrete first step` |
| `fact` (standalone page > 100 words) | `## What`, `## Why it matters`, `## Source` |
| `person` | `## Context`, `## Notes`, `## Interactions` |
| `concept` | `## Definition`, `## Why it matters`, `## Related` |
| `reference` / `url` ingestion | `## Summary`, `## Key takeaways`, `## Source` |
| `project` | `## Goal`, `## Status`, `## Open questions`, optional `## Log` |

### Anti-patterns to refuse

- Don't dump a wall of paragraphs under a single `# H1`. If the content can't be split into 2 `## H2` sections, the note is probably either too short (file it as a one-liner in `wiki/facts.md` instead) or the wrong granularity (split into 2 notes).
- Don't start at `## H2` thinking the filename "serves as H1" — Outline still needs the explicit `# H1` for the top-level anchor.
- Don't use **bold** as a faux-heading. Bold text doesn't appear in Outline.

### How skills enforce this

`save`, `wiki-ingest`, `wiki-query --persist`, and `autoresearch` are all expected to apply this structure when generating content. If a user's input is genuinely too thin to support 2 H2 sections, the skill should push back: *"This conversation is too brief for a standalone page — append as a line to `wiki/facts.md` instead?"* — rather than producing a flat single-section note that defeats Outline.

---

## Source provenance — `source_type` frontmatter (mandatory for substantive pages)

Every substantive page MUST declare where its content came from. Without this, a reader (you, me, future-Claude, or a wiki-query consumer) cannot tell whether an assertion is a verbatim citation, a reasonable inference from a source, or pure synthesis by Claude. That gap silently erodes trust in the whole wiki.

Three values, vocabulary borrowed from graphify's `EXTRACTED / INFERRED / AMBIGUOUS` taxonomy (`validate.py:1-7`):

| Value | Meaning | When to use |
|---|---|---|
| `extracted` | Verbatim or near-quote from a source (a user statement, an article, a pasted document). Maximum reliability — a reader can trust the wording came from outside. | `wiki-ingest` source pages; user-quoted statements; literal citations. |
| `inferred` | Claude derived this by reading the source/conversation, but it isn't written verbatim. Medium reliability — it's a reasonable interpretation that someone else might have phrased differently. | Most `answer` notes; most `wiki-ingest` entity/concept pages spawned from a source; summaries. |
| `claude_synthesized` | Pure synthesis by Claude with no direct textual basis. Low reliability for "what does the source say?" but full agency on "what does Claude think?". | `idea` notes proposed by Claude; framings/restatings; opinion pieces. |

### Where to declare it

- **Frontmatter level** (covers the whole page): `source_type: extracted | inferred | claude_synthesized`. Required on every page of type `source`, `answer`, `decision`, `decision-input`, `reference`, `reference-deep-dive`, `technique`, `idea`. Optional but encouraged on `session`, `concept`, `entity`.
- **Inline callout** (covers a specific paragraph, overrides the page-level default): `> [!extracted]`, `> [!inferred]`, `> [!claude_synthesized]`. Use when a single page mixes provenance — common for `session` notes (user verbatim + your inferences + your synthesis) and for `wiki-ingest` entity pages.

### Rule of thumb when in doubt

Prefer the more conservative tag. `claude_synthesized` over `inferred`, `inferred` over `extracted`. False humility is cheap; false confidence corrodes the wiki.

### How skills use it

- `wiki-ingest` writes `source_type: extracted` on source pages (the body summarises the source faithfully) and `source_type: inferred` or `claude_synthesized` on spawned entity/concept pages depending on how directly the source supported them.
- `save` writes the dominant `source_type` based on what's being saved (see skill for matrix).
- `wiki-query` includes provenance in its citations: *"per [[my-note]] (extracted)"* vs *"per [[my-note]] (synthesized)"* — so readers know whether the answer is grounded or speculative.
- `wiki-lint` (future) flags pages with high `claude_synthesized` ratio for human review.

### Not yet — `confidence_score`

graphify also assigns a discrete float (0.55 / 0.65 / 0.75 / 0.85 / 0.95) on top of the three-bucket tag. For a markdown wiki the three buckets carry most of the value; the float is deferred until a real use case proves it's worth the per-claim labelling cost.

---

## Auto-enrichment (4 modes — `ClaudeAsk` / `Hybrid` / `FullAuto` / `off`)

Proactive save suggestions during conversations bound to this vault. Domain-agnostic — works for development, personal life, research, family planning, anything.

### Reading the current mode

Call `mcp__obsidian-router__list_vaults` once at session start (or at the first auto-enrichment-relevant moment). The response field `autoEnrichMode` is one of:

- `"ClaudeAsk"` — propose, user always confirms (the safe default)
- `"Hybrid"` — auto-save type-safe items, ask on high-stakes
- `"FullAuto"` — auto-save everything (with safety nets, see below)
- `"off"` — no auto-suggestions; manual `/save` only

The mode can change mid-session via `/obsidian-router:auto-mode <Mode>`. Re-check `list_vaults` if the user invokes that command — apply the new mode from that point forward.

### Activation conditions

Even when the mode is non-`off`, auto-enrichment is active ONLY when BOTH are true:

1. **The current Claude session is bound to this vault** — workspace `.env` contains `VAULT_PATH` matching this vault's path, OR `OBSIDIAN_ROUTER_DEFAULT_VAULT` matches this vault's name, OR the user explicitly opted in this session ("track this in <vault>", "prends des notes dans mon vault"), OR the conversation runs inside a Claude Desktop Project bound to this vault.

2. **The user has not turned tracking off** for this session ("no tracking", "pas de notes cette fois", "skip wiki").

If either condition fails → ignore this entire section. Make NO save proposals, regardless of the mode value.

If `autoEnrichMode === "off"` → also ignore this section entirely. The user has explicitly disabled the proactive layer; only respond to manual `/save`, `/wiki-ingest`, etc.

### Three triggers

#### Trigger 1 — Validation (light, inline pin)

Recognize when the user explicitly validates a decision, preference, rule, or architectural choice.

**Signals**:
- Words: *"oui"*, *"yes"*, *"OK"*, *"valide"*, *"j'approuve"*, *"go"*, *"parfait"*, *"exactement"*, *"agreed"*, *"right"*, *"✓"*
- Numbered patterns: *"Décision 1: X / Décision 2: Y"*, *"1. ... 2. ..."*
- Choice with reasoning: *"on part sur X parce que Y"*, *"I'll go with X because Y"*

Valid types for validation pins: `decision`, `preference`, `rule`, `adr`.

**Action by mode**:
- `ClaudeAsk` and `Hybrid`: append a discrete inline marker AT THE END of your next response, on its own line: `🔖 [pin: <type>/"<one-line summary>"]`. Markers accumulate until Trigger 2 or 3.
- `FullAuto`: pin AND immediately auto-save IF the type is `decision` or `preference` and the content passes the sensitivity filter. For `rule` and `adr`, still pin and accumulate (these have higher stakes — defer to the digest where the user can review the wording even in FullAuto).

DO NOT interrupt the user with a question. Pinning is silent.

#### Trigger 2 — Result obtained (digest at the natural transition)

Recognize when an action sequence has succeeded.

**Signals**:
- A git commit + push completed (you yourself just produced "Pushed to ...")
- A test suite went green
- A deploy / publish / build succeeded
- A file was created / updated successfully
- The user expressed explicit satisfaction at a delivered result (*"ça marche"*, *"nickel"*, *"perfect"*, *"yes that's right"*) AFTER an action sequence (not after a simple Q&A)

**Action by mode**:

`ClaudeAsk` — co-locate the digest with your natural "what's next?" prompt:

> 🔖 **Candidats wiki pour ce sujet** :
> - [1] **<type>** — "<one-line title>" (path : `wiki/<folder>/<file>.md`)
> - [2] **<type>** — "..."
>
> Save lesquels ? ("all", "none", numéros, ou "skip")
>
> [Your usual transition question, e.g. "On continue avec X ?"]

Wait for the user's selection before any save action.

`Hybrid` — auto-save the type-safe items, ask on the high-stakes ones:

> 🔖 **Pour ce sujet** :
> - ✅ **Auto-saved** : facts/<slug>.md, urls fetched (type-safe, low stakes)
> - **À confirmer** :
>   - [1] **decision** — "..." (path : `wiki/decisions/...`)
>   - [2] **technique** — "..."
>
> Confirmer lesquels ? ("all", "none", numéros, ou "skip")

Auto-save policy in `Hybrid`:
- **Auto-save** types: `fact`, `url`, `preference`
- **Ask** types: `decision`, `adr`, `rule`, `technique`, `session`

`FullAuto` — auto-save everything **except items flagged by the sensitivity filter** (see "Sensitivity filter" section below — applies in EVERY mode including FullAuto, downgrades flagged items to ask). After auto-saving the safe items, surface the audit summary:

> 🔖 **Pour ce sujet** (FullAuto, X auto-saves cette session sur 5 max) :
> - ✅ wiki/decisions/<slug>.md
> - ✅ wiki/techniques/<slug>.md
> - ✅ wiki/facts.md (append)
> - 🔒 **À confirmer** (sensitivity filter) :
>   - [1] **<type>** — "..." 🔒 reason: contains <client name | credential | financial figure>
>
> Save les items 🔒 ? ("yes", "no", numéros)
>
> [Your usual transition question]

Wait for nothing on the auto-saved items — just inform. Wait for the user's decision on the 🔒 flagged items if any. If the user disagrees with an auto-save retrospectively, they can edit / delete after the fact via `wiki/log.md` audit trail.

`off` — never propose, never auto-save. Skip this trigger entirely.

### Save destinations (all modes)

When a save fires (whether by user confirmation or auto-execute):
- `decision` / `adr` / `rule` → `mcp__obsidian-router__write_file` to `wiki/decisions/<slug>.md`, `wiki/adr/<slug>.md`, or `wiki/rules/<slug>.md` with proper frontmatter (date, type, related, mode-source: "auto" if auto-saved else "confirmed")
- `technique` → `wiki/techniques/<slug>.md`
- `fact` → append to `wiki/facts.md`, or create `wiki/facts/<topic>.md` for substantial facts
- `preference` → append to `wiki/preferences.md`
- `url` → invoke `/obsidian-router:wiki-ingest <url>`

After every save (auto or confirmed), append a 1-line entry to `wiki/log.md`. For auto-saves, prefix the entry with `[auto-save]` so the user can filter.

Example log entry for an auto-save in FullAuto:
```
- 2026-05-03 14:32 — [auto-save] decision/lock-mode-default-claude-ask.md — created (FullAuto, type=decision)
```

#### Trigger 3 — Topic switch (mandatory checkpoint)

Recognize when the user pivots to a new topic without closing the previous one.

**Signals**:
- Words: *"autre question"*, *"sinon"*, *"by the way"*, *"passons à"*, *"et maintenant"*, *"ah au fait"*, *"tiens autre chose"*, *"anyway"*
- Abrupt change of domain / subject without an explicit close

**Action by mode**:

`ClaudeAsk` and `Hybrid` — DO NOT respond directly to the new topic yet. Pause first:

> Avant qu'on attaque <résumé du nouveau sujet>, je propose de saver de <résumé du sujet précédent> :
> - [1] **<type>** — "..."
> - [2] **<type>** — "..."
>
> Save lesquels avant de continuer ? ("all", "none", numéros, ou "skip")

This pause is **mandatory** even if no markers were accumulated — it serves as a graceful checkpoint, marking the cognitive pivot for the user. After their response, then proceed to the new topic.

`FullAuto` — auto-save everything pending **except items flagged by the sensitivity filter** (which still require ask in every mode). Then proceed to the new topic in the SAME response:

> ✅ Auto-saved before pivot: wiki/<...>.md, wiki/<...>.md
> 🔒 Held back for confirmation (sensitivity filter): [1] ... [2] ...
>   → Save these too before continuing? ("yes", "no", numéros)
>
> [direct response to the new topic — only if no 🔒 items, otherwise wait]

`off` — proceed directly to the new topic, no checkpoint.

### Sensitivity filter (NEVER auto-save, applies to ALL modes including FullAuto)

If the conversation contains any of these markers, treat the content as **sensitive** and:
- In `ClaudeAsk` / `Hybrid` / `FullAuto`: do NOT auto-save. In `Hybrid` and `FullAuto`, downgrade the affected items to "ask" — present them as candidates with a 🔒 flag and require explicit user confirmation.
- Annotate the candidate with the reason (e.g., 🔒 "contains a client name").

Sensitivity markers:
- Client / customer / patient names (especially when associated with financial or medical context)
- Personal identifiers — full names + DOB, SSN, passport numbers, IBAN, account numbers
- Credentials — API keys, tokens, passwords, JWT, .env values pasted verbatim
- Financial details — sums, contract values, salary, P&L
- Medical info — diagnoses, prescriptions, lab results
- Private third-party content — emails / DMs from a person who didn't consent to being archived

### NEVER propose saves at all if

- The current sub-topic is **not ripe** — tests not green, doubt unresolved, work in flight
- You are in **active brainstorming / exploration / drafting mode** — the user is thinking out loud, the content is still moving

When in doubt, do NOT propose. Wiki noise (false positives) is worse than missed saves (false negatives) — the user can always invoke `/save` manually later.

### Hard cap (FullAuto only)

In `FullAuto` mode, auto-save up to **5 items per session**. After the 5th auto-save:
- Switch your behavior to `ClaudeAsk` for the rest of the session (new candidates require user confirmation)
- Inform the user: *"FullAuto cap reached (5 auto-saves). I'll ask for confirmation on subsequent candidates this session. Use `/obsidian-router:auto-mode FullAuto` to reset for a fresh budget."*
- The mode field on the registry is NOT changed — only your in-context behavior is. Next session starts fresh at 5.

This protects against runaway noise: a chat that spawns 50 auto-saves would poison the wiki worse than a chat that auto-saved 5 and then asked for the rest.

### Rate limit (all modes)

- Validation pins (Trigger 1): unlimited (lightweight, inline, no interruption)
- Digests (Triggers 2 and 3): max 1 every 8 turns of the conversation. If a digest just fired, accumulate new markers but do not propose another digest until 8+ turns later.

### Phase 1 scope (this version, v0.8.2)

Mode is configurable at runtime — choose `ClaudeAsk` (default), `Hybrid`, `FullAuto`, or `off` via `/obsidian-router:auto-mode <Mode>` or `OBSIDIAN_ROUTER_AUTO_ENRICH=<Mode>` in `.env`. Per-session changes via the slash command, persistent changes via `--persist`.

Phase 2 (planned): daily digest of yesterday's auto-saves at the first interaction of the day, configurable hard cap, sensitivity filter learned from past corrections.
