/**
 * find_twin_pages — C11 of [[roadmap-emprunts]] §2.17. The QUASI-TWIN pairs of
 * a wiki: two pages on one subject, written in two sessions, between which the
 * links, the searches and the updates then split so that neither is complete.
 *
 * Read-only and filesystem-only: reads Smart Connections' vector store
 * (`<vault>/.smart-env/multi/`) and the wiki pages themselves, writes nothing.
 * Same deterministic-core / thin-tool split as `find_boundary_pages`: this
 * module is only the I/O shell (locate vectors → reconcile with what is on
 * disk → drop what must not be compared → delegate to `findTwinPages`).
 *
 * ---------------------------------------------------------------------------
 * "UNAVAILABLE HERE" IS AN ANSWER, AND IT IS NOT ZERO
 * ---------------------------------------------------------------------------
 * Most of the fleet has no Smart Connections index; some vaults are remote and
 * have no local disk to read. In every such case the response carries
 * `available: false`, a machine-readable `reason`, a sentence saying what is
 * missing — and NO `pairs` KEY AT ALL. That absence is the point: a consumer
 * reading `result.pairs.length` cannot turn "I could not look" into "I looked
 * and found none", because there is nothing there to read. A vault that WAS
 * examined and yielded nothing answers `available: true, found: 0, pairs: []`,
 * which is a different shape and a different fact.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS HELD OUT OF THE COMPARISON, AND WHY EVERY COUNT IS REPORTED
 * ---------------------------------------------------------------------------
 *  - PATHS THE STORE STILL KNOWS BUT DISK NO LONGER DOES. A vector store is a
 *    snapshot: measured, 108 of 279 indexed wiki paths on the router's own
 *    vault and 161 of 325 on SchoolMouv point at pages that have been moved or
 *    deleted. Comparing those resurrects a page's own deleted predecessor and
 *    reports it as its twin — the single largest source of nonsense here.
 *  - GENERATED NAVIGATION. `wiki/log.md` and every `index.md` are OKF
 *    projections, structurally alike BY CONSTRUCTION. Before they were held
 *    out, index-against-index pairs sat at the top of the ranking on four of
 *    the five vaults measured. `wiki-lint` already excludes them from Checks
 *    A/B for the same reason; this reuses that same `isWikiContentPath` rule
 *    rather than inventing a second definition of "generated".
 *  - PAGES WHOSE THINNESS IS THEIR JOB — `redirect`, `source`, `answer`, the
 *    exemption set `boundary-score` already uses, verbatim. Migration stubs are
 *    ~89 words of IDENTICAL boilerplate: 29 of them on the router's vault
 *    produced 406 spurious "near-duplicate" pairs between subjects as unrelated
 *    as an AI-memory note and a licence audit.
 *
 * None of these is a silent cut. `excluded` reports each count, because a
 * ranking that quietly dropped a third of the corpus reads as "I looked at
 * everything" when it did not.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  findTwinPages,
  SENSITIVITY_K,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_PAGES,
  RESTRICT_MODES,
  SIGNAL_NOT_ORDER,
} from '../helpers/twin-pages.mjs';
import { readSmartEnvEmbeddings, INDEX_SNAPSHOT_FRESHNESS } from '../helpers/smart-env-embeddings.mjs';
import { isWikiContentPath, hasProjectionMarker } from '../helpers/okf-projections.mjs';
import { parseFrontmatter } from '../helpers/llms-txt-exporter.mjs';
import { DEFAULT_EXEMPT_TYPES } from '../helpers/boundary-score.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';

export const TOOL_NAME = 'find_twin_pages';

/** Root the scan is confined to. The wiki is the corpus C11 is about. */
export const WIKI_ROOT = 'wiki';

