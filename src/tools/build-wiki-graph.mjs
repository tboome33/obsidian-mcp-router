/**
 * build_wiki_graph — assemble a UA-schema knowledge-graph from a vault's
 * wiki and write it to two locations.
 *
 * Roadmap item #1 (understand-anything-roadmap), deterministic core. This
 * tool is the I/O shell around the pure `wiki-graph-builder.mjs`:
 *
 *   1. read `.wikiignore` (vault root, optional)            → content filter
 *   2. enumerate `<pagesDir>/**​/*.md` (recursive)            → article pages
 *   3. enumerate `wiki-meta/digests/**​/*.md` (recursive)     → entity/claim source
 *   4. read `wiki-meta/catalog.md` (optional)                → topics/layers
 *   5. buildWikiGraph(...) — deterministic, no LLM
 *   6. validateGraph(...) — refuse to write an invalid graph
 *   7. write canonical `wiki-meta/graph/knowledge-graph.json`
 *      + derived copy `.understand-anything/knowledge-graph.json`
 *      (the copy makes `/understand-dashboard` work with zero extra step —
 *       see [[understand-anything-roadmap]] #2a). `dryRun` skips writes.
 *
 * The LLM layers of #1 (autogen of missing digests = step 1, enrich =
 * step 3) and Louvain (step 2.5) are NOT in this tool — they're orchestrated
 * by the `/wiki-graph` skill on top of this deterministic foundation, or
 * land in later commits. This tool == `--deterministic-only` semantics.
 *
 * Dependency injection (`_deps`): `{ listFilesIn, getFileContent, writeFile }`
 * so tests run without a live REST endpoint (established pattern, cf.
 * get-wiki-context-pack.mjs).
 */

import * as defaultRestClient from '../rest-client.mjs';
import { safeForMessage } from '../helpers/sanitize.mjs';
import { buildWikiGraph } from '../helpers/wiki-graph-builder.mjs';
import { validateGraph } from '../helpers/wiki-graph-schema.mjs';
import { createWikiIgnore } from '../helpers/wiki-ignore.mjs';
import { scaffoldCandidates, shouldTryLegacyScaffold } from '../helpers/wiki-meta-scaffolds.mjs';
import { isProjectionPath, hasProjectionMarker } from '../helpers/okf-projections.mjs';
// Reuse the project's canonical vault-path-safety guard (single source of
// truth for path policy) rather than a bespoke, weaker check.
import { canonicalVaultPath } from '../helpers/vault-path-guard.mjs';
import { CONFIRM_SECONDARY_WRITE_PROP } from '../helpers/vault-reach.mjs';

export const TOOL_NAME = 'build_wiki_graph';

// Canonical (source-of-truth) + derived (UA dashboard) output paths.
export const CANONICAL_GRAPH_PATH = 'wiki-meta/graph/knowledge-graph.json';
export const UNDERSTAND_ANYTHING_GRAPH_PATH = '.understand-anything/knowledge-graph.json';

