/**
 * Tests for src/helpers/idf-score.mjs — IDF-weighted candidate scoring
 * with dynamic seed selection. Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenise,
  computeIdf,
  defaultIdf,
  scoreCandidates,
  pickSeeds,
  rankAndPick,
  _internals,
} from '../src/helpers/idf-score.mjs';

// ---------------------------------------------------------------------------
// tokenise
// ---------------------------------------------------------------------------

describe('tokenise', () => {
  test('empty or non-string returns []', () => {
    assert.deepEqual(tokenise(''), []);
    assert.deepEqual(tokenise(null), []);
    assert.deepEqual(tokenise(undefined), []);
    assert.deepEqual(tokenise(42), []);
  });

  test('lowercases', () => {
    assert.deepEqual(tokenise('Hello World'), ['hello', 'world']);
  });

  test('splits on punctuation', () => {
    assert.deepEqual(tokenise('foo, bar; baz!'), ['foo', 'bar', 'baz']);
  });

  test('drops tokens shorter than MIN_TOKEN_LEN (3)', () => {
    assert.deepEqual(tokenise('a bb ccc dddd'), ['ccc', 'dddd']);
    assert.equal(_internals.MIN_TOKEN_LEN, 3);
  });

  test('preserves Unicode letters (French, German, emoji-adjacent)', () => {
    assert.deepEqual(tokenise('café résumé über naïve'), ['café', 'résumé', 'über', 'naïve']);
  });

  test('numbers count as tokens (codes, years, versions)', () => {
    // 'v0' (2 chars), '8' (1 char), '9' (1 char) all filtered as too short;
    // 'released' (8 chars) and '2026' (4 chars) kept.
    assert.deepEqual(tokenise('v0.8.9 released 2026'), ['released', '2026']);
  });

  test('underscores are part of tokens (snake_case identifiers)', () => {
    assert.deepEqual(tokenise('user_id and order_total'), ['user_id', 'and', 'order_total']);
  });

  test('preserves token order', () => {
    assert.deepEqual(tokenise('charlie alpha bravo'), ['charlie', 'alpha', 'bravo']);
  });

  test('handles multi-line input', () => {
    assert.deepEqual(tokenise('first line\nsecond line'), ['first', 'line', 'second', 'line']);
  });
});

// Fix the version-tokens test which I miscounted above.
describe('tokenise — version strings', () => {
  test('v0.8.9 splits and drops <3-char fragments', () => {
    const out = tokenise('v0.8.9');
    // v0, 8, 9 — all 1-2 chars → all filtered.
    assert.deepEqual(out, []);
  });

  test('release v0.8.9 keeps "release" only', () => {
    assert.deepEqual(tokenise('release v0.8.9'), ['release']);
  });
});

// ---------------------------------------------------------------------------
// computeIdf
// ---------------------------------------------------------------------------

describe('computeIdf', () => {
  test('empty corpus returns empty map', () => {
    const idf = computeIdf([]);
    assert.equal(idf.size, 0);
  });

  test('rare token gets high weight, common token gets low weight', () => {
    const docs = [
      ['user', 'login', 'flow'],
      ['user', 'profile'],
      ['user', 'settings'],
      ['user', 'logout'],
      ['kelly', 'criterion'], // 'kelly' is rare (1/5), 'user' is common (4/5)
    ];
    const idf = computeIdf(docs);
    assert.ok(idf.get('kelly') > idf.get('user'),
      `kelly=${idf.get('kelly')} should beat user=${idf.get('user')}`);
  });

  test('formula: idf(t) = log(1 + N / (1 + df(t)))', () => {
    const docs = [['a'], ['a'], ['a'], ['b']];
    const idf = computeIdf(docs);
    // N=4, df(a)=3 → log(1 + 4/4) = log(2)
    assert.ok(Math.abs(idf.get('a') - Math.log(2)) < 1e-9);
    // N=4, df(b)=1 → log(1 + 4/2) = log(3)
    assert.ok(Math.abs(idf.get('b') - Math.log(3)) < 1e-9);
  });

  test('token appearing multiple times in same doc counts once', () => {
    const docs = [['user', 'user', 'user'], ['user']];
    const idf = computeIdf(docs);
    // df(user) = 2 (in both docs), not 4. N=2, df=2 → log(1 + 2/3)
    assert.ok(Math.abs(idf.get('user') - Math.log(1 + 2 / 3)) < 1e-9);
  });

  test('accepts iterables (not just arrays)', () => {
    function* gen() {
      yield new Set(['a', 'b']);
      yield new Set(['b', 'c']);
    }
    const idf = computeIdf(gen());
    assert.ok(idf.has('a'));
    assert.ok(idf.has('b'));
    assert.ok(idf.has('c'));
  });
});

describe('defaultIdf', () => {
  test('returns log(1 + N)', () => {
    assert.equal(defaultIdf(10), Math.log(11));
    assert.equal(defaultIdf(0), Math.log(1));
  });
});

// ---------------------------------------------------------------------------
// scoreCandidates
// ---------------------------------------------------------------------------

describe('scoreCandidates', () => {
  test('empty query returns all candidates with score 0', () => {
    const out = scoreCandidates({
      query: '',
      candidates: [{ label: 'foo' }, { label: 'bar' }],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].score, 0);
    assert.equal(out[1].score, 0);
  });

  test('empty candidates returns []', () => {
    const out = scoreCandidates({ query: 'foo', candidates: [] });
    assert.deepEqual(out, []);
  });

  test('exact label match scores way higher than substring', () => {
    const out = scoreCandidates({
      query: 'momentum',
      candidates: [
        { label: 'momentum' },             // exact
        { label: 'momentum strategy' },    // prefix
        { label: 'price momentum trick' }, // substring
        { label: 'completely unrelated' }, // none
      ],
    });
    assert.equal(out[0].candidate.label, 'momentum');
    assert.equal(out[1].candidate.label, 'momentum strategy');
    assert.equal(out[2].candidate.label, 'price momentum trick');
    assert.equal(out[3].candidate.label, 'completely unrelated');
    // Exact > prefix > substring > 0 (ratios are 1000:100:1)
    assert.ok(out[0].score > out[1].score);
    assert.ok(out[1].score > out[2].score);
    assert.equal(out[3].score, 0);
  });

  test('IDF down-weights common terms (rare-term match beats common-term match at same depth)', () => {
    // "user" appears in 4/5 corpus docs → low IDF.
    // "kelly" appears in 1/5 → high IDF.
    // Both candidates match exactly one query term at the same depth (prefix),
    // so the only difference is the per-term IDF weight. Kelly should win.
    const corpus = [
      ['user', 'login'],
      ['user', 'profile'],
      ['user', 'settings'],
      ['user', 'auth'],
      ['kelly', 'criterion'],
    ];
    const idf = computeIdf(corpus);
    const candidates = [
      { label: 'user notes' },       // prefix match on "user" (common)
      { label: 'kelly insights' },   // prefix match on "kelly" (rare)
      { label: 'unrelated stuff' },  // no match
    ];
    const out = scoreCandidates({ query: 'user kelly', candidates, idf });
    assert.equal(out[0].candidate.label, 'kelly insights',
      `expected kelly insights to top user notes (IDF down-weight). out=${JSON.stringify(out.map(o => ({l: o.candidate.label, s: o.score})))}`);
    assert.equal(out[2].candidate.label, 'unrelated stuff');
  });

  test('cumulative match beats single match when IDFs are comparable', () => {
    // No IDF map → all terms get the same default weight. So the candidate
    // matching MORE query terms wins.
    const candidates = [
      { label: 'kelly user notes' },  // kelly prefix + user substring
      { label: 'kelly insights' },    // kelly prefix only
    ];
    const out = scoreCandidates({ query: 'kelly user', candidates });
    assert.equal(out[0].candidate.label, 'kelly user notes');
  });

  test('secondaryLabel matches at half weight', () => {
    const a = scoreCandidates({
      query: 'foo',
      candidates: [{ label: 'unrelated', secondaryLabel: 'foo' }],
    });
    const b = scoreCandidates({
      query: 'foo',
      candidates: [{ label: 'foo', secondaryLabel: 'unrelated' }],
    });
    // Both have a 'foo' match — a is in secondaryLabel (×0.5), b in label (×1).
    // b should score exactly double a.
    assert.ok(Math.abs(b[0].score - 2 * a[0].score) < 1e-9,
      `a=${a[0].score} b=${b[0].score}`);
  });

  test('aliases boost candidate scoring', () => {
    const out = scoreCandidates({
      query: 'kelly',
      candidates: [
        { label: 'position sizing' }, // no match
        { label: 'pos size', aliases: ['kelly criterion', 'half-kelly'] }, // alias matches
      ],
    });
    assert.equal(out[0].candidate.label, 'pos size');
    assert.ok(out[0].score > 0);
    assert.equal(out[1].score, 0);
  });

  test('missing or non-string label is safe (score 0)', () => {
    const out = scoreCandidates({
      query: 'foo',
      candidates: [{ label: 42 }, { label: null }, {}],
    });
    assert.equal(out.length, 3);
    assert.ok(out.every((s) => s.score === 0));
  });

  test('case-insensitive matching', () => {
    const out = scoreCandidates({
      query: 'MOMENTUM',
      candidates: [{ label: 'momentum' }],
    });
    assert.ok(out[0].score > 0);
  });

  test('output is sorted by score descending', () => {
    // Query "foobar"; depth varies cleanly so the order is predictable.
    const out = scoreCandidates({
      query: 'foobar',
      candidates: [
        { label: 'mentions foobar here' },  // substring only (weight 1)
        { label: 'foobar' },                 // exact match (weight 1000)
        { label: 'foobar suffix' },          // prefix match (weight 100)
        { label: 'completely different' },   // no match (0)
      ],
    });
    // Monotonic non-increasing
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].score >= out[i].score,
        `out[${i - 1}].score=${out[i - 1].score} should be >= out[${i}].score=${out[i].score}`);
    }
    // Exact crushes prefix crushes substring crushes nothing.
    assert.equal(out[0].candidate.label, 'foobar');
    assert.equal(out[1].candidate.label, 'foobar suffix');
    assert.equal(out[2].candidate.label, 'mentions foobar here');
    assert.equal(out[3].candidate.label, 'completely different');
  });
});

// ---------------------------------------------------------------------------
// pickSeeds
// ---------------------------------------------------------------------------

describe('pickSeeds', () => {
  test('empty input returns []', () => {
    assert.deepEqual(pickSeeds([]), []);
    assert.deepEqual(pickSeeds(null), []);
    assert.deepEqual(pickSeeds(undefined), []);
  });

  test('single candidate returns that candidate', () => {
    const out = pickSeeds([{ score: 5, candidate: { label: 'only' } }]);
    assert.deepEqual(out, [{ label: 'only' }]);
  });

  test('dominant top (>5× runner-up) returns only top', () => {
    const out = pickSeeds([
      { score: 1000, candidate: { label: 'dominant' } },
      { score: 50, candidate: { label: 'weak1' } },
      { score: 10, candidate: { label: 'weak2' } },
    ]);
    assert.deepEqual(out, [{ label: 'dominant' }]);
  });

  test('non-dominant top returns up to maxSeeds (default 3)', () => {
    const out = pickSeeds([
      { score: 100, candidate: { label: 'a' } },
      { score: 80, candidate: { label: 'b' } },
      { score: 60, candidate: { label: 'c' } },
      { score: 40, candidate: { label: 'd' } },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((c) => c.label), ['a', 'b', 'c']);
  });

  test('honors custom maxSeeds', () => {
    const out = pickSeeds(
      [
        { score: 100, candidate: { label: 'a' } },
        { score: 80, candidate: { label: 'b' } },
        { score: 60, candidate: { label: 'c' } },
      ],
      { maxSeeds: 2 },
    );
    assert.equal(out.length, 2);
  });

  test('honors custom dominanceRatio', () => {
    const out = pickSeeds(
      [
        { score: 100, candidate: { label: 'a' } },
        { score: 80, candidate: { label: 'b' } },
      ],
      { dominanceRatio: 1.1 },
    );
    // 100 > 1.1 × 80 = 88 → dominant.
    assert.deepEqual(out, [{ label: 'a' }]);
  });

  test('runner-up score 0 → top is treated as dominant', () => {
    const out = pickSeeds([
      { score: 50, candidate: { label: 'top' } },
      { score: 0, candidate: { label: 'zero' } },
    ]);
    assert.deepEqual(out, [{ label: 'top' }]);
  });

  test('all scores 0 → returns up to maxSeeds anyway (caller can still try)', () => {
    const out = pickSeeds([
      { score: 0, candidate: { label: 'a' } },
      { score: 0, candidate: { label: 'b' } },
      { score: 0, candidate: { label: 'c' } },
      { score: 0, candidate: { label: 'd' } },
    ]);
    assert.equal(out.length, 3);
  });

  test('exactly equals dominanceRatio (boundary case) → NOT dominant', () => {
    // The condition is `top > ratio * runner` (strict). top == 5 * runner is not dominant.
    const out = pickSeeds([
      { score: 100, candidate: { label: 'top' } },
      { score: 20, candidate: { label: 'runner' } },
    ]);
    // 100 == 5 * 20 → not strictly dominant → returns both
    assert.equal(out.length, 2);
  });
});

// ---------------------------------------------------------------------------
// rankAndPick (convenience wrapper)
// ---------------------------------------------------------------------------

describe('rankAndPick', () => {
  test('end-to-end: dominant single seed', () => {
    const out = rankAndPick({
      query: 'momentum',
      candidates: [
        { label: 'momentum' },
        { label: 'random' },
        { label: 'other' },
      ],
    });
    assert.deepEqual(out, [{ label: 'momentum' }]);
  });

  test('end-to-end: multi-seed when ambiguous', () => {
    const out = rankAndPick({
      query: 'sizing position kelly',
      candidates: [
        { label: 'position sizing' },     // 2 tokens, 1 exact prefix
        { label: 'kelly criterion' },     // 1 token prefix
        { label: 'risk management' },     // 0 tokens
        { label: 'sizing strategies' },   // 1 token prefix
      ],
    });
    // Top should be 'position sizing' (best match) — but check we get >1 seed.
    assert.ok(out.length >= 2, `got ${out.length} seeds`);
  });

  test('end-to-end with IDF map produces sensible ranking', () => {
    const idf = computeIdf([
      ['user', 'login'],
      ['user', 'profile'],
      ['user', 'auth'],
      ['user', 'settings'],
      ['kelly', 'criterion'],
    ]);
    const out = rankAndPick({
      query: 'user kelly',
      candidates: [
        { label: 'user settings' },   // common term match
        { label: 'kelly criterion' }, // rare-term match
        { label: 'unrelated stuff' }, // no match
      ],
      idf,
    });
    // Kelly's IDF dominates, so kelly criterion should top.
    assert.equal(out[0].label, 'kelly criterion');
  });
});

// ---------------------------------------------------------------------------
// Regression — graphify issue #897 (multi-weak-seed traversal)
// ---------------------------------------------------------------------------

describe('regression — graphify #897 (dominant match suppresses weak runner-ups)', () => {
  test('single strong term + several weak matches → only one seed picked', () => {
    // Simulate: query "lock vault behavior" where "lock" has a strong exact
    // match on one page, and "vault" + "behavior" only match weakly via
    // substring on a bunch of pages. Without _pick_seeds, you'd traverse
    // through all three and produce incoherent synthesis. With it, the lock
    // page wins outright.
    const candidates = [
      { label: 'lock' },
      { label: 'vault management overview' },
      { label: 'lock-behavior of caching' },
      { label: 'behavior tracking' },
    ];
    const out = rankAndPick({ query: 'lock', candidates });
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'lock');
  });
});
