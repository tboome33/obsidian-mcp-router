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
 *   node setup-vault.mjs <vault-path> --force            # overwrite existing files
 *   node setup-vault.mjs <vault-path> --regenerate       # force fresh port + apiKey
 *   node setup-vault.mjs <vault-path> --sync-plugins     # only sync new plugins from .template
 *   node setup-vault.mjs --bootstrap-reference <path>    # scaffold a fresh reference vault from
 *                                                          templates/reference-vault-skeleton/
 *                                                          + download bridge plugin from GitHub
 *   node setup-vault.mjs --init-reference <path>         # mark an existing vault as the reference
 *   node setup-vault.mjs --status                        # show config + registry
 *
 * Config file lives at: ~/.claude/obsidian-mcp-router/config.json
 * (kept outside this repo because it contains user-specific paths.)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
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
const REQUIRED_PLUGINS = ['obsidian-local-rest-api', 'mcp-router-bridge'];
// --- Optional plugins: cloned if present in reference vault, else skipped ---
// Note: this list is the SUPERSET of plugins setup-vault.mjs is willing to
// clone from a reference. The shipped skeleton's `community-plugins.json`
// (templates/reference-vault-skeleton/.obsidian/community-plugins.json) lists
// a SUBSET — the "default recommended set" enabled out of the box. `dataview`
// and `obsidian-bases` are NOT in the skeleton; they're cloned only if the
// user (a) adds them to their own reference vault later, OR (b) uses an
// existing reference vault that already has them. This divergence is
// intentional: the skeleton ships an opinionated minimal-but-useful set, the
// script accommodates any user-grown reference.
const OPTIONAL_PLUGINS = ['smart-connections', 'templater-obsidian', 'dataview', 'obsidian-bases', 'obsidian-quiet-outline'];
const PLUGINS_TO_CLONE = [...REQUIRED_PLUGINS, ...OPTIONAL_PLUGINS];

// --- Reference-vault skeleton: shipped with the repo, used by --bootstrap-reference --
// Contains: .obsidian/community-plugins.json + app.json, .smart-env/smart_env.json,
// .claude/settings.json, CLAUDE.md, wiki/{index,log,hot,overview}.md, README.md.
// Does NOT contain plugin binaries (license + size reasons); --bootstrap-reference
// downloads the bridge plugin from GitHub releases, and the user installs the
// remaining marketplace plugins via Obsidian's Community Plugins browser.
const SKELETON_DIR = path.join(REPO_ROOT, 'templates', 'reference-vault-skeleton');

// --- Bridge plugin release: only non-marketplace required plugin --
// `releases/latest/download/<asset>` is GitHub's stable URL pattern that
// 302-redirects to the latest release asset's signed CDN URL.
// `downloadToFile` follows the redirect chain. Both files are tiny
// (main.js ~few KB, manifest.json <1KB).
const BRIDGE_PLUGIN_URLS = {
  'main.js': 'https://github.com/tboome33/obsidian-mcp-router-bridge/releases/latest/download/main.js',
  'manifest.json': 'https://github.com/tboome33/obsidian-mcp-router-bridge/releases/latest/download/manifest.json',
};
// Expected plugin id in the manifest after download — guards against an
// HTML error page or a wrong asset being silently accepted as JSON.
const BRIDGE_EXPECTED_MANIFEST_ID = 'mcp-router-bridge';

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
  // Convention: enable the unencrypted HTTP server on `port + 10`, bound to
  // loopback. Used by the bridge plugin's GET /open/<path> route to produce
  // click-to-open URLs that work even when an antivirus (Bitdefender, ESET,
  // Kaspersky) silently drops self-signed HTTPS loopback connections — those
  // products intercept HTTPS for inspection and refuse the plugin's
  // auto-generated cert, with no browser-side warning. Plain HTTP on
  // 127.0.0.1 sidesteps the issue. Each vault gets a unique HTTP port via
  // the `+ 10` offset so multiple vaults can have HTTP enabled
  // simultaneously without binding the same socket. Safe because: bind is
  // loopback-only, the public route /open/* is navigation-only (no read,
  // write, or exec capability — it calls workspace.openLinkText), and the
  // routes that DO read/write/search still require the apiKey on the
  // HTTPS port. Documented in the user's CLAUDE.md "Obsidian vault links"
  // section.
  data.insecurePort = port + 10;
  data.enableInsecureServer = true;
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  ok(`Patched Local REST API data.json (port=${port}, insecurePort=${port + 10}, HTTP enabled, fresh apiKey)`);
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