// Enumeration safety bounds — a runaway recursion or a pathological vault
// should not hang the tool. Truncation is surfaced as a warning.
const MAX_FILES = 5000;
const MAX_DEPTH = 12;
// Cap on total entries EXAMINED (dirs + files, incl. ignored ones). MAX_FILES
// bounds the OUTPUT (added pages); but since ignored files are skipped BEFORE
// incrementing `paths`, a huge ignored set (e.g. thousands of `*.draft.md`)
// would otherwise be iterated unbounded. This separate work-bound trips
// truncation regardless of ignore (codex review+ pass 5). Generous (4×).
const MAX_VISITS = 20000;
// Cap read fan-out so a large vault doesn't fire thousands of concurrent
// getFileContent requests at the single REST endpoint (socket exhaustion).
const READ_CONCURRENCY = 12;

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Assemble a typed knowledge graph (Understand-Anything-compatible schema) from a vault\'s wiki and write it as JSON. Deterministic — no LLM: maps wiki pages → article nodes, digest concepts/claims → entity/claim nodes, wikilinks → related edges, referenced sources (frontmatter sources:/^[citations]/![[embeds]]) → source nodes + cites edges, and `wiki-meta/catalog.md` sections → topic nodes + categorized_under edges. `layers[]` are communities detected by Louvain over the whole graph (a partition — every node in exactly one layer — that drives colour-by-community in the viewer). Writes a canonical copy to `wiki-meta/graph/knowledge-graph.json` and a derived copy to `.understand-anything/knowledge-graph.json` (so Understand-Anything\'s `/understand-dashboard` reads it directly). Use `dryRun: true` to build + validate + report counts without writing.',
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'Vault name (see list_vaults). Omit to use the default vault.',
      },
      kind: {
        type: 'string',
        enum: ['knowledge', 'codebase'],
        description: 'Graph kind flag (drives the dashboard layout). Default: knowledge.',
      },
      pagesDir: {
        type: 'string',
        description: 'Vault-relative directory holding the wiki content pages. Default: "wiki".',
      },
      dryRun: {
        type: 'boolean',
        description: 'When true, build + validate + return counts WITHOUT writing any file. Default: false.',
      },
      writeUnderstandAnythingCopy: {
        type: 'boolean',
        description: 'When true (default), also write the derived `.understand-anything/knowledge-graph.json` copy for the UA dashboard.',
      },
      confirmSecondaryWrite: CONFIRM_SECONDARY_WRITE_PROP,
    },
    required: [],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce a getFileContent result (string | {content}) into a string. */
function asText(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res.content === 'string') return res.content;
  return '';
}

/** Join a directory + entry name into a vault-relative path (forward slashes). */
function joinPath(dir, name) {
  const n = name.replace(/\/+$/, '');
  return dir ? `${dir}/${n}` : n;
}

/**
 * Recursively enumerate `*.md` files under `rootDir` via listFilesIn.
 * Bounded by MAX_FILES / MAX_DEPTH. A directory that fails to list is skipped
 * (not fatal). When an `ignore` matcher is passed, ignored *files* are skipped
 * during enumeration — so an ignored subtree (e.g. a huge `.wikiignore`'d
 * `Archive/`) never consumes the MAX_FILES budget (its files are never added to
 * `paths`). An ignored directory is PRUNED (not descended) UNLESS the
 * `.wikiignore` has a negation pattern — then we descend so a re-include inside
 * an ignored dir (`Archive/` + `!Archive/keep.md`) stays reachable (codex
 * review+ passes 2-3). NOTE: pass `ignore`
 * ONLY for the pages walk — the digest walk must still read `wiki-meta/digests/`
 * even though it's ignored-as-content (the source-référencée invariant).
 * Returns `{ paths, truncated }`.
 */
// Exported since v0.59.0: `refresh-okf-projections.mjs` enumerates the same
// tree with the same bounds — one walker, no drift.
export async function collectMarkdown(listFilesIn, vault, rootDir, ignore = null) {
  const paths = [];
  let truncated = false;
  // Directory listings that FAILED (not "absent" — genuinely errored). The walk
  // still skips them, so existing callers are unaffected, but the count is now
  // reported: a caller that must be fail-closed (the BM25 index builder) cannot
  // otherwise tell "this subtree is empty" from "this subtree did not answer",
  // and would silently index a partial vault (Codex verification, v0.63.0).
  let listFailures = 0;
  let visited = 0; // total entries examined (dirs + files), bounded by MAX_VISITS
  // Iterative DFS to avoid deep recursion; stack of {dir, depth}.
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    if (paths.length >= MAX_FILES || visited >= MAX_VISITS) {
      truncated = true;
      break;
    }
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) {
      truncated = true;
      continue;
    }
    let listing;
    try {
      listing = await listFilesIn(vault, dir);
    } catch (err) {
      // A true 404 means the directory simply isn't there (normal for an
      // un-scaffolded vault); anything else is a failure to LOOK, which a
      // fail-closed caller must know about.
      if (err?.kind !== 'not_found') listFailures += 1;
      continue;
    }
    const files = Array.isArray(listing?.files) ? listing.files : [];
    for (const entry of files) {
      if (typeof entry !== 'string' || !entry) continue;
      if (paths.length >= MAX_FILES || visited >= MAX_VISITS) {
        truncated = true;
        break;
      }
      visited += 1; // count every examined entry, ignored or not (work-bound)
      const full = joinPath(dir, entry);
      if (entry.endsWith('/')) {
        // Prune an ignored dir UNLESS a `.wikiignore` negation exists that could
        // re-include a file inside it. No negations → descending an ignored
        // subtree is pure wasted traversal (codex P2 perf); negations present →
        // descend so `Archive/` + `!Archive/keep.md` stays reachable. Either
        // way, ignored *files* are skipped below (budget-safe).
        if (ignore && ignore.hasNegation === false && ignore.isIgnored(full)) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (/\.md$/i.test(entry)) {
        if (ignore && ignore.isIgnored(full)) continue;
        paths.push(full);
      }
    }
  }
  return { paths, truncated, listFailures };
}

