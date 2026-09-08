/**
 * Lot 4 — a vault's durable identity, and the guard that decides who may
 * rewrite its ports.
 *
 * Two layers, and the second is the one that matters most here:
 *
 *   1. The MATRIX the specification makes mandatory — five ownership states,
 *      including the two crossed cases that are the entire reason UUIDs are
 *      compared and hostnames are not.
 *   2. A SOURCE SCAN. A behavioural test proves the guard works where it is
 *      called; it cannot prove there is no writer that never calls it. This
 *      repository has watched a fix reach only its first site four times, and
 *      each time the denominator was the thing that lied. So the scan asks the
 *      question the tests cannot: does any file write a Local REST API
 *      `data.json` outside the two guarded funnels?
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  validateVaultIdentity,
  createVaultIdentity,
  serializeVaultIdentity,
  IDENTITY_SCHEMA_VERSION,
} from '../src/helpers/vault-identity.mjs';
import {
  assertVaultPortOwnership,
  classifyVaultOwnership,
  OWNERSHIP_VERDICT,
  VaultOwnershipError,
} from '../src/helpers/vault-ownership.mjs';
import {
  readVaultIdentity,
  writeVaultIdentity,
  identityPathFor,
  IDENTITY_STATUS,
  IdentityPreconditionError,
} from '../src/vault-identity-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOCAL = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const OTHER = '11111111-2222-4333-8444-555555555555';
const VAULT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const identityWith = (owner) => ({ schemaVersion: 1, vaultId: VAULT_ID, owner, createdAt: '2026-09-09T00:00:00.000Z' });

// ---------------------------------------------------------------------------
// The mandatory matrix
// ---------------------------------------------------------------------------

describe('ownership — the matrix the specification makes mandatory', () => {
  test('the local owner may write', () => {
    const { verdict, allowed } = classifyVaultOwnership({
      identity: identityWith({ installId: LOCAL, hostname: 'ROLAND-PC' }),
      installId: LOCAL,
    });
    assert.equal(verdict, OWNERSHIP_VERDICT.OWNED);
    assert.equal(allowed, true);
  });

  test('ANOTHER installation with the SAME hostname is refused', () => {
    // The first crossed case. Two machines can carry the same label — a default
    // Windows name, a restored image, a family that names both PCs the same
    // thing. If the hostname decided anything, this would be a silent yes.
    const { verdict, allowed } = classifyVaultOwnership({
      identity: identityWith({ installId: OTHER, hostname: 'ROLAND-PC' }),
      installId: LOCAL,
    });
    assert.equal(verdict, OWNERSHIP_VERDICT.FOREIGN);
    assert.equal(allowed, false);
  });

  test('the SAME installation with a DIFFERENT hostname is recognised', () => {
    // The second crossed case, and the one a hostname check would break: rename
    // the machine and it would lose every vault it owns.
    const { verdict, allowed } = classifyVaultOwnership({
      identity: identityWith({ installId: LOCAL, hostname: 'OLD-NAME' }),
      installId: LOCAL,
    });
    assert.equal(verdict, OWNERSHIP_VERDICT.OWNED);
    assert.equal(allowed, true);
  });

  test('an unknown owner is refused — and it is a VALID state, not an error', () => {
    const { verdict, allowed } = classifyVaultOwnership({ identity: identityWith(null), installId: LOCAL });
    assert.equal(verdict, OWNERSHIP_VERDICT.UNCLAIMED);
    assert.equal(allowed, false);
    assert.notEqual(verdict, OWNERSHIP_VERDICT.INVALID, 'unclaimed and damaged are different facts');
  });

  test('a damaged identity is refused, and is a different verdict from unclaimed', () => {
    for (const bad of [null, {}, { vaultId: 'nope', owner: null }, identityWith({ installId: 'nope' })]) {
      const { verdict, allowed } = classifyVaultOwnership({ identity: bad, installId: LOCAL });
      assert.equal(allowed, false, JSON.stringify(bad));
      assert.equal(verdict, OWNERSHIP_VERDICT.INVALID, JSON.stringify(bad));
    }
  });

  test('an installation with no identity of its own owns nothing', () => {
    const { verdict, allowed } = classifyVaultOwnership({
      identity: identityWith({ installId: LOCAL, hostname: 'X' }),
      installId: null,
    });
    assert.equal(verdict, OWNERSHIP_VERDICT.NO_LOCAL_IDENTITY);
    assert.equal(allowed, false);
  });

  test('the thrown refusal names the operation and never the foreign installId', () => {
    try {
      assertVaultPortOwnership({
        identity: identityWith({ installId: OTHER, hostname: 'SONS-PC' }),
        installId: LOCAL,
        operation: 'renumbering this vault',
      });
      assert.fail('expected a refusal');
    } catch (err) {
      assert.ok(err instanceof VaultOwnershipError);
      assert.match(err.message, /renumbering this vault/);
      assert.match(err.message, /SONS-PC/);
      assert.ok(!err.message.includes(OTHER), 'a foreign installId leaked into a message');
      assert.equal(err.verdict, OWNERSHIP_VERDICT.FOREIGN);
    }
  });

  test('the local owner raises nothing at all', () => {
    assert.doesNotThrow(() => assertVaultPortOwnership({
      identity: identityWith({ installId: LOCAL, hostname: 'X' }),
      installId: LOCAL,
    }));
  });
});

// ---------------------------------------------------------------------------
// The identity itself
// ---------------------------------------------------------------------------

describe('validateVaultIdentity', () => {
  test('accepts a well-formed identity, claimed or not', () => {
    assert.equal(validateVaultIdentity(identityWith(null)).valid, true);
    assert.equal(validateVaultIdentity(identityWith({ installId: LOCAL, hostname: 'X' })).valid, true);
  });

  test('a schema version from the FUTURE is refused, not overwritten', () => {
    const out = validateVaultIdentity({ ...identityWith(null), schemaVersion: IDENTITY_SCHEMA_VERSION + 1 });
    assert.equal(out.valid, false);
    assert.ok(out.issues.some((i) => i.kind === 'identity-future-schema'));
  });

  test('an owner without a valid installId is damage, not an unclaimed vault', () => {
    const out = validateVaultIdentity(identityWith({ hostname: 'ROLAND-PC' }));
    assert.equal(out.valid, false);
    assert.ok(out.issues.some((i) => i.kind === 'identity-bad-owner'));
  });

  test('unknown fields are PRESERVED — a newer router may have written them', () => {
    const out = validateVaultIdentity({ ...identityWith(null), somethingNewer: { a: 1 } });
    assert.equal(out.valid, true);
    assert.deepEqual(out.identity.somethingNewer, { a: 1 });
  });

  test('a `__proto__` key in the file never reaches Object.prototype', () => {
    const raw = JSON.parse(`{"schemaVersion":1,"vaultId":"${VAULT_ID}","owner":null,"__proto__":{"polluted":true}}`);
    const out = validateVaultIdentity(raw);
    assert.equal(out.valid, true);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });

  test('the serialization is stable — the same identity yields the same bytes', () => {
    const a = serializeVaultIdentity({ vaultId: VAULT_ID, schemaVersion: 1, owner: null, createdAt: 'x' });
    const b = serializeVaultIdentity({ createdAt: 'x', owner: null, schemaVersion: 1, vaultId: VAULT_ID });
    assert.equal(a, b);
  });

  test('createVaultIdentity refuses a half-formed owner', () => {
    assert.throws(
      () => createVaultIdentity({ randomUUID: () => VAULT_ID, owner: { hostname: 'X' } }),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// The store, against real files
// ---------------------------------------------------------------------------

describe('the identity store', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-identity-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('an absent file is ABSENT, and a corrupt one is INVALID — never the same', async () => {
    assert.equal((await readVaultIdentity(dir)).status, IDENTITY_STATUS.ABSENT);

    fs.mkdirSync(path.dirname(identityPathFor(dir)), { recursive: true });
    fs.writeFileSync(identityPathFor(dir), '{ not json');
    const corrupt = await readVaultIdentity(dir);
    assert.equal(corrupt.status, IDENTITY_STATUS.INVALID);
    assert.notEqual(corrupt.status, IDENTITY_STATUS.ABSENT);
    assert.ok(corrupt.revision, 'a corrupt file still has a revision — it has bytes');
  });

  test('ifNew creates, and refuses a second time', async () => {
    const identity = createVaultIdentity({ randomUUID: () => VAULT_ID, owner: { installId: LOCAL, hostname: 'X' } });
    const first = await writeVaultIdentity(dir, identity, { ifNew: true });
    assert.equal(first.created, true);
    assert.equal(first.backupPath, null, 'creating cannot need a backup');

    await assert.rejects(
      () => writeVaultIdentity(dir, identity, { ifNew: true }),
      (err) => err instanceof IdentityPreconditionError && err.kind === 'identity-exists',
    );
  });

  test('a replace needs the CURRENT revision, and refuses a stale one', async () => {
    const identity = createVaultIdentity({ randomUUID: () => VAULT_ID, owner: null });
    const { revision } = await writeVaultIdentity(dir, identity, { ifNew: true });

    // Somebody else — the other machine, Drive, a person — writes in between.
    fs.writeFileSync(identityPathFor(dir), serializeVaultIdentity({ ...identity, createdAt: '2026-01-01T00:00:00.000Z' }));

    await assert.rejects(
      () => writeVaultIdentity(dir, { ...identity, owner: { installId: LOCAL, hostname: 'X' } }, { expectedRevision: revision }),
      (err) => err instanceof IdentityPreconditionError && err.kind === 'identity-revision-mismatch',
    );
  });

  test('there is NO unconditional write', async () => {
    const identity = createVaultIdentity({ randomUUID: () => VAULT_ID, owner: null });
    await assert.rejects(() => writeVaultIdentity(dir, identity, {}), TypeError);
    await assert.rejects(() => writeVaultIdentity(dir, identity, { ifNew: true, expectedRevision: 'x' }), TypeError);
  });

  test('a replace backs the old file up first, and never overwrites a backup', async () => {
    const identity = createVaultIdentity({ randomUUID: () => VAULT_ID, owner: null });
    let current = await writeVaultIdentity(dir, identity, { ifNew: true });

    const frozenClock = () => new Date('2026-09-09T12:00:00.000Z');
    const claimed = { ...identity, owner: { installId: LOCAL, hostname: 'X' } };
    const first = await writeVaultIdentity(dir, claimed, { expectedRevision: current.revision, now: frozenClock });
    assert.ok(first.backupPath, 'no backup was taken before replacing');

    // A second replace in the SAME second must not destroy the first backup —
    // which is exactly the state someone would want back.
    const again = { ...claimed, owner: { installId: LOCAL, hostname: 'Y' } };
    const second = await writeVaultIdentity(dir, again, { expectedRevision: first.revision, now: frozenClock });
    assert.notEqual(second.backupPath, first.backupPath);
    assert.ok(fs.existsSync(first.backupPath), 'the earlier backup was overwritten');
  });

  test('a DAMAGED file is backed up before being replaced, not discarded', async () => {
    fs.mkdirSync(path.dirname(identityPathFor(dir)), { recursive: true });
    fs.writeFileSync(identityPathFor(dir), '{ broken but possibly the only trace of a UUID');
    const { revision } = await readVaultIdentity(dir);

    const identity = createVaultIdentity({ randomUUID: () => VAULT_ID, owner: null });
    const out = await writeVaultIdentity(dir, identity, { expectedRevision: revision });
    assert.ok(out.backupPath && fs.existsSync(out.backupPath));
    assert.match(fs.readFileSync(out.backupPath, 'utf8'), /broken but possibly/);
  });

  test('an invalid identity is never written', async () => {
    await assert.rejects(
      () => writeVaultIdentity(dir, { schemaVersion: 1, vaultId: 'nope', owner: null }, { ifNew: true }),
      TypeError,
    );
    assert.equal(fs.existsSync(identityPathFor(dir)), false);
  });

  test('the file carries no key, no path and no port', async () => {
    const identity = createVaultIdentity({ randomUUID: () => VAULT_ID, owner: { installId: LOCAL, hostname: 'ROLAND-PC' } });
    await writeVaultIdentity(dir, identity, { ifNew: true });
    const written = fs.readFileSync(identityPathFor(dir), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(written)).sort(), ['createdAt', 'owner', 'schemaVersion', 'vaultId']);
    assert.ok(!written.includes(dir), 'an absolute path was written into the identity');
    assert.ok(!/\b2[0-9]{4}\b/.test(written), 'something port-shaped was written into the identity');
  });
});

// ---------------------------------------------------------------------------
// The scan — the question the behavioural tests cannot ask
// ---------------------------------------------------------------------------

describe('no writer of a Local REST API data.json bypasses the guard', () => {
  /**
   * The funnels that are ALLOWED to write a vault's plugin configuration, each
   * of which asserts ownership immediately before doing so. Anything else that
   * writes such a file is a hole, whatever its intention.
   */
  const GUARDED_FUNNELS = [
    'patchRestApiData',
    'upgradeInsecureServer',
    // The two re-clone funnels. They weld the ownership check, the `rm -rf` and
    // the write-back into one function on purpose: when those were three
    // statements at a call site, the guard sat on the LAST of them, so a
    // refusal fired only after the folder had been replaced by the reference
    // vault's copy — leaving the vault holding the template's key and ports.
    // A guard that makes the failure path destructive is worse than none.
    'recloneVaultPlugin',
    'recloneVaultPluginPreservingConfig',
  ];

  test('every data.json writer in scripts/ and src/ sits inside a guarded funnel', async () => {
    const files = [];
    for (const root of ['src', 'scripts']) {
      const walk = async (d) => {
        for (const entry of await fsp.readdir(path.join(REPO_ROOT, d), { withFileTypes: true })) {
          const rel = path.join(d, entry.name);
          if (entry.isDirectory()) await walk(rel);
          else if (entry.name.endsWith('.mjs')) files.push(rel);
        }
      };
      await walk(root);
    }
    assert.ok(files.length > 20, `expected a populated source tree, found ${files.length}`);

    const offenders = [];
    for (const rel of files) {
      const source = await fsp.readFile(path.join(REPO_ROOT, rel), 'utf8');
      // Find the enclosing function of every write whose target is a variable
      // holding a REST API data.json path.
      const lines = source.split('\n');
      const restPathVars = new Set();
      lines.forEach((line) => {
        const m = line.match(/(?:const|let)\s+(\w+)\s*=.*obsidian-local-rest-api/);
        if (m) restPathVars.add(m[1]);
        const m2 = line.match(/(?:const|let)\s+(\w+)\s*=\s*path\.join\((\w+),\s*'data\.json'\)/);
        if (m2) restPathVars.add(m2[1]);
      });

      let currentFn = '(top level)';
      lines.forEach((line, i) => {
        const fn = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
        if (fn) currentFn = fn[1];
        const write = line.match(/(?:fs|fsSync|fsp)\.(writeFileSync|writeFile|appendFileSync|copyFileSync)\(\s*(\w+)/);
        if (!write) return;
        if (!restPathVars.has(write[2])) return;
        if (GUARDED_FUNNELS.includes(currentFn)) return;
        offenders.push(`${rel}:${i + 1} — ${currentFn}() writes ${write[2]}`);
      });
    }

    assert.deepEqual(
      offenders,
      [],
      `a Local REST API data.json is written outside the guarded funnels:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('each guarded funnel really does assert ownership', async () => {
    // The scan above is only worth anything if the funnels it exempts actually
    // carry the guard. Mutating one of them — deleting its assert — must fail
    // HERE, not merely at some behavioural test that happens to cover it.
    const source = await fsp.readFile(path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs'), 'utf8');
    for (const fn of GUARDED_FUNNELS) {
      const start = source.indexOf(`function ${fn}(`);
      assert.notEqual(start, -1, `${fn} no longer exists — update GUARDED_FUNNELS`);
      const next = source.indexOf('\nfunction ', start + 1);
      const nextAsync = source.indexOf('\nasync function ', start + 1);
      const end = Math.min(...[next, nextAsync].filter((n) => n > 0));
      const body = source.slice(start, Number.isFinite(end) ? end : source.length);
      assert.match(
        body,
        /assertMayWriteVaultPorts\(|mayRecloneVaultPlugin\(/,
        `${fn}() no longer settles ownership before writing`,
      );
    }
  });

  test('nothing outside the re-clone funnels removes a plugin directory', () => {
    // The companion to the funnel list. A guard welded into a function is only
    // as good as the absence of a second path that skips it — and `rm -rf` on a
    // plugin folder IS the destructive half of a re-clone, whatever comes next.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs'), 'utf8');
    const lines = source.split('\n');
    let currentFn = '(top level)';
    const offenders = [];
    lines.forEach((line, i) => {
      const fn = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (fn) currentFn = fn[1];
      if (!/fs\.rmSync\(\s*dstPlugin/.test(line)) return;
      if (GUARDED_FUNNELS.includes(currentFn)) return;
      offenders.push(`${i + 1} — ${currentFn}()`);
    });
    assert.deepEqual(offenders, [], `a plugin directory is removed outside a guarded funnel:\n  ${offenders.join('\n  ')}`);
  });
});
