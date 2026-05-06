#!/usr/bin/env node
/**
 * setup-vault.mjs
 *
 * Bootstraps an Obsidian vault for use with obsidian-mcp-router:
 *   - Clones Local REST API + MCP Router Bridge plugins from a reference vault
 *   - Allocates a unique HTTPS port
 *   - Generates a fresh API key
 *   - Patches plugin data.json
 *   - Writes .env + .mcp.json at vault root (.mcp.json points to obsidian-mcp-router)
 *
 * Usage:
 *   node setup-vault.mjs <vault-path>
 *   node setup-vault.mjs <vault-path> --force          # overwrite existing files
 *   node setup-vault.mjs <vault-path> --regenerate     # force fresh port + apiKey
 *   node setup-vault.mjs <vault-path> --sync-plugins   # only sync new plugins from .template
 *   node setup-vault.mjs --init-reference <path>       # mark a vault as the reference
 *   node setup-vault.mjs --status                      # show config + registry
 *
 * Config file lives at: ~/.claude/obsidian-mcp-router/config.json
 * (kept outside this repo because it contains user-specific paths.)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// --- Config path: user-home, NOT relative to this script ---------------------
// The script lives inside the router repo (which is git-tracked and may live
// anywhere), so we anchor config.json in the user's home dir under our project
// name. The router itself reads from the same path by default.
const CONFIG_PATH = path.join(
  os.homedir(),
  '.claude',
  'obsidian-mcp-router',
  'config.json',
);

// --- Router executable that bootstrapped vaults will spawn -------------------
// .mcp.json files in each vault will reference these paths so Claude Code
// (and other MCP clients) can launch the router. We resolve them once at
// script-startup so .mcp.json gets fully-absolute, portable paths.
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SELF_DIR, '..');
const ROUTER_BIN = path.join(REPO_ROOT, 'bin', 'obsidian-mcp-router.mjs');
// We capture the absolute path of the node binary that's running THIS script
// (process.execPath) and bake it into the generated .mcp.json. This is
// reliable on first launch, but be aware:
//   - With nvm-windows, process.execPath is the symlink target at the time of
//     setup (e.g. C:\nvm4w\nodejs\node.exe → ...\v23\node.exe). Switching to a
//     different active Node version later does NOT update the symlink target
//     baked here — it just rebinds the symlink. So this generally keeps
//     working as long as nvm-windows is the layer the user manages.
//   - If the user uninstalls Node entirely or moves it, the .mcp.json breaks.
//     Re-run setup-vault.mjs (or hand-edit .mcp.json) to repair.
// We deliberately don't fall back to a bare `"node"` because spawn() on
// Windows with command:"node" requires PATHEXT/shell resolution the user's
// MCP client may not provide.
const NODE_EXE = process.execPath;

// --- Required plugins: must exist in reference vault, otherwise we fail --
const REQUIRED_PLUGINS = ['obsidian-local-rest-api', 'obsidian-mcp-router-bridge'];
// --- Optional plugins: cloned if present in reference vault, else skipped ---
const OPTIONAL_PLUGINS = ['smart-connections', 'templater-obsidian', 'dataview', 'obsidian-bases'];
const PLUGINS_TO_CLONE = [...REQUIRED_PLUGINS, ...OPTIONAL_PLUGINS];

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};
const c = (color, s) => `${COLORS[color]}${s}${COLORS.reset}`;

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ referenceVault: null, portStart: 27124, portRegistry: {} }, null, 2),
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function fail(msg) {
  console.error(c('red', '✗ ') + msg);
  process.exit(1);
}

function ok(msg) {
  console.log(c('green', '✓ ') + msg);
}

function info(msg) {
  console.log(c('cyan', 'ℹ ') + msg);
}

function warn(msg) {
  console.log(c('yellow', '⚠ ') + msg);
}

function defaultNameFromPath(p) {
  // MUST match src/registry.mjs's defaultNameFromPath() exactly so
  // disabled-by-name checks (and the printStatus output) match what the
  // router computes at runtime. The structural Windows-path detection
  // mirrors `isWindowsPath` in registry.mjs — duplicated inline because
  // setup-vault.mjs is intentionally a standalone script with no
  // src/registry.mjs imports (runs in npm preinstall scenarios etc.).
  // If you change either copy, change BOTH and add a regression test.
  const isWindows = /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
  const base = (isWindows ? path.win32 : path.posix).basename(p);
  return base.replace(/^\./, '').toLowerCase();
}

function printStatus() {
  const cfg = loadConfig();
  console.log(c('bold', '\nobsidian-mcp-router — current configuration\n'));
  console.log('Config file:    ' + c('gray', CONFIG_PATH));
  console.log('Router binary:  ' + c('gray', ROUTER_BIN));
  console.log('Reference vault: ' + (cfg.referenceVault ? c('green', cfg.referenceVault) : c('red', 'NOT SET')));
  console.log('Port start:      ' + cfg.portStart);
  const entries = Object.entries(cfg.portRegistry || {});
  const disabled = new Set(Array.isArray(cfg.disabledVaults) ? cfg.disabledVaults : []);
  const vaultNames = cfg.vaultNames || {};
  if (entries.length === 0) {
    console.log('Configured vaults: ' + c('gray', '(none yet)'));
  } else {
    console.log(c('bold', '\nConfigured vaults:'));
    for (const [vault, port] of entries) {
      // disabledVaults entries can be NAME or PATH; check both, mirroring
      // src/registry.mjs.
      const name = vaultNames[vault] || defaultNameFromPath(vault);
      const isDisabled = disabled.has(name) || disabled.has(vault);
      const tag = isDisabled ? c('gray', '  (disabled)') : '';
      console.log(`  ${c('cyan', port)}  ${vault}${tag}`);
    }
  }
  console.log('');
}

function initReference(refPath) {
  const abs = path.resolve(refPath);
  if (!fs.existsSync(abs)) fail(`Path does not exist: ${abs}`);
  if (!fs.existsSync(path.join(abs, '.obsidian'))) fail(`Not an Obsidian vault (no .obsidian/): ${abs}`);

  const missing = [];
  for (const p of REQUIRED_PLUGINS) {
    const pluginDir = path.join(abs, '.obsidian', 'plugins', p);
    if (!fs.existsSync(pluginDir)) missing.push(p);
  }
  if (missing.length) {
    fail(
      `Reference vault is missing plugin(s): ${missing.join(', ')}.\n  ` +
      `Open this vault in Obsidian, install them via Community Plugins,\n  ` +
      `then re-run this command.`
    );
  }

  const cfg = loadConfig();
  cfg.referenceVault = abs;

  // Reserve the reference vault's current port in the registry so
  // bootstrapped vaults don't collide with it.
  const restDataPath = path.join(abs, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
  if (fs.existsSync(restDataPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(restDataPath, 'utf8'));
      if (data.port) {
        cfg.portRegistry[abs] = data.port;
        info(`Reserved port ${data.port} for the reference vault`);
      }
    } catch {}
  }

  saveConfig(cfg);
  ok(`Reference vault set to: ${abs}`);
  info('Plugins detected in reference: ' + PLUGINS_TO_CLONE.filter((p) =>
    fs.existsSync(path.join(abs, '.obsidian', 'plugins', p))
  ).join(', '));
}

function copyDirRecursive(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

function allocatePort(cfg, vaultPath) {
  if (cfg.portRegistry[vaultPath]) return cfg.portRegistry[vaultPath];
  const used = new Set(Object.values(cfg.portRegistry));
  let p = cfg.portStart;
  while (used.has(p)) p++;
  return p;
}

function patchRestApiData(vaultPath, port, apiKey) {
  const dataPath = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
  if (!fs.existsSync(dataPath)) {
    warn(`Local REST API data.json not found at ${dataPath} — plugin may regenerate it on first run.`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  data.apiKey = apiKey;
  data.port = port;
  data.bindingHost = '127.0.0.1';
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  ok(`Patched Local REST API data.json (port=${port}, fresh apiKey)`);
}

function ensureCommunityPlugins(vaultPath) {
  const cpPath = path.join(vaultPath, '.obsidian', 'community-plugins.json');
  let list = [];
  if (fs.existsSync(cpPath)) {
    try { list = JSON.parse(fs.readFileSync(cpPath, 'utf8')); } catch { list = []; }
  }
  const enabled = [];
  for (const p of PLUGINS_TO_CLONE) {
    const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', p);
    if (!fs.existsSync(pluginDir)) continue;
    if (!list.includes(p)) list.push(p);
    enabled.push(p);
  }
  fs.writeFileSync(cpPath, JSON.stringify(list, null, 2));
  ok(`Enabled plugins in community-plugins.json: ${enabled.join(', ')}`);
}

function writeEnvFile(vaultPath, apiKey, port, force) {
  const envPath = path.join(vaultPath, '.env');
  const baseUrl = `https://127.0.0.1:${port}`;
  if (fs.existsSync(envPath) && !force) {
    warn(`.env already exists, leaving it untouched. Use --force to overwrite.`);
    info(`Expected values:\n   VAULT_PATH=${vaultPath}\n   OBSIDIAN_API_KEY=${apiKey}\n   OBSIDIAN_BASE_URL=${baseUrl}`);
    return;
  }
  const content =
    `# obsidian-mcp-router — generated by setup-vault.mjs\n` +
    `VAULT_PATH=${vaultPath}\n` +
    `OBSIDIAN_API_KEY=${apiKey}\n` +
    `OBSIDIAN_BASE_URL=${baseUrl}\n`;
  fs.writeFileSync(envPath, content);
  ok(`Wrote ${envPath}`);
}

/**
 * Write .mcp.json at vault root that registers obsidian-mcp-router as the
 * project-scoped MCP server. The router itself reads the multi-vault registry
 * at ~/.claude/obsidian-mcp-router/config.json and auto-discovers each vault's
 * Local REST API key from .obsidian/plugins/obsidian-local-rest-api/data.json,
 * so no env vars or secrets need to live in this file.
 */
