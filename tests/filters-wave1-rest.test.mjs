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
