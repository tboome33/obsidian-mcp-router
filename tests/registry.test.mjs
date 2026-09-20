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
import { dotenvLockPath, dotenvKeyLineRegex, readDotenvVarSync } from '../src/helpers/dotenv-writer.mjs';
import { parseDotenv, applyWorkspaceDotenv, _resetWorkspaceDotenvProvenance } from '../src/helpers/workspace-dotenv.mjs';
import { acquireLockAsync } from '../src/helpers/file-lock.mjs';
import { stripExtendedPathPrefix } from '../src/helpers/vault-path-identity.mjs';
import fsSync from 'node:fs';
import { confirmWorkspaceBinding } from '../src/tools/workspace-binding.mjs';
import { setAutoEnrichMode, canonicalizeMode, VALID_MODES } from '../src/tools/auto-enrich.mjs';
import { applyLockGuard, validateLock, validateAutoEnrichMode } from '../src/index.mjs';
import { buildDefaultVaultStatus } from '../src/tools/list-vaults.mjs';
import { canonicalWorkspaceKey } from '../src/helpers/workspace-bindings.mjs';
import { acquireLock, lockPathFor } from '../src/helpers/file-lock.mjs';
import { disabledSinceStart, DISABLED_SINCE_START } from '../src/helpers/vault-slug.mjs';
import { blankStringsAndComments } from './_source-scan.mjs';

const { normalizePathForCompare, resolveDefaultVault, defaultNameFromPath, pathBasename } = _internals;
const { upsertDotenvVar, removeDotenvVar } = lockInternals;

// Homedir guards must run against a throwaway home, never the operator's.
function isolatedHomeSuite() {
  let savedCwd, home, saved;
  const keys = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
  before(() => {
    savedCwd = process.cwd();
    saved = keys.map((k) => [k, process.env[k]]);
    home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'registry-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.HOMEDRIVE = '';
    process.env.HOMEPATH = home;
    assert.equal(os.homedir(), home);
  });
  after(() => {
    process.chdir(savedCwd);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fsSync.rmSync(home, { recursive: true, force: true });
  });
}

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
// pathBasename — preserves on-disk casing for obsidian:// URI composition
// ---------------------------------------------------------------------------

describe('pathBasename — exact-case basename helper (v0.10.0)', () => {
  test('Windows path preserves casing (Roland, not roland)', () => {
    assert.equal(pathBasename('C:\\VAULTS\\Roland'), 'Roland');
  });

  test('Windows path with forward slashes still detected as Windows', () => {
    assert.equal(pathBasename('C:/VAULTS/Roland'), 'Roland');
  });

  test('Windows path with leading-dot folder preserves the dot', () => {
    // Contrast with defaultNameFromPath which strips it for slug stability.
    // The Obsidian URI handler needs the actual folder name.
    assert.equal(pathBasename('C:\\VAULTS\\.template'), '.template');
  });

  test('POSIX absolute path preserves case', () => {
    assert.equal(pathBasename('/home/user/Vaults/Trading'), 'Trading');
  });

  test('UNC network share path is supported', () => {
    assert.equal(pathBasename('\\\\nas-01\\Vaults\\Wiki'), 'Wiki');
  });

  test('empty / falsy input returns empty string (does not throw)', () => {
    assert.equal(pathBasename(''), '');
    assert.equal(pathBasename(null), '');
    assert.equal(pathBasename(undefined), '');
  });

  test('non-string input is safe', () => {
    assert.equal(pathBasename(42), '');
    assert.equal(pathBasename({}), '');
  });

  test('Windows path with trailing backslash returns the last segment', () => {
    // path.win32.basename(`C:\VAULTS\Roland\`) === 'Roland'
    assert.equal(pathBasename('C:\\VAULTS\\Roland\\'), 'Roland');
  });
});

// ---------------------------------------------------------------------------
// buildDefaultVaultStatus — pure URI composition for list_vaults (v0.10.0)
// ---------------------------------------------------------------------------

describe('buildDefaultVaultStatus — default vault health summary', () => {
  // Synthetic ping result rows — mirror what `listVaults` builds internally
  // for each registry.vaults[] entry. No network involved.
  const localOnlineRow = (name, vaultPath) => ({
    name,
    type: 'local',
    path: vaultPath,
    online: true,
    latencyMs: 12,
    error: undefined,
    missingApiKey: false,
  });

  const localOfflineRow = (name, vaultPath, errMsg = 'ECONNREFUSED') => ({
    name,
    type: 'local',
    path: vaultPath,
    online: false,
    latencyMs: 5000,
    error: errMsg,
    missingApiKey: false,
  });

  const localMissingKeyRow = (name, vaultPath) => ({
    name,
    type: 'local',
    path: vaultPath,
    online: false,
    latencyMs: 0,
    error: 'no api key',
    missingApiKey: true,
  });

  const remoteOnlineRow = (name, baseUrl) => ({
    name,
    type: 'remote',
    path: undefined,
    baseUrl,
    online: true,
    latencyMs: 42,
    error: undefined,
    missingApiKey: false,
  });

  test('default vault online → status carries obsidianName + openUri + online=true', () => {
    const results = [localOnlineRow('roland', 'P:\\Mon Drive\\VAULTS\\Roland')];
    const status = buildDefaultVaultStatus('roland', results);
    assert.equal(status.name, 'roland');
    assert.equal(status.obsidianName, 'Roland');
    assert.equal(status.online, true);
    assert.equal(status.error, null);
    assert.equal(status.missingApiKey, false);
    assert.equal(status.openUri, 'obsidian://open?vault=Roland');
    assert.equal(status.path, 'P:\\Mon Drive\\VAULTS\\Roland');
    assert.equal(status.type, 'local');
  });

  test('default vault offline (ECONNREFUSED) → status.online=false + error surfaced', () => {
    const results = [localOfflineRow('roland', 'P:\\Mon Drive\\VAULTS\\Roland')];
    const status = buildDefaultVaultStatus('roland', results);
    assert.equal(status.online, false);
    assert.equal(status.error, 'ECONNREFUSED');
    // openUri must STILL be emitted on offline — that's the whole point:
    // the convention layer uses it to compose the one-click fix link.
    assert.equal(status.openUri, 'obsidian://open?vault=Roland');
  });

  test('default vault missingApiKey → status.missingApiKey=true + openUri still emitted', () => {
    const results = [localMissingKeyRow('roland', 'P:\\Mon Drive\\VAULTS\\Roland')];
    const status = buildDefaultVaultStatus('roland', results);
    assert.equal(status.missingApiKey, true);
    assert.equal(status.openUri, 'obsidian://open?vault=Roland');
    // Even with no API key, the URI is useful — opening Obsidian on the
    // vault is the first step toward fixing the missing-key state.
  });

  test('no defaultVaultName (empty registry / no cascade match) → returns null', () => {
    assert.equal(buildDefaultVaultStatus(null, []), null);
    assert.equal(buildDefaultVaultStatus(undefined, []), null);
    assert.equal(buildDefaultVaultStatus('', []), null);
  });

  test('defaultVaultName references a vault not in pingedResults → returns null', () => {
    // Pathological post-load mutation: the default name doesn't match
    // any active vault. Don't fabricate a status — let the convention
    // layer surface the inconsistency at session start.
    const results = [localOnlineRow('roland', 'P:\\VAULTS\\Roland')];
    const status = buildDefaultVaultStatus('karine', results);
    assert.equal(status, null);
  });

  test('remote default vault → obsidianName falls back to the router slug', () => {
    // Remote vaults have no `path` field, so there's no on-disk basename
    // to use. We surface the slug — the convention layer can detect
    // `type !== 'local'` and skip the openUri suggestion if it wants.
    const results = [remoteOnlineRow('tribu-dedibox', 'https://livesync.kiviri.fr/tribu')];
    const status = buildDefaultVaultStatus('tribu-dedibox', results);
    assert.equal(status.obsidianName, 'tribu-dedibox');
    assert.equal(status.openUri, 'obsidian://open?vault=tribu-dedibox');
    assert.equal(status.path, null);
    assert.equal(status.type, 'remote');
  });

  test('obsidianName with spaces is URL-encoded in openUri (P:\\Mon Drive case)', () => {
    // The Roland vault is literally `P:\Mon Drive\VAULTS\Roland`; if the
    // basename ever contains spaces (it doesn't in this layout but might
    // for other users), the URI must percent-encode them so the OS
    // handler doesn't split on the space.
    const results = [localOnlineRow('client x', 'C:\\VAULTS\\Client X')];
    const status = buildDefaultVaultStatus('client x', results);
    assert.equal(status.obsidianName, 'Client X');
    assert.equal(status.openUri, 'obsidian://open?vault=Client%20X');
  });

  test('obsidianName with accents is URL-encoded in openUri', () => {
    const results = [localOnlineRow('amelie', 'P:\\VAULTS\\Amélie')];
    const status = buildDefaultVaultStatus('amelie', results);
    assert.equal(status.obsidianName, 'Amélie');
    // encodeURIComponent yields %C3%A9 for é
    assert.equal(status.openUri, 'obsidian://open?vault=Am%C3%A9lie');
  });

  test('UNC-path vault yields openUri based on the share basename', () => {
    const results = [localOnlineRow('wiki', '\\\\nas-01\\Vaults\\Wiki')];
    const status = buildDefaultVaultStatus('wiki', results);
    assert.equal(status.obsidianName, 'Wiki');
    assert.equal(status.openUri, 'obsidian://open?vault=Wiki');
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
    delete process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS;
  });

  // afterEach mirrors beforeEach so that even if a test mutates env then
  // throws (so its own beforeEach for the next test never runs), state
  // still doesn't leak across describe blocks. v0.9.0 needs this because
  // OBSIDIAN_ROUTER_ALLOWED_VAULTS, when leaked, can wipe the vault list
  // seen by unrelated tests downstream (e.g. lockVault).
  afterEach(() => {
    delete process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT;
    delete process.env.VAULT_PATH;
    delete process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS;
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

  // -------------------------------------------------------------------------
  // OBSIDIAN_ROUTER_ALLOWED_VAULTS — Phase 1.1 (v0.9.0) opt-in whitelist
  // -------------------------------------------------------------------------

  test('v0.9.0 ALLOWED_VAULTS — unset → all vaults visible (rétrocompat)', async () => {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'beta', baseUrl: 'https://b/', apiKey: 'k' },
        { name: 'gamma', baseUrl: 'https://g/', apiKey: 'k' },
      ],
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    // env var NOT set → behaviour must be identical to v0.8.x
    const r = await loadRegistry({ configPath: cfgPath });
    assert.deepEqual(
      r.vaults.map((v) => v.name).sort(),
      ['alpha', 'beta', 'gamma'],
    );
    assert.equal(r.skipped.length, 0);
  });

  test('v0.9.0 ALLOWED_VAULTS — CSV list filters vaults[] to the whitelist', async () => {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'roland', baseUrl: 'https://r/', apiKey: 'k' },
        { name: 'karine', baseUrl: 'https://k/', apiKey: 'k' },
        { name: 'nicolas', baseUrl: 'https://n/', apiKey: 'k' },
        { name: 'tribu', baseUrl: 'https://t/', apiKey: 'k' },
      ],
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS = 'roland,tribu';
    const r = await loadRegistry({ configPath: cfgPath });
    assert.deepEqual(
      r.vaults.map((v) => v.name).sort(),
      ['roland', 'tribu'],
    );
    // skipped[] contains the filtered-out names with the explicit reason
    const skippedNames = r.skipped.map((s) => s.name).sort();
    assert.deepEqual(skippedNames, ['karine', 'nicolas']);
    for (const s of r.skipped) {
      assert.equal(s.reason, 'not in OBSIDIAN_ROUTER_ALLOWED_VAULTS whitelist');
    }
  });

  test('v0.9.0 ALLOWED_VAULTS — tolerates spaces and empty CSV entries', async () => {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'a', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'b', baseUrl: 'https://b/', apiKey: 'k' },
      ],
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS = '  a , , b  ,';
    const r = await loadRegistry({ configPath: cfgPath });
    assert.deepEqual(r.vaults.map((v) => v.name).sort(), ['a', 'b']);
  });

  test('v0.9.0 ALLOWED_VAULTS — empty string treated as unset (no filtering)', async () => {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'a', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'b', baseUrl: 'https://b/', apiKey: 'k' },
      ],
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS = '';
    const r = await loadRegistry({ configPath: cfgPath });
    assert.equal(r.vaults.length, 2, 'empty string must NOT filter');
  });

  test('v0.9.0 ALLOWED_VAULTS — filtering precedes defaultVault resolution (R3 from codex-audit)', async () => {
    // configuredDefault = "alpha" but ALLOWED_VAULTS excludes alpha → the
    // resolution cascade must NOT pick alpha (it's not in the active set
    // after filtering). It should fall through to tier 4/5 within the
    // filtered set.
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'beta', baseUrl: 'https://b/', apiKey: 'k' },
      ],
      defaultVault: 'alpha',
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS = 'beta';
    const r = await loadRegistry({ configPath: cfgPath });
    assert.equal(r.vaults.length, 1);
    assert.equal(r.vaults[0].name, 'beta');
    assert.equal(r.defaultVault, 'beta', 'defaultVault must fall through to filtered set, not point at the wiped alpha');
  });

  test('v0.9.0 ALLOWED_VAULTS — whitelist of unknown names yields empty active set', async () => {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'a', baseUrl: 'https://a/', apiKey: 'k' },
      ],
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS = 'does-not-exist,also-not';
    const r = await loadRegistry({ configPath: cfgPath });
    assert.equal(r.vaults.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].name, 'a');
  });
});

