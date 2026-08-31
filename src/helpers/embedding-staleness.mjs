/**
 * embedding-staleness — A1 of [[claude-code-large-codebases-roadmap]]: say when
 * a semantic hit comes from a note that has been EDITED SINCE it was embedded.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `search_smart` ranks by cosine against vectors Smart Connections computed on
 * its own schedule. A note edited after that pass still answers with its old
 * vector, and until now nothing said so: a stale hit and a fresh one arrived
 * looking exactly alike. That is the failure mode the Anthropic large-codebases
 * article names for RAG — "the index reflects the codebase as it existed hours
 * ago" — and the router was trusting it blindly.
 *
 * ---------------------------------------------------------------------------
 * THE SIGNAL IS IN THE STORE, AND THAT CORRECTS A CLAIM THIS REPO MADE
 * ---------------------------------------------------------------------------
 * `smart-env-embeddings.mjs` states that "per-page staleness cannot be
 * determined from here (the store keeps no hash this router can recompute)".
 * That is TRUE ABOUT THE HASH and FALSE ABOUT STALENESS, and the difference was
 * found by opening a record rather than reasoning about one. Every whole-note
 * record carries:
 *
 *     "last_import": { "mtime": 1779556760606, "size": 39489, "at": …, "hash": … }
 *     "last_embed":  { "hash": "1l1schy", "at": 1779556778156 }
 *
 * `last_import.mtime` is THE NOTE'S OWN MTIME AS SMART CONNECTIONS SAW IT. So
 * comparing it against the note's mtime now is a like-for-like comparison, not
 * a heuristic — and `last_import.size` gives a second, independent axis for
 * free. Measured over the whole fleet (19 vaults with a store, 2915 records):
 * `last_import.mtime > 0` on 2899, `last_embed.at` on 2907. The residue is real
 * and is reported as `unknown` rather than guessed at.
 *
 * ---------------------------------------------------------------------------
 * THE CHEAP SHORTCUT IS REFUTED BY MEASUREMENT
 * ---------------------------------------------------------------------------
 * The obvious economy — stat the store file instead of reading it, and treat
 * ITS mtime as the page's index time — does not hold. On this vault's 803 store
 * files the file mtime agrees with the record's own `last_embed.at` within a
 * minute for only 329 of them; the median disagreement is 12.5 HOURS and the
 * tail runs to 5 days, because a file is rewritten for reasons that have
 * nothing to do with the page being re-embedded. So the records are read. It is
 * affordable: 9.4 ms for the ten files a default page of hits touches (3.9 MB),
 * against 0.5 ms for the one directory listing that precedes them.
 *
 * ---------------------------------------------------------------------------
 * FINDING A PAGE'S RECORD WITHOUT READING 166 MB
 * ---------------------------------------------------------------------------
 * Smart Connections names each file after the page, flattening `/`, `.` and ` `
 * to `_`. That mapping is LOSSY — `a/b.md`, `a.b.md` and `a b.md` all flatten
 * alike — so it is used as a LOOKUP HINT and never as proof: whatever file it
 * opens, the record's own key must equal the path we asked about, or the page
 * is reported `unknown`. Measured fleet-wide: 2890 of 2915 records are found by
 * the exact derived name, 25 need the case-folded index of the real directory
 * listing (SchoolMouv alone has 21 — a directory renamed after indexing, so the
 * store file kept the old casing), and 0 are unresolvable.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE VERDICTS MEAN — AND WHY `touched` IS NOT `changed`
 * ---------------------------------------------------------------------------
 * A quarter of the fleet's stale pages (61 of 244) have the SAME BYTE SIZE they
 * had at import, and they cluster on the two Google Drive vaults (21 of 30 on
 * one, 11 of 13 on another). That is the signature of a sync client touching
 * mtime without changing content. Collapsing those into one "stale" verdict
 * would make a quarter of the warnings unearned, so the two are named apart:
 *
 *   fresh        no evidence the note differs from what was indexed: the size
 *                matches (or is unknown) and the mtime has not moved past the
 *                tolerance.
 *   changed      evidence that it DOES differ — either a differing byte size
 *                (proof) or a moved mtime with no identical-size finding. The
 *                per-page `sizeEvidence` says which, and never implies a byte
 *                comparison that did not happen.
 *   touched      mtime moved and the size is PROVEN identical — a same-length
 *                edit, or a sync client touching the clock. Real doubt, weaker
 *                evidence; reported as its own thing, not hidden and not
 *                promoted.
 *   not-indexed  no candidate store file exists for this path at all.
 *   page-missing the page this path names is NOT ON DISK (a proven ENOENT).
 *                Deliberately independent of the record: a hit pointing at a
 *                deleted page is a fact worth surfacing whether or not the
 *                store could be read.
 *   unknown      we could not tell, WITH A REASON — an unreadable or oversized
 *                store file, an ambiguous filename, a stat that failed for
 *                anything other than absence, a record with no usable basis.
 *
 * SIZE OUTRANKS THE CLOCK. A differing byte size is proof the bytes are not the
 * ones that were embedded; an unmoved mtime cannot overturn it (a restored
 * timestamp or `touch -r` would otherwise buy a false `fresh`).
 *
 * THE CONSERVATIVE DIRECTION IS CHOSEN DELIBERATELY. A note whose mtime is
 * OLDER than its import (restored from backup, clock moved) reads `fresh`, and
 * the tolerance below suppresses sub-second noise. Under-reporting doubt is the
 * cheaper error for an advisory signal: a warning nobody can act on teaches the
 * reader to ignore the channel. What is NEVER traded away is the other
 * direction — an inability to look is never reported as a fact.
 *
 * ---------------------------------------------------------------------------
 * LOCAL DISK ONLY, ON PURPOSE
 * ---------------------------------------------------------------------------
 * A vault this machine has no disk for answers `checkable: false` and NO
 * warning — never a false positive, the rule the roadmap set. The bridge's
 * `GET /smart-env/sources` could serve these same records remotely (C11 uses it
 * that way), but it ships the WHOLE store — 4.3 MB gzipped on this fleet's
 * largest vault, against a 240 s budget — which is not a thing to do on a
 * search's hot path. Deferred deliberately, not overlooked.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SMART_ENV_DIR, SMART_ENV_MULTI, parseSourceRecordLine } from './smart-env-embeddings.mjs';
import { canonicalVaultPath } from './vault-path-guard.mjs';

/** Per-page verdicts. A closed vocabulary — callers may switch on it. */
export const FRESH = 'fresh';
export const CHANGED = 'changed';
export const TOUCHED = 'touched';
export const NOT_INDEXED = 'not-indexed';
export const PAGE_MISSING = 'page-missing';
export const UNKNOWN = 'unknown';

