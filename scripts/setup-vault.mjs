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
import { assertDotenvScalar } from '../src/helpers/dotenv-scalar.mjs';
import { obsidianOpenUri, launchObsidianVault } from '../src/helpers/obsidian-launcher.mjs';
import {
  updateConfigBindings,
  withBinding,
  withoutBinding,
  withMigrationState,
  readBinding,
} from '../src/helpers/workspace-bindings.mjs';
import { acquireLock, lockPathFor } from '../src/helpers/file-lock.mjs';
import { writeFileAtomicSync } from '../src/helpers/write-file-atomic.mjs';
import { snapshotConfig, mergeConfigOntoDisk } from '../src/helpers/config-merge.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { samePath, canonicalPath } from './path-helpers.mjs';
import { resolvePluginsToClone } from './plugin-resolver.mjs';
import { parseSemver, compareSemver } from '../src/helpers/semver-compare.mjs';
import { extractTarGz, assertSafeRepoRef, httpsGetBuffer } from '../src/helpers/targz-extract.mjs';
import { computePlanSeal, verifyPlanSeal, isPlanSeal, PlanDriftError } from '../src/helpers/plan-seal.mjs';
import { subprocessOptions } from '../src/helpers/subprocess-env.mjs';
import {
  defaultNameFromPath,
  disabledVaultEntries,
  knownVaultSlugs,
  referenceVaultPath,
  registeredVaultPaths,
  resolveVaultBySlug,
  vaultSlug,
  vaultsRootPath,
} from '../src/helpers/vault-slug.mjs';
// Filesystem-safe slug for a NEW vault's folder name, aliased against the many
// local `slug` bindings already in this file (vaultSlug results, --attach
// params) — see the vaultsRoot-composition block below for why this is a
// deliberately DIFFERENT derivation from `buildProvisionPlan`'s vaultNames
// slug (a bare lowercase of --name).
import { slug as slugifyForPath } from '../src/helpers/filters/slug.mjs';
import {
  DEFAULT_INSECURE_OFFSET,
  normalizePortEntry,
  allocatePortPair,
  allocateInsecurePortFor,
  buildPortIndex,
  migratePortRegistry,
  detectPortCollisions,
  summarizePortCollisions,
} from '../src/helpers/port-registry.mjs';
import {
  CATALOG_BASENAME,
  JOURNAL_BASENAME,
  WIKI_META_SCAFFOLDS,
  resolveScaffold,
  scaffoldWritePath,
  scaffoldMigrationHint,
} from '../src/helpers/wiki-meta-scaffolds.mjs';
import { generateProjectionsOnDisk } from '../src/helpers/okf-projections-fs.mjs';
import { generateSearchIndexOnDisk } from '../src/helpers/bm25-index-fs.mjs';
import { hasProjectionMarker } from '../src/helpers/okf-projections.mjs';
import {
  buildProvisionPlan,
  resolveSourceVault,
  resolvePluginProfile,
  existingSlugs,
} from './vault-plan.mjs';

// --- Config path: user-home, NOT relative to this script ---------------------
// The script lives inside the router repo (which is git-tracked and may live
// anywhere), so we anchor config.json in the user's home dir under our project
// name. The router itself reads from the same path by default.
//
// `OBSIDIAN_ROUTER_CONFIG` env var overrides the default — mirrors the router
// binary's own `--config` flag / env var (see src/index.mjs). This lets the
// meta-sync-template skill read `list_vaults.configPath` and pass the SAME
// active config path back into setup-vault.mjs, instead of falling back to a
// hard-coded `~/.claude/...`. Also used by the test suite to point at temp
// config fixtures (see tests/setup-vault-safety.test.mjs).
const CONFIG_PATH = process.env.OBSIDIAN_ROUTER_CONFIG
  ? path.resolve(process.env.OBSIDIAN_ROUTER_CONFIG)
  : path.join(
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

// --- Credentialed plugins (data.json carries per-vault secrets) -------------
// Plugins whose folder contains a per-vault credential file. The
// reference vault's `data.json` for these holds its OWN port + API
// key — copying that file into any target would leak the credential
// across vaults (every target ends up with the same key, and the
// bound port would conflict on first plugin start).
//
// `syncPluginsMode()` (--sync-plugins) handles these specially:
//   - First-time copy (no plugin folder in target):  refuse, ask user
//     to bootstrap via `setup-vault.mjs <path>` first (generates a
//     fresh port + key per vault).
//   - --force refresh AND target's data.json exists:  preserved
//     across re-clone (read → rm → copy code → write data.json back).
//   - --force refresh AND target's data.json MISSING (folder existed
//     but plugin was never activated):  also refuse, same as first
//     time — otherwise we'd overwrite the empty slot with the
//     reference's data.json. See codex P1 finding for the regression
//     trail.
//
// Note: `setupVault()` (full bootstrap path, NOT --sync-plugins) is
// safe for these plugins because it explicitly overwrites data.json
// with a freshly-generated port + key via `patchRestApiData()`
// immediately after the clone.
const CREDENTIAL_LEAK_PLUGINS = new Set(['obsidian-local-rest-api']);

// Plugins the --sync-from-github vetting may EVER copy from a network
// archive. Pinned in code — versioned with this script — so a hostile or
// compromised archive cannot enlarge its own allowlist through the
// community-plugins.json it ships (review+ finding: the allowlist was read
// from the archive itself, a circular trust). Mirrors the curated template
// set (Lot 2) plus the dev conveniences of the living .template. A plugin
// outside this set is NEVER copied from the network, whatever the archive
// claims; note the residual trust boundary stays repo+ref+HTTPS — a hostile
// archive could still ship its own code UNDER one of these names, which is
// why --repo away from the default requires --trust-repo.
const NETWORK_PLUGIN_ALLOWLIST = new Set([
  'obsidian-local-rest-api',
  'mcp-router-bridge',
  'obsidian42-brat',
  'obsidian-quiet-outline',
  'obsidian-style-settings',
  'obsidian-icon-folder',
  'recent-files-obsidian',
  'realclaudian',
  'image-converter',
  'rich-text-editor',
  'templater-obsidian',
  'obsidian-livesync',
  'smart-connections',
  'hot-reload',
]);
// --- Plugin clone list: DERIVED from the source, not a hardcoded constant ---
// `resolvePluginsToClone(referenceVault, REQUIRED_PLUGINS)` (plugin-resolver.mjs)
// reads the reference vault's own `.obsidian/community-plugins.json` — the set
// Obsidian has ENABLED there — and unions it with REQUIRED_PLUGINS. Any plugin
// the reference enables (smart-connections, templater, dataview, bases,
// quiet-outline, hot-reload, obsidian42-brat, realclaudian, …) propagates
// automatically. This replaced the old hardcoded OPTIONAL_PLUGINS list, which
// drifted out of sync with the skeleton's community-plugins.json ("activated
// but never cloned"). REQUIRED_PLUGINS remains the only hard list: those MUST
// physically exist in the reference or the clone loop fails loudly.
//
// `hot-reload` (pjeby) auto-reloads a plugin whose files change on disk IF its
// folder carries a `.hotreload` (or `.git`) marker — the bridge's deploy.mjs
// drops that marker so `npm run deploy:all` reloads the bridge live in every
// open vault. `obsidian42-brat` (TfTHacker, MIT) auto-installs + auto-updates
// GitHub-only plugins (the bridge, hot-reload) from releases at startup. Both
// are cloned automatically when the reference enables them.

// --- Reference-vault skeleton: shipped with the repo, used by --bootstrap-reference --
// Contains: .obsidian/{community-plugins,app,appearance}.json, the vendored
// Blue Topaz theme + obsidian42-brat plugin (both MIT — see NOTICE) with BRAT's
// data.json pre-wired on the bridge repo, non-secret data.json for the
// quiet-outline/icon-folder/bridge plugins, .smart-env/smart_env.json,
// .claude/settings.json, CLAUDE.md, wiki-meta scaffolds, README.md.
// Marketplace plugin BINARIES are still not vendored (license + size);
// --bootstrap-reference downloads the bridge plugin from GitHub releases, BRAT
// pulls its pluginList at startup, and the user installs the remaining
// marketplace plugins via Obsidian's Community Plugins browser.
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

const DEFAULT_CONFIG = { referenceVault: null, portStart: 27124, portRegistry: {} };

// Read-only config load: returns the on-disk config, or an in-memory default
// WITHOUT creating the file. Used by `--dry-run`, which must never write.
function loadConfigReadOnly() {
  if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { ...DEFAULT_CONFIG }; }
}

/**
 * What each loaded config looked like WHEN IT WAS READ, per top-level key, so
 * `saveConfig` can tell which keys this process actually changed. See
 * `src/helpers/config-merge.mjs` for the rule and the reason.
 *
 * KEYED ON THE CONFIG OBJECT ITSELF, not a module-level "last loaded". This
 * script calls `loadConfig()` from eighteen places, and several of its
 * commands call helpers that load again; a single "last" slot would then
 * describe a LATER read than the object being saved, and the merge would
 * compare a snapshot against the wrong config — silently taking the disk's
 * value for a key this process had in fact changed, or the reverse. Nothing in
 * today's call graph nests that way, but "today's call graph" is not a
 * property anyone maintains, and the WeakMap removes the question instead of
 * answering it once.
 *
 * @type {WeakMap<object, Record<string, string>>}
 */
const CONFIG_SNAPSHOTS = new WeakMap();

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    // Through `saveConfig`, like every other write of this file. This was the
    // second bare `writeFileSync` of the config — found not by the review but
    // by the guard written for the review's finding, on its first run. Two
    // processes bootstrapping at once would otherwise race to create it.
    saveConfig(DEFAULT_CONFIG);
  }
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  CONFIG_SNAPSHOTS.set(parsed, snapshotConfig(parsed));
  return parsed;
}

/**
 * Write the whole config back — UNDER THE SAME LOCK AND THROUGH THE SAME
 * ATOMIC WRITER as the binding registry.
 *
 * Round 2 of the Codex review (2026-09-03): this used to be a bare
 * `writeFileSync`. `updateConfigBindings` was "the one writer" of
 * `workspaceBindings`, and it took a lock — but this function rewrites the
 * ENTIRE file from an in-memory copy, so the ordering "setup reads config A;
 * a session confirms binding B under the lock; setup saves stale A" deleted B
 * without either side noticing, and the same ordering loses an API key edit.
 * A lock only one of two writers takes is not a lock.
 *
 * The lock is the very one the binding writer takes, keyed on the canonical
 * config path, so the two exclude each other.
 *
 * THE LOCK ALONE WAS NOT ENOUGH, and the comment that used to stand here said
 * it was. It claimed "every such caller reads, changes and saves in one
 * synchronous stretch, and the lock makes that stretch exclusive" — but the
 * lock is taken by THIS function, at the save, not at the read. `setupVault`
 * reads the config, then clones plugin directories and probes ports, then
 * saves: seconds later, and a `confirm_workspace_binding` that landed in
 * between was inside the snapshot's blind spot and disappeared. Synchronous is
 * not short. Found in the final review, 2026-09-03.
 *
 * What closes it is a three-way merge at TOP-LEVEL KEY granularity, done
 * inside the lock: the snapshot taken when THIS config object was read, the file
 * is re-read now, and a key is written from the snapshot only when this
 * process actually changed it. Everything else — a binding, an API key, a port
 * another writer added — comes from the disk. The rule itself is a pure
 * function in `src/helpers/config-merge.mjs`, where it is tested exhaustively
 * without needing a race to be reproduced.
 */
function saveConfig(cfg) {
  const release = acquireLock(lockPathFor(CONFIG_PATH, 'config'));
  if (!release) {
    throw new Error(
      `another process is writing ${CONFIG_PATH} and did not finish in time — nothing was changed, run the command again`,
    );
  }
  try {
    writeFileAtomicSync(CONFIG_PATH, JSON.stringify(mergeOntoDisk(cfg), null, 2));
  } finally {
    release();
  }
}

/**
 * Merge the in-memory config onto whatever the file holds NOW. Called only
 * from inside `saveConfig`'s lock — see its header for why this exists.
 *
 * The RULE lives in `src/helpers/config-merge.mjs`, as a pure function of
 * three JSON values, so it can be tested exhaustively without a race. This is
 * the I/O around it and has no rules of its own.
 *
 * @param {object} cfg the snapshot this process is saving
 * @returns {object} what should be written
 */
function mergeOntoDisk(cfg) {
  // The snapshot of THIS object, or none when the caller built the config
  // itself (the bootstrap write of DEFAULT_CONFIG) — in which case there is
  // nothing on disk it could be clobbering that it knows about.
  const snapshot = CONFIG_SNAPSHOTS.get(cfg);
  if (!snapshot) return cfg;
  let onDisk;
  try {
    onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // Unreadable or gone since we read it: our snapshot is the only config
    // there is, and refusing to write would leave the user with nothing.
    return cfg;
  }
  return mergeConfigOntoDisk(cfg, onDisk, snapshot);
}

/**
 * Copy `config.json` next to itself under a timestamped name, and return that
 * path (or null when there was nothing to copy).
 *
 * Taken before the port-registry migration rewrites the file's shape. The
 * migration is designed to be lossless, but "designed to be" is not "proven
 * on your machine": the backup is what makes the change reversible by hand,
 * with no tooling, at 2am.
 */
function backupConfigFile(reason = 'backup') {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${CONFIG_PATH}.${reason}-${stamp}.bak`;
  fs.copyFileSync(CONFIG_PATH, dest);
  return dest;
}

/**
 * Bring `portRegistry` from the legacy HTTPS-only shape to the two-port shape,
 * reading each vault's plaintext port from its own `data.json`.
 *
 * Non-destructive on three counts: a timestamped backup of the file is taken
 * before the write; a vault whose `data.json` cannot be read keeps `http:
 * null` (the plaintext port is recorded as UNKNOWN, never invented from
 * `port + 10`); and an entry that resolves to nothing usable is preserved
 * verbatim rather than replaced by nulls.
 *
 * Mutates and saves `cfg` only when something actually changed, so it is safe
 * to call on every provisioning run — which is the point: a legacy registry is
 * at its most dangerous precisely when a new vault is about to be allocated.
 *
 * @returns {{ changed: boolean, backup: string|null, entries: Array }}
 */
function migrateConfigPortRegistry(cfg, { quiet = false, dryRun = false } = {}) {
  const onDisk = buildOnDiskPortMap(cfg);
  const { changed, portRegistry, entries } = migratePortRegistry(cfg, { onDisk });
  if (!changed) return { changed: false, backup: null, entries };
  if (dryRun) {
    if (!quiet) {
      for (const e of entries.filter((x) => x.status !== 'unchanged')) {
        info(`[DRY-RUN] ${e.vaultPath} — would record https=${e.after.https}, http=${e.after.http ?? 'unknown'} (${e.httpSource})`);
      }
    }
    return { changed: true, backup: null, entries };
  }
  const backup = backupConfigFile('portRegistry');
  cfg.portRegistry = portRegistry;
  saveConfig(cfg);
  if (!quiet) {
    const migrated = entries.filter((e) => e.status === 'migrated' || e.status === 'completed');
    const unknown = migrated.filter((e) => e.httpSource === 'unknown');
    ok(`portRegistry migrated to the two-port shape (${migrated.length} entr${migrated.length === 1 ? 'y' : 'ies'}).`);
    if (backup) info(`Previous config backed up to ${backup}`);
    if (unknown.length) {
      warn(
        `${unknown.length} vault(s) have no readable data.json — their plaintext port is recorded as unknown ` +
        `rather than guessed as port+${DEFAULT_INSECURE_OFFSET}. Open them in Obsidian once, then re-run ` +
        `--sync-port-registry.`,
      );
    }
  }
  return { changed: true, backup, entries };
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

// `defaultNameFromPath` used to be inlined here, on the grounds that
// setup-vault.mjs is "intentionally a standalone script with no
// src/registry.mjs imports". It still imports no registry — but it imports
// eight other `src/helpers/` modules (see the top of this file), so the
// premise no longer justified a copy. It comes from
// src/helpers/vault-slug.mjs as of v0.90.0, along with the `vaultNames`
// lookup it is the fallback for; that module reaches only `node:path`, so the
// preinstall scenarios the comment worried about are still fine.
//
// "MUST match src/registry.mjs's exactly" is now true because it IS the same
// function, rather than because two copies were kept in step by hand.

// Note: samePath() / canonicalPath() live in scripts/path-helpers.mjs
// (imported at the top of this file). Extracted so unit tests can hit
// them without spawning this CLI as a subprocess.

// ---------------------------------------------------------------------------
// v0.12.1 — wiki/<scaffold>.md → wiki-meta/<scaffold>.md migration
// ---------------------------------------------------------------------------

/**
 * The 4 canonical scaffolds that move from `wiki/` to `wiki-meta/` in v0.12.0.
 *
 * These are the v0.12.0-era BASENAMES and must stay that way: this list drives
 * the `--migrate-wiki-meta` path, whose input is a pre-v0.12.0 vault carrying
 * `wiki/index.md` + `wiki/log.md`. It lands them on `wiki-meta/index.md` +
 * `wiki-meta/log.md`, which v0.58.0 renamed again (see
 * `src/helpers/wiki-meta-scaffolds.mjs`) — so such a vault needs the second
 * hop afterwards:
 *
 *   node scripts/okf-safe-rename-vault.mjs --preset okf-reserved-scaffolds --vault <v> --apply
 *
 * Live scaffolding uses `WIKI_META_SCAFFOLDS` from that helper instead.
 */
const LEGACY_V0120_SCAFFOLDS = ['hot.md', 'index.md', 'log.md', 'overview.md'];

/**
 * The same four slots, each listing every basename that can legitimately fill
 * it. Used for PRESENCE tests, where a vault may be on either naming.
 */
/**
 * Is <vault>/wiki/<basename> a PRE-v0.12.0 legacy scaffold? The v0.59.0 OKF
 * projections reuse two of the same paths (wiki/index.md, wiki/log.md) — a
 * marker-carrying file there is OUR generated navigation, not a legacy
 * scaffold awaiting migration. Without this exemption, bootstrapping a wiki
 * (which now initialises projections) makes the very next bootstrap refuse
 * with 'legacy scaffolds present', and --migrate-wiki-meta reads the vault
 * as 'partial'.
 */
function isLegacyWikiScaffoldFile(vaultPath, basename) {
  const abs = path.join(vaultPath, 'wiki', basename);
  if (!fs.existsSync(abs)) return false;
  if (basename !== 'index.md' && basename !== 'log.md') return true;
  try {
    return !hasProjectionMarker(fs.readFileSync(abs, 'utf8'));
  } catch {
    return true; // unreadable → treat as legacy (fail safe: refuse loudly)
  }
}

const SCAFFOLD_SLOTS = [
  ['hot.md'],
  [CATALOG_BASENAME, 'index.md'],
  [JOURNAL_BASENAME, 'log.md'],
  ['overview.md'],
];

/**
 * Detect the migration state of a single vault.
 * Returns one of:
 *   - `'fresh'`        — already on the new layout (wiki-meta/{...}.md all present, none of the wiki/<scaffold>.md left)
 *   - `'legacy'`       — fully on the old layout (wiki/{...}.md all present, no wiki-meta/)
 *   - `'partial'`      — mix (some moved, some not — needs investigation, refuse auto-migration)
 *   - `'empty'`        — neither layout present (no scaffolds at all — vault never bootstrapped)
 *   - `'no-vault'`     — path doesn't exist or isn't a directory
 */
function detectVaultMigrationState(vaultPath) {
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    return 'no-vault';
  }
  // `wiki/` side: pre-v0.12.0 basenames — minus the v0.59.0 projections
  // that legitimately reuse wiki/index.md + wiki/log.md (marker-exempted).
  const wikiPresent = LEGACY_V0120_SCAFFOLDS.filter((f) =>
    isLegacyWikiScaffoldFile(vaultPath, f));
  // `wiki-meta/` side: a slot counts as filled under EITHER the current name
  // or the pre-0.58.0 one. Counting only one set would read a fully-migrated
  // vault as 'partial' (2 of 4 present) and make --migrate-wiki-meta refuse a
  // vault that has nothing left to migrate.
  const metaPresent = SCAFFOLD_SLOTS.filter((names) =>
    names.some((f) => fs.existsSync(path.join(vaultPath, 'wiki-meta', f))));

  if (wikiPresent.length === 0 && metaPresent.length === 0) return 'empty';
  if (wikiPresent.length === 0 && metaPresent.length === SCAFFOLD_SLOTS.length) return 'fresh';
  if (wikiPresent.length === LEGACY_V0120_SCAFFOLDS.length && metaPresent.length === 0) return 'legacy';
  return 'partial';
}

/**
 * Detect whether the vault is a git repo by probing for `.git/`. Used to
 * decide between `git mv` (preserves history + auto-stages) and plain
 * `fs.renameSync` (when there's no git layer to talk to).
 */
function vaultIsGitRepo(vaultPath) {
  return fs.existsSync(path.join(vaultPath, '.git'));
}

/**
 * Move one scaffold file. Uses `git mv` if the vault is a git repo (preserves
 * history + auto-stages the rename), otherwise plain `fs.renameSync`.
 * Returns { ok: bool, mode: 'git'|'fs', err?: string }.
 */
function moveScaffold(vaultPath, filename, useGit) {
  const oldRel = path.posix.join('wiki', filename);
  const newRel = path.posix.join('wiki-meta', filename);
  if (useGit) {
    const res = spawnSync('git', ['-C', vaultPath, 'mv', oldRel, newRel],
      subprocessOptions('git', { encoding: 'utf8', stdio: 'pipe' }));
    if (res.status === 0) return { ok: true, mode: 'git' };
    return { ok: false, mode: 'git', err: (res.stderr || res.stdout || '').trim() };
  }
  try {
    fs.renameSync(path.join(vaultPath, oldRel), path.join(vaultPath, newRel));
    return { ok: true, mode: 'fs' };
  } catch (err) {
    return { ok: false, mode: 'fs', err: err.message };
  }
}

/**
 * Rewrite occurrences of `wiki/<scaffold>.md` to `wiki-meta/<scaffold>.md` in
 * the vault's root `CLAUDE.md`. Idempotent — re-running on already-migrated
 * content is a no-op. Returns the number of replacements made (0 if no edits
 * needed or CLAUDE.md absent).
 *
 * Scope: only matches the 4 scaffold filenames, never touches arbitrary
 * `wiki/X.md` mentions (user content like `wiki/decisions/foo.md` is
 * preserved).
 */
/**
 * Common locations where CLAUDE.md may live, in priority order:
 *   1. `<vault>/CLAUDE.md` — standard Claude Code workspace location
 *   2. `<vault>/wiki-meta/CLAUDE.md` — Roland's "meta lives in wiki-meta"
 *      convention, observed on 5+ of his vaults post-migration
 *   3. `<vault>/Documentation/CLAUDE.md` — another Roland convention for
 *      a few vaults
 *
 * v0.12.2: extended from "just vault root" to also include wiki-meta/ and
 * Documentation/ after the v0.12.1 migration audit revealed Roland's
 * 9 vaults had CLAUDE.md scattered across these three locations. Returning
 * an ARRAY of paths (all that exist) so the rewrite touches every copy
 * instead of just the first one — defensive in case a user has multiple.
 */
function findClaudeMdCandidates(vaultPath) {
  return [
    path.join(vaultPath, 'CLAUDE.md'),
    path.join(vaultPath, 'wiki-meta', 'CLAUDE.md'),
    path.join(vaultPath, 'Documentation', 'CLAUDE.md'),
  ].filter((p) => fs.existsSync(p));
}

function rewriteClaudeMdScaffoldPaths(vaultPath) {
  // v0.12.2: rewrite across ALL discovered CLAUDE.md copies (vault root,
  // wiki-meta/, Documentation/). Returns the total replacement count
  // across all files. Each file is read+rewritten+written atomically.
  let total = 0;
  for (const claudeMd of findClaudeMdCandidates(vaultPath)) {
    const before = fs.readFileSync(claudeMd, 'utf8');
    const after = before.replace(/wiki\/(hot|index|log|overview)\.md/g, 'wiki-meta/$1.md');
    if (after === before) continue;
    fs.writeFileSync(claudeMd, after, 'utf8');
    total += (before.match(/wiki\/(hot|index|log|overview)\.md/g) || []).length;
  }
  return total;
}

/**
 * Migrate a single vault from `wiki/<scaffold>.md` to `wiki-meta/<scaffold>.md`.
 * Steps:
 *   1. Detect state. Bail on 'no-vault'/'partial', skip on 'fresh' (already
 *      migrated, unless `force`), warn on 'empty' (nothing to migrate).
 *   2. Ensure `wiki-meta/` exists.
 *   3. Move the 4 scaffolds (via `git mv` if git repo, else `fs.rename`).
 *      Abort early if any move fails — partial state would require manual fix.
 *   4. Rewrite scaffold paths in `<vault>/CLAUDE.md`.
 *   5. Append a migration line to the (now-moved) `wiki-meta/journal.md`.
 *
 * Returns { status, scaffoldsMoved, mode, claudeMdReplacements, error? }.
 * `status` is one of: 'migrated', 'already-migrated', 'skipped', 'failed'.
 *
 * Options:
 *   - `dryRun: true` — only report what would happen, don't touch the filesystem.
 *   - `force: true`   — re-run CLAUDE.md rewrite + log append even if already migrated.
 *   - `quiet: true`   — suppress per-vault success messages (batch mode uses this).
 */
function migrateVaultToWikiMeta(vaultPath, opts = {}) {
  const { dryRun = false, force = false, quiet = false } = opts;
  const result = {
    vaultPath,
    state: detectVaultMigrationState(vaultPath),
    status: 'failed',
    scaffoldsMoved: [],
    mode: null,
    claudeMdReplacements: 0,
    // C3: the ACTUAL matched scaffold refs per CLAUDE.md candidate (dry-run
    // only), so a same-count-but-different-text change is caught as drift.
    claudeMdMatches: null,
    error: null,
  };

  if (result.state === 'no-vault') {
    result.error = `vault path does not exist or is not a directory: ${vaultPath}`;
    return result;
  }
  if (result.state === 'partial') {
    result.error = (
      `vault is in a PARTIAL migration state — some scaffolds live under wiki/, ` +
      `others under wiki-meta/. Refusing to auto-migrate. Inspect manually:\n` +
      `  ls "${path.join(vaultPath, 'wiki')}"\n  ls "${path.join(vaultPath, 'wiki-meta')}"`
    );
    return result;
  }
  if (result.state === 'empty') {
    result.error = (
      `vault has neither wiki/<scaffold>.md NOR wiki-meta/<scaffold>.md — ` +
      `it was never bootstrapped via the /obsidian-router:wiki skill. ` +
      `Nothing to migrate.`
    );
    result.status = 'skipped';
    return result;
  }
  if (result.state === 'fresh' && !force) {
    result.status = 'already-migrated';
    if (!quiet) info(`${vaultPath} — already on wiki-meta/ layout, nothing to do.`);
    return result;
  }

  // Pre-flight: ensure wiki-meta/ dir exists (idempotent).
  const wikiMetaDir = path.join(vaultPath, 'wiki-meta');
  if (!dryRun && !fs.existsSync(wikiMetaDir)) {
    fs.mkdirSync(wikiMetaDir, { recursive: true });
  }

  const useGit = vaultIsGitRepo(vaultPath);
  result.mode = useGit ? 'git' : 'fs';

  // State is 'legacy' (or 'fresh' with force). Perform the move.
  if (result.state === 'legacy') {
    for (const scaffold of LEGACY_V0120_SCAFFOLDS) {
      const src = path.join(vaultPath, 'wiki', scaffold);
      const dst = path.join(vaultPath, 'wiki-meta', scaffold);
      if (!fs.existsSync(src)) {
        // Should not happen given state === 'legacy', but defend.
        result.error = `expected scaffold missing: ${src}`;
        return result;
      }
      if (fs.existsSync(dst)) {
        result.error = `target already exists, refusing to overwrite: ${dst}`;
        return result;
      }
      if (dryRun) {
        result.scaffoldsMoved.push({ scaffold, mode: result.mode, dryRun: true });
        continue;
      }
      const moveRes = moveScaffold(vaultPath, scaffold, useGit);
      if (!moveRes.ok) {
        result.error = `failed to move ${scaffold} via ${moveRes.mode}: ${moveRes.err}`;
        return result;
      }
      result.scaffoldsMoved.push({ scaffold, mode: moveRes.mode });
    }
  }

  // Rewrite CLAUDE.md scaffold paths (idempotent).
  // v0.12.2: searches vault root + wiki-meta/ + Documentation/ (see
  // findClaudeMdCandidates) so vaults with non-standard CLAUDE.md
  // placement still get their paths rewritten.
  if (dryRun) {
    // Compute what WOULD change across ALL discovered CLAUDE.md copies.
    let total = 0;
    const claudeMdMatches = [];
    for (const claudeMd of findClaudeMdCandidates(vaultPath)) {
      const content = fs.readFileSync(claudeMd, 'utf8');
      const found = content.match(/wiki\/(hot|index|log|overview)\.md/g) || [];
      total += found.length;
      if (found.length) {
        claudeMdMatches.push({ relPath: path.relative(vaultPath, claudeMd), matches: [...found].sort() });
      }
    }
    result.claudeMdReplacements = total;
    // C3: seal the exact matched refs per file — not just the sum — so a
    // CLAUDE.md that swaps `wiki/hot.md`→`wiki/index.md` (count unchanged) is
    // caught as drift instead of rewritten under a matching seal (Codex).
    result.claudeMdMatches = claudeMdMatches.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  } else {
    result.claudeMdReplacements = rewriteClaudeMdScaffoldPaths(vaultPath);
  }

  // Append a migration line to the journal the move just produced. This is
  // the v0.12.1 path, so that file is `wiki-meta/log.md` under the pre-0.58.0
  // name; `resolveScaffold` accepts either, which also covers a vault that
  // has since been through the catalog/journal rename.
  if (!dryRun) {
    const logMd = resolveScaffold(vaultPath, 'journal', { fs, path })?.absPath ?? null;
    if (logMd) {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const line = (
        `\n- ${ts} — **wiki-meta migration** (v0.12.1) — moved the 4 scaffolds from ` +
        `\`wiki/{hot,index,log,overview}.md\` to \`wiki-meta/{...}.md\` ` +
        `(via ${result.mode === 'git' ? '\`git mv\`' : '\`fs.rename\`'}). ` +
        `Rewrote ${result.claudeMdReplacements} scaffold path(s) in \`CLAUDE.md\`.\n`
      );
      fs.appendFileSync(logMd, line, 'utf8');
    }
  }

  result.status = 'migrated';
  if (!quiet) {
    if (dryRun) {
      info(`[DRY-RUN] ${vaultPath} — would move ${result.scaffoldsMoved.length} scaffolds via ${result.mode}, rewrite ${result.claudeMdReplacements} CLAUDE.md path(s).`);
    } else {
      ok(`${vaultPath} — migrated ${result.scaffoldsMoved.length} scaffolds via ${result.mode}, rewrote ${result.claudeMdReplacements} CLAUDE.md path(s).`);
    }
  }
  return result;
}

