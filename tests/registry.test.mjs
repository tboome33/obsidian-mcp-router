/**
 * Tests for src/registry.mjs — default vault resolution cascade and path
 * normalization. Run with `npm test` (which calls `node --test tests/`).
 *
 * Strategy:
 * - normalizePathForCompare: pure function, tested directly via _internals.
 * - resolveDefaultVault: tested directly via _internals with synthetic
 *   `vaults` arrays (no I/O, no env mutation visible to other tests).
 * - loadRegistry: integration tests using a temp config file. Each test
 *   saves and restores process.env to avoid leaking state.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { loadRegistry, _internals } from '../src/registry.mjs';
import { lockVault, unlockVaults, _internals as lockInternals } from '../src/tools/lock.mjs';
import { setAutoEnrichMode, canonicalizeMode, VALID_MODES } from '../src/tools/auto-enrich.mjs';
import { applyLockGuard, validateLock, validateAutoEnrichMode } from '../src/index.mjs';

const { normalizePathForCompare, resolveDefaultVault, defaultNameFromPath } = _internals;
const { upsertDotenvVar, removeDotenvVar } = lockInternals;

// ---------------------------------------------------------------------------
// normalizePathForCompare — pure unit tests
// ---------------------------------------------------------------------------

describe('normalizePathForCompare', () => {
  test('falsy input passes through', () => {
    assert.equal(normalizePathForCompare(null), null);
    assert.equal(normalizePathForCompare(undefined), undefined);
    assert.equal(normalizePathForCompare(''), '');
  });

  test('Windows drive-letter path with backslashes is normalized + lowercased', () => {
    const result = normalizePathForCompare('C:\\VAULTS\\Trading');
    assert.equal(result, 'c:\\vaults\\trading');
  });

  test('Windows drive-letter path with forward slashes is normalized as Windows', () => {
    const result = normalizePathForCompare('C:/VAULTS/Trading');
    // path.win32.normalize converts forward slashes to backslashes
    assert.equal(result, 'c:\\vaults\\trading');
  });

  test('Windows path with mixed separators is normalized', () => {
    const result = normalizePathForCompare('C:\\VAULTS/Trading\\sub');
    assert.equal(result, 'c:\\vaults\\trading\\sub');
  });

  test('Windows path with trailing backslash is stripped', () => {
    const result = normalizePathForCompare('C:\\VAULTS\\Trading\\');
    assert.equal(result, 'c:\\vaults\\trading');
  });

  test('Windows path with trailing forward slash is stripped', () => {
    const result = normalizePathForCompare('C:/VAULTS/Trading/');
    assert.equal(result, 'c:\\vaults\\trading');
  });

  test('two equivalent Windows paths normalize to the same value', () => {
    const a = normalizePathForCompare('C:\\VAULTS\\.template');
    const b = normalizePathForCompare('c:/vaults/.template');
    assert.equal(a, b);
  });

  test('different Windows paths normalize differently', () => {
    const a = normalizePathForCompare('C:\\VAULTS\\Trading');
    const b = normalizePathForCompare('C:\\VAULTS\\Recherche');
    assert.notEqual(a, b);
  });

  test('UNC path (\\\\server\\share\\...) is detected as Windows-style', () => {
    const result = normalizePathForCompare('\\\\nas-01\\Vaults\\Wiki');
    assert.equal(result, '\\\\nas-01\\vaults\\wiki');
  });

  test('UNC path with trailing backslash is stripped', () => {
    const result = normalizePathForCompare('\\\\nas-01\\Vaults\\Wiki\\');
    assert.equal(result, '\\\\nas-01\\vaults\\wiki');
  });

  test('extended-length prefix path (\\\\?\\C:\\...) is detected as Windows', () => {
    const result = normalizePathForCompare('\\\\?\\C:\\VAULTS\\Trading');
    // path.win32.normalize collapses \\?\C:\... back to C:\... in some Node versions
    // but the case folding should still kick in. Just verify it's lowercased and
    // recognizable, not specific layout.
    assert.match(result, /trading/);
    assert.equal(result, result.toLowerCase());
  });

  test('POSIX absolute path is normalized, case preserved', () => {
    const result = normalizePathForCompare('/home/User/Vaults/Trading');
    assert.equal(result, '/home/User/Vaults/Trading');
  });

  test('POSIX path with trailing slash is stripped', () => {
    const result = normalizePathForCompare('/home/user/x/');
    assert.equal(result, '/home/user/x');
  });

  test('POSIX path with redundant separators is collapsed', () => {
    const result = normalizePathForCompare('/home//user///x');
    assert.equal(result, '/home/user/x');
  });

  test('two equivalent POSIX paths normalize to the same value', () => {
    const a = normalizePathForCompare('/home/user/x');
    const b = normalizePathForCompare('/home/user//x/');
    assert.equal(a, b);
  });

  test('POSIX path case is NOT folded', () => {
    const a = normalizePathForCompare('/home/User/X');
    const b = normalizePathForCompare('/home/user/x');
    assert.notEqual(a, b);
  });

  test('relative path is not Windows-detected', () => {
    // Relative paths are normalized by path.posix; they will never match an
    // absolute portRegistry entry, which is fine.
    const result = normalizePathForCompare('relative/path');
    assert.equal(result, 'relative/path');
  });
});

// ---------------------------------------------------------------------------
// defaultNameFromPath — sanity check of the helper used by tier 2
// ---------------------------------------------------------------------------

describe('defaultNameFromPath', () => {
  // ⚠️ REGRESSION TESTS — these existed before commit 7740a6a but only passed
  // on Windows by accident (where Node's default `path` IS path.win32). On
  // POSIX runtime they failed because `path.basename('C:\\VAULTS\\.template')`
  // returned the whole string verbatim. The fix routes Windows-style inputs
  // to `path.win32.basename` regardless of runtime — these tests now pin
  // that behavior so a regression would be caught on ANY CI runner.

  test('strips leading dot and lowercases (Windows path)', () => {
    assert.equal(defaultNameFromPath('C:\\VAULTS\\.template'), 'template');
  });

  test('lowercases without leading dot (Windows path)', () => {
    assert.equal(defaultNameFromPath('C:\\VAULTS\\TradingView'), 'tradingview');
  });

  test('handles POSIX absolute paths', () => {
    assert.equal(defaultNameFromPath('/home/user/Vaults/Recherche'), 'recherche');
  });

  test('Windows path with mixed forward/backslash separators', () => {
    // Real-world: people sometimes write `C:/VAULTS/X` in JSON to avoid
    // having to escape backslashes. path.win32 handles this.
    assert.equal(defaultNameFromPath('C:/VAULTS/.template'), 'template');
  });

  test('UNC network share path', () => {
    assert.equal(defaultNameFromPath('\\\\nas-01\\Vaults\\Wiki'), 'wiki');
  });

  test('Windows extended-length prefix (\\\\?\\)', () => {
    assert.equal(defaultNameFromPath('\\\\?\\C:\\VAULTS\\.template'), 'template');
  });

  test('empty string is safe', () => {
    assert.equal(defaultNameFromPath(''), '');
  });

  test('POSIX path with leading dot folder', () => {
    assert.equal(defaultNameFromPath('/srv/vaults/.shared'), 'shared');
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultVault — pure cascade tests with synthetic vault arrays
// ---------------------------------------------------------------------------

describe('resolveDefaultVault — 5-tier cascade', () => {
  // Save and restore env vars between tests
  const ENV_KEYS = ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'VAULT_PATH'];
  const saved = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const localVault = (name, vaultPath, missingApiKey = false) => ({
    name,
    type: 'local',
    path: vaultPath,
    baseUrl: `https://127.0.0.1:27124`,
    apiKey: missingApiKey ? null : 'fake',
    tlsInsecure: true,
    timeoutMs: 5000,
    missingApiKey,
  });

  const remoteVault = (name) => ({
    name,
    type: 'remote',
    baseUrl: `https://${name}.example.com`,
    apiKey: 'fake',
    tlsInsecure: false,
    timeoutMs: 10000,
  });

  test('tier 5 (last resort): returns first vault when nothing else is set', () => {
    const vaults = [remoteVault('alpha'), remoteVault('beta')];
    const result = resolveDefaultVault({ vaults, configuredDefault: undefined });
    assert.equal(result, 'alpha');
  });

  test('tier 5: empty vault array returns undefined', () => {
    const result = resolveDefaultVault({ vaults: [], configuredDefault: undefined });
    assert.equal(result, undefined);
  });

  test('tier 4: prefers healthy local over missing-key local', () => {
    const vaults = [
      localVault('broken', 'C:\\VAULTS\\Broken', true),
      localVault('healthy', 'C:\\VAULTS\\Healthy', false),
    ];
    const result = resolveDefaultVault({ vaults, configuredDefault: undefined });
    assert.equal(result, 'healthy');
  });

  test('tier 3: honors config.defaultVault when active', () => {
    const vaults = [localVault('alpha', '/v/alpha'), localVault('beta', '/v/beta')];
    const result = resolveDefaultVault({ vaults, configuredDefault: 'beta' });
    assert.equal(result, 'beta');
  });

  test('tier 3: ignores config.defaultVault when not in active set', () => {
    const vaults = [localVault('alpha', '/v/alpha'), localVault('beta', '/v/beta')];
    const result = resolveDefaultVault({ vaults, configuredDefault: 'gamma-disabled' });
    assert.equal(result, 'alpha'); // falls through to tier 4
  });

  test('tier 2: matches VAULT_PATH against vault.path → vault name', () => {
    process.env.VAULT_PATH = 'C:\\VAULTS\\.template';
    const vaults = [
      localVault('template', 'C:\\VAULTS\\.template'),
      localVault('tradingview', 'C:\\VAULTS\\TradingView'),
    ];
    const result = resolveDefaultVault({ vaults, configuredDefault: 'tradingview' });
    assert.equal(result, 'template'); // tier 2 wins over tier 3
  });

  test('tier 2: VAULT_PATH with case differences still matches on Windows-style', () => {
    process.env.VAULT_PATH = 'c:/vaults/.template/';
    const vaults = [localVault('template', 'C:\\VAULTS\\.template')];
    const result = resolveDefaultVault({ vaults, configuredDefault: undefined });
    assert.equal(result, 'template');
  });

  test('tier 2: VAULT_PATH that does not match any vault falls through silently', () => {
    process.env.VAULT_PATH = 'C:\\VAULTS\\NotARegisteredVault';
    const vaults = [localVault('template', 'C:\\VAULTS\\.template')];
    const result = resolveDefaultVault({ vaults, configuredDefault: undefined });
    // Falls through to tier 4 (first healthy local)
    assert.equal(result, 'template');
  });

  test('tier 1: OBSIDIAN_ROUTER_DEFAULT_VAULT wins over VAULT_PATH', () => {
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'tradingview';
    process.env.VAULT_PATH = 'C:\\VAULTS\\.template';
    const vaults = [
      localVault('template', 'C:\\VAULTS\\.template'),
      localVault('tradingview', 'C:\\VAULTS\\TradingView'),
    ];
    const result = resolveDefaultVault({ vaults, configuredDefault: 'template' });
    assert.equal(result, 'tradingview');
  });

  test('tier 1: OBSIDIAN_ROUTER_DEFAULT_VAULT typo emits warning + falls through', () => {
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'tradingvieww';

    // Capture stderr
    const original = console.error;
    let warning = '';
    console.error = (msg) => {
      warning = String(msg);
    };

    try {
      const vaults = [
        localVault('template', 'C:\\VAULTS\\.template'),
        localVault('tradingview', 'C:\\VAULTS\\TradingView'),
      ];
      const result = resolveDefaultVault({ vaults, configuredDefault: 'tradingview' });
      assert.equal(result, 'tradingview'); // falls through to tier 3
      assert.match(warning, /tradingvieww/);
      assert.match(warning, /falling through/);
      assert.match(warning, /Active vaults: template, tradingview/);
    } finally {
      console.error = original;
    }
  });

  test('tier 1: valid OBSIDIAN_ROUTER_DEFAULT_VAULT does NOT emit a warning', () => {
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'template';

    const original = console.error;
    let warningEmitted = false;
    console.error = () => {
      warningEmitted = true;
    };

    try {
      const vaults = [
        localVault('template', 'C:\\VAULTS\\.template'),
        localVault('tradingview', 'C:\\VAULTS\\TradingView'),
      ];
      const result = resolveDefaultVault({ vaults, configuredDefault: undefined });
      assert.equal(result, 'template');
      assert.equal(warningEmitted, false);
    } finally {
      console.error = original;
    }
  });

  test('tier 1: missing-key vault is still selectable as explicit override', () => {
    // Per the documented policy: explicit overrides (tiers 1-3) honor
    // missing-key vaults; the resolveVault() call later raises a clear
    // error. Only tier 4 (the implicit fallback) prefers healthy.
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'broken';
    const vaults = [
      localVault('broken', 'C:\\VAULTS\\Broken', true),
      localVault('healthy', 'C:\\VAULTS\\Healthy', false),
    ];
    const result = resolveDefaultVault({ vaults, configuredDefault: undefined });
    assert.equal(result, 'broken');
  });
});

// ---------------------------------------------------------------------------
// loadRegistry — integration tests with temp config files
// ---------------------------------------------------------------------------

describe('loadRegistry — integration', () => {
  let tmpDir;
  let cfgPath;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-test-'));
    cfgPath = path.join(tmpDir, 'config.json');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    delete process.env.VAULT_PATH;
  });

  test('loadRegistry resolves defaultVault from config when no env is set', async () => {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'alpha', baseUrl: 'https://a.example.com', apiKey: 'k' },
        { name: 'beta', baseUrl: 'https://b.example.com', apiKey: 'k' },
      ],
      defaultVault: 'beta',
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    const r = await loadRegistry({ configPath: cfgPath });
    assert.equal(r.defaultVault, 'beta');
  });

  test('loadRegistry honors OBSIDIAN_ROUTER_DEFAULT_VAULT env var', async () => {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'alpha', baseUrl: 'https://a.example.com', apiKey: 'k' },
        { name: 'beta', baseUrl: 'https://b.example.com', apiKey: 'k' },
      ],
      defaultVault: 'beta',
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'alpha';
    const r = await loadRegistry({ configPath: cfgPath });
    assert.equal(r.defaultVault, 'alpha');
  });

  test('loadRegistry exposes configPath in the result', async () => {
    const config = { portRegistry: {}, remoteVaults: [{ name: 'a', baseUrl: 'https://a/', apiKey: 'k' }] };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    const r = await loadRegistry({ configPath: cfgPath });
    assert.equal(r.configPath, cfgPath);
  });

  test('loadRegistry filters disabled vaults out of the active set', async () => {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'beta', baseUrl: 'https://b/', apiKey: 'k' },
      ],
      disabledVaults: ['beta'],
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    const r = await loadRegistry({ configPath: cfgPath });
    assert.deepEqual(r.vaults.map((v) => v.name), ['alpha']);
    assert.deepEqual(r.skipped.map((s) => s.name), ['beta']);
  });

  test('loadRegistry exposes skipped[] with name + type + reason', async () => {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'beta', baseUrl: 'https://b/', apiKey: 'k' },
      ],
      disabledVaults: ['beta'],
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    const r = await loadRegistry({ configPath: cfgPath });
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].name, 'beta');
    assert.equal(r.skipped[0].type, 'remote');
    assert.equal(r.skipped[0].reason, 'disabled');
  });
});

// ---------------------------------------------------------------------------
// lock_vault / unlock_vaults — tool handler tests
// ---------------------------------------------------------------------------

describe('lockVault / unlockVaults — tool handlers', () => {
  let tmpDir;
  let originalCwd;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-lock-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeRegistry() {
    return {
      vaults: [
        { name: 'alpha', type: 'remote', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'beta', type: 'remote', baseUrl: 'https://b/', apiKey: 'k' },
      ],
      lockedVault: null,
    };
  }

  test('lockVault sets registry.lockedVault on the in-memory state', async () => {
    const reg = makeRegistry();
    const result = await lockVault(reg, { vault: 'alpha' });
    assert.equal(reg.lockedVault, 'alpha');
    assert.equal(result.locked, true);
    assert.equal(result.vault, 'alpha');
    assert.equal(result.persisted, false);
  });

  test('lockVault refuses unknown vault with explicit error', async () => {
    const reg = makeRegistry();
    await assert.rejects(
      () => lockVault(reg, { vault: 'gamma' }),
      /not in the active vault set/,
    );
    assert.equal(reg.lockedVault, null);
  });

  test('lockVault requires `vault` argument', async () => {
    const reg = makeRegistry();
    await assert.rejects(
      () => lockVault(reg, {}),
      /missing required argument `vault`/,
    );
  });

  test('lockVault with persist:true writes OBSIDIAN_ROUTER_LOCKED to .env', async () => {
    const reg = makeRegistry();
    const envPath = path.join(tmpDir, '.env');
    await fs.rm(envPath, { force: true });

    const result = await lockVault(reg, { vault: 'alpha', persist: true });
    assert.equal(result.persisted, true);
    const envContent = await fs.readFile(envPath, 'utf8');
    assert.match(envContent, /^OBSIDIAN_ROUTER_LOCKED=alpha$/m);
  });

  test('unlockVaults clears lockedVault', async () => {
    const reg = makeRegistry();
    reg.lockedVault = 'alpha';
    const result = await unlockVaults(reg, {});
    assert.equal(reg.lockedVault, null);
    assert.equal(result.locked, false);
    assert.equal(result.wasLocked, 'alpha');
  });

  test('unlockVaults on a non-locked router is a no-op', async () => {
    const reg = makeRegistry();
    const result = await unlockVaults(reg, {});
    assert.equal(reg.lockedVault, null);
    assert.match(result.message, /was not locked/i);
  });

  test('unlockVaults with persist:true removes OBSIDIAN_ROUTER_LOCKED from .env', async () => {
    const envPath = path.join(tmpDir, '.env');
    await fs.writeFile(envPath, 'KEEP_ME=hello\nOBSIDIAN_ROUTER_LOCKED=alpha\nALSO_KEEP=world\n', 'utf8');

    const reg = makeRegistry();
    reg.lockedVault = 'alpha';
    const result = await unlockVaults(reg, { persist: true });
    assert.equal(result.persistRemoved, true);

    const envContent = await fs.readFile(envPath, 'utf8');
    assert.doesNotMatch(envContent, /OBSIDIAN_ROUTER_LOCKED/);
    // Other lines preserved
    assert.match(envContent, /KEEP_ME=hello/);
    assert.match(envContent, /ALSO_KEEP=world/);
  });
});

// ---------------------------------------------------------------------------
// .env mutation helpers — directly tested via _internals
// ---------------------------------------------------------------------------

describe('upsertDotenvVar / removeDotenvVar', () => {
  let tmpDir;
  let envPath;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-env-test-'));
    envPath = path.join(tmpDir, '.env');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await fs.rm(envPath, { force: true });
  });

  test('upsert creates the file when absent', async () => {
    await upsertDotenvVar(envPath, 'FOO', 'bar');
    const content = await fs.readFile(envPath, 'utf8');
    assert.equal(content, 'FOO=bar\n');
  });

  test('upsert appends when key not present', async () => {
    await fs.writeFile(envPath, 'EXISTING=1\n', 'utf8');
    await upsertDotenvVar(envPath, 'FOO', 'bar');
    const content = await fs.readFile(envPath, 'utf8');
    assert.match(content, /^EXISTING=1$/m);
    assert.match(content, /^FOO=bar$/m);
  });

  test('upsert updates existing key in place', async () => {
    await fs.writeFile(envPath, 'A=1\nFOO=old\nB=2\n', 'utf8');
    await upsertDotenvVar(envPath, 'FOO', 'new');
    const content = await fs.readFile(envPath, 'utf8');
    assert.match(content, /^FOO=new$/m);
    assert.doesNotMatch(content, /FOO=old/);
    // Other keys preserved
    assert.match(content, /^A=1$/m);
    assert.match(content, /^B=2$/m);
  });

  test('remove returns false on missing file', async () => {
    const removed = await removeDotenvVar(envPath, 'FOO');
    assert.equal(removed, false);
  });

  test('remove returns false when key absent', async () => {
    await fs.writeFile(envPath, 'A=1\nB=2\n', 'utf8');
    const removed = await removeDotenvVar(envPath, 'FOO');
    assert.equal(removed, false);
    const content = await fs.readFile(envPath, 'utf8');
    assert.equal(content, 'A=1\nB=2\n');
  });

  test('remove deletes the line and preserves others', async () => {
    await fs.writeFile(envPath, 'A=1\nFOO=bar\nB=2\n', 'utf8');
    const removed = await removeDotenvVar(envPath, 'FOO');
    assert.equal(removed, true);
    const content = await fs.readFile(envPath, 'utf8');
    assert.doesNotMatch(content, /FOO/);
    assert.match(content, /^A=1$/m);
    assert.match(content, /^B=2$/m);
  });

  test('upsert updates FIRST occurrence (matches reader convention) — C.4 regression', async () => {
    // The .env loader (bin/obsidian-mcp-router.mjs) keeps the FIRST occurrence
    // of a duplicated key. The writer must follow the same convention or
    // the user can end up with the writer updating the bottom line and
    // the loader reading a stale top one.
    await fs.writeFile(envPath, 'FOO=stale_top\nMIDDLE=preserved\nFOO=stale_bottom\n', 'utf8');
    await upsertDotenvVar(envPath, 'FOO', 'fresh');
    const content = await fs.readFile(envPath, 'utf8');
    const lines = content.split(/\r?\n/);
    assert.equal(lines[0], 'FOO=fresh');
    assert.equal(lines[1], 'MIDDLE=preserved');
    assert.equal(lines[2], 'FOO=stale_bottom');
  });

  test('remove deletes ALL occurrences of the key', async () => {
    await fs.writeFile(envPath, 'FOO=top\nMIDDLE=keep\nFOO=bottom\n', 'utf8');
    const removed = await removeDotenvVar(envPath, 'FOO');
    assert.equal(removed, true);
    const content = await fs.readFile(envPath, 'utf8');
    assert.doesNotMatch(content, /FOO/);
    assert.match(content, /^MIDDLE=keep$/m);
  });
});

// ---------------------------------------------------------------------------
// validateLock — startup + hot-reload guard against typo / disabled lock
// ---------------------------------------------------------------------------

describe('validateLock — env + preserved contexts', () => {
  const vaults = [
    { name: 'alpha', type: 'remote' },
    { name: 'beta', type: 'remote' },
  ];

  test('null/undefined candidate returns no lock + no warning', () => {
    assert.deepEqual(validateLock(null, vaults, 'env'), {
      lock: null,
      warning: null,
    });
    assert.deepEqual(validateLock(undefined, vaults, 'preserved'), {
      lock: null,
      warning: null,
    });
    assert.deepEqual(validateLock('', vaults, 'env'), {
      lock: null,
      warning: null,
    });
  });

  test('valid candidate is returned as the lock with no warning', () => {
    const result = validateLock('alpha', vaults, 'env');
    assert.equal(result.lock, 'alpha');
    assert.equal(result.warning, null);
  });

  test('env context: unknown candidate falls through with OBSIDIAN_ROUTER_LOCKED warning (A.3 regression)', () => {
    const result = validateLock('alpha-typo', vaults, 'env');
    assert.equal(result.lock, null);
    assert.match(result.warning, /OBSIDIAN_ROUTER_LOCKED="alpha-typo"/);
    assert.match(result.warning, /falling back to normal multi-vault mode/);
    assert.match(result.warning, /Active vaults: alpha, beta/);
  });

  test('preserved context: unknown candidate falls through with reload warning (B.6 regression)', () => {
    // Simulates a hot-reload where the user disabled the locked vault
    // in config.json. Without validateLock the lock would persist and
    // brick every subsequent tool call.
    const result = validateLock('alpha', [{ name: 'beta', type: 'remote' }], 'preserved');
    assert.equal(result.lock, null);
    assert.match(result.warning, /Locked vault "alpha" is no longer in the active set after config reload/);
    assert.match(result.warning, /Active vaults: beta/);
  });

  test('empty active vault list still produces a clean fall-through', () => {
    const result = validateLock('alpha', [], 'env');
    assert.equal(result.lock, null);
    assert.match(result.warning, /Active vaults: \(none\)/);
  });
});

// ---------------------------------------------------------------------------
// applyLockGuard — integration: monkey-patched resolveVault enforces lock
// ---------------------------------------------------------------------------

describe('applyLockGuard — registry.resolveVault enforces lock', () => {
  let tmpDir;
  let cfgPath;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-applylock-test-'));
    cfgPath = path.join(tmpDir, 'config.json');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // applyLockGuard is imported from `../src/index.mjs` — exercising the
  // production helper directly so any signature drift breaks these tests.

  async function makeRegistry() {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'beta', baseUrl: 'https://b/', apiKey: 'k' },
      ],
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    const reg = await loadRegistry({ configPath: cfgPath });
    applyLockGuard(reg);
    return reg;
  }

  test('no lock → resolveVault works for any active vault', async () => {
    const reg = await makeRegistry();
    assert.equal(reg.resolveVault('alpha').name, 'alpha');
    assert.equal(reg.resolveVault('beta').name, 'beta');
  });

  test('locked → resolveVault to OTHER vault throws with explicit error', async () => {
    const reg = await makeRegistry();
    reg.lockedVault = 'alpha';
    assert.throws(
      () => reg.resolveVault('beta'),
      /Router is locked to vault "alpha"/,
    );
  });

  test('locked → resolveVault without name resolves to locked vault', async () => {
    const reg = await makeRegistry();
    reg.lockedVault = 'alpha';
    assert.equal(reg.resolveVault().name, 'alpha');
    assert.equal(reg.resolveVault(undefined).name, 'alpha');
  });

  test('locked → resolveVault with locked name proceeds normally', async () => {
    const reg = await makeRegistry();
    reg.lockedVault = 'alpha';
    assert.equal(reg.resolveVault('alpha').name, 'alpha');
  });

  test('idempotent: applying applyLockGuard twice does not double-wrap', async () => {
    const reg = await makeRegistry();
    applyLockGuard(reg); // already applied in makeRegistry; this is the 2nd
    reg.lockedVault = 'alpha';
    let thrownCount = 0;
    try {
      reg.resolveVault('beta');
    } catch (err) {
      thrownCount++;
      assert.match(err.message, /Router is locked to vault "alpha"/);
    }
    assert.equal(thrownCount, 1);
  });
});

// ---------------------------------------------------------------------------
// lockVault E.2 regression: refuse persist when cwd === homedir
// ---------------------------------------------------------------------------

describe('lockVault — homedir refusal (E.2)', () => {
  let savedCwd;

  before(() => {
    savedCwd = process.cwd();
  });

  after(() => {
    process.chdir(savedCwd);
  });

  test('persist:true refuses when cwd is the user homedir', async () => {
    // Snapshot ~/.env state before to avoid false positive if a real .env exists
    const homeEnvPath = path.join(os.homedir(), '.env');
    let preExisted = true;
    try {
      await fs.access(homeEnvPath);
    } catch {
      preExisted = false;
    }

    process.chdir(os.homedir());
    const reg = {
      vaults: [{ name: 'alpha', type: 'remote' }],
      lockedVault: null,
    };
    await assert.rejects(
      () => lockVault(reg, { vault: 'alpha', persist: true }),
      /refusing to persist.*home directory/,
    );
    // In-memory lock IS still set per docstring contract
    assert.equal(reg.lockedVault, 'alpha');

    // CRITICAL: refusal must happen BEFORE any .env write. If ~/.env didn't
    // exist before, it must still not exist. If it did exist, its content
    // must not have been mutated to add OBSIDIAN_ROUTER_LOCKED.
    if (!preExisted) {
      let exists = true;
      try {
        await fs.access(homeEnvPath);
      } catch {
        exists = false;
      }
      assert.equal(exists, false, 'lock_vault must not create ~/.env on refusal');
    } else {
      const content = await fs.readFile(homeEnvPath, 'utf8');
      assert.equal(
        content.includes('OBSIDIAN_ROUTER_LOCKED'),
        false,
        'lock_vault must not mutate ~/.env on refusal',
      );
    }
  });

  test('persist:false works at homedir (no .env touched)', async () => {
    process.chdir(os.homedir());
    const reg = {
      vaults: [{ name: 'alpha', type: 'remote' }],
      lockedVault: null,
    };
    const result = await lockVault(reg, { vault: 'alpha', persist: false });
    assert.equal(reg.lockedVault, 'alpha');
    assert.equal(result.persisted, false);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 — auto-enrichment mode (canonicalizeMode + validateAutoEnrichMode)
// ---------------------------------------------------------------------------

describe('canonicalizeMode — input normalization', () => {
  test('exact canonical names pass through', () => {
    assert.equal(canonicalizeMode('ClaudeAsk'), 'ClaudeAsk');
    assert.equal(canonicalizeMode('Hybrid'), 'Hybrid');
    assert.equal(canonicalizeMode('FullAuto'), 'FullAuto');
    assert.equal(canonicalizeMode('off'), 'off');
  });

  test('case-insensitive matching', () => {
    assert.equal(canonicalizeMode('claudeask'), 'ClaudeAsk');
    assert.equal(canonicalizeMode('HYBRID'), 'Hybrid');
    assert.equal(canonicalizeMode('Fullauto'), 'FullAuto');
    assert.equal(canonicalizeMode('OFF'), 'off');
  });

  test('common aliases resolve', () => {
    assert.equal(canonicalizeMode('ask'), 'ClaudeAsk');
    assert.equal(canonicalizeMode('claude-ask'), 'ClaudeAsk');
    assert.equal(canonicalizeMode('auto'), 'FullAuto');
    assert.equal(canonicalizeMode('full'), 'FullAuto');
    assert.equal(canonicalizeMode('full-auto'), 'FullAuto');
    assert.equal(canonicalizeMode('semi'), 'Hybrid');
    assert.equal(canonicalizeMode('hybride'), 'Hybrid');
    assert.equal(canonicalizeMode('none'), 'off');
    assert.equal(canonicalizeMode('disabled'), 'off');
  });

  test('unknown input returns null', () => {
    assert.equal(canonicalizeMode('superpowers'), null);
    assert.equal(canonicalizeMode(''), null);
    assert.equal(canonicalizeMode(null), null);
    assert.equal(canonicalizeMode(undefined), null);
    assert.equal(canonicalizeMode(42), null);
  });

  test('whitespace is trimmed', () => {
    assert.equal(canonicalizeMode('  ClaudeAsk  '), 'ClaudeAsk');
    assert.equal(canonicalizeMode('\thybrid\n'), 'Hybrid');
  });

  test('VALID_MODES is the source of truth', () => {
    assert.deepEqual(VALID_MODES, ['ClaudeAsk', 'Hybrid', 'FullAuto', 'off']);
  });
});

describe('validateAutoEnrichMode — env + preserved contexts', () => {
  test('null/undefined falls back to ClaudeAsk silently', () => {
    assert.deepEqual(validateAutoEnrichMode(null, 'env'), {
      mode: 'ClaudeAsk',
      warning: null,
    });
    assert.deepEqual(validateAutoEnrichMode(undefined, 'preserved'), {
      mode: 'ClaudeAsk',
      warning: null,
    });
    assert.deepEqual(validateAutoEnrichMode('', 'env'), {
      mode: 'ClaudeAsk',
      warning: null,
    });
  });

  test('valid input returns canonical mode, no warning', () => {
    assert.deepEqual(validateAutoEnrichMode('Hybrid', 'env'), {
      mode: 'Hybrid',
      warning: null,
    });
    assert.deepEqual(validateAutoEnrichMode('fullauto', 'env'), {
      mode: 'FullAuto',
      warning: null,
    });
  });

  test('env context: invalid input falls back to ClaudeAsk with warning', () => {
    const result = validateAutoEnrichMode('superduper', 'env');
    assert.equal(result.mode, 'ClaudeAsk');
    assert.match(result.warning, /OBSIDIAN_ROUTER_AUTO_ENRICH="superduper"/);
    assert.match(result.warning, /falling back to "ClaudeAsk"/);
    assert.match(result.warning, /Valid modes: ClaudeAsk, Hybrid, FullAuto, off/);
  });

  test('preserved context: invalid input warns differently', () => {
    const result = validateAutoEnrichMode('garbled', 'preserved');
    assert.equal(result.mode, 'ClaudeAsk');
    assert.match(result.warning, /Preserved auto-enrichment mode "garbled" is not recognized after config reload/);
  });
});

// ---------------------------------------------------------------------------
// setAutoEnrichMode — handler behavior
// ---------------------------------------------------------------------------

describe('setAutoEnrichMode — tool handler', () => {
  let tmpDir;
  let savedCwd;

  before(async () => {
    savedCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-automode-test-'));
    process.chdir(tmpDir);
  });

  after(async () => {
    process.chdir(savedCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('sets registry.autoEnrichMode in-memory', async () => {
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    const result = await setAutoEnrichMode(reg, { mode: 'Hybrid' });
    assert.equal(reg.autoEnrichMode, 'Hybrid');
    assert.equal(result.mode, 'Hybrid');
    assert.equal(result.previousMode, 'ClaudeAsk');
    assert.equal(result.persisted, false);
  });

  test('canonicalizes case + alias inputs', async () => {
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    await setAutoEnrichMode(reg, { mode: 'fullauto' });
    assert.equal(reg.autoEnrichMode, 'FullAuto');
    await setAutoEnrichMode(reg, { mode: 'auto' });
    assert.equal(reg.autoEnrichMode, 'FullAuto');
    await setAutoEnrichMode(reg, { mode: 'none' });
    assert.equal(reg.autoEnrichMode, 'off');
  });

  test('rejects unknown mode with explicit error', async () => {
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    await assert.rejects(
      () => setAutoEnrichMode(reg, { mode: 'maximum-overdrive' }),
      /invalid mode "maximum-overdrive"/,
    );
    // Mode unchanged on rejection
    assert.equal(reg.autoEnrichMode, 'ClaudeAsk');
  });

  test('requires mode argument', async () => {
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    await assert.rejects(
      () => setAutoEnrichMode(reg, {}),
      /missing required argument `mode`/,
    );
  });

  test('persist:true writes OBSIDIAN_ROUTER_AUTO_ENRICH to .env', async () => {
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    const result = await setAutoEnrichMode(reg, { mode: 'Hybrid', persist: true });
    assert.equal(result.persisted, true);
    const envContent = await fs.readFile(path.join(tmpDir, '.env'), 'utf8');
    assert.match(envContent, /^OBSIDIAN_ROUTER_AUTO_ENRICH=Hybrid$/m);
  });

  test('persist:true with mode "off" writes "off" literally (Codex Critical regression)', async () => {
    // Earlier impl removed the line entirely on persist+off. That was a
    // user-facing bug: startup defaults to "ClaudeAsk" when the env var is
    // absent, so an explicit "off" chosen for sensitive/debug vaults would
    // silently revert to ClaudeAsk after restart. Now we write the literal.
    const reg = { autoEnrichMode: 'ClaudeAsk' };

    // First set a non-default mode persisted
    await setAutoEnrichMode(reg, { mode: 'FullAuto', persist: true });
    let envContent = await fs.readFile(path.join(tmpDir, '.env'), 'utf8');
    assert.match(envContent, /OBSIDIAN_ROUTER_AUTO_ENRICH=FullAuto/);

    // Now persist "off" — must WRITE off, not remove
    const result = await setAutoEnrichMode(reg, { mode: 'off', persist: true });
    envContent = await fs.readFile(path.join(tmpDir, '.env'), 'utf8');
    assert.match(envContent, /^OBSIDIAN_ROUTER_AUTO_ENRICH=off$/m);
    assert.equal(reg.autoEnrichMode, 'off');
    // Returned message must NOT claim "removed" — must claim "written"
    assert.match(result.message, /written to/);
    assert.equal(result.message.includes('Removed'), false);

    // Confirm round-trip: simulate boot with this .env value would resolve to "off"
    assert.deepEqual(canonicalizeMode('off'), 'off');
  });

  test('persist:true preserves other .env entries', async () => {
    // Pre-populate .env with unrelated entries
    await fs.writeFile(
      path.join(tmpDir, '.env'),
      'VAULT_PATH=/vaults/x\nSOME_OTHER=value\n',
      'utf8',
    );
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    await setAutoEnrichMode(reg, { mode: 'Hybrid', persist: true });
    const envContent = await fs.readFile(path.join(tmpDir, '.env'), 'utf8');
    assert.match(envContent, /VAULT_PATH=\/vaults\/x/);
    assert.match(envContent, /SOME_OTHER=value/);
    assert.match(envContent, /OBSIDIAN_ROUTER_AUTO_ENRICH=Hybrid/);
  });
});

describe('setAutoEnrichMode — homedir refusal (mirrors lock_vault E.2)', () => {
  let savedCwd;

  before(() => {
    savedCwd = process.cwd();
  });

  after(() => {
    process.chdir(savedCwd);
  });

  test('persist:true refuses when cwd is the user homedir', async () => {
    // Snapshot ~/.env state before to avoid false positive if a real .env exists
    const homeEnvPath = path.join(os.homedir(), '.env');
    let preExisted = true;
    try {
      await fs.access(homeEnvPath);
    } catch {
      preExisted = false;
    }

    process.chdir(os.homedir());
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    await assert.rejects(
      () => setAutoEnrichMode(reg, { mode: 'Hybrid', persist: true }),
      /refusing to persist.*home directory/,
    );
    // In-memory mode IS still set per docstring contract
    assert.equal(reg.autoEnrichMode, 'Hybrid');

    // Refusal must happen BEFORE any .env write — same artifact assertion as
    // the lock_vault homedir test.
    if (!preExisted) {
      let exists = true;
      try {
        await fs.access(homeEnvPath);
      } catch {
        exists = false;
      }
      assert.equal(exists, false, 'set_auto_enrich_mode must not create ~/.env on refusal');
    } else {
      const content = await fs.readFile(homeEnvPath, 'utf8');
      assert.equal(
        content.includes('OBSIDIAN_ROUTER_AUTO_ENRICH'),
        false,
        'set_auto_enrich_mode must not mutate ~/.env on refusal',
      );
    }
  });

  test('persist:false works at homedir (no .env touched)', async () => {
    process.chdir(os.homedir());
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    const result = await setAutoEnrichMode(reg, { mode: 'FullAuto', persist: false });
    assert.equal(reg.autoEnrichMode, 'FullAuto');
    assert.equal(result.persisted, false);
  });
});
