---
name: meta-status
description: Diagnose the obsidian-mcp-router and all its configured vaults. Pings each vault, reports online/offline/auth status, and suggests fixes for each issue type. Use when the user says "check vault status", "diagnose the router", "are my vaults reachable", "status of obsidian", "what's wrong with the router", or asks to debug an obsidian connection issue.
---

# meta-status

Produces a one-shot diagnostic of the multi-vault Obsidian router. Run it when the user wants to know what's working, what isn't, and how to fix it.

## Steps

1. Call the router's `list_vaults` tool (no arguments). The router will ping each configured vault in parallel and return a structure like:
   ```json
   {
     "defaultVault": "tradingview",
     "configPath": "/Users/.../.claude/obsidian-mcp-router/config.json",
     "vaults": [
       {
         "name": "tradingview",
         "type": "local",
         "baseUrl": "https://127.0.0.1:27125",
         "online": true,
         "latencyMs": 4,
         "missingApiKey": false,
         "isDefault": true
       },
       {
         "name": "qnap",
         "type": "remote",
         "baseUrl": "https://qnap.tailnet.local:27125",
         "online": false,
         "latencyMs": 5012,
         "error": "[qnap] timed out after 5000ms calling /",
         "missingApiKey": false
       }
     ]
   }
   ```

2. Render the result as a compact summary:
   - First line: `<n> vault(s) configured · <m> online · default: <name>`
   - Then a markdown table with columns: name | type | status | latency | path/baseUrl
   - Use ✅ for online, ❌ for offline, ⚠️ for missingApiKey or any partial issue

3. For each vault that is NOT fully healthy, add a short diagnostic block explaining the likely cause and the fix:

| Symptom | Likely cause | Fix to suggest |
|---|---|---|
| `online: false` AND `type: local` | Obsidian not running on this vault, or a different vault is open | Open Obsidian and load the vault at the path shown |
| `online: false` AND `type: remote` AND `error` includes "unreachable" | Remote host not reachable | Check that the remote machine is online, the tunnel is up (Tailscale / Cloudflare), and that no firewall changed |
| `online: false` AND `error` includes "timed out" | Network path is alive but slow, or the remote vault is busy | Bump `timeoutMs` for that vault to 15000-20000 |
| `online: false` AND `error` includes "401" | API key is wrong or expired | For local: re-run `setup-vault.mjs` to regenerate. For remote: re-fetch the key from the host's `data.json` |
| `online: false` AND `error` includes "cf_access" or "cloudflareaccess.com" | Cloudflare Access policy is blocking the request | Verify `extraHeaders` has the right `CF-Access-Client-Id` + `CF-Access-Client-Secret` and that the service token is attached to a "Service Auth" policy on the Access app |
| `missingApiKey: true` AND `type: local` | Local REST API plugin never enabled for this vault, so no `data.json` to read | Open Obsidian on this vault, enable Local REST API plugin, then re-run `setup-vault.mjs` |
| `online: true` AND `latencyMs > 500` AND `type: remote` | Functional but slow; might cause timeouts on large operations | Note it as a soft warning; consider Tailscale Funnel for a closer relay or moving to a Cloudflare Tunnel |

