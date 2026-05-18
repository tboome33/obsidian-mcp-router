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
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Agentic markers that have semantic meaning to Claude / Claude Code and
// should never appear inside vault content reaching the model verbatim.
// Match the OPENING `<` (with optional `/`) of these tag names — we encode
// just that `<` to break the parse without otherwise mangling the text.
const INJECTION_TAGS = [
  'system-reminder',
  'system',
  'tool_use',
  'tool_call',
  'tool_result',
  'antml:[a-z_-]+', // anthropic markup family (parameter, function_calls, ...)
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
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeResponse(v, opts);
    }
    return out;
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
