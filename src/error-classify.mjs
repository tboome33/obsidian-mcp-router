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
  // The vaultReach refusal, now that it carries a binding proposal (decision
  // proposition-de-liaison-a-l-acces). Same verdict the message-shape rule
  // below already gave it — permission, not retryable: the vault exists and is
  // configured, this workspace has simply never declared it, and repeating the
  // call changes nothing. The kind is what makes that survive a rewording of
  // the sentence; the message rule stays underneath as the safety net.
  workspace_declaration_required: { errorCategory: 'permission', isRetryable: false },
  // fallback
  unknown: { errorCategory: 'unknown', isRetryable: false },
};

const UNKNOWN = KIND_TO_CATEGORY.unknown;

/**
 * Signatures a YAML parser emits when it refuses a document. Obsidian's Local
 * REST API forwards these verbatim inside an HTTP 500 body, so the only thing
 * separating "the vault is briefly unwell" from "this page's frontmatter is
 * malformed" is the wording. Drawn from js-yaml's own error vocabulary.
 */
// Split in two on purpose. Suppressing a retry is the DANGEROUS direction
// here — it tells the caller to give up on a request that might well have
// succeeded — so a phrase only gets to do that alone if nothing but a YAML
// parser says it. The adversarial review supplied the two counterexamples
// this shape is built to reject: "upstream connection closed: unexpected end
// of the stream" (a transport failure borrowing a generic phrase) and
// "Temporarily unavailable while reading YAMLException.md" (a phrase that is
// merely part of a filename). Neither matches now.
// Phrases a YAML parser uses. On their own these prove nothing — the review
// kept producing 500s that contained one by coincidence: a transport failure
// borrowing a stem ("upstream connection closed: unexpected end of the
// stream"), and a message quoting a FILENAME that happens to read like a
// parser phrase ("…while reading a document separator is expected.md").
// Longer, more specific wording did not fix that; a filename can be anything.
const YAML_PHRASE_RE = new RegExp(
  [
    'Nested mappings are not allowed',
    'can not read a block mapping entry',
    'can not read an implicit mapping pair',
    'incomplete explicit mapping pair',
    'duplicated mapping key',
    'unidentified alias',
    'bad indentation',
    'deficient indentation',
    'unexpected end of the stream',
    'a document separator is expected',
    'within a double quoted scalar',
    'within a single quoted scalar',
    'within a flow collection',
  ].join('|'),
  'i',
);

// …so a phrase NEVER counts alone. What settles it is the position suffix
// Obsidian was measured emitting on 2026-09-14: "Nested mappings are not
// allowed in compact mappings at line 2, column 8". A filename cannot carry
// that, and neither can a connection error.
//
// The compact "(N:N)" spelling js-yaml uses natively is deliberately NOT
// accepted: round 4 showed it is short enough to appear by accident (a
// duration, a retry window). Losing it costs only a MISSED reclassification —
// the error stays `transient` and the caller retries once for nothing. That
// is the safe direction. The unsafe one is telling a caller to abandon a
// request that would have succeeded, and requiring the measured format for
// every phrase closes that off completely.
// Anchored at the END, because that is where both producers put it: the
// measured Obsidian body finished on "…at line 2, column 8", and js-yaml
// appends its position last too. Anchoring is what rules out the remaining
// filename forgery the review kept finding — a 500 reading
// `…while reading "duplicated mapping key at line 2, column 8.md"; retry
// later` carries phrase and position both, but the position sits mid-message
// followed by the rest of the sentence, so it no longer counts.
//
// RESIDUAL RISK, stated rather than hidden: message-substring matching can
// never be airtight. A 500 whose body ENDS with a filename spelled exactly
// like a parser diagnostic would still be misread. Nothing short of
// structured error provenance from the plugin closes that, and the cost if it
// ever happens is bounded — one retry not taken, on a request the caller can
// simply reissue. The opposite error (retrying forever against a malformed
// page) is the one this whole guard exists to stop.
const YAML_POSITION_RE = /at line \d+, column \d+[\s.]*$/i;

function looksLikeYamlParseError(message) {
  return YAML_PHRASE_RE.test(message) && YAML_POSITION_RE.test(message);
}

/**
 * Classify a thrown error.
 *
 * @param {unknown} err - the caught error (RestApiError, plain Error, or anything).
 * @returns {{ errorCategory: 'transient'|'permission'|'validation'|'unknown', isRetryable: boolean }}
 */
export function classifyError(err) {
  const kind = err && typeof err === 'object' ? err.kind : undefined;
  const message = err && typeof err === 'object' ? String(err.message || '') : '';

  // A 500 carrying a YAML parse error is NOT transient, and calling it so is
  // an actively harmful answer: it tells the caller to retry a request that
  // can never succeed until the FILE changes. Measured 2026-09-14 — a
  // patch_file on a page whose frontmatter does not parse came back
  // `server_error` → `transient` / `isRetryable: true`, with
  // "Nested mappings are not allowed in compact mappings at line 2, column 8"
  // in the body. Obsidian is healthy; the data is malformed, which is a
  // validation failure wearing a 5xx. The guard is narrow on purpose: it only
  // reclassifies a 5xx whose message carries a YAML parser's own signature,
  // so a genuinely transient 500 keeps its retry.
  if (kind === 'server_error' && looksLikeYamlParseError(message)) {
    return { errorCategory: 'validation', isRetryable: false };
  }

  if (kind && Object.prototype.hasOwnProperty.call(KIND_TO_CATEGORY, kind)) {
    return KIND_TO_CATEGORY[kind];
  }

  // Internal errors are thrown as a plain Error (no `kind`). Recognize the
  // well-known router messages so they're categorized precisely.
  const msg = message;
  // "not reachable from this workspace" is the vaultReach: "declared" refusal
  // (resolveVault(), lock_vault) — a vault that exists and is correctly
  // configured, but this workspace's own binding/openVaults restricts naming
  // it. Grouped with the other workspace-scoped access restrictions rather
  // than with "Unknown vault" below, which means the vault itself does not
  // exist at all.
  if (/READONLY mode|read-only|is locked to vault|not reachable from this workspace/i.test(msg)) {
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
