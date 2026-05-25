import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractImageUrls,
  extractImagesWithMeta,
  pickAssetFilename,
  decodeImageDimensions,
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

// -----------------------------------------------------------------------------
// v0.14.7 — extractImagesWithMeta (alt-text + figure-wrapping signals)
// -----------------------------------------------------------------------------

test('extractImagesWithMeta: captures alt text from <img>', () => {
  const html = '<img src="https://x.io/a.png" alt="A diagram">';
  const r = extractImagesWithMeta(html, 'https://x.io/');
  assert.deepEqual(r, [{ url: 'https://x.io/a.png', alt: 'A diagram', isFigure: false }]);
});

test('extractImagesWithMeta: empty alt="" stays as empty string', () => {
  const html = '<img src="https://x.io/a.png" alt="">';
  const r = extractImagesWithMeta(html, 'https://x.io/');
  assert.equal(r[0].alt, '');
});

test('extractImagesWithMeta: missing alt attribute returns empty string', () => {
  const html = '<img src="https://x.io/a.png">';
  const r = extractImagesWithMeta(html, 'https://x.io/');
  assert.equal(r[0].alt, '');
});

test('extractImagesWithMeta: marks isFigure=true when wrapped in <figure>', () => {
  const html = '<figure><img src="https://x.io/a.png"><figcaption>Fig.</figcaption></figure>';
  const r = extractImagesWithMeta(html, 'https://x.io/');
  assert.equal(r.length, 1);
  assert.equal(r[0].isFigure, true);
});

test('extractImagesWithMeta: isFigure=false when outside <figure>', () => {
  const html = '<figure><img src="https://x.io/in.png"></figure><img src="https://x.io/out.png">';
  const r = extractImagesWithMeta(html, 'https://x.io/');
  const inFig = r.find((e) => e.url === 'https://x.io/in.png');
  const outFig = r.find((e) => e.url === 'https://x.io/out.png');
  assert.equal(inFig.isFigure, true);
  assert.equal(outFig.isFigure, false);
});

test('extractImagesWithMeta: nested figures decrement correctly', () => {
  // Pathological but valid: figure-inside-figure. We don't need true tree
  // tracking — just the boolean "currently inside any figure", which a
  // depth counter handles.
  const html = '<figure><img src="https://x.io/outer.png"><figure><img src="https://x.io/inner.png"></figure></figure><img src="https://x.io/after.png">';
  const r = extractImagesWithMeta(html, 'https://x.io/');
  assert.equal(r.find((e) => e.url === 'https://x.io/outer.png').isFigure, true);
  assert.equal(r.find((e) => e.url === 'https://x.io/inner.png').isFigure, true);
  assert.equal(r.find((e) => e.url === 'https://x.io/after.png').isFigure, false);
});

test('extractImagesWithMeta: markdown ![alt](url) extracts alt + isFigure=false', () => {
  const md = '![A picture](https://x.io/a.png)';
  const r = extractImagesWithMeta(md, 'https://x.io/');
  assert.deepEqual(r, [{ url: 'https://x.io/a.png', alt: 'A picture', isFigure: false }]);
});

test('extractImagesWithMeta: markdown ![](url) has empty alt', () => {
  const md = '![](https://x.io/a.png)';
  const r = extractImagesWithMeta(md, 'https://x.io/');
  assert.equal(r[0].alt, '');
});

test('extractImagesWithMeta: dedupe keeps first occurrence metadata', () => {
  // Same URL appears twice — once with alt, once without. First wins.
  const html = '<img src="https://x.io/a.png" alt="first wins"><img src="https://x.io/a.png" alt="">';
  const r = extractImagesWithMeta(html, 'https://x.io/');
  assert.equal(r.length, 1);
  assert.equal(r[0].alt, 'first wins');
});

test('extractImagesWithMeta: single-quoted alt is supported', () => {
  const html = "<img src='https://x.io/a.png' alt='single-quoted alt'>";
  const r = extractImagesWithMeta(html, 'https://x.io/');
  assert.equal(r[0].alt, 'single-quoted alt');
});

// extractImageUrls back-compat — make sure the facade still returns []string
// matching the new metadata-aware impl.
test('extractImageUrls: still returns plain string array (back-compat facade)', () => {
  const html = '<img src="https://x.io/a.png" alt="x"><img src="https://x.io/b.png">';
  const urls = extractImageUrls(html, 'https://x.io/');
  assert.deepEqual(urls, ['https://x.io/a.png', 'https://x.io/b.png']);
});

// -----------------------------------------------------------------------------
// v0.14.7 — decodeImageDimensions (Phase E.2)
// -----------------------------------------------------------------------------

