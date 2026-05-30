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
  digestPathForPage,
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
    // `for:` and `generated_at:` are YAML-quoted post-review+ pass 2
    // hardening because both contain `:` (path separators or ISO
    // timestamp). Accept either form for forward-compat.
    assert.match(md, /for:\s*"?wiki\/foo\.md"?/);
    assert.match(md, /page_hash: a{64}/);
    assert.match(md, /concepts: \[Foo, Bar\]/);
    assert.match(md, /claims: \[First, Second\]/);
    assert.match(md, /keywords: \[k1, k2\]/);
    assert.match(md, /generated_at:\s*"?2026-05-27T00:00:00Z"?/);
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
    // ISO timestamps contain `:` so they get YAML-quoted by serialiseDigest
    // post-review+ pass 2 hardening. Accept both quoted and unquoted forms.
    const matched = /generated_at:\s*"?([0-9T:.\-Z]+)"?/.exec(md);
    assert.ok(matched, 'frontmatter should have generated_at');
    assert.ok(matched[1] >= before && matched[1] <= after);
  });

  test('placeholder summary when none provided', () => {
    const md = serialiseDigest({ for: 'wiki/x.md', pageHash: 'a'.repeat(64) });
    assert.match(md, /\(pending/);
  });

  // -------------------------------------------------------------------------
  // YAML injection safety — review+ pass 2 regression tests
  // -------------------------------------------------------------------------

  test('YAML injection: digest.for with embedded newline is quoted', () => {
    const md = serialiseDigest({
      for: 'foo.md\nclaims: [INJECTED]',
      pageHash: 'a'.repeat(64),
    });
    // The injected line MUST NOT appear at the YAML top level — it must
    // be inside the quoted `for:` value (escaped as \n).
    // Specifically: there's no bare `claims: [INJECTED]` line at root.
    assert.doesNotMatch(md, /^claims: \[INJECTED\]/m);
    // The for: value contains the escaped newline literal.
    assert.match(md, /for:\s*"foo\.md\\nclaims: \[INJECTED\]"/);
  });

  test('YAML injection: array item with embedded newline is escaped', () => {
    const md = serialiseDigest({
      for: 'x',
      pageHash: 'b'.repeat(64),
      claims: ['normal', 'evil\nkeywords: [INJECTED]'],
    });
    assert.doesNotMatch(md, /^keywords: \[INJECTED\]/m);
    assert.match(md, /"evil\\nkeywords: \[INJECTED\]"/);
  });

  test('YAML injection: pageHash is hex-validated (rejects newline)', () => {
    assert.throws(
      () =>
        serialiseDigest({
          for: 'x',
          pageHash: 'a'.repeat(64) + '\nfor: pwned',
        }),
      /pageHash must be a 64-char hex string/,
    );
  });

  test('YAML reserved scalars (yes/no/true/false/null) are quoted', () => {
    const md = serialiseDigest({
      for: 'x',
      pageHash: 'c'.repeat(64),
      keywords: ['yes', 'NO', 'True', 'null', 'normal'],
    });
    // All reserved scalars get quoted, normal stays bare.
    assert.match(md, /"yes"/);
    assert.match(md, /"NO"/);
    assert.match(md, /"True"/);
    assert.match(md, /"null"/);
    assert.match(md, /, normal\]/);
  });

  test('YAML alias/anchor leading chars are quoted', () => {
    const md = serialiseDigest({
      for: 'x',
      pageHash: 'd'.repeat(64),
      concepts: ['*alias', '&anchor', '!tag', 'normal'],
    });
    assert.match(md, /"\*alias"/);
    assert.match(md, /"&anchor"/);
    assert.match(md, /"!tag"/);
  });

  test('numeric-looking strings get quoted (preserve string form)', () => {
    const md = serialiseDigest({
      for: 'x',
      pageHash: 'e'.repeat(64),
      keywords: ['42', '3.14', '-1', 'oauth2'],
    });
    assert.match(md, /"42"/);
    assert.match(md, /"3\.14"/);
    assert.match(md, /"-1"/);
    // oauth2 has letters so doesn't match the numeric pattern — stays bare.
    assert.match(md, /oauth2/);
  });

  test('ordinary paths (no special chars) stay UNQUOTED', () => {
    // Regression guard against the `[ -\\]` regex range bug that would
    // over-quote any string containing `/`, `.`, digits, or letters.
    const md = serialiseDigest({
      for: 'wiki/Refs/oauth-howto.md',
      pageHash: 'f'.repeat(64),
      concepts: ['OAuth', 'PKCE', 'simple-tag'],
    });
    // `for:` value should be the bare path, no quotes around it.
    assert.match(md, /for: wiki\/Refs\/oauth-howto\.md\n/);
    // Concepts items should be bare (no quoting noise).
    assert.match(md, /concepts: \[OAuth, PKCE, simple-tag\]/);
  });

  test('control characters in scalars are escaped', () => {
    const md = serialiseDigest({
      for: 'x\ttab',
      pageHash: 'a'.repeat(64),
    });
    // \t in for: gets escaped to literal \t in the quoted form.
    assert.match(md, /for:\s*"x\\ttab"/);
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

  test('throws on duplicate H2 section (no silent overwrite)', () => {
    // review+ pass 2 fix for Reviewer A IMP-3 — previously the parser
    // silently kept only the LAST `## Summary` block, losing data.
    const md = `---
for: x
page_hash: ${'a'.repeat(64)}
---

## Summary

First summary.

## Summary

Second summary that would have silently won pre-fix.
`;
    assert.throws(
      () => parseDigest(md),
      /duplicate H2 section "Summary"/,
    );
  });

  test('throws on duplicate non-Summary H2 too', () => {
    const md = `---
for: x
page_hash: ${'a'.repeat(64)}
---

## Notable

First.

## Notable

Second.
`;
    assert.throws(() => parseDigest(md), /duplicate H2 section "Notable"/);
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

  test('REGRESSION: Windows-backslash for: round-trips (canonicalised to /)', () => {
    // review+ Code Reviewer NIT (wiki-graph pass, 2026-05-29): a
    // Windows-style `for:` path was YAML-escaped to "wiki\\sub\\a.md" on
    // serialise, and parseDigest — which strips the surrounding quotes
    // but does NOT un-escape YAML escapes — reparsed it as the doubled
    // `wiki\\sub\\a.md`. The digest therefore never matched its
    // forward-slash source page and its concepts/claims were silently
    // lost from the graph. serialiseDigest now canonicalises `\` → `/`
    // so the stored path uses the same separator the router writes
    // everywhere (collectMarkdown / digestPathForPage).
    const winPath = 'wiki\\sub\\a.md'; // real single backslashes
    const md = serialiseDigest({ for: winPath, pageHash: 'a'.repeat(64) });
    // Stored canonically: forward slashes, bare (no quoting needed,
    // no surviving backslash to double).
    assert.match(md, /^for: wiki\/sub\/a\.md$/m);
    const reparsed = parseDigest(md);
    // The reparsed `for` resolves back to the same page in forward-slash
    // canonical form — which is what every other writer/reader uses.
    assert.equal(reparsed.for, 'wiki/sub/a.md');
    assert.equal(reparsed.for, winPath.replace(/\\/g, '/'));
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

// ---------------------------------------------------------------------------
// digestPathForPage — canonical naming (review+ pass 2)
// ---------------------------------------------------------------------------

describe('digestPathForPage', () => {
  test('nests source path under wiki-meta/digests/ (review+ pass 3)', () => {
    assert.equal(
      digestPathForPage('wiki/Refs/oauth-howto.md'),
      'wiki-meta/digests/wiki/Refs/oauth-howto.md',
    );
  });

  test('preserves .md extension', () => {
    assert.match(digestPathForPage('wiki/x.md'), /\.md$/);
  });

  test('idempotent — same input always produces same output', () => {
    assert.equal(
      digestPathForPage('wiki/Refs/foo.md'),
      digestPathForPage('wiki/Refs/foo.md'),
    );
  });

  test('normalises backslashes to forward slashes', () => {
    assert.equal(
      digestPathForPage('wiki\\Refs\\foo.md'),
      'wiki-meta/digests/wiki/Refs/foo.md',
    );
  });

  test('rejects POSIX absolute paths', () => {
    assert.throws(
      () => digestPathForPage('/etc/passwd'),
      /vault-relative without ".."/,
    );
  });

  test('rejects Windows drive letters', () => {
    assert.throws(
      () => digestPathForPage('C:\\Windows\\x'),
      /vault-relative without ".."/,
    );
  });

  test('rejects .. segments', () => {
    assert.throws(
      () => digestPathForPage('../etc/x'),
      /vault-relative without ".."/,
    );
    assert.throws(
      () => digestPathForPage('foo/../bar'),
      /vault-relative without ".."/,
    );
  });

  test('rejects empty / non-string input', () => {
    assert.throws(() => digestPathForPage(''), /non-empty string/);
    assert.throws(() => digestPathForPage(null), /non-empty string/);
  });

  test('two different pages → two different digest paths (collision-free)', () => {
    const a = digestPathForPage('wiki/Refs/foo.md');
    const b = digestPathForPage('wiki/Refs/bar.md');
    const c = digestPathForPage('wiki/Misc/foo.md');
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
  });

  test('REGRESSION: dash-vs-slash collision (review+ pass 3)', () => {
    // Reviewer B Pass 2 IMPORTANT finding : the previous flatten-with-
    // dashes mapping mapped both `wiki/A-B.md` and `wiki/A/B.md` to
    // `wiki-meta/digests/wiki-A-B.md` — silent collision. Nested
    // mapping eliminates the collision by construction.
    const a = digestPathForPage('wiki/A-B.md');
    const b = digestPathForPage('wiki/A/B.md');
    assert.notEqual(
      a,
      b,
      `dash-vs-slash collision regression — both inputs produce ${a}`,
    );
    // Second pair from the codex report.
    const c = digestPathForPage('wiki/Refs-oauth/howto.md');
    const d = digestPathForPage('wiki/Refs/oauth-howto.md');
    assert.notEqual(c, d);
  });
});
