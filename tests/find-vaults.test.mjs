/**
 * The vaults on this machine the router does not know yet, and adding one
 * (src/helpers/find-vaults.mjs, scripts/find-vaults.mjs): what the vault
 * panel's first-run screen offers in one click.
 *
 * The property that matters most: a folder's Local REST API key is read to
 * ask its address, and written into the router's config — it never appears in
 * what the script prints for the panel.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { adoptFoundVault, findVaults, probeAddress, scanRoots } from '../src/helpers/find-vaults.mjs';
import { run } from '../scripts/find-vaults.mjs';

const KEY = 'secret-key-of-games-0123456789abcdef';

function vault(dir, { key = null, plugins = ['obsidian-local-rest-api'], port = 27187, wiki = false } = {}) {
  fs.mkdirSync(path.join(dir, '.obsidian', 'plugins'), { recursive: true });
  for (const id of plugins) fs.mkdirSync(path.join(dir, '.obsidian', 'plugins', id), { recursive: true });
  if (key) {
    fs.writeFileSync(
      path.join(dir, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: key, port, insecurePort: 27186, enableInsecureServer: false }),
    );
  }
  if (wiki) fs.mkdirSync(path.join(dir, 'wiki-meta'), { recursive: true });
}

describe('findVaults', () => {
  let tmp;
  let cfg;
  let workspace;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'find-vaults-'));
    const vaults = path.join(tmp, 'common', 'Vaults');
    workspace = path.join(tmp, 'common', 'Projets', 'games.kiviri.fr');
    fs.mkdirSync(workspace, { recursive: true });
    vault(path.join(vaults, 'games.kiviri.fr'), { key: KEY });
    vault(path.join(vaults, 'notes'), { key: 'other-key', plugins: ['obsidian-local-rest-api', 'mcp-router-bridge'], wiki: true });
    vault(path.join(vaults, 'known-local'), { key: 'k2' });
    vault(path.join(vaults, 'known-remote'), { key: 'k3' });
    fs.mkdirSync(path.join(vaults, 'not-a-vault'), { recursive: true });
    cfg = {
      portRegistry: { [path.join(vaults, 'known-local')]: 27200 },
      remoteVaults: [{ name: 'known-remote', baseUrl: 'http://10.8.0.1:27185', apiKey: 'k3', localPath: path.join(vaults, 'known-remote') }],
    };
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('looks beside the project and where the known vaults live', () => {
    const roots = scanRoots(cfg, workspace);
    assert.ok(roots.includes(path.join(tmp, 'common', 'Vaults')), roots.join(' | '));
    assert.equal(new Set(roots.map((r) => r.toLowerCase())).size, roots.length, 'no root twice');
  });

  test('lists only the folders the router does not know, with the address that accepts their own key', async () => {
    const asked = [];
    const probe = async ({ baseUrl, apiKey }) => {
      asked.push(baseUrl);
      if (apiKey === KEY && baseUrl === 'https://10.8.0.1:27187') return 'accepted';
      if (apiKey === 'other-key' && baseUrl.startsWith('https://127.0.0.1')) return 'refused';
      return 'unreachable';
    };
    const { vaults } = await findVaults({ cfg, workspace }, { probe });
    assert.deepEqual(vaults.map((v) => v.name).sort(), ['games.kiviri.fr', 'notes']);
    const games = vaults.find((v) => v.name === 'games.kiviri.fr');
    assert.deepEqual(games.address, { baseUrl: 'https://10.8.0.1:27187', tlsInsecure: true, isLocal: false });
    assert.equal(games.key, 'accepted');
    assert.equal(games.hasWiki, false);
    assert.deepEqual(games.missingPlugins, ['mcp-router-bridge']);
    const notes = vaults.find((v) => v.name === 'notes');
    assert.equal(notes.address, null);
    assert.equal(notes.key, 'refused');
    assert.equal(notes.hasWiki, true);
    assert.ok(asked.includes('https://127.0.0.1:27187'), 'the loopback is asked first');
    assert.ok(!JSON.stringify(vaults).includes(KEY), 'no key in the answer');
  });

  test('the script prints no key either', async () => {
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    const answer = await run(['scan', '--config', configPath, '--workspace', workspace], { probe: async () => 'accepted' });
    assert.equal(answer.vaults.length, 2);
    assert.ok(!JSON.stringify(answer).includes(KEY));
    assert.equal(typeof answer.platform, 'string');
  });
});

describe('adoptFoundVault', () => {
  let tmp;
  let folder;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-vault-'));
    folder = path.join(tmp, 'games.kiviri.fr');
    vault(folder, { key: KEY });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('registers the remote address with the key read from the folder, and the folder as its local path', async () => {
    let sent = null;
    const result = await adoptFoundVault(
      { configPath: path.join(tmp, 'config.json'), folder, baseUrl: 'https://10.8.0.1:27187' },
      { probe: async () => 'accepted', register: async (_reg, args) => ((sent = args), { registered: true, name: args.name }) },
    );
    assert.equal(result.name, 'games.kiviri.fr');
    assert.equal(sent.apiKey, KEY);
    assert.equal(sent.baseUrl, 'https://10.8.0.1:27187');
    assert.equal(sent.tlsInsecure, true);
    assert.equal(sent.localPath, folder);
  });

  test('writes a real entry into the config file', async () => {
    const configPath = path.join(tmp, 'real-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ remoteVaults: [] }));
    await adoptFoundVault({ configPath, folder, baseUrl: 'https://10.8.0.1:27187' }, { probe: async () => 'accepted' });
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(written.remoteVaults.length, 1);
    assert.equal(written.remoteVaults[0].name, 'games.kiviri.fr');
    assert.equal(written.remoteVaults[0].apiKey, KEY);
    assert.equal(written.remoteVaults[0].localPath, folder);
  });

  test('refuses an address that no longer accepts the key, and a loopback one', async () => {
    const register = async () => assert.fail('nothing is registered');
    await assert.rejects(
      adoptFoundVault({ configPath: 'x', folder, baseUrl: 'https://10.8.0.1:27187' }, { probe: async () => 'refused', register }),
      /refuses the key/,
    );
    await assert.rejects(
      adoptFoundVault({ configPath: 'x', folder, baseUrl: 'https://127.0.0.1:27187' }, { probe: async () => 'accepted', register }),
      /local vault/,
    );
  });
});

describe('probeAddress', () => {
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'OK', authenticated: req.headers.authorization === `Bearer ${KEY}` }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('accepted with the right key, refused with another, unreachable where nothing listens', async () => {
    assert.equal(await probeAddress({ baseUrl: base, apiKey: KEY, tlsInsecure: false }), 'accepted');
    assert.equal(await probeAddress({ baseUrl: base, apiKey: 'wrong', tlsInsecure: false }), 'refused');
    assert.equal(await probeAddress({ baseUrl: 'http://127.0.0.1:1', apiKey: KEY, tlsInsecure: false }), 'unreachable');
  });
});
