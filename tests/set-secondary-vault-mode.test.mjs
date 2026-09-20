/**
 * `set_secondary_vault_mode` — one answer of the "paramétrons les vaults
 * secondaires" conversation, recorded on the workspace's binding.
 *
 * Every test drives the tool through injected read/write seams. NOTHING here
 * touches a real config file. Same fixture discipline as
 * tests/workspace-binding-tool.test.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { setSecondaryVaultMode, SECONDARY_MODES, TOOL_DEFINITION } from '../src/tools/set-secondary-vault-mode.mjs';
import { confirmWorkspaceBinding } from '../src/tools/workspace-binding.mjs';
import { canonicalWorkspaceKey, readBinding, readRefusals, withBinding, withRefusal } from '../src/helpers/workspace-bindings.mjs';
import { alsoWriteTierFor } from '../src/helpers/vault-reach.mjs';

const CWD = process.cwd();

function registryOf(overrides = {}) {
  return {
    configPath: path.join('/cfg', 'config.json'),
    vaults: [
      { name: 'notes', type: 'local', path: '/v/Notes' },
      { name: 'ref', type: 'local', path: '/v/Ref' },
      { name: 'scratch', type: 'local', path: '/v/Scratch' },
    ],
    workspaceBinding: { vault: 'notes', also: ['ref', 'scratch'], locked: false, alsoLocked: [], alsoWritable: [] },
    ...overrides,
  };
}

/** The config on disk: the vaults the registry knows, plus the binding the registry carries. */
function onDisk(binding = { vault: 'notes', also: ['ref', 'scratch'] }) {
  const base = {
    portRegistry: { '/v/Notes': 27124, '/v/Ref': 27125, '/v/Scratch': 27126 },
    remoteVaults: [],
  };
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

describe('set_secondary_vault_mode — the tool definition', () => {
  test('names the three modes as an enum, requires vault + mode, and admits nothing else', () => {
    assert.equal(TOOL_DEFINITION.name, 'set_secondary_vault_mode');
    assert.deepEqual(TOOL_DEFINITION.inputSchema.properties.mode.enum, [...SECONDARY_MODES]);
    assert.deepEqual(TOOL_DEFINITION.inputSchema.required, ['vault', 'mode']);
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
  });
});

describe('set_secondary_vault_mode — recording the user\'s answer', () => {
  test('locked: lands in the binding\'s alsoLocked, on disk AND on the live registry, and the gate sees it at once', async () => {
    const { written, seam } = seams();
    const reg = registryOf();
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(r.mode, 'locked');
    assert.equal(r.previousMode, 'soft');
    assert.equal(r.effectiveMode, 'locked');
    assert.equal(r.overriddenBy, null);
    assert.equal(written.length, 1);
    assert.deepEqual(readBinding(written[0].config, CWD).alsoLocked, ['ref']);
    assert.deepEqual(reg.workspaceBinding.alsoLocked, ['ref']);
    assert.equal(alsoWriteTierFor('ref', reg), 'locked', 'the live registry is what the write gate reads');
    assert.equal(alsoWriteTierFor('scratch', reg), 'soft', 'the other secondary is untouched');
  });

  test('writable, then back to soft: each answer replaces the previous one, in both lists', async () => {
    const { seam } = seams();
    const reg = registryOf();
    await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'writable' }, seam);
    assert.deepEqual(reg.workspaceBinding.alsoWritable, ['ref']);
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'soft' }, seam);
    assert.equal(r.previousMode, 'writable');
    assert.deepEqual(reg.workspaceBinding.alsoWritable, []);
    assert.deepEqual(reg.workspaceBinding.alsoLocked, []);
    assert.equal(alsoWriteTierFor('ref', reg), 'soft');
  });

  test('locked → writable moves the name from one list to the other, never leaves it in both', async () => {
    const { seam } = seams();
    const reg = registryOf();
    await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'writable' }, seam);
    assert.deepEqual(reg.workspaceBinding.alsoLocked, []);
    assert.deepEqual(reg.workspaceBinding.alsoWritable, ['ref']);
  });

  test('re-recording the SAME mode writes nothing (the file holds every vault\'s API key)', async () => {
    const { written, seam } = seams({ config: onDisk({ vault: 'notes', also: ['ref', 'scratch'], alsoLocked: ['ref'] }) });
    const reg = registryOf({ workspaceBinding: { vault: 'notes', also: ['ref', 'scratch'], locked: false, alsoLocked: ['ref'], alsoWritable: [] } });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(r.previousMode, 'locked');
    assert.match(r.message, /unchanged/);
    assert.equal(written.length, 0);
  });

  test('the mode is read case-insensitively and trimmed', async () => {
    const { seam } = seams();
    const reg = registryOf();
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: ' Locked ' }, seam);
    assert.equal(r.mode, 'locked');
  });

  test('the file is what counts: the binding is re-read INSIDE the lock, not from the live copy', async () => {
    // The live registry still lists `scratch`; the file (another session) no
    // longer does. The answer must be about the file.
    const { seam } = seams({ config: onDisk({ vault: 'notes', also: ['ref'] }) });
    const reg = registryOf();
    await assert.rejects(setSecondaryVaultMode(reg, { vault: 'scratch', mode: 'locked' }, seam), /not a secondary of this workspace/);
  });
});

