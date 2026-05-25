import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractImageUrls,
  pickAssetFilename,
  downloadOne,
  downloadAssets,
  rewriteAssetUrls,
} from '../src/helpers/asset-downloader.mjs';

// -----------------------------------------------------------------------------
// extractImageUrls
// -----------------------------------------------------------------------------

test('extractImageUrls: HTML <img src="..."> double-quoted', () => {
  const html = '<img src="https://example.com/a.png" alt="x">';
  const urls = extractImageUrls(html, 'https://example.com/');
  assert.deepEqual(urls, ['https://example.com/a.png']);
});

test('extractImageUrls: HTML <img src=\'...\'> single-quoted', () => {
  const html = "<img src='/foo/b.jpg' alt='y'/>";
  const urls = extractImageUrls(html, 'https://site.tld/page');
  assert.deepEqual(urls, ['https://site.tld/foo/b.jpg']);
});

test('extractImageUrls: HTML <img src=bare> unquoted', () => {
  const html = '<img src=https://cdn.x.io/c.gif width=200>';
  const urls = extractImageUrls(html, 'https://other.tld/');
  assert.deepEqual(urls, ['https://cdn.x.io/c.gif']);
});

test('extractImageUrls: <source srcset="..."> takes first URL', () => {
  const html =
    '<source srcset="https://a.io/img-300.png 300w, https://a.io/img-600.png 600w, https://a.io/img-900.png 900w">';
  const urls = extractImageUrls(html, 'https://a.io/');
  assert.deepEqual(urls, ['https://a.io/img-300.png']);
});

test('extractImageUrls: Markdown ![alt](url) basic', () => {
  const md = 'See ![equation](https://wiki.org/eq.png) below.';
  const urls = extractImageUrls(md, 'https://wiki.org/');
  assert.deepEqual(urls, ['https://wiki.org/eq.png']);
});

test('extractImageUrls: Markdown ![alt](url "title") drops title', () => {
  const md = '![logo](https://x.io/l.svg "My Logo")';
  const urls = extractImageUrls(md, 'https://x.io/');
  assert.deepEqual(urls, ['https://x.io/l.svg']);
});

test('extractImageUrls: resolves relative URLs against baseUrl', () => {
  const html = '<img src="../img/a.png"> <img src="/abs/b.jpg"> <img src="rel.gif">';
  const urls = extractImageUrls(html, 'https://example.com/posts/2026/');
  assert.deepEqual(urls, [
    'https://example.com/posts/img/a.png',
    'https://example.com/abs/b.jpg',
    'https://example.com/posts/2026/rel.gif',
  ]);
});

test('extractImageUrls: skips data:, blob:, javascript: URIs', () => {
  const html =
    '<img src="data:image/png;base64,xxx"><img src="blob:nope"><img src="javascript:alert(1)"><img src="https://ok.io/r.png">';
  const urls = extractImageUrls(html, 'https://x.io/');
  assert.deepEqual(urls, ['https://ok.io/r.png']);
});

test('extractImageUrls: dedupes across patterns AND document order is preserved', () => {
  const content =
    '<img src="https://x.io/a.png">\nThen ![text](https://x.io/a.png)\nAnother <img src="https://x.io/b.png">';
  const urls = extractImageUrls(content, 'https://x.io/');
  assert.deepEqual(urls, ['https://x.io/a.png', 'https://x.io/b.png']);
});

test('extractImageUrls: refuses to run without baseUrl', () => {
  assert.throws(() => extractImageUrls('<img src="x.png">'), /baseUrl is required/);
});

test('extractImageUrls: empty/null input returns []', () => {
  assert.deepEqual(extractImageUrls('', 'https://x.io/'), []);
  assert.deepEqual(extractImageUrls(null, 'https://x.io/'), []);
});

// -----------------------------------------------------------------------------
// pickAssetFilename
// -----------------------------------------------------------------------------

test('pickAssetFilename: uses last URL segment with content-type ext', () => {
  const r = pickAssetFilename('https://x.io/path/photo.jpeg', Buffer.from('xxx'), 'image/jpeg');
  assert.equal(r, 'photo.jpg', 'forces .jpg ext from content-type, preserves base');
});

test('pickAssetFilename: forces ext to match content-type even if URL says .html', () => {
  const r = pickAssetFilename('https://x.io/sneaky.html', Buffer.from('xxx'), 'image/png');
  assert.equal(r, 'sneaky.png');
});

