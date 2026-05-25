/**
 * plugin-auto-update.mjs
 *
 * Pure helpers used by hooks/check-router-update.mjs to replicate what
 * `/plugin update obsidian-router@obsidian-mcp-router-marketplace` does:
 *
 *   1. git pull in the marketplace clone
 *   2. mkdir + copy the new version into the cache dir
 *   3. npm install --omit=dev
 *   4. update installed_plugins.json (installPath, version, lastUpdated,
 *      gitCommitSha)
 *   5. rewrite hook paths in ~/.claude/settings.json (Claude Code does
 *      NOT do this automatically — confirmed via docs: "When a plugin
 *      updates mid-session, hook commands keep using the previous
 *      version's path. Run /reload-plugins to switch."). Without this
 *      step, the auto-update hook itself would keep firing from the
 *      old version dir.
 *
 * Extracted into its own module so tests can drive these functions
 * with isolated fixtures (no need to spawn the CLI hook, no side
 * effect of trying to reach GitHub on import).
 *
 * All functions are I/O-bound (filesystem + git + npm subprocesses)
 * but return structured results — no throws on expected failures, so
 * the hook can fall back to its manual-notice path silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NPM_INSTALL_TIMEOUT_MS = 180 * 1000;

/**
 * Replicate what `/plugin update` does internally. Returns
 *   { success: true }
 *   { success: false, error: string }
 *
 * `runners` is an optional object that overrides the subprocess
 * helpers (`gitRun`, `npmRun`) — used by tests to avoid spawning real
 * git/npm. In production, callers omit it and the real spawnSync is used.
 */
export function tryAutoUpdate({
  installedVersion,
  newVersion,
  homeDir,
  pluginRoot,
  runners = {},
}) {
  const gitRun = runners.gitRun || defaultGitRun;
  const npmRun = runners.npmRun || defaultNpmRun;

  // 1. Detect marketplace install. pluginRoot must match
  //    <HOME>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
  const cacheLayout = parseMarketplaceCachePath(pluginRoot, homeDir);
  if (!cacheLayout) {
    return { success: false, error: 'not a marketplace install (dev / npm-link)' };
  }
  const { marketplace, plugin, version: oldVersionFromPath } = cacheLayout;

  if (oldVersionFromPath !== installedVersion) {
    return {
      success: false,
      error: `path version (${oldVersionFromPath}) != package.json version (${installedVersion})`,
    };
  }

  // 2. Marketplace clone must exist and be a git repo
  const marketplaceDir = path.join(
    homeDir, '.claude', 'plugins', 'marketplaces', marketplace,
  );
  if (!fs.existsSync(path.join(marketplaceDir, '.git'))) {
    return { success: false, error: `marketplace dir not a git repo: ${marketplaceDir}` };
  }

  // 3. Refuse if marketplace dir has uncommitted changes — never
  //    obliterate user edits.
  const status = gitRun(['status', '--porcelain'], { cwd: marketplaceDir });
  if (status.status !== 0) {
    return { success: false, error: 'git status failed' };
  }
  if (status.stdout.trim() !== '') {
    return { success: false, error: 'marketplace working tree dirty — skipped to preserve local edits' };
  }

  // 4. Fast-forward pull. Fails if main has diverged (which means the
  //    user has done something funky in the marketplace clone, bail).
  const fetch = gitRun(['fetch', 'origin', 'main'], { cwd: marketplaceDir });
  if (fetch.status !== 0) {
    return { success: false, error: 'git fetch failed' };
  }
  const pull = gitRun(['pull', '--ff-only', 'origin', 'main'], { cwd: marketplaceDir });
  if (pull.status !== 0) {
    return { success: false, error: 'git pull --ff-only failed (non-FF divergence?)' };
  }

  // 5. Sanity: marketplace's package.json version after pull should
  //    equal `newVersion` (= what GitHub raw said). If not, GitHub
  //    raw is ahead of main HEAD, weird state — bail.
  let marketplacePkg;
  try {
    marketplacePkg = JSON.parse(
      fs.readFileSync(path.join(marketplaceDir, 'package.json'), 'utf8'),
    );
  } catch {
    return { success: false, error: 'cannot read marketplace package.json post-pull' };
  }
  if (marketplacePkg.version !== newVersion) {
    return {
      success: false,
      error: `post-pull version (${marketplacePkg.version}) != expected (${newVersion})`,
    };
  }

  // 6. Capture new commit SHA
  const sha = gitRun(['rev-parse', 'HEAD'], { cwd: marketplaceDir });
  if (sha.status !== 0) {
    return { success: false, error: 'git rev-parse failed' };
  }
  const newSha = sha.stdout.trim();

  // 7. Create the new version cache dir and copy the marketplace
  //    content into it (excluding .git and node_modules).
  const newCacheDir = path.join(
    homeDir, '.claude', 'plugins', 'cache', marketplace, plugin, newVersion,
  );
  try {
    if (!fs.existsSync(newCacheDir)) {
      fs.mkdirSync(newCacheDir, { recursive: true });
      fs.cpSync(marketplaceDir, newCacheDir, {
        recursive: true,
        force: false,
        filter: (src) => {
          const base = path.basename(src);
          return base !== '.git' && base !== 'node_modules';
        },
      });
    }
  } catch (err) {
    return { success: false, error: `copy to cache failed: ${err.message}` };
  }

  // 8. npm install --omit=dev in the new cache dir
  const npm = npmRun(['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: newCacheDir,
    timeout: NPM_INSTALL_TIMEOUT_MS,
  });
  if (npm.status !== 0) {
    return { success: false, error: `npm install failed (exit ${npm.status})` };
  }

  // 9. Update installed_plugins.json
  const installedPath = path.join(
    homeDir, '.claude', 'plugins', 'installed_plugins.json',
  );
  if (!fs.existsSync(installedPath)) {
    return { success: false, error: 'installed_plugins.json missing' };
  }
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  } catch {
    return { success: false, error: 'installed_plugins.json malformed' };
  }
  const pluginKey = `${plugin}@${marketplace}`;
  const entry = findInstalledEntry(installed, pluginKey);
  if (!entry) {
    return { success: false, error: `no entry for ${pluginKey} in installed_plugins.json` };
  }
  entry.installPath = newCacheDir;
  entry.version = newVersion;
  entry.lastUpdated = new Date().toISOString();
  entry.gitCommitSha = newSha;
  try {
    writeJsonAtomic(installedPath, installed);
  } catch (err) {
    return { success: false, error: `installed_plugins.json write failed: ${err.message}` };
  }

  // 10. Rewrite hook paths in ~/.claude/settings.json. Best-effort:
  //     a failure here just means hooks keep firing from the old
  //     version dir until the user re-runs install-hooks.
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  rewriteSettingsHookPaths({
    settingsPath, marketplace, plugin,
    oldVersion: oldVersionFromPath,
    newVersion,
  });

  return { success: true };
}

