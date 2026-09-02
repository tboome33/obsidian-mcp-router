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

import { planCachePurge, applyCachePurge } from './plugin-cache-purge.mjs';
import { subprocessOptions } from './subprocess-env.mjs';

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
  //
  //    Idempotence requires checking that an existing target actually
  //    contains the new version — not just that the dir exists. A
  //    previous run that crashed after mkdirSync but before cpSync
  //    would leave an empty dir; the old "dir exists → skip copy"
  //    branch would then run npm install against an empty dir and
  //    fail opaquely. We re-copy unless package.json exists AND
  //    already reports `newVersion`.
  const newCacheDir = path.join(
    homeDir, '.claude', 'plugins', 'cache', marketplace, plugin, newVersion,
  );
  try {
    const cachedPkgPath = path.join(newCacheDir, 'package.json');
    let alreadyPopulated = false;
    if (fs.existsSync(cachedPkgPath)) {
      try {
        const cachedPkg = JSON.parse(fs.readFileSync(cachedPkgPath, 'utf8'));
        alreadyPopulated = cachedPkg.version === newVersion;
      } catch { alreadyPopulated = false; }
    }
    if (!alreadyPopulated) {
      fs.mkdirSync(newCacheDir, { recursive: true });
      fs.cpSync(marketplaceDir, newCacheDir, {
        recursive: true,
        force: true,
        filter: (src) => {
          const base = path.basename(src);
          return base !== '.git' && base !== 'node_modules';
        },
      });
    }
  } catch (err) {
    return { success: false, error: `copy to cache failed: ${err.message}` };
  }

  // 8. npm install --omit=dev --ignore-scripts in the new cache dir.
  //    --ignore-scripts is critical: without it, every auto-update would
  //    run preinstall/install/postinstall lifecycle scripts from freshly
  //    pulled upstream code — this package's own, and every dependency's —
  //    in a silent SessionStart hook, with full user privileges. That's a
  //    supply-chain footgun on every release. (v0.56.0 also removed this
  //    package's own `postinstall`, which used to build Python venvs; the
  //    guard stays because dependencies can still declare theirs.)
  //
  //    Trade-off: skipping postinstall means the new cache dir won't
  //    have a `.venv/` provisioned for markitdown. resolveMarkitdownPath
  //    (src/markdownify/utils.mjs) looks at `<projectRoot>/.venv` per
  //    version, so users on the bundled venv (no MARKITDOWN_PATH set,
  //    no global `markitdown` on PATH) will get ENOENT on
  //    *_to_markdown tool calls after /reload-plugins. We detect that
  //    case below and propagate `markitdownStatus` to the caller so
  //    the success notice can include a one-liner fix. We do NOT
  //    re-run install-markitdown.mjs inline — it takes 30-180s to
  //    create the venv and pip-install ~100MB of wheels, which would
  //    freeze the SessionStart hook.
  const npm = npmRun(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: newCacheDir,
    timeout: NPM_INSTALL_TIMEOUT_MS,
  });
  if (npm.status !== 0) {
    return { success: false, error: `npm install failed (exit ${npm.status})` };
  }

  // Markitdown availability check (see comment above).
  const markitdownStatus = detectMarkitdownStatus({
    oldCacheDir: pluginRoot,
    newCacheDir,
    env: process.env,
  });

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
  const entries = findInstalledEntries(installed, pluginKey, pluginRoot);
  if (entries.length === 0) {
    return { success: false, error: `no entry for ${pluginKey} in installed_plugins.json` };
  }
  const nowIso = new Date().toISOString();
  for (const entry of entries) {
    entry.installPath = newCacheDir;
    entry.version = newVersion;
    entry.lastUpdated = nowIso;
    entry.gitCommitSha = newSha;
  }
  try {
    writeJsonAtomic(installedPath, installed);
  } catch (err) {
    return { success: false, error: `installed_plugins.json write failed: ${err.message}` };
  }

  // 10. Rewrite hook paths in ~/.claude/settings.json. Best-effort:
  //     a failure here just means hooks keep firing from the old
  //     version dir until the user re-runs install-hooks.
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  const settingsRewrite = rewriteSettingsHookPaths({
    settingsPath, marketplace, plugin,
    oldVersion: oldVersionFromPath,
    newVersion,
  });

  // 11. Plan (never apply) the cache purge.
  //
  //     Every update copies ~155 MB in and removes nothing, so the cache grows
  //     without bound — eight versions and ~1.2 GB by the time this was
  //     measured. The plan is computed HERE, where we know which version was
  //     just installed, and returned to the caller so the success notice can
  //     say how much is reclaimable and how to reclaim it.
  //
  //     It is deliberately NOT applied. This runs inside a silent SessionStart
  //     hook; deleting ~800 MB with no one watching is exactly the kind of
  //     unannounced destruction this repo refuses everywhere else. Opt in with
  //     OBSIDIAN_ROUTER_AUTO_PURGE_CACHE=1 and the update applies its own
  //     sealed plan — still fail-closed, still never touching a snapshot a
  //     running session is pinned to.
  //
  //     Best-effort: a purge that cannot even be planned must never turn a
  //     successful update into a reported failure.
  let cachePurge = null;
  try {
    //     `pluginRoot` must be the snapshot THIS process is executing from,
    //     which during an update is the OLD one — `pluginRoot`, not
    //     `newCacheDir`. The new directory is already protected by
    //     `currentVersion`; passing it here would have left the directory we
    //     are actually running out of protected by nothing but the
    //     best-effort process scan.
    const purgeArgs = {
      homeDir, marketplace, plugin,
      currentVersion: newVersion,
      pluginRoot,
    };
    cachePurge = planCachePurge(purgeArgs);
    if (cachePurge && !cachePurge.blocked && cachePurge.purge.length > 0
        && String(process.env.OBSIDIAN_ROUTER_AUTO_PURGE_CACHE || '') === '1') {
      cachePurge.applied = applyCachePurge({
        ...purgeArgs,
        approvedPlanSha256: cachePurge.approvedPlanSha256,
      });
    }
  } catch (err) {
    cachePurge = { blocked: true, blockedReason: `purge planning failed: ${err.message}`, purge: [], keep: [] };
  }

  return { success: true, settingsRewrite, markitdownStatus, cachePurge };
}

