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

import { canonicalWorkspaceKey } from '../src/helpers/workspace-bindings.mjs';

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
  binding = null,
  disabled = null,
} = {}) {
  if (workspaceDotenv !== null) {
    fs.writeFileSync(path.join(cwd, '.env'), workspaceDotenv);
  } else {
    // Clean any existing .env from prior test
    const envFile = path.join(cwd, '.env');
    if (fs.existsSync(envFile)) fs.unlinkSync(envFile);
  }
  // The config is rewritten per run so a binding can be added or removed.
  // Since v0.90.0 the binding — not the workspace `.env` — is what puts this
  // hook in workspace-bound mode.
  fs.writeFileSync(configPath, JSON.stringify({
    portRegistry: { [vaultDir]: 27999 },
    ...(binding ? { workspaceBindings: { [canonicalWorkspaceKey(cwd)]: binding } } : {}),
    ...(disabled ? { disabledVaults: disabled } : {}),
  }, null, 2));
  const stdin = JSON.stringify({
    hook_event_name: 'SessionStart',
    cwd: stdinCwd === null ? cwd : stdinCwd,
    session_id: 'test',
  });
  // The developer's own shell carries OBSIDIAN_ROUTER_* variables, and these
  // tests now turn on WHERE a value came from — an ambient one would decide
  // the outcome for a reason unrelated to the code.
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) {
    if (k.startsWith('OBSIDIAN_ROUTER_') || k === 'VAULT_PATH') delete clean[k];
  }
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...clean,
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
  test('reads the associated vault\'s hot.md when a CONFIRMED BINDING links it', () => {
    const r = runHook({ cwd: codeWorkspace, binding: { vault: 'my-vault' } });
    assert.equal(r.status, 0, r.stderr);
    // Should contain the hot.md content
    assert.match(r.stdout, /did X/);
    // AND the workspace-bound marker
    assert.match(r.stdout, /workspace-bound mode/);
    assert.match(r.stdout, /my-vault/);
  });

  test('a workspace that IS a vault but is BOUND elsewhere follows the binding — hooks and server agree', () => {
    // Round 2 of the Codex review: `detectVaultContext` returned
    // `cwd-is-vault` before reading the binding, so a workspace carrying its
    // own catalog but explicitly bound to another vault had the server
    // defaulting to the binding while this hook injected the cwd's hot.md.
    // Two answers to one question, from one config.
    const selfVault = path.join(workDir, 'self-vault');
    fs.mkdirSync(path.join(selfVault, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(selfVault, 'wiki-meta', 'catalog.md'), '# Self\n');
    fs.writeFileSync(path.join(selfVault, 'wiki-meta', 'hot.md'), '## Recent\n\n- SELF CONTENT\n');
    const r = runHook({ cwd: selfVault, binding: { vault: 'my-vault' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /did X/, 'the BOUND vault\'s hot.md');
    assert.doesNotMatch(r.stdout, /SELF CONTENT/, 'not the cwd\'s own');
    assert.match(r.stdout, /workspace-bound mode/);
  });

  test('a binding to a DISABLED vault is ignored, exactly as the cascade ignores it', () => {
    // Otherwise the server falls through to another vault while this hook
    // injects the disabled one's notes — two answers to "which vault is this
    // session on", from one config. Codex, merge review.
    const r = runHook({
      cwd: codeWorkspace,
      binding: { vault: 'my-vault' },
      disabled: ['my-vault'],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
  });

  test('a workspace .env alone is REFUSED — this hook injects a vault\'s notes into the session', () => {
    // One of the four resolvers swept for the Codex finding of 2026-09-03,
    // and the one with the widest blast radius: whatever vault this hook
    // picks has its `hot.md` read straight into Claude's context. A cloned
    // repository choosing that was the confused-deputy hole the accepted
    // decision exists to close, and fixing only the resolution cascade would
    // have left it open while reading as closed.
    const r = runHook({
      cwd: codeWorkspace,
      workspaceDotenv: `OBSIDIAN_ROUTER_DEFAULT_VAULT="my-vault"\n`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '', 'a project file may propose a vault; it may not have its notes injected');
  });

  test('marker mentions both cwd and associated vault path', () => {
    const r = runHook({ cwd: codeWorkspace, binding: { vault: 'my-vault' } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code-workspace/); // cwd in marker
    assert.match(r.stdout, /my-vault/);       // vault path/slug in marker
  });

  test('marker tells Claude to use mcp__obsidian-router__get_file for other vault files', () => {
    const r = runHook({ cwd: codeWorkspace, binding: { vault: 'my-vault' } });
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

  test('OBSIDIAN_ROUTER_ALLOWED_VAULTS excludes the HOST default too, not only a binding', () => {
    // The whitelist NARROWS what the server serves. A hook whose idea of
    // "registered" ignored it was WIDER than the server's — so with
    // `OBSIDIAN_ROUTER_ALLOWED_VAULTS` naming another vault and a host default
    // of `my-vault`, this hook loaded and injected `my-vault`'s notes into a
    // session that is not allowed to reach it, while the server answered from
    // somewhere else entirely. The whitelist check had been added at the
    // BINDING tier and stopped there. (Codex, round 5.)
    const r = runHook({
      cwd: codeWorkspace,
      env: {
        OBSIDIAN_ROUTER_DEFAULT_VAULT: 'my-vault',
        OBSIDIAN_ROUTER_ALLOWED_VAULTS: 'some-other-vault',
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '', 'a vault outside the isolation boundary is not loaded');
  });

  test('and the whitelist does not gag a vault it ALLOWS — the guard narrows nothing else', () => {
    const r = runHook({
      cwd: codeWorkspace,
      env: {
        OBSIDIAN_ROUTER_DEFAULT_VAULT: 'my-vault',
        OBSIDIAN_ROUTER_ALLOWED_VAULTS: 'my-vault,some-other-vault',
      },
    });
    assert.equal(r.status, 0, r.stderr);
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
    // Bounded: banner + excerpt together fit the injection budget
    // (absoluteCapTokens×4 ≈ 7200 B) — the banner's bytes come OUT of the
    // budget since the codex review fix, they no longer ride on top of it.
    // The only bytes outside the budget are the short provenance frame
    // (≈300 B in cwd-is-vault mode), hence the small allowance.
    const outBytes = Buffer.byteLength(r.stdout, 'utf8');
    assert.ok(outBytes <= 7200 + 500, `output ${outBytes} bytes exceeds budget+frame allowance`);
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