/**
 * How much newer a note's mtime must be before it counts as modified.
 *
 * A CONVENTION, NOT A CALIBRATION — 2 s is FAT's mtime granularity, the coarsest
 * still met in practice (NTFS is 100 ns, ext4 finer still), so it is the widest
 * gap a filesystem can introduce without anything having been edited. Nothing
 * was fitted to a corpus, and the constant travels in the response so a reader
 * can judge it instead of trusting it.
 */
export const MTIME_TOLERANCE_MS = 2000;

/**
 * Hard cap on PAGES reported in one call. The search tiers cap at 50 results, so
 * this is a backstop against a caller passing its own list, not a limit the
 * search path can reach.
 */
export const MAX_PAGES_ASSESSED = 50;

/**
 * Hard cap on distinct PATHS resolved before collapsing to pages. Higher than
 * the page cap on purpose: many paths can name one page (one per section), and
 * store reads are memoised per file, so a generous bound here costs reads only
 * when the paths really are different pages.
 */
export const MAX_PATHS_RESOLVED = 200;

/**
 * Refuse to read a store file larger than this rather than block the process.
 *
 * Store files run to about 1 MB in normal use (the largest vault on this fleet:
 * 166 MB over 803 files). Nothing in the format bounds them, and this read is
 * SYNCHRONOUS on a search's hot path — a pathological file would stall the MCP
 * server in a way no try/catch recovers from. 32 MB is ~30× the observed
 * maximum: high enough never to fire on real data, low enough to be a bound.
 */
export const MAX_STORE_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Aggregate read budget for ONE page's lookup, and the number of candidate
 * files it will open. The per-file cap alone left the total unbounded once
 * every candidate had to be examined rather than the first match taken: many
 * case-variants of one derived name, each just under the per-file cap, would
 * all be read before the ambiguity they create is even reported.
 */
export const MAX_STORE_BYTES_PER_PAGE = 64 * 1024 * 1024;
export const MAX_CANDIDATES_PER_KEY = 8;

/** The verdicts that mean "this hit may not reflect the page as it is now". */
export function isDoubtful(state) {
  return state === CHANGED || state === TOUCHED;
}

/**
 * Why an assessment could not be made, in a sentence.
 *
 * A machine-readable `reason` on its own leaves the reader to guess whether the
 * silence means "nothing is stale" or "I never looked" — and those are opposite
 * facts. Same rule `find_twin_pages` applies to its own `available: false`.
 */
const DECLINE_DETAIL = {
  'no-local-disk':
    'Freshness was not checked: this vault has no disk on the machine running the router, and the '
    + 'check compares each page\'s mtime against the one the index recorded. Absence of a warning '
    + 'here is NOT evidence that the results are current.',
  'store-missing':
    'Freshness was not checked: no Smart Connections store (.smart-env/multi) was readable in this '
    + 'vault. Absence of a warning here is NOT evidence that the results are current.',
  'store-empty':
    'Freshness was not checked: this vault\'s Smart Connections store holds no record files. '
    + 'Absence of a warning here is NOT evidence that the results are current.',
  'no-usable-paths':
    'Freshness was not checked: none of the paths in these results is a valid vault-relative path, '
    + 'so none could be located on disk. Absence of a warning here is NOT evidence that the results '
    + 'are current.',
};

