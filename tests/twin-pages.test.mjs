/**
 * twin-pages — C11's deterministic core: quasi-twin detection by cosine, with
 * the similarity threshold DERIVED FROM THE CORPUS rather than fixed.
 *
 * Every test here EXERCISES the module. None of them reads the source text:
 * a test that greps for a spelling passes on a rename and fails on a rewrite,
 * which is exactly backwards.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  findTwinPages,
  deriveThreshold,
  normalise,
  dot,
  SENSITIVITY_K,
  MIN_PAIRS_FOR_THRESHOLD,
  MAX_PAGES,
  MAX_PAGES_CEILING,
  UNAVAILABLE_REASONS,
  SIGNAL_NOT_ORDER,
} from '../src/helpers/twin-pages.mjs';

// ---------------------------------------------------------------------------
// Fixtures — a corpus that looks like a real vault, built with NO randomness.
// ---------------------------------------------------------------------------

/** Deterministic LCG. `Math.random` in a fixture makes a flaky test. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A vector with a SHARED component plus per-page noise. The shared part is what
 * makes the fixture realistic: on a real vault every page is about the same
 * project, so background pairs sit around cosine 0.75 rather than around 0.
 * (Measured on the router's own vault: median pair cosine 0.746; this fixture
 * lands at 0.749.) A fixture of orthogonal vectors would have no spread to
 * derive a threshold from and would never exercise the derivation at all.
 */
function backgroundVector(seed, dims = 16, shared = 0.55) {
  const rand = lcg(seed);
  const v = [];
  for (let i = 0; i < dims; i += 1) v.push(shared * Math.sin(i) + (rand() - 0.5));
  return v;
}

const TWIN_A = 'wiki/alpha/router-setup.md';
const TWIN_B = 'wiki/beta/setting-up-the-router.md';

/**
 * 12 unrelated pages + 2 near-identical ones in DIFFERENT folders sharing no
 * link — the shape §2.17 warns about: two pages born in two sessions.
 */
function corpus({ withTwins = true, twinLinks = null } = {}) {
  const pages = [];
  for (let i = 0; i < 12; i += 1) {
    pages.push({
      path: `wiki/topic-${String(i).padStart(2, '0')}.md`,
      vector: backgroundVector(1000 + i * 7919),
      links: [`hub-${i % 3}`],
    });
  }
  if (withTwins) {
    const base = backgroundVector(424242);
    pages.push({ path: TWIN_A, vector: base, ...(twinLinks ? { links: twinLinks[0] } : {}) });
    pages.push({
      path: TWIN_B,
      vector: base.map((x, i) => x + (i % 5 === 0 ? 0.004 : -0.003)),
      ...(twinLinks ? { links: twinLinks[1] } : {}),
    });
  }
  return pages;
}

function hasPair(result, a, b) {
  return (result.pairs || []).some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
}

// ---------------------------------------------------------------------------