4. **Report the conversion toolbox**, from the `conversionToolbox` field of the same
   `list_vaults` response. **Eight** tools go through the `markitdown` Python CLI,
   which is installed by an explicit opt-in and **never automatically** — so on a fresh
   install they are dormant, and nothing else says so until the first call fails
   mid-task. One line, after the vault table:

   Check `verified` BEFORE `available` — the two rules below used to be written in
   the other order, so `MARKITDOWN_PATH=markitdown.exe` (available, unverified) matched
   both "say ready and nothing more" and "never say ready", and which one won was
   undefined.

   - `available: true` and `verified: true` → `✅ Conversion toolbox: ready (<via>)`
     where `via` is `bundled-venv`, `env-override` or `path`. Say nothing more.
   - `available: true` and `verified: false` → `○ Conversion toolbox: configured
     (<via>), not verified`. The answer was taken on the user's word rather than
     measured: a bare command name that `execFile` resolves through `PATH` at call
     time, or a UNC path that is unsafe to stat on this hot path. Do **not** upgrade it
     to "ready", and do not offer to install anything — nothing says it is missing.
   - `available: false` and `optedOut: true` → `○ Conversion toolbox: off by choice
     (OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1)`. **Do not** suggest installing it — the user
     already answered that question.
   - `available: false` and `verified: false` and `optedOut: false` → the probe could
     not answer at all (it never throws; this is how it reports that). Say `?
     Conversion toolbox: state unknown — the check could not run`. Do **not** say "not
     installed", and do not offer an install: nothing was measured, so absence was never
     established.

     *(Test `optedOut` first, above — an opted-out machine with nothing installed also
     has `hint: null`, so keying "unknown" on a null hint made the two rules overlap.
     `verified` is the field that separates them: the opted-out case still measured.)*
   - `available: false`, `optedOut: false` and `via: "env-override"` → this is NOT
     "not installed". `MARKITDOWN_PATH` is set and points at something that will not
     run, which **masks** any working bundled venv or PATH install underneath. Say
     `⚠️ Conversion toolbox: MARKITDOWN_PATH points at something unusable`, then quote
     the `hint` **verbatim** — it names the offending value and says to fix or unset
     the variable. Do **not** offer to install anything: nothing is missing.
   - `available: false`, `optedOut: false`, **`verified: true`**, any other `via` →
     `⚠️ Conversion toolbox: not installed — 8 tools dormant`, then quote the `hint`
     field **verbatim**: it
     carries the exact command for THIS install, which a generic "run it in the router
     directory" does not for a plugin-cache install. Offer to run it; do not run it
     unasked (see **Don't**).

   **Do not inflate the count** — and do not over-reassure either. `toolsAffected` and
   `toolsDegraded` in the response are the two lists; read them rather than counting
   from memory. `git_repo_to_markdown` never used markitdown at all (it goes through
   repomix). `youtube_to_markdown` falls back to yt-dlp captions, which keeps it working
   **only if yt-dlp is installed** — itself another executable the router does not
   install, so on a genuinely fresh machine it can fail too.

   **Where the state travels vs. where you surface it.** `conversionToolbox` rides on
   EVERY `list_vaults` response, including the automatic one the default-vault
   health-check convention makes at session start — it is data, cheap, and always
   there. Surfacing it is this skill's job: do not raise it unprompted at session
   start, and do not mention it in an unrelated answer just because you saw the field.

   **ONE OFFER PER CONVERSATION.** `optedOut` records only the permanent env-var
   answer; a spoken "not now" is written down nowhere, so nothing in the response
   stops you asking again. If the user has already declined in this conversation —
   here or in `meta-setup` — report the state in one line and **do not re-offer**.
   Mention `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` once, as the way to make the answer
   stick across sessions, and then let it go. Repeating the offer is the pressure this
   feature exists to avoid.

5. End with one of two endings:

- **All healthy**:
  > 🎉 All <n> vaults online. Ready to use.

- **Issues present**:
  > Found `<k>` issue(s). Apply the fixes above, then re-run `meta-status` to verify.

## Don't

- Don't try to fix issues automatically — this skill is a diagnostic, not a fixer. Surface the problem and let the user choose how to proceed.
- Don't install markitdown on your own initiative, even if the user says "fix the issues". It is a 30-180 s download of ~100 MB of Python wheels, and the router's refusal to impose a Python install is a written decision, not an oversight. Offer, wait for a yes, then run it.
- Don't expose API keys in the output.
- Don't dump the full raw JSON to the user — render the table and the issue blocks. The raw JSON is for your own consumption.
- Don't run write/delete tools as part of this skill. Read-only diagnostic.

## When this skill fails

If `list_vaults` itself errors out (e.g., the router process crashed, MCP connection dead), report that distinctly:

> ⚠️ The Obsidian router MCP didn't respond. Possible causes:
> - The router binary `obsidian-mcp-router` isn't installed (run `npm link` in the repo)
> - `~/.claude.json` doesn't have the router registered under `mcpServers.obsidian-router` (or whatever name)
> - Claude Desktop / Code wasn't restarted after the registration
>
> Fix: verify with `which obsidian-mcp-router` and check the `mcpServers` block in `~/.claude.json`.
