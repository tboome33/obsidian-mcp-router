/**
 * Tests for the VAULT_* env-var config source (v0.20.0) — src/registry.mjs.
 *
 * Strategy (mirrors tests/registry.test.mjs):
 * - parseEnvVaults: pure function via _internals. Covers parse OK + defaults,
 *   explicit optionals, invalid JSON (skip + NO secret leak), missing required
 *   field (skip + apiKey redacted), the WireGuard defensive warning, the
 *   VAULT_PATH exclusion, and the retro-compat no-VAULT_* → [] case.
 * - loadRegistry: integration tests with a temp config file proving the merge
 *   (VAULT_* overrides same-name from both prior sources), interaction with the
 *   ALLOWED_VAULTS whitelist + default resolution + disabledVaults, and strict
 *   retro-compat (no VAULT_* → byte-identical to the file-only result).
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { loadRegistry, _internals } from '../src/registry.mjs';

const { parseEnvVaults } = _internals;

// Capture console.error output (parseEnvVaults logs warnings to stderr) so the
// test run stays quiet AND we can assert on what was/wasn't logged.
function captureStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    const result = fn();
    return { result, stderr: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

// ---------------------------------------------------------------------------
// parseEnvVaults — pure unit tests
// ---------------------------------------------------------------------------

describe('parseEnvVaults — parsing + validation', () => {
  test('parses a valid entry, strips trailing slash, applies defaults', () => {
    const env = {
      VAULT_DEDIBOX: JSON.stringify({
        name: 'dedibox',
        baseUrl: 'http://10.8.0.10:27161/',
        apiKey: 'tok',
        wireguard: true,
      }),
    };
    const { result, stderr } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults.length, 1);
    const v = result.envVaults[0];
    assert.equal(v.name, 'dedibox');
    assert.equal(v.type, 'remote');
    assert.equal(v.baseUrl, 'http://10.8.0.10:27161'); // trailing slash stripped
    assert.equal(v.apiKey, 'tok');
    assert.equal(v.wireguard, true);
    assert.equal(v.tlsInsecure, false); // default
    assert.equal(v.timeoutMs, 10000); // default (mirrors remoteVaults)
    // wireguard:true + host in 10.8.0.x → no warning
    assert.equal(result.warnings.length, 0);
    assert.equal(stderr, '');
  });

  test('carries explicit optional fields through', () => {
    const env = {
      VAULT_X: JSON.stringify({
        name: 'x',
        baseUrl: 'https://x.example.com',
        apiKey: 'k',
        description: 'hello',
        tlsInsecure: true,
        timeoutMs: 15000,
      }),
    };
    const { result } = captureStderr(() => parseEnvVaults(env));
    const v = result.envVaults[0];
    assert.equal(v.description, 'hello');
    assert.equal(v.tlsInsecure, true);
    assert.equal(v.timeoutMs, 15000);
    assert.equal(v.wireguard, false); // absent → default false
  });

  test('non-finite timeoutMs falls back to the 10000 default', () => {
    const env = {
      VAULT_X: JSON.stringify({
        name: 'x',
        baseUrl: 'https://x/',
        apiKey: 'k',
        timeoutMs: 'not-a-number',
      }),
    };
    const { result } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults[0].timeoutMs, 10000);
  });

  test('invalid JSON is skipped and the raw value is NEVER logged (security)', () => {
    const SECRET = 'SUPERSECRET_TOKEN_xyz';
    const env = { VAULT_BAD: `{"apiKey":"${SECRET}", oops` };
    const { result, stderr } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /VAULT_BAD/);
    assert.match(result.warnings[0], /not valid JSON/);
    // The whole point: the plaintext token must not reach the logs, even via
    // the parser's error message (V8 echoes a snippet of the input).
    assert.doesNotMatch(stderr, /SUPERSECRET/);
    assert.doesNotMatch(result.warnings.join('\n'), /SUPERSECRET/);
  });

  test('non-object JSON (array/scalar) is skipped', () => {
    const env = {
      VAULT_ARR: JSON.stringify([1, 2, 3]),
      VAULT_NUM: JSON.stringify(42),
    };
    const { result } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults.length, 0);
    assert.equal(result.warnings.length, 2);
  });

  test('missing required field is skipped and the apiKey is redacted in the log', () => {
    const SECRET = 'TOKEN_should_be_redacted';
    const env = {
      // baseUrl missing, apiKey present → must be redacted before logging
      VAULT_Y: JSON.stringify({ name: 'y', apiKey: SECRET }),
    };
    const { result, stderr } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults.length, 0);
    assert.match(result.warnings[0], /VAULT_Y/);
    assert.match(result.warnings[0], /baseUrl/); // names the missing field
    assert.match(result.warnings[0], /apiKey/); // mentions requirement
    assert.match(result.warnings[0], /<redacted>/);
    assert.doesNotMatch(stderr, /TOKEN_should_be_redacted/);
  });

  test('empty-string required fields count as missing', () => {
    const env = {
      VAULT_Z: JSON.stringify({ name: '  ', baseUrl: 'https://z/', apiKey: 'k' }),
    };
    const { result } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults.length, 0);
    assert.match(result.warnings[0], /name/);
  });

  test('wireguard:true with a non-10.8.0.x host warns but still loads', () => {
    const env = {
      VAULT_W: JSON.stringify({
        name: 'w',
        baseUrl: 'http://192.168.0.10:27161',
        apiKey: 'k',
        wireguard: true,
      }),
    };
    const { result } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults.length, 1); // still loaded
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /wireguard/);
    assert.match(result.warnings[0], /192\.168\.0\.10/);
    assert.match(result.warnings[0], /10\.8\.0/);
  });

  test('wireguard:false with any host does not warn', () => {
    const env = {
      VAULT_W: JSON.stringify({
        name: 'w',
        baseUrl: 'http://192.168.0.10:27161',
        apiKey: 'k',
      }),
    };
    const { result } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults.length, 1);
    assert.equal(result.warnings.length, 0);
  });

  test('VAULT_PATH is excluded from the scan (no spurious warning)', () => {
    // VAULT_PATH is the tier-2 default-vault hint (a filesystem path, not JSON)
    // — it matches /^VAULT_.+/ but must NOT be treated as a vault config.
    const env = { VAULT_PATH: 'C:\\VAULTS\\.template' };
    const { result, stderr } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(stderr, '');
  });

  test('no VAULT_* keys → empty result (retro-compat); boundary keys ignored', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      VAULTX: 'nope', // no underscore → not a match
      VAULT_: 'nope', // empty suffix → /^VAULT_.+/ needs ≥1 char
      OBSIDIAN_ROUTER_DEFAULT_VAULT: 'x',
    };
    const { result } = captureStderr(() => parseEnvVaults(env));
    assert.deepEqual(result.envVaults, []);
    assert.deepEqual(result.warnings, []);
  });

  test('defaults env to {} when called with no arg', () => {
    const { result } = captureStderr(() => parseEnvVaults());
    assert.deepEqual(result.envVaults, []);
  });

  test('returns duplicate-name entries as-is (dedup is the caller’s job)', () => {
    const env = {
      VAULT_AAA: JSON.stringify({ name: 'dup', baseUrl: 'http://10.8.0.1:1', apiKey: 'first' }),
      VAULT_ZZZ: JSON.stringify({ name: 'dup', baseUrl: 'http://10.8.0.2:2', apiKey: 'second' }),
    };
    const { result } = captureStderr(() => parseEnvVaults(env));
    assert.equal(result.envVaults.length, 2);
    // Sorted by key → AAA before ZZZ (deterministic for the merge tie-break)
    assert.equal(result.envVaults[0].apiKey, 'first');
    assert.equal(result.envVaults[1].apiKey, 'second');
  });
});

// ---------------------------------------------------------------------------
// loadRegistry — integration: VAULT_* as a 3rd merged source
// ---------------------------------------------------------------------------

describe('loadRegistry — VAULT_* 3rd source merge', () => {
  let tmpDir;
  let cfgPath;

  // Snapshot + wipe every env key we touch so state never leaks across tests
  // or into other describe blocks (the registry reads process.env directly).
  const TOUCHED = [
    'OBSIDIAN_ROUTER_DEFAULT_VAULT',
    'VAULT_PATH',
    'OBSIDIAN_ROUTER_ALLOWED_VAULTS',
  ];
  const saved = {};

  function wipeVaultEnv() {
    for (const k of Object.keys(process.env)) {
      if (/^VAULT_/.test(k)) delete process.env[k];
    }
    for (const k of TOUCHED) delete process.env[k];
  }

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-envvault-'));
    cfgPath = path.join(tmpDir, 'config.json');
    for (const k of [...TOUCHED, 'VAULT_FOO', 'VAULT_SHARED', 'VAULT_BETA', 'VAULT_GAMMA']) {
      saved[k] = process.env[k];
    }
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    // Restore the originally-snapshotted keys exactly.
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(wipeVaultEnv);
  afterEach(wipeVaultEnv);

  async function writeConfig(config) {
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
  }

  test('adds a VAULT_* vault alongside file-configured vaults', async () => {
    await writeConfig({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' }],
    });
    process.env.VAULT_BETA = JSON.stringify({
      name: 'beta',
      baseUrl: 'http://10.8.0.9:1',
      apiKey: 'k',
    });
    const r = await loadRegistry({ configPath: cfgPath });
    assert.deepEqual(r.vaults.map((v) => v.name).sort(), ['alpha', 'beta']);
    assert.equal(r.resolveVault('beta').baseUrl, 'http://10.8.0.9:1');
  });

  test('VAULT_* OVERRIDES a same-name remoteVault', async () => {
    await writeConfig({
      portRegistry: {},
      remoteVaults: [{ name: 'shared', baseUrl: 'https://old.example.com', apiKey: 'oldkey' }],
    });
    process.env.VAULT_SHARED = JSON.stringify({
      name: 'shared',
      baseUrl: 'http://10.8.0.3:27161',
      apiKey: 'newkey',
    });
    const r = await loadRegistry({ configPath: cfgPath });
    const shared = r.vaults.filter((v) => v.name === 'shared');
    assert.equal(shared.length, 1, 'exactly one "shared" after override');
    assert.equal(shared[0].baseUrl, 'http://10.8.0.3:27161');
    assert.equal(r.resolveVault('shared').apiKey, 'newkey');
  });

  test('VAULT_* OVERRIDES a same-name portRegistry (local) vault', async () => {
    // portRegistry name = defaultNameFromPath('C:\\VAULTS\\Shared') = 'shared'.
    // The local entry has no data.json on disk → missingApiKey, but the env
    // override replaces it with a usable remote descriptor.
    await writeConfig({
      portRegistry: { 'C:\\VAULTS\\Shared': 27124 },
      remoteVaults: [],
    });
    process.env.VAULT_SHARED = JSON.stringify({
      name: 'shared',
      baseUrl: 'http://10.8.0.4:27161',
      apiKey: 'k',
    });
    const r = await loadRegistry({ configPath: cfgPath });
    const shared = r.vaults.filter((v) => v.name === 'shared');
    assert.equal(shared.length, 1);
    assert.equal(shared[0].type, 'remote'); // env entry won
    assert.equal(shared[0].baseUrl, 'http://10.8.0.4:27161');
  });

  test('retro-compat: no VAULT_* set → result identical to file-only', async () => {
    await writeConfig({
      portRegistry: {},
      remoteVaults: [
        { name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' },
        { name: 'beta', baseUrl: 'https://b/', apiKey: 'k' },
      ],
      defaultVault: 'beta',
    });
    // No VAULT_* in env (wiped by beforeEach).
    const r = await loadRegistry({ configPath: cfgPath });
    assert.deepEqual(r.vaults.map((v) => v.name), ['alpha', 'beta']);
    assert.equal(r.defaultVault, 'beta');
    assert.equal(r.skipped.length, 0);
  });

  test('VAULT_* vaults are subject to the ALLOWED_VAULTS whitelist', async () => {
    await writeConfig({ portRegistry: {}, remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' }] });
    process.env.VAULT_BETA = JSON.stringify({ name: 'beta', baseUrl: 'http://10.8.0.9:1', apiKey: 'k' });
    process.env.VAULT_GAMMA = JSON.stringify({ name: 'gamma', baseUrl: 'http://10.8.0.9:2', apiKey: 'k' });
    process.env.OBSIDIAN_ROUTER_ALLOWED_VAULTS = 'alpha,beta';
    const r = await loadRegistry({ configPath: cfgPath });
    assert.deepEqual(r.vaults.map((v) => v.name).sort(), ['alpha', 'beta']);
    assert.ok(r.skipped.some((s) => s.name === 'gamma'));
  });

  test('a VAULT_* vault can be selected as the default via env override', async () => {
    await writeConfig({ portRegistry: {}, remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' }] });
    process.env.VAULT_BETA = JSON.stringify({ name: 'beta', baseUrl: 'http://10.8.0.9:1', apiKey: 'k' });
    process.env.OBSIDIAN_ROUTER_DEFAULT_VAULT = 'beta';
    const r = await loadRegistry({ configPath: cfgPath });
    assert.equal(r.defaultVault, 'beta');
  });

  test('disabledVaults disables a VAULT_* vault by name', async () => {
    await writeConfig({
      portRegistry: {},
      remoteVaults: [{ name: 'alpha', baseUrl: 'https://a/', apiKey: 'k' }],
      disabledVaults: ['beta'],
    });
    process.env.VAULT_BETA = JSON.stringify({ name: 'beta', baseUrl: 'http://10.8.0.9:1', apiKey: 'k' });
    const r = await loadRegistry({ configPath: cfgPath });
    assert.deepEqual(r.vaults.map((v) => v.name), ['alpha']);
    assert.ok(r.skipped.some((s) => s.name === 'beta' && s.reason === 'disabled'));
  });
});
