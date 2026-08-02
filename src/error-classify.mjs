/**
 * Machine-readable error classification (v0.20.0, MCP standard #4).
 *
 * Maps a thrown error to { errorCategory, isRetryable } so an MCP client / agent
 * can decide whether to retry automatically (a transient infra hiccup — e.g. a
 * WireGuard tunnel drop on a remote vault) versus surface to the user
 * (validation / permission problems a retry can't fix).
 *
 * Driven by the `RestApiError.kind` taxonomy (see src/rest-client.mjs). Internal
 * errors thrown as a plain Error (vault lock / read-only mode / unknown vault)
 * carry no `kind`, so they're recognized by message — all of them are
 * non-retryable, so even the safe `unknown` fallback yields correct retry
 * behavior; the message match only sharpens the category.
 *
 * Categories:
 *   transient  — unreachable / timeout / 5xx     → a retry may succeed
 *   permission — 401 / 403 / Cloudflare Access / read-only / vault lock
 *   validation — 404 / 409 conflict / unknown vault → fix the request
 *   unknown    — anything unclassified (conservative: not retryable)
 */

/**
 * RestApiError.kind → { errorCategory, isRetryable }. Kinds mirror the
 * authoritative list in src/rest-client.mjs (categorizeFetchError /
 * categorizeHttpStatus). Keep in sync if new kinds are added there.
 */
export const KIND_TO_CATEGORY = {
  // transient — worth an automatic retry
  unreachable: { errorCategory: 'transient', isRetryable: true },
  timeout: { errorCategory: 'transient', isRetryable: true },
  server_error: { errorCategory: 'transient', isRetryable: true },
  // permission — auth / authorization; fix creds or the gateway, don't retry
  unauthorized: { errorCategory: 'permission', isRetryable: false },
  forbidden: { errorCategory: 'permission', isRetryable: false },
  cf_access: { errorCategory: 'permission', isRetryable: false },
  // validation — the request itself is wrong
  not_found: { errorCategory: 'validation', isRetryable: false },
  conflict: { errorCategory: 'validation', isRetryable: false },
  // Router-side refusals that never reached the network: a malformed source
  // ledger / write journal, a step list that fails pre-flight, a bound that was
  // exceeded. They carry kind:'validation' explicitly (source-ledger.mjs,
  // write-bundle.mjs) and were previously falling through to `unknown` — same
  // retry verdict, but the category told the caller nothing.
  validation: { errorCategory: 'validation', isRetryable: false },
  // C3 sealed-preview drift (or a malformed approvedPlanSha256): the approved
  // plan no longer matches current state/vault. A retry with the SAME stale seal
  // can never succeed — the caller must re-run the preview. Non-retryable.
  plan_drift: { errorCategory: 'validation', isRetryable: false },
  // fallback
  unknown: { errorCategory: 'unknown', isRetryable: false },
};

const UNKNOWN = KIND_TO_CATEGORY.unknown;

/**
 * Classify a thrown error.
 *
 * @param {unknown} err - the caught error (RestApiError, plain Error, or anything).
 * @returns {{ errorCategory: 'transient'|'permission'|'validation'|'unknown', isRetryable: boolean }}
 */
export function classifyError(err) {
  const kind = err && typeof err === 'object' ? err.kind : undefined;
  if (kind && Object.prototype.hasOwnProperty.call(KIND_TO_CATEGORY, kind)) {
    return KIND_TO_CATEGORY[kind];
  }

  // Internal errors are thrown as a plain Error (no `kind`). Recognize the
  // well-known router messages so they're categorized precisely.
  const msg = err && typeof err === 'object' ? String(err.message || '') : '';
  if (/READONLY mode|read-only|is locked to vault/i.test(msg)) {
    return { errorCategory: 'permission', isRetryable: false };
  }
  if (/Unknown vault|No vault specified|has no API key/i.test(msg)) {
    return { errorCategory: 'validation', isRetryable: false };
  }
  // Malformed precondition tokens (C1 ifMatch / C3 approvedPlanSha256) thrown
  // as a plain Error at the tool layer: the request is wrong, a retry with the
  // same token cannot succeed. (The C3 tools now throw PlanDriftError with
  // kind:'plan_drift' — this match is the safety net for C1's ifMatch sites.)
  if (/^Invalid (ifMatch|approvedPlanSha256)/.test(msg)) {
    return { errorCategory: 'validation', isRetryable: false };
  }
  return UNKNOWN;
}
