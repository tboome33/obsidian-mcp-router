/**
 * Tests for src/tools/build-wiki-graph.mjs — the I/O shell around the
 * deterministic wiki-graph builder.
 *
 * Approach: dependency-injection mocking (same as get-wiki-context-pack).
 * An in-memory vault filesystem backs mocked `listFilesIn` / `getFileContent`
 * / `writeFile`, so a full enumerate→build→validate→write pipeline runs with
 * no live REST endpoint.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWikiGraphTool,
  TOOL_DEFINITION,
  TOOL_NAME,
  CANONICAL_GRAPH_PATH,
  UNDERSTAND_ANYTHING_GRAPH_PATH,
} from '../src/tools/build-wiki-graph.mjs';
import { validateGraph } from '../src/helpers/wiki-graph-schema.mjs';
import { serialiseDigest, computePageHash } from '../src/helpers/digest-generator.mjs';

function makeRegistry() {
  return {
    resolveVault: (name) => ({ name: name || 'test-vault', type: 'local', path: '/tmp/v' }),
  };
}

/**
 * Build mocked DI deps backed by an in-memory `{ path: content }` map.
 * `failWritePaths` (set of paths) makes writeFile reject for those paths.
 */
function makeVaultFs(files, { failWritePaths = new Set() } = {}) {
  const writes = {};
  function listFilesIn(_vault, dir) {
    const norm = String(dir ?? '').replace(/^\/+|\/+$/g, '');
    const prefix = norm ? `${norm}/` : '';
    const childDirs = new Set();
    const childFiles = [];
    let any = false;
    for (const p of Object.keys(files)) {
      if (prefix && !p.startsWith(prefix)) continue;
      any = true;
      const rest = p.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash === -1) childFiles.push(rest);
      else childDirs.add(`${rest.slice(0, slash)}/`);
    }
    // Mirror Local REST API: a non-existent directory 404s. Our tool's
    // collectMarkdown tolerates that (try/catch → skip).
    if (!any && prefix) {
      const e = new Error('not found');
      e.kind = 'not_found';
      e.status = 404;
      return Promise.reject(e);
    }
    return Promise.resolve({ files: [...childDirs, ...childFiles] });
  }
  function getFileContent(_vault, path) {
    const norm = String(path).replace(/^\/+/, '');
    if (Object.prototype.hasOwnProperty.call(files, norm)) {
      return Promise.resolve(files[norm]);
    }
    const e = new Error(`not found: ${norm}`);
    e.kind = 'not_found';
    e.status = 404;
    return Promise.reject(e);
  }
  function writeFile(_vault, path, content) {
    const norm = String(path).replace(/^\/+/, '');
    if (failWritePaths.has(norm)) return Promise.reject(new Error(`write denied: ${norm}`));
    writes[norm] = content;
    return Promise.resolve({ ok: true });
  }
  return { deps: { listFilesIn, getFileContent, writeFile }, writes };
}

