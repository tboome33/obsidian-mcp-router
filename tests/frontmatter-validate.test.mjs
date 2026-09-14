/**
 * Frontmatter validity — the three states, and the pre-write heuristic.
 *
 * WHY THIS FILE EXISTS. The router has EIGHT distinct ways to read a
 * frontmatter block and exactly ONE of them is a real YAML parser (Obsidian's,
 * reached over REST — the repo has no YAML dependency at all). The seven
 * others are line-oriented readers that split on the first `:` and keep the
 * rest of the line, so a block Obsidian REJECTS parses CLEANLY through them.
 * Measured 2026-09-14 on vault `roland`: for
 *
 *     title: hermes-delivery — publication des livrables dans H: (as-built)
 *
 * `llms-txt-exporter.parseFrontmatter` returns a result BYTE-IDENTICAL to the
 * one it returns for the correctly quoted twin, which is why a page Obsidian
 * showed as "Invalid properties" still carried its right title into the
 * generated OKF `index.md`. This file owns the two pieces that close that gap.
 *
 * TWO DIFFERENT EPISTEMIC STATUSES, DELIBERATELY NOT MIXED.
 *
 *   `classifyParsedFrontmatter` is CERTAIN. It does not guess: it is handed
 *   the verdict of the real parser (what Obsidian put in `frontmatter`) and
 *   only has to separate "the parser found nothing because there was nothing"
 *   from "the parser found nothing because it choked". The fence in the raw
 *   text is what separates them, and the REST layer already returns both
 *   fields — so this costs no extra round trip and cannot be wrong.
 *
 *   `detectFrontmatterDefects` is a HEURISTIC, and can only ever be one:
 *   before a PUT there is no parser to ask. Its contract is therefore
 *   asymmetric, and the asymmetry is the point — Roland's constraint is that
 *   a false positive blocking a write costs more than a false negative. It
 *   never blocks (write_file warns and writes anyway), and the tests below
 *   spend more lines on what it must NOT flag than on what it must.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FM_ABSENT,
  FM_INVALID,
  FM_OK,
  classifyParsedFrontmatter,
  detectFrontmatterDefects,
} from '../src/helpers/frontmatter-validate.mjs';

// Built, never escaped: a `\u` typed into a source file becomes the character
// itself, so special characters are CONSTRUCTED (memory: never author code
// via heredoc, never escape what you can build).
const BACKTICK = String.fromCharCode(96);
// Also built rather than written: a drive-letter path spelled out as a literal
// reads as a private path to the export gate, which scans every tracked blob
// at release time. The fixture still carries real backslashes.
const BACKSLASH = String.fromCharCode(92);

// The exact block that broke `dedibox-hermes`, reproduced 2026-09-14.
const BROKEN = [
  '---',
  'type: reference',
  'title: hermes-delivery — publication des livrables dans H: (as-built)',
  'tags:',
  '  - hermes',
  '---',
  '',
  '# Body',
  '',
].join('\n');

const QUOTED = [
  '---',
  'type: reference',
  'title: "hermes-delivery — publication des livrables dans H: (as-built)"',
  'tags:',
  '  - hermes',
  '---',
  '',
  '# Body',
  '',
].join('\n');

const NO_FRONTMATTER = '# Just a body\n\nNothing above it.\n';

describe('classifyParsedFrontmatter — the three states the router owes its callers', () => {
  // THE DEFECT THIS FILE WAS OPENED FOR. Before the fix, `get_frontmatter`
  // answered `{}` for both of the next two cases, and the caller could not
  // tell "nothing to read" from "unreadable". These two assertions are the
  // whole point; if they ever collapse back to the same value, the tool has
  // regressed to the 2026-09-14 behaviour.
  test('a block Obsidian could not parse is INVALID, not absent', () => {
    const r = classifyParsedFrontmatter(BROKEN, {});
    assert.equal(r.frontmatterStatus, FM_INVALID);
    assert.ok(r.parseError, 'an invalid block must carry a parseError');
  });

  test('a page with no block at all is ABSENT, not invalid', () => {
    const r = classifyParsedFrontmatter(NO_FRONTMATTER, {});
    assert.equal(r.frontmatterStatus, FM_ABSENT);
    assert.equal(r.parseError, null);
  });

  test('the two states are distinguishable — the regression this file guards', () => {
    const invalid = classifyParsedFrontmatter(BROKEN, {});
    const absent = classifyParsedFrontmatter(NO_FRONTMATTER, {});
    assert.notDeepEqual(invalid, absent);
  });

  test('a block the parser read is OK', () => {
    const r = classifyParsedFrontmatter(QUOTED, { type: 'reference', title: 'x' });
    assert.equal(r.frontmatterStatus, FM_OK);
    assert.equal(r.parseError, null);
  });

  // A fence with nothing meaningful inside it is NOT a parse failure: the
  // parser correctly found no keys. Calling that "invalid" would fabricate a
  // defect on a legitimate page, which is the false-positive Roland ruled
  // more costly than a miss.
  test('an EMPTY fenced block is OK, not invalid — the parser did not choke', () => {
    assert.equal(classifyParsedFrontmatter('---\n---\n\nbody\n', {}).frontmatterStatus, FM_OK);
  });

  test('a fenced block holding only comments and blanks is OK', () => {
    const onlyComments = '---\n# a comment\n\n#another\n---\n\nbody\n';
    assert.equal(classifyParsedFrontmatter(onlyComments, {}).frontmatterStatus, FM_OK);
  });

  // A `---` that never closes is not a frontmatter block at all — it is a
  // horizontal rule, or a body separator. Obsidian agrees, and so must we:
  // treating it as a broken block would flag every page that opens on a rule.
  test('an UNCLOSED opening fence is ABSENT — it is a horizontal rule, not a block', () => {
    assert.equal(classifyParsedFrontmatter('---\ntype: x\n\nbody\n', {}).frontmatterStatus, FM_ABSENT);
  });

  test('a `---` separator in the MIDDLE of a body is ABSENT', () => {
    assert.equal(
      classifyParsedFrontmatter('# Title\n\ntext\n\n---\n\nmore text\n', {}).frontmatterStatus,
      FM_ABSENT,
    );
  });

  // The parser's verdict OUTRANKS the raw text. If Obsidian returned keys,
  // the block parsed, full stop — no heuristic of ours gets to overrule it.
  test('keys returned by the real parser always win over the raw text', () => {
    const r = classifyParsedFrontmatter(BROKEN, { title: 'the parser managed' });
    assert.equal(r.frontmatterStatus, FM_OK);
  });

  test('a null/undefined parse result is treated as no keys', () => {
    assert.equal(classifyParsedFrontmatter(BROKEN, null).frontmatterStatus, FM_INVALID);
    assert.equal(classifyParsedFrontmatter(NO_FRONTMATTER, undefined).frontmatterStatus, FM_ABSENT);
  });

  test('CRLF line endings classify the same as LF', () => {
    assert.equal(
      classifyParsedFrontmatter(BROKEN.replace(/\n/g, '\r\n'), {}).frontmatterStatus,
      FM_INVALID,
    );
    assert.equal(
      classifyParsedFrontmatter('---\r\n---\r\n\r\nbody\r\n', {}).frontmatterStatus,
      FM_OK,
    );
  });

  test('a non-string content argument does not throw', () => {
    assert.equal(classifyParsedFrontmatter(null, {}).frontmatterStatus, FM_ABSENT);
    assert.equal(classifyParsedFrontmatter(undefined, {}).frontmatterStatus, FM_ABSENT);
  });
});

describe('detectFrontmatterDefects — must FLAG the real defect class', () => {
  test('the dedibox-hermes line: `: ` inside an unquoted scalar', () => {
    const found = detectFrontmatterDefects(BROKEN);
    assert.equal(found.length, 1, 'exactly one line is at fault');
    assert.match(found[0].line, /^title:/);
    assert.match(found[0].reason, /colon/i);
  });

  test('a value ending in a bare colon is flagged', () => {
    assert.equal(detectFrontmatterDefects('---\nkey: value ends here:\n---\n').length, 1);
  });

  test('several bad lines are all reported, not just the first', () => {
    const twoBad = '---\na: x: y\nb: p: q\n---\n';
    assert.equal(detectFrontmatterDefects(twoBad).length, 2);
  });

  test('an unbalanced bracket in an unquoted value is flagged', () => {
    assert.equal(detectFrontmatterDefects('---\ntags: [a, b\n---\n').length, 1);
  });
});

describe('detectFrontmatterDefects — must NOT flag legitimate content', () => {
  // These are the false positives that would make the warning noise, and
  // noise is how a warning gets ignored. Each entry is a shape that appears
  // in real vault pages.
  const MUST_STAY_SILENT = [
    ['the correctly quoted twin of the broken line', QUOTED],
    ['no frontmatter at all', NO_FRONTMATTER],
    ['a single-quoted value containing `: `', "---\ntitle: 'a: b'\n---\n"],
    ['a double-quoted value containing `: `', '---\ntitle: "a: b"\n---\n'],
    ['a URL (colon with no following space)', '---\nurl: https://example.com/x\n---\n'],
    // BUILT, not written as a literal — see the note on BACKSLASH above.
    ['a Windows path', '---\ncwd: ' + ['D:', 'Projects', 'example', 'dev'].join(BACKSLASH) + '\n---\n'],
    ['an ISO timestamp', '---\nupdated: 2026-09-14T10:30:00.000Z\n---\n'],
    ['a plain time value', '---\nat: 10:30\n---\n'],
    ['a nested mapping', '---\nparent:\n  child: value\n---\n'],
    ['a block sequence', '---\ntags:\n  - a\n  - b\n---\n'],
    ['a sequence of mappings', '---\nrefs:\n  - name: a\n    url: b\n---\n'],
    ['an inline flow mapping', '---\nmeta: {a: 1, b: 2}\n---\n'],
    ['an inline flow sequence', '---\ntags: [a, b]\n---\n'],
    ['a literal block scalar whose body holds `: `', '---\ndesc: |\n  Note: important.\n  More: here.\n---\n'],
    ['a folded block scalar whose body holds `: `', '---\ndesc: >\n  Note: important.\n---\n'],
    ['a block scalar with a chomping indicator', '---\ndesc: |-\n  Note: important.\n---\n'],
    ['a comment containing `: `', '---\nkey: value # note: this is fine\n---\n'],
    ['a full-line comment containing `: `', '---\n# note: fine\nkey: value\n---\n'],
    ['an empty fenced block', '---\n---\n\nbody\n'],
    ['a `---` separator in the body', '# T\n\na\n\n---\n\nb\n'],
    ['a fenced CODE block containing `---` in the body', '---\ntype: x\n---\n\n```\n---\nnot: frontmatter: at all\n```\n'],
    ['body text after a valid block, however hostile', QUOTED + '\nRandom: prose: with: colons everywhere\n'],
  ];

  for (const [label, content] of MUST_STAY_SILENT) {
    test('silent on ' + label, () => {
      assert.deepEqual(detectFrontmatterDefects(content), []);
    });
  }

  test('a leading-backtick value is not flagged (valid, merely ugly)', () => {
    assert.deepEqual(detectFrontmatterDefects('---\nk: "' + BACKTICK + 'x"\n---\n'), []);
  });

  test('a non-string argument returns no findings instead of throwing', () => {
    assert.deepEqual(detectFrontmatterDefects(null), []);
    assert.deepEqual(detectFrontmatterDefects(42), []);
  });
});

// ---------------------------------------------------------------------------
// Defects the adversarial review found in the FIRST version of this module.
// Each one is a case the code got wrong on 2026-09-14 before being told so.
// ---------------------------------------------------------------------------

describe('review round 1 — the flow-collection false positive', () => {
  // `bracketsUnbalanced` ran BEFORE the comment was stripped, so a comment's
  // bracket was counted against the collection.
  test('a flow sequence followed by a comment containing a bracket is silent', () => {
    assert.deepEqual(detectFrontmatterDefects('---\ntags: [a, b] # see note ]\n---\n'), []);
  });

  test('a flow mapping followed by a comment containing a brace is silent', () => {
    assert.deepEqual(detectFrontmatterDefects('---\nmeta: {a: 1} # closes }\n---\n'), []);
  });

  // …without losing the genuine case the branch exists for.
  test('a genuinely unclosed flow sequence is still flagged', () => {
    assert.equal(detectFrontmatterDefects('---\ntags: [a, b\n---\n').length, 1);
  });
});

describe('review round 2 — separation whitespace is not only a space', () => {
  test('a colon followed by a TAB is flagged like a colon followed by a space', () => {
    assert.equal(detectFrontmatterDefects('---\na: x:\ty\n---\n').length, 1);
  });
});

describe('review round 2 — what counts as a fence', () => {
  // A block scalar's payload is the one place an indented `---` reliably
  // shows up. Trimming both ends closed the block there, truncating it and
  // dropping every key below — so the module disagreed with Obsidian about
  // which text was even frontmatter.
  const INDENTED_FENCE = [
    '---',
    'desc: |',
    '  ---',
    'title: kept',
    '---',
    '',
    'body',
    '',
  ].join('\n');

  test('an indented `---` inside a block scalar does NOT close the block', () => {
    // If it closed early, `title: kept` would fall outside and the block
    // would look empty-but-fenced. It parses, so the page is healthy.
    assert.equal(
      classifyParsedFrontmatter(INDENTED_FENCE, { desc: '---', title: 'kept' }).frontmatterStatus,
      FM_OK,
    );
    assert.deepEqual(detectFrontmatterDefects(INDENTED_FENCE), []);
  });

  test('a fence with trailing whitespace still closes the block', () => {
    assert.equal(classifyParsedFrontmatter('---\nk: v\n---  \n\nbody\n', {}).frontmatterStatus, FM_INVALID);
  });

  test('an INDENTED opening fence is not a block at all', () => {
    assert.equal(classifyParsedFrontmatter('  ---\nk: v\n  ---\n', {}).frontmatterStatus, FM_ABSENT);
  });

  test('four dashes are not a fence', () => {
    assert.equal(classifyParsedFrontmatter('----\nk: v\n----\n', {}).frontmatterStatus, FM_ABSENT);
  });

  // A BOM in front of the fence is invisible to a reader and to Obsidian, but
  // a plain equality test would call the page frontmatter-less.
  test('a UTF-8 BOM before the fence does not hide the block', () => {
    const BOM = String.fromCharCode(0xfeff);
    assert.equal(classifyParsedFrontmatter(BOM + BROKEN, {}).frontmatterStatus, FM_INVALID);
    assert.equal(detectFrontmatterDefects(BOM + BROKEN).length, 1);
  });

  test('a file that is exactly one fence is absent, not a block', () => {
    assert.equal(classifyParsedFrontmatter('---', {}).frontmatterStatus, FM_ABSENT);
  });

  // The column-zero rule was meant to stop an INDENTED fence closing a block.
  // It must not also stop a CRLF document whose last line has no trailing
  // newline, which the old both-ends trim handled fine.
  test('a closing fence left with a bare CR still closes the block', () => {
    assert.equal(classifyParsedFrontmatter('---\r\nk: v\r\n---\r', {}).frontmatterStatus, FM_INVALID);
  });
});

// ---------------------------------------------------------------------------
// Round 3 attacked the REPAIRS themselves. Two of these are defects the fixes
// for round 1 and 2 introduced — the repair copying a mechanism without the
// discipline that made it safe.
// ---------------------------------------------------------------------------

describe('review round 3 — comment stripping must respect quotes', () => {
  // Moving the comment strip before the flow branch fixed one false positive
  // and created another: cutting at the first ` #` regardless of quoting
  // truncated `["a #b", c]` to `["a` and then called the brackets unbalanced.
  // This one is NOT merely advisory — it reaches an OKF conformance ERROR.
  test('a `#` inside a double-quoted flow element does not truncate the value', () => {
    assert.deepEqual(detectFrontmatterDefects('---\ntags: ["a #b", c]\n---\n'), []);
  });

  test('a `#` inside a single-quoted flow element does not truncate the value', () => {
    assert.deepEqual(detectFrontmatterDefects("---\ntags: ['a #b', c]\n---\n"), []);
  });

  test('a `#` inside a quoted plain scalar does not truncate the value', () => {
    assert.deepEqual(detectFrontmatterDefects('---\ntitle: "a #b"\n---\n'), []);
  });

  // …while a REAL trailing comment is still removed, so the rule it was moved
  // for keeps working.
  test('a genuine trailing comment after a flow collection is still ignored', () => {
    assert.deepEqual(detectFrontmatterDefects('---\ntags: [a, b] # note ]\n---\n'), []);
  });
});

describe('review round 3 — separation whitespace is space and tab, not every Unicode space', () => {
  // `\s` also matches U+00A0. YAML does not treat it as separation, so
  // `hello:<NBSP>world` is an ordinary plain scalar.
  test('a colon followed by a NON-BREAKING space is not flagged', () => {
    const NBSP = String.fromCharCode(0x00a0);
    assert.deepEqual(detectFrontmatterDefects(`---\ntitle: hello:${NBSP}world\n---\n`), []);
  });

  test('a colon followed by an ordinary space is still flagged', () => {
    assert.equal(detectFrontmatterDefects('---\ntitle: hello: world\n---\n').length, 1);
  });

  test('a colon followed by a tab is still flagged', () => {
    assert.equal(detectFrontmatterDefects('---\ntitle: hello:\tworld\n---\n').length, 1);
  });
});

describe('review round 4 — a value that is entirely a comment', () => {
  // `key: # comment` is a valid null-valued property. The comment scanner
  // only recognised a `#` preceded by whitespace, so at index zero it fell
  // through and the COMMENT TEXT was read as the value.
  test('a null value whose comment contains a colon is not flagged', () => {
    assert.deepEqual(detectFrontmatterDefects('---\ntitle: # note: retry\n---\n'), []);
  });

  test('a null value whose comment contains a bracket is not flagged', () => {
    assert.deepEqual(detectFrontmatterDefects('---\ntitle: # ]\n---\n'), []);
  });

  test('a real value is still read when a comment follows it', () => {
    assert.equal(detectFrontmatterDefects('---\ntitle: a: b # note\n---\n').length, 1);
  });
});

describe('review round 4 — trimming must not manufacture a defect', () => {
  // The narrowed colon regex was correct; `String.trim()` downstream removed
  // a significant non-breaking space and turned a valid value into one that
  // ends in a colon. The check held and normalisation defeated it.
  test('an NBSP after a colon survives comment stripping', () => {
    const NBSP = String.fromCharCode(0x00a0);
    assert.deepEqual(
      detectFrontmatterDefects(`---\ntitle: word:${NBSP} # note\n---\n`),
      [],
    );
  });

  test('a value genuinely ending in a colon before a comment is still flagged', () => {
    assert.equal(detectFrontmatterDefects('---\ntitle: word: # note\n---\n').length, 1);
  });
});

describe('review round 5 — the NBSP twin WITHOUT a comment', () => {
  // Round 4 protected the commented form and left its twin exposed: the
  // earlier `String.trim()` on the raw line and on the extracted value ate
  // the NBSP before the repaired branch ever ran. Two nearly identical
  // inputs, two different verdicts — which is how an incomplete repair reads
  // as a finished one.
  const NBSP = String.fromCharCode(0x00a0);

  test('a trailing NBSP after a colon is content, with or without a comment', () => {
    assert.deepEqual(detectFrontmatterDefects(`---\nkey: word:${NBSP}\n---\n`), []);
    assert.deepEqual(detectFrontmatterDefects(`---\nkey: word:${NBSP} # note\n---\n`), []);
  });

  test('ordinary trailing space/tab is still trimmed, so the colon rule still bites', () => {
    assert.equal(detectFrontmatterDefects('---\nkey: word:  \n---\n').length, 1);
    assert.equal(detectFrontmatterDefects('---\nkey: word:\t\n---\n').length, 1);
  });

  test('a sequence item separated by a tab is still read', () => {
    assert.equal(detectFrontmatterDefects('---\nrefs:\n  -\tname: a: b\n---\n').length, 1);
  });
});

describe('review round 6 — a lone CR must not hide what classifies the value', () => {
  // `split(/\r?\n/)` leaves a CR that has no LF after it inside the line.
  // Trimming it at the end only meant a LEADING one survived, and a leading
  // one hides the very first character — the quote, or the `|` — that decides
  // how the value is read.
  const CR = String.fromCharCode(13);

  test('a leading lone CR does not hide a quoted value', () => {
    assert.deepEqual(detectFrontmatterDefects(`---\ntitle: ${CR}  "hello: world"\n---\n`), []);
  });

  test('a leading lone CR does not hide a flow collection', () => {
    assert.deepEqual(detectFrontmatterDefects(`---\ntags: ${CR}  [a, b]\n---\n`), []);
  });

  // These two ASSERTED THE WRONG THING while a lone CR was being kept inside
  // a line. Round 7 made it a line break, which is what it is — so
  // `title: <CR>  hello: world` is not one value carrying a stray CR, it is
  // a null `title:` followed by a sibling `hello: world`. That document is
  // VALID, and reporting a defect on it would be a false positive. The
  // expectation moved because the reading was corrected, not because the rule
  // was weakened — the no-CR twin below still bites.
  test('a lone CR separates two properties, and two valid properties are silent', () => {
    assert.deepEqual(detectFrontmatterDefects(`---\ntitle: ${CR}  hello: world\n---\n`), []);
  });

  test('the same text WITHOUT the CR is one broken value, and is flagged', () => {
    assert.equal(detectFrontmatterDefects('---\ntitle: hello: world\n---\n').length, 1);
  });
});

describe('review round 7 — a lone CR is a LINE BREAK, and indentation is not any whitespace', () => {
  const CR = String.fromCharCode(13);
  const LS = String.fromCharCode(0x2028); // Unicode line separator

  // Round 6 stopped a lone CR hiding a value's leading character, and in
  // doing so let it pose as INDENTATION instead: the line after it looked
  // like block-scalar payload and was skipped, so its defect went unseen.
  // A miss rather than a false positive, but a miss the detector had before.
  test('a property after a lone CR inside a block scalar is still inspected', () => {
    const content = `---\ndesc: ${CR}  |\n${CR}title: bad: value\n---\n`;
    const found = detectFrontmatterDefects(content);
    assert.equal(found.length, 1);
    assert.match(found[0].line, /^title:/, 'the defect must be reported on the property, not swallowed');
  });

  test('U+2028 is content, not indentation, so the line after it is inspected', () => {
    const content = `---\ndesc: |\n${LS}title: bad: value\n---\n`;
    assert.equal(detectFrontmatterDefects(content).length, 1);
  });

  // The conservative half: a genuinely indented payload is still payload, so
  // a block scalar full of colons stays silent.
  test('a properly indented block-scalar payload is still skipped', () => {
    assert.deepEqual(
      detectFrontmatterDefects('---\ndesc: |\n  Note: important: text\n  More: here\ntitle: ok\n---\n'),
      [],
    );
  });

  test('a TAB-indented payload line is still treated as payload, not as a broken key', () => {
    assert.deepEqual(detectFrontmatterDefects('---\ndesc: |\n\tNote: important: text\n---\n'), []);
  });

  test('a CR-only document still finds its fences', () => {
    assert.equal(
      classifyParsedFrontmatter(`---${CR}title: a: b${CR}---${CR}${CR}body${CR}`, {}).frontmatterStatus,
      FM_INVALID,
    );
  });
});
