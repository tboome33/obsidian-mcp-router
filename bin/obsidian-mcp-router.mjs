#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDependencies,
  formatFailure,
  PACKAGE_ROOT as packageRoot,
} from '../src/helpers/ensure-deps.mjs';

// NOTE: `../src/index.mjs` is imported DYNAMICALLY at the bottom of this
// file, after ensureDependencies() has had a chance to repair the install.
// A static import here would be hoisted above everything — including the
// dependency check — and the process would die with ERR_MODULE_NOT_FOUND
// before it could explain itself. Keep this file's static imports limited
// to node: builtins and dependency-free local helpers. See
// src/helpers/ensure-deps.mjs for the full rationale (Lot 5).

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
  obsidian-mcp-router --attach <vault-slug> [--also <slug>]...

SETUP
      --attach <slug>   Bind the CURRENT directory to vault(s) that already
                        exist in the router config. Writes the .env binding,
                        enables the router plugin in .claude/settings.json
                        (without which the binding is inert), adds a CLAUDE.md
                        block naming the vaults, and guards .gitignore.
                        Provisions nothing; idempotent; safe to re-run.
                        Extra vaults: --also <slug> (repeatable). They are NOT
                        auto-loaded — address them with vault: "<slug>".
                        Other flags: --workspace <path>, --no-plugin,
                        --no-claude-md, --no-gitignore.
                        Run \`node scripts/setup-vault.mjs --help\` for the
                        full vault-creation toolbox.

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
  OBSIDIAN_ROUTER_AUTO_ENRICH     Wiki auto-enrichment mode for Claude's
                                  proactive save suggestions. One of:
                                  ClaudeAsk (default — propose + confirm),
                                  Hybrid (auto-save type-safe, ask on
                                  high-stakes), FullAuto (auto-save all
                                  with audit log), or off (no auto). Set at
                                  runtime via set_auto_enrich_mode({ mode,
                                  persist: true }) which writes this var to
                                  <cwd>/.env. Surfaced in list_vaults under
                                  field autoEnrichMode.

The router auto-loads a .env file from the cwd at startup, so the
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

// ── `--attach` passthrough (v0.65.0, roadmap W4) ─────────────────────
// Bind the current workspace to already-registered vault(s). Delegated to
// scripts/setup-vault.mjs, which owns the four writes.
//
// It is intercepted HERE, before parseArgs (which rejects unknown flags),
// before loadDotenvSync (a workspace being attached for the first time has no
// .env yet — that is the point) and before the dependency self-heal (the
// setup script and its imports are node: builtins + local modules, so this
// answers even on a torn install).
//
// Why the server binary carries a setup subcommand at all: this is the one
// command a user needs BEFORE the router has any presence in their workspace.
// The skill and the MCP tools ship inside the Claude Code plugin, and the
// plugin is enabled per-workspace by one of the very writes below — so they
// cannot be the entry point without a bootstrap paradox. `obsidian-mcp-router`
// is on PATH the moment the package is installed.
if (process.argv[2] === '--attach') {
  // Spawned rather than imported on purpose: setup-vault.mjs runs its CLI only
  // when it IS the process entrypoint (it compares import.meta.url to argv[1]),
  // so an in-process import would define helpers and do nothing at all. The
  // child inherits stdio and its exit code is propagated verbatim.
  const setupScript = join(packageRoot, 'scripts', 'setup-vault.mjs');
  if (!existsSync(setupScript)) {
    process.stderr.write(
      `[obsidian-mcp-router] --attach needs ${setupScript}, which is missing from this install.\n`,
    );
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [setupScript, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(res.status === null ? 1 : res.status);
}

// Load .env from cwd BEFORE parsing args or reading env, so VAULT_PATH /
// OBSIDIAN_ROUTER_DEFAULT_VAULT / OBSIDIAN_ROUTER_NO_WATCH from the
// project's .env are visible.
loadDotenvSync(process.cwd());

const args = parseArgs(process.argv.slice(2));
if (process.env.OBSIDIAN_ROUTER_NO_WATCH) args.watch = false;

// ── Dependency self-heal ─────────────────────────────────────────────
// Everything above this line runs with node: builtins only, so --help and
// --version answer even on a tree that has never been installed.
//
// stderr, never stdout: stdout is the MCP stdio channel and a single stray
// byte desynchronises the protocol framing.
const deps = ensureDependencies({
  packageRoot,
  log: (msg) => process.stderr.write(`[obsidian-mcp-router] ${msg}\n`),
});

if (deps.status !== 'ok') {
  process.stderr.write(`${formatFailure({ packageRoot, ...deps })}\n`);
  process.exit(1);
}

let startServer;
try {
  ({ startServer } = await import('../src/index.mjs'));
} catch (err) {
  // The probe only covers the specifiers we import directly; a torn or
  // partial tree can still break on a transitive. Say so precisely rather
  // than surfacing a bare ERR_MODULE_NOT_FOUND.
  process.stderr.write(
    `${formatFailure({
      packageRoot,
      missing: [String(err?.message || err)],
      reason: 'the server module graph failed to load even though the direct dependencies resolved',
    })}\n`,
  );
  process.exit(1);
}

startServer(args).catch((err) => {
  console.error('[obsidian-mcp-router] Fatal:', err);
  process.exit(1);
});