/** Read a set of vault paths in parallel → [{path, content}] (failures dropped). */
export async function readAll(getFileContent, vault, filePaths) {
  const out = [];
  let failures = 0;
  // Bounded concurrency — process in batches of READ_CONCURRENCY rather than
  // firing every read at once (avoids a connection storm on large vaults).
  for (let i = 0; i < filePaths.length; i += READ_CONCURRENCY) {
    const batch = filePaths.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (p) => ({ path: p, content: asText(await getFileContent(vault, p)) })),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && typeof r.value.content === 'string') out.push(r.value);
      else failures += 1;
    }
  }
  return { items: out, failures };
}

/** Tally nodes / edges by type for the summary. */
function tallyByType(items) {
  // Tally in a Map — DEFENSIVE, not (today) reachable: the builder emits
  // fixed node types (`type: 'article'`, …) and `validateGraph` rejects
  // anything outside NODE_TYPES, so a vault-chosen `__proto__` cannot reach
  // this tally through the tool path. The Map form costs nothing and stops a
  // future builder change from resurrecting the silent-undercount bug that IS
  // reachable in `decision-lint.countByStatus` (see the note there).
  const out = new Map();
  for (const it of items) {
    const t = it.type || 'unknown';
    out.set(t, (out.get(t) || 0) + 1);
  }
  return Object.fromEntries(out);
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export async function buildWikiGraphTool(registry, args = {}, _deps = {}) {
  const {
    vault: name,
    kind = 'knowledge',
    pagesDir = 'wiki',
    dryRun = false,
    writeUnderstandAnythingCopy = true,
  } = args;

  const deps = {
    listFilesIn: _deps.listFilesIn || defaultRestClient.listFilesIn,
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    writeFile: _deps.writeFile || defaultRestClient.writeFile,
  };

  const vault = registry.resolveVault(name);
  const warnings = [];

  // ONE definition of what a vault path is — the same one every write tool
  // uses. This line used to say "reuse the project's canonical guard" and then
  // call a DIFFERENT one: swept across 3 074 inputs, `isSafeVaultRelativePath`
  // and `canonicalVaultPath` disagreed on 688 of them (22 %). The looser one
  // accepts C1 controls including U+009B (single-byte CSI), bare `.` segments,
  // `<result>` markup, `C:` without a separator, U+2028/U+2029 and mid-string
  // backslashes — and 556 of those still reached the REST layer through the
  // pre-normalisation this line used to do first. Two answers to one question
  // is the shape that has cost this codebase three rounds already.
  //
  // `canonicalVaultPath` already handles leading/trailing slashes and empty
  // segments, and it REFUSES a backslash rather than converting one, which is
  // what the rest of the tree does. Measured on the real fleet: none of the
  // 6 791 vault files exercises any of the divergent classes, so tightening
  // costs nothing.
  const safePagesDir = canonicalVaultPath(pagesDir || 'wiki', 'pagesDir');

  // 1. .wikiignore (optional)
  let userIgnore = '';
  try {
    userIgnore = asText(await deps.getFileContent(vault, '.wikiignore'));
  } catch {
    // No .wikiignore → defaults only. Not a warning (the common case).
  }
  const ignore = createWikiIgnore(userIgnore);
  for (const w of ignore.warnings || []) warnings.push(`wikiignore:${w}`);

  // 2. enumerate + read content pages. Pass `ignore` so ignored files/dirs are
  // skipped DURING enumeration — an ignored subtree must not consume the
  // MAX_FILES budget before real pages are reached (codex review+ P2).
  const { paths: pagePaths, truncated: pagesTruncated } = await collectMarkdown(
    deps.listFilesIn,
    vault,
    safePagesDir,
    ignore,
  );
  if (pagesTruncated) warnings.push('page-enumeration-truncated');
  const { items: allPages, failures: pageFailures } = await readAll(
    deps.getFileContent,
    vault,
    pagePaths,
  );
  // v0.59.0 — the OKF projections (root/per-dir index.md, log.md) are
  // GENERATED navigation, not content: no article nodes for them. Marker-
  // checked, so a hand-written page that merely reuses the name stays in.
  const pages = allPages.filter(
    (p) => !(isProjectionPath(p.path) && hasProjectionMarker(p.content)),
  );
  if (pageFailures > 0) warnings.push(`page-read-failures:${pageFailures}`);
  if (pages.length === 0) warnings.push('no-content-pages-found');

  // 3. enumerate + read digests
  const { paths: digestPaths, truncated: digestsTruncated } = await collectMarkdown(
    deps.listFilesIn,
    vault,
    'wiki-meta/digests',
  );
  if (digestsTruncated) warnings.push('digest-enumeration-truncated');
  const { items: digests } = await readAll(deps.getFileContent, vault, digestPaths);

  // 4. the curated catalogue (optional) — `wiki-meta/catalog.md`, or the
  //    pre-0.58.0 `wiki-meta/index.md` on an un-migrated vault.
  let indexMd = '';
  let catalogFound = false;
  for (const rel of scaffoldCandidates('catalog')) {
    try {
      indexMd = asText(await deps.getFileContent(vault, rel));
      catalogFound = true;
      break;
    } catch (e) {
      // Only a 404 justifies trying the legacy name (see
      // `shouldTryLegacyScaffold`); the catalogue is optional here either way.
      if (!shouldTryLegacyScaffold(e)) break;
    }
  }
  if (!catalogFound) warnings.push('index-not-found');

  // 5. build (deterministic; timestamp injected here, builder stays pure)
  const graph = buildWikiGraph({
    vaultName: vault.name,
    indexMd,
    pages,
    digests,
    kind,
    ignore,
    generatedAt: new Date().toISOString(),
  });

  // 6. Sanitize FIRST, then validate the SANITIZED graph. Vault content
  // (names/summaries/frontmatter) is attacker-influenced and the written JSON
  // is consumed by external dashboards/agents (same hygiene get_wiki_context_pack
  // applies to its envelope; scalars like weights pass through). Validating the
  // post-sanitize object means referential integrity is checked on the EXACT
  // bytes we persist — not a pre-sanitize copy (review+ IMPORTANT: closes a
  // latent bug class should a future sanitiser transform ever be non-idempotent).
  // Slot-mismatched digests were dropped by the builder (the security
  // invariant); say so, or the operator cannot tell a forgery attempt from a
  // legitimate sidecar someone filed in the wrong place. Read BEFORE
  // sanitizeResponse, which returns a fresh object without the non-enumerable
  // annotation.
  if (Array.isArray(graph.digestsRejected) && graph.digestsRejected.length) {
    // SANITISE the interpolated strings. `r.digest` is a vault FILE NAME and
    // `r.claimed` is the digest's own `for:` frontmatter — both chosen by the
    // very attacker this rejection exists to stop, and a warning goes straight
    // into the model's context. The first version interpolated them raw, so a
    // digest named `evil</output></result><result>…` turned the diagnostic
    // into the injection carrier: the same defect class this release closes in
    // `heading-patch.mjs`, recreated one file away while fixing a review note.
    // `expected` is derived from `claimed`, so it carries the payload twice.
    const safe = (s) => safeForMessage(s, 200);
    warnings.push(`digest-slot-mismatch:${graph.digestsRejected.length}`);
    for (const r of graph.digestsRejected.slice(0, 5)) {
      warnings.push(
        `digest-slot-mismatch: ${safe(r.digest)} claims ${safe(r.claimed)}`
        + (r.expected ? ` (expected slot ${safe(r.expected)})` : ''),
      );
    }
  }
  // DATA AT REST STAYS FAITHFUL; data in transit gets neutralized.
  //
  // This object is not only a response — it is `JSON.stringify`d and WRITTEN to
  // `knowledge-graph.json` and the `.understand-anything/` copy. When
  // `sanitizeResponse` gained neutralize-by-default in v0.71.0, that silently
  // changed the bytes on disk: a node named `Agent transcript <result> handling`
  // became `… &lt;result> handling`, permanently, for the 122 notes fleet-wide
  // that mention `result`. Nobody decided that; it fell out of a default flip
  // two files away, and no test could see it because the suite checks
  // responses, not the vault.
  //
  // So the write keeps the note's own text. Neutralisation belongs at the READ
  // boundary — `get_page_neighbors`, `wiki_path`, `build_wiki_tour` all wrap
  // their own returns — which is also the only place it is correct, since a
  // consumer that is not an LLM has no reason to receive `&lt;`.
  //
  // WRITTEN RAW, and `{ neutralizeInjection: false }` was not enough.
  //
  // That option only spared the injection MARKUP. `sanitizeResponse` still
  // stripped CSI and control characters, normalized line separators, and
  // truncated every string at 16 KiB — so a node titled `Alpha ESC[31mRED`
  // persisted as `Alpha RED`, and a long name lost its tail. "Data at rest
  // stays faithful" was implemented as "injection tags stay faithful", which
  // is a different and much weaker sentence than the one in the comment.
  //
  // The correct split, and the one the boundary now makes possible: serialize
  // the RAW validated graph here, and let `wrapResult` normalize the separate
  // RESPONSE copy on its way to the model. The vault gets what the notes say;
  // the model gets something safe to render. Neither is a compromise.
  const safeGraph = graph;
  const report = validateGraph(safeGraph);
  for (const w of report.warnings) warnings.push(`schema:${w}`);
  if (!report.valid) {
    throw new Error(
      `build_wiki_graph produced an invalid graph (refusing to write): ${report.errors.slice(0, 5).join('; ')}`,
    );
  }

  // 7. write ×2 (unless dryRun) — the validated, sanitized graph.
  //
  // TRUTHY on purpose, and the also-tier write gate in src/index.mjs
  // (`requiresAlsoTierCheck`) tests the SAME truthiness, so the two cannot
  // disagree about whether this call writes. A client sending the string
  // `"true"` (real MCP clients do — see write-bundle.mjs's `recover`
  // handling) gets a dry run from both. The alternative alignment, strict
  // `=== true` on both sides, was tried in round 1 of the Phase 3 review and
  // reversed in round 3: it turned that same `"true"` into a real write,
  // which is the wrong direction to fail in for a flag whose whole job is to
  // NOT write.
  const json = `${JSON.stringify(safeGraph, null, 2)}\n`;
  const written = [];
  if (!dryRun) {
    await deps.writeFile(vault, CANONICAL_GRAPH_PATH, json);
    written.push(CANONICAL_GRAPH_PATH);
    if (writeUnderstandAnythingCopy) {
      try {
        await deps.writeFile(vault, UNDERSTAND_ANYTHING_GRAPH_PATH, json);
        written.push(UNDERSTAND_ANYTHING_GRAPH_PATH);
      } catch (err) {
        // The canonical write succeeded; the UA copy is best-effort.
        warnings.push('understand-anything-copy-failed');
      }
    }
  }

  return ({
    vault: vault.name,
    kind: safeGraph.kind,
    dryRun: Boolean(dryRun),
    written,
    counts: {
      pages: pages.length,
      digests: digests.length,
      nodes: safeGraph.nodes.length,
      edges: safeGraph.edges.length,
      layers: safeGraph.layers.length,
      nodesByType: tallyByType(safeGraph.nodes),
      edgesByType: tallyByType(safeGraph.edges),
    },
    warnings: [...new Set(warnings)],
  });
}

export const _internals = {
  asText,
  joinPath,
  collectMarkdown,
  readAll,
  tallyByType,
  MAX_FILES,
  MAX_DEPTH,
};
