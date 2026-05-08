# Reference vault setup

> How to create the **reference vault** that `setup-vault.mjs` clones from when bootstrapping new vaults.

## What is the reference vault?

The reference vault is a **regular Obsidian vault** kept on disk, used by [`scripts/setup-vault.mjs`](../scripts/setup-vault.mjs) as a source of truth when bootstrapping any new vault. When you run `setup-vault.mjs <new-vault>`, the script:

1. Clones the **plugin folders** from the reference vault's `.obsidian/plugins/` into the new vault.
2. Clones the `community-plugins.json` (so the cloned plugins are pre-enabled).
3. Clones `.smart-env/`, `.claude/`, and any top-level files (`README.md`, quick-reference PDFs, etc.) you've placed at the reference root.
4. **Regenerates** the per-vault secrets (port + API key) for `obsidian-local-rest-api/data.json`.
5. Writes a fresh `.env` and `.mcp.json` at the new vault's root.

This means once your reference is set up correctly **once**, every new vault you bootstrap with the script is fully operational on first launch.

## Why it lives outside the router repo

The reference vault is **deliberately not** committed to this repo, even though `setup-vault.mjs` reads from it. Three reasons:

1. **Secrets**: `obsidian-local-rest-api/data.json` contains a TLS cert + private key + API key in cleartext. Committing that to any git repo is a leak vector — even private repos can get mirrored, forked, or leaked through misconfigured access.
2. **Third-party code**: the plugin `main.js` files are built artifacts of separate projects (Smart Connections, Templater, the bridge plugin) under their own licenses (MIT, GPL-3.0). Redistributing them in this repo would conflate licensing.
3. **Separation of concerns**: the router is a runtime tool; the reference is bootstrap content. Keeping them apart lets each evolve on its own cadence — you can update Templater without touching the router release.

The router only stores a path to it: `referenceVault` in `~/.claude/obsidian-mcp-router/config.json`.

## Where to put it

Convention: under your vaults root, with a leading dot so Obsidian's "open vault" picker doesn't fold it into your real vaults.

| OS | Suggested path |
|---|---|
| Windows | `C:\VAULTS\.template` |
| macOS | `~/Vaults/.template` |
| Linux | `~/vaults/.template` |

The path is arbitrary — what matters is that it's **stable** (you don't move it) and **readable** by the user running `setup-vault.mjs`.

## Required plugins

Two plugins are non-negotiable. `setup-vault.mjs` refuses to bootstrap a vault if either is missing from the reference.

### 1. Local REST API

Provides the HTTPS endpoint that the router calls.

- **Source**: Obsidian Community plugins → "Local REST API" by Adam Coddington
- **Plugin id (folder name)**: `obsidian-local-rest-api`
- **Why required**: every router tool ultimately hits a route on this plugin.

Install from inside Obsidian: Settings → Community plugins → Browse → search "Local REST API" → Install → Enable.

### 2. MCP Router Bridge

Adds two custom routes on top of Local REST API: `/search/smart` (semantic search via Smart Connections) and `/templates/execute` (run a Templater template). Without it, those two router tools return 404.

- **Source**: <https://github.com/tboome33/obsidian-mcp-router-bridge> (manual install — not yet in the community plugin marketplace)
- **Plugin id (folder name)**: ⚠️ **`mcp-router-bridge`** (no `obsidian-` prefix)
- **Why required**: enables `search_smart` and `execute_template`.

> ⚠️ **Critical naming gotcha**: the GitHub repo is named `obsidian-mcp-router-bridge`, but the plugin's `manifest.json` declares `"id": "mcp-router-bridge"`. Obsidian requires the **folder name to match the manifest id**, so the folder under `.obsidian/plugins/` must be `mcp-router-bridge` — not `obsidian-mcp-router-bridge`. If you keep the folder name from the cloned repo, the plugin won't load and `setup-vault.mjs` will fail with `Required plugin missing in reference vault`.

Manual install procedure:

```bash
# Clone the repo
git clone https://github.com/tboome33/obsidian-mcp-router-bridge /tmp/bridge
cd /tmp/bridge

# Build (if main.js isn't pre-built)
npm install
npm run build

# Copy the built artifacts into the reference vault under the correct folder name
mkdir -p "<REFERENCE_VAULT>/.obsidian/plugins/mcp-router-bridge"
cp main.js manifest.json "<REFERENCE_VAULT>/.obsidian/plugins/mcp-router-bridge/"
# (styles.css if present)
```

Then enable inside Obsidian: Settings → Community plugins → toggle on "MCP Router Bridge".

## Optional plugins

These get cloned if present in the reference, skipped silently if not.

| Plugin | Plugin id | Source | Why optional |
|---|---|---|---|
| Smart Connections | `smart-connections` | Community plugins → "Smart Connections" by Brian Petro | Required for `search_smart` to actually return results — but `setup-vault.mjs` won't fail without it (the bridge plugin gracefully 503s if Smart Connections isn't loaded). |
| Templater | `templater-obsidian` | Community plugins → "Templater" by SilentVoid13 | Required for `execute_template`. Many users don't use Templater at all. |
| Dataview | `dataview` | Community plugins → "Dataview" | Not used by the router today, but commonly installed across vaults. Cloning it from the reference saves manual install per-vault. |
| Bases | `obsidian-bases` | Community plugins → "Bases" | Same rationale — convenience cloning. |

The full list lives in [`scripts/setup-vault.mjs`](../scripts/setup-vault.mjs) under `OPTIONAL_PLUGINS`.

## What else to put in the reference

