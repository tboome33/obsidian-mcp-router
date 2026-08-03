/**
 * boundary-score — C10. The tests §2.17 names ("on a fixture graph the heavily
 * linked thin page comes out top; the score is identical from one run to the
 * next") plus the ones that PIN A WRONG BEHAVIOUR: a stable score that ranks
 * arbitrarily would pass a determinism test and be useless.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreBoundaryPages,
  measureSubstanceWords,
  countProseWords,
  SUBSTANCE_UNIT_WORDS,
  STALENESS_HORIZON_DAYS,
  MAX_RECENCY_MULTIPLIER,
  SUBSTANCE_MEASURE,
  DEFAULT_EXEMPT_TYPES,
  MAX_LIMIT,
  _internals,
} from '../src/helpers/boundary-score.mjs';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function article(path, { words: w = 0, updated = '2026-01-01', type = 'reference' } = {}) {
  return {
    id: `article:${path}`,
    type: 'article',
    name: path.split('/').pop(),
    filePath: `${path}.md`,
    summary: '',
    tags: ['article'],
    complexity: 'simple',
    knowledgeMeta: {
      format: 'obsidian',
      wikilinks: [],
      frontmatter: { type, ...(updated === null ? {} : { updated }) },
      substance: { words: w, measure: SUBSTANCE_MEASURE },
    },
  };
}

function edge(from, to, type = 'related') {
  return { source: `article:${from}`, target: `article:${to}`, type, direction: 'forward', weight: 0.6 };
}

function graphOf(nodes, edges, analyzedAt = '2026-06-01T00:00:00.000Z') {
  return {
    version: '1.0.0',
    kind: 'knowledge',
    project: { name: 'fixture', languages: ['markdown'], frameworks: [], description: '', analyzedAt, gitCommitHash: '' },
    nodes,
    edges,
    layers: [],
    tour: [],
  };
}

/**
 * The canonical fixture. Same recency everywhere so the RANKING is decided by
 * links-versus-substance alone — recency gets its own tests below.
 *   crossroads : 5 inbound,   40 words  → the frontier page
 *   deep-page  : 5 inbound, 4000 words  → equally linked, richly written
 *   lonely-stub: 0 inbound,   40 words  → thin but nobody points at it
 *   filler-*   : the five linkers
 */
function standardFixture(overrides = {}) {
  const nodes = [
    article('wiki/crossroads', { words: 40, updated: '2026-06-01', ...overrides.crossroads }),
    article('wiki/deep-page', { words: 4000, updated: '2026-06-01', ...overrides.deep }),
    article('wiki/lonely-stub', { words: 40, updated: '2026-06-01', ...overrides.lonely }),
  ];
  const edges = [];
  for (let i = 1; i <= 5; i += 1) {
    nodes.push(article(`wiki/filler-${i}`, { words: 900, updated: '2026-06-01' }));
    edges.push(edge(`wiki/filler-${i}`, 'wiki/crossroads'));
    edges.push(edge(`wiki/filler-${i}`, 'wiki/deep-page'));
  }
  return graphOf(nodes, edges);
}

// ---------------------------------------------------------------------------

describe('boundary-score — the ranking is MEANINGFUL', () => {
  test('the heavily-linked thin page comes out top (the §2.17 test)', () => {
    const r = scoreBoundaryPages(standardFixture());
    assert.equal(r.pages[0].path, 'wiki/crossroads.md');
    assert.ok(
      r.pages[0].score > r.pages[1].score,
      `top score ${r.pages[0].score} must beat runner-up ${r.pages[1].score}`,
    );
  });

  test('equal inbound + more substance ⇒ strictly lower score', () => {
    const r = scoreBoundaryPages(standardFixture());
    const cross = r.pages.find((p) => p.path === 'wiki/crossroads.md');
    const deep = r.pages.find((p) => p.path === 'wiki/deep-page.md');
    assert.equal(cross.inbound, deep.inbound, 'fixture must give both the same inbound count');
    assert.ok(cross.substanceWords < deep.substanceWords);
    assert.ok(cross.score > deep.score, 'the thin one must outrank the thick one');
  });

  test('a thin page nobody links to is NOT a frontier page', () => {
    const r = scoreBoundaryPages(standardFixture());
    assert.equal(r.pages.find((p) => p.path === 'wiki/lonely-stub.md'), undefined);
    assert.ok(r.excluded.withoutInboundLinks >= 1);
  });

  test('more inbound at equal substance ⇒ strictly higher score', () => {
    const nodes = [article('wiki/a', { words: 100 }), article('wiki/b', { words: 100 })];
    const edges = [];
    for (let i = 1; i <= 4; i += 1) {
      nodes.push(article(`wiki/src-${i}`, { words: 500 }));
      edges.push(edge(`wiki/src-${i}`, 'wiki/a'));
    }
    edges.push(edge('wiki/src-1', 'wiki/b'));
    const r = scoreBoundaryPages(graphOf(nodes, edges));
    const a = r.pages.find((p) => p.path === 'wiki/a.md');
    const b = r.pages.find((p) => p.path === 'wiki/b.md');
    assert.equal(a.substanceWords, b.substanceWords);
    assert.ok(a.inbound > b.inbound);
    assert.ok(a.score > b.score);
  });

  test('linkPressure is inbound DAMPED by length — not "inbound per 100 words"', () => {
    // The shorthand is wrong and the difference is testable: the literal
    // reading of "4 inbound per 100 words" on a 100-word page is 4. The code
    // computes 4 / (1 + 100/100) = 2, because the `1 +` keeps an empty page
    // from dividing by zero. Pinning both ends stops the doc phrasing and the
    // implementation from drifting apart again.
    const mk = (words) => {
      const nodes = [article('wiki/target', { words })];
      const edges = [];
      for (let i = 1; i <= 4; i += 1) {
        nodes.push(article(`wiki/s${i}`, { words: 10 }));
        edges.push(edge(`wiki/s${i}`, 'wiki/target'));
      }
      return scoreBoundaryPages(graphOf(nodes, edges), { asOf: '2026-06-01' })
        .pages.find((p) => p.path === 'wiki/target.md');
    };
    assert.equal(mk(SUBSTANCE_UNIT_WORDS).linkPressure, 2, '100 words halves, not leaves unchanged');
    assert.equal(mk(0).linkPressure, 4, 'an empty page keeps its full inbound count');
    assert.equal(mk(3 * SUBSTANCE_UNIT_WORDS).linkPressure, 1, '300 words quarters');
  });
});

