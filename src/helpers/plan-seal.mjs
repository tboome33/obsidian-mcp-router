/**
 * Sealed preview — "approved_plan_sha256" (C3, borrowed from claude-obsidian v2).
 *
 * The problem C1 (ifMatch) does NOT solve. ifMatch pins ONE file's content:
 * "write B only if the file still hashes to A". But several router operations
 * are TWO-PHASE — a preview call computes a plan, the caller inspects it, then a
 * second call applies it — and the plan spans more than a single file's bytes:
 *   - delete_file: which file, does it still exist, is it still that content;
 *   - provision_vault: the resolved target path, slug, plugin set, warnings
 *     (a slug collision may have appeared since the preview);
 *   - refresh_okf_projections: the whole set of writes/deletes/conflicts derived
 *     from the current tree (a page added, a conflict resolved, since the check).
 * Between the preview and the apply the world can move. Applying the plan the
 * caller APPROVED when the plan that would ACTUALLY run is now different is the
 * exact class of silent damage C3 prevents.
 *
 * The seal. The preview computes a SHA-256 over a canonical serialization of
 * (a) the resolved-vault identity, (b) the operation tag, and (c) the plan —
 * "exactly what will be executed". That digest, `approvedPlanSha256`, travels
 * back to the apply call. The apply RE-derives the plan from CURRENT state,
 * re-computes the seal, and refuses — before any write — if it differs. Identical
 * plan ⇒ identical bytes ⇒ identical seal ⇒ proceed. Any drift ⇒ mismatch ⇒
 * actionable refusal telling the caller to re-run the preview.
 *
 * Bound to the resolved vault (spec §2.17). The identity is folded into the
 * hashed payload, so a preview computed against vault A can never be replayed to
 * confirm an apply against vault B (e.g. the default vault changed, or a
 * different `vault` argument was passed). Cross-vault replay is a mismatch.
 *
 * Opt-in, enforced when provided — same philosophy as C1's ifMatch. A preview
 * always emits `approvedPlanSha256`; an apply that omits it behaves exactly as
 * before (no hard break across the fleet — "généralisation progressive"). An
 * apply that PROVIDES it gets the guard. The two-phase skills thread it through,
 * so in practice the sealed flow always carries it.
 *
 * Reuses `contentSha256` (the C1 helper): the seal is the content hash of the
 * canonical JSON string, so there is one hashing core in the router, pinned by
 * the same known-vector discipline. A fixed domain prefix keeps a plan seal from
 * ever colliding with a raw file-content hash.
 */
import { contentSha256, isContentSha256 } from './content-hash.mjs';

/**
 * Domain separation. Folded into every sealed payload so a plan seal lives in a
 * different hash space than a raw file-content hash — a `contentSha256` value can
 * never be a valid `approvedPlanSha256` for the same bytes, and a future seal
 * grammar can bump the version without colliding with v1 seals.
 */
export const SEAL_DOMAIN = 'obsidian-mcp-router/plan-seal/v1';

/**
 * Deterministic serialization: object keys sorted recursively, array order
 * preserved (order is semantically meaningful in a plan — a list of writes/steps
 * is not a set). The preview and the apply build the plan with the same
 * extractor, so identical logical plans serialize to byte-identical strings
 * regardless of the order the object keys happened to be inserted in.
 *
 * Only JSON-safe values are expected (the plan is plain data). `undefined`
 * object values are dropped by JSON.stringify on BOTH sides — consistent because
 * both sides run the same extractor — so no divergence results.
 *
 * @param {unknown} value
 * @returns {string} canonical JSON
 */
export function canonicalize(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortDeep(v[k]);
        return acc;
      }, {});
  }
  return v;
}

/**
 * The stable identity of a resolved vault, for binding a seal to it. Includes
 * only fields that are the SAME at preview time and apply time (they come from
 * config, not from the wire): the name and the REST base URL. Absent fields are
 * omitted rather than defaulted, so two configs that differ only in base URL
 * still produce distinct identities.
 *
 * @param {object} vault a resolved vault descriptor
 * @returns {object}
 */
export function vaultIdentity(vault) {
  const v = vault || {};
  const id = {};
  if (v.name != null) id.name = String(v.name);
  if (v.baseUrl != null) id.baseUrl = String(v.baseUrl);
  return id;
}