// Build a minimal valid PNG header: magic + IHDR chunk. We don't care
// about the IDAT/CRC since `decodeImageDimensions` only reads up to
// offset 24.
function buildPngHeader(width, height) {
  const buf = Buffer.alloc(24);
  // PNG magic.
  buf.writeUInt8(0x89, 0); buf.writeUInt8(0x50, 1); buf.writeUInt8(0x4e, 2); buf.writeUInt8(0x47, 3);
  buf.writeUInt8(0x0d, 4); buf.writeUInt8(0x0a, 5); buf.writeUInt8(0x1a, 6); buf.writeUInt8(0x0a, 7);
  // IHDR length (13) + 'IHDR' + width/height as BE u32 at offsets 16, 20.
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function buildGifHeader(width, height, version = '89') {
  const buf = Buffer.alloc(10);
  buf.write('GIF' + version + 'a', 0, 'ascii'); // 'GIF89a' or 'GIF87a'
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function buildJpegHeader(width, height) {
  // SOI (FF D8) + SOF0 (FF C0) marker with dimensions.
  // SOF0 segment: length=17, precision=8, height(BE u16), width(BE u16), components(3),
  //   each component=3 bytes — total 17 bytes after marker.
  const buf = Buffer.alloc(2 + 2 + 2 + 1 + 2 + 2 + 1 + 9);
  buf[0] = 0xff; buf[1] = 0xd8;        // SOI
  buf[2] = 0xff; buf[3] = 0xc0;        // SOF0
  buf.writeUInt16BE(17, 4);             // segment length
  buf[6] = 8;                           // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  buf[11] = 3;                          // components
  // 3*3 = 9 component bytes (zeros — don't care)
  return buf;
}

function buildWebpVp8xHeader(width, height) {
  // RIFF<size>WEBP VP8X<chunk-size><flags 1byte><reserved 3bytes><w-1 24bit LE><h-1 24bit LE>
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);                // file size (minimal, doesn't matter for parsing)
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);                // chunk size
  buf.writeUInt8(0, 20);                    // flags
  // reserved 3 bytes at 21-23
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  buf.writeUInt8(wMinus1 & 0xff, 24);
  buf.writeUInt8((wMinus1 >> 8) & 0xff, 25);
  buf.writeUInt8((wMinus1 >> 16) & 0xff, 26);
  buf.writeUInt8(hMinus1 & 0xff, 27);
  buf.writeUInt8((hMinus1 >> 8) & 0xff, 28);
  buf.writeUInt8((hMinus1 >> 16) & 0xff, 29);
  return buf;
}

test('decodeImageDimensions: PNG 200x100 → {width:200, height:100}', () => {
  const r = decodeImageDimensions(buildPngHeader(200, 100), 'image/png');
  assert.deepEqual(r, { width: 200, height: 100 });
});

test('decodeImageDimensions: GIF87a + GIF89a both parse', () => {
  assert.deepEqual(decodeImageDimensions(buildGifHeader(50, 30, '87'), 'image/gif'), { width: 50, height: 30 });
  assert.deepEqual(decodeImageDimensions(buildGifHeader(200, 100), 'image/gif'), { width: 200, height: 100 });
});

test('decodeImageDimensions: JPEG SOF0 marker parsed correctly', () => {
  const r = decodeImageDimensions(buildJpegHeader(640, 480), 'image/jpeg');
  assert.deepEqual(r, { width: 640, height: 480 });
});

test('decodeImageDimensions: WebP VP8X parses 24-bit dimensions', () => {
  const r = decodeImageDimensions(buildWebpVp8xHeader(1920, 1080), 'image/webp');
  assert.deepEqual(r, { width: 1920, height: 1080 });
});

test('decodeImageDimensions: SVG with px width/height attrs', () => {
  const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="150" height="80"><rect/></svg>';
  const r = decodeImageDimensions(Buffer.from(svg), 'image/svg+xml');
  assert.deepEqual(r, { width: 150, height: 80 });
});

test('decodeImageDimensions: SVG falls back to viewBox when width/height missing', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect/></svg>';
  const r = decodeImageDimensions(Buffer.from(svg), 'image/svg+xml');
  assert.deepEqual(r, { width: 300, height: 200 });
});

test('decodeImageDimensions: unknown format returns null (cant-verify → keep)', () => {
  // BMP magic 'BM' → unsupported.
  const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(20)]);
  assert.equal(decodeImageDimensions(bmp, 'image/bmp'), null);
});

test('decodeImageDimensions: too-short buffer returns null', () => {
  assert.equal(decodeImageDimensions(Buffer.alloc(4), 'image/png'), null);
  assert.equal(decodeImageDimensions(Buffer.from('hi'), 'image/png'), null);
});

