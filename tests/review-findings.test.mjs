/**
 * The twelve defects the adversarial review of v0.94.0 found, each with a
 * witness that fails if the fix is removed.
 *
 * A fix without a witness is a fix until somebody refactors near it. These are
 * kept in one file, named by the finding, so a later reader can see what was
 * wrong rather than inferring it from an assertion.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { setVaultPortEntry, portEntryOf } from '../src/helpers/port-registry.mjs';
import { planPortStartChange } from '../src/helpers/port-policy.mjs';
import {
  validateVaultIdentity,
  createVaultIdentity,
  sameUuid,
  canonicalUuid,
} from '../src/helpers/vault-identity.mjs';
import { classifyVaultOwnership, OWNERSHIP_VERDICT } from '../src/helpers/vault-ownership.mjs';
import {
  buildCanonicalVaultIndex,
  classifyIdentityMatches,
  planRegistryMigration,
  applyPlanToConfig,
} from '../src/helpers/registry-migration.mjs';
import { writeVaultIdentity, readVaultIdentity, identityPathFor } from '../src/vault-identity-store.mjs';
import { applyRegistryMigration, configRevision } from '../src/registry-migration-store.mjs';
import { classifyVaultReachability, REACHABILITY } from '../src/helpers/vault-reachability.mjs';
import { loadRegistry } from '../src/registry.mjs';

const LOCAL = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const OTHER = '11111111-2222-4333-8444-555555555555';
const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stampIdentity(vaultPath, vaultId, owner = null) {
  const file = identityPathFor(vaultPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, vaultId, owner, createdAt: '2026-09-09T00:00:00.000Z',
  }, null, 2));
}

function makeVault(root, name, rest) {
  const v = path.join(root, name);
  fs.mkdirSync(path.join(v, '.obsidian', 'plugins', 'obsidian-local-rest-api'), { recursive: true });
  fs.writeFileSync(
    path.join(v, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
    JSON.stringify({ apiKey: `KEY-${name}-DO-NOT-LEAK`, enableInsecureServer: true, ...rest }, null, 2),
  );
  return v;
}

// ---------------------------------------------------------------------------

describe('finding 1 — a reused path must not serve another vault under the first one\'s name', () => {
  let dir;
  beforeEach(() => { dir = tmp('finding1-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('the loader refuses to serve a directory whose identity is not the registered one', async () => {
    // A was registered at this path under ID_A. B now sits there, with its own
    // identity, ports and credential. Serving it would hand B's key to anything
    // that asked for A's name — and authentication would CONFIRM it.
    const vault = makeVault(dir, 'Reused', { port: 27150, insecurePort: 27160 });
    stampIdentity(vault, ID_B);
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      schemaVersion: 2,
      installId: LOCAL,
      vaultsById: { [ID_A]: { path: vault, ports: { https: 27150, http: 27160 }, owner: null } },
      vaultNames: { [vault]: 'original' },
    }, null, 2));

    const registry = await loadRegistry({ configPath: cfgPath });
    assert.equal(registry.vaults.find((v) => v.path === vault), undefined, 'a foreign vault was served');
    assert.ok(registry.skipped.some((s) => /identity mismatch/i.test(s.reason)));
    assert.ok(registry.portDiagnostics.some((d) => d.kind === 'identity-mismatch'));
  });

  test('a matching identity is served normally', async () => {
    const vault = makeVault(dir, 'Same', { port: 27150, insecurePort: 27160 });
    stampIdentity(vault, ID_A);
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      schemaVersion: 2,
      installId: LOCAL,
      vaultsById: { [ID_A]: { path: vault, ports: { https: 27150, http: 27160 }, owner: null } },
    }, null, 2));
    const registry = await loadRegistry({ configPath: cfgPath });
    assert.ok(registry.vaults.some((v) => v.path === vault));
  });
});

describe('finding 2 — a duplicate UUID must not displace another directory\'s record', () => {
  test('recording a path under a UUID another directory holds is refused', () => {
    const cfg = {
      schemaVersion: 2,
      vaultsById: { [ID_A]: { path: 'C:\\ORIGINAL', ports: { https: 27150, http: 27160 }, owner: null } },
    };
    assert.throws(
      () => setVaultPortEntry(cfg, 'C:\\COPY', { https: 21000, http: 21010 }, { vaultId: ID_A }),
      /already registered for/,
    );
    assert.equal(cfg.vaultsById[ID_A].path, 'C:\\ORIGINAL', 'the original record was displaced');
  });

  test('the SAME directory under a different spelling is still allowed to update', () => {
    const cfg = {
      schemaVersion: 2,
      vaultsById: { [ID_A]: { path: 'C:\\VAULTS\\X', ports: { https: 27150, http: 27160 }, owner: null } },
    };
    setVaultPortEntry(cfg, 'C:\\vaults\\x', { https: 21000, http: 21010 }, { vaultId: ID_A });
    assert.deepEqual(cfg.vaultsById[ID_A].ports, { https: 21000, http: 21010 });
  });

  test('two UNSTAMPED vaults do not collide on their placeholder keys', () => {
    // The bug the fix nearly introduced: comparing canonical forms with `===`
    // finds `null === null` true, so two placeholder keys would have looked
    // like one identity and refused an ordinary write.
    const cfg = { schemaVersion: 2, vaultsById: {} };
    setVaultPortEntry(cfg, 'C:\\A', { https: 21000, http: 21010 });
    setVaultPortEntry(cfg, 'C:\\B', { https: 21100, http: 21110 });
    assert.equal(Object.keys(cfg.vaultsById).length, 2);
  });
});

describe('findings 3 and 4 — the migration commit must verify what it writes', () => {
  let dir, cfgPath, a, b;
  const readConfig = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const writeConfig = (cfg) => fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  beforeEach(() => {
    dir = tmp('finding34-');
    a = makeVault(dir, 'A', { port: 27150, insecurePort: 27160 });
    b = makeVault(dir, 'B', { port: 27151, insecurePort: 27161 });
    stampIdentity(a, ID_A);
    stampIdentity(b, ID_B);
    cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      installId: LOCAL,
      portRegistry: { [a]: { https: 27150, http: 27160 }, [b]: { https: 27151, http: 27161 } },
    }, null, 2));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const buildPlan = () => planRegistryMigration({
    cfg: readConfig(),
    observations: [
      { path: a, pathExists: true, identityStatus: 'ok', vaultId: ID_A, owner: null },
      { path: b, pathExists: true, identityStatus: 'ok', vaultId: ID_B, owner: null },
    ],
    installation: { installId: LOCAL, hostname: 'X' },
    uuidFactory: () => crypto.randomUUID(),
  });

  test('finding 3 — identities swapped to ONE uuid between plan and commit are refused', async () => {
    const plan = buildPlan();
    // Both files rewritten to the same valid UUID after the plan was approved.
    stampIdentity(a, ID_A);
    stampIdentity(b, ID_A);

    await assert.rejects(
      () => applyRegistryMigration(plan, { configPath: cfgPath, readConfig, writeConfig }),
      (err) => err.name === 'MigrationRefusedError',
    );
    // The old verification collapsed the two into one record and finished.
    assert.equal(readConfig().schemaVersion, undefined, 'the config was rewritten despite the swap');
  });

  test('finding 3 — an identity changed to a DIFFERENT uuid is refused, not adopted', async () => {
    const plan = buildPlan();
    stampIdentity(b, '22222222-3333-4444-8555-666666666666');
    await assert.rejects(
      () => applyRegistryMigration(plan, { configPath: cfgPath, readConfig, writeConfig }),
      /different identity than the approved plan/,
    );
  });

  test('finding 4 — a vault registered while the migration ran is not discarded', async () => {
    const plan = buildPlan();
    const revision = configRevision(readConfig());

    // Another process registers C after the plan was made.
    const cfg = readConfig();
    cfg.portRegistry[path.join(dir, 'C')] = { https: 27152, http: 27162 };
    writeConfig(cfg);

    await assert.rejects(
      () => applyRegistryMigration(plan, {
        configPath: cfgPath, readConfig, writeConfig, expectedConfigRevision: revision,
      }),
      (err) => err.name === 'MigrationRefusedError',
    );
    assert.ok(readConfig().portRegistry[path.join(dir, 'C')], 'the concurrent registration was erased');
  });
});

describe('finding 5 — ifNew must be an exclusive create, not a check then a write', () => {
  let dir;
  beforeEach(() => { dir = tmp('finding5-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('two concurrent creations produce ONE identity, and the loser is told', async () => {
    const one = createVaultIdentity({ randomUUID: () => ID_A, owner: null });
    const two = createVaultIdentity({ randomUUID: () => ID_B, owner: null });

    // Started together, so both pass their absence check before either writes —
    // the exact interleaving the read-then-write version lost.
    const results = await Promise.allSettled([
      writeVaultIdentity(dir, one, { ifNew: true }),
      writeVaultIdentity(dir, two, { ifNew: true }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, 'both writers believed they had created the identity');

    const onDisk = (await readVaultIdentity(dir)).identity.vaultId;
    assert.ok(sameUuid(onDisk, ID_A) || sameUuid(onDisk, ID_B));
    const rejected = results.find((r) => r.status === 'rejected');
    assert.match(rejected.reason.message, /already has an identity|created this vault's identity first/i);
  });
});

describe('finding 6 — the base-change seal must cover the ports, not only the paths', () => {
  test('a changed pair changes the preconditions', () => {
    const paths = ['C:\\A'];
    const before = planPortStartChange({ portStart: 27181 }, {
      randomInt: () => 0, registeredPaths: paths, reservedPorts: new Set([23000, 23010]),
    });
    const after = planPortStartChange({ portStart: 27181 }, {
      randomInt: () => 0, registeredPaths: paths, reservedPorts: new Set([24000, 24010]),
    });
    assert.notDeepEqual(
      before.preconditions,
      after.preconditions,
      'the seal is blind to a pair that moved between the two phases',
    );
  });

  test('an unchanged fleet yields identical preconditions', () => {
    const args = { randomInt: () => 0, registeredPaths: ['C:\\A'], reservedPorts: new Set([23000, 23010]) };
    assert.deepEqual(
      planPortStartChange({ portStart: 27181 }, args).preconditions,
      planPortStartChange({ portStart: 27181 }, args).preconditions,
    );
  });
});

describe('finding 8 — two spellings of one directory must not block a migration', () => {
  test('a LEGACY registry with two spellings of one directory is a warning, not an error', () => {
    // This is where the case actually arises. A migrated registry is keyed by
    // UUID, so two records for one directory carrying ONE identity cannot exist
    // — the key would be the same. The path-keyed registry has no such
    // constraint, and it is the one every unmigrated installation still has.
    const { issues } = buildCanonicalVaultIndex({
      portRegistry: {
        'C:\\VAULTS\\X': { https: 27150, http: 27160 },
        'C:\\vaults\\x': { https: 27150, http: 27160 },
      },
    });
    const issue = issues.find((i) => i.kind === 'redundant-path-spelling');
    assert.ok(issue, 'two spellings of one directory were not recognised as redundant');
    assert.equal(issue.severity, 'warning');
    assert.equal(issues.filter((i) => i.severity === 'error').length, 0, 'a harmless alias blocked the migration');
  });

  test('and the migration is not blocked by it', () => {
    const plan = planRegistryMigration({
      cfg: {
        portRegistry: {
          'C:\\VAULTS\\X': { https: 27150, http: 27160 },
          'C:\\vaults\\x': { https: 27150, http: 27160 },
        },
      },
      observations: [
        { path: 'C:\\VAULTS\\X', pathExists: true, identityStatus: 'ok', vaultId: ID_A, owner: null },
        { path: 'C:\\vaults\\x', pathExists: true, identityStatus: 'ok', vaultId: ID_A, owner: null },
      ],
      installation: { installId: LOCAL, hostname: 'X' },
      uuidFactory: () => crypto.randomUUID(),
    });
    assert.deepEqual(plan.blockers, [], `an alias blocked the migration: ${JSON.stringify(plan.blockers)}`);
  });

  test('DISAGREEING spellings are still an error — nothing is chosen between them', () => {
    const { issues } = buildCanonicalVaultIndex({
      schemaVersion: 2,
      vaultsById: {
        [ID_A]: { path: 'C:\\VAULTS\\X', ports: { https: 27150, http: 27160 }, owner: null },
        [ID_B]: { path: 'C:\\vaults\\x', ports: { https: 21000, http: 21010 }, owner: null },
      },
    });
    assert.ok(issues.some((i) => i.kind === 'duplicate-path' && i.severity === 'error'));
  });
});

describe('finding 9 — a port that is not a port is a configuration problem', () => {
  test('an invalid configured port does not earn "open Obsidian"', () => {
    const out = classifyVaultReachability({
      endpointState: {
        effectivePorts: { https: 27124, http: 27134 },
        registeredPorts: { https: 27124, http: 27134 },
        httpsSource: 'registry',
        httpEnabled: true,
        issues: [{ kind: 'invalid-port', severity: 'error', protocol: 'https', message: 'x' }],
      },
      probeResult: { answered: false },
      name: 'X',
    });
    assert.equal(out.status, REACHABILITY.CONFIG_UNREADABLE);
    assert.equal(out.suggestedActions.filter((a) => a.kind === 'open-obsidian').length, 0);
  });
});

describe('finding 10 — a re-migration must not drop nested unknown fields', () => {
  test('a field inside an existing record survives', () => {
    const cfg = {
      schemaVersion: 2,
      installId: LOCAL,
      vaultsById: {
        [ID_A]: {
          path: 'C:\\A',
          ports: { https: 27150, http: 27160 },
          owner: null,
          routingPolicy: { written: 'by a newer router' },
        },
      },
    };
    const plan = planRegistryMigration({
      cfg,
      observations: [{ path: 'C:\\A', pathExists: true, identityStatus: 'ok', vaultId: ID_A, owner: null }],
      installation: { installId: LOCAL, hostname: 'X' },
      uuidFactory: () => crypto.randomUUID(),
    });
    const next = applyPlanToConfig(cfg, plan);
    assert.deepEqual(
      next.vaultsById[ID_A].routingPolicy,
      { written: 'by a newer router' },
      'a nested extension was dropped by a re-migration',
    );
    assert.equal(next.vaultsById[ID_A].extra, undefined, 'the internal carrier leaked into the config');
  });
});

describe('finding 11 — UUIDs compare case-insensitively, as RFC 4122 says', () => {
  test('an owner written in upper case is still this installation', () => {
    const { verdict } = classifyVaultOwnership({
      identity: { schemaVersion: 1, vaultId: ID_A, owner: { installId: LOCAL.toUpperCase(), hostname: 'X' } },
      installId: LOCAL,
    });
    assert.equal(verdict, OWNERSHIP_VERDICT.OWNED, 'an installation was made foreign to itself by letter case');
  });

  test('two case variants of one vault UUID are ONE duplicate, not two groups', () => {
    const out = classifyIdentityMatches([
      { path: 'C:\\A', identityStatus: 'ok', vaultId: ID_A, owner: null },
      { path: 'C:\\B', identityStatus: 'ok', vaultId: ID_A.toUpperCase(), owner: null },
    ]);
    assert.equal(out.ambiguousDuplicates.length, 1, 'a case-variant duplicate walked past detection');
  });

  test('sameUuid refuses to call two non-identifiers equal', () => {
    assert.equal(sameUuid('not-a-uuid', 'not-a-uuid'), false);
    assert.equal(sameUuid(null, null), false);
    assert.equal(canonicalUuid('nope'), null);
  });
});

// ---------------------------------------------------------------------------
// Round 2 — the defects the REPAIRS introduced
// ---------------------------------------------------------------------------

describe('round 2, finding 1 — a failed exclusive create must leave no file behind', () => {
  let dir;
  beforeEach(() => { dir = tmp('r2f1-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('an identity that cannot be serialized never creates the file', async () => {
    // The first version created the file and serialized afterwards, so a
    // failure in between left an EMPTY file — which then made every later
    // exclusive creation fail with EEXIST. A vault stuck forever with a
    // zero-byte identity nothing would replace.
    const circular = { schemaVersion: 1, vaultId: ID_A, owner: null, createdAt: 'x' };
    circular.loop = circular; // JSON.stringify throws on this
    await assert.rejects(() => writeVaultIdentity(dir, circular, { ifNew: true }));
    assert.equal(fs.existsSync(identityPathFor(dir)), false, 'an empty identity file was left behind');
  });

  test('a successful create leaves a complete, re-readable file', async () => {
    const identity = createVaultIdentity({ randomUUID: () => ID_A, owner: null });
    await writeVaultIdentity(dir, identity, { ifNew: true });
    const back = await readVaultIdentity(dir);
    assert.equal(back.status, 'ok');
    assert.equal(back.identity.vaultId, ID_A);
  });
});

describe('round 2, finding 2 — an unstamped placeholder is not an expected UUID', () => {
  let dir;
  beforeEach(() => { dir = tmp('r2f2-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a vault recorded under a placeholder key is still served once it is stamped', async () => {
    // `setVaultPortEntry` records a vault it cannot name yet under
    // `unstamped:<path>`. That key is truthy, and `sameUuid(realUuid,
    // placeholder)` is false — so the identity-mismatch guard would have
    // refused to serve a vault whose record never held a UUID to mismatch.
    const vault = makeVault(dir, 'Unstamped', { port: 27150, insecurePort: 27160 });
    stampIdentity(vault, ID_A);
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      schemaVersion: 2,
      installId: LOCAL,
      vaultsById: {
        'unstamped:c:\\\\whatever': { path: vault, ports: { https: 27150, http: 27160 }, owner: null },
      },
    }, null, 2));

    const registry = await loadRegistry({ configPath: cfgPath });
    assert.ok(registry.vaults.some((v) => v.path === vault), 'a placeholder key was read as a mismatch');
    assert.equal(registry.portDiagnostics.filter((d) => d.kind === 'identity-mismatch').length, 0);
  });
});

describe('round 2, finding 3 — a disagreeing legacy alias must not pass as redundant', () => {
  test('two spellings with DIFFERENT ports are an error, not a warning', () => {
    const { issues } = buildCanonicalVaultIndex({
      portRegistry: {
        'C:\\VAULTS\\X': { https: 27150, http: 27160 },
        'C:\\vaults\\x': { https: 21000, http: 21010 },
      },
    });
    const issue = issues.find((i) => i.kind === 'duplicate-path');
    assert.ok(issue, 'a disagreeing legacy alias slipped through as redundancy');
    assert.equal(issue.severity, 'error');
    assert.match(issue.message, /DISAGREE/);
  });

  test('two migrated records with different OWNERS do not read as agreeing', () => {
    const { issues } = buildCanonicalVaultIndex({
      schemaVersion: 2,
      vaultsById: {
        [ID_A]: { path: 'C:\\VAULTS\\X', ports: { https: 27150, http: 27160 }, owner: { installId: LOCAL } },
        [ID_B]: { path: 'C:\\vaults\\x', ports: { https: 27150, http: 27160 }, owner: { installId: OTHER } },
      },
    });
    assert.ok(issues.some((i) => i.severity === 'error'));
  });
});

describe('round 2, finding 4 — a record legitimately named `extra` must survive', () => {
  test('a field called `extra` is data, not the carrier', () => {
    const cfg = {
      schemaVersion: 2,
      installId: LOCAL,
      vaultsById: {
        [ID_A]: {
          path: 'C:\\A',
          ports: { https: 27150, http: 27160 },
          owner: null,
          extra: { futureFlag: true },
        },
      },
    };
    const plan = planRegistryMigration({
      cfg,
      observations: [{ path: 'C:\\A', pathExists: true, identityStatus: 'ok', vaultId: ID_A, owner: null }],
      installation: { installId: LOCAL, hostname: 'X' },
      uuidFactory: () => crypto.randomUUID(),
    });
    const next = applyPlanToConfig(cfg, plan);
    assert.deepEqual(
      next.vaultsById[ID_A].extra,
      { futureFlag: true },
      'a field named `extra` was unwrapped as if it were the carrier',
    );
    assert.equal(next.vaultsById[ID_A].futureFlag, undefined, 'its contents leaked up a level');
  });

  test('the carrier never reaches the written configuration', () => {
    const cfg = {
      schemaVersion: 2,
      installId: LOCAL,
      vaultsById: { [ID_A]: { path: 'C:\\A', ports: { https: 27150, http: 27160 }, owner: null, newerField: 7 } },
    };
    const plan = planRegistryMigration({
      cfg,
      observations: [{ path: 'C:\\A', pathExists: true, identityStatus: 'ok', vaultId: ID_A, owner: null }],
      installation: { installId: LOCAL, hostname: 'X' },
      uuidFactory: () => crypto.randomUUID(),
    });
    const written = JSON.parse(JSON.stringify(applyPlanToConfig(cfg, plan)));
    assert.equal(written.vaultsById[ID_A].newerField, 7, 'a top-level extension was dropped');
    assert.deepEqual(
      Object.keys(written.vaultsById[ID_A]).sort(),
      ['newerField', 'owner', 'path', 'ports'],
      'the record gained a field it should not have',
    );
  });
});

describe('round 2, candidate — a case-variant UUID must update, not duplicate', () => {
  test('the existing key wins for the same directory', () => {
    const cfg = {
      schemaVersion: 2,
      vaultsById: { [ID_A]: { path: 'C:\\A', ports: { https: 27150, http: 27160 }, owner: null, keepMe: 1 } },
    };
    setVaultPortEntry(cfg, 'C:\\A', { https: 21000, http: 21010 }, { vaultId: ID_A.toUpperCase() });
    assert.equal(Object.keys(cfg.vaultsById).length, 1, 'a second record was created for one directory');
    assert.deepEqual(cfg.vaultsById[ID_A].ports, { https: 21000, http: 21010 });
    assert.equal(cfg.vaultsById[ID_A].keepMe, 1, 'the preserved extension was lost');
  });
});

// ---------------------------------------------------------------------------
// Round 3 — the defects round 2's repairs introduced
// ---------------------------------------------------------------------------

describe('round 3, finding 1 — creation never touches the destination path', () => {
  let dir;
  beforeEach(() => { dir = tmp('r3f1-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('an identity that appears while we are writing is NOT deleted', async () => {
    // The previous repair opened the destination with `wx` and removed it if
    // the write failed — but exclusive creation owns an inode, not a pathname,
    // so a file another process had put there in between was the one deleted.
    // Publication is now by `link()` from a staging file, so the destination is
    // never opened, written or removed by this branch at all.
    const file = identityPathFor(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, vaultId: ID_B, owner: null, createdAt: 'someone else wrote this',
    }, null, 2));

    const mine = createVaultIdentity({ randomUUID: () => ID_A, owner: null });
    await assert.rejects(() => writeVaultIdentity(dir, mine, { ifNew: true }));

    assert.equal(fs.existsSync(file), true, 'another writer\'s identity was deleted');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).vaultId, ID_B, 'it was overwritten');
  });

  test('no staging file is left behind, on success or on refusal', async () => {
    const identity = createVaultIdentity({ randomUUID: () => ID_A, owner: null });
    await writeVaultIdentity(dir, identity, { ifNew: true });
    await assert.rejects(() => writeVaultIdentity(dir, identity, { ifNew: true }));

    const leftovers = fs.readdirSync(path.dirname(identityPathFor(dir))).filter((f) => f.includes('.new-'));
    assert.deepEqual(leftovers, [], `staging files left behind: ${leftovers.join(', ')}`);
  });
});

describe('round 3, finding 2 — a plan record is JSON, all the way through', () => {
  test('extensions survive a JSON round trip of the plan', () => {
    // The Symbol carrier was invisible to `JSON.stringify`, so the plan's SEAL
    // could not see it and the journal's round trip destroyed it — after which
    // the writer, which had been taught to read the carrier as authoritative,
    // dropped the extensions entirely. There is no carrier now.
    const cfg = {
      schemaVersion: 2,
      installId: LOCAL,
      vaultsById: { [ID_A]: { path: 'C:\\A', ports: { https: 27150, http: 27160 }, owner: null, futureFlag: true } },
    };
    const plan = planRegistryMigration({
      cfg,
      observations: [{ path: 'C:\\A', pathExists: true, identityStatus: 'ok', vaultId: ID_A, owner: null }],
      installation: { installId: LOCAL, hostname: 'X' },
      uuidFactory: () => crypto.randomUUID(),
    });
    const roundTripped = JSON.parse(JSON.stringify(plan));
    const next = applyPlanToConfig(cfg, roundTripped);
    assert.equal(next.vaultsById[ID_A].futureFlag, true, 'an extension did not survive the journal');
  });

  test('two plans that serialize identically write identical records', () => {
    const build = () => planRegistryMigration({
      cfg: {
        schemaVersion: 2,
        installId: LOCAL,
        vaultsById: { [ID_A]: { path: 'C:\\A', ports: { https: 27150, http: 27160 }, owner: null, f: 1 } },
      },
      observations: [{ path: 'C:\\A', pathExists: true, identityStatus: 'ok', vaultId: ID_A, owner: null }],
      installation: { installId: LOCAL, hostname: 'X' },
      uuidFactory: () => ID_B,
      transactionId: 'fixed',
      now: () => new Date('2026-09-09T00:00:00.000Z'),
    });
    const a = build();
    const b = build();
    assert.equal(JSON.stringify(a.vaultsById), JSON.stringify(b.vaultsById));
    assert.deepEqual(
      applyPlanToConfig({}, a).vaultsById,
      applyPlanToConfig({}, b).vaultsById,
      'identical serialized plans wrote different records',
    );
  });
});

describe('round 3, finding 3 — an exact path match wins over a folded one', () => {
  test('the record whose path matches exactly is the one updated', () => {
    const cfg = {
      schemaVersion: 2,
      vaultsById: {
        [ID_A]: { path: 'C:\\VAULTS\\X', ports: { https: 27150, http: 27160 }, owner: null, mark: 'first' },
        [ID_A.toUpperCase()]: { path: 'C:\\vaults\\x', ports: { https: 27151, http: 27161 }, owner: null, mark: 'second' },
      },
    };
    setVaultPortEntry(cfg, 'C:\\vaults\\x', { https: 21000, http: 21010 }, { vaultId: ID_A.toUpperCase() });
    assert.deepEqual(
      cfg.vaultsById[ID_A.toUpperCase()].ports,
      { https: 21000, http: 21010 },
      'the write landed on the wrong record, chosen by insertion order',
    );
    assert.equal(cfg.vaultsById[ID_A].mark, 'first', 'the other record was modified');
  });

  test('two folded records and no exact match is a refusal, not a coin toss', () => {
    const cfg = {
      schemaVersion: 2,
      vaultsById: {
        [ID_A]: { path: 'C:\\VAULTS\\X', ports: {}, owner: null },
        [ID_B]: { path: 'C:\\Vaults\\X', ports: {}, owner: null },
      },
    };
    assert.throws(
      () => setVaultPortEntry(cfg, 'C:\\vaults\\x', { https: 21000, http: 21010 }),
      /none of them matches it exactly/,
    );
  });
});

describe('round 3, finding 4 — key order is not a conflict', () => {
  test('extensions that differ only in insertion order still agree', () => {
    const { issues } = buildCanonicalVaultIndex({
      schemaVersion: 2,
      vaultsById: {
        [ID_A]: { path: 'C:\\VAULTS\\X', ports: { https: 27150, http: 27160 }, owner: null, alpha: 1, beta: 2 },
        [ID_B]: { path: 'C:\\vaults\\x', ports: { https: 27150, http: 27160 }, owner: null, beta: 2, alpha: 1 },
      },
    });
    // The identities differ here, so this is still a conflict — what must NOT
    // happen is the conflict being caused by key order. Use one identity:
    const same = buildCanonicalVaultIndex({
      schemaVersion: 2,
      vaultsById: {
        [ID_A]: { path: 'C:\\VAULTS\\X', ports: { https: 27150, http: 27160 }, owner: null, alpha: 1, beta: 2 },
        [ID_A.toUpperCase()]: { path: 'C:\\vaults\\x', ports: { https: 27150, http: 27160 }, owner: null, beta: 2, alpha: 1 },
      },
    });
    assert.ok(
      same.issues.some((i) => i.kind === 'redundant-path-spelling'),
      'insertion order alone turned agreeing records into a blocking conflict',
    );
    assert.equal(same.issues.filter((i) => i.severity === 'error').length, 0);
    assert.ok(issues.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Round 4 — the defects round 3's repairs introduced
// ---------------------------------------------------------------------------

describe('round 4, finding 1 — a staging file this call did not create is not ours to delete', () => {
  let dir;
  beforeEach(() => { dir = tmp('r4f1-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a colliding staging name is left alone', async () => {
    // The random suffix makes a collision unlikely, not impossible — and the
    // cleanup ran in a `finally` that did not know whether this call had
    // created the file. Ownership now comes from the `open('wx')` succeeding.
    // Simulated by making the staging directory hold a file we did not write:
    // we cannot force the exact name, so this asserts the general property that
    // an unrelated file in the directory survives a failed creation.
    const file = identityPathFor(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bystander = path.join(path.dirname(file), 'identity.json.new-someone-else');
    fs.writeFileSync(bystander, 'another invocation was here');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, vaultId: ID_B, owner: null }, null, 2));

    await assert.rejects(
      () => writeVaultIdentity(dir, createVaultIdentity({ randomUUID: () => ID_A, owner: null }), { ifNew: true }),
    );
    assert.equal(fs.readFileSync(bystander, 'utf8'), 'another invocation was here');
  });

  test('a successful creation reports no leftover', async () => {
    const out = await writeVaultIdentity(
      dir, createVaultIdentity({ randomUUID: () => ID_A, owner: null }), { ifNew: true },
    );
    assert.equal(out.created, true);
    assert.equal(out.stagingLeftBehind, null, 'a leftover was reported on a clean run');
    assert.equal((await readVaultIdentity(dir)).identity.vaultId, ID_A);
  });
});

describe('round 4, finding 2 — the comparator must not crash where the old one worked', () => {
  test('deeply nested extensions compare without a stack overflow', () => {
    let a = {}; let b = {};
    for (let i = 0; i < 3000; i += 1) { a = { x: a }; b = { x: b }; }
    // The recursive version threw RangeError here; JSON.stringify, which it
    // replaced, did not. A comparison that crashes is a worse answer than one
    // that is occasionally too strict.
    assert.doesNotThrow(() => buildCanonicalVaultIndex({
      schemaVersion: 2,
      vaultsById: {
        [ID_A]: { path: 'C:\\VAULTS\\X', ports: { https: 1, http: 2 }, owner: null, deep: a },
        [ID_B]: { path: 'C:\\vaults\\x', ports: { https: 1, http: 2 }, owner: null, deep: b },
      },
    }));
  });

  test('array order still matters, and key order still does not', () => {
    const withExtras = (first, second) => buildCanonicalVaultIndex({
      schemaVersion: 2,
      vaultsById: {
        [ID_A]: { path: 'C:\\VAULTS\\X', ports: { https: 1, http: 2 }, owner: null, ...first },
        [ID_A.toUpperCase()]: { path: 'C:\\vaults\\x', ports: { https: 1, http: 2 }, owner: null, ...second },
      },
    }).issues;

    assert.ok(
      withExtras({ alpha: 1, beta: 2 }, { beta: 2, alpha: 1 }).some((i) => i.kind === 'redundant-path-spelling'),
      'key order was treated as a difference',
    );
    assert.ok(
      withExtras({ list: [1, 2] }, { list: [2, 1] }).some((i) => i.severity === 'error'),
      'array order was ignored, which changes meaning',
    );
  });
});

// ---------------------------------------------------------------------------
// Round 5 — a caller that swallowed the new refusal
// ---------------------------------------------------------------------------

describe('round 5, finding 1 — --init-reference must not swallow a reservation refusal', () => {
  test('the catch wraps only the read, so a refusal aborts instead of saving without it', () => {
    // `setVaultPortEntry` could not fail when this `try` was written, so
    // wrapping the reservation in it was harmless. The moment the setter gained
    // its refusals, the same `catch {}` silently skipped the reservation that
    // keeps bootstrapped vaults off the reference's ports — and `saveConfig`
    // persisted everything else. A source check, because the defect is the
    // SHAPE of the block, not a value it produces.
    const source = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'scripts', 'setup-vault.mjs'),
      'utf8',
    );
    const start = source.indexOf('Reserve the reference vault\'s current port');
    assert.notEqual(start, -1, 'the reference reservation block was renamed — update this test');
    // ANCHORED ON THE CODE, not on a byte distance. A first version sliced a
    // fixed 1800 characters after the marker, and adding four lines of comment
    // pushed the setter out of the window — the test then failed for a reason
    // that had nothing to do with what it protects. A window that a comment can
    // break is a window that will break.
    const setterAt = source.indexOf('setVaultPortEntry(cfg, abs', start);
    assert.notEqual(setterAt, -1, 'the reservation no longer calls the setter');

    // Between the marker and the setter call, every `try {` must already have
    // been closed by a `} catch` — otherwise the setter sits inside a catch
    // that would swallow its refusal.
    const beforeSetter = source.slice(start, setterAt);
    const opens = (beforeSetter.match(/\btry\s*\{/g) || []).length;
    const closes = (beforeSetter.match(/\}\s*catch/g) || []).length;
    assert.equal(opens, closes, 'the reservation is still inside a try/catch that would swallow its refusal');
  });
});

// ---------------------------------------------------------------------------
// Penetration test — the two probes that broke, kept as regressions
// ---------------------------------------------------------------------------

describe('pen test A5 — an identity from a NEWER format is never overwritten', () => {
  let dir;
  beforeEach(() => { dir = tmp('pen-a5-'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a matching revision does not authorise replacing a future schema', async () => {
    // The documentation promised this in as many words, and the code did the
    // opposite: `validateVaultIdentity` refuses a future version, so the file
    // arrives at the replace path as "invalid" WITH a perfectly matching
    // revision — and was cheerfully overwritten, destroying whatever a newer
    // router had recorded. Neither the design review nor five rounds of
    // repair-review found it; the penetration test did, by trying it.
    const file = identityPathFor(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, vaultId: ID_A, owner: null }, null, 2));
    const before = fs.readFileSync(file, 'utf8');

    const read = await readVaultIdentity(dir);
    assert.equal(read.status, 'invalid');
    await assert.rejects(
      () => writeVaultIdentity(dir, createVaultIdentity({ randomUUID: () => ID_B, owner: null }), {
        expectedRevision: read.revision,
      }),
      (err) => err.kind === 'identity-future-schema',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a newer format was overwritten');
  });
});

describe('pen test F1 — a fingerprint helper must verify it was given a fingerprint', () => {
  test('a raw key handed in as a fingerprint is never partly printed', async () => {
    // Invariant I3 forbids a key PREFIX by name. The helper sliced whatever
    // string it received, so a caller passing a raw key by mistake published
    // twelve characters of it. A function whose purpose is to make a value safe
    // to print must not assume the caller already did that.
    const { findSharedKeyGroups, shortFingerprint } = await import('../src/helpers/vault-lifecycle.mjs');
    const KEY = 'SUPER-SECRET-KEY-0123456789';
    const groups = findSharedKeyGroups([
      { path: 'C:\\A', keyFingerprint: KEY },
      { path: 'C:\\B', keyFingerprint: KEY },
    ]);
    assert.equal(groups.length, 1, 'the shared-credential fact must still be reported');
    const text = JSON.stringify(groups);
    assert.ok(!text.includes(KEY.slice(0, 8)), 'a prefix of the key reached the message');
    assert.equal(shortFingerprint(KEY), null);
    // A genuine digest still shortens.
    const digest = crypto.createHash('sha256').update('x').digest('hex');
    assert.equal(shortFingerprint(digest), digest.slice(0, 12));
  });
});

describe('finding 12 — an identity may not carry a credential, a port or a path', () => {
  test('each forbidden field makes the identity invalid', () => {
    const base = { schemaVersion: 1, vaultId: ID_A, owner: null, createdAt: 'x' };
    for (const field of ['apiKey', 'port', 'insecurePort', 'absolutePath', 'path']) {
      const { valid, issues } = validateVaultIdentity({ ...base, [field]: 'x' });
      assert.equal(valid, false, `${field} was accepted`);
      assert.ok(issues.some((i) => i.kind === 'identity-forbidden-field'), field);
    }
  });

  test('a genuinely unknown field is still preserved', () => {
    const { valid, identity } = validateVaultIdentity({
      schemaVersion: 1, vaultId: ID_A, owner: null, createdAt: 'x', somethingNewer: 1,
    });
    assert.equal(valid, true);
    assert.equal(identity.somethingNewer, 1);
  });

  test('the store refuses to write one', async () => {
    const dir = tmp('finding12-');
    try {
      await assert.rejects(
        () => writeVaultIdentity(dir, { schemaVersion: 1, vaultId: ID_A, owner: null, apiKey: 'S' }, { ifNew: true }),
        TypeError,
      );
      assert.equal(fs.existsSync(identityPathFor(dir)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
