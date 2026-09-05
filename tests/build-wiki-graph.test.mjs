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
  _internals,
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
    // Refs topic node from index.md (the human taxonomy).
    assert.ok(ids.includes('topic:refs'));
    // layers[] are Louvain communities now (id `layer:community-N`), not index
    // sections — and they partition every node exactly once.
    assert.ok(graph.layers.length >= 1);
    assert.ok(graph.layers.every((l) => /^layer:community-\d+$/.test(l.id)));
    const inLayers = graph.layers.flatMap((l) => l.nodeIds).sort();
    assert.deepEqual(inLayers, graph.nodes.map((n) => n.id).sort());
  });

  test('dryRun builds + reports counts but writes nothing', async () => {
    const { deps, writes } = makeVaultFs(files);
    const res = await buildWikiGraphTool(makeRegistry(), { dryRun: true }, deps);
    assert.deepEqual(res.written, []);
    assert.equal(res.dryRun, true);
    assert.equal(Object.keys(writes).length, 0);
    assert.equal(res.counts.pages, 2);
  });

  test('a stringified dryRun ("true", as real MCP clients send) is a dry run, never an unintended write', async () => {
    // Pinned in the fail-SAFE direction: the also-tier gate in src/index.mjs
    // exempts this call on the same truthiness, so the two can only ever
    // agree on "nothing was written".
    const { deps, writes } = makeVaultFs(files);
    const res = await buildWikiGraphTool(makeRegistry(), { dryRun: 'true' }, deps);
    assert.deepEqual(res.written, []);
    assert.equal(res.dryRun, true);
    assert.equal(Object.keys(writes).length, 0);
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
    // The refusal now comes from `canonicalVaultPath`, the same guard every
    // write tool uses, instead of a second local predicate that disagreed with
    // it on 688 of 3 074 swept inputs. Its message names the argument and the
    // reason ("pagesDir \"../etc\" contains a \"..\" segment"), so these match
    // on the argument name rather than the old wording.
    const { deps } = makeVaultFs({ 'wiki/a.md': 'A' });
    for (const bad of ['../etc', '\\\\server\\share', 'C:/Windows', 'wiki/../../etc']) {
      await assert.rejects(
        () => buildWikiGraphTool(makeRegistry(), { pagesDir: bad }, deps),
        /pagesDir/,
        `should reject pagesDir=${JSON.stringify(bad)}`,
      );
    }
  });

  test('a leading slash on pagesDir is NORMALISED, not refused', async () => {
    // The one place the two guards genuinely disagreed on meaning rather than
    // on strictness. The local predicate refused a leading slash outright,
    // reasoning that stripping it first would let `/etc` through as `etc`.
    // That is true of strip-then-check; it is not true of `canonicalVaultPath`,
    // for which a leading slash is simply another SPELLING of the same
    // vault-relative path — the identity rule that makes five spellings of one
    // note yield one note. `/etc/passwd` therefore means `etc/passwd` INSIDE
    // the vault, which is contained, not an escape, and is exactly what
    // `write_file({ path: '/wiki/a.md' })` has always meant.
    //
    // Pinned rather than left implicit: this is the only behaviour the guard
    // swap loosened, and a silent loosening is the thing this suite exists to
    // prevent.
    const { deps } = makeVaultFs({ 'wiki/a.md': 'A' });
    const res = await buildWikiGraphTool(makeRegistry(), { pagesDir: '/etc/passwd' }, deps);
    assert.ok(res, 'a leading slash should normalise, not throw');
    assert.equal(
      res.graph?.articles?.length ?? 0,
      0,
      'and it should resolve INSIDE the vault, where that folder holds nothing',
    );
  });
});

// ---------------------------------------------------------------------------
// review+ codex regressions (2026-05-29)
// ---------------------------------------------------------------------------