/**
 * v0.12.8: Migrate a vault's `wiki/Sessions/` directory to `wiki-meta/Sessions/`.
 *
 * Background: the `session-auto-journal.mjs` hook (introduced v0.12.4) initially
 * wrote session journals to `wiki/Sessions/`. v0.12.8 relocated them under
 * `wiki-meta/` to align with the v0.12.0 separation (auto-generated scaffolds
 * vs user content). Existing vaults with `wiki/Sessions/` populated need their
 * sessions physically relocated.
 *
 * Returns { status, sessionsMoved, mode, error? }.
 * `status` ∈ 'migrated' | 'already-migrated' | 'merged' | 'skipped' | 'failed'.
 *
 * State table:
 *   - `wiki/Sessions/` absent, `wiki-meta/Sessions/` absent     → 'skipped'  (no-op)
 *   - `wiki/Sessions/` absent, `wiki-meta/Sessions/` present   → 'already-migrated'
 *   - `wiki/Sessions/` present, `wiki-meta/Sessions/` absent   → 'migrated' (full rename)
 *   - `wiki/Sessions/` present, `wiki-meta/Sessions/` present  → 'merged'   (per-file move, skip duplicates)
 *
 * Options:
 *   - `dryRun: true` — only report what would happen, don't touch filesystem.
 *   - `quiet: true`  — suppress per-vault success messages (batch mode uses this).
 *
 * NB: `force` is not supported because there's no idempotent re-run risk — the
 * function detects state via filesystem presence + per-file dedup.
 */
function migrateSessionsToWikiMeta(vaultPath, opts = {}) {
  const { dryRun = false, quiet = false } = opts;
  const result = {
    vaultPath,
    status: 'failed',
    sessionsMoved: [],
    sessionsSkipped: [], // already present in target — kept in source as conflicts
    mode: null,
    // 'rename' (dst absent → whole-dir move) vs 'merge' (dst present →
    // per-file move, skip dups). Sealed by C3 so a dst directory appearing
    // between preview and apply — which flips a rename into a merge into
    // pre-existing content — is caught as drift (Fable 5 review).
    strategy: null,
    // C3 (rename case only): every top-level entry the directory rename moves —
    // not just .md — so a non-.md file dropped in before the apply is caught.
    sessionsAllEntries: null,
    error: null,
  };

  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    result.error = `vault path does not exist or is not a directory: ${vaultPath}`;
    return result;
  }

  const srcDir = path.join(vaultPath, 'wiki', 'Sessions');
  const dstDir = path.join(vaultPath, 'wiki-meta', 'Sessions');
  const srcExists = fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory();
  const dstExists = fs.existsSync(dstDir) && fs.statSync(dstDir).isDirectory();

  if (!srcExists && !dstExists) {
    result.status = 'skipped';
    result.error = 'no wiki/Sessions/ nor wiki-meta/Sessions/ — nothing to migrate';
    if (!quiet) info(`${vaultPath} — no Sessions/ directory found, skipping.`);
    return result;
  }
  if (!srcExists && dstExists) {
    result.status = 'already-migrated';
    if (!quiet) info(`${vaultPath} — already on wiki-meta/Sessions/, nothing to do.`);
    return result;
  }

  // From here on: srcExists === true.
  const useGit = vaultIsGitRepo(vaultPath);
  result.mode = useGit ? 'git' : 'fs';
  result.strategy = dstExists ? 'merge' : 'rename';

  // Case 1: dst absent → full rename of the directory (fast path).
  if (!dstExists) {
    if (dryRun) {
      const allEntries = fs.readdirSync(srcDir).sort();
      const srcFiles = allEntries.filter((f) => f.endsWith('.md'));
      result.sessionsMoved = srcFiles.map((f) => ({ file: f, mode: result.mode, dryRun: true }));
      // The rename relocates the WHOLE directory — seal every entry so the
      // manifest matches what actually moves, not just the .md subset (Codex).
      result.sessionsAllEntries = allEntries;
      result.status = 'migrated';
      if (!quiet) info(`[DRY-RUN] ${vaultPath} — would rename wiki/Sessions/ → wiki-meta/Sessions/ via ${result.mode} (${srcFiles.length} files).`);
      return result;
    }

    // Ensure wiki-meta/ exists (parent of the target).
    const wikiMetaParent = path.join(vaultPath, 'wiki-meta');
    if (!fs.existsSync(wikiMetaParent)) fs.mkdirSync(wikiMetaParent, { recursive: true });

    if (useGit) {
      const gitRes = spawnSync('git', ['mv', 'wiki/Sessions', 'wiki-meta/Sessions'], subprocessOptions('git', {
        cwd: vaultPath, encoding: 'utf8',
      }));
      if (gitRes.status !== 0) {
        // Fallback: fs.rename (history won't preserve as nicely but works).
        try { fs.renameSync(srcDir, dstDir); result.mode = 'fs (git fallback)'; }
        catch (err) { result.error = `git mv failed (${gitRes.stderr.trim()}), fs.rename fallback also failed: ${err.message}`; return result; }
      }
    } else {
      try { fs.renameSync(srcDir, dstDir); }
      catch (err) {
        // Cross-device link error → copy + unlink per file.
        // v0.12.9 (review+ pass 1 — E2): track files already moved so the
        // error message tells the operator exactly which files crossed
        // safely (no rollback is possible after the unlink, but the
        // partial state must be visible for resume).
        if (err.code === 'EXDEV') {
          const moved = [];
          try {
            fs.mkdirSync(dstDir, { recursive: true });
            for (const f of fs.readdirSync(srcDir)) {
              fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
              fs.unlinkSync(path.join(srcDir, f));
              moved.push(f);
            }
            fs.rmdirSync(srcDir);
            result.mode = 'fs (cross-device copy)';
          } catch (err2) {
            result.error = (
              `cross-device fallback failed after moving ${moved.length} file(s)` +
              (moved.length ? ` (${moved.join(', ')})` : '') +
              `: ${err2.message}. Re-run --migrate-sessions-to-wiki-meta to resume on the remaining files.`
            );
            return result;
          }
        } else {
          result.error = `fs.rename failed: ${err.message}`;
          return result;
        }
      }
    }

    const movedFiles = fs.readdirSync(dstDir).filter((f) => f.endsWith('.md'));
    result.sessionsMoved = movedFiles.map((f) => ({ file: f, mode: result.mode }));
    result.status = 'migrated';
  } else {
    // Case 2: both src and dst exist → merge per-file, skip dup, then rmdir if empty.
    const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md'));
    for (const f of srcFiles) {
      const dstFile = path.join(dstDir, f);
      if (fs.existsSync(dstFile)) {
        // Conflict: don't clobber. Leave in source for manual review.
        result.sessionsSkipped.push({ file: f, reason: 'target already exists' });
        continue;
      }
      if (dryRun) {
        result.sessionsMoved.push({ file: f, mode: result.mode, dryRun: true });
        continue;
      }
      const srcFile = path.join(srcDir, f);
      if (useGit) {
        // v0.12.9 (review+ pass 1 — E1): pass forward-slash paths to git mv
        // explicitly. Git accepts both on Windows but forward-slash is
        // unambiguous and matches the textual rename semantics git uses
        // internally — avoids any quoting surprises on paths with spaces.
        const gitRes = spawnSync('git', ['mv', `wiki/Sessions/${f}`, `wiki-meta/Sessions/${f}`], subprocessOptions('git', {
          cwd: vaultPath, encoding: 'utf8',
        }));
        if (gitRes.status !== 0) {
          try { fs.renameSync(srcFile, dstFile); result.sessionsMoved.push({ file: f, mode: 'fs (git fallback)' }); }
          catch (err) { result.sessionsSkipped.push({ file: f, reason: `move failed: ${err.message}` }); continue; }
        } else {
          result.sessionsMoved.push({ file: f, mode: 'git' });
        }
      } else {
        try { fs.renameSync(srcFile, dstFile); result.sessionsMoved.push({ file: f, mode: 'fs' }); }
        catch (err) { result.sessionsSkipped.push({ file: f, reason: `move failed: ${err.message}` }); continue; }
      }
    }
    // If srcDir is now empty AND no skips → rmdir
    if (!dryRun && fs.readdirSync(srcDir).length === 0) {
      try { fs.rmdirSync(srcDir); } catch { /* swallow */ }
    }
    result.status = result.sessionsSkipped.length > 0 ? 'merged' : 'migrated';
  }

  // Append a migration line to the vault journal (if present AND something
  // actually moved). v0.12.9 (review+ pass 1 — B1): skip the append when
  // 0 sessions were moved (`merged` status with only conflicts) so a user
  // who re-runs the script doesn't spam the journal with empty-action lines.
  if (!dryRun && result.sessionsMoved.length > 0) {
    const logMd = resolveScaffold(vaultPath, 'journal', { fs, path })?.absPath ?? null;
    if (logMd) {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const line = (
        `\n- ${ts} — migrate — wiki/Sessions/ → wiki-meta/Sessions/ — ` +
        `router v0.12.8 layout (${result.sessionsMoved.length} sessions via ${result.mode}` +
        (result.sessionsSkipped.length ? `, ${result.sessionsSkipped.length} skipped due to conflicts` : '') +
        `)\n`
      );
      fs.appendFileSync(logMd, line, 'utf8');
    }
  }

  if (!quiet) {
    if (dryRun) {
      info(`[DRY-RUN] ${vaultPath} — would move ${result.sessionsMoved.length} sessions via ${result.mode} (${result.sessionsSkipped.length} would skip).`);
    } else {
      const action = result.status === 'merged' ? 'merged' : 'migrated';
      ok(`${vaultPath} — ${action} ${result.sessionsMoved.length} sessions via ${result.mode}${result.sessionsSkipped.length ? `, ${result.sessionsSkipped.length} skipped (conflicts)` : ''}.`);
    }
  }
  return result;
}

function printStatus() {
  const cfg = loadConfig();
  console.log(c('bold', '\nobsidian-mcp-router — current configuration\n'));
  console.log('Config file:    ' + c('gray', CONFIG_PATH));
  console.log('Router binary:  ' + c('gray', ROUTER_BIN));
  const referenceForStatus = referenceVaultPath(cfg);
  console.log('Reference vault: ' + (referenceForStatus ? c('green', referenceForStatus) : c('red', 'NOT SET')));
  console.log('Port start:      ' + cfg.portStart);
  // Through the accessor for the KEYS, then indexed with its own validated
  // keys — the same composition src/registry.mjs uses, and for the same
  // reason: `Object.entries` on a hand-edited string invents vaults.
  const entries = registeredVaultPaths(cfg).map((vp) => [vp, cfg.portRegistry[vp]]);
  const disabled = new Set(disabledVaultEntries(cfg));
  if (entries.length === 0) {
    console.log('Configured vaults: ' + c('gray', '(none yet)'));
  } else {
    console.log(c('bold', '\nConfigured vaults:'));
    for (const [vault, value] of entries) {
      // disabledVaults entries can be NAME or PATH; check both, mirroring
      // src/registry.mjs.
      const name = vaultSlug(cfg, vault);
      const isDisabled = disabled.has(name) || disabled.has(vault);
      const tag = isDisabled ? c('gray', '  (disabled)') : '';
      // Both ports, always — the plaintext one is what every click-to-open
      // link in the notes is pinned to, so hiding it made the fleet's real
      // port usage invisible in the one place people look for it.
      const { https, http } = normalizePortEntry(value);
      const httpsCell = String(https ?? '?').padStart(5);
      const httpCell = http === null ? c('gray', 'http ?    ') : `http ${String(http).padEnd(5)}`;
      console.log(`  ${c('cyan', httpsCell)}  ${httpCell}  ${vault}${tag}`);
    }
  }

  // Collision report — the "make it legible" half of the two-port fix. Until
  // now a port clash surfaced only as a vault that was mysteriously offline.
  const collisions = detectPortCollisions(cfg, { onDisk: buildOnDiskPortMap(cfg) });
  if (collisions.length > 0) {
    console.log('');
    console.log(c('bold', c('red', `⚠ Port problems detected — ${summarizePortCollisions(collisions)}:`)));
    for (const f of collisions) {
      const mark = f.severity === 'error' ? c('red', '  ✗ ') : c('yellow', '  ! ');
      console.log(mark + f.message);
    }
    console.log(c('gray', '\n  Repair the registry side with:  node scripts/setup-vault.mjs --sync-port-registry'));
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
        // Reserve BOTH of the reference vault's ports. Reserving only the
        // HTTPS one is how the reference's plaintext port ended up looking
        // free to the allocator.
        const http = Number.isInteger(data.insecurePort) && data.insecurePort > 0
          ? data.insecurePort : null;
        cfg.portRegistry[abs] = { https: data.port, http };
        info(`Reserved ports ${data.port} (HTTPS) + ${http ?? 'unknown'} (plaintext) for the reference vault`);
      }
    } catch {}
  }

  saveConfig(cfg);
  ok(`Reference vault set to: ${abs}`);
  info('Plugins detected in reference: ' + resolvePluginsToClone(abs, REQUIRED_PLUGINS).filter((p) =>
    fs.existsSync(path.join(abs, '.obsidian', 'plugins', p))
  ).join(', '));
}

function copyDirRecursive(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Parse a vault's Local REST API `data.json`, or null when absent/unreadable.
 *
 * The object it returns carries the vault's `apiKey` and TLS private key, so
 * callers compare it in memory and NEVER print, log or serialise it — the two
 * call sites here only read `port` and compare `apiKey` for equality.
 */
function readRestApiData(vaultPath) {
  if (!vaultPath) return null;
  const dataPath = path.join(
    vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json',
  );
  if (!fs.existsSync(dataPath)) return null;
  try { return JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
  catch { return null; }
}

/**
 * Read the two ports a vault actually binds, straight from its own
 * `data.json`. Returns null when the file is absent or unparseable.
 *
 * ONLY the two integers are lifted out. That file also carries the vault's
 * `apiKey` and its TLS private key in clear — the port bookkeeping must never
 * become a second path by which those travel (see the ticket's "note de
 * mesure": never inventory ports through the plugin's own API).
 */
function readVaultPortsFromDisk(vaultPath) {
  const dataPath = path.join(
    vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json',
  );
  if (!fs.existsSync(dataPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const port = Number.isInteger(data.port) && data.port > 0 ? data.port : null;
    const insecurePort = Number.isInteger(data.insecurePort) && data.insecurePort > 0
      ? data.insecurePort : null;
    // An entry is returned even when BOTH fields are absent. "Readable and
    // says nothing binds" is a different fact from "unreadable, so unknown",
    // and collapsing them let a stale registry number be reported as an
    // active binding (pre-release review, 2026-08-30). Only a missing or
    // unparseable file returns null.
    return { port, insecurePort };
  } catch {
    return null;
  }
}

/**
 * Build the `vaultPath → { port, insecurePort }` map the pure port-registry
 * helpers reason over: every registered vault, plus any extra path the caller
 * names (the target being provisioned, the reference vault, an unregistered
 * stray the user passed on the command line).
 *
 * This is the layer that makes `data.json` the source of truth. The registry
 * is a cache of it, not the other way round.
 */
function buildOnDiskPortMap(cfg, extraPaths = []) {
  const map = new Map();
  const paths = [...registeredVaultPaths(cfg)];
  // Straight into `readVaultPortsFromDisk` → `path.join`, which throws on a
  // non-string. This was the least visible of the three referenceVault sinks
  // and the only one reached during ordinary port-collision reporting.
  // (v0.90.0)
  const reference = referenceVaultPath(cfg);
  if (reference) paths.push(reference);
  for (const p of extraPaths) if (p) paths.push(p);
  for (const p of paths) {
    if (map.has(p)) continue;
    const ports = readVaultPortsFromDisk(p);
    if (ports) map.set(p, ports);
  }
  return map;
}

/**
 * Allocate the vault's PAIR of ports — HTTPS and plaintext — checking BOTH
 * spaces before handing either one out.
 *
 * The predecessor (`allocatePort`) scanned `Object.values(portRegistry)`,
 * which only ever held HTTPS ports, and so could hand a new vault a number
 * already bound by another vault's plaintext server. That is the bug this
 * whole change exists to close; see `src/helpers/port-registry.mjs`.
 *
 * A vault already in the registry gets its existing pair back untouched —
 * re-running the bootstrap on a live vault must never move its ports.
 */
function allocatePortsFor(cfg, vaultPath, { onDisk, forceFresh = false } = {}) {
  const diskMap = onDisk || buildOnDiskPortMap(cfg, [vaultPath]);
  return allocatePortPair(cfg, vaultPath, { onDisk: diskMap, forceFresh });
}

/**
 * Write port + key + plaintext port into a vault's Local REST API data.json.
 *
 * @returns {{ written: boolean, insecurePort: number|null }} what ACTUALLY
 * reached the disk. The caller records the plaintext port in `portRegistry`
 * and returns it as provisioning metadata; before this returned anything, a
 * missing data.json produced a warning and the caller went on to persist a
 * port that had never been written — bookkeeping describing a file that does
 * not exist (pre-release review, 2026-08-30).
 */
function patchRestApiData(vaultPath, port, apiKey, insecurePort = null) {
  const dataPath = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
  if (!fs.existsSync(dataPath)) {
    warn(`Local REST API data.json not found at ${dataPath} — plugin may regenerate it on first run.`);
    warn('  No port was written; the registry will record the plaintext port as unknown.');
    return { written: false, insecurePort: null };
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
  //
  // The `+ 10` below is the DEFAULT the caller falls back to, not a law: the
  // allocator now hands us the plaintext port it actually reserved, checked
  // free in both spaces. Two vaults on this fleet already escape the offset
  // (27131/27162, 27132/27163) — treating it as a derivable fact is precisely
  // what let the allocator hand out ports that were already bound.
  const effectiveInsecurePort = Number.isInteger(insecurePort) && insecurePort > 0
    ? insecurePort
    : port + DEFAULT_INSECURE_OFFSET;
  data.insecurePort = effectiveInsecurePort;
  data.enableInsecureServer = true;
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  ok(`Patched Local REST API data.json (port=${port}, insecurePort=${effectiveInsecurePort}, HTTP enabled, fresh apiKey)`);
  return { written: true, insecurePort: effectiveInsecurePort };
}

/**
 * v0.13.9 — `--upgrade-insecure-server` mode.
 *
 * Bootstrapped-from-scratch vaults get `insecurePort` + `enableInsecureServer`
 * out of the box (see `patchRestApiData` above). But vaults bootstrapped BEFORE
 * the v0.10.x release that introduced those fields stay on HTTPS-only — which
 * is broken under Bitdefender / ESET / Kaspersky (silent drop of self-signed
 * HTTPS loopback). The `--sync-plugins --force` path explicitly preserves
 * `data.json` for credential safety, so it doesn't repair this either.
 *
 * This function targets that gap surgically: rewrites ONLY the two fields
 * that enable the HTTP-side endpoint, preserving everything else
 * (apiKey, port, cert, bindingHost, user-set extras).
 *
 * Returns { vaultPath, status, before, after, error? }
 *   status:
 *     - 'already-enabled' — both fields already set correctly, no write
 *     - 'upgraded'        — one or both fields patched
 *     - 'no-data-json'    — vault has no Local REST API data.json
 *                           (plugin never activated or not installed)
 *     - 'no-port'         — data.json exists but has no `port` field
 *                           (cannot derive insecurePort safely)
 *     - 'failed'          — fs/JSON error
 *
 * Options:
 *   - `dryRun: true` — report intended change, no write
 *   - `quiet: true`  — suppress per-vault success/info messages
 *   - `cfg`          — optional pre-loaded config (used by batch mode to
 *                      detect insecurePort collisions across vaults)
 */
function upgradeInsecureServer(vaultPath, opts = {}) {
  const { dryRun = false, quiet = false, cfg = null } = opts;
  const result = {
    vaultPath,
    status: 'failed',
    before: null,
    after: null,
    error: null,
  };

  const dataPath = path.join(
    vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json',
  );
  if (!fs.existsSync(dataPath)) {
    result.status = 'no-data-json';
    result.error = `no Local REST API data.json at ${dataPath} — plugin not installed or never activated`;
    if (!quiet) warn(`${vaultPath} — ${result.error}`);
    return result;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (err) {
    result.error = `data.json is not valid JSON: ${err.message}`;
    if (!quiet) warn(`${vaultPath} — ${result.error}`);
    return result;
  }

  if (typeof data.port !== 'number' || data.port <= 0) {
    result.status = 'no-port';
    result.error = `data.json has no usable \`port\` field (got ${JSON.stringify(data.port)})`;
    if (!quiet) warn(`${vaultPath} — ${result.error}`);
    return result;
  }

  result.before = {
    insecurePort: data.insecurePort ?? null,
    enableInsecureServer: data.enableInsecureServer ?? null,
  };

  // Policy — respect existing values, only fix gaps. Behavior matrix:
  //   - insecurePort set AND enableInsecureServer === true        → already-enabled (no-op)
  //   - insecurePort set AND enableInsecureServer ∈ {false,unset} → flip the bool, keep port
  //   - insecurePort unset AND enableInsecureServer === true      → allocate insecurePort (collision-avoid)
  //   - both unset/wrong                                          → allocate both (collision-avoid)
  //
  // Why we DON'T bump a sane-but-colliding insecurePort:
  // changing a vault's HTTP port silently breaks every click-to-open link
  // that was generated under the old value, and the user may have been
  // running fine for months precisely because they never open colliding
  // vaults simultaneously. Surface, don't mutate.
  const insecurePortIsSane = (typeof data.insecurePort === 'number'
    && data.insecurePort > 0
    && data.insecurePort !== data.port);
  const insecureServerOn = data.enableInsecureServer === true;

  if (insecurePortIsSane && insecureServerOn) {
    result.status = 'already-enabled';
    result.after = {
      insecurePort: data.insecurePort,
      enableInsecureServer: true,
    };
    if (!quiet) info(`${vaultPath} — already HTTP-enabled (insecurePort=${data.insecurePort}, enableInsecureServer=true), no change`);
    return result;
  }

  // Need to allocate insecurePort? Only if not already sane.
  let newInsecurePort;
  if (insecurePortIsSane) {
    newInsecurePort = data.insecurePort;
  } else {
    // Collision-avoidance ONLY when allocating fresh — never bumps an
    // existing sane value (see Policy note above). Delegated to the shared
    // allocator so this path cannot drift from the provisioning one: the
    // hand-rolled loop it replaces could return `data.port + 10` unchecked
    // when no config was passed, run past 65535 (port 65530 → 65540), and
    // stop ON a reserved 65535 (pre-release review, 2026-08-30).
    if (registeredVaultPaths(cfg).length > 0) {
      try {
        newInsecurePort = allocateInsecurePortFor(cfg, vaultPath, data.port, {
          onDisk: buildOnDiskPortMap(cfg, [vaultPath]),
        });
      } catch (err) {
        result.error = err.message;
        if (!quiet) warn(`${vaultPath} — ${result.error}`);
        return result;
      }
    } else {
      newInsecurePort = data.port + DEFAULT_INSECURE_OFFSET;
      if (newInsecurePort > 65535) {
        result.error = `cannot derive a plaintext port from ${data.port} (+${DEFAULT_INSECURE_OFFSET} exceeds 65535)`;
        if (!quiet) warn(`${vaultPath} — ${result.error}`);
        return result;
      }
    }
  }

  const desired = {
    insecurePort: newInsecurePort,
    enableInsecureServer: true,
  };

  result.after = desired;

  if (dryRun) {
    result.status = 'upgraded';
    if (!quiet) {
      info(`[DRY-RUN] ${vaultPath} — would set insecurePort=${desired.insecurePort}, enableInsecureServer=true`);
      info(`  (before: insecurePort=${data.insecurePort ?? 'unset'}, enableInsecureServer=${data.enableInsecureServer ?? 'unset'})`);
    }
    return result;
  }

  data.insecurePort = desired.insecurePort;
  data.enableInsecureServer = true;
  try {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  } catch (err) {
    result.error = `failed to write data.json: ${err.message}`;
    if (!quiet) warn(`${vaultPath} — ${result.error}`);
    return result;
  }

  result.status = 'upgraded';
  if (!quiet) {
    ok(`${vaultPath} — patched insecurePort=${desired.insecurePort}, enableInsecureServer=true (apiKey + port + cert preserved)`);
    info(`  Reload Obsidian (Ctrl+P → "Reload app without saving") to pick up the change.`);
  }
  return result;
}

// ---------- Vault discovery (v0.13.9) ----------------------------------------
//
// Scan well-known per-OS locations for Obsidian vaults. Annotates each with
// a status reflecting whether it's already registered with the router. Used
// by --discover-vaults (list + report) and --discover-vaults --bootstrap-all
// (auto-bootstrap every candidate).
//
// "Vault" detection rule: a directory containing a `.obsidian/` subdirectory.
// We scan two layouts at each well-known location:
//   1. The location ITSELF is a vault (e.g. `~/Obsidian/.obsidian/` exists)
//   2. The location is a CONTAINER of vaults (e.g. `C:/VAULTS/RolandWiki/.obsidian/`)
// We do NOT recurse deeper than 1 level to avoid runaway scans (a vault may
// have arbitrary subdirs that contain `.obsidian/` of their own from old
// experiments — we don't try to be clever).
//
// Locations come from observation of Roland's setups + the most common
// community conventions (Obsidian's defaults, iCloud sync path, Google Drive
// desktop). Users can pass additional --scan-dir <path> to extend.

function defaultScanLocations() {
  const home = os.homedir();
  const locations = [];

  // Cross-platform: $HOME/Obsidian and $HOME/Documents/Obsidian are the
  // first-launch defaults the Obsidian installer suggests.
  locations.push(path.join(home, 'Obsidian'));
  locations.push(path.join(home, 'Documents', 'Obsidian'));

  if (process.platform === 'win32') {
    // Drive-rooted VAULTS conventions Roland uses.
    locations.push('C:\\VAULTS');
    locations.push('D:\\VAULTS');
    locations.push('E:\\VAULTS');
    // OneDrive default mount.
    locations.push(path.join(home, 'OneDrive', 'Documents', 'Obsidian'));
    // Google Drive desktop default mount (Roland observed: `P:\Mon Drive\VAULTS`).
    // Probe a few common mount letters since Google Drive picks the next free.
    for (const drive of ['G', 'H', 'I', 'P', 'Q']) {
      locations.push(`${drive}:\\Mon Drive\\VAULTS`);
      locations.push(`${drive}:\\My Drive\\VAULTS`);
    }
  } else if (process.platform === 'darwin') {
    // iCloud Drive default path for Obsidian-on-iOS sync.
    locations.push(path.join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'));
  }
  // Linux: just $HOME/Obsidian and $HOME/Documents/Obsidian (above).

  // De-dupe (path.join may produce duplicates across branches).
  return [...new Set(locations)];
}

function isObsidianVaultRoot(dirPath) {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return false;
    const dotObsidian = path.join(dirPath, '.obsidian');
    return fs.existsSync(dotObsidian) && fs.statSync(dotObsidian).isDirectory();
  } catch {
    return false;
  }
}

function classifyVault(vaultPath, cfg) {
  const abs = path.resolve(vaultPath);
  const registered = registeredVaultPaths(cfg).some((rp) => samePath(rp, abs));
  // `samePath` throws a TypeError on a non-string — measured, not assumed.
  const reference = referenceVaultPath(cfg);
  const isReference = Boolean(reference) && samePath(reference, abs);
  const hasRestApi = fs.existsSync(path.join(abs, '.obsidian', 'plugins', 'obsidian-local-rest-api'));
  const hasBridge = fs.existsSync(path.join(abs, '.obsidian', 'plugins', 'mcp-router-bridge'));

  let status;
  if (isReference) status = 'reference';
  else if (registered) status = 'registered';
  else if (!hasRestApi) status = 'partial';
  else status = 'candidate';

  return { path: abs, status, hasRestApi, hasBridge, isReference, registered };
}

/**
 * v0.13.9 — Scan well-known locations for Obsidian vaults and classify each.
 *
 * Returns array of { path, status, hasRestApi, hasBridge, isReference,
 * registered, scanRoot } where status ∈ 'reference'|'registered'|'candidate'|
 * 'partial'.
 *
 * Options:
 *   - `extraDirs: string[]` — additional roots to scan (passed via --scan-dir)
 *   - `cfg`                 — pre-loaded router config (avoid re-loading)
 */
function discoverVaults(opts = {}) {
  const { extraDirs = [], cfg = loadConfig(), skipDefaults = false } = opts;
  const roots = skipDefaults ? [...extraDirs] : [...defaultScanLocations(), ...extraDirs];

  const found = [];
  const seen = new Set();

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Layout A: the root ITSELF is a vault.
    if (isObsidianVaultRoot(root)) {
      const key = canonicalPath(root) || root;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ ...classifyVault(root, cfg), scanRoot: root });
      }
    }

    // Layout B: scan one level of children for vault roots.
    let children;
    try {
      children = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const child of children) {
      const childPath = path.join(root, child);
      try {
        if (!fs.statSync(childPath).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!isObsidianVaultRoot(childPath)) continue;
      const key = canonicalPath(childPath) || childPath;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...classifyVault(childPath, cfg), scanRoot: root });
    }
  }

  return found;
}

// ---------- Global CLAUDE.md convention snippets (v0.13.9) -------------------
//
// Ships snippets under `templates/global-claude-md-snippets/<name>.md` that
// can be appended to the user's `~/.claude/CLAUDE.md` via `--install-global-
// convention <name>`. Idempotent via HTML-comment markers — re-runs are no-ops
// unless `--force` is passed (which replaces the content between markers).
//
// The first shipped snippet is `obsidian-vault-links` — the canonical click-
// to-open formatting rules. Without this section in the global CLAUDE.md,
// Claude on a fresh machine doesn't know to generate http://127.0.0.1:<port>/
// open/<path> links, and falls back to `obsidian://` (silently filtered by
// Claude Code CLI on click) or `https://` (silently dropped by Bitdefender).
//
// Why HTML-comment markers (not a separate file include): `~/.claude/CLAUDE.md`
// is a single flat document that gets fully loaded into Claude's context at
// every session start. Markers let us co-locate the canonical text in the
// repo, push updates via re-runs, and never silently overwrite user edits
// outside the marker block.

const GLOBAL_SNIPPETS_DIR = path.join(REPO_ROOT, 'templates', 'global-claude-md-snippets');

function globalClaudeMdPath() {
  return path.join(os.homedir(), '.claude', 'CLAUDE.md');
}

function listGlobalConventions() {
  if (!fs.existsSync(GLOBAL_SNIPPETS_DIR)) return [];
  return fs.readdirSync(GLOBAL_SNIPPETS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({
      name: f.replace(/\.md$/, ''),
      path: path.join(GLOBAL_SNIPPETS_DIR, f),
    }));
}

function makeConventionMarkers(name) {
  return {
    begin: `<!-- BEGIN obsidian-mcp-router:${name} -->`,
    end: `<!-- END obsidian-mcp-router:${name} -->`,
  };
}

/**
 * Append (or, with --force, replace) a snippet inside `~/.claude/CLAUDE.md`,
 * delimited by HTML-comment markers for idempotency.
 *
 * Returns { name, status, path, error? }
 *   status:
 *     - 'installed'           — first-time append (markers added)
 *     - 'already-installed'   — marker block found, no --force → no-op
 *     - 'upgraded'            — marker block found AND --force → contents
 *                                between markers replaced
 *     - 'snippet-not-found'   — no `templates/global-claude-md-snippets/<name>.md`
 *     - 'failed'              — fs error
 *
 * Options:
 *   - `dryRun: true` — report intended change, no write
 *   - `force: true`  — if marker block already present, replace contents
 *   - `quiet: true`  — suppress success/info messages
 */
