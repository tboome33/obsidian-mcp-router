/**
 * Tests for src/tools/build-wiki-tour.mjs — the read-only tour-skeleton tool.
 * DI-mocked getFileContent returns a graph JSON; no live REST endpoint.
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWikiTourTool,
  TOOL_NAME,
  TOOL_DEFINITION,
} from '../src/tools/build-wiki-tour.mjs';
import { CANONICAL_GRAPH_PATH } from '../src/tools/build-wiki-graph.mjs';

function makeRegistry() {
  return { resolveVault: (name) => ({ name: name || 'test-vault', type: 'local', path: '/tmp/v' }) };
}

const GRAPH = {
  version: '1.0.0',
  kind: 'knowledge',
  project: { name: 'V', languages: ['markdown'], frameworks: [], description: '', analyzedAt: '', gitCommitHash: '' },
  nodes: [
    { id: 'article:wiki/index', type: 'article', name: 'Index', summary: 'The index', tags: ['article'], complexity: 'simple' },
    { id: 'article:wiki/a', type: 'article', name: 'A', summary: 'Page A', tags: ['article'], complexity: 'simple' },
    { id: 'topic:refs', type: 'topic', name: 'Refs', summary: '', tags: ['topic'], complexity: 'simple' },
  ],
  edges: [
    { source: 'article:wiki/a', target: 'article:wiki/index', type: 'related', direction: 'forward', weight: 0.6 },
    { source: 'article:wiki/a', target: 'topic:refs', type: 'categorized_under', direction: 'forward', weight: 0.5 },
  ],
  layers: [{ id: 'layer:refs', name: 'Refs', description: '', nodeIds: ['article:wiki/a'] }],
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
  test('name + read-only schema', () => {
    assert.equal(TOOL_NAME, 'build_wiki_tour');
    assert.equal(TOOL_DEFINITION.name, 'build_wiki_tour');
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
  });
});

describe('buildWikiTourTool', () => {
  test('reads the graph + returns an enriched step skeleton', async () => {
    const res = await buildWikiTourTool(makeRegistry(), {}, depsReturning(JSON.stringify(GRAPH)));
    assert.equal(res.scope, 'whole-vault');
    assert.ok(res.stepCount >= 1);
    // Step nodes carry name + summary for narration.
    const overview = res.steps[0];
    assert.ok(overview.nodes.some((n) => n.id === 'article:wiki/index' && n.name === 'Index'));
    assert.equal(res.entryPoints[0].id, 'article:wiki/index');
    assert.equal(res.graphPath, CANONICAL_GRAPH_PATH);
  });

  test('scope is forwarded to the topology', async () => {
    const res = await buildWikiTourTool(makeRegistry(), { scope: 'Refs' }, depsReturning(JSON.stringify(GRAPH)));
    assert.equal(res.scope, 'Refs');
    assert.equal(res.totalArticles, 1); // only article:wiki/a in layer Refs
  });

  test('missing graph → actionable error pointing at /wiki-graph', async () => {
    const deps = {
      getFileContent: () => {
        const e = new Error('not found');
        e.kind = 'not_found';
        return Promise.reject(e);
      },
    };
    await assert.rejects(() => buildWikiTourTool(makeRegistry(), {}, deps), /build_wiki_graph/);
  });

  test('non-not-found read failure is rethrown (not masked as missing graph — codex review)', async () => {
    const deps = {
      getFileContent: () => {
        const e = new Error('ECONNREFUSED 127.0.0.1');
        e.kind = 'unreachable';
        return Promise.reject(e);
      },
    };
    // The real operational error surfaces; NOT the "run build_wiki_graph" message.
    await assert.rejects(() => buildWikiTourTool(makeRegistry(), {}, deps), /ECONNREFUSED/);
  });

  test('invalid JSON → actionable error', async () => {
    await assert.rejects(
      () => buildWikiTourTool(makeRegistry(), {}, depsReturning('not json {')),
      /not valid JSON/,
    );
  });

  test('malformed graph (no nodes/edges) → actionable error', async () => {
    await assert.rejects(
      () => buildWikiTourTool(makeRegistry(), {}, depsReturning(JSON.stringify({ version: '1.0.0' }))),
      /malformed/,
    );
  });

  test('content returned as {content} object is handled', async () => {
    const res = await buildWikiTourTool(makeRegistry(), {}, depsReturning({ content: JSON.stringify(GRAPH) }));
    assert.ok(res.stepCount >= 1);
  });
});