test('pickAssetFilename: sanitizes unsafe chars in URL segment', () => {
  const r = pickAssetFilename('https://x.io/a%20b%20c.png', Buffer.from('xxx'), 'image/png');
  // Decoded `a b c.png` → sanitized to `a_b_c.png` (URL is NOT decoded — we
  // operate on the raw pathname which still shows %20, sanitized to _).
  // Either behaviour is acceptable; assert just that no spaces survive.
  assert.match(r, /^[A-Za-z0-9._-]+\.png$/);
});

test('pickAssetFilename: empty/odd segment → sha256 fallback', () => {
  const r1 = pickAssetFilename('https://x.io/', Buffer.from('hello'), 'image/png');
  assert.match(r1, /^[a-f0-9]{16}\.png$/, 'sha256-prefix.png fallback');

  const r2 = pickAssetFilename('https://x.io/...', Buffer.from('hello'), 'image/png');
  assert.match(r2, /^[a-f0-9]{16}\.png$/, 'pure-dots base rejected, sha256 used');
});

test('pickAssetFilename: collision in usedNames → sha256-based unique name', () => {
  const used = new Set(['a.png']);
  const r = pickAssetFilename('https://x.io/a.png', Buffer.from('xxx'), 'image/png', used);
  assert.notEqual(r, 'a.png');
  assert.match(r, /\.png$/);
});

test('pickAssetFilename: unknown content-type AND no URL ext → .bin', () => {
  const r = pickAssetFilename('https://x.io/file', Buffer.from('xxx'), 'application/foo');
  assert.match(r, /\.bin$/);
});

test('pickAssetFilename: caps base length at 80 chars', () => {
  const long = 'a'.repeat(200);
  const r = pickAssetFilename(`https://x.io/${long}.png`, Buffer.from('xxx'), 'image/png');
  assert.ok(r.length <= 80 + 4, 'base+ext stays under cap');
});

test('pickAssetFilename: avoids double-extension (image.png.png)', () => {
  const r = pickAssetFilename('https://x.io/image.png', Buffer.from('xxx'), 'image/png');
  assert.equal(r, 'image.png');
});

// -----------------------------------------------------------------------------
// downloadOne / downloadAssets — using fetch + write injection
// -----------------------------------------------------------------------------

function makeStubFetch(map) {
  // map: { url: { buffer, contentType } } OR { url: Error }
  return async (url) => {
    const entry = map[url];
    if (!entry) throw new Error(`stub: no fixture for ${url}`);
    if (entry instanceof Error) throw entry;
    return { buffer: entry.buffer, contentType: entry.contentType, finalUrl: url };
  };
}

function makeStubWrite() {
  const writes = [];
  const fn = async (fullPath, buffer) => {
    writes.push({ fullPath, bytes: buffer.length });
  };
  return { writes, fn };
}

// v0.14.3 hardening: downloadAssets now stat-checks outputDir + parent.
// Tests use fake paths, so we inject a stub that says "everything is a
// directory and exists" so the guard doesn't reject them. Tests that
// SPECIFICALLY exercise the guard pass their own _statFn.
const stubStatAllDirs = async () => ({ isDirectory: () => true });

test('downloadOne: happy path writes file and returns ok metadata', async () => {
  const stub = makeStubFetch({
    'https://x.io/a.png': { buffer: Buffer.alloc(2048, 0xff), contentType: 'image/png' },
  });
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadOne('https://x.io/a.png', '/abs/out', {
    _fetchFn: stub,
    _writeFn: writeFn,
  });

  assert.equal(r.ok, true);
  assert.equal(r.savedAs, 'a.png');
  assert.equal(r.bytes, 2048);
  assert.equal(writes.length, 1);
  assert.match(writes[0].fullPath, /[\\/]a\.png$/);
});