function installGlobalConvention(name, opts = {}) {
  const { dryRun = false, force = false, quiet = false } = opts;
  const result = {
    name,
    status: 'failed',
    path: globalClaudeMdPath(),
    error: null,
  };

  const snippetPath = path.join(GLOBAL_SNIPPETS_DIR, `${name}.md`);
  if (!fs.existsSync(snippetPath)) {
    result.status = 'snippet-not-found';
    const available = listGlobalConventions().map((c) => c.name).join(', ');
    result.error = `no snippet '${name}.md' under ${GLOBAL_SNIPPETS_DIR}` +
      (available ? ` — available: ${available}` : ' — (no snippets shipped)');
    if (!quiet) warn(result.error);
    return result;
  }

  const snippetContent = fs.readFileSync(snippetPath, 'utf8').trimEnd();
  const { begin, end } = makeConventionMarkers(name);
  const blockBody = `${begin}\n${snippetContent}\n${end}\n`;

  const claudeMdPath = result.path;
  const claudeMdDir = path.dirname(claudeMdPath);
  let existing = '';
  let fileExists = fs.existsSync(claudeMdPath);
  if (fileExists) {
    existing = fs.readFileSync(claudeMdPath, 'utf8');
  }

  // Detection: BEGIN marker present anywhere = block already installed.
  const beginIdx = existing.indexOf(begin);
  const blockPresent = beginIdx !== -1;

  if (blockPresent && !force) {
    result.status = 'already-installed';
    if (!quiet) info(`${claudeMdPath} — convention '${name}' already installed (use --force to upgrade)`);
    return result;
  }

  let next;
  if (blockPresent && force) {
    // Replace the existing marker block (BEGIN..END), preserving everything else.
    const endIdx = existing.indexOf(end, beginIdx);
    if (endIdx === -1) {
      result.error = `BEGIN marker found at offset ${beginIdx} but no matching END marker — refusing to write`;
      if (!quiet) warn(`${claudeMdPath} — ${result.error}`);
      return result;
    }
    const endLineEnd = existing.indexOf('\n', endIdx);
    const tailStart = endLineEnd === -1 ? existing.length : endLineEnd + 1;
    next = existing.slice(0, beginIdx) + blockBody + existing.slice(tailStart);
    result.status = 'upgraded';
  } else {
    // First-time append. Add separators so the block doesn't run into existing
    // content. Two leading newlines if the file is non-empty and doesn't end
    // with a blank line.
    let separator = '';
    if (existing.length > 0) {
      if (existing.endsWith('\n\n')) separator = '';
      else if (existing.endsWith('\n')) separator = '\n';
      else separator = '\n\n';
    }
    next = existing + separator + blockBody;
    result.status = 'installed';
  }

  if (dryRun) {
    if (!quiet) {
      const action = result.status === 'upgraded' ? 'would upgrade' : 'would install';
      info(`[DRY-RUN] ${claudeMdPath} — ${action} convention '${name}' (${blockBody.length} bytes)`);
    }
    return result;
  }

  try {
    if (!fs.existsSync(claudeMdDir)) fs.mkdirSync(claudeMdDir, { recursive: true });
    fs.writeFileSync(claudeMdPath, next, 'utf8');
  } catch (err) {
    result.error = `failed to write ${claudeMdPath}: ${err.message}`;
    if (!quiet) warn(result.error);
    result.status = 'failed';
    return result;
  }

  if (!quiet) {
    if (result.status === 'upgraded') {
      ok(`${claudeMdPath} — upgraded convention '${name}' (${blockBody.length} bytes between markers)`);
    } else {
      ok(`${claudeMdPath} — installed convention '${name}' (${blockBody.length} bytes appended)`);
    }
    info(`  Re-runs are no-ops unless you pass --force. Edit outside the markers freely; they're preserved.`);
  }
  return result;
}

function ensureCommunityPlugins(vaultPath, pluginsToEnable) {
  const cpPath = path.join(vaultPath, '.obsidian', 'community-plugins.json');
  let list = [];
  if (fs.existsSync(cpPath)) {
    try { list = JSON.parse(fs.readFileSync(cpPath, 'utf8')); } catch { list = []; }
  }
  const enabled = [];
  for (const p of pluginsToEnable) {
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
  // Validate BEFORE interpolating. `apiKey` is adopted verbatim from the
  // vault's own `.obsidian/plugins/obsidian-local-rest-api/data.json` — a file
  // inside the synced/shared/cloned tree, checked only for `length > 16`. A
  // key carrying a newline turns this three-line file into five, and the extra
  // lines are loaded at start-up because `writeMcpJson` puts `.mcp.json` at
  // this same vault root, so the router runs with cwd here. Measured: an
  // injected `MARKITDOWN_PATH` reaches `execFileAsync` (arbitrary execution)
  // and an injected `OBSIDIAN_ROUTER_READONLY=false` re-enables every write
  // tool. Under `--force` — the documented repair action — this file is
  // REPLACED, so an operator's own `OBSIDIAN_ROUTER_READONLY=true` is deleted
  // rather than shadowed.
  //
  // This is the FOURTH writer of this format, and it sits sixty lines above
  // the third one, in the file where the guard was already added. The guard
  // that was supposed to prevent exactly this reasoned at FILE granularity and
  // saw a compliant neighbour. Hence the behavioural pin in
  // tests/security-invariants.test.mjs rather than another text scan.
  assertDotenvScalar(vaultPath, 'VAULT_PATH', envPath);
  assertDotenvScalar(apiKey, 'OBSIDIAN_API_KEY', envPath);
  assertDotenvScalar(baseUrl, 'OBSIDIAN_BASE_URL', envPath);
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

  // If this bootstrap is running against a non-default config path
  // (currently only via the `OBSIDIAN_ROUTER_CONFIG` env var — this
  // script doesn't parse a `--config` CLI flag of its own; the router
  // binary does), embed `--config <path>` into the spawned router's
  // args. Without this,
  // the MCP client (Claude Code, Claude Desktop) launches the router
  // process WITHOUT the env var the user set during bootstrap, so the
  // router falls back to the default config and can't see the vault
  // that was just registered. The CLI flag is the only reliable way
  // to pin the registry across process boundaries.
  //
  // CONFIG_PATH equals the default when no override was provided; in
  // that case we keep args minimal so the generated .mcp.json stays
  // identical to the historical output (no diff-noise across upgrades).
  const defaultConfigPath = path.join(os.homedir(), '.claude', 'obsidian-mcp-router', 'config.json');
  const usingCustomConfig = path.resolve(CONFIG_PATH) !== path.resolve(defaultConfigPath);
  const args = usingCustomConfig
    ? [ROUTER_BIN, '--config', CONFIG_PATH]
    : [ROUTER_BIN];

  const config = {
    mcpServers: {
      'obsidian-router': {
        command: NODE_EXE,
        args,
      },
    },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2));
  ok(`Wrote ${mcpPath}${usingCustomConfig ? ` (with --config ${CONFIG_PATH})` : ''}`);
}

// ---------------------------------------------------------------------------
// .env upsert / remove (sync) — hoisted to module scope in v0.12.7 so that
// setupVault() can call them inline (for the --link-workspace flag) AND the
// standalone --link-workspace / --unlink-workspace CLI handler can keep using
// the same logic.
//
// Mirrors src/tools/lock.mjs's env-file editing but stays sync — this script
// is mostly sync, and async/await here adds no value.
// ---------------------------------------------------------------------------
function upsertEnvVarSync(file, key, value) {
  // Shared definition — see src/helpers/dotenv-scalar.mjs. THIS is the writer
  // that stayed injectable after the guard was added to `lock.mjs` alone: a
  // vault slug of `safe\nOBSIDIAN_ROUTER_READONLY=false\nINJECTED` wrote three
  // lines here, the middle one re-enabling write access at the next start.
  // Quoting does not help — both readers split into lines before they look at
  // quotes — which is why the caller's `quotedValue` wrapping did not contain
  // it either.
  assertDotenvScalar(value, key, file);
  let lines = [];
  if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const keyRegex = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*=`);
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) { if (keyRegex.test(lines[i])) { firstIdx = i; break; } }
  const newLine = `${key}=${value}`;
  if (firstIdx === -1) {
    if (lines.length === 0 || lines[lines.length - 1] === '') {
      const at = lines.length === 0 ? 0 : lines.length - 1;
      lines.splice(at, 0, newLine);
    } else {
      lines.push(newLine);
    }
  } else {
    lines[firstIdx] = newLine;
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  fs.writeFileSync(file, out, 'utf8');
}

function removeEnvVarSync(file, key) {
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const keyRegex = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*=`);
  const filtered = lines.filter((l) => !keyRegex.test(l));
  if (filtered.length === lines.length) return false;
  let out = filtered.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  fs.writeFileSync(file, out, 'utf8');
  return true;
}

/**
 * Bind a workspace to a vault by writing `OBSIDIAN_ROUTER_DEFAULT_VAULT=<slug>`
 * to the workspace's `.env`. Used by:
 *   - The standalone `--link-workspace` CLI subcommand (after resolving slug → path
 *     via portRegistry)
 *   - The inline `--link-workspace <ws-path>` flag of the main bootstrap
 *     subcommand (vault path is already known — slug derived via defaultNameFromPath)
 *
 * Validates:
 *   - workspacePath exists and is a directory
 *   - vaultPath has `wiki-meta/catalog.md` (otherwise the workspace-bound hooks
 *     would skip silently, making the link pointless)
 *
 * On `opts.quiet`, suppresses the success log lines (used by setupVault inline
 * call which has its own final recap).
 */
function linkWorkspaceToVault({ workspacePath, vaultPath, vaultSlug, opts = {} }) {
  if (!fs.existsSync(workspacePath)) fail(`Workspace path does not exist: ${workspacePath}`);
  if (!fs.statSync(workspacePath).isDirectory()) fail(`Workspace path is not a directory: ${workspacePath}`);

  const catalog = resolveScaffold(vaultPath, 'catalog', { fs, path });
  if (!catalog) {
    const indexMd = scaffoldWritePath(vaultPath, 'catalog', { path });
    fail(
      `Vault at ${vaultPath} has no wiki-meta/catalog.md (expected: ${indexMd}).\n` +
      `   Bootstrap its wiki first with the \`/obsidian-router:wiki\` skill, or if the vault is\n` +
      `   on the legacy \`wiki/{hot,index,log,overview}.md\` layout (pre-v0.12.0), migrate it\n` +
      `   with \`setup-vault.mjs --migrate-wiki-meta <vault-path>\` (shipped in v0.12.1).`,
    );
  }

  // Spaces in slug need quoting for shell-source compatibility (e.g.
  // `set -a; source .env; set +a` in bash). The .env parser strips
  // matched outer quotes on read.
  const quotedValue = /\s/.test(vaultSlug) ? `"${vaultSlug}"` : vaultSlug;
  const envPath = path.join(workspacePath, '.env');

  // Rebind detection (review+ pass 1 Reviewer A IMPORTANT #1) — silently
  // overwriting an existing binding is exactly the UX antipattern this commit
  // sets out to fix. Read the previous value (if any) and surface a warning
  // when we're about to switch the workspace from vault A to vault B. The
  // upsert itself is unchanged; the warn fires before it.
  let previousSlug = null;
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*OBSIDIAN_ROUTER_DEFAULT_VAULT\s*=\s*(.*?)\s*$/);
      if (m) {
        // Strip matched outer quotes (mirrors dotenv parser).
        let value = m[1];
        const quoted = value.match(/^"(.*)"$|^'(.*)'$/);
        if (quoted) value = quoted[1] ?? quoted[2];
        previousSlug = value;
        break;
      }
    }
  }
  if (previousSlug && previousSlug !== vaultSlug && !opts.quiet) {
    warn(
      `Rebinding workspace ${workspacePath} from vault "${previousSlug}" to "${vaultSlug}".\n` +
      `   The previous binding will be replaced. If this is unintended (typo, wrong cwd),\n` +
      `   abort now and inspect ${envPath} manually.`,
    );
  }

  upsertEnvVarSync(envPath, 'OBSIDIAN_ROUTER_DEFAULT_VAULT', quotedValue);

  // AND THE BINDING, which is the half that actually decides. Since the
  // binding registry landed, the `.env` line above is a portable HINT that the
  // router reports and does not apply — so a `--link-workspace` that wrote
  // only the file linked nothing at all, while `docs/features/13` said it
  // "records the binding in workspaceBindings (which is what decides)". One of
  // the two had to move, and it is the code: `--link-workspace` is a command
  // the user typed, which is exactly what a confirmation is. Found in the
  // final review, 2026-09-03.
  //
  // `opts.recordBinding === false` is for `--attach`, which writes a richer
  // binding of its own (secondaries included) a few lines later and would
  // otherwise write the config twice.
  let bindingRecorded = false;
  if (opts.recordBinding !== false) {
    try {
      updateConfigBindings(CONFIG_PATH, (cfg) => {
        // A re-link to the SAME primary keeps its lock and its secondaries;
        // pointing the workspace elsewhere drops both, because they belonged
        // to the vault it is being moved away from. Read inside the lock.
        const previous = readBinding(cfg, workspacePath);
        const same = previous && previous.vault === vaultSlug;
        // The write tier of each secondary that STAYS (Phase 3, per-workspace
        // `alsoLocked`/`alsoWritable` on the binding) survives a re-link to the
        // same primary — the secondaries do, so their modes must, or a re-run
        // of `--link-workspace` silently reopens a strict read-only vault.
        return withBinding(cfg, workspacePath, {
          vault: vaultSlug,
          also: same ? previous.also : [],
          locked: Boolean(same && previous.locked),
          confirmedVia: 'link-workspace',
          alsoLocked: same ? previous.alsoLocked : [],
          alsoWritable: same ? previous.alsoWritable : [],
        });
      });
      bindingRecorded = true;
    } catch (e) {
      // A FAILURE HERE FAILS THE COMMAND. The binding is the half that
      // decides; the `.env` line is a hint the router reports and does not
      // apply. Warning and exiting 0 printed "Linked workspace" for a command
      // that had linked nothing at all — the worst possible report, because
      // the user walks away believing the attachment exists. (Codex, round 5.)
      fail(
        [
          `Could not record the workspace binding in ${CONFIG_PATH} (${e.message}).`,
          `   The portable hint WAS written to ${envPath}, but a project file no longer chooses`,
          '   a vault: nothing is attached until the binding is recorded. Fix the config',
          '   (permissions, or another process holding it) and run this again — or confirm the',
          '   binding from a session with confirm_workspace_binding.',
        ].join('\n'),
      );
    }
  }

  if (!opts.quiet) {
    ok(`Linked workspace ${workspacePath}`);
    console.log(`    ${c('green', '→')} ${envPath}`);
    console.log(`    ${c('green', '→')} OBSIDIAN_ROUTER_DEFAULT_VAULT=${quotedValue}`);
    if (bindingRecorded) {
      console.log(`    ${c('green', '→')} ${CONFIG_PATH}`);
      console.log(`    ${c('green', '→')} workspaceBindings: ${vaultSlug} ${c('gray', '(this is what decides; the .env line is a portable hint)')}`);
    }
    console.log(`    ${c('gray', `(vault path: ${vaultPath})`)}`);
  }
  return { envPath, vaultSlug, vaultPath, previousSlug, bindingRecorded };
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

// ---------------------------------------------------------------------------
// v0.65.0 (roadmap W4) — ATTACH an already-provisioned vault to a workspace.
//
// Distinct from bootstrap: every vault here ALREADY exists and is ALREADY in
// portRegistry. Nothing is provisioned, no port is allocated, no plugin is
// cloned. The whole job is the four workspace-side writes that make the
// binding real:
//
//   1. <ws>/.env                  OBSIDIAN_ROUTER_DEFAULT_VAULT=<primary slug>
//   2. <ws>/.claude/settings.json enabledPlugins[router] = true
//   3. <ws>/CLAUDE.md             a marked block naming primary + secondaries
//   4. <ws>/.gitignore            .env + .mcp.json
//
// Why a CLI subcommand and not (only) a skill or an MCP tool: the skill and
// the MCP server both ship INSIDE the Claude Code plugin, and the plugin is
// enabled per-workspace by write #2 above. In a workspace that has never been
// attached, the plugin is off, so `/obsidian-router:meta-attach-vault` does
// not exist and — under plugin-only distribution — neither does the router's
// MCP surface. The remedy cannot live in the thing it has to switch on. A
// terminal command has no such bootstrap paradox.
//
// Observed 2026-08-02: binding an empty workspace to two already-registered
// vaults cost ~15 tool calls of reverse-engineering for what is, in the end,
// these four writes.
// ---------------------------------------------------------------------------

const WS_BLOCK_START = '<!-- obsidian-mcp-router:vaults:start -->';
const WS_BLOCK_END = '<!-- obsidian-mcp-router:vaults:end -->';

/**
 * Resolve a vault slug against the router config's portRegistry. Returns the
 * absolute vault path, or null when no registered vault carries that slug.
 * Case-insensitive (Windows/macOS friendly), and honors `vaultNames` display
 * overrides exactly like src/registry.mjs and hooks/_helpers/workspace-vault.mjs.
 *
 * Extracted in v0.65.0 — the same loop was inlined in the standalone
 * --link-workspace handler and needed a third caller for --attach.
 *
 * v0.90.0: "exactly like src/registry.mjs and hooks/_helpers/workspace-vault.mjs"
 * is now literal — all three delegate to `resolveVaultBySlug` in
 * src/helpers/vault-slug.mjs, which also type-checks the `vaultNames` value.
 * The thin wrapper stays because this name is part of the module's surface
 * (tests/attach-workspace.test.mjs imports it, and so does --attach).
 */
export function resolveSlugToVaultPath(cfg, slug) {
  return resolveVaultBySlug(cfg, slug);
}

/** Every slug registered in the config, for "did you mean" error text. */
export function knownSlugs(cfg) {
  return knownVaultSlugs(cfg);
}

/**
 * Render the workspace CLAUDE.md block that names the attached vaults.
 *
 * This block is the ONLY first-class representation of "this workspace uses
 * more than one vault". The hooks cannot carry it: `detectVaultContext()`
 * reads a SINGLE `OBSIDIAN_ROUTER_DEFAULT_VAULT` slug, so exactly one vault is
 * ever auto-loaded and implicitly written to. Secondaries are reachable only
 * by naming them — `vault: "<slug>"` — on each tool call. The block states
 * that rule where the agent will actually read it, because the failure mode is
 * silent: a forgotten `vault:` writes to the primary and nothing complains.
 *
 * Pure string builder, so the wording is testable without touching disk.
 */
export function buildWorkspaceVaultsBlock({ primary, secondaries = [] }) {
  const lines = [];
  lines.push(WS_BLOCK_START);
  lines.push('## Obsidian vaults for this workspace');
  lines.push('');
  lines.push('*Managed by `obsidian-mcp-router --attach`. Edits inside this block are overwritten on re-attach; write your own notes outside it.*');
  lines.push('');
  lines.push(`- **Primary — \`${primary.slug}\`** (${primary.path})`);
  lines.push('  Auto-loaded at session start (its `wiki-meta/hot.md`), and the target of every router call made **without** a `vault:` argument.');
  if (secondaries.length > 0) {
    lines.push('');
    for (const s of secondaries) {
      lines.push(`- **Secondary — \`${s.slug}\`** (${s.path})`);
      lines.push(`  Reachable ONLY by naming it explicitly: \`vault: "${s.slug}"\`.`);
    }
    lines.push('');
    lines.push('> ⚠️ **The trap**: the router binds ONE vault per workspace. Omitting `vault:` does not raise an error — it silently reads and writes the primary. When you mean a secondary, name it.');
  }
  lines.push(WS_BLOCK_END);
  return lines.join('\n');
}

/**
 * Insert or replace the managed block in <ws>/CLAUDE.md, preserving whatever
 * the user wrote around it. Creates the file when absent.
 *
 * Returns { file, changed, created }.
 */
export function upsertWorkspaceClaudeMd(workspacePath, block) {
  const file = path.join(workspacePath, 'CLAUDE.md');
  const existed = fs.existsSync(file);
  let existing = '';
  if (existed) existing = fs.readFileSync(file, 'utf8');

  const start = existing.indexOf(WS_BLOCK_START);
  const end = existing.indexOf(WS_BLOCK_END);
  let next;
  if (start !== -1 && end !== -1 && end > start) {
    // Replace in place, keeping the text before and after untouched.
    next = existing.slice(0, start) + block + existing.slice(end + WS_BLOCK_END.length);
  } else {
    const sep = existing && !existing.endsWith('\n') ? '\n\n' : (existing ? '\n' : '');
    next = existing + sep + block + '\n';
  }
  if (existed && next === existing) return { file, changed: false, created: false };
  fs.writeFileSync(file, next, 'utf8');
  return { file, changed: true, created: !existed };
}

/**
 * Workspace-side .gitignore guard. Distinct from `appendGitignore()`, which
 * targets the VAULT (and also ignores `.smart-env/`). Here the concern is the
 * code repo: `.env` carries the vault binding and `.mcp.json` the router
 * wiring — neither belongs in a pushed commit. Idempotent.
 */
export function appendWorkspaceGitignore(workspacePath) {
  const giPath = path.join(workspacePath, '.gitignore');
  const wanted = ['.env', '.mcp.json'];
  let existing = '';
  if (fs.existsSync(giPath)) existing = fs.readFileSync(giPath, 'utf8');
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const toAdd = wanted.filter((l) => !present.has(l));
  if (toAdd.length === 0) return { file: giPath, added: [] };
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  const header = existing.includes('# obsidian-mcp-router') ? '' : '# obsidian-mcp-router (added by --attach)\n';
  fs.writeFileSync(giPath, existing + sep + header + toAdd.join('\n') + '\n', 'utf8');
  return { file: giPath, added: toAdd };
}

/**
 * Attach a workspace to one primary vault (+ optional secondaries), doing all
 * four writes. Every vault must already be in portRegistry — this never
 * provisions. Idempotent: re-running with the same arguments rewrites the same
 * bytes and reports "no change".
 *
 * `opts.claudeMd` / `opts.gitignore` / `opts.plugin` (all default true) let a
 * caller opt out of individual writes.
 */
export function attachWorkspace({ workspacePath, primarySlug, alsoSlugs = [], opts = {} }) {
  const ws = path.resolve(workspacePath);
  if (!fs.existsSync(ws)) fail(`Workspace path does not exist: ${ws}`);
  if (!fs.statSync(ws).isDirectory()) fail(`Workspace path is not a directory: ${ws}`);

  const cfg = loadConfig();
  if (registeredVaultPaths(cfg).length === 0) {
    fail(
      'Router config has no vaults in portRegistry.\n' +
      '   --attach binds EXISTING vaults. Bootstrap one first with `setup-vault.mjs <vault-path>`,\n' +
      '   or use the /obsidian-router:meta-attach-vault wizard to create one.',
    );
  }

  // Resolve every slug BEFORE writing anything — a typo in the 2nd vault must
  // not leave the workspace half-attached.
  const resolve1 = (slug, label) => {
    const vp = resolveSlugToVaultPath(cfg, slug);
    if (!vp) {
      fail(
        `${label} vault slug "${slug}" is not in portRegistry.\n` +
        `   Known slugs: ${knownSlugs(cfg).join(', ')}`,
      );
    }
    // THE REGISTERED SPELLING IS STORED, NOT THE USER'S. Resolution is
    // case-insensitive as a courtesy, but the registry matches bindings by
    // exact name: `--attach NoTeS` used to resolve `notes`, store `NoTeS`,
    // and produce a binding the server then rejected — the cascade fell
    // through to the host default and the user was bound to nothing while
    // the config said otherwise. Codex round 2, 2026-09-03.
    // Through `vaultSlug`, the one boundary that type-checks the config's
    // word about a vault's name — the hand-written version of this line was
    // exactly what the `vaultNames` sweep collapsed, and its scan refuses a
    // twenty-third copy on the commit that introduces it.
    return { slug: vaultSlug(cfg, vp), path: vp };
  };
  const primary = resolve1(primarySlug, 'Primary');
  const seen = new Set([primary.slug.toLowerCase()]);
  const secondaries = [];
  for (const s of alsoSlugs) {
    if (seen.has(String(s).trim().toLowerCase())) {
      warn(`Ignoring duplicate --also "${s}" (already the primary or listed twice).`);
      continue;
    }
    seen.add(String(s).trim().toLowerCase());
    secondaries.push(resolve1(s, 'Secondary'));
  }

  const steps = [];

  // 1) .env — reuses the bootstrap path's validation (catalog present, rebind
  //    warning) so both entry points refuse the same broken states.
  const link = linkWorkspaceToVault({
    workspacePath: ws,
    vaultPath: primary.path,
    vaultSlug: primary.slug,
    // `--attach` writes its own binding below, with the secondaries, so the
    // link step writes only the portable hint. One config write, not two.
    opts: { quiet: true, recordBinding: false },
  });
  steps.push({ step: '.env', detail: `OBSIDIAN_ROUTER_DEFAULT_VAULT=${primary.slug}`, path: link.envPath });

  // 1b) THE BINDING, in the user's own config — v0.90.0. `--attach` is an
  //     explicit command the user typed, so it IS a confirmation: it records
  //     the binding rather than leaving the workspace to be asked again at the
  //     next session. The .env line above stays as the PORTABLE HINT — it is
  //     the only part that travels to a second machine, where it will be
  //     signalled and confirmed once. This is also the first time the router
  //     itself learns about the secondaries: before this they lived only in
  //     the CLAUDE.md prose block, which the router never reads.
  //     Best effort: a config that cannot be written must not abort an attach
  //     whose workspace-side writes already succeeded.
  try {
    updateConfigBindings(CONFIG_PATH, (cfg) => {
      // A RE-ATTACH TO THE SAME PRIMARY KEEPS ITS LOCK. Rewriting the binding
      // from scratch dropped `locked: true` silently — the same shape as the
      // confirmation tool's `locked === true`, found together in round 2 of
      // the Codex review (2026-09-03). Attaching elsewhere drops it, since the
      // lock belonged to the previous primary.
      const previous = readBinding(cfg, ws);
      const also = secondaries.map((s) => s.slug);
      // Same rule as confirm_workspace_binding: the write tier of a secondary
      // that stays in `also` survives the re-attach; one that leaves takes its
      // tier with it; the previous primary, if it drops to `also`, starts soft.
      const keep = (list) => (previous && Array.isArray(list) ? list.filter((n) => also.includes(n)) : []);
      return withBinding(cfg, ws, {
        vault: primary.slug,
        also,
        locked: Boolean(previous && previous.vault === primary.slug && previous.locked),
        confirmedVia: 'attach',
        alsoLocked: keep(previous?.alsoLocked),
        alsoWritable: keep(previous?.alsoWritable),
      });
    });
    const alsoNote = secondaries.length ? ` (+${secondaries.length} also)` : '';
    steps.push({ step: 'binding', detail: `${primary.slug}${alsoNote} — in your router config, not in this project`, path: CONFIG_PATH });
  } catch (e) {
    // Same as `--link-workspace`: attaching IS this command's purpose, and the
    // binding is the only part of it that decides anything now. Reporting a
    // successful attach whose binding was not written would be reporting the
    // opposite of what happened. (Codex, round 5.)
    fail(
      [
        `Could not record the workspace binding in ${CONFIG_PATH} (${e.message}).`,
        '   The workspace files were written, but a project file no longer chooses a vault:',
        '   this workspace is NOT attached until the binding is recorded. Fix the config and',
        '   run --attach again, or confirm it from a session with confirm_workspace_binding.',
      ].join('\n'),
    );
  }

  // 2) .claude/settings.json — WITHOUT this the .env above is inert: the
  //    plugin stays off, so hot-cache-load and wiki-query-first-nudge never
  //    run and the binding has no observable effect.
  if (opts.plugin !== false) {
    const res = writeClaudeWorkspaceSettings(ws);
    steps.push({ step: '.claude/settings.json', detail: res.changed ? 'router plugin enabled' : 'already enabled', path: res.file });
  }

  // 3) CLAUDE.md — the multi-vault declaration.
  if (opts.claudeMd !== false) {
    const block = buildWorkspaceVaultsBlock({ primary, secondaries });
    const res = upsertWorkspaceClaudeMd(ws, block);
    steps.push({
      step: 'CLAUDE.md',
      detail: res.created ? 'created with the vaults block' : (res.changed ? 'vaults block updated' : 'vaults block already current'),
      path: res.file,
    });
  }

  // 4) .gitignore.
  if (opts.gitignore !== false) {
    const res = appendWorkspaceGitignore(ws);
    steps.push({
      step: '.gitignore',
      detail: res.added.length ? `added ${res.added.join(', ')}` : 'already covers .env + .mcp.json',
      path: res.file,
    });
  }

  return { workspacePath: ws, primary, secondaries, steps, previousSlug: link.previousSlug };
}

// ---------------------------------------------------------------------------
// v0.12.7 — Wiki scaffolding at vault bootstrap time
// ---------------------------------------------------------------------------
//
// Pre-v0.12.7, the 4 wiki-meta scaffolds (catalog/hot/overview/journal.md) were
// created only by the `/obsidian-router:wiki` skill — a separate manual step
// after vault bootstrap. The `meta-attach-vault` wizard now bundles it into
// the provisioning step so a freshly-bootstrapped vault is immediately ready
// for workspace-bound mode (hot-cache-load + wiki-query-first-nudge hooks
// depend on `wiki-meta/catalog.md` existing; without it, --link-workspace
// refuses to bind — see `linkWorkspaceToVault()` above).
//
// Behavior:
//   - Creates `wiki/` and `wiki/sessions/` (idempotent: `mkdir -p`).
//   - Copies the 4 scaffolds from `templates/wiki-meta/` into the target
//     vault's `wiki-meta/`, substituting {{TIMESTAMP}} and {{VAULT_PATH}}.
//   - Existing files at the destination are preserved (no clobber).
//
// `--force` is intentionally NOT honored here. Other clone helpers
// (`cloneRootDocs`, `cloneSmartEnv`, `cloneSnippets`) overwrite on --force
// because the source-of-truth lives in the reference vault. The scaffolds
// are different: they become USER CONTENT the moment they're first written
// (the wiki accretes notes, the log gets entries, hot.md tracks recent work).
// Re-running setup-vault.mjs --force on an active vault should NOT wipe the
// user's wiki state. If someone genuinely needs to reset a scaffold, they
// delete the file by hand and re-run — that path is explicit and traceable
// via git.
//
// Does NOT touch CLAUDE.md — that's owned by the `meta-attach-vault`
// conventions-picker step (and by the `wiki` skill for the wiki block).

// Wizard `--wiki-mode` section seeds. The engine stays 100% deterministic: for
// the `domain` mode the frontend (LLM) translates the user's one-line domain
// description into a flat section list passed via `--wiki-sections`, and the
// engine simply lays those out. When no mode is given, scaffoldWikiMeta uses
// the shipped generic template verbatim (unchanged pre-wizard behaviour).
const WIKI_MODE_SECTIONS = {
  personal: ['People', 'Concepts', 'Decisions', 'References', 'Projects'],
  research: ['Papers', 'Concepts', 'Hypotheses', 'Methodology', 'Findings'],
  business: ['Competitors', 'Clients', 'Decisions', 'Stakeholders', 'Meetings'],
  code: ['Codebases', 'Architecture Decisions (ADR)', 'Runbooks', 'Concepts', 'Sessions'],
};

