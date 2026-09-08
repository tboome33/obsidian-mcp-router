/**
 * Lot 3 — moving the allocation base for FUTURE vaults, and nothing else.
 *
 * The command's whole value is a negative claim: it changes no existing port.
 * A negative claim cannot be tested by reading the code, so the fleet fixture
 * below is compared BY HASH before and after — every `data.json` byte-for-byte,
 * every registry pair number-for-number.
 *
 * MUTATION WITNESS: `the apply rewrites no data.json` — put a regeneration loop
 * inside the apply branch and it turns red.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { planPortStartChange, isAllowedNewServicePort } from '../src/helpers/port-policy.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-vault.mjs');

/**
 * A fleet shaped like the real one: 27 vaults, pairs that mostly do NOT respect
 * the +10 gap, six of them running backwards, and every port inside the
 * 27000-27999 thousand the band excludes.
 */
function fleetPairs() {
  const pairs = [];
  for (let i = 0; i < 27; i += 1) {
    const https = 27124 + i * 2;
    // Six backwards pairs, the rest at assorted gaps — never a clean +10.
    const http = i < 6 ? https - 27 - i : https + 3 + (i % 7);
    pairs.push({ https, http });
  }
  return pairs;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('--force-new-port-start', () => {
  let workDir, ref, cfgPath, vaults;

  function makeVault(name, restData) {
    const vaultPath = path.join(workDir, name);
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge']) {
      fs.mkdirSync(path.join(vaultPath, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(vaultPath, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
    }
    fs.writeFileSync(
      path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify(restData, null, 2));
    return vaultPath;
  }

  const restPath = (v) => path.join(v, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-base-'));
    ref = makeVault('.template', { apiKey: 'KEY-ref-DO-NOT-LEAK', port: 27123, insecurePort: 27133 });
    const registry = {};
    vaults = [];
    fleetPairs().forEach((pair, i) => {
      const v = makeVault(`Vault${i}`, {
        apiKey: `KEY-v${i}-DO-NOT-LEAK`,
        port: pair.https,
        insecurePort: pair.http,
        enableInsecureServer: true,
      });
      vaults.push(v);
      registry[v] = { https: pair.https, http: pair.http };
    });
    cfgPath = path.join(workDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      referenceVault: ref,
      portStart: 27181,
      installId: '11111111-2222-4333-8444-555555555555',
      portRegistry: registry,
      vaultNames: { [vaults[0]]: 'a custom name' },
    }, null, 2));
  });

  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfgPath, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
  });
  const readConfig = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const parsePlan = (out) => ({
    base: Number.parseInt((out.match(/new base\s+: (\d+)/) || [])[1], 10),
    seal: (out.match(/approvedPlanSha256: ([0-9a-f]{64})/) || [])[1],
    previous: Number.parseInt((out.match(/previous base\s+: (\d+)/) || [])[1], 10),
  });

  test('--dry-run writes nothing at all — no config, no backup, no state file', () => {
    const before = fs.readFileSync(cfgPath, 'utf8');
    const beforeListing = fs.readdirSync(workDir).sort();

    const r = run(['--force-new-port-start', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);

    assert.equal(fs.readFileSync(cfgPath, 'utf8'), before, 'the config was modified by a dry run');
    assert.deepEqual(fs.readdirSync(workDir).sort(), beforeListing, 'a dry run left a file behind');
  });

  test('the plan states the number of existing ports it changes, and it is zero', () => {
    const r = run(['--force-new-port-start', '--dry-run']);
    assert.match(r.stdout, /EXISTING ports changed\s+: 0/);
    assert.match(r.stdout, /installId\s+: preserved/);
    // The words "future vaults" have to appear, or the operation reads as a
    // fleet-wide renumbering to anyone who has not read the skill.
    assert.match(r.stdout, /FUTURE vaults/i);
  });

  test('the proposed base is inside the band, and both its ports are', () => {
    const { base } = parsePlan(run(['--force-new-port-start', '--dry-run']).stdout);
    assert.ok(isAllowedNewServicePort(base), `${base} is outside the band`);
    assert.ok(isAllowedNewServicePort(base + 10), `${base + 10} is outside the band`);
    assert.notEqual(base, 27181, 'the base being replaced must not be redrawn');
  });

  test('the apply rewrites no data.json — 27 hashes, before and after', () => {
    // ► MUTATION WITNESS: make the apply loop over the vaults and re-patch
    //   their REST settings and this comparison turns red on all 27.
    const before = vaults.map((v) => sha256(restPath(v)));
    const beforeRegistry = readConfig().portRegistry;

    const { base, seal } = parsePlan(run(['--force-new-port-start', '--dry-run']).stdout);
    const r = run(['--force-new-port-start', '--port-start', String(base), '--approved-plan-sha256', seal]);
    assert.equal(r.status, 0, r.stderr);

    const after = vaults.map((v) => sha256(restPath(v)));
    assert.deepEqual(after, before, 'a vault data.json was modified');

    const cfg = readConfig();
    assert.equal(cfg.portStart, base, 'the base was not written');
    assert.deepEqual(cfg.portRegistry, beforeRegistry, 'a registered pair moved');
    assert.equal(cfg.installId, '11111111-2222-4333-8444-555555555555', 'installId changed');
    assert.deepEqual(cfg.vaultNames, { [vaults[0]]: 'a custom name' }, 'a custom name was lost');
  });

  test('the base written is the base that was shown — never redrawn at apply time', () => {
    const { base, seal } = parsePlan(run(['--force-new-port-start', '--dry-run']).stdout);
    const r = run(['--force-new-port-start', '--port-start', String(base), '--approved-plan-sha256', seal]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readConfig().portStart, base);
  });

  test('applying without --port-start is refused, so a redraw cannot slip in', () => {
    const r = run(['--force-new-port-start']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /Refusing to apply without --port-start/);
    assert.equal(readConfig().portStart, 27181);
  });

  test('a concurrent change to the registry invalidates the plan', () => {
    const { base, seal } = parsePlan(run(['--force-new-port-start', '--dry-run']).stdout);

    // Somebody registers a vault between the proposal and the apply.
    const cfg = readConfig();
    cfg.portRegistry[path.join(workDir, 'LateArrival')] = { https: 27500, http: 27510 };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const r = run(['--force-new-port-start', '--port-start', String(base), '--approved-plan-sha256', seal]);
    assert.notEqual(r.status, 0, 'a stale plan was applied');
    assert.match(r.stdout + r.stderr, /drift/i);
    assert.equal(readConfig().portStart, 27181, 'the base moved despite the refusal');
  });

  test('a tampered seal is refused before anything is written', () => {
    const { base } = parsePlan(run(['--force-new-port-start', '--dry-run']).stdout);
    const r = run(['--force-new-port-start', '--port-start', String(base), '--approved-plan-sha256', 'f'.repeat(64)]);
    assert.notEqual(r.status, 0);
    assert.equal(readConfig().portStart, 27181);
  });

  test('a base that is not allowed by the band is refused', () => {
    const r = run(['--force-new-port-start', '--port-start', '27500']);
    assert.notEqual(r.status, 0);
    assert.equal(readConfig().portStart, 27181);
  });

  test('no output ever carries an API key', () => {
    const dry = run(['--force-new-port-start', '--dry-run']);
    const { base, seal } = parsePlan(dry.stdout);
    const apply = run(['--force-new-port-start', '--port-start', String(base), '--approved-plan-sha256', seal]);
    const all = dry.stdout + dry.stderr + apply.stdout + apply.stderr;
    assert.ok(!all.includes('DO-NOT-LEAK'), 'an API key reached the output');
  });
});

