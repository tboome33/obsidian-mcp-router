/**
 * Lot 5 — keying the registry by a UUID that survives the path changing.
 *
 * The claim this migration makes is almost entirely NEGATIVE: not one port
 * moves, not one key is touched, not one `data.json` is rewritten, not one
 * custom name or workspace binding is lost. Negative claims are not testable by
 * reading code, so the fleet fixture below is compared BY HASH, file by file,
 * before and after — and every reference in the config is looked up again
 * afterwards to prove it still resolves.
 *
 * MUTATION WITNESSES named in-line:
 *   - regenerating UUIDs on a second pass  → `a second migration changes nothing`
 *   - forgetting a workspace reference     → `every reference still resolves`
 *   - applying +10 to historic pairs       → `27 pairs, byte-identical`
 *   - acting on a duplicate UUID           → `a duplicate UUID blocks before any mutation`
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
  buildCanonicalVaultIndex,
  classifyIdentityMatches,
  planRegistryMigration,
  applyPlanToConfig,
  TARGET_SCHEMA_VERSION,
} from '../src/helpers/registry-migration.mjs';
import { registeredVaultPaths, vaultSlug, vaultRecordsOf, isMigratedRegistry } from '../src/helpers/vault-slug.mjs';
import { portEntryOf, setVaultPortEntry } from '../src/helpers/port-registry.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-vault.mjs');
const INSTALL_ID = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

/** 27 pairs shaped like the real fleet: mostly not +10, six running backwards. */
function fleetPairs() {
  const pairs = [];
  for (let i = 0; i < 27; i += 1) {
    const https = 27124 + i * 2;
    const http = i < 6 ? https - 27 - i : https + 3 + (i % 7);
    pairs.push({ https, http });
  }
  return pairs;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('--migrate-vault-identities, on a 27-vault fleet', () => {
  let workDir, cfgPath, vaults, restPaths;

  const restPath = (v) => path.join(v, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json');
  const identityPath = (v) => path.join(v, '.obsidian', 'obsidian-mcp-router', 'identity.json');

  function makeVault(name, rest) {
    const v = path.join(workDir, name);
    fs.mkdirSync(path.join(v, '.obsidian', 'plugins', 'obsidian-local-rest-api'), { recursive: true });
    fs.mkdirSync(path.join(v, '.obsidian', 'plugins', 'mcp-router-bridge'), { recursive: true });
    fs.writeFileSync(restPath(v), JSON.stringify({ apiKey: `KEY-${name}-DO-NOT-LEAK`, ...rest }, null, 2));
    return v;
  }

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-migration-'));
    cfgPath = path.join(workDir, 'config.json');
    vaults = [];
    const portRegistry = {};
    fleetPairs().forEach((pair, i) => {
      const v = makeVault(`Vault${i}`, { port: pair.https, insecurePort: pair.http, enableInsecureServer: true });
      vaults.push(v);
      portRegistry[v] = { https: pair.https, http: pair.http };
    });
    restPaths = vaults.map(restPath);

    fs.writeFileSync(cfgPath, JSON.stringify({
      installId: INSTALL_ID,
      installHostname: 'FIXTURE-PC',
      portStart: 27181,
      portRegistry,
      vaultNames: { [vaults[0]]: 'a custom name', [vaults[3]]: 'another one' },
      defaultVault: 'a custom name',
      openVaults: ['a custom name', 'another one'],
      disabledVaults: [],
      vaultReach: 'declared',
      workspaceBindings: { 'C:\\some\\workspace': { vault: 'a custom name', also: ['another one'] } },
      workspaceBindingsMigration: { done: true },
      referenceVault: vaults[26],
      somethingAFutureVersionAdded: { keep: 'me' },
    }, null, 2));
  });

  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfgPath, OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS: '1' },
  });
  const readConfig = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const sealOf = (out) => (out.match(/approvedPlanSha256: ([0-9a-f]{64})/) || [])[1];

  test('--dry-run writes nothing — no config, no identity, no backup', () => {
    const before = fs.readFileSync(cfgPath, 'utf8');
    const r = run(['--migrate-vault-identities', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);

    assert.equal(fs.readFileSync(cfgPath, 'utf8'), before);
    for (const v of vaults) {
      assert.equal(fs.existsSync(identityPath(v)), false, 'a dry run stamped a vault');
    }
    assert.equal(fs.readdirSync(workDir).filter((f) => f.includes('.bak-')).length, 0);
    assert.match(r.stdout, /data\.json files modified\s*: 0/);
  });

  test('27 pairs, byte-identical, and 27 distinct UUIDs', () => {
    // ► MUTATION WITNESS: apply the +10 convention to the historic pairs and
    //   the hashes below diverge on all 27 — six of these pairs run BACKWARDS.
    const beforeHashes = restPaths.map(sha256);
    const beforePairs = vaults.map((v) => portEntryOf(readConfig(), v));

    const dry = run(['--migrate-vault-identities', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    const r = run(['--migrate-vault-identities', '--approved-plan-sha256', sealOf(dry.stdout)]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

    assert.deepEqual(restPaths.map(sha256), beforeHashes, 'a data.json was modified');

    const cfg = readConfig();
    assert.equal(cfg.schemaVersion, TARGET_SCHEMA_VERSION);
    assert.equal(isMigratedRegistry(cfg), true);
    assert.equal(cfg.portRegistry, undefined, 'the old container survived — that is a second source');

    const records = vaultRecordsOf(cfg);
    assert.equal(records.length, 27);
    assert.equal(new Set(records.map((r2) => r2.vaultId)).size, 27, 'a UUID was reused');

    vaults.forEach((v, i) => {
      const after = portEntryOf(cfg, v);
      assert.deepEqual(after, beforePairs[i], `${v} changed pair`);
    });
  });

  test('every vault carries an identity file, owned by NOBODY', () => {
    const dry = run(['--migrate-vault-identities', '--dry-run']);
    run(['--migrate-vault-identities', '--approved-plan-sha256', sealOf(dry.stdout)]);

    for (const v of vaults) {
      const identity = JSON.parse(fs.readFileSync(identityPath(v), 'utf8'));
      assert.match(identity.vaultId, /^[0-9a-f-]{36}$/i);
      // Decision D4: the migration claims nothing. An owner recorded here would
      // hand this installation the right to rewrite 27 vaults' ports without
      // anyone having said so.
      assert.equal(identity.owner, null, `${v} was claimed by the migration`);
    }
  });

  test('every reference still resolves', () => {
    // ► MUTATION WITNESS: drop `vaultNames` (or any other reference) from the
    //   carried-through config and these look-ups return the path instead.
    const dry = run(['--migrate-vault-identities', '--dry-run']);
    run(['--migrate-vault-identities', '--approved-plan-sha256', sealOf(dry.stdout)]);

    const cfg = readConfig();
    assert.equal(vaultSlug(cfg, vaults[0]), 'a custom name');
    assert.equal(vaultSlug(cfg, vaults[3]), 'another one');
    assert.equal(cfg.defaultVault, 'a custom name');
    assert.deepEqual(cfg.openVaults, ['a custom name', 'another one']);
    assert.deepEqual(cfg.workspaceBindings, { 'C:\\some\\workspace': { vault: 'a custom name', also: ['another one'] } });
    assert.deepEqual(cfg.workspaceBindingsMigration, { done: true });
    assert.equal(cfg.referenceVault, vaults[26]);
    assert.equal(cfg.vaultReach, 'declared');
    assert.equal(cfg.installId, INSTALL_ID);
    assert.equal(cfg.portStart, 27181, 'the historic base moved');
    // A key this version has never heard of must survive too — it may be one a
    // newer router wrote.
    assert.deepEqual(cfg.somethingAFutureVersionAdded, { keep: 'me' });
    assert.deepEqual(registeredVaultPaths(cfg).slice().sort(), vaults.slice().sort());
  });

  test('a second migration changes nothing', () => {
    // ► MUTATION WITNESS: mint fresh UUIDs on the second pass and both the
    //   config and the 27 identity files change.
    const dry = run(['--migrate-vault-identities', '--dry-run']);
    run(['--migrate-vault-identities', '--approved-plan-sha256', sealOf(dry.stdout)]);

    const configAfterFirst = fs.readFileSync(cfgPath, 'utf8');
    const identityHashes = vaults.map((v) => sha256(identityPath(v)));

    const dry2 = run(['--migrate-vault-identities', '--dry-run']);
    assert.equal(dry2.status, 0, dry2.stderr);
    const second = run(['--migrate-vault-identities', '--approved-plan-sha256', sealOf(dry2.stdout)]);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);

    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).vaultsById),
      JSON.stringify(JSON.parse(configAfterFirst).vaultsById), 'the second run changed the records');
    assert.deepEqual(vaults.map((v) => sha256(identityPath(v))), identityHashes, 'an identity was rewritten');
  });

  test('a concurrent change to the config makes the apply refuse', () => {
    const dry = run(['--migrate-vault-identities', '--dry-run']);
    const seal = sealOf(dry.stdout);

    const cfg = readConfig();
    cfg.portRegistry[path.join(workDir, 'LateArrival')] = { https: 27500, http: 27510 };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const r = run(['--migrate-vault-identities', '--approved-plan-sha256', seal]);
    assert.notEqual(r.status, 0, 'a stale plan was applied');
    assert.equal(readConfig().schemaVersion, undefined, 'the config was migrated despite the refusal');
  });

  test('a registered directory that is gone blocks, and migrates nothing', () => {
    const cfg = readConfig();
    cfg.portRegistry[path.join(workDir, 'Vanished')] = { https: 27600, http: 27610 };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const dry = run(['--migrate-vault-identities', '--dry-run']);
    assert.notEqual(dry.status, 0, 'a missing directory did not block');
    assert.match(dry.stdout + dry.stderr, /is registered but is not on this machine/);

    const applied = run(['--migrate-vault-identities']);
    assert.notEqual(applied.status, 0);
    assert.equal(readConfig().schemaVersion, undefined);
    for (const v of vaults) assert.equal(fs.existsSync(identityPath(v)), false, 'a vault was stamped anyway');
  });

  test('a duplicate UUID blocks before any mutation', () => {
    // ► MUTATION WITNESS: treat a duplicate as a copy and regenerate it, and
    //   this stops blocking — which is what would break a synchronised replica.
    const shared = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    for (const v of [vaults[0], vaults[1]]) {
      fs.mkdirSync(path.dirname(identityPath(v)), { recursive: true });
      fs.writeFileSync(identityPath(v), JSON.stringify({
        schemaVersion: 1, vaultId: shared, owner: null, createdAt: '2026-09-09T00:00:00.000Z',
      }, null, 2));
    }
    const beforeHashes = restPaths.map(sha256);

    const dry = run(['--migrate-vault-identities', '--dry-run']);
    assert.notEqual(dry.status, 0, 'a duplicate UUID did not block');
    assert.match(dry.stdout + dry.stderr, /Two directories carry the UUID/);
    assert.match(dry.stdout + dry.stderr, /synchronised replica/);

    const applied = run(['--migrate-vault-identities']);
    assert.notEqual(applied.status, 0);
    assert.equal(readConfig().schemaVersion, undefined);
    assert.deepEqual(restPaths.map(sha256), beforeHashes);
  });

  test('a damaged identity blocks, and is never replaced', () => {
    fs.mkdirSync(path.dirname(identityPath(vaults[5])), { recursive: true });
    fs.writeFileSync(identityPath(vaults[5]), '{ not json at all');

    const dry = run(['--migrate-vault-identities', '--dry-run']);
    assert.notEqual(dry.status, 0);
    assert.match(fs.readFileSync(identityPath(vaults[5]), 'utf8'), /not json at all/);
  });

  test('no output ever carries an API key', () => {
    const dry = run(['--migrate-vault-identities', '--dry-run']);
    const apply = run(['--migrate-vault-identities', '--approved-plan-sha256', sealOf(dry.stdout)]);
    const all = dry.stdout + dry.stderr + apply.stdout + apply.stderr;
    assert.ok(!all.includes('DO-NOT-LEAK'), 'an API key reached the output');
  });

  test('the backup and the journal are left where the report says', () => {
    const dry = run(['--migrate-vault-identities', '--dry-run']);
    const r = run(['--migrate-vault-identities', '--approved-plan-sha256', sealOf(dry.stdout)]);
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(workDir);
    assert.ok(files.some((f) => f.includes('config.json.bak-')), 'no configuration backup was taken');
    assert.ok(files.some((f) => /^\.migration-.+\.journal\.json$/.test(f)), 'no journal was written');
  });
});

