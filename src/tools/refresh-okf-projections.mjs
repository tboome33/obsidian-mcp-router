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
import { parseFrontmatter } from '../helpers/llms-txt-exporter.mjs';
import { contentSha256 } from '../helpers/content-hash.mjs';
import { computePlanSeal, verifyPlanSeal, isPlanSeal, vaultIdentity, PlanDriftError } from '../helpers/plan-seal.mjs';
import {
  buildProjections,
  planProjectionWrites,
  hasProjectionMarker,
  isProjectionPath,
  isWikiContentPath,
} from '../helpers/okf-projections.mjs';
import { scaffoldCandidates, shouldTryLegacyScaffold } from '../helpers/wiki-meta-scaffolds.mjs';
import { withVaultLock } from '../helpers/vault-maintenance-lock.mjs';
import { applyReservedWrites, strictReservedCasEnabled } from '../helpers/reserved-path-write.mjs';
import { collectMarkdown, readAll } from './build-wiki-graph.mjs';
import { CONFIRM_SECONDARY_WRITE_PROP } from '../helpers/vault-reach.mjs';
import {
  WIKI_META_OWNED_AREAS,
  detectSessionFolderCollision,
  detectCatalogOwnedHeadings,
} from '../helpers/session-folder-collision.mjs';

/**
 * The catalogue half of Check O: is an owned name still an AREA of this vault's
 * catalogue, sending the next session note under `wiki/`?
 *
 * One extra read, and only for the explicit caller (`sessionScan`). The
 * candidate list and the fall-through rule are the shared ones —
 * `scaffoldCandidates` for the names, `shouldTryLegacyScaffold` for "only a true
 * 404 means *not under this name*". Anything else is about the VAULT, so it
 * stops the search and is reported: re-asking under the old name cannot succeed,
 * and an unreachable vault must never be summarised as having no heading.
 *
 * @returns {Promise<{findings: object[], skipped: string|null}>}
 */
async function readCatalogHeadings({ getFileContent, vault }) {
  if (typeof getFileContent !== 'function') return { findings: [], skipped: 'catalog-read-failed' };
  for (const rel of scaffoldCandidates('catalog')) {
    let text;
    try {
      text = asText(await getFileContent(vault, rel));
    } catch (err) {
      if (shouldTryLegacyScaffold(err)) continue;
      return { findings: [], skipped: 'catalog-read-failed' };
    }
    return {
      findings: detectCatalogOwnedHeadings(text).map((f) => ({ ...f, file: rel })),
      skipped: null,
    };
  }
  return { findings: [], skipped: null };
}

/**
 * Check O — two folders named "Sessions" — from the refresh's OWN snapshot.
 *
 * WHY HERE. The rule lives in `helpers/session-folder-collision.mjs` and the
 * offline fleet CLI already applies it; but the vault where the incident
 * happened was being driven from a session with no shell, through the router.
 * A check that only an operator at a terminal can run is invisible exactly
 * where the misfile occurs. `check: true` is what wiki-lint already calls, and
 * this refresh has already enumerated `wiki/` in full and read every file at a
 * projection path fail-closed — so the `wiki/` half of the question costs
 * nothing more, and the marker verdict comes from bytes already in hand.
 *
 * The `wiki-meta/` half is one top-level listing plus one walk per owned
 * directory. It is fail-closed the same way the refresh is: a listing that
 * FAILED (not a 404) means the scan cannot say "no collision", and it says so
 * with `skipped` instead of returning an empty finding list.
 *
 * Deliberately OUTSIDE the C3 seal: `projectionPlanCore` describes what an
 * apply would write, and a sessions finding changes no write. A seal taken by
 * `check: true` must still verify on the apply that follows it.
 *
 * @param {object} input
 * @param {(v:object, dir:string)=>Promise<any>} input.listFilesIn
 * @param {object} input.vault
 * @param {string[]} input.wikiPaths every `.md` under `wiki/` (the refresh's walk)
 * @param {Map<string,string>} input.current content of every existing projection path
 * @returns {Promise<{findings: object[], skipped: string|null, metaDirs: string[]}>}
 */