describe('twin-pages — the three announced behaviours', () => {
  // ---------------- 1 ----------------
  test('TWO QUASI-IDENTICAL PAGES ARE FLAGGED', () => {
    const result = findTwinPages({ pages: corpus() }, { limit: 20 });

    assert.equal(result.available, true, 'the corpus is comparable, so the check must run');
    assert.ok(hasPair(result, TWIN_A, TWIN_B), 'the near-identical pair must be reported');
    assert.equal(result.found, 1, 'and it must be the ONLY pair — a check that flags everything flags nothing');

    // The pair is reported ABOVE the threshold the corpus itself produced,
    // not above a number written into the test.
    const row = result.pairs[0];
    assert.ok(
      row.similarity >= result.threshold.similarity,
      `reported similarity ${row.similarity} must clear the derived threshold ${result.threshold.similarity}`,
    );
    assert.ok(row.similarity > 0.99, 'the twins are near-identical by construction');

    // The threshold is a fact about THIS corpus and travels with the answer.
    assert.equal(result.threshold.method, 'log-distance-robust-z');
    assert.equal(result.threshold.sensitivity, SENSITIVITY_K);
    assert.equal(result.threshold.pairsSampled, result.corpus.pairs);
    assert.ok(
      result.threshold.similarity > result.threshold.medianSimilarity,
      'a cut at or below the median would select half the vault',
    );
  });

  // ---------------- 2 ----------------
  test('TWO DISTINCT PAGES ARE NOT FLAGGED', () => {
    const result = findTwinPages({ pages: corpus() }, { limit: 50 });

    // The two background pages that are CLOSEST to each other — the hardest
    // negative in the corpus, not a randomly chosen easy one.
    const pages = corpus();
    const units = pages.map((p) => normalise(p.vector));
    let best = { s: -Infinity, a: '', b: '' };
    for (let i = 0; i < 12; i += 1) {
      for (let j = i + 1; j < 12; j += 1) {
        const s = dot(units[i], units[j]);
        if (s > best.s) best = { s, a: pages[i].path, b: pages[j].path };
      }
    }
    assert.ok(best.s > 0.8, `the hardest negative should be genuinely close (was ${best.s})`);
    assert.ok(
      !hasPair(result, best.a, best.b),
      `${best.a} and ${best.b} are distinct pages (cosine ${best.s.toFixed(4)}) and must NOT be reported`,
    );

    // Nothing but the twins, on the whole corpus.
    for (const row of result.pairs) {
      assert.ok(
        (row.a === TWIN_A && row.b === TWIN_B) || (row.a === TWIN_B && row.b === TWIN_A),
        `unexpected pair reported: ${row.a} | ${row.b} at ${row.similarity}`,
      );
    }
  });

  // ---------------- 3 ----------------
  test('UNAVAILABLE IS NOT ZERO — the two answers have DIFFERENT SHAPES', () => {
    // (a) Too small to derive anything: the question was NOT answered.
    const tooSmall = findTwinPages({ pages: corpus().slice(0, 3) }, {});
    assert.equal(tooSmall.available, false);
    assert.equal(tooSmall.reason, UNAVAILABLE_REASONS.CORPUS_TOO_SMALL);
    assert.equal(
      Object.prototype.hasOwnProperty.call(tooSmall, 'pairs'), false,
      'an unavailable answer must carry NO `pairs` key — an empty array would let a consumer '
      + 'reading `pairs.length` turn "I could not look" into "I looked and found none"',
    );
    assert.equal(Object.prototype.hasOwnProperty.call(tooSmall, 'found'), false);
    assert.match(tooSmall.detail, /NOT a finding/i, 'the prose must say so too, for a human reader');

    // (a-bis) The OTHER early return — fewer than two comparable pages — is a
    // SEPARATE branch from the one above (which comes out of `deriveThreshold`).
    // It was reachable and untested: a mutation that added `pairs: []` to it
    // alone left every other test green.
    const nothingToCompare = findTwinPages({ pages: corpus().slice(0, 1) }, {});
    assert.equal(nothingToCompare.available, false);
    assert.equal(nothingToCompare.reason, UNAVAILABLE_REASONS.CORPUS_TOO_SMALL);
    assert.equal(
      Object.prototype.hasOwnProperty.call(nothingToCompare, 'pairs'), false,
      'the <2-page branch must obey the same contract as every other unavailable answer',
    );
    assert.equal(Object.prototype.hasOwnProperty.call(nothingToCompare, 'found'), false);
    assert.equal(findTwinPages({ pages: [] }, {}).available, false);

    // Stated once, over EVERY way of being unavailable, so a new branch that
    // forgets the contract has to fail something.
    for (const unavailable of [
      tooSmall,
      nothingToCompare,
      findTwinPages({ pages: [] }, {}),
      findTwinPages({ pages: Array.from({ length: 12 }, (_, i) => ({ path: `wiki/x${i}.md`, vector: backgroundVector(5) })) }, {}),
    ]) {
      assert.equal(unavailable.available, false);
      assert.equal(Object.prototype.hasOwnProperty.call(unavailable, 'pairs'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(unavailable, 'found'), false);
    }

    // (b) Examined and nothing stood out: a REAL answer of zero.
    const clean = findTwinPages({ pages: corpus({ withTwins: false }) }, {});
    assert.equal(clean.available, true, 'a twin-free corpus is still a corpus that was examined');
    assert.equal(clean.found, 0);
    assert.deepEqual(clean.pairs, [], 'the zero answer DOES carry an empty pairs array');
    assert.equal(Object.prototype.hasOwnProperty.call(clean, 'pairs'), true);

    // The discriminator a consumer can rely on, stated as an invariant.
    assert.notEqual(
      Object.prototype.hasOwnProperty.call(tooSmall, 'pairs'),
      Object.prototype.hasOwnProperty.call(clean, 'pairs'),
      'the presence of `pairs` is the structural discriminator between the two answers',
    );
  });
});

describe('twin-pages — the threshold is DERIVED, never fixed', () => {
  test('two corpora with different spreads get different thresholds', () => {
    // Same twins, different background: the cut must move with the corpus.
    const tight = corpus();
    const loose = corpus().map((p, i) =>
      i < 12 ? { ...p, vector: backgroundVector(1000 + i * 7919, 16, 0.05) } : p);

    const a = findTwinPages({ pages: tight }, {});
    const b = findTwinPages({ pages: loose }, {});
    assert.ok(a.available && b.available);
    assert.notEqual(
      a.threshold.similarity, b.threshold.similarity,
      'a threshold that does not move between two differently-spread corpora is a hard-coded number',
    );
    assert.notEqual(a.threshold.medianSimilarity, b.threshold.medianSimilarity);
    // Both still find their twins — the derivation adapts, it does not drift.
    assert.ok(hasPair(a, TWIN_A, TWIN_B));
    assert.ok(hasPair(b, TWIN_A, TWIN_B));
  });

  test('sensitivity moves the cut monotonically', () => {
    const pages = corpus();
    const low = findTwinPages({ pages }, { sensitivity: 2 });
    const mid = findTwinPages({ pages }, { sensitivity: SENSITIVITY_K });
    const high = findTwinPages({ pages }, { sensitivity: 12 });
    assert.ok(low.threshold.similarity < mid.threshold.similarity);
    assert.ok(mid.threshold.similarity < high.threshold.similarity);
    assert.ok(low.found >= mid.found, 'a looser cut cannot report fewer pairs');
    assert.ok(mid.found >= high.found);
  });

  test('the derivation lives in LOG-DISTANCE space, because cosine is bounded', () => {
    // The reason the naive `median + k*MAD` on raw cosine was rejected: on 5 of
    // 6 real vaults it put the cut past 1.0 at k=4, where nothing can match.
    // Here the same corpus is checked to yield a cut that is INSIDE the domain
    // at a k where the naive form would not be.
    const sims = [];
    const pages = corpus();
    const units = pages.map((p) => normalise(p.vector));
    for (let i = 0; i < units.length; i += 1) {
      for (let j = i + 1; j < units.length; j += 1) sims.push(dot(units[i], units[j]));
    }
    const mean = sims.reduce((x, y) => x + y, 0) / sims.length;
    const sd = Math.sqrt(sims.reduce((x, y) => x + (y - mean) ** 2, 0) / sims.length);
    const naive = mean + 4 * sd;
    assert.ok(naive >= 1, `this corpus reproduces the failure: naive cut = ${naive.toFixed(3)} ≥ 1`);

    const derived = deriveThreshold(sims, { sensitivity: 4 });
    assert.equal(derived.ok, true);
    assert.ok(derived.similarity < 1, 'the log-distance derivation stays inside the cosine domain');
    assert.ok(derived.similarity > derived.medianSimilarity);
  });

  test('a sample too small for a median+MAD refuses instead of inventing a cut', () => {
    const few = Array.from({ length: MIN_PAIRS_FOR_THRESHOLD - 1 }, (_, i) => 0.5 + i / 1000);
    const r = deriveThreshold(few);
    assert.equal(r.ok, false);
    assert.equal(r.reason, UNAVAILABLE_REASONS.CORPUS_TOO_SMALL);
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'similarity'), false);

    const enough = Array.from({ length: MIN_PAIRS_FOR_THRESHOLD }, (_, i) => 0.5 + i / 1000);
    assert.equal(deriveThreshold(enough).ok, true, 'exactly the minimum must be accepted');
  });

  test('a corpus with no spread refuses rather than cut at its own median', () => {
    const flat = Array.from({ length: 60 }, () => 0.8);
    const r = deriveThreshold(flat);
    assert.equal(r.ok, false);
    assert.equal(r.reason, UNAVAILABLE_REASONS.NO_SPREAD);
    // …and the refusal survives the whole pipeline as an unavailable answer.
    const base = backgroundVector(7);
    const clones = Array.from({ length: 12 }, (_, i) => ({ path: `wiki/c${i}.md`, vector: base.slice() }));
    const res = findTwinPages({ pages: clones }, {});
    assert.equal(res.available, false);
    assert.equal(res.reason, UNAVAILABLE_REASONS.NO_SPREAD);
    assert.equal(Object.prototype.hasOwnProperty.call(res, 'pairs'), false);
  });

  test('THE MIN_DISTANCE CLAMP: a corpus half made of exact duplicates still yields a threshold', () => {
    // The clamp on `1 - cos` was the line answering "what happens at cos = 1",
    // and NO test killed its removal: replacing `Math.log(Math.max(MIN_DISTANCE,
    // 1 - s))` with `Math.log(1 - s)` left the whole suite green.
    //
    // It needs HALF the sample at cos = 1, not a handful: with a few duplicates
    // the median stays finite and the missing clamp is invisible. At half, the
    // median of ln(1-cos) becomes -Infinity and the MAD becomes NaN, so the
    // corpus stops being answerable at all.
    const duplicates = Array.from({ length: 25 }, () => 1);
    const ordinary = Array.from({ length: 25 }, (_, i) => 0.5 + i / 200);
    const r = deriveThreshold([...duplicates, ...ordinary]);

    assert.equal(r.ok, true, 'a corpus half made of duplicates is still answerable');
    assert.equal(Number.isFinite(r.logDistanceMedian), true, 'ln(0) must not reach the median');
    assert.equal(Number.isFinite(r.logDistanceMadSigma), true, 'and the MAD must not become NaN');
    assert.equal(Number.isFinite(r.similarity), true);
    assert.equal(r.similarity, 1, 'the honest cut here is 1: only exact duplicates qualify');

    // Float overshoot past 1 travels the same path — `1 - s` is NEGATIVE there,
    // which is outside ln's domain entirely, not merely at its edge.
    const over = deriveThreshold([
      ...Array.from({ length: 25 }, () => 1.0000000000000002),
      ...ordinary,
    ]);
    assert.equal(over.ok, true);
    assert.equal(Number.isFinite(over.similarity), true, 'ln of a negative must never reach the statistic');
  });

  test('identical vectors do not blow up the log transform', () => {
    // 1 - cos is 0 (or slightly negative through float overshoot) for identical
    // vectors; ln of that is -Infinity or NaN. The floor keeps it finite.
    const r = deriveThreshold([...Array.from({ length: 40 }, (_, i) => 0.4 + i / 100), 1, 1.0000000000000002]);
    assert.equal(r.ok, true);
    assert.ok(Number.isFinite(r.similarity), 'threshold must stay a finite number');
    assert.ok(Number.isFinite(r.logDistanceMedian) && Number.isFinite(r.logDistanceMadSigma));
  });
});