// ---------------------------------------------------------------------------
// The pure pieces
// ---------------------------------------------------------------------------

describe('classifyIdentityMatches', () => {
  const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  test('two spellings of ONE directory fold, and do not block', () => {
    const out = classifyIdentityMatches([
      { path: 'C:\\VAULTS\\X', identityStatus: 'ok', vaultId: ID_A, owner: null },
      { path: 'C:\\vaults\\x', identityStatus: 'ok', vaultId: ID_A, owner: null },
    ]);
    assert.equal(out.ambiguousDuplicates.length, 0);
    assert.equal(out.aliases.length, 1);
    assert.equal(out.unique.length, 1);
  });

  test('two REAL directories with one UUID block', () => {
    const out = classifyIdentityMatches([
      { path: 'C:\\VAULTS\\X', identityStatus: 'ok', vaultId: ID_A, owner: null },
      { path: 'C:\\VAULTS\\Y', identityStatus: 'ok', vaultId: ID_A, owner: null },
    ]);
    assert.equal(out.ambiguousDuplicates.length, 1);
    assert.match(out.ambiguousDuplicates[0].message, /replica|move|copy/i);
  });

  test('a UUID the registry knows at another path is a MOVE, not a duplicate', () => {
    const cfg = { vaultsById: { [ID_A]: { path: 'C:\\OLD', ports: { https: 1, http: 2 } } } };
    const out = classifyIdentityMatches(
      [{ path: 'C:\\NEW', identityStatus: 'ok', vaultId: ID_A, owner: null }],
      buildCanonicalVaultIndex(cfg),
    );
    assert.equal(out.moves.length, 1);
    assert.deepEqual(out.moves[0], { vaultId: ID_A, from: 'C:\\OLD', to: 'C:\\NEW' });
    assert.equal(out.ambiguousDuplicates.length, 0);
  });

  test('an unreadable or damaged identity is a conflict, never a candidate', () => {
    const out = classifyIdentityMatches([
      { path: 'C:\\A', identityStatus: 'invalid', vaultId: null, owner: null },
      { path: 'C:\\B', identityStatus: 'unreadable', vaultId: null, owner: null },
    ]);
    assert.equal(out.conflicts.length, 2);
    assert.equal(out.unique.length, 0);
  });
});