// Clone Obsidian CSS snippets from reference vault. Currently ships
// `no-task-strikethrough.css` (kills the default rendering of `~~text~~`
// on `- [x]` items — aligned with the `roadmap-discipline` v0.10.1 §2bis
// convention). Future-proofed: every `.css` file under the reference's
// `.obsidian/snippets/` is copied, and every snippet basename is added to
// `appearance.json`'s `enabledCssSnippets` array.
function cloneSnippets(referenceVault, targetVault, force) {
  const srcDir = path.join(referenceVault, '.obsidian', 'snippets');
  if (!fs.existsSync(srcDir)) return;

  const snippets = fs.readdirSync(srcDir).filter((f) => f.endsWith('.css'));
  if (snippets.length === 0) return;

  const dstDir = path.join(targetVault, '.obsidian', 'snippets');
  fs.mkdirSync(dstDir, { recursive: true });

  const copiedBasenames = [];
  for (const snippet of snippets) {
    const src = path.join(srcDir, snippet);
    const dst = path.join(dstDir, snippet);
    if (fs.existsSync(dst) && !force) {
      warn(`Snippet already present, skipping clone: ${snippet} (use --force to overwrite)`);
      copiedBasenames.push(snippet.replace(/\.css$/, ''));
      continue;
    }
    fs.copyFileSync(src, dst);
    copiedBasenames.push(snippet.replace(/\.css$/, ''));
    ok(`Cloned snippet: ${snippet}`);
  }

  // Patch appearance.json so the snippets actually load. Without this step,
  // the file lives on disk but Obsidian ignores it.
  enableSnippetsInAppearance(targetVault, copiedBasenames);
}

// Merge a list of snippet basenames into `<vault>/.obsidian/appearance.json`'s
// `enabledCssSnippets` array. Creates the file if missing. Idempotent: a
// snippet already in the array is not duplicated.
function enableSnippetsInAppearance(targetVault, snippetBasenames) {
  if (!snippetBasenames || snippetBasenames.length === 0) return;

  const appearancePath = path.join(targetVault, '.obsidian', 'appearance.json');
  let appearance = {};
  if (fs.existsSync(appearancePath)) {
    try {
      appearance = JSON.parse(fs.readFileSync(appearancePath, 'utf8'));
    } catch {
      // File is malformed — start fresh rather than crash the bootstrap.
      appearance = {};
    }
  }

  const enabled = new Set(appearance.enabledCssSnippets || []);
  let added = 0;
  for (const basename of snippetBasenames) {
    if (!enabled.has(basename)) {
      enabled.add(basename);
      added++;
    }
  }

  if (added === 0) return;

  appearance.enabledCssSnippets = Array.from(enabled);
  fs.mkdirSync(path.dirname(appearancePath), { recursive: true });
  fs.writeFileSync(appearancePath, JSON.stringify(appearance, null, 2) + '\n');
  ok(`Enabled ${added} CSS snippet(s) in appearance.json`);
}

