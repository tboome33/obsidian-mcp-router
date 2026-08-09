/**
 * build_search_index — build the vault's local deterministic BM25 index (C4+C5).
 *
 * Walks `wiki/` (user content — the same scope the knowledge graph indexes),
 * chunks every page with its C5 contextual header (title · description ·
 * section path), and writes the inverted index to `wiki-meta/search-index.json`
 * through the REST API — never the filesystem.
 *
 * IDEMPOTENT BY FINGERPRINT. The index carries a content hash of the corpus; an
 * unchanged vault rebuilds to the same fingerprint and the write is SKIPPED
 * (`upToDate: true`), so re-running costs nothing and never churns the file.
 *
 * FAIL CLOSED on read failures — the same rule as the OKF projections: an index
 * built from a partially-readable tree would silently omit pages, and a search
 * that quietly misses content is worse than a search that says it cannot run.
 * A transient REST failure must mean "no rebuild", never "wrong index".
 *
 * `check: true` reports what a build WOULD do (and whether the current index is
 * absent / stale / current) without writing.
 */

import * as defaultRestClient from '../rest-client.mjs';
import {
  buildSearchIndex,
  corpusFingerprint,
  isUsableIndex,
  indexProblem,
  automaticIndexAction,
  looksLikeSearchIndex,
  incompatibleIndexMessage,
  staleIndexMessage,
  emptyIndexMessage,
  unusableIndexMessage,
  SEARCH_INDEX_PATH,
  INDEX_VERSION,
} from '../helpers/bm25-index.mjs';
import { isProjectionPath } from '../helpers/okf-projections.mjs';
import { scaffoldCandidates } from '../helpers/wiki-meta-scaffolds.mjs';
import { withVaultLock } from '../helpers/vault-maintenance-lock.mjs';
import { applyReservedWrites, strictReservedCasEnabled } from '../helpers/reserved-path-write.mjs';
import { collectMarkdown, readAll } from './build-wiki-graph.mjs';

export const TOOL_NAME = 'build_search_index';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Build (or refresh) the vault\'s LOCAL BM25 search index — a deterministic, plugin-free search tier that works on every vault, including those without Smart Connections. Chunks every page under `wiki/` and prefixes each chunk with its context (page title, frontmatter description, heading path) so a hit can always say where it came from. Writes `wiki-meta/search-index.json` through the REST API. Idempotent: an unchanged vault is detected by content fingerprint and the write is skipped. Use `check: true` to report whether the index is absent, stale, or current WITHOUT writing. Once built, `search_smart` falls back to this index whenever the semantic tier is unavailable.',
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'Vault name (see list_vaults). Omit to use the default vault.',
      },
      check: {
        type: 'boolean',
        description: 'When true, report what a build would produce and whether the stored index is absent/stale/current — without writing. Default: false.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/** Coerce a getFileContent result (string | {content}) into a string. */
function asText(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res.content === 'string') return res.content;
  return '';
}

/**
 * Does `content` look like OUR OWN search index (so a reduced-mode overwrite
 * regenerates it WITHOUT a sidecar backup)?
 *
 * THE CATCH IS TIGHT ON PURPOSE. It swallows ONLY a JSON parse failure — content
 * that is not JSON is genuinely "not ours". Anything else re-throws: a broken
 * import (looksLikeSearchIndex was once used here UNIMPORTED → ReferenceError)
 * or any other programming defect must EXPLODE, not be silently read as
 * "foreign" and trigger a backup of our own index on every rebuild (the
 * unbounded-.bak-accumulation bug). A `catch { return false }` masked exactly
 * that through the whole test suite, because the helper tests inject a correct
 * `isOurs` and never exercised this wired closure.
 *
 * Exported and pure so the guard is unit-tested directly.
 */
export function indexContentIsOurs(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) return false; // not JSON → not ours
    throw err; // a real bug — never swallow it
  }
  return looksLikeSearchIndex(parsed);
}

