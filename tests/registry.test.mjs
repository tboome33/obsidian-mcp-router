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

const { normalizePathForCompare, resolveDefaultVault, defaultNameFromPath } = _internals;

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
  test('strips leading dot and lowercases', () => {
    assert.equal(defaultNameFromPath('C:\\VAULTS\\.template'), 'template');
  });

  test('lowercases without leading dot', () => {
    assert.equal(defaultNameFromPath('C:\\VAULTS\\TradingView'), 'tradingview');
  });

  test('handles POSIX paths', () => {
    assert.equal(defaultNameFromPath('/home/user/Vaults/Recherche'), 'recherche');
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
});
