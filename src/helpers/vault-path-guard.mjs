/**
 * THE canonical spelling of a vault path — one definition, used by every tool
 * that puts a caller-supplied path on the wire.
 *
 * This module exists because the guard was written once, for `write_bundle`,
 * and never reached the five single-file write tools. A pen test then walked
 * straight past them: `append_to_file` with `path: "../commands/app:reload/"`
 * reached `POST /commands/app%3Areload` — arbitrary Obsidian command execution
 * — while `write_bundle` refused the identical string. Same shape as the
 * ENOTFOUND bug of v0.70.1: a correct fix that only ever covered its first
 * call site. Hence one module, imported everywhere, and a capability test that
 * fails if a write tool stops calling it.
 *
 * AND THEN IT HAPPENED AGAIN, HERE. The sentence above said "every tool that
 * puts a caller-supplied path on the wire" for five rounds while `get_file`,
 * `get_frontmatter` and `list_files` did exactly that and never called it —
 * `list_files({directory: "../commands"})` reached `GET /commands/`, and
 * `get_file({path: "../../active/"})` read whatever note the GUI had open.
 * A GET is a smaller blast radius than a POST, not a different question, and
 * on a `OBSIDIAN_ROUTER_READONLY` deployment the read tools ARE the surface.
 *
 * The docstring was not merely incomplete: it was a false security claim in
 * shipped code, which is worse than no claim, because it is what a reviewer
 * reads instead of the call sites. Found in round 14 — by a reviewer, in the
 * module written to end this exact failure mode.
 *
 * Two reasons the canonicalisation cannot be skipped:
 *
 *   1. IDENTITY. `a/b.md`, `a//b.md`, `/a.md` and `a.md/` all address the SAME
 *      file, but as raw strings they are four different map keys — so a bundle
 *      would take four separate before-images of one file, and a rollback would
 *      restore it several times from images that contradict each other. Reduced
 *      to one spelling, they collapse into one target. (Reproduced by probe
 *      during the C2 review.)
 *   2. CONTAINMENT. `..` segments survive `encodeURIComponent`, so a path like
 *      `../../x` reaches `/vault/../../x`, and the URL parser collapses the dot
 *      segments BEFORE the request is sent — landing on a sibling route
 *      (`/commands/`, `/active/`, `/periodic/`) rather than on `/vault/`. The
 *      journal parser needs the same guard for a second reason: a recovery
 *      replays paths that came from a file inside the vault, i.e. from a
 *      writable, syncable place.
 *
 * What this deliberately does NOT do: reject NTFS alternate data streams
 * (`note.md:evil`), trailing dot/space, or Windows reserved device names
 * (`CON`, `NUL`, `COM1`). Those stay under the vault root — they are naming
 * hygiene for the backend to enforce, not containment. Written down so the
 * omission reads as a decision rather than an oversight.
 */

import { safeForMessage, isSanitizerClean, NO_TRUNCATION } from './sanitize.mjs';

/**
 * Raised when a caller-supplied path cannot be shown to stay inside the vault.
 * `kind: 'validation'` so `error-classify` reports an actionable refusal rather
 * than `Category: unknown` (the convention established in v0.70.1).
 */
export class VaultPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VaultPathError';
    this.kind = 'validation';
  }
}

/**
 * Echo a REJECTED value safely.
 *
 * A refusal message names the offending path so the caller can fix it — and
 * that path is, by construction, the thing an attacker chose. Interpolating it
 * raw makes the guard itself an injection channel: this module was written to
 * close a containment hole and shipped a fresh instance of the error-channel
 * defect the same release fixed in `heading-patch`, in the digest warning and
 * in `graph-neighbors`. Found in round 9, by a reviewer, in the fixer.
 *
 * `where` gets the same treatment, not just `p`: two of its call sites build the
 * label from a journal path read back out of the vault
 * (`The write journal at ${sourcePath}: backup path`), so the label is no more
 * trusted than the value.
 *
 * Truncated hard: a refusal needs to be recognisable, not complete.
 */
const echo = (v) => safeForMessage(v, 120);