describe('boundary-score — the score is STABLE', () => {
  test('identical from one run to the next, byte for byte (the §2.17 test)', () => {
    const g = standardFixture();
    const a = JSON.stringify(scoreBoundaryPages(g));
    const b = JSON.stringify(scoreBoundaryPages(g));
    const c = JSON.stringify(scoreBoundaryPages(standardFixture()));
    assert.equal(a, b);
    assert.equal(a, c);
  });

  test('independent of the order nodes and edges were enumerated', () => {
    const g = standardFixture();
    const shuffled = graphOf([...g.nodes].reverse(), [...g.edges].reverse(), g.project.analyzedAt);
    assert.equal(JSON.stringify(scoreBoundaryPages(g)), JSON.stringify(scoreBoundaryPages(shuffled)));
  });

  test('PIN: order-independence covers the WHOLE response, not just the ranking', () => {
    // Regression. The first version sorted the pages correctly but built
    // `exempted.byType` by walking the nodes, so reversing the node array gave
    // {"redirect":..,"source":..} instead of {"source":..,"redirect":..} — the
    // same data, different JSON bytes. The fixture missed it because it only
    // ever had ONE exempt type present; the real vault (2 exempt types) caught
    // it. Two distinct exempt types are what make this test able to fail.
    const nodes = [
      article('wiki/red', { words: 20, type: 'redirect' }),
      article('wiki/src', { words: 20, type: 'source' }),
      article('wiki/ans', { words: 20, type: 'answer' }),
      article('wiki/keep', { words: 60 }),
      article('wiki/linker', { words: 900 }),
    ];
    const edges = ['wiki/red', 'wiki/src', 'wiki/ans', 'wiki/keep'].map((t) => edge('wiki/linker', t));
    const fwd = scoreBoundaryPages(graphOf(nodes, edges));
    const rev = scoreBoundaryPages(graphOf([...nodes].reverse(), [...edges].reverse()));
    assert.equal(fwd.exempted.total, 3, 'fixture must exempt more than one distinct type');
    assert.deepEqual(Object.keys(fwd.exempted.byType), ['answer', 'redirect', 'source']);
    assert.equal(JSON.stringify(fwd), JSON.stringify(rev));
  });

  test('PIN: order-independence survives COLLATION-EQUAL paths', () => {
    // The tiebreak used localeCompare, which is not a total order: it returns 0
    // for distinct strings — an accented name in NFC vs NFD (exactly what a
    // vault synced between macOS and Windows produces), a soft hyphen, a
    // zero-width space. When every key ties, the sort falls back to insertion
    // order and the whole determinism claim collapses. The old ASCII-only
    // fixture could not see this.
    for (const [a, b] of [
      ['wiki/café', 'wiki/café'],   // NFC vs NFD
      ['wiki/ab', 'wiki/a­b'],            // soft hyphen
      ['wiki/xy', 'wiki/x​y'],            // zero-width space
    ]) {
      assert.notEqual(a, b, 'fixture paths must be distinct strings');
      assert.equal(a.localeCompare(b), 0, 'fixture must actually collate equal, else it proves nothing');
      const nodes = [article(a, { words: 100 }), article(b, { words: 100 }), article('wiki/linker', { words: 500 })];
      const edges = [edge('wiki/linker', a), edge('wiki/linker', b)];
      const fwd = scoreBoundaryPages(graphOf(nodes, edges));
      const rev = scoreBoundaryPages(graphOf([...nodes].reverse(), [...edges].reverse()));
      assert.equal(fwd.pages[0].score, fwd.pages[1].score, 'fixture must produce a genuine score tie');
      assert.deepEqual(
        fwd.pages.map((p) => p.path),
        rev.pages.map((p) => p.path),
        `enumeration order leaked through for ${JSON.stringify([a, b])}`,
      );
    }
  });

  test('ties break on path, so equal scores never reorder between runs', () => {
    // Two identical pages, each with one inbound link: same score exactly.
    const nodes = [
      article('wiki/zzz', { words: 100 }),
      article('wiki/aaa', { words: 100 }),
      article('wiki/linker', { words: 500 }),
    ];
    const edges = [edge('wiki/linker', 'wiki/zzz'), edge('wiki/linker', 'wiki/aaa')];
    const fwd = scoreBoundaryPages(graphOf(nodes, edges));
    const rev = scoreBoundaryPages(graphOf([...nodes].reverse(), [...edges].reverse()));
    assert.equal(fwd.pages[0].score, fwd.pages[1].score, 'fixture must produce a genuine tie');
    assert.equal(fwd.pages[0].path, 'wiki/aaa.md');
    assert.deepEqual(fwd.pages.map((p) => p.path), rev.pages.map((p) => p.path));
  });

  test('no clock: recency is measured against the graph\'s own build stamp', () => {
    const r = scoreBoundaryPages(standardFixture());
    assert.equal(r.asOfSource, 'graph-analyzedAt');
    assert.equal(r.asOf, '2026-06-01');
  });
});