/**
 * Pick the path library matching the STYLE of the stored vault path rather than
 * the runtime's — the registry keeps Windows paths verbatim even on a POSIX
 * runtime (CI matrix). Same detection as `resolve-vault-path.mjs`.
 */
function libFor(vaultPath) {
  return /^[A-Za-z]:[\\/]/.test(vaultPath) || /^\\\\/.test(vaultPath) ? path.win32 : path.posix;
}

/**
 * Smart Connections' filename for a page path. A HINT, verified by the caller
 * against the record's own key — see the header on why it cannot be trusted
 * alone.
 */
export function storeFileNameFor(pagePath) {
  return `${String(pagePath).replace(/[/. ]/g, '_')}.ajson`;
}

/**
 * The freshness fields of the LAST `smart_sources` record in one store file.
 *
 * Last-wins, like every other reader of this format: a path is rewritten every
 * time the note changes, and reading first-wins would report the freshness of a
 * superseded version. A `null` value is a tombstone and retracts the key.
 *
 * @param {string} text raw `.ajson` content
 * @returns {Map<string, {importMtime?: number|null, importSize?: number|null,
 *                        embeddedAt?: number|null, rawKey: string,
 *                        tombstoned?: true, foldAmbiguous?: true}>}
 *   path → freshness. A TOMBSTONED path maps to `{tombstoned: true, rawKey}` —
 *   NOT to `null`, which is what it used to be: the raw spelling has to survive
 *   so the fold-ambiguity check can see it, and `null` carried nothing.
 *   `foldAmbiguous` marks a path two different raw spellings folded onto.
 */
export function parseFreshnessRecords(text) {
  const out = new Map();
  if (typeof text !== 'string' || !text) return out;
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  for (const rawLine of text.split('\n')) {
    const line = parseSourceRecordLine(rawLine);
    if (line === null || line.malformed) continue;
    for (const [pagePath, value, rawKey] of line.entries) {
      if (!pagePath) continue;
      // ONE FOLDED PATH, TWO RAW SPELLINGS = AN AMBIGUITY THAT LAST-WINS ERASES.
      // The Map keeps only the final value, so a POSIX store holding a record
      // for raw `a\b.md` and later one for raw `a/b.md` kept no trace of the
      // first — and the survivor looked unambiguous. The flag is sticky.
      const prior = out.get(pagePath);
      const priorRaw = prior?.rawKey;
      const folded = prior?.foldAmbiguous || (priorRaw !== undefined && priorRaw !== rawKey);
      // A TOMBSTONE STILL CARRIES ITS RAW KEY. Represented as a bare `null` it
      // did not, so the fold check above could not see that a POSIX record
      // literally named `a\b.md` had been folded onto `a/b.md`.
      if (value === null) {
        out.set(pagePath, { tombstoned: true, rawKey, ...(folded ? { foldAmbiguous: true } : {}) });
        continue;
      }
      if (typeof value !== 'object' || Array.isArray(value)) continue;
      const imp = value.last_import;
      const emb = value.last_embed;
      const okObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
      out.set(pagePath, {
        // `mtime: 0` occurs in the wild (4 records fleet-wide) and is NOT a date
        // — read as one it reports a page 56 years stale. `num` rejects it, and
        // the embed timestamp becomes the basis instead.
        importMtime: okObj(imp) ? num(imp.mtime) : null,
        importSize: okObj(imp) && Number.isInteger(imp.size) && imp.size >= 0 ? imp.size : null,
        embeddedAt: okObj(emb) ? num(emb.at) : null,
        // The key BEFORE backslash folding, so a caller can tell a recovered
        // Windows-style key from a POSIX filename that merely folds onto the
        // requested path. See `readRecordFor`.
        rawKey,
        ...(folded ? { foldAmbiguous: true } : {}),
      });
    }
  }
  return out;
}

/**
 * Locate and read the record for one page, verifying the file actually speaks
 * about it.
 *
 * "I COULD NOT READ" IS NOT "IT IS NOT THERE" — the distinction this codebase
 * keeps having to relearn. An unreadable candidate, or one past the byte cap,
 * yields `unreadable: true`, which the caller turns into `unknown`; only a
 * COMPLETE, successful search of every candidate yields `found: false`, which is
 * the one that licenses the claim `not-indexed`.
 *
 * @returns {{found: true, page: string, freshness: object|null}
 *          |{found: false, unreadable?: true, reason?: string}}
 */