function buildModeCatalogContent(mode, sections) {
  const list = (mode === 'domain' && sections && sections.length)
    ? sections
    : (WIKI_MODE_SECTIONS[mode] || WIKI_MODE_SECTIONS.personal);
  // v0.59.4 — map-of-maps seeding. The pre-0.59.4 seed said "add a row for
  // every new page", which is precisely what grew one vault's catalog to
  // 70 KB / 115 rows: unreadable in a single tool call, and a guaranteed
  // maintenance drift. Areas point at their generated `index.md` instead.
  let body =
    '---\n' +
    'type: index\n' +
    'title: "Wiki Catalog"\n' +
    'description: "The map of maps: one entry per area, each pointing at that directory\'s generated index."\n' +
    `mode: ${mode}\n` +
    '---\n\n' +
    '# Wiki Catalog\n\n' +
    '> **A map of maps, not a list of pages.** Each section below is an *area*; once it has pages on disk, link its generated index with a markdown link — `[Area](../wiki/<dir>/index.md)` — never a wikilink, since every index shares the `index` basename and Obsidian resolves wikilinks by basename.\n' +
    '> A new page in an existing area needs **no edit here**: the generated index picks it up. Only a new area earns a new section.\n\n' +
    '## Wiki Core\n\n' +
    '- [[overview]] — what this wiki covers\n' +
    '- [[hot]] — recent-context cache, rewritten (not appended) each session\n' +
    '- [[journal]] — thin session index, one line per milestone\n';
  for (const header of list) {
    body += `\n## ${header}\n\n_Area — link its generated index here once it has pages._\n`;
  }
  return body;
}

function scaffoldWikiMeta(vaultPath, wikiOpts = {}) {
  const wikiDir = path.join(vaultPath, 'wiki');
  // v0.59.0 — the session journals live in wiki-meta/Sessions/ since v0.12.8;
  // this scaffolder kept creating the pre-v0.12.8 wiki/sessions/ ghost dir.
  const sessionsDir = path.join(vaultPath, 'wiki-meta', 'Sessions');
  const metaDir = path.join(vaultPath, 'wiki-meta');
  const templatesDir = path.join(REPO_ROOT, 'templates', 'wiki-meta');

  if (!fs.existsSync(templatesDir)) {
    warn(`Wiki-meta templates not found at ${templatesDir} — skipping scaffold.`);
    return;
  }

  fs.mkdirSync(wikiDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(metaDir, { recursive: true });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  let created = 0;
  let preserved = 0;
  // Which slot each scaffold fills, for the two that were renamed in v0.58.0.
  const SLOT_OF = { [CATALOG_BASENAME]: 'catalog', [JOURNAL_BASENAME]: 'journal' };
  for (const scaffold of WIKI_META_SCAFFOLDS) {
    const dst = path.join(metaDir, scaffold);
    if (fs.existsSync(dst)) {
      preserved++;
      continue;
    }
    // A vault still on the pre-0.58.0 names fills these slots under
    // `index.md`/`log.md`. Testing only the CURRENT name would create an empty
    // template beside the user's real file — and since readers try the current
    // name first, the real catalogue/journal would go silently invisible. Same
    // duplicate-journal trap the audit trail avoids in `src/index.mjs`.
    const slot = SLOT_OF[scaffold];
    if (slot) {
      const existing = resolveScaffold(vaultPath, slot, { fs, path });
      if (existing) {
        preserved++;
        warn(
          `${existing.relPath} still uses the pre-0.58.0 name — preserved, and ${scaffold} was NOT created ` +
          `(a second file would shadow it). ${scaffoldMigrationHint(existing.relPath)}`,
        );
        continue;
      }
    }
    // --wiki-mode: seed catalog.md programmatically from the mode's section
    // list (and stamp overview.md's frontmatter). Without a mode, use the
    // shipped template verbatim — the pre-wizard default.
    let content;
    if (scaffold === CATALOG_BASENAME && wikiOpts.mode) {
      content = buildModeCatalogContent(wikiOpts.mode, wikiOpts.sections);
    } else {
      const src = path.join(templatesDir, scaffold);
      if (!fs.existsSync(src)) {
        // Loud-fail rather than silently skipping: if WIKI_META_SCAFFOLDS gains
        // a new entry without a matching template file, this catches it on the
        // next bootstrap instead of letting the partial scaffold ship silently.
        // (review+ pass 1 Reviewer A NIT #5)
        warn(`Wiki-meta scaffold template missing at ${src} — not creating ${scaffold} in target vault. Add the template file to fix.`);
        continue;
      }
      content = fs.readFileSync(src, 'utf8')
        .replace(/\{\{TIMESTAMP\}\}/g, timestamp)
        .replace(/\{\{VAULT_PATH\}\}/g, vaultPath);
      if (scaffold === 'overview.md' && wikiOpts.mode) {
        content = content.replace(/^type: overview$/m, `type: overview\nmode: ${wikiOpts.mode}`);
      }
    }
    fs.writeFileSync(dst, content);
    created++;
  }

  // v0.59.0 — volet ②: a fresh wiki is born with its OKF projections (root
  // wiki/index.md + wiki/log.md), so the write middleware's requireInitialized
  // gate opens from day one. Conflict-safe: an unmarked homonym is preserved.
  const projections = generateProjectionsOnDisk(vaultPath, { apply: true, vaultName: wikiOpts.vaultName });
  if (projections.conflicts.length > 0) {
    warn(`OKF projections: ${projections.conflicts.length} hand-written file(s) squat reserved paths (${projections.conflicts.join(', ')}) — left untouched.`);
  }

  // BIRTH, second half: the local BM25 index. Until this call the index was an
  // opt-in nothing ever triggered — a vault could live its whole life without
  // one, and `search_smart` on a vault without Smart Connections then had NO
  // tier left and failed outright instead of degrading. Built on DISK because
  // Obsidian has never opened this vault yet, so the REST tool cannot run.
  //
  // A newborn wiki has no content pages (the projections are excluded from the
  // corpus), so this writes a valid, empty, version-stamped index. That is the
  // point: the file exists, so the first router contact of the first session
  // sees `stale` and rebuilds it, rather than seeing `absent` and having to
  // decide. Idempotent by fingerprint — re-running the scaffolder rewrites
  // nothing.
  const searchIndex = generateSearchIndexOnDisk(vaultPath, { apply: true, vaultName: wikiOpts.vaultName });
  if (searchIndex.conflicts.length > 0) {
    warn(`Search index: ${searchIndex.conflicts.join(', ')} is not one of ours — left untouched, no index written.`);
  }

  // Honest one-liner about the index: `chunks: 0` on a newborn vault is the
  // expected state, not a failure, and saying so beats a silent success.
  const indexNote = searchIndex.skipped
    ? `search index skipped (${searchIndex.skipped})`
    : searchIndex.written
      ? `search index built (${searchIndex.stats?.chunks ?? 0} chunk${searchIndex.stats?.chunks === 1 ? '' : 's'}${searchIndex.stats?.chunks === 0 ? ' — no content pages yet' : ''})`
      : searchIndex.upToDate
        ? 'search index already current'
        : 'search index NOT written';

  if (created > 0) {
    ok(`Scaffolded wiki structure: wiki/, wiki-meta/ (+ Sessions/), OKF projections, ${indexNote} (${created} file${created > 1 ? 's' : ''} created${preserved > 0 ? `, ${preserved} preserved` : ''})`);
  } else if (preserved > 0) {
    info(`Wiki scaffolds already present (${preserved} file${preserved > 1 ? 's' : ''} preserved) — ${indexNote}`);
  }
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
// Human-facing docs cloned to a fresh vault. `Documentation/` is the reference
// vault's docs folder (quick-reference PDFs, SETUP.md, the vault-facing
// CLAUDE.md) — reorganized there from the vault root, so the old per-PDF root
// entries found nothing and only `.claude` still cloned. Dir entries
// (`Documentation`, `.claude`) are cloned recursively by cloneRootDocs();
// `README.md` covers the shipped skeleton (which keeps its README at root and
// has no Documentation/). Non-existent entries are silently skipped, so this
// list is a union across source shapes.
const ROOT_FILES_TO_CLONE = ['README.md', 'Documentation', '.claude'];

function cloneRootDocs(referenceVault, targetVault, force, skipItems = []) {
  for (const item of ROOT_FILES_TO_CLONE) {
    if (skipItems.includes(item)) continue;
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
  console.log(`     (The bridge plugin and BRAT are already in place — no action needed for those;`);
  console.log(`      BRAT auto-updates the bridge + hot-reload from GitHub releases at startup.)`);
  console.log(`  4. Enable all four in Settings → Community plugins.`);
  console.log(`  5. Restart Obsidian once so Local REST API generates its certificate.`);
  console.log(`  6. ${c('bold', 'Finalize')}: ${c('cyan', `node "${fileURLToPath(import.meta.url)}" --init-reference "${abs}"`)}`);
  console.log(`     This validates the required plugins are present and reserves the port.`);
  console.log('');
  console.log(c('gray', `After step 6, bootstrap any new vault with:`));
  console.log(c('gray', `  node ${path.basename(fileURLToPath(import.meta.url))} <new-vault-path>`));
  console.log('');
}

// --with-folder-tree (with --from-vault): recreate the source vault's `wiki/`
// DIRECTORY tree in the target, empty — no `.md` files, no content. Keeps the
// organizational skeleton without cloning any notes (config-only copy, per Q3).
export function recreateWikiFolderTree(sourceVault, targetVault) {
  const srcWiki = path.join(sourceVault, 'wiki');
  if (!fs.existsSync(srcWiki)) return 0;
  let made = 0;
  const walk = (relDir) => {
    const abs = path.join(srcWiki, relDir);
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const rel = path.join(relDir, e.name);
      fs.mkdirSync(path.join(targetVault, 'wiki', rel), { recursive: true });
      made++;
      walk(rel);
    }
  };
  walk('');
  if (made > 0) ok(`Recreated ${made} empty wiki/ folder(s) from source (no notes copied)`);
  return made;
}

// --from-vault: copy the source vault's appearance.json (visual config, no
// secrets) so a vault chosen for its look keeps it (spec Q3). Called BEFORE
// cloneSnippets so the snippet-enablement merges INTO the copied
// appearance.json rather than overwriting it. The themes/ folder itself is
// handled by cloneThemes() below (per-theme granularity, all bootstrap paths)
// — this function used to wipe-and-replace the whole themes/ dir on --force,
// which destroyed target-only themes; cloneThemes never does.
function copyVaultAppearance(sourceVault, targetVault, force) {
  const srcApp = path.join(sourceVault, '.obsidian', 'appearance.json');
  const dstApp = path.join(targetVault, '.obsidian', 'appearance.json');
  if (fs.existsSync(srcApp) && (force || !fs.existsSync(dstApp))) {
    fs.mkdirSync(path.dirname(dstApp), { recursive: true });
    fs.copyFileSync(srcApp, dstApp);
    ok('Copied appearance.json from source vault');
  }
}

// Lot 2 — theme propagation, every bootstrap/sync path. Copies each theme
// folder under the source's `.obsidian/themes/` into the target, PER THEME:
// an existing theme dir in the target is left untouched unless --force, and
// a theme that exists ONLY in the target is never deleted (unlike a
// wipe-and-replace of the whole themes/ dir). Theme folders are CSS +
// manifest by construction — no credentials to leak.
export function cloneThemes(sourceVault, targetVault, force) {
  const srcThemes = path.join(sourceVault, '.obsidian', 'themes');
  const result = { cloned: [], skipped: [] };
  if (!fs.existsSync(srcThemes)) return result;
  for (const entry of fs.readdirSync(srcThemes, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(srcThemes, entry.name);
    const dst = path.join(targetVault, '.obsidian', 'themes', entry.name);
    if (fs.existsSync(dst)) {
      if (!force) { result.skipped.push(entry.name); continue; }
      fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    result.cloned.push(entry.name);
  }
  if (result.cloned.length > 0) ok(`Cloned theme(s): ${result.cloned.join(', ')}`);
  return result;
}

// Lot 2 — appearance bootstrap for the reference/skeleton paths. Copies the
// source's appearance.json ONLY when the target has none: a fresh vault
// inherits the template's look (cssTheme / light-dark scheme / accentColor),
// an existing vault's choices are NEVER touched — not even with --force,
// because the theme is a per-user preference, not template state. Per-key
// writes stay with enableSnippetsInAppearance() and applyThemeChoice().
export function syncAppearanceDefaults(sourceVault, targetVault) {
  const srcApp = path.join(sourceVault, '.obsidian', 'appearance.json');
  const dstApp = path.join(targetVault, '.obsidian', 'appearance.json');
  if (!fs.existsSync(srcApp) || fs.existsSync(dstApp)) return false;
  fs.mkdirSync(path.dirname(dstApp), { recursive: true });
  fs.copyFileSync(srcApp, dstApp);
  ok('Created appearance.json (from source template)');
  return true;
}

// Lot 2 — the `--theme` wizard picker, applied (it used to be recorded but
// blocked). Merge-writes ONLY `cssTheme` in the target's appearance.json:
// 'obsidian-default' (the planner's id for the built-in look) → "" ; any
// other value must match a theme folder present in the target AFTER
// cloneThemes ran — otherwise warn-and-keep rather than writing a cssTheme
// Obsidian cannot resolve (which silently renders as the default theme).
export function applyThemeChoice(targetVault, themeChoice) {
  const isDefault = themeChoice === 'obsidian-default' || themeChoice === 'default';
  if (!isDefault) {
    const manifest = path.join(targetVault, '.obsidian', 'themes', themeChoice, 'manifest.json');
    if (!fs.existsSync(manifest)) {
      warn(`--theme "${themeChoice}" has no .obsidian/themes/${themeChoice}/manifest.json in the target — keeping the current theme.`);
      return false;
    }
  }
  const appPath = path.join(targetVault, '.obsidian', 'appearance.json');
  let appearance = {};
  if (fs.existsSync(appPath)) {
    try { appearance = JSON.parse(fs.readFileSync(appPath, 'utf8')); } catch { appearance = {}; }
  }
  appearance.cssTheme = isDefault ? '' : themeChoice;
  fs.mkdirSync(path.dirname(appPath), { recursive: true });
  fs.writeFileSync(appPath, JSON.stringify(appearance, null, 2) + '\n');
  ok(`Applied theme: ${isDefault ? 'Obsidian default' : themeChoice}`);
  return true;
}

// Lot 2 — anti-downgrade guard. BRAT auto-updates GitHub-sourced plugins
// (the bridge, hot-reload) inside USER vaults at Obsidian startup, so a
// target's installed plugin can legitimately be NEWER than the copy sitting
// in the reference vault. Overwriting it would downgrade live code — locked
// decision 2026-06-19: never. Compares manifest.json versions; returns false
// (= keep the historical overwrite behavior) whenever either manifest is
// missing or unparseable, so the guard can only ever SKIP a copy, never
// break one.
export function isTargetPluginNewer(srcPluginDir, dstPluginDir) {
  const readVersion = (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version; }
    catch { return null; }
  };
  const srcV = readVersion(srcPluginDir);
  const dstV = readVersion(dstPluginDir);
  // A SOURCE with no readable manifest facing a target that has one is a
  // config pre-seed (data.json only) — it must PROTECT the installed
  // plugin, never justify replacing its code (review+ BLOCKER: --force
  // from the GitHub skeleton wiped the bridge's main.js fleet-wide).
  // A broken TARGET manifest still fails open (refresh repairs it).
  if (srcV === null && dstV !== null) return true;
  if (!srcV || !dstV || !parseSemver(srcV) || !parseSemver(dstV)) return false;
  return compareSemver(dstV, srcV) > 0;
}

// --claude-workspace: enable the router plugin in the WORKSPACE's
// `.claude/settings.json` (idempotent merge, preserving other keys). Closes the
// gap where a fresh vault got its slash commands via cloneRootDocs but the
// bound code workspace never did. Best-effort verification of the global
// marketplace registration — WARNS rather than blind-writing the user's global
// settings (the correct marketplace source is not guessable safely).
const ROUTER_PLUGIN_KEY = 'obsidian-router@obsidian-mcp-router-marketplace';
const ROUTER_MARKETPLACE = 'obsidian-mcp-router-marketplace';
function writeClaudeWorkspaceSettings(workspacePath) {
  const dir = path.join(workspacePath, '.claude');
  const file = path.join(dir, 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { settings = {}; }
  }
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object' || Array.isArray(settings.enabledPlugins)) {
    settings.enabledPlugins = {};
  }
  const already = settings.enabledPlugins[ROUTER_PLUGIN_KEY] === true;
  settings.enabledPlugins[ROUTER_PLUGIN_KEY] = true;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  if (already) info(`Workspace .claude/settings.json already enabled the router plugin — no change.`);
  else ok(`Enabled the router plugin in ${file} (~10k context tokens/session).`);

  // Verify the marketplace is known globally (read-only). If not, guide the
  // user rather than mutating their global settings with a guessed source.
  try {
    const globalSettings = loadUserSettings();
    const known = globalSettings.extraKnownMarketplaces
      && Object.prototype.hasOwnProperty.call(globalSettings.extraKnownMarketplaces, ROUTER_MARKETPLACE);
    if (!known) {
      warn(`Marketplace "${ROUTER_MARKETPLACE}" is not in ~/.claude/settings.json extraKnownMarketplaces.\n` +
        `   The workspace plugin toggle only takes effect once Claude Code knows the marketplace.\n` +
        `   Register it once (interactive session): /plugin marketplace add tboome33/obsidian-mcp-router`);
    }
  } catch { /* global settings unreadable — skip the advisory */ }
  return { file, changed: !already };
}

// --open: launch Obsidian on the freshly-provisioned vault via its protocol
// handler. Best-effort + guarded: a failure never aborts (the vault is already
// provisioned). Returns the URI regardless so the caller can print it.
// The URI builder and the launcher itself moved to
// src/helpers/obsidian-launcher.mjs in v0.90.0: the MCP server needs them too
// (binding a vault whose Obsidian is closed has to be able to open it), and a
// second copy would eventually lose the Electron-fuse lesson the original
// carries. Re-exported here because this file has been the import site since
// v0.65.0 — one definition, and this is a view of it.
export { obsidianOpenUri };
function openObsidianVault(obsidianName) {
  // The launcher itself lives in src/helpers/obsidian-launcher.mjs since
  // v0.90.0 — one definition, shared with the MCP server, carrying the
  // Electron-fuse removal and the platform table. This wrapper keeps the
  // script's own reporting: best effort, never aborts a provisioning that
  // already succeeded, and always prints the URI so a human can finish by hand.
  const r = launchObsidianVault(obsidianName);
  if (r.launched) ok(`Opened Obsidian on vault "${obsidianName}"`);
  else warn(`Could not auto-open Obsidian (${r.reason}). Open manually: ${r.uri}`);
  return r.uri;
}

// --probe: poll the vault's unencrypted loopback REST port until it answers (or
// times out), then verdict. Reachability of the insecure HTTP server means
// Local REST API is up in an opened + trusted vault; the bridge's /open route
// rides on the same server. A red verdict (timeout) is expected until the user
// opens Obsidian + clicks "Trust author and enable plugins", so this is the
// wizard's post-open health check. Returns { ok, insecurePort, attempts }.
async function probeVaultHealth(insecurePort, { timeoutMs = 15000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  const tryOnce = () => new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: insecurePort, path: '/', timeout: 2000 },
      (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
  while (Date.now() < deadline) {
    attempts++;
    if (await tryOnce()) return { ok: true, insecurePort, attempts };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, insecurePort, attempts };
}

function setupVault(vaultPath, opts = {}) {
  const cfg = loadConfig();
  // Reconcile the registry's shape BEFORE anything reads it to allocate. A
  // legacy HTTPS-only registry is at its most dangerous at exactly this
  // moment: the allocator is about to trust it, and every plaintext port in
  // the fleet is invisible in it. No-op (no backup, no write) when the
  // registry is already two-port.
  migrateConfigPortRegistry(cfg);
  const wizard = opts.wizard || {};

  // Resolve the effective source vault + plugin set from the wizard opts. The
  // DEFAULT (no wizard flags) is source 'reference' → cfg.referenceVault and
  // profile 'recommended' → resolvePluginsToClone(reference), which reproduces
  // the pre-wizard clone behaviour byte-for-byte. `--from-vault` swaps the
  // source vault; `--bare` forces the minimal (REQUIRED-only) profile;
  // `--plugins` overrides the profile.
  const srcResolved = resolveSourceVault(
    { source: wizard.source || 'reference', fromVault: wizard.fromVault }, cfg, SKELETON_DIR);
  if (srcResolved.error) fail(srcResolved.error);
  const sourceVault = srcResolved.sourceVault;
  const sourceKind = srcResolved.kind;
  if (!sourceVault) {
    fail(
      `No reference vault configured.\n  ` +
      `Run first:\n  ` +
      c('cyan', `  node "${fileURLToPath(import.meta.url)}" --init-reference <path-to-vault-with-plugins-installed>`)
    );
  }
  if (!fs.existsSync(sourceVault)) {
    fail(`Source vault no longer exists: ${sourceVault}`);
  }
  const pluginProfile = sourceKind === 'bare' ? 'minimal' : (wizard.pluginProfile || 'recommended');

  // v0.12.7 — early validation of `--link-workspace <ws-path>` (review+ pass 1
  // codex P2 #2). Without this, a typo in --link-workspace would still let the
  // provisioning succeed (plugins cloned, port allocated, registry updated)
  // and only fail at the very end on `linkWorkspaceToVault()`, leaving an
  // orphan registry entry pointing at a vault that was never bound to a
  // workspace. We fail HERE so the user sees the typo before any state mutation.
  if (opts.linkWorkspace) {
    const wsResolved = path.resolve(opts.linkWorkspace);
    if (!fs.existsSync(wsResolved)) {
      fail(`Workspace path does not exist: ${wsResolved} (passed via --link-workspace)`);
    }
    if (!fs.statSync(wsResolved).isDirectory()) {
      fail(`Workspace path is not a directory: ${wsResolved} (passed via --link-workspace)`);
    }
  }

  const abs = path.resolve(vaultPath);

  // --name slug-collision guard (review+ W1 pass 1). Checked HERE — before any
  // mutation — so a colliding name fails fast with zero side-effects, rather
  // than provisioning a full vault and only then discovering the registry can't
  // disambiguate it. The dry-run planner surfaces the same warning; this is the
  // enforcing counterpart on the real write path.
  if (wizard.name) {
    const customSlug = wizard.name.toLowerCase();
    if (customSlug !== defaultNameFromPath(abs)) {
      const slugs = existingSlugs(cfg);
      if (slugs.has(customSlug) && path.resolve(slugs.get(customSlug)) !== abs) {
        fail(`Slug "${customSlug}" already maps to ${slugs.get(customSlug)}.\n` +
          `   Pass a distinct --name so the router can disambiguate the two vaults.`);
      }
    }
  }

  if (!fs.existsSync(abs)) {
    fs.mkdirSync(abs, { recursive: true });
    ok(`Created vault directory: ${abs}`);
  }

  // Legacy wiki layout guard (review+ pass 2 codex P2 #1, refines pass 1 #1).
  // Placed BEFORE any vault mutation (plugin clone, patchRestApiData, root-docs
  // copy) so a legacy-layout vault fails fast with zero side-effects — pre-fix,
  // the check ran AFTER cloning, leaving a partially bootstrapped vault on
  // refusal. Refines pass 1's `migrationState === 'legacy'` check: now refuses
  // whenever ANY of the 4 wiki/<scaffold>.md exists (the only condition that
  // makes adding wiki-meta/ alongside dangerous — it would create a 'partial'
  // state that --migrate-wiki-meta then refuses). Vaults with ONLY some
  // wiki-meta/*.md files (and no legacy files) are repaired idempotently by
  // scaffoldWikiMeta() below — no refusal needed (codex P2 #2).
  const legacyScaffolds = LEGACY_V0120_SCAFFOLDS.filter((f) =>
    isLegacyWikiScaffoldFile(abs, f));
  if (legacyScaffolds.length > 0) {
    fail(
      `Vault at ${abs} still has legacy scaffold(s): wiki/${legacyScaffolds.join(', wiki/')}.\n` +
      `   Refusing to scaffold wiki-meta/ alongside — that would create a 'partial'\n` +
      `   migration state that --migrate-wiki-meta later refuses.\n` +
      `   Fix: migrate first, then re-run setup-vault.mjs:\n` +
      `      node "${fileURLToPath(import.meta.url)}" --migrate-wiki-meta "${abs}"`
    );
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

  // Clone plugins. The set comes from the resolved wizard profile: 'recommended'
  // (default) derives from the source vault's community-plugins.json (union
  // REQUIRED — see plugin-resolver.mjs), 'minimal' is REQUIRED-only (also what
  // --bare forces), 'custom:a,b,c' is an explicit list ∪ REQUIRED.
  const targetObsidian = path.join(abs, '.obsidian');
  fs.mkdirSync(path.join(targetObsidian, 'plugins'), { recursive: true });
  const pluginsToClone = resolvePluginProfile(
    pluginProfile, wizard.pluginCustom, sourceVault, REQUIRED_PLUGINS);

  // SECURITY (review+ W1 pass 1, codex P1): validate ALL required plugins exist
  // in the source BEFORE copying anything. Otherwise, if a required plugin that
  // sorts AFTER obsidian-local-rest-api is missing, the loop would copy the
  // credentialed REST data.json first and then fail() — leaving the source's
  // API key + port in the half-built target. Failing here guarantees the
  // credential file is never written on a doomed run.
  for (const req of REQUIRED_PLUGINS) {
    if (!fs.existsSync(path.join(sourceVault, '.obsidian', 'plugins', req))) {
      fail(`Required plugin missing in source vault: ${req}\n   Source: ${sourceVault}`);
    }
  }
  // --plugins custom:… names an explicit set; warn (don't silently skip) when a
  // requested plugin isn't present in the source, since the clone loop below
  // skips non-existent optional plugins.
  if (pluginProfile === 'custom' && Array.isArray(wizard.pluginCustom)) {
    for (const p of wizard.pluginCustom) {
      if (!REQUIRED_PLUGINS.includes(p) &&
          !fs.existsSync(path.join(sourceVault, '.obsidian', 'plugins', p))) {
        warn(`--plugins custom: "${p}" is not installed in the source vault — it will NOT be cloned or enabled.`);
      }
    }
  }

  for (const p of pluginsToClone) {
    const srcPlugin = path.join(sourceVault, '.obsidian', 'plugins', p);
    const dstPlugin = path.join(targetObsidian, 'plugins', p);
    if (!fs.existsSync(srcPlugin)) {
      if (REQUIRED_PLUGINS.includes(p)) fail(`Required plugin missing in reference vault: ${p}`);
      continue;
    }
    if (fs.existsSync(dstPlugin) && !opts.force) {
      warn(`Plugin already present, skipping clone: ${p} (use --force to overwrite)`);
      continue;
    }
    // Lot 2 anti-downgrade: even under --force, never replace a plugin the
    // target has at a NEWER version than the source (BRAT keeps user vaults
    // fresh; the reference copy can lag). See isTargetPluginNewer().
    if (fs.existsSync(dstPlugin) && isTargetPluginNewer(srcPlugin, dstPlugin)) {
      warn(`Kept ${p}: target version is newer than the source's (BRAT-updated) — not downgrading.`);
      continue;
    }
    if (fs.existsSync(dstPlugin)) {
      // --force re-clone: preserve the target's local data.json (per-vault user
      // settings — e.g. mcp-router-bridge's `foregroundViaProtocol` + presence).
      // syncPluginsMode already does this; this clone path MUST match or
      // re-running `setup-vault.mjs <vault> --force` (a documented repair action)
      // silently resets those prefs to defaults. The REST API's data.json is
      // exempt: it's intentionally (re)written by the port/apiKey adoption logic
      // a few lines below, so preserving it here would be pointless.
      let preservedData = null;
      const dataJsonPath = path.join(dstPlugin, 'data.json');
      if (!CREDENTIAL_LEAK_PLUGINS.has(p) && fs.existsSync(dataJsonPath)) {
        try { preservedData = fs.readFileSync(dataJsonPath); } catch {}
      }
      fs.rmSync(dstPlugin, { recursive: true, force: true });
      copyDirRecursive(srcPlugin, dstPlugin);
      if (preservedData) {
        try { fs.writeFileSync(dataJsonPath, preservedData); } catch {}
      }
    } else {
      copyDirRecursive(srcPlugin, dstPlugin);
    }
    ok(`Cloned plugin: ${p}`);
  }

  // Ensure app.json exists so vault is "valid". Prefer the SOURCE vault's
  // app.json (skeleton and --from-vault sources carry their own app-level
  // defaults, e.g. defaultViewMode: "preview" / livePreview: false), then the
  // configured reference vault's, then an empty object. Same model as
  // cloneSnippets().
  const appJsonPath = path.join(targetObsidian, 'app.json');
  if (!fs.existsSync(appJsonPath)) {
    const candidates = [
      path.join(sourceVault, '.obsidian', 'app.json'),
      // `path.join` throws on a non-string; the ternary's truthiness test let
      // one straight through. (v0.90.0)
      referenceVaultPath(cfg) ? path.join(referenceVaultPath(cfg), '.obsidian', 'app.json') : null,
    ].filter(Boolean);
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) {
      fs.copyFileSync(found, appJsonPath);
      ok('Created app.json (from source template)');
    } else {
      fs.writeFileSync(appJsonPath, '{}\n');
      ok('Created app.json');
    }
  }

  // Decide port + apiKey: adopt pre-existing values if found, else generate fresh.
  //
  // The on-disk map is built ONCE here — before any decision — so every branch
  // below reasons over the same picture of what the fleet actually binds, in
  // BOTH port spaces. `abs` is included so the target's own current ports do
  // not read as somebody else's reservation.
  const onDiskPorts = buildOnDiskPortMap(cfg, [abs, sourceVault]);
  let port, insecurePort = null, apiKey, adopted = false;

  // Corollary of the two-port bug: `referenceVault` is copied to create a new
  // vault, PORTS INCLUDED. Three of the nine collisions measured on 2026-08-29
  // were exactly this — Roblox, RECHERCHES ETUDES SUP and a second .template
  // all sitting on the template's factory 27124/27134. Provisioning must
  // RENUMBER the copy, never let it inherit.
  //
  // THE TELL IS THE API KEY, AND ONLY THE API KEY. A target whose REST key is
  // byte-identical to the source's cannot be anything but a copy of it: the key
  // is 32 random bytes, nobody types it, and no independent vault ever grows
  // the same one. Renumbering such a vault is safe precisely because the
  // plaintext port it carries is the SOURCE's — any click-to-open link written
  // under that number belongs to the source, not to this vault.
  //
  // A PORT match is NOT a tell, and treating it as one was a defect (found in
  // review, 2026-08-30, before release): an independent vault that merely
  // happens to sit on the source's HTTPS port would be classified as a copy and
  // renumbered — and renumbering writes a NEW `insecurePort` over the one it
  // legitimately owns, killing every click-to-open link already written to it.
  // Measured on a fixture: insecurePort 27199 → 27135, plus a regenerated key.
  // That is the one invariant this whole release exists to protect.
  //
  // So a port-only match falls through to the adoption branch below, where the
  // both-spaces conflict check refuses with a message naming the other holder.
  // Refusing and asking is right here: only the user knows whether that vault
  // is a stale copy (→ `--regenerate`) or a live vault whose links matter.
  const sourceRestData = readRestApiData(sourceVault);
  const inheritedFromSource = Boolean(
    preExistingRestData && sourceRestData && !samePath(sourceVault, abs) &&
    sourceRestData.apiKey && sourceRestData.apiKey === preExistingRestData.apiKey,
  );

  if (preExistingRestData && !inheritedFromSource) {
    // Check the adopted port against BOTH spaces of every other vault, not
    // just the HTTPS column — the old check compared against
    // `Object.values(portRegistry)` and so never saw a plaintext listener.
    const claimants = buildPortIndex(cfg, { onDisk: onDiskPorts, exclude: abs });
    const wantedPorts = [preExistingRestData.port, preExistingRestData.insecurePort]
      .filter((p) => Number.isInteger(p) && p > 0);
    for (const wanted of wantedPorts) {
      const holders = claimants.get(wanted);
      if (!holders || holders.length === 0) continue;
      const who = holders
        .map((h) => `${h.vaultPath} (${h.role === 'https' ? 'HTTPS' : 'plaintext'}, per ${h.source})`)
        .join(', ');
      fail(
        `Vault has existing port ${wanted} but that port is already claimed by ${who}.\n` +
        `  Free the port on the other side, or pass --regenerate to assign a fresh port pair + key.\n` +
        `  NOTE: --regenerate also moves this vault's plaintext insecurePort` +
        (Number.isInteger(preExistingRestData.insecurePort) ? ` (currently ${preExistingRestData.insecurePort})` : '') +
        `, which BREAKS every click-to-open link already written to it. Only use it on a vault whose links do not matter yet.`
      );
    }
    port = preExistingRestData.port;
    insecurePort = Number.isInteger(preExistingRestData.insecurePort) && preExistingRestData.insecurePort > 0
      ? preExistingRestData.insecurePort
      : null;
    apiKey = preExistingRestData.apiKey;
    adopted = true;
    // The key itself is never echoed — not even a prefix. Eight characters
    // identify the key well enough to correlate it across a transcript, and
    // this file's own contract says credentials do not travel.
    info(`Adopted existing REST API config (port=${port}, insecurePort=${insecurePort ?? 'to be assigned'}, existing apiKey kept)`);
    info('Use --regenerate to overwrite with fresh credentials.');
  } else {
    if (inheritedFromSource) {
      warn(
        `Target carries the source vault's REST credentials (port ${preExistingRestData.port}) — ` +
        `a copy of ${sourceVault}, not an independent vault.`,
      );
      info('Renumbering to a fresh port pair + key rather than inheriting them.');
    }
    // Never let a copy keep the source's ports: drop the target's inherited
    // values out of the picture before allocating, or the allocator would
    // "reuse" them as if the vault legitimately owned them.
    // `forceFresh` as well as dropping the disk entry: a copy that is ALREADY
    // registered carries the source's pair in `portRegistry` too, and the
    // registry alone was enough to send the allocator down its "reuse the
    // existing pair" branch — handing the copy exactly the ports it was
    // supposed to be renumbered off (pre-release review, 2026-08-30).
    const allocationDisk = new Map(onDiskPorts);
    if (inheritedFromSource) allocationDisk.delete(abs);
    const pair = allocatePortsFor(cfg, abs, {
      onDisk: allocationDisk,
      forceFresh: inheritedFromSource,
    });
    port = pair.https;
    insecurePort = pair.http;
    apiKey = generateApiKey();
  }
  // A vault adopted with a valid port + key but NO `insecurePort` (the
  // pre-v0.10.x population) needs one created. Allocate it against both spaces
  // rather than letting `patchRestApiData` fall back to `port + 10` — writing
  // an unchecked plaintext port is the very defect this release closes, and it
  // would be embarrassing to reintroduce it here. Nothing is renumbered: this
  // only runs when there is no plaintext port to preserve.
  if (insecurePort === null) {
    insecurePort = allocateInsecurePortFor(cfg, abs, port, { onDisk: onDiskPorts });
    if (insecurePort !== port + DEFAULT_INSECURE_OFFSET) {
      info(`Plaintext port ${port + DEFAULT_INSECURE_OFFSET} is taken — assigning ${insecurePort} instead.`);
    }
  }
  // Always patch data.json so the values match (plugin clone may have overwritten with .template's port/key)
  const patched = patchRestApiData(abs, port, apiKey, insecurePort);
  // Record only what actually reached the disk. When data.json was missing,
  // nothing was written, and claiming a plaintext port in the registry (or in
  // the returned metadata that drives --probe and the click-to-open hint)
  // would describe a file that does not exist.
  insecurePort = patched.written ? patched.insecurePort : null;
  ensureCommunityPlugins(abs, pluginsToClone);

  // Clone Smart Connections config + embedding cache from the source vault.
  cloneSmartEnv(sourceVault, abs, opts.force);

  // --from-vault: copy the source's appearance.json BEFORE snippets,
  // so cloneSnippets merges snippet-enablement into the copied appearance.
  if (sourceKind === 'from-vault') copyVaultAppearance(sourceVault, abs, opts.force);

  // Lot 2 — every bootstrap path propagates the source's themes plus a
  // default appearance.json (fill-if-absent), so the shipped Blue Topaz
  // decision (skeleton) or the reference vault's current look reaches new
  // vaults. from-vault already force-copied appearance above; per-theme
  // skip keeps every path idempotent. The wizard's `--theme` choice is
  // applied LAST so it wins over whatever cssTheme the copied appearance
  // carries.
  cloneThemes(sourceVault, abs, opts.force);
  if (sourceKind !== 'from-vault') syncAppearanceDefaults(sourceVault, abs);
  if (wizard.theme) applyThemeChoice(abs, wizard.theme);

  // Clone Obsidian CSS snippets (no-task-strikethrough.css + any others)
  // and patch appearance.json to enable them.
  cloneSnippets(sourceVault, abs, opts.force);

  // Clone root-level docs (README.md, Documentation/, .claude) from the source.
  cloneRootDocs(sourceVault, abs, opts.force);

  // --from-vault: also copy the source's root CLAUDE.md (conventions) when
  // present — config-only, matching the spec. The reference `.template` keeps
  // its CLAUDE.md under Documentation/ (already covered by cloneRootDocs), so
  // this only fires for a from-vault source that keeps one at the root. Never
  // copies content, workspace.json, or credential data.json (those are handled
  // by the plugin clone loop, which regenerates the REST API port + key).
  if (sourceKind === 'from-vault') {
    const srcClaude = path.join(sourceVault, 'CLAUDE.md');
    const dstClaude = path.join(abs, 'CLAUDE.md');
    if (fs.existsSync(srcClaude) && (opts.force || !fs.existsSync(dstClaude))) {
      fs.copyFileSync(srcClaude, dstClaude);
      ok('Copied CLAUDE.md from source vault');
    }
    if (wizard.withFolderTree) {
      recreateWikiFolderTree(sourceVault, abs);
    }
  }

  // Wiki scaffolding (v0.12.7+) — creates wiki/, wiki/sessions/, and the
  // 4 wiki-meta scaffolds so workspace-bound mode works out of the box.
  // Idempotent: existing wiki-meta/*.md files are preserved, missing ones are
  // created. The legacy-layout refusal that protects this step lives earlier
  // (just after `mkdirSync(abs)`) so a legacy vault never gets here.
  // F2: the disk generators must stamp the SAME name the registry will resolve
  // this vault by, or the first REST contact rewrites wiki/index.md for a title
  // that only differs in case. The registry slug is the custom --name (lowered)
  // when it differs from the basename default, else defaultNameFromPath (which
  // lowercases) — exactly the resolution setupVault performs below for
  // vaultNames. path.basename(abs) alone would carry the on-disk case.
  const canonicalSlug = (wizard.name && wizard.name.toLowerCase() !== defaultNameFromPath(abs))
    ? wizard.name.toLowerCase()
    : defaultNameFromPath(abs);
  scaffoldWikiMeta(abs, {
    mode: wizard.wikiMode || undefined,
    sections: wizard.wikiSections,
    vaultName: canonicalSlug,
  });

  // Project config files
  writeEnvFile(abs, apiKey, port, opts.force);
  writeMcpJson(abs, opts.force);
  appendGitignore(abs);

  // --name: record a custom display slug in vaultNames when it differs from the
  // basename-derived default, so the router (and the workspace link below)
  // resolve this vault by the chosen name. Written BEFORE saveConfig + the link
  // block so both pick it up.
  if (wizard.name) {
    const customSlug = wizard.name.toLowerCase();
    if (customSlug !== defaultNameFromPath(abs)) {
      cfg.vaultNames = cfg.vaultNames || {};
      cfg.vaultNames[abs] = customSlug;
    }
  }

  // Persist port registry — BOTH ports. Recording only the HTTPS one is what
  // left the plaintext space invisible to the allocator.
  cfg.portRegistry[abs] = { https: port, http: insecurePort };
  saveConfig(cfg);

  // Optional workspace link (v0.12.7+) — when invoked with
  // `--link-workspace <ws-path>` as a flag of the main bootstrap subcommand,
  // bind the workspace to this newly-provisioned vault in one shot. Saves a
  // second permission prompt vs. having to re-invoke setup-vault.mjs
  // --link-workspace separately. Slug is derived from the vault path via the
  // same defaultNameFromPath() that the router itself uses, so the .env line
  // and the runtime resolution agree.
  let linkResult = null;
  if (opts.linkWorkspace) {
    // Honor a configured custom name for this vault path before falling back
    // to the basename-derived default. Otherwise an existing vault registered
    // with a custom name would get the basename written into the workspace
    // .env, and the workspace-bound hooks (which resolve the same way) would
    // never see it. (review+ pass 1 codex P2 #3)
    //
    // v0.90.0: through `vaultSlug`, so the value's TYPE is checked too. This
    // was the worst of the twelve silent sites — a non-string here was written
    // verbatim into a workspace `.env`, where every later session read it back
    // and resolved no vault at all.
    const slug = vaultSlug(cfg, abs);
    linkResult = linkWorkspaceToVault({
      workspacePath: path.resolve(opts.linkWorkspace),
      vaultPath: abs,
      vaultSlug: slug,
    });
  }

  // --claude-workspace: enable the router plugin in the bound workspace's
  // .claude/settings.json (needs a workspace to target).
  if (wizard.claudeWorkspace) {
    if (opts.linkWorkspace) writeClaudeWorkspaceSettings(path.resolve(opts.linkWorkspace));
    else warn('--claude-workspace needs a workspace: pass --link-workspace <path> to target one.');
  }

  console.log('');
  console.log(c('bold', c('green', '✓ Vault setup complete')));
  console.log(`  Path:        ${abs}`);
  console.log(`  Port:        ${port}`);
  console.log(`  API key:     ${apiKey.slice(0, 12)}…  ${c('gray', '(full value in .env)')}`);
  if (linkResult) {
    console.log(`  Linked WS:   ${path.resolve(opts.linkWorkspace)}  ${c('gray', `(slug=${linkResult.vaultSlug})`)}`);
  }
  console.log('');
  console.log(c('bold', 'Next steps:'));
  console.log(`  1. Open Obsidian → File → ${c('cyan', 'Open another vault')} → ${abs}`);
  console.log(`  2. Trust the vault when prompted`);
  console.log(`  3. Verify in Settings → Local REST API: port = ${port}, server enabled`);
  console.log(`  4. Verify in Settings → Community plugins: MCP Router Bridge is enabled`);
  console.log(`  5. Restart Claude Code in this project to load the new MCP server`);
  console.log('');

  // Return provisioning metadata so the CLI dispatch can drive the optional
  // tail (--open / --probe / --git-init). Callers that ignore the return value
  // (the pre-wizard code path) are unaffected. insecurePort is the port the
  // allocator actually reserved and patchRestApiData actually wrote — no
  // longer re-derived here as `port + 10`, which would have lied for any vault
  // that escapes the offset.
  return {
    abs,
    port,
    insecurePort,
    slug: vaultSlug(cfg, abs),
    obsidianName: path.basename(abs),
  };
}

function syncPluginsMode(vaultPath, opts = {}) {
  // When called from --sync-all (opts.throwOnError = true), errors throw
  // instead of process.exit so a single failing vault doesn't tear down
  // the whole loop. Direct CLI invocation keeps the legacy exit behavior
  // so users see a non-zero exit code on failure.
  const failOrThrow = (msg) => {
    if (opts.throwOnError) throw new Error(msg);
    fail(msg);
  };

  // The quiet-hook path exits early via process.exit(0) in several places —
  // combined with a source override that would silently kill a fleet loop
  // and skip its temp-dir cleanup. No current caller combines them; refuse
  // the combination outright so a future one fails loudly (review+ finding).
  if (opts.quiet && opts.sourceVault) {
    failOrThrow('quiet mode is not supported with a source override');
  }

  // Lot 3: the sync SOURCE can be overridden — `--sync-from-github` extracts
  // the GitHub skeleton into a temp dir and syncs FROM it, so machines with
  // no dev repo and no local .template get the exact same guarded pipeline.
  // Default stays the configured reference vault.
  const sourceVault = opts.sourceVault ?? referenceVaultPath(loadConfig());
  const sourceLabel = opts.sourceLabel ?? '.template';
  if (!sourceVault || !fs.existsSync(sourceVault)) {
    if (opts.quiet) process.exit(0);
    failOrThrow(`Sync source not found: ${sourceVault || '(no reference vault configured)'}`);
  }

  const abs = path.resolve(vaultPath);

  // Refuse to sync the source vault onto itself. With --force this is
  // a data-loss bug (the loop below would rm -rf each plugin dir in the
  // source before copying from the same path, leaving the source empty).
  // Without --force it's a silent no-op. Either way, surface clearly so
  // a script-aware caller (--sync-all or the meta-sync-template skill)
  // can adjust, but don't crash a --quiet hook run.
  if (samePath(abs, sourceVault)) {
    if (opts.quiet) process.exit(0);
    failOrThrow(
      `Refusing to sync the reference vault onto itself: ${abs}\n` +
      `   (it is the source — sync targets must be other vaults).`,
    );
  }

  const targetObsidian = path.join(abs, '.obsidian');
  if (!fs.existsSync(targetObsidian)) {
    // Not an Obsidian vault — silent in quiet mode (hook will hit non-vault projects)
    if (opts.quiet) process.exit(0);
    failOrThrow(`Not an Obsidian vault (no .obsidian/): ${abs}`);
  }

  const refPluginsDir = path.join(sourceVault, '.obsidian', 'plugins');
  if (!fs.existsSync(refPluginsDir)) {
    if (opts.quiet) process.exit(0);
    failOrThrow(`Sync source has no plugins dir: ${refPluginsDir}`);
  }

  const tgtPluginsDir = path.join(targetObsidian, 'plugins');
  fs.mkdirSync(tgtPluginsDir, { recursive: true });

  const refPlugins = fs.readdirSync(refPluginsDir).filter((p) => {
    try { return fs.statSync(path.join(refPluginsDir, p)).isDirectory(); }
    catch { return false; }
  });

  // Network-sourced skeleton (--sync-from-github): the archive is NOT a
  // trusted plugin store. Only plugins that the skeleton's own curated
  // community-plugins.json (∪ REQUIRED_PLUGINS) declares are eligible, and
  // only under strictly normalized names with a matching manifest id — a
  // dir like `Obsidian-Local-REST-API` or one with a trailing space exists
  // to dodge the credential guard on a case-insensitive filesystem
  // (review finding). Local sources (.template) are untouched by this.
  let vettedPlugins = refPlugins;
  const rejectedByVetting = [];
  if (opts.networkSource) {
    let enabled = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(sourceVault, '.obsidian', 'community-plugins.json'), 'utf8'));
      if (Array.isArray(parsed)) enabled = parsed.filter((x) => typeof x === 'string');
    } catch { enabled = []; }
    // The archive's own enabled list only SELECTS among the pinned
    // allowlist — it can never enlarge it (circular-trust review finding).
    const allow = new Set(
      [...REQUIRED_PLUGINS, ...enabled].filter((x) => NETWORK_PLUGIN_ALLOWLIST.has(x)),
    );
    vettedPlugins = [];
    for (const p of refPlugins) {
      // The skeleton legitimately ships two kinds of dirs: full vendored
      // plugins (manifest + main.js — BRAT, the bridge once downloaded) and
      // CONFIG PRE-SEEDS (a lone non-secret data.json; the code comes from
      // the marketplace/BRAT — Lot 2 curation). So: a manifest must match
      // the folder name; no manifest is fine ONLY without executable code
      // (Obsidian won't load a manifest-less dir anyway — belt and braces).
      const hasMain = fs.existsSync(path.join(refPluginsDir, p, 'main.js'));
      let manifestOk;
      try {
        manifestOk = JSON.parse(fs.readFileSync(path.join(refPluginsDir, p, 'manifest.json'), 'utf8')).id === p;
      } catch { manifestOk = !hasMain; }
      if (/^[a-z0-9][a-z0-9._-]*$/.test(p) && manifestOk && allow.has(p)) vettedPlugins.push(p);
      else rejectedByVetting.push(p);
    }
  }

  const newlySynced = [];
  const refreshed = [];
  // Plugins whose installed version in the target is NEWER than the
  // reference's copy (BRAT auto-update) — kept as-is, see the Lot 2
  // anti-downgrade guard in the loop.
  const keptNewer = [];
  // Plugins we refused to copy for safety reasons — currently
  // CREDENTIAL_LEAK_PLUGINS into a target that's missing the credential
  // file. Surfaced at the end of the loop with a clear "bootstrap
  // first" message. See CREDENTIAL_LEAK_PLUGINS doc-block at the top
  // of this file for the full reasoning.
  const deferredForSafety = [];

  for (const p of vettedPlugins) {
    const srcPlugin = path.join(refPluginsDir, p);
    const dstPlugin = path.join(tgtPluginsDir, p);
    const exists = fs.existsSync(dstPlugin);

    if (exists && !opts.force) continue;

    // Credentialed-plugin safety check. Refuse the copy whenever the
    // target lacks its own data.json — both the first-time-copy case
    // (folder absent) AND the --force refresh case where the folder
    // exists but data.json doesn't. Without this second check, --force
    // on a folder-present-but-data.json-missing target would copy the
    // reference's data.json wholesale (codex P1 — folder existed
    // because Obsidian had created it on plugin install but the user
    // never activated it, so no data.json was ever written).
    // Normalized lookup: `.has(p)` was an exact case-sensitive match while
    // Windows resolves paths case-insensitively — `Obsidian-Local-REST-API`
    // from a hostile source skipped the guard yet wrote into the real
    // plugin folder (review finding).
    if (CREDENTIAL_LEAK_PLUGINS.has(p.trim().toLowerCase())) {
      const tgtDataJson = path.join(dstPlugin, 'data.json');
      if (!fs.existsSync(tgtDataJson)) {
        deferredForSafety.push(p);
        continue;
      }
    }

    if (exists) {
      // A manifest-less source dir is a config PRE-SEED (lone data.json —
      // the Lot 2 curation pattern): it may seed a first install, never
      // replace a target that has a REAL installed plugin (manifest
      // present). Without this, --force replaced the bridge's code with a
      // bare data.json fleet-wide (review+ BLOCKER). A target that has no
      // manifest either is not an installed plugin — refresh stays allowed.
      if (!fs.existsSync(path.join(srcPlugin, 'manifest.json'))
        && fs.existsSync(path.join(dstPlugin, 'manifest.json'))) continue;
      // Lot 2 anti-downgrade: BRAT auto-updates GitHub plugins in user vaults,
      // so the target can be ahead of the reference — never replace a newer
      // installed version, even under --force.
      if (isTargetPluginNewer(srcPlugin, dstPlugin)) {
        keptNewer.push(p);
        continue;
      }
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
  if (!fs.existsSync(tgtSmartEnv) && fs.existsSync(path.join(sourceVault, '.smart-env'))) {
    cloneSmartEnv(sourceVault, abs, false);
    smartEnvAdded = true;
  }

  // Lot 2 — themes + appearance ride the same sync: per-theme skip unless
  // --force (target-only themes always preserved), appearance.json only when
  // the target has none (a user's theme choice is never clobbered).
  cloneThemes(sourceVault, abs, opts.force);
  syncAppearanceDefaults(sourceVault, abs);

  // Sync Obsidian CSS snippets (no-task-strikethrough.css + any future ones)
  // and patch appearance.json — idempotent, never blocks existing snippets.
  cloneSnippets(sourceVault, abs, opts.force);

  // Sync root docs (README.md) — preserve user customizations unless --force.
  // `.claude/` is EXCLUDED from network sources: its settings.json can carry
  // hooks (shell commands Claude Code runs automatically) — network bytes
  // must never land in an executable config while plugins get vetted and
  // this wouldn't (review+ finding: same threat model, two treatments).
  cloneRootDocs(sourceVault, abs, opts.force, opts.networkSource ? ['.claude'] : []);

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
      console.log(`[obsidian-mcp-router] Synced ${newlySynced.length} new plugin(s) from ${sourceLabel}: ${newlySynced.join(', ')}`);
    }
    if (deferredForSafety.length > 0) {
      // Even in --quiet (used by hooks), credential-leak avoidance
      // should not be silent — the user needs to know they have a vault
      // that still needs bootstrapping.
      console.log(
        `[obsidian-mcp-router] WARNING: ${abs}\n` +
        `  Skipped first-time copy of: ${deferredForSafety.join(', ')}\n` +
        `  Run \`node ${path.relative(process.cwd(), fileURLToPath(import.meta.url)) || 'setup-vault.mjs'} "${abs}"\`\n` +
        `  (without --sync-plugins) to bootstrap with a per-vault port + API key, then re-run sync.`,
      );
    }
    process.exit(0);
  }

  if (rejectedByVetting.length > 0) {
    warn(
      `Refused ${rejectedByVetting.length} plugin dir(s) from the network source (not in the skeleton's curated ` +
      `community-plugins.json, or failed name/manifest hygiene): ${rejectedByVetting.join(', ')}`,
    );
  }
  if (newlySynced.length > 0) ok(`Synced ${newlySynced.length} new plugin(s): ${newlySynced.join(', ')}`);
  if (refreshed.length > 0) ok(`Refreshed ${refreshed.length} plugin(s) (--force): ${refreshed.join(', ')}`);
  if (keptNewer.length > 0) info(`Kept ${keptNewer.length} plugin(s) at the target's NEWER version (BRAT-updated, never downgraded): ${keptNewer.join(', ')}`);
  if (smartEnvAdded) ok('Cloned .smart-env from reference vault');
  if (deferredForSafety.length > 0) {
    warn(
      `Refused first-time copy of credentialed plugin(s) into ${abs}:\n` +
      `      ${deferredForSafety.join(', ')}\n` +
      `   The reference vault's data.json (port + API key) would be cloned\n` +
      `   into this target, leaking credentials across vaults.\n` +
      `   Fix: bootstrap this vault with a per-vault port + API key first:\n` +
      `      node ${path.relative(process.cwd(), fileURLToPath(import.meta.url)) || 'setup-vault.mjs'} "${abs}"\n` +
      `   Then re-run --sync-plugins to pick up the remaining plugins.`,
    );
  }
  if (newlySynced.length === 0 && refreshed.length === 0 && !smartEnvAdded && deferredForSafety.length === 0) {
    info(`Already up to date with ${sourceLabel}.`);
  }
}

