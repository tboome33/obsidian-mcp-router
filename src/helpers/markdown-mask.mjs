/**
 * markdown-mask — blank out the regions of a markdown document where a
 * syntax-looking string is NOT that syntax: fenced code, inline code spans, and
 * HTML comments.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SHARED AND NOT COPIED
 * ---------------------------------------------------------------------------
 * Two features need it for opposite reasons — `get_wiki_context_pack` must not
 * report a `[[link]]` shown as an EXAMPLE as an authoritative graph edge, and
 * the citation formatter must not rewrite a `[text](url)` that is being
 * displayed as code. A second hand-rolled copy of "which backticks close which"
 * is exactly the class of defect this repo has had to sweep three times: a rule
 * fixed in one place and left wrong in the other.
 *
 * ---------------------------------------------------------------------------
 * THE DELIMITERS ARE COUNTED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * CommonMark allows a fence of N ≥ 3 backticks (or tildes), and a
 * four-backtick fence legitimately CONTAINS a triple one; an inline span opened
 * with N backticks closes only on N. Matching exactly ``` and exactly ` — the
 * obvious first version, and the one adversarial review caught — leaks both
 * shapes, `` `[[ghost]]` `` being the smallest case.
 *
 * ---------------------------------------------------------------------------
 * LENGTH IS PRESERVED, WHICH IS THE POINT
 * ---------------------------------------------------------------------------
 * Masked regions become spaces of the same length, and newlines are kept. A
 * caller can therefore run its regex over the MASK and use the offsets it finds
 * to cut the ORIGINAL — no index arithmetic, no second pass, and the mask is
 * never what gets emitted.
 */

/**
 * ---------------------------------------------------------------------------
 * SCANNED, NOT MATCHED — AND THE MEASUREMENT IS WHY
 * ---------------------------------------------------------------------------
 * The obvious implementation is three regexes, and the first version was. Two
 * of them are QUADRATIC, measured: a document of N backticks took 2.3 ms at
 * N=2000, 35.5 ms at 8000 and **582 ms at 32000** — a 4× input costing 15×,
 * then 16× costing 253×. The shape is inherent: a back-referenced closing run
 * (`` /(`+)…\1/ ``) restarts its forward search at every opener, and so does an
 * unmatched fence. This runs on EVERY page body of every `get_wiki_context_pack`
 * call, with no per-file byte cap — the exact hot path whose bracket-bomb twin
 * this repo already had to fix once (v0.71.0), and whose standing guard caught
 * the citation regex next door on its first run.
 *
 * The scanner below visits each character a bounded number of times: backtick
 * and tilde runs are found once, then matched opener→closer through a per-length
 * queue, so nothing is re-scanned. Measured on the same inputs, 32000 backticks
 * costs under a millisecond.
 */

/** Every maximal run of `ch` in `text`, as `{start, len}`, left to right. */
function runsOf(text, ch) {
  const runs = [];
  for (let i = 0; i < text.length;) {
    if (text[i] !== ch) { i += 1; continue; }
    const start = i;
    while (i < text.length && text[i] === ch) i += 1;
    runs.push({ start, len: i - start });
  }
  return runs;
}

/**
 * ---------------------------------------------------------------------------
 * ORDER MATTERS BETWEEN THE THREE CONSTRUCTS, AND THREE INDEPENDENT PASSES GET
 * IT WRONG
 * ---------------------------------------------------------------------------
 * The first version masked fences, then comments, then spans, each ignoring the
 * others. Adversarial review produced four inputs where that misfires, all with
 * the same consequence — a REAL link disappearing because something inside code
 * opened a construct outside it:
 *
 *   - a `<!--` DISPLAYED inside a fence starting a "comment" that ran past it;
 *   - a fence marker inside a comment opening an unterminated fence;
 *   - a backtick inside a comment pairing with a later one in prose;
 *   - an inline opener before a fenced block pairing with a run after it.
 *
 * So: BLOCK STRUCTURE IS RESOLVED FIRST and everything else is confined by it.
 * A fence opener must begin its line's content (after at most three spaces, per
 * CommonMark), which is what stops `<!-- ``` -->` from being read as a fence at
 * all. Comments and code spans are then found in ONE left-to-right scan of what
 * is left, and neither may start inside a block or cross one.
 *
 * WHAT IT STILL DOES NOT DO, stated rather than implied: this is a masker for
 * captured pages and wiki notes, not a CommonMark implementation. Link
 * reference definitions, HTML blocks, and lists that change the indented-code
 * rule are not modelled. Every gap costs at most a missed mask — a construct
 * read as prose — never a rewrite of real code.
 */

/**
 * @param {string} text
 * @param {{fences?: boolean, inline?: boolean, comments?: boolean, indented?: boolean}} [what]
 *   Which regions to blank. All true by default.
 * @returns {string} the same length as `text`, with those regions blanked.
 */
