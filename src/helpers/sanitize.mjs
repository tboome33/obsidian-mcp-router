/**
 * Sanitize text that comes from untrusted vault content (notes, search
 * matches, frontmatter values) before it flows back through MCP into
 * Claude's context.
 *
 * Borrowed from graphify's `sanitize_label()` pattern (`serve.py:261-264`,
 * threat model F-010): an attacker who controls a document in a corpus we
 * read can otherwise inject ANSI escape sequences, fake log lines, or
 * prompt-injection markup into the model's context via search results /
 * file content / breadcrumbs.
 *
 * Defenses applied (every site):
 *   - Strip ANSI CSI / OSC escape sequences.
 *   - Strip control characters except \n \t \r.
 *
 * Defenses opt-in per call site:
 *   - Length cap (default 16 KiB, override for full-page content).
 *   - Prompt-injection neutralization (encode `<` around known agentic
 *     markers like `<system-reminder>`, `<tool_use>`, `<*>`, etc.
 *     before they reach Claude).
 *
 * The helper is deliberately conservative — we'd rather pass through too
 * much than break legitimate markdown. The neutralization list is the
 * narrow set of tokens that have semantic meaning to the host agent and
 * never legitimately appear in user-authored notes.
 */

const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Control chars except \t (0x09), \n (0x0A), \r (0x0D).
//
// C1 (\x80-\x9F) is stripped too. It was missing, and it matters for the same
// reason C0 does: U+009B is a single-character CSI — an ANSI escape introducer
// that needs no `ESC [`.
//
// The three Unicode LINE BREAKS outside \n\r — U+0085 (NEL, inside the C1
// block), U+2028 and U+2029 — are NORMALIZED to `\n` by LINE_SEPARATORS, not
// deleted. Deleting them JOINED adjacent words ("alpha beta" became
// "alphabeta"), silently changing meaning; the round-3 review caught that the
// first version of this hardening pinned the destructive behaviour as correct.
// Normalization keeps the word boundary while still closing the hole they
// opened: JSON.stringify does not escape them, so raw they could split a
// rendered line exactly as an unescaped `\n` would.
// ORDER MATTERS: NEL sits inside \x7F-\x9F, so it must be rewritten to `\n`
// BEFORE the control strip runs, or the strip eats it first.
const LINE_SEPARATORS = /[\u0085\u2028\u2029]/g;
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Agentic markers that have semantic meaning to Claude / Claude Code and
// should never appear inside vault content reaching the model verbatim.
// Match the OPENING `<` (with optional `/`) of these tag names — we encode
// just that `<` to break the parse without otherwise mangling the text.
//
// IMP-5 (v0.8.12): broadened the blocklist beyond the original v0.8.8
// shipping. The pattern `antml:[a-z_-]+` already covers
// `<parameter>`, `<invoke>`, `<function_calls>`, etc. —
// the Anthropic prefixed family. The new bare-tag additions
// (`function_calls`, `function_results`, `invoke`, `parameter`, `env`,
// `claudeMd`, `currentDate`) cover variants that have appeared in Claude
// Code's system reminders WITHOUT the `antml:` prefix. Better belt-and-
// suspenders than to discover a bypass via a non-prefixed tag.
const INJECTION_TAGS = [
  'system-reminder',
  'system',
  'tool_use',
  'tool_call',
  'tool_result',
  'antml:[a-z_-]+', // anthropic markup family (parameter, function_calls, ...)
  'function_calls',
  'function_results',
  'invoke',
  'parameter',
  'env',
  'claudeMd',
  'currentDate',
  'userEmail',
  'cc-instructions',
  'commands',
  'command-name',
  'command-message',
  'command-args',
  'assistant',
  'user',
];
const INJECTION_RE = new RegExp(
  '<(/?(?:' + INJECTION_TAGS.join('|') + '))',
  'gi',
);

const DEFAULT_LABEL_CAP = 16 * 1024; // 16 KiB for snippets / search matches
const DEFAULT_CONTENT_CAP = 1024 * 1024; // 1 MiB for full-page content

/**
 * Sanitize a short string (path, query, snippet, breadcrumb, frontmatter
 * scalar). Default cap 16 KiB. Returns the input unchanged for non-string
 * values (numbers, booleans, null) so the helper composes safely with
 * `sanitizeResponse()`.
 *
 * @param {*} input
 * @param {object} [opts]
 * @param {number} [opts.maxLen=16384]
 * @param {boolean} [opts.neutralizeInjection=false]
 * @returns {*}
 */
