---
name: meta-sync-template
description: Interactive flow to propagate the reference (`.template`) vault's plugins, snippets, Smart Connections config and root docs to one or more configured vaults. Filters out the reference vault (case-insensitive on Windows) and any vault missing the `obsidian-local-rest-api` plugin (to avoid leaking the reference's API key), lists the remaining targets with their online status, lets the user pick a subset or all, optionally re-clones with `--force`, then iterates `scripts/setup-vault.mjs --sync-plugins` per validated target and reports per-vault results. Never calls `--sync-all` — the bulk handler bypasses the skill's safety filters. Use whenever the user says "propagate the template", "sync vaults with template", "propage la config du template aux autres vaults", "mets à jour les vaults avec la config du template", "diffuse les plugins du vault de référence", "/obsidian-router:meta-sync-template", or any phrasing implying the reference vault should be the source of truth for plugins/config across the fleet.
---

# meta-sync-template

Interactive bulk propagation of the reference vault (typically `.template`) to one or more configured vaults. Iterates the existing `scripts/setup-vault.mjs --sync-plugins` command per validated target behind a conversational picker with skill-side safety filters (case-insensitive reference-vault exclusion, pre-flight REST-API-plugin detection). Never calls `--sync-all`.

## What the underlying script propagates

From `referenceVault` to each target vault:

- **Plugin folders**: `.obsidian/plugins/<plugin-id>/` — full directory copy when the plugin is missing from the target, or a re-clone with `--force` that preserves the target's local `data.json`
- **Plugin enablement**: `community-plugins.json` entries appended for newly synced plugins
- **CSS snippets**: `.obsidian/snippets/*.css` + enabled in `appearance.json` (idempotent)
- **Root docs**: `README.md`, `quick-reference-*.pdf`, `.claude/` (preserved if already present unless `--force`)
- **Smart Connections** — **first-time only**: `.smart-env/smart_env.json` + embedding-model cache are cloned only when the target's `.smart-env/` directory is entirely missing (`scripts/setup-vault.mjs:853-856`, passes `force: false`). On an already-bootstrapped target, **`--sync-plugins --force` does NOT refresh `.smart-env`**. To push an updated Smart Connections config to an existing target, delete the target's `.smart-env/smart_env.json` before re-running, or re-bootstrap the vault.

What it does **NOT** touch (intentional, per-vault):

- The target's existing `obsidian-local-rest-api/data.json` (port + API key) — preserved across re-clones via `setup-vault.mjs:837-842`. **Caveat**: see "Pre-flight check" in step 4 — this preservation only kicks in if the plugin already exists in the target. A first-time copy *would* import the reference's `data.json`.
- `.smart-env/event_logs`, `smart_contexts/`, `smart_components/`, `multi/` (vault-specific runtime cache, not config)
- The vault's actual notes

Important: file-system sync. **Works on offline vaults too** — Obsidian doesn't need to be running on the target. But targets that *are* currently open will need a reload to see new plugins.

## Steps

### 1. Locate the router repo

The skill must `cd` to the cloned `obsidian-mcp-router` repo to run `npm run setup-vault`. Try these in order until one works, and **tell the user which one succeeded** (so failures are explainable):

1. **Current working directory** — if `process.cwd()` already contains a `scripts/setup-vault.mjs`, use it.
2. **npm global link** — `npm root -g` returns the global `node_modules`, and `<that>/obsidian-mcp-router/` is the symlink if the user ran `npm link` during `meta-setup`.
   ```bash
   REPO="$(npm root -g)/obsidian-mcp-router"
   [ -f "$REPO/scripts/setup-vault.mjs" ] && echo "$REPO"
   ```
   ```powershell
   $repo = Join-Path (npm root -g) "obsidian-mcp-router"
   if (Test-Path "$repo\scripts\setup-vault.mjs") { Write-Output $repo }
   ```
   ⚠️ **Windows + nvm/volta gotcha**: `npm root -g` returns the path for the *currently active* Node version. If the user ran `npm link` under a different Node version (or switched nvm afterwards), the symlink won't exist under the active one — `Test-Path` returns false silently. If step 2 fails this way, surface it explicitly: *"`npm root -g` resolved to `<path>` but no `obsidian-mcp-router` link is there. If you use nvm/volta, switch to the Node version you used during `meta-setup`, or re-run `npm link` from the cloned repo under your current version."*
3. **`npm ls -g --depth=0 --parseable obsidian-mcp-router`** — cross-version-manager fallback. Outputs the resolved path if the package is linked anywhere npm knows about. Empty output → not installed via `npm link`.
4. **Ask the user**: "Where is the obsidian-mcp-router repo cloned on this machine?" Take the answer, verify the script exists at `<answer>/scripts/setup-vault.mjs`.

