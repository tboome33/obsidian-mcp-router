/**
 * Tests for hooks/hot-cache-load.mjs (v0.11.6 dual-mode extension).
 *
 * Two modes covered:
 *   - cwd-is-vault: cwd has wiki/hot.md → print it (original behavior)
 *   - workspace-bound: cwd has no wiki/, but workspace .env sets
 *     OBSIDIAN_ROUTER_DEFAULT_VAULT pointing to a configured vault that
 *     has wiki/hot.md → print THAT, prefixed with a marker comment
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
const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'hot-cache-load.mjs');

let workDir;
let vaultDir;          // a real vault (has wiki/index.md + wiki/hot.md)
let codeWorkspace;     // a code workspace (no wiki/) — will be linked to vaultDir via .env
let plainCwd;          // non-vault, non-bound — should be silent
let configPath;        // router config registering vaultDir

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-cache-load-'));

  vaultDir = path.join(workDir, 'my-vault');
  fs.mkdirSync(path.join(vaultDir, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'wiki', 'index.md'), '# Index\n');
  fs.writeFileSync(path.join(vaultDir, 'wiki', 'hot.md'), '## Recent\n\n- did X\n- planning Y\n');

  codeWorkspace = path.join(workDir, 'code-workspace');
  fs.mkdirSync(codeWorkspace, { recursive: true });

  plainCwd = path.join(workDir, 'plain');
  fs.mkdirSync(plainCwd, { recursive: true });

  configPath = path.join(workDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: { [vaultDir]: 27999 },
  }, null, 2));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Run the hook. Optional `stdinCwd` overrides what we pass as the cwd
 * field in the stdin JSON payload (mimics SessionStart input).
 * Optional `env` overrides env vars. `workspaceDotenv` writes a .env in
 * the relevant workspace.
 */
function runHook({
  cwd = plainCwd,
  stdinCwd = null,
  env = {},
  workspaceDotenv = null,
} = {}) {
  if (workspaceDotenv !== null) {
    fs.writeFileSync(path.join(cwd, '.env'), workspaceDotenv);
  } else {
    // Clean any existing .env from prior test
    const envFile = path.join(cwd, '.env');
    if (fs.existsSync(envFile)) fs.unlinkSync(envFile);
  }
  const stdin = JSON.stringify({
    hook_event_name: 'SessionStart',
    cwd: stdinCwd === null ? cwd : stdinCwd,
    session_id: 'test',
  });
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      OBSIDIAN_ROUTER_CONFIG: configPath,
      ...env,
    },
    timeout: 10000,
  });
}

// ---------------------------------------------------------------------------
// cwd-is-vault mode (regression — preserve original behavior)
// ---------------------------------------------------------------------------

describe('hot-cache-load — cwd-is-vault mode', () => {
  test('prints wiki/hot.md when cwd IS the vault', () => {
    const r = runHook({ cwd: vaultDir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /## Recent/);
    assert.match(r.stdout, /did X/);
    // No workspace-bound marker (this is cwd-is-vault mode)
    assert.doesNotMatch(r.stdout, /workspace-bound mode/);
  });

  test('exits silent when cwd is non-vault AND no .env link', () => {
    const r = runHook({ cwd: plainCwd });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
  });

  test('stdin cwd field overrides process.cwd fallback', () => {
    // Pass plainCwd as the spawn cwd but vaultDir as stdin cwd
    const stdin = JSON.stringify({ cwd: vaultDir });
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath },
      cwd: plainCwd,
      timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /did X/);
  });
});

// ---------------------------------------------------------------------------
// workspace-bound mode (v0.11.6 new)
// ---------------------------------------------------------------------------

describe('hot-cache-load — workspace-bound mode (v0.11.6)', () => {
  test('reads associated vault\'s hot.md when workspace .env links it', () => {
    const r = runHook({
      cwd: codeWorkspace,
      workspaceDotenv: `OBSIDIAN_ROUTER_DEFAULT_VAULT="my-vault"\n`,
    });
    assert.equal(r.status, 0, r.stderr);
    // Should contain the hot.md content
    assert.match(r.stdout, /did X/);
    // AND the workspace-bound marker
    assert.match(r.stdout, /workspace-bound mode/);
    assert.match(r.stdout, /my-vault/);
  });

  test('marker mentions both cwd and associated vault path', () => {
    const r = runHook({
      cwd: codeWorkspace,
      workspaceDotenv: `OBSIDIAN_ROUTER_DEFAULT_VAULT="my-vault"\n`,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code-workspace/); // cwd in marker
    assert.match(r.stdout, /my-vault/);       // vault path/slug in marker
  });

  test('marker tells Claude to use mcp__obsidian-router__get_file for other vault files', () => {
    const r = runHook({
      cwd: codeWorkspace,
      workspaceDotenv: `OBSIDIAN_ROUTER_DEFAULT_VAULT="my-vault"\n`,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /mcp__obsidian-router__get_file/);
  });

  test('silent when .env links to a slug not in portRegistry', () => {
    const r = runHook({
      cwd: codeWorkspace,
      workspaceDotenv: `OBSIDIAN_ROUTER_DEFAULT_VAULT="nonexistent-vault"\n`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
  });

  test('silent when env var set via process.env (not .env file)', () => {
    // process.env should also work — the .env autoload is additive, not
    // exclusive. Here we test the env-var-only path (no .env file).
    const r = runHook({
      cwd: codeWorkspace,
      env: { OBSIDIAN_ROUTER_DEFAULT_VAULT: 'my-vault' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /did X/);
    assert.match(r.stdout, /workspace-bound mode/);
  });

  test('silent when associated vault has no wiki/hot.md (but has wiki/index.md)', () => {
    // Create another vault with wiki/index.md but no hot.md yet
    const noHotVault = path.join(workDir, 'no-hot-vault');
    fs.mkdirSync(path.join(noHotVault, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(noHotVault, 'wiki', 'index.md'), '# Index\n');

    const otherConfig = path.join(workDir, 'no-hot-config.json');
    fs.writeFileSync(otherConfig, JSON.stringify({
      portRegistry: { [noHotVault]: 28000 },
    }));

    try {
      const r = runHook({
        cwd: codeWorkspace,
        workspaceDotenv: `OBSIDIAN_ROUTER_DEFAULT_VAULT="no-hot-vault"\n`,
        env: { OBSIDIAN_ROUTER_CONFIG: otherConfig },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), '');
    } finally {
      fs.rmSync(noHotVault, { recursive: true, force: true });
      fs.unlinkSync(otherConfig);
    }
  });

  test('cwd-is-vault takes precedence when cwd ALSO has wiki/ (no double-load)', () => {
    // If somehow both conditions are true (cwd is a vault AND .env
    // links to another), cwd-is-vault wins (more specific). No marker.
    const r = runHook({
      cwd: vaultDir,
      workspaceDotenv: `OBSIDIAN_ROUTER_DEFAULT_VAULT="my-vault"\n`,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /did X/);
    assert.doesNotMatch(r.stdout, /workspace-bound mode/);
  });
});
