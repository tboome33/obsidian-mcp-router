/**
 * Tests for src/helpers/click-to-open-walker.mjs — recursive path
 * discovery + URL map building. Covers nested shapes (Local REST API
 * search hits, smart-connections chunks), invalid candidates (URLs,
 * absolute paths), dedup, and the empty-result case.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { collectClickToOpenLinks } from '../src/helpers/click-to-open-walker.mjs';
import { _resetCache } from '../src/helpers/click-to-open.mjs';

let vaultPath;

before(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-vault-'));
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

const VAULT = () => ({ type: 'local', path: vaultPath, name: 'test' });

describe('collectClickToOpenLinks — shape coverage', () => {
  test('Local REST API /search/simple shape (array of {filename, matches})', () => {
    const payload = [
      { filename: 'wiki/foo.md', matches: [{ context: '...' }] },
      { filename: 'wiki/bar.md', matches: [{ context: '...' }] },
    ];
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result.clickToOpenLinks, {
      'wiki/foo.md': 'http://127.0.0.1:27142/open/wiki%2Ffoo.md',
      'wiki/bar.md': 'http://127.0.0.1:27142/open/wiki%2Fbar.md',
    });
  });

  test('smart-connections shape (chunks with `path` field)', () => {
    const payload = {
      chunks: [
        { path: 'wiki/Decisions/d1.md', score: 0.9, excerpt: '...' },
        { path: 'wiki/Refs/r1.md', score: 0.8, excerpt: '...' },
      ],
    };
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result.clickToOpenLinks, {
      'wiki/Decisions/d1.md': 'http://127.0.0.1:27142/open/wiki%2FDecisions%2Fd1.md',
      'wiki/Refs/r1.md': 'http://127.0.0.1:27142/open/wiki%2FRefs%2Fr1.md',
    });
  });

  test('mixed `filename` and `path` keys at any depth', () => {
    const payload = {
      perVault: [
        { vault: 'a', matches: [{ filename: 'x.md' }] },
        { vault: 'b', hits: { nested: { path: 'y.md' } } },
      ],
    };
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result.clickToOpenLinks, {
      'x.md': 'http://127.0.0.1:27142/open/x.md',
      'y.md': 'http://127.0.0.1:27142/open/y.md',
    });
  });

  test('deduplicates repeated paths', () => {
    const payload = [
      { filename: 'wiki/foo.md' },
      { filename: 'wiki/foo.md' },
      { path: 'wiki/foo.md' },
    ];
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.equal(Object.keys(result.clickToOpenLinks).length, 1);
    assert.equal(
      result.clickToOpenLinks['wiki/foo.md'],
      'http://127.0.0.1:27142/open/wiki%2Ffoo.md',
    );
  });
});

describe('collectClickToOpenLinks — rejected candidates', () => {
  test('rejects URLs in path-like fields', () => {
    const payload = { path: 'https://example.com/foo.md' };
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result, {});
  });

  test('rejects absolute POSIX paths', () => {
    const payload = { filename: '/etc/passwd' };
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result, {});
  });

  test('rejects absolute Windows paths (drive letter)', () => {
    const payload = { filename: 'C:\\Users\\someone\\foo.md' };
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result, {});
  });

  test('rejects empty strings', () => {
    const payload = { filename: '' };
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result, {});
  });

  test('rejects non-string values in path-like fields', () => {
    const payload = { filename: 42, path: null, file: { nested: true } };
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result, {});
  });
});

describe('collectClickToOpenLinks — edge cases', () => {
  test('empty payload returns empty object (no clickToOpenLinks key)', () => {
    assert.deepEqual(collectClickToOpenLinks(VAULT(), []), {});
    assert.deepEqual(collectClickToOpenLinks(VAULT(), {}), {});
    assert.deepEqual(collectClickToOpenLinks(VAULT(), null), {});
    assert.deepEqual(collectClickToOpenLinks(VAULT(), undefined), {});
  });

  test('null vault returns empty object', () => {
    const payload = [{ filename: 'foo.md' }];
    assert.deepEqual(collectClickToOpenLinks(null, payload), {});
  });

  test('remote vault returns empty object (no URLs buildable)', () => {
    const payload = [{ filename: 'foo.md' }];
    const remote = { type: 'remote', baseUrl: 'https://example.com', name: 'r' };
    assert.deepEqual(collectClickToOpenLinks(remote, payload), {});
  });

  test('depth limit prevents infinite recursion on cycles', () => {
    // Build a cyclic structure — walker must not blow the stack.
    const a = { filename: 'a.md', child: null };
    const b = { filename: 'b.md', child: a };
    a.child = b;
    // Should not throw; result includes a + b (depth limit cuts further recursion).
    const result = collectClickToOpenLinks(VAULT(), a);
    assert.ok(result.clickToOpenLinks);
    assert.equal(
      result.clickToOpenLinks['a.md'],
      'http://127.0.0.1:27142/open/a.md',
    );
    assert.equal(
      result.clickToOpenLinks['b.md'],
      'http://127.0.0.1:27142/open/b.md',
    );
  });
});
