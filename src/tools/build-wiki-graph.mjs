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
 *   4. read `wiki-meta/index.md` (optional)                  → topics/layers
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
import { sanitizeResponse } from '../helpers/sanitize.mjs';
import { buildWikiGraph } from '../helpers/wiki-graph-builder.mjs';
import { validateGraph } from '../helpers/wiki-graph-schema.mjs';
import { createWikiIgnore } from '../helpers/wiki-ignore.mjs';
// Reuse the project's canonical vault-path-safety guard (single source of
// truth for path policy) rather than a bespoke, weaker check.
import { isSafeVaultRelativePath } from './get-wiki-context-pack.mjs';

export const TOOL_NAME = 'build_wiki_graph';

// Canonical (source-of-truth) + derived (UA dashboard) output paths.
export const CANONICAL_GRAPH_PATH = 'wiki-meta/graph/knowledge-graph.json';
export const UNDERSTAND_ANYTHING_GRAPH_PATH = '.understand-anything/knowledge-graph.json';

// Enumeration safety bounds — a runaway recursion or a pathological vault
// should not hang the tool. Truncation is surfaced as a warning.
const MAX_FILES = 5000;
const MAX_DEPTH = 12;
// Cap read fan-out so a large vault doesn't fire thousands of concurrent
// getFileContent requests at the single REST endpoint (socket exhaustion).
const READ_CONCURRENCY = 12;

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Assemble a typed knowledge graph (Understand-Anything-compatible schema) from a vault\'s wiki and write it as JSON. Deterministic — no LLM: maps wiki pages → article nodes, digest concepts/claims → entity/claim nodes, wikilinks → related edges, referenced sources (frontmatter sources:/^[citations]/![[embeds]]) → source nodes + cites edges, and index.md sections → topic nodes + layers. Writes a canonical copy to `wiki-meta/graph/knowledge-graph.json` and a derived copy to `.understand-anything/knowledge-graph.json` (so Understand-Anything\'s `/understand-dashboard` reads it directly). Use `dryRun: true` to build + validate + report counts without writing.',
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
 * Bounded by MAX_FILES / MAX_DEPTH. A directory that fails to list is
 * skipped (not fatal). Returns `{ paths, truncated }`.
 */
async function collectMarkdown(listFilesIn, vault, rootDir) {
  const paths = [];
  let truncated = false;
  // Iterative DFS to avoid deep recursion; stack of {dir, depth}.
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    if (paths.length >= MAX_FILES) {
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
    } catch {
      continue; // missing/inaccessible directory → skip
    }
    const files = Array.isArray(listing?.files) ? listing.files : [];
    for (const entry of files) {
      if (typeof entry !== 'string' || !entry) continue;
      if (paths.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      if (entry.endsWith('/')) {
        stack.push({ dir: joinPath(dir, entry), depth: depth + 1 });
      } else if (/\.md$/i.test(entry)) {
        paths.push(joinPath(dir, entry));
      }
    }
  }
  return { paths, truncated };
}

/** Read a set of vault paths in parallel → [{path, content}] (failures dropped). */
async function readAll(getFileContent, vault, filePaths) {
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
  const out = {};
  for (const it of items) {
    const t = it.type || 'unknown';
    out[t] = (out[t] || 0) + 1;
  }
  return out;
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

  // Defensive: a caller-supplied pagesDir must stay vault-relative. Reuse the
  // project's canonical guard (rejects leading `/`, drive letters, UNC, `..`
  // segments, control chars, URL-like). We DON'T strip a leading slash before
  // the check — doing so would let `/etc` slip through as `etc`.
  const safePagesDir = String(pagesDir || 'wiki').replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!safePagesDir || !isSafeVaultRelativePath(safePagesDir)) {
    throw new Error(`Invalid pagesDir: ${pagesDir}`);
  }

  // 1. .wikiignore (optional)
  let userIgnore = '';
  try {
    userIgnore = asText(await deps.getFileContent(vault, '.wikiignore'));
  } catch {
    // No .wikiignore → defaults only. Not a warning (the common case).
  }
  const ignore = createWikiIgnore(userIgnore);
  for (const w of ignore.warnings || []) warnings.push(`wikiignore:${w}`);

  // 2. enumerate + read content pages (ignore-filtered)
  const { paths: allPagePaths, truncated: pagesTruncated } = await collectMarkdown(
    deps.listFilesIn,
    vault,
    safePagesDir,
  );
  if (pagesTruncated) warnings.push('page-enumeration-truncated');
  const pagePaths = allPagePaths.filter((p) => !ignore.isIgnored(p));
  const { items: pages, failures: pageFailures } = await readAll(
    deps.getFileContent,
    vault,
    pagePaths,
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

  // 4. index.md (optional)
  let indexMd = '';
  try {
    indexMd = asText(await deps.getFileContent(vault, 'wiki-meta/index.md'));
  } catch {
    warnings.push('index-not-found');
  }

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

  // 6. validate — refuse to write an invalid graph (signals a builder bug)
  const report = validateGraph(graph);
  for (const w of report.warnings) warnings.push(`schema:${w}`);
  if (!report.valid) {
    throw new Error(
      `build_wiki_graph produced an invalid graph (refusing to write): ${report.errors.slice(0, 5).join('; ')}`,
    );
  }

  // 7. write ×2 (unless dryRun). Sanitize the graph's string fields first —
  // vault content (names/summaries/frontmatter) is attacker-influenced and the
  // written JSON is consumed by external dashboards/agents (same hygiene
  // get_wiki_context_pack applies to its envelope). Scalars (weights) pass
  // through untouched; JSON validity is preserved.
  const json = `${JSON.stringify(sanitizeResponse(graph), null, 2)}\n`;
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

  return sanitizeResponse({
    vault: vault.name,
    kind: graph.kind,
    dryRun: Boolean(dryRun),
    written,
    counts: {
      pages: pages.length,
      digests: digests.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      layers: graph.layers.length,
      nodesByType: tallyByType(graph.nodes),
      edgesByType: tallyByType(graph.edges),
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
