# Vault-creation wizard — playbook (harness-agnostic)

This is the manual an LLM agent WITHOUT a skill system (Codex, Hermes, Deepseek, a
raw MCP client…) reads to drive the guided vault-creation wizard. The Claude Code
skill [`meta-attach-vault`](../skills/meta-attach-vault/SKILL.md) is one frontend
over the same engine; this playbook is the other. **The wizard lives in the plan
DATA, not the harness** — so any agent that can call the two MCP tools (or run the
CLI) can create a fully-configured vault in one guided pass.

## Architecture (3 layers)

```
Layer 2 · Frontends   meta-attach-vault skill (Claude)  ·  THIS playbook (any harness)
Layer 1 · MCP tools   plan_vault (read-only)            ·  provision_vault (one-shot apply)
Layer 0 · Engine      scripts/setup-vault.mjs (flags, scriptable, tested)
```

Both MCP tools drive the SAME layer-0 CLI, so there is one source of truth. If the
tools are unavailable (see *Security gates* below), drive layer 0 directly.

## The flow (defaults-first)

1. **Propose a default vault path.** Convention: `C:\VAULTS\<Name>` (Windows) or
   `~/VAULTS/<Name>` (POSIX) — OUTSIDE any code workspace, so the vault's `.env`
   (which holds the API key) is never committed with the code.
2. **Call `plan_vault`** (read-only, zero mutation) to compute the complete
   default plan + the questionnaire:
   ```json
   plan_vault({ "path": "C:\\VAULTS\\MyProject", "linkWorkspace": "C:\\dev\\my-project" })
   ```
   Returns:
   - `defaults` — `{ name, slug, path, source, plugins:{profile,resolved}, theme, wikiMode, claudeWorkspace, open, probe, gitInit }`
   - `questions[]` — each `{ id, label, description, options:[{id,label,description,isDefault}] }`. Includes the **5 wiki modes with explanations**, the **themes installed in the source**, the **registered vaults you can copy config from**, and the **plugin profiles**.
   - `warnings[]` — `slug-collision`, `path-outside-known-roots`, `no-known-roots`, `theme-blocked`, `domain-no-sections`, `source-error`.
   - `steps[]` — the ordered list of what provisioning will do.
   - `context` — `{ flow, gitPresent, knownRoots, copyableVaults, availableThemes }`.
3. **Show the plan as one line** and ask the user to accept it or adjust one point:
   > Plan: vault "MyProject" → C:\VAULTS\MyProject · source: reference · plugins: recommended (7) · wiki mode: code · workspace slash-commands: yes. OK, or adjust (name / location / source / plugins / theme / wiki mode)?
4. **On adjustment**, re-call `plan_vault` with the changed args to preview the new
   plan. Present the option lists from `questions` verbatim (they carry the
   descriptions). For **wiki mode `domain`**, translate the user's one-line domain
   description into a flat `wikiMode.sections` list yourself — the engine only lays
   them out (it never runs AI).
5. **Call `provision_vault`** once with the accepted answers + the automated tail:
   ```json
   provision_vault({
     "path": "C:\\VAULTS\\MyProject", "linkWorkspace": "C:\\dev\\my-project",
     "claudeWorkspace": true,
     "source": { "kind": "reference" }, "plugins": { "profile": "recommended" },
     "wikiMode": { "mode": "code" },
     "open": true, "probe": true
   })
   ```
   Returns a step report + `port`, `insecurePort`, `openUri`, `probeResult`,
   `hooksWired: false`. `open: true` launches Obsidian; `probe: true` polls the
   REST port (expected red until the user trusts the author).
6. **Tell the user the two incompressible manual gestures**: (a) click **"Trust
   author and enable plugins"** in Obsidian; (b) **restart the harness** so it
   picks up the new vault. If the probe was red, re-run with `probe: true` after
   the Trust-author click to confirm green.

## The 5 wiki modes

| id | for | seeded index sections |
|---|---|---|
| `personal` | second brain | People, Concepts, Decisions, References, Projects |
| `research` | studying a subject | Papers, Concepts, Hypotheses, Methodology, Findings |
| `business` | a business | Competitors, Clients, Decisions, Stakeholders, Meetings |
| `code` | tied to a repo | Codebases, Architecture Decisions (ADR), Runbooks, Concepts, Sessions |
| `domain` | custom | the flat section list you pass in `wikiMode.sections` |

Default: `code` when a workspace is bound, else `personal`.

## Security gates

- **`plan_vault` + `provision_vault` are LOCAL-ONLY.** On a gated/multi-tenant
  deployment (the env var `OBSIDIAN_ROUTER_USER_ID` is set — e.g. MCPHub/Tribu),
  BOTH tools are absent from the tool list and refused if called by name.
  `provision_vault` is also a write tool, so `OBSIDIAN_ROUTER_READONLY` hides it
  too. On such a router, **there is no vault-creation path** — that's intentional
  (a shared router must never write vaults to its host). Create vaults on a local,
  non-gated router instead.
- **`provision_vault` refuses any path outside the known vault roots** (config
  `vaultsRoot` + registered vaults' parent dirs) unless you pass
  `allowOutsideRoots: true`. It is fail-closed: an empty-roots config refuses an
  arbitrary path too. `plan_vault` surfaces the same condition as a
  `path-outside-known-roots` / `no-known-roots` warning, so you can ask the user
  for the override BEFORE the write call.
- **`--from-vault` copies config only.** `workspace.json` and credentialed
  `data.json` are never copied; the REST port + API key are always regenerated.
  This holds regardless of which layer calls it.

## Fallback — drive layer 0 directly

If the MCP tools aren't available (older router, or a gated deployment where they
are hidden), run the engine. The plan shape is identical:

```bash
# Plan (read-only, JSON):
node scripts/setup-vault.mjs "C:\VAULTS\MyProject" --link-workspace "C:\dev\my-project" --dry-run --json

# Provision:
node scripts/setup-vault.mjs "C:\VAULTS\MyProject" --link-workspace "C:\dev\my-project" \
  --claude-workspace --wiki-mode code --open --probe
```

Full flag reference: `node scripts/setup-vault.mjs --help`.

### Engine flag ↔ tool-input mapping

| Tool input | CLI flag |
|---|---|
| `name` | `--name "<Display>"` |
| `source: { kind: 'from-vault', fromVault, withFolderTree }` | `--from-vault <slug\|path> [--with-folder-tree]` |
| `source: { kind: 'skeleton' }` | `--from-skeleton` |
| `source: { kind: 'bare' }` | `--bare` |
| `plugins: { profile, custom }` | `--plugins recommended\|minimal\|custom:a,b,c` |
| `wikiMode: { mode, sections }` | `--wiki-mode <mode> [--wiki-sections "A,B,C"]` |
| `theme` | `--theme "<name>"` *(recorded, not yet applied — Lot 2)* |
| `linkWorkspace` | `--link-workspace <path>` |
| `claudeWorkspace` | `--claude-workspace` |
| `open` / `probe` / `gitInit` | `--open` / `--probe [--probe-timeout N]` / `--git-init` |
| `allowOutsideRoots` | *(tool-only gate; the CLI always allows the path)* |

## Non-goals

- No copy of `wiki/` **content** in `--from-vault` (structure/config only).
- No `git init` of the vault by default (opt-in `--git-init` — vaults often live
  on Google Drive / iCloud).
- `--theme` application is deferred to the Lot 2 theme chantier.
