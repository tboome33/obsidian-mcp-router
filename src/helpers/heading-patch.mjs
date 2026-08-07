/**
 * Router-side heading patch engine.
 *
 * Replaces the Local REST API plugin's PATCH Target-Type:heading path, which
 * computes character offsets on LF-normalized content and splices them into
 * the RAW file bytes. On a CRLF file every line above the target shifts the
 * true offset by one byte, so the patch lands short — content inserted in the
 * middle of an unrelated line, or a replace range that starts before the
 * heading and swallows it (real corruption observed 2026-08-02 on a CRLF
 * roadmap page; same failure class as the known "heading containing a slash"
 * bug). This engine never counts character offsets: it works line-by-line on
 * the raw content, so CRLF vs LF, "·", emoji, or slashes in headings cannot
 * desynchronize anything.
 *
 * Semantics (mirrors the documented patch_file contract):
 *  - target = FULL heading ancestry path joined by the delimiter ("A::B::C").
 *    The matched heading's ancestor chain must equal the whole path.
 *  - append  → insert content at the END of the heading's section (its whole
 *              subtree — just before the next heading of same-or-shallower
 *              level, or EOF).
 *  - prepend → insert content right AFTER the heading line.
 *  - replace → replace the section content, KEEPING the heading line.
 *  - createTargetIfMissing → create the missing tail of the heading path
 *    (nested one level deeper per segment, capped at H6) then apply.
 *  - applyIfContentPreexists → skip (applied:false) when the section already
 *    contains the content (idempotency).
 *  - trimTargetWhitespace → drop blank lines at the join boundary (trailing
 *    blanks for append, leading blanks for prepend).
 *
 * Line endings: existing lines are NEVER rewritten (a CRLF file keeps every
 * CRLF byte-for-byte); inserted lines use the file's dominant EOL, so LF
 * content patched into a CRLF file no longer produces mixed endings.
 */

import { safeForMessage } from './sanitize.mjs';

/** Thrown when the heading path cannot be resolved (and creation is off). */
export class HeadingPatchError extends Error {
  constructor(message, { code = 'invalid-target' } = {}) {
    super(message);
    this.name = 'HeadingPatchError';
    this.code = code;
  }
}

/** Dominant EOL of a file: CRLF wins only when it is the majority style. */
export function dominantEol(raw) {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const bare = (raw.match(/(?<!\r)\n/g) || []).length;
  return crlf > bare ? '\r\n' : '\n';
}

/** Split into lines, each KEEPING its own terminator (last may have none). */
function splitLinesKeepEol(raw) {
  return raw.length ? raw.split(/(?<=\n)/) : [];
}

/** A line's text without its terminator. */
function lineText(line) {
  return line.replace(/\r?\n$/, '');
}

const ATX_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Strip a CommonMark closing hash sequence: "## Title ##" → "Title". */
function stripClosingHashes(text) {
  const m = text.match(/^(.*?)[ \t]+#+[ \t]*$/);
  return (m ? m[1] : text).trim();
}

/**
 * Parse ATX headings (fenced code blocks excluded) into
 * [{ line, level, text, path }] where `path` is the full ancestor chain of
 * heading texts, root-first — the shape the target path is matched against.
 */
export function parseHeadings(lines) {
  const headings = [];
  const stack = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lineText(lines[i]);
    if (fence) {
      const close = text.match(CLOSING_FENCE_RE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = text.match(FENCE_RE);
    if (open) {
      fence = open[1];
      continue;
    }
    const m = text.match(ATX_HEADING_RE);
    if (!m) continue;
    const level = m[1].length;
    const htext = stripClosingHashes(m[2]);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: htext });
    headings.push({ line: i, level, text: htext, path: stack.map((h) => h.text) });
  }
  return headings;
}

/** End of a heading's section (exclusive line index): next heading with level <= its own, or EOF. */
function sectionEnd(headings, idx, lineCount) {
  const h = headings[idx];
  for (let j = idx + 1; j < headings.length; j++) {
    if (headings[j].level <= h.level) return headings[j].line;
  }
  return lineCount;
}

/** Content string → array of lines each terminated with `eol`. */
function contentToLines(content, eol) {
  if (content === '') return [];
  const parts = String(content).split(/\r?\n/);
  // A single trailing newline in the content is a terminator, not an extra
  // blank line; deliberate extra blank lines beyond it are preserved.
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => p + eol);
}

function isBlank(line) {
  return lineText(line).trim() === '';
}

/**
 * Apply a heading patch to raw markdown content. Pure — no I/O.
 *
 * @param {string} raw - the file's raw content (line endings preserved as-is)
 * @param {object} opts
 *   @param {"append"|"prepend"|"replace"} opts.operation
 *   @param {string} opts.target - delimiter-joined FULL heading path
 *   @param {string} opts.content
 *   @param {string} [opts.targetDelimiter="::"]
 *   @param {boolean} [opts.createTargetIfMissing=false]
 *   @param {boolean} [opts.applyIfContentPreexists] - true → skip when the
 *     section already contains the content
 *   @param {boolean} [opts.trimTargetWhitespace=false]
 * @returns {{ content: string, applied: boolean, createdTarget: boolean, skippedReason?: string }}
 */
