/**
 * The annotation context — phase 4a.1.
 *
 * THE THIRD CONSUMER of `temporal-validity.mjs`, and the first one that does
 * I/O. Everything here that matters is bookkeeping the pure helper must never
 * know about: one read per page per operation, a failure remembered instead of
 * retried, a quota per collection, and a summary whose numbers say what was
 * really looked at.
 *
 * THE READER IS ALWAYS INJECTED and always COUNTS ITS CALLS. Nearly every
 * assertion below is about how many times the reader ran, because that is the
 * property the module exists to provide and the one no amount of reading the
 * code can establish. A test that only checked the annotations would pass just
 * as happily against a version that reads every page three times.
 *
 * THE REST NOTES ARE THE MEASURED ONES. The values fed to the annotator in the
 * production-shape block are what Obsidian's parser was measured to return on
 * 2026-09-11 (roadmap, end of phase 4a), not what a reasonable parser might be
 * expected to return. That measurement is the reason this phase was allowed to
 * start at all.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REVISION_COHERENCE,
  UNMETERED,
  createValidityContext,
} from '../src/helpers/validity-annotator.mjs';
import { parseFrontmatter } from '../src/helpers/llms-txt-exporter.mjs';
import { TEMPORAL_VALIDITY_CASES } from './fixtures/temporal-validity-cases.mjs';

const TODAY = '2026-06-15';
const VAULT = { name: 'test-vault' };

/** A reader over a fixed map of notes, which remembers every call it served. */
function readerOver(notes, { fail = new Map() } = {}) {
  const calls = [];
  const reader = async (vault, path) => {
    calls.push(path);
    if (fail.has(path)) throw fail.get(path);
    if (!Object.prototype.hasOwnProperty.call(notes, path)) {
      const err = new Error(`not found: ${path}`);
      err.status = 404;
      throw err;
    }
    return notes[path];
  };
  reader.calls = calls;
  reader.countFor = (path) => calls.filter((p) => p === path).length;
  return reader;
}

/** A note as `getNote` delivers one. */
function note(frontmatter, content = '# Page\n\nBody.\n') {
  return { content, frontmatter };
}

function contextWith(notes, options = {}) {
  const readNote = options.readNote ?? readerOver(notes, { fail: options.fail });
  const ctx = createValidityContext({
    vault: VAULT,
    readNote,
    asOf: options.asOf ?? TODAY,
    budget: options.budget ?? { primary: UNMETERED, chunks: UNMETERED, neighbors: UNMETERED },
  });
  return { ctx, readNote };
}

// ---------------------------------------------------------------------------
describe('construction — what the context refuses to be built without', () => {
  const ok = { vault: VAULT, readNote: async () => note({}), budget: {} };

  test('a vault, bound once — the context is never shared across vaults', () => {
    assert.throws(() => createValidityContext({ ...ok, vault: undefined }), /a vault is required/);
  });

  test('a reader', () => {
    assert.throws(() => createValidityContext({ ...ok, readNote: null }), /`readNote` must be a function/);
  });

  test('a budget object — an absent one is an implicit budget', () => {
    assert.throws(() => createValidityContext({ vault: VAULT, readNote: ok.readNote }), /`budget` must be an object/);
    assert.throws(() => createValidityContext({ ...ok, budget: [] }), /`budget` must be an object/);
  });

  test('quotas that are whole and non-negative, or explicitly unmetered', () => {
    assert.throws(() => createValidityContext({ ...ok, budget: { chunks: -1 } }), /non-negative integer or UNMETERED/);
    assert.throws(() => createValidityContext({ ...ok, budget: { chunks: 2.5 } }), /non-negative integer or UNMETERED/);
    assert.doesNotThrow(() => createValidityContext({ ...ok, budget: { chunks: 0 } }));
    assert.doesNotThrow(() => createValidityContext({ ...ok, budget: { chunks: UNMETERED } }));
  });

  test('THE REFERENCE DAY IS RESOLVED HERE, and a bad one fails HERE', () => {
    // The ordering the helper was corrected to, kept at this level: an
    // unreadable `asOf` must fail on its own terms, not on the first page that
    // happens to declare a window.
    assert.throws(
      () => createValidityContext({ ...ok, asOf: 'la semaine prochaine' }),
      /temporal-validity/,
    );
  });

  test('resolved ONCE — two entries of one response are never on different days', () => {
    // A REAL Date whose reading advances, because the helper rightly refuses a
    // hand-rolled clock object (the first version of this test was refused for
    // exactly that, which is the guard doing its job). The instant crosses
    // midnight UTC on the second read, so a context that re-resolved the day
    // would answer 2026-06-16 the second time.
    const clock = new Date('2026-06-15T23:59:59.000Z');
    const trueReading = Date.prototype.toISOString.call(clock);
    let ticks = 0;
    clock.toISOString = () => {
      ticks += 1;
      return ticks === 1 ? trueReading : '2026-06-16T00:00:01.000Z';
    };

    const ctx = createValidityContext({ ...ok, asOf: undefined, now: clock });
    assert.equal(ctx.asOf, '2026-06-15');
    assert.equal(ctx.asOf, '2026-06-15', 'reading it again must not re-resolve it');
    assert.equal(ticks, 1, 'the clock is consulted exactly once, at construction');
  });

  test('and the marching clock really does discriminate', () => {
    // Without this the test above could pass against a context that consults
    // the clock twice but happens to be handed the same day both times.
    const clock = new Date('2026-06-15T23:59:59.000Z');
    let ticks = 0;
    clock.toISOString = () => {
      ticks += 1;
      return ticks === 1 ? '2026-06-15T23:59:59.000Z' : '2026-06-16T00:00:01.000Z';
    };
    assert.equal(clock.toISOString().slice(0, 10), '2026-06-15');
    assert.equal(clock.toISOString().slice(0, 10), '2026-06-16', 'the second reading is a different day');
  });
});

