/**
 * Tests for `setup-vault.mjs --upgrade-insecure-server[-all]` (v0.13.9).
 *
 * The mode targets a legacy gap: vaults bootstrapped BEFORE the v0.10.x
 * release that added `insecurePort` + `enableInsecureServer` to the default
 * data.json. Those vaults stay HTTPS-only and break under Bitdefender / ESET /
 * Kaspersky which silently drop self-signed HTTPS loopback. The `--sync-plugins
 * --force` path preserves data.json (credential safety) so it doesn't repair
 * this either — hence the dedicated mode.
 *
 * Strategy: spawn the CLI with synthetic temp-dir vaults + a temp config.json
 * pointed at via OBSIDIAN_ROUTER_CONFIG. Verify the on-disk effect of the
 * upgrade matches the documented behavior matrix.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'setup-vault.mjs');

/** The installation these fixtures belong to. */
const LOCAL_INSTALL_ID = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const OTHER_INSTALL_ID = '11111111-2222-4333-8444-555555555555';

/**
 * Stamp a vault's identity file.
 *
 * v0.94.0, lot 4: `--upgrade-insecure-server` writes `insecurePort` into a
 * vault's plugin configuration, so it is a port write like any other and
 * invariant I2 gates it — a repair path is exactly the kind of site a guard
 * reaches last. An unowned vault is now refused rather than repaired, which is
 * why every fixture below states who owns it instead of leaving it implicit.
 */
function stampIdentity(vaultPath, { installId = LOCAL_INSTALL_ID, hostname = 'FIXTURE-PC' } = {}) {
  const dir = path.join(vaultPath, '.obsidian', 'obsidian-mcp-router');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({
    schemaVersion: 1,
    vaultId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    owner: installId === null ? null : { installId, hostname },
    createdAt: '2026-09-09T00:00:00.000Z',
  }, null, 2));
}

function makeVault(workDir, name, dataOverride = {}, identityOptions = {}) {
  const vaultPath = path.join(workDir, name);
  const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api');
  fs.mkdirSync(pluginDir, { recursive: true });
  const data = {
    apiKey: `KEY-${name}-DO-NOT-LEAK`,
    port: 27130,
    bindingHost: '127.0.0.1',
    crypto: { cert: 'STUB-CERT', privateKey: 'STUB-KEY', publicKey: 'STUB-PUB' },
    ...dataOverride,
  };
  fs.writeFileSync(path.join(pluginDir, 'data.json'), JSON.stringify(data, null, 2));
  if (identityOptions.skip !== true) stampIdentity(vaultPath, identityOptions);
  return { vaultPath, dataPath: path.join(pluginDir, 'data.json'), initial: data };
}

function readData(dataPath) {
  return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

function runScript(args, env = {}) {
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, ...args],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
}