describe('applyPlanToConfig', () => {
  test('removes the old container so no second source survives', () => {
    const next = applyPlanToConfig(
      { portRegistry: { '/a': { https: 1, http: 2 } }, vaultNames: { '/a': 'x' } },
      { vaultsById: { 'id-1': { path: '/a', ports: { https: 1, http: 2 }, owner: null } } },
    );
    assert.equal(next.portRegistry, undefined);
    assert.equal(next.schemaVersion, TARGET_SCHEMA_VERSION);
    assert.deepEqual(next.vaultNames, { '/a': 'x' });
  });

  test('the input config is not mutated', () => {
    const cfg = { portRegistry: { '/a': { https: 1, http: 2 } } };
    const frozen = JSON.stringify(cfg);
    applyPlanToConfig(cfg, { vaultsById: {} });
    assert.equal(JSON.stringify(cfg), frozen);
  });
});

describe('an interrupted migration resumes without minting a second UUID', () => {
  let workDir, cfgPath, vaults;
  const identityPath = (v) => path.join(v, '.obsidian', 'obsidian-mcp-router', 'identity.json');

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-resume-'));
    cfgPath = path.join(workDir, 'config.json');
    vaults = [];
    const portRegistry = {};
    for (let i = 0; i < 4; i += 1) {
      const v = path.join(workDir, `V${i}`);
      fs.mkdirSync(path.join(v, '.obsidian'), { recursive: true });
      vaults.push(v);
      portRegistry[v] = { https: 27130 + i, http: 27140 + i };
    }
    fs.writeFileSync(cfgPath, JSON.stringify({ installId: INSTALL_ID, portRegistry }, null, 2));
  });

  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  test('the identities already created are reused, not re-minted', async () => {
    const { observeVaults, applyRegistryMigration, resumeRegistryMigration, journalPathFor } =
      await import('../src/registry-migration-store.mjs');

    const readConfig = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const writeConfig = (cfg) => fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const buildPlan = async ({ transactionId = null } = {}) => planRegistryMigration({
      cfg: readConfig(),
      observations: await observeVaults(registeredVaultPaths(readConfig())),
      installation: { installId: INSTALL_ID, hostname: 'FIXTURE-PC' },
      uuidFactory: () => crypto.randomUUID(),
      transactionId,
    });

    const plan = await buildPlan({});

    // Interrupt in the middle: make the THIRD vault unwritable by putting a
    // damaged identity there, which the store refuses to replace.
    fs.mkdirSync(path.dirname(identityPath(vaults[2])), { recursive: true });
    fs.writeFileSync(identityPath(vaults[2]), '{ damaged');

    await assert.rejects(
      () => applyRegistryMigration(plan, { configPath: cfgPath, readConfig, writeConfig }),
      (err) => err.name === 'MigrationRefusedError',
    );

    // The first two vaults DID get identities, and the config did not move.
    const firstTwo = [identityPath(vaults[0]), identityPath(vaults[1])].map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).vaultId);
    assert.equal(firstTwo.filter(Boolean).length, 2, 'the run stopped before creating anything');
    assert.equal(readConfig().schemaVersion, undefined, 'the config was rewritten despite the failure');

    // Repair the obstacle, then resume with the SAME transaction.
    fs.rmSync(identityPath(vaults[2]));
    const report = await resumeRegistryMigration(plan.transactionId, {
      configPath: cfgPath, readConfig, writeConfig, buildPlan,
    });

    assert.equal(report.migrated, 4);
    // THE ASSERTION THIS TEST EXISTS FOR: the two identities created before the
    // interruption still carry their original UUIDs. A second UUID for a folder
    // that already has one is the single most damaging thing a naive retry
    // could do — the first may already be on the other machine.
    const afterResume = [identityPath(vaults[0]), identityPath(vaults[1])].map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).vaultId);
    assert.deepEqual(afterResume, firstTwo, 'a resumed run re-minted an identity');

    const cfg = readConfig();
    assert.equal(Object.keys(cfg.vaultsById).length, 4);
    assert.ok(Object.keys(cfg.vaultsById).includes(firstTwo[0]), 'the config lost the identity created before the failure');
    assert.equal(fs.existsSync(journalPathFor(cfgPath, plan.transactionId)), true);
  });

  test('resuming a finished transaction is a no-op, not a second migration', async () => {
    const { observeVaults, applyRegistryMigration, resumeRegistryMigration } =
      await import('../src/registry-migration-store.mjs');
    const readConfig = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const writeConfig = (cfg) => fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const plan = planRegistryMigration({
      cfg: readConfig(),
      observations: await observeVaults(registeredVaultPaths(readConfig())),
      installation: { installId: INSTALL_ID, hostname: 'X' },
      uuidFactory: () => crypto.randomUUID(),
    });
    await applyRegistryMigration(plan, { configPath: cfgPath, readConfig, writeConfig });
    const after = fs.readFileSync(cfgPath, 'utf8');

    const report = await resumeRegistryMigration(plan.transactionId, {
      configPath: cfgPath, readConfig, writeConfig, buildPlan: async () => plan,
    });
    assert.equal(report.alreadyFinished, true);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), after);
  });
});

