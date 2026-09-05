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
import { canonicalWorkspaceKey, readBinding, withBinding } from '../src/helpers/workspace-bindings.mjs';
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
});
