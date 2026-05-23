/**
 * Regression tests for the safety guards added to scripts/setup-vault.mjs:
 *
 *   1. `samePath()` — replaces the previous case-sensitive
 *      `path.resolve(a) === path.resolve(b)` in --sync-all's self-skip.
 *      Without this fix, a reference vault `C:\VAULTS\.template` registered
 *      with different casing (`c:\vaults\.template`) in `portRegistry`
 *      would slip past the skip, and `--force` would `rm -rf` the source's
 *      own plugin folder mid-copy → data-loss.
 *
 *   2. CREDENTIAL_LEAK_PLUGINS skip — `--sync-plugins` refuses to
 *      first-time-copy `obsidian-local-rest-api` into a target that
 *      doesn't have it installed, because that copy would clone the
 *      reference vault's data.json (port + API key) → credential leak.
 *
 * Strategy:
 *   - samePath unit tests use the helper module directly (no I/O, fast).
 *   - Behavior tests spawn the CLI script with synthetic fixtures (temp
 *     vault dirs + temp config.json pointed at via OBSIDIAN_ROUTER_CONFIG).
 *     Slower (~100ms each) but exercises the real codepath end-to-end.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { samePath, canonicalPath } from '../scripts/path-helpers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-vault.mjs');

// ---------------------------------------------------------------------------
// samePath — unit tests
// ---------------------------------------------------------------------------

describe('samePath()', () => {
  test('returns false for null/undefined/empty inputs', () => {
    assert.equal(samePath(null, 'x'), false);
    assert.equal(samePath('x', null), false);
    assert.equal(samePath(undefined, undefined), false);
    assert.equal(samePath('', 'x'), false);
    assert.equal(samePath('x', ''), false);
  });

  test('returns true for identical paths', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'same-path-'));
    try {
      assert.equal(samePath(tmp, tmp), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns true for paths that differ only in trailing separator', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'same-path-'));
    try {
      assert.equal(samePath(tmp, tmp + path.sep), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns true for case-different paths on case-insensitive platforms', () => {
    // Only meaningful on win32 / darwin where the FS is case-insensitive
    // by default. On Linux ext4, FOO and foo are genuinely different dirs.
    if (process.platform === 'linux') {
      // Smoke test: at least confirm the function doesn't crash on linux.
      assert.equal(samePath('/tmp', '/TMP'), false);
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'same-path-'));
    try {
      const upper = tmp.toUpperCase();
      const lower = tmp.toLowerCase();
      // realpathSync.native should canonicalize both to the on-disk casing.
      assert.equal(samePath(upper, lower), true);
      assert.equal(samePath(upper, tmp), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns false for different physical directories', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'same-path-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'same-path-b-'));
    try {
      assert.equal(samePath(a, b), false);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test('non-existent paths fall back to lowercase compare on case-insensitive platforms', () => {
    const fake = process.platform === 'win32'
      ? 'C:\\does-not-exist\\foo'
      : '/does-not-exist-12345/foo';
    const fakeUpper = process.platform === 'win32'
      ? 'C:\\DOES-NOT-EXIST\\FOO'
      : '/does-not-exist-12345/FOO';

    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.equal(samePath(fake, fakeUpper), true);
    } else {
      // Linux: different case = different paths even when both non-existent.
      assert.equal(samePath(fake, fakeUpper), false);
    }
  });

  test('canonicalPath does not throw on non-existent paths', () => {
    // The function is called from production code paths where the registry
    // may contain stale entries pointing at deleted vaults. Must not throw.
    assert.doesNotThrow(() => canonicalPath('/nope/nope/nope-' + Date.now()));
  });
});

// ---------------------------------------------------------------------------
// Integration: --sync-plugins refuses to target the reference vault
// ---------------------------------------------------------------------------

describe('setup-vault.mjs --sync-plugins safety guards', () => {
  let workDir;
  let referenceVault;
  let targetVault;
  let configPath;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-vault-test-'));
    referenceVault = path.join(workDir, '.template');
    targetVault = path.join(workDir, 'target');

    // Reference vault: minimal Obsidian structure with plugins/, including
    // obsidian-local-rest-api (the credentialed one) and a benign plugin.
    fs.mkdirSync(path.join(referenceVault, '.obsidian', 'plugins', 'obsidian-local-rest-api'), { recursive: true });
    fs.writeFileSync(
      path.join(referenceVault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: 'SECRET-REF-KEY', port: 27123 }),
    );
    fs.writeFileSync(
      path.join(referenceVault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'main.js'),
      '// rest-api plugin code',
    );
    fs.mkdirSync(path.join(referenceVault, '.obsidian', 'plugins', 'benign-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(referenceVault, '.obsidian', 'plugins', 'benign-plugin', 'main.js'),
      '// benign plugin code',
    );

    // Target vault: has .obsidian/ but no plugins/ yet — simulates a vault
    // a user has opened in Obsidian but never bootstrapped against the router.
    fs.mkdirSync(path.join(targetVault, '.obsidian'), { recursive: true });

    // Config: minimal, references our fixture vaults.
    configPath = path.join(workDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault,
      portRegistry: { [targetVault]: 27130 },
      portStart: 27130,
    }, null, 2));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function runScript(args, env = {}) {
    return spawnSync(
      process.execPath,
      [SCRIPT_PATH, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath, ...env },
      },
    );
  }

  test('refuses to --sync-plugins onto the reference vault itself', () => {
    const result = runScript([referenceVault, '--sync-plugins']);
    assert.notEqual(result.status, 0, 'should exit non-zero');
    const output = (result.stdout || '') + (result.stderr || '');
    assert.match(output, /Refusing to sync the reference vault onto itself/i);
  });

  test('refuses with case-different reference path (Windows/macOS regression)', () => {
    // On case-insensitive platforms, an uppercase variant should still be
    // recognized as the reference vault. On Linux, the path won't resolve
    // to the same dir so the test would mean something different — skip.
    if (process.platform === 'linux') return;

    const refUpper = referenceVault.toUpperCase();
    const result = runScript([refUpper, '--sync-plugins']);
    assert.notEqual(result.status, 0, 'should still refuse');
    const output = (result.stdout || '') + (result.stderr || '');
    assert.match(output, /Refusing to sync the reference vault onto itself/i);
  });

  test('--sync-plugins on a clean target skips credentialed plugins + copies benign ones', () => {
    // Sanity: target has no plugins folder at all yet.
    const tgtPlugins = path.join(targetVault, '.obsidian', 'plugins');
    if (fs.existsSync(tgtPlugins)) fs.rmSync(tgtPlugins, { recursive: true, force: true });

    const result = runScript([targetVault, '--sync-plugins']);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr=${result.stderr}`);

    // Benign plugin: should be copied
    assert.ok(
      fs.existsSync(path.join(targetVault, '.obsidian', 'plugins', 'benign-plugin', 'main.js')),
      'benign plugin should be copied',
    );

    // Credentialed plugin: should NOT be present in the target
    assert.ok(
      !fs.existsSync(path.join(targetVault, '.obsidian', 'plugins', 'obsidian-local-rest-api')),
      'obsidian-local-rest-api should NOT be copied first-time (credential leak avoidance)',
    );

    // Output should explain why
    const output = (result.stdout || '') + (result.stderr || '');
    assert.match(output, /Refused first-time copy.*obsidian-local-rest-api/is);
    assert.match(output, /port \+ API key/i);
  });

  test('--sync-plugins with --force on a vault that already has REST API preserves data.json', () => {
    // Pre-state: ensure the target has an existing obsidian-local-rest-api
    // plugin with its OWN data.json (different from the reference).
    const tgtRestApi = path.join(targetVault, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fs.mkdirSync(tgtRestApi, { recursive: true });
    const tgtDataJson = { apiKey: 'TARGET-OWN-KEY', port: 27130 };
    fs.writeFileSync(path.join(tgtRestApi, 'data.json'), JSON.stringify(tgtDataJson));
    fs.writeFileSync(path.join(tgtRestApi, 'main.js'), '// stale rest-api code');

    const result = runScript([targetVault, '--sync-plugins', '--force']);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr=${result.stderr}`);

    // Code file was refreshed from reference
    const newMain = fs.readFileSync(path.join(tgtRestApi, 'main.js'), 'utf8');
    assert.match(newMain, /rest-api plugin code/);

    // data.json was preserved (target's own key, NOT reference's)
    const data = JSON.parse(fs.readFileSync(path.join(tgtRestApi, 'data.json'), 'utf8'));
    assert.equal(data.apiKey, 'TARGET-OWN-KEY', 'target data.json must be preserved across --force re-clone');
    assert.equal(data.port, 27130);
  });

  test('REGRESSION (codex P1): --force refuses to copy credentialed plugin when target lacks data.json', () => {
    // Scenario: target has the plugin folder (Obsidian created it on
    // install) but data.json was never written (user never activated
    // the plugin). With the bug, --force would `rm -rf` the folder
    // then `copyDirRecursive` from reference, importing the reference's
    // data.json. With the fix, the credentialed-plugin check fires
    // BEFORE the rm and the plugin is deferred.
    const tgtRestApi = path.join(targetVault, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fs.rmSync(tgtRestApi, { recursive: true, force: true });
    fs.mkdirSync(tgtRestApi, { recursive: true });
    fs.writeFileSync(path.join(tgtRestApi, 'main.js'), '// installed but inactive');
    // Deliberately NO data.json — the regression case.

    const result = runScript([targetVault, '--sync-plugins', '--force']);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr=${result.stderr}`);

    // The plugin's data.json must NOT have been imported from reference.
    const tgtDataJsonPath = path.join(tgtRestApi, 'data.json');
    if (fs.existsSync(tgtDataJsonPath)) {
      const data = JSON.parse(fs.readFileSync(tgtDataJsonPath, 'utf8'));
      assert.notEqual(data.apiKey, 'SECRET-REF-KEY', 'reference data.json must not be imported');
    }
    // The script must have surfaced the refusal in output.
    const output = (result.stdout || '') + (result.stderr || '');
    assert.match(output, /Refused first-time copy.*obsidian-local-rest-api/is);
  });

  test('--sync-plugins --quiet still surfaces the credential-leak warning to stdout', () => {
    // The --quiet flag is used by SessionStart hooks — they want
    // silence on no-ops. But credential-leak avoidance MUST NOT be
    // silenced; the user needs to know they have an unbootstrapped
    // vault even when the hook is the only caller.
    const tgtRestApi = path.join(targetVault, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fs.rmSync(tgtRestApi, { recursive: true, force: true });

    const result = runScript([targetVault, '--sync-plugins', '--quiet']);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr=${result.stderr}`);
    const output = (result.stdout || '') + (result.stderr || '');
    assert.match(output, /\[obsidian-mcp-router\] WARNING:/, 'quiet mode must still print credential-leak warnings');
    assert.match(output, /obsidian-local-rest-api/);
  });
});

// ---------------------------------------------------------------------------
// Integration: --sync-all auto-skips the reference vault by case-insensitive match
// ---------------------------------------------------------------------------

describe('setup-vault.mjs --sync-all reference skip (Windows/macOS regression)', () => {
  let workDir;
  let referenceVault;
  let targetVault;
  let configPath;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-all-test-'));
    referenceVault = path.join(workDir, '.template');
    targetVault = path.join(workDir, 'target');

    fs.mkdirSync(path.join(referenceVault, '.obsidian', 'plugins', 'benign-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(referenceVault, '.obsidian', 'plugins', 'benign-plugin', 'main.js'),
      '// benign plugin code',
    );
    fs.mkdirSync(path.join(targetVault, '.obsidian'), { recursive: true });

    // Registry includes BOTH the canonical reference (same-casing — the
    // normal case after `initReference()`) AND a case-different variant
    // (the regression scenario) + a legit target.
    configPath = path.join(workDir, 'config.json');
    const referenceVaultMisCased = process.platform === 'win32' || process.platform === 'darwin'
      ? referenceVault.toUpperCase()
      : referenceVault; // on linux this would be a different dir, skip the regression

    // Fixture invariant guard (NIT N3): on case-insensitive platforms,
    // the mis-cased variant MUST differ from the canonical entry as a
    // string — otherwise the test below would silently no-op. Catches
    // pathological setups where mkdtempSync returned an already-
    // uppercased path.
    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.notEqual(
        referenceVaultMisCased, referenceVault,
        'fixture invariant: mis-cased variant must differ from canonical as a string',
      );
    }

    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault,
      portRegistry: {
        [targetVault]: 27130,
        // SAME-casing entry: covers the natural case where the reference
        // vault is also in portRegistry (which is what initReference()
        // does). Must be skipped by the bulk handler's self-skip.
        [referenceVault]: 27131,
        // The mis-cased entry: with the old case-sensitive self-skip, this
        // would NOT be recognized as the reference and the loop would try
        // to sync the reference onto itself. With samePath() it's skipped.
        ...(referenceVaultMisCased !== referenceVault ? { [referenceVaultMisCased]: 27132 } : {}),
      },
      portStart: 27130,
    }, null, 2));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('same-casing reference entry in portRegistry is self-skipped (natural case)', () => {
    // This is the normal post-initReference() state: portRegistry has
    // an entry with the reference's exact path. The bulk handler must
    // skip it via samePath(). No platform skip needed — same casing
    // is universal.
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--sync-all'],
      { encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath } },
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr=${result.stderr}`);
    const output = (result.stdout || '') + (result.stderr || '');
    // The same-casing reference entry appears in the "skip (reference)"
    // line — search for the path verbatim.
    assert.match(output, new RegExp(`skip \\(reference\\):.*${referenceVault.replace(/\\/g, '\\\\').replace(/\./g, '\\.')}`));
  });

  test('case-different reference entry in portRegistry is correctly self-skipped', () => {
    // Only meaningful on case-insensitive platforms.
    if (process.platform === 'linux') return;

    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--sync-all'],
      {
        encoding: 'utf8',
        env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: configPath },
      },
    );

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr=${result.stderr}`);
    const output = (result.stdout || '') + (result.stderr || '');
    // The mis-cased entry should appear in the skip-reference message,
    // NOT in a "syncing" message that would mean data-loss.
    assert.match(output, /skip \(reference\)/i);
    // The legit target should still be synced.
    assert.ok(
      fs.existsSync(path.join(targetVault, '.obsidian', 'plugins', 'benign-plugin')),
      'legit target should still be synced',
    );
    // No "syncing" message containing the reference path's casing variant
    // — would indicate the self-skip was bypassed.
    assert.doesNotMatch(output, /→.*\.TEMPLATE/);
  });

  test('REGRESSION (Reviewer A I1): a single failing vault does not abort --sync-all loop', () => {
    // Setup: portRegistry contains a target whose .obsidian/ exists
    // but plugins/ subtree is unusable (the test makes the target a
    // file masquerading as the plugins dir → fs operations on it
    // throw mid-sync). Verify the loop catches the throw, logs the
    // failure, and continues to the legit target.
    const brokenWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-all-broken-'));
    const brokenRef = path.join(brokenWorkDir, '.template');
    const brokenLegit = path.join(brokenWorkDir, 'legit');
    const brokenBad = path.join(brokenWorkDir, 'bad');
    fs.mkdirSync(path.join(brokenRef, '.obsidian', 'plugins', 'benign-plugin'), { recursive: true });
    fs.writeFileSync(path.join(brokenRef, '.obsidian', 'plugins', 'benign-plugin', 'main.js'), '// ref code');
    fs.mkdirSync(path.join(brokenLegit, '.obsidian'), { recursive: true });
    // The "bad" vault: .obsidian exists but its plugins subdir is a file,
    // not a directory → mkdirSync (recursive:true) will throw EEXIST/ENOTDIR.
    fs.mkdirSync(path.join(brokenBad, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(brokenBad, '.obsidian', 'plugins'), 'not-a-directory');
    const brokenCfg = path.join(brokenWorkDir, 'config.json');
    fs.writeFileSync(brokenCfg, JSON.stringify({
      referenceVault: brokenRef,
      portRegistry: { [brokenBad]: 27200, [brokenLegit]: 27201 },
      portStart: 27200,
    }, null, 2));

    try {
      const result = spawnSync(
        process.execPath,
        [SCRIPT_PATH, '--sync-all'],
        { encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: brokenCfg } },
      );
      // Exit code is non-zero because at least one vault failed.
      assert.notEqual(result.status, 0);
      const output = (result.stdout || '') + (result.stderr || '');
      // Both vaults should appear in output — bad one as "failed",
      // legit one as synced. With the bug (process.exit on first
      // failure), only the bad one would appear.
      assert.match(output, /failed:/i);
      assert.ok(
        fs.existsSync(path.join(brokenLegit, '.obsidian', 'plugins', 'benign-plugin')),
        'legit vault must still be synced even after the bad one failed',
      );
    } finally {
      fs.rmSync(brokenWorkDir, { recursive: true, force: true });
    }
  });
});
