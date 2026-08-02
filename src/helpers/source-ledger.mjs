/**
 * Source ledger + independence rule — C6 (borrowed from claude-obsidian v2, §2.17).
 *
 * THE GAP THIS FILLS. The vault's source pages read beautifully, but the vault
 * cannot ANSWER questions about them: "which sources are stale?", "aren't these
 * two articles from the same site?", "what is this claim actually resting on?".
 * Prose is not queryable. This module is the structured register that is — one
 * entry per source, carrying what a reviewer needs and nothing more.
 *
 * RELATIONSHIP TO `ingest-state.mjs`. That module answers a DIFFERENT question:
 * "have I already ingested this exact content?" (a fingerprint cache that makes
 * re-ingestion a no-op). This one answers "what do I know ABOUT this source, and
 * how much should I trust it?" — authority, review state, refresh horizon, which
 * pages depend on it. Different lifetimes, different consumers. So the hashing
 * and the hard-won URL normalisation (tracking params, credential stripping,
 * param sorting) are IMPORTED from there, never re-implemented: there is one
 * URL-normaliser in this repo.
 *
 * ── THE TWO RULES THAT MAKE IT HONEST ─────────────────────────────────────
 *
 * 1. FORWARD-FILL ONLY. The ledger is written by ingestion, going forward. It is
 *    NEVER back-filled by guessing from existing prose: a page that says "per
 *    the official docs" is not evidence that an official source was consulted,
 *    and inventing an entry from it would manufacture the very confidence the
 *    ledger exists to measure. An un-ingested source is simply absent — an
 *    honest gap beats a plausible fiction. `recordSource` therefore refuses to
 *    invent authority: it must be DECLARED by the caller, never inferred.
 *
 * 2. INDEPENDENCE IS ABOUT ORIGIN, NOT URL. "Two independent sources" is
 *    meaningless if both are the same newsroom under two addresses. Before
 *    counting, every source is reduced to an `independenceKey` — the
 *    registrable domain, so `blog.example.com/a`, `www.example.com/b?utm=x` and
 *    `EXAMPLE.com:443/b/` all collapse to one. Counting distinct keys, not
 *    distinct URLs, is what makes "corroborated by two independent sources" mean
 *    something.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS MODULE DOES NOT DO. It records and counts; it does not judge. It
 * never decides that a source is trustworthy, never promotes an authority tier
 * on its own, and never resolves a contradiction. Those are editorial acts —
 * C7 (claim ledger) is where that debate was deliberately deferred to.
 */

import { computeSourceHash, normaliseUrl, hasUnstrippableSecret } from './ingest-state.mjs';

/**
 * Names whose `=`-assignment inside a FREE-TEXT field (title, note, an explicit
 * id) means a credential is about to be written into the vault. The ledger is a
 * persisted file; a caller pasting a whole URL-with-token into `note` should be
 * refused, not quietly archived (Codex review).
 */
const SECRET_IN_TEXT_RE =
  /\b(?:access_token|refresh_token|id_token|api[_-]?key|client_secret|password|passwd|jsessionid|phpsessid|sessionid|authorization|secret|token)\b\s*[=:]\s*\S/i;

