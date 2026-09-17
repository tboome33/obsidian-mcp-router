/**
 * temporal-validity — does what a page says still apply, on a given day?
 *
 * The pure half of the `validite-temporelle-des-connaissances` decision
 * (accepted 2026-09-11). A page may declare a window of application with two
 * optional frontmatter fields, `valid_from` and `valid_through`, and this
 * module is THE ONE PLACE that turns those into a state. Every consumer — the
 * wiki-lint check, the decisions-recall hook, the search annotator — imports
 * it; none re-implements the comparison. Zero I/O, zero dependency, so a hook
 * running in a fresh checkout before `npm install` can use it, exactly like
 * `total-order.mjs`.
 *
 * FOUR STATES, and the fifth thing that is not a state:
 *
 *   not-yet-in-force · in-force · no-longer-in-force · unreadable
 *
 * A page that declares NEITHER field has no state at all — `classifyValidity`
 * returns null. That is not "always valid" and not "unknown, flag it": it is
 * the normal case for almost every page in a vault, and it must stay silent.
 * A page whose window cannot be read is `unreadable`, which is loud on
 * purpose: the failure this whole module exists to prevent is a mis-typed date
 * quietly promoting a perishable page to a permanent one. `review_after` was
 * bitten by exactly that (`01/01/2026` read as "no date at all"), and the fix
 * there is the rule here.
 *
 * WHY STRINGS AND NOTHING ELSE. Both frontmatter parsers in play hand back
 * strings: the router's own line-oriented parser (hooks, linter, index) and
 * the JSON frontmatter Obsidian returns through `getNote`. A `Date` object is
 * therefore refused rather than converted — and that is a CHOICE OF CONTRACT,
 * not an impossibility. A conversion exists (the UTC day of the instant), but
 * it would be a second calendar rule to document and test, and the tempting
 * wrong one (the host's local day) moves a bound by a day depending on where
 * the machine sits: `new Date("2026-01-01")` is midnight UTC, whose local day
 * is 31 December anywhere west of Greenwich. Refusing makes a source that
 * types its dates VISIBLE, as `unreadable`, instead of silently shifted.
 *
 * WHY AN EMPTY KEY IS ABSENT, NOT UNREADABLE. In YAML, a key with no value IS
 * null. Obsidian's parser returns null; the router's line parser returns the
 * empty string, and the string "null" for a null written out in full (measured
 * by running the module, not assumed). If "empty" meant unreadable, the very
 * same page would be `unreadable` for the hook and stateless for the context
 * pack. The only reading that gives both parsers the same answer is YAML's:
 * empty is nothing. The `review_after` lesson still holds, because it is about
 * a NON-EMPTY value that is mis-written, and that stays unreadable here.
 *
 * WHY THE REFERENCE DAY IS UTC. `review_after` is compared against
 * `new Date().toISOString().slice(0, 10)` — the UTC calendar day — in the
 * linter and in the recall hook, and that pattern appears at seven sites in
 * this repo. Using the host's local day here would put two clocks on a single
 * decision page. Near local midnight the two disagree by a day; the decision
 * says so in the open rather than hiding it, and a caller who wants another
 * day passes `asOf`.
 */

/** The two fields, spelled once. */
export const VALID_FROM = 'valid_from';
export const VALID_THROUGH = 'valid_through';

/** Shape of an ISO calendar date. Width is fixed, which is what lets the
 *  comparisons below be plain string comparisons. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The spellings YAML 1.2 gives to null, as they reach us through a parser that
 * does not interpret them. Exact matches, not a case-insensitive test: `null`,
 * `Null` and `NULL` are null in YAML, `nUlL` is the four-letter string — and a
 * four-letter string that is not a date is unreadable, which is the right
 * answer for it.
 */
const YAML_NULL_SPELLINGS = new Set(['null', 'Null', 'NULL', '~']);