// ---------------------------------------------------------------------------
describe('the one read door — a page is read at most once per operation', () => {
  test('two CONCURRENT reads of the same path produce ONE call', async () => {
    // The reason the cache stores the promise rather than the result: by the
    // time a result exists, the second I/O has already left.
    let resolveIt;
    const gate = new Promise((r) => { resolveIt = r; });
    const readNote = async () => { await gate; return note({ valid_from: '2026-01-01' }); };
    let calls = 0;
    const counting = async (...args) => { calls += 1; return readNote(...args); };

    const { ctx } = contextWith({}, { readNote: counting });
    const both = Promise.all([ctx.read('wiki/a.md'), ctx.read('wiki/a.md')]);
    resolveIt();
    const [first, second] = await both;

    assert.equal(calls, 1, 'one I/O');
    assert.equal(first, second, 'and both callers get the very same note object');
  });

  test('a SEQUENTIAL second read is served from the cache', async () => {
    const { ctx, readNote } = contextWith({ 'wiki/a.md': note({ valid_from: '2026-01-01' }) });
    await ctx.read('wiki/a.md');
    await ctx.read('wiki/a.md');
    assert.equal(readNote.countFor('wiki/a.md'), 1);
  });

  test('A FAILURE IS A RESULT — recorded, never replayed', async () => {
    const boom = Object.assign(new Error('vault unreachable'), { kind: 'unreachable' });
    const { ctx, readNote } = contextWith({}, { fail: new Map([['wiki/a.md', boom]]) });

    await assert.rejects(() => ctx.read('wiki/a.md'), /vault unreachable/);
    await assert.rejects(() => ctx.read('wiki/a.md'), /vault unreachable/);
    assert.equal(readNote.countFor('wiki/a.md'), 1, 'the second call was served from the cache');
  });

  test('and the ORIGINAL error object comes back, so callers can still classify it', async () => {
    // `isMissingReadError` distinguishes a dead wikilink from an unreachable
    // vault, and the placeholder\'s `fetchError` and the `page-read-failed`
    // warning both depend on that. A wrapped or re-created error would keep the
    // message and lose the meaning.
    const original = Object.assign(new Error('gone'), { status: 404, kind: 'not-found' });
    const { ctx } = contextWith({}, { fail: new Map([['wiki/a.md', original]]) });

    const caught = [];
    await ctx.read('wiki/a.md').catch((e) => caught.push(e));
    await ctx.read('wiki/a.md').catch((e) => caught.push(e));
    assert.equal(caught[0], original, 'the identical object, not a copy');
    assert.equal(caught[1], original);
    assert.equal(caught[1].status, 404);
    assert.equal(caught[1].kind, 'not-found');
  });

  test('THE SHARED DEFERRED REJECTION — two waiters, one attempt, one error', async () => {
    // The case review asked for by name. Two readers are already waiting on the
    // same in-flight promise when it rejects; the annotation then meets the
    // failure in the cache. One attempt total, the same error to both waiters,
    // the entry marked without a re-read, and the counts say exactly that.
    let rejectIt;
    const gate = new Promise((_, r) => { rejectIt = r; });
    const original = Object.assign(new Error('deferred failure'), { status: 500 });
    let calls = 0;
    const readNote = async () => { calls += 1; await gate; };

    const { ctx } = contextWith({}, { readNote });
    const waiterA = ctx.read('wiki/a.md').catch((e) => e);
    const waiterB = ctx.read('wiki/a.md').catch((e) => e);
    rejectIt(original);
    const [a, b] = await Promise.all([waiterA, waiterB]);

    assert.equal(a, original);
    assert.equal(b, original, 'the same error object reached both waiters');

    const entries = [{ path: 'wiki/a.md' }];
    await ctx.annotate(entries, { collection: 'chunks' });
    assert.equal(calls, 1, 'the annotation found the failure in the cache — no second attempt');
    assert.equal(entries[0].validityUnverified, true);
    assert.equal(entries[0].validity, undefined);

    const summary = ctx.finalize(entries);
    assert.equal(summary.unverifiedPages, 1);
    assert.equal(summary.inspectedPages, 0);
    assert.equal(summary.budgetExhausted, false, 'nothing here was refused for lack of budget');
  });
});

// ---------------------------------------------------------------------------
describe('what an annotated entry says', () => {
  const notes = {
    'wiki/in-force.md': note({ valid_from: '2026-01-01', valid_through: '2026-12-31' }),
    'wiki/ended.md': note({ valid_through: '2025-12-31' }),
    'wiki/future.md': note({ valid_from: '2027-01-01' }),
    'wiki/broken.md': note({ valid_from: '01/01/2026' }),
    'wiki/silent.md': note({ type: 'concept' }),
  };

  async function annotateOne(path) {
    const { ctx } = contextWith(notes);
    const entries = [{ path }];
    await ctx.annotate(entries, { collection: 'chunks' });
    return entries[0];
  }

  test('a declared, readable window carries its state and its bounds', async () => {
    const entry = await annotateOne('wiki/in-force.md');
    assert.deepEqual(entry.validity, {
      state: 'in-force', from: '2026-01-01', through: '2026-12-31', asOf: TODAY,
    });
    assert.equal(entry.validityUnverified, undefined);
  });

  test('and `problems` is ABSENT on a readable one', async () => {
    // An empty array on every entry of every response is a field the consumer
    // must check and that never has anything to say.
    const entry = await annotateOne('wiki/ended.md');
    assert.equal('problems' in entry.validity, false);
    assert.equal(entry.validity.state, 'no-longer-in-force');
  });

  test('an unreadable window carries `problems`, because there it means something', async () => {
    const entry = await annotateOne('wiki/broken.md');
    assert.equal(entry.validity.state, 'unreadable');
    assert.deepEqual(entry.validity.problems, ['valid_from:not-iso']);
  });

  test('a page that declares NO window says nothing at all', async () => {
    // Invariant 1. Not `validity: null`, not `validity: {state: null}` — absent.
    const entry = await annotateOne('wiki/silent.md');
    assert.equal('validity' in entry, false);
    assert.equal('validityUnverified' in entry, false);
  });

  test('a page that could not be read is MARKED, never silently silent', async () => {
    const entry = await annotateOne('wiki/does-not-exist.md');
    assert.equal(entry.validityUnverified, true);
    assert.equal('validity' in entry, false);
  });

  test('an entry naming no page is marked too, and is not counted as a page', async () => {
    // Some bridge payloads carry text and no path. It cannot be verified, and
    // there is no page to count as unverified either.
    const { ctx } = contextWith(notes);
    const entries = [{ path: '   ' }, { text: 'no path key at all' }];
    await ctx.annotate(entries, { collection: 'chunks' });
    assert.equal(entries[0].validityUnverified, true);
    assert.equal(entries[1].validityUnverified, true);
    const summary = ctx.finalize(entries);
    assert.equal(summary.unverifiedPages, 0, 'no page was named, so no page went unverified');
    assert.equal(summary.inspectedPages, 0);
  });

  test('the entry is never dropped, whatever happened to it', async () => {
    const { ctx } = contextWith(notes);
    const entries = [
      { path: 'wiki/in-force.md' }, { path: 'wiki/silent.md' },
      { path: 'wiki/gone.md' }, { path: '' },
    ];
    const returned = await ctx.annotate(entries, { collection: 'chunks' });
    assert.equal(returned.length, 4);
    assert.equal(entries.length, 4);
  });
});

