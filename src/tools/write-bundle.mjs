/**
 * `write_bundle` — the MCP surface of the C2 journaled multi-file operation.
 *
 * `src/helpers/write-bundle.mjs` holds the rules (validation, plan derivation,
 * the rollback decision table, the journal shape). This module is the I/O around
 * them: capture before-images, persist the journal, run the steps THROUGH THE
 * EXISTING SINGLE-FILE TOOLS, and undo on failure.
 *
 * Steps are executed by the real `write_file` / `append_to_file` / `patch_file` /
 * `set_frontmatter` / `merge_frontmatter` / `delete_file` handlers rather than by
 * a parallel implementation. Every guard those tools carry — C1 `ifMatch`, the
 * delete confirmation, the OKF-name and projection warnings, the router-side
 * heading engine — therefore applies inside a bundle exactly as outside it, and
 * cannot drift from it.
 *
 * TWO FAILURE CONTRACTS, on purpose:
 *   - anything that refuses BEFORE the first write THROWS (validation, a stale
 *     `ifMatch`, seal drift, an unreadable target, an unpersistable journal). A
 *     throw from this tool means the vault was not touched.
 *   - a failure DURING the steps RETURNS a result with `ok:false` and the full
 *     rollback report, because throwing would take that report with it.
 */
import * as defaultRestClient from '../rest-client.mjs';
import { randomBytes } from 'node:crypto';
import { buildClickToOpenUrl, resolveInsecurePort } from '../helpers/click-to-open.mjs';
import { contentSha256, isContentSha256 } from '../helpers/content-hash.mjs';
import { computePlanSeal, verifyPlanSeal, isPlanSeal, vaultIdentity, PlanDriftError } from '../helpers/plan-seal.mjs';
import { classifyError } from '../error-classify.mjs';
import {
  BundleError,
  BUNDLE_JOURNAL_DIR,
  BUNDLE_SEAL_OP,
  JOURNAL_PENDING,
  MAX_BACKUP_BYTES,
  MAX_STEPS,
  STEP_OPS,
  backupBytes,
  buildBundlePlan,
  buildJournal,
  canonicalVaultPath,
  derivePostImage,
  isCleanRollback,
  isOperationId,
  isVerifiedRollback,
  journalPathFor,
  newOperationId,
  normalizeRecoverArg,
  outcomeMessage,
  parseJournal,
  planRestore,
  uniquePaths,
  validateSteps,
} from '../helpers/write-bundle.mjs';

import { writeFileTool } from './write-file.mjs';
import { appendToFileTool } from './append-to-file.mjs';
import { patchFileTool } from './patch-file.mjs';
import { setFrontmatterTool } from './set-frontmatter.mjs';
import { mergeFrontmatterTool } from './merge-frontmatter.mjs';
import { deleteFileTool } from './delete-file.mjs';