function readRecordFor(io, lib, dir, pagePath, listing, ctx) {
  // A hit normally names a plain page path, but the store's own block keys are
  // `<page>.md#<heading>` and nothing forbids a caller passing one. Trying the
  // page part as a SECOND key costs one lookup and keeps `not-indexed` from
  // being claimed about a page the index does in fact cover — an over-claim is
  // worse here than a miss, because this signal exists to be trusted.
  // (`#` is legal in a filename, so the full path is always tried FIRST.)
  const pageKeys = [pagePath];
  const hash = pagePath.indexOf('#');
  if (hash > 0) pageKeys.push(pagePath.slice(0, hash));

  // Did ANY candidate file exist for this page? `not-indexed` is a claim about
  // the vault, and only an empty candidate set licenses it. A file that exists
  // and speaks about a DIFFERENT page (the lossy flattening puts `a/b.md`,
  // `a.b.md` and `a b.md` on one filename) proves our lookup was ambiguous, not
  // that the index lacks the page — and for a hit that came BACK from semantic
  // search, "not indexed" would contradict the hit's own existence.
  let sawCandidate = false;
  let budget = MAX_STORE_BYTES_PER_PAGE;
  for (const key of pageKeys) {
    // DOUBT IS SCOPED TO THE KEY BEING TRIED. Held across keys, an unresolved
    // ambiguity on `a.md#H` was quietly abandoned when the fallback key `a.md`
    // matched — the answer then described a different page than the one asked
    // about, with no sign that anything had been given up.
    let unreadable = null;
    const wanted = storeFileNameFor(key);
    const candidates = [];
    if (listing.exact.has(wanted)) candidates.push(wanted);
    // The case-folded index catches a store file whose name kept an old
    // directory casing (25 records fleet-wide). SORTED, because on a
    // case-sensitive filesystem two files can differ only in case and both claim
    // the same page: taking them in `readdirSync` order made the verdict depend
    // on directory enumeration, so the same store answered differently on two
    // machines. Sorting makes the choice a function of the data.
    const folded = listing.byLower.get(wanted.toLowerCase());
    if (folded) for (const f of [...folded].sort()) if (!candidates.includes(f)) candidates.push(f);

    if (candidates.length > 0) sawCandidate = true;
    // EVERY candidate is examined, not the first that matches. Two files whose
    // names differ only in case can BOTH claim the page with different
    // timestamps; taking the first was a guess, and sorting them only made the
    // guess repeatable. A disagreement is something we cannot resolve, so it is
    // reported as such.
    const matches = [];
    for (const file of candidates.slice(0, MAX_CANDIDATES_PER_KEY)) {
      let entry = ctx.cache.get(file);
      if (entry === undefined) {
        entry = { records: null, reason: null, bytes: 0 };
        try {
          // A BYTE CAP BEFORE THE READ. Store files run to ~1 MB in normal use,
          // but nothing in the format bounds them, and a synchronous read of an
          // arbitrarily large file on a search's hot path can stall the process
          // in a way no try/catch recovers from. A size we cannot READ is not a
          // size we may assume small.
          const st = io.statSync(lib.join(dir, file));
          if (!Number.isFinite(st?.size)) {
            entry.reason = 'store-file-unreadable';
          } else if (st.size > MAX_STORE_FILE_BYTES) {
            entry.reason = 'store-file-too-large';
          } else {
            entry.bytes = st.size;
            const text = io.readFileSync(lib.join(dir, file), 'utf8');
            entry.records = parseFreshnessRecords(typeof text === 'string' ? text : String(text));
          }
        } catch {
          entry.reason = 'store-file-unreadable';
        }
        // The REASON is cached with the failure. Caching a bare `null` made the
        // same failed read report `store-file-too-large` to one caller and
        // `store-file-unreadable` to the next.
        ctx.cache.set(file, entry);
        // A PER-FILE CAP IS NOT AN AGGREGATE CAP. Examining every candidate
        // (the fix for the "pick the first" guess) made the total unbounded:
        // many case-variants of one name, each just under the per-file cap,
        // are all read before the ambiguity is even reported.
        budget -= entry.bytes;
        if (budget < 0) { unreadable ??= 'store-read-budget-exhausted'; break; }
      }
      if (entry.records === null) { unreadable ??= entry.reason || 'store-file-unreadable'; continue; }
      // THE VERIFICATION THAT MAKES THE LOSSY FILENAME SAFE: the record must be
      // about the page we asked about, or this file tells us nothing.
      //
      // The equality is against the key AFTER the shared parser folded
      // backslashes to slashes, so on a case-sensitive filesystem a page truly
      // named `a\b.md` folds onto `a/b.md` and could lend it its freshness. That
      // fold is right for the Windows-authored keys it exists to recover
      // (measured on a real vault) and cannot be undone here without a second
      // definition of the format. It is refused rather than accepted: on a vault
      // whose paths are POSIX-style, a folded match is not proof.
      if (entry.records.has(key)) {
        const value = entry.records.get(key);
        const raw = value?.rawKey;
        if (value?.foldAmbiguous || (raw !== undefined && raw !== key && !ctx.windowsStyle)) {
          unreadable ??= 'ambiguous-record-key';
          continue;
        }
        matches.push(value);
      }
    }
    // TWO CANDIDATES THAT SAY THE SAME THING ARE NOT A DISAGREEMENT. Refusing
    // on count alone turned two byte-identical records — or two tombstones —
    // into a doubt nothing warranted.
    if (matches.length > 1 && !matches.every((m) => sameFreshness(m, matches[0]))) {
      // Two files, one page, two answers. Which is current is not knowable from
      // here, and picking one would be a deterministic fabrication.
      unreadable ??= 'fold-ambiguous';
    }
    // A MATCH IS CONCLUSIVE ONLY IF EVERY OTHER CANDIDATE WAS EXCLUDED. With an
    // unreadable competing file, a single readable record was being returned as
    // if the field were clear — a positive verdict resting on a file nobody
    // could open.
    if (unreadable) return { found: false, unreadable: true, reason: unreadable };
    if (matches.length >= 1) return { found: true, page: key, freshness: matches[0] };
  }
  // A candidate existed, was read, and did not speak about this page: ambiguous
  // lookup, not proven absence. See `sawCandidate`.
  if (sawCandidate) return { found: false, unreadable: true, reason: 'filename-collision' };
  return { found: false };
}