function writeMcpJson(vaultPath, force) {
  const mcpPath = path.join(vaultPath, '.mcp.json');
  if (fs.existsSync(mcpPath) && !force) {
    warn(`.mcp.json already exists, leaving it untouched. Use --force to overwrite.`);
    return;
  }
  const config = {
    mcpServers: {
      'obsidian-router': {
        command: NODE_EXE,
        args: [ROUTER_BIN],
      },
    },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2));
  ok(`Wrote ${mcpPath}`);
}

function appendGitignore(vaultPath) {
  const giPath = path.join(vaultPath, '.gitignore');
  const lines = ['.env', '.mcp.json', '.smart-env/'];
  let existing = '';
  if (fs.existsSync(giPath)) existing = fs.readFileSync(giPath, 'utf8');
  const toAdd = lines.filter((l) => !existing.split(/\r?\n/).includes(l));
  if (toAdd.length === 0) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(giPath, existing + sep + toAdd.join('\n') + '\n');
  ok(`Appended ${toAdd.join(', ')} to .gitignore`);
}

// Files OR directories at the root of the reference vault to clone to new vaults.
// Auto-skipped if already present in target (preserves user customizations) unless --force.
//
// `quick-reference-{fr,en}.pdf` are the printable cheat sheets (router overview
// + setup + every slash command with NL trigger phrases) — generated from the
// HTML sources in `obsidian-mcp-router/docs/` and committed to `.template/` so
// every bootstrapped vault inherits them. Update via:
//   1. Edit docs/quick-reference-{fr,en}.html in the obsidian-mcp-router repo
//   2. Re-render PDFs via Chrome headless (--print-to-pdf=...)
//   3. Copy PDFs to `.template/`
//   4. `npm run setup-vault -- <existing-vault> --sync-plugins --force` to push update.
//
// `.claude/` (directory) ships a per-workspace `.claude/settings.json` that enables
// the obsidian-router plugin scoped to this vault only — instead of forcing users
// to add it to their global `~/.claude/settings.json` (which would load the 30+
// slash commands + skills in EVERY Claude Code session, even on unrelated
// projects, costing ~10k context tokens per session). With project-scope, the
// plugin only loads in vault workspaces. The reference vault `.template/.claude/
// settings.json` is the canonical content; cpSync handles the directory clone
// recursively. Existing per-vault `.claude/settings.json` files are preserved by
// the no-overwrite guard (use --force to push template updates).
const ROOT_FILES_TO_CLONE = ['README.md', 'quick-reference-fr.pdf', 'quick-reference-en.pdf', '.claude'];

