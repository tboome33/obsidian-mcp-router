// Decision portee-et-mode-ecriture-des-vaults (2026-09-04), Phase 2+3 of
// portee-ergonomie-refus-roadmap. Unit tests for the two shared predicates
// (reachability, the three write tiers) that resolveVault(), the CallTool
// dispatcher's also-tier gate, and list_vaults all read from — ONE
// definition, tested here so every consumer inherits the same coverage.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import os from 'node:os';
import path from 'node:path';

import {
  isVaultReachable, alsoWriteTierFor, assertVaultWritable, vaultContainingPath, isPromotionOfLockedSecondary,
} from '../src/helpers/vault-reach.mjs';

describe('isVaultReachable', () => {
  test('vaultReach inactive (absent/anything but "declared") — every vault reachable, unconditionally', () => {
    for (const registry of [
      {},
      { vaultReach: null },
      { vaultReach: 'open' }, // not the literal 'declared'
      { vaultReach: 'declared' /* but flipped below */ },
    ]) {
      if (registry.vaultReach === 'declared') continue; // covered separately
      assert.equal(isVaultReachable('anything', registry), true, JSON.stringify(registry));
    }
  });

  test('vaultReach: "declared", no openVaults, no binding — nothing is reachable', () => {
    assert.equal(isVaultReachable('notes', { vaultReach: 'declared' }), false);
    assert.equal(isVaultReachable('notes', { vaultReach: 'declared', openVaults: [], workspaceBinding: null }), false);
  });

  test('a vault in openVaults is reachable even with no binding at all', () => {
    const registry = { vaultReach: 'declared', openVaults: ['roland'], workspaceBinding: null };
    assert.equal(isVaultReachable('roland', registry), true);
    assert.equal(isVaultReachable('other', registry), false);
  });

  test('the binding\'s PRIMARY vault is reachable', () => {
    const registry = { vaultReach: 'declared', openVaults: [], workspaceBinding: { vault: 'work', also: [] } };
    assert.equal(isVaultReachable('work', registry), true);
    assert.equal(isVaultReachable('other', registry), false);
  });

  test('a vault in the binding\'s `also` is reachable', () => {
    const registry = { vaultReach: 'declared', openVaults: [], workspaceBinding: { vault: 'work', also: ['reference'] } };
    assert.equal(isVaultReachable('reference', registry), true);
    assert.equal(isVaultReachable('unrelated', registry), false);
  });

  test('openVaults and a binding compose (either one is enough)', () => {
    const registry = { vaultReach: 'declared', openVaults: ['roland'], workspaceBinding: { vault: 'work', also: [] } };
    assert.equal(isVaultReachable('roland', registry), true);
    assert.equal(isVaultReachable('work', registry), true);
    assert.equal(isVaultReachable('neither', registry), false);
  });

  test('malformed also/openVaults containers do not throw — treated as empty', () => {
    const registry = { vaultReach: 'declared', openVaults: 'roland', workspaceBinding: { vault: 'work', also: 'reference' } };
    assert.equal(isVaultReachable('roland', registry), false, 'a bare string container is not iterated as an array');
    assert.equal(isVaultReachable('work', registry), true, 'the primary is still read directly, not through the malformed container');
    assert.equal(isVaultReachable('reference', registry), false);
  });

  test('no registry at all does not throw', () => {
    assert.equal(isVaultReachable('x', null), true);
    assert.equal(isVaultReachable('x', undefined), true);
  });
});

describe('alsoWriteTierFor', () => {
  test('no binding at all — gate does not apply (null)', () => {
    assert.equal(alsoWriteTierFor('any', {}), null);
    assert.equal(alsoWriteTierFor('any', { workspaceBinding: null }), null);
  });

  test('the binding\'s own PRIMARY vault — gate does not apply, even if it is ALSO (mistakenly) in alsoLocked', () => {
    const registry = { workspaceBinding: { vault: 'work', also: [] }, alsoLocked: ['work'] };
    assert.equal(alsoWriteTierFor('work', registry), null);
  });

  test('a vault the binding does not declare at all — gate does not apply (reached via openVaults or a direct name, not `also`)', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['reference'] } };
    assert.equal(alsoWriteTierFor('unrelated', registry), null);
  });

  test('a declared `also` vault in NEITHER list — soft tier (the default)', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['reference'] }, alsoWritable: [], alsoLocked: [] };
    assert.equal(alsoWriteTierFor('reference', registry), 'soft');
  });

  test('a declared `also` vault in alsoWritable — writable', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['reference'] }, alsoWritable: ['reference'], alsoLocked: [] };
    assert.equal(alsoWriteTierFor('reference', registry), 'writable');
  });

  test('a declared `also` vault in alsoLocked — locked', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['reference'] }, alsoWritable: [], alsoLocked: ['reference'] };
    assert.equal(alsoWriteTierFor('reference', registry), 'locked');
  });

  test('alsoLocked wins over alsoWritable if a vault is (misconfigured into) both', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['reference'] }, alsoWritable: ['reference'], alsoLocked: ['reference'] };
    assert.equal(alsoWriteTierFor('reference', registry), 'locked', 'the hard tier must win a conflict — "never" cannot be talked out of');
  });

  test('missing alsoWritable/alsoLocked containers default to soft, not a crash', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['reference'] } };
    assert.equal(alsoWriteTierFor('reference', registry), 'soft');
  });
});