// ---------- Hook installation helpers ------------------------------------
//
// Wires the router's hooks (from hooks/hooks.example.json) into the user's
// `~/.claude/settings.json` so they actually fire. Without this, the hooks
// ship on disk but stay dormant — the user has to edit settings.json
// manually, which is a UX cliff documented in v0.11.3 review trail.
//
// Design:
//   - Idempotent: re-run = no-op. Detection by hook script basename (e.g.
//     `vault-link-linter.mjs`). If the user's settings already contain a
//     command pointing at that basename ANYWHERE in any event, skip it.
//   - Preserves user-defined hooks: the merge only adds, never reorders
//     or removes non-router entries. Uninstall removes ONLY commands
//     whose path contains `obsidian-mcp-router/hooks/` (or backslash
//     variant on Windows).
//   - Auto-detects this router's absolute path via `import.meta.url`.
//     Forward slashes in JSON for Windows compat (escape-free).
//   - `--select <names>` (comma-separated basenames without .mjs) lets
//     the user pick a subset. Default = all hooks in the example file.
//   - Layout note: appends new matcher blocks alongside existing ones
//     rather than merging into them. Claude Code unions all blocks under
//     the same event name at runtime, so this is functionally equivalent
//     and avoids the complexity of regex-matching the matcher strings.

const ROUTER_HOOKS_PATH_FRAGMENT = 'obsidian-mcp-router/hooks/';
const ROUTER_HOOKS_PATH_FRAGMENT_WIN = 'obsidian-mcp-router\\hooks\\';

/**
 * Basenames of the hook scripts this router ships. Read once, lazily.
 * Same in every copy of the router, which is what makes it a usable
 * identity test regardless of where the copy lives.
 */
let _routerHookBasenames = null;
function routerHookBasenames() {
  if (_routerHookBasenames) return _routerHookBasenames;
  try {
    _routerHookBasenames = new Set(
      fs.readdirSync(path.join(REPO_ROOT, 'hooks')).filter((f) => f.endsWith('.mjs')),
    );
  } catch {
    _routerHookBasenames = new Set();
  }
  return _routerHookBasenames;
}

/**
 * Is this settings.json `command` string one of OUR hooks?
 *
 * The original test was a substring match on `obsidian-mcp-router/hooks/`,
 * which only ever matched a checkout whose directory happens to be named
 * `obsidian-mcp-router`. A marketplace install lives at
 * `…/.claude/plugins/cache/obsidian-mcp-router-marketplace/obsidian-router/<version>/hooks/…`
 * — marketplace and plugin are SEPARATE path segments, so the fragment is
 * absent and every plugin user was invisible to `--hooks-status`,
 * `--uninstall-hooks` and the matcher refresh. `--install-hooks` then
 * re-added hooks it could not see, duplicating them.
 *
 * Identity is now "a hook script we ship, sitting in a hooks/ directory",
 * which holds for a dev checkout, a plugin cache, an npm global install and
 * a .mcpb bundle alike. The legacy fragment stays accepted so a hook we no
 * longer ship is still recognised for removal.
 */
function isRouterHookCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return false;
  if (cmd.includes(ROUTER_HOOKS_PATH_FRAGMENT) || cmd.includes(ROUTER_HOOKS_PATH_FRAGMENT_WIN)) return true;
  const bn = commandBasename(cmd);
  if (!bn || !routerHookBasenames().has(bn)) return false;
  const normalized = cmd.replace(/["']/g, '').replace(/\\/g, '/');
  return normalized.includes('/hooks/');
}

function userSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function loadUserSettings() {
  const p = userSettingsPath();
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveUserSettings(settings) {
  const p = userSettingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Load hooks/hooks.example.json and replace the `<router-repo>`
 * placeholder with this router's absolute path (forward slashes for
 * Windows-compatible JSON without escape gymnastics).
 */
function loadHooksExample() {
  const examplePath = path.join(REPO_ROOT, 'hooks', 'hooks.example.json');
  const raw = fs.readFileSync(examplePath, 'utf8');
  const repoPath = REPO_ROOT.replace(/\\/g, '/');
  return JSON.parse(raw.replace(/<router-repo>/g, repoPath));
}

/**
 * Return basename (e.g. `vault-link-linter.mjs`) from a hook command
 * string like `node "/path/to/.../hooks/vault-link-linter.mjs"`.
 * Robust to quoted/unquoted, forward/backward slashes.
 */
function commandBasename(cmd) {
  if (typeof cmd !== 'string') return null;
  // Strip surrounding quotes if any
  const cleaned = cmd.replace(/["']/g, '');
  // Find last path separator and grab the rest
  const m = cleaned.match(/[\\/]([^\\/]+\.mjs)\b/);
  return m ? m[1] : null;
}

/**
 * Walk the settings.json structure and collect the basenames of every
 * router-hook command already installed.
 */
function activeRouterHookBasenames(settings) {
  const found = new Set();
  const hooks = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    const blocks = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const block of blocks) {
      const entries = Array.isArray(block.hooks) ? block.hooks : [];
      for (const entry of entries) {
        const cmd = entry.command || '';
        if (isRouterHookCommand(cmd)) {
          const bn = commandBasename(cmd);
          if (bn) found.add(bn);
        }
      }
    }
  }
  return found;
}

/**
 * Install hooks from `example` into `settings`, skipping any hook whose
 * basename is already present. Returns { added: string[], skipped: string[] }.
 * Pure (mutates settings, but doesn't touch disk).
 *
 * `opts.select` (optional): Set of basenames (with or without .mjs) to
 * restrict installation to. Default = all hooks in the example.
 */
function installHooksInto(settings, example, opts = {}) {
  const added = [];
  const skipped = [];
  // Hooks the plugin already runs by itself — wiring them here too would
  // double-fire them. Empty unless the caller passes the set explicitly,
  // so the pure function stays testable without touching $HOME.
  const pluginProvided = new Set(opts.pluginProvided || []);
  const skippedAsPluginProvided = [];
  const already = activeRouterHookBasenames(settings);

  // Normalize --select input: accept "vault-link-linter" or "vault-link-linter.mjs"
  let selectFilter = null;
  if (opts.select) {
    selectFilter = new Set();
    for (const name of opts.select) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      selectFilter.add(trimmed.endsWith('.mjs') ? trimmed : `${trimmed}.mjs`);
    }
  }

  settings.hooks = settings.hooks || {};

  for (const event of Object.keys(example.hooks || {})) {
    settings.hooks[event] = settings.hooks[event] || [];
    const exampleBlocks = Array.isArray(example.hooks[event]) ? example.hooks[event] : [];

    for (const exampleBlock of exampleBlocks) {
      const matcher = exampleBlock.matcher;
      const exampleHooksList = Array.isArray(exampleBlock.hooks) ? exampleBlock.hooks : [];

      // Filter to hooks not already installed (idempotency) AND in --select if set.
      const toAdd = exampleHooksList.filter((entry) => {
        const bn = commandBasename(entry.command);
        if (!bn) return false;
        if (pluginProvided.has(bn) && !already.has(bn)) {
          skippedAsPluginProvided.push(bn);
          return false;
        }
        if (selectFilter && !selectFilter.has(bn)) {
          // Selected-out: count as skipped only if not already installed,
          // otherwise it's just a no-op (which is fine).
          if (!already.has(bn)) skipped.push(bn);
          return false;
        }
        if (already.has(bn)) {
          skipped.push(bn);
          return false;
        }
        return true;
      });

      if (toAdd.length === 0) continue;

      // Append a new block (intentional — see "Layout note" in the header
      // doc above). Includes ALL the original example block's hooks even
      // if some were filtered out for idempotency, because Claude Code
      // would run the same hook twice if we add a partial duplicate. So
      // we only add a block when there's at least one NEW hook for it,
      // and we add ONLY the new ones (not the already-present siblings).
      settings.hooks[event].push({
        matcher: matcher === undefined ? '' : matcher,
        hooks: toAdd,
      });

      for (const entry of toAdd) {
        const bn = commandBasename(entry.command);
        if (bn) added.push(bn);
      }
    }
  }

  return { added, skipped, pluginProvided: [...new Set(skippedAsPluginProvided)] };
}

/**
 * Basenames of the hooks the PLUGIN activates on its own (hooks/hooks.json).
 *
 * Those hooks need no settings.json entry — Claude Code runs them for every
 * user who installs the plugin. Wiring them a second time here would make
 * them fire TWICE per event. Returns [] when the manifest is absent or
 * unreadable (a dev checkout that predates Lot 5, an npm install, …).
 */
function pluginProvidedHookBasenames(pluginRoot = REPO_ROOT) {
  try {
    const raw = fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8');
    const manifest = JSON.parse(raw);
    const found = new Set();
    for (const event of Object.keys(manifest.hooks || {})) {
      for (const block of manifest.hooks[event] || []) {
        for (const entry of block.hooks || []) {
          const bn = commandBasename(entry.command);
          if (bn) found.add(bn);
        }
      }
    }
    return [...found];
  } catch {
    return [];
  }
}

/**
 * Absolute path of the INSTALLED obsidian-router plugin, or null.
 *
 * Reads the `installPath` that `installed_plugins.json` records, handling
 * the v1 (object) and v2 (array of scoped entries) shapes. Returns null
 * unless the directory actually exists.
 */
function installedRouterPluginPath({ homedir = os.homedir() } = {}) {
  try {
    const p = path.join(homedir, '.claude', 'plugins', 'installed_plugins.json');
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const plugins = json.plugins || {};
    const key = Object.keys(plugins).find((k) => k === ROUTER_PLUGIN_KEY || k.startsWith('obsidian-router@'));
    if (!key) return null;
    const entry = plugins[key];
    for (const candidate of Array.isArray(entry) ? entry : [entry]) {
      const dir = candidate && candidate.installPath;
      if (typeof dir === 'string' && dir && fs.existsSync(dir)) return dir;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when the obsidian-router plugin is installed AND not explicitly
 * disabled — i.e. when Claude Code will actually run what it declares.
 *
 * Deliberately conservative: any doubt (file missing, unparseable, no
 * matching key, `enabledPlugins[key] === false`) reports false, so
 * `--install-hooks` keeps its pre-Lot-5 behaviour of wiring everything
 * rather than silently skipping hooks the user expected to get.
 */
function isRouterPluginInstalled({ homedir = os.homedir() } = {}) {
  if (!installedRouterPluginPath({ homedir })) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(homedir, '.claude', 'settings.json'), 'utf8'));
    const enabled = settings.enabledPlugins || {};
    for (const [k, v] of Object.entries(enabled)) {
      if ((k === ROUTER_PLUGIN_KEY || k.startsWith('obsidian-router@')) && v === false) return false;
    }
  } catch { /* no settings.json, or unreadable — absence means enabled */ }
  return true;
}

/**
 * The hooks the installed plugin is really running right now.
 *
 * The two halves MUST come from the same copy of the plugin. Deriving the
 * manifest from this checkout while deriving "is it installed?" from
 * `installed_plugins.json` credits the installed plugin with hooks it does
 * not ship: on the normal upgrade path the cached plugin lags the checkout,
 * so a 0.55.1 plugin (no hooks.json at all) would be credited with the
 * 0.56.0 manifest — `--install-hooks` would skip wiring both hooks, nothing
 * would run them, and `--hooks-status` would report a double-wiring that
 * does not exist and prescribe a "fix" that deletes them for good.
 */
function activePluginProvidedHooks({ homedir = os.homedir() } = {}) {
  if (!isRouterPluginInstalled({ homedir })) return [];
  const pluginRoot = installedRouterPluginPath({ homedir });
  if (!pluginRoot) return [];
  return pluginProvidedHookBasenames(pluginRoot);
}

/**
 * Refresh the matcher string of blocks that hold ONLY router hooks.
 *
 * `installHooksInto` is idempotent by hook-script basename and never
 * revisits a block it has already written (see the "Layout note" above).
 * That is fine while matchers are stable, and a trap when they change: a
 * user who ran `--install-hooks` before Lot 5 carries a frozen matcher
 * enumerating `mcp__obsidian-router__*` literally, which no longer matches
 * the plugin-provided tool names (`mcp__plugin_obsidian-router_router__*`).
 * The hooks then stop firing — silently, because a hook with nothing to do
 * looks exactly like a hook that never ran.
 *
 * Only blocks whose every entry is a router hook are touched, so a matcher
 * a user shares with their own hooks is never rewritten.
 * Returns { updated: string[] }. Pure.
 */
function refreshRouterMatchers(settings, example) {
  const updated = [];

  // event::basename -> matcher the example wants for it
  const desired = new Map();
  for (const event of Object.keys(example.hooks || {})) {
    for (const block of example.hooks[event] || []) {
      for (const entry of block.hooks || []) {
        const bn = commandBasename(entry.command);
        if (bn) desired.set(`${event}::${bn}`, block.matcher === undefined ? '' : block.matcher);
      }
    }
  }

  const hooks = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    for (const block of Array.isArray(hooks[event]) ? hooks[event] : []) {
      const entries = Array.isArray(block.hooks) ? block.hooks : [];
      if (entries.length === 0) continue;

      const basenames = [];
      let allRouter = true;
      for (const entry of entries) {
        const cmd = entry.command || '';
        if (!isRouterHookCommand(cmd)) {
          allRouter = false;
          break;
        }
        const bn = commandBasename(cmd);
        if (bn) basenames.push(bn);
      }
      if (!allRouter || basenames.length === 0) continue;

      const wanted = desired.get(`${event}::${basenames[0]}`);
      if (wanted === undefined) continue;
      // Every hook in the block must want the same matcher, otherwise we
      // cannot rewrite it without changing another hook's gate.
      if (!basenames.every((bn) => desired.get(`${event}::${bn}`) === wanted)) continue;

      const current = block.matcher === undefined ? '' : block.matcher;
      if (current === wanted) continue;
      block.matcher = wanted;
      updated.push(...basenames);
    }
  }

  return { updated };
}

/**
 * Remove all router hooks from `settings`. Preserves user-defined hooks.
 * Returns { removed: string[] }. Pure.
 */
function uninstallHooksFrom(settings) {
  const removed = [];
  const hooks = settings.hooks || {};

  for (const event of Object.keys(hooks)) {
    const blocks = Array.isArray(hooks[event]) ? hooks[event] : [];
    const filteredBlocks = [];

    for (const block of blocks) {
      const entries = Array.isArray(block.hooks) ? block.hooks : [];
      const filteredEntries = entries.filter((entry) => {
        const cmd = entry.command || '';
        const isRouter = isRouterHookCommand(cmd);
        if (isRouter) {
          const bn = commandBasename(cmd);
          if (bn) removed.push(bn);
        }
        return !isRouter;
      });

      if (filteredEntries.length > 0) {
        filteredBlocks.push({ ...block, hooks: filteredEntries });
      }
      // Else: drop the whole block (no user-defined hooks left in it).
    }

    if (filteredBlocks.length > 0) {
      hooks[event] = filteredBlocks;
    } else {
      delete hooks[event];
    }
  }

  if (Object.keys(hooks).length === 0) delete settings.hooks;

  return { removed };
}

/**
 * Report which hooks from `example` are active in `settings`.
 * Returns [{ basename, status: 'active'|'inactive'|'plugin' }].
 *
 * `plugin` means the hook runs because the installed plugin declares it in
 * hooks/hooks.json — it is active WITHOUT any settings.json entry, and
 * wiring it here would double-fire it. Reported distinctly so `--hooks-status`
 * never invites the user to "activate" something already running.
 */
function reportHooksStatus(settings, example, opts = {}) {
  const active = activeRouterHookBasenames(settings);
  const fromPlugin = new Set(opts.pluginProvided || []);
  const knownBasenames = new Set();
  for (const event of Object.keys(example.hooks || {})) {
    for (const block of example.hooks[event] || []) {
      for (const entry of block.hooks || []) {
        const bn = commandBasename(entry.command);
        if (bn) knownBasenames.add(bn);
      }
    }
  }
  const rows = [...knownBasenames].sort().map((bn) => ({
    basename: bn,
    // settings.json wins the label: if a hook is BOTH wired by hand and
    // provided by the plugin, it really is firing twice and the user needs
    // to see it as wired so `--uninstall-hooks` is the obvious next step.
    status: active.has(bn) ? 'active' : (fromPlugin.has(bn) ? 'plugin' : 'inactive'),
  }));
  return rows;
}

// Exported for test-time access (the file is a CLI but we also want to
// unit-test the pure helpers). Tests `import * as setup from
// './setup-vault.mjs'` — but importing this CLI file as a module would
// execute the top-level CLI dispatch. Instead, tests spawn it as a
// subprocess (see tests/install-hooks.test.mjs) — these exports stay
// in the module namespace for future intra-module use.
// ---------------------------------------------------------------------------
// C3 sealed preview for the CLI two-phase flows (migrations + sync-from-github).
// Same contract as the MCP tools (src/helpers/plan-seal.mjs): a --dry-run emits
// an approvedPlanSha256 over a canonical, vault-bound plan core; the apply
// accepts --approved-plan-sha256 and refuses — before any filesystem or network
// mutation — if the freshly re-derived plan drifted since the preview. Opt-in:
// an apply without the flag behaves exactly as before.
// ---------------------------------------------------------------------------

/**
 * Drift-sensitive core of a migration dry-run result (wiki-meta or sessions).
 * Both the preview and the pre-apply re-derivation are DRY-RUN results, so an
 * unchanged vault yields an identical core. Captures WHAT would move (scaffold
 * names / session files, sorted), the transport mode (git vs fs — a repo that
 * gained/lost `.git` between preview and apply is a real change), the detected
 * state/status, and the CLAUDE.md rewrite count.
 */
export function migrationPlanCore(op, result) {
  const r = result || {};
  return {
    op,
    state: r.state ?? null,
    status: r.status ?? null,
    mode: r.mode ?? null,
    // Sessions: the rename-vs-merge strategy (a dst directory appearing since
    // the preview flips one into the other — same moved-set, different executed
    // behaviour) and the conflict set left behind, both sealed (Fable 5 review).
    strategy: r.strategy ?? null,
    scaffolds: Array.isArray(r.scaffoldsMoved)
      ? r.scaffoldsMoved.map((s) => String(s.scaffold)).sort()
      : [],
    sessions: Array.isArray(r.sessionsMoved)
      ? r.sessionsMoved.map((s) => String(typeof s === 'string' ? s : s.file)).sort()
      : [],
    sessionsSkipped: Array.isArray(r.sessionsSkipped)
      ? r.sessionsSkipped.map((s) => String(typeof s === 'string' ? s : s.file)).sort()
      : [],
    // Rename case: every entry moved (not just .md). Merge case: null (the
    // .md-level moved/skipped sets fully describe it).
    sessionsAllEntries: Array.isArray(r.sessionsAllEntries) ? [...r.sessionsAllEntries].map(String).sort() : null,
    claudeMdReplacements: r.claudeMdReplacements ?? null,
    // Exact matched scaffold refs per CLAUDE.md candidate (dry-run only).
    claudeMdMatches: Array.isArray(r.claudeMdMatches)
      ? r.claudeMdMatches
          .map((m) => ({ relPath: String(m.relPath), matches: Array.isArray(m.matches) ? [...m.matches].map(String).sort() : [] }))
          .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
      : null,
  };
}

/**
 * Drift-sensitive core of a `--sync-from-github` plan. Binds the ARCHIVE
 * identity (its SHA-256 — the key signal: a moving ref like `main` can advance
 * between preview and apply), the repo/ref/force knobs, and the resolved
 * eligible-target set. It deliberately does NOT model per-plugin sync decisions
 * (those live inside the hardened, un-touched syncPluginsMode) — the seal
 * guarantees the apply runs against the SAME archive + vault set + force the
 * caller previewed, which is the outer drift that matters.
 */
export function syncPlanCore({ repo, ref, force, archiveSha256, targets }) {
  return {
    op: 'sync-from-github',
    repo: repo ?? null,
    ref: ref ?? null,
    force: Boolean(force),
    archiveSha256: archiveSha256 ?? null,
    targets: Array.isArray(targets) ? [...targets].map(String).sort() : [],
  };
}

/**
 * Parse `--approved-plan-sha256 <hash>` from argv. Returns the validated seal or
 * null when absent. Fails loudly (before any work) on a missing/flag-like value
 * or a malformed hash, so a typo never silently degrades to "no seal".
 */
function readApprovedPlanSeal(argv) {
  const i = argv.indexOf('--approved-plan-sha256');
  if (i === -1) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('-')) {
    fail('--approved-plan-sha256 requires a value (the 64-hex seal a --dry-run printed).');
  }
  if (!isPlanSeal(value)) {
    fail('Invalid --approved-plan-sha256: expected a 64-char lowercase hex plan seal (the value a --dry-run printed).');
  }
  return value;
}

/** Print the seal after a dry-run, with the exact command to apply it. */
function printPlanSeal(seal, applyHint) {
  console.log('');
  console.log(c('bold', `approvedPlanSha256: ${seal}`));
  info(applyHint);
}

/**
 * Verify a caller-provided seal against the current plan. On drift, `fail()`
 * (exit 1) BEFORE any mutation with an actionable message. Any other error type
 * propagates unchanged.
 */
function verifyPlanSealOrFail({ op, identity, plan, provided, previewHint }) {
  try {
    verifyPlanSeal({ op, identity, plan, approvedPlanSha256: provided, previewHint });
  } catch (e) {
    if (e instanceof PlanDriftError) {
      fail(`Sealed-preview drift — nothing was changed.\n   ${e.message}`);
    }
    throw e;
  }
}

export {
  loadHooksExample,
  commandBasename,
  activeRouterHookBasenames,
  installHooksInto,
  uninstallHooksFrom,
  reportHooksStatus,
  pluginProvidedHookBasenames,
  isRouterPluginInstalled,
  installedRouterPluginPath,
  activePluginProvidedHooks,
  isRouterHookCommand,
  refreshRouterMatchers,
};

// ---------- CLI ----------
/**
 * Auto-wire ALL router hooks into ~/.claude/settings.json at the END of a
 * successful main bootstrap (v0.18.2). Closes the failure mode behind the
 * recurring cwd+vault phantom-link bug: the deterministic guards
 * (wiki-query-first-nudge, vault-link-linter, …) ship on disk but catch
 * NOTHING until wired — and on a fresh machine / new setup they were left
 * dormant because wiring was a manual, skippable step.
 *
 * Default-on. Opt out with the `--no-hooks` flag or the
 * `OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS` env var (truthy). Idempotent
 * (installHooksInto skips already-present hooks → no write, no churn on
 * re-bootstrap). Best-effort: a missing hooks.example.json or an unwritable
 * settings.json WARNS but never aborts the bootstrap it tails — the vault is
 * already provisioned by the time we get here.
 *
 * Distinct from the standalone `--install-hooks` subcommand, which stays the
 * explicit path (with `--select` + the "nothing to do" report). A standalone
 * `--link-workspace` re-link is NOT covered here: it requires the vault to
 * already be in portRegistry (i.e. bootstrapped — and thus already wired by
 * this function on a post-v0.18.2 setup).
 */
function maybeAutoInstallHooks({ quiet = false, noHooks = false } = {}) {
  const TRUTHY = new Set(['true', '1', 'yes', 'on']);
  const envOptOut = TRUTHY.has(
    String(process.env.OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS || '').toLowerCase(),
  );
  if (noHooks || envOptOut) {
    if (!quiet) {
      info('Skipped hook wiring (--no-hooks / OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS).');
      console.log(c('gray', '   Run `node scripts/setup-vault.mjs --install-hooks` when ready.'));
    }
    return;
  }

  let example;
  try { example = loadHooksExample(); }
  catch (err) {
    warn(`Hooks not auto-wired: could not load hooks/hooks.example.json (${err.message}).\n   Run \`node scripts/setup-vault.mjs --install-hooks\` later.`);
    return;
  }

  const settings = loadUserSettings();
  // Same refresh as the explicit --install-hooks path: this is the branch
  // most users actually take (it runs at the tail of every bootstrap), so
  // leaving it out would make the matcher migration unreachable in practice.
  const refreshed = refreshRouterMatchers(settings, example);
  const result = installHooksInto(settings, example, {
    pluginProvided: activePluginProvidedHooks(),
  });

  if (result.added.length === 0 && refreshed.updated.length === 0) {
    if (!quiet) info('Router hooks already wired into settings.json — nothing to add.');
    return;
  }

  try { saveUserSettings(settings); }
  catch (err) {
    warn(`Hooks not auto-wired: could not write ${userSettingsPath()} (${err.message}).\n   Run \`node scripts/setup-vault.mjs --install-hooks\` later.`);
    return;
  }

  if (result.added.length > 0) ok(`Auto-wired ${result.added.length} router hook(s) into ${userSettingsPath()}.`);
  if (refreshed.updated.length > 0) {
    ok(`Refreshed the tool matcher of ${[...new Set(refreshed.updated)].length} already-wired hook(s) so they also match plugin-provided tool names.`);
  }
  if (!quiet) {
    console.log(c('gray', '   Deterministic guards now active next session (wiki-query-first-nudge, vault-link-linter, …).'));
    console.log(c('gray', '   Opt out next time with --no-hooks; manage with --hooks-status / --uninstall-hooks.'));
    info('Restart Claude Code to activate them.');
  }
}

// Human-readable rendering of a buildProvisionPlan() result (the `--dry-run`
// default output; `--json` prints the raw object instead). Read-only preview —
// the exact set of steps provision_vault / setupVault will perform.
function printPlanHuman(plan) {
  console.log('');
  console.log(c('bold', 'Proposed plan (dry-run — nothing written):'));
  console.log(`  Vault:        ${plan.name}  ${c('gray', `(slug: ${plan.slug})`)}`);
  console.log(`  Path:         ${plan.path}`);
  console.log(`  Source:       ${plan.source.kind}${plan.source.fromVault ? ` (${plan.source.fromVault})` : ''}`);
  console.log(`  Plugins:      ${plan.plugins.profile} (${plan.plugins.resolved.length}) — ${plan.plugins.resolved.join(', ')}`);
  console.log(`  Theme:        ${plan.theme ? plan.theme.name + (plan.theme.blocked ? c('yellow', ' [blocked: Lot 2]') : '') : c('gray', '(unchanged)')}`);
  console.log(`  Wiki mode:    ${plan.wikiMode.mode}${plan.wikiMode.sections && plan.wikiMode.sections.length ? ` [${plan.wikiMode.sections.join(', ')}]` : ''}`);
  console.log(`  Workspace CC: ${plan.claudeWorkspace ? 'yes' : 'no'}`);
  console.log(`  Tail:         ${plan.open ? 'open' : '—'}${plan.probe ? ' + probe' : ''}`);
  if (plan.warnings.length) {
    console.log('');
    console.log(c('yellow', '  Warnings:'));
    for (const w of plan.warnings) console.log(`    ${c('yellow', '⚠')} [${w.code}] ${w.message}`);
  }
  console.log('');
  console.log(c('bold', '  Steps:'));
  for (const s of plan.steps) console.log(`    ${c('gray', '·')} ${s}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// CLI dispatch — wrapped in cliMain() and guarded by an entrypoint check.
// Importing this module (tests import its exported helpers) used to RUN the
// dispatch: empty args printed the help and process.exit(0)'d DURING import,
// silently killing an entire test file while the runner counted the file as
// one green test (review+ pass 2 finding — setup-vault-themes.test.mjs was a
// false green since v0.52.0). samePath() absorbs Windows case/slash drift
// between import.meta.url and argv[1]. The body is intentionally NOT
// re-indented — the wrap is two insertions, keeping the diff reviewable.
const IS_CLI_ENTRYPOINT = (() => {
  try {
    return !!process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1]);
  } catch {
    return false;
  }
})();

async function cliMain() {

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage:
  node setup-vault.mjs <vault-path>                          Bootstrap a vault.
                                                              If vault already has a REST API port + apiKey
                                                              they are preserved (= adoption mode).
  node setup-vault.mjs <vault-path> --link-workspace <ws>    Bootstrap a vault AND bind workspace <ws> to it
                                                              in one shot (writes OBSIDIAN_ROUTER_DEFAULT_VAULT
                                                              in <ws>/.env). Single permission prompt vs. two
                                                              separate invocations. (v0.12.7+)
  node setup-vault.mjs <vault-path> --no-hooks               Bootstrap WITHOUT auto-wiring the router hooks
                                                              into ~/.claude/settings.json. Hooks are wired by
                                                              default since v0.18.2 (idempotent); use this, or
                                                              OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS=1, to skip.
  node setup-vault.mjs <vault-path> --regenerate             Force fresh port + apiKey even if existing
  node setup-vault.mjs <vault-path> --force                  Overwrite existing files (.env, .mcp.json, README, etc.)
  node setup-vault.mjs <vault-path> --sync-plugins           Sync new plugins from reference vault
  node setup-vault.mjs <vault-path> --sync-plugins --force   Re-clone all plugins, preserving data.json
  node setup-vault.mjs <vault-path> --sync-plugins --quiet   Silent unless something changed (for hooks)
  node setup-vault.mjs --sync-all                            Run --sync-plugins on every vault in portRegistry
  node setup-vault.mjs --sync-all --force                    Same, force-overwrite plugins + snippets
  node setup-vault.mjs --sync-from-github <vault…>|--all     Sync plugins/themes/snippets straight from the GitHub
      [--ref <branch|tag>] [--force] [--dry-run]              skeleton — no dev repo or local .template needed.
      [--repo <owner/name> --trust-repo]                      Same guards as --sync-plugins (credentials, anti-
      [--approved-plan-sha256 <hash>]                         downgrade) + hardened archive extraction + pinned
                                                              plugin allowlist. A non-default --repo requires the
                                                              explicit --trust-repo acknowledgement. C3: --dry-run
                                                              prints an approvedPlanSha256 sealing {archive, targets,
                                                              force}; pass it back on apply to refuse a drifted archive
                                                              (moved ref) or vault set before any sync.
  node setup-vault.mjs --bootstrap-reference <path>          Scaffold a fresh reference vault from the
                                                              shipped skeleton + download bridge plugin.
                                                              Follow up with --init-reference once you've
                                                              installed the marketplace plugins via Obsidian.
  node setup-vault.mjs --init-reference <path>               Register a vault as the reference template
  node setup-vault.mjs --status                              Show current configuration
  node setup-vault.mjs --install-hooks                       Merge ALL hooks from hooks.example.json into
                                                              ~/.claude/settings.json. Idempotent (re-run safe);
                                                              preserves user-defined non-router hooks.
  node setup-vault.mjs --install-hooks --select <a,b,c>      Install only the named hooks (basenames without .mjs)
  node setup-vault.mjs --uninstall-hooks                     Remove all router hooks from ~/.claude/settings.json
                                                              (preserves user-defined hooks)
  node setup-vault.mjs --hooks-status                        Report which router hooks are currently active
  node setup-vault.mjs --migrate-wiki-meta <vault-path>      Migrate ONE vault from wiki/<scaffold>.md to
                                                              wiki-meta/<scaffold>.md (v0.12.1+). Uses git mv
                                                              if .git/ exists, plain rename otherwise. Also
                                                              rewrites scaffold paths in vault's CLAUDE.md.
                                                              Idempotent. Add --dry-run to preview, --force to
                                                              re-rewrite CLAUDE.md on already-migrated vaults. C3:
                                                              --dry-run prints an approvedPlanSha256; pass it back via
                                                              --approved-plan-sha256 <hash> to apply exactly that plan
                                                              (refused if the vault drifted). Same on --migrate-
                                                              sessions-to-wiki-meta.
  node setup-vault.mjs --migrate-all-wiki-meta               Same migration, run on every vault in
                                                              portRegistry. Reports per-vault status; non-zero
                                                              exit if any vault fails.
  node setup-vault.mjs --migrate-sessions-to-wiki-meta <path> Migrate ONE vault from wiki/Sessions/ to
                                                              wiki-meta/Sessions/ (v0.12.8+, was wiki/Sessions/
                                                              in v0.12.4–v0.12.7). Uses git mv if .git/ exists.
                                                              If both dirs exist, merges per-file skipping
                                                              conflicts. Idempotent. Add --dry-run to preview.
  node setup-vault.mjs --migrate-all-sessions-to-wiki-meta   Same Sessions/ migration, run on every vault in
                                                              portRegistry. Reports per-vault status; non-zero
                                                              exit if any vault fails.
  node setup-vault.mjs --attach <slug> [--also <slug>]...    v0.65.0. Bind the CURRENT directory to vault(s)
                                                              that ALREADY exist in portRegistry. Does the four
                                                              workspace writes in one go: .env binding,
                                                              .claude/settings.json (enables the router plugin —
                                                              without it the .env is inert), a CLAUDE.md block
                                                              naming primary + secondaries, and .gitignore.
                                                              Nothing is provisioned. Idempotent.
                                                              Add --workspace <path> to target another directory,
                                                              or --no-plugin / --no-claude-md / --no-gitignore
                                                              to skip an individual write.
  node setup-vault.mjs --link-workspace <path> <vault-slug>  Lower-level: write ONLY the .env binding
      [--claude-workspace]                                    (OBSIDIAN_ROUTER_DEFAULT_VAULT=<slug>). Prefer
                                                              --attach unless you specifically want just this.
                                                              Pass --claude-workspace to also enable the plugin.
  node setup-vault.mjs --unlink-workspace <path>             Remove the OBSIDIAN_ROUTER_DEFAULT_VAULT line from
                                                              the workspace's .env (preserves other entries).
  node setup-vault.mjs --upgrade-insecure-server <vault>     v0.13.9. Patch insecurePort + enableInsecureServer
                                                              on a vault that was bootstrapped before those
                                                              defaults existed. Preserves apiKey + port + cert.
                                                              Idempotent. Add --dry-run to preview.
  node setup-vault.mjs --upgrade-insecure-server-all         Same patch, run on every vault in portRegistry.
                                                              Detects insecurePort collisions across vaults.
  node setup-vault.mjs --check-ports [--json]                v0.77.0. Report port collisions across the fleet
                                                              in BOTH spaces (HTTPS + plaintext insecurePort),
                                                              plus registry-vs-data.json drift. Read-only.
                                                              Exit 1 when a collision (severity error) is found.
  node setup-vault.mjs --sync-port-registry [--dry-run]      v0.77.0. Record each vault's plaintext insecurePort
                                                              in portRegistry, read from its own data.json.
                                                              Timestamped backup of config.json first; a vault
                                                              with no readable data.json is left "unknown",
                                                              never guessed as port+10.
  node setup-vault.mjs --discover-vaults                     v0.13.9. Scan well-known OS locations
                                                              (C:/VAULTS, ~/Documents/Obsidian, iCloud,
                                                              Google Drive desktop, etc.) and report each
                                                              vault with its registration status. Add
                                                              --scan-dir <path> to extend (repeatable).
                                                              Add --no-default-scan to scan ONLY --scan-dir
                                                              roots.
  node setup-vault.mjs --discover-vaults --bootstrap-all     Same scan + bootstrap every candidate vault
                                                              (not yet registered, has Local REST API plugin).
                                                              Add --dry-run to preview.
  node setup-vault.mjs --list-global-conventions             v0.13.9. List snippets shipped under
                                                              templates/global-claude-md-snippets/.
  node setup-vault.mjs --install-global-convention <name>    v0.13.9. Append a snippet to ~/.claude/CLAUDE.md
                                                              with idempotent HTML-comment markers (re-runs
                                                              are no-ops). Add --force to replace an existing
                                                              marker block. Currently shipped: obsidian-vault-links.

  Vault-creation wizard flags (v0.34.0) — additive; a plain bootstrap is unchanged:
  node setup-vault.mjs <vault-path> --dry-run [--json]        Print the full provisioning plan WITHOUT writing
                                                              anything. --json emits the machine-readable plan
                                                              (consumed by the meta-attach-vault skill + the
                                                              plan_vault MCP tool).
  ... --name "<Display Name>"                                Display name → slug; writes vaultNames when it
                                                              differs from the path basename.
  ... --from-vault <slug|path> [--with-folder-tree]          Clone config ONLY from an existing vault (plugins,
                                                              snippets, appearance, .smart-env, CLAUDE.md).
                                                              workspace.json + credential data.json excluded;
                                                              port + API key regenerated. --with-folder-tree
                                                              recreates its wiki/ folder tree EMPTY (no notes).
  ... --from-skeleton                                        Scaffold from the shipped skeleton + download the
                                                              bridge (delegates to --bootstrap-reference).
  ... --bare                                                 Minimal vault: the 2 REQUIRED plugins only.
  ... --plugins recommended|minimal|custom:a,b,c             Plugin profile (default recommended = source set).
  ... --wiki-mode personal|research|business|code|domain     Seed catalog.md/overview.md per mode. For 'domain',
      [--wiki-sections "A,B,C"]                              pass the sections explicitly (engine stays
                                                              deterministic; the frontend translates the domain).
  ... --claude-workspace                                     Enable the router plugin in the bound workspace's
                                                              .claude/settings.json (needs --link-workspace).
  ... --open                                                 Launch Obsidian on the new vault (obsidian://open).
  ... --probe [--probe-timeout N]                            Poll the REST port for a health verdict (non-zero
                                                              exit if red). Expected red until you Trust author.
  ... --git-init                                             git init + initial commit inside the new vault
                                                              (off by default — vaults often live on cloud drives).
  ... --theme "<name>"                                       (BLOCKED — lands with the Lot 2 theme chantier.)
`);
  process.exit(0);
}

if (args[0] === '--status') {
  printStatus();
  process.exit(0);
}

// v0.77.0 — read-only collision report over BOTH port spaces. The failure it
// makes legible is the one that used to present as a vault mysteriously
// "offline": two servers on one port, second one loses the bind, no message
// anywhere. Exits 1 on a real collision so a scheduled task can alert on it.
if (args[0] === '--check-ports') {
  const asJson = args.includes('--json');
  const cfg = loadConfigReadOnly();
  const findings = detectPortCollisions(cfg, { onDisk: buildOnDiskPortMap(cfg) });
  if (asJson) {
    console.log(JSON.stringify({
      configPath: CONFIG_PATH,
      vaults: registeredVaultPaths(cfg).length,
      summary: summarizePortCollisions(findings),
      findings,
    }, null, 2));
  } else if (findings.length === 0) {
    ok(`No port collisions across ${registeredVaultPaths(cfg).length} registered vault(s) — HTTPS and plaintext spaces both clean.`);
  } else {
    console.log(c('bold', c('red', `Port problems — ${summarizePortCollisions(findings)}:\n`)));
    for (const f of findings) {
      console.log((f.severity === 'error' ? c('red', '✗ ') : c('yellow', '! ')) + f.message + '\n');
    }
    info('Repair the registry side with:  node scripts/setup-vault.mjs --sync-port-registry');
  }
  process.exit(findings.some((f) => f.severity === 'error') ? 1 : 0);
}