describe('set_secondary_vault_mode — a write adopts the file\'s LOCK with its binding', () => {
  test('a sibling re-bound the workspace elsewhere, unlocked: recording a tier adopts that binding AND releases this session\'s binding lock', async () => {
    // Round 16, W2 (blocker): the write adopted the binding and the default
    // but left `lockedVault`/`lockSource` on the vault the adopted binding
    // no longer named — unqualified calls routed to a vault outside the
    // binding, calls to the new primary refused under a lock the file had
    // lifted.
    const reg = registryOf({
      lockedVault: 'notes',
      lockSource: { origin: 'binding', variable: null },
      workspaceBinding: { vault: 'notes', also: ['ref'], locked: true, alsoLocked: [], alsoWritable: [] },
    });
    // The FILE: re-bound to `scratch` (unlocked) with `ref` kept.
    const { seam } = seams({ config: onDisk({ vault: 'scratch', also: ['ref'], locked: false }) });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(r.mode, 'locked');
    assert.equal(reg.workspaceBinding.vault, 'scratch', 'the write did not adopt the file\'s binding');
    assert.equal(reg.lockedVault, null, 'the binding lock on the OLD primary survived the adoption of an unlocked binding');
    assert.equal(reg.lockSource.origin, 'unset');
  });

  test('…and adopts a lock the file carries', async () => {
    const reg = registryOf({ lockedVault: null, lockSource: { origin: 'unset', variable: null } });
    const { seam } = seams({ config: onDisk({ vault: 'notes', also: ['ref', 'scratch'], locked: true }) });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(reg.lockedVault, 'notes');
    assert.equal(reg.lockSource.origin, 'binding');
    // The primary did not change and the lock was already what the file said,
    // so nothing about the routing is reported: the note is for a CHANGE.
    assert.equal(r.adoptedRouting?.lockBefore ?? null, null);
    assert.equal(r.adoptedRouting?.lockAfter, 'notes');
    assert.match(r.message, /this write also adopted the binding the config file holds/);
  });

  test('a lock on a primary this session cannot resolve is NOT applied — lock_vault refuses exactly that', async () => {
    // Round 16 made the adoption carry the lock by copying `adoptRouting`.
    // But `adoptRouting`'s own comment says the guards it dropped belonged to
    // paths that WRITE the binding, where `assertBindable` has already
    // refused a name the live registry cannot resolve. Here the binding is a
    // SIBLING's, adopted whole, and nothing validated its primary: a sibling
    // that registers `b` and binds this workspace to it, locked, left the
    // older session locked to a vault it never loaded — through
    // `applyLockGuard`, every later call resolves a name that is not there.
    // A mechanism copied without its discipline. (Codex, round 17, C7.)
    const reg = registryOf({ lockedVault: null, lockSource: { origin: 'unset', variable: null } });
    // The FILE names `b` as primary, locked. This session's catalogue has no `b`.
    const { seam } = seams({ config: onDisk({ vault: 'b', also: ['ref'], locked: true }) });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(r.mode, 'locked', 'the tier the user asked for is still recorded');
    assert.equal(reg.workspaceBinding.vault, 'b', 'the binding itself is adopted, as a write always is');
    assert.equal(reg.lockedVault, null, 'a lock was applied to a vault this session cannot resolve');
    assert.notEqual(reg.lockSource.origin, 'binding');
    // AND IT IS SAID: the user asked for one secondary's tier.
    assert.match(r.message, /records a lock on "b", which this session has not loaded/);
    assert.match(r.message, /The lock was NOT applied here/);
    assert.match(r.message, /It applies at the next start/);
  });

  test('a lock on a primary this session DOES hold is still applied — the guard is narrow', async () => {
    // The guard must not swallow the repair round 16 made: a lock the file
    // records on a vault this session loaded is adopted, as before.
    const reg = registryOf({ lockedVault: null, lockSource: { origin: 'unset', variable: null } });
    const { seam } = seams({ config: onDisk({ vault: 'scratch', also: ['ref'], locked: true }) });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(reg.lockedVault, 'scratch');
    assert.equal(reg.lockSource.origin, 'binding');
    assert.doesNotMatch(r.message, /The lock was NOT applied here/);
  });

  test('the routing a write ADOPTS is reported — the user asked for a tier, not a new primary', async () => {
    // The adoption is deliberate and right (round 9). What was missing is
    // the sentence: a call about one secondary's write tier could change the
    // session's primary and its lock, and the answer spoke only of the tier.
    // (Codex, round 17.)
    const reg = registryOf({ lockedVault: 'notes', lockSource: { origin: 'binding', variable: null } });
    const { seam } = seams({ config: onDisk({ vault: 'scratch', also: ['ref'], locked: false }) });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'writable' }, seam);
    assert.deepEqual(r.adoptedRouting, {
      primaryBefore: undefined, primaryAfter: 'scratch', lockBefore: 'notes', lockAfter: null,
    });
    assert.match(r.message, /this session's primary is now "scratch"/);
    assert.match(r.message, /its lock none \(was "notes"\)/);
  });

  test('a write that changes no routing says nothing about it', async () => {
    const reg = registryOf({
      defaultVault: 'notes',
      lockedVault: null,
      lockSource: { origin: 'unset', variable: null },
    });
    const { seam } = seams({ config: onDisk({ vault: 'notes', also: ['ref', 'scratch'], locked: false }) });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'writable' }, seam);
    assert.equal(r.adoptedRouting, null);
    assert.doesNotMatch(r.message, /also adopted the binding/);
  });
});

