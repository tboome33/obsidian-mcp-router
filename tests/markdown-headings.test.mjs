/**
 * The shared heading scanner — and the reason it is shared.
 *
 * `detectCatalogOwnedHeadings` (v0.92.0) already owned a fence- and
 * comment-aware line scanner, hardened over two adversarial rounds. The
 * `conventions` installer asked the same question with `includes()` and "cut at
 * the next `## `", and that answer destroyed a real file. The scanner therefore
 * moved into `markdown-headings.mjs` and both callers import it.
 *
 * MOVED CODE IS NEW CODE, so this file re-states the invariants the move had to
 * preserve rather than trusting the extraction — including the two shapes the
 * v0.92.0 review rounds found, which are the reason the state machine looks the
 * way it does. The catalogue's own suite stays green beside it; between the two,
 * a regression in the extraction has to fail somewhere.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scanHeadings, scanAtxHeadings, normaliseHeadingText } from '../src/helpers/markdown-headings.mjs';

const texts = (headings) => headings.map((h) => h.text);

describe('scanAtxHeadings — the shape of a heading', () => {
  test('reports level, text, line and offsets', () => {
    const doc = '# One\n\n## Two\n\ntext\n\n### Three\n';
    const found = scanAtxHeadings(doc);
    assert.deepEqual(texts(found), ['One', 'Two', 'Three']);
    assert.deepEqual(found.map((h) => h.level), [1, 2, 3]);
    assert.deepEqual(found.map((h) => h.line), [1, 3, 7]);
    // The offsets must cut the ORIGINAL text, terminator included.
    assert.equal(doc.slice(found[1].start, found[1].end), '## Two\n');
  });

  test('a heading needs a space or a tab after its hashes', () => {
    assert.deepEqual(texts(scanAtxHeadings('##NoSpace\n')), []);
    assert.deepEqual(texts(scanAtxHeadings('##\tTabbed\n')), ['Tabbed']);
    // A non-breaking space is not whitespace here — that line is not a heading.
    assert.deepEqual(texts(scanAtxHeadings(`##${String.fromCharCode(160)}Nbsp\n`)), []);
  });

  test('seven hashes is not a heading, and a bare `##` is one', () => {
    assert.deepEqual(texts(scanAtxHeadings('####### Too deep\n')), []);
    const bare = scanAtxHeadings('##\n');
    assert.equal(bare.length, 1);
    assert.equal(bare[0].text, '');
  });

  test('CRLF documents keep byte-exact offsets and clean text', () => {
    const doc = '# One\r\n\r\n## Two\r\n';
    const found = scanAtxHeadings(doc);
    assert.deepEqual(texts(found), ['One', 'Two']);
    assert.equal(doc.slice(found[1].start, found[1].end), '## Two\r\n');
  });

  test('a heading on the last line, with no terminator, is still found', () => {
    const doc = 'text\n## Last';
    const found = scanAtxHeadings(doc);
    assert.equal(found.length, 1);
    assert.equal(doc.slice(found[0].start, found[0].end), '## Last');
  });

  test('indent is REPORTED, not filtered — callers decide', () => {
    const found = scanAtxHeadings('   ### Indented\n');
    assert.equal(found.length, 1);
    assert.equal(found[0].indent, 3);
    // Four spaces is an indented code block, where nothing is structure.
    assert.deepEqual(texts(scanAtxHeadings('    ## Code\n')), []);
  });
});

describe('scanAtxHeadings — what is NOT a heading', () => {
  test('a `## ` inside a fenced block is an example, not a heading', () => {
    const doc = [
      '## Real',
      '',
      '```markdown',
      '## Fake FR',
      '',
      '## Fake EN',
      '```',
      '',
      '## Also real',
      '',
    ].join('\n');
    assert.deepEqual(texts(scanAtxHeadings(doc)), ['Real', 'Also real']);
  });

  test('a four-backtick fence contains a triple one without being closed by it', () => {
    const doc = ['````markdown', '```', '## Hidden', '```', '````', '', '## Real', ''].join('\n');
    assert.deepEqual(texts(scanAtxHeadings(doc)), ['Real']);
  });

  test('a tilde fence is not closed by a backtick fence', () => {
    const doc = ['~~~', '```', '## Hidden', '~~~', '', '## Real', ''].join('\n');
    assert.deepEqual(texts(scanAtxHeadings(doc)), ['Real']);
  });

  test('a backtick line whose info string holds a backtick opens nothing', () => {
    // v0.92.0 review round 1: treating it as an opener hid the heading after it.
    const doc = ['``` `inline` ```', '', '## Real', ''].join('\n');
    assert.deepEqual(texts(scanAtxHeadings(doc)), ['Real']);
  });

  test('only spaces or tabs may follow a closing fence', () => {
    const doc = ['```', '## Hidden', '``` trailing words', '## Still hidden', '```', '', '## Real', ''].join('\n');
    assert.deepEqual(texts(scanAtxHeadings(doc)), ['Real']);
  });

  test('a commented-out heading is not a heading', () => {
    const doc = ['<!--', '## Hidden', '-->', '', '## Real', ''].join('\n');
    assert.deepEqual(texts(scanAtxHeadings(doc)), ['Real']);
  });

  test('a backtick-quoted comment opener in prose does not swallow the file', () => {
    // v0.92.0 review round 2: a substring search on the marker ate the rest.
    const doc = ['Prose mentioning `<!--` inline.', '', '## Real', ''].join('\n');
    assert.deepEqual(texts(scanAtxHeadings(doc)), ['Real']);
  });

  test('an INDENTED fence is NOT tracked — and the real heading after it survives', () => {
    // The documented limit. Recognising the indented closer without its
    // list-marker opener turns the closer into an OPENER and hides everything
    // after it; recognising the opener too fails three more v0.92.0 witnesses.
    // So an indented fence's contents are scanned — the cost is a `## ` inside
    // one being read as a heading, and the corpus scan in
    // tests/claude-md-conventions.test.mjs is what keeps that hypothetical.
    const doc = ['- ```markdown', '  ## Fenced', '  ```', '', '## Real', ''].join('\n');
    const found = scanAtxHeadings(doc);
    assert.deepEqual(texts(found), ['Fenced', 'Real']);
    assert.equal(found[0].indent, 2, 'the fenced one is indented — callers filter on that');
    assert.equal(found[1].indent, 0);
  });

  test('an INDENTED comment opener is not tracked — column 0, like the fences', () => {
    // Deliberate: the v0.92.0 behaviour is what its 69 witnesses describe, and
    // widening it during an extraction is a behaviour change smuggled in with a
    // refactor. The heading inside is reported, indented, and both callers
    // filter on that.
    const doc = ['  <!--', '## Inside', '-->', '', '## Real', ''].join('\n');
    assert.deepEqual(texts(scanAtxHeadings(doc)), ['Inside', 'Real']);
  });

  test('a single-line comment does not become a promotable paragraph', () => {
    // Review round 2: it fell through to the paragraph branch, and the `---`
    // under it promoted the comment to a fake H2 — a boundary that stopped a
    // cut early and left half a convention behind.
    assert.deepEqual(scanHeadings('<!-- explanation -->\n---\nbody\n'), []);
  });
});

describe('scanHeadings — setext, frontmatter, and lone CR', () => {
  test('a setext heading is found, and its offsets cover the TITLE line', () => {
    const doc = 'Personal rules\n==============\nbody\n';
    const found = scanHeadings(doc);
    assert.equal(found.length, 1);
    assert.equal(found[0].style, 'setext');
    assert.equal(found[0].level, 1);
    assert.equal(found[0].text, 'Personal rules');
    assert.equal(doc.slice(found[0].start, found[0].end), 'Personal rules\n');
  });

  test('a dash underline is level 2', () => {
    const found = scanHeadings('Personal rules\n---\nbody\n');
    assert.equal(found.length, 1);
    assert.equal(found[0].level, 2);
  });

  test('YAML frontmatter is skipped, terminator included', () => {
    // The single setext candidate in the real corpus is a frontmatter
    // terminator. The BLANK LINE inside the block is what makes this a real
    // witness: without it, the "one-line paragraph" rule already refuses to
    // promote `updated:` and the frontmatter tracking would be untested.
    const doc = '---\ntype: conventions\n\nupdated: 2026-05-03\n---\n\n## Real\n';
    assert.deepEqual(scanHeadings(doc).map((h) => h.text), ['Real']);
  });

  test('a leading `---` with NO terminator is a thematic break, not frontmatter', () => {
    // Round 2: assuming frontmatter suppressed an entire catalogue whose first
    // line was a rule — a regression against the pre-extraction scanner, which
    // had no frontmatter notion at all.
    assert.deepEqual(scanHeadings('---\n\n## Sessions\nA real section.\n').map((h) => h.text),
      ['Sessions']);
  });

  test('a thematic break after a blank line is not a setext heading', () => {
    assert.deepEqual(scanHeadings('body\n\n---\n\nmore\n'), []);
  });

  test('a multi-line paragraph is promoted from its FIRST line', () => {
    // Round 2 refused the earlier "one-line paragraphs only" rule, and rightly:
    // a multi-line setext heading is still a heading a reader sees, and its
    // first line is a perfectly good place for a cut to stop. Missing it meant
    // deleting the user's section under it.
    const doc = 'Personal\nrules\n-----\nKeep this.\n';
    const found = scanHeadings(doc);
    assert.equal(found.length, 1);
    assert.equal(found[0].text, 'Personal rules');
    assert.equal(found[0].line, 1);
    assert.equal(doc.slice(found[0].start, found[0].end), 'Personal\n');
  });

  test('a setext heading directly under an ATX heading is found', () => {
    // No blank line above it: a heading closes the block before it, so what
    // follows starts a new paragraph.
    const found = scanHeadings('## Alpha\nPersonal\n---\nbody\n');
    assert.deepEqual(found.map((h) => `${h.style}:${h.text}`), ['atx:Alpha', 'setext:Personal']);
  });

  test('an indented code line under a tab is not promoted', () => {
    assert.deepEqual(scanHeadings('\tcode\n---\n'), []);
    assert.deepEqual(scanHeadings('    code\n---\n'), []);
  });

  test('a list item is not promoted', () => {
    assert.deepEqual(scanHeadings('- item\n---\n'), []);
  });

  test('a setext underline inside a fence is not a heading', () => {
    assert.deepEqual(scanHeadings('```\nTitle\n=====\n```\n'), []);
  });

  test('scanAtxHeadings excludes setext, scanHeadings includes it', () => {
    const doc = '## Atx\n\nSetext\n======\n';
    assert.deepEqual(texts(scanAtxHeadings(doc)), ['Atx']);
    assert.deepEqual(texts(scanHeadings(doc)), ['Atx', 'Setext']);
  });

  test('a lone CR line ending no longer hides a heading', () => {
    // A documented WIDENING over the pre-extraction scanner, which left the
    // `\r` on the line and so did not match it as a heading.
    const found = scanHeadings('## Sessions\r');
    assert.equal(found.length, 1);
    assert.equal(found[0].text, 'Sessions');
  });
});

describe('ATX closing sequences — handled by the parser, once', () => {
  const textOf = (line) => scanHeadings(`${line}\n`)[0]?.text;

  test('a closing sequence is stripped', () => {
    assert.equal(textOf('## Foo ##'), 'Foo');
    assert.equal(textOf('## Foo #'), 'Foo');
    assert.equal(textOf('##   Foo   '), 'Foo');
  });

  test('a NON-BREAKING space AFTER the hashes disqualifies the sequence', () => {
    // Round 2's first counterexample. Trimming before stripping turned this
    // user heading into `Foo`, and a removal then deleted their section.
    const nbsp = String.fromCharCode(160);
    assert.equal(textOf(`## Foo ##${nbsp}`), 'Foo ##');
  });

  test('a NON-BREAKING space BEFORE the hashes disqualifies it too', () => {
    const nbsp = String.fromCharCode(160);
    assert.equal(textOf(`## Foo${nbsp}##`), `Foo${nbsp}##`);
  });

  test('a trailing hash that is part of a word survives', () => {
    assert.equal(textOf('## Issue #12'), 'Issue #12');
  });
});

describe('normaliseHeadingText', () => {
  test('trims, and does NOT strip hashes a second time', () => {
    assert.equal(normaliseHeadingText('   Bilingual convention (FR + EN, FR primary)   '),
      'Bilingual convention (FR + EN, FR primary)');
    // A second pass cannot tell a closing sequence from the author's text.
    assert.equal(normaliseHeadingText('Foo ##'), 'Foo ##');
  });

  test('does NOT peel backticks or emphasis — the identities contain them', () => {
    const heading = 'Source provenance — `source_type` frontmatter';
    assert.equal(normaliseHeadingText(heading), heading);
    // A fully backtick-wrapped heading stays wrapped: peeling it here would
    // make two different conventions compare equal.
    assert.equal(normaliseHeadingText('`quoted`'), '`quoted`');
  });

  test('a trailing hash that is part of a word survives', () => {
    assert.equal(normaliseHeadingText('Issue #12'), 'Issue #12');
  });

  test('junk in, empty string out', () => {
    assert.equal(normaliseHeadingText(null), '');
    assert.equal(normaliseHeadingText(42), '');
  });
});

describe('scanAtxHeadings — junk input', () => {
  test('anything that is not a string scans to nothing', () => {
    for (const junk of [null, undefined, 42, {}, []]) {
      assert.deepEqual(scanAtxHeadings(junk), [], String(junk));
    }
  });

  test('an empty document has no headings and does not throw', () => {
    assert.deepEqual(scanAtxHeadings(''), []);
  });
});