/** Do two records say the same thing about a page? */
function sameFreshness(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return Boolean(a.tombstoned) === Boolean(b.tombstoned)
    && a.importMtime === b.importMtime
    && a.importSize === b.importSize
    && a.embeddedAt === b.embeddedAt;
}

/**
 * Assess, for each of `pagePaths`, whether the note has changed since Smart
 * Connections embedded it.
 *
 * NEVER THROWS. This runs inside a search response, and a freshness check that
 * can fail a search would be a strictly worse trade than not knowing: every
 * failure degrades to `checkable: false` or to a per-page `unknown`.
 *
 * @param {object} vault registry vault descriptor
 * @param {string[]} pagePaths vault-relative paths, as returned by a search
 * @param {{fs?: object, now?: number}} [deps]
 * @returns {{
 *   checkable: boolean, reason?: string, storePath: string, toleranceMs: number,
 *   pages?: Array<{path: string, state: string, indexedMtime?: number|null,
 *                  noteMtime?: number|null, embeddedAt?: number|null,
 *                  sizeAtImport?: number|null, sizeNow?: number|null}>,
 *   summary?: {checked: number, fresh: number, changed: number, touched: number,
 *              notIndexed: number, pageMissing: number, unknown: number, doubtful: number},
 *   truncated?: boolean,
 * }}
 */
