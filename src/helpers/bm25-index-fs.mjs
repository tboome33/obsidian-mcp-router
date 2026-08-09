/**
 * Disk-side BM25 search index — the same construction as the
 * `build_search_index` tool, but over the FILESYSTEM instead of REST.
 *
 * WHY A DISK PATH EXISTS AT ALL. `build_search_index` talks to a vault through
 * its Local REST API, which needs Obsidian running on that vault. At the moment
 * a vault is PROVISIONED, Obsidian has never opened it — so the tool cannot be
 * the thing that gives a newborn vault its index. This module is the same
 * relationship to `bm25-index.mjs` that `okf-projections-fs.mjs` has to
 * `okf-projections.mjs`: an I/O shell around an already-pure core.
 *
 * NOTHING IS RE-IMPLEMENTED HERE. The chunker, the scorer, the fingerprint and
 * the shape checks are IMPORTED from `bm25-index.mjs`. A second BM25 in this
 * repo would be a second thing to keep in sync, and the two would answer
 * different rankings for the same vault the first time one of them was fixed.
 * What this file owns is exactly: walking a directory, reading files, deciding
 * whether to write, and writing.
 *
 * IDEMPOTENT BY FINGERPRINT, like the tool: an unchanged corpus rebuilds to the
 * same content hash and the write is SKIPPED (`upToDate: true`). Re-running the
 * scaffolder therefore costs one read pass and touches nothing.
 *
 * SQUATTERS ARE NEVER OVERWRITTEN (`preserveForeignIndexFile`, on by default
 * here). A file sitting at `wiki-meta/search-index.json` that does not even
 * CLAIM to be one of our indexes is somebody's data — reported as a conflict,
 * left byte-intact. The explicit tool keeps the older, blunter behaviour on
 * purpose: calling a tool named `build_search_index` IS the consent this
 * automatic path does not have.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  buildSearchIndex,
  corpusFingerprint,
  automaticIndexAction,
  indexProblem,
  SEARCH_INDEX_PATH,
  INDEX_VERSION,
} from './bm25-index.mjs';
import { isProjectionPath } from './okf-projections.mjs';
import { writeFileAtomicSync } from './write-file-atomic.mjs';

/**
 * Walk `<vault>/wiki` for .md files (vault-relative posix paths).
 *
 * Deliberately the same walker shape as `okf-projections-fs.mjs`: dot-entries
 * and `node_modules` skipped, depth-first, `.md` only.
 */
