/**
 * Integration tests for `src/tools/propose-linked-sources.mjs` MCP tool
 * wrapper. Phase C (v0.13.3) registers this tool in TOOL_REGISTRY of
 * src/index.mjs. Tests verify the wrapper contract (input validation,
 * output shape) and that the tool is wired correctly.
 *
 * Network is NOT exercised here — tests use the `html` input branch
 * with an explicit `baseUrl` to keep them hermetic. SSRF/fetch path is
 * covered by the underlying helpers in `src/markdownify/utils.mjs`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_NAME,
  TOOL_DEFINITION,
  handleProposeLinkedSources,
} from '../src/tools/propose-linked-sources.mjs';

describe('propose-linked-sources — TOOL_DEFINITION shape', () => {
  test('canonical name', () => {
    assert.equal(TOOL_NAME, 'propose_linked_sources');
    assert.equal(TOOL_DEFINITION.name, TOOL_NAME);
  });

  test('input schema has url, html, baseUrl, maxCandidates', () => {
    const schema = TOOL_DEFINITION.inputSchema;
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.url);
    assert.ok(schema.properties.html);
    assert.ok(schema.properties.baseUrl);
    assert.ok(schema.properties.maxCandidates);
    assert.equal(schema.required, undefined);
  });

  test('description mentions scoring + boilerplate strip', () => {
    assert.match(TOOL_DEFINITION.description, /score/i);
    assert.match(TOOL_DEFINITION.description, /(nav|footer|boilerplate)/i);
  });
});

describe('propose-linked-sources — input validation', () => {
  test('throws if neither url nor html', async () => {
    await assert.rejects(
      () => handleProposeLinkedSources({}),
      /one of `url` or `html` is required/,
    );
  });

  test('throws if both url and html', async () => {
    await assert.rejects(
      () => handleProposeLinkedSources({ url: 'https://x.com', html: '<a></a>', baseUrl: 'https://x.com' }),
      /mutually exclusive/,
    );
  });

  test('throws if html provided without baseUrl', async () => {
    await assert.rejects(
      () => handleProposeLinkedSources({ html: '<a href="/x">x</a>' }),
      /`baseUrl` is required when `html` is provided/,
    );
  });
});

describe('propose-linked-sources — hermetic html branch', () => {
  test('returns content array with JSON-stringified candidates', async () => {
    const html = `<article>
      <h1>Test</h1>
      <p>Body link: <a href="https://example.com/a">A</a> and external <a href="https://other.com/b">B</a>.</p>
      <h2>Related</h2>
      <ul><li><a href="/c">C</a></li></ul>
    </article>`;
    const result = await handleProposeLinkedSources({
      html,
      baseUrl: 'https://example.com/page',
    });
    // v0.13.4: handler returns RAW payload (no {content:[...]} wrap).
    assert.equal(result.baseUrl, 'https://example.com/page');
    assert.equal(result.count, 3);
    assert.equal(result.candidates.length, 3);
    // C in "Related" section: +2 same-domain + +3 related = 5
    const c = result.candidates.find((x) => x.href === 'https://example.com/c');
    assert.equal(c.score, 5);
    // A in body: +2 same-domain = 2
    const a = result.candidates.find((x) => x.href === 'https://example.com/a');
    assert.equal(a.score, 2);
    // B cross-domain: 0
    const b = result.candidates.find((x) => x.href === 'https://other.com/b');
    assert.equal(b.score, 0);
  });

  test('honors maxCandidates cap', async () => {
    const html = Array.from(
      { length: 20 },
      (_, i) => `<p><a href="https://other-${i}.com/">link ${i}</a></p>`,
    ).join('');
    const result = await handleProposeLinkedSources({
      html,
      baseUrl: 'https://example.com/',
      maxCandidates: 3,
    });
    assert.equal(result.candidates.length, 3);
    assert.equal(result.count, 3);
  });

  test('empty html returns empty candidates list', async () => {
    const result = await handleProposeLinkedSources({
      html: '<p>nothing</p>',
      baseUrl: 'https://example.com/',
    });
    assert.equal(result.count, 0);
    assert.deepEqual(result.candidates, []);
  });

  test('REGRESSION (v0.13.4): handler returns raw payload, not pre-wrapped {content:[...]}', async () => {
    const result = await handleProposeLinkedSources({
      html: '<p>x</p>',
      baseUrl: 'https://example.com/',
    });
    assert.ok(!('content' in result), 'handler must NOT return a {content:[...]} envelope');
    assert.ok('baseUrl' in result);
    assert.ok('count' in result);
    assert.ok('candidates' in result);
  });
});

describe('propose-linked-sources — URL branch (validation only, no fetch)', () => {
  test('rejects non-http(s) URL', async () => {
    await assert.rejects(
      () => handleProposeLinkedSources({ url: 'file:///etc/passwd' }),
      /Only http: and https:/,
    );
  });

  test('rejects loopback URL via SSRF guard', async () => {
    await assert.rejects(
      () => handleProposeLinkedSources({ url: 'http://127.0.0.1/admin' }),
      /potentially dangerous/i,
    );
  });

  test('rejects malformed URL', async () => {
    await assert.rejects(
      () => handleProposeLinkedSources({ url: 'not-a-url' }),
    );
  });
});

describe('propose-linked-sources — wiring in src/index.mjs', () => {
  test('TOOLS / TOOL_HANDLERS cross-check passes', async () => {
    const mod = await import('../src/index.mjs');
    assert.ok(mod._internals.TOOL_HANDLERS.propose_linked_sources);
    assert.equal(
      typeof mod._internals.TOOL_HANDLERS.propose_linked_sources,
      'function',
    );
    const toolNames = mod._internals.TOOLS.map((t) => t.name);
    assert.ok(toolNames.includes('propose_linked_sources'));
  });

  test('not in WRITE_TOOL_NAMES (no vault mutation)', async () => {
    const mod = await import('../src/index.mjs');
    assert.ok(!mod._internals.WRITE_TOOL_NAMES.has('propose_linked_sources'));
  });
});
