/**
 * config-merge.test.mjs — the rule that lets a process holding a SNAPSHOT of
 * the router config save it back without deleting somebody else's write.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN INTEGRATION TEST. The failure it guards
 * against is an interleaving: process A reads, process B writes, process A
 * saves. Reproducing that deterministically across two real processes needs a
 * seam in the middle of a CLI run, and a test that cannot reproduce it
 * reliably is worse than none — the first attempt at one planted the competing
 * write BEFORE the run, so the planted value was inside A's own snapshot and
 * survived with or without the merge. A mutation said so.
 *
 * The rule is a pure function of three JSON values, so it is tested as one.
 * `tests/attach-workspace.test.mjs` keeps the end-to-end smoke that the CLI
 * actually calls it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { snapshotConfig, mergeConfigOntoDisk } from '../src/helpers/config-merge.mjs';

/** The three inputs of every case: what was read, what is on disk now, what we save. */
const merge = (read, onDisk, next) => mergeConfigOntoDisk(next, onDisk, snapshotConfig(read));

describe('mergeConfigOntoDisk — a snapshot must not delete what another writer added', () => {
  test('a key this process never touched comes from the DISK, not from the snapshot', () => {
    // The defect, in one line. `setup-vault` reads the config, works for a few
    // seconds, and saves; a `confirm_workspace_binding` that landed in between
    // was in neither its snapshot nor its output, and disappeared.
    const read = { portRegistry: { a: 1 } };
    const onDisk = { portRegistry: { a: 1 }, workspaceBindings: { '/w': { vault: 'notes' } } };
    const next = { portRegistry: { a: 1, b: 2 } };
    assert.deepEqual(merge(read, onDisk, next), {
      portRegistry: { a: 1, b: 2 },
      workspaceBindings: { '/w': { vault: 'notes' } },
    });
  });

  test('a key this process CHANGED wins over the disk — that is what it is saving', () => {
    const read = { defaultVault: 'old' };
    const onDisk = { defaultVault: 'old' };
    assert.deepEqual(merge(read, onDisk, { defaultVault: 'new' }), { defaultVault: 'new' });
  });

  test('an API key another writer added to a key we DID change is still lost — and that is the lock\'s job', () => {
    // Stated rather than hidden: key granularity cannot combine two edits to
    // ONE key. Both writers taking the same lock around their own
    // read-modify-write is what covers that; this merge covers the case where
    // the lock is only around the write, which is the shape `setup-vault` has.
    const read = { portRegistry: { a: 1 } };
    const onDisk = { portRegistry: { a: 1, theirs: 9 } };
    assert.deepEqual(merge(read, onDisk, { portRegistry: { a: 2 } }), { portRegistry: { a: 2 } });
  });

  test('a key the caller REMOVED stays removed — a deletion is a change like any other', () => {
    const read = { portRegistry: {}, referenceVault: '/ref' };
    const onDisk = { portRegistry: {}, referenceVault: '/ref' };
    assert.deepEqual(merge(read, onDisk, { portRegistry: {} }), { portRegistry: {} });
  });

  test('a key that appeared on disk under a name this process never read is KEPT', () => {
    const read = { portRegistry: {} };
    const onDisk = { portRegistry: {}, brandNewKey: [1, 2] };
    assert.deepEqual(merge(read, onDisk, { portRegistry: { a: 1 } }), {
      portRegistry: { a: 1 }, brandNewKey: [1, 2],
    });
  });

  test('an unchanged nested object is not re-serialised from the snapshot — it comes from the disk WHOLE', () => {
    // The subtle half: `vaultNames` is untouched here, so the disk's newer
    // version of it must survive, not the one this process happens to hold.
    const read = { vaultNames: { '/a': 'a' } };
    const onDisk = { vaultNames: { '/a': 'a', '/b': 'b' } };
    assert.deepEqual(merge(read, onDisk, { vaultNames: { '/a': 'a' }, portStart: 27124 }), {
      vaultNames: { '/a': 'a', '/b': 'b' }, portStart: 27124,
    });
  });

  test('a key this process never touched, DELETED on disk, stays deleted', () => {
    // The mirror of the first case, and it was missing: the coverage only had
    // "a key appeared on disk". A merge that resurrected snapshot keys absent
    // from the disk would put back a vault the user had just removed in
    // another session — silently, from a process that never looked at it.
    // (Codex, round 5.)
    const read = { portRegistry: {}, referenceVault: '/ref' };
    const onDisk = { portRegistry: {} };
    assert.deepEqual(merge(read, onDisk, { portRegistry: { a: 1 }, referenceVault: '/ref' }), {
      portRegistry: { a: 1 },
    });
  });

  test('a key the caller removed stays removed EVEN IF the disk changed it meanwhile', () => {
    // The deletion is a change this process made, so it wins over the disk —
    // the same rule as any other changed key. The earlier test had the disk
    // value identical to the snapshot, so it could not tell "the caller's
    // deletion wins" from "nothing was different anyway". (Codex, round 5.)
    const read = { portRegistry: {}, referenceVault: '/ref' };
    const onDisk = { portRegistry: {}, referenceVault: '/somebody-else-changed-it' };
    assert.deepEqual(merge(read, onDisk, { portRegistry: {} }), { portRegistry: {} });
  });

  test('no snapshot means no merge — a bootstrap write has nothing it could be clobbering', () => {
    const next = { portRegistry: {} };
    assert.deepEqual(mergeConfigOntoDisk(next, { other: 1 }, null), next);
  });

  test('an unusable disk copy is not merged onto — the snapshot is the only config there is', () => {
    for (const onDisk of [null, undefined, 'text', [1, 2], 42]) {
      assert.deepEqual(merge({ a: 1 }, onDisk, { a: 2 }), { a: 2 }, JSON.stringify(onDisk));
    }
  });

  test('snapshotConfig survives anything a config file can hold', () => {
    assert.deepEqual(snapshotConfig(null), {});
    assert.deepEqual(snapshotConfig([1, 2]), {});
    assert.deepEqual(snapshotConfig('text'), {});
    assert.deepEqual(snapshotConfig({ a: undefined, b: 1 }), { a: undefined, b: '1' });
  });

  test('the snapshot is BY VALUE, so a caller mutating the object it was handed is still detected', () => {
    // The trap this exists for: `loadConfig` returns the parsed object and
    // every caller mutates it in place, so keeping a REFERENCE would compare
    // the snapshot against itself and conclude nothing ever changed — the
    // merge would then take every key from the disk and throw the process's
    // own work away, which is the same bug pointing the other way.
    const cfg = { portRegistry: { a: 1 } };
    const snapshot = snapshotConfig(cfg);
    cfg.portRegistry.b = 2; // the caller works on the object it was handed
    const merged = mergeConfigOntoDisk(cfg, { portRegistry: { a: 1 }, keep: true }, snapshot);
    assert.deepEqual(merged, { portRegistry: { a: 1, b: 2 }, keep: true });
  });
});