export async function scanSessionFolders({ listFilesIn, getFileContent, vault, wikiPaths, current }) {
  const owned = new Set(WIKI_META_OWNED_AREAS.map((a) => a.toLowerCase()));

  // wiki/ side: a file at a projection path is generated iff its bytes carry
  // the marker — the same bytes the planner just used to decide conflicts.
  const entries = wikiPaths.map((p) => ({
    path: p,
    generated: isProjectionPath(p) ? hasProjectionMarker(current.get(p) ?? '') : false,
  }));

  // The two halves answer DIFFERENT questions, so they fail differently. A
  // folder enumeration that failed makes "no collision" unsayable and returns
  // no findings at all — the pre-existing contract, unchanged. An unread
  // CATALOGUE leaves only the heading question open, so the folder findings
  // that WERE established are still returned alongside `catalog-read-failed`.
  // Both facts are documented where the reader of this block lives
  // (`skills/wiki-lint/SKILL.md`, Check O), because one `skipped` field
  // carrying two meanings is exactly how a valid finding gets dropped.
  const withCatalog = async (folderFindings, metaDirs) => {
    const catalog = await readCatalogHeadings({ getFileContent, vault });
    return {
      findings: [...folderFindings, ...catalog.findings],
      skipped: catalog.skipped,
      metaDirs,
    };
  };

  // wiki-meta/ side: nothing under it is ever generated by the router, so every
  // .md there is content without a read.
  let listing;
  try {
    listing = await listFilesIn(vault, 'wiki-meta');
  } catch (err) {
    if (err?.kind === 'not_found') {
      return withCatalog(detectSessionFolderCollision(entries).findings, []);
    }
    return { findings: [], skipped: 'enumeration-failed', metaDirs: [] };
  }
  const names = Array.isArray(listing?.files) ? listing.files : [];
  const metaDirs = names
    .filter((n) => typeof n === 'string' && n.endsWith('/') && owned.has(n.replace(/\/+$/, '').toLowerCase()))
    .map((n) => `wiki-meta/${n.replace(/\/+$/, '')}`);
  for (const dir of metaDirs) {
    const { paths, truncated, listFailures } = await collectMarkdown(listFilesIn, vault, dir);
    if (truncated) return { findings: [], skipped: 'enumeration-truncated', metaDirs };
    if (listFailures > 0) return { findings: [], skipped: 'enumeration-failed', metaDirs };
    for (const p of paths) entries.push({ path: p, generated: false });
  }
  return withCatalog(detectSessionFolderCollision(entries).findings, metaDirs);
}

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
    "Regenerate the OKF navigation projections inside `wiki/`: the root `index.md` (frontmatter `okf_version` only), one `index.md` per content directory (`* [Title](file.md) - description` entries, grouped by type), and a newest-first `log.md` — all derived deterministically from page frontmatter (title/description/type/dates), marked as generated, never to be hand-edited or wikilinked (internal links keep targeting `[[catalog]]`/`[[journal]]`). Unchanged files are skipped; stale generated indexes (their directory emptied) are deleted; a hand-written file squatting a reserved path is reported as a conflict and NEVER overwritten. Use `check: true` for a drift report without writing (wiki-lint integration). Every explicit call also returns `sessions` — wiki-lint's Check O: `findings` of `session-folder-collision` (content under BOTH `wiki/Sessions/` and `wiki-meta/Sessions/`, ERROR), `session-folder-stray` (under `wiki/Sessions/` only, WARNING), or `catalog-sessions-heading` (WARNING — the vault's catalogue still carries a `## Sessions` AREA heading, with `file`/`line`/`heading`: the signpost that sends the next agent to the wrong folder, reportable even when nothing is misfiled yet). `skipped` is `enumeration-failed`/`enumeration-truncated` when `wiki-meta/` could not be listed in full (findings are empty then — the check could not run), or `catalog-read-failed` when only the catalogue could not be read (any findings alongside it remain valid). Session notes belong in `wiki-meta/Sessions/`; a `wiki/` twin is reported, never moved. Projections are also refreshed automatically ~15 s after any router write under `wiki/` once the vault is initialised (root index present and marked).",
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
      confirmSecondaryWrite: CONFIRM_SECONDARY_WRITE_PROP,
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
  const {
    check = false,
    requireInitialized = false,
    requireScaffold = false,
    // F3-b: the AUTOMATIC callers set these. `conditionalWrites` routes writes
    // through the reserved-path writer (backup-before-overwrite, never a blind
    // clobber); `deferDeletes` reports stale generated files instead of deleting
    // them; `strictReservedCas` skips a racy overwrite instead of the reduced
    // backup path. The explicit tool leaves them off unless it opts in.
    conditionalWrites = false,
    deferDeletes = false,
    strictReservedCas = false,
    // Check O (two folders named "Sessions"). OFF by default so the automatic
    // callers — the debounced middleware, the first-contact repair — keep
    // exactly the REST traffic and the result shape they had; the explicit
    // tool turns it on, because a session driving the router is where the
    // finding is worth reading.
    sessionScan = false,
    nowMs = Date.now(),
  } = opts;
  const now = opts.now || new Date().toISOString().slice(0, 10);

  // THE OPT-IN SIGNAL — two of them, and they answer different questions.
  //
  // `requireScaffold` (the maintenance paths): is this a ROUTER-MANAGED vault?
  // The honest marker of that is the private `wiki-meta/` scaffold the
  // provisioner writes — `catalog.md`, or `index.md` on a vault still on the
  // pre-0.58.0 names. It is present from the moment the vault is provisioned and
  // it survives a missing or damaged `wiki/index.md`.
  //
  // `requireInitialized` (kept, unchanged): does the ROOT PROJECTION already
  // exist and carry the marker?
  //
  // Gating maintenance on the latter was a contradiction the reviewers caught:
  // a vault whose root `wiki/index.md` had gone missing was reported as
  // non-conformant by the bridge, whose Notice says "the router will repair it"
  // — and `requireInitialized` refused to repair precisely that. The scaffold
  // answers the question actually being asked, so maintenance uses it, and the
  // safety that made the strict gate attractive is unchanged: `planProjectionWrites`
  // still refuses to overwrite any UNMARKED file and reports it as a conflict.
  if (requireScaffold) {
    let seen = false;
    for (const rel of scaffoldCandidates('catalog')) {
      try {
        await deps.getFileContent(vault, rel);
        seen = true;
        break;
      } catch (err) {
        // Only a true 404 means "not under this name". Anything else —
        // unreachable, unauthorized, timeout — is about the VAULT, and mapping
        // it onto "not a router vault" would make the skip perfectly silent.
        if (err?.kind !== 'not_found') throw err;
      }
    }
    if (!seen) return { skipped: 'no-wiki-meta-scaffold' };
  }

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
  const { paths, truncated, listFailures } = await collectMarkdown(deps.listFilesIn, vault, 'wiki');
  const warnings = [];
  if (truncated) {
    // A truncated enumeration means the plan would be built from a PARTIAL
    // tree — deletions computed from it would remove valid indexes. Refuse.
    return { skipped: 'enumeration-truncated', warnings: ['enumeration-truncated'] };
  }
  // THE DANGEROUS ONE, and it went unread here for two releases while the BM25
  // builder next door checked it.
  //
  // `collectMarkdown` distinguishes a directory that is ABSENT (a 404 — normal)
  // from one that FAILED TO LIST (a timeout, a 500, a permission error). A
  // subtree that failed to list contributes no paths, so it is indistinguishable
  // from an empty one — and this planner turns "no pages under `wiki/notes/`"
  // into "delete `wiki/notes/index.md`". Under the automatic repair that
  // deletion is then EXECUTED, unattended, because one directory listing
  // hiccuped. Deleting a valid index over a transient REST failure is the worst
  // outcome this feature can produce, so: no enumeration, no plan, no writes.
  if (listFailures > 0) {
    return {
      skipped: 'enumeration-failed',
      warnings: [
        `${listFailures} directory listing(s) failed — the vault tree could not be read in full, so a ` +
          'plan built from it would delete indexes for directories that merely did not answer. ' +
          'Nothing was written or deleted. Fix vault access and re-run.',
      ],
    };
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

  // PLANNED vs ACTUAL are now DISTINCT (codex H1). `plannedWrites`/`plannedDeletes`
  // describe the plan; `written`/`deleted` describe what the apply actually did.
  // A runtime conflict (a foreign file appeared on a reserved path between the
  // snapshot and the write) removes that path from `written` and adds it to
  // `conflicts`, and `conformant` is computed AFTER the apply.
  const plannedWrites = plan.writes.map((w) => w.path);
  const plannedDeletes = plan.deletes;
  const snapshotConflicts = plan.conflicts; // squatters seen AT the snapshot

  // Same snapshot the plan was built from, so a generated `wiki/Sessions/index.md`
  // the apply is about to delete is already excluded by its marker, and an
  // unmarked one shows up in BOTH `conflicts` (the planner's word) and here.
  const sessions = sessionScan
    ? await scanSessionFolders({
      listFilesIn: deps.listFilesIn,
      getFileContent: deps.getFileContent,
      vault,
      wikiPaths: paths,
      current,
    })
    : undefined;

  if (check) {
    return {
      vault: vault.name,
      mode: 'check',
      ...(sessions ? { sessions } : {}),
      pagesScanned: pages.length,
      plannedWrites,
      plannedDeletes,
      // `written`/`deleted` mirror the plan in check mode (nothing is written) —
      // kept for callers that read them, but they are PLANNED, not actual.
      written: plannedWrites,
      deleted: plannedDeletes,
      pendingDeletes: [],
      unchanged: plan.unchanged.length,
      conflicts: snapshotConflicts,
      backups: [],
      protectionMode: null,
      upToDate: plannedWrites.length === 0 && plannedDeletes.length === 0,
      conformant: plannedWrites.length === 0 && plannedDeletes.length === 0 && snapshotConflicts.length === 0,
      approvedPlanSha256,
      warnings,
    };
  }

  // Refuse to apply a drifted plan — BEFORE any write. Especially load-bearing
  // with conditional writes: the user approved THIS plan, and a file that
  // appeared after the seal must not be silently clobbered (codex H4).
  if (opts.approvedPlanSha256 !== undefined) {
    verifyPlanSeal({
      op: 'refresh_okf_projections',
      identity: vaultIdentity(vault),
      plan: planCore,
      approvedPlanSha256: opts.approvedPlanSha256,
      previewHint: 'call refresh_okf_projections with check:true',
    });
  }

  // WRITES.
  let written = [];
  let runtimeConflicts = [];
  let backups = [];
  let protectionMode = null;
  if (conditionalWrites) {
    // Each planned write carries what we read at snapshot (undefined = the path
    // was absent → a CREATE) and a recogniser for OUR own projection, so a
    // foreign file earns a backup instead of a blind overwrite.
    const plannedWithSnapshot = plan.writes.map((w) => ({
      path: w.path,
      content: w.content,
      snapshotContent: current.get(w.path),
      // No swallowing catch here BY DESIGN: `hasProjectionMarker` is imported
      // (line 30) and string-scans — it never throws SyntaxError. So a broken
      // import would surface as a ReferenceError that EXPLODES, never a silent
      // "foreign" verdict that sidecars our own projection on every rebuild
      // (the class of bug the index closure's tight catch also guards against).
      isOurs: (c) => hasProjectionMarker(c),
    }));
    const applied = await applyReservedWrites({
      deps: {
        writeFile: deps.writeFile,
        getFileContent: deps.getFileContent,
        attemptAtomicCas: deps.attemptAtomicCas,
      },
      vault,
      plannedWrites: plannedWithSnapshot,
      mode: strictReservedCas ? 'strict' : 'reduced',
      nowMs,
    });
    written = applied.written;
    runtimeConflicts = applied.conflicts;
    backups = applied.backups;
    protectionMode = applied.protectionMode;
    warnings.push(...applied.warnings);
  } else {
    for (const file of plan.writes) {
      await deps.writeFile(vault, file.path, file.content);
      written.push(file.path);
    }
    protectionMode = 'unconditional';
  }

  // DELETES. On the AUTOMATIC path deletes are NEVER executed (codex H3): an
  // automatic delete of a reserved-path file is irrecoverable by nature, so it
  // is reported as `pendingDeletes` and left for an explicit action. The
  // explicit tool (deferDeletes off) still deletes.
  let deleted = [];
  let pendingDeletes = [];
  if (deferDeletes) {
    pendingDeletes = plannedDeletes;
  } else {
    for (const path of plan.deletes) {
      try {
        await deps.deleteFile(vault, path);
        deleted.push(path);
      } catch (err) {
        warnings.push(`delete-failed: ${path} (${err?.message ?? err})`);
      }
    }
  }

  const conflicts = [...snapshotConflicts, ...runtimeConflicts];
  return {
    vault: vault.name,
    mode: 'apply',
    ...(sessions ? { sessions } : {}),
    pagesScanned: pages.length,
    plannedWrites,
    plannedDeletes,
    written,
    deleted,
    pendingDeletes,
    unchanged: plan.unchanged.length,
    conflicts,
    backups,
    protectionMode,
    // `upToDate` is a statement about WORK — "there was nothing to do" — and is
    // computed from the PLAN, as callers/tests read it.
    upToDate: plannedWrites.length === 0 && plannedDeletes.length === 0,
    // `conformant` is the statement about the VAULT, POST-apply: no conflict, no
    // foreign file backed-up-and-clobbered, no pending cleanup, and every
    // planned write actually landed.
    conformant:
      conflicts.length === 0 &&
      backups.length === 0 &&
      pendingDeletes.length === 0 &&
      written.length === plannedWrites.length,
    approvedPlanSha256,
    warnings,
  };
}