export function applyHeadingPatch(raw, opts) {
  const {
    operation,
    target,
    content,
    targetDelimiter = '::',
    createTargetIfMissing = false,
    applyIfContentPreexists,
    trimTargetWhitespace = false,
  } = opts;

  if (!['append', 'prepend', 'replace'].includes(operation)) {
    throw new HeadingPatchError(`invalid-operation: "${safeForMessage(operation, 80)}"`, { code: 'invalid-operation' });
  }

  // Preserve a leading BOM without letting it hide the first heading.
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? raw.slice(1) : raw;

  const segments = String(target)
    .split(targetDelimiter)
    .map((s) => s.trim());
  if (!segments.length || segments.some((s) => s === '')) {
    throw new HeadingPatchError(
      `invalid-target: empty segment in heading path "${safeForMessage(target, 200)}" (delimiter "${safeForMessage(targetDelimiter, 40)}")`,
    );
  }

  const eol = dominantEol(body);
  const lines = splitLinesKeepEol(body);
  let headings = parseHeadings(lines);

  const pathEquals = (path, segs) =>
    path.length === segs.length && path.every((t, i) => t === segs[i]);

  let idx = headings.findIndex((h) => pathEquals(h.path, segments));
  let createdTarget = false;

  if (idx === -1 && createTargetIfMissing) {
    // Deepest existing prefix of the path → create the missing tail nested
    // under it (or at EOF when nothing matches).
    let prefixLen = 0;
    let insertAt = lines.length;
    let parentLevel = 0;
    for (let k = segments.length - 1; k >= 1; k--) {
      const pIdx = headings.findIndex((h) => pathEquals(h.path, segments.slice(0, k)));
      if (pIdx !== -1) {
        prefixLen = k;
        insertAt = sectionEnd(headings, pIdx, lines.length);
        parentLevel = headings[pIdx].level;
        break;
      }
    }
    const created = [];
    // One blank separator when gluing after existing non-blank content.
    if (insertAt > 0 && !isBlank(lines[insertAt - 1])) created.push(eol);
    for (let i = prefixLen; i < segments.length; i++) {
      const level = Math.min(parentLevel + (i - prefixLen + 1), 6);
      created.push('#'.repeat(level) + ' ' + segments[i] + eol);
    }
    ensureTrailingEol(lines, insertAt - 1, eol);
    lines.splice(insertAt, 0, ...created);
    headings = parseHeadings(lines);
    idx = headings.findIndex((h) => pathEquals(h.path, segments));
    createdTarget = true;
  }

  if (idx === -1) {
    // Heading text is VAULT CONTENT, and an error message is the one channel
    // that bypasses `sanitizeResponse` entirely: the message is re-wrapped
    // verbatim by rest-client and rendered as `Error: ${err.message}` straight
    // into the model's context. A pen test walked a live ANSI escape and a
    // forged tool-result block through here from an ordinary H1. Sanitise at
    // the point of construction, and cap each heading so a long title cannot
    // crowd out the actionable part of the refusal.
    //
    // ROUND 10: the fix above reached the heading LIST and left the two other
    // untrusted values in the SAME message raw — `segments.join(delimiter)` is
    // the caller's `target`, and `targetDelimiter` is echoed three times in the
    // example text. Both carried a forged `</result><result>` wrapper AND a
    // live ESC through. Ten rounds in, in the first file this release fixed:
    // the defect is never the sanitiser, it is always the call site nobody
    // enumerated. Hence: sanitise the whole message's inputs, not the one a
    // reviewer happened to name.
    const roots = headings
      .filter((h) => h.path.length === 1)
      .map((h) => `"${safeForMessage(h.text, 120)}"`)
      .slice(0, 8);
    const delim = safeForMessage(targetDelimiter, 40);
    throw new HeadingPatchError(
      `invalid-target: heading path "${safeForMessage(segments.join(targetDelimiter), 200)}" not found. ` +
        `The target must be the FULL ancestry path joined by "${delim}" ` +
        `(e.g. "H1${delim}H2${delim}H3"), not the leaf heading alone. ` +
        (roots.length ? `Top-level headings in this file: ${roots.join(', ')}.` : 'This file has no headings.'),
    );
  }

  const h = headings[idx];
  let end = sectionEnd(headings, idx, lines.length);

  // Idempotency: skip when the section already carries this exact content.
  if (applyIfContentPreexists === true) {
    const sectionNorm = lines
      .slice(h.line + 1, end)
      .map((l) => l.replace(/\r\n$/, '\n'))
      .join('');
    const contentNorm = String(content).replace(/\r\n/g, '\n').trim();
    if (contentNorm !== '' && sectionNorm.includes(contentNorm)) {
      return {
        content: raw,
        applied: false,
        createdTarget,
        skippedReason: 'content-preexists',
      };
    }
  }

  const insert = contentToLines(content, eol);

  if (operation === 'replace') {
    if (insert.length) ensureTrailingEol(lines, h.line, eol);
    lines.splice(h.line + 1, end - (h.line + 1), ...insert);
  } else if (operation === 'prepend') {
    let at = h.line + 1;
    if (trimTargetWhitespace) {
      let drop = 0;
      while (at + drop < end && isBlank(lines[at + drop])) drop++;
      lines.splice(at, drop);
      end -= drop;
    }
    if (insert.length) ensureTrailingEol(lines, at - 1, eol);
    lines.splice(at, 0, ...insert);
  } else {
    // append — at the very end of the section, just before the next heading.
    if (trimTargetWhitespace) {
      let drop = 0;
      while (end - 1 - drop > h.line && isBlank(lines[end - 1 - drop])) drop++;
      lines.splice(end - drop, drop);
      end -= drop;
    }
    if (insert.length) ensureTrailingEol(lines, end - 1, eol);
    lines.splice(end, 0, ...insert);
  }

  return { content: bom + lines.join(''), applied: true, createdTarget };
}

/** Give line `idx` a terminator if it lacks one (something follows it now). */
function ensureTrailingEol(lines, idx, eol) {
  if (idx >= 0 && idx < lines.length && !lines[idx].endsWith('\n')) {
    lines[idx] += eol;
  }
}