describe('--upgrade-insecure-server (single vault)', () => {
  let workDir;
  let configPath;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-http-test-'));
    configPath = path.join(workDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ installId: LOCAL_INSTALL_ID, portRegistry: {}, portStart: 27130 }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('legacy vault (no insecurePort, no enableInsecureServer): patches both, preserves apiKey/port/cert', () => {
    const { vaultPath, dataPath, initial } = makeVault(workDir, 'legacy', {
      port: 27200,
      // No insecurePort, no enableInsecureServer — the legacy case.
    });

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);

    const after = readData(dataPath);
    assert.equal(after.insecurePort, 27210, 'should default to port + 10');
    assert.equal(after.enableInsecureServer, true);
    assert.equal(after.apiKey, initial.apiKey, 'apiKey must be preserved');
    assert.equal(after.port, 27200, 'port must be preserved');
    assert.deepEqual(after.crypto, initial.crypto, 'cert + key must be preserved');
    assert.equal(after.bindingHost, '127.0.0.1');
  });

  test('vault with insecurePort set but enableInsecureServer:false: only flips the bool', () => {
    const { vaultPath, dataPath } = makeVault(workDir, 'partial', {
      port: 27200,
      insecurePort: 27299, // custom user value
      enableInsecureServer: false,
    });

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 0);

    const after = readData(dataPath);
    assert.equal(after.insecurePort, 27299, 'must preserve user-chosen insecurePort');
    assert.equal(after.enableInsecureServer, true);
  });

  test('vault already HTTP-enabled: no-op, exit 0', () => {
    const { vaultPath, dataPath, initial } = makeVault(workDir, 'enabled', {
      port: 27200,
      insecurePort: 27210,
      enableInsecureServer: true,
    });

    // Capture mtime to assert no write.
    const mtimeBefore = fs.statSync(dataPath).mtimeMs;

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /already HTTP-enabled/);

    // Wait a tick + verify mtime unchanged.
    const mtimeAfter = fs.statSync(dataPath).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'file must not be rewritten when no-op');

    const after = readData(dataPath);
    assert.equal(after.insecurePort, 27210, 'unchanged');
    assert.deepEqual(after, initial);
  });

  test('--dry-run does not write anything', () => {
    const { vaultPath, dataPath } = makeVault(workDir, 'dry', {
      port: 27200,
    });
    const mtimeBefore = fs.statSync(dataPath).mtimeMs;

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath, '--dry-run'],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[DRY-RUN\]/);

    const mtimeAfter = fs.statSync(dataPath).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore);

    const after = readData(dataPath);
    assert.equal(after.insecurePort, undefined, 'dry-run must not write');
  });

  test('a vault owned by ANOTHER installation is refused, and its data.json is untouched', () => {
    // v0.94.0, lot 4 / invariant I2. This vault is the shared-over-Drive case:
    // its ports must stay identical on both machines or the click-to-open links
    // written in its notes break on the other one. A "repair" here is damage.
    const { vaultPath, dataPath, initial } = makeVault(workDir, 'foreign', {
      port: 27200,
    }, { installId: OTHER_INSTALL_ID, hostname: 'SONS-PC' });
    const before = fs.readFileSync(dataPath, 'utf8');

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.match(result.stdout + result.stderr, /owned by another installation/i);
    assert.equal(fs.readFileSync(dataPath, 'utf8'), before, 'a foreign vault was written to');
    assert.equal(readData(dataPath).insecurePort, undefined);
    assert.equal(readData(dataPath).apiKey, initial.apiKey);
    // The refusal names the OWNER'S LABEL, never its installId: putting another
    // machine's identifier into logs and transcripts buys nothing.
    assert.match(result.stdout + result.stderr, /SONS-PC/);
    assert.ok(!(result.stdout + result.stderr).includes(OTHER_INSTALL_ID), 'a foreign installId leaked');
  });

  test('a vault nobody has claimed is refused too — absent owner is not permission', () => {
    const { vaultPath, dataPath } = makeVault(workDir, 'unclaimed', { port: 27200 }, { installId: null });
    const before = fs.readFileSync(dataPath, 'utf8');

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.match(result.stdout + result.stderr, /no owner recorded/i);
    assert.equal(fs.readFileSync(dataPath, 'utf8'), before);
  });

  test('a vault with NO identity file at all is refused, and none is invented', () => {
    const { vaultPath, dataPath } = makeVault(workDir, 'identityless', { port: 27200 }, { skip: true });
    const before = fs.readFileSync(dataPath, 'utf8');

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(fs.readFileSync(dataPath, 'utf8'), before);
    // And a repair path must NOT be a back door that stamps an identity: only
    // an explicit setup does that, so the operator sees the claim happen.
    assert.equal(
      fs.existsSync(path.join(vaultPath, '.obsidian', 'obsidian-mcp-router', 'identity.json')),
      false,
      'a repair path silently created an identity',
    );
  });

  test('no data.json: warns + non-fatal (exit 0)', () => {
    // Vault root exists but plugin dir doesn't.
    const vaultPath = path.join(workDir, 'no-plugin');
    fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true });

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    // no-data-json is not 'failed' — exit 0 (we treat absence as informational).
    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /no Local REST API data\.json/);
  });

  test('corrupt data.json: reports failure, exit 1', () => {
    const vaultPath = path.join(workDir, 'corrupt');
    const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'data.json'), '{ not valid json');

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /data\.json is not valid JSON/);
  });

  test('data.json without port: reports no-port, exit 0', () => {
    const vaultPath = path.join(workDir, 'no-port');
    const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'data.json'), JSON.stringify({ apiKey: 'X' }));

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /no usable `port` field/);
  });

  test('insecurePort === port: bumps to port + 10 (safety against self-collision)', () => {
    const { vaultPath, dataPath } = makeVault(workDir, 'self-collide', {
      port: 27200,
      insecurePort: 27200, // pathological — same as port
      enableInsecureServer: true,
    });

    const result = runScript(
      ['--upgrade-insecure-server', vaultPath],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 0);

    const after = readData(dataPath);
    assert.notEqual(after.insecurePort, 27200, 'must escape the self-collision');
    assert.equal(after.insecurePort, 27210, 'should land on port + 10');
  });
});

