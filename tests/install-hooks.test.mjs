/**
 * Tests for setup-vault.mjs --install-hooks / --uninstall-hooks /
 * --hooks-status.
 *
 * Strategy: spawn the script as subprocess with a fake HOME (via env)
 * pointing to a temp dir, then inspect the resulting `.claude/settings.json`.
 * Each test isolated to its own temp HOME so they don't interfere.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-vault.mjs');

let workDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-hooks-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Spawn the script with isolated HOME / USERPROFILE pointing at a fresh
 * dir under workDir. Returns { settings, status, stdout, stderr, homePath }.
 * If `initialSettings` is provided, pre-populates ~/.claude/settings.json.
 * `args` is the CLI arg list (e.g. ['--install-hooks']).
 */
function runScript(args, { initialSettings = null, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(workDir, 'home-'));
  if (initialSettings !== null) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify(initialSettings, null, 2),
    );
  }
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ...env,
      },
    },
  );
  let settings = null;
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch { /* settings unreadable */ }
  }
  return { ...result, settings, homePath: home };
}

// ---------------------------------------------------------------------------
// --install-hooks
// ---------------------------------------------------------------------------

describe('setup-vault.mjs --install-hooks', () => {
  test('creates settings.json from scratch with all router hooks', () => {
    const r = runScript(['--install-hooks']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.settings, 'settings.json should be created');
    assert.ok(r.settings.hooks, 'hooks key should exist');
    // Expect all 4 lifecycle events present
    for (const event of ['SessionStart', 'PostCompact', 'PostToolUse', 'Stop']) {
      assert.ok(r.settings.hooks[event], `event ${event} should be present`);
    }
    // Stdout reports installed hooks
    assert.match(r.stdout, /Installed \d+ hook\(s\)/);
  });

  test('merges into existing settings.json without clobbering user keys', () => {
    const r = runScript(['--install-hooks'], {
      initialSettings: { agentPushNotifEnabled: true, otherUserKey: 42 },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.settings.agentPushNotifEnabled, true, 'user keys preserved');
    assert.equal(r.settings.otherUserKey, 42, 'user keys preserved');
    assert.ok(r.settings.hooks, 'hooks added');
  });

  test('is idempotent (re-run = no-op)', () => {
    const r1 = runScript(['--install-hooks']);
    assert.equal(r1.status, 0);
    // Re-use the same HOME by re-running in the same dir
    const settingsCopy = JSON.parse(JSON.stringify(r1.settings));
    const r2 = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--install-hooks'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: r1.homePath, USERPROFILE: r1.homePath },
      },
    );
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /All requested hooks are already installed/);
    // Settings should be unchanged
    const after = JSON.parse(
      fs.readFileSync(path.join(r1.homePath, '.claude', 'settings.json'), 'utf8'),
    );
    assert.deepEqual(after, settingsCopy, 'no-op should not mutate settings');
  });

  test('--select installs only the named hooks', () => {
    const r = runScript(['--install-hooks', '--select', 'vault-link-linter,doc-propagation-checker']);
    assert.equal(r.status, 0, r.stderr);

    // Walk all commands in settings, collect basenames
    const found = new Set();
    for (const event of Object.keys(r.settings.hooks || {})) {
      for (const block of r.settings.hooks[event]) {
        for (const entry of block.hooks || []) {
          const m = entry.command.match(/[\\/]([^\\/]+\.mjs)\b/);
          if (m) found.add(m[1]);
        }
      }
    }
    assert.ok(found.has('vault-link-linter.mjs'), 'linter installed');
    assert.ok(found.has('doc-propagation-checker.mjs'), 'propagation-checker installed');
    assert.ok(!found.has('wiki-autocommit.mjs'), 'autocommit NOT installed');
    assert.ok(!found.has('hot-cache-load.mjs'), 'hot-cache NOT installed');
  });

  test('--select accepts basenames with or without .mjs extension', () => {
    const r = runScript(['--install-hooks', '--select', 'vault-link-linter.mjs']);
    assert.equal(r.status, 0, r.stderr);
    const stopBlocks = r.settings.hooks?.Stop || [];
    const allCommands = stopBlocks.flatMap((b) => (b.hooks || []).map((h) => h.command));
    assert.ok(allCommands.some((c) => c.includes('vault-link-linter.mjs')), 'matched .mjs form');
  });

  test('--select fails clearly when name is missing or starts with --', () => {
    const r = runScript(['--install-hooks', '--select']);
    assert.notEqual(r.status, 0);
    assert.match((r.stdout || '') + (r.stderr || ''), /--select requires/);
  });

  test('command paths use forward slashes (Windows-safe JSON)', () => {
    const r = runScript(['--install-hooks']);
    assert.equal(r.status, 0);
    for (const event of Object.keys(r.settings.hooks)) {
      for (const block of r.settings.hooks[event]) {
        for (const entry of block.hooks) {
          assert.ok(
            !entry.command.includes('\\'),
            `command should use forward slashes only: ${entry.command}`,
          );
        }
      }
    }
  });

  test('placeholder <router-repo> is replaced with the actual router path', () => {
    const r = runScript(['--install-hooks']);
    assert.equal(r.status, 0);
    const allCommands = Object.values(r.settings.hooks).flat()
      .flatMap((b) => (b.hooks || []).map((h) => h.command));
    for (const cmd of allCommands) {
      assert.ok(!cmd.includes('<router-repo>'), `placeholder not replaced: ${cmd}`);
    }
  });
});