export const TOOL_NAME = 'write_bundle';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Run several vault writes as ONE logical operation with rollback. A save, an ingestion or a fold touches 3-4 files (the note, an index, the journal, hot.md); today a failure at step 3 leaves the vault half-written and nothing notices. write_bundle captures every target's content BEFORE the first write, persists those before-images to a journal (so a rollback survives the process dying), then runs the steps through the ordinary write_file / append_to_file / patch_file / set_frontmatter / merge_frontmatter / delete_file handlers — every guard they carry still applies. If any step fails, every file the bundle touched is put back to the content the bundle read, and the result says which: `applied` · `rolled-back` · `rolled-back-unverified` (everything is back, but the undo could not be proven) · `rolled-back-partial` (some files are still dirty). Read that field — a failure mid-bundle RETURNS this report with ok:false rather than throwing; only refusals BEFORE the first write throw. HONEST SCOPE: this is recovery, not isolation — a concurrent reader can still observe an intermediate state while the bundle runs, and a bundle is not a lock. A file changed by SOMEONE ELSE is never restored over (that would be the exact clobber ifMatch exists to prevent): it is left alone and named in the report. Attribution is graded — `ours` when the bundle knows the exact bytes it wrote (write/delete steps), `observed` when it can only read the file back after the step (patch/append/frontmatter steps, where a write landing inside that one round trip would be adopted as the bundle's own). Steps may carry `ifMatch`: the preconditions are all checked up front, so a bundle whose targets moved refuses ENTIRELY before writing anything. Use `preview:true` for a sealed plan, and `recover:true` to list journals left behind by a crash.",
  inputSchema: {
    type: 'object',
    properties: {
      vault: { type: 'string', description: 'Vault name (see list_vaults). Omit for the default vault. A bundle is single-vault: steps may not override it.' },
      steps: {
        type: 'array',
        description:
          `Ordered list of writes, at most ${MAX_STEPS}. Each entry is { op, path, ...the arguments that op's own tool takes }. ` +
          `op is one of: ${STEP_OPS.join(', ')}. A "delete" step still requires confirm:true, exactly like delete_file. ` +
          `"move" is deliberately unsupported — express it as a delete plus a write.`,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: STEP_OPS, description: 'Which write to perform.' },
            path: { type: 'string', description: 'Vault-relative path this step writes.' },
            content: { type: 'string', description: 'For write / append / patch.' },
            ifMatch: { type: 'string', description: "C1 precondition for this step's file: the contentSha256 you read. Verified for EVERY step before the first write, so a stale bundle refuses whole." },
            confirm: { type: 'boolean', description: 'Required (true) on a delete step.' },
            operation: { type: 'string', description: 'For patch: append | prepend | replace.' },
            targetType: { type: 'string', description: 'For patch: heading | block | frontmatter.' },
            target: { type: 'string', description: 'For patch: the heading path / block id / frontmatter key.' },
            key: { type: 'string', description: 'For set_frontmatter.' },
            values: { type: 'object', description: 'For merge_frontmatter. A partially-applied merge counts as a FAILED step and rolls the bundle back — this is what makes merge_frontmatter all-or-nothing.' },
          },
          required: ['op', 'path'],
          additionalProperties: true,
        },
      },
      preview: { type: 'boolean', description: 'Return the plan (what each step would touch, the current state of every target, and any ifMatch precondition that is ALREADY stale) plus an approvedPlanSha256 seal, WITHOUT writing.' },
      approvedPlanSha256: { type: 'string', description: 'C3 sealed preview: the seal a preview:true call returned. When supplied, the bundle is refused — before any write — if the plan or any target drifted since the preview.' },
      recover: {
        // NOT `oneOf`: a union does not survive every MCP client's schema
        // normalisation — observed in production on the first real call, where
        // `recover: true` arrived as the string "true" and the read-only listing
        // became unreachable. The handler normalises both forms.
        type: ['boolean', 'string'],
        description:
          'true (or "true") → LIST the journals left behind by bundles that never finished (read-only), each with a per-file verdict of what a recovery would do. ' +
          'An operationId string → replay that journal\'s rollback (requires confirm:true). Recovery cannot attribute the current content to anyone — it also cannot tell which files the crashed bundle actually reached — so it reports every restore as `unverified`: list first, look at the files, then decide. Narrow it with `only`.',
      },
      only: { type: 'array', items: { type: 'string' }, description: 'For a recovery run: restore ONLY these paths out of the journal. Use it when the listing shows files you know you edited yourself after the crash.' },
      confirm: { type: 'boolean', description: 'Required (true) to RUN a recovery. Ignored when applying a normal bundle.' },
    },
    required: [],
    additionalProperties: false,
  },
};

/**
 * op → the tool that performs it. Reusing the real handlers is the point: a
 * bundle must never be a second implementation that can drift from the tools it
 * bundles.
 */
const DEFAULT_EXECUTORS = {
  write: (registry, args) => writeFileTool(registry, args),
  append: (registry, args) => appendToFileTool(registry, args),
  patch: (registry, args) => patchFileTool(registry, args),
  set_frontmatter: (registry, args) => setFrontmatterTool(registry, args),
  merge_frontmatter: (registry, args) => mergeFrontmatterTool(registry, args),
  delete: (registry, args) => deleteFileTool(registry, args),
};

/**
 * Some tools report a partial failure in their RESULT instead of throwing.
 * `merge_frontmatter` is the whole reason C2 exists ("sequential, NOT atomic"):
 * it writes one frontmatter key per call and returns a per-key status. Treating
 * its `failed > 0` as success would let a bundle report `applied` over a
 * half-written file — the precise dishonesty this feature is meant to remove.
 */
const RESULT_FAILURE_PROBES = {
  merge_frontmatter: (r) =>
    r && r.failed > 0
      ? `merge_frontmatter applied ${r.applied} key(s) and failed on ${r.failed}: ${r.firstError || 'unknown error'}`
      : null,
};

/**
 * Results that are legitimate NO-OPS rather than failures. `patch_file` with
 * `applyIfContentPreexists:false` returns `patched:false` when the content is
 * already there — an idempotent success, so it must not roll the bundle back.
 * It must not be counted as a write either: "applied all N steps" over a step
 * that changed nothing is the small end of the same dishonesty.
 */
const RESULT_SKIP_PROBES = {
  patch: (r) => (r && r.patched === false ? r.skippedReason || 'the target already satisfied this patch' : null),
};

/** Coerce a getFileContent result (string | {content}) into a string. */
function asText(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res.content === 'string') return res.content;
  return String(res ?? '');
}

/** Read one path's current state. `not_found` is a state, not an error. */
async function probePath(getFileContent, vault, filePath) {
  try {
    const content = asText(await getFileContent(vault, filePath));
    return { exists: true, content, contentSha256: contentSha256(content) };
  } catch (err) {
    if (err && err.kind === 'not_found') {
      return { exists: false, content: null, contentSha256: null };
    }
    throw err;
  }
}