/** Problem codes a bound can carry. Exported so tests and consumers name them
 *  instead of matching on message text. */
export const PROBLEM_NOT_A_STRING = 'not-a-string';
export const PROBLEM_NOT_ISO = 'not-iso';
export const PROBLEM_NOT_A_CALENDAR_DATE = 'not-a-calendar-date';
/** Carried by the WINDOW, not by either bound: both read fine, and `from` is
 *  after `through`. Unprefixed for that reason. */
export const PROBLEM_INVERTED = 'inverted';

/** The four states, exported for the same reason. */
export const STATE_NOT_YET = 'not-yet-in-force';
export const STATE_IN_FORCE = 'in-force';
export const STATE_NO_LONGER = 'no-longer-in-force';
export const STATE_UNREADABLE = 'unreadable';

/**
 * Days in a month of the proleptic Gregorian calendar — the calendar ISO 8601
 * specifies, all the way back.
 *
 * Computed rather than delegated to `Date`: `Date.UTC(26, 1, 30)` maps the
 * two-digit year onto 1926, so a date in year 0026 would be judged against a
 * different year's leap rule. Nobody writes year 0026, and a rule that only
 * works for years we expect is a rule that fails where nobody is watching.
 */
function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * Read ONE bound.
 *
 * @param {unknown} value the raw frontmatter value
 * @returns {{value: string}|{absent: true}|{problem: string}}
 *   Exactly one of the three shapes. `absent` means the page said nothing;
 *   `problem` carries one of the PROBLEM_* codes.
 */
export function normalizeBound(value) {
  if (value === undefined || value === null) return { absent: true };
  if (typeof value !== 'string') return { problem: PROBLEM_NOT_A_STRING };

  const text = value.trim();
  if (text === '' || YAML_NULL_SPELLINGS.has(text)) return { absent: true };

  if (!ISO_DATE_RE.test(text)) return { problem: PROBLEM_NOT_ISO };

  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (month < 1 || month > 12) return { problem: PROBLEM_NOT_A_CALENDAR_DATE };
  if (day < 1 || day > daysInMonth(year, month)) return { problem: PROBLEM_NOT_A_CALENDAR_DATE };

  return { value: text };
}

/**
 * Read the WINDOW a page declares.
 *
 * Defined on the NORMALISED bounds, which is what makes `{valid_from: null}`
 * behave: null is absent, so that page declares no window and gets null back —
 * it must not become a half-open window that classifies as `in-force`.
 *
 * @param {object|null|undefined} frontmatter
 * @returns {null|{from: string|null, through: string|null, problems: string[]}}
 *   null when both bounds are absent AND nothing was wrong. Otherwise the
 *   window, with `problems` empty when both bounds read cleanly. Problems from
 *   a bound are prefixed with the field that carried them
 *   (`valid_from:not-iso`); `inverted` belongs to the pair and is not.
 */
export function readWindow(frontmatter) {
  const source = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  const rawFrom = Object.prototype.hasOwnProperty.call(source, VALID_FROM) ? source[VALID_FROM] : undefined;
  const rawThrough = Object.prototype.hasOwnProperty.call(source, VALID_THROUGH) ? source[VALID_THROUGH] : undefined;

  const from = normalizeBound(rawFrom);
  const through = normalizeBound(rawThrough);

  const problems = [];
  if (from.problem) problems.push(`${VALID_FROM}:${from.problem}`);
  if (through.problem) problems.push(`${VALID_THROUGH}:${through.problem}`);

  const fromValue = from.value ?? null;
  const throughValue = through.value ?? null;

  // Fixed-width ISO strings compare correctly with `<` / `>`; no Date needed.
  if (fromValue !== null && throughValue !== null && fromValue > throughValue) {
    problems.push(PROBLEM_INVERTED);
  }

  if (fromValue === null && throughValue === null && problems.length === 0) return null;

  return { from: fromValue, through: throughValue, problems };
}

