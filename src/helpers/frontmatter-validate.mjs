/**
 * frontmatter-validate.mjs — telling "no frontmatter" from "unreadable
 * frontmatter", and warning about the second before it reaches disk.
 *
 * THE PROBLEM THIS SOLVES. The router has eight distinct ways to read a
 * frontmatter block, and exactly one of them is a real YAML parser: Obsidian's,
 * reached over REST. The repo itself has NO YAML dependency — the seven
 * in-process readers are line-oriented, splitting on the first `:` and keeping
 * the rest of the line. A block YAML rejects therefore parses cleanly through
 * them. Measured on vault `roland`, 2026-09-14, for the line
 *
 *     title: hermes-delivery — publication des livrables dans H: (as-built)
 *
 * `llms-txt-exporter.parseFrontmatter` returned a result byte-identical to the
 * one it returned for the properly quoted twin — which is how a page Obsidian
 * displayed as "Invalid properties" still carried its correct title into the
 * generated OKF `index.md`, while `get_frontmatter` reported `{}` for it.
 *
 * TWO FUNCTIONS, TWO DIFFERENT EPISTEMIC STATUSES. Keeping them apart is the
 * whole design; merging them would let a guess masquerade as a fact.
 *
 *   1. `classifyParsedFrontmatter` is CERTAIN, and costs nothing. It does not
 *      parse anything: it is handed the REAL parser's verdict and only has to
 *      separate "found nothing because there was nothing" from "found nothing
 *      because it choked". The closing fence in the raw text is what separates
 *      those, and the REST layer already returns `content` alongside
 *      `frontmatter` — so no extra round trip, and no way to be wrong.
 *
 *   2. `detectFrontmatterDefects` is a HEURISTIC, and can only ever be one:
 *      before a PUT there is no parser to ask. Its contract is deliberately
 *      asymmetric — a false positive is more expensive than a miss, because
 *      the false positive lands on a legitimate write. So it recognises the
 *      shapes it is SURE about and stays silent on everything else: quoted
 *      scalars, block scalars, flow collections, comments and continuation
 *      lines are all skipped rather than guessed at. It never blocks a write;
 *      `write_file` warns and writes anyway.
 */

export const FM_ABSENT = 'absent';
export const FM_OK = 'ok';
export const FM_INVALID = 'invalid';

/**
 * Locate the leading frontmatter block.
 *
 * A block exists only when the very first line is exactly `---` AND a later
 * line closes it. An UNCLOSED `---` is not a broken block — it is a horizontal
 * rule or a body separator, and Obsidian reads it that way too. Calling it
 * broken would flag every page that opens on a rule, which is exactly the
 * false positive this module refuses to produce.
 *
 * @param {string} content
 * @returns {{ lines: string[], start: number, end: number } | null}
 */
function locateBlock(content) {
  if (typeof content !== 'string') return null;
  // A UTF-8 BOM sits in front of the opening fence without being part of it.
  // Obsidian looks past it; a plain equality test does not, and would call a
  // perfectly healthy page "no frontmatter".
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  // A LONE `\r` is a line break too. Splitting on `/\r?\n/` alone left it
  // sitting inside a line, where it masqueraded first as part of the value
  // (hiding the quote or `|` that classifies it) and then, once trimmed, as
  // INDENTATION — so a malformed property following a lone CR inside a block
  // scalar was skipped as payload and its defect went unreported (review
  // rounds 6 and 7). Treating it as the break it is fixes both at the source,
  // instead of patching each symptom where it surfaced.
  const lines = text.split(/\r\n|\r|\n/);
  // A fence is `---` at COLUMN ZERO — trailing spaces tolerated, leading ones
  // never. Trimming both ends instead would let an INDENTED `---` close the
  // block, and the one place that reliably produces an indented `---` is the
  // payload of a block scalar:
  //
  //     ---
  //     desc: |
  //       ---
  //     title: x
  //     ---
  //
  // Obsidian closes that block at the LAST fence; a both-ends trim closes it
  // at the indented one, truncating the block and losing `title`. Matching
  // Obsidian's rule is what keeps the two in agreement.
  // `\r` is tolerated so a file whose LAST line is `---\r` (a CRLF document
  // with no trailing newline) still closes its block — the previous
  // both-ends trim accepted that, and losing it would be a regression the
  // column-zero rule never intended (review round 3).
  const isFence = (line) => /^---[ \t\r]*$/.test(line);
  if (lines.length === 0 || !isFence(lines[0])) return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (isFence(lines[i])) return { lines, start: 1, end: i };
  }
  return null; // opened, never closed → a horizontal rule, not a block
}

/**
 * A line that YAML would actually have to make sense of — blanks and
 * whole-line comments carry no properties, so a block made only of those is
 * legitimately empty, not unreadable.
 */
function isSignificant(line) {
  const t = line.trim();
  return t !== '' && !t.startsWith('#');
}