// ---------------------------------------------------------------------------
describe('the budget — a quota per collection, never implicit', () => {
  const notes = Object.fromEntries(
    ['a', 'b', 'c', 'd'].map((n) => [`wiki/${n}.md`, note({ valid_through: '2025-12-31' })]),
  );

  test('an undeclared collection is refused, even with nothing to annotate', async () => {
    // A tool that mis-names its quota learns it on the first empty response,
    // not on the first response that happens to carry entries.
    const { ctx } = contextWith(notes, { budget: { chunks: 5 } });
    await assert.rejects(() => ctx.annotate([], { collection: 'neighbours' }), /no quota declared/);
  });

  test('over budget: the entries are KEPT, marked, counted — and no attempt is made', async () => {
    const { ctx, readNote } = contextWith(notes, { budget: { chunks: 2 } });
    const entries = ['a', 'b', 'c', 'd'].map((n) => ({ path: `wiki/${n}.md` }));
    await ctx.annotate(entries, { collection: 'chunks' });

    assert.equal(readNote.calls.length, 2, 'exactly the quota — the extra pages were never fetched');
    assert.equal(entries[0].validity.state, 'no-longer-in-force');
    assert.equal(entries[1].validity.state, 'no-longer-in-force');
    assert.equal(entries[2].validityUnverified, true);
    assert.equal(entries[3].validityUnverified, true);

    const summary = ctx.finalize(entries);
    assert.equal(summary.inspectedPages, 2);
    assert.equal(summary.unverifiedPages, 2);
    assert.equal(summary.budgetExhausted, true);
  });

  test('the debit follows ARRAY ORDER, so two identical calls spend identically', async () => {
    // The cache makes the debit order-dependent: whoever touches a page first
    // pays for it. If the reservation happened as reads completed, the same
    // request could spend different quotas on different runs.
    const { ctx, readNote } = contextWith(notes, { budget: { chunks: 2 } });
    const entries = ['d', 'c', 'b', 'a'].map((n) => ({ path: `wiki/${n}.md` }));
    await ctx.annotate(entries, { collection: 'chunks' });
    assert.deepEqual(readNote.calls, ['wiki/d.md', 'wiki/c.md'], 'the first two of the array, always');
    ctx.finalize(entries);
  });

  test('quotas are SEPARATE — one collection cannot eat the other\'s', async () => {
    const { ctx, readNote } = contextWith(notes, { budget: { chunks: 1, neighbors: 1 } });
    const chunks = [{ path: 'wiki/a.md' }, { path: 'wiki/b.md' }];
    const neighbours = [{ path: 'wiki/c.md' }, { path: 'wiki/d.md' }];
    await ctx.annotate(chunks, { collection: 'chunks' });
    await ctx.annotate(neighbours, { collection: 'neighbors' });

    assert.deepEqual(readNote.calls, ['wiki/a.md', 'wiki/c.md']);
    assert.equal(chunks[1].validityUnverified, true);
    assert.equal(neighbours[1].validityUnverified, true);
  });

  test('THE QUOTA BUYS A PAGE, not an entry — several entries on one page cost ONE', async () => {
    // The defect the phase 4b measurement on the real vault surfaced. The
    // reservation loop is synchronous: nothing has been read when it runs, so
    // without a record of what THIS pass already reserved, ten chunks of one
    // page each debited the quota. Nine were refused for lack of budget and
    // reported as unverified — while the page had been read successfully and
    // its window was known. A lie in the response, produced by the bookkeeping
    // rather than by any failure.
    const notes = { 'wiki/one.md': note({ valid_through: '2025-12-31' }) };
    const { ctx, readNote } = contextWith(notes, { budget: { chunks: 1 } });
    const entries = Array.from({ length: 10 }, () => ({ path: 'wiki/one.md' }));

    await ctx.annotate(entries, { collection: 'chunks' });

    assert.equal(readNote.calls.length, 1, 'one page, one read');
    assert.equal(entries.filter((e) => e.validity).length, 10, 'and ALL TEN entries carry the window');
    assert.equal(entries.filter((e) => e.validityUnverified).length, 0);

    const summary = ctx.finalize(entries);
    assert.equal(summary.inspectedPages, 1);
    assert.equal(summary.unverifiedPages, 0);
    assert.equal(summary.budgetExhausted, false, 'a quota of exactly one page was never exceeded');
  });

  test('and a quota of N pages serves N pages however many entries point at them', async () => {
    const notes = {
      'wiki/a.md': note({ valid_through: '2025-12-31' }),
      'wiki/b.md': note({ valid_through: '2025-12-31' }),
      'wiki/c.md': note({ valid_through: '2025-12-31' }),
    };
    const { ctx, readNote } = contextWith(notes, { budget: { chunks: 3 } });
    const entries = ['a', 'a', 'b', 'b', 'c', 'c'].map((n) => ({ path: `wiki/${n}.md` }));

    await ctx.annotate(entries, { collection: 'chunks' });

    assert.deepEqual(readNote.calls, ['wiki/a.md', 'wiki/b.md', 'wiki/c.md']);
    assert.equal(entries.filter((e) => e.validity).length, 6, 'six entries, three pages, all annotated');
    assert.equal(ctx.finalize(entries).budgetExhausted, false);
  });

  test('the quota STILL runs out when the pages really are distinct', async () => {
    // The mirror, so the repair above cannot be mistaken for "the budget stopped
    // applying". Four distinct pages against a quota of two.
    const notes = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((n) => [`wiki/${n}.md`, note({ valid_through: '2025-12-31' })]),
    );
    const { ctx, readNote } = contextWith(notes, { budget: { chunks: 2 } });
    const entries = ['a', 'b', 'c', 'd'].map((n) => ({ path: `wiki/${n}.md` }));

    await ctx.annotate(entries, { collection: 'chunks' });

    assert.equal(readNote.calls.length, 2);
    assert.equal(entries.filter((e) => e.validityUnverified).length, 2);
    assert.equal(ctx.finalize(entries).budgetExhausted, true);
  });

  test('a page already read costs the NEXT collection nothing', async () => {
    // The primary pages are read for their body anyway; annotating a chunk that
    // names one of them must not spend the chunk quota.
    const { ctx, readNote } = contextWith(notes, { budget: { primary: UNMETERED, chunks: 1 } });
    await ctx.annotate([{ path: 'wiki/a.md' }], { collection: 'primary' });
    const chunks = [{ path: 'wiki/a.md' }, { path: 'wiki/b.md' }];
    await ctx.annotate(chunks, { collection: 'chunks' });

    assert.deepEqual(readNote.calls, ['wiki/a.md', 'wiki/b.md']);
    assert.equal(chunks[0].validity.state, 'no-longer-in-force', 'served from the cache');
    assert.equal(chunks[1].validity.state, 'no-longer-in-force', 'and the quota still bought the new page');
    assert.equal(ctx.remaining('chunks'), 0);
  });

  test('an unmetered collection never exhausts', async () => {
    const { ctx, readNote } = contextWith(notes, { budget: { primary: UNMETERED } });
    const entries = ['a', 'b', 'c', 'd'].map((n) => ({ path: `wiki/${n}.md` }));
    await ctx.annotate(entries, { collection: 'primary' });
    assert.equal(readNote.calls.length, 4);
    assert.equal(ctx.finalize(entries).budgetExhausted, false);
  });

  test('a zero quota reads nothing at all, and says so', async () => {
    const { ctx, readNote } = contextWith(notes, { budget: { chunks: 0 } });
    const entries = [{ path: 'wiki/a.md' }];
    await ctx.annotate(entries, { collection: 'chunks' });
    assert.equal(readNote.calls.length, 0);
    assert.equal(entries[0].validityUnverified, true);
    assert.equal(ctx.finalize(entries).budgetExhausted, true);
  });
});

