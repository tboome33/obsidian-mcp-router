/**
 * Tests for MCP Resources (v0.20.0, MCP standard #6) — src/resources.mjs.
 *
 * Pure logic only (URI build/parse, list shape, catalogue JSON, readResource
 * with an injected REST read returning a string). No network, no real server.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESOURCE_SCHEME,
  CATALOG_URI,
  VAULT_RESOURCE_FILES,
  buildResourceUri,
  parseResourceUri,
  buildResourceList,
  buildVaultCatalog,
  readResource,
} from '../src/resources.mjs';

const fakeVaults = [
  { name: 'dedibox', type: 'remote', baseUrl: 'http://10.8.0.10:27161', apiKey: 'SECRET1', description: 'infra' },
  { name: 'smile', type: 'local', baseUrl: 'https://127.0.0.1:27129', apiKey: 'SECRET2' },
];

describe('buildResourceUri / parseResourceUri — round trip', () => {
  test('catalog URI parses to { catalog: true }', () => {
    assert.deepEqual(parseResourceUri(CATALOG_URI), { catalog: true });
  });

  test('vault/id round-trips', () => {
    const uri = buildResourceUri('dedibox', 'wiki-index');
    assert.equal(uri, `${RESOURCE_SCHEME}://dedibox/wiki-index`);
    assert.deepEqual(parseResourceUri(uri), { vault: 'dedibox', id: 'wiki-index' });
  });

  test('vault names with spaces are percent-encoded and decode back', () => {
    const uri = buildResourceUri('opsidian-mcp-router et bridge', 'wiki-overview');
    assert.match(uri, /et%20bridge/);
    assert.deepEqual(parseResourceUri(uri), {
      vault: 'opsidian-mcp-router et bridge',
      id: 'wiki-overview',
    });
  });

  test('non-matching / malformed URIs return null', () => {
    assert.equal(parseResourceUri('https://example.com/x'), null);
    assert.equal(parseResourceUri('obsidian-router://novault'), null); // no slash → no id
    assert.equal(parseResourceUri('obsidian-router:///wiki-index'), null); // empty vault
    assert.equal(parseResourceUri(null), null);
    assert.equal(parseResourceUri(42), null);
  });
});

describe('buildResourceList', () => {
  test('one catalogue + two scaffold pages per vault', () => {
    const list = buildResourceList(fakeVaults);
    assert.equal(list.length, 1 + fakeVaults.length * VAULT_RESOURCE_FILES.length);
    assert.equal(list[0].uri, CATALOG_URI);
    assert.equal(list[0].mimeType, 'application/json');
    for (const r of list.slice(1)) {
      assert.equal(r.mimeType, 'text/markdown');
      assert.ok(parseResourceUri(r.uri));
    }
  });

  test('empty vault set → just the catalogue', () => {
    const list = buildResourceList([]);
    assert.equal(list.length, 1);
    assert.equal(list[0].uri, CATALOG_URI);
  });
});

describe('buildVaultCatalog — never leaks secrets', () => {
  test('includes name/type/baseUrl, EXCLUDES apiKey', () => {
    const json = buildVaultCatalog(fakeVaults);
    assert.doesNotMatch(json, /SECRET1/);
    assert.doesNotMatch(json, /SECRET2/);
    assert.doesNotMatch(json, /apiKey/);
    const parsed = JSON.parse(json);
    assert.equal(parsed.vaults.length, 2);
    assert.equal(parsed.vaults[0].name, 'dedibox');
    assert.equal(parsed.vaults[0].type, 'remote');
    assert.equal(parsed.vaults[0].baseUrl, 'http://10.8.0.10:27161');
    assert.equal(parsed.vaults[0].description, 'infra');
  });
});

describe('readResource', () => {
  const registry = {
    vaults: fakeVaults,
    resolveVault(name) {
      const v = fakeVaults.find((x) => x.name === name);
      if (!v) throw new Error(`Unknown vault "${name}".`);
      return v;
    },
  };

  test('catalog URI returns the JSON catalogue', async () => {
    const res = await readResource(CATALOG_URI, registry, async () => {
      throw new Error('readFile must not be called for the catalogue');
    });
    assert.equal(res.contents[0].uri, CATALOG_URI);
    assert.equal(res.contents[0].mimeType, 'application/json');
    assert.ok(JSON.parse(res.contents[0].text).vaults);
  });

  test('vault page calls readFile(vault, path) and returns its string content', async () => {
    const calls = [];
    const res = await readResource(
      buildResourceUri('dedibox', 'wiki-index'),
      registry,
      async (vault, path) => {
        calls.push([vault.name, path]);
        return '# Index of dedibox';
      },
    );
    assert.deepEqual(calls, [['dedibox', 'wiki-meta/index.md']]);
    assert.equal(res.contents[0].mimeType, 'text/markdown');
    assert.equal(res.contents[0].text, '# Index of dedibox');
  });

  test('wiki-overview maps to wiki-meta/overview.md', async () => {
    let readPath = null;
    await readResource(
      buildResourceUri('smile', 'wiki-overview'),
      registry,
      async (_v, path) => {
        readPath = path;
        return 'ok';
      },
    );
    assert.equal(readPath, 'wiki-meta/overview.md');
  });

  test('unknown URI throws a clear error', async () => {
    await assert.rejects(
      () => readResource('https://nope/', registry, async () => ''),
      /Unknown resource URI/,
    );
  });

  test('unknown resource id throws', async () => {
    await assert.rejects(
      () => readResource(buildResourceUri('dedibox', 'bogus'), registry, async () => ''),
      /Unknown resource id/,
    );
  });

  test('unknown vault propagates resolveVault error', async () => {
    await assert.rejects(
      () => readResource(buildResourceUri('ghost', 'wiki-index'), registry, async () => ''),
      /Unknown vault/,
    );
  });
});
