/**
 * W-C — inline links to footnotes, plus the shared markdown mask it rests on.
 *
 * The contract that matters most is the NON-REGRESSION one: without
 * `citations: true` the converted page must be byte-identical to what every
 * existing caller already depends on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { linksToFootnotes } from '../src/helpers/citations-format.mjs';
import { maskCodeAndComments } from '../src/helpers/markdown-mask.mjs';
import { webpageToMarkdown } from '../src/tools/convert.mjs';

describe('markdown-mask — the delimiters are counted, not assumed', () => {
  test('length and lines are preserved, so offsets stay usable', () => {
    const src = 'a\n```\ncode\n```\nb';
    const masked = maskCodeAndComments(src);
    assert.equal(masked.length, src.length);
    assert.equal(masked.split('\n').length, src.split('\n').length);
  });

  test('a triple fence, a FOUR-backtick fence, and a tilde fence are all blanked', () => {
    for (const fence of ['```', '````', '~~~~']) {
      const src = `keep\n${fence}\n[[hidden]]\n${fence}\nkeep`;
      assert.equal(maskCodeAndComments(src).includes('hidden'), false, `fence ${fence}`);
    }
  });

  test('a four-backtick fence containing a triple one stays entirely blanked', () => {
    const src = 'keep\n````\n```\n[[hidden]]\n```\n````\nkeep';
    const masked = maskCodeAndComments(src);
    assert.equal(masked.includes('hidden'), false);
    assert.ok(masked.includes('keep'), 'text outside is untouched');
  });

  test('inline spans close on the SAME number of backticks', () => {
    assert.equal(maskCodeAndComments('a `x` b').includes('x'), false);
    assert.equal(maskCodeAndComments('a ``[[x]]`` b').includes('x'), false);
    assert.equal(maskCodeAndComments('a ```y``` b').includes('y'), false);
  });

  test('an HTML comment is blanked, terminated or not', () => {
    assert.equal(maskCodeAndComments('a <!-- [[x]] --> b').includes('x'), false);
    assert.equal(maskCodeAndComments('a <!-- [[x]] never closed').includes('x'), false);
  });

  test('an UNTERMINATED fence swallows the rest — as every renderer does', () => {
    assert.equal(maskCodeAndComments('a\n```\n[[x]]\nmore').includes('x'), false);
  });

  test('ordinary prose is returned unchanged', () => {
    const src = 'Just [[a link]] and (parentheses) and a `code` span.';
    const masked = maskCodeAndComments(src);
    assert.ok(masked.includes('[[a link]]'));
    assert.ok(masked.includes('(parentheses)'));
  });

  test('non-string input is total', () => {
    assert.equal(maskCodeAndComments(null), '');
    assert.equal(maskCodeAndComments(''), '');
  });

  test('PIN: masking is LINEAR — the first version was quadratic and this path has no byte cap', () => {
    // Measured on the regex version: 2.3 ms at 2000 backticks, 35.5 ms at 8000,
    // 582 ms at 32000 — a 4× input costing 15×, then 16× costing 253×. This runs
    // on every page body of every context-pack call, the same hot path whose
    // bracket-bomb twin the repo already had to fix (v0.71.0).
    const time = (s) => { const t0 = performance.now(); maskCodeAndComments(s); return performance.now() - t0; };
    const small = time('`'.repeat(8000));
    const big = time('`'.repeat(64000));
    // 8× the input. Quadratic would be ~64×; allow a generous 12× for noise and
    // constant factors while still failing on any super-linear return.
    assert.ok(
      big < Math.max(small * 12, 60),
      `64k backticks took ${big.toFixed(1)} ms against ${small.toFixed(1)} ms for 8k — super-linear`,
    );
  });

  test('a run of unmatched backticks is literal, not an open span swallowing the document', () => {
    const src = '`` unmatched then [[keep]] at the end';
    assert.ok(maskCodeAndComments(src).includes('keep'));
  });
});

describe('linksToFootnotes — what it converts', () => {
  test('an inline link becomes a footnote plus a reference', () => {
    const r = linksToFootnotes('See the [REST API](https://example.com/a) plugin.');
    assert.match(r.markdown, /See the REST API\[\^1\] plugin\./);
    assert.match(r.markdown, /## References/);
    assert.match(r.markdown, /\[\^1\]: https:\/\/example\.com\/a/);
    assert.equal(r.converted, 1);
    assert.equal(r.references, 1);
  });

  test('ONE footnote per DESTINATION, cited as many times as it appears', () => {
    const r = linksToFootnotes('[a](https://x.test/1) then [b](https://x.test/1) then [c](https://x.test/2)');
    assert.equal(r.converted, 3);
    assert.equal(r.references, 2);
    assert.match(r.markdown, /a\[\^1\] then b\[\^1\] then c\[\^2\]/);
  });

  test('numbering follows FIRST APPEARANCE, so the list reads in document order', () => {
    const r = linksToFootnotes('[z](https://x.test/z) [a](https://x.test/a)');
    const refs = r.markdown.slice(r.markdown.indexOf('[^1]:'));
    assert.ok(refs.indexOf('https://x.test/z') < refs.indexOf('https://x.test/a'));
  });

  test('a link title is dropped with the link, not left dangling', () => {
    const r = linksToFootnotes('[a](https://x.test/1 "Some title")');
    assert.match(r.markdown, /^a\[\^1\]/);
    assert.equal(r.markdown.includes('Some title'), false);
  });

  test('an empty label survives as an empty label', () => {
    const r = linksToFootnotes('[](https://x.test/1)');
    assert.match(r.markdown, /^\[\^1\]/);
  });
});

describe('linksToFootnotes — what it REFUSES to touch', () => {
  test('a link inside a fenced block is left byte-for-byte alone', () => {
    const src = 'Real [a](https://x.test/1)\n\n```\nExample [b](https://x.test/2)\n```\n';
    const r = linksToFootnotes(src);
    assert.ok(r.markdown.includes('Example [b](https://x.test/2)'), 'the example is intact');
    assert.equal(r.references, 1, 'only the real link became a reference');
  });

  test('a link inside an inline code span is left alone', () => {
    const r = linksToFootnotes('Use `[text](https://x.test/1)` like this.');
    assert.ok(r.markdown.includes('`[text](https://x.test/1)`'));
    assert.equal(r.converted, 0);
  });

  test('an IMAGE is an embed, not a citation — footnoting it would delete the picture', () => {
    const r = linksToFootnotes('![alt](https://x.test/pic.png)');
    assert.equal(r.converted, 0);
    assert.equal(r.markdown, '![alt](https://x.test/pic.png)');
  });

  test('a wikilink is untouched', () => {
    const r = linksToFootnotes('See [[a page]] and [[another]].');
    assert.equal(r.converted, 0);
  });

  test('a NON-HTTP target stays inline and is COUNTED, not silently kept', () => {
    // `#anchor` is navigation, not a reference: converting it breaks the jump.
    const r = linksToFootnotes('[jump](#section) and [rel](./other.md) and [mail](mailto:a@b.c)');
    assert.equal(r.converted, 0);
    assert.equal(r.skipped, 3);
    assert.equal(r.markdown.includes('[jump](#section)'), true);
  });

  test('a reference-style link is not an inline link', () => {
    const src = '[text][ref]\n\n[ref]: https://x.test/1';
    assert.equal(linksToFootnotes(src).converted, 0);
  });

  test('a document with nothing to convert comes back UNCHANGED — no empty heading', () => {
    const src = '# Title\n\nJust prose.\n';
    const r = linksToFootnotes(src);
    assert.equal(r.markdown, src);
    assert.equal(r.references, 0);
  });
});

describe('the defects the review found — each pinned', () => {
  test('a BACKSLASH-ESCAPED bracket is not a link', () => {
    // `\[not-a-link](url)` used to become `\not-a-link[^1]`.
    const r = linksToFootnotes(String.raw`\[not-a-link](https://x.test/a)`);
    assert.equal(r.converted, 0);
  });

  test('BALANCED PARENTHESES in a URL no longer break the match', () => {
    const r = linksToFootnotes('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))');
    assert.equal(r.converted, 1);
    assert.match(r.markdown, /\[\^1\]: https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)/);
  });

  test('an ANGLE-BRACKET destination is unwrapped, not stored with its syntax', () => {
    const r = linksToFootnotes('[space](<https://x.test/a b>)');
    assert.equal(r.converted, 1);
    assert.match(r.markdown, /\[\^1\]: https:\/\/x\.test\/a b$/m);
  });

  test('a footnote definition shown INSIDE CODE does not shift our numbering', () => {
    // `startedAt` was computed on the raw document, so `[^99]:` displayed in a
    // fence pushed us to 100 and made the stats claim a namespace nobody used.
    const r = linksToFootnotes('```\n[^99]: shown as an example\n```\n\n[a](https://x.test/1)');
    assert.equal(r.startedAt, 1);
    assert.match(r.markdown, /a\[\^1\]/);
  });

  test('an INDENTED code example is not rewritten', () => {
    const src = 'para\n\n    [x](https://x.test/1)\n\npara [y](https://x.test/2)';
    const r = linksToFootnotes(src);
    assert.equal(r.converted, 1, 'only the real link');
    assert.ok(r.markdown.includes('    [x](https://x.test/1)'), 'the example is intact');
  });

  test('a `<!--` displayed inside a fence does not comment out the link after it', () => {
    const src = '```\n<!-- not a comment\n```\n\nReal [a](https://x.test/1).';
    assert.equal(linksToFootnotes(src).converted, 1);
  });

  test('a fence marker inside a COMMENT does not swallow the rest of the document', () => {
    const src = '<!-- ``` -->\n\nReal [a](https://x.test/1).';
    assert.equal(linksToFootnotes(src).converted, 1);
  });

  test('an inline opener before a fenced block does not pair across it', () => {
    const src = 'a ` b\n\n```\ncode\n```\n\nReal [x](https://x.test/1) ` c';
    assert.equal(linksToFootnotes(src).converted, 1);
  });

  test('CRLF survives the mask — line boundaries are not eaten', () => {
    const src = 'a\r\n```\r\ncode\r\n```\r\n\r\nReal [x](https://x.test/1).';
    const masked = maskCodeAndComments(src);
    assert.equal(masked.length, src.length);
    assert.equal((masked.match(/\r/g) || []).length, (src.match(/\r/g) || []).length);
    assert.equal(linksToFootnotes(src).converted, 1);
  });
});

describe('linksToFootnotes — an existing footnote namespace is not ours', () => {
  test('numbering starts ABOVE the page\'s own footnotes', () => {
    const src = 'Author note[^1].\n\n[^1]: their reference\n\nOurs: [a](https://x.test/1)';
    const r = linksToFootnotes(src);
    assert.equal(r.startedAt, 2);
    assert.match(r.markdown, /Ours: a\[\^2\]/);
    assert.ok(r.markdown.includes('[^1]: their reference'), 'theirs is untouched');
  });

  test('a non-numeric footnote label does not shift our numbering', () => {
    const src = 'x[^note]\n\n[^note]: a named one\n\n[a](https://x.test/1)';
    assert.equal(linksToFootnotes(src).startedAt, 1);
  });
});

describe('webpage_to_markdown — opt-in, and byte-identical without it', () => {
  const page = 'See [the docs](https://x.test/docs) for more.';

  test('WITHOUT `citations` the output is byte-identical to before', async () => {
    const out = await webpageToMarkdown({}, { url: 'https://x.test' }, { convert: async () => page });
    assert.equal(out, page);
  });

  test('`citations: false` is also a no-op — only `true` opts in', async () => {
    const out = await webpageToMarkdown({}, { url: 'https://x.test', citations: false }, { convert: async () => page });
    assert.equal(out, page);
  });

  test('`citations: true` footnotes the links and appends a one-line stats comment', async () => {
    const out = await webpageToMarkdown({}, { url: 'https://x.test', citations: true }, { convert: async () => page });
    assert.match(out, /See the docs\[\^1\] for more\./);
    assert.match(out, /\[\^1\]: https:\/\/x\.test\/docs/);
    assert.match(out, /<!-- citations: 1 inline link\(s\) → 1 footnote\(s\) -->/);
  });

  test('the stats comment is ONE line and sits at the very end', async () => {
    const out = await webpageToMarkdown({}, { url: 'https://x.test', citations: true }, { convert: async () => page });
    const lines = out.trimEnd().split('\n');
    assert.match(lines[lines.length - 1], /^<!-- citations:/);
  });

  test('MARKERS AND DEFINITIONS ARE ONE-TO-ONE after the relevance filter', async () => {
    // The order was originally citations-then-filter, on the reasoning that a
    // reference list built from survivors would omit links the reader "can no
    // longer see". That is backwards: a link in a dropped block has no marker
    // left, so listing it is an ORPHAN — and the reference block itself scores
    // nothing against the query, so the filter DROPPED IT, leaving `[^1]`
    // markers with no definitions. Filtering first is what makes them match.
    //
    // THE FIXTURE MUST ACTUALLY TRIGGER BM25. The first version had three
    // scored blocks and the filter refuses below four (`too-few-blocks`), so
    // the test passed while never exercising what its name claims — found in
    // review. Enough unrelated blocks are present here to put it over the line,
    // and the assertion checks the filter really RAN.
    // …and it must not trip the OVER-FILTER GUARD either (dropping >70% makes
    // the filter no-op — a second way to pass without exercising anything), and
    // the query term must be RARE: BM25 weights by inverse document frequency,
    // so a word present in most blocks scores near zero everywhere and nothing
    // clears the threshold. Three blocks carry the rare term, four do not.
    const doc = [
      '# T', '',
      'Kubernetes ingress notes with [a ref](https://x.test/1).', '',
      'Kubernetes controllers and how they reconcile state.', '',
      'Kubernetes namespaces and their quota behaviour.', '',
      'Unrelated cooking paragraph about onions and garlic.', '',
      'Another unrelated paragraph about bicycle maintenance.', '',
      'A third stranger about weather patterns in autumn.', '',
      'A fourth stranger about train timetables and delays.', '',
    ].join('\n');
    const out = await webpageToMarkdown(
      {},
      { url: 'https://x.test', citations: true, relevanceQuery: 'kubernetes ingress' },
      { convert: async () => doc },
    );
    assert.match(out, /<!-- bm25-filter: kept \d+\//, 'the filter must actually have run, not no-opped');
    assert.match(out, /<!-- citations:/);
    // EVERY marker has a definition, and every definition has a marker.
    const markers = new Set([...out.matchAll(/(?<!^)\[\^(\d+)\](?!:)/gm)].map((m) => m[1]));
    const defs = new Set([...out.matchAll(/^\[\^(\d+)\]:/gm)].map((m) => m[1]));
    assert.deepEqual([...markers].sort(), [...defs].sort(),
      `markers ${[...markers]} must match definitions ${[...defs]}`);
    assert.ok(markers.size > 0, 'the surviving block did carry a link');
  });

  test('both stats comments appear, each on its own line', async () => {
    const out = await webpageToMarkdown(
      {},
      { url: 'https://x.test', citations: true, relevanceQuery: 'docs' },
      { convert: async () => page },
    );
    const tail = out.trimEnd().split('\n').slice(-2);
    assert.match(tail[0], /^<!-- citations:/);
    assert.match(tail[1], /^<!-- bm25-filter:/);
  });
});