// HTTPS GET with redirect following (GitHub releases use 302 chains).
// Caps at 5 hops to avoid infinite redirect loops. Streams to a file rather
// than buffering — the bridge plugin assets are small (~few KB) so this is
// belt-and-suspenders, but keeps the helper reusable for larger downloads.
// On ANY error (network, HTTP non-200, timeout, write failure) the partial
// destination file is unlinked so the caller can retry or fall back to the
// manual install path without an unusable truncated file sitting on disk.
function downloadToFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const cleanup = (err) => fs.unlink(destPath, () => reject(err));
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'obsidian-mcp-router-bootstrap' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return cleanup(new Error(`Too many redirects: ${url}`));
          const next = new URL(res.headers.location, url).toString();
          return downloadToFile(next, destPath, redirectsLeft - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return cleanup(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''} for ${url}`));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', cleanup);
        res.on('error', cleanup);
      },
    );
    req.on('error', cleanup);
    req.setTimeout(30_000, () => req.destroy(new Error(`Timeout fetching ${url}`)));
  });
}

// Sanity-check the downloaded bridge plugin: manifest.json must be valid JSON
// with the expected plugin id. We've seen edge cases where a CDN returns an
// HTML error page with HTTP 200 in front of GitHub release URLs, and we want
// to catch that BEFORE the user enables the plugin in Obsidian and hits an
// opaque "plugin failed to load" with a JS syntax error in console.
function validateBridgePlugin(pluginDir) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const mainJsPath = path.join(pluginDir, 'main.js');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON — likely an HTML error page leaked through: ${err.message}`);
  }
  if (manifest.id !== BRIDGE_EXPECTED_MANIFEST_ID) {
    throw new Error(`manifest.json id mismatch: got "${manifest.id}", expected "${BRIDGE_EXPECTED_MANIFEST_ID}"`);
  }
  // main.js sanity: if the first bytes look like HTML (`<!DOCTYPE`, `<html`),
  // it's not a plugin bundle. We don't try to parse it as JS — too brittle —
  // just refuse the obvious HTML-error-page case.
  const head = fs.readFileSync(mainJsPath, { encoding: 'utf8', flag: 'r' }).slice(0, 64).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    throw new Error('main.js looks like an HTML page, not a JS bundle');
  }
}

async function downloadBridgePlugin(pluginDir) {
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const [asset, url] of Object.entries(BRIDGE_PLUGIN_URLS)) {
    const dst = path.join(pluginDir, asset);
    info(`Downloading mcp-router-bridge/${asset}…`);
    await downloadToFile(url, dst);
    ok(`Downloaded ${asset}`);
  }
  validateBridgePlugin(pluginDir);
  ok(`Validated mcp-router-bridge manifest (id="${BRIDGE_EXPECTED_MANIFEST_ID}")`);
}

// Refuse paths that, combined with the destructive `--force` flag, could wipe
// important user content if pasted by accident. We check:
//   - empty / "." / "/" / Windows drive root (`C:\` or `C:`)
//   - the user's HOME directory itself
//   - the OS temp dir root
// We intentionally do NOT try to enumerate "system" paths like /etc, /usr,
// C:\Windows — fs permissions handle those. We catch the realistic footgun:
// `--bootstrap-reference C:\Users\me --force` blowing away Documents/Desktop.
function assertSafeBootstrapTarget(abs) {
  if (!abs || abs === '.' || abs === '/' || abs === '\\') {
    fail(`Refusing to bootstrap into "${abs}" — pass an explicit subdirectory path.`);
  }
  // Windows drive root: "C:" or "C:\" (path.resolve normalizes to "C:\")
  if (/^[A-Za-z]:[\\/]?$/.test(abs)) {
    fail(`Refusing to bootstrap into drive root "${abs}".`);
  }
  const norm = path.resolve(abs);
  const dangerous = [
    path.resolve(os.homedir()),
    path.resolve(os.tmpdir()),
  ];
  if (dangerous.includes(norm)) {
    fail(
      `Refusing to bootstrap into "${norm}" — it's your home dir or temp root.\n  ` +
      `Choose a dedicated subdirectory (e.g. ${path.join(norm, '.template')}).`
    );
  }
}