/**
 * A UTF-16 code unit that is half of a surrogate pair with no other half.
 *
 * ONE DEFINITION because two rules need it and they are not the same rule:
 * `canonicalVaultPath` refuses such a path (it cannot address a file), and
 * `isAuditStable` refuses such a value (the journal cannot name it). Written
 * once so a future fix to either cannot leave the other behind — the failure
 * this whole module was created to stop.
 *
 * Both branches are needed: a HIGH surrogate not followed by a low one, and a
 * LOW surrogate not preceded by a high one. A rule with only the first accepts
 * `"\uDC00"` on its own.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** @param {unknown} value @returns {boolean} */
export function hasLoneSurrogate(value) {
  return LONE_SURROGATE.test(String(value));
}

/**
 * @param {unknown} p
 * @param {string} where label used in the refusal
 * @param {(msg: string) => Error} [makeError] override the error type (write_bundle
 *   raises its own `BundleError` so its step-level refusals stay uniform)
 * @returns {string} canonical vault-relative path
 */
export function canonicalVaultPath(p, rawWhere = 'path', makeError = (m) => new VaultPathError(m)) {
  const where = echo(rawWhere);
  if (typeof p !== 'string' || p.trim() === '') {
    throw makeError(`${where} is required (vault-relative path of the file).`);
  }
  // Reject spellings whose containment this canonicaliser cannot reason about.
  // A backslash is not a separator here, so `..\outside.md` would survive as ONE
  // innocent-looking segment — and percent-encoded, land on a server that may
  // well treat it as a separator (Windows does). Same for drive letters, UNC
  // prefixes, and a NUL, which truncates a path in more than one filesystem API.
  if (p.includes('\\')) {
    throw makeError(
      `${where} "${echo(p)}" contains a backslash. Vault paths use "/" only — a backslash is not a separator ` +
        `here, so its containment cannot be verified.`,
    );
  }
  if (p.includes('\0')) {
    throw makeError(`${where} contains a NUL character.`);
  }
  // A PATH THE SANITISER WOULD REWRITE IS NOT A VALID PATH.
  //
  // Defined by DIFFERENCE rather than by a list, and that is the whole point:
  // any hand-written list of forbidden shapes drifts from the sanitiser the
  // moment either side changes, and this session has watched three such lists
  // go stale. Asking "would `sanitizeLabel` alter this?" cannot drift, because
  // it IS the sanitiser answering.
  //
  // Two defects collapse into this one check:
  //
  //   1. IDENTITY. `wrapResult` neutralizes every response at the wire
  //      boundary, so a path containing `<result>` reached the model as
  //      `&lt;result>` — a string that names no file. Replaying it fails, and
  //      for `delete_file` / `write_bundle` the sealed plan no longer matches
  //      its own preview, producing a drift refusal for a drift that never
  //      happened. Sanitising an identity cannot be made correct downstream;
  //      the fix is to ensure identities never need sanitising.
  //   2. AUDIT INTEGRITY. The guard accepted CR and LF, so a path could forge a
  //      whole second attribution line inside `wiki-meta/journal.md`
  //      (`path="a.md"]\n[claude-write by attacker] …`). Canonicalising the
  //      audit path would NOT have fixed that — the newline was legal here.
  //
  // Cost, stated plainly: a handful of pathological but legal POSIX filenames
  // become unusable through this router. A note called `</result>.md` is not a
  // note anyone means to write, and refusing it is cheaper than every consumer
  // downstream having to reason about an identity that is not itself.
  // A PATH IS ONE LINE. Stated separately because the difference check above
  // CANNOT catch this: `sanitizeLabel` deliberately preserves `\n` — a newline
  // is legitimate in CONTENT — so a path carrying one passes through unchanged
  // and looks clean by that measure. The first version of this guard relied on
  // the difference alone and accepted `wiki/a\nforged\n.md`, which is exactly
  // the audit-journal forgery it was written to stop.
  //
  // The lesson is about the shape of the check, not the character: defining a
  // rule as "whatever the sanitiser rewrites" inherits the sanitiser's
  // blind spots along with its coverage.
  //
  // AND THE BLIND SPOT HAS THREE CHARACTERS, NOT ONE. `sanitizeLabel` exempts
  // `\t` for the same reason it exempts `\r\n` — legitimate in CONTENT — so the
  // difference check is blind to the tab as well, and this rule was written
  // naming only the two that had bitten. Swept afterwards: of the 65 C0 + DEL +
  // C1 codepoints, U+0009 was the ONLY one this guard still accepted, in all
  // four positions. Widening to the whole control range buys nothing —
  // `isSanitizerClean` already refuses the other 64.
  //
  // What it costs: zero of the 6 791 files in the real vault fleet carry a tab
  // in their path. What it buys: `formatAuditLine` flattens a tab to a space,
  // so `write_file({ path: "wiki/a\tb.md" })` really did PUT `wiki/a<TAB>b.md`
  // while journalling `path="wiki/a b.md"` — the journal naming a different
  // file, one that may well exist.
  if (/[\r\n\t]/.test(p)) {
    throw makeError(
      `${where} "${echo(p)}" contains a line break or a tab. A vault path is a single line of `
      + `printable text — a newline here would forge additional lines in the audit journal, which `
      + `records writes one per line, and a tab is flattened to a space there, so the journal `
      + `would name a different file than the one written.`,
    );
  }
  if (!isSanitizerClean(p)) {
    throw makeError(
      `${where} "${echo(p)}" contains characters a vault path may not carry — a control byte, `
      + `an escape sequence, or markup shaped like a tool-result tag. Such a path cannot be echoed `
      + `back to you unchanged, so it could not be used to address the file again.`,
    );
  }
  if (/^[a-zA-Z]:/.test(p)) {
    throw makeError(`${where} "${echo(p)}" looks like an absolute filesystem path. Vault paths are relative to the vault root.`);
  }
  // A LONE SURROGATE IS NOT A CHARACTER, and the audit journal cannot tell two
  // of them apart.
  //
  // A JS string is UTF-16 code units, so `wiki/a\uD800.md` and `wiki/a\uD801.md`
  // are distinct strings — and `isSanitizerClean` sees no difference to object
  // to, because neither is a control byte nor markup. But every consumer that
  // leaves the JS heap encodes to UTF-8, where an unpaired surrogate has no
  // encoding at all and becomes U+FFFD. Measured on this branch, 2 048 paths
  // differing ONLY in their surrogate:
  //
  //   accepted by guard         : 2048
  //   distinct JS strings       : 2048
  //   distinct UTF-8 wire bytes : 1        ← the journal line actually appended
  //   collisions ON THE WIRE    : 2047
  //
  // So 2 047 distinct write targets shared one journal line, byte for byte, in
  // the file. This is NOT the truncation-digest hole next door (which the
  // `utf16le` hashing in `escapeAuditPart` closes, and which only bit paths past
  // the 400-character cap): these paths are twelve characters long and never
  // reach a digest. No amount of hashing repairs it, because the collapse
  // happens when the LINE is encoded, downstream of everything this router
  // renders.
  //
  // Refused here rather than mangled downstream for the same reason as the
  // sanitiser-difference rule above: an identity that changes when it is
  // written down is not an identity. Cost measured on the 26 real vault roots —
  // 5 070 files, zero carry an unpaired surrogate, and none can: the REST API
  // addresses notes over UTF-8 JSON, so such a file is unreachable through this
  // router whether the guard refuses it or not.
  if (hasLoneSurrogate(p)) {
    throw makeError(
      `${where} "${echo(p)}" contains an unpaired surrogate code unit. Such a path has no UTF-8 `
      + `encoding — it reaches the vault, and the audit journal, as U+FFFD, so two different paths `
      + `would be recorded as the same file.`,
    );
  }
  const segments = p.split('/').filter((s) => s !== '');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw makeError(
        `${where} "${echo(p)}" contains a "${segment}" segment. Vault paths are relative to the vault root ` +
          `and may not walk outside it.`,
      );
    }
  }
  const canonical = segments.join('/');
  if (canonical === '') {
    throw makeError(`${where} "${echo(p)}" does not name a file.`);
  }
  return canonical;
}