/**
 * Read the stored index, or null when absent. A 404 is "not built yet" (a normal
 * state); anything else is about the VAULT and must surface, not be swallowed
 * into a silent rebuild.
 *
 * Returns the PARSED index, decorated with a non-enumerable `__raw` = the exact
 * bytes read, so the conditional-write path can compute a byte-exact precondition
 * hash of what was on disk at snapshot. (`{ __unparseable: true }` for a present
 * but non-JSON file.)
 */
async function readStoredIndex(getFileContent, vault) {
  let raw;
  try {
    raw = asText(await getFileContent(vault, SEARCH_INDEX_PATH));
  } catch (err) {
    if (err?.kind === 'not_found') return null;
    throw err;
  }
  const withRaw = (obj) => {
    // Non-enumerable so it never affects JSON.stringify / Object.keys / the
    // integrity recompute — it is only read by the conditional-write path.
    Object.defineProperty(obj, '__raw', { value: raw, enumerable: false, configurable: true });
    return obj;
  };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return withRaw({ __unparseable: true });
  }
  // A JSON primitive or array at the index path is not one of our indexes.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return withRaw({ __unparseable: true });
  }
  return withRaw(parsed);
}

/**
 * Core build over ONE resolved vault. Injected deps for tests.
 *
 * @param {object} vault resolved vault descriptor
 * @param {object} deps {listFilesIn, getFileContent, writeFile}
 * @param {object} [opts]
 * @param {boolean} [opts.check=false] Plan only, write nothing.
 * @param {boolean} [opts.automatic=false] This call is UNATTENDED (first-contact
 *   repair, post-write flush) rather than a user asking for it. It then refuses
 *   to touch a file that is not unambiguously ours — see `automaticIndexAction`
 *   for the two refusals and why an automatic version migration is a ping-pong.
 *   OFF for the MCP tool: calling `build_search_index` IS the consent.
 */
