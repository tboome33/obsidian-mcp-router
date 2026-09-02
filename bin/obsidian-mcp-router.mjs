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
import { subprocessOptions } from '../src/helpers/subprocess-env.mjs';
import { applyWorkspaceDotenv } from '../src/helpers/workspace-dotenv.mjs';

// NOTE: `../src/index.mjs` is imported DYNAMICALLY at the bottom of this
// file, after ensureDependencies() has had a chance to repair the install.
// A static import here would be hoisted above everything — including the
// dependency check — and the process would die with ERR_MODULE_NOT_FOUND
// before it could explain itself. Keep this file's static imports limited
// to node: builtins and dependency-free local helpers. See
// src/helpers/ensure-deps.mjs for the full rationale (Lot 5).

/**
 * Workspace .env loader — no dependency on `dotenv`.
 *
 * The router needs to honor per-workspace env vars like VAULT_PATH and
 * OBSIDIAN_ROUTER_DEFAULT_VAULT to support per-project default vault
 * resolution. Claude Code does not auto-load .env files into the spawned
 * MCP process, so we do it here.
 *
 * Behavior (the policy and the parser live in src/helpers/workspace-dotenv.mjs,
 * shared with the two hooks that load the same file):
 * - Reads .env from process.cwd() if present.
 * - Existing env vars (set by the parent) win — never overwrite.
 * - ONLY the keys the router's own writers put in a workspace .env are
 *   taken (OBSIDIAN_ROUTER_DEFAULT_VAULT, _LOCKED, _AUTO_ENRICH, VAULT_PATH,
 *   the MD_* sandbox, the enumerated OBSIDIAN_ROUTER_NO_* opt-outs). A
 *   workspace is often a cloned repository, and a repository's .env used to
 *   be able to set GIT_CONFIG_GLOBAL, NODE_OPTIONS, MARKITDOWN_PATH — or
 *   OBSIDIAN_ROUTER_CONFIG — in this process (v0.87.0). Anything else is
 *   ignored and named once on stderr, which for an MCP server is its log.
 * - One accepted key has a value it may not carry: OBSIDIAN_ROUTER_AUTO_ENRICH
 *   is fine, OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto (in any of its spellings) is
 *   not applied from a workspace file (v0.89.0, accepted option 4 of the
 *   decision `liaison-workspace-vault-hors-depot`). That refusal reaches this
 *   stderr through the same single warning as the ignored and withheld keys —
 *   the binary keeps the default `warn` precisely so it does — and it carries
 *   the migration line for a file written by an earlier `auto-mode persist`.
 * - What WAS taken is named too, on one line. A cloned repository's file can
 *   pick which of the user's REGISTERED vaults this session reads, locks and
 *   enriches (every value is checked against the registry; an unregistered
 *   vault cannot be named into existence), and the log should say the choice
 *   came from the file rather than from the host.
 * - Silently no-ops if .env is missing or unreadable. Never throws.
 */
function loadDotenvSync(cwd) {
  const { applied } = applyWorkspaceDotenv({ cwd });
  if (applied.length) {
    // The names are the router's own — the policy admits no other — so they
    // are safe to print as they are. Nothing else is: not the values, not
    // the path (the operator knows the server's cwd).
    try {
      process.stderr.write(`[obsidian-mcp-router] .env: applied ${applied.join(', ')}\n`);
    } catch { /* a closed stderr is not our problem */ }
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
                                  FullAuto is the one value NOT taken from a
                                  workspace .env (v0.89.0), in any of its
                                  spellings: that mode is standing permission
                                  to write into a vault without asking, and a
                                  cloned repository's file must not grant it.
                                  It still comes from this environment (an env
                                  entry in the MCP host's server declaration,
                                  or your shell), or from a call during the
                                  session. persist:true therefore refuses to
                                  write it and applies it to the session
                                  instead. A refusal is named on this stderr
                                  and in list_vaults under field
                                  autoEnrichModeRefused.

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
  // child inherits stdio, receives the `setup-vault` allowlist as its
  // environment (subprocess-env.mjs — not this shell's, whole), and its exit
  // code is propagated verbatim.
  const setupScript = join(packageRoot, 'scripts', 'setup-vault.mjs');
  if (!existsSync(setupScript)) {
    process.stderr.write(
      `[obsidian-mcp-router] --attach needs ${setupScript}, which is missing from this install.\n`,
    );
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [setupScript, ...process.argv.slice(2)], subprocessOptions('setup-vault', {
    stdio: 'inherit',
  }));
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
