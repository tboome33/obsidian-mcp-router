/**
 * Temporal validity — the annotation context (roadmap phase 4a.1).
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. The purity lives one module
 * down, in `temporal-validity.mjs`: given a frontmatter object and a day, it
 * says whether the page applies. This module is the opposite kind of thing —
 * an asynchronous orchestrator with injected dependencies, whose whole job is
 * the bookkeeping that a real tool call needs and a pure function must not
 * know about: one read per page per operation, failures remembered rather than
 * retried, a quota per collection, and a summary that says what was actually
 * looked at.
 *
 * THE ONE READ DOOR. `ctx.read` is the only place an operation reads a note.
 * That is not tidiness, it is the only way to guarantee one attempt per page:
 * a tool that reads its primary pages directly and registers them afterwards
 * has already made the second I/O by the time it could have deduplicated, and
 * two concurrent reads of the same path cannot be merged after the fact. So
 * the context is created BEFORE the first read of the operation, and the drill
 * that needs a page's BODY and the annotator that needs only its FRONTMATTER
 * consume two projections of the same single read.
 *
 * PATHS ARE CACHED, PAGES ARE COUNTED. Those are different units and conflating
 * them produces a wrong number. Resolving one catalogue entry can try several
 * paths — `wiki/x.md` first, then `x.md` — and every path tried is remembered
 * with its outcome so it is never tried twice. But the summary counts PAGES:
 * two probes for one dead link is one page nobody could verify, not two. The
 * caller says which attempts belong to the same page via `page`.
 *
 * NOTHING IS EVER HIDDEN. A page that could not be read, or that the budget
 * never reached, leaves its entry in place and marks it `validityUnverified`.
 * An entry is never dropped, and silence never means "no window".
 */

import {
  STATE_UNREADABLE,
  classifyValidity,
  resolveAsOf,
} from './temporal-validity.mjs';
import { isMissingReadError } from './missing-read-guard.mjs';

/**
 * The window describes the page as it was read AT QUERY TIME, not the revision
 * an excerpt came from. Stated as a constant in every summary rather than left
 * for a consumer to wonder about (decision D4).
 */
export const REVISION_COHERENCE = 'not-verified';

/** A quota of `null` means explicitly unmetered — never the absence of a key. */
export const UNMETERED = null;

/** Marks an entry whose window could not be established. */
export const UNVERIFIED_KEY = 'validityUnverified';

/** Carries the window when one is declared and readable. */
export const VALIDITY_KEY = 'validity';

function annotatorError(message) {
  const err = new Error(`validity-annotator: ${message}`);
  err.kind = 'validation';
  return err;
}

/** The path an entry points at, when the caller has not said otherwise. */
function defaultPathOf(entry) {
  return entry && typeof entry.path === 'string' ? entry.path : '';
}

/**
 * ONE ENTRY, SEVERAL SPELLINGS.
 *
 * Neither the catalogue nor a wikilink addresses a file: both name a page, and
 * the router resolves it by trying `wiki/<name>.md` and then `<name>.md`. That
 * is one page and up to two I/Os, so the caller may hand over a list and the
 * first success wins. The quota is debited once, because the quota counts
 * pages; the cache still records every spelling, because the cache prevents
 * repeated I/O.
 */
function toCandidateList(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p !== '');
}

/**
 * The cache key for a path. Deliberately NOT `canonicalVaultPath`: that guard
 * throws on a spelling it refuses, and a hostile path arriving from a bridge
 * payload must mark one entry unverified, never abort the whole operation. So
 * the key is a cheap normalisation, and the REAL guard stays where it belongs,
 * in the injected reader.
 */
function cacheKeyFor(path) {
  // IDEMPOTENT BY CONSTRUCTION, because it has to be idempotent and because
  // getting there case by case failed twice.
  //
  // `reserve` normalises the page identity once and `read` normalises it again,
  // so a normaliser that still moves on the second pass gives the two steps
  // different keys: a page read by one collection is not found by the next,
  // which refuses the entry for lack of budget and reports the same page as
  // BOTH inspected and unverified. Round 3 found it with `././x.md` (one `./`
  // stripped per pass) and round 4 found it again with `./ x.md`, where
  // stripping the prefix EXPOSES a space that only the next `trim()` removes.
  // Each fix closed its own input and left the property false.
  //
  // So the rules are applied until they stop changing anything. Every rule only
  // ever removes characters, so the loop shortens the string or stops — and
  // `f(f(x)) === f(x)` holds for every input, not for the ones we thought of.
  let key = String(path);
  for (;;) {
    const next = key.trim().replace(/^(?:\.\/)+/, '').replace(/\/{2,}/g, '/');
    if (next === key) return next;
    key = next;
  }
}

