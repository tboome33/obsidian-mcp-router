import { deleteFile, assertContentMatches, getFileContent } from '../rest-client.mjs';
import { contentSha256, isContentSha256 } from '../helpers/content-hash.mjs';
import { computePlanSeal, verifyPlanSeal, isPlanSeal, vaultIdentity, canonicalize, PlanDriftError } from '../helpers/plan-seal.mjs';

/**
 * Derive the delete plan from CURRENT vault state: what file, does it still
 * exist, and (for a string file) its content fingerprint. Both the preview and
 * the apply build it with THIS function, so an identical live state yields an
 * identical plan — the basis of the C3 seal. String content is hashed directly
 * (matching get_file's contentSha256); a content-negotiated note+json form (an
 * object, if the read path ever returns one) is fingerprinted over its canonical
 * serialization rather than dropped to null, so the seal still catches a change
 * to a structured note instead of silently allowing its deletion.
 *
 * @param {object} vault resolved vault descriptor
 * @param {string} filePath
 * @param {(v:object,p:string)=>Promise<any>} getFileContentFn injected for tests
 * @returns {Promise<{path:string, exists:boolean, contentSha256:string|null}>}
 */
export async function buildDeletePlan(vault, filePath, getFileContentFn) {
  try {
    const content = await getFileContentFn(vault, filePath);
    return {
      path: filePath,
      exists: true,
      contentSha256: typeof content === 'string' ? contentSha256(content) : contentSha256(canonicalize(content)),
    };
  } catch (err) {
    if (err && err.kind === 'not_found') {
      return { path: filePath, exists: false, contentSha256: null };
    }
    throw err;
  }
}

export async function deleteFileTool(registry, args = {}, deps = {}) {
  const { vault: name, path: filePath, confirm, ifMatch, preview, approvedPlanSha256 } = args;
  const getFileContentFn = deps.getFileContent || getFileContent;
  const deleteFileFn = deps.deleteFile || deleteFile;

  if (!filePath) throw new Error('Missing required argument: path');

  // Validate the precondition tokens' SHAPE before touching the network, so a
  // typo surfaces immediately instead of behaving like "no guard".
  if (ifMatch !== undefined && !isContentSha256(ifMatch)) {
    throw new Error(
      'Invalid ifMatch: expected a 64-char lowercase hex content hash (the contentSha256 field from get_file).',
    );
  }
  // PlanDriftError (not a plain Error) so the malformed-seal refusal carries
  // kind:'plan_drift' and classifies as validation/non-retryable, matching the
  // structured-error contract (Codex verification of v0.61.0).
  if (approvedPlanSha256 !== undefined && !isPlanSeal(approvedPlanSha256)) {
    throw new PlanDriftError(
      'Invalid approvedPlanSha256: expected a 64-char lowercase hex plan seal ' +
        '(the value delete_file returned with preview:true).',
      { op: 'delete', provided: String(approvedPlanSha256) },
    );
  }

  const vault = registry.resolveVault(name);
  const identity = vaultIdentity(vault);

  // Phase 1 — sealed preview (C3). Derive the plan from CURRENT state, seal it,
  // and return it WITHOUT deleting. The caller inspects it and echoes
  // approvedPlanSha256 back on the confirm call; the delete is refused if the
  // file drifts (changes, or is deleted/created) before then.
  if (preview === true) {
    const plan = await buildDeletePlan(vault, filePath, getFileContentFn);
    const seal = computePlanSeal({ op: 'delete', identity, plan });
    return {
      vault: vault.name,
      path: filePath,
      preview: true,
      exists: plan.exists,
      ...(plan.contentSha256 ? { contentSha256: plan.contentSha256 } : {}),
      willDelete: plan.exists,
      approvedPlanSha256: seal,
      message: plan.exists
        ? `Ready to delete "${filePath}". To proceed, call again with confirm:true and ` +
          `approvedPlanSha256:"${seal}". The delete is refused if the file changes before then.`
        : `"${filePath}" does not exist — nothing to delete.`,
    };
  }

  // Phase 2 — apply. Require explicit confirmation to avoid accidental deletes
  // when Claude hallucinates a delete call. (Unchanged guard.)
  if (confirm !== true) {
    throw new Error(
      `Refusing to delete "${filePath}": pass confirm: true to proceed. ` +
        `This guard exists to prevent accidental deletions.`,
    );
  }

  // C3 seal: if the caller approved a preview, refuse the delete when the live
  // plan no longer matches — BEFORE the DELETE. Cross-vault replay (a seal from
  // another vault) and content/existence drift are both caught here.
  if (approvedPlanSha256 !== undefined) {
    const plan = await buildDeletePlan(vault, filePath, getFileContentFn);
    verifyPlanSeal({
      op: 'delete',
      identity,
      plan,
      approvedPlanSha256,
      previewHint: 'call delete_file with preview:true',
    });
  }

  // ifMatch (C1): refuse to delete if the file changed since the caller read it.
  // Independent of the seal — a caller may use either guard or both.
  if (ifMatch !== undefined) {
    await assertContentMatches(vault, filePath, ifMatch);
  }
  await deleteFileFn(vault, filePath);
  return {
    vault: vault.name,
    path: filePath,
    deleted: true,
  };
}
