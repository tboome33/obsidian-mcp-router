# build-mcpb.ps1
#
# Build obsidian-mcp-router.mcpb bundle for MCPHub deployment.
#
# - Pure JS deps (sdk, undici, defuddle, mathml-to-latex, repomix — no native build
#   step) → npm ci directly on Windows produces a Linux-compatible node_modules
# - Excludes tests/, .git/, .venv/, mcpb-staging/, *.mcpb AND local secret config
#   (config.json / config.local.json / .env*) from staging — never ship credentials
# - npm ci --ignore-scripts → no lifecycle scripts run, so the markitdown Python venv
#   postinstall (would fail in a Python-less Alpine container anyway) is skipped
#   hermetically, independent of any OBSIDIAN_ROUTER_SKIP_MARKITDOWN env var
# - Output: <repo>/obsidian-mcp-router-v<version>.mcpb
#
# Usage:
#   pwsh scripts/build-mcpb.ps1                 # build with current version
#   pwsh scripts/build-mcpb.ps1 -Clean         # remove staging before build
#   pwsh scripts/build-mcpb.ps1 -VerboseOutput # show robocopy + npm output

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
Write-Host "[2/5] Copying source to staging (excluding .git, node_modules, tests, .venv, secrets...)..."
$excludeDirs  = @('.git', 'node_modules', 'tests', '.github', 'docs', '.vscode', 'mcpb-staging', '.venv', '.claude', 'worktrees', '.vault-meta')
# SECURITY: config.json / config.local.json are gitignored because they hold API keys.
# A normal user of this tool HAS a local config.json — without these exclusions, /MIR
# would copy it into the bundle and ship credentials to MCPHub. Keep aligned with .gitignore.
$excludeFiles = @('*.mcpb', '*.log', '.env', '.env.*', 'config.json', 'config.local.json')

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

# --- 2b. SECURITY: purge stale secrets from a REUSED staging dir ---
# robocopy /XF and /XD exclude files/dirs from BOTH the copy AND the /MIR delete pass.
# So a config.json (or .claude/, .vault-meta/) left over in $serverDir from a build that
# ran BEFORE these exclusions existed would survive a no-`-Clean` rerun and get zipped
# into the bundle. Explicitly delete the sensitive items from staging to plug that hole.
# (This runs BEFORE `npm ci`, which then regenerates node_modules from scratch — so the
#  purge only meaningfully targets the copied source tree, not installed packages.)
# Secret files match by exact name and are purged RECURSIVELY — config.json / .env are
# secrets wherever they sit. `*.log` is a wildcard, so scope it to the staging root only
# (where a credential-bearing log would sit) to avoid nuking a legit *.log a dep ships.
$secretFilesRecursive = @('config.json', 'config.local.json', '.env', '.env.*')
$secretDirNames       = @('.claude', '.vault-meta', '.venv', '.git')
foreach ($pat in $secretFilesRecursive) {
    Get-ChildItem -Path $serverDir -Recurse -File -Filter $pat -Force -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
Get-ChildItem -Path $serverDir -File -Filter '*.log' -Force -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
foreach ($dir in $secretDirNames) {
    Get-ChildItem -Path $serverDir -Recurse -Directory -Filter $dir -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "  Purged any stale secret files/dirs from staging" -ForegroundColor DarkGray

# --- 3. npm ci --omit=dev --ignore-scripts (hermetic: no postinstall venv) ---
# --ignore-scripts skips ALL lifecycle scripts. The only one is `postinstall` →
# install-markitdown.mjs (builds a Python venv that's useless in a Linux container).
# The runtime deps (@modelcontextprotocol/sdk + undici) are pure JS with no build step,
# so skipping scripts is safe and makes the bundle hermetic regardless of env vars.
Write-Host "[3/5] Installing prod deps via npm ci --omit=dev --ignore-scripts..."
Push-Location $serverDir
try {
    if ($VerboseOutput) {
        & npm ci --omit=dev --ignore-scripts
    } else {
        & npm ci --omit=dev --ignore-scripts 2>&1 | Out-Null
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  npm ci failed with exit $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Prod deps installed" -ForegroundColor DarkGray
} finally {
    Pop-Location
}

# --- 4. Write manifest.json ---
Write-Host "[4/5] Writing manifest.json..."

# Note: MCPHub prefixes 'server-' to the extraction directory (confirmed in
# mcphub-deployment-roadmap §5.1 / 2026-05-20-mcphub-reconnaissance). So the
# absolute path inside the container is /app/data/uploads/mcpb/server-<name>/...
# Derive the entrypoint path from $bundleBaseName (single source of truth) so it
# stays in sync if the manifest name ever changes.
$bundleBaseName = 'obsidian-mcp-router'
$entryPath = "/app/data/uploads/mcpb/server-$bundleBaseName/server/bin/obsidian-mcp-router.mjs"
$manifest = @{
    manifest_version = '1.0'
    name = $bundleBaseName
    version = $version
    description = 'Multi-vault MCP router for Obsidian Local REST API. Bundle for MCPHub deployment.'
    server = @{
        mcp_config = @{
            command = 'node'
            args = @($entryPath)
            env = @{
                OBSIDIAN_ROUTER_ALLOWED_VAULTS = '${OBSIDIAN_ROUTER_ALLOWED_VAULTS}'
                OBSIDIAN_ROUTER_READONLY = '${OBSIDIAN_ROUTER_READONLY}'
                OBSIDIAN_ROUTER_USER_ID = '${OBSIDIAN_ROUTER_USER_ID}'
                OBSIDIAN_ROUTER_CONFIG = '${OBSIDIAN_ROUTER_CONFIG}'
                MD_ALLOWED_PATHS = '${MD_ALLOWED_PATHS}'
                OBSIDIAN_ROUTER_VIEW_AGENT_URL = '${OBSIDIAN_ROUTER_VIEW_AGENT_URL}'
                OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN = '${OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN}'
            }
        }
    }
} | ConvertTo-Json -Depth 6

# UTF-8 without BOM
$manifestPath = Join-Path $staging 'manifest.json'
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  manifest.json written ($((Get-Item $manifestPath).Length) bytes)" -ForegroundColor DarkGray

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