describe('--upgrade-insecure-server-all (batch)', () => {
  let workDir;
  let configPath;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-http-all-test-'));
    configPath = path.join(workDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('iterates portRegistry, reports per-status summary', () => {
    const v1 = makeVault(workDir, 'legacy-one', { port: 27200 });
    const v2 = makeVault(workDir, 'legacy-two', { port: 27201 });
    const v3 = makeVault(workDir, 'already-ok', {
      port: 27202, insecurePort: 27212, enableInsecureServer: true,
    });

    fs.writeFileSync(configPath, JSON.stringify({
      installId: LOCAL_INSTALL_ID,
      portRegistry: { [v1.vaultPath]: 27200, [v2.vaultPath]: 27201, [v3.vaultPath]: 27202 },
      portStart: 27200,
    }, null, 2));

    const result = runScript(
      ['--upgrade-insecure-server-all'],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 0, `stderr=${result.stderr}`);

    // Summary line present
    assert.match(result.stdout, /upgraded:\s+2/);
    assert.match(result.stdout, /already-enabled:\s+1/);

    // Both legacy vaults patched, with collision avoidance (port + 10 each).
    const a1 = readData(v1.dataPath);
    const a2 = readData(v2.dataPath);
    assert.equal(a1.enableInsecureServer, true);
    assert.equal(a2.enableInsecureServer, true);
    assert.notEqual(a1.insecurePort, a2.insecurePort, 'collision avoidance: ports must differ');

    // Already-ok vault unchanged.
    const a3 = readData(v3.dataPath);
    assert.equal(a3.insecurePort, 27212);
  });

  test('--dry-run on batch: no writes, summary printed', () => {
    const v1 = makeVault(workDir, 'legacy', { port: 27200 });
    fs.writeFileSync(configPath, JSON.stringify({
      installId: LOCAL_INSTALL_ID,
      portRegistry: { [v1.vaultPath]: 27200 }, portStart: 27200,
    }, null, 2));
    const mtimeBefore = fs.statSync(v1.dataPath).mtimeMs;

    const result = runScript(
      ['--upgrade-insecure-server-all', '--dry-run'],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[DRY-RUN\]/);
    assert.match(result.stdout, /upgraded:\s+1/);

    const mtimeAfter = fs.statSync(v1.dataPath).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore);
  });

  test('empty portRegistry: fails with clear message', () => {
    fs.writeFileSync(configPath, JSON.stringify({ installId: LOCAL_INSTALL_ID, portRegistry: {}, portStart: 27200 }, null, 2));

    const result = runScript(
      ['--upgrade-insecure-server-all'],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /no vaults in portRegistry/i);
  });

  test('vault path with no data.json: counted in no-data-json bucket, batch still exits 0', () => {
    const v1 = makeVault(workDir, 'real', { port: 27200 });
    // Pretend the registry references a vault that doesn't have the plugin
    // installed (folder doesn't exist on disk).
    const ghostVault = path.join(workDir, 'ghost');
    fs.mkdirSync(path.join(ghostVault, '.obsidian'), { recursive: true });

    fs.writeFileSync(configPath, JSON.stringify({
      installId: LOCAL_INSTALL_ID,
      portRegistry: { [v1.vaultPath]: 27200, [ghostVault]: 27201 },
      portStart: 27200,
    }, null, 2));

    const result = runScript(
      ['--upgrade-insecure-server-all'],
      { OBSIDIAN_ROUTER_CONFIG: configPath },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no-data-json:\s+1/);
    assert.match(result.stdout, /upgraded:\s+1/);
  });
});
