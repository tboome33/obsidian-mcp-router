/**
 * Tests for `setup-vault.mjs --migrate-wiki-meta <vault>` and
 * `--migrate-all-wiki-meta` (v0.12.1).
 *
 * Strategy: spawn the script as a subprocess against temp vault fixtures.
 * Each test creates a fresh temp dir with a known starting state (legacy,
 * already-migrated, partial, empty), runs the script, and asserts on:
 *   - exit code (0 success, 1 on any vault failure in batch mode)
 *   - filesystem outcome (wiki-meta/ populated, wiki/<scaffold>.md absent)
 *   - CLAUDE.md path rewrites
 *   - log.md append (migration line present after success)
 *   - idempotency (re-running on `fresh` is a no-op)
 *
 * Git path: we use `git init` in some fixtures to verify the git-mv branch.
 * The plain rename branch is covered by fixtures WITHOUT `.git/`.
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-wm-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Create a temp vault in one of 4 states.
 *   - 'legacy':   wiki/<4 scaffolds> exist, no wiki-meta/
 *   - 'fresh':    wiki-meta/<4 scaffolds> exist, no wiki/<scaffold>
 *   - 'partial':  hot.md in wiki-meta/, the other 3 still in wiki/ (mixed)
 *   - 'empty':    neither wiki/ nor wiki-meta/ scaffolds present
 *
 * `withGit: true` adds a `.git/` placeholder OR runs `git init` for real
 * (depending on `realGit`). Real git lets us assert the `git mv` branch
 * actually staged the rename.
 */
function makeVault(state, { withGit = false, realGit = false, claudeMd = null } = {}) {
  const vp = fs.mkdtempSync(path.join(workDir, `${state}-`));
  if (state === 'legacy' || state === 'partial') {
    fs.mkdirSync(path.join(vp, 'wiki'), { recursive: true });
    for (const f of ['hot.md', 'index.md', 'log.md', 'overview.md']) {
      if (state === 'partial' && f === 'hot.md') continue;
      fs.writeFileSync(path.join(vp, 'wiki', f), `# ${f}\n`);
    }
  }
  if (state === 'fresh' || state === 'partial') {
    fs.mkdirSync(path.join(vp, 'wiki-meta'), { recursive: true });
    if (state === 'fresh') {
      for (const f of ['hot.md', 'index.md', 'log.md', 'overview.md']) {
        fs.writeFileSync(path.join(vp, 'wiki-meta', f), `# ${f}\n`);
      }
    } else {
      // partial: hot.md is already in wiki-meta/, the others still under wiki/
      fs.writeFileSync(path.join(vp, 'wiki-meta', 'hot.md'), `# hot.md\n`);
    }
  }
  if (claudeMd !== null) {
    fs.writeFileSync(path.join(vp, 'CLAUDE.md'), claudeMd);
  }
  if (withGit) {
    if (realGit) {
      // Real git init + add + commit so subsequent `git mv` has a HEAD.
      // Skip silently if git isn't installed (CI without git is unusual but
      // possible — these specific tests just won't cover the git-mv branch).
      const init = spawnSync('git', ['-C', vp, 'init', '-q'], { encoding: 'utf8' });
      if (init.status !== 0) return vp;
      spawnSync('git', ['-C', vp, 'config', 'user.email', 'test@test'], { encoding: 'utf8' });
      spawnSync('git', ['-C', vp, 'config', 'user.name', 'test'], { encoding: 'utf8' });
      spawnSync('git', ['-C', vp, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf8' });
      spawnSync('git', ['-C', vp, 'add', '.'], { encoding: 'utf8' });
      spawnSync('git', ['-C', vp, 'commit', '-m', 'initial', '-q'],
        { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_COMMITTER_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_EMAIL: 't@t' } });
    } else {
      // Just a `.git/` placeholder dir — enough to trigger the `vaultIsGitRepo`
      // branch in the script, but the `git mv` call will fail (no actual git
      // repo). Used by tests that want to verify the error path.
      fs.mkdirSync(path.join(vp, '.git'), { recursive: true });
    }
  }
  return vp;
}

/**
 * Spawn the script with the given args. Returns the result + parsed
 * stdout/stderr. Always pipes; never inherits.
 */
function runScript(...scriptArgs) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...scriptArgs], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