// v0.77.0 — reconcile portRegistry with each vault's data.json, recording the
// plaintext port the registry never knew about. Never renumbers anything.
if (args[0] === '--sync-port-registry') {
  const dryRun = args.includes('--dry-run');
  const cfg = loadConfig();
  const result = migrateConfigPortRegistry(cfg, { dryRun });
  if (!result.changed) {
    ok('portRegistry is already in the two-port shape and matches every readable data.json — nothing to do.');
  }
  const after = dryRun ? { ...cfg, portRegistry: migratePortRegistry(cfg, { onDisk: buildOnDiskPortMap(cfg) }).portRegistry } : cfg;
  const findings = detectPortCollisions(after, { onDisk: buildOnDiskPortMap(cfg) });
  if (findings.length > 0) {
    console.log('');
    warn(`Reconciling the registry does not move any port. Still open — ${summarizePortCollisions(findings)}:`);
    for (const f of findings) {
      console.log((f.severity === 'error' ? c('red', '  ✗ ') : c('yellow', '  ! ')) + f.message);
    }
  }
  process.exit(0);
}

if (args[0] === '--install-hooks') {
  // Merge hooks/hooks.example.json into ~/.claude/settings.json. See the
  // "Hook installation helpers" doc-block above for design rationale.
  const selectIdx = args.indexOf('--select');
  let select = null;
  if (selectIdx !== -1) {
    const value = args[selectIdx + 1];
    if (!value || value.startsWith('--')) {
      fail('--select requires a comma-separated list of hook names (e.g. "vault-link-linter,doc-propagation-checker")');
    }
    select = value.split(',').map((s) => s.trim()).filter(Boolean);
  }

  let example;
  try { example = loadHooksExample(); }
  catch (err) { fail(`Could not load hooks/hooks.example.json: ${err.message}`); }

  const settings = loadUserSettings();

  // Bring already-wired blocks up to date BEFORE installing. A matcher
  // frozen by an earlier run can no longer match the plugin-provided tool
  // names, and installHooksInto would happily skip the hook as "already
  // present" while it silently never fires. See refreshRouterMatchers.
  const refreshed = refreshRouterMatchers(settings, example);

  // Hooks the plugin runs by itself are only skipped when the plugin is
  // actually installed for this user — otherwise nothing would wire them.
  const pluginProvided = activePluginProvidedHooks();
  const result = installHooksInto(settings, example, { select, pluginProvided });

  const changed = result.added.length > 0 || refreshed.updated.length > 0;
  if (changed) {
    try { saveUserSettings(settings); }
    catch (err) { fail(`Could not write ${userSettingsPath()}: ${err.message}`); }
  }

  if (result.added.length === 0) {
    info('All requested hooks are already installed. Nothing to do.');
    if (result.skipped.length > 0) {
      console.log(c('gray', `   (already-installed or de-selected: ${[...new Set(result.skipped)].join(', ')})`));
    }
  } else {
    ok(`Installed ${result.added.length} hook(s) into ${userSettingsPath()}:`);
    for (const bn of result.added) console.log(`    ${c('green', '+')} ${bn}`);
    if (result.skipped.length > 0) {
      const uniq = [...new Set(result.skipped)];
      console.log(c('gray', `   (already-installed or de-selected: ${uniq.join(', ')})`));
    }
  }

  if (refreshed.updated.length > 0) {
    console.log('');
    ok(`Refreshed the tool matcher of ${[...new Set(refreshed.updated)].length} already-wired hook(s):`);
    for (const bn of [...new Set(refreshed.updated)]) console.log(`    ${c('cyan', '~')} ${bn}`);
    console.log(c('gray', '   (they now also match the plugin-provided tool names, e.g. mcp__plugin_obsidian-router_router__write_file)'));
  }

  if (result.pluginProvided.length > 0) {
    console.log('');
    info(`Skipped ${result.pluginProvided.length} hook(s) already provided by the installed plugin:`);
    for (const bn of result.pluginProvided) console.log(`    ${c('gray', '·')} ${bn}`);
    console.log(c('gray', '   Wiring them here too would run them twice per event. They are already active.'));
  }

  if (changed) {
    console.log('');
    info('Restart Claude Code to pick up the changes.');
  }
  process.exit(0);
}

if (args[0] === '--uninstall-hooks') {
  const settings = loadUserSettings();
  const result = uninstallHooksFrom(settings);

  if (result.removed.length === 0) {
    info('No router hooks were installed. Nothing to do.');
    process.exit(0);
  }

  try { saveUserSettings(settings); }
  catch (err) { fail(`Could not write ${userSettingsPath()}: ${err.message}`); }

  ok(`Removed ${result.removed.length} router hook(s) from ${userSettingsPath()}:`);
  for (const bn of result.removed) console.log(`    ${c('red', '-')} ${bn}`);
  console.log('');
  info('Restart Claude Code so the removed hooks stop firing.');
  process.exit(0);
}

if (args[0] === '--link-workspace' || args[0] === '--unlink-workspace') {
  // Standalone subcommand — bind/unbind a workspace to a vault that's ALREADY
  // in portRegistry (i.e. was bootstrapped in a previous run). For the
  // one-shot "bootstrap + link in a single command" flow, pass `--link-workspace
  // <ws-path>` as a flag of the main `setup-vault.mjs <vault-path>` subcommand
  // instead (v0.12.7+).
  //
  // Activates the v0.11.6+ "workspace-bound" mode in `hot-cache-load.mjs`
  // (auto-loads the associated vault's hot.md) and `wiki-query-first-nudge.mjs`
  // (injects pre-answer wiki-investigation reminder citing the associated vault).
  //
  // Args: --link-workspace <workspace-path> <vault-slug>
  //       --unlink-workspace <workspace-path>
  //
  // Both upsertEnvVarSync / removeEnvVarSync and the link-workspace core logic
  // live at module scope (hoisted in v0.12.7) — see `linkWorkspaceToVault()`.
  const op = args[0];
  const wsArg = args[1];
  if (!wsArg) fail(`${op} requires a workspace path argument`);
  const wsPath = path.resolve(wsArg);
  if (!fs.existsSync(wsPath)) fail(`Workspace path does not exist: ${wsPath}`);
  if (!fs.statSync(wsPath).isDirectory()) fail(`Workspace path is not a directory: ${wsPath}`);
  const envPath = path.join(wsPath, '.env');

  if (op === '--unlink-workspace') {
    const removed = removeEnvVarSync(envPath, 'OBSIDIAN_ROUTER_DEFAULT_VAULT');
    // THE BINDING GOES TOO, and it is the half that decides. Removing only the
    // dotenv line left the workspace bound in the user's own config while this
    // command reported the link gone and told the user to restart so "the
    // hooks stop loading the previously-associated vault" — after a restart
    // the binding would load it again, and the advice would look like a bug in
    // the hooks. Found in the final review, 2026-09-03.
    //
    // The workspace is recorded as CONSIDERED at the same time, so the
    // one-time import does not read the leftover hint (if the user keeps the
    // line) and quietly re-create what they just removed.
    let bindingRemoved = false;
    let hadBinding = false;
    try {
      updateConfigBindings(CONFIG_PATH, (cfg) => {
        hadBinding = readBinding(cfg, wsPath) !== null;
        return withMigrationState(withoutBinding(cfg, wsPath), { cwd: wsPath, recordImported: true });
      });
      bindingRemoved = true;
    } catch (e) {
      // Symmetrical with `--link-workspace`: the binding is what decides, so
      // failing to remove it means the workspace is still attached and this
      // command has not done what it says. Exit non-zero rather than print a
      // warning above a success message.
      fail(
        [
          `Could not update ${CONFIG_PATH} (${e.message}).`,
          '   A binding recorded there is STILL IN FORCE, so this workspace is still attached.',
          '   Fix the config and run this again.',
        ].join('\n'),
      );
    }
    if (removed) ok(`Removed OBSIDIAN_ROUTER_DEFAULT_VAULT from ${envPath}`);
    else info(`No OBSIDIAN_ROUTER_DEFAULT_VAULT entry in ${envPath} (or file absent).`);
    if (bindingRemoved && hadBinding) ok(`Removed this workspace's binding from ${CONFIG_PATH}`);
    else if (bindingRemoved) info('No binding was recorded for this workspace in your router config.');
    if (removed || hadBinding) {
      info('Restart Claude Code in this workspace so the hooks stop loading the previously-associated vault.');
    } else {
      info('Nothing to do.');
    }
    process.exit(0);
  }

  // --link-workspace : also requires the vault-slug arg
  const vaultSlug = args[2];
  if (!vaultSlug) fail('--link-workspace requires both <workspace-path> AND <vault-slug>');

  const cfg = loadConfig();
  const paths = registeredVaultPaths(cfg);
  if (paths.length === 0) fail('Router config has no vaults in portRegistry. Bootstrap at least one with `setup-vault.mjs <vault-path>` first.');

  // Resolve slug → vault path. Delegated to src/helpers/vault-slug.mjs as of
  // v0.90.0 — this was the fourth hand-written copy of that loop, and one of
  // the two in this file that called `.toLowerCase()` on whatever `vaultNames`
  // happened to hold.
  //
  // NOTE the local `const vaultSlug = args[2]` above shadows the imported
  // `vaultSlug` helper inside this block, which is why the two module-level
  // names used here are `resolveVaultBySlug` / `knownVaultSlugs`.
  const vaultPath = resolveVaultBySlug(cfg, vaultSlug);
  if (!vaultPath) {
    fail(`Vault slug "${vaultSlug}" not in portRegistry.\n   Known slugs: ${knownVaultSlugs(cfg).join(', ')}`);
  }

  linkWorkspaceToVault({ workspacePath: wsPath, vaultPath, vaultSlug });

  // v0.65.0 (W4.2) — honor --claude-workspace HERE too. Before this, the flag
  // was wired only into the bootstrap subcommand, so a standalone re-link wrote
  // a correct .env that stayed INERT: the router plugin was never enabled in
  // the workspace, so no hook ran and the binding had no observable effect.
  // Observed 2026-08-02 — the missing link had to be written by hand.
  if (args.includes('--claude-workspace')) writeClaudeWorkspaceSettings(wsPath);
  else {
    console.log('');
    info('The .env binding alone is INERT until the router plugin is enabled in this workspace.');
    info('  Re-run with --claude-workspace, or use `--attach` which does both (and more).');
  }

  console.log('');
  info('Restart Claude Code in this workspace to activate:');
  info('  • hot-cache-load will print the associated vault\'s wiki-meta/hot.md');
  info('  • wiki-query-first-nudge will inject pre-answer reminders');
  process.exit(0);
}

// v0.65.0 (W4.1) — bind a workspace to vault(s) that ALREADY exist.
//
//   --attach <primary-slug> [--also <slug>]... [--workspace <path>]
//
// Workspace defaults to the cwd, so the common case is a single line typed
// from the repo you want attached. See attachWorkspace() for why this lives in
// the CLI rather than in the skill or an MCP tool.
if (args[0] === '--attach') {
  const positional = [];
  const alsoSlugs = [];
  let wsArg = null;
  const optOut = { plugin: true, claudeMd: true, gitignore: true };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--also') {
      const v = args[++i];
      if (!v || v.startsWith('--')) fail('--also requires a vault slug (e.g. `--also dedibox-hermes`).');
      alsoSlugs.push(v);
    } else if (a === '--workspace') {
      wsArg = args[++i];
      if (!wsArg || wsArg.startsWith('--')) fail('--workspace requires a path argument.');
    } else if (a === '--no-plugin') optOut.plugin = false;
    else if (a === '--no-claude-md') optOut.claudeMd = false;
    else if (a === '--no-gitignore') optOut.gitignore = false;
    else if (a.startsWith('--')) fail(`Unknown flag for --attach: ${a}`);
    else positional.push(a);
  }

  if (positional.length === 0) {
    fail(
      '--attach requires a vault slug.\n' +
      '   Usage: --attach <primary-slug> [--also <slug>]... [--workspace <path>]\n' +
      '   The workspace defaults to the current directory.',
    );
  }
  if (positional.length > 1) {
    fail(
      `--attach takes ONE primary slug; got ${positional.length} (${positional.join(', ')}).\n` +
      '   Additional vaults go behind --also: `--attach a --also b --also c`.',
    );
  }

  const result = attachWorkspace({
    workspacePath: wsArg || process.cwd(),
    primarySlug: positional[0],
    alsoSlugs,
    opts: optOut,
  });

  console.log('');
  ok(`Attached ${result.workspacePath}`);
  console.log(`    ${c('green', '→')} primary: ${c('bold', result.primary.slug)}  ${c('gray', `(${result.primary.path})`)}`);
  for (const s of result.secondaries) {
    console.log(`    ${c('green', '→')} also:    ${s.slug}  ${c('gray', `(${s.path})`)} — address with vault: "${s.slug}"`);
  }
  console.log('');
  for (const s of result.steps) {
    console.log(`    ${c('gray', '·')} ${s.step.padEnd(22)} ${s.detail}`);
  }
  if (result.previousSlug && result.previousSlug !== result.primary.slug) {
    console.log('');
    warn(`This workspace was previously bound to "${result.previousSlug}" — the primary is now "${result.primary.slug}".`);
  }
  console.log('');
  info('Restart Claude Code in this workspace so the plugin and the binding load.');
  if (result.secondaries.length > 0) {
    info(`Secondary vault(s) are NOT auto-loaded: name them explicitly (vault: "${result.secondaries[0].slug}").`);
  }
  process.exit(0);
}

if (args[0] === '--migrate-wiki-meta' || args[0] === '--migrate-all-wiki-meta') {
  // v0.12.1 — migrate vaults from the legacy `wiki/<scaffold>.md` layout
  // to the v0.12.0+ `wiki-meta/<scaffold>.md` layout.
  //
  // Single-vault form:  --migrate-wiki-meta <vault-path>
  // Batch form:         --migrate-all-wiki-meta
  //
  // Shared flags:
  //   --dry-run   preview only, don't touch the filesystem
  //   --force     re-rewrite CLAUDE.md even if the vault is already on the new
  //               layout (useful if a previous migration crashed before the
  //               CLAUDE.md rewrite landed)
  //
  // Why this exists: v0.12.0 shipped the clean break in code, but existing
  // vaults need their scaffold files physically relocated + their CLAUDE.md
  // path references rewritten. Doing it via a script (vs ad-hoc git mv
  // commands) makes the operation atomic per-vault, idempotent (safe to
  // re-run), and consistent across 10 vaults.
  const dryRun = args.includes('--dry-run');
  const forceFlag = args.includes('--force');
  const isBatch = args[0] === '--migrate-all-wiki-meta';

  // C3: the seal binds ONE vault's plan. The batch form has no single plan to
  // seal, so it must REJECT the flag rather than silently ignore it (which would
  // let an operator believe drift protection is active when it is not — Fable 5).
  if (isBatch && args.includes('--approved-plan-sha256')) {
    fail('--approved-plan-sha256 is only supported on the single-vault form (--migrate-wiki-meta <vault>); the seal binds one vault\'s plan.');
  }

  if (!isBatch) {
    // Single vault: require an explicit path argument. Exclude the value that
    // follows --approved-plan-sha256 so a seal is never mistaken for the path.
    const sealValIdx = args.indexOf('--approved-plan-sha256') + 1;
    const vaultArg = args.find((a, i) => i > 0 && !a.startsWith('--') && i !== sealValIdx);
    if (!vaultArg) {
      fail('--migrate-wiki-meta requires a vault path argument.\n   Usage: setup-vault.mjs --migrate-wiki-meta <vault-path> [--dry-run] [--force] [--approved-plan-sha256 <hash>]');
    }
    // canonicalPath (not path.resolve): the seal identity must be case-stable so
    // previewing `i:\v` then applying `I:\V` (same NTFS dir) isn't a false drift
    // refusal on Windows (Codex verification).
    const abs = canonicalPath(vaultArg);
    const approvedPlanSha256 = readApprovedPlanSeal(args);
    // C3 apply: verify the sealed preview against the CURRENT plan (a read-only
    // dry-run) BEFORE mutating anything.
    if (!dryRun && approvedPlanSha256) {
      const preview = migrateVaultToWikiMeta(abs, { dryRun: true, force: forceFlag, quiet: true });
      if (preview.status === 'failed') fail(`Migration failed for ${abs}:\n   ${preview.error}`);
      verifyPlanSealOrFail({
        op: 'migrate-wiki-meta',
        identity: { target: abs },
        plan: migrationPlanCore('migrate-wiki-meta', preview),
        provided: approvedPlanSha256,
        previewHint: `setup-vault.mjs --migrate-wiki-meta "${abs}" --dry-run`,
      });
    }
    const result = migrateVaultToWikiMeta(abs, { dryRun, force: forceFlag });
    if (result.status === 'failed') {
      fail(`Migration failed for ${abs}:\n   ${result.error}`);
    }
    if (result.status === 'skipped') {
      info(`Skipped: ${result.error}`);
    }
    // C3 preview: seal the plan so a later apply can pin exactly this.
    if (dryRun && result.status !== 'failed') {
      const seal = computePlanSeal({
        op: 'migrate-wiki-meta',
        identity: { target: abs },
        plan: migrationPlanCore('migrate-wiki-meta', result),
      });
      printPlanSeal(seal, `Re-run with --approved-plan-sha256 ${seal} to apply exactly this plan (refused if the vault drifts).`);
    }
    process.exit(0);
  }

  // Batch mode: iterate over portRegistry.
  const cfg = loadConfig();
  // Through the accessor (the container half of the `vaultNames` sweep): a
  // hand-edited `"portRegistry": "AB"` yields no vaults instead of the
  // manufactured paths "0" and "1".
  const vaultPaths = registeredVaultPaths(cfg);
  if (vaultPaths.length === 0) {
    fail('Router config has no vaults in portRegistry. Bootstrap at least one with `setup-vault.mjs <vault-path>` first.');
  }

  console.log(c('bold',
    `\n${dryRun ? '[DRY-RUN] ' : ''}Migrating ${vaultPaths.length} vault(s) to wiki-meta/ layout...\n`));

  const summary = {
    migrated: 0,
    'already-migrated': 0,
    skipped: 0,
    failed: 0,
  };
  const failures = [];
  for (const vp of vaultPaths) {
    const result = migrateVaultToWikiMeta(vp, { dryRun, force: forceFlag, quiet: false });
    summary[result.status] = (summary[result.status] || 0) + 1;
    if (result.status === 'failed') {
      failures.push({ vaultPath: vp, error: result.error });
      // Surface but keep going — batch mode reports the full picture at the end.
      warn(`${vp} — FAILED: ${result.error}`);
    }
  }

  console.log('');
  console.log(c('bold', 'Batch summary:'));
  console.log(`  ${c('green', 'migrated:        ' + (summary.migrated || 0))}`);
  console.log(`  ${c('gray',  'already-migrated: ' + (summary['already-migrated'] || 0))}`);
  console.log(`  ${c('gray',  'skipped (empty):  ' + (summary.skipped || 0))}`);
  if (summary.failed > 0) {
    console.log(`  ${c('red', 'failed:          ' + summary.failed)}`);
    console.log('');
    for (const f of failures) {
      console.log(`    ${c('red', '✗')} ${f.vaultPath}`);
      console.log(`      ${c('gray', f.error)}`);
    }
  } else {
    console.log(`  ${c('gray', 'failed:          0')}`);
  }

  if (dryRun) {
    console.log('');
    info('Dry-run only — re-run without --dry-run to apply.');
  }

  process.exit(summary.failed > 0 ? 1 : 0);
}

if (args[0] === '--migrate-sessions-to-wiki-meta' || args[0] === '--migrate-all-sessions-to-wiki-meta') {
  // v0.12.8 — migrate vaults from wiki/Sessions/ (v0.12.4–v0.12.7) to
  // wiki-meta/Sessions/. Cohérent avec la séparation v0.12.0 (scaffolds
  // auto-générés sous wiki-meta/, user content sous wiki/).
  //
  // Single-vault form:  --migrate-sessions-to-wiki-meta <vault-path>
  // Batch form:         --migrate-all-sessions-to-wiki-meta
  //
  // Shared flags: --dry-run (preview only, no fs writes)
  const dryRun = args.includes('--dry-run');
  const isBatch = args[0] === '--migrate-all-sessions-to-wiki-meta';

  // C3: reject the seal on the batch form — it binds one vault's plan (Fable 5).
  if (isBatch && args.includes('--approved-plan-sha256')) {
    fail('--approved-plan-sha256 is only supported on the single-vault form (--migrate-sessions-to-wiki-meta <vault>); the seal binds one vault\'s plan.');
  }

  if (!isBatch) {
    // Exclude the --approved-plan-sha256 value from vault-path detection.
    const sealValIdx = args.indexOf('--approved-plan-sha256') + 1;
    const vaultArg = args.find((a, i) => i > 0 && !a.startsWith('--') && i !== sealValIdx);
    if (!vaultArg) {
      fail('--migrate-sessions-to-wiki-meta requires a vault path argument.\n   Usage: setup-vault.mjs --migrate-sessions-to-wiki-meta <vault-path> [--dry-run] [--approved-plan-sha256 <hash>]');
    }
    // canonicalPath (not path.resolve): the seal identity must be case-stable so
    // previewing `i:\v` then applying `I:\V` (same NTFS dir) isn't a false drift
    // refusal on Windows (Codex verification).
    const abs = canonicalPath(vaultArg);
    const approvedPlanSha256 = readApprovedPlanSeal(args);
    // C3 apply: verify the sealed preview against the current plan first.
    if (!dryRun && approvedPlanSha256) {
      const preview = migrateSessionsToWikiMeta(abs, { dryRun: true, quiet: true });
      if (preview.status === 'failed') fail(`Migration failed for ${abs}:\n   ${preview.error}`);
      verifyPlanSealOrFail({
        op: 'migrate-sessions',
        identity: { target: abs },
        plan: migrationPlanCore('migrate-sessions', preview),
        provided: approvedPlanSha256,
        previewHint: `setup-vault.mjs --migrate-sessions-to-wiki-meta "${abs}" --dry-run`,
      });
    }
    const res = migrateSessionsToWikiMeta(abs, { dryRun });
    if (res.status === 'failed') fail(`Migration failed for ${abs}:\n   ${res.error}`);
    if (res.status === 'merged' && res.sessionsSkipped.length > 0) {
      warn('Some files were not moved due to name conflicts (already exist in target):');
      for (const s of res.sessionsSkipped) {
        warn(`  - ${s.file}: ${s.reason}`);
      }
      warn('Inspect manually and remove or rename the source copies in wiki/Sessions/.');
    }
    // C3 preview: seal the plan.
    if (dryRun && res.status !== 'failed') {
      const seal = computePlanSeal({
        op: 'migrate-sessions',
        identity: { target: abs },
        plan: migrationPlanCore('migrate-sessions', res),
      });
      printPlanSeal(seal, `Re-run with --approved-plan-sha256 ${seal} to apply exactly this plan (refused if the vault drifts).`);
    }
    process.exit(0);
  }

  // Batch mode: iterate over portRegistry.
  const cfg = loadConfig();
  // Through the accessor (the container half of the `vaultNames` sweep): a
  // hand-edited `"portRegistry": "AB"` yields no vaults instead of the
  // manufactured paths "0" and "1".
  const vaultPaths = registeredVaultPaths(cfg);
  if (vaultPaths.length === 0) {
    fail('Router config has no vaults in portRegistry. Bootstrap at least one with `setup-vault.mjs <vault-path>` first.');
  }

  console.log(c('bold',
    `\n${dryRun ? '[DRY-RUN] ' : ''}Migrating Sessions/ for ${vaultPaths.length} vault(s) to wiki-meta/Sessions/...\n`));

  const summary = { migrated: 0, 'already-migrated': 0, merged: 0, skipped: 0, failed: 0 };
  const failures = [];
  const merges = [];
  for (const vp of vaultPaths) {
    const res = migrateSessionsToWikiMeta(vp, { dryRun, quiet: false });
    summary[res.status] = (summary[res.status] || 0) + 1;
    if (res.status === 'failed') {
      failures.push({ vaultPath: vp, error: res.error });
      warn(`${vp} — FAILED: ${res.error}`);
    }
    if (res.status === 'merged' && res.sessionsSkipped.length > 0) {
      merges.push({ vaultPath: vp, skipped: res.sessionsSkipped });
    }
  }

  console.log('');
  console.log(c('bold', 'Batch summary:'));
  console.log(`  ${c('green', 'migrated:        ' + (summary.migrated || 0))}`);
  console.log(`  ${c('gray',  'already-migrated: ' + (summary['already-migrated'] || 0))}`);
  console.log(`  ${c('yellow', 'merged (with conflicts): ' + (summary.merged || 0))}`);
  console.log(`  ${c('gray',  'skipped (no Sessions/):  ' + (summary.skipped || 0))}`);
  if (summary.failed > 0) {
    console.log(`  ${c('red', 'failed:          ' + summary.failed)}`);
    console.log('');
    for (const f of failures) {
      console.log(`    ${c('red', '✗')} ${f.vaultPath}`);
      console.log(`      ${c('gray', f.error)}`);
    }
  }
  if (merges.length > 0) {
    console.log('');
    console.log(c('yellow', 'Merge conflicts (files left in source for manual review):'));
    for (const m of merges) {
      console.log(`  ${m.vaultPath}:`);
      for (const s of m.skipped) console.log(`    - ${s.file}: ${s.reason}`);
    }
  }

  if (dryRun) {
    console.log('');
    info('Dry-run only — re-run without --dry-run to apply.');
  }

  process.exit(summary.failed > 0 ? 1 : 0);
}

if (args[0] === '--hooks-status') {
  let example;
  try { example = loadHooksExample(); }
  catch (err) { fail(`Could not load hooks/hooks.example.json: ${err.message}`); }
  const settings = loadUserSettings();
  const pluginInstalled = isRouterPluginInstalled();
  const fromPlugin = activePluginProvidedHooks();
  const rows = reportHooksStatus(settings, example, { pluginProvided: fromPlugin });

  console.log(c('bold', '\nRouter hooks status\n'));
  console.log('Settings file:  ' + c('gray', userSettingsPath()));
  console.log('Router repo:    ' + c('gray', REPO_ROOT));
  if (pluginInstalled) {
    const where = installedRouterPluginPath();
    console.log('Plugin:         ' + c('gray',
      fromPlugin.length > 0
        ? `installed — runs ${fromPlugin.length} hook(s) on its own (${where})`
        : `installed, provides no hooks of its own (${where})`));
  }
  console.log('');
  const doubleWired = [];
  for (const row of rows) {
    const marker = row.status === 'active'
      ? c('green', '✓ active   ')
      : row.status === 'plugin'
        ? c('cyan', '✓ plugin   ')
        : c('gray', '○ inactive ');
    console.log(`  ${marker} ${row.basename}`);
    if (row.status === 'active' && fromPlugin.includes(row.basename)) doubleWired.push(row.basename);
  }
  if (doubleWired.length > 0) {
    console.log('');
    warn(`${doubleWired.length} hook(s) are wired in settings.json AND provided by the plugin — they fire TWICE per event:\n` +
      `   ${doubleWired.join(', ')}\n` +
      `   Fix: \`node scripts/setup-vault.mjs --uninstall-hooks\` then re-run \`--install-hooks\`;\n` +
      '   the plugin-provided ones will be skipped and keep working.');
  }
  const inactive = rows.filter((r) => r.status === 'inactive').length;
  console.log('');
  if (inactive > 0) {
    info(`${inactive} inactive hook(s) — install all with \`node ${path.relative(process.cwd(), fileURLToPath(import.meta.url)) || 'setup-vault.mjs'} --install-hooks\``);
  } else {
    ok('All router hooks active.');
  }
  process.exit(0);
}