function cloneRootDocs(referenceVault, targetVault, force) {
  for (const item of ROOT_FILES_TO_CLONE) {
    const src = path.join(referenceVault, item);
    const dst = path.join(targetVault, item);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst) && !force) continue;
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
    }
    ok(`Cloned ${item} from reference vault`);
  }
}

function cloneSmartEnv(referenceVault, targetVault, force) {
  const srcDir = path.join(referenceVault, '.smart-env');
  if (!fs.existsSync(srcDir)) return;
  const dstDir = path.join(targetVault, '.smart-env');
  fs.mkdirSync(dstDir, { recursive: true });

  // Items to clone: config file + embedding model cache
  // Skip: event_logs, smart_contexts, smart_components, multi (vault-specific runtime)
  const itemsToClone = ['smart_env.json', 'embedding_models'];
  for (const item of itemsToClone) {
    const src = path.join(srcDir, item);
    const dst = path.join(dstDir, item);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst) && !force) {
      warn(`.smart-env/${item} already present, skipping (use --force to overwrite)`);
      continue;
    }
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
    }
    ok(`Cloned .smart-env/${item}`);
  }
}

function setupVault(vaultPath, opts = {}) {
  const cfg = loadConfig();
  if (!cfg.referenceVault) {
    fail(
      `No reference vault configured.\n  ` +
      `Run first:\n  ` +
      c('cyan', `  node "${fileURLToPath(import.meta.url)}" --init-reference <path-to-vault-with-plugins-installed>`)
    );
  }
  if (!fs.existsSync(cfg.referenceVault)) {
    fail(`Reference vault no longer exists: ${cfg.referenceVault}`);
  }

  const abs = path.resolve(vaultPath);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(abs, { recursive: true });
    ok(`Created vault directory: ${abs}`);
  }

  // BEFORE cloning anything: snapshot pre-existing REST API config in target
  // (so we can distinguish a fresh bootstrap from an adoption of an existing vault).
  let preExistingRestData = null;
  const preRestDataPath = path.join(abs, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
  if (fs.existsSync(preRestDataPath) && !opts.regenerate) {
    try {
      const data = JSON.parse(fs.readFileSync(preRestDataPath, 'utf8'));
      if (data.port && data.apiKey && data.apiKey.length > 16) {
        preExistingRestData = data;
      }
    } catch {}
  }

  // Clone plugins
  const targetObsidian = path.join(abs, '.obsidian');
  fs.mkdirSync(path.join(targetObsidian, 'plugins'), { recursive: true });
  for (const p of PLUGINS_TO_CLONE) {
    const srcPlugin = path.join(cfg.referenceVault, '.obsidian', 'plugins', p);
    const dstPlugin = path.join(targetObsidian, 'plugins', p);
    if (!fs.existsSync(srcPlugin)) {
      if (REQUIRED_PLUGINS.includes(p)) fail(`Required plugin missing in reference vault: ${p}`);
      continue;
    }
    if (fs.existsSync(dstPlugin) && !opts.force) {
      warn(`Plugin already present, skipping clone: ${p} (use --force to overwrite)`);
      continue;
    }
    if (fs.existsSync(dstPlugin)) fs.rmSync(dstPlugin, { recursive: true, force: true });
    copyDirRecursive(srcPlugin, dstPlugin);
    ok(`Cloned plugin: ${p}`);
  }

  // Ensure app.json exists so vault is "valid"
  const appJsonPath = path.join(targetObsidian, 'app.json');
  if (!fs.existsSync(appJsonPath)) {
    fs.writeFileSync(appJsonPath, '{}\n');
    ok('Created app.json');
  }

  // Decide port + apiKey: adopt pre-existing values if found, else generate fresh
  let port, apiKey, adopted = false;
  if (preExistingRestData) {
    const conflict = Object.entries(cfg.portRegistry).find(
      ([k, v]) => v === preExistingRestData.port && k !== abs
    );
    if (conflict) {
      fail(
        `Vault has existing port ${preExistingRestData.port} but that port is already registered to ${conflict[0]}.\n` +
        `  Pass --regenerate to assign a fresh port + key, or remove the conflicting entry from config.json.`
      );
    }
    port = preExistingRestData.port;
    apiKey = preExistingRestData.apiKey;
    adopted = true;
    info(`Adopted existing REST API config (port=${port}, apiKey=${apiKey.slice(0, 8)}…)`);
    info('Use --regenerate to overwrite with fresh credentials.');
  } else {
    port = allocatePort(cfg, abs);
    apiKey = generateApiKey();
  }
  // Always patch data.json so the values match (plugin clone may have overwritten with .template's port/key)
  patchRestApiData(abs, port, apiKey);
  ensureCommunityPlugins(abs);

  // Clone Smart Connections config + embedding cache from reference
  cloneSmartEnv(cfg.referenceVault, abs, opts.force);

  // Clone root-level docs (README.md etc.) from reference
  cloneRootDocs(cfg.referenceVault, abs, opts.force);

  // Project config files
  writeEnvFile(abs, apiKey, port, opts.force);
  writeMcpJson(abs, opts.force);
  appendGitignore(abs);

  // Persist port registry
  cfg.portRegistry[abs] = port;
  saveConfig(cfg);

  console.log('');
  console.log(c('bold', c('green', '✓ Vault setup complete')));
  console.log(`  Path:        ${abs}`);
  console.log(`  Port:        ${port}`);
  console.log(`  API key:     ${apiKey.slice(0, 12)}…  ${c('gray', '(full value in .env)')}`);
  console.log('');
  console.log(c('bold', 'Next steps:'));
  console.log(`  1. Open Obsidian → File → ${c('cyan', 'Open another vault')} → ${abs}`);
  console.log(`  2. Trust the vault when prompted`);
  console.log(`  3. Verify in Settings → Local REST API: port = ${port}, server enabled`);
  console.log(`  4. Verify in Settings → Community plugins: MCP Router Bridge is enabled`);
  console.log(`  5. Restart Claude Code in this project to load the new MCP server`);
  console.log('');
}

