/**
 * find_twin_pages — C11 of [[roadmap-emprunts]] §2.17. The QUASI-TWIN pairs of
 * a wiki: two pages on one subject, written in two sessions, between which the
 * links, the searches and the updates then split so that neither is complete.
 *
 * Read-only: reads Smart Connections' vector store (`<vault>/.smart-env/multi/`)
 * and the wiki pages themselves, writes nothing. Same deterministic-core /
 * thin-tool split as `find_boundary_pages`: this module is only the I/O shell
 * (locate vectors → reconcile with what exists → drop what must not be compared
 * → delegate to `findTwinPages`).
 *
 * ---------------------------------------------------------------------------
 * TWO BACKENDS, ONE COMPARISON (v0.82.0)
 * ---------------------------------------------------------------------------
 * A local vault reads its own disk. A vault reached over the network reads the
 * SAME store through the bridge's `GET /smart-env/sources`, and its pages
 * through the ordinary Local REST API. The store needed a bridge route because
 * it lives in a dot-directory the REST API does not serve — measured, Obsidian's
 * own file index does not carry it either. The pages did not: they are ordinary
 * files in ordinary directories.
 *
 * The backends decide WHERE BYTES COME FROM and nothing else. Both hand their
 * text to `reconcileSmartEnvStore`, the single place that resolves last-wins,
 * tombstones, the winning model and the incomparable cohorts — so they cannot
 * disagree about what the store says. Verified end to end on this vault: 805
 * pages, 0 missing over REST, 0 differing vectors.
 *
 * ---------------------------------------------------------------------------
 * "UNAVAILABLE HERE" IS AN ANSWER, AND IT IS NOT ZERO
 * ---------------------------------------------------------------------------
 * Most of the fleet has no Smart Connections index; a remote vault may sit
 * behind a bridge too old to serve the store. In every such case the response carries
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
import {
  readSmartEnvEmbeddings,
  readSmartEnvEmbeddingsViaRest,
  INDEX_SNAPSHOT_FRESHNESS,
} from '../helpers/smart-env-embeddings.mjs';
import { makeRestWalker } from '../helpers/resolve-vault-path.mjs';
import { listFilesIn, getFileContent, getSmartEnvSources } from '../rest-client.mjs';
import { isWikiContentPath, hasProjectionMarker } from '../helpers/okf-projections.mjs';
import { parseFrontmatter } from '../helpers/llms-txt-exporter.mjs';
import { DEFAULT_EXEMPT_TYPES } from '../helpers/boundary-score.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';

export const TOOL_NAME = 'find_twin_pages';

/** Root the scan is confined to. The wiki is the corpus C11 is about. */
export const WIKI_ROOT = 'wiki';

