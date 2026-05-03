---
name: Feature request
about: Suggest a new tool, slash command, or behavior
title: '[feature] '
labels: enhancement
---

## What problem does this solve

<!-- Describe the situation where the current router is insufficient. Concrete
scenario, not abstract. "When I X, the router does Y, I'd want Z because…" -->

## Proposed approach

<!-- If you have one. Otherwise leave blank — the maintainer may have a
different design in mind. -->

## Alternatives considered

<!-- Workarounds you've tried. Why they don't fit. -->

## Scope check

This feature should fit in one of these layers:

- [ ] **MCP tool** — new or extended `mcp__obsidian-router__*` tool
- [ ] **Slash command** — new `/obsidian-router:*` command (plugin side)
- [ ] **Skill** — high-level workflow (`save`, `autoresearch`, etc.)
- [ ] **Hook** — opt-in hook in `hooks/`
- [ ] **Doc / setup** — `setup-vault.mjs`, README, placement guide, etc.
- [ ] **Other** (please describe)

## Out of scope

The router is deliberately neutral. Workflow macros that bake in vault-specific conventions (daily notes templates, capture inbox layouts, weekly rollups) belong in **your** `~/.claude/commands/<name>.md`, not as PRs on this repo. See [`docs/building-commands.md`](../../docs/building-commands.md).

## Additional context

<!-- Mockups, related issues, links to similar features in other tools, etc. -->
