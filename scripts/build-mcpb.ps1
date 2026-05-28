# build-mcpb.ps1
#
# Build obsidian-mcp-router.mcpb bundle for MCPHub deployment.
#
# - Pure JS deps (@modelcontextprotocol/sdk + undici) → npm ci directly on Windows works
# - Excludes tests/, .git/, .venv/, mcpb-staging/, *.mcpb from staging
# - OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1 during npm ci → skips the 10 conversion tools'
#   Python venv postinstall (would fail in Alpine container anyway; revisit later)
# - Output: <repo>/obsidian-mcp-router-v<version>.mcpb
#
# Usage:
#   pwsh scripts/build-mcpb.ps1                # build with current version
#   pwsh scripts/build-mcpb.ps1 -Clean         # remove staging before build
#   pwsh scripts/build-mcpb.ps1 -Verbose       # show robocopy + npm output

param(
    [switch]$Clean,
    [switch]$VerboseOutput
)

$ErrorActionPreference = 'Stop'

# --- Paths ---
$repoRoot  = Split-Path -Parent $PSScriptRoot
$staging   = Join-Path $repoRoot 'mcpb-staging'
$serverDir = Join-Path $staging 'server'

$version = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
$bundleName = "obsidian-mcp-router-v$version.mcpb"
$bundle = Join-Path $repoRoot $bundleName

Write-Host ""
Write-Host "================================================================"
Write-Host "  obsidian-mcp-router .mcpb bundle build" -ForegroundColor Cyan
Write-Host "================================================================"
Write-Host "  Repo:      $repoRoot"
Write-Host "  Version:   $version"
Write-Host "  Staging:   $staging"
Write-Host "  Output:    $bundle"
Write-Host ""

# --- 1. Clean staging ---
if ((Test-Path $staging) -and $Clean) {
    Write-Host "[1/5] Cleaning existing staging dir..." -ForegroundColor Yellow
    Remove-Item $staging -Recurse -Force
}
if (Test-Path $staging) {
    Write-Host "[1/5] Reusing existing staging dir (pass -Clean to rebuild fresh)" -ForegroundColor DarkGray
} else {
    Write-Host "[1/5] Creating staging dir..."
    New-Item -ItemType Directory -Path $serverDir -Force | Out-Null
}

# --- 2. Robocopy source ---
Write-Host "[2/5] Copying source to staging (excluding .git, node_modules, tests, .venv, mcpb-staging)..."
$excludeDirs  = @('.git', 'node_modules', 'tests', '.github', 'docs', '.vscode', 'mcpb-staging', '.venv', '.claude', 'worktrees')
$excludeFiles = @('*.mcpb', '*.log', '.env', '.env.*')

$rcArgs = @(
    $repoRoot,
    $serverDir,
    '/MIR'
    '/NJH', '/NJS', '/NDL', '/NC', '/NS', '/NP'  # quieter logs
    '/XD'
) + $excludeDirs + @('/XF') + $excludeFiles

if (-not $VerboseOutput) { $rcArgs += '/NFL' }

$rcOutput = & robocopy @rcArgs
$rcExitCode = $LASTEXITCODE
# Robocopy uses bitmask exit codes: 0-7 success, 8+ failure
if ($rcExitCode -ge 8) {
    Write-Host "  robocopy failed with exit code $rcExitCode" -ForegroundColor Red
    if ($rcOutput) { Write-Host ($rcOutput | Out-String) }
    exit 1
}
Write-Host "  Source copied (robocopy exit $rcExitCode = success bitmask)" -ForegroundColor DarkGray

# --- 3. npm ci --omit=dev (with markitdown opt-out) ---
Write-Host "[3/5] Installing prod deps via npm ci --omit=dev (markitdown skipped)..."
Push-Location $serverDir
try {
    $env:OBSIDIAN_ROUTER_SKIP_MARKITDOWN = '1'
    if ($VerboseOutput) {
        & npm ci --omit=dev
    } else {
        & npm ci --omit=dev 2>&1 | Out-Null
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  npm ci failed with exit $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
    Remove-Item Env:OBSIDIAN_ROUTER_SKIP_MARKITDOWN -ErrorAction SilentlyContinue
    Write-Host "  Prod deps installed" -ForegroundColor DarkGray
} finally {
    Pop-Location
}

# --- 4. Write manifest.json ---
Write-Host "[4/5] Writing manifest.json..."

# Note: MCPHub prefixes 'server-' to the extraction directory (confirmed in
# mcphub-deployment-roadmap §5.1 / 2026-05-20-mcphub-reconnaissance). So the
# absolute path inside the container is /app/data/uploads/mcpb/server-<name>/...
$manifest = @{
    manifest_version = '1.0'
    name = 'obsidian-mcp-router'
    version = $version
    description = 'Multi-vault MCP router for Obsidian Local REST API. Bundle for MCPHub deployment.'
    server = @{
        mcp_config = @{
            command = 'node'
            args = @('/app/data/uploads/mcpb/server-obsidian-mcp-router/server/bin/obsidian-mcp-router.mjs')
            env = @{
                OBSIDIAN_ROUTER_ALLOWED_VAULTS = '${OBSIDIAN_ROUTER_ALLOWED_VAULTS}'
                OBSIDIAN_ROUTER_READONLY = '${OBSIDIAN_ROUTER_READONLY}'
                OBSIDIAN_ROUTER_USER_ID = '${OBSIDIAN_ROUTER_USER_ID}'
                OBSIDIAN_ROUTER_CONFIG = '${OBSIDIAN_ROUTER_CONFIG}'
                MD_ALLOWED_PATHS = '${MD_ALLOWED_PATHS}'
            }
        }
    }
} | ConvertTo-Json -Depth 6

# UTF-8 without BOM
$manifestPath = Join-Path $staging 'manifest.json'
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  manifest.json written ($($manifest.Length) bytes)" -ForegroundColor DarkGray

# --- 5. Compress to .mcpb ---
Write-Host "[5/5] Compressing to .mcpb archive..."
if (Test-Path $bundle) {
    Remove-Item $bundle -Force
}
Compress-Archive -Path "$staging\*" -DestinationPath $bundle -CompressionLevel Optimal

$sizeMB = [math]::Round((Get-Item $bundle).Length / 1MB, 2)
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Bundle ready: $bundleName ($sizeMB MB)" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Upload $bundle to MCPHub Dashboard -> Servers -> Upload"
Write-Host "  2. Verify extraction: docker exec mcphub ls /app/data/uploads/mcpb/server-obsidian-mcp-router/server/"
Write-Host "  3. Add instance entries in /share/Container/mcp-hub/mcp_settings.json with env vars"
Write-Host "  4. docker restart mcphub"
Write-Host ""
