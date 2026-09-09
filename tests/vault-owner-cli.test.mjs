/**
 * `--vault-owner` end to end, through the actual CLI process — not just the
 * pure helpers it calls (planOwnershipChange, classifyVaultOwnership, ...),
 * which tests/vault-ownership.test.mjs already covers in isolation.
 *
 * This file exists because the CLI branch itself (setup-vault.mjs, the
 * `args[0] === '--vault-owner'` block) had NO test spawning the script until
 * now. That gap is exactly how a real installation — 27 vaults already
 * migrated, no vault provisioned since v0.94.0 shipped, so
 * ensureInstallationIdentity() had never run — reached `--claim` with no
 * `installId` of its own and got refused outright.
 *
 * MUTATION WITNESS: restore the original refusal (`if (!releasing &&
 * !localOwner) fail(...)`) without the bootstrap call, and "claiming with no
 * prior installId succeeds" turns red.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-vault.mjs');

describe('--vault-owner', () => {
  let workDir, vaultPath, cfgPath;

  function writeIdentity(owner) {
    const dir = path.join(vaultPath, '.obsidian', 'obsidian-mcp-router');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({
      schemaVersion: 1,
      vaultId: '72717814-8537-423c-92ed-d94f27da6fba',
      owner,
      createdAt: '2026-09-09T17:50:56.498Z',
    }, null, 2));
  }

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-owner-cli-'));
    vaultPath = path.join(workDir, 'Vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    writeIdentity(null);
    cfgPath = path.join(workDir, 'config.json');
    // No installId, no portStart — the exact shape of an already-migrated
    // fleet whose installation has never run setupVault() since v0.94.0.
    fs.writeFileSync(cfgPath, JSON.stringify({
      portStart: 27181,
      vaultsById: {
        '72717814-8537-423c-92ed-d94f27da6fba': { path: vaultPath, ports: { https: 27132, http: 27163 }, owner: null },
      },
    }, null, 2));
  });

  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfgPath, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
  });
  const readConfig = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const readIdentity = () => JSON.parse(fs.readFileSync(path.join(vaultPath, '.obsidian', 'obsidian-mcp-router', 'identity.json'), 'utf8'));

  test('--show on an unclaimed vault reports "unclaimed" and writes nothing', () => {
    const before = fs.readFileSync(cfgPath, 'utf8');
    const r = run(['--vault-owner', vaultPath, '--show']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /unclaimed/);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), before, '--show must not write the config');
  });

  test('claiming with no prior installId succeeds — the installation is bootstrapped, not refused', () => {
    assert.equal(readConfig().installId, undefined, 'fixture must start with no installId');

    const r = run(['--vault-owner', vaultPath, '--claim']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Claimed/);

    const cfg = readConfig();
    assert.ok(cfg.installId, 'ensureInstallationIdentity should have drawn an installId');
    assert.equal(cfg.portStart, 27181, 'an existing portStart must never be redrawn by a claim');

    const identity = readIdentity();
    assert.equal(identity.owner.installId, cfg.installId);
    assert.equal(identity.createdAt, '2026-09-09T17:50:56.498Z', 'claiming must not touch createdAt');
  });

  test('a second claim by the same installation is a no-op transfer, refused without --acknowledge-transfer, and does not redraw installId either way', () => {
    const first = run(['--vault-owner', vaultPath, '--claim']);
    assert.equal(first.status, 0, first.stderr);
    const installIdAfterFirst = readConfig().installId;

    // planOwnershipChange treats ANY already-owned vault as a transfer needing
    // explicit ack, even when the new owner equals the old one — pre-existing,
    // intentional behaviour this fix does not touch.
    const unacknowledged = run(['--vault-owner', vaultPath, '--claim']);
    assert.notEqual(unacknowledged.status, 0);
    assert.equal(readConfig().installId, installIdAfterFirst, 'a refused re-claim must not redraw the installId');

    const acknowledged = run(['--vault-owner', vaultPath, '--claim', '--acknowledge-transfer']);
    assert.equal(acknowledged.status, 0, acknowledged.stderr);
    assert.equal(readConfig().installId, installIdAfterFirst, 'an acknowledged re-claim by the same installation must not redraw the installId');
    assert.equal(readIdentity().owner.installId, installIdAfterFirst);
  });

  test('a damaged identity is never claimed — the CLI refuses before touching the installation', () => {
    fs.writeFileSync(
      path.join(vaultPath, '.obsidian', 'obsidian-mcp-router', 'identity.json'),
      '{ not json',
    );
    const r = run(['--vault-owner', vaultPath, '--claim']);
    assert.notEqual(r.status, 0);
    assert.equal(readConfig().installId, undefined, 'a refused claim must not bootstrap an installation identity either');
  });
});
