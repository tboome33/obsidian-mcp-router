/**
 * CLI-level proof for the two-port registry (v0.77.0).
 *
 * `tests/port-registry.test.mjs` pins the pure helpers. THIS file proves the
 * wiring: that `setup-vault.mjs` actually consults both port spaces before
 * handing out a port, that a copy of the reference vault gets renumbered
 * instead of inheriting, and that migrating a legacy `config.json` loses
 * nothing.
 *
 * Every test here is RED against the pre-fix code — that is the point of
 * writing them at this level rather than only against the helpers:
 *
 *   - "refuses a port held by another vault's insecurePort": the old
 *     `allocatePort` scanned `Object.values(portRegistry)` (HTTPS only) and
 *     would have handed out 27200, which Beta already binds in plaintext.
 *   - "renumbers a copy of the reference vault": the old adoption branch saw
 *     the copied `data.json`, found no conflict in the HTTPS-only registry,
 *     and adopted the reference's port AND its API key. Three of the nine
 *     collisions measured on 2026-08-29 were exactly this.
 *
 * Fixtures are synthetic temp vaults, so no real vault, port or credential is
 * involved. Fake API keys are BUILT from the vault name rather than written as
 * string literals — a literal long enough to satisfy the code under test
 * (`apiKey.length > 16` is what makes provisioning treat a vault as
 * pre-existing) is also long enough for the export gate's credential scanner
 * to stop a release over it.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-vault.mjs');

/** An obviously-fake API key, long enough to read as "already configured". */
const fakeKey = (label) => `KEY-${label}-DO-NOT-LEAK-0000`;

/** A minimal vault carrying the two REQUIRED plugins + a REST API data.json. */
function makeVault(root, name, restData) {
  const vaultPath = path.join(root, name);
  for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']) {
    fs.mkdirSync(path.join(vaultPath, '.obsidian', 'plugins', p), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
  }
  fs.writeFileSync(
    path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
    JSON.stringify(restData, null, 2));
  fs.writeFileSync(
    path.join(vaultPath, '.obsidian', 'community-plugins.json'),
    JSON.stringify(['obsidian-local-rest-api', 'mcp-router-bridge', 'smart-connections']));
  return vaultPath;
}

