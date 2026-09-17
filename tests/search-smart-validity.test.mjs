/**
 * `search_smart` and the temporal-validity filter — roadmap phase 4b.
 *
 * THIS IS THE FIRST PLACE IN THE BATCH WHERE A PAGE CAN BE REMOVED from an
 * answer. Everything before it annotates. So the assertions that matter here
 * are about what survives a filter, and about whether the response admits that
 * candidates it never examined may exist.
 *
 * THE EXHAUSTIVENESS COUNTS ARE THE HARD PART, not the filtering. A caller who
 * sees two hits needs to tell three situations apart: there were only two, there
 * were more and the page was full, or there were more and nobody looked. The
 * response answers all three, and every fixture below fixes its numbers BEFORE
 * the run — the chunk counts were measured against the real index builder, not
 * assumed, because the whole point of `moreCandidates` is arithmetic.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { searchSmartTool } from '../src/tools/search-smart.mjs';
import { buildSearchIndex } from '../src/helpers/bm25-index.mjs';

const TODAY = '2026-06-15';
const QUERY = 'tarif archive stockage';
const BODY = 'Le tarif archive de stockage.';

/** Windows, by the state they produce at TODAY. */
const IN_FORCE = { valid_from: '2026-01-01' };
const EXPIRED = { valid_through: '2025-12-31' };
const FUTURE = { valid_from: '2027-01-01' };
const BROKEN = { valid_from: '01/01/2026' };

const registry = {
  resolveVault: () => ({ name: 'v', type: 'local', path: '/tmp/v', baseUrl: 'http://127.0.0.1:1' }),
};

/** One page, one section, therefore one chunk (measured against the builder). */
const onePage = (n) => ({ path: `wiki/p${n}.md`, content: `# P${n}\n\n${BODY}\n` });
/** One page, two sections, therefore TWO chunks pointing at ONE page. */
const twoChunkPage = (n) => ({
  path: `wiki/t${n}.md`,
  content: `# T${n}\n\n## Premier\n\n${BODY}\n\n## Second\n\n${BODY} Encore.\n`,
});

/**
 * Deps that remember every note read, because "one read per page" is the
 * property this phase must provide and the response cannot show it.
 */
function depsFor({ pages, frontmatter = {}, missing = [] } = {}) {
  const index = buildSearchIndex({ pages, vaultName: 'v' });
  const reads = [];
  const deps = {
    getFileContent: async () => JSON.stringify(index),
    getNote: async (_vault, path) => {
      reads.push(path);
      if (missing.includes(path)) {
        throw Object.assign(new Error(`not found: ${path}`), { status: 404, kind: 'not_found' });
      }
      return { content: BODY, frontmatter: frontmatter[path] ?? {} };
    },
    // Forces the deterministic tier in the tests that use `tier: 'auto'`.
    searchSmart: async () => {
      throw Object.assign(new Error('Smart Connections plugin is not available'), { status: 503 });
    },
  };
  deps.reads = reads;
  deps.readCountFor = (p) => reads.filter((r) => r === p).length;
  return deps;
}

const local = (args, deps) => searchSmartTool(registry, { query: QUERY, tier: 'local', asOf: TODAY, ...args }, deps);