describe('buildWikiGraphTool — codex review regressions', () => {
  test('ignored files/dirs are skipped DURING enumeration (never read — codex P2)', async () => {
    const files = {
      'wiki/a.md': 'A',
      'wiki/Archive/old1.md': 'old',
      'wiki/Archive/old2.md': 'old',
      '.wikiignore': 'wiki/Archive/\n',
    };
    const reads = [];
    const { deps, writes } = makeVaultFs(files);
    const getFileContent = (vault, path) => {
      reads.push(String(path));
      return deps.getFileContent(vault, path);
    };
    await buildWikiGraphTool(makeRegistry(), {}, { ...deps, getFileContent });
    // Ignored Archive pages must NEVER be read — proves enumeration-time skip,
    // not just a post-filter (so they can't consume the MAX_FILES budget).
    assert.ok(
      !reads.some((p) => p.includes('Archive')),
      `Archive was read: ${reads.filter((p) => p.includes('Archive')).join(', ')}`,
    );
    const graph = JSON.parse(writes[CANONICAL_GRAPH_PATH]);
    assert.ok(graph.nodes.some((n) => n.id === 'article:wiki/a'));
    assert.ok(!graph.nodes.some((n) => n.id.startsWith('article:wiki/Archive')));
  });

  test('digests are still read even though wiki-meta/digests/ is ignored-as-content (invariant)', async () => {
    const aContent = 'A body';
    const files = {
      'wiki/a.md': aContent,
      'wiki-meta/digests/wiki/a.md': digest('wiki/a.md', aContent, { concepts: ['RAG'] }),
    };
    const { deps, writes } = makeVaultFs(files);
    await buildWikiGraphTool(makeRegistry(), {}, deps);
    const graph = JSON.parse(writes[CANONICAL_GRAPH_PATH]);
    // The digest walk is NOT ignore-filtered → entity still produced.
    assert.ok(graph.nodes.some((n) => n.id === 'entity:rag'));
  });

  test('.wikiignore negation re-includes a file inside an ignored dir (codex pass-2 P2)', async () => {
    const files = {
      'wiki/a.md': 'A',
      'wiki/Archive/old.md': 'old',
      'wiki/Archive/keep.md': 'keep',
      '.wikiignore': 'wiki/Archive/\n!wiki/Archive/keep.md\n',
    };
    const { deps, writes } = makeVaultFs(files);
    await buildWikiGraphTool(makeRegistry(), {}, deps);
    const ids = JSON.parse(writes[CANONICAL_GRAPH_PATH]).nodes.map((n) => n.id);
    // Always-descend + file-level skip → the negated file survives, its
    // ignored sibling does not.
    assert.ok(ids.includes('article:wiki/Archive/keep'), 'negated file re-included');
    assert.ok(!ids.includes('article:wiki/Archive/old'), 'ignored sibling excluded');
  });
});

describe('pickAuditPath — build_wiki_graph (codex P2)', () => {
  test('records the canonical graph path (no `path` arg → not "(unknown)")', async () => {
    const { pickAuditPath, formatAuditLine } = await import('../src/index.mjs');
    // Router text, not a bare string: `formatAuditLine` escapes caller-derived
    // parts and adds the line's structure afterwards, so it has to know which
    // is which. This target is chosen by the tool, never by a caller.
    assert.deepEqual(pickAuditPath('build_wiki_graph', {}), { kind: 'router', text: CANONICAL_GRAPH_PATH });
    // And an appended `path` still cannot become the attribution.
    assert.deepEqual(
      pickAuditPath('build_wiki_graph', { path: 'wiki/FORGED.md' }),
      { kind: 'router', text: CANONICAL_GRAPH_PATH },
    );
    const line = formatAuditLine({
      userId: 'roland', toolName: 'build_wiki_graph', auditPath: pickAuditPath('build_wiki_graph', {}), now: new Date(0),
    });
    assert.ok(line.includes(`path="${CANONICAL_GRAPH_PATH}"`), line);
  });
});

describe('tallyByType — defensive against adversarial type keys', () => {
  test('PIN: a node whose `type` is exactly `__proto__` is still counted', () => {
    // DEFENSIVE pin on the helper, not a reachable tool path: the builder
    // emits fixed node types (`type: 'article'`, …) and `validateGraph`
    // rejects anything outside NODE_TYPES, so a vault-chosen `__proto__`
    // cannot reach this tally today. (The first version of this comment
    // claimed the keys came from vault frontmatter — false, corrected by the
    // round-2 review.) The pin exists so a future builder change cannot
    // silently resurrect the undercount: on a plain `{}` accumulator the
    // `out[t] = (out[t] || 0) + 1` assignment hits Object.prototype's
    // inherited setter — four nodes in, a reported total of two.
    const tally = _internals.tallyByType([
      { type: 'article' },
      { type: '__proto__' },
      { type: 'article' },
      { type: '__proto__' },
    ]);
    assert.equal(
      Object.values(tally).reduce((a, b) => a + b, 0),
      4,
      `the tally must account for every node; got ${JSON.stringify(tally)}`,
    );
    assert.equal(tally.__proto__, 2);
    assert.equal(JSON.parse(JSON.stringify(tally)).__proto__, 2, 'must survive a JSON round-trip');
  });

  test('ordinary types are unaffected', () => {
    const tally = _internals.tallyByType([{ type: 'article' }, { type: 'reference' }, {}]);
    assert.deepEqual({ ...tally }, { article: 1, reference: 1, unknown: 1 });
  });
});
