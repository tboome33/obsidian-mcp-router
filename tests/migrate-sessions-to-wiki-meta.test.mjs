/**
 * Tests for `setup-vault.mjs --migrate-sessions-to-wiki-meta <vault>` and
 * `--migrate-all-sessions-to-wiki-meta` (v0.12.8).
 *
 * Strategy: spawn the script as a subprocess against temp vault fixtures.
 * Each test creates a fresh temp dir with a known starting state of the
 * `Sessions/` directory (legacy, fresh, both-overlap, empty), runs the
 * script, and asserts on:
 *   - exit code (0 success in single-vault mode, 1 on batch failure)
 *   - filesystem outcome (wiki-meta/Sessions/ populated, wiki/Sessions/ gone)
 *   - log.md append (migration line present after success)
 *   - merge logic (per-file dedup, conflicts left in source)
 *
 * Git path: tested with a real `git init` to verify the `git mv` branch.
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-sessions-'));
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Create a temp vault with a specific Sessions/ state.
 *   - 'legacy':       wiki/Sessions/ with N files, no wiki-meta/Sessions/
 *   - 'fresh':        wiki-meta/Sessions/ with N files, no wiki/Sessions/
 *   - 'both-overlap': both dirs exist, 1 file in common + extras each side
 *   - 'empty':        neither directory exists
 * `withGit: true` runs `git init` for real (lets us assert git mv branch).
 */
function makeVault(state, { withGit = false, filesLegacy = ['2026-05-23-1000-foo.md', '2026-05-23-1100-bar.md', '2026-05-23-1200-baz.md'] } = {}) {
  const vp = fs.mkdtempSync(path.join(workDir, `${state}-`));
  // Always create the wiki-meta/ parent — needed for the log.md side effect
  // and for the migration's wiki-meta/ creation path.
  fs.mkdirSync(path.join(vp, 'wiki-meta'), { recursive: true });
  // Provide a log.md so we can assert the migration line was appended.
  fs.writeFileSync(path.join(vp, 'wiki-meta', 'log.md'), '---\ntype: wiki-log\n---\n\n# Log\n', 'utf8');

  if (state === 'legacy' || state === 'both-overlap') {
    const wikiSessions = path.join(vp, 'wiki', 'Sessions');
    fs.mkdirSync(wikiSessions, { recursive: true });
    for (const f of filesLegacy) {
      fs.writeFileSync(path.join(wikiSessions, f), `---\ntype: session\n---\n\n# ${f}\n`, 'utf8');
    }
  }
  if (state === 'fresh' || state === 'both-overlap') {
    const wmSessions = path.join(vp, 'wiki-meta', 'Sessions');
    fs.mkdirSync(wmSessions, { recursive: true });
    if (state === 'fresh') {
      // 3 distinct fresh files
      for (const f of ['2026-05-24-0900-x.md', '2026-05-24-1000-y.md', '2026-05-24-1100-z.md']) {
        fs.writeFileSync(path.join(wmSessions, f), `---\ntype: session\n---\n\n# ${f}\n`, 'utf8');
      }
    } else {
      // both-overlap: dst has 1 file in common with src (the first one) so
      // merging should detect the conflict and skip it, moving only the 2
      // extras from src.
      const common = filesLegacy[0];
      fs.writeFileSync(path.join(wmSessions, common), `---\ntype: session\n---\n\n# ${common} (dst version)\n`, 'utf8');
    }
  }
  if (withGit) {
    const init = spawnSync('git', ['-C', vp, 'init', '-q'], { encoding: 'utf8' });
    if (init.status !== 0) return vp;
    spawnSync('git', ['-C', vp, 'config', 'user.email', 'test@test'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vp, 'config', 'user.name', 'test'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vp, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vp, 'add', '.'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vp, 'commit', '-m', 'initial', '-q'],
      { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_COMMITTER_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_EMAIL: 't@t' } });
  }
  return vp;
}

function runScript(...scriptArgs) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...scriptArgs], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

