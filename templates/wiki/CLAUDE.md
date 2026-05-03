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

## Auto-enrichment (Phase 0 — `ClaudeAsk` mode)

Proactive save suggestions during conversations bound to this vault. Mode is hardcoded `ClaudeAsk`: Claude proposes candidates, the user always confirms before any save executes. Domain-agnostic — works for development, personal life, research, family planning, anything.

### Activation conditions

Active ONLY when BOTH are true:

1. **The current Claude session is bound to this vault** — workspace `.env` contains `VAULT_PATH` matching this vault's path, OR `OBSIDIAN_ROUTER_DEFAULT_VAULT` matches this vault's name, OR the user explicitly opted in this session ("track this in <vault>", "prends des notes dans mon vault").

2. **The user has not turned tracking off** for this session ("no tracking", "pas de notes cette fois", "skip wiki").

If either condition fails → ignore this entire section. Make NO save proposals.

### Three triggers

#### Trigger 1 — Validation (light, inline pin)

Recognize when the user explicitly validates a decision, preference, rule, or architectural choice.

**Signals**:
- Words: *"oui"*, *"yes"*, *"OK"*, *"valide"*, *"j'approuve"*, *"go"*, *"parfait"*, *"exactement"*, *"agreed"*, *"right"*, *"✓"*
- Numbered patterns: *"Décision 1: X / Décision 2: Y"*, *"1. ... 2. ..."*
- Choice with reasoning: *"on part sur X parce que Y"*, *"I'll go with X because Y"*

**Action**: append a discrete inline marker AT THE END of your next response, on its own line:

> 🔖 [pin: <type>/"<one-line summary>"]

Valid types: `decision`, `preference`, `rule`, `adr`.

DO NOT interrupt the user. Markers accumulate in your context until the next Trigger 2 or 3 fires.

#### Trigger 2 — Result obtained (digest at the natural transition)

Recognize when an action sequence has succeeded.

**Signals**:
- A git commit + push completed (you yourself just produced "Pushed to ...")
- A test suite went green
- A deploy / publish / build succeeded
- A file was created / updated successfully
- The user expressed explicit satisfaction at a delivered result (*"ça marche"*, *"nickel"*, *"perfect"*, *"yes that's right"*) AFTER an action sequence (not after a simple Q&A)

**Action**: co-locate the digest with your natural "what's next?" prompt. Format:

> 🔖 **Candidats wiki pour ce sujet** :
> - [1] **<type>** — "<one-line title>" (path : `wiki/<folder>/<file>.md`)
> - [2] **<type>** — "..."
>
> Save lesquels ? ("all", "none", numéros, ou "skip")
>
> [Your usual transition question, e.g. "On continue avec X ?"]

Wait for the user's selection before any save action.

When user confirms a save:
- `decision` / `adr` / `rule` → `mcp__obsidian-router__write_file` to `wiki/decisions/<slug>.md`, `wiki/adr/<slug>.md`, or `wiki/rules/<slug>.md` with proper frontmatter (date, type, related)
- `technique` → `wiki/techniques/<slug>.md`
- `fact` → append to `wiki/facts.md`, or create `wiki/facts/<topic>.md` for substantial facts
- `preference` → append to `wiki/preferences.md`
- `url` → invoke `/obsidian-router:wiki-ingest <url>`

After saves, append a 1-line entry to `wiki/log.md` per the existing pattern.

#### Trigger 3 — Topic switch (mandatory checkpoint)

Recognize when the user pivots to a new topic without closing the previous one.

**Signals**:
- Words: *"autre question"*, *"sinon"*, *"by the way"*, *"passons à"*, *"et maintenant"*, *"ah au fait"*, *"tiens autre chose"*, *"anyway"*
- Abrupt change of domain / subject without an explicit close

**Action**: DO NOT respond directly to the new topic yet. Pause first:

> Avant qu'on attaque <résumé du nouveau sujet>, je propose de saver de <résumé du sujet précédent> :
> - [1] **<type>** — "..."
> - [2] **<type>** — "..."
>
> Save lesquels avant de continuer ? ("all", "none", numéros, ou "skip")

This pause is **mandatory** even if no markers were accumulated — it serves as a graceful checkpoint, marking the cognitive pivot for the user. After their response, then proceed to the new topic.

### NEVER suggest saves if

- The current sub-topic is **not ripe** — tests not green, doubt unresolved, work in flight
- You are in **active brainstorming / exploration / drafting mode** — the user is thinking out loud, the content is still moving
- The conversation contains **markers of sensitive content** — client names, identifiers, tokens, credentials, financial details, personal medical info

When in doubt, do NOT propose. Wiki noise (false positives) is worse than missed saves (false negatives) — you can always invoke `/save` manually later.

### Rate limit

- Validation pins (Trigger 1): unlimited (lightweight, inline, no interruption)
- Digests (Triggers 2 and 3): max 1 every 8 turns of the conversation. If a digest just fired, accumulate new markers but do not propose another digest until 8+ turns later.

### Phase 0 scope

Mode is hardcoded `ClaudeAsk` — always present candidates and wait for user choice. Never auto-execute. Phase 1 will add: persistent mode flag in `.env`, `/obsidian-router:auto-mode` slash command, `Hybrid` mode (auto-save type-safe items like facts/URLs, ask on decisions/ADRs), `FullAuto` with audit log + sensitivity filter.
