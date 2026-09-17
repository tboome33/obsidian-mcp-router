/**
 * Temporal validity across a fan-out, and the tier that fell back — phase 4c.
 *
 * THE WHOLE SUBJECT IS WHAT A FAILED VAULT DOES TO EACH NUMBER. Summing is
 * arithmetic; the interesting question is whether a fleet where one vault was
 * unreachable can still answer "there is nothing more anywhere". It cannot, and
 * that is the pair of witnesses the roadmap names by name:
 *
 *     true  + error -> true
 *     false + error -> 'unknown'
 *
 * The second is the one that matters. Everything we SAW was exhausted, but not
 * all of it was seen, and a response that rounded that to `false` would be
 * telling the caller the search was complete.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { searchSmartTool } from '../src/tools/search-smart.mjs';
import {
  MORE_CANDIDATES_UNKNOWN,
  mergeFanoutValidity,
  mergeMoreCandidates,
} from '../src/helpers/validity-fanout.mjs';
import { buildSearchIndex } from '../src/helpers/bm25-index.mjs';
import { TIER_LOCAL } from '../src/helpers/local-search.mjs';

const TODAY = '2026-06-15';
const QUERY = 'tarif archive stockage';
const BODY = 'Le tarif archive de stockage.';
const IN_FORCE = { valid_from: '2026-01-01' };
const EXPIRED = { valid_through: '2025-12-31' };

// ---------------------------------------------------------------------------
describe('merging an existential answer', () => {
  test('one `true` settles it, whatever else is there', () => {
    assert.equal(mergeMoreCandidates([false, true, MORE_CANDIDATES_UNKNOWN]), true);
    assert.equal(mergeMoreCandidates([MORE_CANDIDATES_UNKNOWN, false, true]), true);
  });

  test("an `unknown` among `false`s makes the whole answer unknown", () => {
    assert.equal(mergeMoreCandidates([false, MORE_CANDIDATES_UNKNOWN, false]), MORE_CANDIDATES_UNKNOWN);
  });

  test('only all-`false` gives `false`', () => {
    assert.equal(mergeMoreCandidates([false, false]), false);
  });

  test('an EMPTY list is `false`, not `unknown`', () => {
    // No candidates at all means none went unexamined. `'unknown'` would claim
    // a doubt that nothing supports.
    assert.equal(mergeMoreCandidates([]), false);
  });

  test('any value that is not exactly `true`/`false` counts as unknown, never as false', () => {
    // Defence in depth: whatever a future tier answers, it must not be able to
    // silently assert exhaustiveness.
    assert.equal(mergeMoreCandidates([null]), MORE_CANDIDATES_UNKNOWN);
    assert.equal(mergeMoreCandidates([undefined, false]), MORE_CANDIDATES_UNKNOWN);
  });
});

// ---------------------------------------------------------------------------
describe('the top-level aggregate', () => {
  const ok = (vault, summary, filter) => ({
    vault, validitySummary: summary, ...(filter ? { validityFilter: filter } : {}),
  });
  const summary = (o = {}) => ({
    asOf: TODAY, annotatedEntries: 0, inspectedPages: 0, unverifiedPages: 0,
    budgetExhausted: false, revisionCoherence: 'not-verified', ...o,
  });

  test('the numeric counts are summed over the vaults that ANSWERED', () => {
    const { validitySummary } = mergeFanoutValidity([
      ok('a', summary({ annotatedEntries: 2, inspectedPages: 5, unverifiedPages: 1 })),
      ok('b', summary({ annotatedEntries: 3, inspectedPages: 4, unverifiedPages: 0 })),
      { vault: 'c', error: 'unreachable' },
    ], { asOf: TODAY, filterRequested: false });

    assert.equal(validitySummary.annotatedEntries, 5);
    assert.equal(validitySummary.inspectedPages, 9);
    assert.equal(validitySummary.unverifiedPages, 1);
  });

  test('and THE SCOPE OF THOSE SUMS IS STATED', () => {
    // Without coverage, a fleet with a third of its vaults unreachable reports
    // a third less of everything and looks like a complete answer.
    const { validitySummary } = mergeFanoutValidity([
      ok('a', summary()), { vault: 'b', error: 'down' }, { vault: 'c', error: 'down' },
    ], { asOf: TODAY, filterRequested: false });
    assert.deepEqual(validitySummary.coverage, {
      vaultsSummarized: 1, vaultsInError: 2, vaultsUnsummarized: 0,
    });
  });

  test('budgetExhausted is a logical OR — one vault that ran out marks the whole', () => {
    const { validitySummary } = mergeFanoutValidity([
      ok('a', summary({ budgetExhausted: false })),
      ok('b', summary({ budgetExhausted: true })),
    ], { asOf: TODAY, filterRequested: false });
    assert.equal(validitySummary.budgetExhausted, true);
  });

  test('the day is the ONE resolved for the call, and revisionCoherence is constant', () => {
    const { validitySummary } = mergeFanoutValidity([ok('a', summary())], { asOf: '2030-01-01', filterRequested: false });
    assert.equal(validitySummary.asOf, '2030-01-01');
    assert.equal(validitySummary.revisionCoherence, 'not-verified');
  });

  test('no filter requested → NO filter block at the top level either', () => {
    const out = mergeFanoutValidity([ok('a', summary())], { asOf: TODAY, filterRequested: false });
    assert.equal(out.validityFilter, undefined);
  });

  test('a vault entry carrying an error is counted as failed even if it somehow has a summary', () => {
    // `error` is the key that decides, not the absence of a summary — those are
    // different questions and only one of them is what `vaultsInError` names.
    const { validitySummary } = mergeFanoutValidity([
      { vault: 'a', error: 'boom', validitySummary: summary({ inspectedPages: 99 }) },
    ], { asOf: TODAY, filterRequested: false });
    assert.equal(validitySummary.coverage.vaultsInError, 1);
    assert.equal(validitySummary.inspectedPages, 0, 'a failed vault contributes nothing to the sums');
  });

  // A THIRD CATEGORY USED TO FALL BETWEEN THE TWO. An entry with no error and
  // no summary was in neither list: invisible in `coverage`, and — because it
  // never reached the merge — it let the remaining vaults' `false`s carry the
  // answer. A fan-out over ONE such vault reported "there is nothing more
  // anywhere". Found by the adversarial review of 2026-09-16.
  test('a vault that answered WITHOUT a summary is counted, and never read as silence', () => {
    const { validitySummary } = mergeFanoutValidity(
      [{ vault: 'a', results: [] }],
      { asOf: TODAY, filterRequested: false },
    );
    assert.deepEqual(validitySummary.coverage, {
      vaultsSummarized: 0, vaultsInError: 0, vaultsUnsummarized: 1,
    });
  });

  test('and under a filter it makes the answer unknown, not `false`', () => {
    const out = mergeFanoutValidity(
      [{ vault: 'a', results: [] }],
      { asOf: TODAY, filterRequested: true, states: ['in-force'] },
    );
    assert.equal(out.validityFilter.moreCandidates, 'unknown');
  });

  test('a vault WITH a summary but no filter block is the same silence', () => {
    // It answered, it was summarised, and it said nothing about what it
    // filtered. Skipping it left the merge one voice short.
    const out = mergeFanoutValidity(
      [ok('a', summary()), { vault: 'b', validitySummary: summary(), validityFilter: { states: [], excludedHits: 0, cutByLimit: 0, moreCandidates: false } }],
      { asOf: TODAY, filterRequested: true, states: ['in-force'] },
    );
    assert.equal(out.validityFilter.moreCandidates, 'unknown',
      'the vault without a filter block raises the doubt the other one cannot settle');
  });
});

// ---------------------------------------------------------------------------
describe('THE TWO WITNESSES THE ROADMAP NAMES', () => {
  const ok = (vault, more) => ({
    vault,
    validitySummary: {
      asOf: TODAY, annotatedEntries: 0, inspectedPages: 0, unverifiedPages: 0,
      budgetExhausted: false, revisionCoherence: 'not-verified',
    },
    validityFilter: { states: ['in-force'], excludedHits: 0, cutByLimit: 0, moreCandidates: more },
  });

  test("`false` + a vault in error -> 'unknown'", () => {
    // THE ONE THAT MATTERS. Everything we saw was exhausted, but a whole vault
    // went unread. Rounding that to `false` tells the caller the search was
    // complete when it was not.
    const { validityFilter } = mergeFanoutValidity(
      [ok('a', false), { vault: 'b', error: 'unreachable' }],
      { asOf: TODAY, filterRequested: true, states: ['in-force'] },
    );
    assert.equal(validityFilter.moreCandidates, MORE_CANDIDATES_UNKNOWN);
  });

  test('`true` + a vault in error -> `true`', () => {
    // The question is existential, so one positive answer settles it and the
    // unread vault cannot weaken it.
    const { validityFilter } = mergeFanoutValidity(
      [ok('a', true), { vault: 'b', error: 'unreachable' }],
      { asOf: TODAY, filterRequested: true, states: ['in-force'] },
    );
    assert.equal(validityFilter.moreCandidates, true);
  });

  test('and with NO vault in error, all-`false` really is `false`', () => {
    // The denominator for the two above: without it they would both pass
    // against a merge that always answered `'unknown'`.
    const { validityFilter } = mergeFanoutValidity(
      [ok('a', false), ok('b', false)],
      { asOf: TODAY, filterRequested: true, states: ['in-force'] },
    );
    assert.equal(validityFilter.moreCandidates, false);
  });

  test('the filter counts are summed, and the states echoed', () => {
    const a = ok('a', false); a.validityFilter.excludedHits = 3; a.validityFilter.cutByLimit = 1;
    const b = ok('b', false); b.validityFilter.excludedHits = 2; b.validityFilter.cutByLimit = 4;
    const { validityFilter } = mergeFanoutValidity([a, b], {
      asOf: TODAY, filterRequested: true, states: ['in-force'],
    });
    assert.equal(validityFilter.excludedHits, 5);
    assert.equal(validityFilter.cutByLimit, 5);
    assert.deepEqual(validityFilter.states, ['in-force']);
  });
});

// ---------------------------------------------------------------------------
describe('the fan-out, end to end', () => {
  const page = (n) => ({ path: `wiki/p${n}.md`, content: `# P${n}\n\n${BODY}\n` });

  function fanoutDeps({ frontmatter = {}, failing = new Set() } = {}) {
    const index = buildSearchIndex({ pages: [page(1), page(2)], vaultName: 'v' });
    return {
      getFileContent: async (vault) => {
        if (failing.has(vault.name)) throw Object.assign(new Error(`index absent on ${vault.name}`), { kind: 'index-absent' });
        return JSON.stringify(index);
      },
      getNote: async (_v, p) => ({ content: BODY, frontmatter: frontmatter[p] ?? {} }),
      searchSmart: async () => {
        throw Object.assign(new Error('Smart Connections plugin is not available'), { status: 503 });
      },
    };
  }

  const registryOf = (names) => ({
    lockedVault: null,
    vaults: names.map((name) => ({ name, type: 'local', path: `/tmp/${name}`, baseUrl: 'http://127.0.0.1:1' })),
    resolveVault: (n) => ({ name: n, type: 'local', path: `/tmp/${n}`, baseUrl: 'http://127.0.0.1:1' }),
  });

  test('every vault entry carries its OWN summary, and the top level carries the whole', async () => {
    const deps = fanoutDeps({ frontmatter: { 'wiki/p1.md': EXPIRED, 'wiki/p2.md': IN_FORCE } });
    const out = await searchSmartTool(registryOf(['a', 'b']), { vault: '*', query: QUERY, tier: 'local', asOf: TODAY }, deps);

    assert.equal(out.perVault.length, 2);
    for (const entry of out.perVault) assert.ok(entry.validitySummary, `${entry.vault} carries its own summary`);
    assert.equal(out.validitySummary.coverage.vaultsSummarized, 2);
    assert.equal(out.validitySummary.coverage.vaultsUnsummarized, 0);
    assert.equal(out.validitySummary.inspectedPages, 4, 'two pages per vault, both vaults');
    assert.equal(out.validitySummary.asOf, TODAY);
  });

  test('A VAULT IN ERROR keeps its entry untouched and is counted, not summed', async () => {
    const deps = fanoutDeps({ frontmatter: { 'wiki/p1.md': IN_FORCE }, failing: new Set(['b']) });
    const out = await searchSmartTool(registryOf(['a', 'b']), { vault: '*', query: QUERY, tier: 'local', asOf: TODAY }, deps);

    const broken = out.perVault.find((e) => e.vault === 'b');
    assert.ok(broken.error, 'its `{vault, error}` shape is unchanged');
    assert.equal(broken.validitySummary, undefined);
    assert.deepEqual(out.validitySummary.coverage, {
      vaultsSummarized: 1, vaultsInError: 1, vaultsUnsummarized: 0,
    });
  });

  test("and under a filter, that unreachable vault turns `false` into 'unknown' END TO END", async () => {
    // The same claim as the unit witness, but through the real tool: vault `a`
    // inspected everything it had, vault `b` could not be read at all.
    const deps = fanoutDeps({
      frontmatter: { 'wiki/p1.md': IN_FORCE, 'wiki/p2.md': IN_FORCE },
      failing: new Set(['b']),
    });
    const out = await searchSmartTool(
      registryOf(['a', 'b']),
      { vault: '*', query: QUERY, tier: 'local', asOf: TODAY, limit: 10, validityStates: ['in-force'] },
      deps,
    );

    const answered = out.perVault.find((e) => e.vault === 'a');
    assert.equal(answered.validityFilter.moreCandidates, false, 'the vault that answered saw everything it had');
    assert.equal(out.validityFilter.moreCandidates, MORE_CANDIDATES_UNKNOWN,
      'but the fleet cannot claim exhaustiveness with a vault it never read');
  });

  test('no filter requested → no top-level filter block on a fan-out either', async () => {
    const deps = fanoutDeps();
    const out = await searchSmartTool(registryOf(['a']), { vault: '*', query: QUERY, tier: 'local', asOf: TODAY }, deps);
    assert.equal(out.validityFilter, undefined);
    assert.ok(out.validitySummary, 'the summary is still always there');
  });

  test('the pre-existing fan-out keys are untouched', async () => {
    const deps = fanoutDeps();
    const out = await searchSmartTool(registryOf(['a']), { vault: '*', query: QUERY, tier: 'local', asOf: TODAY }, deps);
    const { validitySummary, validityFilter, ...rest } = out;
    assert.deepEqual(Object.keys(rest).sort(), ['filter', 'perVault', 'query', 'requestedTier']);
  });
});

// ---------------------------------------------------------------------------
describe('the fallback tier is annotated exactly like the one it replaced', () => {
  test("a call that DEGRADED from semantic to local is still annotated, and says 'local'", async () => {
    // Phase 4c.1: `tier: 'auto'` changes nothing about the annotation. The
    // response is annotated whichever engine served it, and `moreCandidates`
    // then follows the tier that ANSWERED — local here, so a real number.
    const index = buildSearchIndex({
      pages: [{ path: 'wiki/p1.md', content: `# P1\n\n${BODY}\n` }],
      vaultName: 'v',
    });
    const deps = {
      getFileContent: async () => JSON.stringify(index),
      getNote: async () => ({ content: BODY, frontmatter: EXPIRED }),
      searchSmart: async () => {
        throw Object.assign(new Error('Smart Connections plugin is not available'), { status: 503 });
      },
    };
    const registry = { resolveVault: () => ({ name: 'v', type: 'local', path: '/tmp/v', baseUrl: 'http://127.0.0.1:1' }) };

    const out = await searchSmartTool(registry, { query: QUERY, asOf: TODAY, validityStates: ['no-longer-in-force'] }, deps);

    // The CONSTANT, not a literal: the first version of this test guessed
    // `'local'` and the tier is actually `'local-bm25'`. A literal here would
    // also stop discriminating the day the value changed.
    assert.equal(out.tier, TIER_LOCAL, 'it really did degrade');
    assert.ok(out.fallback, 'and the degrade is labelled, as before');
    assert.equal(out.results[0].validity.state, 'no-longer-in-force', 'annotated all the same');
    assert.equal(typeof out.validityFilter.moreCandidates, 'boolean',
      "the ANSWERING tier decides — local gives a real answer, not 'unknown'");
  });
});
