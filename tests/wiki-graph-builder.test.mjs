/**
 * Tests for src/helpers/wiki-graph-builder.mjs — the deterministic
 * UA-schema knowledge-graph assembler.
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildWikiGraph } from '../src/helpers/wiki-graph-builder.mjs';
import { validateGraph } from '../src/helpers/wiki-graph-schema.mjs';
import { createWikiIgnore } from '../src/helpers/wiki-ignore.mjs';
import { serialiseDigest, computePageHash } from '../src/helpers/digest-generator.mjs';

const FIXED_TS = '2026-05-29T12:00:00Z';

function digestFor(forPath, content, { concepts = [], claims = [], keywords = [] } = {}) {
  return {
    path: `wiki-meta/digests/${forPath}`,
    content: serialiseDigest({
      for: forPath,
      pageHash: computePageHash(content),
      concepts,
      claims,
      keywords,
      generatedAt: FIXED_TS,
    }),
  };
}

function nodeById(graph, id) {
  return graph.nodes.find((n) => n.id === id);
}
function hasEdge(graph, source, target, type) {
  return graph.edges.some((e) => e.source === source && e.target === target && (!type || e.type === type));
}

// ---------------------------------------------------------------------------
// Basic shape + validity
// ---------------------------------------------------------------------------

describe('buildWikiGraph — basics', () => {
  test('empty vault → valid empty-ish knowledge graph', () => {
    const g = buildWikiGraph({ vaultName: 'V', generatedAt: FIXED_TS });
    assert.equal(g.kind, 'knowledge');
    assert.equal(g.project.name, 'V');
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
    assert.ok(validateGraph(g).valid);
  });

  test('throws on missing vaultName', () => {
    assert.throws(() => buildWikiGraph({}), /vaultName is required/);
  });

  test('each wiki page becomes an article node; result validates', () => {
    const pages = [
      { path: 'wiki/a.md', content: '---\ntitle: Alpha\ntags: [x, y]\n---\nFirst para.\n\nSecond.' },
      { path: 'wiki/b.md', content: '# B\n\nBody of B.' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    const a = nodeById(g, 'article:wiki/a');
    assert.ok(a);
    assert.equal(a.type, 'article');
    assert.equal(a.name, 'Alpha');
    assert.equal(a.summary, 'First para.');
    assert.deepEqual(a.tags, ['article', 'x', 'y']);
    assert.equal(a.knowledgeMeta.format, 'obsidian');
    assert.ok(nodeById(g, 'article:wiki/b'));
    assert.ok(validateGraph(g).valid, validateGraph(g).errors.join('; '));
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('buildWikiGraph — determinism', () => {
  test('same input → deep-equal output', () => {
    const pages = [
      { path: 'wiki/b.md', content: 'B links [[a]]' },
      { path: 'wiki/a.md', content: '---\nsources: ["paper.pdf"]\n---\nA' },
    ];
    const digests = [digestFor('wiki/a.md', pages[1].content, { concepts: ['RAG', 'Embeddings'], claims: ['X beats Y'] })];
    const indexMd = '## Refs\n- [[a]] — the A page\n- [[b]] — the B page\n';
    const args = { vaultName: 'V', pages, digests, indexMd, generatedAt: FIXED_TS };
    const g1 = buildWikiGraph(args);
    const g2 = buildWikiGraph(args);
    assert.deepEqual(g1, g2);
  });

  test('nodes/edges/layers are canonically sorted', () => {
    const pages = [
      { path: 'wiki/z.md', content: 'Z' },
      { path: 'wiki/a.md', content: 'A' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    const ids = g.nodes.map((n) => n.id);
    assert.deepEqual(ids, [...ids].sort((x, y) => x.localeCompare(y)));
  });
});

// ---------------------------------------------------------------------------
// Digests → entity/claim nodes
// ---------------------------------------------------------------------------

describe('buildWikiGraph — digests', () => {
  test('concepts → entity nodes (deduped global), claims → claim nodes', () => {
    const pages = [
      { path: 'wiki/a.md', content: 'A' },
      { path: 'wiki/b.md', content: 'B' },
    ];
    const digests = [
      digestFor('wiki/a.md', 'A', { concepts: ['OAuth 2.0', 'PKCE'], claims: ['PKCE replaces implicit flow'] }),
      digestFor('wiki/b.md', 'B', { concepts: ['OAuth 2.0'] }), // shared entity
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, digests, generatedAt: FIXED_TS });
    // OAuth entity deduped to a single node, referenced by both articles.
    const oauth = nodeById(g, 'entity:oauth-2-0');
    assert.ok(oauth);
    assert.equal(g.nodes.filter((n) => n.id === 'entity:oauth-2-0').length, 1);
    assert.ok(hasEdge(g, 'article:wiki/a', 'entity:oauth-2-0', 'related'));
    assert.ok(hasEdge(g, 'article:wiki/b', 'entity:oauth-2-0', 'related'));
    // Claim node namespaced under page stem.
    const claim = g.nodes.find((n) => n.type === 'claim');
    assert.ok(claim);
    assert.match(claim.id, /^claim:a:/);
    assert.ok(hasEdge(g, 'article:wiki/a', claim.id, 'related'));
    assert.ok(validateGraph(g).valid);
  });

  test('page without a digest still yields an article (no entity/claim)', () => {
    const pages = [{ path: 'wiki/a.md', content: 'A' }];
    const g = buildWikiGraph({ vaultName: 'V', pages, digests: [], generatedAt: FIXED_TS });
    assert.ok(nodeById(g, 'article:wiki/a'));
    assert.equal(g.nodes.filter((n) => n.type === 'entity').length, 0);
    assert.equal(g.nodes.filter((n) => n.type === 'claim').length, 0);
  });

  test('malformed digest is skipped, not fatal', () => {
    const pages = [{ path: 'wiki/a.md', content: 'A' }];
    const digests = [{ path: 'wiki-meta/digests/wiki/a.md', content: 'no frontmatter here' }];
    const g = buildWikiGraph({ vaultName: 'V', pages, digests, generatedAt: FIXED_TS });
    assert.ok(nodeById(g, 'article:wiki/a'));
    assert.ok(validateGraph(g).valid);
  });
});

// ---------------------------------------------------------------------------
// Wikilinks → related edges
// ---------------------------------------------------------------------------

describe('buildWikiGraph — wikilinks', () => {
  test('resolved wikilink → related edge; dangling skipped', () => {
    const pages = [
      { path: 'wiki/a.md', content: 'See [[b]] and [[ghost]].' },
      { path: 'wiki/b.md', content: 'B' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    assert.ok(hasEdge(g, 'article:wiki/a', 'article:wiki/b', 'related'));
    // ghost doesn't resolve → no node, no dangling edge → graph still valid
    assert.equal(nodeById(g, 'article:wiki/ghost'), undefined);
    assert.ok(validateGraph(g).valid, validateGraph(g).errors.join('; '));
  });

  test('wikilink alias/heading/block decorations resolve by basename', () => {
    const pages = [
      { path: 'wiki/a.md', content: 'See [[b|Bee]] and [[b#Section]] and [[b^block]].' },
      { path: 'wiki/b.md', content: 'B' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    assert.ok(hasEdge(g, 'article:wiki/a', 'article:wiki/b', 'related'));
  });
});

// ---------------------------------------------------------------------------
// Sources — the "source référencée" invariant
// ---------------------------------------------------------------------------

describe('buildWikiGraph — source nodes (the invariant)', () => {
  test('frontmatter sources:, ^[citations], and binary embeds → source nodes + cites edges', () => {
    const content = [
      '---',
      'sources: ["raw/paper.pdf", "https://example.com/article"]',
      '---',
      'Body asserts a fact. ^[wiki/Refs/notes.md:42-58]',
      'And embeds ![[diagram.png]] plus ![[b]] (a note).',
    ].join('\n');
    const pages = [
      { path: 'wiki/a.md', content },
      { path: 'wiki/b.md', content: 'B' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });

    assert.ok(nodeById(g, 'source:raw/paper.pdf'), 'frontmatter source');
    assert.ok(nodeById(g, 'source:https://example.com/article'), 'url source');
    assert.ok(nodeById(g, 'source:wiki/Refs/notes'), 'citation source (range stripped)');
    assert.ok(nodeById(g, 'source:diagram.png'), 'binary embed source');
    assert.ok(hasEdge(g, 'article:wiki/a', 'source:raw/paper.pdf', 'cites'));
    // ![[b]] is a note embed → related article edge, NOT a source
    assert.ok(hasEdge(g, 'article:wiki/a', 'article:wiki/b', 'related'));
    assert.equal(nodeById(g, 'source:b'), undefined);
    // url source carries knowledgeMeta.sourceUrl
    assert.equal(nodeById(g, 'source:https://example.com/article').knowledgeMeta.sourceUrl, 'https://example.com/article');
    assert.ok(validateGraph(g).valid, validateGraph(g).errors.join('; '));
  });

  test('THE INVARIANT: a referenced source whose file matches .wikiignore is STILL a source node', () => {
    const ignore = createWikiIgnore(); // defaults exclude *.pdf and *.png as content
    // Sanity: the matcher would exclude these as content.
    assert.equal(ignore.isIgnored('raw/secret.pdf'), true);
    assert.equal(ignore.isIgnored('assets/diagram.png'), true);

    const content = [
      '---',
      'sources: ["raw/secret.pdf"]',
      '---',
      'Embeds ![[assets/diagram.png]].',
    ].join('\n');
    const pages = [{ path: 'wiki/a.md', content }];
    const g = buildWikiGraph({ vaultName: 'V', pages, ignore, generatedAt: FIXED_TS });

    // Reference-driven → present despite being ignored-as-content.
    assert.ok(nodeById(g, 'source:raw/secret.pdf'), 'ignored pdf still a source node');
    assert.ok(nodeById(g, 'source:assets/diagram.png'), 'ignored png still a source node');
    assert.ok(hasEdge(g, 'article:wiki/a', 'source:raw/secret.pdf', 'cites'));
    assert.ok(validateGraph(g).valid);
  });

  test('ignore filter DOES exclude ignored pages from becoming article nodes', () => {
    const ignore = createWikiIgnore(['Drafts/'], { useDefaults: false });
    const pages = [
      { path: 'wiki/a.md', content: 'A' },
      { path: 'Drafts/secret.md', content: 'draft' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, ignore, generatedAt: FIXED_TS });
    assert.ok(nodeById(g, 'article:wiki/a'));
    assert.equal(nodeById(g, 'article:Drafts/secret'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Topics + layers from index.md
// ---------------------------------------------------------------------------

describe('buildWikiGraph — topics from index.md', () => {
  test('index sections → topic nodes + categorized_under edges', () => {
    const pages = [
      { path: 'wiki/a.md', content: 'A' },
      { path: 'wiki/b.md', content: 'B' },
    ];
    const indexMd = [
      '# Index',
      '',
      '## Wiki Core',
      '- [[overview]] — nav page (not a content page)',
      '',
      '## Refs',
      '- [[a]] — the A page',
      '- [[b]] — the B page',
    ].join('\n');
    const g = buildWikiGraph({ vaultName: 'V', pages, indexMd, generatedAt: FIXED_TS });

    // Refs topic created (has content members), Wiki Core skipped (no member).
    assert.ok(nodeById(g, 'topic:refs'));
    assert.equal(nodeById(g, 'topic:wiki-core'), undefined);
    assert.ok(hasEdge(g, 'article:wiki/a', 'topic:refs', 'categorized_under'));
    assert.ok(hasEdge(g, 'article:wiki/b', 'topic:refs', 'categorized_under'));
    // layers[] are Louvain communities (see the dedicated suite), NOT the index
    // sections: no `layer:<section-slug>` id is emitted any more.
    assert.equal(g.layers.find((l) => l.id === 'layer:refs'), undefined);
    assert.ok(validateGraph(g).valid, validateGraph(g).errors.join('; '));
  });
});

// ---------------------------------------------------------------------------
// Layers = Louvain communities (roadmap #1 step 2.5)
// ---------------------------------------------------------------------------

describe('buildWikiGraph — layers (Louvain communities)', () => {
  test('two unlinked clusters → two community layers', () => {
    // a↔b mutually linked, c↔d mutually linked, no link across → 2 communities.
    const pages = [
      { path: 'wiki/a.md', content: 'A links [[b]]' },
      { path: 'wiki/b.md', content: 'B links [[a]]' },
      { path: 'wiki/c.md', content: 'C links [[d]]' },
      { path: 'wiki/d.md', content: 'D links [[c]]' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    assert.equal(g.layers.length, 2, 'two disconnected clusters → two layers');
    for (const l of g.layers) assert.match(l.id, /^layer:community-\d+$/);
    // a with b, c with d, a apart from c.
    const layerOf = (id) => g.layers.findIndex((l) => l.nodeIds.includes(id));
    assert.equal(layerOf('article:wiki/a'), layerOf('article:wiki/b'));
    assert.equal(layerOf('article:wiki/c'), layerOf('article:wiki/d'));
    assert.notEqual(layerOf('article:wiki/a'), layerOf('article:wiki/c'));
    assert.ok(validateGraph(g).valid, validateGraph(g).errors.join('; '));
  });

  test('layers partition every node exactly once (articles, entities, sources…)', () => {
    const pages = [
      { path: 'wiki/a.md', content: '---\nsources: ["paper.pdf"]\n---\nA links [[b]]' },
      { path: 'wiki/b.md', content: 'B' },
    ];
    const digests = [digestFor('wiki/a.md', pages[0].content, { concepts: ['RAG'] })];
    const g = buildWikiGraph({ vaultName: 'V', pages, digests, generatedAt: FIXED_TS });
    const inLayers = g.layers.flatMap((l) => l.nodeIds).sort();
    const allNodeIds = g.nodes.map((n) => n.id).sort();
    assert.deepEqual(inLayers, allNodeIds, 'every node in exactly one layer');
    assert.equal(new Set(inLayers).size, inLayers.length, 'no node in two layers');
  });

  test('each layer carries a method:"louvain" marker and a non-empty name', () => {
    const pages = [
      { path: 'wiki/a.md', content: 'A links [[b]]' },
      { path: 'wiki/b.md', content: 'B' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    assert.ok(g.layers.length >= 1);
    for (const l of g.layers) {
      assert.equal(l.method, 'louvain');
      assert.ok(typeof l.name === 'string' && l.name.length > 0);
    }
  });

  test('community layers do not depend on index.md, and index.md still yields topic nodes', () => {
    // index.md contributes topic nodes + categorized_under edges (unchanged),
    // but layers now come from Louvain, not from the index sections.
    const pages = [
      { path: 'wiki/a.md', content: 'A links [[b]]' },
      { path: 'wiki/b.md', content: 'B' },
    ];
    const indexMd = '## Refs\n- [[a]] — A\n- [[b]] — B\n';
    const g = buildWikiGraph({ vaultName: 'V', pages, indexMd, generatedAt: FIXED_TS });
    // Topic node + categorized_under still built from the index section.
    assert.ok(nodeById(g, 'topic:refs'), 'index section still yields a topic node');
    assert.ok(hasEdge(g, 'article:wiki/a', 'topic:refs', 'categorized_under'));
    // No layer is named after the index section id any more.
    assert.equal(g.layers.find((l) => l.id === 'layer:refs'), undefined);
    for (const l of g.layers) assert.match(l.id, /^layer:community-\d+$/);
    assert.ok(validateGraph(g).valid, validateGraph(g).errors.join('; '));
  });
});

// ---------------------------------------------------------------------------
// Regression — review fixes (2026-05-29)
// ---------------------------------------------------------------------------

describe('buildWikiGraph — review regressions', () => {
  test('project.analyzedAt is populated from generatedAt (was silently dropped — CRITICAL)', () => {
    const g = buildWikiGraph({ vaultName: 'V', generatedAt: FIXED_TS });
    assert.equal(g.project.analyzedAt, FIXED_TS);
  });

  test('two claims sharing their first 8 words are distinct nodes (no ID collision)', () => {
    const pages = [{ path: 'wiki/a.md', content: 'A' }];
    const digests = [
      digestFor('wiki/a.md', 'A', {
        claims: [
          'one two three four five six seven eight alpha',
          'one two three four five six seven eight beta',
        ],
      }),
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, digests, generatedAt: FIXED_TS });
    assert.equal(g.nodes.filter((n) => n.type === 'claim').length, 2);
    assert.ok(validateGraph(g).valid);
  });

  test('order-independent: same pages in different input order → identical graph (basename collision)', () => {
    const a = { path: 'wiki/x/dup.md', content: 'X dup' };
    const b = { path: 'wiki/y/dup.md', content: 'Y dup' };
    const linker = { path: 'wiki/linker.md', content: 'See [[dup]].' };
    const g1 = buildWikiGraph({ vaultName: 'V', pages: [a, b, linker], generatedAt: FIXED_TS });
    const g2 = buildWikiGraph({ vaultName: 'V', pages: [linker, b, a], generatedAt: FIXED_TS });
    assert.deepEqual(g1, g2);
    // [[dup]] resolves to the path-sorted-first page (wiki/x/dup), deterministically.
    assert.ok(hasEdge(g1, 'article:wiki/linker', 'article:wiki/x/dup', 'related'));
  });

  test('a citation to an EXISTING page → related-to-article, not a duplicate source node', () => {
    const pages = [
      { path: 'wiki/a.md', content: 'Body. ^[wiki/b.md:1-5]' },
      { path: 'wiki/b.md', content: 'B' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    assert.ok(hasEdge(g, 'article:wiki/a', 'article:wiki/b', 'related'));
    assert.equal(nodeById(g, 'source:wiki/b'), undefined);
    assert.ok(validateGraph(g).valid);
  });

  test('block-list sources: YAML (Obsidian Properties UI form) → source nodes', () => {
    const content = ['---', 'sources:', '  - raw/paper.pdf', '  - https://example.com', '---', 'body'].join('\n');
    const pages = [{ path: 'wiki/a.md', content }];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    assert.ok(nodeById(g, 'source:raw/paper.pdf'), 'block-list pdf source');
    assert.ok(nodeById(g, 'source:https://example.com'), 'block-list url source');
    assert.ok(hasEdge(g, 'article:wiki/a', 'source:raw/paper.pdf', 'cites'));
  });

  test('prototype-pollution keys in frontmatter are stripped from knowledgeMeta', () => {
    const content = ['---', 'title: A', 'constructor: evil', '---', 'body'].join('\n');
    const pages = [{ path: 'wiki/a.md', content }];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    const a = nodeById(g, 'article:wiki/a');
    assert.equal(
      Object.prototype.hasOwnProperty.call(a.knowledgeMeta.frontmatter, 'constructor'),
      false,
    );
    assert.ok(validateGraph(g).valid);
  });

  test('path-qualified link resolves to the EXACT article on basename collision (codex P2)', () => {
    const pages = [
      { path: 'wiki/x/dup.md', content: 'X dup' },
      { path: 'wiki/y/dup.md', content: 'Y dup' },
      { path: 'wiki/linker.md', content: 'A [[wiki/y/dup]] and a bare [[dup]].' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    // Path-qualified [[wiki/y/dup]] → the EXACT article (not the first-inserted x).
    assert.ok(hasEdge(g, 'article:wiki/linker', 'article:wiki/y/dup', 'related'));
    // Bare [[dup]] → basename fallback (first by path-sort = x).
    assert.ok(hasEdge(g, 'article:wiki/linker', 'article:wiki/x/dup', 'related'));
    assert.ok(validateGraph(g).valid);
  });

  test('^[url:range] citation strips the trailing range (documented edge case, NIT)', () => {
    const pages = [{ path: 'wiki/a.md', content: 'Body. ^[https://example.com/p:1-5]' }];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    // The line-range strip turns the URL into source:https://example.com/p — an
    // accepted edge case (URLs belong in frontmatter sources:, not ^[...]).
    assert.ok(nodeById(g, 'source:https://example.com/p'));
  });

  test('path-qualified link with NO exact match does NOT fall back to a same-basename page (codex pass-3 P2)', () => {
    const pages = [
      { path: 'wiki/x/dup.md', content: 'X' },
      { path: 'wiki/linker.md', content: 'Stale link to [[wiki/GONE/dup]].' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    // The stale path-qualified target doesn't resolve exactly → NO edge (must
    // NOT silently link to the unrelated wiki/x/dup with the same basename).
    assert.ok(!hasEdge(g, 'article:wiki/linker', 'article:wiki/x/dup'));
    assert.ok(validateGraph(g).valid);
  });

  test('relative path-qualified link resolves by UNIQUE path-suffix (Obsidian relative format — codex pass-4 P2)', () => {
    const pages = [
      { path: 'wiki/sub/page.md', content: 'P' },
      { path: 'wiki/linker.md', content: 'Relative [[sub/page]].' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    // [[sub/page]] → wiki/sub/page via segment-aligned suffix match.
    assert.ok(hasEdge(g, 'article:wiki/linker', 'article:wiki/sub/page', 'related'));
  });

  test('ambiguous path-suffix refuses rather than guess', () => {
    const pages = [
      { path: 'wiki/a/sub/page.md', content: 'A' },
      { path: 'wiki/b/sub/page.md', content: 'B' },
      { path: 'wiki/linker.md', content: 'Ambiguous [[sub/page]].' },
    ];
    const g = buildWikiGraph({ vaultName: 'V', pages, generatedAt: FIXED_TS });
    // Two articles end with sub/page → ambiguous → no edge (no wrong guess).
    assert.ok(!hasEdge(g, 'article:wiki/linker', 'article:wiki/a/sub/page'));
    assert.ok(!hasEdge(g, 'article:wiki/linker', 'article:wiki/b/sub/page'));
    assert.ok(validateGraph(g).valid);
  });
});