// ---------------------------------------------------------------------------
describe('paths are cached, PAGES are counted', () => {
  // The two-attempt heuristic resolves one catalogue entry through several
  // paths. Counting paths would report two unverified pages for one dead link,
  // and one unverified page for a page that was read perfectly well on its
  // second try. The summary's declared unit is the page.

  test('a page found on its SECOND path is inspected, not half-failed', async () => {
    const notes = { 'root.md': note({ valid_through: '2025-12-31' }) };
    const { ctx, readNote } = contextWith(notes);

    // `resolution` names the spellings this loop will try. A caller that tries
    // several and says so is ONE resolution of one page; a caller that reads a
    // second spelling under the same identity WITHOUT saying so is two callers
    // disagreeing, and that is what the guard is there to catch (round 5).
    const resolution = ['wiki/root.md', 'root.md'];
    let resolved = null;
    for (const tryPath of resolution) {
      try {
        resolved = await ctx.read(tryPath, { page: 'root.md', resolution });
        break;
      } catch { /* fall through to the next spelling, as the drill does */ }
    }
    assert.ok(resolved, 'the fallback spelling found it');
    assert.deepEqual(readNote.calls, ['wiki/root.md', 'root.md'], 'both paths were really tried');

    const summary = ctx.finalize([]);
    assert.equal(summary.inspectedPages, 1, 'one page, and it WAS read');
    assert.equal(summary.unverifiedPages, 0, 'the failed probe is not a page nobody could verify');
  });

  test('a dead link tried twice is ONE unverified page, not two', async () => {
    const { ctx, readNote } = contextWith({});
    const resolution = ['wiki/ghost.md', 'ghost.md'];
    for (const tryPath of resolution) {
      await ctx.read(tryPath, { page: 'ghost.md', resolution }).catch(() => {});
    }
    assert.equal(readNote.calls.length, 2, 'both spellings were tried');
    const summary = ctx.finalize([]);
    assert.equal(summary.unverifiedPages, 1);
    assert.equal(summary.inspectedPages, 0);
  });

  test('ANNOTATING BY CANDIDATE SPELLINGS — the first that answers wins', async () => {
    // How a wikilink neighbour is resolved: it names a page, not a file, so
    // `wiki/<name>.md` is tried and then `<name>.md`.
    const notes = { 'root.md': note({ valid_through: '2025-12-31' }) };
    const { ctx, readNote } = contextWith(notes, { budget: { neighbors: 5 } });
    const entries = [{ path: 'root.md' }];

    await ctx.annotate(entries, {
      collection: 'neighbors',
      pathsOf: (e) => [`wiki/${e.path}`, e.path],
      pageOf: (e) => e.path,
    });

    assert.deepEqual(readNote.calls, ['wiki/root.md', 'root.md']);
    assert.equal(entries[0].validity.state, 'no-longer-in-force');
    const summary = ctx.finalize(entries);
    assert.equal(summary.inspectedPages, 1, 'one page, two spellings');
    assert.equal(summary.unverifiedPages, 0);
  });

  test('and two spellings cost the quota ONE page, not two', async () => {
    // The quota counts pages. Charging per spelling would halve a declared
    // budget the moment the first guess stopped being the lucky one.
    const notes = { 'a.md': note({}), 'b.md': note({}) };
    const { ctx } = contextWith(notes, { budget: { neighbors: 2 } });
    const entries = [{ path: 'a.md' }, { path: 'b.md' }];
    await ctx.annotate(entries, {
      collection: 'neighbors',
      pathsOf: (e) => [`wiki/${e.path}`, e.path],
      pageOf: (e) => e.path,
    });
    assert.equal(ctx.remaining('neighbors'), 0);
    assert.equal(ctx.finalize(entries).inspectedPages, 2, 'both pages were reached');
  });

  test('SEVERAL spellings without a `pageOf` is refused, not guessed', async () => {
    // Raised by the adversarial review. Defaulting the page identity to the
    // first candidate is right for a single spelling; with several, two entries
    // resolving to the same page but listing their spellings in a different
    // order would count as two pages — read twice, charged twice, and reported
    // as two. No shipped caller does this, which is exactly why a silent wrong
    // count would have gone unnoticed.
    const { ctx, readNote } = contextWith({ 'wiki/a.md': note({}) }, { budget: { chunks: 5 } });
    await assert.rejects(
      () => ctx.annotate([{ path: 'a.md' }], {
        collection: 'chunks',
        // No `pageOf` — that IS the case under test. A bulk edit briefly added
        // one here and the test went green while proving nothing.
        pathsOf: (e) => [`wiki/${e.path}`, e.path],
      }),
      /ambiguous.*Pass `pageOf`/s,
    );
    assert.equal(readNote.calls.length, 0, 'and it is refused BEFORE any I/O');
  });

  test('a SINGLE spelling still needs no `pageOf` — the identity is unambiguous', async () => {
    // The mirror, so the guard cannot be mistaken for "pageOf is now mandatory".
    const { ctx } = contextWith({ 'wiki/a.md': note({ valid_through: '2025-12-31' }) }, { budget: { chunks: 5 } });
    const entries = [{ path: 'wiki/a.md' }];
    await ctx.annotate(entries, { collection: 'chunks' });
    assert.equal(entries[0].validity.state, 'no-longer-in-force');
    ctx.finalize(entries);
  });

  test('when every spelling fails, the entry is marked once', async () => {
    const { ctx, readNote } = contextWith({}, { budget: { neighbors: 5 } });
    const entries = [{ path: 'ghost.md' }];
    await ctx.annotate(entries, {
      collection: 'neighbors',
      pathsOf: (e) => [`wiki/${e.path}`, e.path],
      pageOf: (e) => e.path,
    });
    assert.equal(readNote.calls.length, 2);
    assert.equal(entries[0].validityUnverified, true);
    assert.equal(ctx.finalize(entries).unverifiedPages, 1);
  });

  test('a page the BUDGET skipped can still be read by a later collection', async () => {
    // Refused for lack of quota is not the same as tried and failed. The first
    // costs no I/O, so a collection that still has quota may pay for it.
    const notes = { 'wiki/a.md': note({ valid_through: '2025-12-31' }) };
    const { ctx, readNote } = contextWith(notes, { budget: { chunks: 0, neighbors: 1 } });

    const chunks = [{ path: 'wiki/a.md' }];
    await ctx.annotate(chunks, { collection: 'chunks' });
    assert.equal(readNote.calls.length, 0);
    assert.equal(chunks[0].validityUnverified, true);

    const neighbours = [{ path: 'wiki/a.md' }];
    await ctx.annotate(neighbours, { collection: 'neighbors' });
    assert.equal(readNote.calls.length, 1, 'the second collection paid for it');
    assert.equal(neighbours[0].validity.state, 'no-longer-in-force');

    const summary = ctx.finalize([...chunks, ...neighbours]);
    assert.equal(summary.inspectedPages, 1, 'the page ends the operation READ');
    assert.equal(summary.unverifiedPages, 0);
    assert.equal(summary.budgetExhausted, true, 'but the refusal really happened, and is still reported');
  });

  test('and every path tried is remembered, so a retry costs no I/O', async () => {
    const { ctx, readNote } = contextWith({});
    await ctx.read('wiki/ghost.md', { page: 'ghost.md' }).catch(() => {});
    await ctx.read('wiki/ghost.md', { page: 'ghost.md' }).catch(() => {});
    assert.equal(readNote.countFor('wiki/ghost.md'), 1);
  });
});

