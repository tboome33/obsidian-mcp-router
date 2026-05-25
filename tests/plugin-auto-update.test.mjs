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
    assert.deepEqual(env.calls.npm[0].args, ['install', '--omit=dev', '--no-audit', '--no-fund']);
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

  test('rewrites settings.json hook paths when present', () => {
    const oldCacheRel = '/cache/obsidian-mcp-router-marketplace/obsidian-router/0.13.10/';
    const newCacheRel = '/cache/obsidian-mcp-router-marketplace/obsidian-router/0.14.0/';
    const env = makeFakeHome({
      settingsContent: {
        hooks: {
          SessionStart: [{
            matcher: 'startup|resume',
            hooks: [
              { type: 'command', command: `node "/Users/nicolas/.claude/plugins${oldCacheRel}hooks/check-router-update.mjs"` },
              { type: 'command', command: `node "/Users/nicolas/.claude/plugins${oldCacheRel}hooks/hot-cache-load.mjs"` },
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
    assert.match(hooks[0].command, new RegExp(newCacheRel.replace(/\//g, '\\/')));
    assert.match(hooks[1].command, new RegExp(newCacheRel.replace(/\//g, '\\/')));
    // Unrelated hook untouched
    assert.match(hooks[2].command, /some\/other\/unrelated/);
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
});