function digest(forPath, content, fields) {
  return serialiseDigest({
    for: forPath,
    pageHash: computePageHash(content),
    generatedAt: '2026-05-29T00:00:00Z',
    ...fields,
  });
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

describe('TOOL_DEFINITION', () => {
  test('name + schema shape', () => {
    assert.equal(TOOL_NAME, 'build_wiki_graph');
    assert.equal(TOOL_DEFINITION.name, 'build_wiki_graph');
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('buildWikiGraphTool — happy path', () => {
  const aContent = [
    '---',
    'title: Alpha',
    'sources: ["raw/paper.pdf"]',
    '---',
    'Alpha body. See [[b]]. ^[wiki/Refs/notes.md:10-20]',
  ].join('\n');
  const files = {
    'wiki/a.md': aContent,
    'wiki/Refs/b.md': '# B\n\nBody of B.',
    'wiki-meta/index.md': '# Index\n\n## Refs\n- [[a]] — alpha\n- [[b]] — bee\n',
    'wiki-meta/digests/wiki/a.md': digest('wiki/a.md', aContent, {
      concepts: ['RAG'],
      claims: ['Alpha asserts something'],
    }),
  };

  test('enumerates, builds, validates, writes ×2', async () => {
    const { deps, writes } = makeVaultFs(files);
    const res = await buildWikiGraphTool(makeRegistry(), { vault: 'V' }, deps);

    assert.deepEqual(res.written, [CANONICAL_GRAPH_PATH, UNDERSTAND_ANYTHING_GRAPH_PATH]);
    assert.equal(res.counts.pages, 2);
    assert.ok(res.counts.nodes >= 4); // 2 article + entity + claim + source(s)

    // Both files written + identical
    assert.ok(writes[CANONICAL_GRAPH_PATH]);
    assert.equal(writes[CANONICAL_GRAPH_PATH], writes[UNDERSTAND_ANYTHING_GRAPH_PATH]);

    // Canonical JSON parses + validates
    const graph = JSON.parse(writes[CANONICAL_GRAPH_PATH]);
    assert.ok(validateGraph(graph).valid, validateGraph(graph).errors.join('; '));
    const ids = graph.nodes.map((n) => n.id);
    assert.ok(ids.includes('article:wiki/a'));
    assert.ok(ids.includes('article:wiki/Refs/b'));
    assert.ok(ids.includes('entity:rag'));
    assert.ok(ids.includes('source:raw/paper.pdf'));
    assert.ok(ids.includes('source:wiki/Refs/notes')); // citation range stripped
    // Refs topic + layer from index.md
    assert.ok(ids.includes('topic:refs'));
    assert.ok(graph.layers.some((l) => l.id === 'layer:refs'));
  });

  test('dryRun builds + reports counts but writes nothing', async () => {
    const { deps, writes } = makeVaultFs(files);
    const res = await buildWikiGraphTool(makeRegistry(), { dryRun: true }, deps);
    assert.deepEqual(res.written, []);
    assert.equal(res.dryRun, true);
    assert.equal(Object.keys(writes).length, 0);
    assert.equal(res.counts.pages, 2);
  });

  test('writeUnderstandAnythingCopy:false writes only the canonical file', async () => {
    const { deps, writes } = makeVaultFs(files);
    const res = await buildWikiGraphTool(
      makeRegistry(),
      { writeUnderstandAnythingCopy: false },
      deps,
    );
    assert.deepEqual(res.written, [CANONICAL_GRAPH_PATH]);
    assert.equal(writes[UNDERSTAND_ANYTHING_GRAPH_PATH], undefined);
  });
});

// ---------------------------------------------------------------------------
// .wikiignore + the source invariant (end-to-end through the tool)
// ---------------------------------------------------------------------------

describe('buildWikiGraphTool — ignore + source invariant', () => {
  test('.wikiignore excludes a page from articles', async () => {
    const files = {
      'wiki/a.md': 'A',
      'wiki/Drafts/secret.md': 'draft',
      '.wikiignore': 'wiki/Drafts/\n',
    };
    const { deps, writes } = makeVaultFs(files);
    const res = await buildWikiGraphTool(makeRegistry(), {}, deps);
    const graph = JSON.parse(writes[CANONICAL_GRAPH_PATH]);
    const ids = graph.nodes.map((n) => n.id);
    assert.ok(ids.includes('article:wiki/a'));
    assert.ok(!ids.includes('article:wiki/Drafts/secret'));
    assert.equal(res.counts.pages, 1);
  });

  test('a referenced source ignored-as-content is STILL a source node', async () => {
    // raw/paper.pdf is default-ignored as content (*.pdf), but it's cited.
    const files = {
      'wiki/a.md': '---\nsources: ["raw/paper.pdf"]\n---\nBody ![[assets/img.png]]',
    };
    const { deps, writes } = makeVaultFs(files);
    await buildWikiGraphTool(makeRegistry(), {}, deps);
    const graph = JSON.parse(writes[CANONICAL_GRAPH_PATH]);
    const ids = graph.nodes.map((n) => n.id);
    assert.ok(ids.includes('source:raw/paper.pdf'), 'cited pdf is a source node');
    assert.ok(ids.includes('source:assets/img.png'), 'embedded png is a source node');
    assert.ok(graph.edges.some((e) => e.source === 'article:wiki/a' && e.type === 'cites'));
  });
});

// ---------------------------------------------------------------------------
// Degradation + guards
// ---------------------------------------------------------------------------

describe('buildWikiGraphTool — degradation + guards', () => {
  test('missing index.md → warning, still writes', async () => {
    const { deps, writes } = makeVaultFs({ 'wiki/a.md': 'A' });
    const res = await buildWikiGraphTool(makeRegistry(), {}, deps);
    assert.ok(res.warnings.includes('index-not-found'));
    assert.ok(writes[CANONICAL_GRAPH_PATH]);
  });

  test('no content pages → warning', async () => {
    const { deps } = makeVaultFs({ 'wiki-meta/index.md': '# Index' });
    const res = await buildWikiGraphTool(makeRegistry(), {}, deps);
    assert.ok(res.warnings.includes('no-content-pages-found'));
    assert.equal(res.counts.pages, 0);
  });

  test('UA copy write failure → warning, canonical still written', async () => {
    const { deps, writes } = makeVaultFs(
      { 'wiki/a.md': 'A' },
      { failWritePaths: new Set([UNDERSTAND_ANYTHING_GRAPH_PATH]) },
    );
    const res = await buildWikiGraphTool(makeRegistry(), {}, deps);
    assert.deepEqual(res.written, [CANONICAL_GRAPH_PATH]);
    assert.ok(res.warnings.includes('understand-anything-copy-failed'));
    assert.ok(writes[CANONICAL_GRAPH_PATH]);
  });

  test('invalid pagesDir throws (traversal / absolute / UNC / drive-letter)', async () => {
    const { deps } = makeVaultFs({ 'wiki/a.md': 'A' });
    for (const bad of ['../etc', '/etc/passwd', '\\\\server\\share', 'C:/Windows', 'wiki/../../etc']) {
      await assert.rejects(
        () => buildWikiGraphTool(makeRegistry(), { pagesDir: bad }, deps),
        /Invalid pagesDir/,
        `should reject pagesDir=${JSON.stringify(bad)}`,
      );
    }
  });
});