function walkWiki(vaultAbs) {
  const out = [];
  const wikiAbs = path.join(vaultAbs, 'wiki');
  if (!fs.existsSync(wikiAbs)) return out;
  const rec = (rel) => {
    const abs = path.join(wikiAbs, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (/^(\.|node_modules$)/.test(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(childRel);
      else if (/\.md$/i.test(e.name)) out.push(`wiki/${childRel}`);
    }
  };
  rec('');
  return out;
}

/**
 * Read the stored index from disk. Returns
 *   - `{ present: false }`                    — no file
 *   - `{ present: true, parsed: null }`        — file exists, not JSON
 *   - `{ present: true, parsed: <object> }`
 */
function readStoredIndex(vaultPath) {
  const abs = path.join(vaultPath, ...SEARCH_INDEX_PATH.split('/'));
  if (!fs.existsSync(abs)) return { present: false, abs };
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    // Unreadable is not absent: refusing to guess is the same fail-closed rule
    // the REST builder applies to a read failure.
    return { present: true, parsed: null, unreadable: true, abs };
  }
  try {
    return { present: true, parsed: JSON.parse(raw), abs };
  } catch {
    return { present: true, parsed: null, abs };
  }
}

/**
 * The pre-`automaticIndexAction` classification, kept for the ONE caller that
 * opts out of the conservative policy (`preserveForeignIndexFile: false`, i.e.
 * "this is an explicit rebuild, overwrite whatever is there").
 */
function legacyIndexState(stored, fingerprint) {
  if (!stored.present) return 'absent';
  if (stored.parsed === null) return 'unparseable';
  const problem = indexProblem(stored.parsed);
  if (problem !== null) return problem === 'malformed' ? 'unparseable' : problem;
  return stored.parsed.fingerprint === fingerprint ? 'current' : 'stale';
}

/**
 * Build (or refresh) the local BM25 index of ONE vault, on disk.
 *
 * @param {string} vaultPath Absolute vault root
 * @param {object} [opts]
 * @param {boolean} [opts.apply=false] Write; false = plan only.
 * @param {string}  [opts.vaultName] Recorded in the index (defaults to basename).
 * @param {boolean} [opts.preserveForeignIndexFile=true] Never overwrite a file
 *   at the index path that does not claim to be one of our indexes.
 * @returns {{
 *   path: string, applied: boolean, written: boolean, upToDate: boolean,
 *   indexState: 'absent'|'current'|'stale'|'unparseable'|'foreign-file'|'integrity-failed'|'foreign-version',
 *   fingerprint: string|null, stats: object|null, conflicts: string[],
 *   pagesScanned: number, skipped?: string, warnings?: string[]
 * }}
 */
export function generateSearchIndexOnDisk(vaultPath, opts = {}) {
  const apply = opts.apply === true;
  const preserveForeign = opts.preserveForeignIndexFile !== false;
  const vaultName = opts.vaultName || path.basename(vaultPath);

  if (!fs.existsSync(path.join(vaultPath, 'wiki'))) {
    // Not a wiki vault. Silence, not an error — the same posture the projections
    // CLI takes, and the same one the bridge's open-time check takes.
    return {
      path: SEARCH_INDEX_PATH,
      applied: apply,
      written: false,
      upToDate: true,
      indexState: 'absent',
      fingerprint: null,
      stats: null,
      conflicts: [],
      pagesScanned: 0,
      skipped: 'no-wiki',
    };
  }

  // Generated projections are excluded from the corpus for the same reason the
  // REST builder excludes them: they are derived listings, and indexing a table
  // of contents ranks it above the pages it points at. The predicate is
  // IMPORTED, so `wiki/trading/log.md` (a user page) stays indexable.
  const pages = [];
  for (const rel of walkWiki(vaultPath)) {
    if (isProjectionPath(rel)) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(vaultPath, ...rel.split('/')), 'utf8');
    } catch (err) {
      // FAIL CLOSED. An index built from a partially-readable tree silently
      // omits pages, and a search that quietly misses content is worse than one
      // that says it could not run.
      return {
        path: SEARCH_INDEX_PATH,
        applied: apply,
        written: false,
        upToDate: false,
        indexState: 'absent',
        fingerprint: null,
        stats: null,
        conflicts: [],
        pagesScanned: 0,
        skipped: 'page-reads-failed',
        warnings: [`could not read ${rel}: ${err?.message ?? err}`],
      };
    }
    pages.push({ path: rel, content });
  }

  const fingerprint = corpusFingerprint(pages);
  const stored = readStoredIndex(vaultPath);

  // THE SAME DECISION AS THE REST PATH, from the same pure helper. Provisioning
  // is an automatic context too — nobody asked for the file at that path to be
  // replaced — so `automaticIndexAction` decides, and it refuses both a
  // stranger's file and another router generation's index. See its header for
  // why an automatic version migration is a ping-pong that never converges.
  const storedForDecision = !stored.present
    ? null
    : stored.parsed === null ? { __unparseable: true } : stored.parsed;
  const decision = preserveForeign
    ? automaticIndexAction(storedForDecision, fingerprint)
    : null;

  if (decision && (decision.action === 'foreign' || decision.action === 'incompatible')) {
    return {
      path: SEARCH_INDEX_PATH,
      applied: apply,
      written: false,
      upToDate: false,
      indexState: decision.state,
      fingerprint,
      stats: null,
      conflicts: [SEARCH_INDEX_PATH],
      pagesScanned: pages.length,
      warnings: [
        decision.action === 'incompatible'
          ? `${SEARCH_INDEX_PATH} is version ${storedForDecision?.version} and this router speaks ` +
            `${INDEX_VERSION} — left untouched so two router generations do not rewrite each other's ` +
            'index on every run. Migrate deliberately with `build_search_index`.'
          : `${SEARCH_INDEX_PATH} exists but is not one of our search indexes — left untouched. ` +
            'Move or delete it, then rebuild.',
      ],
    };
  }

  const indexState = decision
    ? (decision.action === 'build' ? 'absent' : decision.state)
    : legacyIndexState(stored, fingerprint);

  if (indexState === 'current') {
    return {
      path: SEARCH_INDEX_PATH,
      applied: apply,
      written: false,
      upToDate: true,
      indexState,
      fingerprint,
      stats: stored.parsed.stats ?? null,
      conflicts: [],
      pagesScanned: pages.length,
    };
  }

  const index = buildSearchIndex({ pages, vaultName });
  const warnings = [];
  if (index.stats.truncated) {
    warnings.push(`corpus truncated at ${index.stats.maxChunks} chunks — the index does NOT cover the whole vault`);
  }

  const result = {
    path: SEARCH_INDEX_PATH,
    applied: apply,
    written: false,
    upToDate: false,
    indexState,
    fingerprint: index.fingerprint,
    stats: index.stats,
    conflicts: [],
    pagesScanned: pages.length,
    version: INDEX_VERSION,
    ...(warnings.length ? { warnings } : {}),
  };

  if (!apply) return result;

  const abs = path.join(vaultPath, ...SEARCH_INDEX_PATH.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Atomic: a half-written index would not parse, and the automatic path
  // PRESERVES an unparseable file — so an interrupted plain write would leave a
  // corruption that nothing is ever allowed to repair. See write-file-atomic.
  writeFileAtomicSync(abs, JSON.stringify(index));
  result.written = true;
  return result;
}