/** Throw when a free-text field carries what looks like a credential. */
function assertNoSecretText(field, value) {
  if (typeof value === 'string' && SECRET_IN_TEXT_RE.test(value)) {
    throw new Error(
      `source-ledger: refusing to persist \`${field}\` — it contains what looks like a credential ` +
        `(a token/key/password assignment). The ledger is stored inside the vault; strip the secret first.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** Where the ledger lives inside the vault (written through the REST API). */
export const SOURCE_LEDGER_PATH = 'wiki-meta/source-ledger.json';

/** Ledger schema version — a foreign version is refused, never half-read. */
export const LEDGER_VERSION = 1;

/**
 * Authority tiers, most authoritative first. DECLARED by the ingesting caller,
 * never inferred from content (forward-fill rule 1).
 *
 *   official   — the thing itself speaking: vendor docs, a spec, a law text,
 *                the project's own repository.
 *   primary    — first-hand evidence: a study, a dataset, an interview, a
 *                dated announcement by the actor concerned.
 *   secondary  — professional reporting/analysis ABOUT primary material.
 *   community  — forums, blogs, Q&A, wikis: useful, unvetted.
 *   synthetic  — produced by a model (including this router). Recorded so it
 *                can never be silently mistaken for evidence.
 */
export const AUTHORITY_TIERS = ['official', 'primary', 'secondary', 'community', 'synthetic'];

/** Review states. `unreviewed` is the honest default — nothing is vetted by existing. */
export const REVIEW_STATES = ['unreviewed', 'reviewed', 'disputed', 'retired'];

/**
 * Default refresh horizon per tier, in days. A spec changes slowly; a forum
 * thread rots fast; model output is stale the moment the model moves. These are
 * DEFAULTS — a caller who knows better passes `refreshEveryDays` explicitly.
 */
export const DEFAULT_REFRESH_DAYS = {
  official: 365,
  primary: 365,
  secondary: 180,
  community: 90,
  synthetic: 30,
};

/**
 * Multi-tenant hosts where the SUBDOMAIN is the publisher identity, not the
 * platform. `alice.github.io` and `bob.github.io` are two independent authors;
 * collapsing them to `github.io` would let one platform masquerade as
 * corroboration.
 *
 * ONLY subdomain-based tenancy belongs here. Platforms whose tenant lives in
 * the PATH (`medium.com/@author`, `github.com/user`, `reddit.com/r/x`) must NOT
 * be listed: this function only ever sees the hostname, so listing them made
 * `blog.medium.com` and `medium.com` two different "publishers" — an
 * over-count, i.e. a FALSE corroboration, the one direction that must never
 * happen. Path-based tenancy is therefore not modelled at all: two Medium
 * authors count as one origin (an under-count — the safe side).
 */
export const MULTI_TENANT_HOSTS = new Set([
  'github.io', 'gitlab.io', 'pages.dev', 'netlify.app', 'vercel.app',
  'blogspot.com', 'wordpress.com', 'substack.com',
  'tumblr.com', 'notion.site', 'gitbook.io', 'readthedocs.io',
  'herokuapp.com', 'firebaseapp.com', 'web.app', 'glitch.me',
]);

/**
 * Two-label public suffixes (`co.uk`, `com.au`, …). Without these,
 * `bbc.co.uk` would reduce to `co.uk` and every British site would look like
 * one publisher.
 */
const COMPOUND_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'gov.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.za', 'org.za', 'gov.za',
  'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw',
  'gouv.fr', 'asso.fr', 'gov.it', 'gov.es', 'gov.pl',
]);

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------

/**
 * Reduce a hostname to the registrable domain that identifies its PUBLISHER.
 *
 * HONEST LIMITATION, stated rather than hidden: correct eTLD+1 resolution needs
 * the Public Suffix List — thousands of rules, updated continuously, and a
 * dependency this repo deliberately does not take. What runs here is a bounded
 * heuristic: two labels by default, three for a known compound suffix or a known
 * multi-tenant host. It is right for the overwhelming majority of real sources
 * and WRONG for exotic suffixes it has never heard of (an unlisted `co.xx` would
 * under-count independence — the SAFE direction: it treats two publishers as
 * one, never one as two). Callers that need certainty should record an explicit
 * `independenceKey`; `wiki-lint` surfaces the heuristic's groupings so a wrong
 * call is visible rather than silent.
 *
 * @param {string} hostname already lowercased by normaliseUrl
 * @returns {string} the registrable domain, or the hostname when it cannot reduce
 */
export function registrableDomain(hostname) {
  let host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return '';
  // An IP literal is its own publisher — never strip labels off it.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;
  // `www` is never a tenant and never an organisation. Dropping it up front is
  // what keeps `www.substack.com` from looking like a different publisher than
  // `substack.com` on the multi-tenant branch below — an over-count, i.e. a
  // false corroboration.
  host = host.replace(/^www\./, '');
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (COMPOUND_SUFFIXES.has(lastTwo) || MULTI_TENANT_HOSTS.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * The key two sources must SHARE to be considered dependent (same origin).
 *
 * URLs reduce to their registrable domain. Non-URL sources (a local file, pasted
 * text) have no verifiable publisher, so each gets its own key — but note that
 * "its own key" still ADDS ONE to an origin count, which is why
 * `pageIndependence` excludes them from corroboration unless the caller supplies
 * an explicit `independenceKey`. Two copies of the same PDF under two filenames
 * are not two witnesses (Fable 5 review).
 *
 * @param {{kind: string, url?: string, id?: string}} source
 * @returns {string|null} null when a URL could not be normalised safely.
 */
export function independenceKeyFor({ kind, url, id }) {
  if (kind === 'url') {
    const normalised = normaliseUrl(url);
    // normaliseUrl returns null when the input carries credentials it could not
    // strip — refuse rather than persist a leaky key.
    if (normalised === null) return null;
    try {
      const { hostname } = new URL(normalised);
      if (!hostname) return null;
      return registrableDomain(hostname);
    } catch {
      // Unparseable (typically a schemeless `example.com/a`). Returning an
      // `opaque:<string>` key here used to make every raw spelling its OWN
      // countable origin, so `lemonde.fr/a` and `www.lemonde.fr/b` "corroborated"
      // each other — the exact false corroboration this rule exists to prevent
      // (Fable 5 review). An origin we cannot determine must never count: null
      // routes it to `unknown`.
      return null;
    }
  }
  return `${kind}:${id ?? ''}`;
}

/**
 * Count how many INDEPENDENT origins a set of sources represents, and say which
 * ones collapsed together.
 *
 * This is the function that gives "corroborated by two independent sources" a
 * definition. Sources whose independence key could not be computed are reported
 * separately and NEVER counted — an unknown origin cannot corroborate.
 *
 * @param {Array<object>} sources ledger entries or `{kind,url,id}` shapes
 * @returns {{count: number, groups: Record<string, string[]>, unknown: string[]}}
 */
export function countIndependentOrigins(sources, aliases = null) {
  const groups = Object.create(null);
  const unknown = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const derived = source?.independenceKey ?? independenceKeyFor(source ?? {});
    // A declared alias collapses several registrable domains onto one publisher.
    const key = applyPublisherAliases(derived, aliases);
    const label = source?.id ?? source?.url ?? '(unnamed)';
    if (!key) {
      unknown.push(label);
      continue;
    }
    (groups[key] ||= []).push(label);
  }
  return { count: Object.keys(groups).length, groups, unknown };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** Add `days` to an ISO instant, returning an ISO date (no clock read here). */
function addDays(isoInstant, days) {
  const t = Date.parse(isoInstant);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 86400000).toISOString();
}

/**
 * The stable id of a source: its normalised URL, or `<kind>:<id>` otherwise.
 * @returns {string|null} null when a URL cannot be normalised safely.
 */
export function sourceIdFor({ kind, url, id }) {
  if (kind === 'url') {
    const normalised = normaliseUrl(url);
    if (normalised === null) return null;
    // A schemeless string (`lemonde.fr/a`) is returned unparsed by the
    // normaliser, which means NONE of its cleaning ran: tracking params survive,
    // so one article becomes two entries under two spellings (Fable 5 review).
    // Demand a real URL rather than storing a half-normalised identity.
    let parsed;
    try {
      parsed = new URL(normalised);
    } catch {
      return null;
    }
    if (!parsed.hostname) return null;
    // Only http(s). Any other hostname-bearing scheme could collide with the
    // `<kind>:` namespace below — `text://publisher.example/x` recorded as a URL
    // produced the exact same id as `{kind:'text', id:'//publisher.example/x'}`,
    // silently merging two different sources (Codex review).
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Every id is namespaced by kind, so identity is injective by construction.
    return `url:${normalised}`;
  }
  if (!id) return null;
  return `${kind}:${id}`;
}

/**
 * Build a ledger entry from a DECLARED observation.
 *
 * Everything editorial (authority, review state) must be supplied — this
 * function never infers a tier from a URL or from content. Everything derived
 * (id, independence key, content hash, refresh horizon) is computed here so two
 * callers cannot disagree about it.
 *
 * @param {object} input
 * @param {'url'|'file'|'text'} input.kind
 * @param {string} [input.url]              required for kind 'url'
 * @param {string} [input.id]               required for 'file' / 'text'
 * @param {string} input.authority          one of AUTHORITY_TIERS (declared)
 * @param {string} input.capturedAt         ISO instant the content was fetched
 * @param {string} [input.content]          content to fingerprint (post-defuddle)
 * @param {string} [input.contentHash]      pre-computed fingerprint (alternative)
 * @param {string} [input.title]
 * @param {string[]} [input.pages]          vault pages resting on this source
 * @param {number} [input.refreshEveryDays] overrides the per-tier default
 * @param {string} [input.reviewState]      defaults to 'unreviewed'
 * @param {string} [input.independenceKey]  explicit override of the heuristic
 * @param {string} [input.note]
 * @returns {object} the entry
 * @throws {Error} on a missing/invalid declaration — never a silent default.
 */
export function buildSourceEntry(input = {}) {
  const { kind, authority, capturedAt, reviewState = 'unreviewed' } = input;

  if (!['url', 'file', 'text'].includes(kind)) {
    throw new Error(`source-ledger: kind must be one of url|file|text (got ${JSON.stringify(kind)}).`);
  }
  if (!AUTHORITY_TIERS.includes(authority)) {
    throw new Error(
      `source-ledger: authority must be DECLARED as one of ${AUTHORITY_TIERS.join('|')} (got ` +
        `${JSON.stringify(authority)}). It is never inferred from the source itself — an ingester ` +
        `that does not know the tier should say so rather than guess.`,
    );
  }
  if (!REVIEW_STATES.includes(reviewState)) {
    throw new Error(`source-ledger: reviewState must be one of ${REVIEW_STATES.join('|')} (got ${JSON.stringify(reviewState)}).`);
  }
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) {
    throw new Error('source-ledger: capturedAt must be an ISO instant (the moment the content was fetched).');
  }
  // Free-text fields are persisted verbatim into a vault file — guard them.
  assertNoSecretText('title', input.title);
  assertNoSecretText('note', input.note);
  assertNoSecretText('id', input.id);
  assertNoSecretText('independenceKey', input.independenceKey);
  if (kind === 'url' && hasUnstrippableSecret(input.url)) {
    throw new Error(
      'source-ledger: refusing this URL — it carries a credential in a form the normaliser cannot ' +
        'strip (a matrix parameter such as `;jsessionid=` or a secret smuggled inside a query value). ' +
        'Remove it from the address and record the source again.',
    );
  }

  const id = sourceIdFor(input);
  if (!id) {
    throw new Error(
      kind === 'url'
        ? `source-ledger: refusing this URL (${String(input.url).slice(0, 40)}…) — it is either not a ` +
          'fully-qualified URL (a schemeless `example.com/a` cannot be normalised, so the same article ' +
          'would land twice under two spellings and count as two independent origins), or it carries ' +
          'credentials that could not be stripped. Supply a complete https:// URL, or record it as ' +
          "kind 'text' with an explicit id."
        : `source-ledger: kind '${kind}' requires an explicit id.`,
    );
  }
  const independenceKey = input.independenceKey ?? independenceKeyFor(input);
  if (!independenceKey) {
    throw new Error('source-ledger: could not derive an independence key for this source.');
  }

  let contentHash = input.contentHash ?? null;
  if (!contentHash && typeof input.content === 'string') {
    contentHash = computeSourceHash(input.content);
  }
  if (contentHash !== null && !/^[0-9a-f]{64}$/i.test(contentHash)) {
    throw new Error('source-ledger: contentHash must be a 64-char SHA-256 hex digest.');
  }
  // Store lowercase: the digest is validated case-insensitively but compared
  // exactly, so an uppercase re-record of the SAME content otherwise read as a
  // content change and needlessly killed the review (Fable 5 review).
  if (contentHash !== null) contentHash = contentHash.toLowerCase();

  const refreshEveryDays = Number.isFinite(input.refreshEveryDays)
    ? Math.max(1, Math.floor(input.refreshEveryDays))
    : DEFAULT_REFRESH_DAYS[authority];

  return {
    id,
    kind,
    ...(kind === 'url' ? { url: id } : {}),
    ...(input.title ? { title: String(input.title) } : {}),
    authority,
    independenceKey,
    // Records whether a human vouched for this origin — a non-URL source only
    // counts toward corroboration when it did (see pageIndependence).
    ...(input.independenceKey ? { independenceKeyDeclared: true } : {}),
    contentHash,
    capturedAt,
    refreshEveryDays,
    refreshDue: addDays(capturedAt, refreshEveryDays),
    reviewState,
    pages: [...new Set((input.pages ?? []).map(String))].sort(),
    ...(input.note ? { note: String(input.note) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Ledger document
// ---------------------------------------------------------------------------

/**
 * An empty, well-formed ledger.
 *
 * `publisherAliases` maps a derived key onto a shared publisher identity, for
 * the case no hostname heuristic can ever solve: one organisation under several
 * registrable domains (`bbc.com` + `bbc.co.uk`, a group's national editions).
 * Without it those counted as two independent origins — a false corroboration
 * (Codex review). It is DECLARED by a human, per vault, and applied at counting
 * time so existing entries benefit immediately.
 */
export function emptyLedger(vaultName = null) {
  return { version: LEDGER_VERSION, vault: vaultName, publisherAliases: {}, sources: {} };
}

/**
 * Apply a vault's publisher-alias map to a derived key.
 * @param {string|null} key
 * @param {Record<string,string>} [aliases]
 */
export function applyPublisherAliases(key, aliases) {
  if (!key || !aliases || typeof aliases !== 'object') return key;
  return Object.prototype.hasOwnProperty.call(aliases, key) ? String(aliases[key]) : key;
}

/** True when `ledger` is a readable ledger of the expected version and shape. */
export function isUsableLedger(ledger) {
  return Boolean(
    ledger &&
      typeof ledger === 'object' &&
      ledger.version === LEDGER_VERSION &&
      ledger.sources &&
      typeof ledger.sources === 'object' &&
      !Array.isArray(ledger.sources),
  );
}

/**
 * Insert or update one source — the ONLY write path (forward-fill rule 1).
 *
 * Merge policy on an existing id, chosen so re-ingesting never destroys
 * editorial work:
 *   - `pages` accumulate (a source can support several pages);
 *   - a human `reviewState` is PRESERVED unless the content changed — a new
 *     fingerprint invalidates the old review, so the entry drops back to
 *     `unreviewed` and says so via `contentChanged`;
 *   - `authority` is overwritten only when the caller declares one;
 *   - `capturedAt`/`refreshDue` always advance to the fresh observation.
 *
 * Returns a NEW ledger (no mutation of the input) plus what happened, so a
 * caller can report "3 added, 1 changed, 12 unchanged" honestly.
 *
 * @returns {{ledger: object, entry: object, outcome: 'added'|'updated'|'unchanged', contentChanged: boolean}}
 */
export function recordSource(ledger, input) {
  const base = isUsableLedger(ledger) ? ledger : emptyLedger(ledger?.vault ?? null);
  // Preserve a declared alias map across every write.
  if (!base.publisherAliases) base.publisherAliases = {};
  const fresh = buildSourceEntry(input);
  const previous = base.sources[fresh.id] ?? null;

  if (!previous) {
    // `firstSeenAt` is set at CREATION, not on the first re-record: otherwise
    // every entry gained a field on its second write, so an otherwise-identical
    // re-record could never report `unchanged`.
    const created = { ...fresh, firstSeenAt: fresh.capturedAt };
    return {
      ledger: { ...base, sources: { ...base.sources, [created.id]: created } },
      entry: created,
      outcome: 'added',
      contentChanged: false,
    };
  }

  const contentChanged =
    fresh.contentHash !== null &&
    previous.contentHash !== null &&
    fresh.contentHash !== previous.contentHash;

  // An explicit reviewState from the caller is a DECLARATION (same status as
  // authority): a caller who re-records changed content AND says 'reviewed' has
  // reviewed the new version. Only the automatic path invalidates.
  const declaredReview = input.reviewState !== undefined;
  // A re-record only counts as a RE-VERIFICATION when it brings a fresh
  // fingerprint. Metadata-only calls (linking one more page) must not advance
  // the refresh horizon — that silently marked an unfetched source as freshly
  // checked, defeating staleness from the other side (Codex review).
  const reVerified = fresh.contentHash !== null;

  const merged = {
    ...previous,
    ...fresh,
    // Prior DECLARATIONS survive a re-record that does not restate them —
    // otherwise an override (`independenceKey: 'bbc-group'`, a 7-day horizon)
    // silently reverted to the heuristic default on the next ingest, while the
    // `declared` flag stayed true (Codex review).
    independenceKey: input.independenceKey ?? previous.independenceKey ?? fresh.independenceKey,
    ...(input.independenceKey || previous.independenceKeyDeclared ? { independenceKeyDeclared: true } : {}),
    refreshEveryDays: Number.isFinite(input.refreshEveryDays)
      ? fresh.refreshEveryDays
      : (previous.refreshEveryDays ?? fresh.refreshEveryDays),
    // Only a re-verification moves the capture instant and its horizon.
    capturedAt: reVerified ? fresh.capturedAt : (previous.capturedAt ?? fresh.capturedAt),
    // Accumulate the pages that rest on this source.
    pages: [...new Set([...(previous.pages ?? []), ...fresh.pages])].sort(),
    // Never let a content-less re-record (the common "just link another page"
    // call) erase the stored fingerprint: doing so destroyed provenance AND let
    // a stale review survive the next real content change, because there was
    // nothing left to compare against (Fable 5 review).
    contentHash: fresh.contentHash ?? previous.contentHash ?? null,
    // A review is about a specific content. If the content moved and the caller
    // did not re-declare, the review no longer applies.
    reviewState: contentChanged && !declaredReview
      ? 'unreviewed'
      : (input.reviewState ?? previous.reviewState ?? 'unreviewed'),
    // Keep the first sighting; it is provenance, not a cache timestamp.
    firstSeenAt: previous.firstSeenAt ?? previous.capturedAt ?? fresh.capturedAt,
    ...(contentChanged ? { previousContentHash: previous.contentHash } : {}),
  };
  // Recompute the horizon from whichever capture instant and policy actually won.
  merged.refreshDue = addDays(merged.capturedAt, merged.refreshEveryDays);

  // "Unchanged" must mean the STORED ENTRY would be byte-identical — comparing a
  // hand-listed subset of fields silently dropped real updates: a re-capture of
  // identical content never advanced `capturedAt`/`refreshDue` (so a re-verified
  // source stayed "stale" in every audit, forever), and a horizon/title/note
  // edit was reported as written when nothing had been (Fable 5 review). Both
  // objects come from the same builder, so key order is stable.
  const unchanged = JSON.stringify(previous) === JSON.stringify(merged);

  return {
    ledger: { ...base, sources: { ...base.sources, [merged.id]: merged } },
    entry: merged,
    outcome: unchanged ? 'unchanged' : 'updated',
    contentChanged,
  };
}

// ---------------------------------------------------------------------------
// Reporting (what `wiki-lint` consumes)
// ---------------------------------------------------------------------------

/**
 * Audit a ledger against a point in time. Pure — `now` is injected, never read
 * from the clock, so a report is reproducible.
 *
 * Reports, never decides: stale entries are listed for a human to refresh,
 * single-origin clusters are listed for a human to weigh. Nothing is rewritten.
 *
 * @param {object} ledger
 * @param {string} now ISO instant
 * @returns {object} report
 */
export function auditLedger(ledger, now) {
  if (!isUsableLedger(ledger)) {
    return { usable: false, reason: 'ledger-unusable', total: 0, stale: [], unreviewed: [], disputed: [], invalid: [], byAuthority: {}, origins: { count: 0, groups: {} } };
  }
  const nowMs = Date.parse(now);
  const all = Object.entries(ledger.sources);
  const stale = [];
  const unreviewed = [];
  const disputed = [];
  const invalid = [];
  const byAuthority = Object.create(null);
  const entries = [];

  for (const [key, e] of all) {
    // A malformed entry must be REPORTED, not silently treated as fresh: a
    // missing/garbled `refreshDue` made a source permanently non-stale, and a
    // null entry crashed the audit outright (Codex review).
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !AUTHORITY_TIERS.includes(e.authority)) {
      invalid.push({ key, reason: !e || typeof e !== 'object' ? 'not-an-object' : 'missing-id-or-authority' });
      continue;
    }
    const dueMs = Date.parse(e.refreshDue ?? '');
    if (!Number.isFinite(dueMs)) {
      invalid.push({ key, reason: 'unusable-refreshDue' });
      continue;
    }
    entries.push(e);
    byAuthority[e.authority] = (byAuthority[e.authority] ?? 0) + 1;
    if (Number.isFinite(nowMs) && dueMs <= nowMs) {
      stale.push({ id: e.id, refreshDue: e.refreshDue, authority: e.authority, overdueDays: Math.floor((nowMs - dueMs) / 86400000) });
    }
    if (e.reviewState === 'unreviewed') unreviewed.push(e.id);
    if (e.reviewState === 'disputed') disputed.push(e.id);
  }
  stale.sort((a, b) => b.overdueDays - a.overdueDays || (a.id < b.id ? -1 : 1));
  unreviewed.sort();
  disputed.sort();

  return {
    usable: true,
    total: entries.length,
    stale,
    unreviewed,
    disputed,
    ...(invalid.length ? { invalid } : {}),
    byAuthority,
    origins: countIndependentOrigins(entries, ledger.publisherAliases),
  };
}

/**
 * Independence verdict for the sources backing ONE page.
 *
 * `corroborated` means: at least `required` DISTINCT origins, counting only
 * entries that can actually WITNESS something. Excluded, each reported:
 *   - `synthetic` — a model quoting itself is not a second opinion;
 *   - `retired` — withdrawn from evidence;
 *   - non-URL sources WITHOUT an explicit `independenceKey` — a local file or a
 *     pasted snippet has no verifiable publisher, so two copies of one document
 *     under two filenames would otherwise "corroborate" each other (Fable 5
 *     review). Pass `independenceKey` to vouch for a real, distinct origin.
 * `disputed` entries still count (they are real sources) but are surfaced so a
 * verdict is never read as "settled" when it rests on contested material.
 *
 * @param {object} ledger
 * @param {string} pagePath
 * @param {number} [required=2]
 * @returns {object} verdict
 */
export function pageIndependence(ledger, pagePath, required = 2) {
  // `required: 0` made a page with ZERO sources "corroborated" (Codex review).
  // Corroboration by nothing is not a verdict.
  const need = Number.isFinite(required) ? Math.max(1, Math.floor(required)) : 2;
  const entries = isUsableLedger(ledger)
    ? Object.values(ledger.sources).filter((e) => (e.pages ?? []).includes(pagePath))
    : [];
  const isUnvouchedLocal = (e) => e.kind !== 'url' && !e.independenceKeyDeclared;
  const excludedSynthetic = entries.filter((e) => e.authority === 'synthetic').map((e) => e.id);
  const excludedRetired = entries.filter((e) => e.reviewState === 'retired').map((e) => e.id);
  const excludedLocal = entries.filter((e) => isUnvouchedLocal(e) && e.authority !== 'synthetic' && e.reviewState !== 'retired').map((e) => e.id);
  const counted = entries.filter(
    (e) => e.authority !== 'synthetic' && e.reviewState !== 'retired' && !isUnvouchedLocal(e),
  );
  const { count, groups, unknown } = countIndependentOrigins(counted, ledger?.publisherAliases);
  return {
    page: pagePath,
    corroborated: count >= need,
    origins: count,
    required: need,
    groups,
    counted: counted.map((e) => e.id).sort(),
    disputed: counted.filter((e) => e.reviewState === 'disputed').map((e) => e.id).sort(),
    excluded: {
      synthetic: excludedSynthetic.sort(),
      retired: excludedRetired.sort(),
      unvouchedLocal: excludedLocal.sort(),
      unknownOrigin: unknown,
    },
  };
}
