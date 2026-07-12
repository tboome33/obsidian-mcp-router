/**
 * Tests for hooks/hot-cache-load.mjs (v0.11.6 dual-mode extension).
 *
 * Two modes covered:
 *   - cwd-is-vault: cwd has wiki-meta/hot.md → print it (original behavior)
 *   - workspace-bound: cwd has no wiki-meta/, but workspace .env sets
 *     OBSIDIAN_ROUTER_DEFAULT_VAULT pointing to a configured vault that
 *     has wiki-meta/hot.md → print THAT, prefixed with a marker comment
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
let vaultDir;          // a real vault (has wiki-meta/index.md + wiki-meta/hot.md)
let codeWorkspace;     // a code workspace (no wiki-meta/) — will be linked to vaultDir via .env
let plainCwd;          // non-vault, non-bound — should be silent
let configPath;        // router config registering vaultDir

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-cache-load-'));

  vaultDir = path.join(workDir, 'my-vault');
  fs.mkdirSync(path.join(vaultDir, 'wiki-meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'index.md'), '# Index\n');
  fs.writeFileSync(path.join(vaultDir, 'wiki-meta', 'hot.md'), '## Recent\n\n- did X\n- planning Y\n');

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
  test('prints wiki-meta/hot.md when cwd IS the vault', () => {
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

  test('silent when associated vault has no wiki-meta/hot.md (but has wiki-meta/index.md)', () => {
    // Create another vault with wiki-meta/index.md but no hot.md yet
    const noHotVault = path.join(workDir, 'no-hot-vault');
    fs.mkdirSync(path.join(noHotVault, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(noHotVault, 'wiki-meta', 'index.md'), '# Index\n');

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

  test('cwd-is-vault takes precedence when cwd ALSO has wiki-meta/ (no double-load)', () => {
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

// ---------------------------------------------------------------------------
// size discipline (v0.44.0) — bounded injection + oversize banner
// ---------------------------------------------------------------------------

describe('hot-cache-load — size discipline (v0.44.0)', () => {
  let bigVault;

  before(() => {
    bigVault = path.join(workDir, 'big-vault');
    fs.mkdirSync(path.join(bigVault, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(bigVault, 'wiki-meta', 'index.md'), '# Index\n');
    // Newest-first oversized hot: > 500 words across dated entries.
    const entries = [];
    for (let i = 0; i < 80; i++) {
      const day = String(Math.max(1, 28 - i)).padStart(2, '0');
      const tok = i === 0 ? 'TOKEN-NEWEST' : i === 79 ? 'TOKEN-OLDEST' : `fait-${i}`;
      entries.push(
        `> 🆕 **Entrée ${i}** (2026-06-${day}) — ${tok} lorem ipsum dolor sit amet consectetur adipiscing elit sed do`,
      );
    }
    const big = `---\ntype: wiki-hot\n---\n\n# Hot\n\n${entries.join('\n\n')}\n`;
    fs.writeFileSync(path.join(bigVault, 'wiki-meta', 'hot.md'), big);
  });

  test('oversized hot → banner + bounded newest-side excerpt', () => {
    const r = runHook({ cwd: bigVault });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /HORS LIMITE/);
    assert.match(r.stdout, /hot-compact/);
    assert.match(r.stdout, /TOKEN-NEWEST/);
    assert.doesNotMatch(r.stdout, /TOKEN-OLDEST/);
    assert.match(r.stdout, /omis/);
    // Bounded: ≤ the 6 KiB injection budget + banner/marker allowance —
    // regardless of how big the raw file is.
    const outBytes = Buffer.byteLength(r.stdout, 'utf8');
    assert.ok(outBytes <= 6144 + 900, `output ${outBytes} bytes exceeds budget+allowance`);
  });

  test('within-limits hot is injected verbatim without banner (regression)', () => {
    const r = runHook({ cwd: vaultDir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /did X/);
    assert.doesNotMatch(r.stdout, /HORS LIMITE/);
    assert.doesNotMatch(r.stdout, /omis/);
  });

  test('frontmatter override raises the limit (no banner under 800 words)', () => {
    const midVault = path.join(workDir, 'mid-vault');
    fs.mkdirSync(path.join(midVault, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(midVault, 'wiki-meta', 'index.md'), '# Index\n');
    // ~600 words: over the 500 default, under an 800 override.
    const words = Array.from({ length: 600 }, (_, i) => `mot${i}`).join(' ');
    fs.writeFileSync(
      path.join(midVault, 'wiki-meta', 'hot.md'),
      `---\nhot-limit-words: 800\n---\n\n# Hot\n\n${words}\n`,
    );
    const r = runHook({ cwd: midVault });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /HORS LIMITE/);
    assert.match(r.stdout, /mot599/);
  });
});