if (args[0] === '--sync-from-github') {
  // Lot 3 — sync vault config (plugins/themes/snippets/root docs) straight
  // from the GitHub skeleton, for machines that have neither the dev repo
  // nor a local .template. Every safety of --sync-plugins applies unchanged
  // (CREDENTIAL_LEAK_PLUGINS, the anti-downgrade guard, per-theme clones,
  // appearance fill-if-absent) because the apply step IS syncPluginsMode
  // with an overridden source. The archive itself goes through the hardened
  // extractor — path-traversal aborts, links skipped and reported, size and
  // entry caps — see src/helpers/targz-extract.mjs.
  // Hardened flag parsing (review findings): a flag-like token is never
  // accepted as a --ref/--repo value, unknown flags fail instead of being
  // treated as vault paths, and --all cannot be silently combined with
  // explicit paths (the paths were dropped and EVERY vault got synced).
  const DEFAULT_SYNC_REPO = 'tboome33/obsidian-mcp-router';
  let force = false;
  let all = false;
  let trustRepo = false;
  let dryRun = false;
  let approvedPlanSha256 = null;
  let ref = 'main';
  let repo = DEFAULT_SYNC_REPO;
  const targets = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') { force = true; continue; }
    if (a === '--all') { all = true; continue; }
    if (a === '--trust-repo') { trustRepo = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--ref' || a === '--repo' || a === '--approved-plan-sha256') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) fail(`${a} requires a value`);
      if (a === '--ref') ref = value;
      else if (a === '--repo') repo = value;
      else {
        if (!isPlanSeal(value)) fail('Invalid --approved-plan-sha256: expected a 64-char lowercase hex plan seal (the value a --dry-run printed).');
        approvedPlanSha256 = value;
      }
      i++;
      continue;
    }
    if (a.startsWith('-')) fail(`Unknown flag for --sync-from-github: ${a}`);
    // canonicalPath (absolute + case-stable): the seal binds the concrete vault,
    // not a cwd-relative string (`./v` from two directories is two different
    // vaults — sealing the raw string would let an apply from another cwd sync a
    // vault the preview never saw; Fable 5) and equivalent Windows spellings of
    // the same vault don't spuriously refuse (Codex). --all keys are canonicalized
    // + de-duplicated below.
    targets.push(canonicalPath(a));
  }

  try { assertSafeRepoRef(repo, ref); } catch (e) { fail(e.message); }
  // A non-default repo ships EXECUTABLE plugin code under trusted names —
  // the pinned allowlist bounds WHICH ids, not WHOSE bytes. Make that trust
  // decision explicit instead of a silently-accepted flag (review+ finding).
  if (repo !== DEFAULT_SYNC_REPO && !trustRepo) {
    fail(
      `--repo points away from the default (${DEFAULT_SYNC_REPO}).\n` +
      `   A non-default repo can ship executable plugin code into your vaults.\n` +
      `   Re-run with --trust-repo if you really mean it.`,
    );
  }
  if (all && targets.length > 0) {
    fail('--all cannot be combined with explicit vault paths — pick one or the other.');
  }
  if (!all && targets.length === 0) {
    fail('Usage: --sync-from-github <vault-path…> | --all  [--ref <branch|tag>] [--repo <owner/name>] [--force] [--dry-run] [--approved-plan-sha256 <hash>]');
  }

  // Resolve the target list BEFORE downloading anything: it fails fast, and
  // loadConfig() throwing after the temp dir exists leaked the extraction
  // (review finding — process.exit skips finally, so exits must stay simple).
  const rawList = all ? Object.keys(loadConfig().portRegistry || {}) : targets;
  // Canonicalize (case-stable absolute) + de-duplicate so two spellings of the
  // same vault seal and sync once (Codex). targets[] is already canonicalized.
  const list = [...new Set(rawList.map((p) => canonicalPath(p)))];
  if (list.length === 0) {
    info('No vaults in portRegistry. Nothing to do.');
    process.exit(0);
  }

  const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`;
  console.log(c('bold', `Downloading ${repo}@${ref} from GitHub…`));
  let buffer;
  try { buffer = await httpsGetBuffer(url); }
  catch (e) { fail(`Download failed: ${e.message}\n   ${url}`); }
  info(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

  // C3 sealed preview: bind the plan to the ARCHIVE identity (its sha256 — a
  // moving ref like `main` advancing between preview and apply is the drift that
  // matters), the repo/ref/force knobs, and the resolved eligible-target set.
  // The hardened per-vault syncPluginsMode is NOT modelled or touched. Compute
  // it — and, on an apply, VERIFY it — from the downloaded buffer + read-only fs
  // checks, BEFORE creating or extracting any temp dir, so a drifted apply
  // refuses before even a scratch write (Codex: "refuse before any mutation").
  const archiveSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const eligible = [];
  const skippedNoObsidian = [];
  for (const vp of list) {
    (fs.existsSync(path.join(vp, '.obsidian')) ? eligible : skippedNoObsidian).push(vp);
  }
  const planCore = syncPlanCore({ repo, ref, force, archiveSha256, targets: eligible });
  if (!dryRun && approvedPlanSha256) {
    try {
      verifyPlanSeal({
        op: 'sync-from-github',
        identity: { repo },
        plan: planCore,
        approvedPlanSha256,
        previewHint: `setup-vault.mjs --sync-from-github … --dry-run`,
      });
    } catch (e) {
      if (e instanceof PlanDriftError) fail(`Sealed-preview drift — nothing was synced (no archive extracted).\n   ${e.message}`);
      throw e;
    }
  }

  // NOTE on cleanup: process.exit() skips finally blocks, so every exit path
  // below calls cleanup() explicitly before failing or exiting.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-github-sync-'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };

  let extracted;
  try { extracted = extractTarGz(buffer, tmp); }
  catch (e) { cleanup(); fail(`Refusing to extract the archive: ${e.message}`); }
  if (extracted.skippedLinks.length > 0) {
    warn(`Skipped ${extracted.skippedLinks.length} link entr${extracted.skippedLinks.length > 1 ? 'ies' : 'y'} in the archive (never materialized): ${extracted.skippedLinks.slice(0, 5).join(', ')}${extracted.skippedLinks.length > 5 ? ', …' : ''}`);
  }

  // Deterministic root selection: pick the extracted directory that actually
  // contains the skeleton, instead of whatever readdir lists first (review
  // finding — multi-root archives chose the source by listing order).
  const skeleton = fs.readdirSync(tmp, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(tmp, e.name, 'templates', 'reference-vault-skeleton'))
    .find((p) => fs.existsSync(path.join(p, '.obsidian', 'plugins'))) ?? null;
  if (!skeleton) {
    cleanup();
    fail(`The archive has no templates/reference-vault-skeleton with plugins — wrong repo or ref? (${repo}@${ref})`);
  }

  if (dryRun) {
    console.log(c('bold', `[DRY-RUN] Would sync ${eligible.length} eligible vault(s) from ${repo}@${ref}${force ? ' (--force)' : ''} (archive ${archiveSha256.slice(0, 12)}…):`));
    for (const vp of eligible) console.log(c('cyan', `  → ${vp}`));
    for (const vp of skippedNoObsidian) console.log(c('yellow', `  - skip (no .obsidian): ${vp}`));
    cleanup();
    const seal = computePlanSeal({ op: 'sync-from-github', identity: { repo }, plan: planCore });
    printPlanSeal(seal, `Re-run without --dry-run and with --approved-plan-sha256 ${seal} to apply exactly this plan — refused if the archive or vault set drifts.`);
    process.exit(0);
  }

  info(`Skeleton extracted (${extracted.files} files) — applying with the standard sync guards…`);
  console.log('');

  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  for (const vaultPath of list) {
    if (!fs.existsSync(path.join(vaultPath, '.obsidian'))) {
      console.log(c('yellow', `  - skip (no .obsidian): ${vaultPath}`));
      skipCount++;
      continue;
    }
    try {
      console.log(c('cyan', `  → ${vaultPath}`));
      syncPluginsMode(vaultPath, {
        force,
        throwOnError: true,
        sourceVault: skeleton,
        sourceLabel: `GitHub ${repo}@${ref}`,
        // Enables the curated-allowlist + name/manifest hygiene vetting —
        // a network archive is never a trusted plugin store.
        networkSource: true,
      });
    } catch (err) {
      console.log(c('red', `    failed: ${err.message || err}`));
      failCount++;
      continue;
    }
    okCount++;
  }
  cleanup();
  console.log('');
  console.log(c('bold', `Done. ${okCount} synced, ${skipCount} skipped, ${failCount} failed.`));
  process.exit(failCount > 0 ? 1 : 0);
}

if (args[0] === '--sync-all') {
  // Iterate over portRegistry and run sync-plugins on each vault.
  // Convenient bulk operation for: pushing a new snippet, a new plugin,
  // or a refreshed reference vault to every configured vault at once.
  // Idempotent — vaults that are already in sync are no-ops.
  const cfg = loadConfig();
  // These two guards were never at risk: `fs.existsSync` returns false for a
  // non-string rather than throwing (measured), so a bad value already failed
  // closed with this message. Routed anyway — a reader the scan cannot vouch
  // for is a reader that has to be re-audited by hand next time. (v0.90.0)
  const referenceVault = referenceVaultPath(cfg);
  if (!referenceVault || !fs.existsSync(referenceVault)) {
    fail('No reference vault configured or it no longer exists.');
  }
  const force = args.includes('--force');
  // Through the accessor, same reason as every other reader of this container.
  const targets = registeredVaultPaths(cfg);
  if (targets.length === 0) {
    info('No vaults in portRegistry. Nothing to do.');
    process.exit(0);
  }
  console.log(c('bold', `Syncing ${targets.length} vault(s) from ${referenceVault}${force ? ' (--force)' : ''}…`));
  console.log('');
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  for (const vaultPath of targets) {
    // Skip the reference vault itself — syncing it to itself is a no-op,
    // and with --force it's actively destructive (the per-vault sync
    // would rm -rf the source's own plugin dir before re-copying from
    // the now-empty source). samePath() handles Windows NTFS / macOS
    // APFS case-insensitivity, which a raw path.resolve() did not.
    if (samePath(vaultPath, referenceVault)) {
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
      // throwOnError: true so a single failing vault throws instead of
      // calling process.exit(1), keeping the loop alive for the rest.
      syncPluginsMode(vaultPath, { force, quiet: false, throwOnError: true });
    } catch (err) {
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

if (args[0] === '--discover-vaults') {
  // v0.13.9 — scan well-known per-OS locations for Obsidian vaults and report
  // their registration status. With --bootstrap-all, every candidate (not yet
  // registered + has Local REST API plugin) is bootstrapped sequentially.
  //
  // Extra scan roots via --scan-dir <path> (repeatable).
  const bootstrapAll = args.includes('--bootstrap-all');
  const dryRun = args.includes('--dry-run');
  const skipDefaults = args.includes('--no-default-scan');

  const extraDirs = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--scan-dir') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) fail('--scan-dir requires a path argument');
      extraDirs.push(path.resolve(v));
      i++; // skip the value
    }
  }

  const cfg = loadConfig();
  const vaults = discoverVaults({ extraDirs, cfg, skipDefaults });

  console.log(c('bold', `\nDiscovered ${vaults.length} Obsidian vault(s):\n`));
  if (vaults.length === 0) {
    console.log(c('gray', '  (none — no vaults found in any well-known location)'));
    console.log('');
    console.log(c('gray', '  Scanned roots:'));
    const scannedRoots = skipDefaults ? [...extraDirs] : [...defaultScanLocations(), ...extraDirs];
    for (const r of scannedRoots) {
      const exists = fs.existsSync(r) ? c('gray', '(exists)') : c('gray', '(missing)');
      console.log(`    ${r}  ${exists}`);
    }
    console.log('');
    console.log(c('gray', '  Add a custom root: --scan-dir <path>'));
    console.log('');
    process.exit(0);
  }

  const byStatus = { reference: [], registered: [], candidate: [], partial: [] };
  for (const v of vaults) byStatus[v.status].push(v);

  const fmtVault = (v) => {
    const flags = [];
    if (v.hasRestApi) flags.push('REST API ✓'); else flags.push('REST API ✗');
    if (v.hasBridge) flags.push('bridge ✓'); else flags.push('bridge ✗');
    return `  ${v.path}\n    ${c('gray', flags.join('  ·  '))}`;
  };

  if (byStatus.reference.length > 0) {
    console.log(c('cyan', 'Reference vault:'));
    for (const v of byStatus.reference) console.log(fmtVault(v));
    console.log('');
  }
  if (byStatus.registered.length > 0) {
    console.log(c('gray', `Already registered (${byStatus.registered.length}):`));
    for (const v of byStatus.registered) console.log(fmtVault(v));
    console.log('');
  }
  if (byStatus.candidate.length > 0) {
    console.log(c('green', `Candidates ready to bootstrap (${byStatus.candidate.length}):`));
    for (const v of byStatus.candidate) console.log(fmtVault(v));
    console.log('');
  }
  if (byStatus.partial.length > 0) {
    console.log(c('yellow', `Partial — missing Local REST API plugin (${byStatus.partial.length}):`));
    for (const v of byStatus.partial) console.log(fmtVault(v));
    console.log(c('gray', '    Install Local REST API in Obsidian first, then re-run discovery.'));
    console.log('');
  }

  if (!bootstrapAll) {
    console.log(c('gray', 'To bootstrap every candidate at once: ') +
      c('cyan', '--discover-vaults --bootstrap-all'));
    console.log('');
    process.exit(0);
  }

  // --bootstrap-all: iterate candidates.
  const candidates = byStatus.candidate;
  if (candidates.length === 0) {
    info('No candidates to bootstrap (everything is already registered, partial, or the reference).');
    process.exit(0);
  }

  if (dryRun) {
    console.log(c('bold', `[DRY-RUN] Would bootstrap ${candidates.length} candidate vault(s):`));
    for (const v of candidates) console.log(`  ${c('cyan', '→')} ${v.path}`);
    console.log('');
    info('Re-run without --dry-run to apply.');
    process.exit(0);
  }

  if (!referenceVaultPath(cfg) || !fs.existsSync(referenceVaultPath(cfg))) {
    fail(`Cannot bootstrap: no reference vault configured (or its path no longer exists).\n   Run \`setup-vault.mjs --bootstrap-reference <path>\` first, then \`--init-reference\`.`);
  }

  console.log(c('bold', `\nBootstrapping ${candidates.length} candidate(s)…\n`));

  let okCount = 0;
  let failCount = 0;
  const failures = [];
  for (const v of candidates) {
    console.log(c('cyan', `  → ${v.path}`));
    try {
      // No --force, no --regenerate: trust the vault's existing port/apiKey
      // if data.json already has them (adoption mode); otherwise allocate fresh.
      setupVault(v.path, { force: false, regenerate: false, linkWorkspace: null });
      okCount++;
    } catch (err) {
      // setupVault calls `fail()` which does process.exit(1). We can't catch
      // that here — we'd need to refactor setupVault to throw. For now,
      // wrap the actual fail() call site... Actually, fail() is unconditional
      // exit. So we rely on bootstrap succeeding for the common path; partial
      // failure aborts the whole batch. Document this in the user-facing
      // message.
      failures.push({ vaultPath: v.path, error: err.message || String(err) });
      failCount++;
      console.log(c('red', `    failed: ${err.message || err}`));
    }
  }

  console.log('');
  console.log(c('bold', `Done. ${okCount} bootstrapped, ${failCount} failed.`));
  if (failCount > 0) {
    for (const f of failures) console.log(`  ${c('red', '✗')} ${f.vaultPath}\n    ${c('gray', f.error)}`);
    process.exit(1);
  }
  process.exit(0);
}

if (args[0] === '--list-global-conventions') {
  // v0.13.9 — enumerate snippets shipped under templates/global-claude-md-snippets/
  const conventions = listGlobalConventions();
  console.log(c('bold', '\nAvailable global CLAUDE.md conventions:\n'));
  if (conventions.length === 0) {
    console.log(c('gray', '  (none shipped — templates/global-claude-md-snippets/ is empty or missing)'));
  } else {
    for (const conv of conventions) {
      const rel = path.relative(REPO_ROOT, conv.path);
      console.log(`  ${c('green', conv.name)}  ${c('gray', rel)}`);
    }
  }
  console.log('');
  console.log(c('gray', 'Install: ') + c('cyan', `node setup-vault.mjs --install-global-convention <name>`));
  console.log('');
  process.exit(0);
}

if (args[0] === '--install-global-convention') {
  // v0.13.9 — append a shipped snippet to `~/.claude/CLAUDE.md` with idempotent
  // HTML-comment markers. See installGlobalConvention() doc-block for design.
  const name = args.find((a, i) => i > 0 && !a.startsWith('--'));
  if (!name) {
    fail('--install-global-convention requires a snippet name.\n   Usage: setup-vault.mjs --install-global-convention <name> [--force] [--dry-run]\n   List available: setup-vault.mjs --list-global-conventions');
  }
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const res = installGlobalConvention(name, { dryRun, force });
  process.exit(res.status === 'failed' || res.status === 'snippet-not-found' ? 1 : 0);
}

if (args[0] === '--upgrade-insecure-server' || args[0] === '--upgrade-insecure-server-all') {
  // v0.13.9 — patch insecurePort + enableInsecureServer on vaults that
  // were bootstrapped BEFORE those fields became defaults. See
  // upgradeInsecureServer() doc-block for the safety rationale.
  const dryRun = args.includes('--dry-run');
  const isBatch = args[0] === '--upgrade-insecure-server-all';

  if (!isBatch) {
    const vaultArg = args.find((a, i) => i > 0 && !a.startsWith('--'));
    if (!vaultArg) {
      fail('--upgrade-insecure-server requires a vault path argument.\n   Usage: setup-vault.mjs --upgrade-insecure-server <vault-path> [--dry-run]');
    }
    const abs = path.resolve(vaultArg);
    const cfg = loadConfig();
    const res = upgradeInsecureServer(abs, { dryRun, cfg });
    process.exit(res.status === 'failed' ? 1 : 0);
  }

  // Batch mode: iterate portRegistry, passing cfg so collisions are detected
  // across the whole set.
  const cfg = loadConfig();
  // Through the accessor (the container half of the `vaultNames` sweep): a
  // hand-edited `"portRegistry": "AB"` yields no vaults instead of the
  // manufactured paths "0" and "1".
  const vaultPaths = registeredVaultPaths(cfg);
  if (vaultPaths.length === 0) {
    fail('Router config has no vaults in portRegistry. Bootstrap at least one with `setup-vault.mjs <vault-path>` first.');
  }

  console.log(c('bold',
    `\n${dryRun ? '[DRY-RUN] ' : ''}Upgrading HTTP server for ${vaultPaths.length} vault(s)...\n`));

  const summary = { upgraded: 0, 'already-enabled': 0, 'no-data-json': 0, 'no-port': 0, failed: 0 };
  const failures = [];
  for (const vp of vaultPaths) {
    const res = upgradeInsecureServer(vp, { dryRun, cfg, quiet: false });
    summary[res.status] = (summary[res.status] || 0) + 1;
    if (res.status === 'failed') failures.push({ vaultPath: vp, error: res.error });
  }

  console.log('');
  console.log(c('bold', 'Batch summary:'));
  console.log(`  ${c('green',  'upgraded:           ' + (summary.upgraded || 0))}`);
  console.log(`  ${c('gray',   'already-enabled:    ' + (summary['already-enabled'] || 0))}`);
  console.log(`  ${c('yellow', 'no-data-json:       ' + (summary['no-data-json'] || 0))}  ${c('gray', '(plugin not installed / never activated)')}`);
  console.log(`  ${c('yellow', 'no-port:            ' + (summary['no-port'] || 0))}  ${c('gray', '(data.json missing port field — anomalous)')}`);
  if (summary.failed > 0) {
    console.log(`  ${c('red',  'failed:             ' + summary.failed)}`);
    console.log('');
    for (const f of failures) {
      console.log(`    ${c('red', '✗')} ${f.vaultPath}`);
      console.log(`      ${c('gray', f.error)}`);
    }
  }

  if (dryRun) {
    console.log('');
    info('Dry-run only — re-run without --dry-run to apply.');
  } else if (summary.upgraded > 0) {
    console.log('');
    info('Reload each affected vault in Obsidian (Ctrl+P → "Reload app without saving") to pick up the change.');
  }

  process.exit(summary.failed > 0 ? 1 : 0);
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

// Indices of argv tokens consumed as the VALUE of a value-taking flag. The
// positional vault-path detection below must skip these so a value like
// `--name "My Vault"` or `--from-vault roland` is never mistaken for the path.
const consumedValueIdx = new Set();
function flagValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    fail(`${name} requires a value (e.g. \`${name} <value>\`).`);
  }
  consumedValueIdx.add(i + 1);
  return v;
}

// v0.12.7+ — inline `--link-workspace <ws-path>` flag of the main bootstrap
// subcommand. When present, setupVault() binds the workspace to the
// freshly-provisioned vault in one shot (single permission prompt vs. two).
// The standalone `--link-workspace <ws-path> <slug>` subcommand (above) keeps
// working for the re-link case where the vault is already registered.
let linkWorkspaceFlag = null;
const lwIdx = args.indexOf('--link-workspace');
if (lwIdx !== -1) {
  const value = args[lwIdx + 1];
  if (!value || value.startsWith('--')) {
    fail('--link-workspace requires a workspace path argument (e.g. `--link-workspace /path/to/repo`).');
  }
  linkWorkspaceFlag = value;
  consumedValueIdx.add(lwIdx + 1);
}

// --- Wizard flags (W1) -----------------------------------------------------
// Every one is ADDITIVE: when none are passed, the bootstrap behaves exactly as
// before (the wizard opts object is threaded through but the default source is
// 'reference', profile 'recommended', which reproduces the prior clone set).
const nameFlag = flagValue('--name');
const fromVaultFlag = flagValue('--from-vault');
const pluginsFlag = flagValue('--plugins');
const themeFlag = flagValue('--theme');
const wikiModeFlag = flagValue('--wiki-mode');
const wikiSectionsFlag = flagValue('--wiki-sections');
const probeTimeoutFlag = flagValue('--probe-timeout');

// Template source (mutually exclusive; default 'reference').
const sourceFlags = [];
if (fromVaultFlag) sourceFlags.push('--from-vault');
if (args.includes('--from-skeleton')) sourceFlags.push('--from-skeleton');
if (args.includes('--bare')) sourceFlags.push('--bare');
if (sourceFlags.length > 1) {
  fail(`Choose one template source, not several: ${sourceFlags.join(', ')}.`);
}
let sourceKind = 'reference';
if (fromVaultFlag) sourceKind = 'from-vault';
else if (args.includes('--from-skeleton')) sourceKind = 'skeleton';
else if (args.includes('--bare')) sourceKind = 'bare';

// Plugin profile: recommended (default) | minimal | custom:a,b,c
let pluginProfile = null;
let pluginCustom = null;
if (pluginsFlag) {
  if (pluginsFlag.startsWith('custom:')) {
    pluginProfile = 'custom';
    pluginCustom = pluginsFlag.slice('custom:'.length).split(',').map((s) => s.trim()).filter(Boolean);
  } else if (pluginsFlag === 'recommended' || pluginsFlag === 'minimal') {
    pluginProfile = pluginsFlag;
  } else {
    fail('--plugins must be one of: recommended | minimal | custom:a,b,c');
  }
}

if (probeTimeoutFlag !== null && !(Number(probeTimeoutFlag) > 0)) {
  fail('--probe-timeout must be a positive number of seconds.');
}

const wizardOpts = {
  name: nameFlag,
  source: sourceKind,
  fromVault: fromVaultFlag,
  withFolderTree: args.includes('--with-folder-tree'),
  pluginProfile,
  pluginCustom,
  theme: themeFlag,
  wikiMode: wikiModeFlag,
  wikiSections: wikiSectionsFlag
    ? wikiSectionsFlag.split(',').map((s) => s.trim()).filter(Boolean)
    : null,
  claudeWorkspace: args.includes('--claude-workspace'),
  open: args.includes('--open'),
  probe: args.includes('--probe'),
  probeTimeout: probeTimeoutFlag ? Number(probeTimeoutFlag) : null,
  gitInit: args.includes('--git-init'),
  linkWorkspace: linkWorkspaceFlag,
};

// Positional vault arg: skip every token consumed as a flag value.
let vaultArg = args.find((a, i) => {
  if (a.startsWith('--')) return false;
  if (consumedValueIdx.has(i)) return false;
  return true;
});

// vaultsRoot composes a path from a NAME ALONE (Phase 1 item 1 of the
// portee-ergonomie-refus roadmap; decision ergonomie-creation-liaison-vaults
// §1, accepted 2026-09-04). `vaultsRoot` already gated WHERE a vault may be
// created (knownVaultRoots, vault-plan.mjs) — nothing composed a path FROM
// it, so `--name "Foo"` with no positional path used to fail below with "No
// vault path provided" even when vaultsRoot was configured.
//
// `slugifyForPath` — NOT the vaultNames slug `buildProvisionPlan` computes a
// few calls downstream (a bare `.toLowerCase()` of --name) — is deliberately
// used here. The two are allowed to diverge: one is a DISPLAY name (Obsidian
// itself tolerates spaces/accents), the other is a FOLDER name (which must
// not carry either). Nothing needs them to match, only to both exist — the
// resolved path is echoed back in plan_vault's preview and provision_vault's
// result before anything is ever created, so a caller sees the actual folder
// name before or as it happens.
//
// `vaultsRoot` itself missing on disk is deliberately NOT special-cased here:
// `fs.mkdirSync(abs, { recursive: true })` inside setupVault() already
// creates every missing intermediate directory, vaultsRoot included.
if (!vaultArg) {
  if (nameFlag) {
    const cfgForRoot = loadConfigReadOnly();
    const root = vaultsRootPath(cfgForRoot);
    if (!root) {
      fail(
        'No vault path provided, and no `vaultsRoot` is configured in config.json to compose one from --name. ' +
        'Pass a path explicitly, or set `vaultsRoot` in config.json.',
      );
    }
    vaultArg = path.join(root, slugifyForPath(nameFlag));

    // A FOLDER ALREADY AT THAT PATH, REGISTERED UNDER A DIFFERENT NAME, IS
    // REFUSED — found in review. `slugifyForPath` (folder slug: char-run
    // folding) and the vaultNames slug `buildProvisionPlan`/`setupVault`
    // compute a few calls downstream (`wizard.name.toLowerCase()`, no
    // folding) are two DIFFERENT normalizations of the same --name — by
    // design, since one names a filesystem folder and the other a display
    // name Obsidian itself lets carry spaces/accents. Left unchecked, two
    // differently-punctuated --name values that happen to fold to the SAME
    // folder slug (e.g. "My Vault" and "My.Vault" both → "my-vault") would
    // silently fall through to the adopt-vs-create branch below under the
    // SECOND call's --name — relabeling an already-registered vault with no
    // warning that a different --name landed on its folder. The EXISTING
    // slug-collision guard a few calls downstream (keyed on the vaultNames
    // slug) cannot see this: it never learns the folder-slug collision
    // happened, because the two calls' vaultNames slugs genuinely differ.
    const already = registeredVaultPaths(cfgForRoot)
      .find((vp) => path.resolve(vp) === path.resolve(vaultArg));
    if (already) {
      const existingName = vaultSlug(cfgForRoot, already);
      if (existingName.toLowerCase() !== nameFlag.toLowerCase()) {
        fail(
          `--name "${nameFlag}" composes the folder ${vaultArg}, which is already registered as vault ` +
          `"${existingName}". Pass --name "${existingName}" to re-run on that same vault, or choose a ` +
          'different --name (or an explicit path) to create a distinct one.',
        );
      }
    }
  } else {
    fail('No vault path provided');
  }
}

// --dry-run [--json] — build the full provisioning plan WITHOUT mutating
// anything and print it. Consumed by the wizard skill's pre-flight and by the
// MCP plan_vault tool (which imports buildProvisionPlan directly).
if (args.includes('--dry-run')) {
  const cfg = loadConfigReadOnly();
  const plan = buildProvisionPlan({
    vaultPath: vaultArg,
    opts: wizardOpts,
    cfg,
    requiredPlugins: REQUIRED_PLUGINS,
    skeletonDir: SKELETON_DIR,
  });
  if (args.includes('--json')) console.log(JSON.stringify(plan, null, 2));
  else printPlanHuman(plan);
  process.exit(0);
}

if (args.includes('--sync-plugins')) {
  syncPluginsMode(vaultArg, { force, quiet });
  process.exit(0);
}

// --from-skeleton delegates to the existing bootstrap-reference flow (scaffold
// the shipped skeleton + download the bridge from GitHub releases). The
// skeleton ships no marketplace plugin binaries, so REQUIRED plugins are
// installed in Obsidian on first open — exactly the bootstrap-reference UX. The
// distinct end-state (a skeleton to finish in Obsidian, not a fully-cloned
// vault) is why it reuses that path rather than setupVault's clone loop.
if (wizardOpts.source === 'skeleton') {
  await bootstrapReference(vaultArg, { force });
  // Emit a result marker on --json so provision_vault gets a parseable result
  // for the skeleton flow too (its end-state differs — a skeleton to finish in
  // Obsidian, no port/.env yet). Without this, the MCP tool reported "no result"
  // AFTER the disk was already mutated (review+ W2 P2).
  if (args.includes('--json')) {
    const _nonce = process.env.OBSIDIAN_ROUTER_PROVISION_NONCE;
    const _marker = _nonce ? `##PROVISION_RESULT:${_nonce}##` : '##PROVISION_RESULT##';
    const _abs = path.resolve(vaultArg);
    const _name = path.basename(_abs);
    // bootstrapReference CATCHES a failed bridge download (warns + removes the
    // dir) rather than throwing, so check the bridge actually landed before
    // claiming it — else provision_vault would report a false success (review+
    // W2 pass 2).
    const _bridgeDownloaded = fs.existsSync(
      path.join(_abs, '.obsidian', 'plugins', 'mcp-router-bridge', 'main.js'));
    console.log(_marker + ' ' + JSON.stringify({
      ok: _bridgeDownloaded,
      kind: 'skeleton',
      abs: _abs,
      slug: _name.toLowerCase(),
      obsidianName: _name,
      port: null,
      insecurePort: null,
      openUri: obsidianOpenUri(_name),
      opened: false,
      probe: null,
      bridgeDownloaded: _bridgeDownloaded,
      message: _bridgeDownloaded
        ? 'Skeleton scaffolded + bridge downloaded. Open it in Obsidian to install the REQUIRED marketplace plugins, then run --init-reference.'
        : 'Skeleton scaffolded, but the bridge download FAILED (check network / GitHub reachability). Install the mcp-router-bridge plugin manually or re-run.',
    }));
  }
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(0);
}

const provisionResult = setupVault(vaultArg, {
  force,
  regenerate,
  linkWorkspace: linkWorkspaceFlag,
  wizard: wizardOpts,
});

// v0.18.2 — wire the router hooks now, so a freshly-bootstrapped vault is
// never left with dormant guards. setupVault() returns (does not exit) on
// success; on an unsafe-target refusal it exits earlier and we never reach
// here. Default-on; --no-hooks / OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS skip.
maybeAutoInstallHooks({ quiet, noHooks: args.includes('--no-hooks') });

// --git-init (opt-in): initialize a git repo in the freshly-scaffolded vault +
// an initial commit. Off by default (vaults often live under Google Drive /
// iCloud where a repo is undesirable). Operates ONLY inside the new vault dir.
if (wizardOpts.gitInit && provisionResult && provisionResult.abs) {
  // git runs with the git allowlist as its environment (subprocess-env.mjs):
  // when this script is the child of the MCP server, process.env here is the
  // server's — trimmed already, but a child's child must not re-widen it.
  const gi = spawnSync('git', ['init'], subprocessOptions('git', { cwd: provisionResult.abs, encoding: 'utf8' }));
  if (gi.status === 0) {
    spawnSync('git', ['add', '-A'], subprocessOptions('git', { cwd: provisionResult.abs }));
    spawnSync('git', ['commit', '-m', 'Initial vault scaffold (setup-vault.mjs --git-init)'],
      subprocessOptions('git', { cwd: provisionResult.abs, encoding: 'utf8' }));
    ok(`Initialized a git repo in ${provisionResult.abs}`);
  } else {
    warn(`--git-init: \`git init\` failed (${(gi.stderr || gi.error?.message || '').trim()}). Skipped.`);
  }
}

// --open + --probe: the wizard's automated tail. --open launches Obsidian on
// the new vault; --probe polls the REST port for a health verdict (expected red
// until the user clicks "Trust author and enable plugins"). A red probe exits
// non-zero so a scripted caller sees the failure.
let opened = false;
if (wizardOpts.open && provisionResult && provisionResult.obsidianName) {
  openObsidianVault(provisionResult.obsidianName);
  opened = true;
}
let probeVerdict = null;
if (wizardOpts.probe && provisionResult && provisionResult.insecurePort) {
  const timeoutMs = wizardOpts.probeTimeout ? wizardOpts.probeTimeout * 1000 : 15000;
  info(`Probing REST health on http://127.0.0.1:${provisionResult.insecurePort}/ (timeout ${Math.round(timeoutMs / 1000)}s)…`);
  probeVerdict = await probeVaultHealth(provisionResult.insecurePort, { timeoutMs });
  if (probeVerdict.ok) {
    ok(`Probe: Local REST API reachable on port ${provisionResult.insecurePort} (Obsidian open + trusted, ${probeVerdict.attempts} attempt(s)).`);
    info('Reachability only — for the full bridge /open readiness check, run `npm run audit:bridge-readiness`.');
  } else {
    warn(`Probe red — port ${provisionResult.insecurePort} not reachable after ${probeVerdict.attempts} attempt(s).\n` +
      `   Open Obsidian on the vault + click "Trust author and enable plugins", then re-run with --probe.`);
  }
}

// Machine-readable result on a REAL run with --json (consumed by the
// provision_vault MCP tool). Printed on a dedicated marker line so the human
// console output above is ignored by the parser. Emitted BEFORE the exit so a
// red probe still yields a parseable result.
if (args.includes('--json') && provisionResult) {
  const _nonce = process.env.OBSIDIAN_ROUTER_PROVISION_NONCE;
  const _marker = _nonce ? `##PROVISION_RESULT:${_nonce}##` : '##PROVISION_RESULT##';
  console.log(_marker + ' ' + JSON.stringify({
    ok: !probeVerdict || probeVerdict.ok,
    ...provisionResult,
    openUri: obsidianOpenUri(provisionResult.obsidianName),
    opened,
    probe: probeVerdict,
  }));
}

if (probeVerdict && !probeVerdict.ok) process.exit(3);

}

if (IS_CLI_ENTRYPOINT) await cliMain();
