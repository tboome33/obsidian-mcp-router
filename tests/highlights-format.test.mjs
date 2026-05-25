import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHighlight,
  renderCallout,
  renderFrontmatterArray,
  serializeHighlights,
  parseHighlights,
  RECOGNIZED_COLORS,
} from '../src/helpers/highlights-format.mjs';

// -----------------------------------------------------------------------------
// normalizeHighlight
// -----------------------------------------------------------------------------

test('normalizeHighlight: minimal input — only text — fills defaults', () => {
  const h = normalizeHighlight({ text: 'Hello world' });
  assert.equal(h.text, 'Hello world');
  assert.equal(h.color, 'yellow', 'default color');
  assert.equal(h.note, null);
  assert.equal(h.xpath, null);
  assert.equal(h.offset_start, null);
  assert.equal(h.offset_end, null);
  assert.match(h.id, /^h-[a-f0-9]{8}$/);
});

test('normalizeHighlight: trims whitespace in text', () => {
  const h = normalizeHighlight({ text: '   spaced   ' });
  assert.equal(h.text, 'spaced');
});

test('normalizeHighlight: throws on missing/blank text', () => {
  assert.throws(() => normalizeHighlight({}), /`text` is required/);
  assert.throws(() => normalizeHighlight({ text: '' }), /`text` is required/);
  assert.throws(() => normalizeHighlight({ text: '   ' }), /`text` is required/);
  assert.throws(() => normalizeHighlight({ text: null }), /`text` is required/);
});

test('normalizeHighlight: throws on non-object input', () => {
  assert.throws(() => normalizeHighlight(null), /must be an object/);
  assert.throws(() => normalizeHighlight('string'), /must be an object/);
  assert.throws(() => normalizeHighlight(42), /must be an object/);
});

test('normalizeHighlight: stable id for same (text, xpath)', () => {
  const a = normalizeHighlight({ text: 'same', xpath: '/p[1]' });
  const b = normalizeHighlight({ text: 'same', xpath: '/p[1]' });
  assert.equal(a.id, b.id, 'idempotent re-ingestion');
});

test('normalizeHighlight: different (text, xpath) → different id', () => {
  const a = normalizeHighlight({ text: 'one', xpath: '/p[1]' });
  const b = normalizeHighlight({ text: 'two', xpath: '/p[1]' });
  const c = normalizeHighlight({ text: 'one', xpath: '/p[2]' });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, c.id);
});

test('normalizeHighlight: explicit id is preserved when valid', () => {
  const h = normalizeHighlight({ text: 'x', id: 'h-custom-id' });
  assert.equal(h.id, 'h-custom-id');
});

test('normalizeHighlight: invalid id is replaced with hash fallback', () => {
  // Block-id-style requires starting letter — `123abc` is rejected.
  const h = normalizeHighlight({ text: 'x', id: '123abc' });
  assert.match(h.id, /^h-[a-f0-9]{8}$/);
});

test('normalizeHighlight: color lowercased + trimmed', () => {
  const h = normalizeHighlight({ text: 'x', color: '  PINK  ' });
  assert.equal(h.color, 'pink');
});

test('normalizeHighlight: empty/blank color → default yellow', () => {
  assert.equal(normalizeHighlight({ text: 'x', color: '' }).color, 'yellow');
  assert.equal(normalizeHighlight({ text: 'x', color: '  ' }).color, 'yellow');
  assert.equal(normalizeHighlight({ text: 'x' }).color, 'yellow');
});

test('normalizeHighlight: note is preserved trimmed when non-blank', () => {
  assert.equal(normalizeHighlight({ text: 'x', note: '  hello  ' }).note, 'hello');
  assert.equal(normalizeHighlight({ text: 'x', note: '' }).note, null);
  assert.equal(normalizeHighlight({ text: 'x' }).note, null);
});

test('normalizeHighlight: offsets are integers ≥0 or null', () => {
  assert.equal(normalizeHighlight({ text: 'x', offset_start: 0 }).offset_start, 0);
  assert.equal(normalizeHighlight({ text: 'x', offset_start: 42 }).offset_start, 42);
  // Invalid: negative, non-integer, NaN → null
  assert.equal(normalizeHighlight({ text: 'x', offset_start: -1 }).offset_start, null);
  assert.equal(normalizeHighlight({ text: 'x', offset_start: 1.5 }).offset_start, null);
  assert.equal(normalizeHighlight({ text: 'x', offset_start: 'foo' }).offset_start, null);
});

