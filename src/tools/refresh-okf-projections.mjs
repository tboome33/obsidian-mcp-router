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
import { contentSha256 } from '../helpers/content-hash.mjs';
import { computePlanSeal, verifyPlanSeal, isPlanSeal, vaultIdentity } from '../helpers/plan-seal.mjs';
import {
  buildProjections,
  planProjectionWrites,
  hasProjectionMarker,
  isProjectionPath,
  isWikiContentPath,
} from '../helpers/okf-projections.mjs';
import { collectMarkdown, readAll } from './build-wiki-graph.mjs';

/**
 * The drift-sensitive core of a projection plan, for the C3 seal. Captures
 * exactly what the apply would do — the writes (path + content fingerprint), the
 * deletes, and the conflicts — order-normalized so the same logical plan always
 * hashes identically. `check:true` seals this; the apply re-derives it from the
 * current tree and refuses if it moved (a page added/edited, a conflict
 * appeared or was resolved) since the check.
 */
function projectionPlanCore(plan) {
  const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    writes: (plan.writes || [])
      .map((w) => ({ path: w.path, sha: contentSha256(w.content) }))
      .sort((a, b) => byPath(a.path, b.path)),
    deletes: [...(plan.deletes || [])].sort(),
    conflicts: [...(plan.conflicts || [])]
      .map((c) => (typeof c === 'string' ? c : c && c.path != null ? String(c.path) : JSON.stringify(c)))
      .sort(),
  };
}

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
        description: 'When true, report what WOULD change (writes/deletes/conflicts) without touching any file — and return an approvedPlanSha256 sealing that plan. Default: false.',
      },
      approvedPlanSha256: {
        type: 'string',
        description: 'C3 sealed preview: the 64-hex seal a prior check:true call returned. When supplied on an apply, the refresh is refused (before any write) if the projection plan drifted since the check — a page was added/edited or a conflict appeared. Use it to apply exactly the plan you reviewed, especially when conflicts are present.',
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
    } catch (err) {
      // Only a true 404 means "this vault never opted in". Anything else —
      // unreachable, unauthorized, timeout — is about the VAULT, and mapping
      // it onto 'not-initialized' would make the skip perfectly silent; let
      // it reach the scheduler's logError instead (review v0.59.0 N2).
      if (err?.kind === 'not_found') return { skipped: 'not-initialized' };
      throw err;
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

  // FAIL CLOSED on any read failure — both directions matter (codex review):
  //   - a content page that failed to read would make every index and the log
  //     silently DROP its entries until some later refresh;
  //   - an existing file at a projection path that failed to read would be
  //     absent from `current`, so the planner would treat the path as free —
  //     and if that unreadable file was an UNMARKED hand-written page, the
  //     write would destroy exactly what the conflict rule protects.
  // A transient REST failure must mean "no refresh", never "wrong refresh".
  const { items: pageItems, failures } = await readAll(deps.getFileContent, vault, contentPaths);
  if (failures > 0) {
    return { skipped: 'page-reads-failed', warnings: [`page-read-failures: ${failures}`] };
  }
  const pages = pageItems.map(({ path, content }) => {
    const { frontmatter, body } = parseFrontmatter(content);
    return { path, frontmatter, body };
  });

  const { items: currentItems, failures: projFailures } =
    await readAll(deps.getFileContent, vault, existingProjectionPaths);
  if (projFailures > 0) {
    return { skipped: 'projection-reads-failed', warnings: [`projection-read-failures: ${projFailures}`] };
  }
  const current = new Map(currentItems.map(({ path, content }) => [path, content]));

  const { files } = buildProjections({ pages, vaultName: vault.name, now });
  const plan = planProjectionWrites({ generated: files, current });

  // C3 sealed preview: bind the plan to the resolved vault. `check:true` returns
  // this so the caller can approve it; a later apply that echoes it is refused if
  // the tree drifted (a page added/edited, a conflict appeared/resolved) since —
  // most valuable "en mode conflit", where blindly applying a stale plan could
  // touch a path a hand-written file has since claimed.
  const planCore = projectionPlanCore(plan);
  const approvedPlanSha256 = computePlanSeal({
    op: 'refresh_okf_projections',
    identity: vaultIdentity(vault),
    plan: planCore,
  });

  const result = {
    vault: vault.name,
    mode: check ? 'check' : 'apply',
    pagesScanned: pages.length,
    written: plan.writes.map((w) => w.path),
    deleted: plan.deletes,
    unchanged: plan.unchanged.length,
    conflicts: plan.conflicts,
    upToDate: plan.writes.length === 0 && plan.deletes.length === 0,
    approvedPlanSha256,
    warnings,
  };

  if (check) return result;

  // Refuse to apply a drifted plan — BEFORE any write.
  if (opts.approvedPlanSha256 !== undefined) {
    verifyPlanSeal({
      op: 'refresh_okf_projections',
      identity: vaultIdentity(vault),
      plan: planCore,
      approvedPlanSha256: opts.approvedPlanSha256,
      previewHint: 'call refresh_okf_projections with check:true',
    });
  }

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
  // Validate the seal SHAPE before any network I/O — a typo must not silently
  // behave like "no seal" and let a drifted apply through.
  if (args.approvedPlanSha256 !== undefined && !isPlanSeal(args.approvedPlanSha256)) {
    throw new Error(
      'Invalid approvedPlanSha256: expected a 64-char lowercase hex plan seal ' +
        '(the value refresh_okf_projections returned with check:true).',
    );
  }
  const vault = registry.resolveVault(args.vault);
  const result = await refreshProjectionsForVault(vault, deps, {
    check: args.check === true,
    approvedPlanSha256: args.approvedPlanSha256,
    now: _deps.now,
  });
  return sanitizeResponse(result);
}