describe('set_secondary_vault_mode — what it refuses', () => {
  test('an unknown mode, with the three valid ones named', async () => {
    const { written, seam } = seams();
    await assert.rejects(setSecondaryVaultMode(registryOf(), { vault: 'ref', mode: 'read-only' }, seam), /"locked", "soft", "writable"/);
    assert.equal(written.length, 0);
  });

  test('a missing vault', async () => {
    const { seam } = seams();
    await assert.rejects(setSecondaryVaultMode(registryOf(), { mode: 'locked' }, seam), /`vault` is required/);
  });

  test('the PRIMARY — always read-write, nothing to qualify', async () => {
    const { written, seam } = seams();
    await assert.rejects(setSecondaryVaultMode(registryOf(), { vault: 'notes', mode: 'locked' }, seam), /PRIMARY/);
    assert.equal(written.length, 0);
  });

  test('a vault that is not a secondary of this workspace — with the secondaries named, and where to add it', async () => {
    // The FILE decides (re-read inside the lock), so the fixture's file must
    // agree with the live registry here: `scratch` is a secondary of neither.
    const { seam } = seams({ config: onDisk({ vault: 'notes', also: ['ref'] }) });
    const reg = registryOf({ workspaceBinding: { vault: 'notes', also: ['ref'], locked: false, alsoLocked: [], alsoWritable: [] } });
    await assert.rejects(
      setSecondaryVaultMode(reg, { vault: 'scratch', mode: 'locked' }, seam),
      /not a secondary of this workspace.*"ref".*confirm_workspace_binding/s,
    );
  });

  test('a workspace with no binding at all — it never binds on its own', async () => {
    const { written, seam } = seams({ config: onDisk(null) });
    await assert.rejects(setSecondaryVaultMode(registryOf({ workspaceBinding: null }), { vault: 'ref', mode: 'locked' }, seam), /no binding/);
    assert.equal(written.length, 0);
  });

  test('a registry with no config path', async () => {
    await assert.rejects(setSecondaryVaultMode(registryOf({ configPath: null }), { vault: 'ref', mode: 'locked' }), /no config path/);
  });
});