// ---------------------------------------------------------------------------
describe('the two parameters, judged on their own terms', () => {
  test('an unreadable `asOf` FAILS THE CALL', async () => {
    const deps = depsFor({ pages: [onePage(1)] });
    await assert.rejects(() => local({ asOf: 'la semaine prochaine' }, deps), /temporal-validity/);
  });

  test('and it fails BEFORE the index or any note is read', async () => {
    // A bad argument is bad on its own terms. Discovering it halfway through
    // means the call already spent I/O on a request that cannot succeed.
    let indexReads = 0;
    const deps = depsFor({ pages: [onePage(1)] });
    const base = deps.getFileContent;
    deps.getFileContent = async (...a) => { indexReads += 1; return base(...a); };
    await local({ asOf: 'nope' }, deps).catch(() => {});
    assert.equal(indexReads, 0, 'the index was never opened');
    assert.deepEqual(deps.reads, [], 'and no note was read');
  });

  test('an UNKNOWN state fails the call, naming the value', async () => {
    const deps = depsFor({ pages: [onePage(1)] });
    await assert.rejects(
      () => local({ validityStates: ['in-force', 'expired'] }, deps),
      (err) => {
        assert.match(err.message, /"expired"/);
        assert.equal(err.kind, 'validation');
        return true;
      },
    );
    assert.deepEqual(deps.reads, [], 'refused before any read, like a bad asOf');
  });

  test('omitting the filter leaves NO validityFilter block', async () => {
    const deps = depsFor({ pages: [onePage(1)] });
    const out = await local({}, deps);
    assert.equal(out.validityFilter, undefined);
  });

  test('but the SUMMARY is there whether or not anyone filtered', async () => {
    // Its absence would be ambiguous: "no page is dated" and "this build does
    // not annotate" would look identical.
    const deps = depsFor({ pages: [onePage(1)] });
    const out = await local({}, deps);
    assert.equal(out.validitySummary.asOf, TODAY);
    assert.equal(out.validitySummary.revisionCoherence, 'not-verified');
  });

  test('an EMPTY list is still a request, so the block appears and says it filtered nothing', async () => {
    const deps = depsFor({ pages: [onePage(1)], frontmatter: { 'wiki/p1.md': EXPIRED } });
    const out = await local({ validityStates: [] }, deps);
    assert.deepEqual(out.validityFilter.states, []);
    // The message belongs on the FIRST assertion that can fail, not on the
    // prettiest one: under a mutation that makes `[]` mean "keep nothing", this
    // is what fires, and a bare `1 !== 0` would name no rule at all.
    assert.equal(out.validityFilter.excludedHits, 0, '[] means keep everything — nothing may be excluded');
    assert.equal(out.results.length, 1, 'and the expired page is still returned');
  });
});

// ---------------------------------------------------------------------------
describe('what the filter removes, and what it refuses to remove', () => {
  test('a certain state outside the list is excluded and counted', async () => {
    const deps = depsFor({
      pages: [onePage(1), onePage(2)],
      frontmatter: { 'wiki/p1.md': IN_FORCE, 'wiki/p2.md': EXPIRED },
    });
    const out = await local({ validityStates: ['in-force'] }, deps);
    assert.deepEqual(out.results.map((r) => r.path), ['wiki/p1.md']);
    assert.equal(out.validityFilter.excludedHits, 1);
  });

  test('THE THREE THAT SURVIVE ANY FILTER — undated, unreadable, unverified', async () => {
    // One assertion per reason, because a single "non-certain hits survive"
    // check would pass with two of the three branches gone.
    const deps = depsFor({
      pages: [onePage(1), onePage(2), onePage(3)],
      frontmatter: { 'wiki/p2.md': BROKEN },
      missing: ['wiki/p3.md'],
    });
    const out = await local({ validityStates: ['no-longer-in-force'] }, deps);
    const byPath = Object.fromEntries(out.results.map((r) => [r.path, r]));

    assert.ok(byPath['wiki/p1.md'], 'undated: it takes no temporal position');
    assert.equal('validity' in byPath['wiki/p1.md'], false);

    assert.ok(byPath['wiki/p2.md'], 'unreadable: a defect to surface, not to hide');
    assert.equal(byPath['wiki/p2.md'].validity.state, 'unreadable');

    assert.ok(byPath['wiki/p3.md'], 'unverified: absence of knowledge, not a verdict');
    assert.equal(byPath['wiki/p3.md'].validityUnverified, true);

    assert.equal(out.validityFilter.excludedHits, 0, 'none of the three is an exclusion');
  });

  test('(f) a page that vanished between the index and the read is marked, never excluded', async () => {
    const deps = depsFor({
      pages: [onePage(1), onePage(2)],
      frontmatter: { 'wiki/p1.md': IN_FORCE },
      missing: ['wiki/p2.md'],
    });
    const out = await local({ validityStates: ['in-force'] }, deps);
    assert.equal(out.results.length, 2);
    assert.equal(out.results.find((r) => r.path === 'wiki/p2.md').validityUnverified, true);
    assert.equal(out.validityFilter.excludedHits, 0);
    assert.equal(out.validitySummary.unverifiedPages, 1);
  });
});

