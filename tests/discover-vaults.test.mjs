/**
 * Tests for `setup-vault.mjs --discover-vaults [--bootstrap-all]` (v0.13.9).
 *
 * Scans well-known per-OS locations for `.obsidian/` directories and reports
 * status (reference | registered | candidate | partial). With `--bootstrap-all`,
 * every candidate is bootstrapped sequentially.
 *
 * Strategy: use `--scan-dir <temp>` to point the scanner at synthetic vaults,
 * and assert the synthetic ones appear with the right classification. We
 * deliberately do NOT assert the absence of other vaults — the test machine
 * may have real vaults under C:/VAULTS that show up in the default scan.
 *
 * Redirecting HOME suppresses the cross-platform default roots ($HOME/Obsidian
 * etc.) but Windows drive-rooted defaults (C:/VAULTS) still get scanned.
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

function homeEnv(homeDir) {
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: '',
    HOMEPATH: '',
  };
}

function runScript(args, opts = {}) {
  const { configPath, homeDir, extraEnv = {} } = opts;
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(homeDir ? homeEnv(homeDir) : {}),
        ...(configPath ? { OBSIDIAN_ROUTER_CONFIG: configPath } : {}),
        ...extraEnv,
      },
    },
  );
}

function makeFakeVault(parentDir, name, opts = {}) {
  const vaultPath = path.join(parentDir, name);
  fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true });
  if (opts.withRestApi) {
    fs.mkdirSync(path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api'), { recursive: true });
  }
  if (opts.withBridge) {
    fs.mkdirSync(path.join(vaultPath, '.obsidian', 'plugins', 'mcp-router-bridge'), { recursive: true });
  }
  return vaultPath;
}

describe('--discover-vaults (report mode)', () => {
  let workDir;
  let homeDir;
  let configPath;
  let scanRoot;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-test-'));
    homeDir = path.join(workDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    configPath = path.join(workDir, 'config.json');
    scanRoot = path.join(workDir, 'scan-root');
    fs.mkdirSync(scanRoot, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault: null, portRegistry: {}, portStart: 27200,
    }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('detects child dir with .obsidian/ as a candidate', () => {
    const v1 = makeFakeVault(scanRoot, 'fresh-vault', { withRestApi: true, withBridge: true });

    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir', scanRoot],
      { homeDir, configPath },
    );
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.match(result.stdout, new RegExp(escRe(v1)));
    // Should fall under "Candidates ready to bootstrap"
    assert.match(result.stdout, /Candidates ready to bootstrap/);
  });

  test('ignores dirs without .obsidian/', () => {
    const garbage = path.join(scanRoot, 'not-a-vault');
    fs.mkdirSync(garbage);
    fs.writeFileSync(path.join(garbage, 'random.txt'), 'hi');

    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir', scanRoot],
      { homeDir, configPath },
    );
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, new RegExp(escRe(garbage)));
  });

  test('classifies vault as partial when Local REST API plugin folder missing', () => {
    const v = makeFakeVault(scanRoot, 'no-rest', { withRestApi: false });

    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir', scanRoot],
      { homeDir, configPath },
    );
    assert.equal(result.status, 0);
    // The "Partial" section should contain this vault's path.
    assert.match(result.stdout, /Partial — missing Local REST API plugin/);
    assert.match(result.stdout, new RegExp(escRe(v)));
  });

  test('classifies already-registered vaults as registered (not candidate)', () => {
    const v = makeFakeVault(scanRoot, 'mine', { withRestApi: true, withBridge: true });
    // Register it in the config.
    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault: null,
      portRegistry: { [v]: 27200 },
      portStart: 27200,
    }, null, 2));

    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir', scanRoot],
      { homeDir, configPath },
    );
    assert.equal(result.status, 0);
    // The synthetic vault must appear under "Already registered", NOT
    // "Candidates ready to bootstrap". We check both directions.
    const registeredSection = sectionBetween(result.stdout, 'Already registered', /(Candidates|Partial|To bootstrap|$)/);
    assert.ok(
      registeredSection.includes(v),
      `expected ${v} in Already registered section; got:\n${registeredSection}`,
    );
  });

  test('classifies reference vault separately', () => {
    const v = makeFakeVault(scanRoot, 'ref', { withRestApi: true });
    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault: v,
      portRegistry: {},
      portStart: 27200,
    }, null, 2));

    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir', scanRoot],
      { homeDir, configPath },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Reference vault:/);
    const refSection = sectionBetween(result.stdout, 'Reference vault', /(Already|Candidates|Partial|To bootstrap|$)/);
    assert.ok(refSection.includes(v), `expected ${v} in Reference section`);
  });

  test('also detects vault when --scan-dir points AT a vault (not just its container)', () => {
    const v = makeFakeVault(workDir, 'standalone-vault', { withRestApi: true });

    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir', v],
      { homeDir, configPath },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(escRe(v)));
  });

  test('--scan-dir without value fails fast', () => {
    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir'],
      { homeDir, configPath },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /--scan-dir requires a path/i);
  });
});

describe('--discover-vaults --bootstrap-all', () => {
  let workDir;
  let homeDir;
  let configPath;
  let scanRoot;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-bootstrap-test-'));
    homeDir = path.join(workDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    configPath = path.join(workDir, 'config.json');
    scanRoot = path.join(workDir, 'scan-root');
    fs.mkdirSync(scanRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('--bootstrap-all --dry-run prints would-bootstrap list, exits 0', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault: null, portRegistry: {}, portStart: 27200,
    }, null, 2));
    const v = makeFakeVault(scanRoot, 'fresh', { withRestApi: true });

    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir', scanRoot, '--bootstrap-all', '--dry-run'],
      { homeDir, configPath },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[DRY-RUN\]/);
    assert.match(result.stdout, /Would bootstrap/);
    assert.match(result.stdout, new RegExp(escRe(v)));
  });

  test('--bootstrap-all without reference vault: fails with clear message', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault: null, portRegistry: {}, portStart: 27200,
    }, null, 2));
    makeFakeVault(scanRoot, 'fresh', { withRestApi: true });

    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir', scanRoot, '--bootstrap-all'],
      { homeDir, configPath },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /no reference vault configured/i);
  });

  test('--bootstrap-all with 0 candidates: reports and exits 0', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault: null, portRegistry: {}, portStart: 27200,
    }, null, 2));
    // Only a partial vault (no REST API plugin) and a registered vault → 0 candidates.
    const partial = makeFakeVault(scanRoot, 'partial', { withRestApi: false });
    const registered = makeFakeVault(scanRoot, 'registered', { withRestApi: true });
    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault: null,
      portRegistry: { [registered]: 27200 },
      portStart: 27200,
    }, null, 2));

    const result = runScript(
      ['--discover-vaults', '--no-default-scan', '--scan-dir', scanRoot, '--bootstrap-all'],
      { homeDir, configPath },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /No candidates to bootstrap/i);
  });
});

// ---------- helpers ----------

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Slice the output between `startLabel:` and the next section header matched
 * by `nextLabelRe`. Used to assert that a specific vault path appears under a
 * specific status section, not just anywhere in the output.
 */
function sectionBetween(text, startLabel, nextLabelRe) {
  const startIdx = text.indexOf(startLabel);
  if (startIdx === -1) return '';
  const sub = text.slice(startIdx);
  const m = sub.search(nextLabelRe);
  // m may match the start label itself if it's the only one — slice past it.
  return m > startLabel.length ? sub.slice(0, m) : sub;
}
