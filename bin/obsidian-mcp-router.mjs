#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { startServer } from '../src/index.mjs';

/**
 * Tiny .env loader — no dependency on `dotenv`.
 *
 * The router needs to honor per-workspace env vars like VAULT_PATH and
 * OBSIDIAN_ROUTER_DEFAULT_VAULT to support per-project default vault
 * resolution. Claude Code does not auto-load .env files into the spawned
 * MCP process, so we do it here.
 *
 * Behavior:
 * - Reads .env from process.cwd() if present.
 * - Existing env vars (set by the parent) win — never overwrite.
 * - Lines: KEY=VALUE. Comments (#) and blank lines ignored. Quoted values
 *   ("..." or '...') are unquoted. No expansion of $VAR or ${VAR}, no
 *   multiline values — keep it boring.
 * - Silently no-ops if .env is missing or unreadable. Never throws.
 */
function loadDotenvSync(cwd) {
  const envPath = join(cwd, '.env');
  if (!existsSync(envPath)) return;
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

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
  OBSIDIAN_ROUTER_CONFIG          Same as --config.
  OBSIDIAN_ROUTER_NO_WATCH        Set to any value to disable hot-reload.
  OBSIDIAN_ROUTER_DEFAULT_VAULT   Override the default vault for this
                                  process (vault name from list_vaults).
                                  Wins over VAULT_PATH auto-detection
                                  and over config.defaultVault.
  VAULT_PATH                      Auto-detection: if set to a path that
                                  matches one of the registered vaults'
                                  paths, that vault becomes the default.
                                  setup-vault.mjs writes this into every
                                  bootstrapped vault's .env, so opening
                                  Claude Code in a vault directory uses
                                  that vault as default with no config.
  OBSIDIAN_ROUTER_LOCKED          Lock the router to a single vault for
                                  this process. While locked, every tool
                                  call targeting another vault throws,
                                  cross-vault fan-out is refused, and
                                  list_vaults reports lockedTo: <vault>.
                                  Lift via the unlock_vaults MCP tool or
                                  by removing this var. Set at runtime via
                                  lock_vault({ vault, persist: true }) which
                                  writes this var to <cwd>/.env.

The router auto-loads a .env file from the cwd at startup, so the two
variables above can be set per-workspace without touching ~/.claude.
Existing env vars in the parent process win over .env.

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

// Load .env from cwd BEFORE parsing args or reading env, so VAULT_PATH /
// OBSIDIAN_ROUTER_DEFAULT_VAULT / OBSIDIAN_ROUTER_NO_WATCH from the
// project's .env are visible.
loadDotenvSync(process.cwd());

const args = parseArgs(process.argv.slice(2));
if (process.env.OBSIDIAN_ROUTER_NO_WATCH) args.watch = false;

startServer(args).catch((err) => {
  console.error('[obsidian-mcp-router] Fatal:', err);
  process.exit(1);
});