test('downloadOne: skips under minBytes (default 1024)', async () => {
  const stub = makeStubFetch({
    'https://x.io/icon.svg': { buffer: Buffer.alloc(200), contentType: 'image/svg+xml' },
  });
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadOne('https://x.io/icon.svg', '/abs/out', {
    _fetchFn: stub,
    _writeFn: writeFn,
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-small');
  assert.equal(r.bytes, 200);
  assert.equal(writes.length, 0, 'must not write skipped assets');
});

test('downloadOne: fetch error returns fetch-error reason', async () => {
  const stub = makeStubFetch({
    'https://x.io/dead.png': new Error('connection refused'),
  });
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadOne('https://x.io/dead.png', '/abs/out', {
    _fetchFn: stub,
    _writeFn: writeFn,
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fetch-error');
  assert.match(r.message, /connection refused/);
  assert.equal(writes.length, 0);
});

test('downloadOne: requires absolute outputDir', async () => {
  await assert.rejects(
    () => downloadOne('https://x.io/a.png', 'rel/path', { _fetchFn: makeStubFetch({}) }),
    /outputDir must be absolute/,
  );
});

test('downloadAssets: bulk + dedup filenames across batch', async () => {
  // Two URLs that would BOTH want to be saved as `a.png` — the second
  // should get a sha256-based unique name.
  const stub = makeStubFetch({
    'https://x.io/a.png': { buffer: Buffer.alloc(2000, 0x01), contentType: 'image/png' },
    'https://y.io/a.png': { buffer: Buffer.alloc(2000, 0x02), contentType: 'image/png' },
  });
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadAssets(
    ['https://x.io/a.png', 'https://y.io/a.png'],
    '/abs/out',
    { _fetchFn: stub, _writeFn: writeFn, _mkdirFn: async () => undefined, _statFn: stubStatAllDirs },
  );

  assert.equal(r.downloaded.length, 2);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.errors.length, 0);
  // Names must be distinct.
  const names = r.downloaded.map((d) => d.savedAs);
  assert.notEqual(names[0], names[1], 'duplicate filenames must be deduped');
  // urlMap covers both sources.
  assert.equal(r.urlMap.size, 2);
});

test('downloadAssets: mixed downloaded / skipped / errors', async () => {
  const stub = makeStubFetch({
    'https://x.io/ok.png': { buffer: Buffer.alloc(5000), contentType: 'image/png' },
    'https://x.io/icon.svg': { buffer: Buffer.alloc(100), contentType: 'image/svg+xml' },
    'https://x.io/dead.png': new Error('refused'),
  });
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadAssets(
    ['https://x.io/ok.png', 'https://x.io/icon.svg', 'https://x.io/dead.png'],
    '/abs/out',
    { _fetchFn: stub, _writeFn: writeFn, _mkdirFn: async () => undefined, _statFn: stubStatAllDirs, concurrency: 2 },
  );

  assert.equal(r.downloaded.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.downloaded[0].sourceUrl, 'https://x.io/ok.png');
  assert.equal(r.skipped[0].reason, 'too-small');
  assert.equal(r.errors[0].sourceUrl, 'https://x.io/dead.png');
});

test('downloadAssets: concurrency cap is respected', async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  const slowFetch = async (url) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    return { buffer: Buffer.alloc(2000), contentType: 'image/png', finalUrl: url };
  };
  const urls = Array.from({ length: 10 }, (_, i) => `https://x.io/img${i}.png`);

  const r = await downloadAssets(urls, '/abs/out', {
    _fetchFn: slowFetch,
    _writeFn: async () => undefined,
    _mkdirFn: async () => undefined,
    _statFn: stubStatAllDirs,
    concurrency: 3,
  });

  assert.equal(r.downloaded.length, 10);
  assert.ok(peakInFlight <= 3, `peak in-flight ${peakInFlight} should be <= concurrency 3`);
});

// -----------------------------------------------------------------------------
// rewriteAssetUrls
// -----------------------------------------------------------------------------

test('rewriteAssetUrls: rewrites markdown ![alt](url) to local path', () => {
  const md = 'Before ![a](https://x.io/a.png) after.';
  const urlMap = new Map([['https://x.io/a.png', 'a.png']]);
  const out = rewriteAssetUrls(md, urlMap, { localPathPrefix: '.assets/test' });
  assert.equal(out, 'Before ![a](.assets/test/a.png) after.');
});

test('rewriteAssetUrls: preserves markdown title', () => {
  const md = '![logo](https://x.io/l.svg "Logo")';
  const urlMap = new Map([['https://x.io/l.svg', 'l.svg']]);
  const out = rewriteAssetUrls(md, urlMap, { localPathPrefix: 'a' });
  assert.equal(out, '![logo](a/l.svg "Logo")');
});

test('rewriteAssetUrls: rewrites HTML <img src> preserving quote style', () => {
  const dq = '<img src="https://x.io/a.png" alt="x">';
  const sq = "<img src='https://x.io/a.png' alt='x'>";
  const bare = '<img src=https://x.io/a.png alt=x>';
  const map = new Map([['https://x.io/a.png', 'a.png']]);

  assert.equal(
    rewriteAssetUrls(dq, map, { localPathPrefix: 'p' }),
    '<img src="p/a.png" alt="x">',
  );
  assert.equal(
    rewriteAssetUrls(sq, map, { localPathPrefix: 'p' }),
    "<img src='p/a.png' alt='x'>",
  );
  assert.equal(
    rewriteAssetUrls(bare, map, { localPathPrefix: 'p' }),
    '<img src=p/a.png alt=x>',
  );
});

test('rewriteAssetUrls: leaves un-mapped URLs alone', () => {
  const md = '![a](https://x.io/a.png) ![b](https://x.io/b.png)';
  const urlMap = new Map([['https://x.io/a.png', 'a.png']]);
  const out = rewriteAssetUrls(md, urlMap, { localPathPrefix: 'p' });
  assert.equal(out, '![a](p/a.png) ![b](https://x.io/b.png)');
});

test('rewriteAssetUrls: protocol-relative URL (//x.io/...) also rewritten', () => {
  const md = '<img src="//x.io/a.png">';
  const urlMap = new Map([['https://x.io/a.png', 'a.png']]);
  const out = rewriteAssetUrls(md, urlMap, { localPathPrefix: 'p' });
  assert.equal(out, '<img src="p/a.png">');
});

test('rewriteAssetUrls: empty urlMap → content unchanged', () => {
  const md = '![a](https://x.io/a.png)';
  assert.equal(rewriteAssetUrls(md, new Map()), md);
  assert.equal(rewriteAssetUrls(md, null), md);
});

test('rewriteAssetUrls: trims trailing slash from localPathPrefix', () => {
  const md = '![a](https://x.io/a.png)';
  const urlMap = new Map([['https://x.io/a.png', 'a.png']]);
  assert.equal(
    rewriteAssetUrls(md, urlMap, { localPathPrefix: '.assets/test/' }),
    '![a](.assets/test/a.png)',
  );
  assert.equal(
    rewriteAssetUrls(md, urlMap, { localPathPrefix: '.assets/test///' }),
    '![a](.assets/test/a.png)',
  );
});

// -----------------------------------------------------------------------------
// v0.14.3 hardening — 4 negative regressions from /review+ on ddc6ecc
// -----------------------------------------------------------------------------

test('HARDENING P2-2: extractImageUrls handles nested brackets in markdown alt text', () => {
  // Wikipedia-style alt `![Photo of [Eiffel tower]](url)` used to bail
  // on the inner `[` because the pre-fix regex used a flat `[^\]]*` for
  // the alt-text match. Now we accept one level of nesting.
  const md = 'See ![Photo of [Eiffel tower] at dusk](https://x.io/eiffel.jpg) above.';
  const urls = extractImageUrls(md, 'https://x.io/');
  assert.deepEqual(urls, ['https://x.io/eiffel.jpg']);
});

test('HARDENING P2-2: rewriteAssetUrls also handles nested brackets', () => {
  // The rewrite regex MUST be in sync with extractImageUrls — if extract
  // accepts an image but rewrite doesn't, we'd leave a remote URL behind
  // for an asset we already downloaded.
  const md = 'See ![Photo of [Eiffel tower] at dusk](https://x.io/eiffel.jpg)';
  const urlMap = new Map([['https://x.io/eiffel.jpg', 'eiffel.jpg']]);
  const out = rewriteAssetUrls(md, urlMap, { localPathPrefix: '.assets/test' });
  assert.equal(out, 'See ![Photo of [Eiffel tower] at dusk](.assets/test/eiffel.jpg)');
});

test('HARDENING P2-1: downloadAssets rejects when outputDir parent does not exist', async () => {
  // Without the parent-exists guard, an MCP caller could pass
  // `/etc/cron.d/whatever-they-want/` and mkdir-recursive would happily
  // bootstrap arbitrary system directory trees. The guard ensures the
  // parent is a real existing dir before any write happens.
  const stubStatParentMissing = async (p) => {
    if (p === '/abs/does-not-exist') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isDirectory: () => true };
  };
  await assert.rejects(
    () =>
      downloadAssets(['https://x.io/a.png'], '/abs/does-not-exist/sub', {
        _fetchFn: makeStubFetch({}),
        _writeFn: async () => undefined,
        _mkdirFn: async () => undefined,
        _statFn: stubStatParentMissing,
      }),
    /outputDir parent must exist/,
  );
});

