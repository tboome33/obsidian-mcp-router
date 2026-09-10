/**
 * markdown-headings — "is this line a heading at all?", answered once.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * The question has a single correct answer and this repository kept answering
 * it twice. `detectCatalogOwnedHeadings` (v0.92.0, the `catalog-sessions-heading`
 * lot) carries a careful line scanner that tracks fences and HTML comments,
 * because a catalogue may legitimately SHOW the heading it tells you not to
 * write. The `conventions` skill asks the same question about a vault's
 * `CLAUDE.md` — "is this convention installed?", "where does its section end?"
 * — and answered it with `includes()` plus "cut at the next `## `", a rule that
 * MEASURABLY destroys a file: the `bilingual` snippet displays two `## ` lines
 * inside a fenced markdown example, so the naive cut stops at an example,
 * leaves two thirds of the convention it claims to have removed, and severs the
 * fence — leaving an unterminated code block that swallows the rest of the
 * document at render time (measured 2026-09-11 on a real vault).
 *
 * So the scanner moves here and both callers share it. That is the repository's
 * standing rule for a defect class: a rule fixed in one place and left wrong in
 * the other reads as closed while the second site keeps failing.
 *
 * ---------------------------------------------------------------------------
 * DETECTION AND DELETION ARE NOT THE SAME RISK — AND THAT SHAPED THIS FILE
 * ---------------------------------------------------------------------------
 * The catalogue scanner only ever REPORTS. Its consumer here CUTS, and a
 * scanner's blind spot becomes a caller's deleted text. Two adversarial rounds
 * turned that into concrete inputs, and each one was MEASURED against the real
 * corpus (12 shipped snippets + the reference template's `CLAUDE.md`) rather
 * than argued about:
 *
 *   - setext headings (`Title` underlined with `===` / `---`): ONE candidate in
 *     the corpus, and it is a YAML frontmatter terminator. So frontmatter is
 *     skipped and setext IS recognised — a heading a human sees is a boundary a
 *     cut must respect, and a user's `CLAUDE.md` is not the shipped library.
 *     Multi-line paragraphs are promoted too, from their FIRST line, because
 *     the alternative is a boundary the scanner cannot see and a cut that eats
 *     the section under it.
 *   - indented ATX headings: ZERO in the corpus, so filtering IDENTITIES to
 *     column 0 costs nothing. They are still REPORTED, because as a BOUNDARY an
 *     indented heading matters: a user's own `  ## Personal rules` between two
 *     conventions must stop the cut.
 *   - indented fences (up to three leading spaces, or after a list marker):
 *     FOUR occurrences in the shipped library, both of `default-vault-health-check.md`
 *     inside a numbered list item. NOT tracked — see below — and the gap is held
 *     by a corpus scan in `tests/claude-md-conventions.test.mjs` that fails if a
 *     heading-shaped line ever hides inside one.
 *
 * ---------------------------------------------------------------------------
 * FENCES ARE TRACKED AT COLUMN 0 ONLY, AND THAT IS A DECISION, NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 * Two widenings were tried here and both were reverted by the v0.92.0 suite,
 * within a minute of each other:
 *
 *   1. accepting a fence indented up to three spaces. `- ```markdown` puts its
 *      opener after a bullet, where nothing recognises it — so recognising the
 *      INDENTED CLOSER below turns that closer into an opener, and the real
 *      heading after the block disappears.
 *   2. so recognise the list-marker opener too. That fails three MORE
 *      witnesses: a closer indented to a `10. ` item's content column (4) is
 *      then never seen and the fence never closes; `-     ``` ` is indented
 *      CODE inside the item, not a fence; and `2. ` cannot start a list after a
 *      paragraph line at all, so its backticks are not a fence either.
 *
 * Each fix is one step deeper into container parsing, and each intermediate
 * step is WORSE than the strict rule it replaces — a scanner that opens a fence
 * it cannot close hides every heading in the rest of the file. HTML comment
 * openers are at column 0 for the same reason and for one more: the v0.92.0
 * behaviour is what its 69 witnesses describe, and an extraction that quietly
 * widens it is a behaviour change smuggled in with a refactor.
 *
 * PURE: text in, findings out. No I/O, no caller state.
 */

