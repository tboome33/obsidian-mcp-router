/**
 * v0.101.0 — `list_vaults.workspaceBindingOnFile` + `ifBindingDigest`: a
 * compare-and-set on the workspace binding.
 *
 * The vault panel rewrites the binding from a button: it reads the entry,
 * computes a new `also`, writes `{ vault, also }`. Without a precondition, a
 * sibling session that changed the entry between that read and the write was
 * overwritten in silence (Codex, review of PR #16, round 3). The precondition
 * already existed for the repair calls (`ifBindingDigest`, checked inside the
 * config write lock); what was missing was a READ that hands out the digest
 * together with the values it was taken on. `bindingOnFile` is that read, and
 * these tests drive it against the real tool, through the same seams
 * workspace-binding-tool.test.mjs uses: nothing here touches a real config.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { bindingOnFile } from '../src/tools/list-vaults.mjs';
import { confirmWorkspaceBinding } from '../src/tools/workspace-binding.mjs';
import { canonicalWorkspaceKey, readBinding, WORKSPACE_BINDINGS_KEY } from '../src/helpers/workspace-bindings.mjs';

const CWD = process.cwd();
const CONFIG_PATH = path.join('/cfg', 'config.json');

const registry = () => ({
  configPath: CONFIG_PATH,
  vaults: [
    { name: 'notes', type: 'local', path: '/v/Notes' },
    { name: 'work', type: 'local', path: '/v/Work' },
    { name: 'ref', type: 'local', path: '/v/Ref' },
  ],
});

/** A config file held in memory: the tool and `bindingOnFile` read the same object. */
function disk(binding) {
  const file = {
    config: {
      portRegistry: { '/v/Notes': 27124, '/v/Work': 27125, '/v/Ref': 27126 },
      ...(binding ? { [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: binding } } : {}),
    },
    writes: 0,
  };
  const readFile = () => JSON.stringify(file.config);
  const seam = {
    cwd: CWD,
    readFile,
    writeFile: (_p, c) => {
      file.config = JSON.parse(c);
      file.writes += 1;
    },
    ping: async () => ({ online: true, identity: 'confirmed' }),
    launch: () => ({ launched: false, uri: null, reason: 'test' }),
  };
  // A sibling session's own write, straight into the file.
  const sibling = (next) => {
    file.config = { ...file.config, [WORKSPACE_BINDINGS_KEY]: { [canonicalWorkspaceKey(CWD)]: next } };
  };

  return { file, seam, read: () => bindingOnFile(CONFIG_PATH, { cwd: CWD, readFile }), sibling };
}

const BOUND = { vault: 'notes', also: ['work'], locked: false, confirmedVia: 'tool' };

describe('bindingOnFile — the entry as the file holds it, read once', () => {
  test('a bound workspace: its vault, its also, and a digest', () => {
    const { read } = disk(BOUND);
    const onFile = read();
    assert.equal(onFile.vault, 'notes');
    assert.deepEqual(onFile.also, ['work']);
    assert.match(onFile.digest, /^[0-9a-f]{64}$/);
  });

  test('an unbound workspace still has a digest: "still unbound" is a precondition too', () => {
    const { read } = disk(null);
    const onFile = read();
    assert.equal(onFile.vault, null);
    assert.deepEqual(onFile.also, []);
    assert.match(onFile.digest, /^[0-9a-f]{64}$/);
    assert.notEqual(onFile.digest, disk(BOUND).read().digest);
  });

  test('the digest moves with the entry', () => {
    const { read, sibling } = disk(BOUND);
    const before = read().digest;
    sibling({ ...BOUND, also: [] });
    assert.notEqual(read().digest, before);
  });

  test('other stored spellings of the workspace are counted, since the digest does not cover them', () => {
    const { read } = disk(BOUND);
    assert.equal(read().aliases, 0);
    // A hand edit: the same directory once more, under a non-canonical spelling.
    const key = canonicalWorkspaceKey(CWD);
    const alias = `${key}${path.sep}`;
    assert.notEqual(alias, key);
    assert.equal(canonicalWorkspaceKey(alias), key, 'the fixture must spell the SAME workspace');
    const readFile = () => JSON.stringify({ [WORKSPACE_BINDINGS_KEY]: { [key]: BOUND, [alias]: { ...BOUND, also: [] } } });
    assert.equal(bindingOnFile(CONFIG_PATH, { cwd: CWD, readFile }).aliases, 1);
  });

  test('no config path, or a file that cannot be read: null, never a throw', () => {
    assert.equal(bindingOnFile(undefined), null);
    assert.equal(bindingOnFile(CONFIG_PATH, { cwd: CWD, readFile: () => { throw new Error('ENOENT'); } }), null);
    assert.equal(bindingOnFile(CONFIG_PATH, { cwd: CWD, readFile: () => '{not json' }), null);
  });
});

describe('workspaceBindingOnFile.digest as ifBindingDigest — a compare-and-set', () => {
  test('nobody changed the entry: the write computed from it lands', async () => {
    const { file, seam, read } = disk(BOUND);
    const onFile = read();
    await confirmWorkspaceBinding(
      registry(),
      { vault: onFile.vault, also: [...onFile.also, 'ref'], ifBindingDigest: onFile.digest },
      seam,
    );
    assert.equal(file.writes, 1);
    assert.deepEqual(readBinding(file.config, CWD).also, ['work', 'ref']);
  });

  test('a sibling changed the entry after the read: refused, and its work survives', async () => {
    const { file, seam, read, sibling } = disk(BOUND);
    const onFile = read();
    // Between the panel's read and its write, another session drops `work`
    // and locks the workspace.
    sibling({ ...BOUND, also: [], locked: true });
    await assert.rejects(
      confirmWorkspaceBinding(
        registry(),
        { vault: onFile.vault, also: [...onFile.also, 'ref'], ifBindingDigest: onFile.digest },
        seam,
      ),
      /binding entry now differs/,
    );
    assert.equal(file.writes, 0);
    const kept = readBinding(file.config, CWD);
    assert.deepEqual(kept.also, []);
    assert.equal(kept.locked, true);
  });

  test('a workspace bound by a sibling after an unbound read: the stale primary pick is refused', async () => {
    const { file, seam, read, sibling } = disk(null);
    const onFile = read();
    sibling({ vault: 'work', also: [], locked: false, confirmedVia: 'tool' });
    await assert.rejects(
      confirmWorkspaceBinding(registry(), { vault: 'notes', ifBindingDigest: onFile.digest }, seam),
      /binding entry now differs/,
    );
    assert.equal(file.writes, 0);
    assert.equal(readBinding(file.config, CWD).vault, 'work');
  });
});
