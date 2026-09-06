// Decision portee-et-mode-ecriture-des-vaults §1, trap 4: "list_vaults must
// keep SHOWING what's unreachable, never hide it." Focused tests for the
// reachability partition added to listVaults() — not a full-coverage suite
// for the tool (no dedicated file existed before this lot).
//
// Vaults expected to end up REACHABLE use a loopback port nothing listens on
// (connection-refused, sub-millisecond, no DNS/timeout wait) so these tests
// stay fast and hermetic without mocking rest-client.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { listVaults } from '../src/tools/list-vaults.mjs';

const REFUSED = 'http://127.0.0.1:1'; // nothing listens on port 1

function vault(name) {
  return { name, type: 'remote', baseUrl: REFUSED, apiKey: 'k', timeoutMs: 500 };
}

describe('listVaults — reachability (trap 4)', () => {
  test('vaultReach inactive (default) — every vault is pinged, none in disabled for reachability', async () => {
    const registry = { vaults: [vault('a'), vault('b')], skipped: [], configPath: '/c' };
    const out = await listVaults(registry);
    assert.deepEqual(out.vaults.map((v) => v.name).sort(), ['a', 'b']);
    assert.deepEqual(out.disabled, []);
  });

  test('vaultReach: "declared", no binding, no openVaults — every vault moves to disabled, none pinged', async () => {
    const registry = {
      vaults: [vault('a'), vault('b')], skipped: [], configPath: '/c',
      vaultReach: 'declared', openVaults: [], workspaceBinding: null,
    };
    const out = await listVaults(registry);
    assert.deepEqual(out.vaults, [], 'unreachable vaults must not be pinged at all');
    assert.deepEqual(out.disabled.map((d) => d.name).sort(), ['a', 'b']);
    for (const d of out.disabled) {
      assert.match(d.reason, /not reachable from this workspace/);
    }
  });

  test('vaultReach: "declared" — reachable and unreachable vaults are correctly split', async () => {
    const registry = {
      vaults: [vault('work'), vault('reference'), vault('unrelated')],
      skipped: [], configPath: '/c',
      vaultReach: 'declared', openVaults: [],
      workspaceBinding: { vault: 'work', also: ['reference'] },
    };
    const out = await listVaults(registry);
    assert.deepEqual(out.vaults.map((v) => v.name).sort(), ['reference', 'work']);
    assert.deepEqual(out.disabled.map((d) => d.name), ['unrelated']);
  });

  test('a genuinely disabled vault (registry.skipped) and an unreachable one both show up, with their OWN distinct reasons', async () => {
    const registry = {
      vaults: [vault('reachable')],
      skipped: [{ name: 'off', type: 'local', reason: 'disabled' }],
      configPath: '/c',
      vaultReach: 'declared', openVaults: ['reachable'],
    };
    const out = await listVaults(registry);
    assert.deepEqual(out.vaults.map((v) => v.name), ['reachable']);
    const byName = Object.fromEntries(out.disabled.map((d) => [d.name, d.reason]));
    assert.equal(byName.off, 'disabled');
    assert.equal(byName.reachable, undefined, 'a reachable vault must not ALSO appear in disabled');
  });

  test('the two absences are told apart BY DATA — awaitingDeclaration, not by parsing the reason', async () => {
    // The whole-lot review, 2026-09-06: `disabled[]` held two different things
    // — "the operator said no" and "this workspace has not declared it yet" —
    // and the `bind-workspace` wizard, reading the array as one kind, excluded
    // both. On a workspace with no binding and no `openVaults` that is EVERY
    // vault, so the wizard could offer nothing, and binding is what would have
    // made the candidates appear: a door locked from the inside. It is trap 3
    // of `portee-et-mode-ecriture-des-vaults` biting one layer above where the
    // decision had guarded it.
    const registry = {
      vaults: [vault('undeclared'), vault('open-one')],
      skipped: [{ name: 'off', type: 'local', reason: 'disabled' }],
      configPath: '/c',
      vaultReach: 'declared',
      openVaults: ['open-one'],
    };
    const out = await listVaults(registry);
    const byName = Object.fromEntries(out.disabled.map((d) => [d.name, d]));

    assert.equal(byName.off.awaitingDeclaration, false, 'the operator said no — never a candidate');
    assert.equal(byName.undeclared.awaitingDeclaration, true,
      'registered and healthy, simply not declared by this workspace — the wizard MUST be able to offer it');
    assert.equal(byName['open-one'], undefined, 'an openVaults vault is reachable, so it is not in disabled at all');

    // The field is present on EVERY entry, always a boolean: a consumer that
    // has to ask "is this key here?" would be back to parsing prose.
    for (const d of out.disabled) {
      assert.equal(typeof d.awaitingDeclaration, 'boolean', `${d.name} carries no verdict`);
    }
  });

  test('with vaultReach inactive nothing awaits a declaration — the field does not invent a state', async () => {
    const registry = {
      vaults: [vault('a')],
      skipped: [{ name: 'off', type: 'local', reason: 'disabled' }],
      configPath: '/c',
    };
    const out = await listVaults(registry);
    assert.deepEqual(out.disabled.map((d) => [d.name, d.awaitingDeclaration]), [['off', false]]);
  });

  test('the default vault, when unreachable, yields defaultVaultStatus: null rather than a stale entry', async () => {
    const registry = {
      vaults: [vault('other')], skipped: [], configPath: '/c',
      vaultReach: 'declared', openVaults: ['other'],
      defaultVault: 'not-declared', workspaceBinding: null,
    };
    const out = await listVaults(registry);
    assert.equal(out.defaultVaultStatus, null);
  });
});

