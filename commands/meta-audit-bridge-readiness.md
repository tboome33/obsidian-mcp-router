---
description: Audit click-to-open readiness across all configured vaults — checks bridge ≥ 0.2.0, Local REST API ≥ 4.0.0, insecure HTTP enabled, AND a live probe that confirms `/open/*` is actually registered in-memory. (Skill `meta-audit-bridge-readiness` handles natural-language triggers.)
---

# meta-audit-bridge-readiness

Read-only diagnostic of the click-to-open feature (`http://127.0.0.1:<port>/open/<path>` links that open files in Obsidian). Complement of `meta-status`: that one checks the router can reach each vault; this one checks the clickable links actually work.

## Steps

1. Run the audit script with JSON output:
   ```bash
   node "<router-repo>/scripts/meta-audit-bridge-readiness.mjs" --json
   ```
   For a single vault: append `--vault <slug-or-path>`.

2. Parse the JSON and render as a table:
   - Header line: `<total> vault(s) · <ready> ready · <notReady> need attention`
   - Columns: `vault | bridge | LRA | insecure | /open route | ready?`
   - `✅` ready, `❌` not ready

3. For each `ready: false` vault, surface the FIRST matching cause in this priority order, with the exact command to run:

| Failed check | Remediation |
|---|---|
| `!bridgeInstalled` | `node scripts/setup-vault.mjs "<vaultPath>" --sync-plugins --force` |
| `!bridgeOk` (version < 0.2.0) | In bridge repo: `npm run deploy:all` |
| `!lraInstalled` | Install Local REST API via Obsidian Settings → Community plugins |
| `!lraOk` (version < 4.0.0) | Update LRA via Obsidian Settings, OR copy v4.x main.js+manifest+styles into `.template` then `node scripts/setup-vault.mjs --sync-all --force` |
| `!insecureEnabled` | Edit `.obsidian/plugins/obsidian-local-rest-api/data.json`: `enableInsecureServer: true` + a free `insecurePort` |
| probe `ECONNREFUSED` | Obsidian not running, OR Local REST API disabled, OR insecure server toggle off |
| probe HTTP `401` | **Files OK, but Obsidian has stale code in memory.** `Ctrl+P → "Reload app without saving"` |

4. Closing line:
   - All ready → `🎉 All <total> vaults are click-to-open ready.`
   - Some not ready → `Apply fixes above, then re-run /obsidian-router:meta-audit-bridge-readiness to verify.`

## Don't

- Auto-fix anything. Diagnostic only — the user picks what to reload/sync.
- Expose API keys.
- Probe HTTPS. Use the insecure HTTP port (Windows AV intercepts self-signed HTTPS loopback silently — full rationale in `wiki/obsidian-mcp-router-bridge/project-bridge.md` "Troubleshooting").

## When the script itself errors

- Exit code 2 + config-not-found → `~/.claude/obsidian-mcp-router/config.json` missing → run `setup-vault.mjs --init-reference <path>` first
- Other crash → relay the stack trace; that's a bug