// ---------------------------------------------------------------------------
describe('the exhaustiveness counts — the six criteria, numbers fixed beforehand', () => {
  test('(a) three pages of two chunks each → THREE reads, not six', async () => {
    // Six chunks point at three pages. A read per hit would be six.
    const pages = [twoChunkPage(1), twoChunkPage(2), twoChunkPage(3)];
    const deps = depsFor({ pages, frontmatter: Object.fromEntries(pages.map((p) => [p.path, IN_FORCE])) });
    const out = await local({ limit: 10, validityStates: ['in-force'] }, deps);

    assert.equal(out.results.length, 6, 'six chunks come back');
    assert.equal(deps.reads.length, 3, 'three pages, three reads');
    assert.equal(new Set(deps.reads).size, 3);
    assert.equal(out.validitySummary.inspectedPages, 3);
    // AND EVERY CHUNK CARRIES THE WINDOW. The first version of this test
    // checked only the read count, so it stayed green while three of the six
    // entries were being reported as unverified — the quota was charged per
    // entry instead of per page, and a read count alone cannot see that.
    assert.equal(out.results.filter((r) => r.validity).length, 6,
      'all six chunks are annotated — none was refused for a budget its page had already paid');
    assert.equal(out.results.some((r) => r.validityUnverified), false);
    assert.equal(out.validitySummary.unverifiedPages, 0);
    assert.equal(out.validitySummary.budgetExhausted, false);
  });

  test('(b) five expired candidates, limit 2, keep in-force → nothing, and it says why', async () => {
    const pages = [1, 2, 3, 4, 5].map(onePage);
    const deps = depsFor({ pages, frontmatter: Object.fromEntries(pages.map((p) => [p.path, EXPIRED])) });
    const out = await local({ limit: 2, validityStates: ['in-force'] }, deps);

    assert.deepEqual(out.results, [], 'an empty answer');
    assert.equal(out.validityFilter.excludedHits, 5, 'but it carries the count that explains it');
    assert.equal(out.validityFilter.cutByLimit, 0, 'the limit removed nothing — the filter did');
    assert.equal(out.validityFilter.moreCandidates, false, 'and every eligible chunk was inspected');
  });

  test('(c) five admissible candidates, limit 2 → two hits, and the cut is named', async () => {
    const pages = [1, 2, 3, 4, 5].map(onePage);
    const deps = depsFor({ pages, frontmatter: Object.fromEntries(pages.map((p) => [p.path, IN_FORCE])) });
    const out = await local({ limit: 2, validityStates: ['in-force'] }, deps);

    assert.equal(out.results.length, 2);
    assert.equal(out.validityFilter.excludedHits, 0);
    assert.equal(out.validityFilter.cutByLimit, 3, 'three admissible hits the page had no room for');
    assert.equal(out.validityFilter.moreCandidates, false, 'what the cut removed is KNOWN, not unexamined');
  });

  test('(d) fifteen eligible chunks, fourteen fetched → candidates remain unexamined', async () => {
    // The real mechanism: with limit 2, the default folder exclusion and the
    // archive filter, `overfetchLimit` returns 14. Fifteen eligible chunks
    // therefore leave one nobody looked at.
    const pages = Array.from({ length: 15 }, (_, i) => onePage(i));
    const deps = depsFor({ pages, frontmatter: Object.fromEntries(pages.map((p) => [p.path, IN_FORCE])) });
    const out = await local({ limit: 2, validityStates: ['in-force'] }, deps);

    assert.equal(out.results.length, 2);
    assert.equal(out.validityFilter.moreCandidates, true);
    assert.equal(deps.reads.length, 14, 'exactly the over-fetched page was inspected');
  });

  test('(d-bis) the same corpus entirely expired → zero hits, and STILL more candidates', async () => {
    // The trap this criterion exists for: an empty answer is not evidence of
    // exhaustiveness. Fourteen expired chunks inspected out of fifteen eligible
    // means the fifteenth was never looked at, whatever the fourteen said.
    const pages = Array.from({ length: 15 }, (_, i) => onePage(i));
    const deps = depsFor({ pages, frontmatter: Object.fromEntries(pages.map((p) => [p.path, EXPIRED])) });
    const out = await local({ limit: 2, validityStates: ['in-force'] }, deps);

    assert.deepEqual(out.results, []);
    assert.equal(out.validityFilter.excludedHits, 14);
    assert.equal(out.validityFilter.moreCandidates, true, 'an empty page does NOT mean the corpus was exhausted');
  });

  test('THE OVER-FETCH THE FILTER NEEDED — with no other exclusion in force', async () => {
    // The case that made `validity` a third reason to over-fetch, and the one
    // that nearly went untested: with `excludeFolders: []` and archives kept,
    // neither pre-existing reason applies, so without the new flag the backend
    // is asked for exactly `limit`. The temporal filter would then cut into a
    // page that cannot be refilled — an empty answer with admissible hits
    // sitting just past the window.
    //
    // Five pages, the first four expired and the fifth in force, limit 2. With
    // the over-fetch all five are inspected and the one good hit comes back.
    // Without it, only two would be fetched, both expired, and the answer would
    // be empty while a match existed.
    const pages = [1, 2, 3, 4, 5].map(onePage);
    const deps = depsFor({
      pages,
      frontmatter: {
        'wiki/p1.md': EXPIRED, 'wiki/p2.md': EXPIRED, 'wiki/p3.md': EXPIRED,
        'wiki/p4.md': EXPIRED, 'wiki/p5.md': IN_FORCE,
      },
    });
    const out = await local(
      { limit: 2, excludeFolders: [], includeArchives: true, validityStates: ['in-force'] },
      deps,
    );

    assert.equal(deps.reads.length, 5, 'all five were fetched, not just the caller\'s two');
    assert.deepEqual(out.results.map((r) => r.path), ['wiki/p5.md'],
      'the admissible hit survived a page the filter would otherwise have emptied');
    assert.equal(out.validityFilter.excludedHits, 4);
    assert.equal(out.validityFilter.moreCandidates, false);
  });

  test('and with NO filter, that same call fetches exactly the limit — the over-fetch is not free', async () => {
    // The mirror. Over-fetching unconditionally would triple the reads of every
    // unfiltered search on the hot path.
    const pages = [1, 2, 3, 4, 5].map(onePage);
    const deps = depsFor({ pages, frontmatter: Object.fromEntries(pages.map((p) => [p.path, IN_FORCE])) });
    const out = await local({ limit: 2, excludeFolders: [], includeArchives: true }, deps);
    assert.equal(out.results.length, 2);
    assert.equal(deps.reads.length, 2, 'nothing downstream will cut, so nothing extra is fetched');
  });

  test('(e) folder-excluded chunks were never candidates, so they do not make moreCandidates true', async () => {
    // Six matched chunks; four live under the excluded folder. Eligible is two,
    // inspected is two. Counting `matched` here would report two unexamined
    // candidates that do not exist.
    const pages = [
      { path: 'wiki-meta/Sessions/s1.md', content: `# S1\n\n${BODY}\n` },
      { path: 'wiki-meta/Sessions/s2.md', content: `# S2\n\n${BODY}\n` },
      { path: 'wiki-meta/Sessions/s3.md', content: `# S3\n\n${BODY}\n` },
      { path: 'wiki-meta/Sessions/s4.md', content: `# S4\n\n${BODY}\n` },
      onePage(1),
      onePage(2),
    ];
    const deps = depsFor({
      pages,
      frontmatter: { 'wiki/p1.md': IN_FORCE, 'wiki/p2.md': IN_FORCE },
    });
    const out = await local({ limit: 10, validityStates: ['in-force'] }, deps);

    assert.equal(out.results.length, 2, 'only the two outside the excluded folder');
    assert.equal(out.validityFilter.moreCandidates, false);
    assert.equal(deps.reads.length, 2, 'and the excluded four were never read');
  });

  test('the count is ELIGIBLE against INSPECTED, never matched against returned', async () => {
    // The denominator, stated directly: `matched` counts before exclusions and
    // would be 6 here while only 2 chunks were ever candidates.
    const pages = [
      { path: 'wiki-meta/Sessions/s1.md', content: `# S1\n\n${BODY}\n` },
      { path: 'wiki-meta/Sessions/s2.md', content: `# S2\n\n${BODY}\n` },
      onePage(1),
    ];
    const deps = depsFor({ pages, frontmatter: { 'wiki/p1.md': IN_FORCE } });
    const out = await local({ limit: 10, validityStates: ['in-force'] }, deps);
    assert.equal(out.matched, 3, 'three chunks scored');
    assert.equal(out.eligible, 1, 'one survived the folder exclusion');
    assert.equal(out.validityFilter.moreCandidates, false);
  });
});