function resolveDeps(_deps = {}) {
  return {
    getFileContent: _deps.getFileContent || defaultRestClient.getFileContent,
    writeFile: _deps.writeFile || defaultRestClient.writeFile,
    writeFileIfMatch: _deps.writeFileIfMatch || defaultRestClient.writeFileIfMatch,
    deleteFile: _deps.deleteFile || defaultRestClient.deleteFile,
    assertContentMatches: _deps.assertContentMatches || defaultRestClient.assertContentMatches,
    listFilesIn: _deps.listFilesIn || defaultRestClient.listFilesIn,
    executors: { ...DEFAULT_EXECUTORS, ..._deps.executors },
    now: _deps.now || (() => new Date().toISOString()),
    randomHex: _deps.randomHex || (() => randomBytes(8).toString('hex')),
  };
}

/**
 * Undo a bundle. Walks the touched paths in REVERSE order and asks
 * `planRestore` what may be done to each; a path whose current content is not
 * attributable to this bundle is left untouched and reported. One path's failure
 * never aborts the others — the goal is to restore as much as is provably ours.
 *
 * Every action is conditional on what the probe just observed, so nothing can
 * slip into the gap between deciding and acting: a restore is a compare-and-swap,
 * and a delete re-asserts the content first (Local REST API has no conditional
 * DELETE, so the assert is the nearest equivalent — the same guard `delete_file`
 * with `ifMatch` uses).
 *
 * @returns {{results:Array, salvage:Object}} `salvage` holds the content that an
 *   UNVERIFIED action overwrote, so nothing is destroyed without a copy.
 */
async function rollbackPaths(deps, vault, { backups, lastState, touchedPaths, persistSalvage = async () => null }) {
  const results = [];
  const salvage = Object.create(null);

  for (const filePath of [...touchedPaths].reverse()) {
    const before = backups.get(filePath) || { existed: false, content: null, contentSha256: null };
    let current;
    try {
      current = await probePath(deps.getFileContent, vault, filePath);
    } catch (err) {
      results.push({
        path: filePath,
        action: 'skip',
        status: 'unknown',
        error: `could not read the file to decide how to restore it: ${err.message}`,
      });
      continue;
    }

    const verdict = planRestore(before, lastState.get(filePath) || null, current);
    const entry = { path: filePath, ...verdict };
    if (verdict.action === 'none' || verdict.action === 'skip') {
      results.push(entry);
      continue;
    }

    // An unverified action is about to overwrite content nobody could attribute.
    // Persist a copy BEFORE touching it — in memory only would lose it to the
    // very crash this journal exists for — and if that copy cannot be persisted,
    // do not perform the action at all. Fail closed: an unprovable overwrite
    // with no salvage is the one thing this module must never do.
    if (verdict.attribution === 'unverified' && current.exists) {
      salvage[filePath] = { content: current.content, contentSha256: current.contentSha256 };
      const persisted = await persistSalvage(salvage);
      if (persisted) {
        results.push({
          ...entry,
          action: 'skip',
          status: 'left-modified',
          reason:
            `this content could not be attributed to the bundle, and the copy that would have been kept ` +
            `before overwriting it could not be saved (${persisted}) — so it was left exactly as it is`,
        });
        continue;
      }
    }

    try {
      if (verdict.action === 'restore') {
        if (current.exists) {
          await deps.writeFileIfMatch(vault, filePath, before.content, current.contentSha256);
        } else {
          // Re-create a file the bundle removed. Create-only, so a third party
          // that re-created it in the meantime wins instead of being overwritten.
          await deps.writeFile(vault, filePath, before.content, { applyIfContentPreexists: false });
        }
      } else {
        // Re-assert the exact content observed a moment ago, then delete. Local
        // REST API has no conditional DELETE, so this narrows the window to the
        // same non-atomic tier as every other guarded mutation in the router —
        // it does not eliminate it. Without the assert the delete is fully
        // unconditional, and a write landing before it is destroyed while the
        // report calls the undo clean (found by both review passes).
        await deps.assertContentMatches(vault, filePath, current.contentSha256);
        await deps.deleteFile(vault, filePath);
      }
      results.push(entry);
    } catch (err) {
      // The salvage entry STAYS. A thrown write is not proof that nothing was
      // written — the server may have committed and lost the response — and an
      // extra copy costs nothing next to a lost one.
      results.push({ ...entry, status: 'restore-failed', error: err.message });
    }
  }
  return { results: results.reverse(), salvage }; // report in step order, not undo order
}

/**
 * Close a journal. Deleting it is the normal end; if the delete fails the record
 * MUST still be stamped terminal, because a `pending` journal left on disk is a
 * live recovery instruction — replaying it would undo the very operation that
 * just succeeded (reproduced during the C2 review). Only when both fail is there
 * something the user has to know about.
 */
async function closeJournal(deps, vault, journalPath, journal, finalState) {
  try {
    await deps.deleteFile(vault, journalPath);
    return null;
  } catch (deleteErr) {
    try {
      const closed = { ...journal, state: finalState, closedAt: deps.now() };
      await deps.writeFile(vault, journalPath, `${JSON.stringify(closed, null, 2)}\n`);
      return (
        `The bundle finished, but its journal at ${journalPath} could not be deleted (${deleteErr.message}). ` +
        `It has been stamped "${finalState}" instead, so a later recover can no longer replay it. Remove the ` +
        `file when convenient.`
      );
    } catch (stampErr) {
      return {
        unsafe: true,
        message:
          `DANGER: the bundle finished, but its journal at ${journalPath} could neither be deleted ` +
          `(${deleteErr.message}) nor stamped terminal (${stampErr.message}). It still reads as "pending", ` +
          `so write_bundle recover would try to UNDO this operation. Delete that file by hand before ` +
          `running any recovery.`,
      };
    }
  }
}

