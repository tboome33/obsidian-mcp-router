/**
 * Tests for src/helpers/graph-neighbors.mjs — the PURE graph-traversal helpers
 * behind `get_page_neighbors` (computeNeighbors) and `wiki_path` (computePath).
 *
 * No I/O: every test hands in a plain graph object (the UA-schema shape written
 * by build_wiki_graph) and asserts on the returned structure. Same philosophy
 * as tests/wiki-tour-topology.test.mjs. Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeNeighbors, computePath } from '../src/helpers/graph-neighbors.mjs';

// ---------------------------------------------------------------------------
// Fixture — a small but deliberately tricky knowledge graph.
//
//   article:wiki/a (A)  --related-->  article:wiki/b (B)  --related-->  article:wiki/c (C)
//        ^                                                                    |
//        |------------------------- related --------------------------------- (C -> A backlink)
//   A --related(0.4)--> entity:oauth (OAuth)     B --related--> entity:oauth   (shared concept)
//   A --categorized_under--> topic:refs (Refs)
//   A --cites--> source:foo (foo)
//
//   A hub page linking four leaves, for the maxNeighbors cap:
//   article:wiki/hub (Hub) --related--> {a, b, c, d}
//
//   A basename collision: article:wiki/sub/dup + article:wiki/other/dup (both "Dup").
// ---------------------------------------------------------------------------

function makeGraph() {
  return {
    version: '1.0.0',
    kind: 'knowledge',
    project: { name: 'V', analyzedAt: '2026-07-09T10:00:00.000Z' },
    nodes: [
      { id: 'article:wiki/a', type: 'article', name: 'A', filePath: 'wiki/a.md', summary: '', tags: ['article'], complexity: 'simple' },
      { id: 'article:wiki/b', type: 'article', name: 'B', filePath: 'wiki/b.md', summary: '', tags: ['article'], complexity: 'simple' },
      { id: 'article:wiki/c', type: 'article', name: 'C', filePath: 'wiki/c.md', summary: '', tags: ['article'], complexity: 'simple' },
      { id: 'article:wiki/d', type: 'article', name: 'D', filePath: 'wiki/d.md', summary: '', tags: ['article'], complexity: 'simple' },
      { id: 'article:wiki/hub', type: 'article', name: 'Hub', filePath: 'wiki/hub.md', summary: '', tags: ['article'], complexity: 'simple' },
      { id: 'article:wiki/sub/dup', type: 'article', name: 'Dup', filePath: 'wiki/sub/dup.md', summary: '', tags: ['article'], complexity: 'simple' },
      { id: 'article:wiki/other/dup', type: 'article', name: 'Dup', filePath: 'wiki/other/dup.md', summary: '', tags: ['article'], complexity: 'simple' },
      { id: 'entity:oauth', type: 'entity', name: 'OAuth', summary: '', tags: ['entity'], complexity: 'simple' },
      { id: 'topic:refs', type: 'topic', name: 'Refs', summary: '', tags: ['topic'], complexity: 'simple' },
      { id: 'source:foo', type: 'source', name: 'foo', summary: '', tags: ['source'], complexity: 'simple' },
    ],
    edges: [
      { source: 'article:wiki/a', target: 'article:wiki/b', type: 'related', direction: 'forward', weight: 0.6 },
      { source: 'article:wiki/b', target: 'article:wiki/c', type: 'related', direction: 'forward', weight: 0.6 },
      { source: 'article:wiki/c', target: 'article:wiki/a', type: 'related', direction: 'forward', weight: 0.6 },
      { source: 'article:wiki/a', target: 'entity:oauth', type: 'related', direction: 'forward', weight: 0.4 },
      { source: 'article:wiki/b', target: 'entity:oauth', type: 'related', direction: 'forward', weight: 0.4 },
      { source: 'article:wiki/a', target: 'topic:refs', type: 'categorized_under', direction: 'forward', weight: 0.5 },
      { source: 'article:wiki/a', target: 'source:foo', type: 'cites', direction: 'forward', weight: 0.7 },
      { source: 'article:wiki/hub', target: 'article:wiki/a', type: 'related', direction: 'forward', weight: 0.6 },
      { source: 'article:wiki/hub', target: 'article:wiki/b', type: 'related', direction: 'forward', weight: 0.6 },
      { source: 'article:wiki/hub', target: 'article:wiki/c', type: 'related', direction: 'forward', weight: 0.6 },
      { source: 'article:wiki/hub', target: 'article:wiki/d', type: 'related', direction: 'forward', weight: 0.6 },
    ],
    layers: [],
    tour: [],
  };
}

const ids = (neighbors) => neighbors.map((n) => n.id);

describe('computeNeighbors — direction', () => {
  test('forward, depth 1: only pages THIS page links to (related + article)', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/a.md', direction: 'forward', depth: 1 });
    // a --related--> b ; a --related--> oauth (entity, filtered) ; a --categorized_under--> refs (edge filtered) ; a --cites--> foo (edge filtered)
    assert.deepEqual(ids(res.neighbors), ['article:wiki/b']);
    assert.equal(res.neighbors[0].hopDistance, 1);
    assert.equal(res.neighbors[0].viaEdgeType, 'related');
    assert.equal(res.neighbors[0].nodeType, 'article');
    assert.equal(res.neighbors[0].name, 'B');
    assert.equal(res.neighbors[0].filePath, 'wiki/b.md');
  });

  test('backward, depth 1: only pages that link TO this page', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/a.md', direction: 'backward', depth: 1 });
    // c --related--> a ; hub --related--> a
    assert.deepEqual(ids(res.neighbors), ['article:wiki/c', 'article:wiki/hub']);
  });

  test('both, depth 1: union of forward and backward', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/a.md', direction: 'both', depth: 1 });
    assert.deepEqual(ids(res.neighbors), ['article:wiki/b', 'article:wiki/c', 'article:wiki/hub']);
  });

  test('direction defaults to "both"', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/a.md' });
    assert.deepEqual(ids(res.neighbors), ['article:wiki/b', 'article:wiki/c', 'article:wiki/hub']);
  });
});

describe('computeNeighbors — depth', () => {
  test('forward, depth 2: transitive across article edges', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/a.md', direction: 'forward', depth: 2 });
    // a -> b (hop 1) -> c (hop 2). a -> oauth filtered (entity). c -> a is a itself (start), skipped.
    assert.deepEqual(ids(res.neighbors), ['article:wiki/b', 'article:wiki/c']);
    const c = res.neighbors.find((n) => n.id === 'article:wiki/c');
    assert.equal(c.hopDistance, 2);
    const b = res.neighbors.find((n) => n.id === 'article:wiki/b');
    assert.equal(b.hopDistance, 1);
  });

  test('depth defaults to 1', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/a.md', direction: 'forward' });
    assert.deepEqual(ids(res.neighbors), ['article:wiki/b']);
  });

  test('depth is clamped to a sane maximum (4)', () => {
    // depth 99 must not throw or explode; it clamps.
    const res = computeNeighbors(makeGraph(), { page: 'wiki/a.md', direction: 'forward', depth: 99 });
    assert.ok(Array.isArray(res.neighbors));
  });
});

describe('computeNeighbors — nodeTypes filter', () => {
  test('default nodeTypes ["article"] excludes the entity concept', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/a.md', direction: 'forward', depth: 1 });
    assert.ok(!ids(res.neighbors).includes('entity:oauth'));
  });

  test('nodeTypes ["entity"] surfaces the concept, drops the article', () => {
    const res = computeNeighbors(makeGraph(), {
      page: 'wiki/a.md', direction: 'forward', depth: 1, nodeTypes: ['entity'],
    });
    assert.deepEqual(ids(res.neighbors), ['entity:oauth']);
    assert.equal(res.neighbors[0].nodeType, 'entity');
  });
});

describe('computeNeighbors — edgeTypes filter', () => {
  test('edgeTypes ["categorized_under"] + nodeTypes ["topic"] surfaces the topic', () => {
    const res = computeNeighbors(makeGraph(), {
      page: 'wiki/a.md', direction: 'forward', depth: 1, edgeTypes: ['categorized_under'], nodeTypes: ['topic'],
    });
    assert.deepEqual(ids(res.neighbors), ['topic:refs']);
    assert.equal(res.neighbors[0].viaEdgeType, 'categorized_under');
  });

  test('edgeTypes ["cites"] + nodeTypes ["source"] surfaces the cited source', () => {
    const res = computeNeighbors(makeGraph(), {
      page: 'wiki/a.md', direction: 'forward', depth: 1, edgeTypes: ['cites'], nodeTypes: ['source'],
    });
    assert.deepEqual(ids(res.neighbors), ['source:foo']);
  });
});

describe('computeNeighbors — maxNeighbors cap', () => {
  test('caps the result and sets truncated + totalFound', () => {
    const res = computeNeighbors(makeGraph(), {
      page: 'wiki/hub.md', direction: 'forward', depth: 1, maxNeighbors: 2,
    });
    assert.equal(res.neighbors.length, 2);
    assert.equal(res.truncated, true);
    assert.equal(res.totalFound, 4);
    // Sorted by (hopDistance, id) → the two lowest ids kept.
    assert.deepEqual(ids(res.neighbors), ['article:wiki/a', 'article:wiki/b']);
  });

  test('no truncation when under the cap', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/hub.md', direction: 'forward', depth: 1 });
    assert.equal(res.truncated, false);
    assert.equal(res.neighbors.length, 4);
  });

  test('maxNeighbors is clamped to the hard ceiling (200)', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/hub.md', maxNeighbors: 99999 });
    assert.ok(res.neighbors.length <= 200);
  });
});

describe('computeNeighbors — deterministic ordering', () => {
  test('neighbors are sorted by hopDistance, then id', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/a.md', direction: 'forward', depth: 2 });
    const sorted = [...res.neighbors].sort(
      (x, y) => x.hopDistance - y.hopDistance || x.id.localeCompare(y.id),
    );
    assert.deepEqual(res.neighbors, sorted);
  });

  test('same graph, same args → identical result (order-independent)', () => {
    const g1 = makeGraph();
    const g2 = makeGraph();
    g2.edges.reverse(); // shuffle input edge order
    g2.nodes.reverse();
    const a = computeNeighbors(g1, { page: 'wiki/a.md', direction: 'both', depth: 2 });
    const b = computeNeighbors(g2, { page: 'wiki/a.md', direction: 'both', depth: 2 });
    assert.deepEqual(a.neighbors, b.neighbors);
  });
});

describe('computeNeighbors — page resolution', () => {
  test('resolves an exact vault-relative path (with .md)', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/b.md' });
    assert.equal(res.page.id, 'article:wiki/b');
    assert.equal(res.page.filePath, 'wiki/b.md');
  });

  test('resolves a bare page name (no slash), case-insensitive', () => {
    const res = computeNeighbors(makeGraph(), { page: 'A' });
    assert.equal(res.page.id, 'article:wiki/a');
  });

  test('resolves a unique path suffix', () => {
    const res = computeNeighbors(makeGraph(), { page: 'sub/dup' });
    assert.equal(res.page.id, 'article:wiki/sub/dup');
  });

  test('ambiguous bare name → throws, listing the candidate paths', () => {
    assert.throws(
      () => computeNeighbors(makeGraph(), { page: 'dup' }),
      (err) => {
        assert.match(err.message, /ambiguous/i);
        assert.match(err.message, /wiki\/sub\/dup\.md/);
        assert.match(err.message, /wiki\/other\/dup\.md/);
        return true;
      },
    );
  });

  test('ambiguity candidate list is stable regardless of node order (deterministic reporting)', () => {
    const g1 = makeGraph();
    const g2 = makeGraph();
    g2.nodes.reverse();
    const msg = (g) => {
      try { computeNeighbors(g, { page: 'dup' }); return ''; } catch (e) { return e.message; }
    };
    const m1 = msg(g1);
    const m2 = msg(g2);
    assert.ok(m1.length > 0);
    assert.equal(m1, m2); // same candidates, same order — independent of input node order
  });

  test('unknown page → throws an actionable not-found error', () => {
    assert.throws(
      () => computeNeighbors(makeGraph(), { page: 'does-not-exist' }),
      /not found/i,
    );
  });

  test('missing page argument → throws', () => {
    assert.throws(() => computeNeighbors(makeGraph(), {}), /page/i);
  });
});

describe('computeNeighbors — defensive', () => {
  test('malformed graph → TypeError', () => {
    assert.throws(() => computeNeighbors({ nodes: 'nope' }, { page: 'a' }), TypeError);
  });

  test('page with no neighbors → empty list, not an error', () => {
    const res = computeNeighbors(makeGraph(), { page: 'wiki/d.md', direction: 'forward', depth: 1 });
    assert.deepEqual(res.neighbors, []);
    assert.equal(res.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// computePath (wiki_path)
// ---------------------------------------------------------------------------

describe('computePath — basic', () => {
  test('direct link → 2-node path', () => {
    const res = computePath(makeGraph(), { from: 'wiki/a.md', to: 'wiki/b.md' });
    assert.equal(res.found, true);
    assert.deepEqual(res.path.map((n) => n.id), ['article:wiki/a', 'article:wiki/b']);
    assert.equal(res.length, 1);
  });

  test('multi-hop shortest path', () => {
    // a -> b -> c is 2 hops. Undirected, so also c -> a exists (backlink) making
    // a<->c a direct 1-hop link. Shortest a..c is therefore 1 (via the c->a edge).
    const res = computePath(makeGraph(), { from: 'wiki/b.md', to: 'wiki/d.md' });
    // b and d connect only through the hub: b <- hub -> d ⇒ b,hub,d (2 hops).
    assert.equal(res.found, true);
    assert.deepEqual(res.path.map((n) => n.id), ['article:wiki/b', 'article:wiki/hub', 'article:wiki/d']);
    assert.equal(res.length, 2);
  });

  test('traversal is undirected (follows links against their stored direction)', () => {
    // d only appears as a TARGET (hub -> d). Reaching d from hub requires walking
    // the edge backwards — proves undirected traversal.
    const res = computePath(makeGraph(), { from: 'wiki/hub.md', to: 'wiki/d.md' });
    assert.equal(res.found, true);
    assert.deepEqual(res.path.map((n) => n.id), ['article:wiki/hub', 'article:wiki/d']);
  });

  test('from === to → trivial single-node path, length 0', () => {
    const res = computePath(makeGraph(), { from: 'wiki/a.md', to: 'wiki/a.md' });
    assert.equal(res.found, true);
    assert.deepEqual(res.path.map((n) => n.id), ['article:wiki/a']);
    assert.equal(res.length, 0);
  });
});

describe('computePath — no path', () => {
  test('disconnected pages → path null, found false (NOT an error)', () => {
    const g = makeGraph();
    // Add an island page with no edges.
    g.nodes.push({ id: 'article:wiki/island', type: 'article', name: 'Island', filePath: 'wiki/island.md', summary: '', tags: ['article'], complexity: 'simple' });
    const res = computePath(g, { from: 'wiki/a.md', to: 'wiki/island.md' });
    assert.equal(res.found, false);
    assert.equal(res.path, null);
    assert.equal(res.length, null);
  });

  test('a path longer than maxDepth is treated as no path', () => {
    // a -> b -> c requires 2 hops (in the article-only graph b->c is the only way
    // to c that isn't the direct c->a backlink). Force maxDepth 1 from b to c.
    const res = computePath(makeGraph(), { from: 'wiki/b.md', to: 'wiki/d.md', maxDepth: 1 });
    assert.equal(res.found, false);
    assert.equal(res.path, null);
  });
});

describe('computePath — nodeTypes bridging', () => {
  test('default nodeTypes ["article"] does NOT bridge through a shared concept', () => {
    // Remove the direct a<->b related edges so a and b connect ONLY via entity:oauth.
    const g = makeGraph();
    g.edges = g.edges.filter(
      (e) => !(e.source === 'article:wiki/a' && e.target === 'article:wiki/b')
        && !(e.source === 'article:wiki/hub'),
    );
    // Also drop the c->a and b->c edges so there is no article-only route a..b.
    g.edges = g.edges.filter((e) => e.type === 'related' ? !(
      (e.source === 'article:wiki/b' && e.target === 'article:wiki/c')
      || (e.source === 'article:wiki/c' && e.target === 'article:wiki/a')
    ) : true);
    const res = computePath(g, { from: 'wiki/a.md', to: 'wiki/b.md' });
    assert.equal(res.found, false);
  });

  test('nodeTypes ["entity"] bridges through a concept, NOT through an intermediate page', () => {
    // Two length-2 routes from A to B: A--related-->MID(article)--related-->B and
    // A--related-->oauth(entity)--related-->B. With nodeTypes:["entity"] the page
    // route must be REFUSED (MID is an article, not an endpoint) and only the
    // concept route may be used — guards against leaking the endpoints' `article`
    // TYPE into the allowed set (codex finding).
    const g = makeGraph();
    g.nodes.push({ id: 'article:wiki/mid', type: 'article', name: 'Mid', filePath: 'wiki/mid.md', summary: '', tags: ['article'], complexity: 'simple' });
    // Isolate A and B from every other route; keep only the two explicit bridges.
    g.edges = [
      { source: 'article:wiki/a', target: 'article:wiki/mid', type: 'related', direction: 'forward', weight: 0.6 },
      { source: 'article:wiki/mid', target: 'article:wiki/b', type: 'related', direction: 'forward', weight: 0.6 },
      { source: 'article:wiki/a', target: 'entity:oauth', type: 'related', direction: 'forward', weight: 0.4 },
      { source: 'entity:oauth', target: 'article:wiki/b', type: 'related', direction: 'forward', weight: 0.4 },
    ];
    const res = computePath(g, { from: 'wiki/a.md', to: 'wiki/b.md', nodeTypes: ['entity'] });
    assert.equal(res.found, true);
    assert.deepEqual(res.path.map((n) => n.id), ['article:wiki/a', 'entity:oauth', 'article:wiki/b']);
    assert.ok(!res.path.some((n) => n.id === 'article:wiki/mid'), 'must not route through the intermediate page');
  });

  test('expanded nodeTypes ["article","entity"] bridges through the shared concept', () => {
    const g = makeGraph();
    g.edges = g.edges.filter(
      (e) => !(e.source === 'article:wiki/a' && e.target === 'article:wiki/b')
        && !(e.source === 'article:wiki/hub'),
    );
    g.edges = g.edges.filter((e) => e.type === 'related' ? !(
      (e.source === 'article:wiki/b' && e.target === 'article:wiki/c')
      || (e.source === 'article:wiki/c' && e.target === 'article:wiki/a')
    ) : true);
    const res = computePath(g, { from: 'wiki/a.md', to: 'wiki/b.md', nodeTypes: ['article', 'entity'] });
    assert.equal(res.found, true);
    // a -> oauth -> b
    assert.deepEqual(res.path.map((n) => n.id), ['article:wiki/a', 'entity:oauth', 'article:wiki/b']);
    assert.equal(res.length, 2);
  });
});

describe('computePath — resolution errors', () => {
  test('unknown "from" → throws not-found', () => {
    assert.throws(() => computePath(makeGraph(), { from: 'zzz', to: 'wiki/a.md' }), /not found/i);
  });

  test('ambiguous "to" → throws with candidates', () => {
    assert.throws(() => computePath(makeGraph(), { from: 'wiki/a.md', to: 'dup' }), /ambiguous/i);
  });
});