export function maskCodeAndComments(text, what = {}) {
  if (typeof text !== 'string' || text === '') return '';
  const { fences = true, inline = true, comments = true, indented = true } = what;
  const n = text.length;
  const isEol = (ch) => ch === '\n' || ch === '\r';
  // One flag per position, applied in a single pass at the end. Line endings —
  // BOTH `\n` and `\r`, so a CRLF document keeps its line boundaries — are never
  // blanked, which is what keeps offsets and line numbers usable.
  const hide = new Uint8Array(n);
  const block = new Uint8Array(n); // fenced or indented code: off-limits below
  const hideRange = (from, to, isBlock) => {
    for (let i = Math.max(0, from); i < Math.min(n, to); i += 1) {
      if (!isEol(text[i])) hide[i] = 1;
      if (isBlock) block[i] = 1;
    }
  };

  // ---- 1. Block structure, line by line -----------------------------------
  let open = null; // { ch, len }
  let prevBlank = true; // an indented code block needs a blank line before it
  let inIndented = false;
  let lineStart = 0;
  while (lineStart <= n) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = n;
    // Trim a CR so a CRLF document measures its content like an LF one.
    const contentEnd = lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;

    let i = lineStart;
    let indent = 0;
    while (i < contentEnd && (text[i] === ' ' || text[i] === '\t')) {
      indent += text[i] === '\t' ? 4 : 1;
      i += 1;
    }
    const blank = i >= contentEnd;
    const ch = text[i];
    let len = 0;
    if (ch === '`' || ch === '~') while (i + len < contentEnd && text[i + len] === ch) len += 1;
    // CommonMark allows at most three spaces before a fence; more is an
    // indented code line. Honouring unlimited indent let a four-space-indented
    // line close a real fence early, or open one that swallowed a live link.
    const fenceHere = fences && len >= 3 && indent <= 3
      // A backtick fence's info string may not itself contain a backtick.
      && (ch === '~' || !text.slice(i + len, contentEnd).includes('`'));

    if (open) {
      hideRange(lineStart, contentEnd, true);
      if (fenceHere && ch === open.ch && len >= open.len
        && text.slice(i + len, contentEnd).trim() === '') {
        open = null;
      }
    } else if (fenceHere) {
      open = { ch, len };
      hideRange(lineStart, contentEnd, true);
    } else if (indented && !blank && indent >= 4 && (prevBlank || inIndented)) {
      // An indented code block: four spaces, opened after a blank line and
      // continuing until a non-indented, non-blank line. Without this, a
      // `[[link]]` shown as an indented example became an authoritative edge.
      inIndented = true;
      hideRange(lineStart, contentEnd, true);
    } else if (!blank) {
      inIndented = false;
    }
    if (!open && !blank && indent < 4) inIndented = false;
    prevBlank = blank;

    if (lineEnd >= n) break;
    lineStart = lineEnd + 1;
  }

  // ---- 2. Comments and code spans, ONE ordered scan of what is left --------
  // Neither may begin inside a block. A span may not CROSS one either, which is
  // checked with a prefix count so the whole pass stays linear.
  const blockPrefix = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) blockPrefix[i + 1] = blockPrefix[i] + block[i];
  const crossesBlock = (from, to) => blockPrefix[Math.min(n, to)] - blockPrefix[Math.max(0, from)] > 0;

  // Backtick runs OUTSIDE any block, indexed per length so each is looked at
  // once as an opener and once as a closer — the property that keeps this O(n).
  const runs = inline ? runsOf(text, '`').filter((r) => !block[r.start]) : [];
  const byLen = new Map();
  runs.forEach((r, idx) => {
    if (!byLen.has(r.len)) byLen.set(r.len, []);
    byLen.get(r.len).push(idx);
  });
  const cursor = new Map();
  const runAt = new Map();
  runs.forEach((r, idx) => runAt.set(r.start, idx));

  let pos = 0;
  while (pos < n) {
    if (block[pos]) { pos += 1; continue; }
    // A COMMENT WINS AT ITS OWN POSITION. Scanning comments separately, and
    // afterwards, is what let a backtick inside one pair with prose outside it.
    if (comments && text.startsWith('<!--', pos)) {
      const close = text.indexOf('-->', pos + 4);
      let end = close === -1 ? n : close + 3;
      // A comment cannot reach into a block; if one intervenes, the comment is
      // unterminated as far as this document's structure is concerned.
      if (crossesBlock(pos, end)) {
        let k = pos;
        while (k < end && !block[k]) k += 1;
        end = k;
      }
      hideRange(pos, end, false);
      pos = end;
      continue;
    }
    const idx = runAt.get(pos);
    if (inline && idx !== undefined) {
      const { len } = runs[idx];
      const candidates = byLen.get(len) || [];
      let c = cursor.get(len) || 0;
      while (c < candidates.length && candidates[c] <= idx) c += 1;
      let paired = -1;
      // The first closer that does not cross a block. Advancing `c` past the
      // rejects is what keeps this from re-scanning.
      while (c < candidates.length) {
        const j = candidates[c];
        if (!crossesBlock(runs[idx].start, runs[j].start)) { paired = j; break; }
        c += 1;
      }
      cursor.set(len, paired === -1 ? c : c + 1);
      if (paired === -1) { pos += len; continue; } // unmatched opener → literal
      const end = runs[paired].start + runs[paired].len;
      hideRange(runs[idx].start, end, false);
      pos = end;
      continue;
    }
    pos += 1;
  }

  // ---- 3. Apply once ------------------------------------------------------
  let out = '';
  let from = 0;
  for (let i = 0; i < n; i += 1) {
    if (!hide[i]) continue;
    out += text.slice(from, i) + ' ';
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/**
 * THERE IS DELIBERATELY NO `isMasked(mask, index)` HELPER.
 *
 * It is the obvious companion and it cannot be written correctly: a masked
 * position holds a space, and so does an ordinary space in prose, so from the
 * mask alone the two are indistinguishable. Callers must instead RUN THEIR
 * REGEX OVER THE MASK and use the offsets it yields to cut the ORIGINAL — a
 * construct inside code simply never matches, because its characters are no
 * longer there to match. That is why the mask preserves length.
 */