describe('planPortStartChange — the pure plan', () => {
  const firstOf = () => 0;

  test('reports zero affected vaults however many are registered', () => {
    const plan = planPortStartChange({ portStart: 27181 }, {
      randomInt: firstOf,
      registeredPaths: ['/a', '/b', '/c'],
    });
    assert.equal(plan.existingPortsChanged, 0);
    assert.deepEqual(plan.affectedVaultIds, []);
    assert.equal(plan.registeredVaultCount, 3);
    assert.equal(plan.installIdPreserved, true);
  });

  test('an explicitly-passed base is validated, not redrawn', () => {
    const plan = planPortStartChange({ portStart: 27181 }, { randomInt: firstOf, nextPortStart: 24000 });
    assert.equal(plan.nextPortStart, 24000);
    assert.deepEqual(plan.issues, []);
  });

  test('an explicit base outside the band is refused', () => {
    const plan = planPortStartChange({ portStart: 27181 }, { randomInt: firstOf, nextPortStart: 27500 });
    assert.equal(plan.nextPortStart, null);
    assert.ok(plan.issues.some((i) => i.kind === 'base-outside-band'));
  });

  test('an explicit base whose partner is now taken is refused', () => {
    const plan = planPortStartChange({ portStart: 27181 }, {
      randomInt: firstOf,
      nextPortStart: 24000,
      reservedPorts: new Set([24010]),
    });
    assert.equal(plan.nextPortStart, null);
    assert.ok(plan.issues.some((i) => i.kind === 'base-now-taken'));
  });

  test('the preconditions do not depend on the order paths were listed in', () => {
    const a = planPortStartChange({ portStart: 27181 }, { randomInt: firstOf, registeredPaths: ['/b', '/a'] });
    const b = planPortStartChange({ portStart: 27181 }, { randomInt: firstOf, registeredPaths: ['/a', '/b'] });
    assert.deepEqual(a.preconditions, b.preconditions);
  });
});