function readRest(vaultPath) {
  return JSON.parse(fs.readFileSync(
    path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8'));
}

describe('setup-vault.mjs — port allocation across BOTH port spaces', () => {
  let workDir, ref, cfgPath;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-registry-cli-'));
    ref = makeVault(workDir, '.template', {
      apiKey: fakeKey('ref'),
      port: 27123,
      insecurePort: 27133,
      crypto: { cert: 'STUB-CERT', privateKey: 'STUB-KEY' },
    });
    cfgPath = path.join(workDir, 'config.json');
  });

  after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  function writeConfig(cfg) {
    fs.writeFileSync(cfgPath, JSON.stringify({ referenceVault: ref, ...cfg }, null, 2));
  }

  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OBSIDIAN_ROUTER_CONFIG: cfgPath,
        OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1',
      },
    });
  }

  function readConfig() {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }

  test('REFUSES a port held by another vault\'s insecurePort — the reported bug', () => {
    // Beta is registered under the LEGACY shape (HTTPS only: 27190). Its
    // plaintext server binds 27200 — a fact that exists ONLY in its data.json.
    // portStart is 27200, so the old allocator (which read the registry's
    // values and nothing else) saw 27200 as free and would have handed it to
    // the new vault. Its HTTPS server would then have fought Beta's HTTP one:
    // whichever started second would fail to bind and look "offline".
    const beta = makeVault(workDir, 'Beta', {
      apiKey: fakeKey('beta'),
      port: 27190,
      insecurePort: 27200,
    });
    writeConfig({ portStart: 27200, portRegistry: { [path.resolve(beta)]: 27190 } });

    const target = path.join(workDir, 'AllocTarget');
    const r = run([target]);
    assert.equal(r.status, 0, `bootstrap must succeed. stderr=${r.stderr}`);

    const rest = readRest(target);
    assert.notEqual(rest.port, 27200, 'must not take a port bound by another vault in plaintext');
    assert.notEqual(rest.insecurePort, 27200);
    // 27200 is out (Beta plaintext), so is 27210 for the pair, so is 27190/27133/27123.
    assert.equal(rest.port, 27201);
    assert.equal(rest.insecurePort, 27211);

    // And both ports are now on record, so the next allocation sees them.
    const entry = readConfig().portRegistry[path.resolve(target)];
    assert.deepEqual(entry, { https: 27201, http: 27211 });
  });

  test('both members of the pair are checked — a free HTTPS port with a taken partner is skipped', () => {
    const gamma = makeVault(workDir, 'Gamma', {
      apiKey: fakeKey('gamma'),
      port: 27390,
      insecurePort: 27310, // the partner of the otherwise-free 27300
    });
    writeConfig({
      portStart: 27300,
      portRegistry: { [path.resolve(gamma)]: { https: 27390, http: 27310 } },
    });

    const target = path.join(workDir, 'PairTarget');
    const r = run([target]);
    assert.equal(r.status, 0, r.stderr);
    const rest = readRest(target);
    assert.notEqual(rest.port, 27300, '27300 was free but its partner 27310 was not');
    assert.equal(rest.port, 27301);
    assert.equal(rest.insecurePort, 27311);
  });

  test('the reference vault\'s OWN ports are reserved, even though it is not registered', () => {
    // `.template` binds 27123/27133 but sits outside portRegistry in this
    // fixture — reading it from disk is what keeps a new vault off its ports.
    writeConfig({ portStart: 27123, portRegistry: {} });
    const target = path.join(workDir, 'RefPortTarget');
    const r = run([target]);
    assert.equal(r.status, 0, r.stderr);
    const rest = readRest(target);
    for (const taken of [27123, 27133]) {
      assert.notEqual(rest.port, taken, `must not take the reference's ${taken}`);
      assert.notEqual(rest.insecurePort, taken);
    }
  });
});