describe('migrate-wiki-meta — single vault, legacy → migrated', () => {
  test('plain rename (no git): moves 4 scaffolds + wiki-meta dir created', () => {
    const vp = makeVault('legacy');
    const r = runScript('--migrate-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    // wiki-meta/ now has the 4 scaffolds
    for (const f of ['hot.md', 'index.md', 'log.md', 'overview.md']) {
      assert.ok(fs.existsSync(path.join(vp, 'wiki-meta', f)),
        `${f} should exist under wiki-meta/`);
      assert.ok(!fs.existsSync(path.join(vp, 'wiki', f)),
        `${f} should NOT exist under wiki/ anymore`);
    }
    // log.md got a migration entry appended
    const log = fs.readFileSync(path.join(vp, 'wiki-meta', 'log.md'), 'utf8');
    assert.match(log, /wiki-meta migration/, 'log.md should record the migration');
    assert.match(log, /v0\.12\.1/);
  });

  test('CLAUDE.md scaffold paths get rewritten', () => {
    const claudeMd = (
      `# Vault rules\n\n` +
      `1. Read wiki/hot.md first.\n` +
      `2. Then wiki/index.md.\n` +
      `3. Append to wiki/log.md.\n` +
      `4. Overview at wiki/overview.md.\n` +
      `5. User content still under wiki/Concepts/ — DO NOT rewrite this.\n`
    );
    const vp = makeVault('legacy', { claudeMd });
    const r = runScript('--migrate-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const after = fs.readFileSync(path.join(vp, 'CLAUDE.md'), 'utf8');
    assert.match(after, /wiki-meta\/hot\.md/);
    assert.match(after, /wiki-meta\/index\.md/);
    assert.match(after, /wiki-meta\/log\.md/);
    assert.match(after, /wiki-meta\/overview\.md/);
    // User content path preserved
    assert.match(after, /wiki\/Concepts\//);
    // No remaining stale scaffold path
    assert.doesNotMatch(after, /wiki\/(hot|index|log|overview)\.md/);
  });

  test('git mv branch: rename is staged in the git index', () => {
    const vp = makeVault('legacy', { withGit: true, realGit: true });
    // Skip the assertion if real git wasn't available — tested by checking
    // whether the initial commit actually exists.
    const log = spawnSync('git', ['-C', vp, 'log', '-1', '--oneline'], { encoding: 'utf8' });
    if (log.status !== 0) {
      console.log('  [skipped — git not available]');
      return;
    }
    const r = runScript('--migrate-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    // After git mv, `git status --porcelain` should show 4 renames (R) staged
    const status = spawnSync('git', ['-C', vp, 'status', '--porcelain'], { encoding: 'utf8' });
    const renames = (status.stdout.match(/^R/gm) || []).length;
    assert.equal(renames, 4, `expected 4 staged renames, got status:\n${status.stdout}`);
  });
});

describe('migrate-wiki-meta — single vault, edge states', () => {
  test('fresh: already migrated — exits 0, no changes', () => {
    const vp = makeVault('fresh');
    const beforeFresh = fs.readdirSync(path.join(vp, 'wiki-meta'));
    const r = runScript('--migrate-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const afterFresh = fs.readdirSync(path.join(vp, 'wiki-meta'));
    assert.deepEqual(afterFresh.sort(), beforeFresh.sort());
    assert.match(r.stdout, /already on wiki-meta/);
  });

  test('partial state: refuses, exits non-zero with diagnostic', () => {
    const vp = makeVault('partial');
    const r = runScript('--migrate-wiki-meta', vp);
    assert.notEqual(r.status, 0);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /PARTIAL migration state/i);
  });

  test('empty: nothing to migrate — exits 0 with explanatory note', () => {
    const vp = makeVault('empty');
    const r = runScript('--migrate-wiki-meta', vp);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /never bootstrapped/i);
  });

  test('non-existent path: fails with clear message', () => {
    const ghost = path.join(workDir, 'ghost-vault-' + Math.random());
    const r = runScript('--migrate-wiki-meta', ghost);
    assert.notEqual(r.status, 0);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /does not exist|not a directory/i);
  });

  test('missing vault path arg: fails with usage', () => {
    const r = runScript('--migrate-wiki-meta');
    assert.notEqual(r.status, 0);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /requires a vault path/i);
  });
});

describe('migrate-wiki-meta — dry-run', () => {
  test('--dry-run does not touch filesystem but reports counts', () => {
    const vp = makeVault('legacy', { claudeMd: '# x\nwiki/hot.md\nwiki/index.md\n' });
    const r = runScript('--migrate-wiki-meta', vp, '--dry-run');
    assert.equal(r.status, 0);
    // Scaffolds still in wiki/
    for (const f of ['hot.md', 'index.md', 'log.md', 'overview.md']) {
      assert.ok(fs.existsSync(path.join(vp, 'wiki', f)));
      assert.ok(!fs.existsSync(path.join(vp, 'wiki-meta', f)));
    }
    // CLAUDE.md unchanged
    const c = fs.readFileSync(path.join(vp, 'CLAUDE.md'), 'utf8');
    assert.match(c, /wiki\/hot\.md/);
    assert.match(c, /wiki\/index\.md/);
    // Output mentions DRY-RUN
    assert.match(r.stdout, /DRY-RUN/);
  });
});

describe('migrate-wiki-meta — multi-location CLAUDE.md (v0.12.2)', () => {
  test('rewrites scaffold paths in <vault>/wiki-meta/CLAUDE.md (Roland layout)', () => {
    // Roland's vaults often have CLAUDE.md UNDER wiki-meta/, not at root.
    // v0.12.2's findClaudeMdCandidates should still find + rewrite it.
    const vp = makeVault('legacy');
    // Move CLAUDE.md into wiki-meta/ to simulate Roland's layout. Note:
    // makeVault doesn't create CLAUDE.md by default; we need to place one
    // explicitly under wiki-meta/ (which will exist after migration creates
    // it). Easier: write a wiki-meta/CLAUDE.md upfront — the script will
    // mkdir-p the dir.
    fs.mkdirSync(path.join(vp, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(vp, 'wiki-meta', 'CLAUDE.md'),
      `# Vault rules\n\nRead wiki/hot.md.\nThen wiki/index.md.\n`);

    const r = runScript('--migrate-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const after = fs.readFileSync(path.join(vp, 'wiki-meta', 'CLAUDE.md'), 'utf8');
    assert.match(after, /wiki-meta\/hot\.md/);
    assert.match(after, /wiki-meta\/index\.md/);
    assert.doesNotMatch(after, /wiki\/(hot|index)\.md/);
  });

  test('rewrites scaffold paths in <vault>/Documentation/CLAUDE.md', () => {
    // Other Roland vaults have CLAUDE.md under Documentation/.
    const vp = makeVault('legacy');
    fs.mkdirSync(path.join(vp, 'Documentation'), { recursive: true });
    fs.writeFileSync(path.join(vp, 'Documentation', 'CLAUDE.md'),
      `# Docs\n\nFile to wiki/log.md after each session.\n`);

    const r = runScript('--migrate-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const after = fs.readFileSync(path.join(vp, 'Documentation', 'CLAUDE.md'), 'utf8');
    assert.match(after, /wiki-meta\/log\.md/);
    assert.doesNotMatch(after, /wiki\/log\.md/);
  });

  test('rewrites across MULTIPLE CLAUDE.md copies in one run', () => {
    // Edge case: vault has CLAUDE.md at BOTH root AND wiki-meta/. Both get
    // rewritten in the same migration; reported count is the sum.
    const claudeMdContent = `# x\nwiki/hot.md\nwiki/index.md\n`;
    const vp = makeVault('legacy', { claudeMd: claudeMdContent });
    fs.mkdirSync(path.join(vp, 'wiki-meta'), { recursive: true });
    fs.writeFileSync(path.join(vp, 'wiki-meta', 'CLAUDE.md'), claudeMdContent);

    const r = runScript('--migrate-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    // Total replacement count in output should be 4 (2 per file × 2 files)
    assert.match(r.stdout, /rewrote 4 CLAUDE\.md path/);
    // Both files updated
    for (const p of [path.join(vp, 'CLAUDE.md'), path.join(vp, 'wiki-meta', 'CLAUDE.md')]) {
      const after = fs.readFileSync(p, 'utf8');
      assert.match(after, /wiki-meta\/hot\.md/);
      assert.doesNotMatch(after, /wiki\/hot\.md/);
    }
  });
});

describe('migrate-wiki-meta — idempotency + force', () => {
  test('re-running on migrated vault is silent no-op', () => {
    const vp = makeVault('legacy');
    runScript('--migrate-wiki-meta', vp);  // first run
    const r2 = runScript('--migrate-wiki-meta', vp);  // second run
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /already on wiki-meta/);
  });

  test('--force on already-migrated vault re-rewrites CLAUDE.md', () => {
    // Start: already on wiki-meta layout BUT CLAUDE.md still has stale paths
    // (simulating a previous migration that crashed before the CLAUDE.md edit).
    const claudeMd = '# x\nwiki/hot.md\nwiki/overview.md\n';
    const vp = makeVault('fresh', { claudeMd });
    const r = runScript('--migrate-wiki-meta', vp, '--force');
    assert.equal(r.status, 0);
    const after = fs.readFileSync(path.join(vp, 'CLAUDE.md'), 'utf8');
    assert.match(after, /wiki-meta\/hot\.md/);
    assert.match(after, /wiki-meta\/overview\.md/);
    assert.doesNotMatch(after, /wiki\/(hot|overview)\.md/);
  });
});

describe('migrate-all-wiki-meta — batch mode', () => {
  let batchWorkDir;
  let batchConfigPath;
  let vaultLegacy;
  let vaultFresh;
  let vaultEmpty;

  before(() => {
    batchWorkDir = fs.mkdtempSync(path.join(workDir, 'batch-'));
    vaultLegacy = makeVault('legacy');
    vaultFresh = makeVault('fresh');
    vaultEmpty = makeVault('empty');
    batchConfigPath = path.join(batchWorkDir, 'config.json');
    fs.writeFileSync(batchConfigPath, JSON.stringify({
      portRegistry: {
        [vaultLegacy]: 27100,
        [vaultFresh]:  27101,
        [vaultEmpty]:  27102,
      },
    }));
  });

  function runBatch(...flags) {
    return spawnSync(process.execPath, [SCRIPT_PATH, '--migrate-all-wiki-meta', ...flags], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: batchConfigPath },
      timeout: 30000,
    });
  }

  test('batch reports per-vault status + non-zero exit only on real failure', () => {
    const r = runBatch();
    assert.equal(r.status, 0, r.stderr || r.stdout);
    // Summary mentions each bucket
    assert.match(r.stdout, /migrated:\s*1/);
    assert.match(r.stdout, /already-migrated:\s*1/);
    assert.match(r.stdout, /skipped \(empty\):\s*1/);
    // Legacy vault was migrated
    assert.ok(fs.existsSync(path.join(vaultLegacy, 'wiki-meta', 'hot.md')));
    // Fresh vault untouched
    assert.ok(fs.existsSync(path.join(vaultFresh, 'wiki-meta', 'index.md')));
  });

  test('batch --dry-run leaves everything in place', () => {
    // Reset legacy vault back to legacy state for this test
    const lv = makeVault('legacy');
    const cfg = path.join(batchWorkDir, 'dry-config.json');
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [lv]: 27200 } }));
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--migrate-all-wiki-meta', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 0);
    // Files still in wiki/
    assert.ok(fs.existsSync(path.join(lv, 'wiki', 'hot.md')));
    assert.ok(!fs.existsSync(path.join(lv, 'wiki-meta', 'hot.md')));
    // Output mentions DRY-RUN and "Dry-run only" hint
    assert.match(r.stdout, /DRY-RUN/);
    assert.match(r.stdout, /Dry-run only/);
  });

  test('batch returns exit 1 when any vault is in partial state', () => {
    const lv = makeVault('partial');
    const cfg = path.join(batchWorkDir, 'partial-cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [lv]: 27300 } }));
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--migrate-all-wiki-meta'], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 1);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /failed:\s*1/);
    assert.match(out, /PARTIAL/i);
  });

  test('batch with empty portRegistry fails clearly', () => {
    const cfg = path.join(batchWorkDir, 'empty-cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: {} }));
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--migrate-all-wiki-meta'], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.notEqual(r.status, 0);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /no vaults in portRegistry/i);
  });
});
