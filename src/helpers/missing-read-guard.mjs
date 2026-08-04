/**
 * missing-read-guard — the ONE definition of "did this read fail because the
 * file is genuinely absent, or because something else went wrong?"
 *
 * Five call sites carried their own copy of this decision (the four tools that
 * read `wiki-meta/graph/knowledge-graph.json`, plus `get_wiki_context_pack`'s
 * citation resolver), and the copies drifted into the same defect: a bare
 * `/not.?found/` matches the **NOTFOUND inside ENOTFOUND**, so an unreachable
 * vault was reported as "the file is missing". In the graph tools that meant
 * "rebuild a graph you already have"; in the context pack it meant recording a
 * live citation as a CONFIRMED dead link. C10 fixed only its own copy, which is
 * precisely why this now lives in one place.
 *
 * Two rules, in order:
 *
 *  1. A STRUCTURED `kind` is authoritative — and *present* means authoritative,
 *     not *truthy*: `kind: ''` fails closed rather than re-enabling the
 *     heuristics. The rest-client always sets one, so in production the message
 *     is never consulted at all.
 *  2. Only with no `kind` do we sniff, and narrowly. Every pattern below exists
 *     because a real message needed it, and every exclusion because a real
 *     message was misread:
 *       - a 404 must be INTRODUCED by an HTTP-ish word or FOLLOWED by "not
 *         found" — a bare `404` matched `ECONNREFUSED 127.0.0.1:404`, a port;
 *       - a 404 must not be followed by `.`, `-` or another word character —
 *         that ate the filename `Error 404.md` and the hash `code 404-deadbeef`;
 *       - "not found" alone is not enough (`credential not found in keyring`,
 *         `user not found`), but `file not found` is.
 *
 * Inspecting the error can itself throw (a getter that raises), and this runs
 * inside a `catch` — so a throw here would REPLACE the original failure with a
 * meaningless one. Every access is guarded; on inspection failure the answer is
 * `false`, which lets the real error through untouched.
 *
 * Pure, no I/O. Exported for direct unit testing.
 */

// A 404 introduced by an HTTP-ish word: `HTTP 404`, `HTTP/1.1 404`,
// `status code 404`, `Error 404`, `Response code 404`, `responded with 404`.
// The trailing guard rejects `404.md`, `404-deadbeef`, `4040`.
const CONTEXTUAL_404 =
  /\b(?:http(?:\/\d(?:\.\d)?)?|status(?:\s*code)?|error|response\s*code|responded(?:\s*with)?)\s*:?\s*404(?![\w.-])/i;
// A 404 followed by "not found": `404 Not Found`, `404 (Not Found)`.
const NOTFOUND_404 = /(?:^|[^\w.-])404(?![\w.-])\s*\(?not[-\s]?found/i;
// Filesystem-shaped signals. `file not found` is narrow on purpose: plain
// "not found" belongs to credentials, users and hosts too.
const FS_MISSING = /\benoent\b|no such file|\bfile\s+not[-\s]?found\b/i;

/**
 * @param {unknown} err The error thrown by a read.
 * @returns {boolean} true only when the target is genuinely absent.
 */
export function isMissingReadError(err) {
  try {
    const kind = err == null ? undefined : err.kind;
    if (kind !== undefined && kind !== null) return kind === 'not_found';

    const status = err == null ? undefined : (err.status ?? err.statusCode);
    // Coerced, so a client that reports `status: '404'` as a string is not
    // silently ignored.
    if (status != null && Number(status) === 404) return true;

    const message = String((err && err.message) || '');
    return CONTEXTUAL_404.test(message) || NOTFOUND_404.test(message) || FS_MISSING.test(message);
  } catch {
    // A throwing getter must not become the error the user sees.
    return false;
  }
}

/**
 * The message every graph-reading tool raises when the graph is absent — one
 * wording, so the advice cannot drift between tools either.
 *
 * @param {string} graphPath Vault-relative path of the canonical graph.
 * @returns {Error} carrying `kind: 'validation'` so the MCP layer classifies it
 *   as an actionable refusal rather than an unclassified failure.
 */
export function graphMissingError(graphPath) {
  const err = new Error(
    `No knowledge graph at ${graphPath}. Run build_wiki_graph (the /wiki-graph skill) first.`,
  );
  err.kind = 'validation';
  return err;
}