describe('setup-vault.mjs — a copy of the reference vault gets RENUMBERED, never inherits', () => {
  let workDir, ref, cfgPath;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-inherit-'));
    ref = makeVault(workDir, '.template', {
      apiKey: fakeKey('ref'),
      port: 27124,
      insecurePort: 27134,
      crypto: { cert: 'STUB-CERT', privateKey: 'STUB-KEY' },
    });
    cfgPath = path.join(workDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      referenceVault: ref, portStart: 27124, portRegistry: {},
    }, null, 2));
  });

  after(() => { /* per-test dirs cleaned below */ });

  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OBSIDIAN_ROUTER_CONFIG: cfgPath,
        OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1',
      },
    });
  }

  test('a folder-copy of the template does NOT keep 27124/27134 or the template\'s API key', () => {
    // Exactly how Roblox, RECHERCHES ETUDES SUP and the second .template all
    // ended up sitting on the factory 27124/27134: the vault directory is a
    // copy of the reference, ports and credentials included, and provisioning
    // used to ADOPT what it found there.
    const target = path.join(workDir, 'CopiedFromTemplate');
    fs.cpSync(ref, target, { recursive: true });
    assert.equal(readRest(target).port, 27124, 'precondition: the copy carries the template\'s port');

    const r = run([target]);
    assert.equal(r.status, 0, `bootstrap must succeed. stderr=${r.stderr}`);

    const rest = readRest(target);
    assert.notEqual(rest.port, 27124, 'the copy must be renumbered off the template\'s HTTPS port');
    assert.notEqual(rest.insecurePort, 27134, 'and off its plaintext port');
    assert.notEqual(rest.apiKey, fakeKey('ref'), 'and must not inherit its API key');
    assert.equal(rest.port, 27125, 'first pair free above portStart');
    assert.equal(rest.insecurePort, 27135);

    const entry = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).portRegistry[path.resolve(target)];
    assert.deepEqual(entry, { https: 27125, http: 27135 });

    // The message has to say what happened, or the renumbering looks arbitrary.
    assert.match((r.stdout || '') + (r.stderr || ''), /Renumbering to a fresh port pair/);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('a port clash with the source is NOT a copy — the vault keeps its insecurePort', () => {
    // REGRESSION, found in pre-release review (2026-08-30). The copy-detection
    // heuristic used to fire on `apiKey OR port` matching the source. The port
    // half was wrong: an INDEPENDENT vault that merely happens to sit on the
    // reference's HTTPS port was classified as a copy, renumbered, and re-keyed
    // — and renumbering writes a NEW insecurePort over the one it legitimately
    // owns, killing every click-to-open link already written to it. Measured
    // before the fix: 27199 → 27135, plus a regenerated key.
    //
    // The API key is the only honest tell (32 random bytes; no independent
    // vault grows the same one). A port clash must REFUSE and let the user
    // decide, because only they know whether the links matter.
    const target = makeVault(workDir, 'IndependentButClashing', {
      apiKey: fakeKey('independent'),
      port: 27124,        // collides with the reference vault's HTTPS port
      insecurePort: 27199, // its OWN plaintext port — notes link to this
    });
    const before = readRest(target);

    const r = run([target]);
    assert.notEqual(r.status, 0, 'a port clash must be refused, not silently resolved');

    const after = readRest(target);
    assert.equal(after.insecurePort, 27199, 'the existing insecurePort must survive untouched');
    assert.equal(after.apiKey, before.apiKey, 'an independent vault keeps its own key');
    assert.equal(after.port, 27124, 'nothing was rewritten at all');

    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /27124/, 'the message names the disputed port');
    assert.match(out, /BREAKS every click-to-open link/, 'and warns what --regenerate would cost');
    assert.ok(!/Renumbering to a fresh port pair/.test(out), 'must NOT take the copy-of-source branch');
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('a vault with NO insecurePort gets a free one, not a blind port+10', () => {
    // Pre-v0.10.x vaults have a port and a key but no plaintext port at all.
    // Nothing is renumbered here (there is no plaintext port to preserve) —
    // but the one being CREATED must still be checked against both spaces.
    const other = makeVault(workDir, 'HoldsThePlusTen', {
      apiKey: fakeKey('other'), port: 27400, insecurePort: 27410,
    });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.portRegistry[path.resolve(other)] = { https: 27400, http: 27410 };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    // This vault is live on 27500; its conventional +10 (27510) is free, but
    // make 27510 taken to force the skip.
    const legacy = makeVault(workDir, 'LegacyNoInsecurePort', {
      apiKey: fakeKey('legacy'), port: 27500,
    });
    const blocker = makeVault(workDir, 'HoldsTheSlot', {
      apiKey: fakeKey('blocker'), port: 27600, insecurePort: 27510,
    });
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg2.portRegistry[path.resolve(blocker)] = { https: 27600, http: 27510 };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2));

    const r = run([legacy]);
    assert.equal(r.status, 0, r.stderr);
    const rest = readRest(legacy);
    assert.equal(rest.port, 27500, 'the live HTTPS port is untouched');
    assert.notEqual(rest.insecurePort, 27510, 'must not take the blocker\'s plaintext port');
    assert.equal(rest.insecurePort, 27511);
    assert.equal(rest.enableInsecureServer, true);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('an INDEPENDENT existing vault still has its own ports adopted, not reset', () => {
    // The counterpart guard: renumbering must key on "this is a copy of the
    // source", not on "the target already had a data.json". A vault someone
    // configured by hand keeps its port — and its insecurePort, which its
    // click-to-open links are pinned to.
    const target = makeVault(workDir, 'IndependentVault', {
      apiKey: fakeKey('independent'),
      port: 27401,
      insecurePort: 27411,
    });
    const r = run([target]);
    assert.equal(r.status, 0, r.stderr);
    const rest = readRest(target);
    assert.equal(rest.port, 27401, 'existing HTTPS port kept');
    assert.equal(rest.insecurePort, 27411, 'existing plaintext port kept — links stay valid');
    assert.equal(rest.apiKey, fakeKey('independent'), 'existing key kept');
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('adoption is REFUSED when the existing port is claimed by another vault\'s plaintext server', () => {
    // The old conflict check compared only against the registry's HTTPS
    // column, so a clash with a plaintext listener sailed through.
    const other = makeVault(workDir, 'OtherVault', {
      apiKey: fakeKey('other'),
      port: 27500,
      insecurePort: 27510,
    });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.portRegistry[path.resolve(other)] = { https: 27500, http: 27510 };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const target = makeVault(workDir, 'ClashingVault', {
      apiKey: fakeKey('clash'),
      port: 27510, // collides with OtherVault's PLAINTEXT port
      insecurePort: 27520,
    });
    const r = run([target]);
    assert.notEqual(r.status, 0, 'must refuse rather than register a known collision');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /27510/);
    assert.match(out, /plaintext/);
    assert.match(out, /--regenerate/, 'and must say how to get past it');
    fs.rmSync(workDir, { recursive: true, force: true });
  });
});

describe('setup-vault.mjs --sync-port-registry / --check-ports', () => {
  let workDir, cfgPath, alpha, beta, orphan;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-migrate-'));
    alpha = makeVault(workDir, 'Alpha', { apiKey: fakeKey('alpha'), port: 27124, insecurePort: 27134 });
    // Off-convention on purpose: the fleet really does contain 27131/27162.
    beta = makeVault(workDir, 'Beta', { apiKey: fakeKey('beta'), port: 27131, insecurePort: 27162 });
    // Registered but never opened in Obsidian → no data.json at all.
    orphan = path.join(workDir, 'Orphan');
    fs.mkdirSync(path.join(orphan, '.obsidian'), { recursive: true });
    cfgPath = path.join(workDir, 'config.json');
  });

  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfgPath, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
    });
  }

  function writeLegacyConfig(extra = {}) {
    fs.writeFileSync(cfgPath, JSON.stringify({
      portStart: 27124,
      portRegistry: {
        [path.resolve(alpha)]: 27124,
        [path.resolve(beta)]: 27131,
        [path.resolve(orphan)]: 27140,
      },
      vaultNames: { [path.resolve(alpha)]: 'alpha' },
      disabledVaults: [path.resolve(orphan)],
      defaultVault: 'alpha',
      ...extra,
    }, null, 2));
  }

  test('migrates a legacy config WITHOUT LOSS, and leaves a timestamped backup', () => {
    writeLegacyConfig();
    const before = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

    const r = run(['--sync-port-registry']);
    assert.equal(r.status, 0, r.stderr);

    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

    // 1. Every non-registry field survives byte-for-byte.
    for (const key of ['portStart', 'vaultNames', 'disabledVaults', 'defaultVault']) {
      assert.deepEqual(after[key], before[key], `${key} preserved`);
    }
    // 2. Every key survives, in order.
    assert.deepEqual(Object.keys(after.portRegistry), Object.keys(before.portRegistry));
    // 3. No HTTPS port moves.
    assert.equal(after.portRegistry[path.resolve(alpha)].https, 27124);
    assert.equal(after.portRegistry[path.resolve(beta)].https, 27131);
    assert.equal(after.portRegistry[path.resolve(orphan)].https, 27140);
    // 4. Plaintext ports come from each data.json — the off-convention pair
    //    is recorded as it IS, not "corrected" to 27141.
    assert.equal(after.portRegistry[path.resolve(alpha)].http, 27134);
    assert.equal(after.portRegistry[path.resolve(beta)].http, 27162);
    // 5. The unreadable vault is recorded as UNKNOWN, never guessed as +10.
    assert.equal(after.portRegistry[path.resolve(orphan)].http, null);
    assert.notEqual(after.portRegistry[path.resolve(orphan)].http, 27150);

    // 6. A timestamped backup of the pre-migration file exists and still
    //    parses as the ORIGINAL config.
    const backups = fs.readdirSync(workDir).filter((f) => f.startsWith('config.json.portRegistry-') && f.endsWith('.bak'));
    assert.equal(backups.length, 1, 'exactly one timestamped backup');
    assert.match(backups[0], /config\.json\.portRegistry-\d{4}-\d{2}-\d{2}T[\d-]+Z\.bak/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workDir, backups[0]), 'utf8')), before);

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('is idempotent — a second run changes nothing and writes no second backup', () => {
    writeLegacyConfig();
    assert.equal(run(['--sync-port-registry']).status, 0);
    const afterFirst = fs.readFileSync(cfgPath, 'utf8');

    const r2 = run(['--sync-port-registry']);
    assert.equal(r2.status, 0);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), afterFirst, 'byte-identical');
    assert.match((r2.stdout || '') + (r2.stderr || ''), /already in the two-port shape/);
    const backups = fs.readdirSync(workDir).filter((f) => f.includes('.portRegistry-'));
    assert.equal(backups.length, 1, 'no backup churn on a no-op run');
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('--dry-run previews without touching the config or leaving a backup', () => {
    writeLegacyConfig();
    const before = fs.readFileSync(cfgPath, 'utf8');
    const r = run(['--sync-port-registry', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), before, 'config untouched');
    assert.equal(fs.readdirSync(workDir).filter((f) => f.includes('.bak')).length, 0, 'no backup written');
    assert.match((r.stdout || '') + (r.stderr || ''), /DRY-RUN/);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('--check-ports is clean on a healthy fleet (exit 0)', () => {
    writeLegacyConfig();
    run(['--sync-port-registry']);
    const r = run(['--check-ports']);
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
    assert.match((r.stdout || '') + (r.stderr || ''), /No port collisions/);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('--check-ports names the two vaults sharing a port, and exits 1', () => {
    // Alpha binds 27134 in plaintext; give Beta the same number as its HTTPS
    // port — the exact shape that produced ERR_SSL_WRONG_VERSION_NUMBER.
    fs.writeFileSync(
      path.join(beta, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: fakeKey('beta'), port: 27134, insecurePort: 27162 }, null, 2));
    writeLegacyConfig();

    const r = run(['--check-ports']);
    assert.equal(r.status, 1, 'a real collision must exit non-zero');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /27134/);
    assert.match(out, /Alpha/);
    assert.match(out, /Beta/);
    assert.match(out, /never the insecurePort/, 'must say which port is allowed to move');
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('--check-ports --json emits machine-readable findings', () => {
    fs.writeFileSync(
      path.join(beta, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: fakeKey('beta'), port: 27134, insecurePort: 27162 }, null, 2));
    writeLegacyConfig();
    const r = run(['--check-ports', '--json']);
    assert.equal(r.status, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.vaults, 3);
    const dup = report.findings.find((f) => f.kind === 'duplicate-port');
    assert.equal(dup.port, 27134);
    assert.equal(dup.severity, 'error');
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('--status prints BOTH ports per vault, and flags the collision', () => {
    fs.writeFileSync(
      path.join(beta, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: fakeKey('beta'), port: 27134, insecurePort: 27162 }, null, 2));
    writeLegacyConfig();
    run(['--sync-port-registry']);
    const r = run(['--status']);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout || '';
    assert.match(out, /http 27134/, 'the plaintext port is visible where people look for it');
    assert.match(out, /Port problems detected/);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('a provisioning run reconciles a legacy registry on its own, backup included', () => {
    // The migration is not a chore the user has to remember: a legacy registry
    // is at its most dangerous exactly when the allocator is about to trust it.
    const ref = makeVault(workDir, '.template', {
      apiKey: fakeKey('ref'), port: 27123, insecurePort: 27133,
    });
    writeLegacyConfig({ referenceVault: ref });
    const target = path.join(workDir, 'AutoMigrated');
    const r = run([target]);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.deepEqual(after.portRegistry[path.resolve(alpha)], { https: 27124, http: 27134 });
    assert.equal(fs.readdirSync(workDir).filter((f) => f.includes('.portRegistry-')).length, 1);
    fs.rmSync(workDir, { recursive: true, force: true });
  });
});
