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

    let resolved = null;
    for (const tryPath of ['wiki/root.md', 'root.md']) {
      try {
        resolved = await ctx.read(tryPath, { page: 'root.md' });
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
    for (const tryPath of ['wiki/ghost.md', 'ghost.md']) {
      await ctx.read(tryPath, { page: 'ghost.md' }).catch(() => {});
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
    });
    assert.equal(ctx.remaining('neighbors'), 0);
    assert.equal(ctx.finalize(entries).inspectedPages, 2, 'both pages were reached');
  });

  test('when every spelling fails, the entry is marked once', async () => {
    const { ctx, readNote } = contextWith({}, { budget: { neighbors: 5 } });
    const entries = [{ path: 'ghost.md' }];
    await ctx.annotate(entries, {
      collection: 'neighbors',
      pathsOf: (e) => [`wiki/${e.path}`, e.path],
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