/** Reasons the check reports itself unavailable. None of them means "zero pairs". */
export const UNAVAILABLE = Object.freeze({
  REMOTE_VAULT: 'remote-vault',
  NO_EMBEDDINGS: 'no-embeddings',
  NO_WIKI: 'no-wiki',
});

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Find QUASI-TWIN pages in a wiki — pairs so close in meaning that a vault has probably written the '
    + 'same subject twice, splitting its links and updates between two half-complete pages. Read-only, '
    + 'deterministic, no LLM: compares the per-page vectors Smart Connections already stores on disk '
    + '(`<vault>/.smart-env/multi/`) by cosine, every page against every other. THE THRESHOLD IS DERIVED '
    + "FROM THE VAULT'S OWN DISTRIBUTION and reported with the result — a fixed cosine cut does not "
    + 'transfer between vaults (measured: 0.95 selects 93 pairs on one vault and 398 on another). '
    + 'A pair PROPOSES A READING, never a merge: similarity does not establish redundancy, and templated '
    + 'series are its dominant false positive, so every row carries the evidence (same folder, same '
    + 'basename, shared links, already linked) needed to dismiss one at a glance. BRANCH ON `available` — '
    + 'it is THE discriminator. Five reasons arrive as `available: false` with NO `pairs` KEY: '
    + '`no-embeddings`, `remote-vault`, `no-wiki`, `corpus-too-small`, `no-spread`. A sixth way to decline '
    + 'is a THROWN refusal, `too-many-pages` (corpus past `maxPages`), which returns no response body at '
    + 'all. None of them is the same answer as `available: true, found: 0`, which means the vault WAS '
    + 'examined and nothing stood out — and `result.pairs?.length ?? 0` would read every one of them as '
    + '"no twins", which is why the key is absent rather than empty. Every ranking also carries `coverage` '
    + '(how many ELIGIBLE pages actually carried a vector and were compared, stated as a sentence — '
    + '`available: true` is not "the whole vault was analysed") and `freshness` (the vectors are an index '
    + 'SNAPSHOT: a page edited since the last indexing pass still carries its previous vector, and '
    + 'per-page staleness cannot be determined). Local vaults only (the vector store is a dot-directory '
    + 'the REST API does not serve).',
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'Vault name (see list_vaults). Omit to use the default vault.',
      },
      limit: {
        type: 'number',
        description: `How many pairs to return, closest first. Default ${DEFAULT_LIMIT}, hard ceiling ${MAX_LIMIT}. \`found\` reports how many were above the threshold and \`truncated\` says whether more exist.`,
      },
      sensitivity: {
        type: 'number',
        description: `\`k\`, in sigma-equivalents of the log-distance MAD. Default ${SENSITIVITY_K}. HIGHER is stricter (fewer, closer pairs); lower widens the net. This is the per-vault calibration knob: the derived cosine threshold is always reported, so you can raise or lower k until the list is the length you will actually read.`,
      },
      folders: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict the corpus to pages under these vault-relative folders (e.g. ["wiki/decisions"]). Narrows what is compared AND what the threshold is derived from — a scoped run answers a scoped question.',
      },
      restrictTo: {
        type: 'string',
        enum: [...RESTRICT_MODES],
        description: 'Bound the pairs considered: "none" (default), "folder" (same folder only), or "folder-or-links" (same folder OR at least one common outgoing wikilink). NOT the default, on measurement: the bound removed 9 of 70 above-threshold pairs on one vault and 0 of 220 on another (where every page links the same hubs, so it filters nothing), while the dot products it would save cost less than the page reads it needs. `removedByRestriction` always reports what it cut.',
      },
      maxPages: {
        type: 'number',
        description: `Ceiling on comparable pages before the tool refuses rather than spend the time unasked. Default ${MAX_PAGES}. Pages are never silently dropped — a truncated corpus would make "no pairs found" a statement about the ceiling instead of about the vault.`,
      },
      exemptTypes: {
        type: 'array',
        items: { type: 'string' },
        description: `Frontmatter \`type:\` values held out of the comparison. Default ${JSON.stringify([...DEFAULT_EXEMPT_TYPES])} — pages whose sameness is by design (migration stubs are identical boilerplate and generate hundreds of spurious pairs). Pass [] to compare every page.`,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/** An ACTIONABLE refusal — see the twin in `helpers/twin-pages.mjs`. */
function refusal(message, reason) {
  const err = new Error(message);
  err.kind = 'validation';
  if (reason) err.reason = reason;
  return err;
}

/**
 * Pick the path library matching the STYLE of the stored vault path rather than
 * the runtime's. Same detection as `resolve-vault-path.mjs`.
 */
function libFor(vaultPath) {
  return /^[A-Za-z]:[\\/]/.test(vaultPath) || /^\\\\/.test(vaultPath) ? path.win32 : path.posix;
}

/**
 * Every `.md` under `<vault>/wiki`, as vault-relative posix paths.
 * Dot-directories and `node_modules` are skipped, symlinked directories are not
 * followed (`readdirSync` reports them as symlinks, not directories).
 */
function walkWiki(io, lib, vaultPath, budget) {
  const out = [];
  const stack = [WIKI_ROOT];
  let scanned = 0;
  let truncated = false;
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = io.readdirSync(lib.join(vaultPath, ...rel.split('/')), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (scanned >= budget) { truncated = true; return { out, truncated }; }
      scanned += 1;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) stack.push(child);
      else if (e.name.toLowerCase().endsWith('.md')) out.push(child);
    }
  }
  return { out, truncated };
}

