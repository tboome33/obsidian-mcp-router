/**
 * v0.106.0 — `unregister_vault`, the other half of register_remote_vault:
 * take a vault out of the router config from a conversation or the vault
 * panel's administration console.
 *
 * Every test drives the tool through injected read/write seams, as the
 * register_remote_vault tests do. Nothing here touches a real config file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { unregisterVaultTool } from '../src/tools/unregister-vault.mjs';

const CONFIG_PATH = path.join('/cfg', 'config.json');
const registry = { configPath: CONFIG_PATH };

// One remote entry, one local vault found by its folder, and a binding.
const BASE = {
  vaultsById: { 'id-notes': { path: 'C:\\VAULTS\\Notes', ports: { https: 27140, http: 27141 } } },
  vaultNames: { 'C:\\VAULTS\\Notes': 'notes' },
  remoteVaults: [
    { name: 'Remote-A', baseUrl: 'http://10.8.0.1:27180', apiKey: 'KEY-A' },
    { name: 'remote-b', baseUrl: 'http://10.8.0.1:27181', apiKey: 'KEY-B' },
  ],
  openVaults: ['Remote-A', 'notes'],
  disabledVaults: ['old'],
  workspaceBindings: {},
};

function seams(config) {
  const written = [];
  return {
    written,
    seam: {
      readFile: () => JSON.stringify(config),
      writeFile: (p, c) => written.push({ path: p, config: JSON.parse(c) }),
    },
  };
}

describe('unregister_vault', () => {
  test('a remoteVaults entry is deleted with its key, and dropped from openVaults; nothing else moves', async () => {
    const { written, seam } = seams(BASE);
    const out = await unregisterVaultTool(registry, { name: 'remote-a' }, seam);
    assert.equal(out.unregistered, true);
    assert.equal(out.name, 'Remote-A');
    assert.equal(out.removedFrom, 'remoteVaults');
    assert.equal(written.length, 1);
    assert.equal(written[0].path, CONFIG_PATH);
    const cfg = written[0].config;
    assert.deepEqual(cfg.remoteVaults.map((r) => r.name), ['remote-b']);
    assert.equal(JSON.stringify(cfg).includes('KEY-A'), false, 'the removed key is gone from the file');
    assert.deepEqual(cfg.openVaults, ['notes']);
    assert.deepEqual(cfg.disabledVaults, ['old']);
    assert.deepEqual(cfg.vaultsById, BASE.vaultsById);
  });

  test('a local vault found by its folder is disabled, not deleted — its entry stays', async () => {
    const { written, seam } = seams(BASE);
    const out = await unregisterVaultTool(registry, { name: 'NOTES' }, seam);
    assert.equal(out.removedFrom, 'disabledVaults');
    assert.equal(out.name, 'notes');
    assert.match(out.message, /disabledVaults/);
    const cfg = written[0].config;
    assert.deepEqual(cfg.disabledVaults, ['old', 'notes']);
    assert.deepEqual(cfg.vaultsById, BASE.vaultsById, 'the folder entry is kept');
    assert.deepEqual(cfg.openVaults, ['Remote-A']);
    assert.equal(cfg.remoteVaults.length, 2);
  });

  test('a local vault disabled under another casing gets its exact name: the loader compares exactly', async () => {
    const { written, seam } = seams({ ...BASE, disabledVaults: ['NOTES'] });
    await unregisterVaultTool(registry, { name: 'notes' }, seam);
    assert.deepEqual(written[0].config.disabledVaults, ['NOTES', 'notes']);
  });

  test('a local vault already disabled is not listed twice', async () => {
    const { written, seam } = seams({ ...BASE, disabledVaults: ['notes'] });
    await unregisterVaultTool(registry, { name: 'notes' }, seam);
    assert.deepEqual(written[0].config.disabledVaults, ['notes']);
  });

  test('refused, with nothing written, while a workspace binding names it — primary or secondary', async () => {
    for (const binding of [{ vault: 'remote-b', also: [] }, { vault: 'other', also: ['REMOTE-B'] }]) {
      const { written, seam } = seams({ ...BASE, workspaceBindings: { 'i:\\projets\\x': binding } });
      await assert.rejects(
        unregisterVaultTool(registry, { name: 'remote-b' }, seam),
        /still bound to 1 workspace\(s\) \("i:\\projets\\x"\) — nothing was changed/,
      );
      assert.equal(written.length, 0);
    }
  });

  test('an unknown name, a missing name or a missing config path is refused and writes nothing', async () => {
    const { written, seam } = seams(BASE);
    await assert.rejects(unregisterVaultTool(registry, { name: 'ghost' }, seam), /is not a registered vault — nothing was changed/);
    await assert.rejects(unregisterVaultTool(registry, { name: '  ' }, seam), /requires `name`/);
    await assert.rejects(unregisterVaultTool({}, { name: 'remote-b' }, seam), /no config path/);
    assert.equal(written.length, 0);
  });
});