Beyond plugins, anything you place at the root of the reference vault gets cloned into every new vault. Useful candidates:

- `README.md` — onboarding doc explaining the router itself (handy when you open a fresh vault and want a refresher).
- `CLAUDE.md` — global Claude Code instructions you want in every vault.
- `quick-reference-en.pdf` / `quick-reference-fr.pdf` — printable cheat sheets for the router.
- `.claude/` — Claude Code project settings (auto-allowed tools, hooks, etc.). The script clones this verbatim.
- `.smart-env/` — Smart Connections config (model selection, embedding parameters). Cloned but the per-vault embedding cache is **not** copied — it gets rebuilt on first index.
- `roadmap.md`, `wiki/`, `rules/` — any vault-level convention you want shared.

What **not** to put:
- Per-vault content (notes, daily journals) — defeats the point of a template.
- Stale or experimental plugins — they'll propagate to every new vault.

## Step-by-step bootstrap

### 1. Create the empty vault

```bash
# Replace with your chosen path (see "Where to put it" above)
mkdir -p "C:/VAULTS/.template"
```

### 2. Open it in Obsidian

File → Open another vault → browse to the new directory → "Trust the vault" when prompted.

### 3. Install the required plugins

- Settings → Community plugins → enable Community plugins
- Browse → install **Local REST API**, **Smart Connections**, **Templater**
- Manual install **MCP Router Bridge** as described above (verify the folder is named `mcp-router-bridge`, not `obsidian-mcp-router-bridge`)
- Activate all four in Settings → Community plugins

### 4. Configure Local REST API

- Settings → Local REST API → note the auto-generated API key and HTTPS port. The bootstrap script will regenerate fresh ones for cloned vaults; the reference's own values are kept for the reference vault itself.
- Restart Obsidian once to ensure the certificate is committed to `data.json`.

### 5. Register the reference with the router

```bash
node "<path-to-this-repo>/scripts/setup-vault.mjs" --init-reference "C:/VAULTS/.template"
```

This writes `referenceVault` into `~/.claude/obsidian-mcp-router/config.json` and adds a `portRegistry` entry so the reference itself is reachable via the router (named `template` by default).

### 6. Sanity check

```bash
node "<path-to-this-repo>/scripts/setup-vault.mjs" --status
```

Expected output:

```
Reference vault: /path/to/.template
Configured vaults:
  27124  /path/to/.template
```

## Bootstrapping a new vault

Once the reference is set up:

```bash
node "<path-to-this-repo>/scripts/setup-vault.mjs" "<new-vault-path>"
```

The script will:
- Allocate the next free port (starting at `portStart`, default 27124)
- Generate a fresh API key for the new vault
- Clone all required + optional plugins from the reference
- Write `.env`, `.mcp.json`, and update `.gitignore` at the new vault's root
- Register the vault in `portRegistry`

Open the new vault in Obsidian, trust it, verify the plugins are enabled — done.

For overwriting an existing partial bootstrap, pass `--force`. To regenerate port + API key in-place, pass `--regenerate`. To pick up newly-added plugins from the reference into an existing vault without touching its credentials, pass `--sync-plugins`.

## Updating the reference

When a plugin in the reference vault updates (via Community plugins → Update available), the new version sits in the reference's `.obsidian/plugins/<plugin-id>/`. Existing bootstrapped vaults are **not** automatically updated — they have their own copies. To propagate the update, re-run on each vault:

```bash
node setup-vault.mjs "<vault-path>" --sync-plugins --force
```

## Troubleshooting

### `Required plugin missing in reference vault: mcp-router-bridge`

The folder under `.obsidian/plugins/` is named something else (most likely `obsidian-mcp-router-bridge`, copied directly from the GitHub repo name). Rename it:

```bash
mv "<reference>/.obsidian/plugins/obsidian-mcp-router-bridge" \
   "<reference>/.obsidian/plugins/mcp-router-bridge"
```

Also check that `manifest.json` inside has `"id": "mcp-router-bridge"` — if you cloned an older version where the id was already `obsidian-mcp-router-bridge`, fix the id too, otherwise Obsidian won't load the plugin.

### `Vault has existing port 27124 but that port is already registered to <reference>`

You ran `setup-vault.mjs <vault>` after a previous partial run left a stale `data.json` in the new vault pointing at port 27124. Pass `--regenerate` to assign a fresh port + API key:

```bash
node setup-vault.mjs "<vault-path>" --regenerate
```

### Plugin appears in `.obsidian/plugins/` but Obsidian doesn't see it

Folder name must match the manifest id exactly, **case-sensitive on Linux/macOS**. Verify with:

```bash
cat "<vault>/.obsidian/plugins/<folder>/manifest.json" | grep '"id"'
```

If the id and folder name diverge, rename the folder to match the id (the manifest is authoritative).

### `setup-vault.mjs` clones plugins but they're not enabled in the new vault

Check that `community-plugins.json` in the reference vault lists every plugin id you want enabled. The script copies this file verbatim. If a plugin is in the reference's `plugins/` folder but missing from `community-plugins.json`, it'll be cloned but not auto-enabled.

## See also

- [`scripts/setup-vault.mjs`](../scripts/setup-vault.mjs) — the script itself, well-commented
- [`examples/config.example.json`](../examples/config.example.json) — full schema of `~/.claude/obsidian-mcp-router/config.json`
- [`docs/architecture.md`](./architecture.md) — how the router uses this config at runtime
- [Bridge plugin source](https://github.com/tboome33/obsidian-mcp-router-bridge) — manifest, install, REST routes registered