// ---------------------------------------------------------------------------
// lock_vault / unlock_vaults — tool handler tests
// ---------------------------------------------------------------------------

describe('the one-time import, re-decided INSIDE the lock against the file as it is', () => {
  const KEYS = ['OBSIDIAN_ROUTER_DEFAULT_VAULT', 'OBSIDIAN_ROUTER_LOCKED', 'OBSIDIAN_ROUTER_REFUSED_VAULT'];
  const roots = [];
  after(() => { for (const r of roots) fsSync.rmSync(r, { recursive: true, force: true }); });

  async function withCleanEnv(fn) {
    const saved = KEYS.map((k) => [k, Object.hasOwn(process.env, k), process.env[k]]);
    for (const k of KEYS) delete process.env[k];
    _resetWorkspaceDotenvProvenance();
    try { return await fn(); } finally {
      for (const [k, had, value] of saved) { if (had) process.env[k] = value; else delete process.env[k]; }
      _resetWorkspaceDotenvProvenance();
    }
  }

  test('a hinted vault a sibling DROPPED between start-up and the lock is not imported — the file re-read decides', async () => {
    // Round 16, W4 (serious): `hints.isRegistered` closed over the catalogue
    // built before the lock, so the in-lock re-decision still found the
    // vault registered and imported it over the fresh file that had lost it.
    // `loadRegistry` never leaves this window open, so the import is called
    // as it is called there, with a start-up copy and a file that moved.
    await withCleanEnv(async () => {
      const ws = fsSync.mkdtempSync(path.join(os.tmpdir(), 'import-window-ws-'));
      roots.push(ws);
      fsSync.writeFileSync(path.join(ws, '.env'), 'OBSIDIAN_ROUTER_DEFAULT_VAULT=s\n', 'utf8');
      applyWorkspaceDotenv({ cwd: ws, env: process.env, warn: () => {} });
      const cfgPath = path.join(ws, 'config.json');
      const startup = { portRegistry: {}, remoteVaults: [{ name: 's', baseUrl: 'https://s/' }] };
      // The FILE, as a sibling left it: `s` gone.
      await fs.writeFile(cfgPath, JSON.stringify({ portRegistry: {}, remoteVaults: [] }, null, 2), 'utf8');
      const prevCwd = process.cwd();
      process.chdir(ws);
      let out;
      try {
        out = _internals.importDotenvHintOnce(startup, cfgPath, [{ name: 's', type: 'remote' }]);
      } finally { process.chdir(prevCwd); }
      assert.equal(out.imported, null, 'a vault the file no longer registers was imported from the stale catalogue');
      const after = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
      assert.equal(after.workspaceBindings?.[canonicalWorkspaceKey(ws)], undefined, 'the import wrote a binding');
    });
  });

  test('an entry the router had to repair to read is not imported over, end to end — the file keeps it', async () => {
    // W4, the blocker, through the real writer: a primary-less entry holding
    // a strict secondary, and a hint naming that very secondary.
    await withCleanEnv(async () => {
      const ws = fsSync.mkdtempSync(path.join(os.tmpdir(), 'import-repair-ws-'));
      roots.push(ws);
      fsSync.writeFileSync(path.join(ws, '.env'), 'OBSIDIAN_ROUTER_DEFAULT_VAULT=s\n', 'utf8');
      applyWorkspaceDotenv({ cwd: ws, env: process.env, warn: () => {} });
      const cfgPath = path.join(ws, 'config.json');
      const entry = { also: ['s', 'envr'], alsoLocked: ['s'], alsoWritable: ['envr'] };
      const cfg = {
        portRegistry: {},
        remoteVaults: [{ name: 's', baseUrl: 'https://s/' }],
        workspaceBindings: { [canonicalWorkspaceKey(ws)]: entry },
      };
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      const prevCwd = process.cwd();
      process.chdir(ws);
      let out;
      try {
        out = _internals.importDotenvHintOnce(cfg, cfgPath, [{ name: 's', type: 'remote' }]);
      } finally { process.chdir(prevCwd); }
      assert.equal(out.imported, null, 'the import replaced an entry to repair');
      const after = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
      assert.deepEqual(after.workspaceBindings[canonicalWorkspaceKey(ws)], entry, 'the entry was rewritten');
      // And the window is NOT closed on this workspace: the hint is looked at
      // again once the entry is repaired.
      assert.ok(!(after.workspaceBindingsMigration?.imported || []).includes(canonicalWorkspaceKey(ws)), 'a repairable entry closed the window');
    });
  });
});

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
      // A CATALOGUE NO FILE LISTS IS AN ENVIRONMENT-PROVIDED ONE. Since round
      // 13 a persisted lock records only a vault a binding may name — the
      // file's names plus the environment's remotes — and most fixtures in
      // this block write a config with no vaults at all. Their vaults are
      // therefore what they always implicitly were: provided by the
      // environment (`VAULT_*`), which the registry marks `source: 'env'`.
      vaults: [
        { name: 'alpha', type: 'remote', source: 'env', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'beta', type: 'remote', source: 'env', baseUrl: 'https://b/', apiKey: 'k' },
      ],
      lockedVault: null,
    };
  }

  test('lockVault persist:true REFUSES an alsoLocked secondary (it would record it as primary and lift the hard tier); a volatile lock to it is fine', async () => {
    // Phase 3 review round 3: `recordLockInBinding` rewrites the binding with
    // the locked vault on top, and a primary is never under a write tier —
    // so a persisted lock was a one-call way past "no exceptions", through
    // the tool whose job is to RESTRICT the session.
    // ► THE FILE DECIDES, since round 13 — this fixture used to hold the hard
    //   tier in the LIVE registry only and pointed at a file that did not
    //   exist, because the in-memory preflight refused before any read. That
    //   preflight decided from a copy that could be stale, and is gone; the
    //   check inside the config lock reads the FILE's `alsoLocked`, so the
    //   tier lives there now. The in-memory lock is applied and taken back.
    const cfgPath = path.join(tmpDir, 'persist-strict-secondary.json');
    const key = canonicalWorkspaceKey(tmpDir);
    const original = `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }],
      alsoLocked: ['beta'],
      workspaceBindings: { [key]: { vault: 'alpha', also: ['beta'], locked: false, confirmedVia: 'tool' } },
    }, null, 2)}\n`;
    await fs.writeFile(cfgPath, original, 'utf8');
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      workspaceBinding: { vault: 'alpha', also: ['beta'], locked: false, alsoLocked: [], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: ['beta'],
    };
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await assert.rejects(lockVault(reg, { vault: 'beta', persist: true }), /alsoLocked SECONDARY/);
    } finally { process.chdir(prevCwd); }
    assert.equal(reg.lockedVault, null, 'the in-memory lock applied before the refusal was not taken back — half-state');
    assert.equal(await fs.readFile(cfgPath, 'utf8'), original, 'the refused promotion was written');

    const volatile = await lockVault(reg, { vault: 'beta' });
    assert.equal(volatile.locked, true);
    assert.equal(reg.lockedVault, 'beta', 'a volatile lock does not touch the binding, so beta stays a locked secondary');
  });

  test('lockVault persist:true — the FILE decides: a tier recorded there by another session refuses, rolls the in-memory lock back, and writes no .env', async () => {
    // Codex, round on fd9e1cd. The live registry knows no tier (loaded before
    // a sibling session ran set_secondary_vault_mode; `--no-watch`); the file
    // does. The preflight passes on the stale copy, and the transform used to
    // read the fresh tier and drop it with `keep` — promotion through the
    // very re-read meant to make the write safe.
    const cfgPath = path.join(tmpDir, 'stale-tier.json');
    const key = canonicalWorkspaceKey(tmpDir);
    const original = `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }],
      workspaceBindings: { [key]: { vault: 'alpha', also: ['beta'], alsoLocked: ['beta'], confirmedVia: 'tool', confirmedAt: '2026-09-05' } },
    }, null, 2)}\n`;
    await fs.writeFile(cfgPath, original, 'utf8');
    const envPath = path.join(tmpDir, '.env');
    const envBefore = await fs.readFile(envPath, 'utf8').catch(() => null);
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      workspaceBinding: { vault: 'alpha', also: ['beta'], locked: false, alsoLocked: [], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: [],
    };
    await assert.rejects(lockVault(reg, { vault: 'beta', persist: true }), /alsoLocked SECONDARY/);
    assert.equal(reg.lockedVault, null, 'the in-memory lock applied before persistence is taken back — no half-state');
    assert.equal(await fs.readFile(cfgPath, 'utf8'), original, 'the config is byte-identical');
    assert.equal(await fs.readFile(envPath, 'utf8').catch(() => null), envBefore, 'no OBSIDIAN_ROUTER_LOCKED hint for a lock that was refused');
  });

  test('lockVault persist:true REFUSES to rebuild a binding over an entry the router cannot read as written', async () => {
    // Round 10, angle B. With the repaired reading null (the entry has no
    // primary) the persist used to write `{ vault, also: [] }` over an entry
    // that still carried a secondary and its strict tier — a lock erasing
    // declarations it was never asked about. Same rule as the proposal and
    // the acceptance: repair first, and the refusal spells out what to re-pass.
    const cfgPath = path.join(tmpDir, 'persist-over-incoherent.json');
    const key = canonicalWorkspaceKey(tmpDir);
    const original = `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }],
      workspaceBindings: { [key]: { also: ['beta'], alsoLocked: ['beta'] } },
    }, null, 2)}\n`;
    await fs.writeFile(cfgPath, original, 'utf8');
    const reg = { ...makeRegistry(), configPath: cfgPath, workspaceBinding: null, alsoWritable: [], alsoLocked: [] };
    await assert.rejects(
      lockVault(reg, { vault: 'alpha', persist: true }),
      /NO BINDING WAS WRITTEN[\s\S]*names no usable primary vault[\s\S]*locked: "beta"/,
    );
    assert.equal(await fs.readFile(cfgPath, 'utf8'), original, 'the persist rebuilt the binding over the entry');
    assert.equal(reg.lockedVault, null, 'a refused persist left the in-memory lock in place');
  });

  test('lockVault persist:true to a NEW primary over an incoherent entry WITH a primary refuses too', async () => {
    // Round 11: the round-10 guard covered only a null repaired reading, so a
    // persisted lock to `gamma` over `{ vault: alpha, also: [beta, beta] }`
    // added a role on top of an entry to repair, normalising it in passing.
    const cfgPath = path.join(tmpDir, 'persist-over-incoherent-with-primary.json');
    const key = canonicalWorkspaceKey(tmpDir);
    const original = `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }, { name: 'gamma', baseUrl: 'https://c/' }],
      workspaceBindings: { [key]: { vault: 'alpha', also: ['beta', 'beta'], alsoLocked: ['beta'] } },
    }, null, 2)}\n`;
    await fs.writeFile(cfgPath, original, 'utf8');
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      vaults: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }],
      workspaceBinding: { vault: 'alpha', also: ['beta'], locked: false, alsoLocked: ['beta'], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: [],
    };
    await assert.rejects(
      lockVault(reg, { vault: 'gamma', persist: true }),
      /NO BINDING WAS WRITTEN[\s\S]*beta appears more than once/,
    );
    assert.equal(await fs.readFile(cfgPath, 'utf8'), original, 'the persist wrote over the entry');
    assert.equal(reg.lockedVault, null);
  });

  test('lockVault persist:true refusing an incoherent entry spells a PLACEHOLDER for a primary no registry knows', async () => {
    // Round 12: the third door that spells a repair went on naming
    // `vault: "ghost"`, a call the tool refuses one step later.
    const cfgPath = path.join(tmpDir, 'persist-ghost.json');
    const key = canonicalWorkspaceKey(tmpDir);
    const original = `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'beta', baseUrl: 'https://b/' }, { name: 'gamma', baseUrl: 'https://c/' }],
      workspaceBindings: { [key]: { vault: 'ghost', also: ['beta', 'beta'] } },
    }, null, 2)}\n`;
    await fs.writeFile(cfgPath, original, 'utf8');
    const reg = { ...makeRegistry(), configPath: cfgPath, vaults: [{ name: 'beta' }, { name: 'gamma' }], workspaceBinding: null, alsoWritable: [], alsoLocked: [] };
    let err = null;
    try { await lockVault(reg, { vault: 'gamma', persist: true }); } catch (e) { err = e; }
    assert.ok(err, 'the persist over an incoherent entry was applied');
    assert.match(err.message, /its primary ghost is not a vault this config file registers/);
    assert.match(err.message, /vault: "<the primary vault you intend>", also: \["beta"\]/);
    assert.doesNotMatch(err.message, /vault: "ghost"/);
    assert.match(err.message, /the lock in force before this call, if any, stays as it was/);
    assert.equal(await fs.readFile(cfgPath, 'utf8'), original);
  });

  test('unlockVaults persist:true over an INCOHERENT locked entry refuses to lift it, and says the router will re-lock', async () => {
    // Round 12: lifting a persisted lock rewrote the whole entry through the
    // normaliser, repairing in silence what the lock path refused to touch.
    const cfgPath = path.join(tmpDir, 'unlock-over-incoherent.json');
    const key = canonicalWorkspaceKey(tmpDir);
    const original = `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }],
      workspaceBindings: { [key]: { vault: 'alpha', also: ['beta', 'beta'], locked: true } },
    }, null, 2)}\n`;
    await fs.writeFile(cfgPath, original, 'utf8');
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      lockedVault: 'alpha',
      lockSource: { origin: 'binding', variable: null },
      workspaceBinding: { vault: 'alpha', also: ['beta'], locked: true, alsoLocked: [], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: [],
    };
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // The vault named is the BINDING's primary (what the file will re-lock
      // to), not what this session held in memory — here they coincide; the
      // mirror below separates them. And the condition is said right: the
      // repair keeps the lock. (Codex, round 13.)
      await assert.rejects(
        unlockVaults(reg, { persist: true }),
        // Round 14: the re-lock target after the repair is the primary THAT
        // REPAIR names — the same vault here, but a placeholder repair ends
        // with the user's choice, and "WILL re-lock to alpha" promised the old
        // name unconditionally.
        /in-memory lock cleared[\s\S]*NOT lifted[\s\S]*beta appears more than once[\s\S]*WILL re-lock — to "alpha" at the next restart if the entry is left as it is[\s\S]*to the PRIMARY THAT REPAIR NAMES[\s\S]*that repair KEEPS the lock[\s\S]*run unlock_vaults\(\{ persist: true \}\) again/,
      );
    } finally { process.chdir(prevCwd); }
    assert.equal(await fs.readFile(cfgPath, 'utf8'), original, 'the unlock normalised the entry');
  });

  test('unlockVaults persist:true refusing names the BINDING\'s primary as the re-lock target, not the in-memory one', async () => {
    // Round 13: the message said `wasLocked` — the vault this session held in
    // memory, possibly another one (a runtime lock), possibly null.
    const cfgPath = path.join(tmpDir, 'unlock-relock-target.json');
    const key = canonicalWorkspaceKey(tmpDir);
    await fs.writeFile(cfgPath, JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }],
      workspaceBindings: { [key]: { vault: 'alpha', also: ['beta', 'beta'], locked: true } },
    }, null, 2), 'utf8');
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      lockedVault: 'beta',
      lockSource: { origin: 'runtime', variable: null },
      workspaceBinding: { vault: 'alpha', also: ['beta'], locked: true, alsoLocked: [], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: [],
    };
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await assert.rejects(unlockVaults(reg, { persist: true }), /WILL re-lock — to "alpha" at the next restart/);
    } finally { process.chdir(prevCwd); }
    // "in-memory lock cleared" is measured, not read (Codex, round 13).
    assert.equal(reg.lockedVault, null);
  });

  test('lockVault persist:true is not refused by a strict tier only this session\'s stale copy holds — the file decides', async () => {
    // Round 13: `lockVault` kept its own in-memory preflight after the
    // binding tool lost its; same defect, same removal. The live registry
    // says `beta` is strict; the file does not.
    const cfgPath = path.join(tmpDir, 'persist-stale-tier.json');
    const key = canonicalWorkspaceKey(tmpDir);
    await fs.writeFile(cfgPath, JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }],
      workspaceBindings: { [key]: { vault: 'alpha', also: ['beta'], confirmedVia: 'tool' } },
    }, null, 2), 'utf8');
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      workspaceBinding: { vault: 'alpha', also: ['beta'], locked: false, alsoLocked: ['beta'], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: [],
    };
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const result = await lockVault(reg, { vault: 'beta', persist: true });
      assert.equal(result.vault, 'beta');
      const written = JSON.parse(await fs.readFile(cfgPath, 'utf8')).workspaceBindings[key];
      assert.equal(written.vault, 'beta');
      assert.equal(written.locked, true);
    } finally { process.chdir(prevCwd); }
  });

  test('lockVault persist:true REFUSES to record as primary a vault the file no longer lists, even over a coherent entry', async () => {
    // Round 13: the confirmation tool got the writer's rule in round 12; this
    // writer did not, and `lock_vault --persist old` over `{ work, also: [old] }`
    // wrote a primary the file had dropped — the next start found no such
    // vault.
    const cfgPath = path.join(tmpDir, 'persist-unbindable-target.json');
    const key = canonicalWorkspaceKey(tmpDir);
    const original = `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }],
      workspaceBindings: { [key]: { vault: 'alpha', also: ['beta'], confirmedVia: 'tool' } },
    }, null, 2)}\n`;
    await fs.writeFile(cfgPath, original, 'utf8');
    // This session still knows `beta` (loaded before a sibling dropped it).
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      vaults: [{ name: 'alpha' }, { name: 'beta' }],
      workspaceBinding: { vault: 'alpha', also: ['beta'], locked: false, alsoLocked: [], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: [],
    };
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await assert.rejects(lockVault(reg, { vault: 'beta', persist: true }), /not a vault the config file registers[\s\S]*NO BINDING WAS WRITTEN/);
    } finally { process.chdir(prevCwd); }
    assert.equal(await fs.readFile(cfgPath, 'utf8'), original, 'a primary the file does not list was recorded');
    assert.equal(reg.lockedVault, null, 'a refused persist left a volatile lock behind');
  });

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

  test('lockVault with persist:true writes the .env HINT, and says the lock does not survive without a config', async () => {
    // `persisted` means "will survive a restart", and since v0.90.0 only the
    // BINDING in the user's own config does that: a lock named by a project
    // `.env` is refused at start-up like any other setting a cloned file
    // proposes. This registry has no `configPath`, so the binding cannot be
    // written — and the honest answer is that the lock is not persisted, even
    // though the dotenv line was written.
    //
    // Before this, the tool returned `persisted: true` here and a message
    // promising the lock survived a restart. Codex flagged the mismatch on
    // 2026-09-03; closing the gate the same day turned it from misleading
    // into false.
    const reg = makeRegistry();
    const envPath = path.join(tmpDir, '.env');
    await fs.rm(envPath, { force: true });

    const result = await lockVault(reg, { vault: 'alpha', persist: true });
    assert.equal(result.hintWritten, true, 'the portable hint IS written');
    assert.equal(result.persisted, false, 'but nothing persists it');
    assert.equal(result.bindingRecorded, null);
    assert.match(result.message, /does NOT survive a restart/);
    const envContent = await fs.readFile(envPath, 'utf8');
    assert.match(envContent, /^OBSIDIAN_ROUTER_LOCKED=alpha$/m);
  });

  test('lockVault with persist:true and a writable config DOES persist, through the binding', async () => {
    const reg = makeRegistry();
    const configPath = path.join(tmpDir, 'lock-config.json');
    await fs.writeFile(configPath, JSON.stringify({ portRegistry: {} }), 'utf8');
    reg.configPath = configPath;
    await fs.rm(path.join(tmpDir, '.env'), { force: true });

    const result = await lockVault(reg, { vault: 'alpha', persist: true });
    assert.equal(result.persisted, true);
    assert.equal(result.hintWritten, true, 'the hint travels; the binding persists');
    assert.equal(result.bindingRecorded?.vault, 'alpha');
    assert.equal(result.bindingRecorded?.locked, true);
    assert.match(result.message, /survives a restart/);

    // And it is really on disk, under this workspace's canonical key.
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const entry = written.workspaceBindings?.[canonicalWorkspaceKey(process.cwd())];
    assert.equal(entry?.vault, 'alpha');
    assert.equal(entry?.locked, true);
  });

  test('lockVault with persist:true REPORTS a .env that cannot be written — the binding is recorded, the call does not fail', async () => {
    // Round on 1fad78c: the dotenv write threw raw after the binding had been
    // recorded and the lock applied, so the caller saw a failed lock that was
    // in fact in force and persisted.
    const reg = makeRegistry();
    const configPath = path.join(tmpDir, 'lock-config-ro.json');
    await fs.writeFile(configPath, JSON.stringify({ portRegistry: {} }), 'utf8');
    reg.configPath = configPath;
    const envPath = path.join(tmpDir, '.env');
    await fs.writeFile(envPath, 'KEEP=1\n', 'utf8');
    await fs.chmod(envPath, 0o444);
    try {
      const result = await lockVault(reg, { vault: 'alpha', persist: true });
      assert.equal(result.persisted, true, 'the half that decides is recorded');
      assert.equal(result.hintWritten, false);
      assert.match(result.hintError, /EPERM|EACCES/);
      assert.match(result.message, /survives a restart/);
      assert.match(result.message, /could NOT be written/);
      assert.equal(reg.lockedVault, 'alpha', 'and the lock is in force');
      assert.equal(await fs.readFile(envPath, 'utf8'), 'KEEP=1\n', 'the file is untouched');
    } finally {
      await fs.chmod(envPath, 0o644);
    }
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

  test('lockVault --persist onto ANOTHER vault keeps the previous primary and its secondaries', async () => {
    // The PUBLIC path for the defect the private suite pinned. Every other
    // test of that wiring calls `recordLockInBinding` directly, so a caller
    // mutation — `lock_vault` writing its own binding instead of going through
    // the helper — would leave them all green while the tool silently dropped
    // vaults from the user's own config.
    //
    // Locking onto `beta` when the workspace goes with `alpha` (and `gamma`
    // also bound) used to leave `{ vault: 'beta', also: [] }`: two bindings
    // the user had recorded, gone, from an operation whose subject is
    // something else entirely. Found in the final review, 2026-09-03.
    const configPath = path.join(tmpDir, 'lock-carry-config.json');
    const key = canonicalWorkspaceKey(process.cwd());
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      workspaceBindings: { [key]: { vault: 'alpha', also: ['gamma'], locked: false, confirmedVia: 'tool' } },
    }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });

    const reg = makeRegistry();
    reg.configPath = configPath;
    const result = await lockVault(reg, { vault: 'beta', persist: true });

    assert.equal(result.persisted, true);
    const entry = JSON.parse(await fs.readFile(configPath, 'utf8')).workspaceBindings[key];
    assert.equal(entry.vault, 'beta', 'the locked vault becomes the primary');
    assert.deepEqual(entry.also, ['alpha', 'gamma'], 'and nothing the user recorded is lost');
    assert.equal(entry.locked, true);
    // The live session agrees with the file it just wrote — including the
    // DEFAULT, which is tier 0 of the cascade and moved with the primary.
    assert.equal(reg.workspaceBinding.vault, 'beta');
    assert.equal(reg.defaultVault, 'beta');
    assert.deepEqual(reg.defaultVaultSource, { origin: 'binding', variable: null });
  });

  test('unlockVaults --persist on a workspace with NO binding reports success, not a phantom lock', async () => {
    // The PUBLIC half of the sentinel. `bindingLifted: false` is relayed by
    // `skills/unlock` as "the lock is still recorded in the router config and
    // WILL come back at the next start" — for a workspace that never had a
    // binding, that sentence sends the user hunting for a lock nobody set.
    // Only the private helper's return was pinned, so the caller could
    // reinterpret it and nothing went red. (Codex, round 5.)
    const configPath = path.join(tmpDir, 'unlock-none-config.json');
    await fs.writeFile(configPath, JSON.stringify({ portRegistry: {} }), 'utf8');
    await fs.writeFile(path.join(tmpDir, '.env'), 'OBSIDIAN_ROUTER_LOCKED=alpha\n', 'utf8');

    const reg = makeRegistry();
    reg.configPath = configPath;
    reg.lockedVault = 'alpha';
    const result = await unlockVaults(reg, { persist: true });

    assert.equal(result.bindingLifted, true, 'nothing is recorded, so nothing comes back');
    assert.equal(result.persisted, true, 'and the unlock does survive a restart');
    assert.match(result.message, /No lock is recorded for this workspace/);
    assert.doesNotMatch(result.message, /could NOT be written/);
    // Nothing was invented on disk to say so.
    const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(after.workspaceBindings, undefined);
  });

  test('unlockVaults --persist that writes NOTHING moves neither the binding nor the default', async () => {
    // THIS TEST ASSERTED THE OPPOSITE, and the history is worth more than the
    // assertion. An earlier round found the no-write lift path refreshing
    // `workspaceBinding` but NOT `defaultVault`: a session started on `alpha`,
    // re-bound to `beta` by a sibling, came out reporting `beta` while routing
    // every unqualified call to `alpha`. A registry contradicting itself. The
    // fix then was to adopt BOTH.
    //
    // The binding lot's seventh round showed the pair should not move at all.
    // `registry.workspaceBinding` is what `isVaultReachable` consults on every
    // call, so adopting a sibling's binding changes which vaults answer — and
    // doing it from a call that wrote nothing is a re-route the user never
    // asked for. Lifting a lock is not re-binding. Moving NEITHER keeps the
    // two halves consistent, which was the real complaint, and leaves a no-op
    // a no-op.
    const configPath = path.join(tmpDir, 'unlock-adopt-config.json');
    const key = canonicalWorkspaceKey(process.cwd());
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      workspaceBindings: { [key]: { vault: 'beta', also: [], locked: false, confirmedVia: 'tool' } },
    }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });

    const reg = makeRegistry();
    reg.configPath = configPath;
    reg.lockedVault = 'alpha';
    reg.defaultVault = 'alpha';
    reg.defaultVaultSource = { origin: 'config', variable: null };
    reg.workspaceBinding = { vault: 'alpha', also: [], locked: true, confirmedVia: 'tool' };
    await unlockVaults(reg, { persist: true });

    assert.equal(reg.workspaceBinding.vault, 'alpha', 'a call that wrote nothing installed another binding');
    assert.equal(reg.defaultVault, 'alpha', 'a call that wrote nothing re-routed unqualified calls');
    assert.deepEqual(reg.defaultVaultSource, { origin: 'config', variable: null });
    // The two halves agree, which is what the earlier round actually wanted.
    assert.equal(reg.workspaceBinding.vault, reg.defaultVault);
  });

  test('...and one that writes a binding whose primary is UNKNOWN here adopts it, with a coherent default', async () => {
    // ► MUTATION WITNESS: gate the adoption on the primary being resolvable,
    //   as round 8 did, and this goes red — the write is not applied.
    //
    // THIS TEST ASSERTED "ADOPTS NEITHER" UNTIL ROUND 9, and the correction
    // matters more than the assertion. Round 7 gated the DEFAULT on "can this
    // session resolve the primary" and adopted the binding anyway: the default
    // ended up undeclared by the binding in force. Round 8 gated BOTH — and
    // produced something worse and quieter, a write this session REFUSED TO
    // APPLY. For the sibling tool that records a secondary's write TIER, that
    // means a restriction the user asked for, confirmed to them, and silently
    // not in force.
    //
    // A write is the user's instruction and the file is the truth, so it is
    // adopted. The primary's resolvability decides only the DEFAULT, and the
    // real cascade answers that — the binding's primary when it resolves,
    // whatever is reachable otherwise. Coherent either way. (Codex, round 9.)
    const configPath = path.join(tmpDir, 'unlock-unresolvable-config.json');
    const key = canonicalWorkspaceKey(process.cwd());
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      workspaceBindings: { [key]: { vault: 'gamma', also: [], locked: true, confirmedVia: 'tool' } },
    }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });

    const reg = makeRegistry(); // knows `alpha` and `beta` only — never `gamma`
    reg.configPath = configPath;
    reg.lockedVault = 'gamma';
    reg.defaultVault = 'alpha';
    reg.defaultVaultSource = { origin: 'config', variable: null };
    reg.workspaceBinding = { vault: 'alpha', also: [], locked: true, confirmedVia: 'tool' };
    await unlockVaults(reg, { persist: true });

    // The write happened, and this session applies it.
    const written = JSON.parse(await fs.readFile(configPath, 'utf8')).workspaceBindings[key];
    assert.equal(written.locked, false, 'the unlock was not persisted');
    assert.equal(reg.workspaceBinding.vault, 'gamma', 'the write this session made was not applied to it');
    assert.equal(reg.workspaceBinding.locked, false, 'the session kept a lock the file no longer holds');

    // And the default is coherent with it: `gamma` does not resolve here, so
    // the cascade answers instead of the binding. What it must never be is the
    // old `alpha` presented as a binding-chosen default while the binding in
    // force is `gamma` — the state round 7 produced.
    assert.notEqual(reg.defaultVault, 'gamma', 'the default names a vault this session cannot resolve');
    if (reg.defaultVault === undefined || reg.defaultVault === null) {
      assert.equal(reg.defaultVaultSource.origin, 'unset', 'no default, but a source that claims one');
    } else {
      assert.ok(
        reg.vaults.some((v) => v.name === reg.defaultVault),
        `the default "${reg.defaultVault}" is not one this session can resolve`,
      );
      assert.notEqual(
        reg.defaultVaultSource.origin,
        'binding',
        'the default is credited to a binding whose primary this session does not have',
      );
    }
  });

  test('...and one that DOES write adopts the binding and the default together', async () => {
    // The other half of the same rule: when the lift really changes the file,
    // the session follows it, both fields at once. Without this the repair
    // above would read as "never adopt", which is not what it says.
    const configPath = path.join(tmpDir, 'unlock-adopt-write-config.json');
    const key = canonicalWorkspaceKey(process.cwd());
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      workspaceBindings: { [key]: { vault: 'beta', also: [], locked: true, confirmedVia: 'tool' } },
    }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });

    const reg = makeRegistry();
    reg.configPath = configPath;
    reg.lockedVault = 'beta';
    reg.defaultVault = 'alpha';
    reg.defaultVaultSource = { origin: 'config', variable: null };
    await unlockVaults(reg, { persist: true });

    assert.equal(reg.workspaceBinding.vault, 'beta', 'the write was not adopted');
    assert.equal(reg.defaultVault, 'beta', 'the default did not follow the binding it just wrote');
    assert.deepEqual(reg.defaultVaultSource, { origin: 'binding', variable: null });
  });

  test('unlockVaults --persist reports persisted:FALSE when the config cannot be written', async () => {
    // `persisted` used to be `persist === true` — a report of what the caller
    // ASKED FOR. So an unwritable config returned `persisted: true` beside
    // `bindingLifted: false`, two fields of one response contradicting each
    // other while the binding stayed locked and came back at the next start.
    const configPath = path.join(tmpDir, 'unlock-locked-config.json');
    const key = canonicalWorkspaceKey(process.cwd());
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      workspaceBindings: { [key]: { vault: 'alpha', also: [], locked: true, confirmedVia: 'tool' } },
    }), 'utf8');
    await fs.writeFile(path.join(tmpDir, '.env'), 'OBSIDIAN_ROUTER_LOCKED=alpha\n', 'utf8');

    const reg = makeRegistry();
    reg.configPath = configPath;
    reg.lockedVault = 'alpha';
    // Hold the config lock so the write is refused rather than clobbering.
    const release = acquireLock(lockPathFor(configPath, 'config'), { waitMs: 0 });
    assert.ok(release, 'the test must actually hold the lock');
    let result;
    try {
      result = await unlockVaults(reg, { persist: true });
    } finally {
      release();
    }
    assert.equal(result.bindingLifted, false);
    assert.equal(result.persisted, false, 'the two fields must agree');
    // And the lock really is still on disk, which is what the message claims.
    const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(after.workspaceBindings[key].locked, true);
  });

  test('unlockVaults with persist:true lifts the lock IN THE CONFIG but keeps the binding', async () => {
    // The public half of the lock↔binding wiring. Every other test of that
    // wiring calls the private `recordLockInBinding` directly, so removing the
    // call sites in src/tools/lock.mjs would leave them all green while
    // `unlock_vaults --persist` silently stopped lifting anything — and, since
    // v0.90.0, the binding is the ONLY thing a restart reads a lock from, so
    // the user would be re-locked at every start with no line to delete.
    // Codex flagged the gap on 2026-09-03.
    const configPath = path.join(tmpDir, 'unlock-config.json');
    const key = canonicalWorkspaceKey(process.cwd());
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      workspaceBindings: { [key]: { vault: 'alpha', also: ['beta'], locked: true, confirmedVia: 'tool' } },
    }), 'utf8');
    await fs.writeFile(path.join(tmpDir, '.env'), 'OBSIDIAN_ROUTER_LOCKED=alpha\n', 'utf8');

    const reg = makeRegistry();
    reg.configPath = configPath;
    reg.lockedVault = 'alpha';
    const result = await unlockVaults(reg, { persist: true });

    assert.equal(result.bindingLifted, true);
    const after = JSON.parse(await fs.readFile(configPath, 'utf8')).workspaceBindings[key];
    assert.equal(after.locked, false, 'the lock is lifted');
    assert.equal(after.vault, 'alpha', 'the workspace still goes with its vault');
    assert.deepEqual(after.also, ['beta'], 'and keeps its secondaries');
    assert.equal(after.confirmedVia, 'tool', 'the original provenance is not rewritten');
  });

  // -------------------------------------------------------------------------
  // Sixth review, 2026-09-04 — "the system says one thing and does another".
  // -------------------------------------------------------------------------

  const clearSeams = () => ({
    cwd: tmpDir,
    ping: async () => ({ online: true }),
    launch: () => ({ launched: false, uri: null, reason: 'test' }),
  });

  test('a PERSISTED lock is the binding\'s lock: clearing the binding releases it, and the source says so', async () => {
    // lock_vault --persist recorded the lock on the binding and kept
    // `lockSource: runtime`; `confirm_workspace_binding({ clear: true })`
    // releases a lock by asking who imposed it (round 5), so it left the
    // session locked to a vault whose binding it had just deleted, while
    // answering "all registered vaults are available again". The next start
    // then disagreed with the session.
    const configPath = path.join(tmpDir, 'lock-clear-config.json');
    await fs.writeFile(configPath, JSON.stringify({ portRegistry: {} }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });
    const reg = { ...makeRegistry(), configPath, defaultVault: 'alpha', defaultVaultSource: { origin: 'config', variable: null } };

    const locked = await lockVault(reg, { vault: 'alpha', persist: true });
    assert.equal(locked.persisted, true);
    assert.deepEqual(reg.lockSource, { origin: 'binding', variable: null },
      'a lock that is recorded on the binding is credited to the binding');

    const r = await confirmWorkspaceBinding(reg, { clear: true }, clearSeams());
    assert.equal(r.cleared, true);
    assert.equal(reg.lockedVault, null, 'the session really is unlocked, as the message says');
    assert.doesNotMatch(r.message, /still locked/);
  });

  test('a VOLATILE lock survives a clear, and the answer names it instead of contradicting it', async () => {
    const configPath = path.join(tmpDir, 'lock-clear-volatile-config.json');
    const key = canonicalWorkspaceKey(tmpDir);
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      workspaceBindings: { [key]: { vault: 'beta', confirmedVia: 'tool' } },
    }), 'utf8');
    const reg = { ...makeRegistry(), configPath, defaultVault: 'beta', defaultVaultSource: { origin: 'binding', variable: null } };

    await lockVault(reg, { vault: 'alpha' });
    const r = await confirmWorkspaceBinding(reg, { clear: true }, clearSeams());
    assert.equal(reg.lockedVault, 'alpha', 'this session\'s own lock is not the binding\'s to lift');
    assert.match(r.message, /vaultReach.*openVaults.*possibly none/);
    assert.match(r.message, /still locked to "alpha" by this session's own lock_vault call; unlock_vaults lifts it/,
      'but the sentence must not stop at "available again" while the guard refuses every other vault');
  });

  test('unlock_vaults --persist after a BINDING lock shadowed a HOST lock still says the host WILL re-lock', async () => {
    // Round 15, O1 (open since round 14): a confirmed `locked: true` binding
    // set the lock's source to `binding`, so `hostReimposes` read false, the
    // unlock said "will not come back on restart", and the next start
    // re-imposed the host's OBSIDIAN_ROUTER_LOCKED. The variable is what
    // re-imposes; the variable is what is asked.
    const configPath = path.join(tmpDir, 'host-shadowed-unlock-config.json');
    const key = canonicalWorkspaceKey(tmpDir);
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }],
      workspaceBindings: { [key]: { vault: 'alpha', also: [], locked: true, confirmedVia: 'tool' } },
    }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });
    const reg = {
      ...makeRegistry(),
      configPath,
      lockedVault: 'alpha',
      lockSource: { origin: 'binding', variable: null },
      workspaceBinding: { vault: 'alpha', also: [], locked: true, alsoLocked: [], alsoWritable: [] },
    };
    const hadEnv = Object.hasOwn(process.env, 'OBSIDIAN_ROUTER_LOCKED');
    const prevEnv = process.env.OBSIDIAN_ROUTER_LOCKED;
    process.env.OBSIDIAN_ROUTER_LOCKED = 'alpha';
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    let r;
    try {
      r = await unlockVaults(reg, { persist: true });
    } finally {
      process.chdir(prevCwd);
      if (hadEnv) process.env.OBSIDIAN_ROUTER_LOCKED = prevEnv; else delete process.env.OBSIDIAN_ROUTER_LOCKED;
    }
    assert.equal(r.bindingLifted, true, 'the binding lock was not lifted');
    assert.equal(r.hostReimposes, true, 'the host lock behind the binding lock went unseen');
    assert.equal(r.persisted, false);
    // WHICH lock the host holds is said: the one lifted came from the binding
    // (round 16 — "this lock came from the host" named a binding lock).
    assert.match(r.message, /The lock just lifted came from the binding, but the host also declares one[\s\S]*OBSIDIAN_ROUTER_LOCKED=alpha[\s\S]*comes back at the next start, for as long as that variable is set/);
    assert.doesNotMatch(r.message, /This lock came from the host/);
    assert.doesNotMatch(r.message, /will not come back on restart/);
  });

  test('unlock_vaults --persist does NOT predict a host re-lock the start-up validation would reject', async () => {
    // Round 16, R105: round 15 read the variable's presence as a lock to
    // come. Start-up validates the candidate — known to the catalogue AND
    // reachable from this workspace — and rejects it otherwise; so does this.
    const configPath = path.join(tmpDir, 'host-unreachable-unlock-config.json');
    const key = canonicalWorkspaceKey(tmpDir);
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }],
      vaultReach: 'declared',
      openVaults: [],
      workspaceBindings: { [key]: { vault: 'alpha', also: [], locked: true, confirmedVia: 'tool' } },
    }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });
    const reg = {
      ...makeRegistry(),
      configPath,
      vaultReach: 'declared',
      openVaults: [],
      lockedVault: 'alpha',
      lockSource: { origin: 'binding', variable: null },
      workspaceBinding: { vault: 'alpha', also: [], locked: true, alsoLocked: [], alsoWritable: [] },
    };
    const hadEnv = Object.hasOwn(process.env, 'OBSIDIAN_ROUTER_LOCKED');
    const prevEnv = process.env.OBSIDIAN_ROUTER_LOCKED;
    // `beta` is registered but this workspace does not declare it: start-up
    // rejects such a host lock.
    process.env.OBSIDIAN_ROUTER_LOCKED = 'beta';
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    let r;
    try {
      r = await unlockVaults(reg, { persist: true });
    } finally {
      process.chdir(prevCwd);
      if (hadEnv) process.env.OBSIDIAN_ROUTER_LOCKED = prevEnv; else delete process.env.OBSIDIAN_ROUTER_LOCKED;
    }
    assert.equal(r.bindingLifted, true);
    assert.equal(r.hostReimposes, false, 'a host candidate this workspace cannot reach was predicted to re-lock');
    assert.equal(r.persisted, true);
    assert.match(r.message, /will not come back on restart/);
  });

  test('lockVault persist:true REFUSES a DISABLED target as disabled — not "register it, then lock again"', async () => {
    // Round 15: the refusal on an unbindable target had one remedy for two
    // causes, and sent the owner of a disabled vault to re-register it.
    const cfgPath = path.join(tmpDir, 'persist-disabled-target.json');
    const key = canonicalWorkspaceKey(tmpDir);
    const original = `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }],
      disabledVaults: ['beta'],
      workspaceBindings: { [key]: { vault: 'alpha', also: ['beta'], confirmedVia: 'tool' } },
    }, null, 2)}\n`;
    await fs.writeFile(cfgPath, original, 'utf8');
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      vaults: [{ name: 'alpha' }, { name: 'beta' }],
      workspaceBinding: { vault: 'alpha', also: ['beta'], locked: false, alsoLocked: [], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: [],
    };
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await assert.rejects(
        lockVault(reg, { vault: 'beta', persist: true }),
        (e) => /is DISABLED by `disabledVaults`/.test(e.message)
          && /remove it from `disabledVaults` first, then lock again/.test(e.message)
          && !/Register it/.test(e.message),
      );
    } finally { process.chdir(prevCwd); }
    assert.equal(await fs.readFile(cfgPath, 'utf8'), original);
    assert.equal(reg.lockedVault, null);
  });

  test('lockVault --persist onto ANOTHER vault NAMES the previous primary it carries over when this session cannot resolve it', async () => {
    // Round 15, O2 (open since round 14): the previous primary becomes a
    // secondary by this call even when the file dropped it — kept by the
    // round-13 rule, and unsaid. The success now says what it is from here.
    const cfgPath = path.join(tmpDir, 'persist-carries-old-primary.json');
    const key = canonicalWorkspaceKey(tmpDir);
    await fs.writeFile(cfgPath, `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 's', baseUrl: 'https://s/' }],
      workspaceBindings: { [key]: { vault: 'gone', also: ['s'], confirmedVia: 'tool' } },
    }, null, 2)}\n`, 'utf8');
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      vaults: [{ name: 'alpha' }, { name: 's' }],
      workspaceBinding: { vault: 'gone', also: ['s'], locked: false, alsoLocked: [], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: [],
    };
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    let r;
    try { r = await lockVault(reg, { vault: 'alpha', persist: true }); } finally { process.chdir(prevCwd); }
    assert.equal(r.persisted, true, r.message);
    assert.deepEqual(r.bindingRecorded, { vault: 'alpha', locked: true, also: ['gone', 's'] });
    assert.deepEqual(r.notLoadedHere, ['gone']);
    // "(tier kept)" was wrong for a previous primary, which acquires the soft
    // tier by this very call (round 16).
    assert.match(r.message, /"gone" stays declared in the binding \(with the tier the binding now records for it\) but this session has not loaded it — neither in the config file as this session reads it nor provided by its environment/);
    assert.doesNotMatch(r.message, /tier kept/);
    assert.match(r.message, /While the lock holds, no vault but the primary answers anyway/);
    assert.doesNotMatch(r.message, /"s" stays declared/);
  });

  test('lockVault --persist: a carried secondary DISABLED after this session loaded it is not "not loaded here"', async () => {
    // Round 16: `notLoadedHere` on the lock's result counted every disabled
    // secondary, loaded or not; the confirmation tool asks the catalogue.
    const cfgPath = path.join(tmpDir, 'persist-carries-disabled-loaded.json');
    const key = canonicalWorkspaceKey(tmpDir);
    await fs.writeFile(cfgPath, `${JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 's', baseUrl: 'https://s/' }],
      disabledVaults: ['s'],
      workspaceBindings: { [key]: { vault: 'alpha', also: ['s'], confirmedVia: 'tool' } },
    }, null, 2)}\n`, 'utf8');
    const reg = {
      ...makeRegistry(),
      configPath: cfgPath,
      vaults: [{ name: 'alpha' }, { name: 's' }],
      workspaceBinding: { vault: 'alpha', also: ['s'], locked: false, alsoLocked: [], alsoWritable: [] },
      alsoWritable: [],
      alsoLocked: [],
    };
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    let r;
    try { r = await lockVault(reg, { vault: 'alpha', persist: true }); } finally { process.chdir(prevCwd); }
    assert.equal(r.persisted, true, r.message);
    assert.deepEqual(r.notLoadedHere, [], 'a disabled secondary this session still holds was counted as not loaded');
    assert.match(r.message, /"s" stays declared in the binding[^.]*DISABLED by `disabledVaults` in the config file since this session started: this session still holds its descriptor, so it may still answer here/);
    assert.doesNotMatch(r.message, /Unknown vault/);
  });

  test('unlock_vaults --persist under a HOST lock says it WILL come back, and persisted is false', async () => {
    // OBSIDIAN_ROUTER_LOCKED from the MCP declaration or the shell is
    // re-imposed at every start; nothing the config says lifts it. The
    // message used to promise "it will not come back on restart".
    const configPath = path.join(tmpDir, 'host-unlock-config.json');
    await fs.writeFile(configPath, JSON.stringify({ portRegistry: {} }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });
    const reg = { ...makeRegistry(), configPath, lockedVault: 'alpha', lockSource: { origin: 'host', variable: 'OBSIDIAN_ROUTER_LOCKED' } };

    const r = await unlockVaults(reg, { persist: true });
    assert.equal(reg.lockedVault, null, 'the in-memory lock is lifted for this session');
    assert.equal(r.hostReimposes, true);
    assert.equal(r.persisted, false, '"survives a restart" is false when the host re-imposes the lock');
    assert.match(r.message, /came from the host/);
    // "WILL come back" was a certainty about a start-up this call cannot see:
    // the variable may be unset, and the vault it names may be disabled or
    // gone by then. The condition is said instead (round 17).
    assert.match(r.message, /comes back at the next start, for as long as that variable is set and the vault it names is loaded and reachable then/);
    assert.doesNotMatch(r.message, /will not come back on restart/);

    // And the volatile form says the same thing in fewer words.
    const reg2 = { ...makeRegistry(), lockedVault: 'alpha', lockSource: { origin: 'host', variable: 'OBSIDIAN_ROUTER_LOCKED' } };
    const r2 = await unlockVaults(reg2, {});
    assert.match(r2.message, /came from the host .* comes back on restart while that variable is set/);
  });

  test('unlock_vaults: a VOLATILE lock this session set is not called "the binding" when a host lock exists', async () => {
    // Round 16 split the host message on `liftedCameFromHost` alone, so every
    // other origin became "the binding" — including `runtime`, the origin
    // `lock_vault` itself sets. The user reads that their CONFIG held a lock
    // they never persisted. (Codex, round 17.)
    const configPath = path.join(tmpDir, 'runtime-vs-binding-config.json');
    await fs.writeFile(configPath, JSON.stringify({ portRegistry: {} }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });
    const prev = process.env.OBSIDIAN_ROUTER_LOCKED;
    process.env.OBSIDIAN_ROUTER_LOCKED = 'alpha';
    try {
      const reg = {
        ...makeRegistry(),
        configPath,
        vaults: [{ name: 'alpha' }],
        // This session called lock_vault: the origin is `runtime`, not `binding`.
        lockedVault: 'beta',
        lockSource: { origin: 'runtime', variable: null },
      };
      const prevCwd = process.cwd();
      process.chdir(tmpDir);
      let r;
      try { r = await unlockVaults(reg, { persist: true }); } finally { process.chdir(prevCwd); }
      assert.equal(r.hostReimposes, true, 'the host declares a lock on a vault this session can reach');
      assert.match(r.message, /came from this session \(lock_vault\)/);
      assert.doesNotMatch(r.message, /just lifted came from the binding/);

      // The volatile form carries the same distinction.
      const reg2 = {
        ...makeRegistry(),
        configPath,
        vaults: [{ name: 'alpha' }],
        lockedVault: 'beta',
        lockSource: { origin: 'runtime', variable: null },
      };
      const r2 = await unlockVaults(reg2, {});
      assert.match(r2.message, /the lock just lifted came from this session/);
      assert.doesNotMatch(r2.message, /this lock came from the host/);
    } finally {
      if (prev === undefined) delete process.env.OBSIDIAN_ROUTER_LOCKED;
      else process.env.OBSIDIAN_ROUTER_LOCKED = prev;
    }
  });

  test('the host prediction is made on the binding this call LEAVES, not the one it replaces', async () => {
    // `isVaultReachable` answers from the workspace's binding, and the
    // persisted unlock ADOPTS the file's binding on its way through
    // (`recordLockInBinding` writes, then takes the file's entry). Round 16
    // computed the prediction before that write: a host candidate the OLD
    // binding did not declare was judged unreachable, "persisted: true",
    // "will not come back on restart" — and the next start re-imposed it,
    // because by then the workspace was bound to it. (Codex, round 17, D.)
    const configPath = path.join(tmpDir, 'host-after-adoption.json');
    const key = canonicalWorkspaceKey(tmpDir);
    await fs.writeFile(configPath, JSON.stringify({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/' }, { name: 'beta', baseUrl: 'https://b/' }],
      // THE FILE: a sibling re-bound this workspace to `beta`.
      workspaceBindings: { [key]: { vault: 'beta', also: [], locked: true, confirmedVia: 'tool' } },
    }), 'utf8');
    await fs.rm(path.join(tmpDir, '.env'), { force: true });
    const reg = {
      ...makeRegistry(),
      configPath,
      vaults: [{ name: 'alpha' }, { name: 'beta' }],
      vaultReach: 'declared',
      openVaults: [],
      // THIS SESSION: still on the older binding, which does not declare `beta`.
      workspaceBinding: { vault: 'alpha', also: [], locked: true, alsoLocked: [], alsoWritable: [] },
      lockedVault: 'alpha',
      lockSource: { origin: 'binding', variable: null },
      alsoLocked: [],
      alsoWritable: [],
    };
    const hadEnv = Object.hasOwn(process.env, 'OBSIDIAN_ROUTER_LOCKED');
    const prevEnv = process.env.OBSIDIAN_ROUTER_LOCKED;
    process.env.OBSIDIAN_ROUTER_LOCKED = 'beta';
    const prevCwd = process.cwd();
    process.chdir(tmpDir);
    let r;
    try {
      r = await unlockVaults(reg, { persist: true });
    } finally {
      process.chdir(prevCwd);
      if (hadEnv) process.env.OBSIDIAN_ROUTER_LOCKED = prevEnv; else delete process.env.OBSIDIAN_ROUTER_LOCKED;
    }
    assert.equal(reg.workspaceBinding.vault, 'beta', 'the persisted unlock did not adopt the file\'s binding');
    assert.equal(r.hostReimposes, true,
      'the host candidate was judged against the binding this call replaced');
    assert.equal(r.persisted, false, '"survives a restart" cannot be true when the host re-imposes');
    assert.doesNotMatch(r.message, /will not come back on restart/);
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

  test('an `export KEY=` line IS the key: updated in place, prefix kept, never shadowed by an appended twin', async () => {
    // `parseDotenv` strips `export `, so the loader read the exported line
    // FIRST and the bare line the writer appended was dead — a persisted
    // setting that never took effect. (Codex, round on b59eb00.)
    await fs.writeFile(envPath, 'export FOO=old\nB=2\n', 'utf8');
    await upsertDotenvVar(envPath, 'FOO', 'new');
    const content = await fs.readFile(envPath, 'utf8');
    assert.equal(content, 'export FOO=new\nB=2\n');
    assert.equal((content.match(/FOO=/g) || []).length, 1, 'one line, not two');
    // And removal sees it too.
    assert.equal(await removeDotenvVar(envPath, 'FOO'), true);
    assert.equal(await fs.readFile(envPath, 'utf8'), 'B=2\n');
  });

  test('a .env that is a SYMBOLIC LINK is refused, and its target untouched', async (t) => {
    // A clone chose where the link points; writing through it edits a file
    // outside the workspace. (Codex, round on b59eb00.)
    const target = path.join(tmpDir, 'elsewhere.env');
    await fs.writeFile(target, 'FOO=target\n', 'utf8');
    try {
      await fs.symlink(target, envPath, 'file');
    } catch (err) {
      // Windows without Developer Mode or the symlink privilege: the guard
      // cannot be exercised here, and a skip says so rather than a green.
      t.skip(`cannot create a symlink on this machine (${err.code})`);
      return;
    }
    await assert.rejects(() => upsertDotenvVar(envPath, 'FOO', 'x'), /symbolic link/);
    await assert.rejects(() => removeDotenvVar(envPath, 'FOO'), /symbolic link/);
    assert.equal(await fs.readFile(target, 'utf8'), 'FOO=target\n', 'the target is exactly as it was');
  });

  test('one writer at a time: a held dotenv lock makes the write refuse, and nothing is changed', async () => {
    // Two tools persisting into one file read-modify-wrote it with nothing
    // between them, and the last one erased the other's line while both
    // reported success. Held at the DEFAULT lock path, with the writer's own
    // wait shortened, so the test proves the path the production call takes.
    await fs.writeFile(envPath, 'A=1\n', 'utf8');
    const release = acquireLock(dotenvLockPath(envPath));
    assert.ok(release, 'the test holds the lock');
    try {
      await assert.rejects(() => upsertDotenvVar(envPath, 'FOO', 'bar', { waitMs: 0 }), /another process is writing/);
      await assert.rejects(() => removeDotenvVar(envPath, 'A', { waitMs: 0 }), /another process is writing/);
      assert.equal(await fs.readFile(envPath, 'utf8'), 'A=1\n');
    } finally {
      release();
    }
    // Released, the same call goes through — and leaves no lock behind.
    await upsertDotenvVar(envPath, 'FOO', 'bar');
    assert.match(await fs.readFile(envPath, 'utf8'), /^FOO=bar$/m);
    assert.equal(fsSync.existsSync(dotenvLockPath(envPath)), false, 'the lock is released after the write');
  });

  test('the contention message says what did NOT happen, and does not claim nothing was changed', async () => {
    // lock_vault writes its binding before the hint: "nothing was changed"
    // was false for it. (Fable round on 7efbad1.)
    await fs.writeFile(envPath, 'A=1\n', 'utf8');
    const release = acquireLock(dotenvLockPath(envPath));
    try {
      await assert.rejects(() => upsertDotenvVar(envPath, 'FOO', 'bar', { waitMs: 0 }), (err) => {
        assert.match(err.message, /the \.env line was NOT written/);
        assert.doesNotMatch(err.message, /Nothing was changed/);
        return true;
      });
    } finally {
      release();
    }
  });

  test('TWO WRITERS IN ONE PROCESS neither freeze the loop nor lose a line — the critical section has no await inside', async () => {
    // Fable round on 7efbad1: the first shared writer took the mkdir lock and
    // then awaited the read; a second same-process writer spun in the lock's
    // synchronous wait for the full 10 s budget, the event loop frozen, and
    // then failed with "another process is writing" — the only writer being
    // this process. Two pipelined tool calls (lock_vault --persist beside
    // set_auto_enrich_mode --persist) reproduced it on the real server.
    await fs.writeFile(envPath, 'A=1\n', 'utf8');
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    const started = Date.now();
    try {
      await Promise.all([
        upsertDotenvVar(envPath, 'ONE', '1'),
        upsertDotenvVar(envPath, 'TWO', '2'),
        removeDotenvVar(envPath, 'A'),
      ]);
    } finally {
      clearInterval(timer);
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `three concurrent writers took ${elapsed} ms — a synchronous wait is spinning`);
    const content = await fs.readFile(envPath, 'utf8');
    assert.match(content, /^ONE=1$/m);
    assert.match(content, /^TWO=2$/m, 'no lost update');
    assert.doesNotMatch(content, /^A=/m);
  });

  test('the writer\'s line regex and the loader\'s parser agree on EVERY line shape — one reader, one writer', () => {
    // Fable round on 7efbad1: the writer matched `export\s+`, the loader
    // `startsWith('export ')` — so `export<TAB>FOO=old` was rewritten in place
    // while the loader read that line as a key named `export\tFOO`: a
    // persisted setting that never took effect. The loader is the reference.
    const TAB = String.fromCharCode(9);
    const NBSP = String.fromCharCode(0xa0);
    const BOM = String.fromCharCode(0xfeff);
    const lines = [
      'FOO=1', '  FOO=1', 'FOO =1', 'export FOO=1', 'export  FOO=1', `export ${TAB}FOO=1`, '  export FOO=1',
      `${BOM}FOO=1`, `${BOM}export FOO=1`, 'FOO==1', 'FOO="a b"',
      `export${TAB}FOO=1`, `export${NBSP}FOO=1`, 'exportFOO=1', 'EXPORT FOO=1', '# FOO=1', 'FOOD=1', 'XFOO=1', 'FOO', '=1', '',
    ];
    const re = dotenvKeyLineRegex('FOO');
    for (const line of lines) {
      const loaderSees = parseDotenv(line).some((e) => e.key === 'FOO');
      assert.equal(re.test(line), loaderSees, `writer and loader disagree on ${JSON.stringify(line)}`);
    }
  });

  test('readDotenvVarSync answers with the loader\'s eyes: export prefix, quotes, first occurrence', async () => {
    await fs.writeFile(envPath, '# c\nexport FOO="a b"\nFOO=second\n', 'utf8');
    assert.equal(readDotenvVarSync(envPath, 'FOO'), 'a b');
    assert.equal(readDotenvVarSync(envPath, 'BAR'), null);
    assert.equal(readDotenvVarSync(path.join(tmpDir, 'absent.env'), 'FOO'), null);
  });

  test('the lock is keyed on the PHYSICAL file: a junctioned parent and the real directory share one lock', (t) => {
    // Fable round on 7efbad1: two spellings of one file — through a junction,
    // an 8.3 name or a `\\?\` prefix — took two locks, and two writers met
    // nothing. Windows junctions need no privilege, so this runs everywhere.
    const real = fsSync.mkdtempSync(path.join(tmpDir, 'real-'));
    const link = path.join(tmpDir, `link-${Date.now()}`);
    try {
      fsSync.symlinkSync(real, link, 'junction');
    } catch (err) {
      t.skip(`cannot create a junction/symlink here (${err.code})`);
      return;
    }
    try {
      assert.equal(dotenvLockPath(path.join(link, '.env')), dotenvLockPath(path.join(real, '.env')),
        'the file does not exist yet: the parent is resolved');
      fsSync.writeFileSync(path.join(real, '.env'), 'A=1\n');
      assert.equal(dotenvLockPath(path.join(link, '.env')), dotenvLockPath(path.join(real, '.env')),
        'and once it exists, the file itself is resolved');
    } finally {
      fsSync.rmSync(link, { recursive: true, force: true });
    }
  });

  test('the extended UNC spelling and the plain UNC spelling share one lock — the prefix is FOLDED, not stripped', () => {
    // Codex, both engines, round on 1fad78c: a blind strip of the four
    // characters turned `\\?\UNC\server\share\x` into the RELATIVE path
    // `UNC\server\share\x`, anchored in the current directory — two processes
    // writing one network-share file took two locks.
    const plain = '\\\\server\\share\\project\\.env';
    const extended = '\\\\?\\UNC\\server\\share\\project\\.env';
    assert.equal(stripExtendedPathPrefix(extended), plain);
    assert.equal(stripExtendedPathPrefix('\\\\?\\C:\\p\\.env'), 'C:\\p\\.env');
    assert.equal(stripExtendedPathPrefix('C:\\p\\.env'), 'C:\\p\\.env', 'an ordinary path is untouched');
    assert.equal(stripExtendedPathPrefix('/posix/.env'), '/posix/.env');
    assert.equal(dotenvLockPath(extended), dotenvLockPath(plain));
  });

  test('the ASYNC face waits for another process\'s lock WITHOUT blocking the loop, then reports contention', async () => {
    // Round on 1fad78c: the synchronous wait still froze the server for the
    // bounded 2 s under cross-process contention. The tools' face polls with a
    // timer now — a 20 ms timer keeps firing while the writer waits.
    await fs.writeFile(envPath, 'A=1\n', 'utf8');
    const release = acquireLock(dotenvLockPath(envPath));
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
      await assert.rejects(() => upsertDotenvVar(envPath, 'FOO', 'bar', { waitMs: 300 }), /another process is writing/);
    } finally {
      clearInterval(timer);
      release();
    }
    assert.ok(ticks >= 5, `the loop kept turning while the writer waited (${ticks} ticks in 300 ms)`);
    assert.equal(await fs.readFile(envPath, 'utf8'), 'A=1\n', 'and nothing was written');
  });

  test('two async writes of one file apply in CALL order — the last caller wins on disk, as it does in the session', async () => {
    // Codex (gpt-6-astra) on faf5b4b: making the wait asynchronous bought the
    // event loop back and cost the ordering the synchronous version had for
    // free. A writer already waiting on the timer was overtaken by one that
    // arrived later and found the lock free, so `set_auto_enrich_mode`
    // persisting Hybrid and then off left the session on `off` and the FILE on
    // `Hybrid` — both calls reporting success — and the next start-up
    // re-enabled the enrichment the user had just switched off.
    const KEY = 'OBSIDIAN_ROUTER_AUTO_ENRICH';
    await fs.writeFile(envPath, '', 'utf8');
    const first = upsertDotenvVar(envPath, KEY, 'ClaudeAsk');
    const second = upsertDotenvVar(envPath, KEY, 'Hybrid');
    await first;
    const third = upsertDotenvVar(envPath, KEY, 'off');
    await Promise.all([second, third]);
    assert.equal((await fs.readFile(envPath, 'utf8')).trim(), `${KEY}=off`,
      'the last call started is the last line written');

    // The same property with no await at all between the calls, and with a
    // removal in the middle: a queue that only happened to work because each
    // task took the lock on its first try would pass the case above.
    const started = [];
    for (let i = 0; i < 6; i += 1) started.push(upsertDotenvVar(envPath, KEY, `v${i}`));
    started.push(removeDotenvVar(envPath, KEY));
    started.push(upsertDotenvVar(envPath, KEY, 'last'));
    await Promise.all(started);
    assert.equal((await fs.readFile(envPath, 'utf8')).trim(), `${KEY}=last`);

    // A failed write does not cancel the ones queued behind it. The refusal
    // here is the shared validator's, raised before the call is queued at all.
    await fs.writeFile(envPath, '', 'utf8');
    const ok = upsertDotenvVar(envPath, KEY, 'Hybrid');
    await assert.rejects(() => upsertDotenvVar(envPath, KEY, 'a\nB=evil'), /newline|DotenvValueError|refus/i);
    const after = upsertDotenvVar(envPath, KEY, 'off');
    await Promise.all([ok, after]);
    assert.equal((await fs.readFile(envPath, 'utf8')).trim(), `${KEY}=off`);

    // And two DIFFERENT files do not serialise against each other: the queue
    // is per physical path, so a slow writer on one .env cannot delay another.
    const otherDir = fsSync.mkdtempSync(path.join(tmpDir, 'other-'));
    const otherEnv = path.join(otherDir, '.env');
    const held = acquireLock(dotenvLockPath(envPath));
    try {
      const blocked = upsertDotenvVar(envPath, KEY, 'blocked', { waitMs: 400 });
      await upsertDotenvVar(otherEnv, KEY, 'free');
      assert.equal((await fs.readFile(otherEnv, 'utf8')).trim(), `${KEY}=free`,
        'the other file was written while the first was still waiting');
      await assert.rejects(() => blocked, /another process is writing/);
    } finally {
      held();
    }
  });

  test('the wait NEVER runs past the budget the caller asked for — the poll interval is clamped to what is left', async () => {
    // Codex (gpt-6-astra), round on faf5b4b: the sleep was a flat `pollMs`
    // whatever the remaining budget, so `{ waitMs: 10, pollMs: 150 }` against a
    // holder that let go at 30 ms acquired the lock at 160 ms — sixteen times
    // the bound, and for the server's face a request held that much longer
    // than its own caller allowed.
    const dir = fsSync.mkdtempSync(path.join(tmpDir, 'budget-'));
    const lockPath = path.join(dir, 'the.lock');
    const held = acquireLock(lockPath);
    try {
      const startedAt = Date.now();
      const got = await acquireLockAsync(lockPath, { waitMs: 10, pollMs: 150 });
      const waited = Date.now() - startedAt;
      assert.equal(got, null, 'the lock was held for the whole budget: contention, not acquisition');
      assert.ok(waited < 120, `waited ${waited} ms for a 10 ms budget`);
    } finally {
      held();
    }
    // The synchronous acquirer shares the same rule through `afterAttempt`.
    const held2 = acquireLock(lockPath);
    try {
      const startedAt = Date.now();
      assert.equal(acquireLock(lockPath, { waitMs: 10, pollMs: 150 }), null);
      assert.ok(Date.now() - startedAt < 120, 'the synchronous wait is clamped too');
    } finally {
      held2();
    }
    // And `waitMs: 0` still means ONE attempt, not none: a free lock is taken.
    const free = await acquireLockAsync(lockPath, { waitMs: 0 });
    assert.ok(free, 'a free lock is acquired even with no budget to wait');
    free();
  });

  test('a transient EPERM/ENOTEMPTY from mkdir — a racing removal on Windows — is retried; past the deadline the ORIGINAL error surfaces, never "contention"', async () => {
    const dir = fsSync.mkdtempSync(path.join(tmpDir, 'transient-'));
    const lockPath = path.join(dir, 'the.lock');
    const eperm = () => Object.assign(new Error('EPERM: operation not permitted, mkdir'), { code: 'EPERM' });
    let calls = 0;
    const flaky = (p) => { calls += 1; if (calls <= 2) throw eperm(); fsSync.mkdirSync(p); };
    const release = acquireLock(lockPath, { waitMs: 1000, pollMs: 1, mkdir: flaky });
    assert.ok(release, 'acquired after two transient failures');
    assert.equal(calls, 3);
    release();
    calls = 0;
    const releaseAsync = await acquireLockAsync(lockPath, { waitMs: 1000, pollMs: 1, mkdir: flaky });
    assert.ok(releaseAsync, 'the async twin retries the same way');
    releaseAsync();
    const always = () => { throw eperm(); };
    assert.throws(() => acquireLock(lockPath, { waitMs: 0, mkdir: always }), /EPERM/);
    await assert.rejects(() => acquireLockAsync(lockPath, { waitMs: 0, mkdir: always }), /EPERM/);
    assert.equal(fsSync.existsSync(lockPath), false, 'no lock left behind');
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
// validateLock — reachability (Phase 2/3 fix, portee-ergonomie-refus-
// roadmap). Codex review: OBSIDIAN_ROUTER_LOCKED naming a real but
// UNREACHABLE vault passed this validator, then bricked every subsequent
// call once applyLockGuard forced every resolveVault() through it. The
// reachability param is OPTIONAL and additive — every test above passes
// none and must keep behaving exactly as before.
// ---------------------------------------------------------------------------

describe('validateLock — reachability, when a `reachability` context is supplied', () => {
  const vaults = [
    { name: 'work', type: 'remote' },
    { name: 'reference', type: 'remote' },
  ];

  test('no reachability param (undefined) — unchanged: a real vault always locks, reachability never consulted', () => {
    // Old 3-arg call site, exactly as every existing caller/test uses it.
    const result = validateLock('reference', vaults, 'env');
    assert.equal(result.lock, 'reference', 'omitting the 4th param must not start enforcing reachability');
    assert.equal(result.warning, null);
  });

  test('env context: a real but unreachable vault falls through with a reachability warning, not a brick', () => {
    const reg = { vaultReach: 'declared', openVaults: [], workspaceBinding: { vault: 'work', also: [] } };
    const result = validateLock('reference', vaults, 'env', reg);
    assert.equal(result.lock, null);
    assert.match(result.warning, /OBSIDIAN_ROUTER_LOCKED="reference"/);
    assert.match(result.warning, /this workspace cannot reach/);
    assert.match(result.warning, /falling back to normal multi-vault mode/);
  });

  test('preserved context: a vault that BECAME unreachable across a hot-reload falls through, named as such', () => {
    const reg = { vaultReach: 'declared', openVaults: [], workspaceBinding: { vault: 'work', also: [] } };
    const result = validateLock('reference', vaults, 'preserved', reg);
    assert.equal(result.lock, null);
    assert.match(result.warning, /Locked vault "reference" is no longer reachable from this workspace after config reload/);
  });

  test('a vault that IS reachable (primary, also, or openVaults) still locks normally', () => {
    assert.equal(
      validateLock('work', vaults, 'env', { vaultReach: 'declared', openVaults: [], workspaceBinding: { vault: 'work', also: [] } }).lock,
      'work',
    );
    assert.equal(
      validateLock('reference', vaults, 'env', { vaultReach: 'declared', openVaults: [], workspaceBinding: { vault: 'work', also: ['reference'] } }).lock,
      'reference',
    );
    assert.equal(
      validateLock('reference', vaults, 'env', { vaultReach: 'declared', openVaults: ['reference'], workspaceBinding: null }).lock,
      'reference',
    );
  });

  test('vaultReach inactive (the default) — reachability param present but harmless', () => {
    const result = validateLock('reference', vaults, 'env', { vaultReach: null, openVaults: [], workspaceBinding: { vault: 'work', also: [] } });
    assert.equal(result.lock, 'reference', 'vaultReach must be exactly "declared" to restrict anything');
  });

  test('a candidate not even in the active set is still reported as such, never misdiagnosed as unreachable', () => {
    // Reachability is checked ONLY after confirming the vault is in the
    // active set at all — a typo must keep getting the ORIGINAL "does not
    // match any active vault" message, not a confusing reachability one.
    const result = validateLock('typo-vault', vaults, 'env', { vaultReach: 'declared', openVaults: [], workspaceBinding: null });
    assert.match(result.warning, /does not match any active vault/);
    assert.doesNotMatch(result.warning, /cannot reach/);
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
// resolveVault() — reachability (decision portee-et-mode-ecriture-des-vaults
// §1, Phase 2 of portee-ergonomie-refus-roadmap). Trap 1 of the decision:
// this is THE single point of passage the guard must live at — tested here
// directly against the production loadRegistry()/resolveVault(), not a
// reimplementation, so a regression in the real wiring shows up here.
// ---------------------------------------------------------------------------

describe('resolveVault() — reachability', () => {
  let tmpDir, cfgPath;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-reach-test-'));
    cfgPath = path.join(tmpDir, 'config.json');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function makeRegistry(extraConfig = {}) {
    const config = {
      portRegistry: {},
      remoteVaults: [
        { name: 'work', baseUrl: 'https://w/', apiKey: 'k' },
        { name: 'reference', baseUrl: 'https://r/', apiKey: 'k' },
        { name: 'roland', baseUrl: 'https://p/', apiKey: 'k' },
      ],
      ...extraConfig,
    };
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    return loadRegistry({ configPath: cfgPath });
  }

  test('vaultReach absent (default) — every registered vault resolves, unchanged behaviour', async () => {
    const reg = await makeRegistry();
    assert.equal(reg.vaultReach, null);
    assert.equal(reg.resolveVault('work').name, 'work');
    assert.equal(reg.resolveVault('reference').name, 'reference');
  });

  test('vaultReach: "declared", no binding, no openVaults — every named vault refuses', async () => {
    const reg = await makeRegistry({ vaultReach: 'declared' });
    assert.equal(reg.vaultReach, 'declared');
    assert.throws(() => reg.resolveVault('work'), /not reachable from this workspace/);
    assert.throws(() => reg.resolveVault('reference'), /not reachable from this workspace/);
  });

  test('vaultReach: "declared" + openVaults — that vault resolves from anywhere, others still refuse', async () => {
    const reg = await makeRegistry({ vaultReach: 'declared', openVaults: ['roland'] });
    assert.equal(reg.resolveVault('roland').name, 'roland');
    assert.throws(() => reg.resolveVault('work'), /not reachable from this workspace/);
  });

  test('vaultReach: "declared" + a live workspaceBinding — the primary and every `also` resolve', async () => {
    const reg = await makeRegistry({ vaultReach: 'declared' });
    // Set LIVE, the same way confirm_workspace_binding does on the real
    // registry object mid-session — no need to fabricate a dotenv-import
    // fixture keyed by this test process's own cwd.
    reg.workspaceBinding = { vault: 'work', also: ['reference'] };
    assert.equal(reg.resolveVault('work').name, 'work');
    assert.equal(reg.resolveVault('reference').name, 'reference');
    assert.throws(() => reg.resolveVault('roland'), /not reachable from this workspace/);
  });

  test('an omitted name still resolves to the default vault when reachable, and still refuses when not', async () => {
    const reg = await makeRegistry({ vaultReach: 'declared' });
    reg.workspaceBinding = { vault: 'work', also: [] };
    reg.defaultVault = 'work';
    assert.equal(reg.resolveVault().name, 'work');
    reg.defaultVault = 'roland'; // not declared, not in openVaults
    assert.throws(() => reg.resolveVault(), /not reachable from this workspace/);
  });

  test('lock + reachability compose: locking to an unreachable vault still refuses it', async () => {
    const reg = await makeRegistry({ vaultReach: 'declared' });
    applyLockGuard(reg);
    reg.lockedVault = 'roland'; // never declared, not in openVaults
    assert.throws(() => reg.resolveVault(), /not reachable from this workspace/);
    assert.throws(() => reg.resolveVault('roland'), /not reachable from this workspace/);
  });

  // -------------------------------------------------------------------------
  // THE ORDER OF THE TWO GUARDS (decision proposition-de-liaison-a-l-acces §1,
  // its trap 1 — Phase 1 of proposition-de-liaison-roadmap).
  //
  // Consent precedes availability: "this workspace does not declare this
  // vault" must be answered BEFORE "this vault has no key on disk". With the
  // old order, a vault that was both undeclared and keyless answered with the
  // key message — sending the user to re-run setup-vault.mjs for a vault they
  // had simply never bound, and suppressing the binding proposal the refusal
  // is meant to carry.
  //
  // ► MUTATION EXPECTATIONS, declared per witness (one rule, one mutation):
  //   Swap the two guards back to their old order and ONLY the first test
  //   below goes red. The second and third MUST stay green — they are what
  //   stops the "fix" from degenerating into "reachability always wins" or
  //   into dropping the key guard altogether.
  // -------------------------------------------------------------------------

  test('undeclared AND keyless → the REACHABILITY refusal, never the key one', async () => {
    const reg = await makeRegistry({ vaultReach: 'declared' });
    reg.vaults.find((v) => v.name === 'work').missingApiKey = true;
    // Declared by nobody, and no key either: consent is the question to answer.
    assert.throws(() => reg.resolveVault('work'), /not reachable from this workspace/);
    assert.throws(() => reg.resolveVault('work'), (err) => {
      assert.doesNotMatch(err.message, /has no API key on disk/,
        'the key message shadowed the reachability one — the two guards are in the wrong order');
      return true;
    });
  });

  test('DECLARED and keyless → the key refusal still fires (the key guard is not bypassed)', async () => {
    const reg = await makeRegistry({ vaultReach: 'declared' });
    reg.workspaceBinding = { vault: 'work', also: [] };
    reg.vaults.find((v) => v.name === 'work').missingApiKey = true;
    // Consent is settled, so availability becomes the right thing to say.
    assert.throws(() => reg.resolveVault('work'), /has no API key on disk/);
  });

  test('vaultReach absent + keyless → the key refusal, unchanged for a default install', async () => {
    const reg = await makeRegistry();
    reg.vaults.find((v) => v.name === 'work').missingApiKey = true;
    // No reachability guard is active here, so the reorder must be invisible.
    assert.throws(() => reg.resolveVault('work'), /has no API key on disk/);
  });
});

// ---------------------------------------------------------------------------
// lockVault E.2 regression: refuse persist when cwd === homedir
// ---------------------------------------------------------------------------

describe('lockVault — homedir refusal (E.2)', () => {
  isolatedHomeSuite();

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

  test('persist:true REPORTS a .env that cannot be written — the mode stays in force, the call does not fail', async () => {
    // Round on 1fad78c: the dotenv write threw raw after the mode had been
    // applied, so the caller saw a failed call for a mode that was in force.
    const envPath = path.join(tmpDir, '.env');
    await fs.writeFile(envPath, 'KEEP=1\n', 'utf8');
    await fs.chmod(envPath, 0o444);
    try {
      const reg = { autoEnrichMode: 'ClaudeAsk' };
      const result = await setAutoEnrichMode(reg, { mode: 'Hybrid', persist: true });
      assert.equal(reg.autoEnrichMode, 'Hybrid', 'in force');
      assert.equal(result.persisted, false);
      assert.match(result.persistError, /EPERM|EACCES/);
      assert.equal(result.persistRefused, null, 'not a refusal — an unwritable file');
      assert.match(result.message, /could NOT be written/);
      assert.equal(await fs.readFile(envPath, 'utf8'), 'KEEP=1\n', 'untouched');
    } finally {
      await fs.chmod(envPath, 0o644);
      await fs.rm(envPath, { force: true });
    }
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

    // First set a non-default mode persisted. Hybrid, not FullAuto: since
    // v0.89.0 FullAuto is the one mode `persist` refuses to write, so using it
    // here would test the refusal instead of the literal-"off" regression this
    // test exists for. The refusal has its own tests, below.
    await setAutoEnrichMode(reg, { mode: 'Hybrid', persist: true });
    let envContent = await fs.readFile(path.join(tmpDir, '.env'), 'utf8');
    assert.match(envContent, /OBSIDIAN_ROUTER_AUTO_ENRICH=Hybrid/);

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

  /**
   * v0.89.0 — persistence is symmetrical with reading.
   *
   * The router no longer READS FullAuto back from a workspace file (accepted
   * option 4 of the decision `liaison-workspace-vault-hors-depot`), so writing
   * it there would leave a line the next start-up refuses: persistence that
   * does not persist. The refusal is a RESULT, not an exception, because the
   * mode really is active — an exception reads as "the call failed" and invites
   * a retry that would change nothing.
   */
  test('persist:true + FullAuto: the mode applies, the file is NOT written, and the refusal names both legitimate homes', async () => {
    for (const written of ['FullAuto', 'fullauto', 'FULLAUTO', 'auto', 'full', 'full-auto']) {
      const envPath = path.join(tmpDir, '.env');
      await fs.rm(envPath, { force: true });
      const reg = { autoEnrichMode: 'ClaudeAsk' };
      const result = await setAutoEnrichMode(reg, { mode: written, persist: true });

      // The mode IS active for the session — that is the whole point of not
      // throwing, and the message has to say so or Claude will retry.
      assert.equal(reg.autoEnrichMode, 'FullAuto', written);
      assert.equal(result.mode, 'FullAuto', written);
      assert.deepEqual(reg.autoEnrichModeSource, { origin: 'runtime', variable: null }, written);
      assert.equal(result.persisted, false, written);
      assert.equal(result.envPath, undefined, written);

      // The refusal, in full.
      assert.ok(result.persistRefused, `${written}: a refusal must be reported, not silence`);
      assert.equal(result.persistRefused.mode, 'FullAuto', written);
      assert.equal(result.persistRefused.variable, 'OBSIDIAN_ROUTER_AUTO_ENRICH', written);
      assert.match(result.persistRefused.reason, /mode IS active for this session/, written);
      assert.match(result.persistRefused.reason, /MCP host's server declaration/, written);
      assert.match(result.persistRefused.reason, /shell or profile/, written);
      assert.match(result.message, /Not persisted:/, written);
      // The success message's own claim, which must not appear here. (Not a
      // bare "written to": the refusal legitimately contains the words "never
      // written to one either", and a test that forbade them would be
      // forbidding the explanation rather than the false claim.)
      assert.doesNotMatch(result.message, /survives restart/, `${written}: the message must not promise persistence`);

      // And nothing was written. The artifact assertion, not the return value:
      // the same shape as the homedir refusal test below.
      await assert.rejects(() => fs.access(envPath), `${written}: no file may be created`);
    }
  });

  test('persist:true + FullAuto leaves an EXISTING file byte-for-byte alone', async () => {
    const envPath = path.join(tmpDir, '.env');
    const before = 'VAULT_PATH=/vaults/x\nOBSIDIAN_ROUTER_AUTO_ENRICH=Hybrid\n';
    await fs.writeFile(envPath, before, 'utf8');
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    const result = await setAutoEnrichMode(reg, { mode: 'FullAuto', persist: true });
    assert.equal(result.persisted, false);
    assert.equal(await fs.readFile(envPath, 'utf8'), before,
      'the refusal must not rewrite, reorder or re-terminate the file');
    await fs.rm(envPath, { force: true });
  });

  test('the three other modes persist exactly as before — the rule is about ONE value, not about persistence', async () => {
    for (const mode of ['ClaudeAsk', 'Hybrid', 'off']) {
      await fs.rm(path.join(tmpDir, '.env'), { force: true });
      const reg = { autoEnrichMode: 'FullAuto' };
      const result = await setAutoEnrichMode(reg, { mode, persist: true });
      assert.equal(result.persisted, true, mode);
      assert.equal(result.persistRefused, null, mode);
      assert.match(await fs.readFile(path.join(tmpDir, '.env'), 'utf8'), new RegExp(`^OBSIDIAN_ROUTER_AUTO_ENRICH=${mode}$`, 'm'), mode);
    }
    await fs.rm(path.join(tmpDir, '.env'), { force: true });
  });

  test('persist:false + FullAuto is not a refusal — nobody asked for a write', async () => {
    const reg = { autoEnrichMode: 'ClaudeAsk' };
    const result = await setAutoEnrichMode(reg, { mode: 'FullAuto' });
    assert.equal(reg.autoEnrichMode, 'FullAuto');
    assert.equal(result.persisted, false);
    assert.equal(result.persistRefused, null, 'null means "not refused", including "never requested"');
    assert.match(result.message, /volatile/);
    // Found by review: the volatile message used to end with "Use persist:true
    // to make it survive restarts" for EVERY mode — advice that, for this one,
    // now leads straight to a refusal. Advice guaranteed to fail is worse than
    // no advice, so this mode gets the answer that actually works.
    assert.doesNotMatch(result.message, /Use persist:true/,
      'must not send a FullAuto caller down the one path that refuses');
    assert.match(result.message, /MCP host's server declaration/);
    assert.match(result.message, /shell or profile/);
  });

  test('the OTHER three modes keep the ordinary volatile advice — the rule is about one value', async () => {
    for (const mode of ['ClaudeAsk', 'Hybrid', 'off']) {
      const result = await setAutoEnrichMode({ autoEnrichMode: 'FullAuto' }, { mode });
      assert.match(result.message, /Use persist:true to make it survive restarts/, mode);
    }
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
  isolatedHomeSuite();

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

// ---------------------------------------------------------------------------
// "the loader skipped it as disabled" — ONE question, three doors (round 17)
// ---------------------------------------------------------------------------

describe('disabledSinceStart — one verdict for every door that asks it', () => {
  let tmpDir;

  before(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-disabled-verdict-')); });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  test('the three verdicts, and null for a vault the loader skipped for another reason', async () => {
    const cfgPath = path.join(tmpDir, 'verdict.json');
    await fs.writeFile(cfgPath, JSON.stringify({ portRegistry: {}, disabledVaults: ['off'] }), 'utf8');
    const reg = {
      configPath: cfgPath,
      skipped: [
        { name: 'off', type: 'local', reason: 'disabled' },
        { name: 'clash', type: 'local', reason: 'name-collision' },
      ],
    };
    assert.equal(disabledSinceStart(reg, 'off', fsSync.readFileSync), DISABLED_SINCE_START.STILL);
    // The file no longer names it: re-enabled since start-up (`--no-watch`).
    await fs.writeFile(cfgPath, JSON.stringify({ portRegistry: {}, disabledVaults: [] }), 'utf8');
    assert.equal(disabledSinceStart(reg, 'off', fsSync.readFileSync), DISABLED_SINCE_START.REENABLED);
    // Nothing can answer: not a verdict about the file, and said as such.
    const blind = { configPath: path.join(tmpDir, 'no-such-file.json'), skipped: reg.skipped };
    assert.equal(disabledSinceStart(blind, 'off', fsSync.readFileSync), DISABLED_SINCE_START.UNVERIFIED);
    // The session's own parsed copy is a reading of the file, so it answers.
    const copy = { configPath: path.join(tmpDir, 'no-such-file.json'), config: { disabledVaults: ['off'] }, skipped: reg.skipped };
    assert.equal(disabledSinceStart(copy, 'off', fsSync.readFileSync), DISABLED_SINCE_START.STILL);
    // A vault skipped for a DIFFERENT reason is not this question's business.
    assert.equal(disabledSinceStart(reg, 'clash', fsSync.readFileSync), null);
    assert.equal(disabledSinceStart(reg, 'never-seen', fsSync.readFileSync), null);
  });

  test('lock_vault answers with the FILE, like resolveVault and list_vaults — the reader round 16 left behind', async () => {
    // Round 16 taught `resolveVault` and `list_vaults` to re-read the file so
    // a vault re-enabled under `--no-watch` is not "is DISABLED"; the
    // `lock_vault` sentence that same round ADDED kept the start-up verdict,
    // so two doors said the list no longer names it while the third demanded
    // it be removed from that list. (Codex, round 17.)
    const cfgPath = path.join(tmpDir, 'lock-reenabled.json');
    await fs.writeFile(cfgPath, JSON.stringify({ portRegistry: {}, disabledVaults: [] }), 'utf8');
    const reg = {
      configPath: cfgPath,
      vaults: [{ name: 'other' }],
      skipped: [{ name: 'off', type: 'local', reason: 'disabled' }],
      vaultReach: 'all',
      openVaults: [],
      workspaceBinding: null,
    };
    await assert.rejects(
      () => lockVault(reg, { vault: 'off' }),
      (e) => {
        assert.match(e.message, /was DISABLED by `disabledVaults` when this session started/);
        assert.match(e.message, /the config file no longer disables it/);
        assert.doesNotMatch(e.message, /Remove it from `disabledVaults` first/);
        return true;
      },
    );

    // Still listed: the original sentence, unchanged.
    await fs.writeFile(cfgPath, JSON.stringify({ portRegistry: {}, disabledVaults: ['off'] }), 'utf8');
    await assert.rejects(
      () => lockVault(reg, { vault: 'off' }),
      (e) => {
        assert.match(e.message, /it is DISABLED by `disabledVaults` in the config file/);
        assert.match(e.message, /Remove it from `disabledVaults` first, then restart, then lock/);
        return true;
      },
    );

    // Unreadable: neither of the two, and the reader is told so.
    const blind = { ...reg, configPath: path.join(tmpDir, 'gone.json'), config: undefined };
    await assert.rejects(
      () => lockVault(blind, { vault: 'off' }),
      (e) => {
        assert.match(e.message, /could not be read just now/);
        assert.match(e.message, /unverified/);
        return true;
      },
    );

    // And a vault that was never skipped still gets the plain refusal.
    await assert.rejects(
      () => lockVault(reg, { vault: 'nowhere' }),
      (e) => {
        assert.match(e.message, /not in the active vault set/);
        return true;
      },
    );
  });

  test('resolveVault says UNVERIFIED rather than keeping the start-up verdict in the present tense', async () => {
    const reg = {
      vaults: [{ name: 'other' }],
      skipped: [{ name: 'off', type: 'local', reason: 'disabled' }],
      configPath: path.join(tmpDir, 'absent-for-resolve.json'),
      vaultReach: 'all',
      openVaults: [],
      workspaceBinding: null,
      resolveVault: _internals.resolveVaultFor,
    };
    // Through a real registry, so the branch under test is the shipped one.
    const cfgPath = path.join(tmpDir, 'resolve-reenabled.json');
    await fs.writeFile(cfgPath, JSON.stringify({ portRegistry: {}, disabledVaults: ['off'] }), 'utf8');
    const registry = await loadRegistry({ configPath: cfgPath });
    // The loader skipped nothing (no vault is registered), so fake the skip
    // the way the loader records it and ask the shipped method.
    registry.skipped = [{ name: 'off', type: 'local', reason: 'disabled' }];
    assert.throws(() => registry.resolveVault('off'), /is DISABLED by `disabledVaults`/);
    await fs.writeFile(cfgPath, JSON.stringify({ portRegistry: {}, disabledVaults: [] }), 'utf8');
    assert.throws(() => registry.resolveVault('off'), /was DISABLED by `disabledVaults` when this session started/);
    registry.configPath = path.join(tmpDir, 'vanished.json');
    registry.config = undefined;
    assert.throws(() => registry.resolveVault('off'), /unverified/);
    void reg;
  });

  test('every reader of registry.skipped goes through the one verdict — a fourth cannot arrive unnoticed', () => {
    // The behavioural witnesses above cover the three doors that exist. This
    // is the half that notices a NEW one. Round 16 repaired two of the three
    // readers of this exact fact and shipped; a repair that reaches its first
    // call sites and not the last reads as closed, which is the defect class
    // this repository has now paid for five times.
    const OWNER = path.join('src', 'helpers', 'vault-slug.mjs');
    const roots = ['src', 'scripts', 'hooks', 'bin'];
    const files = [];
    const walk = (dir) => {
      let entries;
      try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/[.](mjs|cjs|js)$/.test(e.name)) files.push(p);
      }
    };
    for (const r of roots) walk(r);
    assert.ok(files.length > 50, 'the scan found suspiciously few files to read');

    // Files allowed to read the loader's `skipped` list without asking the
    // verdict, because they REPORT it rather than act on it: the start-up
    // note names what the loader skipped, at the moment it skipped it, which
    // is the one instant at which the start-up verdict IS the file.
    const REPORTERS = new Set([path.join('src', 'index.mjs')]);
    const offenders = [];
    const readers = [];
    const judges = [];
    for (const f of files) {
      const raw = fsSync.readFileSync(f, 'utf8');
      const code = blankStringsAndComments(raw);
      // THE VERDICT ITSELF, hand-rolled. Read from the RAW source: blanking
      // erases the string's content, so the literal has to be looked for
      // before it is blanked (the lesson of the OBSIDIAN_ROUTER_LOCKED scan,
      // whose bracket branch was dead for a whole round).
      if (/reason\s*===\s*(['"])disabled\1/.test(raw)) {
        judges.push(path.normalize(f));
        if (path.normalize(f) !== OWNER) offenders.push(`${f}: decides "skipped as disabled" by hand`);
      }
      // THE LOADER'S OWN LIST, by the names the registry object goes by here.
      if (/\b(registry|reg|this)\.skipped\b/.test(code)) {
        readers.push(path.normalize(f));
        // A CALL, not merely an import: a file that imports the helper and
        // then answers the question itself would otherwise pass this scan on
        // the strength of a line it does not use.
        if (path.normalize(f) !== OWNER
          && !REPORTERS.has(path.normalize(f))
          && !/disabledSinceStart\s*\(/.test(code)
          && !/liveDisabledVaultNames\s*\(/.test(code)) {
          offenders.push(`${f}: reads the loader's \`skipped\` without asking ${OWNER}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `readers of \`skipped\` that answer the disabled question themselves:\n${offenders.join('\n')}`);
    // POSITIVE CONTROL: the scan must actually be finding something, or it
    // passes by finding nothing — the failure mode that let a class defect
    // sit at 211/211 green in an earlier lot.
    assert.deepEqual(judges, [OWNER], 'the verdict is decided somewhere other than its owner, or the scan finds nothing');
    assert.ok(
      readers.includes(path.join('src', 'tools', 'list-vaults.mjs')),
      'the scan no longer sees list_vaults reading the loader\'s skipped list — it is looking for the wrong thing',
    );
    assert.ok(readers.length >= 2, 'the scan found fewer readers than the doors that exist');
  });
});
