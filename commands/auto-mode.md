---
description: Set the wiki auto-enrichment mode for the current session — `ClaudeAsk` / `Hybrid` / `FullAuto` / `off`. Pass "persist" to write the choice to the workspace `.env`, except for `FullAuto`, which no workspace file may set (the mode still applies to the session). (Skill `auto-mode` handles natural-language triggers + mode decision rules.)
---

Invoke the `auto-mode` skill.

Required: the mode to switch to (one of `ClaudeAsk`, `Hybrid`, `FullAuto`, `off`, or an alias like `ask` / `auto` / `semi` / `none`).

Optional: `persist` (default false) — when true, writes `OBSIDIAN_ROUTER_AUTO_ENRICH=<mode>` to `<cwd>/.env` so the choice survives a Claude Code restart. **Not for `FullAuto`**: since v0.89.0 the router does not read that mode back from a workspace file, so it is not written to one either — the mode applies to the session and the result carries `persistRefused` naming the two places it does survive a restart (the MCP host's server declaration, or your shell profile). That is a normal result, not a failure: do not retry.

The skill handles:
- Argument parsing (bare mode, `<mode> --persist`, aliases, conversational phrasing)
- Mode-decision rules (when each of the 4 modes is the right pick)
- Disambiguation of phrases like *"stop asking me"* that could map to multiple modes
- Homedir refusal when persisting from `~` (in-memory still applies)
- The `FullAuto` persist refusal, and how to read a non-null `autoEnrichModeRefused` on `list_vaults`
- Confirmation message after the switch