describe('set_secondary_vault_mode — the FILE decides, never this session\'s copy (Codex, round on fd9e1cd)', () => {
  test('live says `ref` is the PRIMARY, the file (another session re-bound the workspace) says secondary: recorded, and the live registry adopts the file', async () => {
    const { written, seam } = seams({ config: onDisk({ vault: 'notes', also: ['ref'] }) });
    const reg = registryOf({ defaultVault: 'ref', workspaceBinding: { vault: 'ref', also: [], locked: false, alsoLocked: [], alsoWritable: [] } });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(r.mode, 'locked');
    assert.equal(written.length, 1);
    assert.equal(reg.workspaceBinding.vault, 'notes', 'the live binding is what the file says now');
    assert.equal(reg.defaultVault, 'notes', 'and so is the default vault — a registry must not contradict itself');
    assert.deepEqual(reg.defaultVaultSource, { origin: 'binding', variable: null });
    assert.equal(alsoWriteTierFor('ref', reg), 'locked');
  });

  test('live has NO binding, the file has one (bound by another session since this one started): recorded', async () => {
    const { written, seam } = seams();
    const reg = registryOf({ workspaceBinding: null });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'writable' }, seam);
    assert.equal(r.mode, 'writable');
    assert.equal(written.length, 1);
    assert.equal(reg.workspaceBinding.vault, 'notes');
  });

  test('live says secondary, the file says PRIMARY: refused on the file', async () => {
    const { written, seam } = seams({ config: onDisk({ vault: 'ref', also: ['notes'] }) });
    await assert.rejects(setSecondaryVaultMode(registryOf(), { vault: 'ref', mode: 'locked' }, seam), /PRIMARY/);
    assert.equal(written.length, 0);
  });

  test('re-recording the SAME mode on a hand-authored binding with no confirmedAt writes nothing — and stamps no date', async () => {
    // `withBinding`'s identity rule compares NORMALISED records, and a record
    // without `confirmedAt` normalises to one carrying today's date — so the
    // "unchanged" path used to rewrite the file and invent a confirmation.
    const key = canonicalWorkspaceKey(CWD);
    const config = { ...onDisk(null), workspaceBindings: { [key]: { vault: 'notes', also: ['ref', 'scratch'], alsoLocked: ['ref'], confirmedVia: 'tool' } } };
    const { written, seam } = seams({ config });
    const r = await setSecondaryVaultMode(registryOf(), { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(r.previousMode, 'locked');
    assert.match(r.message, /unchanged/);
    assert.equal(written.length, 0);
  });
});

describe('set_secondary_vault_mode — the global lists still have the last word, and the result says so', () => {
  test('recording "writable" on a vault config.json locks globally: recorded, but effectiveMode is locked and overriddenBy names the list', async () => {
    const { seam } = seams();
    const reg = registryOf({ alsoLocked: ['ref'] });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'writable' }, seam);
    assert.equal(r.mode, 'writable');
    assert.equal(r.effectiveMode, 'locked');
    assert.equal(r.overriddenBy, 'alsoLocked');
    assert.match(r.message, /alsoLocked/);
    assert.equal(alsoWriteTierFor('ref', reg), 'locked');
  });

  test('recording "soft" on a vault config.json makes writable globally: effectiveMode is writable', async () => {
    const { seam } = seams();
    const reg = registryOf({ alsoWritable: ['ref'] });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'soft' }, seam);
    assert.equal(r.effectiveMode, 'writable');
    assert.equal(r.overriddenBy, 'alsoWritable');
  });

  test('recording "locked" is never overridden — the hard tier is absolute wherever it is declared', async () => {
    const { seam } = seams();
    const reg = registryOf({ alsoWritable: ['ref'] });
    const r = await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(r.effectiveMode, 'locked');
    assert.equal(r.overriddenBy, null);
  });
});

