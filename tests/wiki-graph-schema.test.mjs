/**
 * Tests for src/helpers/wiki-graph-schema.mjs — UA-schema vocabulary,
 * ID builders, empty-graph scaffold, and the validator.
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  NODE_TYPES,
  EDGE_TYPES,
  KNOWLEDGE_NODE_TYPES,
  kebab,
  normalisePathForId,
  articleId,
  entityId,
  topicId,
  claimId,
  sourceId,
  emptyGraph,
  validateGraph,
} from '../src/helpers/wiki-graph-schema.mjs';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('vocabulary', () => {
  test('21 node types, 35 edge types', () => {
    assert.equal(NODE_TYPES.length, 21);
    assert.equal(EDGE_TYPES.length, 35);
  });
  test('the 5 knowledge node types are present', () => {
    for (const t of ['article', 'entity', 'topic', 'claim', 'source']) {
      assert.ok(NODE_TYPES.includes(t), `${t} in NODE_TYPES`);
      assert.ok(KNOWLEDGE_NODE_TYPES.includes(t), `${t} in KNOWLEDGE_NODE_TYPES`);
    }
  });
  test('knowledge edge types are present', () => {
    for (const t of ['cites', 'contradicts', 'builds_on', 'exemplifies', 'categorized_under', 'authored_by']) {
      assert.ok(EDGE_TYPES.includes(t), `${t} in EDGE_TYPES`);
    }
  });
});

// ---------------------------------------------------------------------------
// ID builders
// ---------------------------------------------------------------------------

describe('kebab', () => {
  test('lowercases + hyphenates', () => {
    assert.equal(kebab('OAuth 2.0 Flow'), 'oauth-2-0-flow');
  });
  test('trims leading/trailing separators', () => {
    assert.equal(kebab('  Hello, World!  '), 'hello-world');
  });
  test('preserves unicode letters', () => {
    assert.equal(kebab('Café Périph'), 'café-périph');
  });
  test('empty / non-string → empty', () => {
    assert.equal(kebab(''), '');
    assert.equal(kebab(null), '');
  });
});

describe('id builders', () => {
  test('articleId keeps path, strips .md, normalises slashes', () => {
    assert.equal(articleId('wiki/Refs/oauth-howto.md'), 'article:wiki/Refs/oauth-howto');
    assert.equal(articleId('wiki\\A\\B.md'), 'article:wiki/A/B');
  });
  test('entityId kebabs (deduping form)', () => {
    assert.equal(entityId('OAuth 2.0'), 'entity:oauth-2-0');
    assert.equal(entityId('oauth 2.0'), entityId('OAuth 2.0'));
  });
  test('topicId kebabs', () => {
    assert.equal(topicId('External References'), 'topic:external-references');
  });
  test('claimId namespaces by page stem', () => {
    const id = claimId('wiki/Refs/oauth.md', 'PKCE replaces the implicit flow');
    assert.match(id, /^claim:oauth:/);
  });
  test('sourceId keeps URLs, normalises local paths', () => {
    assert.equal(sourceId('https://example.com/x'), 'source:https://example.com/x');
    assert.equal(sourceId('raw/paper.pdf'), 'source:raw/paper.pdf');
  });
  test('normalisePathForId strips .md + backslashes', () => {
    assert.equal(normalisePathForId('a\\b.md'), 'a/b');
  });
});

// ---------------------------------------------------------------------------
// emptyGraph
// ---------------------------------------------------------------------------

describe('emptyGraph', () => {
  test('produces a valid scaffold', () => {
    const g = emptyGraph({ name: 'Vault', kind: 'knowledge', analyzedAt: '2026-01-01T00:00:00Z' });
    assert.equal(g.version, SCHEMA_VERSION);
    assert.equal(g.kind, 'knowledge');
    assert.equal(g.project.name, 'Vault');
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
    assert.deepEqual(g.layers, []);
    assert.deepEqual(g.tour, []);
    const report = validateGraph(g);
    assert.ok(report.valid, report.errors.join('; '));
  });
  test('invalid kind falls back to knowledge', () => {
    assert.equal(emptyGraph({ name: 'V', kind: 'bogus' }).kind, 'knowledge');
  });
});

// ---------------------------------------------------------------------------
// validateGraph
// ---------------------------------------------------------------------------

function minimalValidGraph() {
  return {
    version: SCHEMA_VERSION,
    kind: 'knowledge',
    project: { name: 'V', languages: ['markdown'], frameworks: [], description: '', analyzedAt: '', gitCommitHash: '' },
    nodes: [
      { id: 'article:a', type: 'article', name: 'A', summary: 's', tags: ['article'], complexity: 'simple' },
      { id: 'entity:x', type: 'entity', name: 'X', summary: '', tags: ['entity'], complexity: 'simple' },
    ],
    edges: [
      { source: 'article:a', target: 'entity:x', type: 'related', direction: 'forward', weight: 0.4 },
    ],
    layers: [{ id: 'layer:l', name: 'L', description: '', nodeIds: ['article:a'] }],
    tour: [],
  };
}

describe('validateGraph', () => {
  test('accepts a minimal valid graph', () => {
    const r = validateGraph(minimalValidGraph());
    assert.ok(r.valid, r.errors.join('; '));
    assert.deepEqual(r.errors, []);
  });
  test('rejects non-object', () => {
    assert.equal(validateGraph(null).valid, false);
    assert.equal(validateGraph([]).valid, false);
  });
  test('rejects bad kind', () => {
    const g = minimalValidGraph();
    g.kind = 'nope';
    const r = validateGraph(g);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /kind/.test(e)));
  });
  test('rejects duplicate node ids', () => {
    const g = minimalValidGraph();
    g.nodes.push({ id: 'article:a', type: 'entity', name: 'dup', summary: '', tags: [], complexity: 'simple' });
    const r = validateGraph(g);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /duplicated/.test(e)));
  });
  test('rejects dangling edge', () => {
    const g = minimalValidGraph();
    g.edges.push({ source: 'article:a', target: 'entity:ghost', type: 'related', weight: 0.5 });
    const r = validateGraph(g);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /does not reference an existing node/.test(e)));
  });
  test('rejects self-edge', () => {
    const g = minimalValidGraph();
    g.edges.push({ source: 'article:a', target: 'article:a', type: 'related', weight: 0.5 });
    const r = validateGraph(g);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /self-edge/.test(e)));
  });
  test('rejects out-of-range weight', () => {
    const g = minimalValidGraph();
    g.edges[0].weight = 1.5;
    assert.equal(validateGraph(g).valid, false);
  });
  test('rejects bad node type / missing fields', () => {
    const g = minimalValidGraph();
    g.nodes.push({ id: 'x:1', type: 'widget', name: '', summary: 0, tags: 'no', complexity: 'huge' });
    const r = validateGraph(g);
    assert.equal(r.valid, false);
    assert.ok(r.errors.length >= 3);
  });
  test('unknown edge type is a warning, not an error', () => {
    const g = minimalValidGraph();
    g.edges[0].type = 'frobnicates';
    const r = validateGraph(g);
    assert.ok(r.valid, r.errors.join('; '));
    assert.ok(r.warnings.some((w) => /frobnicates/.test(w)));
  });
  test('empty edge type IS an error', () => {
    const g = minimalValidGraph();
    g.edges[0].type = '';
    assert.equal(validateGraph(g).valid, false);
  });
});
