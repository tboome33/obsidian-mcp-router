---
name: auto-mode
description: |
  Set the wiki auto-enrichment mode for the current session — `ClaudeAsk` (default, propose + always confirm), `Hybrid` (auto-save type-safe items, ask on high-stakes), `FullAuto` (auto-save everything with safety nets), or `off` (no proactive suggestions). Pass "persist" to write OBSIDIAN_ROUTER_AUTO_ENRICH=<mode> to the workspace `.env`. Triggers on natural-language phrasings like "switch to Hybrid mode" / "passe en mode Hybrid", "save everything automatically" / "sauve tout automatiquement" → `FullAuto`, "stop auto-saving" / "arrête de sauver auto" → `off`.
---

# auto-mode

Invoke the `set_auto_enrich_mode` MCP tool.

## Modes — when to pick which

- **`ClaudeAsk`** (default — propose, always confirm). Best for: discovering the feature, mixed-importance long sessions, vaults where false positives would be costly to clean up, calibration period.
- **`Hybrid`** (auto-save type-safe items like facts/URLs, ask on decisions/ADRs/techniques/rules). Best for: power-user sweet spot after a calibration week, active development with frequent URL ingestion, research with citations to pile up but conclusions to vet.
- **`FullAuto`** (auto-save everything; audit log in `wiki/log.md` + sensitivity filter + hard cap that degrades to `ClaudeAsk` after 5 saves/session). Best for: high-trust sessions, family chronicle / personal journal, long unsupervised flows (autoresearch, batch ingestion), solo brain-dumps where the wiki IS the conversation log.
- **`off`** (no auto-suggestions; manual `/save` only). Best for: debugging sessions you don't want polluting the wiki, sensitive conversations, control-freak preference, default for legal/medical/financial vaults.

## Argument parsing from $ARGUMENTS

- bare mode name (`ClaudeAsk`, `Hybrid`, `FullAuto`, `off`) → `mode=<name>`, persist defaults to false
- `<mode> --persist` or `"permanently"` / `"persist"` / `"de manière permanente"` / `"qui survit au restart"` → `persist=true`
- `mode=X persist=true` — explicit form
- Mode aliases accepted (case-insensitive): `ask` → ClaudeAsk · `auto` / `full` / `full-auto` → FullAuto · `semi` / `semi-auto` / `hybride` → Hybrid · `none` / `disable` / `disabled` → off

## Natural-language phrase → mode mapping

When the user's intent is the BEHAVIOR rather than the mode name:

- *"demande avant de sauver"* / *"ask before saving"* → `ClaudeAsk`
- *"auto-save les trucs sûrs"* / *"auto-save the cheap stuff"* / *"automatique sauf pour les décisions"* → `Hybrid`
- *"sauve tout automatiquement"* / *"save everything automatically"* → `FullAuto`
- *"arrête de sauver auto"* / *"stop auto-saving"* / *"désactive l'auto-enrichissement"* / *"pas de notes"* → `off`

### Ambiguous phrases that require disambiguation BEFORE mapping

(do not auto-pick a mode)

- *"ne demande plus rien"* / *"arrête de me demander à chaque fois"* / *"stop asking me"* — could mean `off` (no auto-save at all) OR `FullAuto` (auto-save without asking) OR `Hybrid` (auto-save the easy stuff, ask only on the hard stuff). When the user phrases their frustration as "stop asking" rather than as a specific behavior, ASK them which they want before invoking the tool: *"You can either turn auto-save fully off, or have me auto-save without asking — which do you want?"*

## Always

- After a successful mode change, confirm to the user: which mode is now active, what changed in behavior versus the previous mode, whether the `.env` was written.
- If the user phrased it persistently (*"permanently"*, *"de manière permanente"*, *"à chaque démarrage"*) but didn't explicitly say "persist", default `persist=true` — that's clearly their intent.
- If the user phrased it temporarily (*"just for now"*, *"juste pour cette session"*, *"pour l'instant"*), default `persist=false`.
- If the user is switching to `FullAuto` for the first time in this session, briefly remind them of the safety nets (audit log in `wiki/log.md`, sensitivity filter, hard cap of 5 auto-saves/session before degrading to `ClaudeAsk`) — so they're not surprised when those trigger.
- If the user is switching to `off`, mention that manual `/save`, `/wiki-ingest`, etc. still work — only the proactive layer is disabled.

## Push back if

- The mode name is missing or ambiguous → ask with the list of valid modes plus their one-line descriptions.
- The user is in a workspace where no vault is bound (no `VAULT_PATH` in `.env`, no explicit opt-in) → tell them the mode is set but auto-enrichment will stay silent until a vault is bound. Suggest `/obsidian-router:meta-add-vault` or pasting the consigne into a Claude Desktop Project's instructions.

## Homedir refusal caveat (persist mode only)

If the user asks for a persistent mode change from their home directory (Claude Code launched from `~` rather than a project folder), the tool refuses with an explicit error and the in-memory mode still applies for the session. Surface the message verbatim — it tells them how to fix (run from a real project directory, or set `OBSIDIAN_ROUTER_AUTO_ENRICH=<mode>` in their shell profile / PowerShell `$PROFILE`). Do not retry the persist call from the same cwd.

## Examples

EN: *"switch to Hybrid mode and persist it"*
FR: *"passe en mode Hybrid de manière permanente"*