describe('assertVaultWritable', () => {
  const vault = (name) => ({ name });

  test('does not throw when the gate does not apply (no binding, primary, or unrelated vault)', () => {
    assert.doesNotThrow(() => assertVaultWritable(vault('x'), {}));
    assert.doesNotThrow(() => assertVaultWritable(vault('work'), { workspaceBinding: { vault: 'work', also: [] } }));
  });

  test('does not throw for an alsoWritable secondary, confirmed or not', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['ref'] }, alsoWritable: ['ref'], alsoLocked: [] };
    assert.doesNotThrow(() => assertVaultWritable(vault('ref'), registry));
    assert.doesNotThrow(() => assertVaultWritable(vault('ref'), registry, { confirmed: true }));
  });

  test('throws for an alsoLocked secondary EVEN WHEN confirmed:true is passed — no override exists', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['ref'] }, alsoWritable: [], alsoLocked: ['ref'] };
    assert.throws(() => assertVaultWritable(vault('ref'), registry), /locked read-only/);
    assert.throws(
      () => assertVaultWritable(vault('ref'), registry, { confirmed: true }),
      /locked read-only/,
      'alsoLocked must be UNCONDITIONAL — a confirmed:true here must still refuse',
    );
  });

  test('throws for a soft-tier secondary when NOT confirmed', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['ref'] }, alsoWritable: [], alsoLocked: [] };
    assert.throws(() => assertVaultWritable(vault('ref'), registry), /SECONDARY vault/);
  });

  test('does not throw for a soft-tier secondary WHEN confirmed:true is passed', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['ref'] }, alsoWritable: [], alsoLocked: [] };
    assert.doesNotThrow(() => assertVaultWritable(vault('ref'), registry, { confirmed: true }));
  });

  test('the refusal names the tool when given', () => {
    const registry = { workspaceBinding: { vault: 'work', also: ['ref'] }, alsoWritable: [], alsoLocked: [] };
    assert.throws(
      () => assertVaultWritable(vault('ref'), registry, { toolName: 'write_file' }),
      /`write_file`/,
    );
  });
});

describe('vaultContainingPath — the filesystem door into a vault (download_page_assets outputDir)', () => {
  const root = path.join(os.tmpdir(), 'vault-reach-Ref');
  const registry = {
    vaults: [
      { name: 'ref', type: 'local', path: root },
      { name: 'remote', type: 'remote', baseUrl: 'http://127.0.0.1:1' },
    ],
  };

  test('a path inside the vault folder resolves to that vault; the folder itself too', () => {
    assert.equal(vaultContainingPath(path.join(root, 'wiki', '.assets', 'x'), registry)?.name, 'ref');
    assert.equal(vaultContainingPath(root, registry)?.name, 'ref');
  });

  test('a sibling folder sharing the prefix is NOT inside (separator-aware, not startsWith on the string)', () => {
    assert.equal(vaultContainingPath(`${root}x`, registry), null);
    assert.equal(vaultContainingPath(path.join(`${root}-other`, 'wiki'), registry), null);
  });

  test('`..` is resolved before comparing — a path that only LOOKS inside is not', () => {
    assert.equal(vaultContainingPath(path.join(root, 'wiki', '..', '..', 'elsewhere'), registry), null);
  });

  test('a path elsewhere, a remote vault (no folder), a malformed input — null', () => {
    assert.equal(vaultContainingPath(path.join(os.tmpdir(), 'nowhere'), registry), null);
    assert.equal(vaultContainingPath(root, { vaults: [{ name: 'remote', type: 'remote' }] }), null);
    assert.equal(vaultContainingPath('', registry), null);
    assert.equal(vaultContainingPath(undefined, registry), null);
    assert.equal(vaultContainingPath(root, {}), null);
  });

  test('Windows case folding: the same folder spelled in another case still matches', { skip: process.platform !== 'win32' }, () => {
    assert.equal(vaultContainingPath(path.join(root.toUpperCase(), 'wiki'), registry)?.name, 'ref');
  });
});

describe('isPromotionOfLockedSecondary', () => {
  test('true only for a vault the LIVE binding declares as an alsoLocked secondary', () => {
    const reg = { workspaceBinding: { vault: 'work', also: ['ref'] }, alsoWritable: [], alsoLocked: ['ref'] };
    assert.equal(isPromotionOfLockedSecondary('ref', reg), true);
    assert.equal(isPromotionOfLockedSecondary('work', reg), false, 'already the primary');
    assert.equal(isPromotionOfLockedSecondary('other', reg), false, 'not a secondary of this binding');
    assert.equal(isPromotionOfLockedSecondary('ref', { ...reg, alsoLocked: [] }), false, 'soft tier may be promoted');
    assert.equal(isPromotionOfLockedSecondary('ref', { alsoLocked: ['ref'] }), false, 'no binding — nothing to promote');
  });
});
