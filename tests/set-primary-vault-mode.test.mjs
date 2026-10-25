/**
 * `set_primary_vault_mode` — the user narrows the PRIMARY's write tier, per
 * workspace; the default stays read-write, and every refusal is a restriction
 * asked for, never an opening.
 *
 * Same discipline as tests/set-secondary-vault-mode.test.mjs: the tool is
 * driven through injected read/write seams, nothing here touches a real config.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { setPrimaryVaultMode, TOOL_DEFINITION } from '../src/tools/set-primary-vault-mode.mjs';
import {
  normalizeBinding, normalizePrimaryTier, PRIMARY_MODES, readBinding, rawBindingEntry, withBinding,
} from '../src/helpers/workspace-bindings.mjs';
import {
  alsoWriteTierFor, primaryWriteTierFor, writeTierFor, assertVaultWritable, isPromotionOfLockedSecondary,
} from '../src/helpers/vault-reach.mjs';

const CWD = process.cwd();

function registryOf(overrides = {}) {
  return {
    configPath: path.join('/cfg', 'config.json'),
    vaults: [
      { name: 'notes', type: 'local', path: '/v/Notes' },
      { name: 'ref', type: 'local', path: '/v/Ref' },
    ],
    workspaceBinding: { vault: 'notes', also: ['ref'], locked: false, alsoLocked: [], alsoWritable: [] },
    ...overrides,
  };
}

function onDisk(binding = { vault: 'notes', also: ['ref'] }) {
  const base = { portRegistry: { '/v/Notes': 27124, '/v/Ref': 27125 }, remoteVaults: [] };

  return binding ? withBinding(base, CWD, binding) : base;
}

function seams({ config = onDisk() } = {}) {
  const written = [];
  let current = config;

  return {
    written,
    current: () => current,
    seam: {
      cwd: CWD,
      readFile: () => JSON.stringify(current),
      writeFile: (p, c) => { current = JSON.parse(c); written.push({ path: p, config: current }); },
    },
  };
}

const notes = { name: 'notes' };
const ref = { name: 'ref' };

describe('set_primary_vault_mode — the tool definition', () => {
  test('names the three modes, requires vault and mode, admits nothing else', () => {
    assert.equal(TOOL_DEFINITION.name, 'set_primary_vault_mode');
    assert.deepEqual(TOOL_DEFINITION.inputSchema.properties.mode.enum, [...PRIMARY_MODES]);
    assert.deepEqual(TOOL_DEFINITION.inputSchema.required, ['vault', 'mode']);
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
  });
});

describe('the default: a primary nobody qualified is read-write', () => {
  test('no tier, no friction: the gate lets every write through, the binding reads as before', () => {
    const reg = registryOf();
    assert.equal(primaryWriteTierFor('notes', reg), null);
    assert.equal(writeTierFor('notes', reg), null);
    assert.doesNotThrow(() => assertVaultWritable(notes, reg, { toolName: 'write_file' }));
    assert.equal('primaryTier' in readBinding(onDisk(), CWD), false);
  });
});

describe('set_primary_vault_mode — recording the answer', () => {
  test('locked: on disk AND on the live registry; the gate refuses every write at once, confirmation or not', async () => {
    const { written, seam } = seams();
    const reg = registryOf();
    const r = await setPrimaryVaultMode(reg, { vault: 'notes', mode: 'locked' }, seam);
    assert.equal(r.mode, 'locked');
    assert.equal(r.previousMode, 'writable');
    assert.equal(r.modeInForceHere, 'locked');
    assert.equal(written.length, 1);
    assert.deepEqual(readBinding(written[0].config, CWD).primaryTier, { vault: 'notes', mode: 'locked' });
    assert.equal(primaryWriteTierFor('notes', reg), 'locked');
    assert.throws(() => assertVaultWritable(notes, reg, { toolName: 'write_file' }), /PRIMARY vault.*locked it read-only/s);
    assert.throws(() => assertVaultWritable(notes, reg, { confirmed: true, toolName: 'write_file' }), /locked it read-only/);
    // the secondary is not touched, and the primary is not "a locked secondary"
    assert.equal(alsoWriteTierFor('notes', reg), null);
    assert.equal(isPromotionOfLockedSecondary('notes', reg), false);
    assert.doesNotThrow(() => assertVaultWritable({ name: 'ref' }, { ...reg, workspaceBinding: { ...reg.workspaceBinding, alsoWritable: ['ref'] } }));
  });

  test('soft: refused unless the write carries the confirmation the user gave', async () => {
    const { seam } = seams();
    const reg = registryOf();
    await setPrimaryVaultMode(reg, { vault: 'notes', mode: 'soft' }, seam);
    assert.equal(primaryWriteTierFor('notes', reg), 'soft');
    assert.throws(() => assertVaultWritable(notes, reg, { toolName: 'write_file' }), /read-only unless asked.*confirmSecondaryWrite: true/s);
    assert.doesNotThrow(() => assertVaultWritable(notes, reg, { confirmed: true, toolName: 'write_file' }));
  });

  test('writable removes the restriction from the file, not a "writable" note beside it', async () => {
    const { current, seam } = seams();
    const reg = registryOf();
    await setPrimaryVaultMode(reg, { vault: 'notes', mode: 'locked' }, seam);
    const r = await setPrimaryVaultMode(reg, { vault: 'notes', mode: 'writable' }, seam);
    assert.equal(r.previousMode, 'locked');
    assert.equal(rawBindingEntry(current(), CWD).primaryTier, undefined);
    assert.equal(primaryWriteTierFor('notes', reg), null);
    assert.doesNotThrow(() => assertVaultWritable(notes, reg, { toolName: 'write_file' }));
  });

  test('the same answer twice writes nothing (the file holds every vault\'s API key)', async () => {
    const { written, seam } = seams({ config: onDisk({ vault: 'notes', also: ['ref'], primaryTier: { vault: 'notes', mode: 'soft' } }) });
    const reg = registryOf({ workspaceBinding: { vault: 'notes', also: ['ref'], alsoLocked: [], alsoWritable: [], primaryTier: { vault: 'notes', mode: 'soft' } } });
    const r = await setPrimaryVaultMode(reg, { vault: 'notes', mode: 'soft' }, seam);
    assert.match(r.message, /unchanged/);
    assert.equal(written.length, 0);
  });

  test('a secondary, a stranger and a bad mode are refused, and nothing is written', async () => {
    const { written, seam } = seams();
    const reg = registryOf();
    await assert.rejects(setPrimaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam), /SECONDARY.*set_secondary_vault_mode/s);
    await assert.rejects(setPrimaryVaultMode(reg, { vault: 'nope', mode: 'locked' }, seam), /not bound to this workspace/);
    await assert.rejects(setPrimaryVaultMode(reg, { vault: 'notes', mode: 'readonly' }, seam), /must be one of/);
    await assert.rejects(setPrimaryVaultMode(reg, { mode: 'locked' }, seam), /`vault` is required/);
    assert.equal(written.length, 0);
    assert.equal(primaryWriteTierFor('notes', reg), null);
  });

  test("a session that does not hold this vault as its primary records nothing: the tier would not be enforced here", async () => {
    // The file's primary is `notes`; this session holds `ref` as primary and `notes` as a writable secondary.
    const { written, seam } = seams();
    const reg = registryOf({ workspaceBinding: { vault: 'ref', also: ['notes'], locked: false, alsoLocked: [], alsoWritable: ['notes'] } });
    await assert.rejects(setPrimaryVaultMode(reg, { vault: 'notes', mode: 'locked' }, seam), /NOTHING WAS RECORDED/);
    assert.equal(written.length, 0);
    assert.doesNotThrow(() => assertVaultWritable(notes, reg, { toolName: 'write_file' }));
    // And with no live binding at all.
    await assert.rejects(setPrimaryVaultMode(registryOf({ workspaceBinding: null }), { vault: 'notes', mode: 'locked' }, seam), /NOTHING WAS RECORDED/);
    assert.equal(written.length, 0);
  });

  test('a workspace with no binding has no primary to qualify', async () => {
    const { seam } = seams({ config: onDisk(null) });
    await assert.rejects(setPrimaryVaultMode(registryOf({ workspaceBinding: null }), { vault: 'notes', mode: 'locked' }, seam), /no binding/);
  });
});

describe('the tier names its vault: re-binding the workspace retires it', () => {
  test('a tier left on the old primary does not apply to the new one, in the registry or in the file', () => {
    const stale = { vault: 'ref', also: [], primaryTier: { vault: 'notes', mode: 'locked' } };
    assert.equal(normalizeBinding(stale).primaryTier, undefined);
    assert.equal(primaryWriteTierFor('ref', { workspaceBinding: { vault: 'ref', primaryTier: { vault: 'notes', mode: 'locked' } } }), null);
    // a writer that does not name the tier carries it only while it still qualifies the primary
    const kept = readBinding(withBinding(onDisk({ vault: 'notes', also: ['ref'], primaryTier: { vault: 'notes', mode: 'locked' } }), CWD, { vault: 'notes', also: ['ref'] }), CWD);
    assert.deepEqual(kept.primaryTier, { vault: 'notes', mode: 'locked' });
    const rebound = readBinding(withBinding(onDisk({ vault: 'notes', also: ['ref'], primaryTier: { vault: 'notes', mode: 'locked' } }), CWD, { vault: 'ref', also: ['notes'] }), CWD);
    assert.equal(rebound.primaryTier, undefined);
  });

  test('an unreadable tier fails CLOSED: a hand edit never lifts a restriction by being wrong', () => {
    for (const bad of [null, 'soft', 42, [], {}, { mode: 'locked' }, { vault: null, mode: 'locked' }, { vault: 7, mode: 'locked' }, { vault: '', mode: 'locked' }, { vault: '   ', mode: 'locked' }, { vault: 'notes' }, { vault: 'notes', mode: 'everything' }]) {
      assert.deepEqual(normalizePrimaryTier(bad, 'notes'), { primaryTier: { vault: 'notes', mode: 'locked' } }, JSON.stringify(bad));
    }
    assert.deepEqual(normalizePrimaryTier(undefined, 'notes'), {});
  });
});