export function sanitizeLabel(input, opts = {}) {
  if (typeof input !== 'string') return input;
  const { maxLen = DEFAULT_LABEL_CAP, neutralizeInjection = false } = opts;

  let out = input;
  out = out.replace(ANSI_CSI, '');
  out = out.replace(ANSI_OSC, '');
  out = out.replace(LINE_SEPARATORS, '\n'); // before CONTROL_CHARS — NEL is C1
  out = out.replace(CONTROL_CHARS, '');

  if (neutralizeInjection) {
    out = out.replace(INJECTION_RE, '&lt;$1');
  }

  if (out.length > maxLen) {
    const head = out.slice(0, maxLen - 64);
    out = head + '\n…[truncated by sanitize: original was ' + input.length + ' chars]';
  }
  return out;
}

/**
 * Sanitize full-page content. Larger cap, injection-neutralization ON by
 * default — content goes straight into Claude's context.
 *
 * @param {*} input
 * @param {object} [opts]
 * @param {number} [opts.maxLen=1048576]
 * @param {boolean} [opts.neutralizeInjection=true]
 * @returns {*}
 */
export function sanitizeContent(input, opts = {}) {
  return sanitizeLabel(input, {
    maxLen: DEFAULT_CONTENT_CAP,
    neutralizeInjection: true,
    ...opts,
  });
}

/**
 * Walk a tool response object and apply `sanitizeLabel` to every string
 * field recursively. Non-strings pass through.
 *
 * Use this for tool responses where every string is short (search results,
 * file lists). For full file content, prefer applying `sanitizeContent` to
 * the specific field directly — `sanitizeResponse` defaults to the label
 * cap which would truncate legitimate large files.
 *
 * @param {*} value
 * @param {object} [opts] - Forwarded to `sanitizeLabel`.
 * @returns {*}
 */
export function sanitizeResponse(value, opts = {}) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeLabel(value, opts);
  if (Array.isArray(value)) return value.map((v) => sanitizeResponse(v, opts));
  if (typeof value === 'object') {
    // `Object.fromEntries` CREATES each own property; a plain `out[k] = v` loop
    // does not, for one key. Assigning to `__proto__` goes through the
    // inherited accessor instead: a primitive value is silently discarded (the
    // key vanishes from the response) and an object value would set the
    // prototype of the object being built rather than a property on it. Either
    // way a sanitiser must not do it — the whole point is that keys here come
    // from vault content. Found via C10's `exempted.byType`, but the bug is
    // generic and C10 was NOT the only response keyed by vault strings: the
    // click-to-open walker keys by vault PATH, `get_frontmatter` returns
    // arbitrary frontmatter keys, and `decision-lint` keeps its own tallies.
    // (The earlier version of this comment claimed C10 was the first such
    // response — an overstatement corrected after an audit found the others.)
    //
    // KEYS go through `sanitizeLabel` too. They come from the same untrusted
    // places as values (frontmatter key names, vault paths), and a key was a
    // clean bypass: a C1 escape introducer or an injection tag in a KEY
    // reached the model verbatim even when the caller explicitly asked for
    // `neutralizeInjection` — caught by the round-2 adversarial review.
    //
    // Keys keep the caller's `neutralizeInjection` but NOT the caller's
    // `maxLen`: that option sizes VALUES (a caller passing `maxLen: 200` means
    // "cap the snippets"), and forwarding it to keys renamed structural fields
    // (`vault`, `path`, …) into their own truncation notices — the round-3
    // review's repro. Keys always use the default label cap, which no sane
    // key approaches.
    //
    // If two keys sanitize to the same string, the LAST one wins (the
    // `Object.fromEntries` duplicate rule, same as JSON parsing); response
    // builders that need a collision policy (like C10's tally, which sums)
    // must merge BEFORE handing the object here.
    const keyOpts = { ...opts, maxLen: DEFAULT_LABEL_CAP };
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [sanitizeLabel(k, keyOpts), sanitizeResponse(v, opts)]),
    );
  }
  return value;
}

// Exposed for unit tests.
export const _internals = {
  ANSI_CSI,
  ANSI_OSC,
  CONTROL_CHARS,
  INJECTION_TAGS,
  DEFAULT_LABEL_CAP,
  DEFAULT_CONTENT_CAP,
};