function syncPluginsMode(vaultPath, opts = {}) {
  const cfg = loadConfig();
  if (!cfg.referenceVault || !fs.existsSync(cfg.referenceVault)) {
    if (opts.quiet) process.exit(0);
    fail('No reference vault configured or it no longer exists.');
  }

  const abs = path.resolve(vaultPath);
  const targetObsidian = path.join(abs, '.obsidian');
  if (!fs.existsSync(targetObsidian)) {
    // Not an Obsidian vault — silent in quiet mode (hook will hit non-vault projects)
    if (opts.quiet) process.exit(0);
    fail(`Not an Obsidian vault (no .obsidian/): ${abs}`);
  }

  const refPluginsDir = path.join(cfg.referenceVault, '.obsidian', 'plugins');
  if (!fs.existsSync(refPluginsDir)) {
    if (opts.quiet) process.exit(0);
    fail(`Reference vault has no plugins dir: ${refPluginsDir}`);
  }

  const tgtPluginsDir = path.join(targetObsidian, 'plugins');
  fs.mkdirSync(tgtPluginsDir, { recursive: true });

  const refPlugins = fs.readdirSync(refPluginsDir).filter((p) => {
    try { return fs.statSync(path.join(refPluginsDir, p)).isDirectory(); }
    catch { return false; }
  });

  const newlySynced = [];
  const refreshed = [];
  for (const p of refPlugins) {
    const srcPlugin = path.join(refPluginsDir, p);
    const dstPlugin = path.join(tgtPluginsDir, p);
    const exists = fs.existsSync(dstPlugin);

    if (exists && !opts.force) continue;

    if (exists) {
      // --force: re-clone but preserve local data.json (port + apiKey + user settings)
      const dataJson = path.join(dstPlugin, 'data.json');
      let preserved = null;
      if (fs.existsSync(dataJson)) preserved = fs.readFileSync(dataJson);
      fs.rmSync(dstPlugin, { recursive: true, force: true });
      copyDirRecursive(srcPlugin, dstPlugin);
      if (preserved) fs.writeFileSync(dataJson, preserved);
      refreshed.push(p);
    } else {
      copyDirRecursive(srcPlugin, dstPlugin);
      newlySynced.push(p);
    }
  }

  // Sync .smart-env if missing locally
  const tgtSmartEnv = path.join(abs, '.smart-env');
  let smartEnvAdded = false;
  if (!fs.existsSync(tgtSmartEnv) && fs.existsSync(path.join(cfg.referenceVault, '.smart-env'))) {
    cloneSmartEnv(cfg.referenceVault, abs, false);
    smartEnvAdded = true;
  }

  // Sync root docs (README.md) — preserve user customizations unless --force
  cloneRootDocs(cfg.referenceVault, abs, opts.force);

  // Update community-plugins.json with newly synced plugins
  if (newlySynced.length > 0) {
    const cpPath = path.join(targetObsidian, 'community-plugins.json');
    let list = [];
    if (fs.existsSync(cpPath)) {
      try { list = JSON.parse(fs.readFileSync(cpPath, 'utf8')); } catch { list = []; }
    }
    for (const p of newlySynced) if (!list.includes(p)) list.push(p);
    fs.writeFileSync(cpPath, JSON.stringify(list, null, 2));
  }

  // Output: silent if nothing changed (especially in --quiet mode)
  if (opts.quiet) {
    if (newlySynced.length > 0) {
      console.log(`[obsidian-mcp-router] Synced ${newlySynced.length} new plugin(s) from .template: ${newlySynced.join(', ')}`);
    }
    process.exit(0);
  }

  if (newlySynced.length > 0) ok(`Synced ${newlySynced.length} new plugin(s): ${newlySynced.join(', ')}`);
  if (refreshed.length > 0) ok(`Refreshed ${refreshed.length} plugin(s) (--force): ${refreshed.join(', ')}`);
  if (smartEnvAdded) ok('Cloned .smart-env from reference vault');
  if (newlySynced.length === 0 && refreshed.length === 0 && !smartEnvAdded) {
    info('Already up to date with reference vault.');
  }
}