/**
 * Determine whether the user will lose access to markitdown after the
 * auto-update activates (via /reload-plugins).
 *
 * Returns one of:
 *   - 'ok'              — user has an override (MARKITDOWN_PATH set, or
 *                         OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1 explicit opt-out),
 *                         OR the new cache dir already has .venv (e.g. user
 *                         pre-ran install-markitdown.mjs).
 *   - 'will-break'      — old cache dir had a working .venv but new one
 *                         doesn't, AND no override. The user's
 *                         *_to_markdown tools will return ENOENT after
 *                         /reload-plugins until they re-run
 *                         install-markitdown.mjs.
 *   - 'never-installed' — neither cache dir had a .venv and no override.
 *                         The user wasn't using markitdown before; the
 *                         update doesn't change anything.
 *
 * Pure: takes `env` as a parameter so tests can drive it without
 * mutating process.env.
 *
 * Both override flags map to 'ok' so the auto-update success notice
 * doesn't keep nagging users who have explicitly chosen not to use the
 * bundled venv — matching what the notice itself promises.
 */
export function detectMarkitdownStatus({ oldCacheDir, newCacheDir, env }) {
  const e = env || {};
  if (e.MARKITDOWN_PATH && String(e.MARKITDOWN_PATH).trim() !== '') return 'ok';
  if (String(e.OBSIDIAN_ROUTER_SKIP_MARKITDOWN || '') === '1') return 'ok';
  const isWin = process.platform === 'win32';
  const venvBinRel = path.join('.venv', isWin ? 'Scripts' : 'bin', `markitdown${isWin ? '.exe' : ''}`);
  const newHasVenv = fs.existsSync(path.join(newCacheDir, venvBinRel));
  if (newHasVenv) return 'ok';
  const oldHasVenv = fs.existsSync(path.join(oldCacheDir, venvBinRel));
  return oldHasVenv ? 'will-break' : 'never-installed';
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
 * Locate every install entry to mutate for `pluginKey` in
 * installed_plugins.json. Always returns an array (possibly empty) of
 * objects that the caller mutates in place.
 *
 * Three schemas are supported:
 *
 *   v2 (current Claude Code): each `plugins[key]` value is an **array** of
 *   scoped install entries — `[{ scope: "user", installPath, version, ... }, ...]`.
 *   A single plugin can have multiple entries (e.g. a `scope: "project"`
 *   install for one workspace plus a `scope: "user"` install). Claude
 *   Code shares the on-disk cache by version, so two scopes can point at
 *   the SAME `installPath` — both then need their version/installPath
 *   refreshed when we move to the new cache dir. We return every entry
 *   whose `installPath` resolves to `currentInstallPath`; if none match
 *   but the array has exactly one entry we return that (legacy install
 *   that has moved on disk).
 *
 *   v1 nested: `installed.plugins[key]` is a single object — returned as
 *   a one-element array.
 *
 *   v1 flat: `installed[key]` is a single object — returned as a
 *   one-element array.
 *
 * Why an array (even for v1): assigning properties onto an Array (the
 * v2 raw value) is silently dropped by JSON.stringify. Returning the
 * array elements explicitly is the safety mechanism.
 */
function findInstalledEntries(installed, pluginKey, currentInstallPath) {
  if (!installed || typeof installed !== 'object') return [];

  const candidates = [
    installed.plugins && typeof installed.plugins === 'object' ? installed.plugins[pluginKey] : undefined,
    installed[pluginKey],
  ];

  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const entries = pickScopedEntries(value, currentInstallPath);
      if (entries.length > 0) return entries;
      continue;
    }
    if (typeof value === 'object') {
      return [value];
    }
  }
  return [];
}