// -----------------------------------------------------------------------------
// renderCallout
// -----------------------------------------------------------------------------

test('renderCallout: basic single-line highlight', () => {
  const h = normalizeHighlight({ text: 'Hello world', id: 'h-abc12345' });
  const out = renderCallout(h);
  assert.equal(
    out,
    '> [!highlight] color=yellow\n> Hello world\n> ^h-abc12345',
  );
});

test('renderCallout: includes note when present', () => {
  const h = normalizeHighlight({ text: 'x', id: 'h-id', note: 'matches Karpathy talk' });
  const out = renderCallout(h);
  assert.match(out, /> \(note: matches Karpathy talk\)/);
});

test('renderCallout: multi-line text — each line gets > prefix', () => {
  const h = normalizeHighlight({ text: 'Line one\nLine two\nLine three', id: 'h-id' });
  const out = renderCallout(h);
  assert.match(out, /^> Line one\n> Line two\n> Line three\n/m);
});

test('renderCallout: blank lines inside text become bare > (Obsidian paragraph break inside callout)', () => {
  const h = normalizeHighlight({ text: 'Para1\n\nPara2', id: 'h-id' });
  const out = renderCallout(h);
  // Verify the blank line is `>` (not `> ` with trailing space, not stripped entirely)
  const lines = out.split('\n');
  // Find the bare `>` line between para1 and para2
  const idx = lines.findIndex((l) => l === '>');
  assert.ok(idx > -1, 'should have at least one bare `>` line');
});

test('renderCallout: color from highlight (not hardcoded yellow)', () => {
  const h = normalizeHighlight({ text: 'x', color: 'pink', id: 'h-id' });
  assert.match(renderCallout(h), /^> \[!highlight\] color=pink/);
});

test('renderCallout: id is always at the end as ^<id>', () => {
  const h = normalizeHighlight({ text: 'x', id: 'h-custom' });
  const out = renderCallout(h);
  assert.equal(out.split('\n').pop(), '> ^h-custom');
});

// -----------------------------------------------------------------------------
// renderFrontmatterArray
// -----------------------------------------------------------------------------

test('renderFrontmatterArray: empty array → highlights: []', () => {
  assert.equal(renderFrontmatterArray([]), 'highlights: []');
  assert.equal(renderFrontmatterArray(null), 'highlights: []');
  assert.equal(renderFrontmatterArray(undefined), 'highlights: []');
});

test('renderFrontmatterArray: single highlight, minimal fields', () => {
  const arr = [normalizeHighlight({ text: 'hello', id: 'h-id1' })];
  const yaml = renderFrontmatterArray(arr);
  // Default color: yellow. No note/xpath/offsets → those lines omitted.
  assert.equal(
    yaml,
    'highlights:\n  - id: h-id1\n    text: hello\n    color: yellow',
  );
});

test('renderFrontmatterArray: full highlight with all fields', () => {
  const arr = [
    normalizeHighlight({
      text: 'Full one',
      id: 'h-full',
      color: 'pink',
      note: 'a note',
      xpath: '/html/body/p[1]',
      offset_start: 5,
      offset_end: 13,
    }),
  ];
  const yaml = renderFrontmatterArray(arr);
  assert.match(yaml, /id: h-full/);
  assert.match(yaml, /text: Full one/);
  assert.match(yaml, /color: pink/);
  assert.match(yaml, /note: a note/);
  assert.match(yaml, /xpath: "\/html\/body\/p\[1\]"/, 'xpath should be quoted (contains brackets)');
  assert.match(yaml, /offset_start: 5/);
  assert.match(yaml, /offset_end: 13/);
});

test('renderFrontmatterArray: multi-line text → double-quoted with \\n escape', () => {
  const arr = [normalizeHighlight({ text: 'Line one\nLine two', id: 'h-id' })];
  const yaml = renderFrontmatterArray(arr);
  assert.match(yaml, /text: "Line one\\nLine two"/);
});

test('renderFrontmatterArray: text containing double-quote and backslash → escaped', () => {
  const arr = [normalizeHighlight({ text: 'He said "hi"\\path', id: 'h-id' })];
  const yaml = renderFrontmatterArray(arr);
  assert.match(yaml, /text: "He said \\"hi\\"\\\\path"/);
});

