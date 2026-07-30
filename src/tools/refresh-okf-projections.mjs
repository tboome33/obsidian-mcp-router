/**
 * refresh_okf_projections — (re)generate the OKF at-rest navigation façade
 * over `wiki/`: root `index.md` (frontmatter `okf_version` only, §11), one
 * `index.md` per content directory (§6), newest-first `log.md` (§7).
 *
 * Volet ② of the 2026-07-30 catalog/journal decision. The files are pure
 * projections of the tree's frontmatter — see `helpers/okf-projections.mjs`
 * for the grammar (shared with the export bundle) and the marker contract.
 *
 * Three call sites, one core:
 *   - the MCP tool (explicit refresh / `check: true` drift report for
 *     wiki-lint);
 *   - the server's post-write middleware (debounced, `requireInitialized` so
 *     a vault that never opted in is never touched);
 *   - `scripts/okf-projections.mjs` uses the same pure helpers disk-side for
 *     offline fleet initialisation.
 *
 * Safety: an UNMARKED file sitting at a projection path is somebody's
 * content — reported as a conflict, never overwritten, never deleted. Only
 * marker-carrying files are ever rewritten or removed.
 */

import * as defaultRestClient from '../rest-client.mjs';
import { sanitizeResponse } from '../helpers/sanitize.mjs';
import { parseFrontmatter } from '../helpers/llms-txt-exporter.mjs';
import {
  buildProjections,
  planProjectionWrites,
  hasProjectionMarker,
  isProjectionPath,
  isWikiContentPath,
} from '../helpers/okf-projections.mjs';
import { collectMarkdown, readAll } from './build-wiki-graph.mjs';

export const TOOL_NAME = 'refresh_okf_projections';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Regenerate the OKF navigation projections inside `wiki/`: the root `index.md` (frontmatter `okf_version` only), one `index.md` per content directory (`* [Title](file.md) - description` entries, grouped by type), and a newest-first `log.md` — all derived deterministically from page frontmatter (title/description/type/dates), marked as generated, never to be hand-edited or wikilinked (internal links keep targeting `[[catalog]]`/`[[journal]]`). Unchanged files are skipped; stale generated indexes (their directory emptied) are deleted; a hand-written file squatting a reserved path is reported as a conflict and NEVER overwritten. Use `check: true` for a drift report without writing (wiki-lint integration). Projections are also refreshed automatically ~15 s after any router write under `wiki/` once the vault is initialised (root index present and marked).",
  inputSchema: {
    type: 'object',
    properties: {
      vault: {
        type: 'string',
        description: 'Vault name (see list_vaults). Omit to use the default vault.',
      },
      check: {
        type: 'boolean',
        description: 'When true, report what WOULD change (writes/deletes/conflicts) without touching any file. Default: false.',
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
 * Core refresh over ONE resolved vault. Injected deps for tests + reuse by
 * the middleware (which resolves the vault itself and passes
 * `requireInitialized: true`).
 *
 * @param {object} vault Resolved vault descriptor
 * @param {object} deps {listFilesIn, getFileContent, writeFile, deleteFile}
 * @param {object} [opts]
 * @param {boolean} [opts.check=false] Plan only, write nothing.
 * @param {boolean} [opts.requireInitialized=false] Abort silently unless the
 *   root `wiki/index.md` already exists AND carries the marker. The middleware
 *   sets this so vaults that never opted into projections are never touched;
 *   the explicit tool call leaves it false — calling the tool IS opting in.
 * @param {string} [opts.now] Injected ISO date (defaults to today).
 */
export async function refreshProjectionsForVault(vault, deps, opts = {}) {
  const { check = false, requireInitialized = false } = opts;
  const now = opts.now || new Date().toISOString().slice(0, 10);

  if (requireInitialized) {
    let rootIndex = null;
    try {
      rootIndex = asText(await deps.getFileContent(vault, 'wiki/index.md'));
    } catch {
      return { skipped: 'not-initialized' };
    }
    if (!hasProjectionMarker(rootIndex)) {
      return { skipped: rootIndex ? 'root-index-unmarked' : 'not-initialized' };
    }
  }

  // Enumerate the whole wiki tree once (same bounded walker as the graph).
  const { paths, truncated } = await collectMarkdown(deps.listFilesIn, vault, 'wiki');
  const warnings = [];
  if (truncated) {
    // A truncated enumeration means the plan would be built from a PARTIAL
    // tree — deletions computed from it would remove valid indexes. Refuse.
    return { skipped: 'enumeration-truncated', warnings: ['enumeration-truncated'] };
  }

  const contentPaths = paths.filter((p) => isWikiContentPath(p));
  const existingProjectionPaths = paths.filter((p) => isProjectionPath(p));

  const { items: pageItems, failures } = await readAll(deps.getFileContent, vault, contentPaths);
  if (failures > 0) warnings.push(`page-read-failures: ${failures}`);
  const pages = pageItems.map(({ path, content }) => {
    const { frontmatter, body } = parseFrontmatter(content);
    return { path, frontmatter, body };
  });

  const { items: currentItems, failures: projFailures } =
    await readAll(deps.getFileContent, vault, existingProjectionPaths);
  if (projFailures > 0) warnings.push(`projection-read-failures: ${projFailures}`);
  const current = new Map(currentItems.map(({ path, content }) => [path, content]));

  const { files } = buildProjections({ pages, vaultName: vault.name, now });
  const plan = planProjectionWrites({ generated: files, current });

  const result = {
    vault: vault.name,
    mode: check ? 'check' : 'apply',
    pagesScanned: pages.length,
    written: plan.writes.map((w) => w.path),
    deleted: plan.deletes,
    unchanged: plan.unchanged.length,
    conflicts: plan.conflicts,
    upToDate: plan.writes.length === 0 && plan.deletes.length === 0,
    warnings,
  };

  if (check) return result;

  for (const file of plan.writes) {
    await deps.writeFile(vault, file.path, file.content);
  }
  for (const path of plan.deletes) {
    try {
      await deps.deleteFile(vault, path);
    } catch (err) {
      warnings.push(`delete-failed: ${path} (${err?.message ?? err})`);
    }
  }
  return result;
}

/** MCP tool wrapper — registry resolution + response sanitization. */
export async function refreshOkfProjectionsTool(registry, args = {}, _deps = {}) {
  const deps = {
    listFilesIn: _deps.listFilesIn || defaultRestClient.listFilesIn,
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    writeFile: _deps.writeFile || defaultRestClient.writeFile,
    deleteFile: _deps.deleteFile || defaultRestClient.deleteFile,
  };
  const vault = registry.resolveVault(args.vault);
  const result = await refreshProjectionsForVault(vault, deps, {
    check: args.check === true,
    now: _deps.now,
  });
  return sanitizeResponse(result);
}
