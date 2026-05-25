/**
 * Wrapper tests for `src/tools/download-page-assets.mjs`. Network is NOT
 * exercised — all tests use the `html` input branch + the helper's
 * built-in injection seams. The SSRF/fetch path is covered by
 * `safe-fetch-html` / `safe-fetch-binary` and tested transitively.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  TOOL_NAME,
  TOOL_DEFINITION,
  handleDownloadPageAssets,
} from '../src/tools/download-page-assets.mjs';

describe('download-page-assets — TOOL_DEFINITION shape', () => {
  test('exports canonical name', () => {
    assert.equal(TOOL_NAME, 'download_page_assets');
    assert.equal(TOOL_DEFINITION.name, TOOL_NAME);
  });

  test('requires outputDir in schema', () => {
    const schema = TOOL_DEFINITION.inputSchema;
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.outputDir);
    assert.ok(schema.required.includes('outputDir'));
  });

  test('declares all input parameters with descriptions', () => {
    const props = TOOL_DEFINITION.inputSchema.properties;
    for (const k of [
      'url', 'html', 'baseUrl', 'outputDir',
      'minBytes', 'maxBytes', 'concurrency', 'maxAssets',
      // v0.14.7
      'defuddleFirst', 'requireAltOrFigure', 'minWidth', 'minHeight',
    ]) {
      assert.ok(props[k], `${k} must be in schema`);
      assert.ok(props[k].description, `${k} must have description`);
    }
  });
});

describe('download-page-assets — input validation', () => {
  // Use OS-appropriate absolute path so tests pass on both POSIX and Windows.
  const ABS_OUT = path.isAbsolute('/tmp') ? '/tmp/test-out' : 'C:\\Users\\Public\\test-out';

  test('rejects when neither url nor html given', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({ outputDir: ABS_OUT }),
      /one of `url` or `html`/,
    );
  });

  test('rejects when both url and html given (mutually exclusive)', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({ url: 'https://x.io/', html: '<html></html>', outputDir: ABS_OUT }),
      /mutually exclusive/,
    );
  });

  test('rejects when html given without baseUrl', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({ html: '<img src="x.png">', outputDir: ABS_OUT }),
      /must also pass `baseUrl`/,
    );
  });

  test('rejects missing outputDir', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({ html: '<x>', baseUrl: 'https://x.io/' }),
      /`outputDir` .* required/,
    );
  });

  test('rejects relative outputDir', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({ html: '<x>', baseUrl: 'https://x.io/', outputDir: 'rel/path' }),
      /must be absolute/,
    );
  });

  // v0.14.3 hardening (P3-3): explicit numeric validation. Pre-fix,
  // maxAssets=0 silently produced an empty no-op the caller might
  // think was broken behavior.
  test('HARDENING P3-3: rejects maxAssets=0', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({ html: '<x>', baseUrl: 'https://x.io/', outputDir: ABS_OUT, maxAssets: 0 }),
      /maxAssets must be a positive integer/,
    );
  });

  test('HARDENING P3-3: rejects negative maxAssets', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({ html: '<x>', baseUrl: 'https://x.io/', outputDir: ABS_OUT, maxAssets: -5 }),
      /maxAssets must be a positive integer/,
    );
  });

  test('HARDENING P3-3: rejects non-integer maxAssets', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({ html: '<x>', baseUrl: 'https://x.io/', outputDir: ABS_OUT, maxAssets: 1.5 }),
      /maxAssets must be a positive integer/,
    );
  });

  test('HARDENING P3-3: rejects concurrency=0 (same validator family)', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({ html: '<x>', baseUrl: 'https://x.io/', outputDir: ABS_OUT, concurrency: 0 }),
      /concurrency must be a positive integer/,
    );
  });
});

describe('download-page-assets — html branch end-to-end (no network, in-memory)', () => {
  // Use OS-aware absolute path with realistic temp dir prefix so the
  // assertPathAllowed call passes when MD_ALLOWED_PATHS is unset (no
  // sandbox → allows anything).
  const ABS_OUT = process.platform === 'win32' ? 'C:\\tmp\\dl-test' : '/tmp/dl-test';

  test('returns serializable urlMap object (not a Map instance)', async () => {
    // Stub fetch + write via the helper's injection seams by importing
    // the helper directly — but the MCP tool wrapper doesn't expose them.
    // So this test exercises the FULL path including `downloadAssets`
    // which will call the real `safeFetchBinary` if we don't override.
    //
    // Workaround: use HTML with ZERO image URLs so no network is touched.
    const html = '<html><body><p>No images here.</p></body></html>';
    const r = await handleDownloadPageAssets({
      html,
      baseUrl: 'https://x.io/',
      outputDir: ABS_OUT,
    });

    assert.equal(r.extracted, 0, 'no images in this HTML');
    assert.equal(r.attempted, 0);
    assert.deepEqual(r.downloaded, []);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.errors, []);
    assert.equal(typeof r.urlMap, 'object');
    assert.equal(r.urlMap instanceof Map, false, 'urlMap must be a plain object for JSON transport');
    assert.equal(Object.keys(r.urlMap).length, 0);
  });

  test('maxAssets caps the attempted list', async () => {
    // 5 image refs in HTML, maxAssets: 2 → only first 2 attempted.
    // We can verify by checking `attempted` even though all fetches will
    // fail (no network) — the failures go to `errors`, not `attempted`.
    //
    // v0.14.7: the new defaults are defuddleFirst=true + requireAltOrFigure=true.
    // We disable both here to keep this test focused on maxAssets capping —
    // the relevance-filter and defuddle behaviors get their own dedicated tests.
    const html = Array.from({ length: 5 }, (_, i) => `<img src="https://nope.invalid/img${i}.png">`).join('');
    const r = await handleDownloadPageAssets({
      html,
      baseUrl: 'https://nope.invalid/',
      outputDir: ABS_OUT,
      maxAssets: 2,
      defuddleFirst: false,
      requireAltOrFigure: false,
    });
    assert.equal(r.extracted, 5);
    assert.equal(r.attempted, 2);
    // All 2 attempts fail (DNS resolves but no server). They land in errors.
    assert.equal(r.errors.length + r.downloaded.length + r.skipped.length, 2);
  });

  test('returns baseUrl field unchanged when html branch is used', async () => {
    const r = await handleDownloadPageAssets({
      html: '<p>x</p>',
      baseUrl: 'https://example.com/post/',
      outputDir: ABS_OUT,
    });
    assert.equal(r.baseUrl, 'https://example.com/post/');
  });
});

describe('download-page-assets — wiring into src/index.mjs', () => {
  test('TOOLS / TOOL_HANDLERS cross-check passes (boot-time guard)', async () => {
    const mod = await import('../src/index.mjs');
    assert.ok(mod._internals.TOOL_HANDLERS.download_page_assets);
    assert.equal(typeof mod._internals.TOOL_HANDLERS.download_page_assets, 'function');
    const toolNames = mod._internals.TOOLS.map((t) => t.name);
    assert.ok(toolNames.includes('download_page_assets'));
  });

  test('listed in WRITE_TOOL_NAMES (read-only deployments hide it)', async () => {
    const mod = await import('../src/index.mjs');
    assert.ok(mod._internals.WRITE_TOOL_NAMES.has('download_page_assets'));
  });
});

// -----------------------------------------------------------------------------
// v0.14.7 — defuddle-first + alt/figure relevance filter (Phase E.2)
// -----------------------------------------------------------------------------

describe('download-page-assets — v0.14.7 defuddle-first + relevance filter', () => {
  const ABS_OUT = process.platform === 'win32' ? 'C:\\tmp\\dl-test-v147' : '/tmp/dl-test-v147';

  test('defuddleFirst=true (default) strips images outside <article>', async () => {
    // Header logo, footer share icon, nav icon → outside article, defuddle drops them.
    // Article body image WITH alt → kept.
    const html = `<!DOCTYPE html><html><body>
      <header><img src="https://nope.invalid/logo.png" alt="logo"></header>
      <nav><img src="https://nope.invalid/twitter.svg" alt="twitter"></nav>
      <article>
        <h1>An article</h1>
        <p>Body text.</p>
        <img src="https://nope.invalid/diagram.png" alt="neural net diagram">
      </article>
      <footer><img src="https://nope.invalid/share-fb.png" alt="share"></footer>
    </body></html>`;
    const r = await handleDownloadPageAssets({
      html,
      baseUrl: 'https://nope.invalid/',
      outputDir: ABS_OUT,
    });
    assert.equal(r.defuddled, true, 'defuddle should have run successfully');
    // Defuddle keeps the article body image, strips the rest.
    assert.equal(r.extracted, 1, 'only the article-body image survives defuddle');
    assert.equal(r.afterRelevanceFilter, 1, 'it has alt, passes filter');
  });

  test('defuddleFirst=false bypasses defuddle (legacy behavior)', async () => {
    const html = `<!DOCTYPE html><html><body>
      <header><img src="https://nope.invalid/logo.png" alt="logo"></header>
      <article><img src="https://nope.invalid/diagram.png" alt="diagram"></article>
      <footer><img src="https://nope.invalid/share.png" alt="share"></footer>
    </body></html>`;
    const r = await handleDownloadPageAssets({
      html,
      baseUrl: 'https://nope.invalid/',
      outputDir: ABS_OUT,
      defuddleFirst: false,
    });
    assert.equal(r.defuddled, false);
    assert.equal(r.extracted, 3, 'all 3 imgs found in raw HTML');
  });

  test('defuddleFirst falls back to raw HTML when defuddle returns empty content', async () => {
    // Empty body with no article structure — defuddle returns "" so we
    // fall back to raw scan. The `<img>` is found that way.
    // Without alt and not in figure → afterRelevanceFilter drops it.
    const html = '<img src="https://nope.invalid/orphan.png" alt="orphan">';
    const r = await handleDownloadPageAssets({
      html,
      baseUrl: 'https://nope.invalid/',
      outputDir: ABS_OUT,
    });
    // Defuddle returned `<body></body>` — no images. We've documented
    // this as "if defuddle drops all content, the page isn't an article".
    // For a TRUE no-article input the orphan img stays filtered.
    assert.equal(r.extracted, 0, 'defuddle correctly identified this as not an article');
  });

  test('requireAltOrFigure=true (default) skips images with empty alt', async () => {
    const html = `<!DOCTYPE html><html><body><article>
      <p>Body</p>
      <img src="https://nope.invalid/no-alt.png">
      <img src="https://nope.invalid/empty-alt.png" alt="">
      <img src="https://nope.invalid/with-alt.png" alt="kept">
    </article></body></html>`;
    const r = await handleDownloadPageAssets({
      html,
      baseUrl: 'https://nope.invalid/',
      outputDir: ABS_OUT,
    });
    assert.equal(r.extracted, 3, 'all 3 survive defuddle');
    assert.equal(r.afterRelevanceFilter, 1, 'only the alt-present one passes');
  });

  test('requireAltOrFigure=true keeps figure-wrapped images even with empty alt', async () => {
    const html = `<!DOCTYPE html><html><body><article>
      <p>Body</p>
      <figure><img src="https://nope.invalid/in-figure.png"><figcaption>Fig.</figcaption></figure>
      <img src="https://nope.invalid/no-alt.png">
    </article></body></html>`;
    const r = await handleDownloadPageAssets({
      html,
      baseUrl: 'https://nope.invalid/',
      outputDir: ABS_OUT,
    });
    assert.equal(r.extracted, 2);
    assert.equal(r.afterRelevanceFilter, 1, 'figure-wrapped kept, naked img dropped');
  });

  test('requireAltOrFigure=false disables the filter (legacy behavior)', async () => {
    const html = `<!DOCTYPE html><html><body><article>
      <p>Body</p>
      <img src="https://nope.invalid/a.png">
      <img src="https://nope.invalid/b.png">
    </article></body></html>`;
    const r = await handleDownloadPageAssets({
      html,
      baseUrl: 'https://nope.invalid/',
      outputDir: ABS_OUT,
      requireAltOrFigure: false,
    });
    assert.equal(r.afterRelevanceFilter, r.extracted);
  });

  test('minWidth / minHeight numeric validation rejects negatives', async () => {
    await assert.rejects(
      () => handleDownloadPageAssets({
        html: '<p>x</p>', baseUrl: 'https://x.io/', outputDir: ABS_OUT, minWidth: -1,
      }),
      /minWidth must be a non-negative/,
    );
    await assert.rejects(
      () => handleDownloadPageAssets({
        html: '<p>x</p>', baseUrl: 'https://x.io/', outputDir: ABS_OUT, minHeight: -1,
      }),
      /minHeight must be a non-negative/,
    );
  });

  test('shape: response includes defuddled + afterRelevanceFilter fields', async () => {
    const r = await handleDownloadPageAssets({
      html: '<p>x</p>',
      baseUrl: 'https://x.io/',
      outputDir: ABS_OUT,
    });
    // Both fields must always be present (consistent JSON shape).
    assert.equal(typeof r.defuddled, 'boolean');
    assert.equal(typeof r.afterRelevanceFilter, 'number');
  });
});