test('renderFrontmatterArray: text starting with reserved YAML char → quoted', () => {
  // Strings starting with `-`, `?`, `:`, `[`, `{`, etc. must be quoted.
  for (const prefix of ['- foo', '? bar', ': baz', '[arr]', '{ obj }', '# comment', '* anchor', '& alias', '@scope']) {
    const arr = [normalizeHighlight({ text: prefix, id: 'h-x' })];
    const yaml = renderFrontmatterArray(arr);
    assert.match(yaml, /text: "/, `"${prefix}" should be quoted`);
  }
});

test('renderFrontmatterArray: multiple highlights — each on its own bullet', () => {
  const arr = [
    normalizeHighlight({ text: 'one', id: 'h-1' }),
    normalizeHighlight({ text: 'two', id: 'h-2', color: 'pink' }),
  ];
  const yaml = renderFrontmatterArray(arr);
  const bullets = yaml.match(/^\s+- id:/gm) || [];
  assert.equal(bullets.length, 2);
});

// -----------------------------------------------------------------------------
// serializeHighlights — top-level wrapper
// -----------------------------------------------------------------------------

test('serializeHighlights: returns both callouts and frontmatter', () => {
  const raw = [{ text: 'hello' }, { text: 'world', color: 'pink' }];
  const { normalized, calloutBlocks, frontmatterYaml } = serializeHighlights(raw);

  assert.equal(normalized.length, 2);
  // Two callouts separated by blank line.
  assert.match(calloutBlocks, /^> \[!highlight\] color=yellow/m);
  assert.match(calloutBlocks, /^> \[!highlight\] color=pink/m);
  assert.match(calloutBlocks, /\n\n>/m, 'callouts separated by blank line');
  // Frontmatter mentions both.
  assert.match(frontmatterYaml, /highlights:/);
  assert.match(frontmatterYaml, /text: hello/);
  assert.match(frontmatterYaml, /text: world/);
});

test('serializeHighlights: empty input is safe', () => {
  const r = serializeHighlights([]);
  assert.deepEqual(r.normalized, []);
  assert.equal(r.calloutBlocks, '');
  assert.equal(r.frontmatterYaml, 'highlights: []');
});

test('serializeHighlights: null/undefined input is safe', () => {
  assert.deepEqual(serializeHighlights(null).normalized, []);
  assert.deepEqual(serializeHighlights(undefined).normalized, []);
});

// -----------------------------------------------------------------------------
// parseHighlights — round-trip support
// -----------------------------------------------------------------------------

test('parseHighlights: null/undefined → []', () => {
  assert.deepEqual(parseHighlights(null), []);
  assert.deepEqual(parseHighlights(undefined), []);
  assert.deepEqual(parseHighlights([]), []);
});

test('parseHighlights: non-array input throws', () => {
  assert.throws(() => parseHighlights({}), /expected an array/);
  assert.throws(() => parseHighlights('string'), /expected an array/);
  assert.throws(() => parseHighlights(42), /expected an array/);
});

test('parseHighlights: round-trips a serialized highlight', () => {
  // serialize → would-be-yaml-parsed (we simulate the YAML parser output
  // as a plain array of objects) → parse → should match normalized.
  const original = [
    { text: 'one', color: 'yellow', id: 'h-a' },
    { text: 'two\nlines', color: 'pink', id: 'h-b', xpath: '/p[1]', offset_start: 0, offset_end: 9 },
  ];
  const { normalized } = serializeHighlights(original);
  const parsed = parseHighlights(normalized);
  assert.deepEqual(parsed, normalized);
});

test('parseHighlights: raw partial entries are normalized (missing color → yellow)', () => {
  // Simulates reading a hand-edited frontmatter that only has text + id.
  const parsed = parseHighlights([
    { text: 'minimal', id: 'h-min' },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].color, 'yellow');
  assert.equal(parsed[0].note, null);
});

// -----------------------------------------------------------------------------
// RECOGNIZED_COLORS sanity
// -----------------------------------------------------------------------------

test('RECOGNIZED_COLORS: frozen and contains expected entries', () => {
  assert.equal(Object.isFrozen(RECOGNIZED_COLORS), true);
  for (const c of ['yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'red']) {
    assert.ok(RECOGNIZED_COLORS.includes(c), `missing color: ${c}`);
  }
});