// ---------------------------------------------------------------------------
describe('finalize — what the response is allowed to claim', () => {
  const notes = {
    'wiki/a.md': note({ valid_through: '2025-12-31' }),
    'wiki/b.md': note({ valid_from: '2026-01-01' }),
    'wiki/silent.md': note({ type: 'concept' }),
  };

  test('annotatedEntries counts the entries RETURNED, not the entries annotated', async () => {
    // Called after the filter and the cut. An annotation on an entry the
    // consumer never receives is not something the response can claim.
    const { ctx } = contextWith(notes);
    const all = [{ path: 'wiki/a.md' }, { path: 'wiki/b.md' }];
    await ctx.annotate(all, { collection: 'chunks' });
    const returned = all.slice(0, 1);
    const summary = ctx.finalize(returned);
    assert.equal(summary.annotatedEntries, 1, 'one entry survived the cut');
    assert.equal(summary.inspectedPages, 2, 'but both pages were really read');
  });

  test('an entry with no window is not an annotated entry', async () => {
    const { ctx } = contextWith(notes);
    const entries = [{ path: 'wiki/silent.md' }, { path: 'wiki/a.md' }];
    await ctx.annotate(entries, { collection: 'chunks' });
    const summary = ctx.finalize(entries);
    assert.equal(summary.annotatedEntries, 1);
    assert.equal(summary.inspectedPages, 2, 'the silent page WAS inspected — it just declares nothing');
  });

  test('revisionCoherence is always there, and always says the same thing', async () => {
    const { ctx } = contextWith(notes);
    const summary = ctx.finalize([]);
    assert.equal(summary.revisionCoherence, REVISION_COHERENCE);
    assert.equal(summary.revisionCoherence, 'not-verified');
  });

  test('the summary carries the day, and it is the context\'s day', async () => {
    const { ctx } = contextWith(notes, { asOf: '2030-01-01' });
    assert.equal(ctx.finalize([]).asOf, '2030-01-01');
  });

  test('THE MODIFIED-PAGE WITNESS — the annotation reflects the READ, and says so', async () => {
    // A hit is retrieved from an index built earlier; the page changes; then we
    // read it. The window describes the page as read NOW, while the excerpt in
    // the envelope came from the older revision. That gap is real, it is not
    // checked, and `revisionCoherence` is the field that admits it.
    let served = 0;
    const readNote = async () => {
      served += 1;
      return served === 1
        ? note({ valid_through: '2099-12-31' })
        : note({ valid_through: '2025-12-31' });
    };
    // The index was built when the page was still in force; by read time the
    // author has closed the window.
    const stale = await readNote();
    assert.equal(stale.frontmatter.valid_through, '2099-12-31');

    const { ctx } = contextWith({}, { readNote });
    const entries = [{ path: 'wiki/moving.md', excerpt: 'text captured from the older revision' }];
    await ctx.annotate(entries, { collection: 'chunks' });

    assert.equal(entries[0].validity.state, 'no-longer-in-force',
      'the annotation reflects what the read returned, not what the index remembered');
    const summary = ctx.finalize(entries);
    assert.equal(summary.revisionCoherence, 'not-verified',
      'and the response admits the excerpt may not be from that revision');
  });

  test('after finalize the context holds nothing, and says so instead of lying', async () => {
    const { ctx } = contextWith(notes);
    await ctx.annotate([{ path: 'wiki/a.md' }], { collection: 'chunks' });
    ctx.finalize([]);
    await assert.rejects(() => ctx.annotate([], { collection: 'chunks' }), /after finalize/);
    assert.throws(() => ctx.read('wiki/a.md'), /after finalize/);
    assert.throws(() => ctx.finalize([]), /after finalize/);
  });
});

// ---------------------------------------------------------------------------
describe('the shared conformance corpus, replayed through the ANNOTATOR', () => {
  // The fourth door the same 23 documents pass through. Here they arrive as
  // simulated REST notes, which is how the annotator meets a page in
  // production. The frontmatter is produced by the router's line parser, so the
  // two divergent cases pin ITS answer; the block after this one pins what
  // Obsidian was MEASURED to hand over, which is what production will do.

  for (const testCase of TEMPORAL_VALIDITY_CASES) {
    test(`case: ${testCase.id}`, async () => {
      const { frontmatter } = parseFrontmatter(testCase.markdown);
      const { ctx } = contextWith(
        { 'wiki/case.md': note(frontmatter) },
        { asOf: testCase.asOf },
      );
      const entries = [{ path: 'wiki/case.md' }];
      await ctx.annotate(entries, { collection: 'chunks' });

      if (testCase.expect.state === null) {
        assert.equal('validity' in entries[0], false, testCase.note ?? testCase.id);
      } else {
        assert.equal(entries[0].validity.state, testCase.expect.state, testCase.note ?? testCase.id);
      }
      assert.equal('validityUnverified' in entries[0], false, 'the note was read — nothing is unverified here');
      ctx.finalize(entries);
    });
  }

  test('the corpus exercises every state AND the silence through this consumer', async () => {
    // The denominator. A corpus that never reaches a state proves nothing
    // about it.
    const seen = new Set();
    let silent = 0;
    for (const testCase of TEMPORAL_VALIDITY_CASES) {
      const { frontmatter } = parseFrontmatter(testCase.markdown);
      const { ctx } = contextWith({ 'wiki/case.md': note(frontmatter) }, { asOf: testCase.asOf });
      const entries = [{ path: 'wiki/case.md' }];
      await ctx.annotate(entries, { collection: 'chunks' });
      if (entries[0].validity === undefined) silent += 1;
      else seen.add(entries[0].validity.state);
      ctx.finalize(entries);
    }
    assert.deepEqual([...seen].sort(), ['in-force', 'no-longer-in-force', 'not-yet-in-force', 'unreadable']);
    assert.ok(silent >= 3, `the corpus must exercise silence too, got ${silent}`);
  });
});