/**
 * Persist the journal after a non-clean outcome.
 *
 * The state stays `pending` on purpose: an operation that did NOT reach a proven
 * clean end is exactly the one a human may still want to replay, and every
 * message that names `recover` would otherwise point at a journal `recover`
 * refuses. `lastOutcome` records what happened without closing the record.
 *
 * `salvage` is MERGED, never replaced — a second partial recovery must not erase
 * the copy the first one made. `backups` may be pruned to what is still
 * outstanding, so a later recovery cannot restore a path that was already put
 * back (and possibly edited since).
 */
async function retainJournal(deps, vault, journalPath, journal, lastOutcome, salvage, { backups } = {}) {
  const keep = { ...journal, state: JOURNAL_PENDING, lastOutcome, closedAt: deps.now() };
  const merged = { ...(journal.salvage || {}), ...(salvage || {}) };
  if (Object.keys(merged).length) keep.salvage = merged;
  else delete keep.salvage;
  if (backups) keep.backups = backups;
  try {
    await deps.writeFile(vault, journalPath, `${JSON.stringify(keep, null, 2)}\n`);
    return null;
  } catch (err) {
    return `The journal at ${journalPath} could not be updated with the rollback outcome (${err.message}); it still holds the pre-bundle content of every target.`;
  }
}