function pickScopedEntries(entries, currentInstallPath) {
  if (entries.length === 0) return [];
  if (currentInstallPath) {
    const target = path.resolve(currentInstallPath);
    const matches = entries.filter(
      (e) => e && typeof e === 'object' && typeof e.installPath === 'string'
        && path.resolve(e.installPath) === target,
    );
    if (matches.length > 0) return matches; // mutate ALL matches
  }
  // No path match — only safe to pick if the array has exactly one entry.
  if (entries.length === 1 && entries[0] && typeof entries[0] === 'object') {
    return [entries[0]];
  }
  return [];
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
 * Walk `settings.json` and rewrite any string referencing the old
 * cache-version segment to point at the new one. Separator-agnostic:
 * matches forward-slash (POSIX, and the convention setup-vault.mjs
 * uses on Windows), backslash (manual Windows install), and mixed
 * (e.g. `C:\Users\u/.claude/plugins/cache/mp/pl/0.1.0/...`), in a
 * single regex pass that preserves the surrounding separator style.
 *
 * Returns `{ changed: boolean, settingsExists: boolean }`. Silent on
 * write failure (returns `changed: false`), but callers can surface a
 * warning to the user when `settingsExists: true` and `changed: false`
 * despite an auto-update succeeding — that means hooks still point at
 * the old version dir.
 */
export function rewriteSettingsHookPaths({ settingsPath, marketplace, plugin, oldVersion, newVersion }) {
  if (!fs.existsSync(settingsPath)) {
    return { changed: false, settingsExists: false };
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return { changed: false, settingsExists: true };
  }

  // Match `[sep]+cache[sep]+marketplace[sep]+plugin[sep]+oldVersion`
  // followed by a separator (so we don't accidentally rewrite a
  // version that happens to be a prefix of another version directory).
  // The `[sep]+` prefix accepts both `/` and `\` so mixed-separator
  // paths are handled too. The captured `$1` keeps whatever separators
  // were in the source, so we don't reformat the user's preferred style.
  const sep = '[\\\\/]';
  const versionRegex = new RegExp(
    '(' + sep + '+cache' + sep + '+' + escapeRegexStrict(marketplace)
    + sep + '+' + escapeRegexStrict(plugin) + sep + '+)'
    + escapeRegexStrict(oldVersion)
    + '(?=' + sep + ')',
    'g',
  );

  let changed = false;
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (typeof obj[i] === 'string') {
          const updated = obj[i].replace(versionRegex, `$1${newVersion}`);
          if (updated !== obj[i]) { obj[i] = updated; changed = true; }
        } else {
          visit(obj[i]);
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        const updated = v.replace(versionRegex, `$1${newVersion}`);
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
      return { changed: false, settingsExists: true };
    }
  }
  return { changed, settingsExists: true };
}

function escapeRegexStrict(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Default subprocess runners (real git / npm) ──────────────────────

// Both build the child's environment from its allowlist (subprocess-env.mjs)
// rather than spreading process.env: this runs inside a Claude Code hook,
// whose environment is the host's, and neither git nor npm has any use for
// what the host keeps there.
function defaultGitRun(args, opts) {
  return spawnSync('git', args, subprocessOptions('git', { ...opts, encoding: 'utf8' }));
}

function defaultNpmRun(args, opts) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(cmd, args, subprocessOptions('npm', {
    ...opts,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }));
}

// The real runners, for the test that spawns a real executable through them
// (tests/subprocess-env.test.mjs). Production callers go through
// `tryAutoUpdate`, which picks them up as the defaults.
export const _internals = { defaultGitRun, defaultNpmRun };
