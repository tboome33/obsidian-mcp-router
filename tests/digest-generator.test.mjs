/**
 * Tests for src/helpers/digest-generator.mjs — digest sidecar generation,
 * parsing, serialisation, and cross-digest analysis.
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computePageHash,
  generateDigestSkeleton,
  parseDigest,
  serialiseDigest,
  isDigestStale,
  conceptOverlap,
  sharedConcepts,
} from '../src/helpers/digest-generator.mjs';

// ---------------------------------------------------------------------------
// computePageHash
// ---------------------------------------------------------------------------

describe('computePageHash', () => {
  test('deterministic — same input → same hash', () => {
    assert.equal(computePageHash('hello'), computePageHash('hello'));
  });

  test('different input → different hash', () => {
    assert.notEqual(computePageHash('hello'), computePageHash('hella'));
  });

  test('returns 64-char lowercase hex', () => {
    assert.match(computePageHash('test'), /^[0-9a-f]{64}$/);
  });

  test('throws on non-string input', () => {
    assert.throws(() => computePageHash(null), /must be a string/);
    assert.throws(() => computePageHash(42), /must be a string/);
  });

  test('utf-8 handles unicode', () => {
    const h = computePageHash('café');
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// serialiseDigest
// ---------------------------------------------------------------------------

describe('serialiseDigest', () => {
  test('throws on missing input', () => {
    assert.throws(() => serialiseDigest(null), /must be an object/);
    assert.throws(() => serialiseDigest({}), /digest\.for is required/);
    assert.throws(
      () => serialiseDigest({ for: 'x.md' }),
      /digest\.pageHash is required/,
    );
  });

  test('produces frontmatter with all required fields', () => {
    const md = serialiseDigest({
      for: 'wiki/foo.md',
      pageHash: 'a'.repeat(64),
      concepts: ['Foo', 'Bar'],
      claims: ['First', 'Second'],
      keywords: ['k1', 'k2'],
      generatedAt: '2026-05-27T00:00:00Z',
      summary: 'A summary.',
    });
    assert.match(md, /type: digest/);
    assert.match(md, /for: wiki\/foo\.md/);
    assert.match(md, /page_hash: a{64}/);
    assert.match(md, /concepts: \[Foo, Bar\]/);
    assert.match(md, /claims: \[First, Second\]/);
    assert.match(md, /keywords: \[k1, k2\]/);
    assert.match(md, /generated_at: 2026-05-27T00:00:00Z/);
    assert.match(md, /## Summary\n\nA summary\./);
  });

  test('empty arrays serialise to []', () => {
    const md = serialiseDigest({
      for: 'wiki/x.md',
      pageHash: 'b'.repeat(64),
    });
    assert.match(md, /concepts: \[\]/);
    assert.match(md, /claims: \[\]/);
    assert.match(md, /keywords: \[\]/);
  });

  test('quotes items with special characters', () => {
    const md = serialiseDigest({
      for: 'wiki/x.md',
      pageHash: 'c'.repeat(64),
      claims: ['Has, comma', 'Has: colon', 'plain'],
    });
    assert.match(md, /"Has, comma"/);
    assert.match(md, /"Has: colon"/);
    assert.match(md, /plain/);
  });

  test('escapes embedded double quotes', () => {
    const md = serialiseDigest({
      for: 'wiki/x.md',
      pageHash: 'd'.repeat(64),
      claims: ['He said "hello, world"'],
    });
    assert.match(md, /"He said \\"hello, world\\""/);
  });

  test('omits Notable section when notable is empty', () => {
    const md = serialiseDigest({
      for: 'wiki/x.md',
      pageHash: 'e'.repeat(64),
      summary: 'OK.',
    });
    assert.doesNotMatch(md, /## Notable/);
  });

  test('includes Notable section when notable is non-empty', () => {
    const md = serialiseDigest({
      for: 'wiki/x.md',
      pageHash: 'f'.repeat(64),
      summary: 'OK.',
      notable: 'A point worth noting.',
    });
    assert.match(md, /## Notable\n\nA point worth noting\./);
  });

  test('defaults generatedAt to now', () => {
    const before = new Date().toISOString();
    const md = serialiseDigest({ for: 'wiki/x.md', pageHash: 'a'.repeat(64) });
    const after = new Date().toISOString();
    const matched = /generated_at: ([0-9T:.\-Z]+)/.exec(md);
    assert.ok(matched, 'frontmatter should have generated_at');
    assert.ok(matched[1] >= before && matched[1] <= after);
  });

  test('placeholder summary when none provided', () => {
    const md = serialiseDigest({ for: 'wiki/x.md', pageHash: 'a'.repeat(64) });
    assert.match(md, /\(pending/);
  });
});

// ---------------------------------------------------------------------------
// parseDigest
// ---------------------------------------------------------------------------

describe('parseDigest', () => {
  test('throws on non-string input', () => {
    assert.throws(() => parseDigest(null), /must be a string/);
  });

  test('throws on missing frontmatter', () => {
    assert.throws(() => parseDigest('# No frontmatter\n\nBody'), /missing or malformed/);
  });

  test('extracts all frontmatter scalars', () => {
    const md = `---
type: digest
for: wiki/foo.md
page_hash: a${'b'.repeat(63)}
generated_at: 2026-05-27T12:00:00Z
---
`;
    const d = parseDigest(md);
    assert.equal(d.type, 'digest');
    assert.equal(d.for, 'wiki/foo.md');
    assert.equal(d.pageHash, `a${'b'.repeat(63)}`);
    assert.equal(d.generatedAt, '2026-05-27T12:00:00Z');
  });

  test('parses inline arrays for concepts/claims/keywords', () => {
    const md = `---
for: wiki/x.md
page_hash: ${'a'.repeat(64)}
concepts: [OAuth, PKCE, refresh tokens]
claims: ["PKCE replaces secret", "Tokens rotate"]
keywords: [oauth, auth, security]
---
`;
    const d = parseDigest(md);
    assert.deepEqual(d.concepts, ['OAuth', 'PKCE', 'refresh tokens']);
    assert.deepEqual(d.claims, ['PKCE replaces secret', 'Tokens rotate']);
    assert.deepEqual(d.keywords, ['oauth', 'auth', 'security']);
  });

  test('handles empty arrays', () => {
    const md = `---
for: wiki/x.md
page_hash: ${'a'.repeat(64)}
concepts: []
claims: []
keywords: []
---
`;
    const d = parseDigest(md);
    assert.deepEqual(d.concepts, []);
    assert.deepEqual(d.claims, []);
    assert.deepEqual(d.keywords, []);
  });

  test('extracts Summary and Notable body sections', () => {
    const md = `---
for: wiki/x.md
page_hash: ${'a'.repeat(64)}
---

## Summary

This is the summary content.

## Notable

Something else.
`;
    const d = parseDigest(md);
    assert.equal(d.summary, 'This is the summary content.');
    assert.equal(d.notable, 'Something else.');
  });

  test('defaults missing optional fields gracefully', () => {
    const md = `---
for: wiki/x.md
page_hash: ${'a'.repeat(64)}
---
`;
    const d = parseDigest(md);
    assert.deepEqual(d.concepts, []);
    assert.deepEqual(d.claims, []);
    assert.deepEqual(d.keywords, []);
    assert.equal(d.summary, '');
    assert.equal(d.notable, '');
    assert.equal(d.generatedAt, '');
  });

  test('handles CRLF line endings', () => {
    const md = '---\r\nfor: wiki/x.md\r\npage_hash: ' + 'a'.repeat(64) + '\r\n---\r\n';
    const d = parseDigest(md);
    assert.equal(d.for, 'wiki/x.md');
  });

  test('handles quoted scalar values', () => {
    const md = `---
for: "wiki/foo: bar.md"
page_hash: ${'a'.repeat(64)}
---
`;
    const d = parseDigest(md);
    assert.equal(d.for, 'wiki/foo: bar.md');
  });
});

// ---------------------------------------------------------------------------
// Roundtrip: parse → serialise → parse → identity (on field values)
// ---------------------------------------------------------------------------

describe('parse/serialise roundtrip', () => {
  test('preserves all field values', () => {
    const original = {
      for: 'wiki/Refs/oauth-howto.md',
      pageHash: 'd'.repeat(64),
      concepts: ['OAuth 2.0', 'PKCE', 'refresh tokens'],
      claims: ['PKCE replaces secret for public', 'Refresh tokens should rotate'],
      keywords: ['oauth', 'auth', 'security'],
      generatedAt: '2026-05-27T10:00:00Z',
      summary: 'OAuth 2.0 with PKCE for public clients.',
      notable: 'Refresh rotation is non-default.',
    };
    const serialised = serialiseDigest(original);
    const reparsed = parseDigest(serialised);
    assert.equal(reparsed.for, original.for);
    assert.equal(reparsed.pageHash, original.pageHash);
    assert.deepEqual(reparsed.concepts, original.concepts);
    assert.deepEqual(reparsed.claims, original.claims);
    assert.deepEqual(reparsed.keywords, original.keywords);
    assert.equal(reparsed.generatedAt, original.generatedAt);
    assert.equal(reparsed.summary, original.summary);
    assert.equal(reparsed.notable, original.notable);
  });

  test('handles tricky items with commas, colons, quotes', () => {
    const original = {
      for: 'wiki/x.md',
      pageHash: 'e'.repeat(64),
      claims: ['Has, comma', 'Has: colon', 'He said "hi"', 'plain'],
      generatedAt: '2026-05-27T10:00:00Z',
      summary: 'Test.',
    };
    const reparsed = parseDigest(serialiseDigest(original));
    assert.deepEqual(reparsed.claims, original.claims);
  });
});

// ---------------------------------------------------------------------------
// generateDigestSkeleton
// ---------------------------------------------------------------------------

describe('generateDigestSkeleton', () => {
  test('produces a parseable digest with computed hash', () => {
    const pageContent = '---\ntype: reference\n---\n# Page\n\nBody.';
    const skeleton = generateDigestSkeleton({
      pageContent,
      forPath: 'wiki/Refs/page.md',
    });
    const d = parseDigest(skeleton);
    assert.equal(d.for, 'wiki/Refs/page.md');
    assert.equal(d.pageHash, computePageHash(pageContent));
    assert.deepEqual(d.concepts, []);
    assert.deepEqual(d.claims, []);
    assert.deepEqual(d.keywords, []);
  });

  test('throws on missing forPath', () => {
    assert.throws(
      () => generateDigestSkeleton({ pageContent: 'x' }),
      /forPath must be a non-empty string/,
    );
  });

  test('throws on non-string pageContent', () => {
    assert.throws(
      () => generateDigestSkeleton({ pageContent: null, forPath: 'x.md' }),
      /pageContent must be a string/,
    );
  });
});

// ---------------------------------------------------------------------------
// isDigestStale
// ---------------------------------------------------------------------------

describe('isDigestStale', () => {
  test('false when hashes match', () => {
    const pageContent = '# X\n\nBody.';
    const digest = { pageHash: computePageHash(pageContent) };
    assert.equal(isDigestStale({ digest, currentPageContent: pageContent }), false);
  });

  test('true when hashes differ', () => {
    const digest = { pageHash: 'a'.repeat(64) };
    assert.equal(isDigestStale({ digest, currentPageContent: 'different' }), true);
  });

  test('throws on invalid input', () => {
    assert.throws(
      () => isDigestStale({ digest: null, currentPageContent: 'x' }),
      /digest must be an object/,
    );
    assert.throws(
      () => isDigestStale({ digest: {}, currentPageContent: null }),
      /currentPageContent must be a string/,
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-digest analysis
// ---------------------------------------------------------------------------

describe('conceptOverlap', () => {
  test('returns 0 when no overlap', () => {
    const a = { concepts: ['x', 'y'] };
    const b = { concepts: ['z', 'w'] };
    assert.equal(conceptOverlap(a, b), 0);
  });

  test('returns 1 when identical sets', () => {
    const a = { concepts: ['x', 'y'] };
    const b = { concepts: ['x', 'y'] };
    assert.equal(conceptOverlap(a, b), 1);
  });

  test('Jaccard coefficient for partial overlap', () => {
    const a = { concepts: ['x', 'y'] };
    const b = { concepts: ['y', 'z'] };
    // intersection={y}, union={x,y,z}, 1/3
    assert.ok(Math.abs(conceptOverlap(a, b) - 1 / 3) < 1e-9);
  });

  test('case-insensitive match', () => {
    const a = { concepts: ['OAuth', 'PKCE'] };
    const b = { concepts: ['oauth', 'pkce'] };
    assert.equal(conceptOverlap(a, b), 1);
  });

  test('handles empty concepts', () => {
    assert.equal(conceptOverlap({ concepts: [] }, { concepts: [] }), 0);
    assert.equal(conceptOverlap({ concepts: ['x'] }, { concepts: [] }), 0);
    assert.equal(conceptOverlap({}, {}), 0);
  });
});

describe('sharedConcepts', () => {
  test('returns intersection with casing from digestA', () => {
    const a = { concepts: ['OAuth', 'PKCE', 'Foo'] };
    const b = { concepts: ['oauth', 'PKCE'] };
    assert.deepEqual(sharedConcepts(a, b), ['OAuth', 'PKCE']);
  });

  test('returns [] when no overlap', () => {
    assert.deepEqual(
      sharedConcepts({ concepts: ['a'] }, { concepts: ['b'] }),
      [],
    );
  });

  test('handles missing concepts arrays', () => {
    assert.deepEqual(sharedConcepts({}, { concepts: ['x'] }), []);
    assert.deepEqual(sharedConcepts({ concepts: ['x'] }, {}), []);
  });
});