describe('twin-pages — the bound is available, reported, and never silent', () => {
  test('restrictTo removes pairs and SAYS how many', () => {
    // Twins in different folders sharing no link: precisely what the bound loses.
    const pages = corpus({ twinLinks: [['solo-a'], ['solo-b']] });
    const open = findTwinPages({ pages }, {});
    assert.ok(hasPair(open, TWIN_A, TWIN_B));
    assert.equal(open.restrictTo, 'none');
    assert.equal(open.removedByRestriction, 0, 'the count is reported even when it is zero');

    const bounded = findTwinPages({ pages }, { restrictTo: 'folder-or-links' });
    assert.equal(bounded.restrictTo, 'folder-or-links');
    assert.equal(bounded.found, 0, 'the bound discards the cross-folder, unlinked twins');
    assert.equal(
      bounded.removedByRestriction, 1,
      'and it must say so — a filter nobody can see is a filter nobody can question',
    );
    // Still AVAILABLE with an honest zero: the bound narrows the answer, it
    // does not make the check impossible.
    assert.equal(bounded.available, true);
    assert.deepEqual(bounded.pairs, []);
  });

  test('the threshold is derived over EVERY pair, not over the bounded subset', () => {
    const pages = corpus({ twinLinks: [['solo-a'], ['solo-b']] });
    const open = findTwinPages({ pages }, {});
    const bounded = findTwinPages({ pages }, { restrictTo: 'folder' });
    assert.equal(
      bounded.threshold.similarity, open.threshold.similarity,
      'the distribution describes the vault; the filter describes the question. If the filter moved '
      + 'the cut, the same vault would answer differently about the same pair depending on how it was asked',
    );
    assert.equal(bounded.threshold.pairsSampled, open.threshold.pairsSampled);
  });

  test('sensitivity and maxPages are REFUSED like restrictTo, never coerced', () => {
    // The module states "A MISUNDERSTOOD ARGUMENT IS REFUSED, NOT COERCED" and
    // then coerced these two. Measured before the fix: `sensitivity: -10` gave a
    // threshold of -3.42 (every pair matches); `-1e308` gave -Infinity, which
    // JSON.stringify writes as `null`, so the answer reached the client with NO
    // threshold at all; `"not a number"` fell back to k=5 in silence.
    for (const bad of [-10, -1e308, -0.001, 'not a number', NaN, Infinity, -Infinity, [], {}]) {
      assert.throws(
        () => findTwinPages({ pages: corpus() }, { sensitivity: bad }),
        (err) => {
          assert.equal(err.kind, 'validation');
          assert.match(err.message, /sensitivity must be a finite number/);
          return true;
        },
        `sensitivity ${JSON.stringify(bad)} was accepted`,
      );
    }
    // The domain that is accepted keeps the threshold inside the cosine range.
    for (const good of [0, 0.5, SENSITIVITY_K, 50]) {
      const r = findTwinPages({ pages: corpus() }, { sensitivity: good });
      assert.equal(r.available, true, `sensitivity ${good} should be in domain`);
      assert.ok(Number.isFinite(r.threshold.similarity), `sensitivity ${good} gave a non-finite threshold`);
      assert.ok(
        r.threshold.similarity >= -1 && r.threshold.similarity <= 1,
        `sensitivity ${good} put the threshold at ${r.threshold.similarity}, outside [-1, 1]`,
      );
      // …and it survives JSON, which is where -Infinity became null.
      assert.equal(typeof JSON.parse(JSON.stringify(r)).threshold.similarity, 'number');
    }

    for (const bad of [0, 1, -5, 2.5, 1e9, MAX_PAGES_CEILING + 1, Infinity, NaN, 'x', []]) {
      assert.throws(
        () => findTwinPages({ pages: corpus() }, { maxPages: bad }),
        (err) => {
          assert.equal(err.kind, 'validation', `maxPages ${JSON.stringify(bad)} threw an unclassified error`);
          assert.match(err.message, /maxPages must be an integer/);
          return true;
        },
        `maxPages ${JSON.stringify(bad)} was accepted`,
      );
    }
    assert.equal(findTwinPages({ pages: corpus() }, { maxPages: MAX_PAGES_CEILING }).available, true);
    // Absent still means "not asked for", for both.
    for (const key of ['sensitivity', 'maxPages']) {
      assert.equal(findTwinPages({ pages: corpus() }, { [key]: undefined }).available, true);
      assert.equal(findTwinPages({ pages: corpus() }, { [key]: null }).available, true);
    }
    assert.equal(findTwinPages({ pages: corpus() }, {}).threshold.sensitivity, SENSITIVITY_K);

    // THE EXPORTED PRIMITIVE IS GUARDED TOO. With the check only in
    // `findTwinPages`, a direct `deriveThreshold(sims, { sensitivity: -10 })`
    // still returned a threshold of -3.42 — outside the cosine domain — because
    // its own coercion accepted any finite number.
    const sims = Array.from({ length: 60 }, (_, i) => 0.4 + i / 200);
    for (const bad of [-10, -1e308, 'x', NaN, Infinity]) {
      assert.throws(
        () => deriveThreshold(sims, { sensitivity: bad }),
        (err) => {
          assert.equal(err.kind, 'validation');
          assert.match(err.message, /sensitivity must be a finite number/);
          return true;
        },
        `deriveThreshold accepted sensitivity ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(deriveThreshold(sims, {}).sensitivity, SENSITIVITY_K);
    assert.equal(deriveThreshold(sims, { sensitivity: 3 }).sensitivity, 3);

    // …AND `findTwinPages` refuses on its OWN account, before any work. The two
    // guards would otherwise mask each other: with only the downstream one, a
    // bad `sensitivity` is still refused eventually, so no ordinary assertion
    // can tell the two arrangements apart. This corpus can: one page never
    // reaches `deriveThreshold` at all — it returns `available: false` from the
    // <2-page branch — so a throw here can only come from the upstream guard.
    assert.throws(
      () => findTwinPages({ pages: corpus().slice(0, 1) }, { sensitivity: -10 }),
      (err) => {
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /sensitivity must be a finite number/);
        return true;
      },
      'a misunderstood argument must be refused even when the corpus is unanswerable — '
      + 'reporting "corpus too small" while silently dropping the argument is the same silence twice',
    );
    assert.equal(findTwinPages({ pages: corpus().slice(0, 1) }, {}).available, false);
  });

  test('MAX_PAGES_CEILING is pinned to the largest size ACTUALLY MEASURED', () => {
    // Not a style pin. The ceiling is a measured fact — 5000 pages ran to
    // completion in 17.8 s at 2.0 GB peak heap, and nothing above it has ever
    // been run. Raising it without re-measuring is precisely the extrapolation
    // that made the old "~1.6 s" comment wrong by 3.6x, so the VALUE is pinned
    // and not merely the fact that some ceiling exists.
    assert.equal(MAX_PAGES_CEILING, 5000, 'raise this only with a new measurement in the header table');
    assert.equal(MAX_PAGES, 3000, 'the default ceiling is the 5.8 s / 737 MB point of that table');
    assert.ok(MAX_PAGES <= MAX_PAGES_CEILING);
  });

  test('a ZERO-NORM vector is never counted as compared', () => {
    // `normalise` cannot scale a zero vector, so its cosine with EVERY page —
    // including a byte-identical copy of itself — is 0. Left in the corpus it
    // was counted as compared while being structurally unable to ever match.
    const zeros = [
      { path: 'wiki/zero-a.md', vector: new Array(16).fill(0) },
      { path: 'wiki/zero-b.md', vector: new Array(16).fill(0) },
    ];
    const withZeros = findTwinPages({ pages: [...corpus(), ...zeros] }, {});
    const without = findTwinPages({ pages: corpus() }, {});
    assert.equal(withZeros.corpus.zeroNormDropped, 2);
    assert.equal(
      withZeros.corpus.pages, without.corpus.pages,
      'a page that cannot participate must not inflate the compared-page count',
    );
    assert.equal(without.corpus.zeroNormDropped, 0, 'the counter is present even when it is zero');
    assert.ok(
      !withZeros.pairs.some((p) => p.a.includes('zero-') || p.b.includes('zero-')),
      'and the two identical zero vectors must not appear as a pair',
    );
  });

  test('an unrecognised restrictTo is REFUSED, never quietly ignored', () => {
    // Coercing to 'none' would hand back the UNBOUNDED answer to a caller who
    // asked for a bound and typed it wrong — silence about a misunderstood
    // argument, which is the same failure as silence about a filter.
    for (const bad of ['same-author', 'folders', '', 7, [], { }]) {
      assert.throws(
        () => findTwinPages({ pages: corpus() }, { restrictTo: bad }),
        (err) => {
          assert.equal(err.kind, 'validation');
          assert.match(err.message, /restrictTo must be one of/);
          return true;
        },
        `restrictTo: ${JSON.stringify(bad)} was accepted`,
      );
    }
    // Absent still means "not asked for".
    for (const ok of [undefined, null]) {
      assert.equal(findTwinPages({ pages: corpus() }, { restrictTo: ok }).restrictTo, 'none');
    }
  });
});

describe('twin-pages — evidence, determinism, refusals', () => {
  test('every row carries the evidence needed to dismiss it, and absence reads as UNKNOWN', () => {
    const withLinks = findTwinPages({ pages: corpus({ twinLinks: [['shared', 'x'], ['shared', 'y']] }) }, {});
    const row = withLinks.pairs[0];
    assert.equal(row.sameFolder, false, 'the fixture twins live in different folders');
    assert.equal(row.sameBasename, false);
    assert.equal(row.sharedLinks, 1);
    assert.equal(row.linked, false, 'neither twin links to the other');

    // No links supplied → null, NOT 0/false. Absence must never read as evidence.
    const noLinks = findTwinPages({ pages: corpus() }, {});
    assert.equal(noLinks.pairs[0].sharedLinks, null);
    assert.equal(noLinks.pairs[0].linked, null);
  });

  test('sameBasename catches the dominant false positive: a templated series', () => {
    const base = backgroundVector(99);
    const pages = [];
    for (let i = 0; i < 12; i += 1) {
      pages.push({ path: `wiki/misc/m${i}.md`, vector: backgroundVector(500 + i * 7919) });
    }
    pages.push({ path: 'wiki/CM1/Allemand.md', vector: base });
    pages.push({ path: 'wiki/CM2/Allemand.md', vector: base.map((x) => x + 0.002) });
    const r = findTwinPages({ pages }, {});
    assert.equal(r.found, 1);
    assert.equal(r.pairs[0].sameBasename, true, 'the reviewer must see the template pattern at a glance');
    assert.equal(r.pairs[0].sameFolder, false);
  });

  test('output does not depend on the order pages were enumerated', () => {
    const pages = corpus();
    const forward = findTwinPages({ pages }, { limit: 50 });
    const reversed = findTwinPages({ pages: [...pages].reverse() }, { limit: 50 });
    assert.deepEqual(JSON.parse(JSON.stringify(reversed)), JSON.parse(JSON.stringify(forward)));
  });

  test('rows obey the documented total order, ties included', () => {
    const pages = [];
    for (let i = 0; i < 12; i += 1) pages.push({ path: `wiki/b${i}.md`, vector: backgroundVector(300 + i * 7919) });
    // Three pages sharing ONE vector: all three pairs among them tie at cosine
    // 1 exactly, so the path tiebreak is the only thing that can order them.
    const clone = backgroundVector(11);
    for (const n of ['wiki/zz-twin.md', 'wiki/aa-twin.md', 'wiki/mm-twin.md']) {
      pages.push({ path: n, vector: clone.slice() });
    }
    const r = findTwinPages({ pages }, { limit: 50 });
    const tied = r.pairs.filter((p) => p.similarity === r.pairs[0].similarity);
    assert.ok(tied.length >= 3, `expected ≥3 exactly-tied rows, got ${tied.length}`);

    for (let i = 1; i < r.pairs.length; i += 1) {
      const prev = r.pairs[i - 1];
      const cur = r.pairs[i];
      assert.ok(prev.similarity >= cur.similarity, 'similarity must be non-increasing');
      if (prev.similarity === cur.similarity) {
        assert.ok(
          prev.a < cur.a || (prev.a === cur.a && prev.b <= cur.b),
          `tied rows must be path-ordered: ${prev.a}|${prev.b} came before ${cur.a}|${cur.b}`,
        );
      }
    }
  });

  test('limit truncates but never lies about how many were found', () => {
    const pages = [];
    for (let i = 0; i < 12; i += 1) pages.push({ path: `wiki/n${i}.md`, vector: backgroundVector(700 + i * 7919) });
    for (let g = 0; g < 4; g += 1) {
      const base = backgroundVector(9000 + g * 131);
      pages.push({ path: `wiki/t${g}-a.md`, vector: base });
      pages.push({ path: `wiki/t${g}-b.md`, vector: base.map((x) => x + 0.002) });
    }
    const r = findTwinPages({ pages }, { limit: 2 });
    assert.equal(r.pairs.length, 2);
    assert.ok(r.found >= 4, `found=${r.found} must count every pair above the threshold, not the page`);
    assert.equal(r.truncated, true);
  });

  test('too many pages REFUSES rather than silently comparing a subset', () => {
    const pages = Array.from({ length: 40 }, (_, i) => ({
      path: `wiki/p${i}.md`, vector: backgroundVector(2000 + i * 7919),
    }));
    assert.throws(
      () => findTwinPages({ pages }, { maxPages: 20 }),
      (err) => {
        assert.equal(err.kind, 'validation', 'an actionable refusal, not an unclassified failure');
        assert.match(err.message, /40 comparable pages/);
        assert.match(err.message, /folders|maxPages/, 'the refusal must say what to do about it');
        return true;
      },
    );
    // Under the ceiling it runs normally — the guard is a ceiling, not a mood.
    assert.equal(findTwinPages({ pages }, { maxPages: MAX_PAGES }).available, true);
  });

  test('mixed vector dimensionality refuses — a cosine across two spaces means nothing', () => {
    const pages = corpus();
    pages[3] = { ...pages[3], vector: pages[3].vector.slice(0, 8) };
    assert.throws(() => findTwinPages({ pages }, {}), /mixed dimensionality/);
  });

  test('NO INSTRUCTION VOCABULARY anywhere the reader sees — EN and FR', () => {
    // The earlier guard checked FIELD-NAME PREFIXES and one English phrase.
    // Neither would have caught a French `detail` reading "fusionner les deux
    // pages", nor a skill paragraph telling the reader to merge. The forbidden
    // set is now phrasal and bilingual, and it is applied to every surface a
    // reader actually meets: the shared note, the row fields, the refusal and
    // detail strings, and the skill's own prose.
    //
    // NEGATIONS ARE ALLOWED and are the point — "not a merge", "jamais une
    // fusion" must remain sayable — so the patterns match IMPERATIVE and
    // RECOMMENDATION shapes, never the bare noun.
    const FORBIDDEN = [
      /\bcandidates?\s+for\s+merg/i,
      /\bconsider\s+(a\s+|the\s+)?(partial\s+)?merg/i,
      /\bmerge\s+(the|these|those|them|both|one|either|page)\b/i,
      /\bshould\s+be\s+(merged|deleted|removed|replaced)\b/i,
      /\b(delete|remove|replace)\s+(the|one|either|both|these|those)\b/i,
      /\bfusionne(?:r|z|nt)?\b/i,
      /\bsupprime(?:r|z|nt)?\b/i,
      /\bremplace(?:r|z|nt)?\b/i,
      /\b(à|a)\s+fusionner\b/i,
    ];
    const scan = (text, where) => {
      for (const re of FORBIDDEN) {
        assert.doesNotMatch(String(text), re, `${where} reads as an instruction (matched ${re})`);
      }
    };

    // 1. The shared note, and the negation it MUST keep.
    scan(SIGNAL_NOT_ORDER, 'SIGNAL_NOT_ORDER');
    assert.match(SIGNAL_NOT_ORDER, /not a merge/i, 'the note must still SAY it is not a merge');

    // 2. Every string a real answer emits — rows, details, threshold prose.
    const answers = [
      findTwinPages({ pages: corpus() }, {}),
      findTwinPages({ pages: corpus({ withTwins: false }) }, {}),
      findTwinPages({ pages: corpus().slice(0, 3) }, {}),
      findTwinPages({ pages: corpus().slice(0, 1) }, {}),
    ];
    for (const answer of answers) {
      const walk = (node, path) => {
        if (typeof node === 'string') return scan(node, `answer${path}`);
        if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
        if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            scan(k, `field name ${path}.${k}`);
            assert.doesNotMatch(
              k, /^(merge|delete|fix|apply|action|recommend|shouldMerge|resolve|fusion|supprim)/i,
              `field "${k}" reads as an instruction`,
            );
            walk(v, `${path}.${k}`);
          }
        }
      };
      walk(answer, '');
    }

    // 3. The refusal messages, which are prose the reader meets too.
    for (const thrower of [
      () => findTwinPages({ pages: corpus() }, { restrictTo: 'nope' }),
      () => findTwinPages({ pages: corpus() }, { maxPages: 2 }),
    ]) {
      try { thrower(); assert.fail('expected a refusal'); } catch (err) { scan(err.message, 'refusal'); }
    }

    // 4. THE SKILL'S OWN PROSE — Check J and Check J-bis, which sit two
    //    paragraphs apart and must not contradict each other.
    const skill = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'skills', 'wiki-lint', 'SKILL.md'), 'utf8',
    );
    const section = (heading) => {
      const start = skill.indexOf(heading);
      assert.notEqual(start, -1, `ANCHOR-MISS: ${heading} is gone from the skill`);
      const next = skill.indexOf('\n#### ', start + heading.length);
      return skill.slice(start, next === -1 ? skill.length : next);
    };
    scan(section('#### Check J-bis (deep)'), 'SKILL.md Check J-bis');
    scan(section('#### Check J (deep)'), 'SKILL.md Check J');
    // …and Check J must still carry its ERROR severity: the WORDING changed,
    // the severity did not (that is a product decision outside C11).
    assert.match(section('#### Check J (deep)'), /ERROR `concept-overlap-strong`/);
  });

  test('every answer carries the signal-not-order note, in one wording', () => {
    for (const r of [
      findTwinPages({ pages: corpus() }, {}),
      findTwinPages({ pages: corpus({ withTwins: false }) }, {}),
      findTwinPages({ pages: corpus().slice(0, 3) }, {}),
    ]) {
      assert.equal(r.note, SIGNAL_NOT_ORDER);
    }
    // The note must not read as an instruction.
    assert.match(SIGNAL_NOT_ORDER, /not a merge/i);
    assert.doesNotMatch(SIGNAL_NOT_ORDER, /\bmerge (them|these|the pages)\b/i);
  });

  test('no field in a row names an action', () => {
    const row = findTwinPages({ pages: corpus() }, {}).pairs[0];
    for (const key of Object.keys(row)) {
      assert.doesNotMatch(
        key, /^(merge|delete|fix|apply|action|recommend|shouldMerge|resolve)/i,
        `field "${key}" reads as an instruction; C11 emits a signal, never an order`,
      );
    }
  });
});