export async function buildIndexForVault(vault, deps, opts = {}) {
  const { check = false, automatic = false, requireScaffold = false, conditionalWrites = false } = opts;

  // IS THIS A ROUTER-MANAGED VAULT AT ALL? Same signal as the projections
  // refresh: the private `wiki-meta/` scaffold the provisioner writes. Without
  // it, an automatic build would CREATE `wiki-meta/` inside somebody's personal
  // Obsidian vault that merely happens to have a folder called `wiki` — a
  // directory appearing out of nowhere in a vault this router was never asked to
  // manage. The explicit tool leaves this off: calling it is the consent.
  if (requireScaffold) {
    let seen = false;
    for (const rel of scaffoldCandidates('catalog')) {
      try {
        await deps.getFileContent(vault, rel);
        seen = true;
        break;
      } catch (err) {
        // Only a true 404 means "not under this name"; an offline vault must not
        // be silently reclassified as "not ours".
        if (err?.kind !== 'not_found') throw err;
      }
    }
    if (!seen) return { vault: vault.name, skipped: 'no-wiki-meta-scaffold' };
  }

  const { paths, truncated, listFailures } = await collectMarkdown(deps.listFilesIn, vault, 'wiki');
  if (truncated) {
    // A truncated enumeration means an index built from a PARTIAL tree — every
    // search against it would silently miss pages. Refuse.
    return {
      vault: vault.name,
      skipped: 'enumeration-truncated',
      warnings: ['enumeration-truncated'],
    };
  }
  if (listFailures > 0) {
    // A subtree that failed to LIST is invisible, not empty. Building anyway
    // produced an index missing whole folders while reporting success (Codex).
    return {
      vault: vault.name,
      skipped: 'enumeration-failed',
      warnings: [
        `${listFailures} directory listing(s) failed — the vault tree could not be read in full, so the index would silently omit those folders. Fix vault access and re-run; a partial index is never written.`,
      ],
    };
  }
  // `wiki-meta/` (scaffolds, sessions) is deliberately out of scope: this index
  // answers questions about CONTENT, and the generated OKF projections inside
  // `wiki/` are excluded for the same reason (they are derived listings, not
  // knowledge — indexing them would rank a table of contents above the page it
  // points at). The predicate is IMPORTED, not re-guessed: only `wiki/log.md` at
  // the root is a projection, so a user's own `wiki/trading/log.md` stays
  // indexable (a hand-rolled regex silently swallowed it — Fable 5 review).
  const contentPaths = paths.filter((p) => !isProjectionPath(p));

  const { items, failures } = await readAll(deps.getFileContent, vault, contentPaths);
  if (failures > 0) {
    return {
      vault: vault.name,
      skipped: 'page-reads-failed',
      warnings: [`page-read-failures: ${failures}`],
    };
  }

  const pages = items.map(({ path, content }) => ({ path, content: asText(content) }));
  const fingerprint = corpusFingerprint(pages);

  const stored = await readStoredIndex(deps.getFileContent, vault);

  // THE AUTOMATIC PATH IS CONSERVATIVE, THE EXPLICIT ONE IS NOT.
  //
  // `automatic` is set by the unattended repair (first contact, post-write
  // flush), which has no consent to rewrite anything ambiguous. It refuses two
  // things the explicit tool still does:
  //
  //   - a file that is not ours (unparseable, or not claiming to be an index):
  //     somebody's data, reported as a conflict — the same rule the projection
  //     planner applies to an UNMARKED `index.md`;
  //   - an index from ANOTHER router generation: two versions rebuilding each
  //     other's file on every session is a ping-pong that never converges. See
  //     `automaticIndexAction` for the full argument.
  //
  // Calling `build_search_index` by hand IS the consent, and it is also how a
  // version migration is performed — so the tool keeps the blunt behaviour.
  if (automatic) {
    const { action, state } = automaticIndexAction(stored, fingerprint);
    if (action === 'foreign') {
      return {
        vault: vault.name,
        mode: check ? 'check' : 'apply',
        path: SEARCH_INDEX_PATH,
        indexState: state,
        upToDate: false,
        written: false,
        conflicts: [SEARCH_INDEX_PATH],
        warnings: [
          `${SEARCH_INDEX_PATH} in vault "${vault.name}" exists but is not one of our search indexes — ` +
            'left untouched, no index written. Move or delete it, then call `build_search_index`.',
        ],
      };
    }
    if (action === 'incompatible') {
      return {
        vault: vault.name,
        mode: check ? 'check' : 'apply',
        path: SEARCH_INDEX_PATH,
        indexState: state,
        upToDate: false,
        written: false,
        conflicts: [SEARCH_INDEX_PATH],
        warnings: [incompatibleIndexMessage(vault.name, stored)],
      };
    }
  }

  // Precise state: 'integrity-failed' (same version, corrupted — sync conflict,
  // truncated write, hand edit) is NOT 'foreign-version' (another router
  // generation). Conflating them pointed the operator at an upgrade that does
  // not exist (post-release Codex verification, v0.63.1).
  const problem = stored === null ? null : stored.__unparseable ? 'malformed' : indexProblem(stored);
  const storedState = stored === null
    ? 'absent'
    : stored.__unparseable
      ? 'unparseable'
      : problem !== null
        ? problem === 'malformed' ? 'unparseable' : problem
        : stored.fingerprint === fingerprint
          ? 'current'
          : 'stale';

  // Nothing to do — the stored index already describes this exact corpus.
  if (storedState === 'current') {
    return {
      vault: vault.name,
      mode: check ? 'check' : 'apply',
      path: SEARCH_INDEX_PATH,
      indexState: storedState,
      upToDate: true,
      written: false,
      fingerprint,
      stats: stored.stats ?? null,
      version: INDEX_VERSION,
      // An index that indexes nothing is a layout problem, not a build success —
      // say so even when the fingerprint says "current" (Fable 5 review).
      ...(stored.stats?.chunks === 0 ? { warnings: [emptyIndexMessage(vault.name)] } : {}),
    };
  }

  const index = buildSearchIndex({ pages, vaultName: vault.name });
  const warnings = [];
  if (index.stats.truncated) {
    warnings.push(`corpus truncated at ${index.stats.maxChunks} chunks — the index does NOT cover the whole vault`);
  }
  // 0 chunks means nothing indexable was found (no `wiki/`, or content lives
  // elsewhere). Building it "successfully" would leave every later search
  // answering an honest-looking empty list.
  if (index.stats.chunks === 0) warnings.push(emptyIndexMessage(vault.name));
  // The stale state is the one worth spelling out in `check` mode: the caller
  // asked whether the index still matches the vault, and it does not.
  if (storedState === 'stale') warnings.push(staleIndexMessage(vault.name));
  // Corruption gets its own diagnostic — the rebuild fixes it, but the operator
  // should know the stored file was inconsistent, not merely old.
  if (storedState === 'integrity-failed') {
    warnings.push(unusableIndexMessage(vault.name, stored, 'integrity-failed'));
  }

  const result = {
    vault: vault.name,
    mode: check ? 'check' : 'apply',
    path: SEARCH_INDEX_PATH,
    indexState: storedState,
    upToDate: false,
    written: false,
    fingerprint: index.fingerprint,
    stats: index.stats,
    version: INDEX_VERSION,
    ...(warnings.length ? { warnings } : {}),
  };

  if (check) return result;

  const serialized = JSON.stringify(index);

  if (!conditionalWrites) {
    // Legacy/explicit-consent path: a plain overwrite.
    await deps.writeFile(vault, SEARCH_INDEX_PATH, serialized);
    result.written = true;
    result.protectionMode = 'unconditional';
    return result;
  }

  // CONDITIONAL WRITE (F3-b, automatic path). Route the single index write
  // through the reserved-path writer. This REDUCES the clobber window, it does
  // not close it: foreign content DETECTED at the late read is copied to a
  // recoverable sidecar before we regenerate; a file landing in the residual
  // read→PUT sub-interval is still overwritten and, since the read could not
  // see it, is not backed up (the limit the sub-interval test proves).
  //   - absent at snapshot        → create-if-absent (409 if it appeared).
  //   - our own index (stale/bad) → overwrite iff still ours (else backup).
  const snapshotContent = stored === null ? undefined : (stored.__raw ?? null);
  const applied = await applyReservedWrites({
    deps: {
      writeFile: deps.writeFile,
      getFileContent: deps.getFileContent,
      attemptAtomicCas: deps.attemptAtomicCas,
    },
    vault,
    plannedWrites: [{
      path: SEARCH_INDEX_PATH,
      content: serialized,
      snapshotContent,
      // OUR index = valid shape at OUR version. A concurrent session's newer
      // valid index is still ours (regeneratable); a foreign JSON is not. The
      // catch inside is tight (parse errors only) — see indexContentIsOurs.
      isOurs: indexContentIsOurs,
    }],
    mode: strictReservedCasEnabled() ? 'strict' : 'reduced',
    nowMs: opts.nowMs,
  });
  result.written = applied.written.includes(SEARCH_INDEX_PATH);
  result.protectionMode = applied.protectionMode;
  if (applied.conflicts.length > 0) result.conflicts = applied.conflicts;
  if (applied.backups.length > 0) result.backups = applied.backups;
  if (applied.warnings.length > 0) {
    result.warnings = [...(result.warnings ?? []), ...applied.warnings];
  }
  return result;
}

/** MCP tool wrapper — registry resolution + response sanitization. */
export async function buildSearchIndexTool(registry, args = {}, _deps = {}) {
  const deps = {
    listFilesIn: _deps.listFilesIn || defaultRestClient.listFilesIn,
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    writeFile: _deps.writeFile || defaultRestClient.writeFile,
    attemptAtomicCas: _deps.attemptAtomicCas || defaultRestClient.attemptAtomicCas,
  };
  const vault = registry.resolveVault(args.vault);
  // Through THE lock, like every other rebuild path. `check: true` takes it too
  // and writes nothing: the point of a check is to describe a tree that is not
  // moving underneath it, and a check that ran mid-flush would report a state
  // that never existed.
  //
  // `conditionalWrites: true` even for the EXPLICIT rebuild (codex H4): a foreign
  // file that appeared on the index path is worth preserving whoever asked.
  const result = await withVaultLock(vault.name, () =>
    buildIndexForVault(vault, deps, { check: args.check === true, conditionalWrites: true }));
  return result; // normalized once at the wire boundary (wrapResult)
}