export async function writeBundleTool(registry, args = {}, _deps = {}) {
  const deps = resolveDeps(_deps);
  const vault = registry.resolveVault(args.vault);

  // The `recover` union does not survive every MCP client intact (a boolean can
  // arrive as the string "true"), so normalise it once, here, before anything
  // branches on it.
  const recoverArg = normalizeRecoverArg(args.recover);
  if (recoverArg !== false) {
    return recover(vault, { ...args, recover: recoverArg }, deps);
  }

  // ---- Pre-flight. Everything that can refuse, refuses HERE — before the
  // first byte is written. A throw from this section means the vault is
  // untouched, which is what makes "all-or-nothing" more than a hope.
  const steps = validateSteps(args.steps);
  if (args.approvedPlanSha256 !== undefined && !isPlanSeal(args.approvedPlanSha256)) {
    throw new PlanDriftError(
      'Invalid approvedPlanSha256: expected a 64-char lowercase hex plan seal (the value write_bundle ' +
        'returned with preview:true).',
      { op: BUNDLE_SEAL_OP, provided: String(args.approvedPlanSha256) },
    );
  }

  const paths = uniquePaths(steps);
  const backups = new Map();
  for (const filePath of paths) {
    let state;
    try {
      state = await probePath(deps.getFileContent, vault, filePath);
    } catch (err) {
      // Fail closed: a target we cannot read is a target we cannot restore, and
      // a bundle that cannot roll back must not start.
      throw new BundleError(
        `Cannot capture a backup of "${filePath}" in vault "${vault.name}": ${err.message}. Refusing to ` +
          `start the bundle — a file that cannot be read cannot be rolled back.`,
        { kind: err && err.kind ? err.kind : 'validation' },
      );
    }
    backups.set(filePath, {
      existed: state.exists,
      content: state.content,
      contentSha256: state.contentSha256,
    });
  }

  const bytes = backupBytes(backups);
  if (bytes > MAX_BACKUP_BYTES) {
    throw new BundleError(
      `The bundle's targets hold ${bytes} bytes, over the ${MAX_BACKUP_BYTES}-byte backup limit. Every ` +
        `before-image is kept in memory and written to the journal; split the operation into smaller bundles.`,
    );
  }

  // C1, applied to the whole group: every declared precondition is checked
  // against the before-images. One stale target refuses the ENTIRE bundle — but
  // a PREVIEW reports them instead of throwing, because a preview whose job is
  // to describe reality should describe this part of it too.
  const stale = [];
  for (const step of steps) {
    const { ifMatch } = step.args;
    if (ifMatch === undefined) continue;
    if (!isContentSha256(ifMatch)) {
      throw new BundleError(
        `steps[${step.index}].ifMatch is not a 64-char lowercase hex content hash (the contentSha256 ` +
          `field from get_file).`,
      );
    }
    const before = backups.get(step.path);
    if (!before.existed) {
      stale.push({
        index: step.index,
        path: step.path,
        reason: 'target-missing',
        message:
          `steps[${step.index}] expects "${step.path}" to hold specific content, but the file no longer ` +
          `exists (deleted or moved since you read it).`,
      });
    } else if (before.contentSha256 !== ifMatch) {
      stale.push({
        index: step.index,
        path: step.path,
        reason: 'content-changed',
        expected: ifMatch,
        actual: before.contentSha256,
        message:
          `steps[${step.index}] expects "${step.path}" to still hash to ${ifMatch}, but it now hashes to ` +
          `${before.contentSha256} — someone changed it since you read it.`,
      });
    }
  }
  if (stale.length && args.preview !== true) {
    throw new BundleError(
      `Bundle refused: ${stale[0].message} NOTHING was written: re-read the file, rebuild the bundle on ` +
        `the current content, and retry.`,
      { kind: 'conflict', status: 409, staleSteps: stale },
    );
  }

  // C3 sealed preview over the whole group.
  const plan = buildBundlePlan(steps, backups);
  const identity = vaultIdentity(vault);
  if (args.preview === true) {
    const seal = computePlanSeal({ op: BUNDLE_SEAL_OP, identity, plan });
    return ({
      vault: vault.name,
      preview: true,
      steps: plan.steps,
      targets: plan.targets,
      backupBytes: bytes,
      approvedPlanSha256: seal,
      ...(stale.length ? { stalePreconditions: stale, willRefuse: true } : {}),
      message: stale.length
        ? `This bundle would be REFUSED as it stands: ${stale.length} step(s) carry an ifMatch that no ` +
          `longer matches the file. Re-read those files and rebuild the bundle before applying.`
        : `Ready to run ${steps.length} step(s) over ${paths.length} file(s). To proceed, call again with ` +
          `approvedPlanSha256:"${seal}" — the bundle is refused if any of those files changes before then.`,
    });
  }
  if (args.approvedPlanSha256 !== undefined) {
    verifyPlanSeal({
      op: BUNDLE_SEAL_OP,
      identity,
      plan,
      approvedPlanSha256: args.approvedPlanSha256,
      previewHint: 'call write_bundle with preview:true',
    });
  }

  // ---- Journal. Persisted BEFORE the first mutation, so the before-images
  // outlive the process that captured them. If it cannot be written, the bundle
  // does not start: an unjournaled bundle is just a loop of writes.
  const operationId = newOperationId(deps.randomHex);
  const journalPath = journalPathFor(operationId);
  const journal = buildJournal({
    operationId,
    vaultName: vault.name,
    startedAt: deps.now(),
    steps,
    backups,
  });
  try {
    await deps.writeFile(vault, journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
      applyIfContentPreexists: false,
    });
  } catch (err) {
    throw new BundleError(
      `Could not persist the rollback journal at ${journalPath} in vault "${vault.name}": ${err.message}. ` +
        `Refusing to start — without a journal a crash mid-bundle could not be undone. Nothing was written.`,
      { kind: err && err.kind ? err.kind : 'validation' },
    );
  }

  // ---- Apply.
  const lastState = new Map();
  const touched = [];
  const stepResults = [];
  const warnings = [];
  let failure = null;

  for (const step of steps) {
    if (failure) {
      stepResults.push({ index: step.index, op: step.op, path: step.path, status: 'not-run' });
      continue;
    }

    // A path this bundle already PROVED someone else is writing is off limits
    // for the rest of the operation — the warning emitted at detection time says
    // exactly that, and running another step on it would produce a fresh
    // post-image that launders their content back into "ours". Treat it as a
    // step failure so the bundle stops and unwinds (leaving that path alone).
    const known = lastState.get(step.path);
    if (known && known.foreign) {
      const why =
        `"${step.path}" was changed by something other than this bundle while it was running, so this ` +
        `step was not attempted — the bundle will not write over a file it has proven it does not own.`;
      failure = { index: step.index, op: step.op, path: step.path, error: new BundleError(why, { kind: 'conflict', status: 409 }) };
      stepResults.push({ index: step.index, op: step.op, path: step.path, status: 'failed', error: why });
      continue;
    }

    let result;
    try {
      result = await deps.executors[step.op](registry, {
        ...step.args,
        vault: vault.name,
        path: step.path,
      });
    } catch (err) {
      // The last thing that happened to this path is an operation we never saw
      // finish. Drop any earlier post-image so the rollback cannot mistake a
      // partial write of OURS for a third party's edit (and vice versa).
      if (!touched.includes(step.path)) touched.push(step.path);
      lastState.delete(step.path);
      failure = { index: step.index, op: step.op, path: step.path, error: err };
      stepResults.push({ index: step.index, op: step.op, path: step.path, status: 'failed', error: err.message });
      continue;
    }

    const partial = RESULT_FAILURE_PROBES[step.op] ? RESULT_FAILURE_PROBES[step.op](result) : null;
    if (partial) {
      if (!touched.includes(step.path)) touched.push(step.path);
      lastState.delete(step.path);
      failure = { index: step.index, op: step.op, path: step.path, error: new BundleError(partial) };
      stepResults.push({ index: step.index, op: step.op, path: step.path, status: 'failed', error: partial });
      continue;
    }

    const skipReason = RESULT_SKIP_PROBES[step.op] ? RESULT_SKIP_PROBES[step.op](result) : null;
    stepResults.push({
      index: step.index,
      op: step.op,
      path: step.path,
      status: skipReason ? 'skipped' : 'ok',
      ...(skipReason ? { skippedReason: skipReason } : {}),
      result,
    });

    // A step that changed NOTHING must not produce a post-image, and must not
    // make the path a rollback target on its own. Reading the file back after a
    // no-op would adopt whatever happens to be there — including a third party's
    // edit — as the bundle's own work, and the rollback would then restore over
    // it. A no-op leaves the path exactly as the previous step (if any) left it.
    if (skipReason) continue;
    if (!touched.includes(step.path)) touched.push(step.path);

    // Post-image. `write` and `delete` are DERIVED — the bundle knows the exact
    // bytes it sent, or that the file is gone — so a read-back that disagrees is
    // proof someone else wrote in between, and the path is marked foreign so the
    // rollback leaves it alone. The other ops are computed by Obsidian's own
    // engines, so the read-back is the only post-image available and carries the
    // weaker `observed` grade (see the helper's ATTRIBUTION note).
    const derived = derivePostImage(step.op, step.args);
    try {
      const after = await probePath(deps.getFileContent, vault, step.path);
      if (derived) {
        const matches = derived.exists === after.exists && derived.contentSha256 === after.contentSha256;
        if (matches) {
          lastState.set(step.path, { ...derived, source: 'derived' });
        } else {
          lastState.set(step.path, { foreign: true });
          warnings.push(
            `"${step.path}" does not hold what step ${step.index + 1} wrote — something else wrote to it ` +
              `while this bundle was running. The bundle will not touch that file again, including during ` +
              `a rollback.`,
          );
        }
      } else {
        lastState.set(step.path, { exists: after.exists, contentSha256: after.contentSha256, source: 'observed' });
      }
    } catch (err) {
      // Could not confirm — treat as unattributable rather than guess, and say
      // so: on the success path this is the only sign that a target's final
      // state was never verified.
      lastState.delete(step.path);
      warnings.push(
        `Could not read "${step.path}" back after step ${step.index + 1} (${err.message}), so its final ` +
          `state was not verified. The step itself reported success.`,
      );
    }
  }

  // Build through a Map: keyed by vault path, and a file named exactly
  // `__proto__` would otherwise lose its link on a plain `{}` — the
  // click-to-open walker carried the same bug. See `decision-lint
  // .countByStatus` for why this is a Map rather than `Object.create(null)`.
  const linkPairs = new Map();
  // ONE port for the whole bundle. There is no port memo since v0.79.0, so
  // resolving per file would read data.json once per entry and — worse — a
  // rewrite mid-loop would split one bundle's links across two ports.
  const insecurePort = resolveInsecurePort(vault);
  for (const p of paths) {
    const url = buildClickToOpenUrl(vault, p, { port: insecurePort });
    if (url) linkPairs.set(p, url);
  }
  const clickToOpenLinks = Object.fromEntries(linkPairs);
  const applied = stepResults.filter((s) => s.status === 'ok').length;
  const skipped = stepResults.filter((s) => s.status === 'skipped').length;

  if (!failure) {
    const journalNote = await closeJournal(deps, vault, journalPath, journal, 'applied');
    const journalUnsafe = Boolean(journalNote && journalNote.unsafe);
    if (journalNote) warnings.push(journalNote.message || journalNote);
    return ({
      vault: vault.name,
      operationId,
      ok: true,
      outcome: 'applied',
      // The steps DID apply — saying otherwise would be false. But a journal
      // that could be neither removed nor closed still reads as a live recovery
      // instruction, and a caller must be able to branch on that without
      // parsing prose.
      ...(journalUnsafe ? { journalUnsafe: true, journalPath } : {}),
      applied,
      ...(skipped ? { skipped } : {}),
      total: steps.length,
      steps: stepResults,
      message: outcomeMessage({ outcome: 'applied', operationId, applied, skipped, total: steps.length }),
      ...(warnings.length ? { warnings } : {}),
      ...(Object.keys(clickToOpenLinks).length ? { clickToOpenLinks } : {}),
    });
  }

  // ---- Roll back. `persistSalvage` writes the copy of any unattributable
  // content into the journal BEFORE it is overwritten; if it cannot, that path
  // is left untouched instead.
  const { results: rollback, salvage } = await rollbackPaths(deps, vault, {
    backups,
    lastState,
    touchedPaths: touched,
    persistSalvage: (soFar) => retainJournal(deps, vault, journalPath, journal, 'rolling-back', soFar),
  });
  const clean = isCleanRollback(rollback);
  const verified = isVerifiedRollback(rollback);
  const outcome = !clean ? 'rolled-back-partial' : verified ? 'rolled-back' : 'rolled-back-unverified';
  const residue = rollback.filter((r) => r.error || !(r.status === 'already-clean' || r.status === 'restored' || r.status === 'removed'));
  const unverified = rollback.filter((r) => r.attribution === 'unverified').map((r) => r.path);

  // A clean, verified undo needs no record; anything else keeps the journal —
  // stamped terminal so a later `recover` cannot replay a decision already made,
  // and carrying whatever an unverified action overwrote.
  const journalNote =
    outcome === 'rolled-back'
      ? await closeJournal(deps, vault, journalPath, journal, 'rolled-back')
      : await retainJournal(deps, vault, journalPath, journal, outcome, salvage);
  const journalUnsafe = Boolean(journalNote && journalNote.unsafe);
  if (journalNote) warnings.push(journalNote.message || journalNote);
  if (unverified.length) {
    warnings.push(
      `Restored without being able to prove this bundle wrote what was there: ${unverified.join(', ')}. ` +
        `The failing step never confirmed a write, so the content could not be attributed. What was ` +
        `overwritten is saved under "salvage" in ${journalPath}.`,
    );
  }

  return ({
    vault: vault.name,
    operationId,
    ok: false,
    outcome,
    applied,
    ...(skipped ? { skipped } : {}),
    total: steps.length,
    failedStep: { index: failure.index, op: failure.op, path: failure.path },
    error: failure.error.message,
    ...classifyError(failure.error),
    steps: stepResults,
    rollback: { clean, verified, paths: rollback },
    ...(outcome === 'rolled-back' && !journalUnsafe ? {} : { journalPath }),
    ...(journalUnsafe ? { journalUnsafe: true } : {}),
    message: outcomeMessage({
      outcome,
      operationId,
      applied,
      skipped,
      total: steps.length,
      failedStep: failure.index,
      residue: residue.map((r) => r.path),
      unverified,
      journalPath,
    }),
    ...(warnings.length ? { warnings } : {}),
    ...(Object.keys(clickToOpenLinks).length ? { clickToOpenLinks } : {}),
  });
}