// ---------------------------------------------------------------------------
describe('fed the values Obsidian was MEASURED to return', () => {
  // Phase 4a.1's stop-gate, turned into standing tests. These are not plausible
  // values, they are the ones measured on 2026-09-11 through the same wire
  // `getNote` crosses. If a future Obsidian changes any of them, the phase 4a
  // contract changes with it, and these are where that shows up.

  const MEASURED = [
    ['a bare ISO date arrives as a plain STRING', { valid_from: '2026-01-01' }, 'in-force'],
    ['a quoted date is indistinguishable from a bare one', { valid_from: '2026-01-01' }, 'in-force'],
    ['a typed null arrives as null', { valid_from: null }, null],
    ['an empty key arrives as null too', { valid_from: null }, null],
    ['a quoted "null" arrives as the STRING null, and is still treated as absent', { valid_from: 'null' }, null],
  ];

  for (const [label, frontmatter, expected] of MEASURED) {
    test(label, async () => {
      const { ctx } = contextWith({ 'wiki/m.md': note(frontmatter) });
      const entries = [{ path: 'wiki/m.md' }];
      await ctx.annotate(entries, { collection: 'chunks' });
      if (expected === null) assert.equal('validity' in entries[0], false);
      else assert.equal(entries[0].validity.state, expected);
      ctx.finalize(entries);
    });
  }

  test('THE REQUIREMENT PHASE 4a INHERITS — a non-scalar bound reaches the helper INTACT', async () => {
    // The measured fact: Obsidian hands over an OBJECT here. The router's line
    // parser flattens the same page to an empty string, which normalises to
    // absent, so the page reads as a tidy open-ended window IN FORCE — a
    // confident wrong answer about a malformed page. The annotator must pass
    // through what the reader gave it and let the helper refuse it.
    const { ctx } = contextWith({
      'wiki/block.md': note({ valid_from: { date: '2026-01-01' }, valid_through: '2026-12-31' }),
    });
    const entries = [{ path: 'wiki/block.md' }];
    await ctx.annotate(entries, { collection: 'chunks' });

    assert.equal(entries[0].validity.state, 'unreadable',
      'if this says in-force, something between the reader and the helper flattened the bound');
    assert.deepEqual(entries[0].validity.problems, ['valid_from:not-a-string']);
    ctx.finalize(entries);
  });

  test('a nested key declares nothing, and the entry stays silent', async () => {
    const { ctx } = contextWith({
      'wiki/nested.md': note({ validity: { valid_from: '2027-01-01' } }),
    });
    const entries = [{ path: 'wiki/nested.md' }];
    await ctx.annotate(entries, { collection: 'chunks' });
    assert.equal('validity' in entries[0], false,
      'top level only — a nested key is not a declaration');
    ctx.finalize(entries);
  });
});

// ---------------------------------------------------------------------------
describe('the dependence on the helper is OBSERVABLE from here', () => {
  // The third consumer, and its own mutation witnesses. Break a bound
  // comparison in the helper and these go red WITHOUT this file being touched.
  // Each witness guards ONE rule: the phase-3 mutation run found that a
  // consumer can guard the end bound and prove nothing about the start.

  async function stateFor(frontmatter) {
    const { ctx } = contextWith({ 'wiki/w.md': note(frontmatter) });
    const entries = [{ path: 'wiki/w.md' }];
    await ctx.annotate(entries, { collection: 'chunks' });
    ctx.finalize(entries);
    return entries[0].validity?.state ?? null;
  }

  test('a window ENDING today is in force — the end bound is included', async () => {
    assert.equal(await stateFor({ valid_from: '2026-01-01', valid_through: TODAY }), 'in-force');
  });

  test('and the day after it is not', async () => {
    assert.equal(await stateFor({ valid_from: '2026-01-01', valid_through: '2026-06-14' }), 'no-longer-in-force');
  });

  test('a window STARTING today is in force — the start bound is included', async () => {
    assert.equal(await stateFor({ valid_from: TODAY }), 'in-force');
  });

  test('and the day before it is not', async () => {
    assert.equal(await stateFor({ valid_from: '2026-06-16' }), 'not-yet-in-force');
  });

  test('an inverted window is unreadable, never a future one', async () => {
    assert.equal(await stateFor({ valid_from: '2027-01-01', valid_through: '2025-12-31' }), 'unreadable');
  });
});