// ---------------------------------------------------------------------------
describe('the envelope', () => {
  test('INVARIANT 6 — strip the additions and the response is what it always was', async () => {
    const deps = depsFor({ pages: [onePage(1)], frontmatter: { 'wiki/p1.md': IN_FORCE } });
    const out = await local({}, deps);

    const { validitySummary, validityFilter, eligible, ...rest } = out;
    assert.ok(validitySummary, 'the summary is one of the additions');
    assert.equal(validityFilter, undefined, 'and the filter block is absent when nobody filtered');
    // `filter` and `folderExclusion` belong to the before-picture: this call
    // carries the measured default folder exclusion, and their presence here is
    // part of what the phase must NOT have disturbed.
    assert.deepEqual(Object.keys(rest).sort(), [
      'filter', 'folderExclusion', 'index', 'matched', 'query', 'queryTokens',
      'requestedTier', 'results', 'scoreScale', 'tier', 'vault',
    ], 'the pre-existing top-level keys, unchanged');

    const { validity, validityUnverified, ...hit } = rest.results[0];
    assert.deepEqual(Object.keys(hit).sort(), ['excerpt', 'path', 'score', 'section', 'title']);
  });

  test('INVARIANT 6 — an UNFILTERED call returns the same NUMBER of hits as before the batch', async () => {
    // The violation my own review found, and the reason the cut is now tied to
    // the filter. `filterArchiveResults` returns early when archives are kept,
    // so its `limit` never runs; with a folder exclusion in force the bridge is
    // asked for the over-fetched page and nothing downstream used to cut it.
    // Measured against the pre-batch code: 14 hits for a `limit` of 2. An
    // unconditional slice here would have silently changed that to 2.
    //
    // The over-return is a pre-existing defect. It is deliberately NOT fixed by
    // this batch, and this test pins the behaviour so the fix, when it comes, is
    // a decision rather than a side effect.
    const hits = Array.from({ length: 14 }, (_, i) => ({ path: `wiki/h${i}.md`, score: 1 - i / 100 }));
    const deps = depsFor({ pages: [onePage(1)] });
    deps.searchSmart = async () => ({ results: hits });

    const out = await searchSmartTool(
      registry, { query: QUERY, tier: 'semantic', asOf: TODAY, limit: 2, includeArchives: true }, deps,
    );
    assert.equal(out.results.length, 14,
      'unfiltered, the page keeps the size it had before phase 4b — the cut belongs to the filter');
    assert.equal(out.validityFilter, undefined);
  });

  test('and the same call WITH a filter does cut, because then the cut is the filter\'s', async () => {
    const hits = Array.from({ length: 14 }, (_, i) => ({ path: `wiki/h${i}.md`, score: 1 - i / 100 }));
    const deps = depsFor({
      pages: [onePage(1)],
      frontmatter: Object.fromEntries(hits.map((h) => [h.path, IN_FORCE])),
    });
    deps.searchSmart = async () => ({ results: hits });

    const out = await searchSmartTool(
      registry,
      { query: QUERY, tier: 'semantic', asOf: TODAY, limit: 2, includeArchives: true, validityStates: ['in-force'] },
      deps,
    );
    assert.equal(out.results.length, 2);
    assert.equal(out.validityFilter.cutByLimit, 12);
  });

  test('every hit carries its window even when NOBODY filtered', async () => {
    const deps = depsFor({
      pages: [onePage(1), onePage(2)],
      frontmatter: { 'wiki/p1.md': EXPIRED, 'wiki/p2.md': FUTURE },
    });
    const out = await local({}, deps);
    const states = out.results.map((r) => r.validity.state).sort();
    assert.deepEqual(states, ['no-longer-in-force', 'not-yet-in-force']);
    assert.equal(out.validitySummary.annotatedEntries, 2);
  });

  test('the summary counts the entries RETURNED, not the ones inspected', async () => {
    const pages = [1, 2, 3, 4, 5].map(onePage);
    const deps = depsFor({ pages, frontmatter: Object.fromEntries(pages.map((p) => [p.path, IN_FORCE])) });
    const out = await local({ limit: 2, validityStates: ['in-force'] }, deps);
    assert.equal(out.validitySummary.annotatedEntries, 2, 'two entries survived the cut');
    assert.equal(out.validitySummary.inspectedPages, 5, 'but five pages were really read');
  });
});