If none of these work, surface this and stop:

> ⚠️ Can't find `scripts/setup-vault.mjs`. The skill needs the cloned obsidian-mcp-router repo to run the sync. Either `cd` into the repo first, or run the `meta-setup` skill to clone + `npm link` it.

### 2. Read the router config

**Get the active config path from `list_vaults`** (call it in step 3 too — you can do it once and reuse). The response includes `configPath`, which respects the `--config` CLI flag and the `OBSIDIAN_ROUTER_CONFIG` env var. Hard-coding `$HOME/.claude/obsidian-mcp-router/config.json` is wrong when the running router was launched against a custom config (it would let the skill pick the wrong fleet, or wrongly report "no reference vault" when the active registry has one). Read **that** file:

```js
const { configPath } = await callTool('list_vaults');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
```

Default path if needed for display only: `$HOME/.claude/obsidian-mcp-router/config.json` (Linux/macOS) or `$env:USERPROFILE\.claude\obsidian-mcp-router\config.json` (Windows). In Node, resolve via `path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json')` — never a literal `~/`.

Pull these fields:

- `referenceVault` — the source vault (absolute path, typically ending in `.template`). **Required**. If missing or the path doesn't exist on disk, stop:
  > ⚠️ No reference vault configured (`referenceVault` is empty or its path is missing). Run `node scripts/setup-vault.mjs --init-reference "<path>"` to designate one first.
- `portRegistry` — object keyed by vault absolute path. The keys are the candidate targets.
- `vaultNames` (optional) — `{ <path>: <display-name> }` for friendlier output.

### 3. Probe online status

Call the router's `list_vaults` tool (no args). It pings each configured vault in parallel and returns `vaults: [{ name, type, baseUrl, path, online, latencyMs, ... }]`. Each entry contains a `path` field directly — match it against `portRegistry` keys via `path.resolve(...)` on both sides (Windows is case-insensitive but the registry keys may differ in casing).

It's OK if some vaults are offline — **the sync still works on them** because it's filesystem-based. Online status is informational, not a gate.

### 4. Render the picker

**4.a — Canonical path comparison helper**. Build a `samePath(a, b)` predicate that handles Windows case-insensitivity and short/long path forms. Algorithm:

```js
import fs from 'node:fs';
import path from 'node:path';

function canonical(p) {
  const resolved = path.resolve(p);
  try {
    // realpathSync.native() returns the true on-disk casing on Windows NTFS,
    // and resolves symlinks on POSIX. Falls back to lowercase on win32 if the
    // path doesn't exist (e.g. registry entry pointing to a removed vault).
    return fs.realpathSync.native(resolved);
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

function samePath(a, b) {
  const ca = canonical(a);
  const cb = canonical(b);
  return process.platform === 'win32'
    ? ca.toLowerCase() === cb.toLowerCase()
    : ca === cb;
}
```

`path.resolve()` alone is **not enough** — it preserves casing, so `C:\VAULTS\.template` ≠ `c:\vaults\.template` even though they point to the same physical directory on NTFS. The bulk handler's self-skip at `setup-vault.mjs:944` uses `path.resolve(a) === path.resolve(b)`, which has the same bug. Defense-in-depth in the skill is the only protection until the script is fixed (out of scope here — file a follow-up).

**4.b — Build the target list**. Take `Object.keys(portRegistry)` and filter out anything where `samePath(entry, cfg.referenceVault)` returns true. This is a **hard requirement** — the reference vault MUST NOT appear in the picker. See "Why filter the reference vault" below for the data-loss reason.

**4.c — Pre-flight: detect REST-API-less targets**. For each remaining target, check whether `<vault>/.obsidian/plugins/obsidian-local-rest-api/data.json` exists. If it doesn't, **mark the row visually** (`⚠️ no REST API`) and add a warning above the picker:

> ⚠️ **N target(s) don't have the `obsidian-local-rest-api` plugin installed yet.** If you sync these, the per-vault first-time plugin copy will import the reference vault's `data.json` (port + API key) — that's a credential leak (every target would share the same key, and the bound port would conflict on bind). **Fix first**: bootstrap each of those vaults via `node scripts/setup-vault.mjs "<path>"` (without `--sync-plugins`), which generates a per-vault port + key. Then re-run this skill.

