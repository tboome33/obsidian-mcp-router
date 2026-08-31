/**
 * Tests for src/helpers/click-to-open.mjs — encoding, port lookup, cache
 * semantics, and the various null-return conditions (remote vault, missing
 * data.json, insecure server disabled, invalid port).
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  buildClickToOpenUrl,
  buildClickToOpenMarkdownLink,
  encodeVaultPath,
  normalizeAnchor,
  _resetCache,
} from '../src/helpers/click-to-open.mjs';

let workDir;
let vaultPath;
let dataJsonPath;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'click-to-open-'));
  vaultPath = fs.mkdtempSync(path.join(workDir, 'vault-'));
  const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-local-rest-api');
  fs.mkdirSync(pluginDir, { recursive: true });
  dataJsonPath = path.join(pluginDir, 'data.json');
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetCache(); // ensure each test sees a fresh port lookup
});

function writeDataJson(obj) {
  fs.writeFileSync(dataJsonPath, JSON.stringify(obj));
  _resetCache(); // bust cache after rewrite
}

describe('encodeVaultPath', () => {
  test('encodes slashes as %2F', () => {
    assert.equal(encodeVaultPath('wiki/Divers/foo.md'), 'wiki%2FDivers%2Ffoo.md');
  });

  test('encodes spaces as %20', () => {
    assert.equal(encodeVaultPath('wiki/My Notes/foo.md'), 'wiki%2FMy%20Notes%2Ffoo.md');
  });

  test('encodes accented characters', () => {
    assert.equal(
      encodeVaultPath('wiki/Décisions/é.md'),
      'wiki%2FD%C3%A9cisions%2F%C3%A9.md',
    );
  });

  test('normalises backslashes to forward slashes before encoding', () => {
    assert.equal(
      encodeVaultPath('wiki\\Divers\\foo.md'),
      'wiki%2FDivers%2Ffoo.md',
    );
  });

  test('strips leading slashes', () => {
    assert.equal(encodeVaultPath('/wiki/foo.md'), 'wiki%2Ffoo.md');
    assert.equal(encodeVaultPath('///wiki/foo.md'), 'wiki%2Ffoo.md');
  });

  test('preserves dots, dashes, underscores', () => {
    assert.equal(
      encodeVaultPath('wiki/_drafts/my-note-2026.md'),
      'wiki%2F_drafts%2Fmy-note-2026.md',
    );
  });

  test('escapes ( and ) for markdown-link safety (codex 2026-06-02)', () => {
    // encodeURIComponent leaves parens literal → a file like `foo (draft).md`
    // would break the [label](url) destination at the `)`. Must be %28/%29.
    assert.equal(encodeVaultPath('wiki/foo (draft).md'), 'wiki%2Ffoo%20%28draft%29.md');
  });
});

describe('buildClickToOpenUrl — happy path', () => {
  test('builds URL with the configured port', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const url = buildClickToOpenUrl(
      { type: 'local', path: vaultPath, name: 'test' },
      'wiki/Divers/foo.md',
    );
    assert.equal(url, 'http://127.0.0.1:27142/open/wiki%2FDivers%2Ffoo.md');
  });

  test('different port → different URL', () => {
    writeDataJson({ insecurePort: 27999, enableInsecureServer: true });
    const url = buildClickToOpenUrl(
      { type: 'local', path: vaultPath, name: 'test' },
      'foo.md',
    );
    assert.equal(url, 'http://127.0.0.1:27999/open/foo.md');
  });
});

describe('normalizeAnchor', () => {
  test('strips a single leading #', () => {
    assert.equal(normalizeAnchor('#Installation'), 'Installation');
  });
  test('strips multiple leading #', () => {
    assert.equal(normalizeAnchor('###Foo'), 'Foo');
  });
  test('trims surrounding whitespace', () => {
    assert.equal(normalizeAnchor('  Mon Titre  '), 'Mon Titre');
  });
  test('empty / whitespace / #-only → null', () => {
    assert.equal(normalizeAnchor(''), null);
    assert.equal(normalizeAnchor('   '), null);
    assert.equal(normalizeAnchor('#'), null);
  });
  test('non-string → null', () => {
    assert.equal(normalizeAnchor(42), null);
    assert.equal(normalizeAnchor(null), null);
    assert.equal(normalizeAnchor(undefined), null);
  });
});

describe('buildClickToOpenUrl — anchor (v0.22.0)', () => {
  test('appends ?h=<heading> when anchor provided', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const url = buildClickToOpenUrl(
      { type: 'local', path: vaultPath, name: 't' },
      'wiki/foo.md',
      { anchor: 'Installation' },
    );
    assert.equal(url, 'http://127.0.0.1:27142/open/wiki%2Ffoo.md?h=Installation');
  });

  test('strips leading # and encodes spaces in the heading', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const url = buildClickToOpenUrl(
      { type: 'local', path: vaultPath, name: 't' },
      'wiki/foo.md',
      { anchor: '#Section 2' },
    );
    assert.equal(url, 'http://127.0.0.1:27142/open/wiki%2Ffoo.md?h=Section%202');
  });

  test('escapes ) in the heading so the markdown link does not break (codex P2)', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const url = buildClickToOpenUrl(
      { type: 'local', path: vaultPath, name: 't' },
      'wiki/foo.md',
      { anchor: 'Step 1) Setup' },
    );
    assert.equal(url, 'http://127.0.0.1:27142/open/wiki%2Ffoo.md?h=Step%201%29%20Setup');
  });

  test('no anchor / empty anchor → no query (backward compatible)', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const vault = { type: 'local', path: vaultPath, name: 't' };
    assert.equal(buildClickToOpenUrl(vault, 'wiki/foo.md'), 'http://127.0.0.1:27142/open/wiki%2Ffoo.md');
    assert.equal(buildClickToOpenUrl(vault, 'wiki/foo.md', {}), 'http://127.0.0.1:27142/open/wiki%2Ffoo.md');
    assert.equal(buildClickToOpenUrl(vault, 'wiki/foo.md', { anchor: '   ' }), 'http://127.0.0.1:27142/open/wiki%2Ffoo.md');
  });

  test('markdown link forwards the anchor', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const link = buildClickToOpenMarkdownLink(
      { type: 'local', path: vaultPath, name: 't' },
      'wiki/foo.md',
      undefined,
      { anchor: 'Usage' },
    );
    assert.equal(link, '[foo](http://127.0.0.1:27142/open/wiki%2Ffoo.md?h=Usage)');
  });
});

describe('buildClickToOpenUrl — null-return conditions', () => {
  // Since v0.79.0 the reason is NOT "remote": a vault carrying an
  // `insecurePort` gets a URL whatever its baseUrl says (see
  // tests/click-to-open-remote.test.mjs — the host plays no part). This one
  // stays null purely because no plaintext port is known for it. The public
  // `baseUrl` in the fixture is incidental, not the cause.
  test('a vault with no declared plaintext port returns null', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const url = buildClickToOpenUrl(
      { type: 'remote', baseUrl: 'https://example.com', name: 'r' },
      'foo.md',
    );
    assert.equal(url, null);
  });

  test('null vault returns null', () => {
    assert.equal(buildClickToOpenUrl(null, 'foo.md'), null);
  });

  test('vault without path returns null', () => {
    assert.equal(buildClickToOpenUrl({ type: 'local' }, 'foo.md'), null);
  });

  test('missing filePath returns null', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    assert.equal(
      buildClickToOpenUrl({ type: 'local', path: vaultPath, name: 'test' }, ''),
      null,
    );
    assert.equal(
      buildClickToOpenUrl({ type: 'local', path: vaultPath, name: 'test' }, null),
      null,
    );
  });

  test('enableInsecureServer:false returns null', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: false });
    assert.equal(
      buildClickToOpenUrl({ type: 'local', path: vaultPath, name: 't' }, 'foo.md'),
      null,
    );
  });

  test('enableInsecureServer absent returns null', () => {
    writeDataJson({ insecurePort: 27142 });
    assert.equal(
      buildClickToOpenUrl({ type: 'local', path: vaultPath, name: 't' }, 'foo.md'),
      null,
    );
  });

  test('insecurePort missing returns null', () => {
    writeDataJson({ enableInsecureServer: true });
    assert.equal(
      buildClickToOpenUrl({ type: 'local', path: vaultPath, name: 't' }, 'foo.md'),
      null,
    );
  });

  test('insecurePort out of range returns null', () => {
    writeDataJson({ insecurePort: 99999, enableInsecureServer: true });
    assert.equal(
      buildClickToOpenUrl({ type: 'local', path: vaultPath, name: 't' }, 'foo.md'),
      null,
    );
  });

  test('insecurePort non-integer returns null', () => {
    writeDataJson({ insecurePort: '27142', enableInsecureServer: true });
    assert.equal(
      buildClickToOpenUrl({ type: 'local', path: vaultPath, name: 't' }, 'foo.md'),
      null,
    );
  });

  test('missing data.json file returns null', () => {
    fs.rmSync(dataJsonPath, { force: true });
    _resetCache();
    assert.equal(
      buildClickToOpenUrl({ type: 'local', path: vaultPath, name: 't' }, 'foo.md'),
      null,
    );
  });

  test('corrupt data.json returns null', () => {
    fs.writeFileSync(dataJsonPath, '{not valid json');
    _resetCache();
    assert.equal(
      buildClickToOpenUrl({ type: 'local', path: vaultPath, name: 't' }, 'foo.md'),
      null,
    );
  });
});

describe('buildClickToOpenMarkdownLink', () => {
  test('uses basename without extension as default label', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const link = buildClickToOpenMarkdownLink(
      { type: 'local', path: vaultPath, name: 't' },
      'wiki/Divers/foo.md',
    );
    assert.equal(link, '[foo](http://127.0.0.1:27142/open/wiki%2FDivers%2Ffoo.md)');
  });

  test('honours explicit label', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const link = buildClickToOpenMarkdownLink(
      { type: 'local', path: vaultPath, name: 't' },
      'wiki/foo.md',
      'My Custom Label',
    );
    assert.equal(link, '[My Custom Label](http://127.0.0.1:27142/open/wiki%2Ffoo.md)');
  });

  test('returns null when URL is unavailable', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: false });
    assert.equal(
      buildClickToOpenMarkdownLink({ type: 'local', path: vaultPath, name: 't' }, 'foo.md'),
      null,
    );
  });

  test('handles backslash paths in basename extraction', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const link = buildClickToOpenMarkdownLink(
      { type: 'local', path: vaultPath, name: 't' },
      'wiki\\Divers\\bar.md',
    );
    assert.equal(link, '[bar](http://127.0.0.1:27142/open/wiki%2FDivers%2Fbar.md)');
  });
});

describe('cache behaviour', () => {
  // REVERSED IN v0.79.0, deliberately. This test used to assert that a mutated
  // data.json kept returning the OLD port — "cache should pin the original port
  // on success". That was the cache's defect written down as its contract: a
  // user who moved their plaintext port, or turned the server off, kept getting
  // the stale number until the router process restarted. Pre-release review
  // caught it. A second review rejected the first repair (an mtime-validated
  // cache) too: two writes inside one filesystem tick share an mtime, so the
  // invariant still could not be stated. THE CACHE IS GONE — every call reads
  // the file, which is why this test needs no timestamp fiddling.
  test('a rewritten data.json is followed, not pinned', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const vault = { type: 'local', path: vaultPath, name: 't' };
    const u1 = buildClickToOpenUrl(vault, 'a.md');
    assert.equal(u1, 'http://127.0.0.1:27142/open/a.md');
    fs.writeFileSync(
      dataJsonPath,
      JSON.stringify({ insecurePort: 27999, enableInsecureServer: true }),
    );
    const u2 = buildClickToOpenUrl(vault, 'b.md');
    assert.equal(u2, 'http://127.0.0.1:27999/open/b.md', 'the live file wins, immediately');
  });

  // `_resetCache` survives as a NO-OP so callers and tests that reference it
  // keep working. What it must not do is change any answer — this test now
  // proves the API is inert rather than that it flushes something.
  test('_resetCache is inert: the answer is the same with or without it', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const vault = { type: 'local', path: vaultPath, name: 't' };
    assert.equal(buildClickToOpenUrl(vault, 'a.md'), 'http://127.0.0.1:27142/open/a.md');
    fs.writeFileSync(
      dataJsonPath,
      JSON.stringify({ insecurePort: 27999, enableInsecureServer: true }),
    );
    const withoutReset = buildClickToOpenUrl(vault, 'b.md');
    _resetCache();
    const withReset = buildClickToOpenUrl(vault, 'b.md');
    assert.equal(withoutReset, 'http://127.0.0.1:27999/open/b.md');
    assert.equal(withReset, withoutReset, 'nothing is being flushed — there is nothing to flush');
  });

  test('v0.14.9: failures (enabled:false) are NOT cached — retry on next call', () => {
    // Reviewer A IMPORTANT-1: onboarding scenario. User starts router
    // before enabling insecure server → first call sees enabled:false.
    // After user flips data.json to enabled:true, subsequent calls MUST
    // pick up the change without a session restart.
    writeDataJson({ insecurePort: 27142, enableInsecureServer: false });
    const vault = { type: 'local', path: vaultPath, name: 't' };
    const u1 = buildClickToOpenUrl(vault, 'a.md');
    assert.equal(u1, null, 'first call sees enabled:false');
    // User flips the setting WITHOUT bumping the cache.
    fs.writeFileSync(
      dataJsonPath,
      JSON.stringify({ insecurePort: 27142, enableInsecureServer: true }),
    );
    const u2 = buildClickToOpenUrl(vault, 'b.md');
    assert.equal(
      u2,
      'http://127.0.0.1:27142/open/b.md',
      'subsequent call must re-read disk and produce a URL',
    );
  });

  test('v0.14.9: missing data.json is NOT cached — retry on next call', () => {
    fs.rmSync(dataJsonPath, { force: true });
    _resetCache();
    const vault = { type: 'local', path: vaultPath, name: 't' };
    const u1 = buildClickToOpenUrl(vault, 'a.md');
    assert.equal(u1, null);
    // Create the file later — next call must pick it up.
    fs.writeFileSync(
      dataJsonPath,
      JSON.stringify({ insecurePort: 27142, enableInsecureServer: true }),
    );
    const u2 = buildClickToOpenUrl(vault, 'b.md');
    assert.equal(u2, 'http://127.0.0.1:27142/open/b.md');
  });
});

describe('v0.14.9: markdown label escaping', () => {
  // Reviewer B P3: a file named `foo]bar.md` was producing `[foo]bar](...)`
  // which the renderer interprets as `[foo]` + literal text `bar](...)`.
  test('escapes ] in basename-derived label', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const vault = { type: 'local', path: vaultPath, name: 't' };
    const link = buildClickToOpenMarkdownLink(vault, 'wiki/foo]bar.md');
    assert.equal(
      link,
      '[foo\\]bar](http://127.0.0.1:27142/open/wiki%2Ffoo%5Dbar.md)',
      'basename containing ] must be escaped in label',
    );
  });

  test('escapes [ in explicit label', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const vault = { type: 'local', path: vaultPath, name: 't' };
    const link = buildClickToOpenMarkdownLink(vault, 'wiki/foo.md', '[draft] note');
    assert.equal(
      link,
      '[\\[draft\\] note](http://127.0.0.1:27142/open/wiki%2Ffoo.md)',
    );
  });

  test('escapes backslash in label', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const vault = { type: 'local', path: vaultPath, name: 't' };
    const link = buildClickToOpenMarkdownLink(vault, 'wiki/foo.md', 'a\\b');
    assert.equal(
      link,
      '[a\\\\b](http://127.0.0.1:27142/open/wiki%2Ffoo.md)',
    );
  });

  test('clean labels pass through unchanged', () => {
    writeDataJson({ insecurePort: 27142, enableInsecureServer: true });
    const vault = { type: 'local', path: vaultPath, name: 't' };
    const link = buildClickToOpenMarkdownLink(vault, 'wiki/foo.md', 'Clean Label');
    assert.equal(
      link,
      '[Clean Label](http://127.0.0.1:27142/open/wiki%2Ffoo.md)',
    );
  });
});