/**
 * Is this a usable `Date`? A `new Date('nonsense')` is an object of the right
 * type whose time is NaN, and every method on it answers NaN — the one shape
 * that would turn a clock into silent garbage.
 */
function isUsableDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Resolve the reference day of ONE operation.
 *
 * Call it once, at the start of a tool call / hook run / lint pass, and pass
 * the result everywhere: two entries of a single response must never be
 * classified against different days because the clock crossed midnight
 * between them.
 *
 * @param {unknown} input caller-supplied `asOf`; undefined or null means "today"
 * @param {Date} [now] the instant to read the day from; defaults to the real clock
 * @returns {string} an ISO calendar day, `YYYY-MM-DD`, in UTC
 * @throws {Error} when `input` is present but unreadable — NEVER a silent
 *   fallback to today, which would answer a mis-typed historical question with
 *   the present and say nothing.
 */
export function resolveAsOf(input, now = new Date()) {
  if (input === undefined || input === null) {
    if (!isUsableDate(now)) {
      const err = new Error('temporal-validity: `now` must be a valid Date');
      err.kind = 'validation';
      throw err;
    }
    // `toISOString` widens to an EXPANDED year outside 0000-9999 (`+010000-…`),
    // where slicing ten characters stops producing `YYYY-MM-DD` and quietly
    // hands back `+010000-01`. Every consumer compares these as fixed-width
    // strings, so a day of the wrong width is worse than an error. Found by
    // review.
    const day = now.toISOString().slice(0, 10);
    if (!normalizeBound(day).value) {
      const err = new Error(
        `temporal-validity: the clock produced ${JSON.stringify(day)}, which is not a `
        + 'YYYY-MM-DD day — a year outside 0000-9999 has no representation here',
      );
      err.kind = 'validation';
      throw err;
    }
    return day;
  }

  const normalized = normalizeBound(input);
  if (normalized.value) return normalized.value;

  // An explicitly empty asOf is a caller mistake, not a request for today: it
  // is refused like any other unreadable value.
  const reason = normalized.absent ? 'is empty' : `is ${normalized.problem}`;
  const err = new Error(
    `temporal-validity: asOf ${reason} — expected an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(input)}`,
  );
  err.kind = 'validation';
  throw err;
}

/**
 * Classify a page at a reference day.
 *
 * @param {object|null|undefined} frontmatter
 * @param {{asOf?: string|null}} [options] an ISO calendar day. Omitting it
 *   reads the real clock ON EVERY CALL, which is only ever right for a
 *   one-shot: a consumer classifying more than one page resolves the day once
 *   with `resolveAsOf` and passes it here. A `Date` is refused, like any
 *   non-string bound.
 * @returns {null|{state: string, from: string|null, through: string|null, asOf: string, problems: string[]}}
 *   null when the page declares no window (invariant: no window, no state).
 */
export function classifyValidity(frontmatter, options = {}) {
  // The reference day is resolved FIRST, before the page is even looked at.
  // Ordering it the other way compiles and reads fine and is a trap: a caller
  // passing a mistyped `asOf` would be refused on pages that declare a window
  // and silently served `null` on pages that do not, so whether the mistake
  // surfaces would depend on which page happened to come first. A bad argument
  // is bad on its own terms.
  const asOf = resolveAsOf(options.asOf);

  const window = readWindow(frontmatter);
  if (window === null) return null;

  const { from, through, problems } = window;

  if (problems.length > 0) {
    return { state: STATE_UNREADABLE, from, through, asOf, problems };
  }

  // Bounds are INCLUDED: `asOf === through` is still in force, and the day
  // after is not. An absent bound leaves that side open.
  let state = STATE_IN_FORCE;
  if (from !== null && asOf < from) state = STATE_NOT_YET;
  else if (through !== null && asOf > through) state = STATE_NO_LONGER;

  return { state, from, through, asOf, problems };
}

