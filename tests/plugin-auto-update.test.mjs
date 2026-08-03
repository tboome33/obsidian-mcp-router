/**
 * Tests for src/helpers/plugin-auto-update.mjs.
 *
 * Strategy: per test we build an isolated fake `<HOME>/.claude/plugins/`
 * tree mimicking what a real marketplace install looks like:
 *
 *   <fakeHome>/.claude/plugins/
 *     ├── marketplaces/obsidian-mcp-router-marketplace/   ← git repo (mocked)
 *     │   ├── .git/                                       ← presence-only
 *     │   ├── package.json                                ← version = newVersion
 *     │   └── hooks/check-router-update.mjs               ← any payload file
 *     ├── cache/obsidian-mcp-router-marketplace/obsidian-router/
 *     │   └── 0.13.10/                                    ← current install
 *     │       ├── package.json                            ← version = oldVersion
 *     │       └── hooks/check-router-update.mjs
 *     └── installed_plugins.json
 *
 * The git + npm subprocesses are stubbed via the `runners` option so
 * tests don't depend on `git` / `npm` binaries being present or on
 * actual network/I/O for git.
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  tryAutoUpdate,
  parseMarketplaceCachePath,
  rewriteSettingsHookPaths,
  detectMarkitdownStatus,
} from '../src/helpers/plugin-auto-update.mjs';

let workDir;
let scratchHomes = [];

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-auto-update-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  scratchHomes = [];
});

/**
 * Build a fake <HOME> tree mimicking a marketplace install. Returns
 * paths the tests need to assert on.
 */
