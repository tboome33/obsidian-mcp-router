---
name: Bug report
about: Something isn't working as documented
title: '[bug] '
labels: bug
---

## What happened

<!-- One or two sentences. -->

## What you expected

<!-- One or two sentences. -->

## Repro steps

1.
2.
3.

## Environment

- Router version: <!-- `obsidian-mcp-router --version` -->
- Plugin version: <!-- check `~/.claude/settings.json` `enabledPlugins` entry -->
- Node version: <!-- `node --version` -->
- OS: <!-- Windows 11 / macOS 14.5 / Ubuntu 24.04 / etc. -->

## Router stderr

<!--
Run the router directly (`obsidian-mcp-router` from a terminal) and paste the
stderr output. The boot line shows vault count, lock state, auto-enrich mode.
Remove any sensitive paths/keys before pasting.
-->

```
paste stderr here
```

## Config (redacted)

<!--
If relevant, paste a redacted copy of `~/.claude/obsidian-mcp-router/config.json`.
Replace API keys with `<redacted>` and remote vault URLs with `https://example.com`.
-->

```json
paste here
```

## Additional context

<!-- Anything else that might help. Vault size, plugin combinations, network
topology for remote vaults, etc. -->