// ---------------------------------------------------------------------------
// Reading the two fields where no YAML parser is available
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS, AND WHY IT REFUSES MORE THAN IT READS.
 *
 * One consumer cannot use a YAML parser: the decisions-recall hook, which runs
 * on every prompt submission, before `npm install`, and therefore carries a
 * line-oriented reader. For most fields that is fine. For these two it is not,
 * because a line reader does not blur the answer — it INVERTS it. A key nested
 * under a parent surfaces at the top level, so a page that declared nothing
 * looks dated; a bound holding a block collapses to an empty value, so a
 * malformed window looks clean.
 *
 * The first version of this function tried to be a small YAML parser. Review
 * then produced, one after another, six shapes it got wrong — block scalars,
 * quoted keys, sequences at the key's own indentation, folded continuations, an
 * unterminated quote on ANOTHER key swallowing the line below, escape sequences
 * inside double quotes — and there was no reason to believe the seventh would
 * not exist. A small YAML parser is wrong in a hundred ways, and each patch
 * hides the next hole.
 *
 * So it stopped guessing. It now reads ONE shape, the plain
 * `key: value-on-this-line`, and everything else is reported as UNDETERMINED —
 * not as absent, not as unreadable, but as "this reader cannot tell". The three
 * outcomes are kept apart on purpose: absent means the page says nothing,
 * unreadable means the author wrote something that is not a date, and
 * undetermined means the READER is the limitation. Only the third is about us,
 * and collapsing it into either of the others is how a tool starts lying about
 * a vault.
 *
 * A consumer holding a real parse must not call this at all — it would get a
 * needlessly narrow answer. `classifyValidity(frontmatter)` is for them.
 */

/** A frontmatter shape this reader will not interpret. */
export const WINDOW_UNDETERMINED = 'undetermined';

/** Block scalar indicators. Their content lives on the following lines, which
 *  this reader does not follow. */
/**
 * A block scalar header, in the shapes YAML actually allows.
 *
 * `|` and `>`, an optional chomping indicator and explicit indent in either
 * order, optional anchor or tag properties BEFORE the indicator, and an
 * optional trailing comment. The narrow version — indicator and digits only —
 * failed to recognise `| # exemple` and `&example |`, so the lines below the
 * header were read as structure instead of as text: a `?` written inside a
 * documentation block was taken for an explicit key and the page's real,
 * perfectly readable bound was thrown away with it.
 * (Adversarial review, round 4, 2026-09-16.)
 */
const BLOCK_SCALAR_RE = /^(?:[&!][^\s]*\s+)*[|>](?:[+-]?\d+|\d+[+-]?|[+-])?\s*(?:#.*)?$/;

/**
 * THE ONE SHAPE THIS READER READS: a key at column zero, then `:`.
 *
 * Two spellings, because YAML has two. The quoted form keeps its delimiter and
 * allows the OTHER quote inside it — `"l'exemple":` is an ordinary key, and a
 * character class that banned both quotes made it invisible, which in turn made
 * its block scalar untracked and the text inside it read as structure.
 *
 * The plain form is deliberately generous about the key's characters — Unicode,
 * spaces, dots, anything but a colon — because recognising a line AS a key is a
 * structural question, separate from whether this reader interprets that key.
 * Tying the two together meant `métadonnées:` did not register as a parent.
 * What it refuses are the YAML INDICATORS that open something else entirely:
 * `?` an explicit key, `-` a sequence entry, `{[` a flow collection, `&*!` node
 * properties, `|>` a block scalar with no key at all, `#` a comment.
 */
const DOUBLE_QUOTED_ROOT_KEY_RE = /^(")((?:\\.|[^"\\\r\n])*)"[ \t]*:([ \t].*|)$/;
/** In single quotes, `''` is the escape for an apostrophe — not a terminator. */
const SINGLE_QUOTED_ROOT_KEY_RE = /^(')((?:''|[^'\r\n])*)'(?!')[ \t]*:([ \t].*|)$/;
/**
 * `:` IS ONLY A SEPARATOR WHEN SOMETHING FOLLOWS IT. `valid_from:2020-01-01` is
 * a plain SCALAR in YAML — one string, no mapping, no key — and reading it as a
 * declaration invented a window on a page that declares none. So the separator
 * is `:` followed by a space, a tab, or the end of the line, and a colon that
 * is not one belongs to the key.
 */