// ---------------------------------------------------------------------------
// Recovery — what makes the journal worth writing.
// ---------------------------------------------------------------------------

/** Read + parse one journal. `requirePending` guards the run path. */
async function loadJournal(deps, vault, operationId, { requirePending = false } = {}) {
  const journalPath = journalPathFor(operationId);
  let raw;
  try {
    raw = asText(await deps.getFileContent(vault, journalPath));
  } catch (err) {
    if (err && err.kind === 'not_found') {
      throw new BundleError(
        `No write journal for operation "${operationId}" in vault "${vault.name}". Either it never ` +
          `existed, or the bundle finished cleanly and its journal was removed (which is the normal case).`,
      );
    }
    throw err;
  }
  return {
    journalPath,
    journal: parseJournal(raw, journalPath, { expectOperationId: operationId, requirePending }),
  };
}

/** Journal file names present in the vault. */
async function listJournalIds(deps, vault) {
  let listing;
  try {
    listing = await deps.listFilesIn(vault, BUNDLE_JOURNAL_DIR);
  } catch (err) {
    if (err && err.kind === 'not_found') return [];
    throw err;
  }
  const files = Array.isArray(listing) ? listing : Array.isArray(listing?.files) ? listing.files : [];
  return files
    .map((f) => String(f).replace(/\/$/, ''))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter(isOperationId);
}

