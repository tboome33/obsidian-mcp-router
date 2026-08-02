/**
 * C6 — source ledger + independence rule.
 *
 * The properties §2.17 demands, proven here:
 *   1. IDENTITY — a source is one entry whatever address it arrived under
 *      (RFC-equivalent URL spellings collapse), and credential-bearing URLs are
 *      REFUSED rather than stored.
 *   2. INDEPENDENCE — "two independent sources" counts distinct ORIGINS, so two
 *      articles from the same site count once; synthetic output and retired
 *      entries never corroborate.
 *   3. FORWARD-FILL ONLY — authority must be DECLARED, never inferred; nothing
 *      is back-filled; a human review survives a re-record but is invalidated
 *      when the content actually changed.
 *   4. STALENESS — a refresh horizon per authority tier, reported (not enforced)
 *      by a pure, clock-injected audit.
 * Plus the tool layer: compare-and-swap writes (C1) so parallel sessions cannot
 * clobber the shared ledger, and a read-only audit that never rewrites.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  registrableDomain,
  independenceKeyFor,
  countIndependentOrigins,
  sourceIdFor,
  buildSourceEntry,
  recordSource,
  emptyLedger,
  isUsableLedger,
  auditLedger,
  pageIndependence,
  AUTHORITY_TIERS,
  DEFAULT_REFRESH_DAYS,
  SOURCE_LEDGER_PATH,
  LEDGER_VERSION,
} from '../src/helpers/source-ledger.mjs';
import { recordSourceTool, auditSourcesTool, readLedger } from '../src/tools/source-ledger.mjs';
import { contentSha256 } from '../src/helpers/content-hash.mjs';

const AT = '2026-08-02T10:00:00Z';
const url = (u, over = {}) => ({ kind: 'url', url: u, authority: 'secondary', capturedAt: AT, ...over });

// --- 1. Identity ------------------------------------------------------------

describe('C6 — source identity', () => {
  test('RFC-equivalent URL spellings collapse to ONE id', () => {
    const ids = new Set([
      sourceIdFor({ kind: 'url', url: 'https://EXAMPLE.com/a' }),
      sourceIdFor({ kind: 'url', url: 'https://example.com:443/a' }),
      sourceIdFor({ kind: 'url', url: 'https://example.com/a/' }),
      sourceIdFor({ kind: 'url', url: 'https://example.com/a?utm_source=news#section' }),
    ]);
    assert.equal(ids.size, 1, `expected one identity, got ${[...ids].join(' | ')}`);
  });

  test('credentials in a parseable URL are STRIPPED, not persisted', () => {
    // The normaliser can clean this one, so the source is still usable — but
    // neither the basic-auth userinfo nor the token may reach the ledger.
    const e = buildSourceEntry(url('https://user:secret@example.com/a?token=abc123'));
    assert.equal(e.id, 'url:https://example.com/a');
    assert.ok(!JSON.stringify(e).includes('secret'));
    assert.ok(!JSON.stringify(e).includes('abc123'));
  });

  test('a credential-bearing URL that CANNOT be cleaned is refused outright', () => {
    // Protocol-relative form: unparseable, so the normaliser cannot strip the
    // secret — it returns null and the entry must be refused rather than
    // persisting a leaky identifier.
    assert.equal(sourceIdFor({ kind: 'url', url: '//u:p@example.com/x?api_key=zz' }), null);
    assert.throws(
      () => buildSourceEntry(url('//u:p@example.com/x?api_key=zz')),
      /credential|normalis/i,
    );
  });

  test('a stored entry never carries the secret query parameter', () => {
    const e = buildSourceEntry(url('https://example.com/a?token=SECRET&page=2'));
    assert.ok(!JSON.stringify(e).includes('SECRET'), 'secret leaked into the entry');
    assert.match(e.id, /page=2/, 'benign params are kept');
  });

  test('identity is INJECTIVE: a url can never collide with a file/text id', () => {
    // `text://publisher.example/x` recorded as a URL produced exactly the same
    // id as `{kind:'text', id:'//publisher.example/x'}` — two different sources
    // silently merged into one entry (Codex review). Ids are namespaced now,
    // and non-http(s) schemes are refused outright.
    assert.equal(sourceIdFor({ kind: 'url', url: 'text://publisher.example/x' }), null);
    assert.notEqual(
      sourceIdFor({ kind: 'url', url: 'https://publisher.example/x' }),
      sourceIdFor({ kind: 'text', id: '//publisher.example/x' }),
    );
    for (const scheme of ['ftp://h/x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi']) {
      assert.equal(sourceIdFor({ kind: 'url', url: scheme }), null, scheme);
    }
  });

  test('percent-encoded unreserved characters are one identity, not three', () => {
    const ids = new Set(['/~alice', '/%7Ealice', '/%7ealice'].map((p) =>
      sourceIdFor({ kind: 'url', url: `https://example.com${p}` })));
    assert.equal(ids.size, 1, `RFC 3986 §6.2.2: got ${[...ids].join(' | ')}`);
  });

  test('a secret in a MATRIX parameter is refused (the normaliser cannot strip it)', () => {
    // Neither URLSearchParams nor the path normaliser touch `;name=value`.
    for (const u of ['https://example.com/a?foo=1;token=QUERYSECRET', 'https://example.com/app;jsessionid=PATHSECRET']) {
      assert.throws(() => buildSourceEntry(url(u)), /credential/i, u);
    }
  });

  test('a credential pasted into a free-text field is refused, not archived', () => {
    // The ledger is persisted inside the vault.
    assert.throws(() => buildSourceEntry(url('https://x.com/a', { note: 'curl -H "authorization: Bearer eyJhb"' })), /credential/i);
    assert.throws(() => buildSourceEntry(url('https://x.com/a', { title: 'api_key=AKIA123' })), /credential/i);
    assert.throws(() => buildSourceEntry({ kind: 'file', id: '/tmp/dump?access_token=zz', authority: 'primary', capturedAt: AT }), /credential/i);
  });

  test('file and text sources need an explicit id', () => {
    assert.throws(() => buildSourceEntry({ kind: 'file', authority: 'primary', capturedAt: AT }), /requires an explicit id/);
    assert.equal(buildSourceEntry({ kind: 'file', id: '/docs/spec.pdf', authority: 'official', capturedAt: AT }).id, 'file:/docs/spec.pdf');
  });

  test('the content fingerprint is the shared SHA-256, and a bad digest is refused', () => {
    assert.equal(buildSourceEntry(url('https://x.com/a', { content: 'bonjour' })).contentHash, contentSha256('bonjour'));
    assert.throws(() => buildSourceEntry(url('https://x.com/a', { contentHash: 'nope' })), /64-char/);
  });
});

// --- 2. Independence --------------------------------------------------------

describe('C6 — independence rule', () => {
  test('registrableDomain: subdomains collapse, compound suffixes survive', () => {
    assert.equal(registrableDomain('www.example.com'), 'example.com');
    assert.equal(registrableDomain('a.b.deep.example.com'), 'example.com');
    assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
    assert.equal(registrableDomain('service.gouv.fr'), 'service.gouv.fr');
    assert.equal(registrableDomain('192.168.0.11'), '192.168.0.11', 'an IP is its own publisher');
  });

  test('multi-tenant hosts keep the author as the identity', () => {
    // Collapsing these to `github.io` would let one platform impersonate
    // corroboration between two unrelated authors.
    assert.notEqual(registrableDomain('alice.github.io'), registrableDomain('bob.github.io'));
    assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
    assert.notEqual(registrableDomain('a.substack.com'), registrableDomain('b.substack.com'));
  });

  test('NO over-counting: `www` is never a tenant', () => {
    // The dangerous direction. On the multi-tenant branch, treating `www` as an
    // identity made `www.substack.com` a different "publisher" than
    // `substack.com` — two articles from one site would have counted as two
    // independent origins, i.e. a FALSE corroboration.
    for (const host of ['substack.com', 'wordpress.com', 'blogspot.com', 'example.com']) {
      assert.equal(registrableDomain(`www.${host}`), registrableDomain(host), `www.${host}`);
    }
    assert.equal(registrableDomain('www.alice.github.io'), 'alice.github.io');
  });

  test('NO over-counting: path-based platforms are not treated as subdomain tenancy', () => {
    // `medium.com/@author` puts the tenant in the PATH, which this function
    // never sees. Listing it as multi-tenant split `blog.medium.com` from
    // `medium.com`. Two Medium authors now count as ONE origin — an
    // under-count, which is the safe side.
    assert.equal(registrableDomain('blog.medium.com'), 'medium.com');
    assert.equal(registrableDomain('www.medium.com'), 'medium.com');
    assert.equal(
      independenceKeyFor({ kind: 'url', url: 'https://medium.com/@alice/p' }),
      independenceKeyFor({ kind: 'url', url: 'https://www.medium.com/@bob/p' }),
    );
  });

  test('equivalent spellings of one publisher never split into two origins', () => {
    const spellings = [
      'https://www.example.com/a', 'https://example.com/b', 'https://blog.example.com/c',
      'http://example.com:80/d', 'https://EXAMPLE.com/e', 'https://example.com./f',
    ].map((u) => independenceKeyFor({ kind: 'url', url: u }));
    assert.equal(new Set(spellings).size, 1, `over-count: ${[...new Set(spellings)].join(' | ')}`);
  });

  test('a declared publisher alias merges one org under several domains', () => {
    // No hostname heuristic can know that bbc.com and bbc.co.uk are one
    // newsroom — they counted as two independent origins, a false corroboration
    // (Codex review). A per-vault alias map, declared by a human, fixes it.
    const sources = [
      { kind: 'url', url: 'https://www.bbc.com/news/a', id: 'a' },
      { kind: 'url', url: 'https://www.bbc.co.uk/news/b', id: 'b' },
    ];
    assert.equal(countIndependentOrigins(sources).count, 2, 'without aliases the heuristic cannot tell');
    const aliased = countIndependentOrigins(sources, { 'bbc.com': 'bbc', 'bbc.co.uk': 'bbc' });
    assert.equal(aliased.count, 1);
    assert.deepEqual(aliased.groups.bbc, ['a', 'b']);
  });

  test('an internationalised host matches its punycode form', () => {
    assert.equal(
      independenceKeyFor({ kind: 'url', url: 'https://münchen.de/a' }),
      independenceKeyFor({ kind: 'url', url: 'https://xn--mnchen-3ya.de/b' }),
    );
  });

  test('two articles from the same site count as ONE origin', () => {
    const { count, groups } = countIndependentOrigins([
      { kind: 'url', url: 'https://www.lemonde.fr/article-a', id: 'a' },
      { kind: 'url', url: 'https://lemonde.fr/article-b?utm_campaign=x', id: 'b' },
      { kind: 'url', url: 'https://www.reuters.com/c', id: 'c' },
    ]);
    assert.equal(count, 2);
    assert.deepEqual(Object.keys(groups).sort(), ['lemonde.fr', 'reuters.com']);
    assert.deepEqual(groups['lemonde.fr'], ['a', 'b']);
  });

  test('a source whose origin cannot be derived is reported, never counted', () => {
    const { count, unknown } = countIndependentOrigins([
      { kind: 'url', url: 'https://good.com/a', id: 'a' },
      { kind: 'url', url: '//user:pw@bad.com/x?secret=1', id: 'leaky' },
    ]);
    assert.equal(count, 1, 'the underivable source must not inflate the count');
    assert.deepEqual(unknown, ['leaky']);
  });

  test('non-URL sources get their own key — but see the corroboration carve-out', () => {
    // Each island adds one to a RAW origin count; `pageIndependence` is where
    // they are excluded from corroboration (an earlier version of this test
    // pinned the raw count as if it proved safety — it did not).
    const { count } = countIndependentOrigins([
      { kind: 'text', id: 'note-1' },
      { kind: 'text', id: 'note-2' },
    ]);
    assert.equal(count, 2);
    assert.equal(independenceKeyFor({ kind: 'file', id: '/a.pdf' }), 'file:/a.pdf');
  });

  test('NO over-counting: a schemeless URL is refused, never counted', () => {
    // `lemonde.fr/a` is unparseable, so the normaliser cleans NOTHING: tracking
    // params survive (one article → two ids) and each raw spelling used to be
    // its own countable origin, so two articles from one newsroom "corroborated"
    // each other (Fable 5 review).
    assert.throws(
      () => buildSourceEntry({ kind: 'url', url: 'lemonde.fr/a', authority: 'secondary', capturedAt: AT }),
      /fully-qualified/,
    );
    assert.equal(independenceKeyFor({ kind: 'url', url: 'lemonde.fr/a' }), null);
    const { count, unknown } = countIndependentOrigins([
      { kind: 'url', url: 'lemonde.fr/a', id: 'a' },
      { kind: 'url', url: 'www.lemonde.fr/b', id: 'b' },
    ]);
    assert.equal(count, 0, 'an origin we cannot determine must never count');
    assert.deepEqual(unknown, ['a', 'b']);
  });

  test('a secret in the FRAGMENT of an unparseable URL is refused', () => {
    // OAuth implicit flow returns tokens after `#`; the parse-failure branch has
    // no fragment stripping, so it would have been persisted verbatim.
    assert.throws(
      () => buildSourceEntry({ kind: 'url', url: 'example.com/cb#access_token=SECRETTOK', authority: 'primary', capturedAt: AT }),
      /credential|fully-qualified/i,
    );
  });

  test('a trailing-dot FQDN is the same source, not a second entry', () => {
    const a = buildSourceEntry(url('https://example.com./a')).id;
    const b = buildSourceEntry(url('https://example.com/a')).id;
    assert.equal(a, b);
  });

  test('an explicit independenceKey overrides the heuristic', () => {
    const e = buildSourceEntry(url('https://eu.acme.com/a', { independenceKey: 'acme-group' }));
    assert.equal(e.independenceKey, 'acme-group');
  });
});

// --- 3. Forward-fill discipline --------------------------------------------

describe('C6 — forward-fill only', () => {
  test('authority must be DECLARED — never inferred, never defaulted', () => {
    assert.throws(
      () => buildSourceEntry({ kind: 'url', url: 'https://docs.python.org/3/', capturedAt: AT }),
      /must be DECLARED/,
    );
    assert.throws(() => buildSourceEntry(url('https://x.com/a', { authority: 'trustworthy' })), /must be DECLARED/);
    for (const tier of AUTHORITY_TIERS) {
      assert.equal(buildSourceEntry(url('https://x.com/a', { authority: tier })).authority, tier);
    }
  });

  test('review defaults to unreviewed — nothing is vetted by existing', () => {
    assert.equal(buildSourceEntry(url('https://x.com/a')).reviewState, 'unreviewed');
  });

  test('re-recording accumulates pages and preserves a human review', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://x.com/a', { content: 'v1', pages: ['wiki/a.md'] })).ledger;
    const r = recordSource(L, url('https://x.com/a', { content: 'v1', reviewState: 'reviewed', pages: ['wiki/b.md'] }));
    assert.deepEqual(r.entry.pages, ['wiki/a.md', 'wiki/b.md']);
    assert.equal(r.entry.reviewState, 'reviewed');
    assert.equal(r.contentChanged, false);
  });

  test('CHANGED content invalidates the prior review and says so', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://x.com/a', { content: 'v1', reviewState: 'reviewed' })).ledger;
    const r = recordSource(L, url('https://x.com/a', { content: 'v2 — the page was edited upstream' }));
    assert.equal(r.contentChanged, true);
    assert.equal(r.entry.reviewState, 'unreviewed', 'a review is about a specific content');
    assert.equal(r.entry.previousContentHash, contentSha256('v1'));
    assert.equal(r.outcome, 'updated');
  });

  test('provenance survives: firstSeenAt keeps the original sighting', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://x.com/a', { capturedAt: '2026-01-01T00:00:00Z', content: 'v1' })).ledger;
    const r = recordSource(L, url('https://x.com/a', { capturedAt: '2026-09-09T00:00:00Z', content: 'v2' }));
    assert.equal(r.entry.firstSeenAt, '2026-01-01T00:00:00Z');
    assert.equal(r.entry.capturedAt, '2026-09-09T00:00:00Z');
  });

  test('an identical re-record is reported as unchanged (no churn)', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://x.com/a', { content: 'v1', pages: ['wiki/a.md'] })).ledger;
    assert.equal(recordSource(L, url('https://x.com/a', { content: 'v1', pages: ['wiki/a.md'] })).outcome, 'unchanged');
  });

  test('a content-less re-record does NOT erase the stored fingerprint', () => {
    // The most common re-record shape (just linking another page) used to
    // overwrite contentHash with null — destroying provenance AND leaving
    // nothing to compare against, so the next real content change went
    // undetected and a stale review survived it (Fable 5 review).
    let L = emptyLedger('v');
    L = recordSource(L, url('https://x.com/a', { content: 'v1', reviewState: 'reviewed' })).ledger;
    L = recordSource(L, url('https://x.com/a', { pages: ['wiki/p.md'] })).ledger;
    assert.equal(L.sources['url:https://x.com/a'].contentHash, contentSha256('v1'), 'fingerprint kept');
    const changed = recordSource(L, url('https://x.com/a', { content: 'v2 edited upstream' }));
    assert.equal(changed.contentChanged, true, 'the change is still detectable');
    assert.equal(changed.entry.reviewState, 'unreviewed');
  });

  test('re-capturing IDENTICAL content advances the refresh horizon', () => {
    // Otherwise a source you just re-verified stays "stale" in every audit,
    // forever — the refresh mechanism defeats itself (Fable 5 review).
    let L = emptyLedger('v');
    L = recordSource(L, url('https://y.com/a', { authority: 'community', capturedAt: '2026-01-01T00:00:00Z', content: 'same' })).ledger;
    const before = L.sources['url:https://y.com/a'].refreshDue;
    const again = recordSource(L, url('https://y.com/a', { authority: 'community', capturedAt: '2026-06-01T00:00:00Z', content: 'same' }));
    assert.equal(again.outcome, 'updated');
    assert.ok(again.entry.refreshDue > before, 'refreshDue must advance on re-verification');
  });

  test('a metadata-only update (horizon, title, note) is not silently dropped', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://y.com/a', { content: 'same' })).ledger;
    for (const patch of [{ refreshEveryDays: 7 }, { title: 'Nouveau titre' }, { note: 'à revoir' }]) {
      assert.equal(recordSource(L, url('https://y.com/a', { content: 'same', ...patch })).outcome, 'updated', JSON.stringify(patch));
    }
  });

  test('an explicitly declared review is honoured even when the content changed', () => {
    // The caller who says 'reviewed' while supplying new content has reviewed
    // the NEW version — a declaration, like authority. Only the automatic path
    // invalidates.
    let L = emptyLedger('v');
    L = recordSource(L, url('https://x.com/a', { content: 'v1', reviewState: 'reviewed' })).ledger;
    const r = recordSource(L, url('https://x.com/a', { content: 'v2', reviewState: 'reviewed' }));
    assert.equal(r.contentChanged, true);
    assert.equal(r.entry.reviewState, 'reviewed');
  });

  test('an uppercase digest of the same content is not read as a change', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://x.com/a', { content: 'v1' })).ledger;
    const r = recordSource(L, url('https://x.com/a', { contentHash: contentSha256('v1').toUpperCase() }));
    assert.equal(r.contentChanged, false);
  });

  test('a metadata-only re-record does NOT refresh an unfetched source', () => {
    // `capturedAt` defaults to now, so merely linking another page marked a
    // source as freshly verified without anything being fetched — staleness
    // defeated from the other side (Codex review). Only a fresh fingerprint
    // counts as re-verification.
    let L = emptyLedger('v');
    L = recordSource(L, url('https://x.com/a', { capturedAt: '2026-01-01T00:00:00Z', content: 'v1' })).ledger;
    const before = L.sources['url:https://x.com/a'];
    const later = recordSource(L, url('https://x.com/a', { capturedAt: '2030-06-30T00:00:00Z', pages: ['wiki/p.md'] }));
    assert.equal(later.entry.capturedAt, before.capturedAt, 'capture instant must not move');
    assert.equal(later.entry.refreshDue, before.refreshDue, 'nor the horizon');
    assert.deepEqual(later.entry.pages, ['wiki/p.md'], 'but the page link lands');
  });

  test('declared overrides survive a re-record that does not restate them', () => {
    // An `independenceKey` / custom horizon silently reverted to the heuristic
    // default on the next ingest, while the `declared` flag stayed true — an
    // entry claiming to be vouched for while carrying a guessed key (Codex).
    let L = emptyLedger('v');
    L = recordSource(L, url('https://www.bbc.com/a', { independenceKey: 'bbc-group', refreshEveryDays: 7, content: 'v1' })).ledger;
    const again = recordSource(L, url('https://www.bbc.com/a', { content: 'v2' }));
    assert.equal(again.entry.independenceKey, 'bbc-group');
    assert.equal(again.entry.independenceKeyDeclared, true);
    assert.equal(again.entry.refreshEveryDays, 7);
    // …and an explicit new value still replaces it.
    assert.equal(recordSource(L, url('https://www.bbc.com/a', { independenceKey: 'other', content: 'v3' })).entry.independenceKey, 'other');
  });

  test('recordSource never mutates the ledger it was given', () => {
    const L = emptyLedger('v');
    const frozen = JSON.stringify(L);
    recordSource(L, url('https://x.com/a'));
    assert.equal(JSON.stringify(L), frozen);
  });
});

// --- 4. Staleness + audit ---------------------------------------------------

describe('C6 — refresh horizons and audit', () => {
  const build = () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://spec.example.com/s', { authority: 'official', capturedAt: '2026-01-01T00:00:00Z', pages: ['wiki/p.md'] })).ledger;
    L = recordSource(L, url('https://forum.example.org/t/1', { authority: 'community', capturedAt: '2026-01-01T00:00:00Z', pages: ['wiki/p.md'] })).ledger;
    return L;
  };

  test('the refresh horizon follows the declared tier', () => {
    const official = buildSourceEntry(url('https://x.com/a', { authority: 'official' }));
    const synthetic = buildSourceEntry(url('https://x.com/b', { authority: 'synthetic' }));
    assert.equal(official.refreshEveryDays, DEFAULT_REFRESH_DAYS.official);
    assert.equal(synthetic.refreshEveryDays, DEFAULT_REFRESH_DAYS.synthetic);
    assert.ok(Date.parse(official.refreshDue) > Date.parse(synthetic.refreshDue));
    assert.equal(buildSourceEntry(url('https://x.com/c', { refreshEveryDays: 7 })).refreshEveryDays, 7);
  });

  test('audit is pure: the clock is injected, so a report is reproducible', () => {
    const L = build();
    assert.deepEqual(auditLedger(L, '2026-06-01T00:00:00Z'), auditLedger(L, '2026-06-01T00:00:00Z'));
  });

  test('the community source goes stale long before the official one', () => {
    const L = build();
    assert.deepEqual(auditLedger(L, '2026-02-01T00:00:00Z').stale, [], 'neither is due yet');
    const mid = auditLedger(L, '2026-06-01T00:00:00Z');
    assert.deepEqual(mid.stale.map((s) => s.id), ['url:https://forum.example.org/t/1']);
    assert.ok(mid.stale[0].overdueDays > 0);
    assert.equal(auditLedger(L, '2027-06-01T00:00:00Z').stale.length, 2);
  });

  test('the audit counts tiers, review gaps and true origins', () => {
    const a = auditLedger(build(), '2026-02-01T00:00:00Z');
    // Null-prototype on purpose (the group maps are keyed by external values),
    // so spread before comparing.
    assert.deepEqual({ ...a.byAuthority }, { official: 1, community: 1 });
    assert.equal(a.unreviewed.length, 2);
    assert.equal(a.origins.count, 2);
    assert.equal(a.total, 2);
  });

  test('malformed ENTRIES are reported, never treated as fresh (and never crash)', () => {
    // Container-only validation let a garbled `refreshDue` make a source
    // permanently non-stale, and a null entry crashed the audit (Codex review).
    const ledger = {
      version: LEDGER_VERSION,
      vault: 'v',
      sources: {
        'url:https://ok.com/a': buildSourceEntry(url('https://ok.com/a', { capturedAt: '2020-01-01T00:00:00Z' })),
        'url:https://bad-date.com/a': { ...buildSourceEntry(url('https://bad-date.com/a')), refreshDue: 'not-a-date' },
        'url:https://null-entry.com/a': null,
        'url:https://no-authority.com/a': { id: 'url:https://no-authority.com/a' },
      },
    };
    let report;
    assert.doesNotThrow(() => { report = auditLedger(ledger, '2026-08-02T00:00:00Z'); });
    assert.equal(report.total, 1, 'only the valid entry is counted');
    assert.equal(report.stale.length, 1);
    assert.equal(report.invalid.length, 3);
    assert.deepEqual(report.invalid.map((i) => i.reason).sort(), ['missing-id-or-authority', 'not-an-object', 'unusable-refreshDue']);
  });

  test('required is floored at 1 — nothing corroborates a page with no sources', () => {
    const v = pageIndependence(emptyLedger('v'), 'wiki/none.md', 0);
    assert.equal(v.corroborated, false, 'corroboration by zero sources is not a verdict');
    assert.equal(v.required, 1);
  });

  test('an unusable ledger is reported as such, not silently empty', () => {
    assert.equal(auditLedger({ version: 999, sources: {} }, AT).usable, false);
    assert.equal(isUsableLedger({ version: LEDGER_VERSION, sources: {} }), true);
    assert.equal(isUsableLedger({ version: LEDGER_VERSION, sources: [] }), false);
  });
});

// --- 5. Page-level verdict --------------------------------------------------

describe('C6 — page independence verdict', () => {
  test('two genuinely distinct origins corroborate a page', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://reuters.com/a', { pages: ['wiki/p.md'] })).ledger;
    L = recordSource(L, url('https://lemonde.fr/b', { pages: ['wiki/p.md'] })).ledger;
    const v = pageIndependence(L, 'wiki/p.md');
    assert.equal(v.corroborated, true);
    assert.equal(v.origins, 2);
  });

  test('two articles from the SAME site do not', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://www.site.fr/a', { pages: ['wiki/p.md'] })).ledger;
    L = recordSource(L, url('https://blog.site.fr/b', { pages: ['wiki/p.md'] })).ledger;
    const v = pageIndependence(L, 'wiki/p.md');
    assert.equal(v.origins, 1);
    assert.equal(v.corroborated, false);
    assert.deepEqual(Object.keys(v.groups), ['site.fr']);
  });

  test('synthetic output never corroborates — and the exclusion is reported', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://reuters.com/a', { pages: ['wiki/q.md'] })).ledger;
    L = recordSource(L, { kind: 'text', id: 'llm-1', authority: 'synthetic', capturedAt: AT, pages: ['wiki/q.md'] }).ledger;
    const v = pageIndependence(L, 'wiki/q.md');
    assert.equal(v.corroborated, false, 'a model quoting itself is not a second opinion');
    assert.deepEqual(v.excluded.synthetic, ['text:llm-1']);
  });

  test('two copies of one local document do NOT corroborate', () => {
    // Each island adds one to the raw count, so without this carve-out any
    // ingester could inflate independence by recording snippets as files/text
    // (Fable 5 review — and the earlier test suite pinned that behaviour).
    let L = emptyLedger('v');
    L = recordSource(L, { kind: 'file', id: '/dl/article-copy1.pdf', authority: 'primary', capturedAt: AT, pages: ['wiki/p.md'] }).ledger;
    L = recordSource(L, { kind: 'file', id: '/dl/article-copy2.pdf', authority: 'primary', capturedAt: AT, pages: ['wiki/p.md'] }).ledger;
    const v = pageIndependence(L, 'wiki/p.md');
    assert.equal(v.corroborated, false);
    assert.deepEqual(v.excluded.unvouchedLocal, ['file:/dl/article-copy1.pdf', 'file:/dl/article-copy2.pdf']);
  });

  test('…unless a human vouches for each origin with an explicit key', () => {
    let L = emptyLedger('v');
    L = recordSource(L, { kind: 'file', id: '/insee.pdf', authority: 'official', capturedAt: AT, pages: ['wiki/q.md'], independenceKey: 'insee' }).ledger;
    L = recordSource(L, { kind: 'file', id: '/eurostat.pdf', authority: 'official', capturedAt: AT, pages: ['wiki/q.md'], independenceKey: 'eurostat' }).ledger;
    assert.equal(pageIndependence(L, 'wiki/q.md').corroborated, true);
  });

  test('disputed sources count but are surfaced in the verdict', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://a.com/1', { pages: ['wiki/d.md'], reviewState: 'disputed' })).ledger;
    L = recordSource(L, url('https://b.com/2', { pages: ['wiki/d.md'] })).ledger;
    const v = pageIndependence(L, 'wiki/d.md');
    assert.equal(v.corroborated, true, 'a contested source is still a source');
    assert.deepEqual(v.disputed, ['url:https://a.com/1'], 'but never silently');
  });

  test('a retired source stops counting', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://reuters.com/a', { pages: ['wiki/r.md'] })).ledger;
    L = recordSource(L, url('https://lemonde.fr/b', { pages: ['wiki/r.md'], reviewState: 'retired' })).ledger;
    const v = pageIndependence(L, 'wiki/r.md');
    assert.equal(v.origins, 1);
    assert.deepEqual(v.excluded.retired, ['url:https://lemonde.fr/b']);
  });

  test('a page with no recorded source is honestly uncorroborated, not an error', () => {
    const v = pageIndependence(emptyLedger('v'), 'wiki/absent.md');
    assert.equal(v.corroborated, false);
    assert.equal(v.origins, 0);
  });

  test('the required threshold is configurable', () => {
    let L = emptyLedger('v');
    L = recordSource(L, url('https://a.com/1', { pages: ['wiki/s.md'] })).ledger;
    assert.equal(pageIndependence(L, 'wiki/s.md', 1).corroborated, true);
    assert.equal(pageIndependence(L, 'wiki/s.md', 3).corroborated, false);
  });
});

// --- 6. Tool layer ----------------------------------------------------------

describe('C6 — tool layer', () => {
  function harness(initial = null) {
    const store = new Map();
    if (initial !== null) store.set(SOURCE_LEDGER_PATH, initial);
    const calls = { writes: [], casWrites: [] };
    const deps = {
      getFileContent: async (_v, p) => {
        if (!store.has(p)) throw Object.assign(new Error('404'), { kind: 'not_found' });
        return store.get(p);
      },
      writeFile: async (_v, p, c) => { store.set(p, c); calls.writes.push(p); },
      writeFileIfMatch: async (_v, p, c, expected) => {
        if (contentSha256(store.get(p) ?? '') !== expected) {
          throw Object.assign(new Error('ifMatch precondition failed: content changed since you read it'), { kind: 'conflict', status: 409 });
        }
        store.set(p, c);
        calls.casWrites.push(p);
        return { casMode: 'fallback' };
      },
      now: () => AT,
    };
    return { store, calls, deps, registry: { resolveVault: () => ({ name: 'v' }) } };
  }

  test('first record creates the ledger with a plain write', async () => {
    const h = harness();
    const out = await recordSourceTool(h.registry, { kind: 'url', url: 'https://x.com/a', authority: 'primary', pages: ['wiki/p.md'] }, h.deps);
    assert.equal(out.outcome, 'added');
    assert.equal(out.written, true);
    assert.deepEqual(h.calls.writes, [SOURCE_LEDGER_PATH]);
    assert.equal(JSON.parse(h.store.get(SOURCE_LEDGER_PATH)).version, LEDGER_VERSION);
  });

  test('a later record uses a compare-and-swap write (C1)', async () => {
    const h = harness();
    await recordSourceTool(h.registry, { kind: 'url', url: 'https://x.com/a', authority: 'primary' }, h.deps);
    const out = await recordSourceTool(h.registry, { kind: 'url', url: 'https://y.com/b', authority: 'official' }, h.deps);
    assert.equal(out.written, true);
    assert.equal(out.casMode, 'fallback');
    assert.deepEqual(h.calls.casWrites, [SOURCE_LEDGER_PATH]);
    assert.equal(Object.keys(JSON.parse(h.store.get(SOURCE_LEDGER_PATH)).sources).length, 2);
  });

  test('a concurrent session cannot clobber the ledger — the CAS refuses', async () => {
    const h = harness();
    await recordSourceTool(h.registry, { kind: 'url', url: 'https://x.com/a', authority: 'primary' }, h.deps);
    // Another session writes between our read and our write.
    const racing = { ...h.deps, getFileContent: async (v, p) => {
      const value = h.store.get(p);
      h.store.set(p, JSON.stringify({ ...JSON.parse(value), sources: { ...JSON.parse(value).sources, 'https://other.com/z': { id: 'https://other.com/z' } } }, null, 2));
      return value; // we return the STALE bytes we "read" first
    } };
    await assert.rejects(
      () => recordSourceTool(h.registry, { kind: 'url', url: 'https://y.com/b', authority: 'official' }, racing),
      /changed since|precondition failed/i,
    );
    assert.ok(h.store.get(SOURCE_LEDGER_PATH).includes('other.com'), "the other session's entry survives");
  });

  test('an unchanged re-record writes nothing at all', async () => {
    const h = harness();
    const args = { kind: 'url', url: 'https://x.com/a', authority: 'primary', pages: ['wiki/p.md'] };
    await recordSourceTool(h.registry, args, h.deps);
    const out = await recordSourceTool(h.registry, args, h.deps);
    assert.equal(out.outcome, 'unchanged');
    assert.equal(out.written, false);
    assert.deepEqual(h.calls.casWrites, [], 'no churn on a shared file');
  });

  test('a corrupt or foreign ledger is REFUSED, never overwritten', async () => {
    await assert.rejects(
      () => recordSourceTool(harness('not json{').registry, { kind: 'url', url: 'https://x.com/a', authority: 'primary' }, harness('not json{').deps),
      /not readable JSON/,
    );
    const foreign = harness(JSON.stringify({ version: 99, sources: {} }));
    await assert.rejects(
      () => recordSourceTool(foreign.registry, { kind: 'url', url: 'https://x.com/a', authority: 'primary' }, foreign.deps),
      /version 99/,
    );
    assert.equal(foreign.calls.writes.length + foreign.calls.casWrites.length, 0, 'nothing written over it');
  });

  test('audit_sources reports an absent ledger honestly (not "no sources")', async () => {
    const h = harness();
    const out = await auditSourcesTool(h.registry, {}, h.deps);
    assert.equal(out.ledgerPresent, false);
    assert.match(out.note, /never back-filled/);
    assert.equal(out.total, 0);
  });

  test('audit_sources is read-only and can answer for one page', async () => {
    const h = harness();
    await recordSourceTool(h.registry, { kind: 'url', url: 'https://reuters.com/a', authority: 'secondary', pages: ['wiki/p.md'] }, h.deps);
    await recordSourceTool(h.registry, { kind: 'url', url: 'https://lemonde.fr/b', authority: 'secondary', pages: ['wiki/p.md'] }, h.deps);
    const before = h.store.get(SOURCE_LEDGER_PATH);
    const out = await auditSourcesTool(h.registry, { page: 'wiki/p.md' }, h.deps);
    assert.equal(out.ledgerPresent, true);
    assert.equal(out.pageVerdict.corroborated, true);
    assert.equal(out.pageVerdict.origins, 2);
    assert.equal(h.store.get(SOURCE_LEDGER_PATH), before, 'audit must not write');
  });

  test('two sessions creating the ledger at once: the loser is told, not silently dropped', async () => {
    // Without a create-only guard both sessions plain-write and one source
    // vanishes — the lost update this file's concurrency note claims to prevent
    // (Fable 5 review).
    const h = harness();
    const guarded = { ...h.deps, writeFile: async (_v, p, c, opts) => {
      if (opts?.applyIfContentPreexists === false && h.store.has(p)) {
        throw Object.assign(new Error('409 file already exists'), { kind: 'conflict', status: 409 });
      }
      h.store.set(p, c);
    } };
    // Another session wins the race between our 404 read and our write.
    h.store.set(SOURCE_LEDGER_PATH, JSON.stringify({ version: LEDGER_VERSION, vault: 'v', sources: { 'https://other.com/z': { id: 'https://other.com/z' } } }, null, 2));
    await assert.rejects(
      () => recordSourceTool(h.registry, { kind: 'url', url: 'https://x.com/a', authority: 'primary' }, { ...guarded, getFileContent: async () => { throw Object.assign(new Error('404'), { kind: 'not_found' }); } }),
      /Another session created|Nothing was overwritten/,
    );
    assert.ok(h.store.get(SOURCE_LEDGER_PATH).includes('other.com'), "the winner's ledger survives");
  });

  test('readLedger treats a missing file as "not started", not an error', async () => {
    const h = harness();
    const { existed, ledger } = await readLedger(h.deps.getFileContent, { name: 'v' });
    assert.equal(existed, false);
    assert.equal(isUsableLedger(ledger), true);
  });
});