export function assessEmbeddingFreshness(vault, pagePaths, deps = {}) {
  const io = deps.fs || fs;
  const storePath = `${SMART_ENV_DIR}/${SMART_ENV_MULTI}`;
  const base = { storePath, toleranceMs: MTIME_TOLERANCE_MS };
  const decline = (reason) => ({
    ...base,
    checkable: false,
    reason,
    ...(DECLINE_DETAIL[reason] ? { detail: DECLINE_DETAIL[reason] } : {}),
  });

  // A vault with no disk here cannot be checked. Not an error and not a warning
  // — the roadmap's rule: best effort, never a false positive.
  if (!vault || vault.type !== 'local' || !vault.path || typeof vault.path !== 'string') {
    return decline('no-local-disk');
  }
  // THESE PATHS COME OFF THE WIRE. They are whatever the bridge put in a search
  // hit, so they are not trusted to be inside the vault: without this guard a
  // hit naming `../outside.md` is `statSync`ed outside the vault root and its
  // mtime and size come back in the response. The repo's own canonicaliser is
  // the guard — the SAME one `get_wiki_context_pack` applies to catalogue
  // wikilinks — rather than a second hand-rolled list that would drift from it.
  // A refused path is COUNTED, never silently dropped.
  const paths = [];
  let refusedPaths = 0;
  for (const p of Array.isArray(pagePaths) ? pagePaths : []) {
    // A non-string or blank entry is a REFUSAL like any other. Dropping it
    // uncounted was the same silence this guard exists to end.
    if (typeof p !== 'string' || !p.trim()) { refusedPaths += 1; continue; }
    // The anchor is split off for the check: `#` is legal in a filename but a
    // fragment is not a path, and `canonicalVaultPath` has no reason to accept
    // one. BOTH halves are canonicalised — validating only the left half let
    // `safe.md#../../../outside.md` through, because the FULL string is also
    // tried as a store key and, if a record carried it, was statted.
    const hash = p.indexOf('#');
    const filePart = hash > 0 ? p.slice(0, hash) : p;
    const fragment = hash > 0 ? p.slice(hash) : '';
    try {
      // USE THE RETURN VALUE. Ignoring it left `wiki/a.md` and `wiki//a.md` as
      // two different pages — two rows, one of them a fabricated `not-indexed`,
      // and `checked: 2` for a single page.
      const canonical = canonicalVaultPath(filePart, 'semantic hit path');
      // The fragment's canonical form is USED too. Validated but discarded, two
      // hundred spellings of one anchor (`#H/`, `#H//`, …) stayed distinct and
      // ate the whole path budget, pushing a genuinely different page out of it.
      const canonicalFragment = fragment
        ? `#${canonicalVaultPath(fragment.slice(1), 'semantic hit fragment')}`
        : '';
      paths.push(canonical + canonicalFragment);
    } catch {
      refusedPaths += 1;
    }
  }
  // `refusedPaths` travels on EVERY exit from here on, including the store
  // declines below: a caller that hears nothing about a refusal cannot tell it
  // happened, whatever else went wrong afterwards.
  const withRefusals = (obj) => (refusedPaths > 0 ? { ...obj, refusedPaths } : obj);
  if (paths.length === 0) {
    return withRefusals(decline(refusedPaths > 0 ? 'no-usable-paths' : 'no-paths'));
  }

  const lib = libFor(vault.path);
  const dir = lib.join(vault.path, SMART_ENV_DIR, SMART_ENV_MULTI);

  let entries;
  try {
    entries = io.readdirSync(dir);
  } catch {
    // Absent or unreadable: most of the fleet simply has no Smart Connections.
    return withRefusals(decline('store-missing'));
  }
  if (!Array.isArray(entries)) return withRefusals(decline('store-missing'));
  const files = entries.filter((f) => typeof f === 'string' && f.endsWith('.ajson'));
  if (files.length === 0) return withRefusals(decline('store-empty'));

  const listing = { exact: new Set(files), byLower: new Map() };
  for (const f of files) {
    const k = f.toLowerCase();
    if (!listing.byLower.has(k)) listing.byLower.set(k, []);
    listing.byLower.get(k).push(f);
  }

  // TWO PHASES, because the unit asked about and the unit reported are not the
  // same thing. A caller can hand fifty hits that are fifty SECTIONS of one
  // note (`wiki/a.md#H0` … `#H49`); collapsing only on the raw string reported
  // one changed page as fifty changed pages, and called a per-path cap a
  // per-page cap. Phase 1 resolves each distinct path to the page its record is
  // about; phase 2 reports one row per PAGE. Reads are memoised by store
  // filename, so those fifty anchors cost one read, which is what lets the raw
  // bound be generous without the work being.
  const uniquePaths = [...new Set(paths)].slice(0, MAX_PATHS_RESOLVED);
  const pathsTruncated = new Set(paths).size > MAX_PATHS_RESOLVED;
  const ctx = { cache: new Map(), windowsStyle: lib === path.win32 };

  /** page key → the first row built for it (keyed by resolved page, not path) */
  const byPage = new Map();
  // ONE PHYSICAL FILE IS ONE PAGE. On a Windows-style vault `wiki/a.md` and
  // `WIKI/A.md` name the same file, so keying rows by the literal spelling gave
  // two rows and `checked: 2` for one page — the very double-counting the
  // collapse exists to prevent, one layer up from the anchors that motivated it.
  const identity = (p) => (ctx.windowsStyle ? p.toLowerCase() : p);
  for (const pagePath of uniquePaths) {
    const record = readRecordFor(io, lib, dir, pagePath, listing, ctx);
    // Report the PAGE the record is about; for a miss there is nothing resolved,
    // so the requested path is the honest label.
    const notePath = record.found ? record.page : pagePath;
    const pageId = identity(notePath);
    if (byPage.has(pageId)) {
      // The row already exists; record that THIS spelling also led to it, so a
      // caller can join its own results back onto the row it belongs to.
      byPage.get(pageId).requested.push(pagePath);
      continue;
    }

    // WHICH FILE IS BEING TESTED MATTERS. When the record lookup failed, the
    // label falls back to the requested path — and a requested path can carry a
    // block anchor, which names a SECTION, not a file. Statting `a.md#H`
    // verbatim then produced a confident `page-missing` about something that
    // never had to exist. `#` is legal in a filename, so the literal form is
    // still tried first; only its ENOENT falls back to the page part.
    const statCandidates = [notePath];
    const noteHash = notePath.indexOf('#');
    if (!record.found && noteHash > 0) statCandidates.push(notePath.slice(0, noteHash));
    let stat = null;
    let statFailed = null;
    for (const candidate of statCandidates) {
      try {
        stat = io.statSync(lib.join(vault.path, candidate.split('/').join(lib.sep)));
        statFailed = null;
        break;
      } catch (err) {
        // ENOENT PROVES ABSENCE; anything else (EACCES on a parent, EPERM, an
        // I/O error) proves only that we could not look, and reporting it as
        // `page-missing` would be a fabricated fact about the vault.
        statFailed = err && err.code === 'ENOENT' ? 'absent' : 'unreadable';
        if (statFailed === 'unreadable') break;
      }
    }

    let state;
    let reason;
    let noteMtime = null;
    let sizeNow = null;
    const freshness = record.found ? record.freshness : null;
    const indexedMtime = freshness ? freshness.importMtime : null;
    const embeddedAt = freshness ? freshness.embeddedAt : null;
    const sizeAtImport = freshness ? freshness.importSize : null;
    let sizeEvidence = 'unknown';
    let usedFallbackClock = false;

    // ORDER MATTERS, AND THE PROVEN FACT COMES FIRST. A page that is not on
    // disk is not on disk whatever the store says, and that is the fact a
    // reader needs: the hit points at something that is gone. Checking the
    // record's readability first buried it, so an unreadable store file plus a
    // deleted page answered `unknown` — trading a certainty for a doubt.
    if (statFailed === 'absent') {
      state = PAGE_MISSING;
    } else if (record.unreadable) {
      // A candidate existed and could not be read, or matched only through a
      // lossy fold, or two files disagreed. Either way the index may well cover
      // this page — claiming `not-indexed` would assert a fact about the vault
      // built out of our own failure to look.
      state = UNKNOWN;
      reason = record.reason;
    } else if (!record.found) {
      // Every candidate was read successfully and none spoke about this page.
      state = NOT_INDEXED;
    } else if (freshness?.tombstoned) {
      state = NOT_INDEXED;
      reason = 'tombstoned';
    } else if (statFailed || !stat || !Number.isFinite(stat.mtimeMs)) {
      // `typeof === 'number'` admitted NaN and the infinities, and a NaN mtime
      // makes every `>` comparison false — so the page came back `fresh`, a
      // positive claim of currency built on a measurement that does not exist.
      // The serialiser then turned `noteMtime: NaN` into `null`, hiding it.
      state = UNKNOWN;
      reason = 'page-unreadable';
    } else {
      noteMtime = stat.mtimeMs;
      sizeNow = Number.isInteger(stat.size) && stat.size >= 0 ? stat.size : null;
      let decidedByClock = false;
      // `last_import.mtime` first — it is the note's own mtime, so the
      // comparison is like-for-like. `last_embed.at` is the fallback for the
      // records that carry no usable import mtime (16 fleet-wide). It is a
      // PROCESSING timestamp, not a file timestamp: normally later than the
      // import, so normally the more permissive basis — but the two come from
      // different clocks, so on a synced vault it can also over-report. The
      // fallback is therefore reported as such rather than claimed conservative.
      if (sizeAtImport !== null && sizeNow !== null) {
        sizeEvidence = sizeAtImport === sizeNow ? 'identical' : 'differs';
      }
      const basis = indexedMtime ?? embeddedAt;
      // SIZE OUTRANKS THE CLOCK, because it is the stronger evidence. A note
      // whose byte size differs from the one recorded at import CANNOT be the
      // bytes that were embedded — mtime says nothing that can overturn that.
      // Ranked the other way round, a page whose size went 100 → 999 under an
      // unchanged mtime (a restored timestamp, a sync client, `touch -r`) was
      // reported `fresh`: a positive claim of currency against proof otherwise.
      if (sizeEvidence === 'differs') {
        state = CHANGED;
      } else if (!basis) {
        state = UNKNOWN;
        reason = 'no-freshness-basis';
      } else if (noteMtime > basis + MTIME_TOLERANCE_MS) {
        // `touched` requires PROVEN identical size: mtime moved and the bytes
        // are the same length, so it may be a same-length edit or a sync touch.
        // With no size evidence at all the honest label is still "modified" —
        // the mtime moved — and `sizeEvidence: 'unknown'` says the byte axis was
        // never established, rather than implying it was checked.
        state = sizeEvidence === 'identical' ? TOUCHED : CHANGED;
        decidedByClock = true;
      } else {
        state = FRESH;
        decidedByClock = true;
      }
      // Only a verdict the CLOCK decided may be labelled with the clock it used.
      // Emitted whenever the fallback existed, it labelled a comparison that
      // never ran — a size-decided `changed` carried `basis: last-embed-at`.
      usedFallbackClock = decidedByClock && indexedMtime === null && embeddedAt !== null;
    }

    byPage.set(pageId, {
      path: notePath,
      // Every requested spelling that resolved to this page. A caller joining
      // its own results back onto these rows cannot do it by string equality:
      // the row is keyed by the resolved PAGE, while a hit may carry a block
      // anchor or a non-canonical spelling.
      requested: [pagePath],
      state,
      ...(reason ? { reason } : {}),
      indexedMtime,
      noteMtime,
      embeddedAt,
      sizeAtImport,
      sizeNow,
      sizeEvidence,
      // Emitted ONLY when a timestamp comparison actually happened, on the
      // fallback clock. See .
      ...(usedFallbackClock ? { basis: 'last-embed-at' } : {}),
    });
  }

  const allPages = [...byPage.values()];
  const pagesTruncated = allPages.length > MAX_PAGES_ASSESSED;
  const pages = allPages.slice(0, MAX_PAGES_ASSESSED);

  const summary = {
    checked: 0, fresh: 0, changed: 0, touched: 0,
    notIndexed: 0, pageMissing: 0, unknown: 0, doubtful: 0,
  };
  for (const p of pages) {
    summary.checked += 1;
    if (p.state === FRESH) summary.fresh += 1;
    else if (p.state === CHANGED) summary.changed += 1;
    else if (p.state === TOUCHED) summary.touched += 1;
    else if (p.state === NOT_INDEXED) summary.notIndexed += 1;
    else if (p.state === PAGE_MISSING) summary.pageMissing += 1;
    else summary.unknown += 1;
    if (isDoubtful(p.state)) summary.doubtful += 1;
  }

  return {
    ...base,
    checkable: true,
    pages,
    summary,
    // TWO KINDS OF TRUNCATION, AND THEY DO NOT MEAN THE SAME THING.
    //
    //  - `pagesTruncated` — more PAGES were assessed than are reported. Rows are
    //    missing, and `pagesFound` says how many there were.
    //  - `pathsTruncated` — more distinct PATHS arrived than were resolved. How
    //    many PAGES that cost is genuinely unknown from here: two hundred
    //    anchors of one note cost nothing, two hundred distinct notes cost a
    //    lot. `pathsGiven` and `pathsResolved` state the input, and nothing
    //    pretends to know the page count.
    //
    // Collapsing both into one `truncated` reported a full answer as truncated
    // whenever a caller passed many sections of a single page.
    ...(pagesTruncated ? { pagesTruncated: true, pagesFound: allPages.length } : {}),
    ...(pathsTruncated
      ? { pathsTruncated: true, pathsGiven: new Set(paths).size, pathsResolved: uniquePaths.length }
      : {}),
    ...(refusedPaths > 0 ? { refusedPaths } : {}),
  };
}

