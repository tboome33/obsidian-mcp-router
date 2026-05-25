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
    for (const k of ['url', 'html', 'baseUrl', 'outputDir', 'minBytes', 'maxBytes', 'concurrency', 'maxAssets']) {
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
    const html = Array.from({ length: 5 }, (_, i) => `<img src="https://nope.invalid/img${i}.png">`).join('');
    const r = await handleDownloadPageAssets({
      html,
      baseUrl: 'https://nope.invalid/',
      outputDir: ABS_OUT,
      maxAssets: 2,
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