**REST-less targets are excluded unconditionally** from the validated list. The skill MUST refuse to sync them even if the user explicitly asks — no opt-in, no "I know what I'm doing" escape hatch. Why: a first-time `--sync-plugins` copy on a vault missing the plugin clones the reference's `obsidian-local-rest-api/` folder wholesale, including its `data.json` (port + API key). That's a credential leak with no mitigation short of post-hoc deletion (which the user is unlikely to do reliably). The only safe path is to bootstrap the target first via plain `setup-vault.mjs "<path>"` (no `--sync-plugins`), which generates a per-vault port + key. Suggest that route along with `meta-add-vault` / `meta-status` when listing rejected targets.

**4.d — Render the table**:

```
Reference vault (source, NOT a sync target): C:\VAULTS\.template

Configured target vaults:
  #   Status        Vault                       Path
  1   ✅            roland                       P:\VAULTS\Roland
  2   ❌            qnap-archive                 \\qnap\notes\Archive
  3   ✅            coursera                     D:\Vaults\coursera
  4   ⚠️ no REST   raw-import                   D:\Vaults\raw-import
  ...
```

Then ask via AskUserQuestion (3 options):

- **All safe vaults (recommended)** — iterate the **filtered** target list from step 4.b/4.c (reference excluded via `samePath`, `⚠️ no REST` excluded **unconditionally** — no opt-in). **Do NOT call `--sync-all`** — see "Why iterate instead of `--sync-all`" below.
- **Pick a subset** — follow-up text prompt; user replies with comma-separated numbers, names, **or absolute paths**. Example reply: `1, 3` or `roland, coursera` or `P:\VAULTS\Roland, D:\Vaults\coursera`.
- **Cancel** — stop here, no changes.

If the user picks "subset", ask a follow-up free-text question listing the table again and accept their selection. Validate every entry resolves to a known path. **Reject any selection that `samePath()`-matches `referenceVault`** with: *"Can't sync the reference vault onto itself — it's the source. Pick a different target or use `meta-status` to inspect the registry."* **Also reject any `⚠️ no REST` target unconditionally** (no opt-in path — see step 4.c rationale): *"`<name>` lacks the `obsidian-local-rest-api` plugin. Syncing would leak the reference vault's API key into it. Bootstrap that vault first via `node scripts/setup-vault.mjs "<path>"` (no `--sync-plugins`), then re-run this skill."*

**Why filter the reference vault**: the bulk handler `--sync-all` has a self-skip at `scripts/setup-vault.mjs:944-948` (`if (path.resolve(vaultPath) === path.resolve(cfg.referenceVault)) skip`) — but that check is **case-sensitive on Windows** and won't catch `C:\VAULTS\.template` vs `c:\vaults\.template`. The per-vault `--sync-plugins` mode (which the subset loop calls) has no guard at all — and with `--force`, `syncPluginsMode` at line 840 does `rm -rf` on the target plugin dir before copying from source. If target ≈ reference, the rm wipes the source itself, then the copy reads from a now-empty directory. **Net effect: the reference vault is destroyed.** This skill's `samePath()` filter is the only line of defense.

**Why iterate instead of `--sync-all`**: `--sync-all` re-reads `portRegistry` from disk and iterates the raw list, bypassing every filter this skill applied (case-insensitive reference filter, REST-less detection). So even if step 4.b/4.c flagged a vault as unsafe, `--sync-all --force` would still process it — wiping the reference (Windows-casing case) or leaking the API key (REST-less case). The only way to keep the safeguards in force is to **iterate the validated list ourselves** from the skill, calling `--sync-plugins` once per validated target. Cost: no built-in final counter — compute it client-side. Benefit: the filters actually apply. Until `setup-vault.mjs:944` is patched to use `realpathSync.native()` AND the bulk handler gains a REST-less check, this is the only safe path. File those two as follow-up issues.

### 5. Ask about `--force`

Second question (before running): "Do you want `--force`?" with two options:

- **No (recommended)** — idempotent, skips plugins/files that already match the reference.
- **Yes (re-clone)** — re-copies every plugin folder. The per-vault `data.json` and `.smart-env/event_logs` are still preserved. Use when a plugin in the reference was updated and you want every target to pick up the new binaries.

### 6. Execute

From the repo root located in step 1, via the Bash tool (works cross-shell — the commands themselves are identical on PowerShell, bash, zsh).

