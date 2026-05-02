@echo off
REM install.cmd  -  install or refresh the obsidian-mcp-router slash commands
REM                 into %USERPROFILE%\.claude\commands\
REM
REM Use this script:
REM   - once after cloning the repo, to install all 14 commands
REM   - again after every `git pull`, to keep your installed copies in sync
REM     with the latest versions from the repo
REM
REM Equivalent to install.sh for users who prefer not to open Git Bash.

setlocal enabledelayedexpansion

set "SRC_DIR=%~dp0"
set "DST_DIR=%USERPROFILE%\.claude\commands"

if not exist "%DST_DIR%" (
    mkdir "%DST_DIR%"
)

set /a count=0
for %%f in ("%SRC_DIR%obsidian-*.md") do (
    copy /Y "%%f" "%DST_DIR%\" >nul
    set /a count+=1
)

echo.
echo Installed/refreshed !count! obsidian-* slash commands in:
echo   %DST_DIR%
echo Restart Claude Code or wait a moment for the commands to be picked up.

endlocal