/** MCP tool wrapper — registry resolution + response sanitization. */
export async function refreshOkfProjectionsTool(registry, args = {}, _deps = {}) {
  const deps = {
    listFilesIn: _deps.listFilesIn || defaultRestClient.listFilesIn,
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    writeFile: _deps.writeFile || defaultRestClient.writeFile,
    deleteFile: _deps.deleteFile || defaultRestClient.deleteFile,
    attemptAtomicCas: _deps.attemptAtomicCas || defaultRestClient.attemptAtomicCas,
  };
  // Validate the seal SHAPE before any network I/O — a typo must not silently
  // behave like "no seal" and let a drifted apply through.
  if (args.approvedPlanSha256 !== undefined && !isPlanSeal(args.approvedPlanSha256)) {
    // PlanDriftError so the refusal classifies as validation, not unknown.
    throw new PlanDriftError(
      'Invalid approvedPlanSha256: expected a 64-char lowercase hex plan seal ' +
        '(the value refresh_okf_projections returned with check:true).',
      { op: 'refresh_okf_projections', provided: String(args.approvedPlanSha256) },
    );
  }
  const vault = registry.resolveVault(args.vault);
  // Through THE lock (helpers/vault-maintenance-lock.mjs), so an explicit
  // refresh can no longer race the debounced flush or the first-contact repair.
  // `check: true` takes it as well and still writes nothing: a drift report
  // computed while a flush is halfway through describes a tree that never
  // existed, and the C3 seal it returns would bind to it.
  const result = await withVaultLock(vault.name, () => refreshProjectionsForVault(vault, deps, {
    check: args.check === true,
    approvedPlanSha256: args.approvedPlanSha256,
    now: _deps.now,
    // The EXPLICIT apply is protected too (codex H4): the user approved a
    // specific plan, and a file that appeared AFTER the approval must not be
    // clobbered. Deletes still fire (an explicit refresh is a deliberate act).
    conditionalWrites: true,
    strictReservedCas: strictReservedCasEnabled(),
    sessionScan: true,
    nowMs: _deps.nowMs,
  }));
  return result; // normalized once at the wire boundary (wrapResult)
}