describe('migrate-sessions-to-wiki-meta — single vault, legacy → migrated', () => {
  test('plain rename (no git): moves all session files + wiki/Sessions/ removed', () => {
    const vp = makeVault('legacy');
    const r = runScript('--migrate-sessions-to-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const wmSessions = path.join(vp, 'wiki-meta', 'Sessions');
    assert.ok(fs.existsSync(wmSessions), 'wiki-meta/Sessions/ should now exist');
    const moved = fs.readdirSync(wmSessions).filter((f) => f.endsWith('.md'));
    assert.equal(moved.length, 3, 'should have moved all 3 session files');
    // wiki/Sessions/ should be gone (renamed)
    assert.ok(!fs.existsSync(path.join(vp, 'wiki', 'Sessions')), 'wiki/Sessions/ should be removed');
    // log.md should have the migration line
    const log = fs.readFileSync(path.join(vp, 'wiki-meta', 'log.md'), 'utf8');
    assert.match(log, /migrate — wiki\/Sessions\/ → wiki-meta\/Sessions\//);
    assert.match(log, /v0\.12\.8/);
    assert.match(log, /3 sessions/);
  });

  test('git mv branch: rename is staged in the git index', () => {
    const vp = makeVault('legacy', { withGit: true });
    const logCheck = spawnSync('git', ['-C', vp, 'log', '-1', '--oneline'], { encoding: 'utf8' });
    if (logCheck.status !== 0) {
      console.log('  [skipped — git not available]');
      return;
    }
    const r = runScript('--migrate-sessions-to-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    // git mv on a whole directory should produce a rename in status
    const status = spawnSync('git', ['-C', vp, 'status', '--porcelain'], { encoding: 'utf8' });
    // git mv on a directory produces N rename lines of the form
    // "R  wiki/Sessions/<file> -> wiki-meta/Sessions/<file>" — verify all 3
    // files were renamed in the index (vs. deleted+added separately).
    const renames = (status.stdout.match(/^R\s+wiki\/Sessions\/.+ -> wiki-meta\/Sessions\/.+$/gm) || []);
    assert.equal(renames.length, 3, `expected 3 staged renames, got status:\n${status.stdout}`);
  });
});

describe('migrate-sessions-to-wiki-meta — single vault, edge states', () => {
  test('fresh: already-migrated → no-op, exits 0', () => {
    const vp = makeVault('fresh');
    const before = fs.readdirSync(path.join(vp, 'wiki-meta', 'Sessions')).sort();
    const r = runScript('--migrate-sessions-to-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const after = fs.readdirSync(path.join(vp, 'wiki-meta', 'Sessions')).sort();
    assert.deepEqual(after, before, 'wiki-meta/Sessions/ should be unchanged');
    assert.match(r.stdout, /already on wiki-meta\/Sessions/);
  });

  test('both-overlap: merges per-file, skips conflict, removes src dir if empty', () => {
    const vp = makeVault('both-overlap');
    const r = runScript('--migrate-sessions-to-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    // Of the 3 legacy files, the first conflicts (already in dst). 2 should have moved.
    const wmFiles = fs.readdirSync(path.join(vp, 'wiki-meta', 'Sessions')).sort();
    assert.equal(wmFiles.length, 3, 'wiki-meta/Sessions/ should now have 3 files (1 pre-existing + 2 merged)');
    // Source dir still exists because 1 conflict remained
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'Sessions')), 'src dir should remain (1 conflict left)');
    const srcRemaining = fs.readdirSync(path.join(vp, 'wiki', 'Sessions'));
    assert.equal(srcRemaining.length, 1, 'only the conflicting file should remain in wiki/Sessions/');
    // dst should still contain the original dst-version of the conflict (not the src-version)
    const conflictContent = fs.readFileSync(path.join(vp, 'wiki-meta', 'Sessions', srcRemaining[0]), 'utf8');
    assert.match(conflictContent, /\(dst version\)/, 'dst-version of conflict should be preserved (no clobber)');
    // Warning message about conflicts surfaced
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /name conflicts|already exists/i);
  });

  test('empty: no Sessions/ dirs anywhere → skipped status, exits 0', () => {
    const vp = makeVault('empty');
    const r = runScript('--migrate-sessions-to-wiki-meta', vp);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /no Sessions\/ directory found/);
  });

  test('non-existent vault path: fails with clear message', () => {
    const ghost = path.join(workDir, 'ghost-' + Math.random());
    const r = runScript('--migrate-sessions-to-wiki-meta', ghost);
    assert.notEqual(r.status, 0);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /does not exist|not a directory/i);
  });

  test('--dry-run: previews without touching the filesystem', () => {
    const vp = makeVault('legacy');
    const r = runScript('--migrate-sessions-to-wiki-meta', vp, '--dry-run');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /DRY-RUN/);
    // Source still present, target empty
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'Sessions')), 'wiki/Sessions/ should still exist');
    assert.ok(!fs.existsSync(path.join(vp, 'wiki-meta', 'Sessions')), 'wiki-meta/Sessions/ should NOT have been created');
    // log.md unchanged
    const log = fs.readFileSync(path.join(vp, 'wiki-meta', 'log.md'), 'utf8');
    assert.doesNotMatch(log, /migrate — wiki\/Sessions/, 'log.md should not be appended in dry-run');
  });
});