// ---------------------------------------------------------------------------
// --uninstall-hooks
// ---------------------------------------------------------------------------

describe('setup-vault.mjs --uninstall-hooks', () => {
  test('removes all router hooks but preserves user-defined hooks', () => {
    // First install router hooks
    const installRes = runScript(['--install-hooks']);
    assert.equal(installRes.status, 0);

    // Add a user-defined hook manually
    const userHookSettings = JSON.parse(JSON.stringify(installRes.settings));
    userHookSettings.hooks.Stop = userHookSettings.hooks.Stop || [];
    userHookSettings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: 'node /home/user/my-custom-hook.mjs' }],
    });
    fs.writeFileSync(
      path.join(installRes.homePath, '.claude', 'settings.json'),
      JSON.stringify(userHookSettings, null, 2),
    );

    // Uninstall router hooks
    const uninstallRes = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--uninstall-hooks'],
      { encoding: 'utf8', env: { ...process.env, HOME: installRes.homePath, USERPROFILE: installRes.homePath } },
    );
    assert.equal(uninstallRes.status, 0, uninstallRes.stderr);

    const after = JSON.parse(
      fs.readFileSync(path.join(installRes.homePath, '.claude', 'settings.json'), 'utf8'),
    );

    // User custom hook should still be present
    assert.ok(after.hooks, 'hooks section preserved');
    const allCommands = Object.values(after.hooks).flat()
      .flatMap((b) => (b.hooks || []).map((h) => h.command));
    assert.ok(allCommands.some((c) => c.includes('my-custom-hook.mjs')), 'user hook preserved');
    // No router hooks should remain
    assert.ok(
      !allCommands.some((c) => c.includes('obsidian-mcp-router/hooks/')),
      'all router hooks removed',
    );
  });

  test('cleans up empty hooks object when no user hooks remain', () => {
    const installRes = runScript(['--install-hooks']);
    assert.equal(installRes.status, 0);
    const uninstallRes = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--uninstall-hooks'],
      { encoding: 'utf8', env: { ...process.env, HOME: installRes.homePath, USERPROFILE: installRes.homePath } },
    );
    assert.equal(uninstallRes.status, 0);
    const after = JSON.parse(
      fs.readFileSync(path.join(installRes.homePath, '.claude', 'settings.json'), 'utf8'),
    );
    assert.ok(!after.hooks, 'empty hooks object removed entirely');
  });

  test('reports nothing-to-do when no router hooks were installed', () => {
    const r = runScript(['--uninstall-hooks'], {
      initialSettings: { agentPushNotifEnabled: true },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No router hooks were installed/);
  });
});

// ---------------------------------------------------------------------------
// --hooks-status
// ---------------------------------------------------------------------------

describe('setup-vault.mjs --hooks-status', () => {
  test('reports all hooks inactive on empty settings', () => {
    const r = runScript(['--hooks-status']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /inactive/);
    assert.match(r.stdout, /vault-link-linter\.mjs/);
    assert.doesNotMatch(r.stdout, /All router hooks active/);
  });

  test('reports all hooks active after --install-hooks', () => {
    const installRes = runScript(['--install-hooks']);
    assert.equal(installRes.status, 0);
    const statusRes = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--hooks-status'],
      { encoding: 'utf8', env: { ...process.env, HOME: installRes.homePath, USERPROFILE: installRes.homePath } },
    );
    assert.equal(statusRes.status, 0, statusRes.stderr);
    assert.match(statusRes.stdout, /All router hooks active/);
    assert.doesNotMatch(statusRes.stdout, /○ inactive/);
  });

  test('reports mixed active/inactive after --install-hooks --select subset', () => {
    const installRes = runScript(['--install-hooks', '--select', 'vault-link-linter']);
    assert.equal(installRes.status, 0);
    const statusRes = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--hooks-status'],
      { encoding: 'utf8', env: { ...process.env, HOME: installRes.homePath, USERPROFILE: installRes.homePath } },
    );
    assert.equal(statusRes.status, 0, statusRes.stderr);
    // vault-link-linter should be active, others inactive
    const stdout = statusRes.stdout;
    const linterLine = stdout.split('\n').find((l) => l.includes('vault-link-linter.mjs'));
    const autocommitLine = stdout.split('\n').find((l) => l.includes('wiki-autocommit.mjs'));
    assert.ok(linterLine && linterLine.includes('active'), `linter line: ${linterLine}`);
    assert.ok(autocommitLine && autocommitLine.includes('inactive'), `autocommit line: ${autocommitLine}`);
  });
});