describe('setVaultPortEntry — the writer that follows the schema', () => {
  test('a migrated config gets its record updated, not a resurrected portRegistry', () => {
    const cfg = {
      schemaVersion: 2,
      vaultsById: { 'id-1': { path: '/a', ports: { https: 1, http: 2 }, owner: null } },
    };
    setVaultPortEntry(cfg, '/a', { https: 20000, http: 20010 });
    assert.equal(cfg.portRegistry, undefined, 'the writer resurrected the old container');
    assert.deepEqual(cfg.vaultsById['id-1'].ports, { https: 20000, http: 20010 });
    assert.deepEqual(portEntryOf(cfg, '/a'), { https: 20000, http: 20010 });
  });

  test('a port write is never a claim of ownership', () => {
    const owner = { installId: '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', hostname: 'X' };
    const cfg = { schemaVersion: 2, vaultsById: { 'id-1': { path: '/a', ports: {}, owner } } };
    setVaultPortEntry(cfg, '/a', { https: 20000, http: 20010 });
    assert.deepEqual(cfg.vaultsById['id-1'].owner, owner, 'a port write changed the owner');
  });

  test('an unmigrated config still writes the legacy container', () => {
    const cfg = { portRegistry: {} };
    setVaultPortEntry(cfg, '/a', { https: 20000, http: 20010 });
    assert.deepEqual(cfg.portRegistry['/a'], { https: 20000, http: 20010 });
  });

  test('a hand-mangled legacy container is replaced, not indexed', () => {
    const cfg = { portRegistry: 'AB' };
    setVaultPortEntry(cfg, '/a', { https: 20000, http: 20010 });
    assert.deepEqual(cfg.portRegistry, { '/a': { https: 20000, http: 20010 } });
  });
});
