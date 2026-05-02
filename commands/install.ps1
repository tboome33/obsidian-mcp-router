# install.ps1 — install or refresh the obsidian-mcp-router slash commands
# into $env:USERPROFILE\.claude\commands\
#
# Use this script:
#   - once after cloning the repo, to install all 14 commands
#   - again after every `git pull`, to keep your installed copies in sync
#     with the latest versions from the repo
#
# PowerShell 5.1+ compatible.

$ErrorActionPreference = 'Stop'

$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dstDir = Join-Path $env:USERPROFILE '.claude\commands'

if (-not (Test-Path $dstDir)) {
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
}

$count = 0
Get-ChildItem -Path (Join-Path $srcDir 'obsidian-*.md') -File | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $dstDir -Force
    $count++
}

Write-Host ""
Write-Host "✅ Installed/refreshed $count obsidian-* slash commands in:" -ForegroundColor Green
Write-Host "   $dstDir"
Write-Host "   Restart Claude Code or wait a moment for the commands to be picked up."
