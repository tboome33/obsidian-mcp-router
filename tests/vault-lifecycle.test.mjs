/**
 * Lot 6 — telling apart the five things that can happen to a vault, before
 * anything is written.
 *
 * MUTATION WITNESSES named in-line:
 *   - comparing keys only against the reference → `a copy of an ORDINARY vault is detected too`
 *   - regenerating on a duplicate UUID          → `a synchronised replica has nothing written to it`
 *   - identifying by path alone                 → `a move keeps its UUID, its ports and its bindings`
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  planVaultRegistration,
  planVaultRelocation,
  planIndependentCopy,
  planOwnershipChange,
  findSharedKeyGroups,
  shortFingerprint,
  FINGERPRINT_LENGTH,
} from '../src/helpers/vault-lifecycle.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-vault.mjs');
const LOCAL = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const OTHER = '11111111-2222-4333-8444-555555555555';
const VAULT_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const INSTALLATION = { installId: LOCAL, hostname: 'ROLAND-PC' };

const digest = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('planVaultRegistration', () => {
  const base = { path: 'C:\\V', exists: true, identityStatus: 'absent', vaultId: null, owner: null, ports: null, keyFingerprint: null };

  test('a brand-new vault is owned by the installation that creates it', () => {
    const plan = planVaultRegistration({ cfg: {}, candidate: base, installation: INSTALLATION, intent: 'create' });
    assert.equal(plan.action, 'create');
    assert.deepEqual(plan.owner, { installId: LOCAL, hostname: 'ROLAND-PC' });
    assert.equal(plan.mayWritePorts, true);
    assert.equal(plan.preservePorts, false);
  });

  test('an existing unclaimed vault is claimed, and KEEPS its ports', () => {
    // The band is a rule for creation. A vault that already has ports has a
    // plaintext number written into click-to-open links; the local policy is
    // never a reason to move it.
    const plan = planVaultRegistration({
      cfg: {},
      candidate: { ...base, identityStatus: 'ok', vaultId: VAULT_A, owner: null },
      installation: INSTALLATION,
    });
    assert.equal(plan.action, 'claim');
    assert.equal(plan.preservePorts, true);
    assert.equal(plan.mayWritePorts, true);
  });

  test('a vault owned by the other installation is registered but never written', () => {
    const plan = planVaultRegistration({
      cfg: {},
      candidate: { ...base, identityStatus: 'ok', vaultId: VAULT_A, owner: { installId: OTHER, hostname: 'SONS-PC' } },
      installation: INSTALLATION,
    });
    assert.equal(plan.action, 'register-foreign');
    assert.equal(plan.mayWritePorts, false);
    assert.equal(plan.preservePorts, true);
    assert.match(plan.warnings[0].message, /SONS-PC/);
    assert.ok(!JSON.stringify(plan.warnings).includes(OTHER), 'a foreign installId leaked');
  });

  test('a damaged identity refuses, and proposes no replacement', () => {
    for (const status of ['invalid', 'unreadable']) {
      const plan = planVaultRegistration({ cfg: {}, candidate: { ...base, identityStatus: status }, installation: INSTALLATION });
      assert.equal(plan.action, 'refuse', status);
      assert.equal(plan.mayWritePorts, false);
    }
  });

  test('binding to a vault that does not exist is refused — a binding never creates one', () => {
    const plan = planVaultRegistration({ cfg: {}, candidate: { ...base, exists: false }, installation: INSTALLATION });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.blockers[0].message, /never creates a vault/);
  });
});

// ---------------------------------------------------------------------------
// Relocation
// ---------------------------------------------------------------------------

describe('planVaultRelocation', () => {
  test('a move keeps its UUID, its ports and its bindings', () => {
    // ► MUTATION WITNESS: identify by path instead of by UUID and a moved vault
    //   reads as a stranger, losing its registration.
    const plan = planVaultRelocation({
      vaultId: VAULT_A,
      previousEntry: { path: 'C:\\OLD' },
      candidate: { path: 'C:\\NEW', vaultId: VAULT_A },
      observations: [{ path: 'C:\\OLD', exists: false, vaultId: null }],
    });
    assert.equal(plan.action, 'relocate');
    assert.equal(plan.portsChanged, 0);
    assert.equal(plan.keyChanged, false);
    assert.equal(plan.ownerChanged, false);
  });

  test('an old path REUSED by a different vault does not inherit the registration', () => {
    const plan = planVaultRelocation({
      vaultId: VAULT_A,
      previousEntry: { path: 'C:\\OLD' },
      candidate: { path: 'C:\\NEW', vaultId: '22222222-3333-4444-8555-666666666666' },
    });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.blockers[0].message, /different identity/);
  });

  test('both directories still present is a question, not a move', () => {
    const plan = planVaultRelocation({
      vaultId: VAULT_A,
      previousEntry: { path: 'C:\\OLD' },
      candidate: { path: 'C:\\NEW', vaultId: VAULT_A },
      observations: [{ path: 'C:\\OLD', exists: true, vaultId: VAULT_A }],
    });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.blockers[0].message, /replica, a stale entry or an independent copy/);
  });

  test('no candidate path means no move — the router does not search the disks', () => {
    const plan = planVaultRelocation({ vaultId: VAULT_A, previousEntry: { path: 'C:\\OLD' }, candidate: null });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.blockers[0].message, /will not pretend/);
  });
});

// ---------------------------------------------------------------------------
// Independent copy
// ---------------------------------------------------------------------------

describe('planIndependentCopy', () => {
  const source = { path: 'C:\\SOURCE', vaultId: VAULT_A };

  test('without explicit consent, nothing happens', () => {
    const plan = planIndependentCopy({ sourceIdentity: source, target: { path: 'C:\\COPY' }, installation: INSTALLATION });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.blockers[0].message, /become independent/);
  });

  test('the source under another spelling is not a copy of itself', () => {
    const plan = planIndependentCopy({
      sourceIdentity: source,
      target: { path: 'C:\\source' },
      installation: INSTALLATION,
      consent: { becomesIndependent: true },
    });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.blockers[0].message, /under another spelling/);
  });

  test('a copy already serving plaintext HTTP is blocked, not renumbered quietly', () => {
    // Invariant I1 reaches here: links may already point at that port, and
    // detaching needs a different one. Two bad outcomes are refused — creating a
    // twin, and breaking links — by refusing the operation instead.
    const plan = planIndependentCopy({
      sourceIdentity: source,
      target: { path: 'C:\\COPY', currentHttpPort: 27145 },
      installation: INSTALLATION,
      consent: { becomesIndependent: true },
    });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.blockers[0].message, /27145/);
  });

  test('with consent, everything changes on the COPY and nothing on the source', () => {
    const plan = planIndependentCopy({
      sourceIdentity: source,
      target: { path: 'C:\\COPY' },
      installation: INSTALLATION,
      consent: { becomesIndependent: true, mayRenumberHttp: true },
    });
    assert.equal(plan.action, 'detach-copy');
    assert.equal(plan.newIdentity, true);
    assert.equal(plan.newKey, true);
    assert.equal(plan.newPorts, true);
    assert.equal(plan.sourceUntouched, true);
    assert.deepEqual(plan.owner, { installId: LOCAL, hostname: 'ROLAND-PC' });
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('planOwnershipChange', () => {
  const identity = (owner) => ({ schemaVersion: 1, vaultId: VAULT_A, owner, createdAt: 'x' });

  test('claiming an unowned vault changes no port', () => {
    const plan = planOwnershipChange({ identity: identity(null), nextOwner: { installId: LOCAL, hostname: 'X' } });
    assert.equal(plan.action, 'claim');
    assert.equal(plan.portsChanged, 0);
    assert.equal(plan.keyChanged, false);
  });

  test('a transfer must be acknowledged, with both parties visible', () => {
    const plan = planOwnershipChange({
      identity: identity({ installId: OTHER, hostname: 'SONS-PC' }),
      nextOwner: { installId: LOCAL, hostname: 'ROLAND-PC' },
    });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.blockers[0].message, /SONS-PC/);

    const acknowledged = planOwnershipChange({
      identity: identity({ installId: OTHER, hostname: 'SONS-PC' }),
      nextOwner: { installId: LOCAL, hostname: 'ROLAND-PC' },
      consent: { transferAcknowledged: true },
    });
    assert.equal(acknowledged.action, 'transfer');
    assert.equal(acknowledged.portsChanged, 0);
  });

  test('an owner that changed since it was read makes the change refuse', () => {
    const plan = planOwnershipChange({
      identity: identity({ installId: OTHER, hostname: 'SONS-PC' }),
      expectedOwner: null,
      nextOwner: { installId: LOCAL, hostname: 'X' },
      consent: { transferAcknowledged: true },
    });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.blockers[0].message, /changed since it was read/);
  });

  test('releasing a vault is a claim of null, and still touches no port', () => {
    const plan = planOwnershipChange({
      identity: identity({ installId: LOCAL, hostname: 'X' }),
      nextOwner: null,
      consent: { transferAcknowledged: true },
    });
    assert.equal(plan.action, 'transfer');
    assert.equal(plan.to, null);
    assert.equal(plan.portsChanged, 0);
  });
});

// ---------------------------------------------------------------------------
// Shared keys
// ---------------------------------------------------------------------------

describe('findSharedKeyGroups', () => {
  test('two vaults on one key are reported', () => {
    const groups = findSharedKeyGroups([
      { path: 'C:\\A', keyFingerprint: digest('same') },
      { path: 'C:\\B', keyFingerprint: digest('same') },
      { path: 'C:\\C', keyFingerprint: digest('different') },
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].paths.sort(), ['C:\\A', 'C:\\B']);
  });

  test('the report says what it is NOT, because all three are tempting', () => {
    const groups = findSharedKeyGroups([
      { path: 'C:\\A', keyFingerprint: digest('same') },
      { path: 'C:\\B', keyFingerprint: digest('same') },
    ]);
    assert.match(groups[0].message, /synchronised replica/i);
    assert.match(groups[0].message, /Nothing was rotated/i);
    assert.match(groups[0].message, /separate UUIDs does not resolve it/i);
  });

  test('two spellings of one directory are one vault, not a shared key', () => {
    const groups = findSharedKeyGroups([
      { path: 'C:\\VAULTS\\X', keyFingerprint: digest('same') },
      { path: 'C:\\vaults\\x', keyFingerprint: digest('same') },
    ]);
    assert.deepEqual(groups, []);
  });

  test('only a truncated digest travels — never a key, never a prefix', () => {
    const groups = findSharedKeyGroups([
      { path: 'C:\\A', keyFingerprint: digest('SECRET-KEY-VALUE') },
      { path: 'C:\\B', keyFingerprint: digest('SECRET-KEY-VALUE') },
    ]);
    assert.equal(groups[0].fingerprint.length, FINGERPRINT_LENGTH);
    assert.ok(!JSON.stringify(groups).includes('SECRET-KEY-VALUE'));
    assert.equal(shortFingerprint(digest('x')).length, FINGERPRINT_LENGTH);
  });

  test('vaults with no key are not grouped together as sharing nothing', () => {
    const groups = findSharedKeyGroups([
      { path: 'C:\\A', keyFingerprint: null },
      { path: 'C:\\B', keyFingerprint: null },
    ]);
    assert.deepEqual(groups, []);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe('the CLI, end to end', () => {
  let workDir, cfgPath, ref;

  function makeVault(name, rest) {
    const v = path.join(workDir, name);
    for (const p of ['obsidian-local-rest-api', 'mcp-router-bridge']) {
      fs.mkdirSync(path.join(v, '.obsidian', 'plugins', p), { recursive: true });
      fs.writeFileSync(path.join(v, '.obsidian', 'plugins', p, 'main.js'), `// ${p}`);
    }
    fs.writeFileSync(
      path.join(v, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify(rest, null, 2));
    return v;
  }
  const identityPath = (v) => path.join(v, '.obsidian', 'obsidian-mcp-router', 'identity.json');
  function stamp(v, owner) {
    fs.mkdirSync(path.dirname(identityPath(v)), { recursive: true });
    fs.writeFileSync(identityPath(v), JSON.stringify({
      schemaVersion: 1, vaultId: VAULT_A, owner, createdAt: '2026-09-09T00:00:00.000Z',
    }, null, 2));
  }

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'));
    cfgPath = path.join(workDir, 'config.json');
    ref = makeVault('.template', { apiKey: 'KEY-ref-DO-NOT-LEAK', port: 27123, insecurePort: 27133 });
  });
  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfgPath, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
  });

  test('a copy of an ORDINARY vault is detected too, not only a copy of the reference', () => {
    // ► MUTATION WITNESS: restrict the key comparison to the reference vault
    //   and this warning disappears — which is the fleet's real twin-vault case,
    //   since copies of ordinary vaults are the common one.
    const shared = 'KEY-ordinary-DO-NOT-LEAK';
    const original = makeVault('Original', { apiKey: shared, port: 27150, insecurePort: 27160 });
    const copy = makeVault('CopyOfOriginal', { apiKey: shared, port: 27151, insecurePort: 27161 });
    fs.writeFileSync(cfgPath, JSON.stringify({
      referenceVault: ref,
      installId: LOCAL,
      portRegistry: { [original]: { https: 27150, http: 27160 } },
      portStart: 27181,
    }, null, 2));

    const r = run([copy]);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /same API key/i, 'the shared credential was not reported');
    assert.match(out, new RegExp(original.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    assert.ok(!out.includes(shared), 'the key itself reached the output');
    // Reported, NOT repaired.
    assert.match(out, /Nothing was rotated/i);
  });

  test('a synchronised replica has nothing written to it', () => {
    // ► MUTATION WITNESS: regenerate on a duplicate identity and this vault's
    //   data.json changes — which breaks the machine it is shared with.
    const replica = makeVault('Replica', { apiKey: 'KEY-replica-DO-NOT-LEAK', port: 27150, insecurePort: 27160 });
    stamp(replica, { installId: OTHER, hostname: 'SONS-PC' });
    const before = fs.readFileSync(path.join(replica, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8');
    fs.writeFileSync(cfgPath, JSON.stringify({ referenceVault: ref, installId: LOCAL, portRegistry: {}, portStart: 27181 }, null, 2));

    const r = run([replica]);
    assert.notEqual(r.status, 0, 'a foreign vault was set up');
    assert.match((r.stdout || '') + (r.stderr || ''), /owned by another installation/i);
    assert.equal(
      fs.readFileSync(path.join(replica, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8'),
      before,
      'a foreign vault\'s data.json was modified',
    );
  });

  test('--vault-owner shows, claims and releases, and moves no port', () => {
    const vault = makeVault('Owned', { apiKey: 'KEY-owned-DO-NOT-LEAK', port: 27150, insecurePort: 27160 });
    stamp(vault, null);
    fs.writeFileSync(cfgPath, JSON.stringify({
      referenceVault: ref, installId: LOCAL, installHostname: 'ROLAND-PC',
      portRegistry: { [vault]: { https: 27150, http: 27160 } }, portStart: 27181,
    }, null, 2));
    const restBefore = fs.readFileSync(path.join(vault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8');

    const shown = run(['--vault-owner', vault, '--show']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /nobody \(unclaimed\)/);

    const claimed = run(['--vault-owner', vault, '--claim']);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(JSON.parse(fs.readFileSync(identityPath(vault), 'utf8')).owner.installId, LOCAL);
    assert.match(claimed.stdout, /0 port changed/);

    const released = run(['--vault-owner', vault, '--release', '--acknowledge-transfer']);
    assert.equal(released.status, 0, released.stderr);
    assert.equal(JSON.parse(fs.readFileSync(identityPath(vault), 'utf8')).owner, null);

    assert.equal(
      fs.readFileSync(path.join(vault, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'), 'utf8'),
      restBefore,
      'an ownership change touched the ports',
    );
  });

  test('--vault-owner refuses to take a vault from another installation unacknowledged', () => {
    const vault = makeVault('Foreign', { apiKey: 'KEY-foreign-DO-NOT-LEAK', port: 27150, insecurePort: 27160 });
    stamp(vault, { installId: OTHER, hostname: 'SONS-PC' });
    fs.writeFileSync(cfgPath, JSON.stringify({
      referenceVault: ref, installId: LOCAL, installHostname: 'ROLAND-PC', portRegistry: {}, portStart: 27181,
    }, null, 2));

    const r = run(['--vault-owner', vault, '--claim']);
    assert.notEqual(r.status, 0);
    const out = r.stdout + r.stderr;
    assert.match(out, /acknowledged explicitly/i);
    assert.match(out, /SONS-PC/);
    assert.ok(!out.includes(OTHER), 'a foreign installId leaked');
    assert.equal(JSON.parse(fs.readFileSync(identityPath(vault), 'utf8')).owner.installId, OTHER);
  });
});
