---
name: meta-audit-bridge-readiness
description: Audit every Obsidian vault for click-to-open (`GET /open/<path>`) readiness. Verifies the FOUR prerequisites — mcp-router-bridge ≥ 0.2.0, Local REST API ≥ 4.0.0, `enableInsecureServer: true`, AND a live probe that confirms the route is actually registered in-memory (catches the "files on disk are right but Obsidian needs reload" case). Triggers (EN) `audit my click-to-open links`, `check bridge readiness`, `are my /open links working`, `audit vault click-to-open`, `which vaults need a reload`, `verify bridge plugin install`. Triggers (FR) `audite les liens cliquables`, `vérifie le bridge sur tous les vaults`, `est-ce que mes liens /open marchent`, `audit click-to-open`, `quels vaults ont besoin d'un reload`, `audit du bridge`.
---

# meta-audit-bridge-readiness

Diagnostic read-only de la fonctionnalité click-to-open (`http://127.0.0.1:<port>/open/<path>` qui ouvre un fichier dans Obsidian). C'est le complément de [[meta-status]] : `meta-status` vérifie que le router peut joindre chaque vault ; ce skill-là vérifie que les **liens cliquables** que tu mets dans le chat fonctionnent vraiment.

Quatre prérequis sont checkés par vault :

| # | Check | Si KO |
|---|---|---|
| 1 | `mcp-router-bridge` plugin ≥ v0.2.0 installé | route handler `/open/*` absent → `npm run deploy:all` dans le bridge repo |
| 2 | `obsidian-local-rest-api` plugin ≥ v4.0.0 installé | méthode `addPublicRoute()` absente → update via Settings Community Plugins, ou copy v4.x dans `.template` + `--sync-all --force` |
| 3 | `enableInsecureServer: true` + `insecurePort` set dans `.obsidian/plugins/obsidian-local-rest-api/data.json` | serveur HTTP non-chiffré coupé → AV (Bitdefender etc.) va dropper les HTTPS auto-signés silencieusement |
| 4 | **Live probe** : `GET http://127.0.0.1:<insecurePort>/open/__nonexistent__.md` retourne 404 (= route enregistrée) plutôt que 401 (= middleware auth catch-all = route pas registered) | Obsidian a du code stale en mémoire → `Ctrl+P → "Reload app without saving"` |

Le check #4 est le plus important — c'est lui qui détecte le cas où **les fichiers sur disque sont corrects** mais Obsidian tourne encore avec l'ancien code (n'a pas reload depuis le sync). Les checks 1-3 sont des static-version checks.

## Steps

1. Run the audit script and capture its JSON output:
   ```bash
   node "<router-repo>/scripts/meta-audit-bridge-readiness.mjs" --json
   ```
   (or for a single vault: `--vault <slug-or-path>`)

2. Parse the JSON. Schema:
   ```json
   {
     "minBridge": "0.2.0",
     "minLra": "4.0.0",
     "results": [
       {
         "vaultName": "DEDIBOX",
         "vaultPath": "C:\\VAULTS\\DEDIBOX",
         "httpsPort": 27131,
         "insecurePort": 27141,
         "bridgeVersion": "0.2.0",
         "lraVersion": "4.0.2",
         "enableInsecureServer": true,
         "checks": {
           "bridgeInstalled": true,
           "bridgeOk": true,
           "lraInstalled": true,
           "lraOk": true,
           "insecureEnabled": true,
           "routeLive": true,
           "probeResult": { "status": 404, "error": null }
         },
         "ready": true
       }
     ],
     "summary": { "total": 10, "ready": 3, "notReady": 7 }
   }
   ```

3. Render as a compact table:
   - First line: `<total> vault(s) audited · <ready> ready · <notReady> need attention`
   - Table: `vault | bridge | LRA | insecure | /open route | ready?`
   - ✅ for ready, ❌ for not ready, version numbers in yellow if below threshold

4. For each vault with `ready: false`, output the first matching remediation in this order:

| Failed check | Remediation to surface |
|---|---|
| `!bridgeInstalled` | bridge plugin missing → `node scripts/setup-vault.mjs "<vaultPath>" --sync-plugins --force` |
| `!bridgeOk` | bridge v<version> < v0.2.0 → in `obsidian-mcp-router-bridge` repo: `npm run deploy:all` |
| `!lraInstalled` | Local REST API missing → install via Obsidian Settings → Community plugins |
| `!lraOk` | LRA v<version> < v4.0.0 → update via Obsidian Settings, OR copy v4.x main.js+manifest+styles into `.template`, then `node scripts/setup-vault.mjs --sync-all --force` |
| `!insecureEnabled` | edit `.obsidian/plugins/obsidian-local-rest-api/data.json`, set `enableInsecureServer: true` + a free `insecurePort`, reload Obsidian |
| `routeLive === false` AND probe error `ECONNREFUSED` | Obsidian not running on this vault, OR Local REST API plugin disabled, OR insecure server toggle off |
| `routeLive === false` AND probe status `401` | files OK but stale code in memory → `Ctrl+P → "Reload app without saving"` in this vault's Obsidian |

5. End with one of:
   - **All ready** → `🎉 All <total> vaults are click-to-open ready.`
   - **Some not ready** → `Apply fixes above, then re-run /obsidian-router:meta-audit-bridge-readiness to verify.`

## When to nudge the user without being asked

Proactively offer this audit when:
- The user mentions a 40101 / "Authorization required" error on a click-to-open link
- After `npm run deploy:all` in the bridge repo (the audit is the natural "did it actually take effect" check)
- After `setup-vault.mjs --sync-all` (same)
- When the user creates several click-to-open links in a row to vaults you haven't recently verified

## Don't

- Don't auto-fix anything. Surface the problem with the specific command to run. The user decides what gets reloaded / re-synced.
- Don't expose API keys (the script never reads them, but if you fall back to reading `data.json` directly, redact the `apiKey` field).
- Don't run a probe against the HTTPS port — the audit deliberately uses HTTP/insecurePort because that's what clickable links use on Windows (AV intercepts self-signed HTTPS loopback silently — see `wiki/obsidian-mcp-router-bridge/project-bridge.md` "Troubleshooting" for the full rationale).

## When this skill fails

If the audit script itself errors out (exit code 2 with stderr):
- Config not found → `~/.claude/obsidian-mcp-router/config.json` missing → run `setup-vault.mjs --init-reference <path>` first
- Crash → relay the stack trace; this is a bug, not user error