// ---------------------------------------------------------------------------
describe('the semantic tier says it does not know', () => {
  const semanticDeps = (hits, frontmatter = {}) => {
    const deps = depsFor({ pages: [onePage(1)], frontmatter });
    deps.searchSmart = async () => ({ results: hits });
    return deps;
  };

  test("moreCandidates is 'unknown', because the engine says nothing about what it withheld", async () => {
    const deps = semanticDeps(
      [{ path: 'wiki/a.md', score: 0.9 }, { path: 'wiki/b.md', score: 0.8 }],
      { 'wiki/a.md': IN_FORCE, 'wiki/b.md': EXPIRED },
    );
    const out = await searchSmartTool(
      registry, { query: QUERY, tier: 'semantic', asOf: TODAY, validityStates: ['in-force'] }, deps,
    );
    assert.equal(out.validityFilter.moreCandidates, 'unknown');
    assert.equal(out.validityFilter.excludedHits, 1);
    assert.deepEqual(out.results.map((r) => r.path), ['wiki/a.md']);
  });

  test("and it stays 'unknown' on an EMPTY page, rather than becoming false", async () => {
    // Zero hits is not evidence that the engine had nothing more.
    const deps = semanticDeps([]);
    const out = await searchSmartTool(
      registry, { query: QUERY, tier: 'semantic', asOf: TODAY, validityStates: ['in-force'] }, deps,
    );
    assert.deepEqual(out.results, []);
    assert.equal(out.validityFilter.moreCandidates, 'unknown');
  });

  test('a read that fails during annotation marks its entry and changes nothing else', async () => {
    // WHAT THIS ACTUALLY MEASURES, after a mutation showed the earlier version
    // claimed more. The annotator never lets a read failure propagate — it
    // marks the entry — so no mutation of the fallback structure can be caught
    // here. What IS checkable is that a failing read does not become a change
    // of engine: the tier is still semantic, no fallback block appears, and the
    // hit says its window is unverified. Even when the failure is dressed as
    // the exact capability gap the fallback exists for.
    const deps = semanticDeps([{ path: 'wiki/a.md', score: 0.9 }]);
    deps.getNote = async () => {
      throw Object.assign(new Error('Smart Connections plugin is not available'), { status: 503 });
    };
    const out = await searchSmartTool(registry, { query: QUERY, asOf: TODAY }, deps);
    assert.equal(out.tier, 'semantic', 'it did NOT fall back');
    assert.equal(out.fallback, undefined);
    assert.equal(out.results[0].validityUnverified, true, 'the failure is reported on the entry');
  });

  test('THE ARCHIVE TRIM MUST NOT SPEND THE OVER-FETCH before the filter runs', async () => {
    // Five semantic hits, limit 2, the first four expired. The over-fetch asks
    // for fourteen, but the archive trim used to cut back to `limit` one step
    // before the temporal filter — so the filter would have seen two expired
    // hits and answered empty while an admissible one sat at position five.
    const deps = semanticDeps(
      [1, 2, 3, 4, 5].map((n) => ({ path: `wiki/s${n}.md`, score: 1 - n / 100 })),
      {
        'wiki/s1.md': EXPIRED, 'wiki/s2.md': EXPIRED, 'wiki/s3.md': EXPIRED,
        'wiki/s4.md': EXPIRED, 'wiki/s5.md': IN_FORCE,
      },
    );
    // `includeArchives` stays FALSE on purpose: the archive filter returns
    // early when archives are kept and never applies its limit at all, so a
    // fixture that included them could not exercise the trim it is about. That
    // was the first version of this test, and a mutation showed it proved
    // nothing.
    const out = await searchSmartTool(registry, {
      query: QUERY, tier: 'semantic', asOf: TODAY, limit: 2,
      excludeFolders: [], validityStates: ['in-force'],
    }, deps);

    assert.deepEqual(out.results.map((r) => r.path), ['wiki/s5.md'],
      'the admissible hit survived a trim that would otherwise have cut it away');
    assert.equal(out.validityFilter.excludedHits, 4);
  });
});