describe('boundary-score — recency is a NUDGE, never a second ranking', () => {
  test('staleness multiplies from ×1 (same day) to ×2 (a year or more)', () => {
    const mk = (updated) => {
      const nodes = [article('wiki/t', { words: 100, updated }), article('wiki/s', { words: 500 })];
      return scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/t')], '2026-06-01T00:00:00.000Z'))
        .pages.find((p) => p.path === 'wiki/t.md');
    };
    assert.equal(mk('2026-06-01').recencyMultiplier, 1);
    assert.equal(mk('2025-06-01').recencyMultiplier, MAX_RECENCY_MULTIPLIER); // 365 days
    assert.equal(mk('2015-06-01').recencyMultiplier, MAX_RECENCY_MULTIPLIER); // saturates
    assert.ok(mk('2026-03-01').recencyMultiplier > 1);
    assert.ok(mk('2026-03-01').recencyMultiplier < MAX_RECENCY_MULTIPLIER);
  });

  test('PIN: staleness can never more than double a score', () => {
    // A page whose link pressure is 2.5× another's must stay ahead of it no
    // matter how stale the other is. This is the property that keeps recency
    // from becoming a hidden second ranking.
    const nodes = [
      article('wiki/pressured', { words: 100, updated: '2026-06-01' }), // fresh, high pressure
      article('wiki/ancient', { words: 400, updated: '2000-01-01' }),   // maximally stale
    ];
    const edges = [];
    for (let i = 1; i <= 5; i += 1) {
      nodes.push(article(`wiki/s${i}`, { words: 500 }));
      edges.push(edge(`wiki/s${i}`, 'wiki/pressured'));
      edges.push(edge(`wiki/s${i}`, 'wiki/ancient'));
    }
    const r = scoreBoundaryPages(graphOf(nodes, edges));
    const p = r.pages.find((x) => x.path === 'wiki/pressured.md');
    const a = r.pages.find((x) => x.path === 'wiki/ancient.md');
    assert.ok(p.linkPressure / a.linkPressure > MAX_RECENCY_MULTIPLIER,
      'fixture must set the pressure gap beyond what staleness can bridge');
    assert.equal(a.recencyMultiplier, MAX_RECENCY_MULTIPLIER);
    assert.ok(p.score > a.score, 'a maximally stale page must NOT overtake across a >2× pressure gap');
  });

  test('PIN: an unknown `updated` is treated as unknown, never as ancient', () => {
    const nodes = [
      article('wiki/nodate', { words: 100, updated: null }),
      article('wiki/dated', { words: 100, updated: '2026-06-01' }),
      article('wiki/s', { words: 500 }),
    ];
    const edges = [edge('wiki/s', 'wiki/nodate'), edge('wiki/s', 'wiki/dated')];
    const r = scoreBoundaryPages(graphOf(nodes, edges));
    const nd = r.pages.find((p) => p.path === 'wiki/nodate.md');
    assert.equal(nd.ageDays, null);
    assert.equal(nd.recencyMultiplier, 1, 'no date must not be inflated into "a year stale"');
    assert.equal(r.withoutRecency, 1);
  });

  test('a date in the future clamps to age 0 rather than going negative', () => {
    const nodes = [article('wiki/t', { words: 100, updated: '2030-01-01' }), article('wiki/s', { words: 500 })];
    const r = scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/t')]));
    const t = r.pages.find((p) => p.path === 'wiki/t.md');
    assert.equal(t.ageDays, 0);
    assert.equal(t.recencyMultiplier, 1);
  });

  test('asOf overrides the graph stamp and is validated', () => {
    const r = scoreBoundaryPages(standardFixture(), { asOf: '2026-12-01' });
    assert.equal(r.asOfSource, 'caller');
    assert.equal(r.asOf, '2026-12-01');
    assert.ok(r.pages[0].ageDays > 0);
    assert.throws(() => scoreBoundaryPages(standardFixture(), { asOf: 'last tuesday' }), /YYYY-MM-DD/);
  });

  test('a well-formed but non-existent date is rejected, not rolled over', () => {
    assert.equal(_internals.toEpochDay('2026-02-31'), null);
    assert.equal(_internals.toEpochDay('2026-13-01'), null);
    assert.equal(_internals.toEpochDay('not a date'), null);
    assert.equal(_internals.toEpochDay(undefined), null);
    assert.ok(Number.isFinite(_internals.toEpochDay('2026-02-28')));
    assert.ok(Number.isFinite(_internals.toEpochDay(new Date('2026-02-28T12:00:00Z'))));
    assert.ok(Number.isFinite(_internals.toEpochDay('2026-06-01T09:00:00.000Z')));
  });

  test('PIN: a TYPO\'d date reads as UNKNOWN, never as ancient', () => {
    // The date regex had no terminator, so `2026-08-0399` (four digits in the
    // day) silently parsed as 2026-08-03 and `2026-08-03banana` was accepted
    // as a valid `asOf`. A value nobody can parse must damp to ×1, not amplify.
    for (const bad of ['2026-08-0399', '2026-08-03banana', '2026-08-03/07', '2026-8-3', 'yesterday']) {
      assert.equal(_internals.toEpochDay(bad), null, `${bad} must not parse`);
      const nodes = [article('wiki/a', { words: 100, updated: bad }), article('wiki/s', { words: 500 })];
      const p = scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/a')]))
        .pages.find((x) => x.path === 'wiki/a.md');
      assert.equal(p.ageDays, null, `${bad} must yield unknown age`);
      assert.equal(p.recencyMultiplier, 1, `${bad} must not amplify the score`);
    }
    // ...and the same strictness applies to a caller-supplied asOf.
    assert.throws(() => scoreBoundaryPages(standardFixture(), { asOf: '2026-08-03banana' }), /YYYY-MM-DD/);
  });

  test('a date with a human annotation after it is HONOURED, not discarded', () => {
    // Three pages in the real vault carry exactly this shape. Refusing them
    // would trade a false "ancient" for a false "unknown" — losing a date that
    // is plainly there. The separator is what distinguishes annotation from typo.
    const annotated = [
      '2026-05-25 (v0.14.7 — Phase E.2 + Phase D.2 hardening bundlés end-to-end)',
      '2026-05-30 (généralisé à 10 vaults ; E2E prouvé 2026-05-27)',
      '2000-01-01 definitely-not-iso',
    ];
    for (const value of annotated) {
      assert.equal(
        _internals.toEpochDay(value),
        _internals.toEpochDay(value.slice(0, 10)),
        `${value} must read as its date part`,
      );
    }
    const nodes = [article('wiki/a', { words: 100, updated: annotated[0] }), article('wiki/s', { words: 500 })];
    const p = scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/a')]))
      .pages.find((x) => x.path === 'wiki/a.md');
    assert.ok(Number.isInteger(p.ageDays) && p.ageDays > 0, 'the annotated date must still produce an age');
  });

  test('PIN: a non-existent calendar date is refused WITH a time suffix too', () => {
    // Round-2 regression. Round 1 added an ISO-timestamp branch that called
    // Date.parse directly, without the calendar round-trip the date-only branch
    // has — so `2026-02-29` was refused while `2026-02-29T00:00:00Z` sailed
    // through as 1 March and earned a real staleness score. The typo guard has
    // to hold whether or not somebody appended a time.
    for (const bad of ['2026-02-29', '2026-02-30', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10']) {
      assert.equal(_internals.toEpochDay(bad), null, `${bad} must be refused`);
      assert.equal(_internals.toEpochDay(`${bad}T00:00:00Z`), null, `${bad}T00:00:00Z must be refused too`);
      assert.equal(_internals.toEpochDay(`${bad}T12:34:56+02:00`), null, `${bad} with an offset must be refused too`);
    }
    // ...and a real leap day still parses, both ways.
    assert.ok(Number.isFinite(_internals.toEpochDay('2024-02-29')));
    assert.ok(Number.isFinite(_internals.toEpochDay('2024-02-29T00:00:00Z')));
  });

  test('PIN: `asOf` names the day actually USED, never the raw input', () => {
    // With an offset crossing midnight the two differ: 23:30 on the 1st at
    // -02:00 is the 2nd in UTC. Echoing the input made the response name one
    // date while measuring every age against another.
    const nodes = [article('wiki/t', { words: 100, updated: '2026-01-01' }), article('wiki/s', { words: 500 })];
    const g = graphOf(nodes, [edge('wiki/s', 'wiki/t')], '2026-01-01T23:30:00-02:00');
    const r = scoreBoundaryPages(g);
    assert.equal(r.asOf, '2026-01-02', 'asOf must be the UTC day the ages were measured against');
    assert.equal(r.pages[0].ageDays, 1, 'and the age must agree with it');
  });

  test('PIN: a caller `asOf` gets NO annotation latitude — its contract is YYYY-MM-DD', () => {
    // Tolerating a trailing note is a concession to pages a human wrote; an API
    // argument documented as YYYY-MM-DD gets none, or the tool would accept
    // — and echo back — a date that does not exist.
    for (const bad of ['2026-08-03 (after the release)', '2026-02-30', '2026-02-30T00:00:00Z', '2026-08-03banana']) {
      assert.throws(() => scoreBoundaryPages(standardFixture(), { asOf: bad }), /YYYY-MM-DD/, bad);
    }
    assert.equal(scoreBoundaryPages(standardFixture(), { asOf: '2026-08-03' }).asOf, '2026-08-03');
  });

  test('a timestamp string and the Date built from it agree on the day', () => {
    // Both reduce to the same UTC day, so an offset that crosses midnight
    // cannot make the two entry points disagree.
    for (const iso of ['2026-01-01T23:30:00-02:00', '2026-06-15T00:30:00+05:00', '2026-06-15T12:00:00Z']) {
      assert.equal(_internals.toEpochDay(iso), _internals.toEpochDay(new Date(iso)), iso);
    }
  });
});

describe('boundary-score — exemptions, and never silently', () => {
  test('PIN: pages thin BY DESIGN are held out, and the count is reported', () => {
    // Without exemptions this redirect stub would top the ranking — measured on
    // the real vault, 13 of the top 20 were exactly this.
    const nodes = [
      article('wiki/_migrated/moved', { words: 89, updated: '2026-06-01', type: 'redirect' }),
      article('wiki/real', { words: 800, updated: '2026-06-01' }),
    ];
    const edges = [];
    for (let i = 1; i <= 7; i += 1) {
      nodes.push(article(`wiki/s${i}`, { words: 500 }));
      edges.push(edge(`wiki/s${i}`, 'wiki/_migrated/moved'));
      edges.push(edge(`wiki/s${i}`, 'wiki/real'));
    }
    const r = scoreBoundaryPages(graphOf(nodes, edges));
    assert.equal(r.pages.find((p) => p.type === 'redirect'), undefined, 'a redirect must never be proposed');
    assert.equal(r.exempted.total, 1);
    assert.deepEqual(r.exempted.byType, { redirect: 1 });

    // ...and with exemptions off it DOES top the ranking — which is what proves
    // the exemption is doing the work, not the formula.
    const open = scoreBoundaryPages(graphOf(nodes, edges), { exemptTypes: [] });
    assert.equal(open.pages[0].path, 'wiki/_migrated/moved.md');
    assert.equal(open.exempted.total, 0);
  });

  test('the default exemptions mirror wiki-lint Check A (source, answer) plus redirect', () => {
    assert.deepEqual([...DEFAULT_EXEMPT_TYPES], ['redirect', 'source', 'answer']);
    const nodes = [
      article('wiki/a', { words: 20, type: 'source' }),
      article('wiki/b', { words: 20, type: 'answer' }),
      article('wiki/c', { words: 20, type: 'redirect' }),
      article('wiki/s', { words: 500 }),
    ];
    const edges = [edge('wiki/s', 'wiki/a'), edge('wiki/s', 'wiki/b'), edge('wiki/s', 'wiki/c')];
    const r = scoreBoundaryPages(graphOf(nodes, edges));
    assert.equal(r.pages.length, 0);
    assert.equal(r.exempted.total, 3);
  });

  test('exemption matching is case-insensitive and trims', () => {
    const nodes = [article('wiki/a', { words: 20, type: '  REDIRECT ' }), article('wiki/s', { words: 500 })];
    const r = scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/a')]));
    assert.equal(r.exempted.total, 1);
  });

  test('a page with no `type:` at all is scored, not exempted', () => {
    const a = article('wiki/a', { words: 20 });
    delete a.knowledgeMeta.frontmatter.type;
    const r = scoreBoundaryPages(graphOf([a, article('wiki/s', { words: 500 })], [edge('wiki/s', 'wiki/a')]));
    assert.equal(r.pages.length, 1);
    assert.equal(r.pages[0].type, null);
  });
});

describe('boundary-score — refuses rather than answering confidently wrong', () => {
  test('PIN: a graph with no substance measurements is REFUSED, not scored as all-empty', () => {
    // The pre-C10 graph shape. Scoring it would rank the vault by raw inbound
    // links while looking like it had measured thinness.
    const nodes = [article('wiki/a', { words: 500 }), article('wiki/s', { words: 500 })];
    for (const n of nodes) delete n.knowledgeMeta.substance;
    assert.throws(
      () => scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/a')])),
      /no substance measurements[\s\S]*build_wiki_graph/,
    );
  });

  test('a graph where only SOME nodes lack substance excludes them and says so', () => {
    const a = article('wiki/a', { words: 100 });
    const b = article('wiki/b', { words: 100 });
    delete b.knowledgeMeta.substance;
    const r = scoreBoundaryPages(graphOf([a, b, article('wiki/s', { words: 500 })],
      [edge('wiki/s', 'wiki/a'), edge('wiki/s', 'wiki/b')]));
    assert.equal(r.pages.length, 1);
    assert.equal(r.pages[0].path, 'wiki/a.md');
    assert.equal(r.excluded.withoutSubstance, 1);
  });

  test('a malformed substance value counts as absent, not as zero words', () => {
    const M = SUBSTANCE_MEASURE;
    for (const bad of [
      { words: 'many', measure: M }, { words: -1, measure: M }, { words: NaN, measure: M },
      { words: Infinity, measure: M },
      // PIN: a count in an UNKNOWN UNIT is not a count. Without the measure
      // check these were accepted and scored as empty pages, and a whole graph
      // of them slipped past the "no measurements at all" refusal below —
      // producing a confident ranking by raw inbound links that looked as if
      // thinness had been measured.
      { words: 0 }, { words: 120 }, { words: 0, measure: 'bytes-v1' }, { words: 42, measure: 'chars-v2' },
      // PIN: 0.5 words is not a small page, it is a corrupt record.
      { words: 0.5, measure: M }, { words: 12.75, measure: M },
      'nope', null, [], 42,
    ]) {
      const n = article('wiki/a', { words: 100 });
      n.knowledgeMeta.substance = bad;
      const r = scoreBoundaryPages(graphOf([n, article('wiki/ok', { words: 100 }), article('wiki/s', { words: 9 })],
        [edge('wiki/s', 'wiki/a'), edge('wiki/s', 'wiki/ok')]));
      assert.equal(r.excluded.withoutSubstance, 1, `substance ${JSON.stringify(bad)} must read as absent`);
      assert.equal(r.pages.length, 1, `${JSON.stringify(bad)} must not be ranked`);
    }
  });

  test('PIN: a graph measured in a DIFFERENT unit is refused, not scored as all-empty', () => {
    const nodes = [article('wiki/a', { words: 500 }), article('wiki/s', { words: 500 })];
    for (const n of nodes) n.knowledgeMeta.substance = { words: 0, measure: 'bytes-v1' };
    assert.throws(
      () => scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/a')])),
      /no substance measurements/,
    );
  });

  test('PIN: an invalid graph is refused rather than ranked from corrupt data', () => {
    // Duplicate article ids resolved last-wins in the node map, so REVERSING
    // the node array changed which page was scored (999 words vs 1) — an
    // order-dependence no downstream sorting can repair. An edge from a
    // non-existent node silently cost its target an inbound link. validateGraph
    // already rejects both; reusing it beats a weaker bespoke check.
    const dup = [article('wiki/dup', { words: 999 }), article('wiki/dup', { words: 1 }), article('wiki/s', { words: 50 })];
    assert.throws(() => scoreBoundaryPages(graphOf(dup, [edge('wiki/s', 'wiki/dup')])), /invalid[\s\S]*duplicated/);

    const dangling = [article('wiki/a', { words: 100 }), article('wiki/s', { words: 50 })];
    assert.throws(
      () => scoreBoundaryPages(graphOf(dangling, [edge('wiki/s', 'wiki/a'), edge('wiki/ghost', 'wiki/a')])),
      /invalid[\s\S]*does not reference an existing node/,
    );
  });

  test('an empty graph is an empty answer, not a crash', () => {
    const r = scoreBoundaryPages(graphOf([], []));
    assert.deepEqual(r.pages, []);
    assert.equal(r.articles, 0);
  });

  test('a non-graph argument is refused', () => {
    for (const bad of [null, undefined, 'graph', 42, {}, { nodes: [] }]) {
      assert.throws(() => scoreBoundaryPages(bad), TypeError);
    }
  });
});

describe('boundary-score — inbound counting', () => {
  test('only article→article `related` edges count', () => {
    const nodes = [article('wiki/t', { words: 100 }), article('wiki/s', { words: 500 })];
    const g = graphOf(nodes, [
      edge('wiki/s', 'wiki/t', 'related'),
      // a cites edge to a source node, and a categorized_under to a topic:
      { source: 'article:wiki/s', target: 'source:https://x.test/a', type: 'cites', direction: 'forward', weight: 0.7 },
      { source: 'article:wiki/t', target: 'topic:stuff', type: 'categorized_under', direction: 'forward', weight: 0.5 },
    ]);
    g.nodes.push({ id: 'source:https://x.test/a', type: 'source', name: 'a', summary: '', tags: ['source'], complexity: 'simple' });
    g.nodes.push({ id: 'topic:stuff', type: 'topic', name: 'Stuff', summary: '', tags: ['topic'], complexity: 'simple' });
    const r = scoreBoundaryPages(g);
    assert.equal(r.pages.find((p) => p.path === 'wiki/t.md').inbound, 1);
  });

  test('a self-link cannot inflate an inbound count — such a graph is refused', () => {
    // The builder never emits a self-edge (`addEdge` drops source === target)
    // and `validateGraph` rejects one, so a persisted graph containing one is
    // corrupt rather than merely odd — it is refused, not quietly tolerated.
    const nodes = [article('wiki/t', { words: 100 }), article('wiki/s', { words: 500 })];
    const selfEdge = { source: 'article:wiki/t', target: 'article:wiki/t', type: 'related', direction: 'forward', weight: 0.6 };
    assert.throws(
      () => scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/t'), selfEdge])),
      /invalid[\s\S]*self-edge/,
    );
    // The scorer also drops self-edges internally, so the guarantee does not
    // rest on validation alone (defence in depth for a direct caller).
    const counted = scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/t')]));
    assert.equal(counted.pages.find((p) => p.path === 'wiki/t.md').inbound, 1);
  });

  test('minInbound filters, and the count filtered out is reported', () => {
    const nodes = [article('wiki/one', { words: 50 }), article('wiki/s1', { words: 500 }), article('wiki/s2', { words: 500 })];
    const edges = [edge('wiki/s1', 'wiki/one')];
    const lax = scoreBoundaryPages(graphOf(nodes, edges), { minInbound: 1 });
    assert.equal(lax.pages.length, 1);
    const strict = scoreBoundaryPages(graphOf(nodes, edges), { minInbound: 3 });
    assert.equal(strict.pages.length, 0);
    assert.equal(strict.excluded.minInbound, 3);
    assert.ok(strict.excluded.withoutInboundLinks >= 1);
  });

  test('PIN: minInbound is clamped to 1, and the response echoes what was APPLIED', () => {
    // `minInbound: 0` used to be accepted, silently behave as 1, and echo back
    // `0` — a report that described a filter nobody ran. A page with no inbound
    // link is not a crossroads (that is Check A's orphan question), so the
    // floor stays; what changed is that the answer stops misdescribing it.
    const nodes = [article('wiki/lonely', { words: 50 }), article('wiki/s', { words: 500 })];
    const r = scoreBoundaryPages(graphOf(nodes, []), { minInbound: 0 });
    assert.equal(r.excluded.minInbound, 1, 'must echo the clamped value, not the requested one');
    assert.equal(r.pages.length, 0);
    assert.equal(scoreBoundaryPages(graphOf(nodes, []), { minInbound: -5 }).excluded.minInbound, 1);
  });
});

describe('boundary-score — bounds and reporting', () => {
  test('limit caps the list and truncation is announced', () => {
    const nodes = []; const edges = [];
    for (let i = 0; i < 20; i += 1) {
      nodes.push(article(`wiki/p${String(i).padStart(2, '0')}`, { words: 50 + i }));
      nodes.push(article(`wiki/l${i}`, { words: 500 }));
      edges.push(edge(`wiki/l${i}`, `wiki/p${String(i).padStart(2, '0')}`));
    }
    const g = graphOf(nodes, edges);
    const r = scoreBoundaryPages(g, { limit: 5 });
    assert.equal(r.pages.length, 5);
    assert.equal(r.truncated, true);
    assert.equal(r.ranked, 20);
    const all = scoreBoundaryPages(g, { limit: 999 });
    assert.equal(all.pages.length, 20);
    assert.equal(all.truncated, false);
    assert.ok(MAX_LIMIT >= 100);
  });

  test('every result carries the formula and its constants', () => {
    const r = scoreBoundaryPages(standardFixture());
    assert.equal(r.measure.substance, SUBSTANCE_MEASURE);
    assert.equal(r.measure.unitWords, SUBSTANCE_UNIT_WORDS);
    assert.equal(r.measure.stalenessHorizonDays, STALENESS_HORIZON_DAYS);
    assert.equal(r.measure.maxRecencyMultiplier, MAX_RECENCY_MULTIPLIER);
    assert.match(r.measure.formula, /inbound/);
  });

  test('PIN: scores keep FULL precision — rounding them inverted the ranking', () => {
    // Regression. Scores were rounded to 4 decimals "so the JSON is readable",
    // and the previous version of this test asserted exactly that. It was
    // pinning a bug: two pages one word apart (2000 vs 2001) collapsed to the
    // same 0.0476, the path tiebreak then ran, and the THICKER page came out
    // first — an inversion of the only thing this module does. Rounding also
    // made the stated ×2 ceiling false in the reported numbers. IEEE-754 and JS
    // number serialisation are both fully specified, so full precision is
    // exactly as byte-stable; formatting belongs to the caller.
    const nodes = [
      article('wiki/zzz-thinner', { words: 2000 }),
      article('wiki/aaa-thicker', { words: 2001 }),
      article('wiki/linker', { words: 50 }),
    ];
    const edges = [edge('wiki/linker', 'wiki/zzz-thinner'), edge('wiki/linker', 'wiki/aaa-thicker')];
    const r = scoreBoundaryPages(graphOf(nodes, edges));
    // "at realistic page sizes" is not hedging: at word counts near
    // Number.MAX_SAFE_INTEGER two adjacent counts do collapse to the same
    // IEEE-754 double. That is a float limit, not a policy, and no markdown
    // page can reach it — but the claim is bounded to what is actually true.
    assert.notEqual(r.pages[0].score, r.pages[1].score,
      'a one-word difference must survive into the score at realistic page sizes');
    assert.equal(r.pages[0].path, 'wiki/zzz-thinner.md',
      'the THINNER page must rank first even when its path sorts last');
    for (const p of r.pages) assert.ok(Number.isFinite(p.score) && p.score > 0);
    // Serialisation is repeatable, which is all determinism actually needs.
    assert.equal(JSON.stringify(r.pages), JSON.stringify(scoreBoundaryPages(graphOf(nodes, edges)).pages));
  });

  test('PIN: the ×2 ceiling holds for the SAME page, in the reported numbers', () => {
    // The earlier version compared two DIFFERENT pages and only checked their
    // rank, so it could not see that rounding made `score` exceed 2 ×
    // `linkPressure` in the emitted JSON (linkPressure rounding to 0 beside a
    // score of 0.0001). Same page, both fields, exact arithmetic.
    for (const updated of ['2026-06-01', '2026-03-01', '2025-06-01', '2000-01-01']) {
      const nodes = [article('wiki/t', { words: 137, updated }), article('wiki/s', { words: 500 })];
      const p = scoreBoundaryPages(graphOf(nodes, [edge('wiki/s', 'wiki/t')]))
        .pages.find((x) => x.path === 'wiki/t.md');
      assert.ok(p.recencyMultiplier >= 1 && p.recencyMultiplier <= MAX_RECENCY_MULTIPLIER,
        `multiplier ${p.recencyMultiplier} out of [1,2] for ${updated}`);
      assert.equal(p.score, p.linkPressure * p.recencyMultiplier, 'score must be exactly the product');
      assert.ok(p.score <= p.linkPressure * MAX_RECENCY_MULTIPLIER + Number.EPSILON,
        `score ${p.score} exceeds 2× linkPressure ${p.linkPressure} for ${updated}`);
    }
  });
});

describe('measureSubstanceWords — the deliberately simple measure', () => {
  test('counts body words and ignores frontmatter', () => {
    const content = `---\ntype: reference\ndescription: "a b c d e f g"\n---\n\n${words(10)}`;
    assert.equal(measureSubstanceWords(content), 10);
  });

  test('a wikilink contributes the words a reader sees, not its brackets', () => {
    assert.equal(countProseWords('see [[some-page]] now'), 3);
    assert.equal(countProseWords('see [[some-page|the nice page]] now'), 5);
  });

  test('KNOWN LIMIT, pinned: an embed counts its TARGET, not what it renders', () => {
    // `![[chart.png|300]]` counts "chart.png|300" → 1 token, and an embedded
    // NOTE contributes 1 word rather than the note's actual content. This is
    // the chosen bias — over-count markup, under-count nothing that would
    // create a false positive — but it is a real limit, not a nicety, and it
    // is pinned here so that changing it is a deliberate decision rather than
    // an accident that looks like a regression.
    assert.equal(countProseWords('![[embedded-thing]]'), 1);
    assert.equal(countProseWords('![[chart.png|300]]'), 1);
  });

  test('a pathological run of brackets stays fast (no quadratic backtracking)', () => {
    // `'[['.repeat(40000)` measured at 3.8 SECONDS before the character classes
    // excluded `[`, and this runs inside the graph builder on every page — one
    // junk note could stall every build.
    const started = process.hrtime.bigint();
    assert.equal(countProseWords('[['.repeat(40000)), 1);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 250, `took ${ms.toFixed(0)}ms — the quadratic scan is back`);
  });

  test('empty and non-string inputs are 0, never NaN', () => {
    for (const v of ['', null, undefined, 42, {}, []]) assert.equal(measureSubstanceWords(v), 0);
    assert.equal(countProseWords(''), 0);
    assert.equal(measureSubstanceWords('---\ntype: x\n---\n'), 0);
  });

  test('the two entry points agree — one measure, two doors', () => {
    const body = `${words(37)}\n\n## Heading\n\n- bullet [[a|alias]] item`;
    assert.equal(measureSubstanceWords(`---\ntype: x\n---\n\n${body}`), countProseWords(body));
  });

  test('KNOWN LIMIT, pinned: the measure cannot tell prose from boilerplate', () => {
    // Both are 6 words. Only the page's declared `type:` separates them, which
    // is exactly why the exemption policy carries more weight than the formula.
    assert.equal(countProseWords('this page has moved to elsewhere'), 6);
    assert.equal(countProseWords('a monad is a monoid endofunctor'), 6);
  });
});
