/**
 * Tests for src/helpers/wiki-tour-topology.mjs — deterministic tour topology
 * + step skeleton from a UA-schema knowledge graph.
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeTourTopology } from '../src/helpers/wiki-tour-topology.mjs';

function art(id, name) {
  return { id, type: 'article', name, summary: `${name} summary`, tags: ['article'], complexity: 'simple' };
}
function rel(s, t) {
  return { source: s, target: t, type: 'related', direction: 'forward', weight: 0.6 };
}

// index ← a, b, c (fan-in 3); a → b (b fan-in 1); a,b in layer Refs.
function fixtureGraph() {
  return {
    version: '1.0.0',
    kind: 'knowledge',
    project: { name: 'V', languages: ['markdown'], frameworks: [], description: '', analyzedAt: '', gitCommitHash: '' },
    nodes: [
      art('article:wiki/index', 'Index'),
      art('article:wiki/a', 'A'),
      art('article:wiki/b', 'B'),
      art('article:wiki/c', 'C'),
      art('article:wiki/d', 'D'),
      { id: 'topic:refs', type: 'topic', name: 'Refs', summary: '', tags: ['topic'], complexity: 'simple' },
    ],
    edges: [
      rel('article:wiki/a', 'article:wiki/index'),
      rel('article:wiki/b', 'article:wiki/index'),
      rel('article:wiki/c', 'article:wiki/index'),
      rel('article:wiki/a', 'article:wiki/b'),
      { source: 'article:wiki/a', target: 'topic:refs', type: 'categorized_under', direction: 'forward', weight: 0.5 },
      { source: 'article:wiki/b', target: 'topic:refs', type: 'categorized_under', direction: 'forward', weight: 0.5 },
    ],
    layers: [{ id: 'layer:refs', name: 'Refs', description: '', nodeIds: ['article:wiki/a', 'article:wiki/b', 'article:wiki/d'] }],
    tour: [],
  };
}

describe('computeTourTopology — basics', () => {
  test('throws on a non-graph', () => {
    assert.throws(() => computeTourTopology(null), /KnowledgeGraph/);
    assert.throws(() => computeTourTopology({}), /KnowledgeGraph/);
  });

  test('fan-in counts inbound related edges (backlinks)', () => {
    const t = computeTourTopology(fixtureGraph());
    assert.equal(t.fanIn['article:wiki/index'], 3);
    assert.equal(t.fanIn['article:wiki/b'], 1);
    assert.equal(t.fanIn['article:wiki/a'], 0);
    assert.equal(t.fanIn['article:wiki/c'], 0);
  });

  test('entry point = index (name-boosted + highest fan-in)', () => {
    const t = computeTourTopology(fixtureGraph());
    assert.equal(t.entryPoints[0].id, 'article:wiki/index');
  });

  test('steps: overview first; NO node repeated across steps (dedup); layer contributes its non-overview member', () => {
    const t = computeTourTopology(fixtureGraph());
    assert.ok(t.steps[0].title.includes('Overview'));
    assert.ok(t.steps[0].nodeIds.includes('article:wiki/index'));
    // Dedup invariant: no node appears in more than one step (codex review).
    const all = t.steps.flatMap((s) => s.nodeIds);
    assert.equal(all.length, new Set(all).size);
    // The Refs layer surfaces its member that isn't already in the overview (d).
    const refsStep = t.steps.find((s) => s.layer === 'layer:refs');
    assert.ok(refsStep);
    assert.ok(refsStep.nodeIds.includes('article:wiki/d'));
  });

  test('layer steps ranked by importance — higher total fan-in first, not alpha order (codex review)', () => {
    const mk = (n) => art(`article:wiki/${n}`, n);
    const g = {
      version: '1.0.0',
      kind: 'knowledge',
      project: {},
      nodes: ['aa1', 'aa2', 'aa3', 'big', 'small', 's1', 's2', 's3'].map(mk),
      edges: [],
      // Stored alpha-sorted (like build_wiki_graph stores layers): asmall < zbig.
      layers: [
        { id: 'layer:asmall', name: 'ASmall', description: '', nodeIds: ['article:wiki/small'] },
        { id: 'layer:zbig', name: 'ZBig', description: '', nodeIds: ['article:wiki/big'] },
      ],
      tour: [],
    };
    // aa1..aa3 take the 3 overview slots (fan-in 3); big fan-in 3 (loses the
    // tie by id), small fan-in 1 → ZBig outranks ASmall despite alpha order.
    for (const s of ['s1', 's2', 's3']) {
      for (const h of ['aa1', 'aa2', 'aa3', 'big']) g.edges.push(rel(`article:wiki/${s}`, `article:wiki/${h}`));
    }
    g.edges.push(rel('article:wiki/s1', 'article:wiki/small'));
    const t = computeTourTopology(g, { maxSteps: 12 });
    const layerOrder = t.steps.filter((s) => s.layer).map((s) => s.layer);
    assert.deepEqual(layerOrder, ['layer:zbig', 'layer:asmall']);
  });

  test('deterministic — same graph → deep-equal output', () => {
    assert.deepEqual(computeTourTopology(fixtureGraph()), computeTourTopology(fixtureGraph()));
  });
});

describe('computeTourTopology — scope', () => {
  test('scope by layer name restricts to its members', () => {
    const t = computeTourTopology(fixtureGraph(), { scope: 'Refs' });
    assert.equal(t.scope, 'Refs');
    assert.equal(t.totalArticles, 3); // a, b, d
    // index/c are out of scope.
    const ids = new Set(t.steps.flatMap((s) => s.nodeIds));
    assert.ok(!ids.has('article:wiki/index'));
    assert.ok(!ids.has('article:wiki/c'));
  });

  test('scope by path substring', () => {
    const g = fixtureGraph();
    g.nodes.push(art('article:wiki/Dedibox/host', 'Host'));
    g.nodes[g.nodes.length - 1].filePath = 'wiki/Dedibox/host.md';
    const t = computeTourTopology(g, { scope: 'Dedibox' });
    assert.equal(t.totalArticles, 1);
    assert.ok(t.steps.flatMap((s) => s.nodeIds).includes('article:wiki/Dedibox/host'));
  });

  test('maxSteps caps the step count', () => {
    const t = computeTourTopology(fixtureGraph(), { maxSteps: 1 });
    assert.equal(t.steps.length, 1);
  });
});

describe('computeTourTopology — edge cases', () => {
  test('empty graph → 0 articles, 0 steps', () => {
    const g = { version: '1.0.0', kind: 'knowledge', project: {}, nodes: [], edges: [], layers: [], tour: [] };
    const t = computeTourTopology(g);
    assert.equal(t.totalArticles, 0);
    assert.deepEqual(t.steps, []);
    assert.deepEqual(t.entryPoints, []);
  });
});