// ---------------------------------------------------------------------------
describe('a semantic hit names a BLOCK, and the window belongs to its page', () => {
  // Roadmap phase 4c.3. These shapes are not invented — they are what the
  // TradingView vault's `/search/smart` returned on 2026-09-15, the one vault
  // of the fleet whose semantic tier answers. Before this wiring, ten of the
  // twenty pages annotated on that call came back unreadable for this reason
  // alone, and every one of them was reported `validityUnverified`: nothing was
  // hidden, but the filter was inert on half the tier.
  const BLOCK = "wiki/p9.md#Modules — comment l'indicateur fonctionne#L'idée en une phrase#{1}";
  const HEADING = "wiki/p9.md#Modules — comment l'indicateur fonctionne";
  const PAGE = 'wiki/p9.md';

  const semanticDeps = (hits, frontmatter = {}, missing = []) => {
    const deps = depsFor({ pages: [onePage(1)], frontmatter, missing });
    deps.searchSmart = async () => ({ results: hits });
    return deps;
  };
  const semantic = (args, deps) => searchSmartTool(
    registry, { query: QUERY, tier: 'semantic', asOf: TODAY, ...args }, deps,
  );

  test('the window is read from the PAGE, not asked of the block key', async () => {
    const deps = semanticDeps([{ path: BLOCK, score: 0.9 }], { [PAGE]: IN_FORCE });
    const out = await semantic({}, deps);
    assert.equal(out.results[0].validity?.state, 'in-force', 'the block inherited its page window');
    assert.equal(out.results[0].validityUnverified, undefined, 'and nothing was left unverified');
    assert.deepEqual(deps.reads, [PAGE], 'exactly one read, of the page');
  });

  test('and the hit keeps its own block path — the repair annotates, it does not rewrite', async () => {
    // The path is what a reader opens and what click-to-open builds on. Lifting
    // the page into the result would have silently dropped the anchor that says
    // WHICH part of the document matched.
    const deps = semanticDeps([{ path: BLOCK, score: 0.9 }], { [PAGE]: IN_FORCE });
    const out = await semantic({}, deps);
    assert.equal(out.results[0].path, BLOCK);
  });

  test('a block hit can be FILTERED OUT on its page window', async () => {
    // The consequence that matters: before the wiring, an expired page reached
    // through a block key survived a `['in-force']` filter, because an entry
    // whose window could not be read is never excluded (invariant 2). The
    // safety rule was doing the work of a defect.
    const deps = semanticDeps([{ path: BLOCK, score: 0.9 }], { [PAGE]: EXPIRED });
    const out = await semantic({ validityStates: ['in-force'] }, deps);
    assert.deepEqual(out.results, []);
    assert.equal(out.validityFilter.excludedHits, 1);
  });

  test('twenty blocks of ONE page cost ONE read and count as ONE page', async () => {
    // Invariant 10, on the shape that used to defeat it: every block key is a
    // distinct string, so nothing deduplicated and the summary counted twenty
    // pages for a document the vault holds once.
    const hits = Array.from({ length: 20 }, (_, i) => ({
      path: `${PAGE}#Section ${i}#{${i}}`, score: 1 - i / 100,
    }));
    const deps = semanticDeps(hits, { [PAGE]: IN_FORCE });
    const out = await semantic({ limit: 20 }, deps);
    assert.equal(deps.readCountFor(PAGE), 1, 'one read');
    assert.deepEqual(deps.reads, [PAGE], 'and no probe at any block key');
    assert.equal(out.validitySummary.inspectedPages, 1, 'one page');
    assert.equal(out.validitySummary.annotatedEntries, 20, 'twenty entries carry the window');
  });

  test('a page reached BOTH directly and through a block is still one page', async () => {
    const deps = semanticDeps(
      [{ path: PAGE, score: 0.9 }, { path: HEADING, score: 0.8 }, { path: BLOCK, score: 0.7 }],
      { [PAGE]: IN_FORCE },
    );
    const out = await semantic({}, deps);
    assert.equal(deps.readCountFor(PAGE), 1);
    assert.equal(out.validitySummary.inspectedPages, 1);
    assert.equal(out.results.every((r) => r.validity?.state === 'in-force'), true);
  });

  test('an UNDECIDABLE path is read as no page at all, rather than as a guess', async () => {
    // `wiki/a.md#b.md` is either the file `a.md#b.md` or the heading `b.md`
    // inside `a.md`, and the string cannot say which. The first version of this
    // wiring probed the literal spelling first and took whichever answered —
    // which, when BOTH exist with different windows, is the wrong one half the
    // time. The adversarial review of 2026-09-16 built that case; here it is,
    // and nothing is read.
    const raw = 'wiki/a.md#b.md';
    const deps = semanticDeps(
      [{ path: raw, score: 0.9 }],
      { [raw]: IN_FORCE, 'wiki/a.md': EXPIRED },
    );
    const out = await semantic({}, deps);
    assert.deepEqual(deps.reads, [], 'no spelling was guessed at');
    assert.equal(out.results[0].validityUnverified, true);
    assert.equal(out.results[0].validity, undefined, 'and no window was invented');
  });

  test('and an undecidable path is NEVER excluded — the doubt costs the annotation only', async () => {
    // The whole reason refusing is affordable: an entry we could not resolve
    // stays in the answer. Invariant 2 does the work the guess was doing, and
    // does it honestly.
    const raw = 'wiki/a.md#b.md';
    const deps = semanticDeps([{ path: raw, score: 0.9 }], { 'wiki/a.md': EXPIRED });
    const out = await semantic({ validityStates: ['in-force'] }, deps);
    assert.equal(out.results.length, 1, 'the hit survived a filter it could have been cut by');
    assert.equal(out.validityFilter.excludedHits, 0);
  });

  test('THE LOCAL TIER KEEPS ITS EXACT PATH — the doubt belongs to blocks only', async () => {
    // Round 2 caught this as a regression the repair introduced: `withValidity`
    // is shared by both tiers, so the semantic resolver was refusing a LOCAL
    // hit whose filename really contains `#`. A local path came out of an index
    // the router built from real filenames — there is nothing to recover and
    // nothing to be uncertain about, and refusing it cost the filter a page it
    // used to handle correctly.
    const weird = { path: 'wiki/a.md#b.md', content: '# A\n\n' + BODY + '\n' };
    const deps = depsFor({ pages: [weird], frontmatter: { 'wiki/a.md#b.md': EXPIRED } });
    const out = await local({ validityStates: ['in-force'] }, deps);
    assert.deepEqual(deps.reads, ['wiki/a.md#b.md'], 'read under its exact name');
    assert.deepEqual(out.results, [], 'and its window applied');
    assert.equal(out.validityFilter.excludedHits, 1);
  });

  test('and the SEMANTIC tier still refuses the same string, because there it is a block key', async () => {
    // The two halves of the same witness: one string, two tiers, two correct
    // and opposite answers. Asserting only the local half would leave the
    // distinction unproved.
    const deps = semanticDeps([{ path: 'wiki/a.md#b.md', score: 0.9 }], { 'wiki/a.md#b.md': EXPIRED });
    const out = await semantic({ validityStates: ['in-force'] }, deps);
    assert.deepEqual(deps.reads, [], 'nothing was read on a guess');
    assert.equal(out.results.length, 1, 'and the hit was kept');
  });

  test('a page nobody can read is unverified and kept, whatever the failure was', async () => {
    // NOT A WITNESS FOR THE FALL-THROUGH RULE, and it must not be read as one.
    // `readFirst` refusing to try another spelling after a transport error is a
    // real rule with a real consumer — the context pack's neighbours, which
    // resolve `wiki/x.md` then `x.md` — but `search_smart` hands over at most
    // ONE spelling, so nothing here can see that rule work or fail. A first
    // version of this test claimed otherwise and stayed green with the rule
    // deleted; the mutation run caught it. The rule's witness lives in
    // `validity-annotator.test.mjs`, where two spellings actually exist.
    const deps = depsFor({ pages: [onePage(1)], frontmatter: { 'wiki/p1.md': EXPIRED } });
    deps.searchSmart = async () => ({ results: [{ path: 'wiki/p1.md', score: 0.9 }] });
    deps.getNote = async () => {
      throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    };
    const out = await semantic({ validityStates: ['in-force'] }, deps);
    assert.equal(out.results[0].validityUnverified, true, 'unverified, never annotated');
    assert.equal(out.results.length, 1, 'and kept, because nobody could look');
    assert.equal(out.validityFilter.excludedHits, 0);
  });

  test('a page nobody can read is still UNVERIFIED, never excluded', async () => {
    // The repair must not cost the safety rule it exposed: an unreadable page
    // reached through a block key stays in the answer under a `['in-force']`
    // filter, because "I could not look" is not "it expired".
    const deps = semanticDeps([{ path: BLOCK, score: 0.9 }], {}, [PAGE]);
    const out = await semantic({ validityStates: ['in-force'] }, deps);
    assert.equal(out.results.length, 1, 'the hit survived');
    assert.equal(out.results[0].validityUnverified, true);
    assert.equal(out.validityFilter.excludedHits, 0);
    assert.equal(out.validitySummary.unverifiedPages, 1, 'counted as ONE page, not two probes');
  });
});
