---
description: Interactive wizard to attach an Obsidian vault to a code/dev workspace (the common case), bootstrap a standalone vault, or register a remote vault. Provisions plugins + scaffolds wiki structure + binds .env + edits .gitignore + offers a conventions picker. (Skill `meta-attach-vault` handles natural-language triggers.)
---

# meta-attach-vault

Interactive wizard that bundles the full setup of an Obsidian vault for use with obsidian-mcp-router. The dominant case is **workspace-first**: you're in a code/dev project (with or without `.git/`), and you want a vault attached to it for documentation/notes — the vault lives OUTSIDE the workspace, the workspace's `.env` gets a binding line, and your `.gitignore` is updated to protect credentials.

> 🔗 **Vault already registered? Skip the wizard.** `obsidian-mcp-router --attach <slug> [--also <slug>]...` (run from the workspace) does the four workspace writes in one idempotent command — `.env`, `.claude/settings.json` (the plugin toggle, without which the `.env` is inert), a `CLAUDE.md` block naming the vaults, `.gitignore`. Nothing is provisioned. The skill's Step 0.0 short-circuits here automatically.

Three flows, one wizard:

1. **Workspace-first** (common) — vault attached to the current code workspace via `OBSIDIAN_ROUTER_DEFAULT_VAULT` in `.env`. Default vault path: `C:\VAULTS\<basename-cwd>`.
2. **Standalone vault** (rare) — vault not tied to any project (personal journal style).
3. **Remote vault** — vault already runs elsewhere (NAS, VPS, Cloudflare Tunnel), just needs registration.

The skill is **didactic by design**: every Bash call is preceded by a 2-3 line explanation of what's about to happen, and Bash descriptions are full sentences in plain language (not cryptic command labels).

## What the wizard does

For the workspace-first flow (Roland's ~95% case):

1. Detects context (cwd has `.git/`? `.obsidian/`? `OBSIDIAN_ROUTER_DEFAULT_VAULT` already set?).
2. If no `.git/` in the workspace, **explains what git is for** (in plain words: versioning, secrets protection, sharing) and offers `git init`.
3. Proposes a default vault path (`C:\VAULTS\<basename-cwd-as-is>`), modifiable.
4. Runs `setup-vault.mjs <vault-path> --link-workspace <cwd>` (single call, single permission prompt) to: install 5 plugins, allocate a port, generate an API key, **scaffold the wiki structure (`wiki/`, `wiki/sessions/`, 4 `wiki-meta/` files)**, write `.env` and `.mcp.json`, register in the router config, AND bind the workspace to the vault via `OBSIDIAN_ROUTER_DEFAULT_VAULT` in `<cwd>/.env`.
5. Edits the workspace's `.gitignore` to add `.env` and `.mcp.json` under a marker comment (idempotent).
6. **Conventions picker** via `AskUserQuestion multiSelect`: the 8 installable conventions (`roadmap-discipline`, `default-vault-health-check`, `wiki-query-first`, `path-disambiguation` pre-checked; `source-type`, `bilingual`, `heading-hierarchy`, `auto-enrichment` opt-in). Installs via `/obsidian-router:conventions install <id>` so the H2-heading idempotency guard fires.
7. Final reminders: open the vault in Obsidian (with the `openUri` from `list_vaults` — pre-encoded for spaces/accents) + restart Claude Code in this workspace.

For standalone and remote flows, see the skill body (`skills/meta-attach-vault/SKILL.md`).

## When to invoke

Triggers (EN): *"set up Obsidian for this project"*, *"attach a vault to this workspace"*, *"add a vault to the router"*, *"register a new obsidian vault"*, *"create a wiki for this repo"*, *"connect my remote vault"*, *"bootstrap a personal vault"*.

Triggers (FR): *"configure Obsidian pour ce projet"*, *"attache un vault à ce workspace"*, *"ajoute un vault au router"*, *"enregistre un nouveau vault obsidian"*, *"crée un wiki pour ce repo"*, *"connecte mon vault distant"*, *"bootstrap un vault perso"*.

## Replaces `meta-add-vault` (v0.12.7+)

Renamed in v0.12.7 to reflect that the dominant case is workspace-attachment, not raw vault registration. Old triggers still work — the skill's natural-language triggers list includes everything `meta-add-vault` used to match.

## See also

- [`/obsidian-router:meta-setup`](./meta-setup.md) — first-time install of the router itself (clone repo, register as MCP, run before this skill on a fresh machine).
- [`/obsidian-router:meta-status`](./meta-status.md) — diagnose router + all vaults (run after this skill to verify the attach worked).
- [`/obsidian-router:meta-sync-template`](./meta-sync-template.md) — push reference vault changes (new plugins, snippets) to existing attached vaults.
- [`/obsidian-router:conventions`](./conventions.md) — install/remove/list conventions standalone (used internally by this skill for the conventions picker).