/**
 * Create the annotation context for ONE vault and ONE operation.
 *
 * @param {object} options
 * @param {object} options.vault           the resolved vault, bound at construction
 * @param {(vault: object, path: string) => Promise<object>} options.readNote
 * @param {string} [options.asOf]          reference day; defaults to today in UTC
 * @param {object} options.budget          `{ <collection>: number | UNMETERED }`
 * @param {Date}   [options.now]           injectable clock, for the default day
 */
export function createValidityContext({ vault, readNote, asOf, budget, now } = {}) {
  if (!vault) throw annotatorError('a vault is required — one context per vault, bound at construction');
  if (typeof readNote !== 'function') throw annotatorError('`readNote` must be a function');
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    throw annotatorError('`budget` must be an object of per-collection quotas — a tool never leaves them implicit');
  }

  // RESOLVED ONCE, FIRST. Two entries of one response are never classified on
  // different days (invariant 8), and a bad `asOf` fails the call here rather
  // than halfway through it — the same ordering the helper was corrected to.
  const day = resolveAsOf(asOf, now ?? new Date());

  const quotas = new Map();
  for (const [collection, value] of Object.entries(budget)) {
    if (value !== UNMETERED && (!Number.isInteger(value) || value < 0)) {
      throw annotatorError(`quota for "${collection}" must be a non-negative integer or UNMETERED, got ${JSON.stringify(value)}`);
    }
    quotas.set(collection, value);
  }

  /** path -> { promise } — every path ever ATTEMPTED, so none is attempted twice. */
  const attempts = new Map();
  /**
   * page -> { inspected, attempted } — the unit the summary counts, and the
   * unit the quota buys. `attempted: false` is the budget case: the page is
   * known about and counted unverified, but no I/O was ever spent on it, so a
   * later collection with quota left may still pay to read it.
   */
  const pages = new Map();
  let budgetExhausted = false;
  let released = false;

  function assertLive(what) {
    if (released) throw annotatorError(`${what} was called after finalize — the context holds no notes any more`);
  }

  function quotaFor(collection) {
    if (!quotas.has(collection)) {
      throw annotatorError(
        `no quota declared for collection "${collection}" — declare it in \`budget\`, `
        + 'as a number or UNMETERED. An undeclared collection is an implicit budget, which is the thing this refuses.',
      );
    }
    return quotas.get(collection);
  }

  /**
   * WHAT THE PAGE COUNTS ARE COUNTS OF, stated because a guard that tried to
   * enforce more than this cost more than it was worth.
   *
   * `inspectedPages` and `unverifiedPages` count the page IDENTITIES a caller
   * declared, not files on disk. A caller that hands two different files the
   * same `pageOf` gets them counted as one page — and, because a later success
   * overwrites an earlier failure, counted as inspected.
   *
   * THAT LIMIT USED TO BE A GUARD, AND THE GUARD WAS WORSE. Round 2 of the
   * adversarial review raised the miscount; rounds 3 to 6 then found four
   * defects in the guard itself, two of them breaking legitimate composition
   * outright: after a drill resolved a page through two spellings, annotating
   * that same page by the spelling that had ANSWERED was refused. No shipped
   * caller ever produced the miscount, and every shipped caller was at risk
   * from the guard. So the rule is written down instead of policed — the
   * honest trade, and a reversal of the round-2 decision rather than another
   * layer on top of it.
   */

    /**
   * A resolution's fingerprint: its normalised spellings, deduplicated, in
   * order. Kept apart from page identities in the same `granted` set by a
   * prefix no `cacheKeyFor` output can produce, so a reservation made for one
   * resolution cannot be mistaken for one made for a page called the same.
   */
  function signatureOf(keys) {
    // `resolution:` as a prefix, and a path can start with those characters —
    // so the JSON array that follows is what makes the two namespaces distinct:
    // a page identity is a bare string, a resolution is `resolution:[...]`.
    // Writing a control character here as a separator was tried twice and the
    // repo's source guard rejected it twice, correctly.
    return `resolution:${JSON.stringify([...new Set(keys)])}`;
  }

  /** Remember what became of a page, letting a later success overwrite a failure. */
  function recordPage(pageKey, { inspected, attempted }) {
    const previous = pages.get(pageKey);
    // A page read successfully on its second spelling is INSPECTED, even though
    // its first probe failed. Recording the failure and stopping there would
    // report a page nobody could verify while its content sits in the envelope.
    if (previous?.inspected) return;
    pages.set(pageKey, {
      inspected,
      // Once something was really tried, it stays tried: a later budget refusal
      // must not erase the fact that an I/O was spent.
      attempted: attempted || Boolean(previous?.attempted),
    });
  }

  /**
   * Read a note, at most once per path for the whole operation.
   *
   * @param {string} path
   * @param {object} [options]
   * @param {string} [options.page]  the logical page these attempts belong to
   */
  function read(path, { page } = {}) {
    assertLive('read');
    const key = cacheKeyFor(path);
    const pageKey = page === undefined ? key : cacheKeyFor(page);

    const existing = attempts.get(key);
    // A FAILURE IS A RESULT. Returning the stored promise replays the ORIGINAL
    // error object to every later caller, so `isMissingReadError` keeps telling
    // a dead wikilink from an unreachable vault, and the placeholder and the
    // `page-read-failed` warning keep meaning what they meant.
    // A PAGE IS RECORDED UNDER THE IDENTITY THAT FIRST NAMED IT, and a cache
    // hit adds nothing. Recording the second identity too was tried and made
    // one file count as two pages in the shipped flow, where the drill names a
    // page `tariff` and the primary collection names the same file
    // `wiki/tariff.md`. The miscount round 6 raised is real, but its cause is
    // in the RESERVATION below — a page already read must not be charged to a
    // quota again — and that is where it is fixed.
    if (existing) {
      // A STALE REFUSAL IS RECONCILED, and only a stale refusal. If this
      // identity was recorded as NOT verified — a budget refusal, or a probe
      // that failed — and the shared read then answered, the page really was
      // inspected and saying otherwise reports one file as both. Recording
      // unconditionally was tried in round 6 and counted one file as two pages
      // in the shipped flow, so nothing is added here: an identity nobody has
      // recorded stays unrecorded. (Round 7, 2026-09-16.)
      if (pages.get(pageKey)?.inspected === false) {
        existing.promise.then(
          () => recordPage(pageKey, { inspected: true, attempted: true }),
          () => {},
        );
      }
      return existing.promise;
    }

    const promise = Promise.resolve()
      .then(() => readNote(vault, key))
      .then(
        (note) => {
          recordPage(pageKey, { inspected: true, attempted: true });
          return note;
        },
        (error) => {
          recordPage(pageKey, { inspected: false, attempted: true });
          throw error;
        },
      );

    // Stored BEFORE anything awaits it, which is what makes two concurrent
    // readers of the same path share one I/O rather than race to create two.
    attempts.set(key, { promise });
    // A cached rejection nobody has awaited yet is still a rejection Node will
    // complain about. This marks it handled without consuming it — every caller
    // still receives the throw.
    promise.catch(() => {});
    return promise;
  }

  /**
   * What `annotate` decided to do about one entry, before any I/O starts.
   *
   * `granted` holds the pages already reserved EARLIER IN THIS SAME PASS, and
   * it is not an optimisation. The reservation loop is synchronous, so nothing
   * has been read yet and `pages` is still empty: without it, ten chunks of one
   * page each debited the quota, nine of them were refused for lack of budget,
   * and the response said nine entries could not be verified while the page had
   * been read successfully. The quota is documented to buy a PAGE; this is what
   * makes that true. Found by the phase 4b measurement on the real vault, where
   * a narrow query returned thirty chunks from two pages.
   */
  function reserve(entry, collection, pathsOf, pageOf, granted) {
    const candidates = toCandidateList(pathsOf(entry));
    // AN ENTRY THAT NAMES NO PAGE CANNOT BE VERIFIED, and must not be counted
    // as a page either — there is no page. It is marked, and that is all.
    if (candidates.length === 0) return { entry, kind: 'no-path' };

    // SEVERAL SPELLINGS WITHOUT A PAGE IDENTITY IS AMBIGUOUS, and guessing is
    // what miscounts. Defaulting the identity to the FIRST candidate is right
    // when there is only one; with several, two entries resolving to the same
    // page but listing their spellings in a different order would be treated as
    // two pages — read twice, counted twice, and each charged to the quota.
    // Refused rather than guessed: it is a caller's bug, and a silent wrong
    // count is exactly the kind of defect this module exists to avoid.
    // (Raised by the phase 4b adversarial review; no shipped caller trips it,
    // which is precisely why it would have gone unnoticed.)
    if (!pageOf && candidates.length > 1) {
      throw annotatorError(
        `annotate() was given ${candidates.length} candidate spellings for one entry but no \`pageOf\`, `
        + 'so which page they resolve to is ambiguous. Pass `pageOf` alongside `pathsOf`.',
      );
    }
    const pageKey = cacheKeyFor(pageOf ? pageOf(entry) : candidates[0]);

    // Already ATTEMPTED — by an earlier collection, or by the drill that read
    // the body — or already RESERVED by an earlier entry of this same pass.
    // Free, and never attempted again, whatever the outcome was.
    //
    // ASKED OF THE PATHS AS WELL AS OF THE IDENTITY. `pages` is keyed by the
    // identity a caller declares, and two callers legitimately name one file
    // differently: the drill reads it as the page `tariff`, the primary
    // collection as the file `wiki/tariff.md`. Looking only at the identity,
    // the second one saw nothing attempted, spent a quota it did not need, and
    // — with no quota left — refused an entry whose page had ALREADY been read,
    // reporting the same file as one page inspected and one page unverified.
    // The quota buys an I/O, so a resolution that needs none costs nothing.
    // (Adversarial review, round 6, 2026-09-16.)
    //
    // EVERY spelling, not any: `some` exempted a whole resolution because ONE
    // of its candidates was cached, and then let the others be read for free —
    // including the one that actually answered. A resolution is free only when
    // nothing in it can reach the reader. (Round 7.)
    const keys = candidates.map(cacheKeyFor);
    const noNewRead = keys.every((k) => attempts.has(k)) || granted.has(signatureOf(keys));
    if (pages.get(pageKey)?.attempted || granted.has(pageKey) || noNewRead) {
      granted.add(signatureOf(keys));
      return { entry, kind: 'read', candidates, pageKey };
    }

    const quota = quotaFor(collection);
    if (quota === UNMETERED) return { entry, kind: 'read', candidates, pageKey };
    if (quota > 0) {
      // Debited in ARRAY ORDER, before any await. The cache makes the debit
      // order-dependent — whichever collection touches a page first pays for
      // it — so the order has to be deterministic or two identical calls would
      // spend different quotas. One debit per PAGE, however many spellings its
      // resolution has to try.
      quotas.set(collection, quota - 1);
      granted.add(pageKey);
      // AND BY ITS RESOLUTION, because two entries of the same pass can name
      // one file under different identities — the reservation loop is
      // synchronous, so the attempt cache is still empty and `pageKey` alone
      // could not see that the read had already been paid for. The second entry
      // was then refused for a budget its own read had not spent. (Round 7.)
      granted.add(signatureOf(candidates.map(cacheKeyFor)));
      return { entry, kind: 'read', candidates, pageKey };
    }

    budgetExhausted = true;
    // NO ATTEMPT IS MADE. The entry stays, marked and counted; the roadmap is
    // explicit that reaching the budget must not cost the reader the entry.
    recordPage(pageKey, { inspected: false, attempted: false });
    return { entry, kind: 'over-budget', pageKey };
  }

  /**
   * Try each spelling in turn; the first that answers wins.
   *
   * ONLY "THAT FILE IS NOT THERE" LICENSES TRYING ANOTHER SPELLING. Falling
   * through on ANY error meant a 503 on `wiki/x.md` was answered by reading
   * `x.md` — a different file, whose window was then attributed to the entry
   * and could get it excluded. A transport failure says nothing about which
   * page the entry names, so it stops the resolution and leaves the entry
   * unverified, which is what "I could not look" is supposed to produce.
   * (Adversarial review, 2026-09-16.)
   */
  async function readFirst(candidates, pageKey) {
    let lastError = null;
    for (const candidate of candidates) {
      try {
        return await read(candidate, { page: pageKey });
      } catch (error) {
        lastError = error;
        if (!isMissingReadError(error)) throw error;
      }
    }
    throw lastError;
  }

  function markUnverified(entry) {
    delete entry[VALIDITY_KEY];
    entry[UNVERIFIED_KEY] = true;
  }

  function applyWindow(entry, frontmatter) {
    // A SUCCESSFUL READ REPLACES WHATEVER WAS THERE, and the early return below
    // made that untrue in two ways. An entry arriving with a `validity` key —
    // from a payload this router does not compose — kept it when the page it
    // really names declares nothing, so invariant 1 was broken by a field
    // nobody wrote here. And an entry refused by one collection's budget, then
    // read by another that still had quota, kept `validityUnverified` alongside
    // its new window: the filter reads the flag first, so a page that HAD been
    // read and HAD expired was kept as if nobody had looked.
    // (Adversarial review, 2026-09-16.)
    delete entry[VALIDITY_KEY];
    delete entry[UNVERIFIED_KEY];
    const result = classifyValidity(frontmatter, { asOf: day });
    // No window declared: the page makes no temporal claim, so the entry says
    // nothing at all. Invariant 1 — silence here is the correct answer, and it
    // is why `validity` is optional rather than nullable.
    if (result === null) return;
    const { state, from, through, problems } = result;
    entry[VALIDITY_KEY] = {
      state,
      from,
      through,
      asOf: day,
      // `problems` only where it means something. On a readable window it would
      // be an empty array on every entry of every response, which reads as a
      // field the consumer must check and never has anything to say.
      ...(state === STATE_UNREADABLE ? { problems } : {}),
    };
  }

  /**
   * Annotate entries in place, reading each page at most once per operation.
   *
   * @param {object[]} entries
   * @param {object} options
   * @param {string} options.collection            which quota to debit
   * @param {(entry: object) => string} [options.pathOf]   one spelling
   * @param {(entry: object) => string[]} [options.pathsOf] several, first wins
   * @param {(entry: object) => string} [options.pageOf]   the page they resolve
   */
  async function annotate(entries, {
    collection, pathOf = defaultPathOf, pathsOf, pageOf,
  } = {}) {
    assertLive('annotate');
    if (!Array.isArray(entries)) throw annotatorError('`entries` must be an array');
    if (typeof collection !== 'string' || collection === '') {
      throw annotatorError('`collection` is required — it names the quota this call debits');
    }
    // Fails on an undeclared collection even when there is nothing to annotate,
    // so a tool that mis-names a quota learns it on its first empty response
    // rather than on the first response that happens to carry entries.
    quotaFor(collection);

    const resolveCandidates = pathsOf ?? pathOf;
    // Pages this pass has already paid for. Scoped to the pass: a later call
    // consults `pages` instead, which by then records what really happened.
    const granted = new Set();
    const plan = entries.map((entry) => reserve(entry, collection, resolveCandidates, pageOf, granted));

    await Promise.all(plan.map(async (item) => {
      if (item.kind === 'no-path' || item.kind === 'over-budget') {
        markUnverified(item.entry);
        return;
      }
      try {
        const note = await readFirst(item.candidates, item.pageKey);
        const frontmatter = (note && note.frontmatter) || {};
        applyWindow(item.entry, frontmatter);
      } catch {
        // The error itself belongs to whoever asked for the CONTENT; here the
        // only thing to say is that the window is not established.
        markUnverified(item.entry);
      }
    }));

    return entries;
  }

  /**
   * Close the operation and describe what it looked at.
   *
   * `annotatedEntries` counts the entries actually RETURNED, so it must be
   * called after the filter and the cut to `limit` — an annotation on an entry
   * the consumer never receives is not something the response can claim.
   */
  function finalize(returnedEntries = []) {
    assertLive('finalize');
    if (!Array.isArray(returnedEntries)) throw annotatorError('`finalize` takes the array of entries actually returned');

    let inspectedPages = 0;
    let unverifiedPages = 0;
    for (const { inspected } of pages.values()) {
      if (inspected) inspectedPages += 1;
      else unverifiedPages += 1;
    }

    const summary = {
      asOf: day,
      annotatedEntries: returnedEntries.filter((e) => e && e[VALIDITY_KEY] !== undefined).length,
      inspectedPages,
      unverifiedPages,
      budgetExhausted,
      revisionCoherence: REVISION_COHERENCE,
    };

    // The notes are released here. `getNote` already carried the body, so the
    // only cost this cache ever added was RETENTION — holding the bodies of
    // chunks and neighbours whose annotation needed the frontmatter alone.
    attempts.clear();
    released = true;
    return summary;
  }

  return {
    get asOf() { return day; },
    get vault() { return vault; },
    read,
    annotate,
    finalize,
    /** Remaining quota, for tests and for a tool that wants to log it. */
    remaining(collection) { return quotaFor(collection); },
  };
}
