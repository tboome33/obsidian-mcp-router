#!/usr/bin/env bash
# install.sh — install or refresh the obsidian-mcp-router slash commands
# into ~/.claude/commands/.
#
# Use this script:
#   - once after cloning the repo, to install all 14 commands
#   - again after every `git pull`, to keep your installed copies in sync
#     with the latest versions from the repo
#
# Why a script instead of symlinks: on Windows, symlinks require either
# admin privileges or Developer Mode. A flat copy works everywhere; the
# trade-off is that you have to re-run this after a pull.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DST_DIR="${HOME}/.claude/commands"

mkdir -p "$DST_DIR"

count=0
for src in "$SRC_DIR"/obsidian-*.md; do
    [ -f "$src" ] || continue
    cp -f "$src" "$DST_DIR/"
    count=$((count + 1))
done

echo "✅ Installed/refreshed $count obsidian-* slash commands in $DST_DIR"
echo "   Restart Claude Code or wait a moment for the commands to be picked up."