**Edge case — empty validated list**: if step 4 left zero targets (everything was a reference-match or a no-REST entry the user didn't opt in for), print *"No targets to sync — nothing to do."* and stop. Don't run any command.

**For both "All safe vaults" and "Subset"**: iterate the **validated target list** from step 4 (post-filter, post-pre-flight). One call per target — never `--sync-all` (see "Why iterate instead of `--sync-all`" in step 4 for the safety rationale):

```bash
node scripts/setup-vault.mjs "<vault-path>" --sync-plugins
node scripts/setup-vault.mjs "<vault-path>" --sync-plugins --force
```

Track results client-side, classified strictly on **exit code**:
- `ok` if exit code 0 — the script prints `Synced N plugin(s)`, `Refreshed N plugin(s) (--force)`, or `Already up to date.` depending on what happened. All three are success states.
- `failed` if exit code ≠ 0 — capture stderr for the final report.
- **Mid-loop crash with `--force`**: stop the loop immediately. A destructive failure mid-loop is more dangerous than a benign failure. In the final report, list the **untouched** vaults (those after the failed index) with their absolute paths, so the user can re-run on them specifically after diagnosing the failure.
- **Mid-loop crash without `--force`**: continue the loop, append to a `failed` list, report at the end.

⚠️ **Windows quoting**: vault paths often contain spaces (`C:\My Vault\`) and a trailing backslash will escape the closing quote (`"C:\My Vault\"` → parsed as `C:\My Vault"`). Before passing each path:
- Strip any trailing `\` or `/`: e.g. PowerShell `($path).TrimEnd('\','/')`, or in Node `path.normalize(p).replace(/[\\\/]+$/, '')`.
- Wrap the result in double-quotes inside the command.
- **Never** rely on shell expansion of `~`. Resolve to absolute first.

Each call prints its own per-vault summary. Aggregate the counts yourself for the final report (step 7).

### 7. Report

Echo the script's output to the user verbatim (it's already well-formatted). At the end, add:

- **All synced**: ✅ N vault(s) updated from `<referenceVault>`. Vaults that were open in Obsidian during the sync need a **reload** (Ctrl+R / Cmd+R) to see new plugins.
- **Some failed**: list the failures with the per-vault error, then suggest re-running with `--force` for those specifically.

If a vault is currently online (Obsidian was running) and a plugin was added, mention that the plugin will not appear in Obsidian until reload OR until the user toggles "Restricted mode" / "Community plugins" off-then-on.

## Don't

- **Don't call `--sync-all` from this skill** — always iterate `--sync-plugins` per validated target. The bulk handler at `setup-vault.mjs:921` re-reads `portRegistry` from disk and ignores the skill's safety filters (case-insensitive reference filter, REST-less detection), which re-introduces the data-loss + credential-leak scenarios this skill exists to prevent.
- Don't pass `--force` silently. Ask once in step 5.
- Don't try to update `data.json` (port + API key) — that's per-vault state and the reference's value would conflict on bind.
- Don't gate on online status. Sync works offline; surfacing the table is informational only.
- Don't write to the router config file. This skill is **execution-only** — config edits live in `meta-add-vault` / manual edits.
- Don't read or copy `.obsidian/plugins/obsidian-local-rest-api/data.json` from the reference vault. The script's `--sync-plugins` mode already preserves the target's local `data.json` across re-clones (see `scripts/setup-vault.mjs:835-842`). If you ever do a manual fallback (e.g. raw `.obsidian/` copy), exclude that file explicitly — otherwise you leak the reference's API key into every target.

## When this skill fails

| Symptom | Likely cause | Fix |
|---|---|---|
| `Can't find scripts/setup-vault.mjs` | Router repo not cloned, or `npm link` never run | Run `meta-setup` first |
| `No reference vault configured` | `config.json` has empty `referenceVault` | Run `node scripts/setup-vault.mjs --init-reference "<path>"` and pick a vault to be the template source |
| Per-vault: `skip (path missing)` | The target path in `portRegistry` no longer exists on disk (vault moved/deleted) | Edit the router config (`$HOME/.claude/obsidian-mcp-router/config.json` or `$env:USERPROFILE\.claude\obsidian-mcp-router\config.json` on Windows) to remove the dead entry, OR move the vault back |
| Per-vault: `skip (no .obsidian)` | The path exists but is not an Obsidian vault | Same as above — clean up the registry |
| Plugin appears in `community-plugins.json` but not in Obsidian | Obsidian was open during sync, hasn't reloaded | User: Ctrl+R on the target vault, or close + reopen |
| User wants to roll back | The sync overwrote a plugin folder they had customized | The reference vault is now the source of truth — if customizations matter, port them back into `.template` then re-sync |

## Companion skills

- **`meta-status`** — pre-flight check: who's online, who's offline, who has missing API keys.
- **`meta-setup`** — install the router itself (clone + `npm link`).
- **`meta-add-vault`** — add a new vault to the registry (interactive, local or remote).
