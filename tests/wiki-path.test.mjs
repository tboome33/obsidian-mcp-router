/**
 * Tests for src/tools/wiki-path.mjs — the read-only "shortest link chain
 * between two pages" tool. DI-mocked getFileContent returns a graph JSON; no
 * live REST endpoint. Mirrors tests/get-page-neighbors.test.mjs (same
 * graph-reading contract). Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  wikiPathTool,
  TOOL_NAME,
  TOOL_DEFINITION,
} from '../src/tools/wiki-path.mjs';
import { CANONICAL_GRAPH_PATH } from '../src/tools/build-wiki-graph.mjs';

function makeRegistry() {
  return { resolveVault: (name) => ({ name: name || 'test-vault', type: 'local', path: '/tmp/v' }) };
}

const GRAPH = {
  version: '1.0.0',
  kind: 'knowledge',
  project: { name: 'V', languages: ['markdown'], frameworks: [], description: '', analyzedAt: '2026-07-09T10:00:00.000Z', gitCommitHash: '' },
  nodes: [
    { id: 'article:wiki/a', type: 'article', name: 'A', filePath: 'wiki/a.md', summary: '', tags: ['article'], complexity: 'simple' },
    { id: 'article:wiki/b', type: 'article', name: 'B', filePath: 'wiki/b.md', summary: '', tags: ['article'], complexity: 'simple' },
    { id: 'article:wiki/c', type: 'article', name: 'C', filePath: 'wiki/c.md', summary: '', tags: ['article'], complexity: 'simple' },
    { id: 'article:wiki/island', type: 'article', name: 'Island', filePath: 'wiki/island.md', summary: '', tags: ['article'], complexity: 'simple' },
    { id: 'entity:oauth', type: 'entity', name: 'OAuth', summary: '', tags: ['entity'], complexity: 'simple' },
  ],
  edges: [
    { source: 'article:wiki/a', target: 'article:wiki/b', type: 'related', direction: 'forward', weight: 0.6 },
    { source: 'article:wiki/b', target: 'article:wiki/c', type: 'related', direction: 'forward', weight: 0.6 },
    // a and c ALSO share the concept oauth (for the nodeTypes-bridge test).
    { source: 'article:wiki/a', target: 'entity:oauth', type: 'related', direction: 'forward', weight: 0.4 },
    { source: 'article:wiki/c', target: 'entity:oauth', type: 'related', direction: 'forward', weight: 0.4 },
  ],
  layers: [],
  tour: [],
};

function depsReturning(content) {
  return {
    getFileContent: (_vault, path) => {
      assert.equal(path, CANONICAL_GRAPH_PATH);
      return Promise.resolve(content);
    },
  };
}

describe('TOOL_DEFINITION', () => {
  test('name + read-only schema requiring from + to', () => {
    assert.equal(TOOL_NAME, 'wiki_path');
    assert.equal(TOOL_DEFINITION.name, 'wiki_path');
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
    assert.ok(TOOL_DEFINITION.inputSchema.required.includes('from'));
    assert.ok(TOOL_DEFINITION.inputSchema.required.includes('to'));
  });
});

describe('wikiPathTool', () => {
  test('finds the shortest link chain + metadata', async () => {
    const res = await wikiPathTool(makeRegistry(), { from: 'wiki/a.md', to: 'wiki/c.md' }, depsReturning(JSON.stringify(GRAPH)));
    assert.equal(res.vault, 'test-vault');
    assert.equal(res.graphPath, CANONICAL_GRAPH_PATH);
    assert.equal(res.graphAnalyzedAt, '2026-07-09T10:00:00.000Z');
    assert.equal(res.found, true);
    assert.deepEqual(res.path.map((n) => n.id), ['article:wiki/a', 'article:wiki/b', 'article:wiki/c']);
    assert.equal(res.length, 2);
  });

  test('disconnected pages → path null, found false (NOT an error)', async () => {
    const res = await wikiPathTool(makeRegistry(), { from: 'wiki/a.md', to: 'wiki/island.md' }, depsReturning(JSON.stringify(GRAPH)));
    assert.equal(res.found, false);
    assert.equal(res.path, null);
    assert.equal(res.length, null);
  });

  test('nodeTypes ["article","entity"] bridges through the shared concept', async () => {
    // Sever the direct a-b-c chain so a..c connect ONLY via entity:oauth.
    const g = JSON.parse(JSON.stringify(GRAPH));
    g.edges = g.edges.filter((e) => e.type !== 'related' || (e.target !== 'article:wiki/b' && e.source !== 'article:wiki/b'));
    const res = await wikiPathTool(
      makeRegistry(),
      { from: 'wiki/a.md', to: 'wiki/c.md', nodeTypes: ['article', 'entity'] },
      depsReturning(JSON.stringify(g)),
    );
    assert.equal(res.found, true);
    assert.deepEqual(res.path.map((n) => n.id), ['article:wiki/a', 'entity:oauth', 'article:wiki/c']);
  });

  test('echoes the resolved query params', async () => {
    const res = await wikiPathTool(makeRegistry(), { from: 'wiki/a.md', to: 'wiki/c.md', maxDepth: 4 }, depsReturning(JSON.stringify(GRAPH)));
    assert.equal(res.query.from, 'article:wiki/a');
    assert.equal(res.query.to, 'article:wiki/c');
    assert.equal(res.query.maxDepth, 4);
  });

  test('missing graph → actionable error pointing at /wiki-graph', async () => {
    const deps = {
      getFileContent: () => {
        const e = new Error('not found');
        e.kind = 'not_found';
        return Promise.reject(e);
      },
    };
    await assert.rejects(() => wikiPathTool(makeRegistry(), { from: 'wiki/a.md', to: 'wiki/c.md' }, deps), /build_wiki_graph/);
  });

  test('non-not-found read failure is rethrown', async () => {
    const deps = {
      getFileContent: () => {
        const e = new Error('ECONNREFUSED 127.0.0.1');
        e.kind = 'unreachable';
        return Promise.reject(e);
      },
    };
    await assert.rejects(() => wikiPathTool(makeRegistry(), { from: 'wiki/a.md', to: 'wiki/c.md' }, deps), /ECONNREFUSED/);
  });

  test('invalid JSON → actionable error', async () => {
    await assert.rejects(
      () => wikiPathTool(makeRegistry(), { from: 'wiki/a.md', to: 'wiki/c.md' }, depsReturning('not json {')),
      /not valid JSON/,
    );
  });

  test('malformed graph → actionable error', async () => {
    await assert.rejects(
      () => wikiPathTool(makeRegistry(), { from: 'wiki/a.md', to: 'wiki/c.md' }, depsReturning(JSON.stringify({ version: '1.0.0' }))),
      /malformed/,
    );
  });

  test('content returned as {content} object is handled', async () => {
    const res = await wikiPathTool(makeRegistry(), { from: 'wiki/a.md', to: 'wiki/c.md' }, depsReturning({ content: JSON.stringify(GRAPH) }));
    assert.equal(res.found, true);
  });

  test('unknown "from" → resolution error propagates', async () => {
    await assert.rejects(
      () => wikiPathTool(makeRegistry(), { from: 'nope', to: 'wiki/c.md' }, depsReturning(JSON.stringify(GRAPH))),
      /not found/i,
    );
  });
});