// ---------- CLI ----------
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage:
  node setup-vault.mjs <vault-path>                          Bootstrap a vault.
                                                              If vault already has a REST API port + apiKey
                                                              they are preserved (= adoption mode).
  node setup-vault.mjs <vault-path> --regenerate             Force fresh port + apiKey even if existing
  node setup-vault.mjs <vault-path> --force                  Overwrite existing files (.env, .mcp.json, README, etc.)
  node setup-vault.mjs <vault-path> --sync-plugins           Sync new plugins from reference vault
  node setup-vault.mjs <vault-path> --sync-plugins --force   Re-clone all plugins, preserving data.json
  node setup-vault.mjs <vault-path> --sync-plugins --quiet   Silent unless something changed (for hooks)
  node setup-vault.mjs --init-reference <path>               Register a vault as the reference template
  node setup-vault.mjs --status                              Show current configuration
`);
  process.exit(0);
}

if (args[0] === '--status') {
  printStatus();
  process.exit(0);
}

if (args[0] === '--init-reference') {
  if (!args[1]) fail('--init-reference requires a path');
  initReference(args[1]);
  process.exit(0);
}

const force = args.includes('--force');
const quiet = args.includes('--quiet');
const regenerate = args.includes('--regenerate');
const vaultArg = args.find((a) => !a.startsWith('--'));
if (!vaultArg) fail('No vault path provided');

if (args.includes('--sync-plugins')) {
  syncPluginsMode(vaultArg, { force, quiet });
  process.exit(0);
}

setupVault(vaultArg, { force, regenerate });
