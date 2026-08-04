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

describe('collectClickToOpenLinks — dynamic keys are vault paths', () => {
  test('PIN: a file named exactly `__proto__` still gets its link', () => {
    // The map was built with `links[p] = url`. Only the key `__proto__` ITSELF
    // hits Object.prototype's inherited accessor instead of creating an own
    // property, so that entry vanished — a real file silently lost its
    // click-to-open link.
    //
    // The first version of this test used `wiki/__proto__.md`, which is NOT the
    // string `__proto__` and therefore passed against the unfixed code: it
    // pinned nothing. The triggering key is the WHOLE path, so it only bites a
    // vault-root file with no extension. Verified by reverting the fix and
    // watching this assertion fail.
    const payload = [
      { filename: '__proto__', matches: [{ context: '...' }] },
      { filename: 'wiki/normal.md', matches: [{ context: '...' }] },
    ];
    const result = collectClickToOpenLinks(VAULT(), payload);
    const links = result.clickToOpenLinks ?? {};
    assert.ok(
      Object.prototype.hasOwnProperty.call(links, '__proto__'),
      `\`__proto__\` lost its link; keys were ${JSON.stringify(Object.keys(links))}`,
    );
    assert.equal(Object.keys(links).length, 2, 'both files must be linked');
    assert.equal(
      JSON.parse(JSON.stringify(result)).clickToOpenLinks.__proto__,
      links.__proto__,
      'must survive a JSON round-trip',
    );
  });

  test('PIN: a nested path containing `__proto__` is unaffected (non-regression)', () => {
    // Guards the boundary the test above establishes: `wiki/__proto__.md` was
    // never broken (only the WHOLE path `__proto__` hits the inherited
    // accessor), and must keep working after the `Object.fromEntries` fix.
    const result = collectClickToOpenLinks(VAULT(), [{ filename: 'wiki/__proto__.md' }]);
    assert.equal(
      result.clickToOpenLinks['wiki/__proto__.md'],
      'http://127.0.0.1:27142/open/wiki%2F__proto__.md',
    );
  });
});

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

  test('v0.14.9: rejects Windows UNC paths (\\\\server\\share\\...)', () => {
    // Reviewer B P2: previously these were normalised to "server/share/..."
    // and emitted a plausible-looking but wrong URL.
    const payload = { path: '\\\\server\\share\\note.md' };
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result, {});
  });

  test('v0.14.9: rejects extended-length Windows prefix (\\\\?\\C:\\path)', () => {
    const payload = { filename: '\\\\?\\C:\\notes\\foo.md' };
    const result = collectClickToOpenLinks(VAULT(), payload);
    assert.deepEqual(result, {});
  });

  test('v0.14.9: rejects path-traversal attempts (..)', () => {
    // Reviewer A IMPORTANT-3: defence-in-depth, even though the bridge
    // would (usually) clamp at vault root.
    const cases = [
      '../sensitive.md',
      'wiki/../../etc/passwd',
      '../../secrets.md',
      'wiki/../foo.md',          // trailing-segment traversal
      '..',                       // pure traversal
      '..\\sensitive.md',         // Windows-style
    ];
    for (const p of cases) {
      const payload = { path: p };
      const result = collectClickToOpenLinks(VAULT(), payload);
      assert.deepEqual(result, {}, `should reject path-traversal: ${p}`);
    }
  });

  test('v0.14.9 pass-2: ALLOWS legitimate dot-pairs in filename/folder', () => {
    // Reviewer B P3 + Reviewer A NIT-1 convergent: substring match was
    // over-rejecting valid Obsidian filenames. Switched to a segment-aware
    // regex — these MUST now produce URLs.
    const cases = [
      'wiki/release..notes.md',           // dots in filename
      'wiki/..hidden.md',                  // leading dots in filename (not a segment)
      'wiki/notes..with..many..dots.md',  // multiple non-segment dot-pairs
      'wiki/My..Project/foo.md',           // dots in folder name
    ];
    for (const p of cases) {
      const payload = { path: p };
      const result = collectClickToOpenLinks(VAULT(), payload);
      assert.ok(
        result.clickToOpenLinks && result.clickToOpenLinks[p],
        `should produce URL for legitimate dot-pair filename: ${p}`,
      );
    }
  });

  test('v0.14.9: rejects NUL-byte injection', () => {
    const payload = { path: 'wiki/foo.md\0../etc/passwd' };
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

describe('v0.14.9: deeper nesting (MAX_DEPTH bump 10→20)', () => {
  // Reviewer A IMPORTANT-2: realistic fan-out shape from search_smart.
  // Outer `perVault` wrapper + per-vault chunks + nested source object
  // stacks ~8-10 levels, which the old MAX_DEPTH=10 was clipping.
  test('finds paths in a realistic fan-out smart-search shape', () => {
    const payload = {
      query: 'hi',
      perVault: [
        {
          vault: 'a',
          chunks: [
            { score: 0.9, excerpt: '...', source: { path: 'wiki/a1.md' } },
            { score: 0.8, excerpt: '...', source: { path: 'wiki/a2.md' } },
          ],
        },
        {
          vault: 'b',
          chunks: [
            { score: 0.85, excerpt: '...', source: { path: 'wiki/b1.md' } },
          ],
        },
      ],
    };
    const result = collectClickToOpenLinks(VAULT(), payload);
    // All 3 source paths should be picked up despite the deeper nesting.
    assert.equal(Object.keys(result.clickToOpenLinks).length, 3);
    assert.ok(result.clickToOpenLinks['wiki/a1.md']);
    assert.ok(result.clickToOpenLinks['wiki/a2.md']);
    assert.ok(result.clickToOpenLinks['wiki/b1.md']);
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