/** Reasons the check reports itself unavailable. None of them means "zero pairs". */
export const UNAVAILABLE = Object.freeze({
  NO_EMBEDDINGS: 'no-embeddings',
  NO_WIKI: 'no-wiki',
  /**
   * The vault is remote and its bridge does not serve `/smart-env/sources` —
   * an older bridge, or none. Kept APART from `no-embeddings` because the two
   * ask different things of the reader: this one has a fix (upgrade the
   * bridge), the other is an ordinary fact about the vault. The bridge route
   * never answers 404 itself, which is what lets a 404 mean only this.
   */
  BRIDGE_ROUTE_ABSENT: 'bridge-route-absent',
  /**
   * The bridge answered with a PREFIX of the store — it hit its own budget.
   * Comparing a partial corpus would report "no twins" about pages that were
   * never fetched, so it is refused instead of quietly narrowed.
   */
  STORE_TRUNCATED: 'store-truncated',
  /** The store could not be fetched at all: network, auth, timeout. */
  STORE_UNREACHABLE: 'store-unreachable',
  /**
   * The store WAS fetched, and its own header contradicts its body — the counts
   * do not balance, or fewer records arrived than were claimed. Different from
   * `store-unreachable`: something answered, and what it said cannot be trusted.
   */
  STORE_INCONSISTENT: 'store-inconsistent',
  /**
   * The vault's own file list could not be enumerated over REST, or came back
   * truncated. Same rule as the store: an incomplete corpus is not a small one.
   */
  WIKI_ENUMERATION_INCOMPLETE: 'wiki-enumeration-incomplete',
  /**
   * Pages were enumerated but some could not be READ over the network.
   *
   * On disk an unreadable page is a rare accident and is reported as a count.
   * Over REST it is a network event, and a run that lost 90 of 100 pages would
   * happily rank the other 10 and call itself `available: true` — every twin
   * among the lost pages simply gone, with nothing in the answer that reads as
   * a failure. So the remote path refuses instead (review, 2026-08-31).
   */
  WIKI_READ_INCOMPLETE: 'wiki-read-incomplete',
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
    + 'it is THE discriminator. Ten reasons arrive as `available: false` with NO `pairs` KEY: '
    + '`no-embeddings`, `no-wiki`, `corpus-too-small`, `no-spread`, and — on a vault reached over the '
    + 'network — `bridge-route-absent` (nothing served the store route; usually a bridge older than '
    + '0.9.0), `store-truncated` (only a prefix of the store arrived), `store-inconsistent` (its header '
    + 'contradicts its body), `store-unreachable` (it could not be fetched at all), '
    + '`wiki-enumeration-incomplete` (the file list did not come back whole) and `wiki-read-incomplete` '
    + '(some pages could not be read, so the corpus would be missing them). An eleventh way to decline '
    + 'is a THROWN refusal, `too-many-pages` (corpus past `maxPages`), which returns no response body at '
    + 'all. None of them is the same answer as `available: true, found: 0`, which means the vault WAS '
    + 'examined and nothing stood out — and `result.pairs?.length ?? 0` would read every one of them as '
    + '"no twins", which is why the key is absent rather than empty. Every ranking also carries `coverage` '
    + '(how many ELIGIBLE pages actually carried a vector and were compared, stated as a sentence — '
    + '`available: true` is not "the whole vault was analysed") and `freshness` (the vectors are an index '
    + 'SNAPSHOT: a page edited since the last indexing pass still carries its previous vector, and '
    + 'this answer does not check which pages those are — it compares vectors, not timestamps). '
    + 'Works on remote vaults too: the store is a '
    + 'dot-directory the Local REST API does not serve, so a networked vault is read through the '
    + "bridge's `GET /smart-env/sources` — which requires obsidian-mcp-router-bridge 0.9.0+ on the "
    + 'machine running that vault, and answers `bridge-route-absent` when it is older.',
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

/**
 * Read many pages with a bounded number of requests in flight, PRESERVING
 * INPUT ORDER. Order matters: the corpus this builds decides the tie-breaks in
 * the ranking, and a result that depended on which response landed first would
 * not be reproducible. Measured on 191 pages over loopback: 519 ms sequential,
 * 156 ms at four in flight — and on a genuinely remote vault the round trip,
 * not the read, is the whole cost.
 *
 * A page that cannot be read yields `{text: null, errorKind}` — never an empty
 * string, which would pass every exclusion filter below and seat a blank
 * document in the corpus. WHY it failed is carried, not just THAT it did: a
 * page deleted between the enumeration and its read is ordinary vault churn and
 * the corpus is still knowable without it, whereas a timeout or an auth failure
 * is a hole of unknown size (review round 2, 2026-08-31).
 *
 * @param {string[]} paths
 * @param {(p: string) => Promise<string>} read
 * @param {number} concurrency
 * @returns {Promise<Array<{text: string|null, errorKind: string|null}>>}
 *   same length and order as `paths`
 */
async function readPagesInOrder(paths, read, concurrency = 4) {
  const out = paths.map(() => ({ text: null, errorKind: 'read-failed' }));
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= paths.length) return;
      try {
        const text = await read(paths[i]);
        out[i] = typeof text === 'string'
          ? { text, errorKind: null }
          // A 200 that is not text is not a page. Same rule as everywhere else
          // here: the wrong shape is unreadable data, not empty data.
          : { text: null, errorKind: 'malformed-content' };
      } catch (err) {
        const kind = err && typeof err.kind === 'string' ? err.kind : null;
        out[i] = {
          text: null,
          errorKind: kind === 'not_found' || err?.status === 404 ? 'not_found' : (kind || 'read-failed'),
        };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Where the PAGES come from — the twin of the two store backends, and drawn on
 * the same line. The local one stats the vault directly; the remote one walks
 * and reads it over the Local REST API, which serves ordinary directories
 * perfectly well (it is only the `.smart-env` dot-directory it will not serve,
 * which is why the store needed a bridge route and this does not).
 *
 * `listPages` reports `truncated` and `listFailures` for the reason every
 * enumeration in this codebase does: a partial list makes "no twins" a
 * statement about the walk instead of about the vault.
 */
function makeDiskPageSource(io, lib, vaultPath) {
  return {
    kind: 'disk',
    async listPages() {
      const { out, truncated } = walkWiki(io, lib, vaultPath, 200000);
      return { paths: out, truncated, listFailures: 0 };
    },
    async readPages(paths) {
      return paths.map((rel) => {
        try {
          return { text: io.readFileSync(lib.join(vaultPath, ...rel.split('/')), 'utf8'), errorKind: null };
        } catch (err) {
          // ENOENT here is the same race the REST side sees as a 404: the walk
          // named the file, and it was gone by the time we opened it.
          return { text: null, errorKind: err && err.code === 'ENOENT' ? 'not_found' : 'read-failed' };
        }
      });
    },
  };
}

function makeRestPageSource(vault, deps) {
  const walk = makeRestWalker(vault, { listFilesIn: deps.listFilesIn });
  return {
    kind: 'rest',
    async listPages() {
      const { paths, truncated, listFailures } = await walk();
      // The walker enumerates the WHOLE vault; the corpus is the wiki. Filtered
      // here rather than asking the walker to narrow, so the bounds it reports
      // keep describing the same walk the disk backend performs.
      return {
        paths: paths.filter((p) => p.startsWith(`${WIKI_ROOT}/`) && p.toLowerCase().endsWith('.md')),
        truncated,
        listFailures,
      };
    },
    readPages(paths) {
      return readPagesInOrder(paths, (p) => deps.getFileContent(vault, p));
    },
  };
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

  // ---- pick the backend ----------------------------------------------------
  // A local vault reads its own disk. A remote one goes through the bridge for
  // the store (a dot-directory the Local REST API does not serve) and through
  // the ordinary Local REST API for the pages. Both paths converge on the SAME
  // reconciliation and the SAME comparison below — the backend decides where
  // bytes come from and nothing else.
  const isLocal = vault.type === 'local' && !!vault.path;
  const lib = isLocal ? libFor(vault.path) : null;

  const pageSource = isLocal
    ? makeDiskPageSource(io, lib, vault.path)
    : makeRestPageSource(vault, {
      listFilesIn: _deps.listFilesIn || listFilesIn,
      getFileContent: _deps.getFileContent || getFileContent,
    });
  base.backend = pageSource.kind;

  // ---- the vectors ---------------------------------------------------------
  const store = isLocal
    ? readSmartEnvEmbeddings(vault.path, { fs: io })
    : await readSmartEnvEmbeddingsViaRest(vault, {
      getSmartEnvSources: _deps.getSmartEnvSources || getSmartEnvSources,
    });

  if (!store.ok) {
    // The ways this declines are NOT interchangeable, and collapsing them into
    // one "no embeddings" was the old behaviour only because a remote vault
    // could never get this far. Each of these asks something different of the
    // reader, so each keeps its own reason and its own sentence.
    if (store.reason === 'bridge-route-absent') {
      return {
        ...base,
        available: false,
        reason: UNAVAILABLE.BRIDGE_ROUTE_ABSENT,
        storeReason: store.reason,
        detail:
          `\`GET /smart-env/sources\` on vault "${vault.name}" answered 404. The vector store lives in `
          + 'a dot-directory the Local REST API does not serve, so that route is the only way in. '
          + 'The likeliest cause is a bridge older than 0.9.0 on the machine running this vault — '
          + 'upgrade obsidian-mcp-router-bridge there. But a 404 can also come from something BETWEEN '
          + 'this router and that bridge (a proxy masking an authorisation failure, or one that does '
          + 'not route this path), which looks identical from here. Nothing was compared — this is NOT '
          + 'a finding of "no twins".',
      };
    }
    if (store.reason === 'store-truncated') {
      return {
        ...base,
        available: false,
        reason: UNAVAILABLE.STORE_TRUNCATED,
        storeReason: store.reason,
        storeFiles: store.files,
        storeFilesRead: store.filesRead,
        truncatedBy: store.truncatedBy,
        detail:
          `The bridge sent only ${store.filesRead} of this vault's ${store.files} store file(s) — it hit `
          + `its own budget (${store.truncatedBy}). A partial store yields a partial corpus, and comparing `
          + 'it would report "no twins" about pages that were never fetched. Nothing was compared.',
      };
    }
    if (store.reason === 'store-inconsistent') {
      return {
        ...base,
        available: false,
        reason: UNAVAILABLE.STORE_INCONSISTENT,
        storeReason: store.reason,
        ...(store.detail ? { storeDetail: safeForMessage(store.detail, 300) } : {}),
        detail:
          `The bridge for vault "${vault.name}" answered, but its response contradicts itself `
          + `(${store.detail}). A store whose own accounting does not add up cannot be told apart `
          + 'from a truncated one, so it is refused rather than compared. Nothing was compared.',
      };
    }
    if (store.reason === 'transport-failed' || store.reason === 'malformed-response' || store.reason === 'no-transport') {
      return {
        ...base,
        available: false,
        reason: UNAVAILABLE.STORE_UNREACHABLE,
        storeReason: store.reason,
        ...(store.transportError ? { transportError: safeForMessage(store.transportError, 300) } : {}),
        detail:
          `The vector store of vault "${vault.name}" could not be fetched (${store.reason}). This says `
          + 'nothing about whether the vault has twins — the comparison never ran.',
      };
    }
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
  const listed = await pageSource.listPages();
  const onDisk = listed.paths;
  const walkTruncated = listed.truncated;

  // A REMOTE ENUMERATION THAT FAILED IS NOT AN EMPTY WIKI. On disk a walk that
  // finds nothing means there is nothing; over REST it can also mean the route
  // did not answer — the distinction `resolve-vault-path.mjs` had to learn the
  // hard way. Refused here rather than answered as `no-wiki`.
  if (!isLocal && (listed.listFailures > 0 || walkTruncated)) {
    return {
      ...base,
      available: false,
      reason: UNAVAILABLE.WIKI_ENUMERATION_INCOMPLETE,
      listFailures: listed.listFailures,
      wikiScanTruncated: walkTruncated,
      wikiPagesEnumerated: onDisk.length,
      detail:
        `Enumerating vault "${vault.name}" over REST did not complete `
        + `(${listed.listFailures} listing failure(s)${walkTruncated ? ', and the walk hit its bounds' : ''}). `
        + 'An incomplete file list makes every exclusion count and every "not on disk" verdict '
        + 'unreliable, so nothing was compared — this is NOT a finding of "no twins".',
    };
  }

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
    // Named by the walk, gone by the time it was opened — ordinary churn during
    // an editing session, and NOT the same fact as "could not be read".
    vanishedDuringRun: 0,
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
  // records.
  //
  // Since v0.82.0 the STORE READER folds the separator at its own boundary too,
  // so such a record now also contributes its vector instead of being a page
  // nothing could look up. This normalisation stays because the paths reaching
  // here come from two places (the store and the walk) and only one of them is
  // that reader.
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

  // EVERY PATH-LEVEL EXCLUSION FIRST, THEN ONE BATCHED READ. The order of the
  // checks is unchanged — folders, then the generated-navigation rule, then the
  // read — but nothing is fetched for a page already ruled out. On disk that
  // saved little; over REST it is the difference between reading the corpus and
  // reading the vault.
  const candidates = [];
  for (const rel of onDisk) {
    if (wantedFolders.length && !wantedFolders.some((f) => rel === f || rel.startsWith(`${f}/`))) {
      excluded.outsideFolders += 1;
      continue;
    }
    // Path-level: it needs no read, and it is `wiki-lint`'s own rule.
    if (!isWikiContentPath(rel)) { excluded.generatedNavigation += 1; continue; }
    candidates.push(rel);
  }
  const contents = await pageSource.readPages(candidates);

  // A NETWORK THAT DROPPED PAGES MUST NOT LOOK LIKE A VAULT WITH FEWER PAGES.
  // Lose ninety of a hundred pages and the ranking would still be produced, from
  // the ten that arrived, under `available: true` — with every twin among the
  // ninety silently absent (review, 2026-08-31).
  //
  // A PAGE THAT VANISHED IS NOT A PAGE THAT FAILED, though. The walk names files
  // and the reads happen afterwards, so a note deleted in between answers 404 —
  // ordinary vault churn, and the corpus is still exactly knowable without it.
  // Refusing on that would make an editing session unable to run this check
  // (review round 2). So only genuine failures are fatal.
  const vanished = contents.reduce((n, c) => (c.errorKind === 'not_found' ? n + 1 : n), 0);
  if (!isLocal) {
    const failed = contents.reduce(
      (n, c) => (c.text === null && c.errorKind !== 'not_found' ? n + 1 : n), 0,
    );
    // …and "every single page 404'd" is not churn either: something is answering
    // 404 for everything the walk just listed. That is a broken peer, not a
    // vault that emptied itself between two calls.
    const allVanished = candidates.length > 0 && vanished === candidates.length;
    if (failed > 0 || allVanished) {
      const lost = failed + (allVanished ? vanished : 0);
      return {
        ...base,
        available: false,
        reason: UNAVAILABLE.WIKI_READ_INCOMPLETE,
        pagesRequested: candidates.length,
        pagesUnread: lost,
        pagesVanished: vanished,
        detail:
          `${lost} of ${candidates.length} page(s) in vault "${vault.name}" could not be read over REST`
          + (allVanished
            ? ' — every one of them answered 404, which is not a vault emptying itself between two '
              + 'calls but something answering 404 for everything the walk just listed'
            : '')
          + '. The corpus would be missing them, and a pair needs BOTH of its pages — so a ranking '
          + 'built from what arrived would hide twins rather than report none. Nothing was compared.',
      };
    }
  }

  const pages = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const rel = candidates[i];
    const { text: content, errorKind } = contents[i];
    // A PAGE WE COULD NOT READ IS NOT AN EMPTY PAGE. Coercing `null` to `''`
    // here would walk it past every filter below and seat a blank document in
    // the corpus, where it would be compared against everything.
    if (typeof content !== 'string') {
      // A page the walk named and the read could not find was DELETED between
      // the two — a different fact from a page that could not be read, and it
      // gets its own counter so a reader is not told an edit was a failure.
      if (errorKind === 'not_found') excluded.vanishedDuringRun += 1;
      else excluded.unreadable += 1;
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
    // WHY the corpus is empty decides what to say about it. Blaming the index
    // when every candidate was deleted mid-run — a one-page wiki edited while
    // this ran — tells the user their vault is unindexed, which is false and
    // sends them to re-index something that was fine (review round 3,
    // 2026-08-31). The store's own emptiness is answered far above; this branch
    // is about the pages.
    const lost = excluded.unreadable + excluded.vanishedDuringRun;
    if (lost > 0 && lost >= candidates.length) {
      return {
        ...base,
        source,
        available: false,
        reason: UNAVAILABLE.WIKI_READ_INCOMPLETE,
        pagesRequested: candidates.length,
        pagesUnread: excluded.unreadable,
        pagesVanished: excluded.vanishedDuringRun,
        detail:
          `None of the ${candidates.length} candidate page(s) in vault "${vault.name}" could be read `
          + `(${excluded.vanishedDuringRun} were deleted between the walk and the read, `
          + `${excluded.unreadable} failed to open). The store is fine — there was nothing left to `
          + 'compare it against. Nothing was compared.',
        excluded,
        wikiPagesOnDisk: onDisk.length,
      };
    }
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
  // HELD OUT = DELIBERATELY EXCLUDED. `unreadable` used to be added here and is
  // not: the sentence names it separately as a failure, so leaving it in this
  // total classified the same page twice — once as "held out on purpose" and
  // once as "could not be read" (review round 2, 2026-08-31). It is added back
  // to `accountsFor` on its own, so the books still balance.
  const heldOut = excluded.generatedNavigation
    + Object.values(excluded.byType).reduce((a, b) => a + b, 0)
    + excluded.outsideFolders;
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
    // Counted apart from `heldOut` because it is a different KIND of thing: a
    // failure, not a decision.
    unreadable: excluded.unreadable,
    vanishedDuringRun: excluded.vanishedDuringRun,
    fraction: eligiblePages > 0 ? comparedPages / eligiblePages : 0,
    // comparedPages + withoutVector + incompatibleVector + heldOut + unreadable
    //   + vanishedDuringRun === wikiPagesOnDisk.
    // Emitted so a reader can check the books rather than take them on trust.
    accountsFor: comparedPages + excluded.withoutVector + excluded.incompatibleVector
      + heldOut + excluded.unreadable + excluded.vanishedDuringRun,
    statement:
      `${comparedPages} of ${eligiblePages} eligible page(s) were compared`
      + (notComparedClauses.length ? `; ${notComparedClauses.join('; ')}` : '')
      + `. ${onDisk.length} markdown file(s) exist under ${WIKI_ROOT}/, of which ${heldOut} were held out `
      + '(generated navigation, exempt types, out of scope)'
      // AN UNREADABLE PAGE IS A FAILURE, NOT A DELIBERATE EXCLUSION, and it used
      // to be listed among them — so a run that lost pages read exactly like a
      // run that skipped them on purpose. Named separately, and only when it
      // actually happened (review, 2026-08-31).
      + (excluded.unreadable > 0
        ? `, and ${excluded.unreadable} could NOT BE READ — that is a failure, not an exclusion`
        : '')
      + (excluded.vanishedDuringRun > 0
        ? `, and ${excluded.vanishedDuringRun} were deleted between the walk and the read`
        : '')
      + '.',
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
