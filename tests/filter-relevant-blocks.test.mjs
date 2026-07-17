/**
 * Tests for src/tools/filter-relevant-blocks.mjs (the tool shell), its
 * registration in src/index.mjs, and the opt-in relevanceQuery wiring on
 * webpage_to_markdown (src/tools/convert.mjs). Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterRelevantBlocksTool,
  TOOL_NAME,
  TOOL_DEFINITION,
} from '../src/tools/filter-relevant-blocks.mjs';
import { webpageToMarkdown, _internals as convertInternals } from '../src/tools/convert.mjs';
import { _internals } from '../src/index.mjs';

const WG_DOC = [
  '# WireGuard setup',
  '',
  'WireGuard is a fast VPN tunnel using modern cryptography. Configure the wireguard interface with a private key.',
  '',
  'Subscribe to our newsletter for weekly lifestyle tips, recipes, and travel photography inspiration.',
  '',
  'The author enjoys hiking and mountain photography in their spare time on quiet weekends.',
  '',
  'To bring up the wireguard tunnel run wg-quick up wg0 and verify the handshake with wg show.',
].join('\n');

const registry = { resolveVault: () => ({ name: 'v', type: 'local', path: '/tmp/v' }) };

describe('TOOL_DEFINITION + registration', () => {
  test('name, required fields, additionalProperties:false', () => {
    assert.equal(TOOL_NAME, 'filter_relevant_blocks');
    assert.equal(TOOL_DEFINITION.name, 'filter_relevant_blocks');
    assert.deepEqual(TOOL_DEFINITION.inputSchema.required, ['markdown', 'query']);
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
    assert.deepEqual(
      Object.keys(TOOL_DEFINITION.inputSchema.properties).sort(),
      ['includeScores', 'markdown', 'query', 'threshold'],
    );
  });

  test('registered in TOOLS + TOOL_HANDLERS, absent from WRITE_TOOL_NAMES', () => {
    assert.ok(_internals.TOOLS.some((t) => t.name === 'filter_relevant_blocks'));
    assert.ok('filter_relevant_blocks' in _internals.TOOL_HANDLERS);
    assert.equal(_internals.WRITE_TOOL_NAMES.has('filter_relevant_blocks'), false);
  });
});

describe('filterRelevantBlocksTool', () => {
  test('happy path returns { markdown, filtered, stats }', async () => {
    const r = await filterRelevantBlocksTool(registry, {
      markdown: WG_DOC,
      query: 'wireguard tunnel configuration',
    });
    assert.equal(r.filtered, true);
    assert.equal(typeof r.markdown, 'string');
    assert.equal(r.stats.kept, 2);
    assert.equal(r.stats.scoredBlocks, 4);
    assert.ok(!('scores' in r)); // includeScores defaults off
  });

  test('includeScores:true attaches a scores array', async () => {
    const r = await filterRelevantBlocksTool(registry, {
      markdown: WG_DOC,
      query: 'wireguard',
      includeScores: true,
    });
    assert.ok(Array.isArray(r.scores));
    assert.equal(r.scores.length, 4);
  });

  test('missing markdown or query (non-string) throws the standard error', async () => {
    await assert.rejects(
      () => filterRelevantBlocksTool(registry, { query: 'x' }),
      /Missing required argument: markdown/,
    );
    await assert.rejects(
      () => filterRelevantBlocksTool(registry, { markdown: 'x' }),
      /Missing required argument: query/,
    );
  });

  test('empty-string query is a no-op (not an error)', async () => {
    const r = await filterRelevantBlocksTool(registry, { markdown: WG_DOC, query: '' });
    assert.equal(r.filtered, false);
    assert.equal(r.stats.reason, 'empty-query');
    assert.equal(r.markdown, WG_DOC);
  });
});

describe('webpage_to_markdown relevanceQuery wiring', () => {
  // `_deps.convert` injects fake converted markdown — no network, no markitdown.
  const deps = { convert: async () => WG_DOC };

  test('no relevanceQuery → byte-identical to the converted markdown (non-regression)', async () => {
    const out = await webpageToMarkdown(registry, { url: 'http://x' }, deps);
    assert.equal(out, WG_DOC);
    assert.doesNotMatch(out, /bm25-filter/);
  });

  test('blank relevanceQuery → strict no-op, still byte-identical', async () => {
    const out = await webpageToMarkdown(registry, { url: 'http://x', relevanceQuery: '   ' }, deps);
    assert.equal(out, WG_DOC);
  });

  test('relevanceQuery → filtered markdown + trailing one-line stats comment', async () => {
    const out = await webpageToMarkdown(
      registry,
      { url: 'http://x', relevanceQuery: 'wireguard tunnel' },
      deps,
    );
    const lines = out.split('\n');
    assert.match(lines[lines.length - 1], /^<!-- bm25-filter: kept 2\/4 scored blocks \(threshold 0\.2\) -->$/);
    // The off-topic blocks are gone from the body.
    assert.doesNotMatch(out, /newsletter/);
  });

  test('relevanceQuery that matches nothing → over-filter no-op comment, body intact', async () => {
    const out = await webpageToMarkdown(
      registry,
      { url: 'http://x', relevanceQuery: 'kubernetes helm istio' },
      deps,
    );
    assert.match(out, /<!-- bm25-filter: no-op \(over-filter-guard: would drop \d+% > 70%\) -->$/);
    assert.match(out, /newsletter/); // body untouched
  });
});

describe('bm25StatsComment formatting', () => {
  const { bm25StatsComment } = convertInternals;

  test('filtered → kept X/Y with threshold', () => {
    const c = bm25StatsComment(true, { kept: 15, scoredBlocks: 34, threshold: 0.2 });
    assert.equal(c, '<!-- bm25-filter: kept 15/34 scored blocks (threshold 0.2) -->');
  });

  test('over-filter-guard → would drop N% > 70%', () => {
    const c = bm25StatsComment(false, { reason: 'over-filter-guard', dropFraction: 0.86 });
    assert.equal(c, '<!-- bm25-filter: no-op (over-filter-guard: would drop 86% > 70%) -->');
  });

  test('other no-op reasons pass through', () => {
    assert.equal(
      bm25StatsComment(false, { reason: 'too-few-blocks' }),
      '<!-- bm25-filter: no-op (too-few-blocks) -->',
    );
  });
});
