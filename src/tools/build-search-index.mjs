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
import { sanitizeResponse } from '../helpers/sanitize.mjs';
import {
  buildSearchIndex,
  corpusFingerprint,
  isUsableIndex,
  staleIndexMessage,
  emptyIndexMessage,
  SEARCH_INDEX_PATH,
  INDEX_VERSION,
} from '../helpers/bm25-index.mjs';
import { isProjectionPath } from '../helpers/okf-projections.mjs';
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
 * Read the stored index, or null when absent. A 404 is "not built yet" (a normal
 * state); anything else is about the VAULT and must surface, not be swallowed
 * into a silent rebuild.
 */
async function readStoredIndex(getFileContent, vault) {
  let raw;
  try {
    raw = asText(await getFileContent(vault, SEARCH_INDEX_PATH));
  } catch (err) {
    if (err?.kind === 'not_found') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparseable: true };
  }
}

/**
 * Core build over ONE resolved vault. Injected deps for tests.
 *
 * @param {object} vault resolved vault descriptor
 * @param {object} deps {listFilesIn, getFileContent, writeFile}
 * @param {object} [opts] {check}
 */
export async function buildIndexForVault(vault, deps, opts = {}) {
  const { check = false } = opts;

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
  const storedUsable = isUsableIndex(stored);
  const storedState = stored === null
    ? 'absent'
    : stored.__unparseable
      ? 'unparseable'
      : !storedUsable
        ? 'foreign-version'
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

  await deps.writeFile(vault, SEARCH_INDEX_PATH, JSON.stringify(index));
  result.written = true;
  return result;
}

/** MCP tool wrapper — registry resolution + response sanitization. */
export async function buildSearchIndexTool(registry, args = {}, _deps = {}) {
  const deps = {
    listFilesIn: _deps.listFilesIn || defaultRestClient.listFilesIn,
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    writeFile: _deps.writeFile || defaultRestClient.writeFile,
  };
  const vault = registry.resolveVault(args.vault);
  const result = await buildIndexForVault(vault, deps, { check: args.check === true });
  return sanitizeResponse(result);
}
