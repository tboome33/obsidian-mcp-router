/**
 * Tests for src/tools/get-page-neighbors.mjs — the read-only page-neighbourhood
 * tool. DI-mocked getFileContent returns a graph JSON; no live REST endpoint.
 * Mirrors tests/build-wiki-tour.test.mjs (same graph-reading contract). Run
 * with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getPageNeighborsTool,
  TOOL_NAME,
  TOOL_DEFINITION,
} from '../src/tools/get-page-neighbors.mjs';
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
    { id: 'entity:oauth', type: 'entity', name: 'OAuth', summary: '', tags: ['entity'], complexity: 'simple' },
  ],
  edges: [
    { source: 'article:wiki/a', target: 'article:wiki/b', type: 'related', direction: 'forward', weight: 0.6 },
    { source: 'article:wiki/c', target: 'article:wiki/a', type: 'related', direction: 'forward', weight: 0.6 },
    { source: 'article:wiki/a', target: 'entity:oauth', type: 'related', direction: 'forward', weight: 0.4 },
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
  test('name + read-only schema requiring `page`', () => {
    assert.equal(TOOL_NAME, 'get_page_neighbors');
    assert.equal(TOOL_DEFINITION.name, 'get_page_neighbors');
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
    assert.ok(TOOL_DEFINITION.inputSchema.required.includes('page'));
  });

  test('schema declares includeSameFolder + includeSharedTags (A5)', () => {
    assert.equal(TOOL_DEFINITION.inputSchema.properties.includeSameFolder.type, 'boolean');
    assert.equal(TOOL_DEFINITION.inputSchema.properties.includeSharedTags.type, 'boolean');
  });
});

describe('getPageNeighborsTool', () => {
  test('reads the graph + returns neighbours with metadata', async () => {
    const res = await getPageNeighborsTool(makeRegistry(), { page: 'wiki/a.md' }, depsReturning(JSON.stringify(GRAPH)));
    assert.equal(res.vault, 'test-vault');
    assert.equal(res.graphPath, CANONICAL_GRAPH_PATH);
    assert.equal(res.graphAnalyzedAt, '2026-07-09T10:00:00.000Z');
    assert.equal(res.page.id, 'article:wiki/a');
    // both directions, depth 1, articles only: b (forward) + c (backward).
    assert.deepEqual(res.neighbors.map((n) => n.id), ['article:wiki/b', 'article:wiki/c']);
    assert.equal(res.truncated, false);
  });

  test('direction/depth/nodeTypes args are forwarded', async () => {
    const res = await getPageNeighborsTool(
      makeRegistry(),
      { page: 'wiki/a.md', direction: 'forward', depth: 1, nodeTypes: ['entity'] },
      depsReturning(JSON.stringify(GRAPH)),
    );
    assert.deepEqual(res.neighbors.map((n) => n.id), ['entity:oauth']);
  });

  test('echoes the resolved query params', async () => {
    const res = await getPageNeighborsTool(
      makeRegistry(),
      { page: 'wiki/a.md', direction: 'forward', depth: 2 },
      depsReturning(JSON.stringify(GRAPH)),
    );
    assert.equal(res.query.direction, 'forward');
    assert.equal(res.query.depth, 2);
  });

  test('missing graph → actionable error pointing at /wiki-graph', async () => {
    const deps = {
      getFileContent: () => {
        const e = new Error('not found');
        e.kind = 'not_found';
        return Promise.reject(e);
      },
    };
    await assert.rejects(() => getPageNeighborsTool(makeRegistry(), { page: 'wiki/a.md' }, deps), /build_wiki_graph/);
  });

  test('non-not-found read failure is rethrown (not masked as missing graph)', async () => {
    const deps = {
      getFileContent: () => {
        const e = new Error('ECONNREFUSED 127.0.0.1');
        e.kind = 'unreachable';
        return Promise.reject(e);
      },
    };
    await assert.rejects(() => getPageNeighborsTool(makeRegistry(), { page: 'wiki/a.md' }, deps), /ECONNREFUSED/);
  });

  test('invalid JSON → actionable error', async () => {
    await assert.rejects(
      () => getPageNeighborsTool(makeRegistry(), { page: 'wiki/a.md' }, depsReturning('not json {')),
      /not valid JSON/,
    );
  });

  test('malformed graph (no nodes/edges) → actionable error', async () => {
    await assert.rejects(
      () => getPageNeighborsTool(makeRegistry(), { page: 'wiki/a.md' }, depsReturning(JSON.stringify({ version: '1.0.0' }))),
      /malformed/,
    );
  });

  test('content returned as {content} object is handled', async () => {
    const res = await getPageNeighborsTool(makeRegistry(), { page: 'wiki/a.md' }, depsReturning({ content: JSON.stringify(GRAPH) }));
    assert.ok(res.neighbors.length >= 1);
  });

  test('unknown page → resolution error propagates', async () => {
    await assert.rejects(
      () => getPageNeighborsTool(makeRegistry(), { page: 'nope' }, depsReturning(JSON.stringify(GRAPH))),
      /not found/i,
    );
  });
});

describe('getPageNeighborsTool — A5 enrichment pass-through', () => {
  test('sameFolderNeighbors/sharedTagNeighbors default to empty when not requested', async () => {
    const res = await getPageNeighborsTool(makeRegistry(), { page: 'wiki/a.md' }, depsReturning(JSON.stringify(GRAPH)));
    assert.deepEqual(res.sameFolderNeighbors, []);
    assert.deepEqual(res.sharedTagNeighbors, []);
  });

  test('includeSameFolder: true surfaces same-directory siblings', async () => {
    const res = await getPageNeighborsTool(
      makeRegistry(),
      { page: 'wiki/a.md', includeSameFolder: true },
      depsReturning(JSON.stringify(GRAPH)),
    );
    // a, b, c all live at wiki/*.md in this fixture.
    assert.deepEqual(res.sameFolderNeighbors.map((n) => n.id).sort(), ['article:wiki/b', 'article:wiki/c']);
  });

  test('includeSharedTags: true surfaces tag-sharing pages', async () => {
    const g = JSON.parse(JSON.stringify(GRAPH));
    g.nodes.find((n) => n.id === 'article:wiki/a').tags = ['article', 'roadmap'];
    g.nodes.find((n) => n.id === 'article:wiki/b').tags = ['article', 'roadmap'];
    const res = await getPageNeighborsTool(
      makeRegistry(),
      { page: 'wiki/a.md', includeSharedTags: true },
      depsReturning(JSON.stringify(g)),
    );
    assert.deepEqual(res.sharedTagNeighbors.map((n) => n.id), ['article:wiki/b']);
    assert.deepEqual(res.sharedTagNeighbors[0].sharedTags, ['roadmap']);
  });
});