test('decodeImageDimensions: non-buffer input returns null', () => {
  assert.equal(decodeImageDimensions(null, 'image/png'), null);
  assert.equal(decodeImageDimensions('not a buffer', 'image/png'), null);
});

// -----------------------------------------------------------------------------
// v0.14.7 — downloadOne dimension filter (Phase E.2)
// -----------------------------------------------------------------------------

test('downloadOne: skips when decoded dimensions are below minWidth', async () => {
  const stub = makeStubFetch({
    'https://x.io/icon.png': { buffer: Buffer.alloc(5000, 0xff), contentType: 'image/png' },
  });
  // Stub dim decoder so we don't have to feed a real PNG header.
  const decodeDimsStub = () => ({ width: 50, height: 50 });
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadOne('https://x.io/icon.png', '/abs/out', {
    _fetchFn: stub,
    _writeFn: writeFn,
    _decodeDimsFn: decodeDimsStub,
    minWidth: 100,
    minHeight: 100,
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-small-dimensions');
  assert.deepEqual(r.dimensions, { width: 50, height: 50 });
  assert.equal(writes.length, 0, 'must not write images below dimension threshold');
});

test('downloadOne: passes through when dimensions meet threshold', async () => {
  const stub = makeStubFetch({
    'https://x.io/big.png': { buffer: Buffer.alloc(5000, 0xff), contentType: 'image/png' },
  });
  const decodeDimsStub = () => ({ width: 800, height: 600 });
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadOne('https://x.io/big.png', '/abs/out', {
    _fetchFn: stub,
    _writeFn: writeFn,
    _decodeDimsFn: decodeDimsStub,
    minWidth: 100,
    minHeight: 100,
  });

  assert.equal(r.ok, true);
  assert.deepEqual(r.dimensions, { width: 800, height: 600 });
  assert.equal(writes.length, 1);
});

test('downloadOne: when minWidth=minHeight=0, dimension check is disabled (decoder not called)', async () => {
  const stub = makeStubFetch({
    'https://x.io/any.png': { buffer: Buffer.alloc(5000, 0xff), contentType: 'image/png' },
  });
  let decoderCalled = false;
  const decodeDimsStub = () => {
    decoderCalled = true;
    return { width: 1, height: 1 }; // would skip if invoked
  };
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadOne('https://x.io/any.png', '/abs/out', {
    _fetchFn: stub,
    _writeFn: writeFn,
    _decodeDimsFn: decodeDimsStub,
    minWidth: 0,
    minHeight: 0,
  });

  assert.equal(r.ok, true);
  assert.equal(decoderCalled, false, 'decoder should not be called when both mins are 0');
  assert.equal(r.dimensions, undefined, 'no dimensions field when decoder did not run');
  assert.equal(writes.length, 1);
});

test('downloadOne: unknown format (decoder returns null) is kept (cant-verify → keep)', async () => {
  // BMP / TIFF / ICO / AVIF return null. We don't want to skip those —
  // false positives are worse than the occasional decorative image
  // sneaking through.
  const stub = makeStubFetch({
    'https://x.io/mystery.tif': { buffer: Buffer.alloc(5000), contentType: 'image/tiff' },
  });
  const decodeDimsStub = () => null;
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadOne('https://x.io/mystery.tif', '/abs/out', {
    _fetchFn: stub,
    _writeFn: writeFn,
    _decodeDimsFn: decodeDimsStub,
    minWidth: 100,
    minHeight: 100,
  });

  assert.equal(r.ok, true, 'unknown format must not be skipped');
  assert.equal(r.dimensions, undefined);
  assert.equal(writes.length, 1);
});

test('downloadAssets: threads minWidth/minHeight through to per-asset downloadOne', async () => {
  const stub = makeStubFetch({
    'https://x.io/small.png': { buffer: Buffer.alloc(5000), contentType: 'image/png' },
    'https://x.io/big.png': { buffer: Buffer.alloc(5000), contentType: 'image/png' },
  });
  let callIdx = 0;
  const decodeDimsStub = () => {
    callIdx += 1;
    return callIdx === 1 ? { width: 50, height: 50 } : { width: 800, height: 800 };
  };
  const { writes, fn: writeFn } = makeStubWrite();

  const r = await downloadAssets(
    ['https://x.io/small.png', 'https://x.io/big.png'],
    '/abs/out',
    {
      _fetchFn: stub,
      _writeFn: writeFn,
      _mkdirFn: async () => undefined,
      _statFn: stubStatAllDirs,
      _decodeDimsFn: decodeDimsStub,
      minWidth: 100,
      minHeight: 100,
      concurrency: 1, // serial so the decoder-call-ordering above is deterministic
    },
  );

  assert.equal(r.downloaded.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, 'too-small-dimensions');
  assert.deepEqual(r.skipped[0].dimensions, { width: 50, height: 50 });
});
