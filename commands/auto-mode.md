---
description: Set the wiki auto-enrichment mode for the current session — `ClaudeAsk` / `Hybrid` / `FullAuto` / `off`. Pass "persist" to write the choice to the workspace `.env`. (Skill `auto-mode` handles natural-language triggers + mode decision rules.)
---

Invoke the `auto-mode` skill.

Required: the mode to switch to (one of `ClaudeAsk`, `Hybrid`, `FullAuto`, `off`, or an alias like `ask` / `auto` / `semi` / `none`).

Optional: `persist` (default false) — when true, writes `OBSIDIAN_ROUTER_AUTO_ENRICH=<mode>` to `<cwd>/.env` so the choice survives a Claude Code restart.

The skill handles:
- Argument parsing (bare mode, `<mode> --persist`, aliases, conversational phrasing)
- Mode-decision rules (when each of the 4 modes is the right pick)
- Disambiguation of phrases like *"stop asking me"* that could map to multiple modes
- Homedir refusal when persisting from `~` (in-memory still applies)
- Confirmation message after the switch