/**
 * Decide which of the three states a page's frontmatter is in.
 *
 * The real parser's verdict OUTRANKS the raw text: if it returned keys, the
 * block parsed, and nothing here gets to overrule that.
 *
 * @param {string} content Raw file content, fences included.
 * @param {object|null|undefined} parsed What the REAL parser returned
 *   (Obsidian's, via `getNote`) — `{}` when it found nothing.
 * @returns {{ frontmatterStatus: 'absent'|'ok'|'invalid', parseError: string|null }}
 */
export function classifyParsedFrontmatter(content, parsed) {
  const hasKeys = !!parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0;
  const block = locateBlock(content);

  if (hasKeys) return { frontmatterStatus: FM_OK, parseError: null };
  if (!block) return { frontmatterStatus: FM_ABSENT, parseError: null };

  const body = block.lines.slice(block.start, block.end);
  if (!body.some(isSignificant)) {
    // A fenced block with nothing in it. The parser did not choke; it
    // correctly found no properties.
    return { frontmatterStatus: FM_OK, parseError: null };
  }

  // A fence, real content inside it, and the real parser came back with
  // nothing. That is not ambiguity — that is a parse failure.
  const defects = detectFrontmatterDefects(content);
  const detail = defects.length
    ? ` Most likely cause: ${defects[0].reason} — \`${defects[0].line}\`.`
    : '';
  return {
    frontmatterStatus: FM_INVALID,
    parseError:
      'The file opens with a frontmatter block, but Obsidian\'s YAML parser '
      + `returned no properties from it — the block is malformed.${detail}`
      + ' Obsidian shows this page as "Invalid properties". Repair it by'
      + ' rewriting the whole file with write_file (+ ifMatch): patch_file and'
      + ' set_frontmatter cannot help, because they must parse the block to'
      + ' edit it.',
  };
}

/**
 * How far a line is indented, in characters.
 */
function indentOf(line) {
  // Separation whitespace only. `trimStart()` is Unicode-aware, so it counted
  // U+2028, U+000B and friends as indentation — and a line "indented" by one
  // of those was skipped as block-scalar payload even though YAML treats the
  // character as content, hiding a real defect (review round 7). Tabs stay in
  // the count deliberately: YAML forbids them in indentation, but treating a
  // tab-indented payload line as content-at-column-zero would end the block
  // early and report its text as broken frontmatter — the false-positive
  // direction, which costs more here than a miss.
  return /^[ \t]*/.exec(line)[0].length;
}

/**
 * Trim YAML SEPARATION whitespace — space and tab — and nothing else.
 *
 * `String.trim()` also removes the non-breaking space and the rest of the
 * Unicode space class, which YAML treats as ordinary scalar CONTENT. That
 * mattered concretely: `key: word:<NBSP>` is a valid plain scalar, but a
 * `String.trim()` turned it into `word:` and the trailing-colon rule then
 * reported a defect on a healthy line. The colon rule itself was right both
 * times it was fixed; the normalisation upstream kept defeating it (review
 * rounds 4 and 5).
 */
function trimSeparation(s) {
  // `\r` appears in both classes as defence in depth only. It USED to be
  // load-bearing: a lone CR survived `split(/\r?\n/)` and sat inside a line,
  // where it hid the character a value is classified by. `locateBlock` now
  // splits on a lone CR as well, so no line reaching here can contain one —
  // the mutation harness proved that by removing this `\r` and finding every
  // test still green. Kept because it costs nothing and makes the function
  // correct standalone, but the real guarantee lives in the split.
  return s.replace(/^[ \t\r]+/, '').replace(/[ \t\r]+$/, '');
}

/**
 * Where a YAML comment starts on this value, or -1.
 *
 * A `#` only opens a comment when it follows whitespace AND sits outside a
 * quoted span. The first version of this repair cut at the first ` #` with no
 * regard for quotes, so `tags: ["a #b", c]` was truncated to `["a` and then
 * reported as an unbalanced collection — a false positive on valid YAML, and
 * not a harmless one: it reaches `frontmatter-not-parseable`, which is an
 * ERROR in the OKF conformance report, not an advisory warning.
 * (Review round 3 — a repair that copied the mechanism without its
 * discipline.)
 */
function commentStart(value) {
  // A value that BEGINS with `#` is entirely a comment — `title: # note` is a
  // null-valued property, which is valid YAML. The scan below only recognises
  // a `#` preceded by whitespace, so index zero fell through it and the
  // comment's own text was then read as the value: `title: # note: retry`
  // produced a colon finding, and `title: # ]` a bracket one (review round 4).
  if (value.startsWith('#')) return 0;
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && i > 0 && (value[i - 1] === ' ' || value[i - 1] === '\t')) return i - 1;
  }
  return -1;
}

/**
 * Count `[`/`{` against `]`/`}` outside quoted spans.
 */