async function bootstrapReference(targetPath, opts = {}) {
  if (!fs.existsSync(SKELETON_DIR)) {
    fail(
      `Skeleton not found at ${SKELETON_DIR}.\n  ` +
      `This shouldn't happen with a normal checkout of obsidian-mcp-router.\n  ` +
      `Verify the templates/reference-vault-skeleton/ directory exists in the repo.`
    );
  }

  const abs = path.resolve(targetPath);
  assertSafeBootstrapTarget(abs);

  // Refuse if target exists and is non-empty, unless --force.
  // We don't want to silently merge into a directory that may contain unrelated
  // user content (or worse, a vault with real notes the user might think is being
  // upgraded — that's what setup-vault.mjs <path> --sync-plugins is for).
  if (fs.existsSync(abs)) {
    const contents = fs.readdirSync(abs);
    if (contents.length > 0 && !opts.force) {
      fail(
        `Target directory is not empty: ${abs}\n  ` +
        `Pass --force to overwrite (DESTRUCTIVE), or choose a different path.\n  ` +
        `If this is already a working vault, use --init-reference instead to just register it.`
      );
    }
  }

  fs.mkdirSync(abs, { recursive: true });

  // Copy the skeleton — handles nested dirs (.obsidian/, .smart-env/, wiki/, .claude/).
  // We don't need an entry-level "skip if exists" branch: the emptiness check
  // above already gated the whole operation. With --force we wipe-and-replace
  // each entry; without --force we only get here when the target was empty.
  info(`Cloning skeleton from ${SKELETON_DIR}…`);
  for (const entry of fs.readdirSync(SKELETON_DIR)) {
    const src = path.join(SKELETON_DIR, entry);
    const dst = path.join(abs, entry);
    if (fs.existsSync(dst) && opts.force) {
      fs.rmSync(dst, { recursive: true, force: true });
    }
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
    }
    ok(`Cloned ${entry}`);
  }

  // Download bridge plugin — the only non-marketplace REQUIRED plugin. The
  // other required plugin (obsidian-local-rest-api) and the optional plugins
  // (smart-connections, templater-obsidian, obsidian-quiet-outline) all live
  // in Obsidian's Community Plugins marketplace, so the user installs them
  // via Obsidian after we hand off. Obsidian auto-prompts to install plugins
  // that are listed in `.obsidian/community-plugins.json` but not yet present
  // under `.obsidian/plugins/`, which makes that step a couple of clicks.
  //
  // On any failure (download or validation), nuke the partially-populated
  // plugin dir so we don't leave a broken plugin that Obsidian would refuse
  // to load with a confusing error.
  const bridgeDir = path.join(abs, '.obsidian', 'plugins', 'mcp-router-bridge');
  try {
    await downloadBridgePlugin(bridgeDir);
  } catch (err) {
    if (fs.existsSync(bridgeDir)) fs.rmSync(bridgeDir, { recursive: true, force: true });
    warn(`Bridge plugin acquisition failed: ${err.message}`);
    warn(`Install manually from: https://github.com/tboome33/obsidian-mcp-router-bridge/releases/latest`);
    warn(`  → drop main.js + manifest.json into ${bridgeDir}`);
  }

  // Record the path in config.json. We don't call initReference() because
  // its REQUIRED_PLUGINS check would fail (Local REST API isn't installed
  // yet — user does that via Obsidian in the next step). The port reservation
  // also happens later, after the user has launched Obsidian and the Local
  // REST API plugin has written its data.json with the auto-generated port.
  const cfg = loadConfig();
  cfg.referenceVault = abs;
  saveConfig(cfg);
  ok(`Recorded referenceVault = ${abs}`);

  console.log('');
  console.log(c('bold', c('green', '✓ Reference vault skeleton created')));
  console.log('');
  console.log(c('bold', 'Next steps:'));
  console.log(`  1. Open Obsidian → File → ${c('cyan', 'Open another vault')} → ${abs}`);
  console.log(`  2. Trust the vault when prompted.`);
  console.log(`  3. Obsidian will prompt you to install the plugins listed in community-plugins.json.`);
  console.log(`     Click ${c('cyan', 'Install')} for: Local REST API, Smart Connections, Templater, Quiet Outline.`);
  console.log(`     (The bridge plugin is already in place — no action needed for it.)`);
  console.log(`  4. Enable all four in Settings → Community plugins.`);
  console.log(`  5. Restart Obsidian once so Local REST API generates its certificate.`);
  console.log(`  6. ${c('bold', 'Finalize')}: ${c('cyan', `node "${fileURLToPath(import.meta.url)}" --init-reference "${abs}"`)}`);
  console.log(`     This validates the required plugins are present and reserves the port.`);
  console.log('');
  console.log(c('gray', `After step 6, bootstrap any new vault with:`));
  console.log(c('gray', `  node ${path.basename(fileURLToPath(import.meta.url))} <new-vault-path>`));
  console.log('');
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

  // Clone Obsidian CSS snippets (no-task-strikethrough.css + any others)
  // and patch appearance.json to enable them.
  cloneSnippets(cfg.referenceVault, abs, opts.force);

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

  // Sync Obsidian CSS snippets (no-task-strikethrough.css + any future ones)
  // and patch appearance.json — idempotent, never blocks existing snippets.
  cloneSnippets(cfg.referenceVault, abs, opts.force);

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
  node setup-vault.mjs --sync-all                            Run --sync-plugins on every vault in portRegistry
  node setup-vault.mjs --sync-all --force                    Same, force-overwrite plugins + snippets
  node setup-vault.mjs --bootstrap-reference <path>          Scaffold a fresh reference vault from the
                                                              shipped skeleton + download bridge plugin.
                                                              Follow up with --init-reference once you've
                                                              installed the marketplace plugins via Obsidian.
  node setup-vault.mjs --init-reference <path>               Register a vault as the reference template
  node setup-vault.mjs --status                              Show current configuration