const WIKILINK_RE = /!?\[\[([^\]|\n[]+)(?:\|[^\]\n[]*)?\]\]/g;

/** Outgoing wikilink targets of a page body. Evidence only — never a filter by default. */
function wikilinksOf(body) {
  const out = [];
  WIKILINK_RE.lastIndex = 0;
  let m;
  while ((m = WIKILINK_RE.exec(body)) !== null) out.push(m[1]);
  return out;
}

export async function findTwinPagesTool(registry, args = {}, _deps = {}) {
  const { vault: name, limit, sensitivity, folders, restrictTo, maxPages, exemptTypes } = args;
  const io = _deps.fs || fs;

  // ARGUMENTS ARE CHECKED BEFORE ANY I/O, and the ordering is the point. When
  // this lived only inside `findTwinPages`, a vault with no embeddings answered
  // `available: false` and NEVER REACHED the check — so a caller who typed
  // `restrictTo: "folders"` was told about the missing store and never about
  // the argument the tool had silently dropped. A misunderstood argument must
  // be reported whatever else is wrong. (The helper keeps its own guard: it is
  // callable on its own.)
  if (restrictTo != null && (typeof restrictTo !== 'string' || !RESTRICT_MODES.includes(restrictTo))) {
    throw refusal(
      `find_twin_pages: restrictTo must be one of ${RESTRICT_MODES.map((m) => `"${m}"`).join(', ')} `
      + `(got ${safeForMessage(typeof restrictTo === 'string' ? JSON.stringify(restrictTo) : typeof restrictTo, 80)}).`,
    );
  }

  const vault = registry.resolveVault(name);

  const base = {
    vault: vault.name,
    source: { kind: 'smart-connections', store: '.smart-env/multi' },
    note: SIGNAL_NOT_ORDER,
  };

  // ---- a local disk, or no answer -----------------------------------------
  if (vault.type !== 'local' || !vault.path) {
    return {
      ...base,
      available: false,
      reason: UNAVAILABLE.REMOTE_VAULT,
      detail:
        `Vault "${vault.name}" has no local filesystem path, and the vector store lives in a `
        + 'dot-directory the Local REST API does not serve. Nothing was compared — this is NOT a '
        + 'finding of "no twins".',
    };
  }
  const lib = libFor(vault.path);

  // ---- the vectors ---------------------------------------------------------
  const store = readSmartEnvEmbeddings(vault.path, { fs: io });
  if (!store.ok) {
    return {
      ...base,
      available: false,
      reason: UNAVAILABLE.NO_EMBEDDINGS,
      storeReason: store.reason,
      detail:
        `No Smart Connections vectors were found for this vault (${store.reason} at `
        + `\`${store.storePath}\`). Cosine needs embeddings, and this vault has none — so the check is `
        + 'UNAVAILABLE here, which is NOT a finding of "no twins". Install and enable the '
        + 'smart-connections plugin in Obsidian and let it index the vault, then ask again. '
        + 'Meanwhile `wiki-lint --deep` Check J still compares pages by concept overlap where digests exist.',
    };
  }

  // ---- the pages that actually exist --------------------------------------
  const { out: onDisk, truncated: walkTruncated } = walkWiki(io, lib, vault.path, 200000);
  if (onDisk.length === 0) {
    return {
      ...base,
      available: false,
      reason: UNAVAILABLE.NO_WIKI,
      detail:
        `No pages found under \`${WIKI_ROOT}/\` in vault "${vault.name}". Nothing was compared — this `
        + 'is NOT a finding of "no twins".',
    };
  }

  const wantedFolders = Array.isArray(folders)
    ? folders.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    : [];
  const exemptSet = new Set(
    (Array.isArray(exemptTypes) ? exemptTypes : [...DEFAULT_EXEMPT_TYPES])
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().toLowerCase()),
  );

  const excluded = {
    // Indexed paths whose page is gone from disk. Reported first because it is
    // routinely the biggest number here and the least expected.
    notOnDisk: 0,
    outsideFolders: 0,
    generatedNavigation: 0,
    byType: {},
    // NO VECTOR AT ALL — the page post-dates the last indexing pass.
    withoutVector: 0,
    // A VECTOR THAT EXISTS BUT CANNOT BE COMPARED — a different model, a
    // different dimensionality, or a zero norm. Kept SEPARATE from
    // `withoutVector` because the two are different facts and the coverage
    // sentence used to state the wrong one: a page dropped for a minority model
    // was reported as having "carried none", contradicting `source.otherModels`
    // two fields away. `byReason` names which cohort each page fell into.
    incompatibleVector: 0,
    incompatibleByReason: {},
    unreadable: 0,
  };

  // A Map, not an object: `type:` comes from vault frontmatter, and a page
  // declaring `type: __proto__` must increment an ordinary counter rather than
  // silently no-op — the lesson `boundary-score` records for its own tallies.
  const typeTally = new Map();
  const incompatibleTally = new Map();
  const onDiskSet = new Set(onDisk);
  // SEPARATORS ARE NORMALISED BEFORE THE PREFIX TEST. A record keyed
  // `wiki\Ident\x.md` — the store is written by a plugin on Windows — matched
  // neither `startsWith('wiki/')` nor any page on disk, so it was an orphan that
  // escaped the orphan count entirely: measured `notOnDisk: 2` for 3 orphaned
  // records. This only fixes the ACCOUNTING; the lookup below still uses the
  // canonical forward-slash form, so such a record still contributes no vector.
  const wikiPrefix = `${WIKI_ROOT}/`;
  const indexedWikiPaths = [];
  for (const indexedPath of store.vectors.keys()) {
    const norm = indexedPath.replace(/\\/g, '/');
    if (!norm.startsWith(wikiPrefix)) continue;
    indexedWikiPaths.push(norm);
    if (!onDiskSet.has(norm)) excluded.notOnDisk += 1;
  }
  for (const [incompatiblePath] of store.incompatible || []) {
    const norm = incompatiblePath.replace(/\\/g, '/');
    if (norm.startsWith(wikiPrefix) && !onDiskSet.has(norm)) excluded.notOnDisk += 1;
  }

  const pages = [];
  for (const rel of onDisk) {
    if (wantedFolders.length && !wantedFolders.some((f) => rel === f || rel.startsWith(`${f}/`))) {
      excluded.outsideFolders += 1;
      continue;
    }
    // Path-level first: it needs no read, and it is `wiki-lint`'s own rule.
    if (!isWikiContentPath(rel)) { excluded.generatedNavigation += 1; continue; }
    let content;
    try {
      content = io.readFileSync(lib.join(vault.path, ...rel.split('/')), 'utf8');
    } catch {
      excluded.unreadable += 1;
      continue;
    }
    // …then the marker, which catches a generated file parked outside the
    // reserved basenames.
    if (hasProjectionMarker(content)) { excluded.generatedNavigation += 1; continue; }

    let frontmatter = {};
    let body = content;
    try {
      ({ frontmatter, body } = parseFrontmatter(content));
    } catch {
      body = content;
    }
    const type = typeof frontmatter.type === 'string' ? frontmatter.type.trim() : '';
    if (type && exemptSet.has(type.toLowerCase())) {
      typeTally.set(type, (typeTally.get(type) || 0) + 1);
      continue;
    }
    const vector = store.vectors.get(rel);
    if (!vector) {
      // "No vector" and "a vector we cannot use" are DIFFERENT FACTS and are
      // counted separately — the coverage sentence below states each correctly.
      const why = store.incompatible && store.incompatible.get(rel);
      if (why) {
        excluded.incompatibleVector += 1;
        incompatibleTally.set(why, (incompatibleTally.get(why) || 0) + 1);
      } else {
        excluded.withoutVector += 1;
      }
      continue;
    }

    pages.push({ path: rel, vector, links: wikilinksOf(body) });
  }
  const sortEntries = (m) => Object.fromEntries([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  excluded.byType = sortEntries(typeTally);
  excluded.incompatibleByReason = sortEntries(incompatibleTally);

  const source = {
    kind: 'smart-connections',
    store: store.storePath,
    model: store.model,
    dimensions: store.dimensions,
    files: store.files,
    // A file the walk could not open is not a file with nothing in it.
    unreadableFiles: store.unreadableFiles,
    // A store that also holds vectors from a second model: reported, never
    // blended. A cosine across two embedding spaces is a number without a
    // meaning — the same rule `search_smart` applies to its two tiers.
    otherModels: store.otherModels,
    // The dimension cohort had NO reporting channel at all before this: the
    // reader computed the number and the tool never copied it, so a store split
    // 12/2 across two dimensionalities of the SAME model lost the minority and
    // nothing in the response could tell you. `otherModels` covered the
    // multi-model case; this is its missing twin.
    mixedDimensions: store.mixedDimensions,
    zeroNormVectors: store.zeroNorm,
    malformedLines: store.malformed,
    unusableRecords: store.unusable,
    indexedWikiPaths: indexedWikiPaths.length,
  };

  if (pages.length === 0) {
    return {
      ...base,
      source,
      available: false,
      reason: UNAVAILABLE.NO_EMBEDDINGS,
      detail:
        `${onDisk.length} page(s) exist under \`${WIKI_ROOT}/\` but none of them carries a vector in the `
        + 'store (they may all post-date the last indexing pass, or all be held out). Nothing was '
        + 'compared — this is NOT a finding of "no twins".',
      excluded,
      wikiPagesOnDisk: onDisk.length,
    };
  }

  let result;
  try {
    result = findTwinPages({ pages }, { limit, sensitivity, restrictTo, maxPages });
  } catch (err) {
    // The message can quote vault-derived text; these throw straight past
    // `wrapResult`, so they are neutralised here rather than trusting the
    // error channel. Same reasoning as `boundary-score`'s `oneLine`.
    // The machine-readable `reason` is CARRIED THROUGH: rebuilding the error
    // from its message alone dropped it, and a caller enumerating the ways this
    // check declines to answer would have seen `too-many-pages` disappear at
    // exactly the boundary where it is delivered.
    throw refusal(safeForMessage(String(err && err.message ? err.message : err), 500), err && err.reason);
  }

  // COVERAGE, AS A FRACTION AND AS A SENTENCE. `excluded.withoutVector` alone
  // required the reader to do arithmetic to discover that `available: true` is
  // not "the whole vault was analysed" — and nobody does that arithmetic. An
  // exhaustive comparison of the 4 pages that happen to carry a vector must not
  // be readable as coverage of the 10 pages that exist.
  const eligiblePages = pages.length + excluded.withoutVector + excluded.incompatibleVector;
  const comparedPages = result.corpus ? result.corpus.pages : 0;
  const heldOut = excluded.generatedNavigation
    + Object.values(excluded.byType).reduce((a, b) => a + b, 0)
    + excluded.outsideFolders + excluded.unreadable;
  // The two ways an eligible page can fail to be compared, stated APART. Rolling
  // them together is what made the sentence false: a page whose vector sits in a
  // rejected model or dimension cohort HAS a vector, and saying it "carried
  // none" contradicted `source.otherModels` / `source.mixedDimensions`.
  const notComparedClauses = [];
  if (excluded.withoutVector > 0) {
    notComparedClauses.push(`${excluded.withoutVector} carried no vector at all (not yet indexed)`);
  }
  if (excluded.incompatibleVector > 0) {
    const reasons = Object.entries(excluded.incompatibleByReason).map(([r, n]) => `${n} ${r}`).join(', ');
    notComparedClauses.push(
      `${excluded.incompatibleVector} carried a vector that could not be compared (${reasons})`,
    );
  }
  const coverage = {
    comparedPages,
    eligiblePages,
    withoutVector: excluded.withoutVector,
    incompatibleVector: excluded.incompatibleVector,
    wikiPagesOnDisk: onDisk.length,
    heldOut,
    fraction: eligiblePages > 0 ? comparedPages / eligiblePages : 0,
    // comparedPages + withoutVector + incompatibleVector + heldOut === wikiPagesOnDisk.
    // Emitted so a reader can check the books rather than take them on trust.
    accountsFor: comparedPages + excluded.withoutVector + excluded.incompatibleVector + heldOut,
    statement:
      `${comparedPages} of ${eligiblePages} eligible page(s) were compared`
      + (notComparedClauses.length ? `; ${notComparedClauses.join('; ')}` : '')
      + `. ${onDisk.length} markdown file(s) exist under ${WIKI_ROOT}/, of which ${heldOut} were held out `
      + '(generated navigation, exempt types, out of scope, unreadable).',
  };

  return {
    ...base,
    source,
    wikiPagesOnDisk: onDisk.length,
    wikiScanTruncated: walkTruncated,
    excluded,
    ...result,
    // Only on an answer that HAS a ranking: an unavailable response compared
    // nothing, so a coverage fraction there would describe a comparison that
    // never happened.
    ...(result.available ? { coverage, freshness: INDEX_SNAPSHOT_FRESHNESS } : {}),
    // `base` already carries the note; `result` carries the same string. Spread
    // order keeps exactly one copy and the value is the shared constant, so the
    // wording cannot drift between the two layers.
  };
}

export const _internals = { walkWiki, wikilinksOf, libFor };