function bracketsUnbalanced(value) {
  let opens = 0;
  let closes = 0;
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') opens += 1;
    else if (ch === ']' || ch === '}') closes += 1;
  }
  return opens !== closes;
}

/**
 * Heuristically spot frontmatter lines that YAML will reject.
 *
 * Recognises the defect class that actually bit us — a bare `: ` inside an
 * unquoted scalar, which YAML reads as a nested mapping and refuses ("Nested
 * mappings are not allowed in compact mappings") — plus unbalanced flow
 * brackets. Everything it is not sure about, it leaves alone.
 *
 * @param {string} content Raw file content, fences included.
 * @returns {Array<{ line: string, reason: string }>}
 */
export function detectFrontmatterDefects(content) {
  const block = locateBlock(content);
  if (!block) return [];

  const findings = [];
  const lines = block.lines;
  // While inside a literal/folded block scalar, every more-indented line is
  // opaque payload — `Note: important.` in there is text, not a mapping.
  let blockScalarIndent = null;

  for (let i = block.start; i < block.end; i += 1) {
    const raw = lines[i];
    const trimmed = trimSeparation(raw);

    if (blockScalarIndent !== null) {
      if (trimmed === '' || indentOf(raw) > blockScalarIndent) continue;
      blockScalarIndent = null; // dedented back out — fall through and read it
    }

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // A sequence item may itself be a mapping (`- name: a`). Read what
    // follows the dash exactly as a key line; a plain scalar item has no
    // colon and falls out below.
    const afterDash = /^-[ \t]+/.test(trimmed) ? trimmed.replace(/^-[ \t]+/, '') : trimmed;

    // A key line is `key:` followed by whitespace or end of line. Non-greedy,
    // so `a: x: y` yields key `a` and value `x: y` — the defect, not a key
    // called `a: x`. A line matching nothing here (a continuation of a
    // multi-line quoted scalar, say) is left alone on purpose.
    const keyMatch = /^([^:#]+?):(?:\s|$)/.exec(afterDash);
    if (!keyMatch) continue;

    let value = trimSeparation(afterDash.slice(keyMatch[0].length));
    if (value === '') continue; // parent of a nested map or a sequence

    // Quoted scalars are safe by construction — whatever they contain is
    // inert. (An unterminated quote is left to the balance check rather than
    // guessed at here.)
    if (value.startsWith('"') || value.startsWith("'")) continue;

    // Block scalar header: the value lives on the following lines.
    if (value.startsWith('|') || value.startsWith('>')) {
      blockScalarIndent = indentOf(raw);
      continue;
    }

    // A trailing ` #` opens a YAML comment, so anything after it is inert.
    // This runs BEFORE the flow-collection branch, not after: `tags: [a, b]
    // # note ]` is valid YAML, and counting the comment's bracket made the
    // detector report an unbalanced collection on a healthy line — a false
    // positive, which is the one thing it must not produce (review round 1).
    const commentAt = commentStart(value);
    // Trim SEPARATION whitespace only — space and tab — not `String.trim`'s
    // whole Unicode space class. A plain `String.trim()` here removed a
    // trailing non-breaking space, turning the valid `word:<NBSP>` into
    // `word:` and manufacturing the very colon finding the narrowed regex had
    // just been fixed to avoid: the check held, and normalisation defeated it
    // downstream (review round 4).
    if (commentAt !== -1) value = trimSeparation(value.slice(0, commentAt));
    if (value === '') continue;

    // Flow collections legitimately contain `: `; only their balance matters.
    if (value.startsWith('[') || value.startsWith('{')) {
      if (bracketsUnbalanced(value)) {
        findings.push({ line: trimmed, reason: 'a flow collection whose brackets never close' });
      }
      continue;
    }

    // THE DEFECT. A colon followed by SEPARATION WHITESPACE inside a plain
    // scalar makes YAML try to read a nested mapping where a compact one is
    // already open; a trailing `:` does the same. Note it is `:` + whitespace
    // and not a bare `:` — `https://x`, `C:\dev` and `10:30` are all valid
    // plain scalars, and flagging those would be exactly the false positive
    // this module exists to avoid. A TAB counts as separation whitespace too,
    // so a literal `': '` is too narrow (review round 2) — but `\s` is too
    // WIDE, because it also matches a non-breaking space and the other
    // Unicode spaces, which YAML does not treat as separation: `hello:<NBSP>`
    // is an ordinary plain scalar and flagging it was a false positive
    // (review round 3). YAML separation is space and tab, and nothing else.
    if (/:[ \t]/.test(value) || value.endsWith(':')) {
      findings.push({
        line: trimmed,
        reason: 'an unquoted value containing a colon followed by a space, which YAML reads as a nested mapping',
      });
      continue;
    }

    if (bracketsUnbalanced(value)) {
      findings.push({ line: trimmed, reason: 'an unquoted value whose brackets never close' });
    }
  }

  return findings;
}
