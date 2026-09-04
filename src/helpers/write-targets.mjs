/**
 * WHICH FILES DOES THIS CALL REALLY WRITE — one definition, two consumers.
 *
 * The rule used to live in `pickAuditPath` (`src/index.mjs`) alone. Two rounds
 * ago it learned three things the hard way:
 *
 *   - a field the tool's own `inputSchema` does not declare is not an argument,
 *     it is something a caller appended (`request.params.arguments` is validated
 *     by the SDK as an OPEN record, so `additionalProperties: false` stops
 *     nothing at runtime);
 *   - `write_bundle` carries its real targets one level down, in `steps[].path`;
 *   - `execute_template` writes at `targetPath` ONLY when `createFile === true`,
 *     because that is the gate the handler and the bridge both use.
 *
 * And the OTHER consumer never heard about any of it. `pathsTouchedByWrite`
 * (`helpers/projections-refresh.mjs`) kept reading raw arguments, which made one
 * real functional bug and two false positives, all three measured against the
 * scheduler:
 *
 *   write_bundle    steps:[{path:'wiki/a.md'}]      -> []            (no refresh
 *                                                     for the tool that writes
 *                                                     the most files at once)
 *   execute_template targetPath:'wiki/t.md'          -> ['wiki/t.md'] (render-only:
 *                                                     nothing was written)
 *   build_search_index path:'wiki/forged.md'         -> ['wiki/forged.md']
 *                                                     (undeclared field)
 *
 * So the rule moves HERE and both consumers import it. Factored rather than
 * copied, deliberately: two rounds of "propagate the fix" is exactly how the
 * copies drift, and the second copy is always the one nobody re-reads.
 *
 * The two consumers want different SHAPES of the same answer, which is why this
 * returns an ordered list rather than a string:
 *   - the audit journal names the FIRST target (`move_file` audits where the
 *     file ended up, not where it started) and enumerates a bundle;
 *   - the projections scheduler wants EVERY touched path (`move_file` must
 *     refresh the indexes the page left as well as the ones it joined).
 */

/**
 * The argument that names the target, PER TOOL. Order matters for the audit
 * consumer, which takes the first present: `move_file` is audited at its
 * DESTINATION.
 */
export const WRITE_TARGET_FIELDS = {
  move_file: ['to', 'from'],
  download_page_assets: ['outputDir'],
};

/** Tools whose target field is just `path`. */
export const DEFAULT_WRITE_TARGET_FIELDS = ['path'];

/**
 * Tools whose target is not an argument at all — the tool decides it.
 *
 * `writeTargets` returns `[]` for these, and that is a statement about the
 * ARGUMENTS: nothing the caller passed names a target here, so an appended
 * `path` must not become one. The audit journal supplies the real target from
 * its own table (`FIXED_AUDIT_TARGETS`); the projections scheduler wants
 * nothing, because none of these four writes wiki CONTENT — measured:
 * `wiki-meta/{search-index,source-ledger}.json` and
 * `wiki-meta/graph/knowledge-graph.json` are `isWikiContentPath === false`, and
 * `refresh_okf_projections` writes the PROJECTIONS (`wiki/index.md` and the
 * per-directory indexes, `isProjectionPath === true`). Reporting that last one
 * would arm a rewrite loop the day `isProjectionPath` is narrowed, so it is
 * withheld here rather than filtered downstream.
 */
export const FIXED_TARGET_TOOLS = new Set([
  'build_wiki_graph',
  'build_search_index',
  'record_source',
  'refresh_okf_projections',
  // v0.90.0 — register_remote_vault writes ONLY `registry.configPath`, never a
  // caller-named path (the tool has no `path` argument at all). Without this
  // entry the DEFAULT `['path']` field would read a caller-APPENDED `path` —
  // `request.params.arguments` is an open record at runtime — and misattribute
  // a config.json write to a forged vault path in the audit journal.
  'register_remote_vault',
]);