async function recover(vault, args, deps) {
  // --- List mode: read-only, shows what a recovery would do to each file.
  if (args.recover === true) {
    const ids = await listJournalIds(deps, vault);
    const pending = [];
    for (const id of ids) {
      let loaded;
      try {
        loaded = await loadJournal(deps, vault, id);
      } catch (err) {
        pending.push({ operationId: id, unreadable: true, error: err.message });
        continue;
      }
      const files = [];
      for (const p of Object.keys(loaded.journal.backups)) {
        const before = loaded.journal.backups[p];
        let current;
        try {
          current = await probePath(deps.getFileContent, vault, p);
        } catch (err) {
          files.push({ path: p, state: 'unreadable', error: err.message });
          continue;
        }
        const same = before.existed
          ? current.exists && current.contentSha256 === before.contentSha256
          : !current.exists;
        files.push({
          path: p,
          existedBefore: before.existed,
          existsNow: current.exists,
          matchesBackup: same,
          wouldChange: !same,
        });
      }
      pending.push({
        operationId: id,
        state: loaded.journal.state,
        recoverable: loaded.journal.state === JOURNAL_PENDING,
        startedAt: loaded.journal.startedAt,
        vault: loaded.journal.vault,
        steps: loaded.journal.steps,
        files,
        wouldChange: files.filter((f) => f.wouldChange).length,
      });
    }
    const open = pending.filter((p) => p.recoverable).length;
    return ({
      vault: vault.name,
      recover: 'list',
      journalDir: BUNDLE_JOURNAL_DIR,
      pending,
      message: pending.length
        ? `${pending.length} bundle journal(s) in vault "${vault.name}", ${open} still recoverable. Each ` +
          `file marked wouldChange:true is NOT at its pre-bundle content — but a crashed bundle leaves no ` +
          `record of how far it actually got, so that list mixes files the bundle wrote with files YOU may ` +
          `have edited since. Look at them before running write_bundle with recover:"<operationId>" and ` +
          `confirm:true; pass only:[...] to restore just the ones you recognise as the bundle's.`
        : `No bundle journals in vault "${vault.name}" — every bundle either applied or rolled back cleanly.`,
    });
  }

  // --- Run mode.
  const operationId = args.recover;
  if (!isOperationId(operationId)) {
    throw new BundleError(
      `Invalid recover value ${JSON.stringify(operationId)}: pass true to LIST unfinished journals, or an ` +
        `operationId ("op-" + 16 hex) to replay one.`,
    );
  }
  if (args.confirm !== true) {
    throw new BundleError(
      `Refusing to recover "${operationId}" without confirm:true. A recovery WRITES pre-bundle content ` +
        `over whatever is there now, and — unlike a rollback inside a live bundle — it can prove neither ` +
        `who wrote that content nor which files the crashed bundle actually reached. Run write_bundle with ` +
        `recover:true first and read the per-file verdict.`,
    );
  }

  const { journalPath, journal } = await loadJournal(deps, vault, operationId, { requirePending: true });
  const backups = new Map(Object.entries(journal.backups));
  let paths = Object.keys(journal.backups);
  if (args.only !== undefined) {
    if (!Array.isArray(args.only) || args.only.length === 0) {
      throw new BundleError('The only: argument must be a non-empty array of vault paths taken from the journal listing.');
    }
    const wanted = args.only.map((p) => canonicalVaultPath(p, 'only: entry'));
    const unknown = wanted.filter((p) => !paths.includes(p));
    if (unknown.length) {
      throw new BundleError(
        `Journal ${operationId} holds no backup for: ${unknown.join(', ')}. A recovery can only restore ` +
          `paths the journal recorded.`,
      );
    }
    paths = paths.filter((p) => wanted.includes(p));
  }

  // No post-images survive a crash, so every path a recovery actually CHANGES is
  // unattributable by construction — `planRestore` reports each such restore as
  // `unverified`, and the confirm gate above is what stands in for the evidence
  // we do not have.
  const total = Object.keys(journal.backups).length;
  const { results: rollback, salvage } = await rollbackPaths(deps, vault, {
    backups,
    lastState: new Map(),
    touchedPaths: paths,
    persistSalvage: (soFar) => retainJournal(deps, vault, journalPath, journal, 'recovering', soFar),
  });
  const clean = isCleanRollback(rollback);
  const verified = isVerifiedRollback(rollback);
  const covered = paths.length === total;
  const outcome = !clean ? 'rolled-back-partial' : verified ? 'rolled-back' : 'rolled-back-unverified';

  // The journal may only be dropped when the recovery is complete AND took no
  // unattributable action. A recovery that overwrote content it could not
  // attribute must KEEP the record — that record now holds the only copy of what
  // it overwrote. Otherwise the resolved entries are pruned, so a later recovery
  // cannot restore a path that is already back (and may have been edited since).
  const resolved = new Set(
    rollback
      .filter((r) => r.status === 'already-clean' || r.status === 'restored' || r.status === 'removed')
      .map((r) => r.path),
  );
  const remaining = Object.create(null);
  for (const p of Object.keys(journal.backups)) {
    if (!resolved.has(p)) remaining[p] = journal.backups[p];
  }
  const done = clean && covered && verified && !Object.keys(salvage).length;

  const warnings = [];
  const journalNote = done
    ? await closeJournal(deps, vault, journalPath, journal, 'rolled-back')
    : await retainJournal(deps, vault, journalPath, journal, outcome, salvage, { backups: remaining });
  const journalUnsafe = Boolean(journalNote && journalNote.unsafe);
  if (journalNote) warnings.push(journalNote.message || journalNote);
  if (Object.keys(salvage).length) {
    warnings.push(
      `This recovery overwrote content it could not attribute to the crashed bundle: ` +
        `${Object.keys(salvage).join(', ')}. A copy of exactly what was overwritten is kept under ` +
        `"salvage" in ${journalPath}, which is why that journal was not removed.`,
    );
  }

  return ({
    vault: vault.name,
    operationId,
    recover: 'run',
    ok: clean,
    outcome,
    rollback: { clean, verified, paths: rollback },
    ...(done && !journalUnsafe ? {} : { journalPath }),
    ...(journalUnsafe ? { journalUnsafe: true } : {}),
    message: !clean
      ? `Recovery of bundle ${operationId} is INCOMPLETE. Still not restored: ` +
        `${rollback.filter((r) => !resolved.has(r.path)).map((r) => r.path).join(', ') || '(see rollback.paths)'}. ` +
        `The journal was KEPT at ${journalPath}.`
      : covered
        ? `Recovered bundle ${operationId}: all ${total} recorded file(s) hold the content the bundle read.` +
          (done
            ? ' The journal was removed.'
            : ` The journal was KEPT at ${journalPath} because this recovery overwrote content it could not attribute.`)
        : `Restored ${paths.length} of ${total} file(s) from bundle ${operationId}. The journal was KEPT at ` +
          `${journalPath}, pruned to the ${Object.keys(remaining).length} file(s) still outstanding.`,
    ...(warnings.length ? { warnings } : {}),
  });
}