test('HARDENING P2-1: downloadAssets rejects when outputDir is a file (not a directory)', async () => {
  // Belt-and-suspenders against the case where the mkdir-recursive
  // succeeded because the path was a symlink, but the resulting target
  // isn't actually a directory. The post-mkdir stat catches this.
  const stubStatOutputIsFile = async (p) => {
    if (p === '/abs/file-not-dir') return { isDirectory: () => false };
    return { isDirectory: () => true };
  };
  await assert.rejects(
    () =>
      downloadAssets(['https://x.io/a.png'], '/abs/file-not-dir', {
        _fetchFn: makeStubFetch({}),
        _writeFn: async () => undefined,
        _mkdirFn: async () => undefined,
        _statFn: stubStatOutputIsFile,
      }),
    /outputDir exists but is not a directory/,
  );
});

test('HARDENING P3-b (v0.14.4): extract and rewrite regexes stay in lock-step on shared fixtures', () => {
  // The two regexes for `![alt](url)` matching MUST accept the same set
  // of inputs. If a future hand-edit changes only one (extractImageUrls
  // OR rewriteAssetUrls) the drift goes silently undetected: we'd
  // either extract images we can't rewrite (leaving stale remote URLs
  // for downloaded assets) or rewrite images we never extracted (a
  // no-op since urlMap wouldn't contain the URL).
  //
  // This test pins the contract: every URL extractImageUrls returns
  // for a fixture MUST also be reachable by rewriteAssetUrls when given
  // a matching urlMap. Add new edge cases here as they come up.
  const fixtures = [
    '![simple](https://x.io/a.png)',
    '![](https://x.io/empty-alt.png)',
    '![multi word alt](https://x.io/b.png)',
    '![alt with [nested] brackets](https://x.io/nested.png)',
    '![Photo of [Eiffel tower] at dusk](https://x.io/eiffel.jpg)',
    '![alt](https://x.io/with-title.png "Title")',
    '![[wikilink-style alt]](https://x.io/wiki.png)',
  ];

  for (const md of fixtures) {
    const extracted = extractImageUrls(md, 'https://x.io/');
    if (extracted.length === 0) continue; // some fixtures might legitimately yield no URLs
    const urlMap = new Map(extracted.map((u) => [u, 'LOCAL']));
    const rewritten = rewriteAssetUrls(md, urlMap, { localPathPrefix: 'p' });

    for (const url of extracted) {
      assert.ok(
        !rewritten.includes(url),
        `extract returned ${url} for fixture "${md}" but rewrite left it unchanged — regexes drifted`,
      );
      assert.ok(
        rewritten.includes('p/LOCAL'),
        `rewrite produced ${rewritten} which doesn't contain the expected local path "p/LOCAL"`,
      );
    }
  }
});

test('HARDENING P3-1: pickAssetFilename strips leading dots → no hidden files', () => {
  // URL `/...png` used to yield filename `...png` (literal three dots),
  // which is a hidden file on POSIX (`ls` hides it) and looks like
  // path traversal. Same for `/.png` → `.png`. Both should now strip
  // the leading dots; if nothing is left, fall back to sha256.
  const r1 = pickAssetFilename('https://x.io/...png', Buffer.from('data'), 'image/png');
  assert.equal(r1.startsWith('.'), false, `${r1} should not start with .`);
  assert.match(r1, /\.png$/);

  const r2 = pickAssetFilename('https://x.io/.png', Buffer.from('data'), 'image/png');
  assert.equal(r2.startsWith('.'), false, `${r2} should not start with .`);

  const r3 = pickAssetFilename('https://x.io/..', Buffer.from('data'), 'image/png');
  // `..` after leading-dot strip → empty → sha256 fallback (16-char hex + ext)
  assert.match(r3, /^[a-f0-9]{16}\.png$/);
});