const PLAIN_ROOT_KEY_RE = /^(?![\s#])(?![-?:](?:\s|$))(?![{}[\]&*!|>'"])(.+?)[ \t]*:([ \t].*|)$/;

/**
 * Does this value open a quote it does not close on the same line? Such a
 * scalar continues onto the lines below, which means every line under it is
 * CONTENT, not a key — the trap that let `valid_from:` inside an unterminated
 * `summary: "…` be read as a real field.
 */
function opensUnclosedQuote(value) {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return false;
  for (let i = 1; i < value.length; i += 1) {
    if (quote === '"' && value[i] === '\\') { i += 1; continue; }
    if (value[i] === quote) return false;
  }
  return true;
}

/**
 * The scalar a `key: value` line carries, when this reader is willing to say.
 *
 * @returns {{value: string}|{undetermined: true}}
 */
/**
 * Strip the characters YAML calls white space, and only those.
 *
 * `String.prototype.trim()` removes a non-breaking space, a zero-width space
 * and a dozen more that YAML treats as ordinary content — so round 6 narrowed
 * the COMMENT separator to `[ \t]#` and the `trim()` right next to it went on
 * eating the very character that made the value unreadable: `valid_from: <NBSP>#citation`
 * came back as an empty value, and the page was reported as declaring nothing.
 * Half a repair is how a defect survives its own fix. (Round 7, 2026-09-16.)
 */
function yamlTrim(text) {
  return String(text).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function plainScalar(raw) {
  const value = yamlTrim(raw);
  if (value === '') return { value: '' };
  // A comment in value position: the key carries nothing.
  if (value[0] === '#') return { value: '' };
  if (BLOCK_SCALAR_RE.test(value)) return { undetermined: true };

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (opensUnclosedQuote(value)) return { undetermined: true };
    const end = value.indexOf(quote, 1);
    const inner = value.slice(1, end);
    // Escapes are a decoding problem, and decoding is exactly the ambition
    // this function gave up. `"2027-01-01"` is a valid date to YAML
    // and gibberish here, so it is declared undetermined rather than misread.
    if (quote === '"' && inner.includes('\\')) return { undetermined: true };
    const after = value.slice(end + 1).trim();
    // Anything but a comment after the closing quote is a shape we do not model.
    if (after !== '' && after[0] !== '#') return { undetermined: true };
    return { value: inner };
  }

  // Unquoted: a YAML comment starts at ` #`; a `#` with no space before it is
  // part of the value.
  //
  // `[ \t]`, NOT `\s`. YAML's white space is the ASCII space and the tab, and
  // nothing else — JavaScript's `\s` also matches a non-breaking space, a
  // no-width space and a dozen other characters that YAML treats as ordinary
  // content. So `valid_through: 2025-12-31<NBSP>#citation` was cut at the NBSP
  // and reported as the certain date `2025-12-31`, when the real value is a
  // string that is not a date at all: a bound nobody can read, announced as an
  // expiry. (Adversarial review, round 6, 2026-09-16.)
  const comment = value.search(/[ \t]#/);
  return { value: (comment >= 0 ? value.slice(0, comment) : value).trim() };
}

/**
 * Extract the two fields from RAW frontmatter text, or say it cannot.
 *
 * @param {string} text the file head, frontmatter included
 * @returns {{fields: object, undetermined: string[]}} `fields` is shaped for
 *   `readWindow` / `classifyValidity` — the caller keeps one set of rules —
 *   and `undetermined` names the fields whose shape this reader refused. A
 *   field named there is absent from `fields`: the caller must not treat it as
 *   a page that said nothing.
 */
/**
 * The next line that carries meaning, skipping blanks and whole-line comments.
 *
 * A comment is not a value and does not end one: `valid_from:` followed by
 * `# note` and then an indented list still has a block for a value. Stopping at
 * the comment reported the key as a genuinely empty one — the block vanished,
 * and a window nobody could read became a page that had said nothing, which is
 * exactly the confusion invariant 2 exists to forbid.
 *
 * @returns {string|null} the line, or null when nothing significant follows
 */
function nextSignificantLine(lines, from) {
  for (let j = from; j < lines.length; j += 1) {
    // `yamlTrim`, not `trim()`: a line holding a single non-breaking space is
    // CONTENT, and skipping it as blank let the reader look past a continuation
    // and accept a truncated date as whole.
    const trimmed = yamlTrim(lines[j]);
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return lines[j];
  }
  return null;
}

export function windowFieldsFromFrontmatterText(text) {
  // A byte-order mark before the opening fence would make the anchored match
  // fail, and the window would vanish while every OTHER field of the same file
  // read fine — a silent loss, on files Windows editors produce routinely.
  const source = String(text ?? '').replace(/^﻿/, '');
  // The closing fence is a line of its own: `---meta: x` is a key, not a fence.
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) {
    // No frontmatter at all and an UNTERMINATED one are different things. If
    // the text never opens a fence, the page simply has none. If it opens one
    // and never closes it, anything could be in there — INCLUDING a bound
    // spelled in a way this reader does not decode.
    //
    // The second condition used to be a text search for `valid_from:`, which is
    // the predicate round 4 retired from the main scan and forgot here: a
    // quoted, escaped or flow-written bound inside an unterminated block was
    // answered with "no window, and I am sure". An opening with no closing is
    // unreadable whatever the keys look like, so nothing is asked of the text.
    // (Round 7, 2026-09-16.)
    if (/^---\r?\n/.test(source)) {
      return { fields: {}, undetermined: [VALID_FROM, VALID_THROUGH] };
    }
    return { fields: {}, undetermined: [] };
  }

  const lines = match[1].split(/\r?\n/);
  const fields = {};
  const undetermined = new Set();
  const seen = new Set();

  // TWO YAML SHAPES THIS READER DOES NOT SEE AT ALL, and silence about them was
  // worse than refusing them. An explicit key (`? valid_from` / `: value`) and a
  // document-level flow mapping (`{"valid_from": …}`) are both valid YAML, both
  // carry a bound, and neither matches the `key: value` scan below — so the
  // reader answered "no window, and I am sure", which is the one answer it must
  // never give about a page that does declare one. A document that mixes them
  // with a plain key is worse still: the plain one was read and the other
  // ignored, so a duplicate went unreported. (Adversarial review, round 2.)
  //
  // They are DETECTED, never decoded: the whole point of this reader is that it
  // does not implement YAML.
  //
  // THE DETECTION LIVES IN THE MAIN LOOP, and that is the whole repair of round
  // 3. A separate pre-scan had its own idea of what a line is: it flagged a `?`
  // written inside a block scalar — losing a perfectly readable bound two lines
  // further down — and it missed an INDENTED flow node, or one behind an anchor
  // (`&window {…}`), because it only looked at column zero. Two passes with two
  // definitions of YAML content will always disagree somewhere. The loop below
  // already tracks block scalars and unclosed quotes; the detection rides along
  // with it and sees exactly what it sees.
  //
  // AND IT ASKS NOTHING ABOUT THE TEXT. Round 3's version only refused when the
  // block literally contained `valid_from` or `valid_through`, which was wrong
  // in both directions: a JSON-escaped key (`"valid_from"`) declares a
  // bound without spelling it, so the window vanished; and a page whose TITLE
  // happened to be the string `valid_from` was refused although it declares
  // nothing. A shape this reader cannot decode means it cannot conclude —
  // full stop. That is the module's own doctrine, and it retires an entire
  // class of text-matching defects. (Round 4, 2026-09-16.)
  let unsupportedShape = false;
  // Whether a root-level key has been read yet, which is what tells a ROOT flow
  // node from a value belonging to the key above it. `metadata:` followed by an
  // indented `{owner: Alice}` is a child, and refusing the document over it lost
  // a bound declared plainly at the root two lines down.
  let sawRootKey = false;
  /**
   * Whether the last root key is still waiting for its value — the only state
   * in which a sequence entry at column zero belongs to it.
   */
  let awaitingSequence = false;

  // Lines consumed by a multi-line scalar are NOT keys. Tracking that is the
  // difference between reading a document and reading the characters in it.
  let skipIndentedUntilDedent = false;
  let insideUnclosedQuote = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (insideUnclosedQuote !== null) {
      // Still inside a quoted scalar opened on an earlier line: this line is
      // content. It ends where the quote closes.
      if (line.includes(insideUnclosedQuote)) insideUnclosedQuote = null;
      continue;
    }
    if (skipIndentedUntilDedent) {
      if (line.trim() === '' || /^\s/.test(line)) continue;
      skipIndentedUntilDedent = false;
    }

    // Reached only on a line the loop considers CONTENT — not inside a quoted
    // scalar, not inside a block scalar.
    const trimmedLine = line.trim();
    // Neither structure nor content: nothing here changes what follows.
    if (trimmedLine === '' || trimmedLine.startsWith('#')) continue;

    // AN INDENTED LINE BELONGS TO THE KEY ABOVE IT — when there is one. A
    // document whose very first content is indented is an indented ROOT node,
    // and every key in it is invisible to a column-zero scan: the reader used to
    // answer "no window, and I am sure" about `  valid_from: …`.
    if (/^\s/.test(line)) {
      if (!sawRootKey) unsupportedShape = true;
      continue;
    }

    // From here the line is at column zero, so it is either a root key this
    // reader recognises or a shape it does not read.
    const quotedKey = DOUBLE_QUOTED_ROOT_KEY_RE.exec(line) ?? SINGLE_QUOTED_ROOT_KEY_RE.exec(line);
    const plainKey = quotedKey ? null : PLAIN_ROOT_KEY_RE.exec(line);
    // A SEQUENCE ENTRY AT COLUMN ZERO IS STILL THE VALUE OF THE KEY ABOVE IT —
    // WHEN THAT KEY IS STILL WAITING FOR ONE. YAML lets a block sequence sit at
    // its parent's indentation, so `tags:` followed by `- documentation` is an
    // ordinary mapping, and refusing the document over it threw away a bound
    // declared two lines below.
    //
    // But `sawRootKey` alone said "some key came before", which is not the same
    // claim: after `valid_through: 2025-12-31`, a `- documentation` line cannot
    // be a second value for a key that already has one. That document mixes a
    // mapping entry and a sequence entry at one level — a shape this reader
    // does not read — and it was answered with a certain expiry. So the sequence
    // is a child only while the last root key is still EMPTY. (Round 7.)
    if (!quotedKey && !plainKey && awaitingSequence && /^-(\s|$)/.test(line)) continue;
    if (!quotedKey && !plainKey) {
      // `? explicit`, `{flow}`, `[flow]`, `&anchor {…}`, a root sequence, a line
      // with no `:` at all. Enumerating those one at a time is what rounds 2
      // through 5 kept doing, and each round found another. The contract is
      // stated the other way round now: this reader reads a flat block mapping
      // whose keys sit at column zero, and ANYTHING else at root means it did
      // not read the document.
      unsupportedShape = true;
      continue;
    }
    // A key at column zero — whatever its spelling, including Unicode and
    // spaces. Recognising it STRUCTURALLY is separate from interpreting it:
    // tying `sawRootKey` to the ASCII subset meant `métadonnées:` did not count
    // as a parent, and its indented child was mistaken for a root node.
    sawRootKey = true;
    // A key whose value is EMPTY on its own line may take a block sequence at
    // column zero; one that already carries a value may not.
    // The two patterns do not have the same shape: a quoted key spends a group
    // on its delimiter, so its value is group 3 and a plain key's is group 2.
    awaitingSequence = yamlTrim(quotedKey ? quotedKey[3] : plainKey[2]) === '';

    if (quotedKey) {
      const [, quote, keyText, quotedRest] = quotedKey;
      // A DOUBLE-QUOTED KEY MAY BE ESCAPED, and `"valid_from"` names
      // `valid_from` without spelling it. This reader does not decode escapes,
      // so it cannot say which key that is — and classing it among foreign
      // properties made a declared bound disappear.
      if (quote === '"' && keyText.includes(String.fromCharCode(92))) {
        unsupportedShape = true;
        continue;
      }
      if (keyText === VALID_FROM || keyText === VALID_THROUGH) undetermined.add(keyText);
      // Quoted or not, a key still opens whatever its value opens.
      const rest = quotedRest.trim();
      if (BLOCK_SCALAR_RE.test(rest)) skipIndentedUntilDedent = true;
      else if (opensUnclosedQuote(rest)) insideUnclosedQuote = rest[0];
      continue;
    }

    const [, key, rest] = plainKey;

    const scalar = plainScalar(rest);
    const rawRest = rest.trim();

    // Whatever the key, a multi-line construct changes what the FOLLOWING
    // lines mean, so it is tracked even for fields we do not care about.
    if (BLOCK_SCALAR_RE.test(rawRest)) skipIndentedUntilDedent = true;
    else if (opensUnclosedQuote(rawRest)) insideUnclosedQuote = rawRest[0];

    if (key !== VALID_FROM && key !== VALID_THROUGH) continue;

    // A repeated key is a document a YAML loader would reject. Taking the last
    // one would let a second, empty occurrence erase the first one's defect.
    if (seen.has(key)) { undetermined.add(key); continue; }
    seen.add(key);

    if (scalar.undetermined) { undetermined.add(key); continue; }

    if (scalar.value !== '') {
      // A value on the line, with an indented line under it, is a folded
      // continuation: the real value is longer than what we read. Blank lines
      // and comments do not end that continuation, and looking only at the
      // very next line let either of them hide it — the date was then accepted
      // whole while the real value went on below. (Review, 2026-09-16.)
      const next = nextSignificantLine(lines, i + 1);
      if (next !== null && /^\s+\S/.test(next)) { undetermined.add(key); continue; }
      fields[key] = scalar.value;
      continue;
    }

    // Nothing on the line. Either the key is null, or its value is the block
    // below — and a block is not a date, but saying WHICH kind of non-date it
    // is would be decoding again. Undetermined covers both honestly.
    const next = nextSignificantLine(lines, i + 1);
    const belongsToKey = next !== null && (/^\s+\S/.test(next) || /^\s*-(\s|$)/.test(next));
    if (belongsToKey) undetermined.add(key);
    // else: a genuinely empty key. Absent, and certain about it — nothing to
    // record, since an absent field is an absent property.
  }

  // A ROOT SHAPE THE LOOP COULD NOT READ MEANS THE DOCUMENT WAS NOT READ.
  // Whatever the plain-key scan believes it found is discarded, because a
  // document that declares a bound twice — once plainly, once in a shape we
  // skipped — would otherwise hand back the half we happened to understand.
  if (unsupportedShape) {
    return { fields: {}, undetermined: [VALID_FROM, VALID_THROUGH] };
  }

  for (const key of undetermined) delete fields[key];
  return { fields, undetermined: [...undetermined].sort() };
}

