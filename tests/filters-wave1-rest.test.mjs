/**
 * Consolidated tests for the 12 Wave-1 filters shipped in v0.13.5
 * (A.1 remainder): decode_uri, length, strip_tags, strip_md, blockquote,
 * callout, footnote, image, table, date_modify, duration, markdown.
 *
 * Pattern: one describe-block per filter, 3-5 cases each. Fixtures
 * inline (same pragmatic decision as the Wave-1-pivot tests).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decode_uri } from '../src/helpers/filters/decode_uri.mjs';
import { length } from '../src/helpers/filters/length.mjs';
import { strip_tags } from '../src/helpers/filters/strip_tags.mjs';
import { strip_md } from '../src/helpers/filters/strip_md.mjs';
import { blockquote } from '../src/helpers/filters/blockquote.mjs';
import { callout } from '../src/helpers/filters/callout.mjs';
import { footnote } from '../src/helpers/filters/footnote.mjs';
import { image } from '../src/helpers/filters/image.mjs';
import { table } from '../src/helpers/filters/table.mjs';
import { date_modify } from '../src/helpers/filters/date_modify.mjs';
import { duration } from '../src/helpers/filters/duration.mjs';
import { markdown } from '../src/helpers/filters/markdown.mjs';

describe('decode_uri', () => {
  test('decodes percent-encoded path', () => {
    assert.equal(decode_uri('a%20b'), 'a b');
    assert.equal(decode_uri('%C3%A9'), 'é');
  });
  test('returns input on malformed encoding', () => {
    assert.equal(decode_uri('%ZZ'), '%ZZ');
    assert.equal(decode_uri('%'), '%');
  });
  test('passes through unencoded text', () => {
    assert.equal(decode_uri('hello'), 'hello');
  });
});

describe('length', () => {
  test('counts array items', () => {
    assert.equal(length('[1,2,3,4]'), '4');
  });
  test('counts object keys', () => {
    assert.equal(length('{"a":1,"b":2}'), '2');
  });
  test('falls back to string length on non-JSON', () => {
    assert.equal(length('hello'), '5');
  });
  test('empty string → 0', () => {
    assert.equal(length(''), '0');
  });
});

describe('strip_tags', () => {
  test('removes all tags by default', () => {
    assert.equal(strip_tags('<p>hello <b>world</b></p>'), 'hello world');
  });
  test('keeps allow-listed tags', () => {
    const out = strip_tags('<p>hello <a href="x">link</a></p>', 'a');
    assert.match(out, /<a href="x">link<\/a>/);
    assert.doesNotMatch(out, /<p>/);
  });
  test('decodes entities', () => {
    assert.equal(strip_tags('A &amp; B &mdash; C'), 'A & B — C');
  });
  test('collapses excessive newlines', () => {
    assert.equal(strip_tags('a\n\n\n\nb'), 'a\n\nb');
  });
});

describe('strip_md', () => {
  test('removes formatting but keeps text', () => {
    assert.equal(strip_md('**bold** and *italic*'), 'bold and italic');
  });
  test('keeps link text, drops URL', () => {
    assert.equal(strip_md('See [docs](https://example.com).'), 'See docs.');
  });
  test('removes headers', () => {
    assert.equal(strip_md('# Title\n\nbody'), 'Title\n\nbody');
  });
  test('removes wikilinks (keeps alias if present)', () => {
    assert.equal(strip_md('See [[page]] and [[other|alias]].'), 'See page and alias.');
  });

  test('REGRESSION (v0.13.6 / F3): pipes in body text are preserved (only full table lines stripped)', () => {
    // Pre-v0.13.6: `\|.*\|/g` matched any line with 2+ pipes, erasing
    // the middle. Now anchored to full table lines (^|...|$).
    assert.equal(
      strip_md('see this | a | b | row'),
      'see this | a | b | row',
    );
    // Math notation P(A|B) preserved.
    assert.equal(
      strip_md('Conditional probability P(A|B) is fundamental'),
      'Conditional probability P(A|B) is fundamental',
    );
    // CLI pipe preserved.
    assert.equal(
      strip_md('run `ls | grep foo` to filter'),
      'run ls | grep foo to filter',
    );
  });

  test('REGRESSION (v0.13.6 / F3): actual table lines still stripped', () => {
    const input = 'Body text\n| col1 | col2 |\n| --- | --- |\n| a | b |\nMore body';
    const out = strip_md(input);
    assert.match(out, /Body text/);
    assert.match(out, /More body/);
    // The 3 table lines are stripped.
    assert.doesNotMatch(out, /\| col1/);
    assert.doesNotMatch(out, /\| a \| b/);
  });

  test('REGRESSION (v0.13.7 / codex H): indented table rows (0-3 leading spaces or tab) are stripped', () => {
    // Markdown spec allows up to 3 leading spaces before block syntax.
    // Pre-v0.13.7 our `^\|...` strict anchor missed indented table rows.
    assert.equal(strip_md('  | col1 | col2 |'), '');         // 2 spaces
    assert.equal(strip_md('   | col1 | col2 |'), '');        // 3 spaces (max valid)
    assert.equal(strip_md('\t| col1 | col2 |'), '');         // tab
    // 4+ leading spaces = code block in markdown, not a table → preserved.
    assert.equal(strip_md('    | col1 | col2 |'), '| col1 | col2 |');
  });
});

describe('blockquote', () => {
  test('prefixes each line with > ', () => {
    assert.equal(blockquote('line1\nline2'), '> line1\n> line2');
  });
  test('JSON array → quoted lines', () => {
    assert.equal(blockquote('["a","b"]'), '> a\n> b');
  });
  test('nested JSON array → deeper quoting', () => {
    const out = blockquote('[["nested"]]');
    assert.match(out, />\s>\s/); // two levels of `> `
  });
});

describe('callout', () => {
  test('default type is info', () => {
    assert.equal(callout('body'), '> [!info]\n> body');
  });
  test('custom type + title + fold', () => {
    assert.equal(callout('body', 'warning,Important,true'), '> [!warning]- Important\n> body');
  });
  test('quoted params unwrapped', () => {
    assert.equal(callout('body', '"warning","Title"'), '> [!warning] Title\n> body');
  });
  test('multi-line body indented', () => {
    assert.equal(callout('a\nb'), '> [!info]\n> a\n> b');
  });
});

describe('footnote', () => {
  test('array → numbered footnotes', () => {
    assert.equal(footnote('["one","two"]'), '[^1]: one\n\n[^2]: two');
  });
  test('object → kebab-keyed footnotes', () => {
    assert.equal(footnote('{"camelKey":"value"}'), '[^camel-key]: value');
  });
  test('empty string → empty', () => {
    assert.equal(footnote(''), '');
  });
  test('non-JSON → unchanged', () => {
    assert.equal(footnote('not json'), 'not json');
  });
});

describe('image', () => {
  test('single URL → !  [](url)', () => {
    assert.equal(image('http://x.com/a.png'), '![](http://x.com/a.png)');
  });
  test('with alt text', () => {
    assert.equal(image('http://x.com/a.png', 'logo'), '![logo](http://x.com/a.png)');
  });
  test('JSON array → list of image markups', () => {
    const out = image('["a.png","b.png"]', 'pic');
    assert.deepEqual(out, ['![pic](a.png)', '![pic](b.png)']);
  });
  test('escapes special chars in alt and url', () => {
    const out = image('http://x.com/[a].png', 'a[b]c');
    assert.match(out, /\\\[/);
    assert.match(out, /\\\]/);
  });
});

describe('table', () => {
  test('single object → 2-column table', () => {
    const out = table('{"a":1,"b":2}');
    assert.match(out, /\| a \| 1 \|/);
    assert.match(out, /\| b \| 2 \|/);
  });
  test('array of objects → header row', () => {
    const out = table('[{"x":1,"y":2},{"x":3,"y":4}]');
    assert.match(out, /\| x \| y \|/);
    assert.match(out, /\| 1 \| 2 \|/);
    assert.match(out, /\| 3 \| 4 \|/);
  });
  test('flat array → single-column Value', () => {
    const out = table('["a","b","c"]');
    assert.match(out, /\| Value \|/);
    assert.match(out, /\| a \|/);
  });
  test('escapes pipes in cell content', () => {
    const out = table('["a|b"]');
    assert.match(out, /\\\|/);
  });
});

describe('date_modify', () => {
  test('+1 day', () => {
    assert.equal(date_modify('2026-05-24', '+1 day'), '2026-05-25');
  });
  test('-2 weeks', () => {
    assert.equal(date_modify('2026-05-24', '-2 weeks'), '2026-05-10');
  });
  test('+1 month', () => {
    assert.equal(date_modify('2026-05-24', '+1 month'), '2026-06-24');
  });
  test('+1 year', () => {
    assert.equal(date_modify('2026-05-24', '+1 year'), '2027-05-24');
  });
  test('invalid format → return input', () => {
    assert.equal(date_modify('2026-05-24', 'gibberish'), '2026-05-24');
  });
  test('calendar-invalid input → return input', () => {
    assert.equal(date_modify('2026-02-31', '+1 day'), '2026-02-31');
  });

  test('REGRESSION (v0.13.6 / F1a): Jan 31 + 1 month clamps to last day of Feb (not roll over to Mar)', () => {
    // Pre-v0.13.6: JS Date.setMonth(0->1) on Jan 31 silently rolled
    // forward to Mar 3 (Feb 28 + 3). Clamp now keeps the result in Feb.
    assert.equal(date_modify('2026-01-31', '+1 month'), '2026-02-28');
    // 2024 is a leap year — Feb has 29 days, so Jan 31 → Feb 29.
    assert.equal(date_modify('2024-01-31', '+1 month'), '2024-02-29');
  });

  test('REGRESSION (v0.13.6 / F1b): Feb 29 leap + 1 year clamps to Feb 28 of non-leap year', () => {
    // Pre-v0.13.6: setFullYear(2024 -> 2025) on Feb 29 silently rolled
    // to Mar 1. Clamp now keeps the result in Feb.
    assert.equal(date_modify('2024-02-29', '+1 year'), '2025-02-28');
    // Going to another leap year preserves Feb 29.
    assert.equal(date_modify('2024-02-29', '+4 years'), '2028-02-29');
  });

  test('REGRESSION (v0.13.6 / F1): mid-month dates roll over months normally', () => {
    // Sanity check: the clamp doesn't break common cases.
    assert.equal(date_modify('2026-05-15', '+1 month'), '2026-06-15');
    assert.equal(date_modify('2026-05-15', '-1 month'), '2026-04-15');
  });
});

describe('duration', () => {
  test('ISO 8601 PT5M30S → mm:ss', () => {
    assert.equal(duration('PT5M30S'), '05:30');
  });
  test('ISO 8601 PT1H30M → HH:mm:ss (auto)', () => {
    assert.equal(duration('PT1H30M'), '01:30:00');
  });
  test('bare seconds', () => {
    assert.equal(duration('90'), '01:30');
  });
  test('custom format', () => {
    assert.equal(duration('PT1H30M', 'H:mm'), '1:30');
  });
  test('non-parseable → return input', () => {
    assert.equal(duration('not a duration'), 'not a duration');
  });

  test('REGRESSION (v0.13.6 / F2 + v0.13.7 / codex G): literal formats with non-token letters are preserved (whitelist-bail)', () => {
    // v0.13.6 added the lookbehind/lookahead token boundary. v0.13.7
    // tightened this further to a whitelist: if the format contains ANY
    // letter outside `Hms`, bail out and return the format literal. This
    // is more predictable than the v0.13.6 behavior which still did
    // partial replacement when a single `H`/`m`/`s` was bordered by
    // delimiters in an otherwise non-token format.
    //
    // Trade-off: a marginal case from v0.13.6 (`'H total'` → `'1 total'`)
    // is now `'H total'` literal. The benefit: `'hh:mm'` is now `'hh:mm'`
    // literal instead of `'hh:01'` (codex G).
    assert.equal(duration('3600', 'Hours'), 'Hours');     // o,u,r non-token
    assert.equal(duration('90', 'seconds'), 'seconds');   // e,c,o,n,d non-token
    assert.equal(duration('3600', 'H total'), 'H total'); // t,o,a,l non-token → bail
  });

  test('REGRESSION (v0.13.6 / F2): canonical formats still work', () => {
    // The standard formats Clipper supports continue to replace correctly.
    assert.equal(duration('3690', 'HH:mm:ss'), '01:01:30');
    assert.equal(duration('3690', 'H:mm:ss'), '1:01:30');
    assert.equal(duration('90', 'mm:ss'), '01:30');
  });

  test('REGRESSION (v0.13.7 / codex G): lowercase variant formats bail out (no partial replacement)', () => {
    // Pre-v0.13.7: `hh:mm` had its `mm` matched (preceded by `:` non-
    // letter, followed by end-of-string non-letter) and replaced → `hh:01`.
    // The lookbehind fix from v0.13.6 was insufficient — the `mm` was
    // still surrounded by non-letters because `:` separated it from `hh`.
    // v0.13.7 adds a letter-whitelist precondition: if the format contains
    // ANY letter outside `Hms` (case-sensitive), bail out and return the
    // format literal. So `hh:mm` (contains lowercase `h` not in `Hms`)
    // is now preserved verbatim.
    assert.equal(duration('3690', 'hh:mm'), 'hh:mm');
    // Same for uppercase variants that aren't in the canonical set.
    assert.equal(duration('3690', 'MM:SS'), 'MM:SS');
    // Mixed case where only some letters are valid: still bail because
    // some are invalid.
    assert.equal(duration('3690', 'H:mm sec'), 'H:mm sec'); // `s,e,c` invalid
  });
});

describe('markdown', () => {
  test('headings', () => {
    assert.equal(markdown('<h1>Title</h1>').trim(), '# Title');
    assert.equal(markdown('<h3>Sub</h3>').trim(), '### Sub');
  });
  test('bold and italic', () => {
    assert.equal(markdown('<strong>b</strong> and <em>i</em>'), '**b** and *i*');
  });
  test('link', () => {
    assert.equal(markdown('<a href="https://x.com">click</a>'), '[click](https://x.com)');
  });
  test('inline code', () => {
    assert.equal(markdown('use <code>foo()</code> for it'), 'use `foo()` for it');
  });
  test('unordered list', () => {
    const out = markdown('<ul><li>a</li><li>b</li></ul>');
    assert.match(out, /- a/);
    assert.match(out, /- b/);
  });
  test('ordered list numbered', () => {
    const out = markdown('<ol><li>a</li><li>b</li></ol>');
    assert.match(out, /1\. a/);
    assert.match(out, /2\. b/);
  });
  test('entities decoded', () => {
    assert.equal(markdown('A &amp; B'), 'A & B');
  });
});
