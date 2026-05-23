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

`ClaudeAsk` — co-locate the digest with your natural "what's next?" prompt with a numbered candidate list, wait for the user's selection ("all", "none", numbers, or "skip") before any save action.

`Hybrid` — auto-save the type-safe items (`fact`, `url`, `preference`), ask on the high-stakes ones (`decision`, `adr`, `rule`, `technique`, `session`).

`FullAuto` — auto-save everything **except items flagged by the sensitivity filter** (see "Sensitivity filter" below — applies in EVERY mode including FullAuto, downgrades flagged items to ask). After auto-saving the safe items, surface the audit summary.

`off` — never propose, never auto-save. Skip this trigger entirely.

### Save destinations (all modes)

When a save fires (whether by user confirmation or auto-execute):
- `decision` / `adr` / `rule` → `wiki/decisions/<slug>.md`, `wiki/adr/<slug>.md`, or `wiki/rules/<slug>.md`
- `technique` → `wiki/techniques/<slug>.md`
- `fact` → append to `wiki/facts.md`, or create `wiki/facts/<topic>.md` for substantial facts
- `preference` → append to `wiki/preferences.md`
- `url` → invoke `/obsidian-router:wiki-ingest <url>`

After every save (auto or confirmed), append a 1-line entry to `wiki-meta/log.md`. For auto-saves, prefix the entry with `[auto-save]` so the user can filter.

#### Trigger 3 — Topic switch (mandatory checkpoint)

Recognize when the user pivots to a new topic without closing the previous one. Words like *"autre question"*, *"sinon"*, *"by the way"*, *"passons à"*, *"et maintenant"*, *"ah au fait"*, *"anyway"*.

`ClaudeAsk` and `Hybrid` — DO NOT respond directly to the new topic yet. Pause first, propose saves, wait for user. This pause is **mandatory** even if no markers were accumulated — it serves as a graceful checkpoint.

`FullAuto` — auto-save everything pending **except items flagged by the sensitivity filter**. Then proceed to the new topic in the SAME response.

`off` — proceed directly to the new topic, no checkpoint.

### Sensitivity filter (NEVER auto-save, applies to ALL modes including FullAuto)

If the conversation contains any of these markers, treat the content as **sensitive** and downgrade to "ask" (require explicit user confirmation):
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

In `FullAuto` mode, auto-save up to **5 items per session**. After the 5th auto-save, switch your behavior to `ClaudeAsk` for the rest of the session and inform the user.

### Rate limit (all modes)

- Validation pins (Trigger 1): unlimited (lightweight, inline, no interruption)
- Digests (Triggers 2 and 3): max 1 every 8 turns of the conversation