/**
 * The same assessment, wrapped so no caller on a response path can be broken by
 * it. Returns `null` when there is nothing worth saying, so the field is simply
 * absent rather than present-and-empty.
 *
 * @returns {object|null}
 */
export function freshnessFor(vault, pagePaths, deps = {}) {
  try {
    const result = assessEmbeddingFreshness(vault, pagePaths, deps);
    if (!result.checkable) {
      // `no-paths` means there was nothing to say; the other reasons are facts
      // about the vault worth reporting once, so the reader knows the silence
      // is "could not look" and not "looked and found nothing".
      return result.reason === 'no-paths' ? null : result;
    }
    return result;
  } catch {
    // AN UNEXPECTED FAILURE IS STILL "COULD NOT LOOK", and returning `null` here
    // made it vanish: the field disappeared from the response exactly as it does
    // when there was nothing to assess, so the reader could not tell the two
    // apart. That is the rule this module exists to enforce, broken by its own
    // safety net.
    return {
      storePath: `${SMART_ENV_DIR}/${SMART_ENV_MULTI}`,
      toleranceMs: MTIME_TOLERANCE_MS,
      checkable: false,
      reason: 'assessment-failed',
      detail:
        'Freshness could not be checked: the check itself failed. Absence of a warning here is NOT '
        + 'evidence that the results are current.',
    };
  }
}

/**
 * One sentence a human or a model can act on, or `null` when there is no doubt
 * to report. Kept next to the verdicts so every surface phrases this the same
 * way — the alternative is three call sites inventing three vocabularies for
 * the same fact.
 */
export function freshnessNote(freshness) {
  if (!freshness || !freshness.checkable || !freshness.summary) return null;
  const s = freshness.summary;
  const parts = [];
  // "modified since indexing", not "edited": the evidence is a moved mtime or a
  // changed byte size, and neither proves a human edited anything. The wording
  // used to say "edited", which claimed more than the measurement supports.
  if (s.changed > 0) parts.push(`${s.changed} modified since indexing`);
  if (s.touched > 0) parts.push(`${s.touched} whose timestamp moved but whose size did not (a same-length edit, or a sync touch)`);
  if (s.pageMissing > 0) parts.push(`${s.pageMissing} whose page is no longer on disk`);
  if (s.notIndexed > 0) parts.push(`${s.notIndexed} the index does not cover`);
  if (parts.length === 0) return null;
  return `Of ${s.checked} page(s) behind these results, ${parts.join(', ')}. `
    + 'Those hits reflect the index, not the page as it is now — re-read the page, '
    + 'or re-index the vault in Obsidian, before relying on them.';
}
