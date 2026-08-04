/**
 * Tests for src/tools/get-wiki-context-pack.mjs — v1 JSON envelope tool.
 *
 * Approach: dependency-injection mocking. The handler accepts an optional
 * `_deps` bag exposing `{ getFileContent, getNote, searchSmart }` so we
 * can run a complete pipeline without a live REST endpoint. ESM module
 * exports are frozen so `mock.method` on `rest-client.mjs` would fail
 * (Cannot redefine property) — DI is the established stable pattern.
 *
 * Coverage:
 *   - v1 envelope contract: every required field present + version: 'v1'
 *   - Deterministic output for fixed mock input
 *   - maxPrimaryPages / maxSemanticChunks bounds honored
 *   - Smart Connections missing → warning, empty semanticChunks
 *   - Vault offline → warning, graceful empty envelope
 *   - Empty query → throws (mirrors search / search_smart tools)
 *   - Wikilink extraction + graph neighbour dedupe
 *   - Citations from frontmatter `sources:` field
 *   - includeNeighbors: false → empty graphNeighbors[]
 *   - Internal helpers (parseIndexEntries, extractWikilinks, etc.)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getWikiContextPack,
  TOOL_DEFINITION,
  TOOL_NAME,
  _internals,
} from '../src/tools/get-wiki-context-pack.mjs';

const {
  parseIndexEntries,
  extractWikilinks,
  stripFrontmatter,
  firstParagraphSummary,
  bestSnippet,
  pickSummary,
  snippetTokens,
  coerceSources,
  candidateToVaultPath,
  SUMMARY_MAX_CHARS,
  SNIPPET_MAX_CHARS,
} = _internals;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRegistry() {
  return {
    resolveVault: (name) => ({
      name: name || 'test-vault',
      type: 'local',
      path: '/tmp/test-vault',
      tlsInsecure: false,
      timeoutMs: 5000,
      baseUrl: 'http://127.0.0.1:27124',
    }),
  };
}

// A minimal multi-section index.md mirroring the bilingual-index format
// shipped by the wiki skill.
const SAMPLE_INDEX = `---
type: wiki-index
created: 2026-05-01
---

# Index

> Catalogue of all pages.

## Wiki Core
- [[overview]] — executive summary
- [[hot]] — recent context

## Trading
- [[kelly-criterion]] — Kelly bet sizing formula and pitfalls
- [[stop-loss-design]] — Where to place stops based on volatility
- [[position-sizing]] — How much to risk per trade — risk parity vs Kelly

## Misc
- [[unrelated-page]] — Nothing about trading here at all
`;

// A primary-page body with frontmatter + body + wikilinks.
const KELLY_BODY = `---
title: Kelly Criterion
type: reference
source_type: extracted
summary: Kelly's formula computes the optimal fraction of bankroll to wager.
sources: [paper-kelly-1956, book-thorp-2017]
---

# Kelly Criterion

Kelly's formula gives the optimal bet size as f* = (bp - q) / b.

Related: [[position-sizing]], [[stop-loss-design]], and [[risk-parity]].

For a full proof see [[kelly-proof|the proof]].
`;

const STOP_BODY = `---
title: Stop-Loss Design
type: reference
source_type: inferred
sources: book-tharp-2008
---

# Stop-Loss Design

Stops should be placed where the trade thesis is invalidated. Avoid
arbitrary percentages. See [[volatility-bands]] and [[kelly-criterion]].
`;

const POSITION_BODY = `---
title: Position Sizing
type: reference
---

# Position Sizing

Position sizing controls risk per trade. The first paragraph mentions
position sizing, Kelly, and stop placement explicitly.

A later paragraph would not be the best snippet for that query.
`;

// Build a deps bag that returns these fixtures for the canonical mock vault.
function makeDeps({
  indexText = SAMPLE_INDEX,
  notes = {},
  smartChunks = null,
  smartError = null,
  indexError = null,
} = {}) {
  return {
    getFileContent: async (_vault, filePath) => {
      if (filePath === 'wiki-meta/catalog.md') {
        if (indexError) throw indexError;
        return indexText;
      }
      throw Object.assign(new Error(`not_found: ${filePath}`), { kind: 'not_found' });
    },
    getNote: async (_vault, filePath) => {
      if (Object.prototype.hasOwnProperty.call(notes, filePath)) {
        return notes[filePath];
      }
      throw Object.assign(new Error(`not_found: ${filePath}`), { kind: 'not_found' });
    },
    searchSmart: async (_vault, _query, _filter) => {
      if (smartError) throw smartError;
      return smartChunks ?? { results: [] };
    },
  };
}

// Parse a fixture body string into the `getNote` return shape (content +
// frontmatter parsed object). Mirrors the application/vnd.olrapi.note+json
// representation Local REST API returns.
function makeNote(bodyWithFrontmatter) {
  // Naive YAML extraction: enough for the test fixtures above. Not a real
  // parser — just splits on `---` and parses `key: value` and `key: [a, b]`.
  const m = bodyWithFrontmatter.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { content: bodyWithFrontmatter, frontmatter: {} };
  const fmText = m[1];
  const content = m[2];
  const frontmatter = {};
  for (const line of fmText.split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    frontmatter[key] = value;
  }
  return { content, frontmatter };
}

// ---------------------------------------------------------------------------
// Tool definition surface
// ---------------------------------------------------------------------------

describe('TOOL_DEFINITION', () => {
  test('TOOL_NAME is get_wiki_context_pack', () => {
    assert.equal(TOOL_NAME, 'get_wiki_context_pack');
    assert.equal(TOOL_DEFINITION.name, 'get_wiki_context_pack');
  });

  test('inputSchema requires query and accepts the documented options', () => {
    assert.deepEqual(TOOL_DEFINITION.inputSchema.required, ['query']);
    const props = TOOL_DEFINITION.inputSchema.properties;
    assert.ok(props.query);
    assert.ok(props.vault);
    assert.ok(props.maxPrimaryPages);
    assert.ok(props.maxSemanticChunks);
    assert.ok(props.includeNeighbors);
    assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
  });

  test('description mentions JSON envelope and v1', () => {
    assert.match(TOOL_DEFINITION.description, /JSON/);
    assert.match(TOOL_DEFINITION.description, /v1/);
  });
});

// ---------------------------------------------------------------------------
// Envelope shape — every required field present
// ---------------------------------------------------------------------------

describe('v1 envelope shape', () => {
  test('all required top-level fields present even on empty vault', async () => {
    const deps = makeDeps({ indexText: '', notes: {} });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'anything' },
      deps,
    );

    assert.equal(result.version, 'v1');
    assert.equal(result.query, 'anything');
    assert.equal(result.vault, 'test-vault');
    assert.ok(Array.isArray(result.primaryPages));
    assert.ok(Array.isArray(result.semanticChunks));
    assert.ok(Array.isArray(result.graphNeighbors));
    assert.ok(Array.isArray(result.citations));
    assert.ok(Array.isArray(result.warnings));
    assert.ok(Array.isArray(result.suggestedActions));
  });

  test('empty arrays are emitted, never omitted (stability invariant)', async () => {
    const deps = makeDeps({ indexText: SAMPLE_INDEX, notes: {} });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'nothing-matches-zzz-zzz' },
      deps,
    );
    // Even with zero matches the keys exist as `[]`.
    assert.deepEqual(result.semanticChunks, []);
    assert.deepEqual(result.graphNeighbors, []);
    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.suggestedActions, []);
  });

  test('version: "v1" is always present', async () => {
    const deps = makeDeps({ indexText: SAMPLE_INDEX });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'kelly' },
      deps,
    );
    assert.equal(result.version, 'v1');
  });
});

// ---------------------------------------------------------------------------
// Empty / missing query handling
// ---------------------------------------------------------------------------

describe('query validation', () => {
  test('missing query throws', async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => getWikiContextPack(makeRegistry(), {}, deps),
      /Missing required argument: query/,
    );
  });

  test('empty string query throws', async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => getWikiContextPack(makeRegistry(), { query: '' }, deps),
      /Missing required argument: query/,
    );
  });

  test('whitespace-only query throws', async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => getWikiContextPack(makeRegistry(), { query: '   ' }, deps),
      /Missing required argument: query/,
    );
  });

  test('non-string query throws', async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => getWikiContextPack(makeRegistry(), { query: 42 }, deps),
      /Missing required argument: query/,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end deterministic pipeline
// ---------------------------------------------------------------------------

describe('end-to-end pipeline (mocked deps)', () => {
  test('primary pages ranked by IDF + bodies drilled + citations + neighbours', async () => {
    const notes = {
      'wiki/kelly-criterion.md': makeNote(KELLY_BODY),
      'wiki/stop-loss-design.md': makeNote(STOP_BODY),
      'wiki/position-sizing.md': makeNote(POSITION_BODY),
    };
    const deps = makeDeps({ indexText: SAMPLE_INDEX, notes });
    // Use a query that matches kelly + stop-loss + position-sizing so we
    // exercise neighbour extraction across multiple primary pages.
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'kelly criterion stop loss position sizing' },
      deps,
    );

    // Kelly should rank first (exact title match crushes substring hits).
    assert.ok(result.primaryPages.length > 0);
    assert.equal(result.primaryPages[0].path, 'wiki/kelly-criterion.md');
    assert.equal(result.primaryPages[0].title, 'Kelly Criterion');
    assert.equal(result.primaryPages[0].source_type, 'extracted');
    assert.match(result.primaryPages[0].summary, /optimal/);
    assert.ok(typeof result.primaryPages[0].snippet === 'string');
    assert.ok(typeof result.primaryPages[0].score === 'number');
    assert.ok(result.primaryPages[0].score > 0);

    // Citations: kelly's frontmatter exposes 2 sources.
    const kellyCitations = result.citations.find(
      (c) => c.page === 'wiki/kelly-criterion.md',
    );
    assert.ok(kellyCitations);
    assert.deepEqual(kellyCitations.sources, ['paper-kelly-1956', 'book-thorp-2017']);

    // Stop-loss page's frontmatter has a single sources string (not array).
    // coerceSources should normalise it to a single-element array.
    const stopCitations = result.citations.find(
      (c) => c.page === 'wiki/stop-loss-design.md',
    );
    assert.ok(stopCitations);
    assert.deepEqual(stopCitations.sources, ['book-tharp-2008']);

    // Graph neighbours: extracted from primary pages' wikilinks, deduped,
    // primary-page basenames excluded.
    const neighbourTitles = result.graphNeighbors.map((n) => n.title);
    assert.ok(neighbourTitles.includes('risk-parity'));
    assert.ok(neighbourTitles.includes('volatility-bands'));
    assert.ok(neighbourTitles.includes('kelly-proof'));
    // Primary-page basenames must NOT appear as neighbours (would be a
    // self-link dupe). `position-sizing`, `kelly-criterion`, `stop-loss-design`
    // are all primary pages in this test.
    assert.ok(!neighbourTitles.includes('position-sizing'));
    assert.ok(!neighbourTitles.includes('kelly-criterion'));
    assert.ok(!neighbourTitles.includes('stop-loss-design'));
  });

  test('deterministic — same query → same envelope', async () => {
    const notes = {
      'wiki/kelly-criterion.md': makeNote(KELLY_BODY),
      'wiki/stop-loss-design.md': makeNote(STOP_BODY),
      'wiki/position-sizing.md': makeNote(POSITION_BODY),
    };
    const deps = makeDeps({ indexText: SAMPLE_INDEX, notes });
    const a = await getWikiContextPack(
      makeRegistry(),
      { query: 'kelly criterion' },
      deps,
    );
    const b = await getWikiContextPack(
      makeRegistry(),
      { query: 'kelly criterion' },
      deps,
    );
    assert.deepEqual(a, b);
  });

  test('maxPrimaryPages bound honored', async () => {
    const notes = {
      'wiki/kelly-criterion.md': makeNote(KELLY_BODY),
      'wiki/stop-loss-design.md': makeNote(STOP_BODY),
      'wiki/position-sizing.md': makeNote(POSITION_BODY),
    };
    const deps = makeDeps({ indexText: SAMPLE_INDEX, notes });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'kelly criterion stop loss position sizing', maxPrimaryPages: 1 },
      deps,
    );
    assert.equal(result.primaryPages.length, 1);
  });

  test('maxPrimaryPages: 0 → empty primary pages (and no-primary-page-matched warning)', async () => {
    const notes = {
      'wiki/kelly-criterion.md': makeNote(KELLY_BODY),
    };
    const deps = makeDeps({ indexText: SAMPLE_INDEX, notes });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'kelly criterion', maxPrimaryPages: 0 },
      deps,
    );
    assert.equal(result.primaryPages.length, 0);
    // Zero cap is treated like no-match — the consumer asked for 0 pages
    // so they get back an empty array, no warning.
    assert.ok(result.warnings.includes('no-primary-page-matched'));
  });

  test('includeNeighbors: false → empty graphNeighbors[]', async () => {
    const notes = {
      'wiki/kelly-criterion.md': makeNote(KELLY_BODY),
    };
    const deps = makeDeps({ indexText: SAMPLE_INDEX, notes });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'kelly criterion', includeNeighbors: false },
      deps,
    );
    assert.deepEqual(result.graphNeighbors, []);
    // But primaryPages still resolved.
    assert.ok(result.primaryPages.length > 0);
  });

  test('missing primary-page file → emits placeholder, no crash', async () => {
    // Index points at kelly-criterion but the page file doesn't exist —
    // dead wikilink scenario. The tool should not throw; it should ship
    // a placeholder primary page with `path: kelly-criterion.md` and an
    // empty summary/snippet so the consumer sees the gap.
    const deps = makeDeps({ indexText: SAMPLE_INDEX, notes: {} });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'kelly criterion', maxPrimaryPages: 1 },
      deps,
    );
    assert.equal(result.primaryPages.length, 1);
    assert.equal(result.primaryPages[0].path, 'kelly-criterion.md');
    assert.equal(result.primaryPages[0].title, 'kelly-criterion');
    assert.equal(result.primaryPages[0].summary, '');
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

describe('graceful degradation', () => {
  test('smart-connections missing → warning + empty semanticChunks', async () => {
    const deps = makeDeps({
      indexText: SAMPLE_INDEX,
      notes: { 'wiki/kelly-criterion.md': makeNote(KELLY_BODY) },
      smartError: Object.assign(
        new Error('Smart Connections plugin is not available'),
        { status: 503 },
      ),
    });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'kelly' },
      deps,
    );
    assert.ok(result.warnings.includes('smart-connections-not-available'));
    assert.deepEqual(result.semanticChunks, []);
    // But primary pages should still come through (different code path).
    assert.ok(result.primaryPages.length > 0);
  });

  test('vault offline (index unreachable) → vault-offline warning + empty envelope', async () => {
    const deps = makeDeps({
      indexError: Object.assign(
        new Error('[test-vault] unreachable at http://127.0.0.1:27124/ (ECONNREFUSED)'),
        { kind: 'unreachable' },
      ),
    });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'anything' },
      deps,
    );
    assert.ok(result.warnings.includes('vault-offline'));
    assert.deepEqual(result.primaryPages, []);
    assert.deepEqual(result.graphNeighbors, []);
    assert.deepEqual(result.citations, []);
    // The envelope is still valid v1.
    assert.equal(result.version, 'v1');
  });

  test('index.md missing → index-not-found warning, envelope still valid', async () => {
    const deps = makeDeps({
      indexError: Object.assign(new Error('not_found'), { kind: 'not_found' }),
    });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'anything' },
      deps,
    );
    assert.ok(result.warnings.includes('index-not-found'));
    assert.equal(result.version, 'v1');
    assert.deepEqual(result.primaryPages, []);
  });

  test('semanticChunks consumed regardless of which key search_smart returns', async () => {
    // Smart returns `{ results: [...] }` shape.
    const deps = makeDeps({
      indexText: '',
      smartChunks: {
        results: [
          { path: 'wiki/foo.md', text: 'hello', score: 0.9, breadcrumbs: 'foo > section' },
          { path: 'wiki/bar.md', text: 'world', score: 0.7 },
        ],
      },
    });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'something', maxSemanticChunks: 5 },
      deps,
    );
    assert.equal(result.semanticChunks.length, 2);
    assert.equal(result.semanticChunks[0].path, 'wiki/foo.md');
    assert.equal(result.semanticChunks[0].text, 'hello');
    assert.equal(result.semanticChunks[0].score, 0.9);
    assert.equal(result.semanticChunks[0].breadcrumbs, 'foo > section');
  });

  test('maxSemanticChunks cap honored', async () => {
    const deps = makeDeps({
      indexText: '',
      smartChunks: {
        results: Array.from({ length: 20 }, (_, i) => ({
          path: `wiki/p${i}.md`,
          text: `chunk ${i}`,
          score: 1 - i * 0.01,
        })),
      },
    });
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'something', maxSemanticChunks: 3 },
      deps,
    );
    assert.equal(result.semanticChunks.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Security — path traversal regression (review+ pass 2)
// ---------------------------------------------------------------------------

describe('isSafeVaultRelativePath (path traversal guard)', () => {
  const { isSafeVaultRelativePath } = _internals;

  test('accepts ordinary vault-relative paths', () => {
    assert.equal(isSafeVaultRelativePath('foo.md'), true);
    assert.equal(isSafeVaultRelativePath('wiki/Refs/oauth.md'), true);
    assert.equal(isSafeVaultRelativePath('A B/file with spaces.md'), true);
    assert.equal(isSafeVaultRelativePath('utf-8 café/naïve.md'), true);
  });

  test('rejects POSIX absolute paths', () => {
    assert.equal(isSafeVaultRelativePath('/etc/passwd'), false);
    assert.equal(isSafeVaultRelativePath('/foo.md'), false);
  });

  test('rejects Windows drive-letter absolute paths', () => {
    assert.equal(isSafeVaultRelativePath('C:\\Windows\\system32'), false);
    assert.equal(isSafeVaultRelativePath('c:/foo'), false);
    assert.equal(isSafeVaultRelativePath('Z:\\notes\\x.md'), false);
  });

  test('rejects UNC and backslash-rooted paths', () => {
    assert.equal(isSafeVaultRelativePath('\\\\server\\share\\x.md'), false);
    assert.equal(isSafeVaultRelativePath('\\foo'), false);
  });

  test('rejects .. as a complete path segment', () => {
    assert.equal(isSafeVaultRelativePath('../etc/passwd'), false);
    assert.equal(isSafeVaultRelativePath('foo/../bar'), false);
    assert.equal(isSafeVaultRelativePath('foo/..'), false);
    assert.equal(isSafeVaultRelativePath('..\\etc'), false);
  });

  test('accepts .. inside a filename component (not a segment)', () => {
    assert.equal(isSafeVaultRelativePath('release..notes.md'), true);
    assert.equal(isSafeVaultRelativePath('foo..bar.md'), true);
  });

  test('rejects URL-like paths', () => {
    assert.equal(isSafeVaultRelativePath('file:///etc/passwd'), false);
    assert.equal(isSafeVaultRelativePath('http://example.com/x'), false);
    assert.equal(isSafeVaultRelativePath('javascript:alert(1)'), false);
  });

  test('rejects paths containing control characters', () => {
    assert.equal(isSafeVaultRelativePath('foo\x00bar.md'), false);
    assert.equal(isSafeVaultRelativePath('foo\nbar.md'), false);
    assert.equal(isSafeVaultRelativePath('foo\rbar.md'), false);
  });

  test('rejects empty / non-string input', () => {
    assert.equal(isSafeVaultRelativePath(''), false);
    assert.equal(isSafeVaultRelativePath(null), false);
    assert.equal(isSafeVaultRelativePath(undefined), false);
    assert.equal(isSafeVaultRelativePath(42), false);
  });
});

describe('drill loop surfaces real fetch errors as page-read-failed', () => {
  test('non-404 error surfaces page-read-failed warning (review+ pass 3)', async () => {
    // Reviewer B Pass 2 PARTIAL : the previous review pass added the
    // non-404 error classification but no executable test asserted the
    // warning emission. Lock it in now.
    const indexMd = `## Refs\n\n- [[unstable-page]] - real failure case\n`;
    const deps = {
      getFileContent: async (_vault, path) => {
        if (path === 'wiki-meta/catalog.md') return indexMd;
        return null;
      },
      getNote: async (_vault, _path) => {
        // Simulate a 503 — service unavailable, neither path attempt
        // will resolve, but it's NOT a legitimate 404.
        const err = new Error('Service Unavailable');
        err.status = 503;
        throw err;
      },
      searchSmart: async () => null,
    };
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'unstable page' },
      deps,
    );
    assert.ok(
      result.warnings.includes('page-read-failed'),
      `expected page-read-failed warning, got ${JSON.stringify(result.warnings)}`,
    );
    // The page should still appear in primaryPages with empty content
    // (consumer sees the gap).
    const entry = result.primaryPages.find((p) => p.title === 'unstable-page');
    assert.ok(entry, 'page should still be in primaryPages');
    assert.equal(entry.summary, '');
  });

  test('PIN: an UNREACHABLE vault is not recorded as a confirmed dead link', async () => {
    // Regression. This resolver carried its own copy of "is the file missing?"
    // with both of the defects the shared guard now fixes: `err.kind` was OR'd
    // rather than authoritative, and the message test matched a bare `404` AND
    // `enotfound` outright. So an unreachable vault — kind 'unreachable',
    // message ending "(ENOTFOUND)" — was classified as a CONFIRMED missing
    // page with `fetchError: null` and NO warning: the consumer was told a live
    // citation was a dead link. Worse than the lie the graph tools told.
    const indexMd = `## Refs\n\n- [[live-page]] - exists, vault just unreachable\n`;
    const deps = {
      getFileContent: async (_vault, path) => {
        if (path === 'wiki-meta/catalog.md') return indexMd;
        return null;
      },
      getNote: async () => {
        const err = new Error('[roland] unreachable at https://127.0.0.1:27126/vault/live-page.md (ENOTFOUND)');
        err.kind = 'unreachable';
        throw err;
      },
      searchSmart: async () => null,
    };
    const result = await getWikiContextPack(makeRegistry(), { query: 'live page' }, deps);
    assert.ok(
      result.warnings.includes('page-read-failed'),
      `an unreachable vault must be flagged as provisional, got ${JSON.stringify(result.warnings)}`,
    );
  });

  test('legitimate 404 does NOT emit page-read-failed (just dead wikilink)', async () => {
    const indexMd = `## Refs\n\n- [[deleted-page]] - was deleted\n`;
    const deps = {
      getFileContent: async (_vault, path) => {
        if (path === 'wiki-meta/catalog.md') return indexMd;
        return null;
      },
      getNote: async (_vault, _path) => {
        const err = new Error('Not Found');
        err.status = 404;
        throw err;
      },
      searchSmart: async () => null,
    };
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'deleted page' },
      deps,
    );
    // 404 is normal (page legitimately doesn't exist) — must NOT spam
    // page-read-failed warnings. Only unsafe-index-target /
    // primary-page-drill-failed would be unexpected here.
    assert.ok(
      !result.warnings.includes('page-read-failed'),
      `404 should NOT emit page-read-failed warning, got ${JSON.stringify(result.warnings)}`,
    );
  });
});

describe('drill loop refuses unsafe index targets (integration)', () => {
  test('emits unsafe-index-target warning for poisoned wikilinks', async () => {
    // Index containing a path-traversal poisoning attempt next to a
    // normal page. Tokens from the unsafe wikilink: etc, passwd.
    // Tokens from normal: normal-page. Query targets passwd so the
    // unsafe candidate ranks at the top and reaches the drill loop.
    const poisonedIndex = `## Refs\n\n- [[../../etc/passwd]] - bad\n- [[normal-page]] - ok\n`;
    let getNoteCalls = [];
    const deps = {
      getFileContent: async (_vault, path) => {
        if (path === 'wiki-meta/catalog.md') return poisonedIndex;
        return null;
      },
      getNote: async (_vault, path) => {
        getNoteCalls.push(path);
        if (path === 'wiki/normal-page.md') {
          return {
            frontmatter: { title: 'Normal' },
            content: '# Normal\n\nBody.',
          };
        }
        const err = new Error('Not found');
        err.status = 404;
        throw err;
      },
      searchSmart: async () => null, // smart connections missing
    };
    const result = await getWikiContextPack(
      makeRegistry(),
      { query: 'passwd etc' },
      deps,
    );
    assert.ok(
      result.warnings.includes('unsafe-index-target'),
      `expected unsafe-index-target warning, got ${JSON.stringify(result.warnings)}`,
    );
    // The unsafe candidate should still appear in primaryPages with
    // empty content (so consumers see the gap).
    const unsafeEntry = result.primaryPages.find(
      (p) => p.title === '../../etc/passwd',
    );
    assert.ok(unsafeEntry, 'unsafe candidate should still be in primaryPages');
    assert.equal(unsafeEntry.summary, '');
    // CRITICAL: getNote was NEVER called on the unsafe path — the guard
    // bails BEFORE the REST call.
    assert.ok(
      !getNoteCalls.some((p) => p.includes('..')),
      `getNote should not be called with '..' paths, got: ${JSON.stringify(getNoteCalls)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Internal helpers — pure unit tests
// ---------------------------------------------------------------------------

describe('parseIndexEntries — sibling-parser alignment (review+ pass 3)', () => {
  test('rejects bare anchor [[#Section]] (no page slug)', () => {
    // Reviewer A Pass 2 IMPORTANT — was producing empty-label
    // candidate that polluted IDF + triggered 2 wasted REST probes.
    // Should align with llms-txt-exporter.parseIndex which skips.
    const md = `## Refs\n\n- [[#OnlyAnchor]] - bare anchor\n- [[real-page]] - ok\n`;
    const entries = parseIndexEntries(md);
    assert.equal(entries.length, 1, 'bare anchor must be skipped');
    assert.equal(entries[0].label, 'real-page');
  });
});

describe('parseIndexEntries', () => {
  test('extracts entries from sample index', () => {
    const entries = parseIndexEntries(SAMPLE_INDEX);
    const labels = entries.map((e) => e.label);
    assert.ok(labels.includes('overview'));
    assert.ok(labels.includes('hot'));
    assert.ok(labels.includes('kelly-criterion'));
    assert.ok(labels.includes('stop-loss-design'));
    assert.ok(labels.includes('position-sizing'));
    assert.ok(labels.includes('unrelated-page'));
  });

  test('description becomes secondaryLabel for ranking boost', () => {
    const entries = parseIndexEntries(SAMPLE_INDEX);
    const kelly = entries.find((e) => e.label === 'kelly-criterion');
    assert.ok(kelly);
    assert.match(kelly.secondaryLabel, /Kelly bet sizing/);
  });

  test('aliases extracted from [[target|Alias]]', () => {
    const out = parseIndexEntries('- [[real-page|Display Name]] — desc');
    assert.equal(out[0].label, 'real-page');
    assert.deepEqual(out[0].aliases, ['Display Name']);
  });

  test('duplicates deduped (case-insensitive)', () => {
    const out = parseIndexEntries('- [[Foo]]\n- [[foo]] — dup\n- [[FOO]]');
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'Foo');
  });

  test('empty input returns []', () => {
    assert.deepEqual(parseIndexEntries(''), []);
    assert.deepEqual(parseIndexEntries('# Index'), []);
  });

  test('handles - * + bullet markers', () => {
    const out = parseIndexEntries('- [[a]]\n* [[b]]\n+ [[c]]');
    assert.equal(out.length, 3);
  });
});

describe('extractWikilinks', () => {
  test('extracts targets', () => {
    const out = extractWikilinks('See [[foo]] and [[bar|alias]] also [[baz#heading]].');
    assert.deepEqual(out, ['foo', 'bar', 'baz']);
  });

  test('deduplicates', () => {
    const out = extractWikilinks('[[a]] [[a]] [[b]]');
    assert.deepEqual(out, ['a', 'b']);
  });

  test('ignores embeds ![[...]]', () => {
    const out = extractWikilinks('![[image.png]] and [[real-link]]');
    assert.deepEqual(out, ['real-link']);
  });

  test('empty / non-string → []', () => {
    assert.deepEqual(extractWikilinks(''), []);
    assert.deepEqual(extractWikilinks(null), []);
    assert.deepEqual(extractWikilinks(42), []);
  });

  test('handles block-ref [[page^block-id]]', () => {
    const out = extractWikilinks('[[page^block-id]]');
    assert.deepEqual(out, ['page']);
  });
});

describe('stripFrontmatter', () => {
  test('strips leading --- block', () => {
    const out = stripFrontmatter('---\nkey: value\n---\n\nBody here.');
    assert.equal(out, '\nBody here.');
  });

  test('passes through unchanged when no frontmatter', () => {
    assert.equal(stripFrontmatter('Just body'), 'Just body');
  });

  test('handles CRLF', () => {
    const out = stripFrontmatter('---\r\nkey: value\r\n---\r\nBody');
    assert.equal(out, 'Body');
  });

  test('empty / non-string → ""', () => {
    assert.equal(stripFrontmatter(''), '');
    assert.equal(stripFrontmatter(null), '');
  });
});

describe('firstParagraphSummary', () => {
  test('returns first paragraph capped', () => {
    const out = firstParagraphSummary('First para line one.\nFirst para line two.\n\nSecond para.');
    assert.equal(out, 'First para line one. First para line two.');
  });

  test('caps at SUMMARY_MAX_CHARS', () => {
    const long = 'x'.repeat(SUMMARY_MAX_CHARS + 100);
    const out = firstParagraphSummary(long);
    assert.ok(out.length <= SUMMARY_MAX_CHARS);
    assert.ok(out.endsWith('…'));
  });

  test('empty → ""', () => {
    assert.equal(firstParagraphSummary(''), '');
    assert.equal(firstParagraphSummary('   '), '');
  });
});

describe('bestSnippet', () => {
  test('picks paragraph with most query-token hits', () => {
    const body = 'First about cats.\n\nMiddle about kelly criterion stop loss.\n\nLast about dogs.';
    const out = bestSnippet(body, ['kelly', 'stop']);
    assert.match(out, /kelly criterion stop loss/);
  });

  test('falls back to first paragraph when no tokens match', () => {
    const body = 'First para.\n\nSecond para.';
    const out = bestSnippet(body, ['zzz']);
    assert.equal(out, 'First para.');
  });

  test('caps at SNIPPET_MAX_CHARS', () => {
    const long = 'kelly '.repeat(200);
    const out = bestSnippet(long, ['kelly']);
    assert.ok(out.length <= SNIPPET_MAX_CHARS);
  });

  test('empty body → ""', () => {
    assert.equal(bestSnippet('', ['x']), '');
  });
});

describe('pickSummary', () => {
  test('prefers frontmatter.summary when present', () => {
    const out = pickSummary({ summary: 'My explicit summary.' }, 'Body paragraph.');
    assert.equal(out, 'My explicit summary.');
  });

  test('falls back to first paragraph when summary missing', () => {
    const out = pickSummary({}, 'First paragraph.\n\nSecond.');
    assert.equal(out, 'First paragraph.');
  });

  test('caps long frontmatter summary', () => {
    const long = 'a'.repeat(SUMMARY_MAX_CHARS + 50);
    const out = pickSummary({ summary: long }, '');
    assert.ok(out.length <= SUMMARY_MAX_CHARS);
  });
});

describe('snippetTokens', () => {
  test('lowercases and drops length < 3', () => {
    assert.deepEqual(snippetTokens('Kelly Criterion AB').sort(), ['criterion', 'kelly']);
  });

  test('deduplicates', () => {
    assert.deepEqual(snippetTokens('foo foo bar bar'), ['foo', 'bar']);
  });

  test('empty / non-string → []', () => {
    assert.deepEqual(snippetTokens(''), []);
    assert.deepEqual(snippetTokens(null), []);
  });
});

describe('coerceSources', () => {
  test('array of strings → trimmed array', () => {
    assert.deepEqual(coerceSources([' a ', 'b', '  ']), ['a', 'b']);
  });

  test('comma-separated string → array', () => {
    assert.deepEqual(coerceSources('a, b, c'), ['a', 'b', 'c']);
  });

  test('whitespace-separated string → array', () => {
    assert.deepEqual(coerceSources('a b   c'), ['a', 'b', 'c']);
  });

  test('non-string non-array → []', () => {
    assert.deepEqual(coerceSources(null), []);
    assert.deepEqual(coerceSources(undefined), []);
    assert.deepEqual(coerceSources(42), []);
    assert.deepEqual(coerceSources({}), []);
  });
});

describe('candidateToVaultPath', () => {
  test('appends .md to bare basename', () => {
    assert.equal(candidateToVaultPath('foo'), 'foo.md');
  });

  test('preserves existing .md extension', () => {
    assert.equal(candidateToVaultPath('foo.md'), 'foo.md');
  });
});