describe('listVaults — the binding\'s per-secondary write tiers reach the caller', () => {
  test('alsoLocked / alsoWritable are passed through, validated like the other binding fields', async () => {
    const registry = {
      vaults: [vault('work')], skipped: [], configPath: '/c',
      workspaceBinding: {
        vault: 'work', also: ['ref', 'scratch'], locked: false,
        alsoLocked: ['ref', 7, ''], alsoWritable: ['scratch'],
      },
    };
    const out = await listVaults(registry);
    assert.deepEqual(out.workspaceBinding.alsoLocked, ['ref']);
    assert.deepEqual(out.workspaceBinding.alsoWritable, ['scratch']);
  });

  test('a binding written before the tiers existed reads back with empty lists, never undefined', async () => {
    const registry = {
      vaults: [vault('work')], skipped: [], configPath: '/c',
      workspaceBinding: { vault: 'work', also: ['ref'], locked: false },
    };
    const out = await listVaults(registry);
    assert.deepEqual(out.workspaceBinding.alsoLocked, []);
    assert.deepEqual(out.workspaceBinding.alsoWritable, []);
  });
});

describe('listVaults — the refusals of this workspace reach the caller (decision refus-d-une-proposition-de-liaison)', () => {
  test('workspaceRefusals: the Map on the registry becomes an array of names; anything else is an empty array', async () => {
    const withMap = await listVaults({
      vaults: [], skipped: [], configPath: '/c',
      workspaceRefusals: new Map([['work', '2026-09-06'], ['', null], ['archive', null]]),
    });
    assert.deepEqual(withMap.workspaceRefusals, ['work', 'archive']);
    for (const junk of [undefined, null, ['work'], { work: '2026-09-06' }, 'work']) {
      const out = await listVaults({ vaults: [], skipped: [], configPath: '/c', workspaceRefusals: junk });
      assert.deepEqual(out.workspaceRefusals, [], JSON.stringify(junk));
    }
  });

  test('bindingHint.previouslyRefused is a boolean, true only when the registry says so', async () => {
    const hint = (extra) => ({ status: 'unconfirmed', hint: 'work', boundTo: null, origin: 'workspace-dotenv', ...extra });
    for (const [value, expected] of [[true, true], [false, false], [undefined, false], ['true', false], [1, false]]) {
      const out = await listVaults({ vaults: [], skipped: [], configPath: '/c', bindingHint: hint({ previouslyRefused: value }) });
      assert.equal(out.bindingHint.previouslyRefused, expected, JSON.stringify(value));
    }
  });
});
