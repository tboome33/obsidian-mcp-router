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

`FullAuto` — auto-save everything, then surface the audit summary:

> 🔖 **Pour ce sujet** (FullAuto, X auto-saves cette session sur 5 max) :
> - ✅ wiki/decisions/<slug>.md
> - ✅ wiki/techniques/<slug>.md
> - ✅ wiki/facts.md (append)
>
> [Your usual transition question]

Wait for nothing — just inform. If the user disagrees with a save, they can edit / delete after the fact.

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

`FullAuto` — auto-save everything pending, then proceed to the new topic in the SAME response:

> ✅ Auto-saved before pivot: wiki/<...>.md, wiki/<...>.md
>
> [direct response to the new topic]

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