/** Column 0 — see the header: every widening of this one made things worse. */
const FENCE = /^(`{3,}|~{3,})(.*)$/;
/** ATX and setext may carry up to three leading spaces and still render. */
const ATX = /^( {0,3})(#{1,6})(?:[ \t]+(.*))?$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/** Line shapes that are not a paragraph, so cannot be promoted by an underline. */
const NOT_A_PARAGRAPH = /^(?: {4,}|\t|>| {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]| {0,3}<)/;

/**
 * Where the document's YAML frontmatter ends, or 0 when it has none.
 *
 * A `---` first line is only frontmatter if a later `---` line CLOSES it.
 * Assuming otherwise suppressed an entire catalogue whose first line was a
 * thematic break — an adversarial-review finding, and a regression against the
 * pre-extraction scanner, which had no frontmatter notion at all.
 */
function frontmatterEnd(text) {
  if (!/^---[ \t]*(\r?\n|$)/.test(text)) return 0;
  const re = /\r?\n/g;
  let lineStart = text.indexOf('\n') + 1;
  if (lineStart === 0) return 0;
  while (lineStart <= text.length) {
    re.lastIndex = lineStart;
    const m = re.exec(text);
    const lineEnd = m ? m.index : text.length;
    if (/^---[ \t]*$/.test(text.slice(lineStart, lineEnd))) {
      return m ? m.index + m[0].length : text.length;
    }
    if (!m) return 0;
    lineStart = m.index + m[0].length;
  }
  return 0;
}

/**
 * An ATX heading's rendered text: the capture minus a CommonMark closing
 * sequence, then trimmed.
 *
 * THE ORDER MATTERS, and review found the version that had it backwards.
 * Trimming first and stripping hashes afterwards accepts `## Alpha ##<NBSP>` —
 * where the non-breaking space after the hashes disqualifies the closing
 * sequence, so those hashes are part of the user's heading TEXT. Normalising
 * them away hands their section to whoever asked to remove the `Alpha`
 * convention. So the closing sequence is recognised against the RAW capture,
 * once, here — and nothing downstream strips hashes again.
 */
function atxText(raw) {
  return String(raw ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
}

/**
 * Every heading in `text` that is not inside a fenced code block, an HTML
 * comment, or the document's YAML frontmatter.
 *
 * ---------------------------------------------------------------------------
 * THE STATE MACHINE, AND THE REVIEW ROUNDS BEHIND EACH BRANCH
 * ---------------------------------------------------------------------------
 * Inside an open fence, only that fence's terminator is looked for. Everything
 * else on those lines is literal text, and a scanner that reads structure out
 * of it desynchronises: an adversarial round on the v0.92.0 lot produced a list
 * item beginning with backticks being taken for a closing fence, which then
 * reported the code below it AND turned the real closer into a new opener.
 *
 * A BACKTICK fence's info string may not contain a backtick, so such a line
 * opens nothing — treating it as an opener hides the real heading after it.
 * A closing fence may be followed only by spaces or tabs; `trim()` would also
 * eat a non-breaking space and close a block CommonMark leaves open.
 *
 * An HTML comment opener has to BEGIN its line: a backtick-quoted comment
 * marker in prose is inline code, and a substring search on it swallowed the
 * rest of a file in an earlier review round. It is checked AFTER the fence, so
 * a comment marker inside a fence's info string cannot hijack it either.
 *
 * A setext underline promotes the paragraph above it, from that paragraph's
 * FIRST line — which is where a cut must stop. A paragraph starts after a blank
 * line or after any block this scanner closes (a heading, a fence, a comment,
 * the frontmatter); it is never an indented code line, a blockquote, a list
 * item or an HTML block, because none of those is a paragraph and promoting one
 * invents a boundary that is not there.
 *
 * @param {unknown} text the document
 * @returns {Array<{level: number, text: string, raw: string, indent: number,
 *   style: 'atx'|'setext', line: number, start: number, end: number}>}
 *   `text` is the heading's rendered text, trimmed, with an ATX closing
 *   sequence already removed; `raw` is the line as written, for a message that
 *   tells a human what to search for. `start` is the offset of the heading
 *   line's first character and `end` the offset just past its line terminator,
 *   so a caller can cut a section out of the ORIGINAL text with no index
 *   arithmetic of its own. For a setext heading, `start` is its first title
 *   line and `end` the end of that same line — the underline travels with the
 *   section below it, which is what a boundary needs.
 */
export function scanHeadings(text) {
  if (typeof text !== 'string') return [];

  const headings = [];
  const fmEnd = frontmatterEnd(text);
  let fenceChar = null;
  let fenceLen = 0;
  let inComment = false;
  let offset = 0;
  let lineNo = 0;
  /** The paragraph currently open, or null. */
  let para = null;

  while (offset <= text.length) {
    const nl = text.indexOf('\n', offset);
    const lineEnd = nl === -1 ? text.length : nl;
    const rawLine = text.slice(offset, lineEnd);
    // A CRLF document must not hand `\r` to the heading text, and must not lose
    // it from the offsets either — the cut has to be byte-exact. A LONE `\r`
    // terminator is stripped too; the pre-extraction scanner did not, so a
    // classic-Mac line ending hid a heading from it. Widened on purpose, with
    // its own witness.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    lineNo += 1;
    const lineStart = offset;
    const nextOffset = nl === -1 ? text.length + 1 : nl + 1;
    const boundedEnd = nextOffset > text.length ? text.length : nextOffset;
    const advance = () => { offset = nextOffset; };
    const done = () => nl === -1;

    if (lineStart < fmEnd) {
      para = null;
      advance();
      if (done()) break;
      continue;
    }

    if (fenceChar !== null) {
      const closer = FENCE.exec(line);
      if (closer && closer[1][0] === fenceChar && closer[1].length >= fenceLen && /^[ \t]*$/.test(closer[2])) {
        fenceChar = null;
        fenceLen = 0;
      }
      advance();
      if (done()) break;
      continue;
    }

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      advance();
      if (done()) break;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      fenceChar = fence[1][0];
      fenceLen = fence[1].length;
      para = null;
      advance();
      if (done()) break;
      continue;
    }

    if (/^<!--/.test(line)) {
      if (!line.includes('-->')) inComment = true;
      para = null;
      advance();
      if (done()) break;
      continue;
    }

    if (SETEXT_UNDERLINE.test(line)) {
      // With no paragraph above it, this is a thematic break (or a stray rule),
      // and it must not become a paragraph line either — otherwise a second
      // `---` under it would promote the first one to a heading.
      if (para) {
        headings.push({
          level: line.trim()[0] === '=' ? 1 : 2,
          text: para.lines.join(' ').trim(),
          raw: para.raw,
          indent: para.indent,
          style: 'setext',
          line: para.line,
          start: para.start,
          end: para.end,
        });
      }
      para = null;
      advance();
      if (done()) break;
      continue;
    }

    // ATX heading. Up to three leading spaces still render as one; four make an
    // indented code block, where nothing is structure. The indent is REPORTED
    // rather than filtered — each caller says in its own words what position
    // means for its question. The separator after the hashes is a space or a
    // TAB, never any other unicode whitespace: `##<NBSP>Sessions` is not a
    // heading at all. A bare `##` with no text is one, with `text: ''`.
    const atx = ATX.exec(line);
    if (atx) {
      headings.push({
        level: atx[2].length,
        text: atxText(atx[3] ?? ''),
        raw: line,
        indent: atx[1].length,
        style: 'atx',
        line: lineNo,
        start: lineStart,
        end: boundedEnd,
      });
      para = null;
      advance();
      if (done()) break;
      continue;
    }

    if (line.trim() === '' || NOT_A_PARAGRAPH.test(line)) {
      para = null;
    } else if (para) {
      para.lines.push(line.trim());
    } else {
      para = {
        lines: [line.trim()],
        raw: line,
        indent: /^ {0,3}/.exec(line)[0].length,
        line: lineNo,
        start: lineStart,
        end: boundedEnd,
      };
    }

    advance();
    if (done()) break;
  }

  return headings;
}

/**
 * The ATX headings only — what `detectCatalogOwnedHeadings` asks for.
 *
 * A catalogue AREA is written `## Name`; the v0.92.0 rules, their two review
 * rounds and their 69 witnesses are all about that shape, and quietly handing
 * them setext headings would be a behaviour change smuggled in with a refactor.
 *
 * @param {unknown} text
 * @returns {ReturnType<typeof scanHeadings>}
 */
export function scanAtxHeadings(text) {
  return scanHeadings(text).filter((h) => h.style === 'atx');
}

/**
 * What a heading text compares AS — whitespace only.
 *
 * ATX closing sequences are handled by the parser (`atxText`), once, against
 * the raw capture. Stripping them again here is what let `## Alpha ##<NBSP>`
 * be read as `Alpha`: a second pass cannot know whether the hashes it sees were
 * a closing sequence or the author's text, so it must not guess.
 *
 * DELIBERATELY NOT PEELED: wrapping emphasis and backticks. `ownedAreaFor` in
 * `session-folder-collision.mjs` peels them because a bold **Sessions** is
 * still the Sessions area; here the identities themselves contain backticks
 * (`## Source provenance — \`source_type\` frontmatter`), so peeling a wrapping
 * run would corrupt the very strings this function compares. Two normalisers,
 * on purpose, each with the rationale for what it does not do.
 *
 * @param {unknown} heading
 * @returns {string}
 */
export function normaliseHeadingText(heading) {
  if (typeof heading !== 'string') return '';
  return heading.trim();
}
