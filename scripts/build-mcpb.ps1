# build-mcpb.ps1 — forwarder to scripts/build-mcpb.mjs (C9, v0.68.0).
#
# This script used to BE the build: robocopy /MIR with a `/XD` + `/XF` deny
# list, then Compress-Archive. Both halves were replaced, and the old code is
# deliberately not kept here as a fallback:
#
#   - The deny list shipped `.codex/config.toml` — a live Authorization bearer
#     token — inside obsidian-mcp-router-v0.67.1.mcpb, along with 25 internal
#     review documents under `.superpowers/`, because those directories were
#     created after the exclusions were written. It ALSO over-excluded:
#     `/XD .claude` matched any directory of that name at any depth, which
#     silently dropped the git-tracked
#     templates/reference-vault-skeleton/.claude/settings.json from the vault
#     skeleton the bundle ships. Selection now comes from a whitelist in
#     contracts/export-allowlist.json.
#   - Compress-Archive stamps entries with their real mtime and walks the tree
#     in filesystem order, so two builds of one commit produced different
#     bytes. The replacement writes the archive itself, normalised.
#
# Keeping a working deny-list build next to the whitelist one would just be a
# way around the gate, so this file forwards instead. Every argument is passed
# through unchanged.
#
# Usage (identical to the Node script):
#   pwsh scripts/build-mcpb.ps1
#   pwsh scripts/build-mcpb.ps1 --verify-reproducible
#   pwsh scripts/build-mcpb.ps1 --keep-staging

$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent $PSScriptRoot
$nodeBuild = Join-Path $PSScriptRoot 'build-mcpb.mjs'

Write-Host "build-mcpb.ps1 now forwards to scripts/build-mcpb.mjs (C9 export gate)." -ForegroundColor DarkGray
Write-Host ""

# `-Clean` and `-VerboseOutput` were the old script's switches. The staging dir
# is rebuilt from scratch by default now, so -Clean has nothing left to mean;
# translate it rather than failing on an argument that used to work.
$forwarded = @()
foreach ($a in $args) {
    switch -Exact ($a) {
        '-Clean'         { Write-Host "  note: -Clean is the default now (staging is rebuilt every run); ignoring." -ForegroundColor Yellow }
        '-VerboseOutput' { Write-Host "  note: -VerboseOutput has no equivalent; the Node build is already verbose." -ForegroundColor Yellow }
        default          { $forwarded += $a }
    }
}

& node $nodeBuild @forwarded
exit $LASTEXITCODE
