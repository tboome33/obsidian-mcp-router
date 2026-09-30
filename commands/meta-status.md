---
description: Diagnose the obsidian-mcp-router and all configured vaults — pings each, reports online/offline/auth status with fix suggestions. (Skill `meta-status` handles natural-language triggers.)
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

4. **Check the plugins of each vault that has a disk**, with the CLI — `list_vaults`
   answers "is the REST API reachable", not "does the vault have its plugins". A vault
   can list a plugin as enabled and have no code for it (a skeleton cloned without
   binaries, a settings-only sync), and Obsidian then shows nothing at all. For every
   `type: local` vault — and every remote vault that declares a `localPath` — run:

   ```
   obsidian-mcp-router --plugin-health "<vault name>" --json
   ```

   It is read-only: it reads `.obsidian/` and, when the REST API answers, calls
   `GET /commands/` and probes the bridge's `/open/` route. Exit code `0` = the required
   plugins (Local REST API, the bridge) have code; `1` = one of them is missing, settings
   only, or enabled without code; `2` = the vault has no disk reachable from here (a
   remote vault without `localPath`) — say that in one line, it is not a plugin fault.

   From the JSON, report per vault:
   - `enabledWithoutCode` non-empty → `⚠️ <vault>: enabled without code — <ids>`.
   - `bridge` is `absent` or `settings-only` → `⚠️ <vault>: bridge <state> — click-to-open
     links will not work`.
   - each entry of `problems` → its `message`, then its `fix` **verbatim**. A `soft`
     problem (`no command seen`, `/open/ route not registered`) is a hint to reload
     Obsidian or turn Restricted mode off, not a missing plugin — say so.
   - a `live.error` → the live half did not run (Obsidian closed, key rejected); the disk
     verdict still stands. Never turn "not probed" into "not loaded".

   The fix for missing code is `obsidian-mcp-router --install-plugins "<vault>" --dry-run`
   followed by an apply with the printed `approvedPlanSha256`. That command downloads
   third-party code: **offer it, show the dry-run plan, and run the apply only after the
   user says yes to that plan** (see **Don't**). After an install, Obsidian must be
   reloaded (Ctrl+P → "Reload app without saving") with Restricted mode off.

5. **Report the conversion toolbox**, from the `conversionToolbox` field of the same
   `list_vaults` response. Eight tools go through the `markitdown` Python CLI, which is
   installed by an explicit opt-in and **never automatically** — so on a fresh install
   they are dormant, and nothing else says so until the first call fails mid-task. One
   line, after the vault table:

   Check `verified` BEFORE `available`, or the two rules below contradict each other
   for an unverified-but-available override.

   - `available: true` and `verified: true` → `✅ Conversion toolbox: ready (<via>)`,
     where `via` is one of `bundled-venv`, `env-override` or `path`. Say nothing more.
   - `available: true` and `verified: false` → `○ Conversion toolbox: configured
     (<via>), not verified` — taken on the user's word (a bare command name resolved by
     `PATH` at call time, or a UNC path unsafe to stat here). Never say "ready", and do
     not offer to install anything.
   - `available: false` and `optedOut: true` → `○ Conversion toolbox: off by choice
     (OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1)`. **Do not** suggest installing it — the user
     already answered that question.
   - `available: false` and `verified: false` and `optedOut: false` → the probe could
     not answer (it never throws; this is how it says so). Say `? Conversion toolbox:
     state unknown — the check could not run`. Never "not installed", and offer no
     install: absence was never established. *(Key this on `verified`, not on a null
     `hint` — an opted-out machine with nothing installed also has `hint: null`, which
     made the two rules overlap.)*
   - `available: false`, `optedOut: false` and `via: "env-override"` → this is NOT
     "not installed". `MARKITDOWN_PATH` points at something that will not run and
     **masks** any working install underneath. Say `⚠️ Conversion toolbox:
     MARKITDOWN_PATH points at something unusable`, quote the `hint` **verbatim**, and
     do **not** offer to install anything — nothing is missing.
   - `available: false`, `optedOut: false`, **`verified: true`**, any other `via` →
     `⚠️ Conversion toolbox: not installed — 8 tools dormant`, then quote the `hint`
     field **verbatim** (it
     carries the exact command for THIS install, which a generic "run it in the router
     directory" does not for a plugin-cache install). Offer to run it; do not run it
     unasked (see **Don't**).
   **ONE OFFER PER CONVERSATION.** `optedOut` records only the permanent env-var
   answer; a spoken "not now" is written down nowhere. If the user already declined in
   this conversation, report the state in one line and do not re-offer — mention
   `OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1` once as the way to make it stick, then let it go.

   **Do not inflate the count.** `toolsAffected` and `toolsDegraded` in the response are
   the two lists — read them rather than counting from memory. `git_repo_to_markdown`
   never used markitdown at all (it goes through repomix), and `youtube_to_markdown`
   falls back to yt-dlp captions — which keeps it working **only if yt-dlp is
   installed**, itself another executable the router does not install.

   **The yt-dlp state is measured, so read it — do not assume it.** `toolsDegraded` is
   computed: it lists `youtube_to_markdown` exactly when `conversionToolbox.youtube.ytdlp`
   is `missing` (or `unknown`, when the check could not run), whatever markitdown's
   state — the transcript only ever comes from yt-dlp. Render it as its own line:
   `found` → `✅ yt-dlp: found` (add "taken from YTDLP_PATH, not checked" when
   `youtube.verified` is `false`); `missing` → `⚠️ yt-dlp: not found — youtube_to_markdown
   degraded`, then quote `youtube.hint` **verbatim** (it names the no-admin install,
   `uv tool install "yt-dlp[default,curl-cffi]"`, or the broken `YTDLP_PATH`);
   `unknown` → `❔ yt-dlp: state unknown`. If the user reports YouTube refusing the
   machine (HTTP 429, "Sign in to confirm you're not a bot"), the fix is `YTDLP_COOKIES`
   (absolute path to a Netscape cookies.txt) or `YTDLP_PROXY` set in the MCP server
   declaration — never in a workspace `.env`, which does not accept them.

   **Where the state travels vs. where you surface it.** `conversionToolbox` rides on
   EVERY `list_vaults` response, including the automatic one the default-vault
   health-check convention makes at session start — it is data, cheap, and always there.
   Surfacing it is this command's job: do not raise it unprompted at session start, and
   do not mention it in an unrelated answer just because you saw the field.

6. End with one of two endings:

- **All healthy**:
  > 🎉 All <n> vaults online. Ready to use.

- **Issues present**:
  > Found `<k>` issue(s). Apply the fixes above, then re-run `meta-status` to verify.

## Don't

- Don't try to fix issues automatically — this skill is a diagnostic, not a fixer. Surface the problem and let the user choose how to proceed.
- Don't install markitdown on your own initiative, even if the user says "fix the issues". It is a 30-180 s download of ~100 MB of Python wheels, and the router's refusal to impose a Python install is a written decision. Offer, wait for a yes, then run it.
- Don't run `--install-plugins` without its `--dry-run` first, and don't apply a plan the user has not seen and approved — it downloads third-party code into their vault. `--plugin-health` is the only plugin command this diagnostic runs on its own.
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