// ---------------------------------------------------------------------------
describe('what a read is allowed to conclude — the three holes of 2026-09-16', () => {
  // All three were found by the adversarial review, and all three share a
  // shape: a fact established at one moment survived into a moment where it was
  // no longer true.

  test('a transport failure stops the resolution instead of trying another page', async () => {
    // `wiki/x.md` answers 503; `x.md` exists and is expired. Falling through
    // used to attribute the SECOND file's window to an entry that names the
    // first — and, under a filter, get it excluded on a date from elsewhere.
    const readNote = readerOver(
      { 'x.md': note({ valid_through: '2020-01-01' }) },
      { fail: new Map([['wiki/x.md', Object.assign(new Error('Service Unavailable'), { status: 503 })]]) },
    );
    const { ctx } = contextWith({}, { readNote });
    const entries = [{ path: 'x' }];
    await ctx.annotate(entries, {
      collection: 'neighbors',
      pathsOf: () => ['wiki/x.md', 'x.md'],
      pageOf: () => 'x.md',
    });
    ctx.finalize(entries);
    assert.equal(entries[0].validityUnverified, true, 'unverified — nobody could look');
    assert.equal(entries[0].validity, undefined, "and no window from the other file");
    assert.deepEqual(readNote.calls, ['wiki/x.md'], 'the second spelling was never tried');
  });

  test('a 404 DOES license the next spelling — the rule is narrow, not a blanket stop', async () => {
    // The control for the witness above. Without it, "stops on error" and
    // "stops on every error" look the same, and the two-spelling resolution the
    // catalogue depends on would be silently dead.
    const readNote = readerOver({ 'x.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote });
    const entries = [{ path: 'x' }];
    await ctx.annotate(entries, {
      collection: 'neighbors',
      pathsOf: () => ['wiki/x.md', 'x.md'],
      pageOf: () => 'x.md',
    });
    ctx.finalize(entries);
    assert.deepEqual(readNote.calls, ['wiki/x.md', 'x.md']);
    assert.equal(entries[0].validity?.state, 'in-force');
  });

  test('a successful read ERASES a window the entry arrived with', async () => {
    // Invariant 1. `classifyValidity` returns null for a page that declares
    // nothing, and the early return left whatever was already on the entry —
    // so a `validity` key this router never wrote decided the filter.
    const { ctx } = contextWith({ 'wiki/w.md': note({ title: 'no window here' }) });
    const entries = [{
      path: 'wiki/w.md',
      validity: { state: 'no-longer-in-force', from: null, through: '2020-01-01', asOf: TODAY },
    }];
    await ctx.annotate(entries, { collection: 'chunks' });
    ctx.finalize(entries);
    assert.equal(entries[0].validity, undefined, 'the stale window is gone');
    assert.equal(entries[0].validityUnverified, undefined, 'and nothing was marked either');
  });

  test('a page already READ is never charged to a quota again, under any spelling', async () => {
    // Round 6. The quota buys an I/O, and `pages` is keyed by the identity a
    // caller declares — so two callers naming one file differently (the drill
    // reads the page `x.md`, a collection names the file `wiki/x.md`) made the
    // second one spend a quota it did not need. With none left it then REFUSED
    // an entry whose page had already been read, and the summary reported the
    // same file as one page inspected AND one page unverified.
    const readNote = readerOver({ 'wiki/x.md': note({ valid_through: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote, budget: { primary: UNMETERED, chunks: 0 } });
    await ctx.read('wiki/x.md', { page: 'x.md' });

    const chunk = { path: 'wiki/x.md' };
    await ctx.annotate([chunk], { collection: 'chunks' });

    assert.equal(chunk.validityUnverified, undefined, 'the chunk found the read, not a closed budget');
    assert.equal(chunk.validity?.state, 'no-longer-in-force');
    const summary = ctx.finalize([chunk]);
    assert.equal(readNote.countFor('wiki/x.md'), 1, 'one read');
    assert.equal(summary.inspectedPages, 1, 'one page');
    assert.equal(summary.unverifiedPages, 0, 'and not ALSO an unverified one');
    assert.equal(summary.budgetExhausted, false);
  });

  test('ONE cached candidate does not make a whole resolution free', async () => {
    // Round 7. The exemption asked `some`, so a resolution whose SECOND
    // spelling happened to be cached was waved through entirely — and its
    // FIRST spelling, a file nobody had touched, was then read for free while
    // the quota said zero. A resolution costs nothing only when nothing in it
    // can reach the reader.
    const readNote = readerOver({
      'wiki/root.md': note({ valid_from: '2020-01-01' }),
      'root.md': note({ valid_from: '2020-01-01' }),
    });
    const { ctx } = contextWith({}, { readNote, budget: { chunks: 0 } });
    await ctx.read('root.md', { page: 'seed' });

    const entry = { path: 'root' };
    await ctx.annotate([entry], {
      collection: 'chunks',
      pageOf: () => 'root',
      pathsOf: () => ['wiki/root.md', 'root.md'],
    });

    assert.equal(readNote.countFor('wiki/root.md'), 0, 'the unread spelling stayed unread');
    assert.equal(entry.validityUnverified, true, 'and the entry was refused, as a zero budget means');
    assert.equal(ctx.finalize([entry]).budgetExhausted, true);
  });

  test('and a resolution ENTIRELY cached really is free', async () => {
    // The control: narrowing `some` to `every` must not have closed the door
    // the exemption exists to open.
    const readNote = readerOver({ 'wiki/root.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote, budget: { chunks: 0 } });
    await ctx.read('wiki/root.md', { page: 'seed' });

    const entry = { path: 'root' };
    await ctx.annotate([entry], {
      collection: 'chunks',
      pageOf: () => 'root',
      pathsOf: () => ['wiki/root.md'],
    });
    assert.equal(entry.validity?.state, 'in-force');
    assert.equal(readNote.countFor('wiki/root.md'), 1, 'served from the cache');
  });

  test('two entries of ONE pass naming one file share the reservation', async () => {
    // Round 7. The reservation loop is synchronous, so the attempt cache is
    // still empty while it runs and `pageKey` alone could not see that the read
    // had already been paid for: with a quota of one, the second entry was
    // refused for a budget its own read never spent. The resolution is what was
    // reserved, so entries that share one are reserved together.
    const readNote = readerOver({ 'wiki/x.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote, budget: { chunks: 1 } });
    const entries = [
      { path: 'wiki/x.md', id: 'x' },
      { path: 'wiki/x.md', id: 'wiki/x.md' },
    ];
    await ctx.annotate(entries, { collection: 'chunks', pageOf: (e) => e.id });

    assert.equal(readNote.countFor('wiki/x.md'), 1, 'one read, as invariant 10 says');
    assert.equal(entries[0].validity?.state, 'in-force');
    assert.equal(entries[1].validityUnverified, undefined, 'the second entry was not refused');
    assert.equal(entries[1].validity?.state, 'in-force');
    assert.equal(ctx.finalize(entries).budgetExhausted, false);
  });

  test('a stale refusal is reconciled when a shared read answers under an alias', async () => {
    // Round 7. One FILE under two identities — the mirror of the limit this
    // module accepts, and not covered by it. An identity refused for budget
    // kept `inspected: false` although the very read it was waiting for then
    // succeeded under another name, so the summary reported one file as one
    // page inspected AND one page unverified.
    const readNote = readerOver({ 'wiki/x.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote, budget: { chunks: 0 } });
    const entry = { path: 'wiki/x.md' };

    await ctx.annotate([entry], { collection: 'chunks' });
    assert.equal(entry.validityUnverified, true, 'refused for budget, as it should be');

    await ctx.read('wiki/x.md', { page: 'x' });
    await ctx.annotate([entry], { collection: 'chunks' });

    assert.equal(entry.validity?.state, 'in-force', 'the entry ends up verified');
    assert.equal(entry.validityUnverified, undefined);
    const summary = ctx.finalize([entry]);
    assert.equal(readNote.countFor('wiki/x.md'), 1, 'one read');
    assert.equal(summary.unverifiedPages, 0, 'and no page is left claiming nobody looked');
  });

  test('but a page nobody has touched still costs its quota', async () => {
    // The control: the exemption above is about I/O already in flight, not a
    // general amnesty. Without it, a budget of zero would stop meaning zero.
    const readNote = readerOver({ 'wiki/y.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote, budget: { chunks: 0 } });
    const entry = { path: 'wiki/y.md' };
    await ctx.annotate([entry], { collection: 'chunks' });
    assert.equal(entry.validityUnverified, true);
    assert.equal(readNote.calls.length, 0, 'and no read was spent');
    assert.equal(ctx.finalize([entry]).budgetExhausted, true);
  });

  test('THE PAGE COUNTS ARE COUNTS OF DECLARED IDENTITIES — the stated limit', async () => {
    // Written down rather than policed. A guard that refused two identities for
    // one file was added in round 2 and removed in round 6: no shipped caller
    // ever produced the miscount, and the guard itself broke legitimate
    // composition twice — after a drill resolved a page through two spellings,
    // annotating that page by the spelling that had ANSWERED was refused.
    //
    // So this is the behaviour, asserted so nobody has to rediscover it: two
    // different files given one identity are one page, and a later success
    // overwrites an earlier failure.
    const readNote = readerOver({ 'wiki/x.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote });
    const chunk = { path: 'x.md' };
    await ctx.annotate([chunk], { collection: 'chunks' });
    assert.equal(chunk.validityUnverified, true, 'that entry really could not be read');

    const neighbour = { path: 'x' };
    await ctx.annotate([neighbour], {
      collection: 'neighbors',
      pathsOf: () => ['wiki/x.md', 'x.md'],
      pageOf: () => 'x.md',
    });
    assert.equal(neighbour.validity?.state, 'in-force', 'and this one really was read');

    const summary = ctx.finalize([chunk, neighbour]);
    assert.equal(summary.inspectedPages, 1, 'ONE identity, so one page');
    assert.equal(summary.unverifiedPages, 0, 'the success is what the identity ends up saying');
    // The entry itself never lies, which is what makes the limit affordable:
    // the reader of a hit always sees whether ITS window was established.
    assert.equal(chunk.validityUnverified, true);
  });

  test('and two spellings the READER treats as one are one resolution, not a conflict', async () => {
    // The guard must speak the reader's language. `read` normalises with
    // `cacheKeyFor`, so `./wiki/a.md` and `wiki/a.md` are one read of one file;
    // the first version of this guard compared the raw strings and threw on a
    // caller that had done nothing wrong — a repair inventing its own failure.
    const readNote = readerOver({ 'wiki/a.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote });
    await ctx.annotate([{ path: './wiki/a.md' }], { collection: 'primary' });
    await ctx.annotate([{ path: 'wiki/a.md' }], { collection: 'chunks' });
    const summary = ctx.finalize([]);
    assert.equal(readNote.countFor('wiki/a.md'), 1, 'one read');
    assert.equal(summary.inspectedPages, 1, 'one page');
  });

  test('duplicate spellings that collapse to one key are ONE resolution', async () => {
    // Round 3, BLOQUANT. The signature normalised its candidates but kept their
    // duplicates, so `['x.md']` and `['x.md', './x.md']` compared unequal —
    // two lists that can only ever read one file, and a legitimate third-party
    // call made to fail by a guard that was supposed to protect counting.
    const readNote = readerOver({ 'wiki/x.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote });
    await ctx.annotate([{ path: 'wiki/x.md' }], { collection: 'primary' });
    await ctx.annotate([{}], {
      collection: 'chunks',
      pageOf: () => 'wiki/x.md',
      pathsOf: () => ['wiki/x.md', './wiki/x.md'],
    });
    const summary = ctx.finalize([]);
    assert.equal(readNote.countFor('wiki/x.md'), 1);
    assert.equal(summary.inspectedPages, 1);
  });

  test('the page key normaliser is IDEMPOTENT, as a property and not as a list', async () => {
    // Twice now a hand-picked input showed the property was false — `././x.md`
    // in round 3, `./ x.md` in round 4, where stripping the prefix EXPOSES a
    // space the next trim removes. Each repair closed its own input. So the
    // property itself is the test: the identity a caller declares must survive
    // being normalised twice, because `reserve` and `read` each normalise once.
    const shapes = [
      'x.md', ' x.md ', './x.md', '././x.md', './././x.md', './ x.md', ' ./ ./x.md',
      'wiki//x.md', './wiki///a//b.md', './/x.md', './', '.', '', '   ',
      'wiki/x.md#a', './wiki/note#2.md', './.x.md', '..//x.md',
    ];
    for (const raw of shapes) {
      // Probed through the PUBLIC surface, and in THIS order: the budget is
      // exhausted FIRST, so the page is recorded by `reserve` under the
      // identity it normalised once, and only then read — which records it
      // again under whatever a second normalisation produces. The other order
      // no longer sees anything, because a spelling already in flight is exempt
      // from the quota; measuring that was what showed this witness had to be
      // turned around to keep proving its property.
      // A reader that answers WHATEVER path it is given. Restating the
      // normaliser in the fixture is how this test broke itself once: the
      // fixture kept an older spelling of the rule, so the assertion failed on
      // correct code. The property is about sharing, not about the key.
      const calls = [];
      const readNote = async (_vault, p) => { calls.push(p); return note({}); };
      readNote.calls = calls;
      const { ctx } = contextWith({}, { readNote, budget: { chunks: 0, primary: UNMETERED } });
      const a = { path: raw };
      const b = { path: raw };
      await ctx.annotate([a], { collection: 'chunks' });
      await ctx.annotate([b], { collection: 'primary' });
      const summary = ctx.finalize([a, b]);
      assert.ok(
        summary.inspectedPages + summary.unverifiedPages <= 1,
        `${JSON.stringify(raw)}: counted as ${summary.inspectedPages} inspected + ${summary.unverifiedPages} unverified`,
      );
      // A path that names NO page at all — `''`, `'.'`, `'./'` — is marked and
      // counted as no page, which is right and is not what this property is
      // about. The sharing assertion applies to the ones that name something.
      if (calls.length > 0) {
        assert.equal(
          b.validityUnverified, undefined,
          `${JSON.stringify(raw)}: the second collection did not find the page the first recorded`,
        );
      }
    }
  });

  test('a page named with a REPEATED `./` is one page, not two', async () => {
    // Round 3, MAJEUR. `reserve` normalises the identity and `read` normalises
    // it again, so the normaliser has to be idempotent. Stripping one `./` at a
    // time was not: `././x.md` became `./x.md`, then `x.md`, and the page the
    // first collection had read was not found by the second — which refused the
    // entry for budget and reported the same page as BOTH inspected and
    // unverified. The second collection has NO quota on purpose: that is what
    // turns the mismatch into a visible wrong count.
    const readNote = readerOver({ 'wiki/x.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, {
      readNote,
      budget: { primary: 1, chunks: 0, neighbors: UNMETERED },
    });
    const a = { path: '././wiki/x.md' };
    const b = { path: '././wiki/x.md' };
    await ctx.annotate([a], { collection: 'primary' });
    await ctx.annotate([b], { collection: 'chunks' });
    const summary = ctx.finalize([a, b]);
    assert.equal(b.validityUnverified, undefined, 'the second entry found the page already read');
    assert.equal(b.validity?.state, 'in-force');
    assert.equal(summary.inspectedPages, 1, 'one page');
    assert.equal(summary.unverifiedPages, 0, 'and it is not ALSO unverified');
    assert.equal(summary.budgetExhausted, false, 'no budget was needed for a page already read');
  });

  test('and the SAME resolution, reached twice, is free — the guard is about disagreement', async () => {
    // The control. A page touched by two collections through the same spellings
    // is one page, read once, charged once. Refusing that would break the
    // sharing the context pack depends on.
    const readNote = readerOver({ 'wiki/a.md': note({ valid_from: '2020-01-01' }) });
    const { ctx } = contextWith({}, { readNote });
    await ctx.annotate([{ path: 'wiki/a.md' }], { collection: 'primary' });
    await ctx.annotate([{ path: 'wiki/a.md' }], { collection: 'chunks' });
    const summary = ctx.finalize([]);
    assert.equal(readNote.countFor('wiki/a.md'), 1, 'one read');
    assert.equal(summary.inspectedPages, 1, 'one page');
  });

  test('a page refused by one budget, then read by another, stops being unverified', async () => {
    // Two collections, the first with no quota at all. The entry was marked
    // unverified there; the second collection had quota and read the page —
    // and the mark stayed, on top of the new window. The filter reads the mark
    // FIRST, so an expired page that HAD been read was kept as if nobody had
    // looked at it.
    const { ctx } = contextWith(
      { 'wiki/w.md': note({ valid_through: '2020-01-01' }) },
      { budget: { chunks: 0, neighbors: UNMETERED } },
    );
    const entry = { path: 'wiki/w.md' };

    await ctx.annotate([entry], { collection: 'chunks' });
    assert.equal(entry.validityUnverified, true, 'refused for budget, as it should be');

    await ctx.annotate([entry], { collection: 'neighbors' });
    assert.equal(entry.validityUnverified, undefined, 'the mark did not survive the read');
    assert.equal(entry.validity?.state, 'no-longer-in-force', 'and the real window is there');
  });
});