/**
 * Would this value survive being written into the audit journal UNCHANGED?
 *
 * THE ONE SENTENCE TO KEEP: the audit line's injectivity is a property of THIS
 * GUARD, not of `formatAuditLine`. `formatAuditLine` escapes — reversibly, so it
 * preserves whatever distinctions reach it — but the very first thing it does to
 * a part is `safeForMessage`, which is MANY-TO-ONE by design: it normalises
 * U+0085 / U+2028 / U+2029 to `\n` and then flattens `\r\n\t` to a space. Two
 * different inputs go in, one line comes out. Nothing downstream can undo that.
 *
 * Every vault path is safe from it only because `canonicalVaultPath` refuses,
 * upstream, precisely the shapes `safeForMessage` would rewrite. A write field
 * that does NOT go through the guard has no such protection — and one did not.
 *
 * `download_page_assets.outputDir` is an ABSOLUTE filesystem path, so it is
 * checked with `isAbsolute` + the `MD_ALLOWED_PATHS` sandbox and never
 * canonicalised. U+2028 is a legal NTFS filename character. Two calls, two
 * directories really created on disk, one journal line:
 *
 *   "a b" = U+0061 U+0020 U+0062
 *   "a b" = U+0061 U+2028 U+0062        (U+2028, LINE SEPARATOR)
 *   audit sha256 A = 0f979888362a07e7…  audit sha256 B = 0f979888362a07e7…
 *   BYTE-IDENTICAL: true | distinct inputs: true
 *
 * So any tool putting a caller-supplied value in the journal WITHOUT the
 * canonicaliser must ask this question itself. Defined by DIFFERENCE against the
 * real renderer for the same reason the sanitiser-difference rule above is: a
 * hand-written list of collapsing characters drifts from `safeForMessage` the
 * moment either side changes, whereas this IS `safeForMessage` answering.
 *
 * `NO_TRUNCATION`, because the cap is not part of the question: a long value is
 * still distinguishable (`escapeAuditPart` truncates with a 128-bit digest), and
 * applying the 200-character default here would refuse every ordinary deep
 * directory.
 *
 * AND THE DIFFERENCE TEST IS NOT THE WHOLE QUESTION — the same lesson the
 * sanitiser-difference rule above had to learn twice. `safeForMessage` leaves an
 * unpaired surrogate exactly as it found it, so the difference test calls it
 * stable; but the journal line is APPENDED OVER UTF-8, where an unpaired
 * surrogate has no encoding and becomes U+FFFD. Measured: 2 048 values differing
 * only there produced 2 048 distinct JS strings and ONE byte sequence in the
 * file. A predicate defined purely as "would the renderer rewrite this?"
 * inherits the renderer's blind spots, and this is one of them.
 *
 * Cost measured on the 26 real vault roots, 2026-08-06: 0 refusals over 5 070
 * files.
 *
 * THE OTHER CANDIDATE, AND WHY IT IS NOT CALLED HERE. `provision_vault.path` has
 * the identical shape — a caller-supplied absolute path that never meets the
 * canonicaliser — and it is STRUCTURALLY UNREACHABLE, so it is documented rather
 * than patched:
 *
 *   the audit line is written iff `userId` is truthy       (index.mjs)
 *   the tool is refused        iff `gated`  is truthy      (index.mjs)
 *   and both are derived from the same OBSIDIAN_ROUTER_USER_ID
 *
 * …with the refusal raised BEFORE the handler runs and the audit block only
 * AFTER it returns. The two are mutually exclusive by construction. Adding a
 * check there would be an edit no future reader could justify, and the day the
 * gates are decoupled a comment would not notice — so the reasoning is pinned
 * end to end in `tests/audit-middleware-e2e.test.mjs` ("the two gates are one
 * condition"), which reddens if either gate moves.
 *
 * @param {unknown} value
 * @returns {boolean} true when the journal can name this value unambiguously
 */
export function isAuditStable(value) {
  return typeof value === 'string'
    && !hasLoneSurrogate(value)
    && safeForMessage(value, NO_TRUNCATION) === value;
}