/**
 * Compute the seal for a plan. Pure and deterministic — no clock, no randomness,
 * so the preview and the apply agree and a resume/replay is reproducible.
 *
 * @param {object} params
 * @param {string} params.op        operation tag, e.g. 'delete' | 'provision' |
 *                                   'refresh_okf_projections'. Folded in so a
 *                                   seal for one op can't be replayed as another.
 * @param {object} [params.identity] resolved-vault (or target) identity.
 * @param {unknown} params.plan      exactly what will be executed (plain data).
 * @returns {string} 64-char lowercase hex seal.
 */
export function computePlanSeal({ op, identity = null, plan = null } = {}) {
  if (typeof op !== 'string' || op.length === 0) {
    throw new TypeError('computePlanSeal: `op` must be a non-empty string.');
  }
  const canonical = canonicalize({ domain: SEAL_DOMAIN, op, identity, plan });
  return contentSha256(canonical);
}

/**
 * True when `value` is a well-formed seal (64 lowercase hex chars). Shares the
 * C1 validator — a seal and a content hash are the same shape on the wire.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlanSeal(value) {
  return isContentSha256(value);
}

/**
 * Raised when the apply's freshly-derived plan does not match the approved seal
 * (drift), OR when the supplied seal is malformed. Carries `kind:'plan_drift'`
 * so error-classify maps it to a non-retryable validation error (a retry with
 * the same stale seal can't succeed — the caller must re-preview).
 */
export class PlanDriftError extends Error {
  constructor(message, { op, expected, provided, hint } = {}) {
    super(message);
    this.name = 'PlanDriftError';
    this.kind = 'plan_drift';
    this.status = 409;
    // `!== undefined` (not `!= null`) so an EXPLICIT null `provided` — a caller
    // that supplied a null seal — is preserved rather than silently dropped.
    if (op !== undefined) this.op = op;
    if (expected !== undefined) this.expected = expected;
    if (provided !== undefined) this.provided = provided;
    if (hint !== undefined) this.hint = hint;
  }
}

/**
 * Verify a supplied seal against the current plan. Throws BEFORE the caller does
 * any write; returns the (matching) seal on success.
 *
 * Two failure modes, both refusals:
 *   - malformed seal (not 64-hex): a typo must not silently behave like "no
 *     seal" and let a stale apply through — reject it explicitly;
 *   - drift: the current plan hashes differently than the approved seal.
 *
 * @param {object} params
 * @param {string} params.op
 * @param {object} [params.identity]
 * @param {unknown} params.plan               the plan derived from CURRENT state.
 * @param {string} params.approvedPlanSha256  the seal the caller approved.
 * @param {string} [params.previewHint]       how to obtain a fresh seal, e.g.
 *   "re-run refresh_okf_projections with check:true" — surfaced in the drift
 *   message so the caller knows the remedy.
 * @returns {string} the verified seal (equals approvedPlanSha256).
 */
export function verifyPlanSeal({ op, identity = null, plan = null, approvedPlanSha256, previewHint } = {}) {
  if (!isPlanSeal(approvedPlanSha256)) {
    throw new PlanDriftError(
      `Invalid approvedPlanSha256: expected a 64-char lowercase hex plan seal ` +
        `(the value a preview returned). ${previewHint ? previewHint + '.' : ''}`.trim(),
      { op, provided: approvedPlanSha256 == null ? null : String(approvedPlanSha256) },
    );
  }
  const current = computePlanSeal({ op, identity, plan });
  if (current !== approvedPlanSha256) {
    const remedy = previewHint
      ? `Re-run the preview (${previewHint}) to get a fresh approvedPlanSha256, review it, and pass THAT.`
      : `Re-run the preview to get a fresh approvedPlanSha256 and pass THAT.`;
    throw new PlanDriftError(
      `[${op}] sealed-preview drift: the approved plan no longer matches the current ` +
        `state or vault. The vault changed between the preview and this apply, so the ` +
        `plan you approved is not the plan that would run now. Nothing was written. ${remedy}`,
      { op, expected: current, provided: approvedPlanSha256, hint: remedy },
    );
  }
  return current;
}