/**
 * Parse a path like
 *   <HOME>/.claude/plugins/cache/<marketplace>/<plugin>/<version>
 * Returns { marketplace, plugin, version } or null if `pluginRoot`
 * isn't a marketplace cache path.
 */
export function parseMarketplaceCachePath(pluginRoot, homeDir) {
  const cacheBase = path.join(homeDir, '.claude', 'plugins', 'cache');
  const rel = path.relative(cacheBase, pluginRoot);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length !== 3) return null;
  return { marketplace: parts[0], plugin: parts[1], version: parts[2] };
}

/**
 * installed_plugins.json could be a flat map keyed by "<plugin>@<marketplace>"
 * OR nested under `plugins: { ... }`. We support both. Returns the
 * entry object (caller mutates in place) or null if not found.
 */
function findInstalledEntry(installed, pluginKey) {
  if (installed && typeof installed === 'object') {
    if (installed[pluginKey] && typeof installed[pluginKey] === 'object') {
      return installed[pluginKey];
    }
    if (installed.plugins && typeof installed.plugins === 'object'
        && installed.plugins[pluginKey] && typeof installed.plugins[pluginKey] === 'object') {
      return installed.plugins[pluginKey];
    }
  }
  return null;
}

/**
 * Write `data` to `filePath` via a temp + rename so a crash mid-write
 * doesn't leave a half-written installed_plugins.json or settings.json.
 */
function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

/**
 * Walk `settings.json` and replace any string containing the old
 * cache-version segment with the new one. Handles both forward-slash
 * (POSIX + the convention setup-vault.mjs uses on Windows) and
 * backslash (manual Windows install).
 *
 * Idempotent; silent on any error (caller doesn't need to know — a
 * failed rewrite just delays the hook switch by one update cycle).
 */
export function rewriteSettingsHookPaths({ settingsPath, marketplace, plugin, oldVersion, newVersion }) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return { changed: false };
  }

  const variants = [
    {
      old: `/cache/${marketplace}/${plugin}/${oldVersion}/`,
      neu: `/cache/${marketplace}/${plugin}/${newVersion}/`,
    },
    {
      old: `\\cache\\${marketplace}\\${plugin}\\${oldVersion}\\`,
      neu: `\\cache\\${marketplace}\\${plugin}\\${newVersion}\\`,
    },
  ];

  function applyVariants(str) {
    let out = str;
    for (const { old, neu } of variants) {
      if (out.includes(old)) out = out.split(old).join(neu);
    }
    return out;
  }

  let changed = false;
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (typeof obj[i] === 'string') {
          const updated = applyVariants(obj[i]);
          if (updated !== obj[i]) { obj[i] = updated; changed = true; }
        } else {
          visit(obj[i]);
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        const updated = applyVariants(v);
        if (updated !== v) { obj[k] = updated; changed = true; }
      } else {
        visit(v);
      }
    }
  };
  visit(settings);

  if (changed) {
    try {
      writeJsonAtomic(settingsPath, settings);
    } catch {
      return { changed: false };
    }
  }
  return { changed };
}

// ─── Default subprocess runners (real git / npm) ──────────────────────

function defaultGitRun(args, opts) {
  return spawnSync('git', args, { ...opts, encoding: 'utf8' });
}

function defaultNpmRun(args, opts) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(cmd, args, {
    ...opts,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}
