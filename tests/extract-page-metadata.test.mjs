/**
 * Integration tests for `src/tools/extract-page-metadata.mjs` MCP tool
 * wrapper. Phase B (v0.13.2) registers this tool in TOOL_REGISTRY of
 * src/index.mjs — these tests verify the wrapper contract (input
 * validation, output shape) and that the tool is wired correctly.
 *
 * Network is NOT exercised here: tests use the `html` input branch to
 * keep them hermetic. The SSRF/fetch path is covered by the helpers
 * in `src/markdownify/utils.mjs` (own test suite) and exercised
 * manually end-to-end during Phase B verification.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_NAME,
  TOOL_DEFINITION,
  handleExtractPageMetadata,
} from '../src/tools/extract-page-metadata.mjs';

describe('extract-page-metadata — TOOL_DEFINITION shape', () => {
  test('exports the canonical name', () => {
    assert.equal(TOOL_NAME, 'extract_page_metadata');
    assert.equal(TOOL_DEFINITION.name, TOOL_NAME);
  });

  test('input schema declares url and html as mutually optional', () => {
    const schema = TOOL_DEFINITION.inputSchema;
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.url);
    assert.ok(schema.properties.html);
    assert.ok(schema.properties.body);
    // No `required` — caller may pass either url or html (one of two).
    // The handler enforces the XOR at runtime.
    assert.equal(schema.required, undefined);
  });

  test('description is non-trivial (visible to MCP clients)', () => {
    assert.ok(TOOL_DEFINITION.description);
    assert.ok(TOOL_DEFINITION.description.length > 50);
    assert.match(TOOL_DEFINITION.description, /metadata/i);
  });
});

describe('extract-page-metadata — handler input validation', () => {
  test('throws if neither url nor html is provided', async () => {
    await assert.rejects(
      () => handleExtractPageMetadata({}),
      /one of `url` or `html` is required/,
    );
  });

  test('throws if both url and html are provided', async () => {
    await assert.rejects(
      () => handleExtractPageMetadata({ url: 'https://x.com', html: '<html></html>' }),
      /mutually exclusive/,
    );
  });

  test('throws if no args at all', async () => {
    await assert.rejects(() => handleExtractPageMetadata());
  });
});

describe('extract-page-metadata — handler with html input (hermetic)', () => {
  test('returns content array with JSON-stringified metadata', async () => {
    const html = `<html lang="en"><head>
      <title>Test Page</title>
      <meta property="og:title" content="OG Title">
      <meta property="article:published_time" content="2026-05-24">
      <meta property="article:author" content="Alice">
      <meta property="og:site_name" content="ExampleSite">
    </head><body><p>One two three four five.</p></body></html>`;
    const result = await handleExtractPageMetadata({ html });
    // v0.13.4: handler returns RAW payload (no {content:[...]} wrap).
    // The router's wrapResult does the MCP-shape wrap; pre-v0.13.4
    // returning {content:[...]} from the handler caused double-wrap.
    assert.equal(result.title, 'OG Title');
    assert.equal(result.author, 'Alice');
    assert.equal(result.published, '2026-05-24');
    assert.equal(result.site, 'ExampleSite');
    assert.equal(result.lang, 'en');
    assert.ok(result.wordCount > 0);
  });

  test('html with no metadata returns all-null structured response', async () => {
    const html = '<html><head><title>X</title></head><body><p>hi</p></body></html>';
    const result = await handleExtractPageMetadata({ html });
    assert.equal(result.title, 'X');
    assert.equal(result.author, null);
    assert.equal(result.published, null);
  });

  test('body input overrides word-count source when provided', async () => {
    const html = '<html><head><title>x</title></head><body><p>one two three</p></body></html>';
    const bigBody = 'word '.repeat(1000).trim();
    const result = await handleExtractPageMetadata({ html, body: bigBody });
    assert.equal(result.wordCount, 1000);
    // ceil(1000/220) = 5
    assert.equal(result.readingMinutes, 5);
  });

  test('REGRESSION (v0.13.4): handler returns raw payload, not pre-wrapped {content:[...]}', async () => {
    // Pre-v0.13.4 the handler returned `{content:[{type:'text', text:
    // JSON.stringify(...)}]}` and then the router's wrapResult re-wrapped
    // it, so MCP clients saw `{"content":[...]}` as the actual text
    // instead of the documented payload. Verify the handler now returns
    // the raw object.
    const result = await handleExtractPageMetadata({ html: '<title>x</title>' });
    assert.ok(!('content' in result), 'handler must NOT return a {content:[...]} envelope');
    assert.ok('title' in result);
    assert.ok('wordCount' in result);
  });
});

describe('extract-page-metadata — handler with url input (validation only, no fetch)', () => {
  test('rejects non-http(s) URL via SSRF guard', async () => {
    await assert.rejects(
      () => handleExtractPageMetadata({ url: 'file:///etc/passwd' }),
      /Only http: and https:/,
    );
  });

  test('rejects URL with private/loopback IP literal via SSRF guard', async () => {
    await assert.rejects(
      () => handleExtractPageMetadata({ url: 'http://127.0.0.1/admin' }),
      /potentially dangerous/i,
    );
  });

  test('rejects malformed URL', async () => {
    await assert.rejects(
      () => handleExtractPageMetadata({ url: 'not-a-url' }),
    );
  });
});

describe('extract-page-metadata — wiring into src/index.mjs', () => {
  test('TOOLS / TOOL_HANDLERS cross-check passes (boot-time guard)', async () => {
    // Importing src/index.mjs runs the boot-time cross-check between
    // TOOLS and TOOL_HANDLERS. If extract_page_metadata is missing from
    // either side, this import throws — which is exactly the contract
    // we want to test.
    const mod = await import('../src/index.mjs');
    assert.ok(mod._internals.TOOL_HANDLERS.extract_page_metadata);
    assert.equal(
      typeof mod._internals.TOOL_HANDLERS.extract_page_metadata,
      'function',
    );
    // Also confirm the tool is in the TOOLS list (the listing surface).
    const toolNames = mod._internals.TOOLS.map((t) => t.name);
    assert.ok(toolNames.includes('extract_page_metadata'));
  });
});