function makeFakeHome({
  oldVersion = '0.13.10',
  newVersion = '0.14.0',
  marketplaceDirty = false,
  marketplacePkgVersion = null,
  installedPluginsContent = null,
  settingsContent = null,
  marketplace = 'obsidian-mcp-router-marketplace',
  plugin = 'obsidian-router',
} = {}) {
  const home = fs.mkdtempSync(path.join(workDir, 'home-'));
  scratchHomes.push(home);

  const marketplacesBase = path.join(home, '.claude', 'plugins', 'marketplaces');
  const cacheBase = path.join(home, '.claude', 'plugins', 'cache');
  const marketplaceDir = path.join(marketplacesBase, marketplace);
  const oldCacheDir = path.join(cacheBase, marketplace, plugin, oldVersion);
  const installedPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  const settingsPath = path.join(home, '.claude', 'settings.json');

  fs.mkdirSync(marketplaceDir, { recursive: true });
  fs.mkdirSync(path.join(marketplaceDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(marketplaceDir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceDir, 'package.json'),
    JSON.stringify({ name: 'obsidian-mcp-router', version: marketplacePkgVersion ?? newVersion }, null, 2),
  );
  fs.writeFileSync(
    path.join(marketplaceDir, 'hooks', 'check-router-update.mjs'),
    '// new version hook payload\n',
  );
  fs.writeFileSync(path.join(marketplaceDir, 'README.md'), 'new readme\n');

  fs.mkdirSync(oldCacheDir, { recursive: true });
  fs.mkdirSync(path.join(oldCacheDir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(oldCacheDir, 'package.json'),
    JSON.stringify({ name: 'obsidian-mcp-router', version: oldVersion }, null, 2),
  );
  fs.writeFileSync(
    path.join(oldCacheDir, 'hooks', 'check-router-update.mjs'),
    '// old version hook payload\n',
  );

  const pluginKey = `${plugin}@${marketplace}`;
  const defaultInstalled = {
    [pluginKey]: {
      installPath: oldCacheDir,
      version: oldVersion,
      lastUpdated: '2026-01-01T00:00:00Z',
      gitCommitSha: 'old-sha-deadbeef',
    },
  };
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.writeFileSync(
    installedPath,
    JSON.stringify(installedPluginsContent ?? defaultInstalled, null, 2) + '\n',
  );

  if (settingsContent !== null) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settingsContent, null, 2) + '\n');
  }

  // Build the runner stubs. `dirty` flag is reflected in `git status`.
  const calls = { git: [], npm: [] };
  const gitRun = (args, opts) => {
    calls.git.push({ args, cwd: opts?.cwd });
    if (args[0] === 'status' && args[1] === '--porcelain') {
      return { status: 0, stdout: marketplaceDirty ? ' M README.md\n' : '', stderr: '' };
    }
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'pull') return { status: 0, stdout: 'Already up to date.\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { status: 0, stdout: 'new-sha-cafef00d\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unstubbed git ${args.join(' ')}\n` };
  };
  const npmRun = (args, opts) => {
    calls.npm.push({ args, cwd: opts?.cwd });
    return { status: 0, stdout: 'added 0 packages\n', stderr: '' };
  };

  return {
    home, marketplaceDir, oldCacheDir, installedPath, settingsPath,
    pluginKey, marketplace, plugin, oldVersion, newVersion,
    runners: { gitRun, npmRun },
    calls,
  };
}

// ───────────────────────────────────────────────────────────────────
// parseMarketplaceCachePath — pure helper
// ───────────────────────────────────────────────────────────────────

describe('parseMarketplaceCachePath', () => {
  test('parses a valid cache path', () => {
    const home = path.join(os.tmpdir(), 'fake-home');
    const pluginRoot = path.join(
      home, '.claude', 'plugins', 'cache',
      'obsidian-mcp-router-marketplace', 'obsidian-router', '0.13.10',
    );
    const result = parseMarketplaceCachePath(pluginRoot, home);
    assert.deepEqual(result, {
      marketplace: 'obsidian-mcp-router-marketplace',
      plugin: 'obsidian-router',
      version: '0.13.10',
    });
  });

  test('returns null for a path outside cache/', () => {
    const home = path.join(os.tmpdir(), 'fake-home');
    const pluginRoot = '/I/DEVELOPPEMENT/obsidian-mcp-router'; // dev install
    const result = parseMarketplaceCachePath(pluginRoot, home);
    assert.equal(result, null);
  });

  test('returns null for too-few path segments', () => {
    const home = path.join(os.tmpdir(), 'fake-home');
    const pluginRoot = path.join(home, '.claude', 'plugins', 'cache', 'only-one-segment');
    const result = parseMarketplaceCachePath(pluginRoot, home);
    assert.equal(result, null);
  });

  test('returns null for too-many path segments', () => {
    const home = path.join(os.tmpdir(), 'fake-home');
    const pluginRoot = path.join(
      home, '.claude', 'plugins', 'cache',
      'marketplace', 'plugin', 'version', 'extra-segment',
    );
    const result = parseMarketplaceCachePath(pluginRoot, home);
    assert.equal(result, null);
  });
});

// ───────────────────────────────────────────────────────────────────
// tryAutoUpdate — happy path + each failure mode
// ───────────────────────────────────────────────────────────────────

describe('tryAutoUpdate', () => {
  test('happy path: pulls + copies + updates installed_plugins.json', () => {
    const env = makeFakeHome({ oldVersion: '0.13.10', newVersion: '0.14.0' });
    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });

    assert.equal(result.success, true, JSON.stringify(result));

    // New cache dir was created and populated
    const newCacheDir = path.join(
      env.home, '.claude', 'plugins', 'cache',
      env.marketplace, env.plugin, '0.14.0',
    );
    assert.ok(fs.existsSync(newCacheDir), 'new cache dir created');
    assert.ok(fs.existsSync(path.join(newCacheDir, 'package.json')), 'package.json copied');
    assert.ok(fs.existsSync(path.join(newCacheDir, 'hooks', 'check-router-update.mjs')), 'hook copied');
    // .git should NOT be copied
    assert.ok(!fs.existsSync(path.join(newCacheDir, '.git')), '.git excluded from copy');

    // installed_plugins.json updated
    const installed = JSON.parse(fs.readFileSync(env.installedPath, 'utf8'));
    const entry = installed[env.pluginKey];
    assert.equal(entry.version, '0.14.0');
    assert.equal(entry.installPath, newCacheDir);
    assert.equal(entry.gitCommitSha, 'new-sha-cafef00d');
    assert.ok(entry.lastUpdated.startsWith('20'), 'lastUpdated is an ISO timestamp');

    // Subprocess calls in expected order: status, fetch, pull, rev-parse, then npm install
    const gitCmds = env.calls.git.map((c) => c.args.join(' '));
    assert.deepEqual(gitCmds, [
      'status --porcelain',
      'fetch origin main',
      'pull --ff-only origin main',
      'rev-parse HEAD',
    ]);
    assert.equal(env.calls.npm.length, 1);
    assert.deepEqual(
      env.calls.npm[0].args,
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    );
    assert.equal(env.calls.npm[0].cwd, newCacheDir);
  });

  test('bails on dev install (pluginRoot outside cache/)', () => {
    const env = makeFakeHome();
    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: '/dev/checkout/not/in/cache',
      runners: env.runners,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /not a marketplace install/);
    assert.equal(env.calls.git.length, 0, 'no git calls when bailing early');
  });

  test('bails if pluginRoot version != installedVersion (path/pkg desync)', () => {
    const env = makeFakeHome({ oldVersion: '0.13.10', newVersion: '0.14.0' });
    const result = tryAutoUpdate({
      installedVersion: '0.12.0', // doesn't match the path's 0.13.10
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /path version.*!=.*package\.json version/);
  });

  test('bails if marketplace dir is not a git repo', () => {
    const env = makeFakeHome();
    // Remove .git
    fs.rmSync(path.join(env.marketplaceDir, '.git'), { recursive: true, force: true });

    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /not a git repo/);
  });

  test('bails if working tree is dirty', () => {
    const env = makeFakeHome({ marketplaceDirty: true });
    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /dirty/);
    // No further git calls after status
    assert.equal(env.calls.git.length, 1);
    assert.deepEqual(env.calls.git[0].args, ['status', '--porcelain']);
  });

  test('bails if post-pull marketplace version != newVersion', () => {
    const env = makeFakeHome({ marketplacePkgVersion: '0.13.99' });
    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0', // GitHub raw said this
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /post-pull version.*!=.*expected/);
  });

  test('bails on npm install failure', () => {
    const env = makeFakeHome();
    const failingNpm = (args, opts) => {
      env.calls.npm.push({ args, cwd: opts?.cwd });
      return { status: 1, stdout: '', stderr: 'EACCES\n' };
    };
    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: { ...env.runners, npmRun: failingNpm },
    });

    assert.equal(result.success, false);
    assert.match(result.error, /npm install failed/);
  });

  test('bails if installed_plugins.json is missing', () => {
    const env = makeFakeHome();
    fs.rmSync(env.installedPath);
    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /installed_plugins\.json missing/);
  });

  test('bails if installed_plugins.json has no entry for this plugin', () => {
    const env = makeFakeHome({
      installedPluginsContent: { 'some-other-plugin@some-marketplace': { version: '1.0' } },
    });
    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /no entry for/);
  });

  test('supports nested `plugins:` schema in installed_plugins.json', () => {
    const env = makeFakeHome({
      installedPluginsContent: {
        plugins: {
          'obsidian-router@obsidian-mcp-router-marketplace': {
            installPath: '/old',
            version: '0.13.10',
          },
        },
      },
    });
    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });

    assert.equal(result.success, true, JSON.stringify(result));
    const installed = JSON.parse(fs.readFileSync(env.installedPath, 'utf8'));
    assert.equal(installed.plugins[env.pluginKey].version, '0.14.0');
  });

  test('idempotent: copy step skipped if target cache dir already exists', () => {
    const env = makeFakeHome({ oldVersion: '0.13.10', newVersion: '0.14.0' });
    // Pre-create the new cache dir as if a previous auto-update partially ran
    const newCacheDir = path.join(
      env.home, '.claude', 'plugins', 'cache',
      env.marketplace, env.plugin, '0.14.0',
    );
    fs.mkdirSync(newCacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(newCacheDir, 'package.json'),
      JSON.stringify({ name: 'pre-existing', version: '0.14.0' }, null, 2),
    );
    const prevContent = fs.readFileSync(path.join(newCacheDir, 'package.json'), 'utf8');

    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });
    assert.equal(result.success, true);

    // The pre-existing file content was NOT overwritten by the copy step
    const afterContent = fs.readFileSync(path.join(newCacheDir, 'package.json'), 'utf8');
    assert.equal(afterContent, prevContent);
  });

  // Regression: prior to the v0.14.0 hardening pass, findInstalledEntry
  // returned the entry array directly under the v2 schema. The caller
  // then assigned `entry.installPath = X` onto the array — JSON.stringify
  // silently drops non-index properties on arrays, so the on-disk file
  // stayed unchanged while tryAutoUpdate returned `success: true`.
  // These tests pin down the v2-schema mutation path.
  describe('installed_plugins.json v2 schema (array of scoped entries)', () => {
    test('mutates the entry in-place and persists to disk', () => {
      const env = makeFakeHome({
        installedPluginsContent: {
          version: 2,
          plugins: {
            'obsidian-router@obsidian-mcp-router-marketplace': [{
              scope: 'user',
              installPath: path.join(
                fs.mkdtempSync(path.join(workDir, 'placeholder-')),
                '.claude', 'plugins', 'cache',
                'obsidian-mcp-router-marketplace', 'obsidian-router', '0.13.10',
              ),
              version: '0.13.10',
              gitCommitSha: 'old-sha',
            }],
          },
        },
      });
      // Overwrite the placeholder installPath with the real oldCacheDir
      // so the entry-match-by-installPath logic finds this entry.
      const installedBefore = JSON.parse(fs.readFileSync(env.installedPath, 'utf8'));
      installedBefore.plugins[env.pluginKey][0].installPath = env.oldCacheDir;
      fs.writeFileSync(env.installedPath, JSON.stringify(installedBefore, null, 2) + '\n');

      const result = tryAutoUpdate({
        installedVersion: '0.13.10',
        newVersion: '0.14.0',
        homeDir: env.home,
        pluginRoot: env.oldCacheDir,
        runners: env.runners,
      });
      assert.equal(result.success, true, JSON.stringify(result));

      const installed = JSON.parse(fs.readFileSync(env.installedPath, 'utf8'));
      const arr = installed.plugins[env.pluginKey];
      assert.ok(Array.isArray(arr), 'plugins[key] should still be an array');
      assert.equal(arr.length, 1);
      assert.equal(arr[0].version, '0.14.0', 'version actually written to disk');
      assert.ok(arr[0].installPath.endsWith('0.14.0'), 'installPath actually written to disk');
      assert.equal(arr[0].gitCommitSha, 'new-sha-cafef00d');
    });

    test('disambiguates among multi-scope entries by installPath match', () => {
      // Plugin with both a `project` scope and a `user` scope. Only the
      // `user` entry (which points at our oldCacheDir) should mutate.
      const env = makeFakeHome();
      const projectScopedPath = '/some/other/cache/v0.13.10';
      const installed = {
        version: 2,
        plugins: {
          [env.pluginKey]: [
            {
              scope: 'project',
              projectPath: '/some/workspace',
              installPath: projectScopedPath,
              version: '0.13.10',
            },
            {
              scope: 'user',
              installPath: env.oldCacheDir,
              version: '0.13.10',
            },
          ],
        },
      };
      fs.writeFileSync(env.installedPath, JSON.stringify(installed, null, 2) + '\n');

      const result = tryAutoUpdate({
        installedVersion: '0.13.10',
        newVersion: '0.14.0',
        homeDir: env.home,
        pluginRoot: env.oldCacheDir,
        runners: env.runners,
      });
      assert.equal(result.success, true, JSON.stringify(result));

      const after = JSON.parse(fs.readFileSync(env.installedPath, 'utf8'));
      const [projectEntry, userEntry] = after.plugins[env.pluginKey];
      assert.equal(projectEntry.installPath, projectScopedPath, 'project scope untouched');
      assert.equal(projectEntry.version, '0.13.10', 'project scope version untouched');
      assert.equal(userEntry.version, '0.14.0', 'user scope version updated');
      assert.ok(userEntry.installPath.endsWith('0.14.0'), 'user scope installPath updated');
    });

    test('mutates ALL scoped entries that share the same installPath (user + project at same version)', () => {
      // Claude Code shares the on-disk cache by version, so a user
      // who installed the plugin both at user-scope and project-scope
      // ends up with two entries pointing at the SAME installPath.
      // Both must be updated, or the project-scoped session keeps
      // loading stale plugin code after /reload-plugins.
      const env = makeFakeHome();
      const installed = {
        version: 2,
        plugins: {
          [env.pluginKey]: [
            {
              scope: 'user',
              installPath: env.oldCacheDir,
              version: '0.13.10',
            },
            {
              scope: 'project',
              projectPath: '/some/workspace',
              installPath: env.oldCacheDir,
              version: '0.13.10',
            },
          ],
        },
      };
      fs.writeFileSync(env.installedPath, JSON.stringify(installed, null, 2) + '\n');

      const result = tryAutoUpdate({
        installedVersion: '0.13.10',
        newVersion: '0.14.0',
        homeDir: env.home,
        pluginRoot: env.oldCacheDir,
        runners: env.runners,
      });
      assert.equal(result.success, true, JSON.stringify(result));

      const after = JSON.parse(fs.readFileSync(env.installedPath, 'utf8'));
      const [userEntry, projectEntry] = after.plugins[env.pluginKey];
      // Both entries must be at 0.14.0 — not just the first match.
      assert.equal(userEntry.version, '0.14.0', 'user entry updated');
      assert.equal(projectEntry.version, '0.14.0', 'project entry also updated');
      assert.ok(userEntry.installPath.endsWith('0.14.0'));
      assert.ok(projectEntry.installPath.endsWith('0.14.0'));
    });

    test('refuses to guess when multiple entries exist and none match installPath', () => {
      const env = makeFakeHome();
      const installed = {
        version: 2,
        plugins: {
          [env.pluginKey]: [
            { scope: 'project', projectPath: '/p1', installPath: '/nowhere/a', version: '0.13.10' },
            { scope: 'project', projectPath: '/p2', installPath: '/nowhere/b', version: '0.13.10' },
          ],
        },
      };
      fs.writeFileSync(env.installedPath, JSON.stringify(installed, null, 2) + '\n');

      const result = tryAutoUpdate({
        installedVersion: '0.13.10',
        newVersion: '0.14.0',
        homeDir: env.home,
        pluginRoot: env.oldCacheDir,
        runners: env.runners,
      });
      assert.equal(result.success, false);
      assert.match(result.error, /no entry for/);
    });
  });

  // Regression: a partial previous run could leave the new cache dir
  // present but empty (mkdir succeeded, cpSync didn't). The old branch
  // `if (!fs.existsSync(newCacheDir))` then skipped the copy entirely
  // and ran npm install in an empty dir. We now check for a populated
  // package.json with matching version before skipping.
  test('repairs partial-previous-run cache dir (empty/wrong version)', () => {
    const env = makeFakeHome({ oldVersion: '0.13.10', newVersion: '0.14.0' });
    const newCacheDir = path.join(
      env.home, '.claude', 'plugins', 'cache',
      env.marketplace, env.plugin, '0.14.0',
    );
    // Simulate a crashed previous run: dir exists, no package.json
    fs.mkdirSync(newCacheDir, { recursive: true });
    fs.writeFileSync(path.join(newCacheDir, 'stale-leftover.txt'), 'junk\n');

    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });
    assert.equal(result.success, true, JSON.stringify(result));

    // Copy must have run: marketplace files are now present
    assert.ok(fs.existsSync(path.join(newCacheDir, 'package.json')), 'package.json populated by re-copy');
    assert.ok(fs.existsSync(path.join(newCacheDir, 'hooks', 'check-router-update.mjs')), 'hooks/ populated');
    const pkg = JSON.parse(fs.readFileSync(path.join(newCacheDir, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '0.14.0');
  });

  test('npm install is invoked with --ignore-scripts (supply-chain guard)', () => {
    const env = makeFakeHome();
    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(env.calls.npm.length, 1);
    assert.ok(env.calls.npm[0].args.includes('--ignore-scripts'),
      `npm install must use --ignore-scripts to avoid running upstream postinstall code; got: ${env.calls.npm[0].args.join(' ')}`);
  });

  // Regression: --ignore-scripts means the new cache dir gets no .venv.
  // If the old cache dir had one (user was relying on bundled markitdown),
  // we must surface markitdownStatus so the success notice warns them
  // and gives the recovery command. Without this, *_to_markdown tools
  // silently ENOENT after /reload-plugins.
  //
  // tryAutoUpdate hardcodes `process.env` when calling
  // detectMarkitdownStatus, so a CI/dev environment where MARKITDOWN_PATH
  // or OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1 is set would short-circuit to
  // 'ok' and silently invalidate these assertions. Save & clear both
  // around these tests to make them deterministic across machines.
  describe('markitdownStatus integration (env-isolated)', () => {
    let savedMarkitdownPath;
    let savedSkipMarkitdown;

    before(() => {
      savedMarkitdownPath = process.env.MARKITDOWN_PATH;
      savedSkipMarkitdown = process.env.OBSIDIAN_ROUTER_SKIP_MARKITDOWN;
      delete process.env.MARKITDOWN_PATH;
      delete process.env.OBSIDIAN_ROUTER_SKIP_MARKITDOWN;
    });

    after(() => {
      if (savedMarkitdownPath !== undefined) process.env.MARKITDOWN_PATH = savedMarkitdownPath;
      if (savedSkipMarkitdown !== undefined) process.env.OBSIDIAN_ROUTER_SKIP_MARKITDOWN = savedSkipMarkitdown;
    });

    test('detects markitdown will-break when old venv exists and new does not', () => {
      const env = makeFakeHome();
      const isWin = process.platform === 'win32';
      const venvBin = path.join(env.oldCacheDir, '.venv', isWin ? 'Scripts' : 'bin', `markitdown${isWin ? '.exe' : ''}`);
      fs.mkdirSync(path.dirname(venvBin), { recursive: true });
      fs.writeFileSync(venvBin, '#!fake\n');

      const result = tryAutoUpdate({
        installedVersion: '0.13.10',
        newVersion: '0.14.0',
        homeDir: env.home,
        pluginRoot: env.oldCacheDir,
        runners: env.runners,
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.markitdownStatus, 'will-break');
    });

    test('reports markitdownStatus=never-installed when no venv anywhere', () => {
      const env = makeFakeHome();
      const result = tryAutoUpdate({
        installedVersion: '0.13.10',
        newVersion: '0.14.0',
        homeDir: env.home,
        pluginRoot: env.oldCacheDir,
        runners: env.runners,
      });
      assert.equal(result.success, true);
      assert.equal(result.markitdownStatus, 'never-installed');
    });
  });

  test('rewrites settings.json hook paths when present', () => {
    const oldCacheRel = '/cache/obsidian-mcp-router-marketplace/obsidian-router/0.13.10/';
    const newCacheRel = '/cache/obsidian-mcp-router-marketplace/obsidian-router/0.14.0/';
    const env = makeFakeHome({
      settingsContent: {
        hooks: {
          SessionStart: [{
            matcher: 'startup|resume',
            hooks: [
              { type: 'command', command: `node "/Users/me/.claude/plugins${oldCacheRel}hooks/check-router-update.mjs"` },
              { type: 'command', command: `node "/Users/me/.claude/plugins${oldCacheRel}hooks/hot-cache-load.mjs"` },
              { type: 'command', command: 'node "/some/other/unrelated/hook.mjs"' },
            ],
          }],
        },
      },
    });

    const result = tryAutoUpdate({
      installedVersion: '0.13.10',
      newVersion: '0.14.0',
      homeDir: env.home,
      pluginRoot: env.oldCacheDir,
      runners: env.runners,
    });
    assert.equal(result.success, true);

    const settings = JSON.parse(fs.readFileSync(env.settingsPath, 'utf8'));
    const hooks = settings.hooks.SessionStart[0].hooks;
    assert.ok(hooks[0].command.includes(newCacheRel), `hooks[0] should include ${newCacheRel}, got: ${hooks[0].command}`);
    assert.ok(hooks[1].command.includes(newCacheRel), `hooks[1] should include ${newCacheRel}, got: ${hooks[1].command}`);
    // Old version should be gone from rewritten entries
    assert.ok(!hooks[0].command.includes(oldCacheRel), 'old version path should be replaced');
    assert.ok(!hooks[1].command.includes(oldCacheRel), 'old version path should be replaced');
    // Unrelated hook untouched
    assert.ok(hooks[2].command.includes('/some/other/unrelated/'), 'unrelated hook untouched');
  });
});

// ───────────────────────────────────────────────────────────────────
// rewriteSettingsHookPaths — pure helper
// ───────────────────────────────────────────────────────────────────

describe('rewriteSettingsHookPaths', () => {
  test('replaces forward-slash variant', () => {
    const home = fs.mkdtempSync(path.join(workDir, 'home-'));
    scratchHomes.push(home);
    const settingsPath = path.join(home, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{
            command: 'node "/home/u/.claude/plugins/cache/mp/pl/0.1.0/hooks/h.mjs"',
          }],
        }],
      },
    }));

    const result = rewriteSettingsHookPaths({
      settingsPath,
      marketplace: 'mp', plugin: 'pl',
      oldVersion: '0.1.0', newVersion: '0.2.0',
    });

    assert.equal(result.changed, true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      'node "/home/u/.claude/plugins/cache/mp/pl/0.2.0/hooks/h.mjs"',
    );
  });

  test('replaces backslash variant', () => {
    const home = fs.mkdtempSync(path.join(workDir, 'home-'));
    scratchHomes.push(home);
    const settingsPath = path.join(home, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{
            command: 'node "C:\\Users\\u\\.claude\\plugins\\cache\\mp\\pl\\0.1.0\\hooks\\h.mjs"',
          }],
        }],
      },
    }));

    const result = rewriteSettingsHookPaths({
      settingsPath,
      marketplace: 'mp', plugin: 'pl',
      oldVersion: '0.1.0', newVersion: '0.2.0',
    });

    assert.equal(result.changed, true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.match(
      settings.hooks.SessionStart[0].hooks[0].command,
      /0\.2\.0/,
    );
  });

  test('returns changed=false if no matches', () => {
    const home = fs.mkdtempSync(path.join(workDir, 'home-'));
    scratchHomes.push(home);
    const settingsPath = path.join(home, 'settings.json');
    const before = JSON.stringify({ hooks: { SessionStart: [] } }, null, 2);
    fs.writeFileSync(settingsPath, before);

    const result = rewriteSettingsHookPaths({
      settingsPath,
      marketplace: 'mp', plugin: 'pl',
      oldVersion: '0.1.0', newVersion: '0.2.0',
    });

    assert.equal(result.changed, false);
    const after = fs.readFileSync(settingsPath, 'utf8');
    assert.equal(after, before);
  });

  test('returns changed=false silently if settings.json missing', () => {
    const home = fs.mkdtempSync(path.join(workDir, 'home-'));
    scratchHomes.push(home);
    const settingsPath = path.join(home, 'does-not-exist.json');

    const result = rewriteSettingsHookPaths({
      settingsPath,
      marketplace: 'mp', plugin: 'pl',
      oldVersion: '0.1.0', newVersion: '0.2.0',
    });

    assert.equal(result.changed, false);
  });

  test('walks arrays of strings (defensive)', () => {
    const home = fs.mkdtempSync(path.join(workDir, 'home-'));
    scratchHomes.push(home);
    const settingsPath = path.join(home, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      paths: ['/cache/mp/pl/0.1.0/foo', '/cache/mp/pl/0.1.0/bar'],
    }));

    const result = rewriteSettingsHookPaths({
      settingsPath,
      marketplace: 'mp', plugin: 'pl',
      oldVersion: '0.1.0', newVersion: '0.2.0',
    });

    assert.equal(result.changed, true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(settings.paths, ['/cache/mp/pl/0.2.0/foo', '/cache/mp/pl/0.2.0/bar']);
  });

  test('replaces mixed-separator paths (Windows + JSON-escaped)', () => {
    // Real-world: a user who hand-edited settings.json after a manual
    // install can end up with paths like
    // `C:\Users\u/.claude/plugins/cache/mp/pl/0.1.0/hooks/h.mjs`.
    // The old code's two pure-separator variants both missed this.
    const home = fs.mkdtempSync(path.join(workDir, 'home-'));
    scratchHomes.push(home);
    const settingsPath = path.join(home, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [
            { type: 'command', command: 'node "C:\\Users\\u/.claude/plugins/cache/mp/pl/0.1.0/hooks/h.mjs"' },
            { type: 'command', command: 'node "/home/u\\.claude\\plugins/cache\\mp/pl\\0.1.0\\hooks/h.mjs"' },
          ],
        }],
      },
    }));

    const result = rewriteSettingsHookPaths({
      settingsPath,
      marketplace: 'mp', plugin: 'pl',
      oldVersion: '0.1.0', newVersion: '0.2.0',
    });
    assert.equal(result.changed, true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const cmds = settings.hooks.SessionStart[0].hooks.map((h) => h.command);
    for (const cmd of cmds) {
      assert.ok(!cmd.includes('0.1.0'), `old version still present: ${cmd}`);
      assert.ok(cmd.includes('0.2.0'), `new version missing: ${cmd}`);
    }
  });

  test('lookahead prevents prefix-matching a longer version (0.1.0 vs 0.1.0-beta.1)', () => {
    const home = fs.mkdtempSync(path.join(workDir, 'home-'));
    scratchHomes.push(home);
    const settingsPath = path.join(home, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      paths: [
        '/cache/mp/pl/0.1.0/foo',
        '/cache/mp/pl/0.1.0-beta.1/foo',
      ],
    }));

    const result = rewriteSettingsHookPaths({
      settingsPath,
      marketplace: 'mp', plugin: 'pl',
      oldVersion: '0.1.0', newVersion: '0.2.0',
    });
    assert.equal(result.changed, true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.paths[0], '/cache/mp/pl/0.2.0/foo');
    assert.equal(settings.paths[1], '/cache/mp/pl/0.1.0-beta.1/foo',
      'unrelated version (longer prefix) must be untouched');
  });

  test('returns settingsExists flag so callers can warn the user', () => {
    const home = fs.mkdtempSync(path.join(workDir, 'home-'));
    scratchHomes.push(home);

    // Missing settings file → settingsExists: false (no warning needed,
    // user just hasn't wired hooks)
    const missingResult = rewriteSettingsHookPaths({
      settingsPath: path.join(home, 'does-not-exist.json'),
      marketplace: 'mp', plugin: 'pl', oldVersion: '0.1.0', newVersion: '0.2.0',
    });
    assert.equal(missingResult.changed, false);
    assert.equal(missingResult.settingsExists, false);

    // Present but no matches → settingsExists: true, changed: false
    // (caller should warn: hooks may be pinned but we couldn't find them)
    const settingsPath = path.join(home, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));
    const noMatchResult = rewriteSettingsHookPaths({
      settingsPath,
      marketplace: 'mp', plugin: 'pl', oldVersion: '0.1.0', newVersion: '0.2.0',
    });
    assert.equal(noMatchResult.changed, false);
    assert.equal(noMatchResult.settingsExists, true);
  });
});

// ───────────────────────────────────────────────────────────────────
// detectMarkitdownStatus — pure helper
// ───────────────────────────────────────────────────────────────────

describe('detectMarkitdownStatus', () => {
  const isWin = process.platform === 'win32';
  const venvBinRel = path.join('.venv', isWin ? 'Scripts' : 'bin', `markitdown${isWin ? '.exe' : ''}`);

  function makeDir() {
    const d = fs.mkdtempSync(path.join(workDir, 'mkd-'));
    scratchHomes.push(d);
    return d;
  }

  function plantVenv(dir) {
    const binPath = path.join(dir, venvBinRel);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '#!fake\n');
  }

  test('MARKITDOWN_PATH set → ok (overrides venv detection)', () => {
    const result = detectMarkitdownStatus({
      oldCacheDir: makeDir(), newCacheDir: makeDir(),
      env: { MARKITDOWN_PATH: '/usr/local/bin/markitdown' },
    });
    assert.equal(result, 'ok');
  });

  test('new cache has venv → ok', () => {
    const newDir = makeDir();
    plantVenv(newDir);
    const result = detectMarkitdownStatus({
      oldCacheDir: makeDir(), newCacheDir: newDir, env: {},
    });
    assert.equal(result, 'ok');
  });

  test('old cache had venv, new does not → will-break', () => {
    const oldDir = makeDir();
    plantVenv(oldDir);
    const result = detectMarkitdownStatus({
      oldCacheDir: oldDir, newCacheDir: makeDir(), env: {},
    });
    assert.equal(result, 'will-break');
  });

  test('neither cache has venv → never-installed', () => {
    const result = detectMarkitdownStatus({
      oldCacheDir: makeDir(), newCacheDir: makeDir(), env: {},
    });
    assert.equal(result, 'never-installed');
  });

  test('MARKITDOWN_PATH wins even when old venv exists', () => {
    const oldDir = makeDir();
    plantVenv(oldDir);
    const result = detectMarkitdownStatus({
      oldCacheDir: oldDir, newCacheDir: makeDir(),
      env: { MARKITDOWN_PATH: '/elsewhere' },
    });
    assert.equal(result, 'ok');
  });

  test('OBSIDIAN_ROUTER_SKIP_MARKITDOWN=1 suppresses will-break (matches notice promise)', () => {
    // The auto-update success notice tells the user this flag silences
    // the warning. If detectMarkitdownStatus doesn't honor it, users
    // who follow that instruction get nagged on every update — broken
    // contract. Pinning the behavior here.
    const oldDir = makeDir();
    plantVenv(oldDir);
    const result = detectMarkitdownStatus({
      oldCacheDir: oldDir, newCacheDir: makeDir(),
      env: { OBSIDIAN_ROUTER_SKIP_MARKITDOWN: '1' },
    });
    assert.equal(result, 'ok');
  });

  test('empty MARKITDOWN_PATH ("") does not count as override', () => {
    const oldDir = makeDir();
    plantVenv(oldDir);
    const result = detectMarkitdownStatus({
      oldCacheDir: oldDir, newCacheDir: makeDir(),
      env: { MARKITDOWN_PATH: '   ' },
    });
    assert.equal(result, 'will-break');
  });
});
