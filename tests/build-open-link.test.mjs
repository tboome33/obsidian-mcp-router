/**
 * Tests for src/tools/build-open-link.mjs — the read-only MCP tool that
 * builds click-to-open URLs without touching vault files.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildOpenLinkTool } from '../src/tools/build-open-link.mjs';
import { _resetCache } from '../src/helpers/click-to-open.mjs';

let vaultPath;

before(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bol-vault-'));
  const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'data.json'),
    JSON.stringify({ insecurePort: 27142, enableInsecureServer: true }),
  );
});

after(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

beforeEach(() => {
  _resetCache();
});

// Mock registry returning the local vault. The tool only uses
// `registry.resolveVault(name)`.
function makeRegistry(vault = { type: 'local', path: vaultPath, name: 'test' }) {
  return {
    resolveVault(name) {
      return vault;
    },
    defaultVault: 'test',
  };
}

describe('buildOpenLinkTool — single mode', () => {
  test('returns URL + markdown link for a single path', async () => {
    const result = await buildOpenLinkTool(makeRegistry(), {
      path: 'wiki/Divers/foo.md',
    });
    assert.equal(result.vault, 'test');
    assert.equal(result.path, 'wiki/Divers/foo.md');
    assert.equal(
      result.clickToOpenUrl,
      'http://127.0.0.1:27142/open/wiki%2FDivers%2Ffoo.md',
    );
    assert.equal(
      result.markdownLink,
      '[foo](http://127.0.0.1:27142/open/wiki%2FDivers%2Ffoo.md)',
    );
  });

  test('null URL when insecure server disabled (no markdownLink in result)', async () => {
    fs.writeFileSync(
      path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ insecurePort: 27142, enableInsecureServer: false }),
    );
    _resetCache();
    const result = await buildOpenLinkTool(makeRegistry(), {
      path: 'wiki/foo.md',
    });
    assert.equal(result.clickToOpenUrl, null);
    assert.ok(!('markdownLink' in result));
    // restore for downstream tests
    fs.writeFileSync(
      path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ insecurePort: 27142, enableInsecureServer: true }),
    );
    _resetCache();
  });
});

describe('buildOpenLinkTool — anchor (v0.22.0)', () => {
  test('emits ?h=<heading> and echoes the anchor', async () => {
    const result = await buildOpenLinkTool(makeRegistry(), {
      path: 'wiki/Divers/foo.md',
      anchor: 'Installation',
    });
    assert.equal(
      result.clickToOpenUrl,
      'http://127.0.0.1:27142/open/wiki%2FDivers%2Ffoo.md?h=Installation',
    );
    assert.equal(result.anchor, 'Installation');
    assert.equal(
      result.markdownLink,
      '[foo](http://127.0.0.1:27142/open/wiki%2FDivers%2Ffoo.md?h=Installation)',
    );
  });

  test('strips a leading # from the anchor', async () => {
    const result = await buildOpenLinkTool(makeRegistry(), {
      path: 'wiki/foo.md',
      anchor: '#Section 2',
    });
    assert.equal(
      result.clickToOpenUrl,
      'http://127.0.0.1:27142/open/wiki%2Ffoo.md?h=Section%202',
    );
  });

  test('URL-encodes spaces and accents in the heading', async () => {
    const result = await buildOpenLinkTool(makeRegistry(), {
      path: 'wiki/foo.md',
      anchor: 'Été & coûts',
    });
    assert.equal(
      result.clickToOpenUrl,
      `http://127.0.0.1:27142/open/wiki%2Ffoo.md?h=${encodeURIComponent('Été & coûts')}`,
    );
  });

  test('empty / whitespace anchor → no query param, no anchor field', async () => {
    const result = await buildOpenLinkTool(makeRegistry(), {
      path: 'wiki/foo.md',
      anchor: '   ',
    });
    assert.equal(result.clickToOpenUrl, 'http://127.0.0.1:27142/open/wiki%2Ffoo.md');
    assert.ok(!('anchor' in result) || result.anchor === undefined);
  });

  test('rejects anchor in batch mode', async () => {
    await assert.rejects(
      () => buildOpenLinkTool(makeRegistry(), { paths: ['a.md', 'b.md'], anchor: 'X' }),
      /anchor.*only supported.*single/i,
    );
  });

  test('rejects non-string anchor', async () => {
    await assert.rejects(
      () => buildOpenLinkTool(makeRegistry(), { path: 'a.md', anchor: 42 }),
      /anchor.*must be a string/i,
    );
  });

  test('markdownLink stays valid when the heading contains ) (codex P2)', async () => {
    const result = await buildOpenLinkTool(makeRegistry(), {
      path: 'wiki/foo.md',
      anchor: 'Step 1) Setup',
    });
    // The ) is %29-encoded so the [..](..) destination doesn't terminate early.
    assert.equal(
      result.markdownLink,
      '[foo](http://127.0.0.1:27142/open/wiki%2Ffoo.md?h=Step%201%29%20Setup)',
    );
    assert.ok(!result.markdownLink.includes(') Setup'), 'an unescaped ) would break the markdown link');
  });
});

describe('buildOpenLinkTool — batch mode', () => {
  test('returns one entry per path', async () => {
    const result = await buildOpenLinkTool(makeRegistry(), {
      paths: ['wiki/foo.md', 'wiki/Divers/bar.md', 'wiki-meta/index.md'],
    });
    assert.equal(result.vault, 'test');
    assert.equal(result.links.length, 3);
    assert.equal(result.links[0].path, 'wiki/foo.md');
    assert.equal(
      result.links[0].clickToOpenUrl,
      'http://127.0.0.1:27142/open/wiki%2Ffoo.md',
    );
    assert.equal(result.links[1].path, 'wiki/Divers/bar.md');
    assert.equal(
      result.links[2].clickToOpenUrl,
      'http://127.0.0.1:27142/open/wiki-meta%2Findex.md',
    );
  });

  test('empty paths array returns empty links array', async () => {
    const result = await buildOpenLinkTool(makeRegistry(), { paths: [] });
    assert.deepEqual(result.links, []);
  });

  test('rejects non-string path in batch', async () => {
    await assert.rejects(
      () => buildOpenLinkTool(makeRegistry(), { paths: ['ok.md', 42, 'also.md'] }),
      /paths\[1\] must be a non-empty string/,
    );
  });

  test('rejects empty string path in batch', async () => {
    await assert.rejects(
      () => buildOpenLinkTool(makeRegistry(), { paths: ['', 'ok.md'] }),
      /paths\[0\] must be a non-empty string/,
    );
  });
});

describe('buildOpenLinkTool — argument validation', () => {
  test('rejects when neither path nor paths provided', async () => {
    await assert.rejects(
      () => buildOpenLinkTool(makeRegistry(), {}),
      /provide .*path.* or .*paths/i,
    );
  });

  test('rejects when both path and paths provided', async () => {
    await assert.rejects(
      () => buildOpenLinkTool(makeRegistry(), { path: 'a.md', paths: ['b.md'] }),
      /not both/,
    );
  });
});
