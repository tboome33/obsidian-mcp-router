#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { startServer } from '../src/index.mjs';

function parseArgs(argv) {
  const args = { configPath: undefined, watch: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--version' || a === '-v') {
      printVersion();
      process.exit(0);
    } else if (a === '--config' || a === '-c') {
      args.configPath = argv[++i];
      if (!args.configPath) {
        console.error('--config requires a path argument');
        process.exit(2);
      }
    } else if (a === '--no-watch') {
      args.watch = false;
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      console.error('Run `obsidian-mcp-router --help` for usage.');
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`obsidian-mcp-router — multi-vault Obsidian MCP server

USAGE
  obsidian-mcp-router [options]

OPTIONS
  -c, --config <path>   Path to config file. Default:
                        ~/.claude/obsidian-mcp-router/config.json
                        Also reads OBSIDIAN_ROUTER_CONFIG env var.

      --no-watch        Disable hot-reload of the config file.
                        Default is to watch for changes and reload.

  -h, --help            Show this help and exit.
  -v, --version         Show version and exit.

ENVIRONMENT
  OBSIDIAN_ROUTER_CONFIG    Same as --config.
  OBSIDIAN_ROUTER_NO_WATCH  Set to any value to disable hot-reload.

The server speaks MCP over stdio. It is meant to be invoked by an MCP
client (Claude Desktop, Claude Code) — not directly from a terminal.
`);
}

function printVersion() {
  const pkgPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'package.json',
  );
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  process.stdout.write(`${pkg.name} v${pkg.version}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (process.env.OBSIDIAN_ROUTER_NO_WATCH) args.watch = false;

startServer(args).catch((err) => {
  console.error('[obsidian-mcp-router] Fatal:', err);
  process.exit(1);
});