`);
  process.exit(0);
}

if (args[0] === '--status') {
  printStatus();
  process.exit(0);
}

if (args[0] === '--sync-all') {
  // Iterate over portRegistry and run sync-plugins on each vault.
  // Convenient bulk operation for: pushing a new snippet, a new plugin,
  // or a refreshed reference vault to every configured vault at once.
  // Idempotent — vaults that are already in sync are no-ops.
  const cfg = loadConfig();
  if (!cfg.referenceVault || !fs.existsSync(cfg.referenceVault)) {
    fail('No reference vault configured or it no longer exists.');
  }
  const force = args.includes('--force');
  const targets = Object.keys(cfg.portRegistry || {});
  if (targets.length === 0) {
    info('No vaults in portRegistry. Nothing to do.');
    process.exit(0);
  }
  console.log(c('bold', `Syncing ${targets.length} vault(s) from ${cfg.referenceVault}${force ? ' (--force)' : ''}…`));
  console.log('');
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  for (const vaultPath of targets) {
    // Skip the reference vault itself — syncing it to itself is a no-op
    // and just adds noise to the output.
    if (path.resolve(vaultPath) === path.resolve(cfg.referenceVault)) {
      console.log(c('gray', `  - skip (reference): ${vaultPath}`));
      skipCount++;
      continue;
    }
    if (!fs.existsSync(vaultPath)) {
      console.log(c('yellow', `  - skip (path missing): ${vaultPath}`));
      skipCount++;
      continue;
    }
    if (!fs.existsSync(path.join(vaultPath, '.obsidian'))) {
      console.log(c('yellow', `  - skip (no .obsidian): ${vaultPath}`));
      skipCount++;
      continue;
    }
    try {
      console.log(c('cyan', `  → ${vaultPath}`));
      syncPluginsMode(vaultPath, { force, quiet: false });
    } catch (err) {
      // syncPluginsMode normally exits on error via fail() — but if it returns,
      // count it as a soft failure and keep iterating the rest.
      console.log(c('red', `    failed: ${err.message || err}`));
      failCount++;
      continue;
    }
    okCount++;
  }
  console.log('');
  console.log(c('bold', `Done. ${okCount} synced, ${skipCount} skipped, ${failCount} failed.`));
  process.exit(failCount > 0 ? 1 : 0);
}

if (args[0] === '--init-reference') {
  if (!args[1]) fail('--init-reference requires a path');
  initReference(args[1]);
  process.exit(0);
}

if (args[0] === '--bootstrap-reference') {
  const pathArg = args[1];
  // Refuse explicitly known flag tokens here rather than the broader
  // `startsWith('--')` heuristic (which would false-positive a literal path
  // like `--my-folder`). The known flags consumed by this subcommand:
  if (!pathArg || pathArg === '--force' || pathArg === '--help' || pathArg === '-h') {
    fail('--bootstrap-reference requires a path');
  }
  const bootstrapForce = args.includes('--force');
  await bootstrapReference(pathArg, { force: bootstrapForce });
  // Flush stdout before exit: process.exit() is synchronous and on piped
  // stdout (e.g. `> out.txt`) can truncate the next-steps message. The
  // promise resolves only after the drain callback fires, then we exit.
  // Using await here (rather than a callback) keeps the script from falling
  // through to the <vault-path> branch below while we wait for the flush.
  await new Promise((resolve) => process.stdout.write('', resolve));
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
