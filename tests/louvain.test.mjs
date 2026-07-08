/**
 * Tests for src/helpers/louvain.mjs — deterministic Louvain community
 * detection. Run with `npm test`.
 *
 * The graphs here have KNOWN community structure (two triangles joined by a
 * single bridge, cliques, disconnected components) so the expected partition
 * is not a guess. Determinism + order-independence are asserted because the
 * whole wiki-graph builder is byte-stable and Louvain must not break that.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { detectCommunities, modularity, _internals } from '../src/helpers/louvain.mjs';

// --- helpers ---------------------------------------------------------------

function e(source, target, weight) {
  return weight === undefined ? { source, target } : { source, target, weight };
}

/** Normalise a partition to a comparable canonical form. */
function norm(parts) {
  return parts
    .map((c) => [...c].sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function sameCommunity(parts, a, b) {
  const ia = parts.findIndex((c) => c.includes(a));
  const ib = parts.findIndex((c) => c.includes(b));
  return ia !== -1 && ia === ib;
}

// The canonical Louvain toy graph: two triangles joined by one bridge edge.
const TWO_TRIANGLES = {
  nodes: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
  edges: [
    e('n1', 'n2'), e('n2', 'n3'), e('n1', 'n3'), // triangle A
    e('n4', 'n5'), e('n5', 'n6'), e('n4', 'n6'), // triangle B
    e('n3', 'n4'), // bridge
  ],
};

// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------

describe('detectCommunities — degenerate inputs', () => {
  test('empty node set → empty partition', () => {
    assert.deepEqual(detectCommunities([], []), []);
  });

  test('nodes with no edges → each is its own singleton community', () => {
    assert.deepEqual(detectCommunities(['a', 'b', 'c'], []), [['a'], ['b'], ['c']]);
  });

  test('a single node → one singleton', () => {
    assert.deepEqual(detectCommunities(['solo'], []), [['solo']]);
  });
});

// ---------------------------------------------------------------------------
// Known community structure
// ---------------------------------------------------------------------------

describe('detectCommunities — known structure', () => {
  test('two triangles joined by a bridge → exactly the two triangles', () => {
    const parts = detectCommunities(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges);
    assert.deepEqual(norm(parts), [['n1', 'n2', 'n3'], ['n4', 'n5', 'n6']]);
  });

  test('a single clique (K4) → one community of all four', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const edges = [
      e('a', 'b'), e('a', 'c'), e('a', 'd'),
      e('b', 'c'), e('b', 'd'), e('c', 'd'),
    ];
    const parts = detectCommunities(nodes, edges);
    assert.deepEqual(norm(parts), [['a', 'b', 'c', 'd']]);
  });

  test('two disconnected edges → two communities', () => {
    const parts = detectCommunities(['a', 'b', 'c', 'd'], [e('a', 'b'), e('c', 'd')]);
    assert.deepEqual(norm(parts), [['a', 'b'], ['c', 'd']]);
  });

  test('an isolated node stays a singleton while others cluster', () => {
    const parts = detectCommunities(
      ['a', 'b', 'c', 'lonely'],
      [e('a', 'b'), e('b', 'c'), e('a', 'c')],
    );
    assert.ok(sameCommunity(parts, 'a', 'b'));
    assert.ok(sameCommunity(parts, 'b', 'c'));
    assert.ok(parts.some((c) => c.length === 1 && c[0] === 'lonely'));
  });
});

// ---------------------------------------------------------------------------
// Partition invariant — every node exactly once
// ---------------------------------------------------------------------------

describe('detectCommunities — partition invariant', () => {
  test('every input node appears in exactly one community', () => {
    const parts = detectCommunities(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges);
    const flat = parts.flat();
    assert.equal(flat.length, TWO_TRIANGLES.nodes.length);
    assert.deepEqual([...flat].sort(), [...TWO_TRIANGLES.nodes].sort());
  });

  test('duplicate node ids in input are deduped to one occurrence', () => {
    const parts = detectCommunities(['a', 'a', 'b'], [e('a', 'b')]);
    assert.deepEqual(parts.flat().sort(), ['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Weights matter
// ---------------------------------------------------------------------------

describe('detectCommunities — weighted', () => {
  test('a weak bridge keeps two heavy pairs apart', () => {
    // a=b and c=d are heavy; b-c is a feather-weight bridge.
    const parts = detectCommunities(
      ['a', 'b', 'c', 'd'],
      [e('a', 'b', 10), e('c', 'd', 10), e('b', 'c', 0.1)],
    );
    assert.deepEqual(norm(parts), [['a', 'b'], ['c', 'd']]);
  });

  test('a missing/invalid weight defaults to 1 (does not crash)', () => {
    const parts = detectCommunities(
      ['a', 'b', 'c'],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c', weight: 'oops' }],
    );
    assert.equal(parts.flat().length, 3);
  });
});

// ---------------------------------------------------------------------------
// Determinism + order-independence (the byte-stability contract)
// ---------------------------------------------------------------------------

describe('detectCommunities — determinism', () => {
  test('same input → deep-equal output', () => {
    const a = detectCommunities(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges);
    const b = detectCommunities(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges);
    assert.deepEqual(a, b);
  });

  test('shuffled node/edge input order → identical output', () => {
    const shuffledNodes = ['n4', 'n1', 'n6', 'n3', 'n5', 'n2'];
    const shuffledEdges = [
      e('n3', 'n4'), e('n6', 'n5'), e('n2', 'n3'),
      e('n4', 'n5'), e('n1', 'n3'), e('n4', 'n6'), e('n1', 'n2'),
    ];
    const canonical = detectCommunities(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges);
    const shuffled = detectCommunities(shuffledNodes, shuffledEdges);
    assert.deepEqual(shuffled, canonical);
  });

  test('output is canonically ordered (communities sorted, outer sorted by first id)', () => {
    const parts = detectCommunities(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges);
    for (const c of parts) {
      assert.deepEqual(c, [...c].sort((x, y) => x.localeCompare(y)), 'members sorted');
    }
    const firsts = parts.map((c) => c[0]);
    assert.deepEqual(firsts, [...firsts].sort((x, y) => x.localeCompare(y)), 'outer sorted');
  });
});

// ---------------------------------------------------------------------------
// Resolution parameter
// ---------------------------------------------------------------------------

describe('detectCommunities — resolution', () => {
  test('a low resolution merges the two triangles into one community', () => {
    const parts = detectCommunities(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges, {
      resolution: 0.05,
    });
    assert.deepEqual(norm(parts), [['n1', 'n2', 'n3', 'n4', 'n5', 'n6']]);
  });
});

// ---------------------------------------------------------------------------
// Robustness — malformed edges
// ---------------------------------------------------------------------------

describe('detectCommunities — malformed edges', () => {
  test('edges referencing unknown nodes are ignored (no phantom node)', () => {
    const parts = detectCommunities(['a', 'b'], [e('a', 'b'), e('a', 'ghost')]);
    assert.deepEqual(parts.flat().sort(), ['a', 'b']);
    assert.ok(!parts.flat().includes('ghost'));
  });

  test('self-edges are ignored', () => {
    const parts = detectCommunities(['a', 'b'], [e('a', 'a'), e('a', 'b')]);
    assert.ok(sameCommunity(parts, 'a', 'b'));
  });

  test('null / malformed edge entries are skipped', () => {
    const parts = detectCommunities(['a', 'b'], [null, undefined, {}, e('a', 'b')]);
    assert.ok(sameCommunity(parts, 'a', 'b'));
  });

  test('parallel edges of the same pair fold to a byte-identical weight regardless of order', () => {
    // Float addition is not associative: 1e16+1+1 === 1e16 but 1+1+1e16 === 1e16+2.
    // The fold must sort parallel edges so the sum is order-independent.
    const { buildGraph } = _internals;
    const g1 = buildGraph(['x', 'y'], [e('x', 'y', 1e16), e('x', 'y', 1), e('x', 'y', 1)]);
    const g2 = buildGraph(['x', 'y'], [e('x', 'y', 1), e('x', 'y', 1), e('x', 'y', 1e16)]);
    assert.equal(g1.neighbors[0].get(1), g2.neighbors[0].get(1), 'neighbors[x][y] identical');
    assert.equal(g1.neighbors[1].get(0), g2.neighbors[1].get(0), 'neighbors[y][x] identical');
    assert.equal(g1.twoM, g2.twoM, 'twoM identical');
  });

  test('mixed edge orientation on the same undirected pair folds identically', () => {
    // The graph is undirected, so {x,y} weights must fold the same whether the
    // caller wrote each parallel edge as x→y or y→x. Canonical-endpoint sorting
    // groups both orientations together before summing.
    const { buildGraph } = _internals;
    const g1 = buildGraph(['x', 'y'], [e('x', 'y', 1e16), e('x', 'y', 1), e('y', 'x', 1)]);
    const g2 = buildGraph(['x', 'y'], [e('x', 'y', 1), e('y', 'x', 1), e('y', 'x', 1e16)]);
    assert.equal(g1.neighbors[0].get(1), g2.neighbors[0].get(1), 'neighbors[x][y] identical');
    assert.equal(g1.twoM, g2.twoM, 'twoM identical');
  });
});

// ---------------------------------------------------------------------------
// modularity() utility
// ---------------------------------------------------------------------------

describe('modularity', () => {
  test('the detected partition scores higher than trivial partitions', () => {
    const parts = detectCommunities(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges);
    const detected = modularity(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges, parts);
    const allSingletons = modularity(
      TWO_TRIANGLES.nodes,
      TWO_TRIANGLES.edges,
      TWO_TRIANGLES.nodes.map((n) => [n]),
    );
    const allOne = modularity(TWO_TRIANGLES.nodes, TWO_TRIANGLES.edges, [TWO_TRIANGLES.nodes]);
    assert.ok(detected > allSingletons, `detected ${detected} > singletons ${allSingletons}`);
    assert.ok(detected > allOne, `detected ${detected} > all-one ${allOne}`);
  });

  test('a graph with no edges has modularity 0 (no division by zero)', () => {
    const q = modularity(['a', 'b'], [], [['a'], ['b']]);
    assert.equal(q, 0);
  });
});
