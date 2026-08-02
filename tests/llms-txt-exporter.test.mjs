/**
 * Tests for src/helpers/llms-txt-exporter.mjs — llms.txt aggregated export.
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFrontmatter,
  normaliseWikilinks,
  parseIndex,
  buildLlmsTxt,
} from '../src/helpers/llms-txt-exporter.mjs';

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('reads a quoted scalar folded over continuation lines', () => {
    // What Obsidian's YAML writer produces for any long value. Reading only
    // the first line kept the opening quote and cut the value mid-sentence,
    // so every export (llms.txt, OKF bundles) carried truncated metadata.
    const result = parseFrontmatter(
      '---\ntype: decision\ndescription: "Une valeur trop longue pour tenir\n'
      + '  sur une seule ligne, repliée par le writer."\nstatus: accepted\n---\n\nBody.\n',
    );
    assert.equal(result.frontmatter.description.startsWith('"'), false, 'no leftover quote');
    assert.match(result.frontmatter.description, /repliée par le writer\.$/, 'read in full');
    assert.equal(result.frontmatter.status, 'accepted', 'parsing resumes after the scalar');
  });

  test('a single-line quoted scalar is unaffected', () => {
    const result = parseFrontmatter('---\ntitle: "Court"\nstatus: ok\n---\n\nBody.\n');
    assert.equal(result.frontmatter.title, 'Court');
    assert.equal(result.frontmatter.status, 'ok');
  });

  test('returns empty frontmatter when no --- block', () => {
    const result = parseFrontmatter('# Hello\n\nBody.');
    assert.deepEqual(result.frontmatter, {});
    assert.equal(result.body, '# Hello\n\nBody.');
  });

  test('extracts scalar fields', () => {
    const result = parseFrontmatter('---\ntitle: Foo\ntype: concept\n---\nBody');
    assert.equal(result.frontmatter.title, 'Foo');
    assert.equal(result.frontmatter.type, 'concept');
    assert.equal(result.body, 'Body');
  });

  test('strips quotes from quoted values', () => {
    const result = parseFrontmatter('---\ntitle: "Hello: World"\n---\n');
    assert.equal(result.frontmatter.title, 'Hello: World');
  });

  test('parses inline array form', () => {
    const result = parseFrontmatter('---\ntags: [a, b, "c d"]\n---\n');
    assert.deepEqual(result.frontmatter.tags, ['a', 'b', 'c d']);
  });

  test('handles empty inline array', () => {
    const result = parseFrontmatter('---\ntags: []\n---\n');
    assert.deepEqual(result.frontmatter.tags, []);
  });

  test('handles CRLF line endings', () => {
    const result = parseFrontmatter('---\r\ntitle: Foo\r\n---\r\nBody');
    assert.equal(result.frontmatter.title, 'Foo');
    assert.equal(result.body, 'Body');
  });

  // -------------------------------------------------------------------------
  // Block scalars (v0.63.2). The line-oriented reader used to keep the
  // INDICATOR as the value, so a page written with `description: |` carried a
  // literal "|" — which surfaced verbatim in the generated OKF indexes
  // (`* [Title](file.md) - |`), in llms.txt/OKF exports and in the knowledge
  // graph, while the real text was silently dropped.
  // -------------------------------------------------------------------------

  test('literal block scalar (|) keeps its line breaks', () => {
    const r = parseFrontmatter('---\ndescription: |\n  Ligne un.\n  Ligne deux.\n---\n\ncorps\n');
    assert.equal(r.frontmatter.description, 'Ligne un.\nLigne deux.');
  });

  test('folded block scalar (>) joins lines with spaces, blank line = paragraph', () => {
    assert.equal(
      parseFrontmatter('---\ndescription: >\n  para un a\n  para un b\n\n  para deux\n---\n').frontmatter.description,
      'para un a para un b\npara deux',
    );
  });

  test('chomping and explicit-indent indicators are accepted in either order', () => {
    for (const header of ['|-', '|+', '>-', '|2-', '|-2', '>2']) {
      const r = parseFrontmatter(`---\ndescription: ${header}\n  Le texte.\n---\n`);
      assert.equal(r.frontmatter.description, 'Le texte.', `header ${header}`);
    }
  });

  test('a trailing comment after the indicator is ignored', () => {
    assert.equal(
      parseFrontmatter('---\ndescription: >- # une note\n  ligne un\n  ligne deux\n---\n').frontmatter.description,
      'ligne un ligne deux',
    );
  });

  test('the block ends at the next sibling key, which still parses', () => {
    const r = parseFrontmatter('---\ndescription: |\n  Le texte.\ntype: note\ntags: [a]\n---\n');
    assert.equal(r.frontmatter.description, 'Le texte.');
    assert.equal(r.frontmatter.type, 'note');
    assert.deepEqual(r.frontmatter.tags, ['a']);
  });

  test('markdown inside a block (colons, list items, deeper indent) survives intact', () => {
    // Without block handling these lines were re-read by the key/value loop:
    // `Note: important.` became a bogus `Note` key.
    const r = parseFrontmatter('---\ndescription: |\n  Note: important.\n  - un\n  - deux\n    imbriqué\ntype: x\n---\n');
    assert.equal(r.frontmatter.description, 'Note: important.\n- un\n- deux\n  imbriqué');
    assert.equal(r.frontmatter.Note, undefined, 'no bogus key leaked out of the block');
    assert.equal(r.frontmatter.type, 'x');
  });

  test('a pipe inside a QUOTED value is not treated as a block scalar', () => {
    assert.equal(parseFrontmatter('---\ntitle: "a | b"\n---\n').frontmatter.title, 'a | b');
  });

  test('an explicit indent indicator keeps the content indentation consistent', () => {
    // Codex review: trimming the whole value stripped the leading spaces of the
    // FIRST line only, so `|2` over 4-space content produced "alpha\n  beta" —
    // internally inconsistent. Leading whitespace of a content line is content.
    assert.equal(
      parseFrontmatter('---\ndescription: |2\n    alpha\n    beta\n---\n').frontmatter.description,
      '  alpha\n  beta',
    );
  });

  test('folded scalars do not fold MORE-INDENTED lines (YAML rule)', () => {
    assert.equal(
      parseFrontmatter('---\ndescription: >\n  alpha\n    code\n  omega\n---\n').frontmatter.description,
      'alpha\n  code\nomega',
    );
  });

  test('folded scalars preserve the number of blank lines', () => {
    assert.equal(
      parseFrontmatter('---\ndescription: >\n  alpha\n\n\n  omega\n---\n').frontmatter.description,
      'alpha\n\nomega',
    );
  });

  test('malformed block headers are NOT swallowed as blocks', () => {
    // `|0` (indent indicator must be 1-9) and `|#x` (a comment needs separating
    // whitespace) are invalid YAML headers — treating them as blocks would
    // silently consume the following lines as content (Codex review).
    assert.equal(parseFrontmatter('---\ntitle: |0\n---\n').frontmatter.title, '|0');
    assert.equal(parseFrontmatter('---\ntitle: |#comment\n---\n').frontmatter.title, '|#comment');
  });

  test('block scalars work with CRLF', () => {
    assert.equal(
      parseFrontmatter('---\r\ndescription: |\r\n  Ligne un.\r\n  Ligne deux.\r\n---\r\nBody').frontmatter.description,
      'Ligne un.\nLigne deux.',
    );
  });
});

// ---------------------------------------------------------------------------
// normaliseWikilinks
// ---------------------------------------------------------------------------

describe('normaliseWikilinks', () => {
  test('simple wikilink to markdown link', () => {
    assert.equal(normaliseWikilinks('See [[Foo]]'), 'See [Foo](Foo.md)');
  });

  test('wikilink with alias', () => {
    assert.equal(normaliseWikilinks('See [[Foo|Bar]]'), 'See [Bar](Foo.md)');
  });

  test('wikilink with folder path keeps path, label = basename', () => {
    assert.equal(normaliseWikilinks('See [[concepts/Foo]]'), 'See [Foo](concepts/Foo.md)');
  });

  test('wikilink that already ends in .md', () => {
    assert.equal(normaliseWikilinks('[[Foo.md]]'), '[Foo.md](Foo.md)');
  });

  test('multiple wikilinks in one string', () => {
    assert.equal(
      normaliseWikilinks('[[A]] and [[B|C]]'),
      '[A](A.md) and [C](B.md)',
    );
  });

  test('leaves text without wikilinks alone', () => {
    assert.equal(normaliseWikilinks('Just text.'), 'Just text.');
  });
});

// ---------------------------------------------------------------------------
// parseIndex
// ---------------------------------------------------------------------------

describe('parseIndex', () => {
  test('returns [] for empty input', () => {
    assert.deepEqual(parseIndex(''), []);
  });

  test('skips H1, picks up H2 sections + bullets', () => {
    const md = `# Index

## Wiki Core

- [[overview]] — vault overview
- [[hot]] — recent context

## Refs

- [[foo]] — description here
`;
    const result = parseIndex(md);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'Wiki Core');
    assert.deepEqual(result[0].bullets, [
      { pageSlug: 'overview', description: 'vault overview' },
      { pageSlug: 'hot', description: 'recent context' },
    ]);
    assert.equal(result[1].title, 'Refs');
    assert.deepEqual(result[1].bullets, [
      { pageSlug: 'foo', description: 'description here' },
    ]);
  });

  test('handles dash separator as well as em-dash', () => {
    const md = `## Section

- [[a]] - dash sep
- [[b]] — em-dash sep
- [[c]]: colon sep
`;
    const result = parseIndex(md);
    assert.deepEqual(result[0].bullets, [
      { pageSlug: 'a', description: 'dash sep' },
      { pageSlug: 'b', description: 'em-dash sep' },
      { pageSlug: 'c', description: 'colon sep' },
    ]);
  });

  test('skips bullets without wikilinks', () => {
    const md = `## Section

- [[valid]] — description
- not a wikilink
- [[also valid]]
`;
    const result = parseIndex(md);
    assert.equal(result[0].bullets.length, 2);
  });

  test('strips frontmatter before parsing', () => {
    const md = `---
type: wiki-index
---

## Section

- [[foo]] — bar
`;
    const result = parseIndex(md);
    assert.equal(result.length, 1);
    assert.equal(result[0].bullets[0].pageSlug, 'foo');
  });

  // -------------------------------------------------------------------------
  // Wikilink alias / section parsing (review+ pass 2 fix)
  // -------------------------------------------------------------------------

  test('handles wikilink with display alias [[page|Alias]]', () => {
    const md = `## Refs\n\n- [[oauth-howto|OAuth HowTo]] — guide\n`;
    const result = parseIndex(md);
    assert.equal(result[0].bullets[0].pageSlug, 'oauth-howto');
    assert.equal(result[0].bullets[0].description, 'guide');
  });

  test('handles wikilink with section anchor [[page#Section]]', () => {
    const md = `## Refs\n\n- [[oauth-howto#PKCE]] — pkce sub-section\n`;
    const result = parseIndex(md);
    assert.equal(result[0].bullets[0].pageSlug, 'oauth-howto');
  });

  test('handles wikilink with section + alias [[page#Section|Display]]', () => {
    const md = `## Refs\n\n- [[oauth-howto#PKCE|PKCE Section]] — pkce\n`;
    const result = parseIndex(md);
    assert.equal(result[0].bullets[0].pageSlug, 'oauth-howto');
    assert.equal(result[0].bullets[0].description, 'pkce');
  });

  test('handles wikilink with block-ref [[page^block-id]]', () => {
    const md = `## Refs\n\n- [[oauth-howto^block-42]] — block ref\n`;
    const result = parseIndex(md);
    assert.equal(result[0].bullets[0].pageSlug, 'oauth-howto');
  });

  test('rejects empty page slug from bare anchor [[#Section]]', () => {
    const md = `## Refs\n\n- [[#Section]] — should be skipped\n- [[real]] — ok\n`;
    const result = parseIndex(md);
    // Only the real bullet should survive.
    assert.equal(result[0].bullets.length, 1);
    assert.equal(result[0].bullets[0].pageSlug, 'real');
  });
});

// ---------------------------------------------------------------------------
// buildLlmsTxt
// ---------------------------------------------------------------------------

describe('buildLlmsTxt', () => {
  const SAMPLE_INDEX = `---
type: wiki-index
---

# Index

## Wiki Core

- [[overview]] — vault overview
- [[hot]] — recent context

## Refs

- [[oauth-howto]] — how OAuth works
- [[pkce-explained]] — PKCE deep dive
`;

  const SAMPLE_PAGES = [
    {
      path: 'wiki-meta/overview.md',
      content: `---
type: overview
---

# Overview

This vault documents the OAuth ecosystem.

It has reference pages and how-to guides.
`,
    },
    {
      path: 'wiki/Refs/oauth-howto.md',
      content: `---
type: reference
source_type: extracted
---

# OAuth HowTo

OAuth 2.0 is an authorisation framework.

See [[pkce-explained]] for PKCE details.
`,
    },
    {
      path: 'wiki/Refs/pkce-explained.md',
      content: `---
type: reference
---

# PKCE Explained

PKCE prevents code interception attacks.
`,
    },
    {
      path: 'wiki/Misc/unindexed-page.md',
      content: `---
type: reference
---

# Unindexed

This page is not in the index.
`,
    },
  ];

  test('throws on missing vaultName', () => {
    assert.throws(
      () => buildLlmsTxt({ indexMd: '', pages: [] }),
      /vaultName is required/,
    );
  });

  test('throws on invalid mode', () => {
    assert.throws(
      () => buildLlmsTxt({ vaultName: 'V', indexMd: '', pages: [], mode: 'bogus' }),
      /mode must be/,
    );
  });

  test('throws on missing indexMd', () => {
    assert.throws(
      () => buildLlmsTxt({ vaultName: 'V', pages: [] }),
      /indexMd is required/,
    );
  });

  test('throws on missing pages', () => {
    assert.throws(
      () => buildLlmsTxt({ vaultName: 'V', indexMd: '' }),
      /pages is required/,
    );
  });

  test('empty vault produces minimal output with generic summary', () => {
    const output = buildLlmsTxt({
      vaultName: 'Empty Vault',
      indexMd: '# Index\n',
      pages: [],
    });
    assert.match(output, /^# Empty Vault/);
    assert.match(output, /> Knowledge base for Empty Vault\./);
    assert.doesNotMatch(output, /## /); // no sections
  });

  test('index mode produces compact output', () => {
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
      mode: 'index',
    });
    assert.match(output, /^# Test/);
    assert.match(output, /## Wiki Core/);
    assert.match(output, /## Refs/);
    assert.match(output, /\[oauth-howto\]\(wiki\/Refs\/oauth-howto\.md\): how OAuth works/);
    // Body should NOT appear in index mode
    assert.doesNotMatch(output, /OAuth 2\.0 is an authorisation framework/);
  });

  test('full mode inlines page bodies', () => {
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
      mode: 'full',
    });
    // Body present
    assert.match(output, /OAuth 2\.0 is an authorisation framework/);
    // Wikilink in body should be normalised
    assert.match(output, /\[pkce-explained\]\(pkce-explained\.md\) for PKCE details/);
    // H1 of source page should be stripped (already in the link)
    assert.doesNotMatch(output, /# OAuth HowTo/);
  });

  test('summary explicit override wins over overview lookup', () => {
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
      summary: 'Custom one-liner.',
    });
    assert.match(output, /> Custom one-liner\./);
    assert.doesNotMatch(output, /> This vault documents the OAuth ecosystem/);
  });

  test('summary derived from overview page when not explicit', () => {
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
    });
    assert.match(output, /> This vault documents the OAuth ecosystem\./);
  });

  test('unindexed pages collected in Unindexed section', () => {
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
    });
    assert.match(output, /## Unindexed/);
    assert.match(output, /\[unindexed-page\]\(wiki\/Misc\/unindexed-page\.md\)/);
  });

  test('skips wiki-meta files from Unindexed (hot, log, index, overview)', () => {
    // Use a minimal index that does NOT reference hot/log/overview/index in
    // its sections — that way any appearance of those page slugs in the
    // output must come from the Unindexed bucket, which is what we want to
    // assert against.
    const minimalIndex = `## Refs\n\n- [[real-page]] — a real page\n`;
    const pagesWithMeta = [
      { path: 'wiki-meta/hot.md', content: '# Hot\n\nRecent.' },
      { path: 'wiki-meta/log.md', content: '# Log\n\nHistory.' },
      { path: 'wiki-meta/index.md', content: '# Index\n\nCatalog.' },
      { path: 'wiki-meta/overview.md', content: '# Overview\n\nExec.' },
      { path: 'wiki/Refs/real-page.md', content: '# Real Page\n\nContent.' },
    ];
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: minimalIndex,
      pages: pagesWithMeta,
    });
    // The Unindexed section, if present, must not list any wiki-meta page.
    const unindexedMatch = output.match(/## Unindexed[\s\S]*$/);
    if (unindexedMatch) {
      assert.doesNotMatch(unindexedMatch[0], /\[hot\]/);
      assert.doesNotMatch(unindexedMatch[0], /\[log\]/);
      assert.doesNotMatch(unindexedMatch[0], /\[index\]/);
      assert.doesNotMatch(unindexedMatch[0], /\[overview\]/);
    }
  });

  test('output is deterministic — same input → same bytes', () => {
    const a = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
    });
    const b = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
    });
    assert.equal(a, b);
  });

  test('output ends with single trailing newline', () => {
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
    });
    assert.match(output, /\n$/);
    assert.doesNotMatch(output, /\n\n$/);
  });

  test('collapses runs of empty lines to max 2 newlines', () => {
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
    });
    assert.doesNotMatch(output, /\n{3,}/);
  });

  test('a MARKED OKF projection never lands in Unindexed (review v0.59.0 N3)', () => {
    // Guaranteed by the long-standing `skipMetaFiles` basename filter —
    // `index` and `log` basenames never bucket, marker or not. This test
    // pins that the v0.59.0 projections stay covered by it.
    const marked = [
      '# Divers', '', '> Generated by obsidian-mcp-router — nav', '', '* [x](x.md)', '',
    ].join('\n');
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: [
        ...SAMPLE_PAGES,
        { path: 'wiki/Divers/index.md', content: marked },
        {
          path: 'wiki/log.md',
          content: ['# Update Log', '', '> Generated by obsidian-mcp-router — nav', ''].join('\n'),
        },
        // NB: even an UNMARKED index.md never buckets — the basename filter
        // predates the projections and is intentionally broader.
        { path: 'wiki/vieux/index.md', content: '# Ma vraie page\n' },
      ],
    });
    assert.doesNotMatch(output, /Divers\/index\.md/);
    assert.doesNotMatch(output, /wiki\/log\.md/);
    assert.doesNotMatch(output, /vieux\/index\.md/);
  });

  test('full mode strips frontmatter from inlined bodies', () => {
    const output = buildLlmsTxt({
      vaultName: 'Test',
      indexMd: SAMPLE_INDEX,
      pages: SAMPLE_PAGES,
      mode: 'full',
    });
    assert.doesNotMatch(output, /source_type: extracted/);
    assert.doesNotMatch(output, /^---$/m);
  });
});