/**
 * Every path this call actually writes, in audit order.
 *
 * @param {string} toolName
 * @param {object} [args] the RAW `request.params.arguments`
 * @param {object} [opts]
 * @param {(toolName: string, field: string) => boolean} [opts.declares]
 *   Optional schema check. When supplied it can only REMOVE fields — the table
 *   above is the rule, and the schema is a second opinion that may veto. The
 *   audit consumer passes the real `inputSchema` lookup; the other consumers do
 *   not: the projections scheduler does not have `TOOLS` in scope (it is
 *   imported BY `index.mjs`, so reaching back for it would close an import
 *   cycle), and the two hooks have no schema at all.
 *
 *   THE SENTENCE THAT USED TO BE HERE WAS FALSE. It said the table is "pinned
 *   against the schemas in `tests/security-invariants.test.mjs`", and no test
 *   mentioned the table — the only occurrences in `tests/` were two comments.
 *   That is the exact shape `vault-path-guard.mjs` documents as worse than no
 *   assertion at all: a reviewer reads the claim instead of the call sites.
 *
 *   What the missing pin was hiding, measured with a new write tool declaring
 *   `destination` and not `path`: containment still refuses it (the guards are
 *   per-tool), but the audit attribution falls silently to `(unknown)` and the
 *   scheduler — which passes no `declares` — happily reads a `path` APPENDED by
 *   the caller. The pin now exists, in the file the sentence always named:
 *   "PIN: WRITE_TARGET_FIELDS names a field each tool's own inputSchema
 *   declares".
 * @returns {string[]}
 */
export function writeTargets(toolName, args = {}, { declares } = {}) {
  if (!args || typeof args !== 'object') return [];

  // Nothing the caller passed names a target for these.
  if (FIXED_TARGET_TOOLS.has(toolName)) return [];

  // `write_bundle` carries its real targets inside `steps[]`.
  if (toolName === 'write_bundle') {
    // A RECOVERY call replays a journal, it does not apply `steps[]` — and the
    // truth test has to be the HANDLER's, not "is this truthy". The dispatcher
    // routes on `normalizeRecoverArg`, which reads `"false"`, `"0"`, `"no"` and
    // `"off"` as an ORDINARY bundle (the field is a boolean|operationId union
    // and a real MCP client was observed sending the string `"true"`). Reading
    // `args.recover` truthily here classified those four calls as recoveries,
    // so their real steps were neither audited nor refreshed.
    if (isRecoveryCall(args.recover)) return [];
    return Array.isArray(args.steps)
      ? args.steps
        .map((s) => (s && typeof s.path === 'string' ? s.path : null))
        .filter(Boolean)
      : [];
  }

  // `execute_template` writes at `targetPath` ONLY when `createFile === true`.
  // Strictly `=== true`, because that is the gate the handler and the bridge
  // both use (`body.createFile === true`); anything looser and this disagrees
  // with the code that does the writing. A render-only call writes nothing, so
  // it has no target — the audit layer names the TEMPLATE instead, which is a
  // display fallback and not a write.
  if (toolName === 'execute_template') {
    return args.createFile === true && typeof args.targetPath === 'string' && args.targetPath
      ? [args.targetPath]
      : [];
  }

  const fields = WRITE_TARGET_FIELDS[toolName] || DEFAULT_WRITE_TARGET_FIELDS;
  const out = [];
  for (const field of fields) {
    if (declares && !declares(toolName, field)) continue;
    const v = args[field];
    if (typeof v === 'string' && v) out.push(v);
  }
  return out;
}

/**
 * Does this `recover` argument mean "replay a journal" to the DISPATCHER?
 *
 * Mirrors `normalizeRecoverArg` (`helpers/write-bundle.mjs`) rather than
 * re-deriving it: the union it normalises is the reason the naive truthiness
 * test was wrong. Kept as a predicate here (not an import) only because this
 * module must stay free of the bundle machinery — the two are pinned equal in
 * `tests/security-invariants.test.mjs`, so they cannot drift silently.
 */
export function isRecoveryCall(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (token === '' || token === 'false' || token === '0' || token === 'no' || token === 'off') {
      return false;
    }
    return true;
  }
  // Anything else reaches the handler and produces an actionable refusal; it is
  // not a bundle apply, so it names no step targets either way.
  return true;
}