describe('the tiers survive the OTHER writers of the binding', () => {
  test('confirm_workspace_binding re-confirmed with one more secondary keeps the modes already recorded, and drops the mode of a secondary that left', async () => {
    const { seam } = seams();
    const reg = registryOf();
    await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    await setSecondaryVaultMode(reg, { vault: 'scratch', mode: 'writable' }, seam);

    // `scratch` leaves, `notes` stays primary, a new secondary is not in this fixture's file → use `ref` only.
    const r = await confirmWorkspaceBinding(reg, { vault: 'notes', also: ['ref'], open: false }, {
      ...seam,
      launch: () => ({ launched: false, uri: null, reason: 'test' }),
      ping: async () => ({ online: true }),
    });
    assert.equal(r.boundTo, 'notes');
    assert.deepEqual(reg.workspaceBinding.also, ['ref']);
    assert.deepEqual(reg.workspaceBinding.alsoLocked, ['ref'], 'the mode of a secondary that STAYS survives the re-confirmation');
    assert.deepEqual(reg.workspaceBinding.alsoWritable, [], 'the mode of a secondary that LEFT is gone with it');
    assert.equal(canonicalWorkspaceKey(CWD), r.workspace);
  });

  test('a stale refusal of a secondary is dropped when its mode is recorded — on disk AND in the live registry', async () => {
    // A hand edit left `ref` both bound and refused. Recording its mode goes
    // through `withBinding`, which drops the refusal of every bound vault;
    // the live copy has to follow, or `list_vaults` lists a refusal the file
    // no longer holds. (Codex, round on b59eb00 — found in lock.mjs, swept
    // to this writer too.)
    const { seam, current } = seams({ config: withRefusal(onDisk(), CWD, 'ref', { at: '2026-09-06' }) });
    const reg = registryOf({ workspaceRefusals: new Map([['ref', '2026-09-06']]) });
    await setSecondaryVaultMode(reg, { vault: 'ref', mode: 'locked' }, seam);
    assert.equal(readRefusals(current(), CWD).has('ref'), false, 'dropped on disk');
    assert.equal(reg.workspaceRefusals.size, 0, 'and live');
  });

  test('on a GATED deployment the tier cannot be recorded, and nothing is written', async () => {
    // Same rule as `confirm_workspace_binding`, closed in Phase 6: the
    // workspace on a gated router is the SERVER's directory, in a config every
    // tenant shares — one caller could open a vault for writing on behalf of
    // all of them, which is the opposite of what the tier exists for.
    for (const [gate, value] of [
      ['OBSIDIAN_ROUTER_READONLY', 'true'],
      ['OBSIDIAN_ROUTER_ALLOWED_VAULTS', 'notes'],
      ['OBSIDIAN_ROUTER_USER_ID', 'u1'],
    ]) {
      const had = Object.hasOwn(process.env, gate);
      const prev = process.env[gate];
      process.env[gate] = value;
      try {
        const { seam, written } = seams();
        for (const mode of ['locked', 'soft', 'writable']) {
          await assert.rejects(
            () => setSecondaryVaultMode(registryOf(), { vault: 'ref', mode }, seam),
            /not available on a gated deployment/,
            `${gate} ${mode}`,
          );
        }
        assert.equal(written.length, 0, `${gate}: nothing may reach the shared config`);
      } finally {
        if (had) process.env[gate] = prev; else delete process.env[gate];
      }
    }
  });
});
