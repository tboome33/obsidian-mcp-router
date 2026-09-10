/**
 * The conventions picker that never looked, and the cut that destroyed a file.
 *
 * MEASURED 2026-09-11 on router 0.94.1, creating the vault `La méthode LICARES`
 * from the reference template: the wizard offered eight conventions, the user
 * kept six and unchecked `bilingual` and `auto-enrichment`, and the vault's
 * `Documentation/CLAUDE.md` afterwards contained all eight — because the
 * template ships all eight and nothing had read the file. Removing `bilingual`
 * by hand then found the second half of the defect: the documented cut stops at
 * a `## ` displayed INSIDE that snippet's fenced example.
 *
 * THE FIXTURES ARE THE REAL SNIPPETS, not a hand-written stand-in. The bug lives
 * in the interaction between the cut and the text the library actually ships —
 * a fixture that omitted the fenced example would have gone green on the broken
 * code. Every sweep below asserts its own DENOMINATOR, so a glob that silently
 * returns nothing fails instead of passing vacuously.
 *
 * ONE TEST HERE IS A REPRODUCTION, and it is honest about what it reproduces:
 * the old behaviour was never code, it was a paragraph of the `conventions`
 * skill. `naiveDetect` / `naiveRemove` implement that paragraph literally, and
 * are asserted to produce the damage that was measured. They are the "fails on
 * the current code" witness, transposed to a defect whose implementation was
 * prose.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_MD_CANDIDATES,
  resolveClaudeMd,
  findConventionSection,
  isConventionInstalled,
  removeConvention,
  verifyRemoval,
  detectConventions,
  planConventionPicker,
} from '../src/helpers/claude-md-conventions.mjs';
import { scanAtxHeadings } from '../src/helpers/markdown-headings.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNIPPET_DIR = path.join(REPO_ROOT, 'skills', 'conventions', 'snippets');

/** The eight the attach wizard's picker offers, in its own order. */
const PICKER_IDS = [
  'roadmap-discipline',
  'default-vault-health-check',
  'wiki-query-first',
  'path-disambiguation',
  'source-type',
  'bilingual',
  'heading-hierarchy',
  'auto-enrichment',
];

/**
 * A snippet's text with LF line endings, whatever the checkout did to it.
 *
 * MEASURED ON CI, not guessed: the Windows runners check these files out with
 * CRLF (`core.autocrlf`), and three tests below reason about line CONTENT — the
 * documented naive cut compares a line to `## <heading>`, and one assertion
 * reads a line out of the fixture by index. A stray `\r` makes the naive cut
 * match nothing, which silently turns the whole REPRODUCTION group into a
 * vacuous pass, and made two assertions fail outright on 2026-09-11.
 *
 * The production scanner is CRLF-safe and has its own witnesses for that
 * (`tests/markdown-headings.test.mjs` builds CRLF and lone-CR documents from
 * literals, which no checkout can rewrite). What is normalised here is the
 * FIXTURE, so that these tests measure the rule they are about rather than the
 * line endings of the machine they run on.
 */
function snippetBody(id) {
  return fs.readFileSync(path.join(SNIPPET_DIR, `${id}.md`), 'utf8').replace(/\r\n/g, '\n');
}

function headingOf(id) {
  const first = snippetBody(id).split(/\r?\n/).find((l) => l.startsWith('## '));
  assert.ok(first, `snippet ${id} has no identifying H2`);
  return first.slice(3).trim();
}

const CATALOGUE = PICKER_IDS.map((id) => ({ id, heading: headingOf(id) }));

/** A `CLAUDE.md` shaped like the one the template ships: all eight, appended. */
function templateClaudeMd() {
  return `# Vault conventions\n\nPreamble prose.\n\n${
    PICKER_IDS.map((id) => snippetBody(id).replace(/\s*$/, '')).join('\n\n')
  }\n`;
}

/** Column-0 fence lines — an odd count means a block was left open. */
function fenceLines(text) {
  return text.split(/\r?\n/).filter((l) => /^(`{3,}|~{3,})/.test(l)).length;
}

// ---------------------------------------------------------------------------
// The guard for the scanner's one documented blind spot: fences are tracked at
// column 0 only (every widening broke a v0.92.0 witness — see
// src/helpers/markdown-headings.mjs). A heading-shaped line inside an INDENTED
// fenced block is therefore read as structure. This walker finds those lines in
// the shipped library, and it tracks what the production scanner deliberately
// does not: an opener after a list marker, the delimiter's character AND
// length, and a closer that must carry nothing after it. Its own witnesses are
// in "the corpus guard itself catches the shapes it exists for" — a guard with
// no test of its own is a green light nobody checked.
// ---------------------------------------------------------------------------
function walkIndentedFences(text) {
  const lines = text.split(/\r?\n/);
  const hidden = [];
  let entered = 0;
  let char = null;
  let len = 0;
  for (const [i, line] of lines.entries()) {
    const plain = /^([ \t]{1,3})(`{3,}|~{3,})(.*)$/.exec(line);
    const listed = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(`{3,}|~{3,})(.*)$/.exec(line);
    const anyFence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);

    if (char === null) {
      const open = plain ? { d: plain[2], info: plain[3] } : (listed ? { d: listed[1], info: listed[2] } : null);
      if (open && !(open.d[0] === '`' && open.info.includes('`'))) {
        char = open.d[0];
        len = open.d.length;
        entered += 1;
      }
      continue;
    }

    if (anyFence && anyFence[1][0] === char && anyFence[1].length >= len && /^[ \t]*$/.test(anyFence[2])) {
      char = null;
      len = 0;
      continue;
    }
    // `##` with no text is a heading too — the offender regex must not require
    // a separator it does not need.
    if (/^ {0,3}#{1,6}([ \t]|$)/.test(line)) hidden.push({ line: i + 1, text: line.trim() });
  }
  return { hidden, entered };
}

const headingsHidingInIndentedFences = (text) => walkIndentedFences(text).hidden;
const countIndentedFences = (text) => walkIndentedFences(text).entered;

// ---------------------------------------------------------------------------
// The rule the skill documented until v0.94.3, implemented to the letter:
// "check if the snippet's H2 heading already appears in the content", and
// "from the H2 line through the line before the NEXT H2 heading".
// ---------------------------------------------------------------------------
function naiveDetect(content, heading) {
  return content.includes(`## ${heading}`);
}

function naiveRemove(content, heading) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l === `## ${heading}`);
  if (start === -1) return content;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

describe('the fixture is the real library', () => {
  test('all eight picker snippets exist and carry a distinct identity', () => {
    assert.equal(CATALOGUE.length, 8);
    assert.equal(new Set(CATALOGUE.map((c) => c.heading)).size, 8);
  });

  test('the corpus guard itself catches the shapes it exists for', () => {
    // Round 2 found the first version of this guard missing its own motivating
    // case: it ignored a list-marker opener, then read the closer as an opener.
    // It also closed a four-backtick block on a literal triple, and closed a
    // tilde block on a line with trailing words. Each is a way for a heading to
    // hide from a guard whose whole job is to find one.
    const cases = [
      ['list-marker opener', '- ```markdown\n  ## Hidden\n  ```\n', 1],
      ['four-backtick nesting', '  ````markdown\n  ```\n ## Hidden\n  ````\n', 1],
      ['tilde with trailing words', '  ~~~\n  ~~~ trailing words\n ## Hidden\n  ~~~\n', 1],
      ['bare hashes', '  ```\n ##\n  ```\n', 1],
      ['plain indented fence, nothing inside', '   ```\n{"a": 1}\n   ```\n', 0],
      ['column-0 fence is not this guard\'s business', '```\n## Shown\n```\n', 0],
    ];
    for (const [label, text, expected] of cases) {
      assert.equal(headingsHidingInIndentedFences(text).length, expected, label);
    }
  });

  test('no snippet hides a `## ` inside an INDENTED fence', () => {
    // The scanner tracks fences at column 0 only — every attempt to widen that
    // broke a v0.92.0 witness (see markdown-headings.mjs). The residual risk is
    // a heading-looking line inside an indented fenced block, which the scanner
    // would read as structure. Four indented fences ship in the library today
    // (`default-vault-health-check.md` has two); none contains such a line.
    // This scan is what keeps that true, and it asserts its own denominator so
    // a glob that finds nothing cannot pass vacuously.
    let scanned = 0;
    let entered = 0;
    const offenders = [];
    for (const id of fs.readdirSync(SNIPPET_DIR).filter((f) => f.endsWith('.md'))) {
      scanned += 1;
      const body = fs.readFileSync(path.join(SNIPPET_DIR, id), 'utf8');
      entered += countIndentedFences(body);
      offenders.push(...headingsHidingInIndentedFences(body).map((h) => `${id}:${h.line} ${h.text}`));
    }
    assert.ok(scanned >= 12, `expected the whole library, scanned ${scanned}`);
    // One such block ships today (`default-vault-health-check.md`, a JSON
    // example inside a numbered list item). The denominator is what stops this
    // test from passing because it found nothing to look at.
    assert.ok(entered >= 1, `the scan must actually enter an indented fence, entered ${entered}`);
    assert.deepEqual(offenders, [],
      'a heading inside an indented fence is invisible to the scanner — unindent the fence');
  });

  test('the bilingual snippet still displays `## ` lines inside a fence', () => {
    // If this ever stops being true, the fence tests below stop testing
    // anything — and would go green on a fence-ignorant cut.
    const fenced = scanAtxHeadings(snippetBody('bilingual')).map((h) => h.text);
    assert.ok(!fenced.some((t) => t.includes('Version française')),
      'the scanner must not see the fenced example headings');
    assert.ok(snippetBody('bilingual').includes('## 🇫🇷 Version française'),
      'the fenced example headings must still be in the snippet');
  });
});

describe('REPRODUCTION — what the documented rule did', () => {
  const doc = templateClaudeMd();
  const bilingual = headingOf('bilingual');

  test('the naive cut leaves most of the convention it claims to have removed', () => {
    const after = naiveRemove(doc, bilingual);
    // Named remnants, unique to THIS convention — `### Rules` alone would not
    // prove which section survived (a review finding on the first version).
    const remnants = [
      '### Short pages (under ~500 words)',
      '### When the user writes only in one language',
      '**Both sections complete**',
    ];
    for (const r of remnants) {
      assert.ok(after.includes(r), `the naive cut left behind: ${r}`);
    }
    // And it is most of the section, not a stray line: measure it.
    const whole = findConventionSection(doc, bilingual).text.split('\n').length;
    const cut = doc.split('\n').length - after.split('\n').length;
    assert.ok(cut < whole / 2,
      `the naive cut removed ${cut} of the section's ${whole} lines — it stopped at the fenced example`);
    assert.ok(naiveDetect(doc, bilingual), 'and it had reported the convention installed');
  });

  test('the naive cut severs the fence, leaving an unterminated code block', () => {
    const after = naiveRemove(doc, bilingual);
    assert.equal(fenceLines(doc) % 2, 0, 'the fixture starts balanced');
    assert.equal(fenceLines(after) % 2, 1, 'the naive cut left an odd number of fences');
  });

  test('the fixed cut does neither', () => {
    const { content: after, removed } = removeConvention(doc, bilingual);
    assert.equal(removed, true);
    assert.ok(!after.includes('### Short pages (under ~500 words)'),
      'the whole section must be gone');
    assert.equal(fenceLines(after) % 2, 0, 'fences stay balanced');
  });

  test('the same cut on a CRLF document gives the same result, line endings apart', () => {
    // The CI failure of 2026-09-11 in witness form. The Windows runners check
    // the snippets out with CRLF, and the FIXTURE helper above normalises that
    // away so these tests measure their own rule — which would hide a real CRLF
    // defect in the production helpers if nothing checked it. This does: same
    // document, CRLF endings, and the cut must land on the same bytes.
    const heading = headingOf('bilingual');
    const crlf = doc.replace(/\n/g, '\r\n');
    assert.notEqual(crlf, doc, 'the CRLF fixture must really differ');

    assert.equal(isConventionInstalled(crlf, heading), true);
    const out = removeConvention(crlf, heading);
    assert.equal(out.removed, true);
    assert.equal(out.content, removeConvention(doc, heading).content.replace(/\n/g, '\r\n'));
    assert.deepEqual(
      verifyRemoval({ before: crlf, after: out.content, heading, catalogue: CATALOGUE }),
      { ok: true, problems: [] },
    );
  });

  test('the neighbouring conventions survive the cut, byte for byte', () => {
    const { content: after } = removeConvention(doc, headingOf('bilingual'));
    const survivors = CATALOGUE.filter((c) => c.id !== 'bilingual');
    assert.equal(survivors.length, 7);
    for (const c of survivors) {
      assert.equal(isConventionInstalled(after, c.heading), true, `${c.id} must survive`);
      const section = findConventionSection(after, c.heading);
      const original = findConventionSection(doc, c.heading);
      assert.equal(section.text, original.text, `${c.id} must be untouched`);
    }
  });
});

describe('findConventionSection — identity, not resemblance', () => {
  const doc = templateClaudeMd();

  test('extra whitespace around the heading still matches', () => {
    const spaced = doc.replace(
      `## ${headingOf('bilingual')}`,
      `##   ${headingOf('bilingual')}   `,
    );
    assert.equal(isConventionInstalled(spaced, headingOf('bilingual')), true);
  });

  test('ATX closing hashes still match', () => {
    const closed = doc.replace(
      `## ${headingOf('source-type')}`,
      `## ${headingOf('source-type')} ##`,
    );
    assert.equal(isConventionInstalled(closed, headingOf('source-type')), true);
  });

  test('a similarly-named heading of the user\'s own does NOT match', () => {
    const other = '## Bilingual convention de test\n\nMy own note.\n\n## Next\n\nx\n';
    assert.equal(isConventionInstalled(other, 'Bilingual convention (FR + EN, FR primary)'), false);
    // And the reverse direction: the identity must not match a shorter heading.
    assert.equal(isConventionInstalled('## Bilingual\n\nx\n', headingOf('bilingual')), false);
  });

  test('a heading that EXTENDS the identity does not match it either', () => {
    // The prefix trap, and the expensive one: this is the user's own section,
    // named after the convention. A `startsWith` (or the `includes()` the skill
    // used to specify) calls it installed — and `remove` then deletes it.
    const mine = `## ${headingOf('bilingual')} — mes ajouts\n\nMy own rules.\n\n## After\n\nx\n`;
    assert.equal(isConventionInstalled(mine, headingOf('bilingual')), false);
    assert.equal(removeConvention(mine, headingOf('bilingual')).content, mine);
  });

  test('the identity buried inside a longer heading does not match', () => {
    const mine = `## Notes about ${headingOf('bilingual')}\n\nx\n`;
    assert.equal(isConventionInstalled(mine, headingOf('bilingual')), false);
  });

  test('the heading may be passed with or without its hashes', () => {
    const a = findConventionSection(doc, headingOf('bilingual'));
    const b = findConventionSection(doc, `## ${headingOf('bilingual')}`);
    assert.equal(a.start, b.start);
    assert.equal(a.end, b.end);
  });

  test('a convention DOCUMENTED inside a fence is not installed', () => {
    const doc2 = `# Notes\n\n\`\`\`markdown\n## ${headingOf('bilingual')}\n\nexample\n\`\`\`\n`;
    assert.equal(isConventionInstalled(doc2, headingOf('bilingual')), false);
  });

  test('an indented heading is not a section of this file', () => {
    const doc2 = `# Notes\n\n- quoted:\n  ## ${headingOf('bilingual')}\n\ntext\n`;
    assert.equal(isConventionInstalled(doc2, headingOf('bilingual')), false);
  });

  test('the section ends at the next heading of the same level or higher', () => {
    const doc2 = [
      '## Alpha', '', 'a', '', '### Alpha sub', '', 'sub body', '',
      '## Beta', '', 'b', '',
    ].join('\n');
    const found = findConventionSection(doc2, 'Alpha');
    assert.ok(found.text.includes('### Alpha sub'), 'subsections belong to the section');
    assert.ok(!found.text.includes('## Beta'));

    const withH1 = doc2.replace('## Beta', '# Beta');
    const found2 = findConventionSection(withH1, 'Alpha');
    assert.ok(!found2.text.includes('Beta'), 'an H1 ends the section too');
  });

  test('the cut removes exactly the section bytes and nothing else', () => {
    // Byte-exactness, with blank-line runs on both sides of the seam so that
    // any "tidying" of the boundary shows up. The standing anti-pattern is that
    // a remove which trims whitespace has started editing its neighbours.
    const doc2 = '## Alpha\n\n\n\nspaced body\n\n\n## Beta\n\n\n\nkeep\n';
    const found = findConventionSection(doc2, 'Alpha');
    const { content: after } = removeConvention(doc2, 'Alpha');
    assert.equal(after, doc2.slice(0, found.start) + doc2.slice(found.end));
    assert.ok(after.includes('\n\n\n'), 'blank-line runs elsewhere are left alone');
  });

  test('the last section runs to end of file', () => {
    const doc2 = '## Alpha\n\na\n\n## Omega\n\nlast\n';
    const { content: after, removed } = removeConvention(doc2, 'Omega');
    assert.equal(removed, true);
    assert.equal(after, '## Alpha\n\na\n\n');
  });

  test('removing an absent convention changes nothing and says so', () => {
    const { content: after, removed, section, reason } = removeConvention(doc, 'Nothing like this');
    assert.equal(removed, false);
    assert.equal(section, null);
    assert.equal(reason, 'not-installed');
    assert.equal(after, doc);
  });

  test('an H1 spelled like the convention is NOT the convention', () => {
    // The worst counterexample review produced: the hashes were stripped before
    // comparing, so an H1 matched — and its "section" ran to the end of the
    // file, which `remove` then deleted in full.
    const doc2 = `# ${headingOf('bilingual')}\n\nMy document.\n\n## Personal material\n\nKeep this.\n`;
    assert.equal(isConventionInstalled(doc2, headingOf('bilingual')), false);
    const out = removeConvention(doc2, `## ${headingOf('bilingual')}`);
    assert.equal(out.removed, false);
    assert.equal(out.content, doc2);
  });

  test('an INDENTED heading still stops the cut', () => {
    // Identity is narrow, the boundary is wide: a heading the user indented is
    // their section, and a cut that runs through it eats their writing.
    const doc2 = ['## Alpha', 'Convention rules.', '', '  ## Personal rules', 'Keep this writing.', '', '## Beta', 'Other.', ''].join('\n');
    const { content: after, removed } = removeConvention(doc2, 'Alpha');
    assert.equal(removed, true);
    assert.ok(after.includes('## Personal rules'));
    assert.ok(after.includes('Keep this writing.'));
    assert.ok(!after.includes('Convention rules.'));
  });

  test('a SETEXT heading stops the cut too', () => {
    const doc2 = ['## Alpha', 'Convention rules.', '', 'Personal rules', '==============', 'Keep this writing.', '', '## Beta', ''].join('\n');
    const { content: after, removed } = removeConvention(doc2, 'Alpha');
    assert.equal(removed, true);
    assert.ok(after.startsWith('Personal rules\n'), `got: ${JSON.stringify(after.slice(0, 40))}`);
    assert.ok(after.includes('Keep this writing.'));
  });

  test('YAML frontmatter is not a setext heading', () => {
    // The one setext candidate in the real corpus is the template's frontmatter
    // terminator. Reading it as a heading would end the first section at the
    // top of the file.
    const doc2 = ['---', 'type: conventions', '', 'updated: 2026-05-03', '---', '', '## Alpha', 'body', '', '## Beta', ''].join('\n');
    const found = findConventionSection(doc2, 'Alpha');
    assert.equal(found.found, true);
    assert.ok(found.text.includes('body'));
    assert.ok(!found.text.includes('Beta'));
  });


  test('a convention appearing TWICE refuses to be cut', () => {
    const doc2 = ['## Alpha', 'first copy', '', '## Beta', 'keep', '', '## Alpha', 'second copy', ''].join('\n');
    const found = findConventionSection(doc2, 'Alpha');
    assert.equal(found.occurrences, 2);
    const out = removeConvention(doc2, 'Alpha');
    assert.equal(out.removed, false);
    assert.equal(out.reason, 'duplicate-identity');
    assert.equal(out.content, doc2, 'nothing is cut until the user says which copy is theirs');
    assert.deepEqual(detectConventions(doc2, [{ id: 'alpha', heading: 'Alpha' }])[0].duplicate, true);
    assert.deepEqual(found.lines, [1, 7], 'the refusal names both occurrences so the user can choose');
  });

  test('and once the user has chosen, that occurrence is cut', () => {
    // A refusal with no continuation is a dead end (round 2). The answer goes
    // back in as `occurrence`, and verification is told a copy is meant to stay.
    const doc2 = ['## Alpha', 'first copy', '', '## Beta', 'keep', '', '## Alpha', 'second copy', ''].join('\n');
    const out = removeConvention(doc2, 'Alpha', { occurrence: 2 });
    assert.equal(out.removed, true);
    assert.ok(out.content.includes('first copy'));
    assert.ok(!out.content.includes('second copy'));
    const verdict = verifyRemoval({
      before: doc2, after: out.content, heading: 'Alpha', occurrence: 2, expectAbsent: false,
    });
    assert.deepEqual(verdict, { ok: true, problems: [] });
  });

  test('an occurrence nobody has is refused, not clamped', () => {
    const doc2 = '## Alpha\nonly copy\n';
    const out = removeConvention(doc2, 'Alpha', { occurrence: 3 });
    assert.equal(out.removed, false);
    assert.equal(out.reason, 'no-such-occurrence');
    assert.equal(out.content, doc2);
  });

  test('a non-breaking space before closing hashes is NOT a closing sequence', () => {
    const nbsp = String.fromCharCode(160);
    const doc2 = `## Alpha${nbsp}##\n\nSomebody else's section.\n`;
    assert.equal(isConventionInstalled(doc2, 'Alpha'), false);
    assert.equal(removeConvention(doc2, 'Alpha').content, doc2);
  });

  test('junk input does not throw', () => {
    assert.equal(findConventionSection(null, 'x').found, false);
    assert.equal(findConventionSection('## x\n', '').found, false);
    assert.equal(findConventionSection('## x\n', null).found, false);
  });
});

describe('planConventionPicker — the four things that can happen', () => {
  const doc = templateClaudeMd();

  test('THE BUG: unchecking a PRESENT convention is reported, not swallowed', () => {
    const selected = PICKER_IDS.filter((id) => id !== 'bilingual' && id !== 'auto-enrichment');
    assert.equal(selected.length, 6, 'six of eight, as measured');

    const plan = planConventionPicker({ content: doc, catalogue: CATALOGUE, selected });

    assert.deepEqual(plan.remove.map((r) => r.id).sort(), ['auto-enrichment', 'bilingual']);
    assert.equal(plan.install.length, 0, 'the template already shipped every one of them');
    assert.equal(plan.keep.length, 6, 'and the six positives are no-ops, honestly labelled');
    assert.equal(plan.skip.length, 0);
    assert.match(plan.plan, /^planned: /, 'the line must announce itself as intentions, not results');
    assert.match(plan.plan, /0 to install/);
    assert.match(plan.plan, /6 already in place/);
    assert.match(plan.plan, /2 unchecked but present/);
  });

  test('and confirming the removal actually removes both, intact', () => {
    const selected = PICKER_IDS.filter((id) => id !== 'bilingual' && id !== 'auto-enrichment');
    const plan = planConventionPicker({ content: doc, catalogue: CATALOGUE, selected });

    let content = doc;
    for (const entry of plan.remove) {
      const out = removeConvention(content, entry.heading);
      assert.equal(out.removed, true, entry.id);
      content = out.content;
    }
    assert.equal(isConventionInstalled(content, headingOf('bilingual')), false);
    assert.equal(isConventionInstalled(content, headingOf('auto-enrichment')), false);
    assert.equal(fenceLines(content) % 2, 0);
    for (const id of selected) {
      assert.equal(isConventionInstalled(content, headingOf(id)), true, `${id} kept`);
    }
  });

  test('verifyRemoval catches a cut that damaged the file', () => {
    const heading = headingOf('bilingual');
    const good = removeConvention(doc, heading).content;
    assert.deepEqual(verifyRemoval({ before: doc, after: good, heading, catalogue: CATALOGUE }),
      { ok: true, problems: [] });

    // The measured damage: the naive cut leaves the target installed AND opens
    // a fence, which hides every convention below it.
    const bad = naiveRemove(doc, heading);
    const verdict = verifyRemoval({ before: doc, after: bad, heading, catalogue: CATALOGUE });
    assert.equal(verdict.ok, false);
    // The naive cut DOES take the identity line with it — so "is the target
    // gone?" alone would have passed it. What catches the damage is the other
    // question: the severed fence swallows the conventions below, and they stop
    // being detectable.
    assert.ok(verdict.problems.some((p) => p.includes('no longer detectable')), JSON.stringify(verdict.problems));
  });

  test('verifyRemoval catches a cut that left the target installed', () => {
    // The other failure shape, on its own witness: a "removal" that changed
    // something else entirely.
    const heading = headingOf('bilingual');
    const after = doc.replace('Preamble prose.\n\n', '');
    assert.notEqual(after, doc, 'the fixture must really have shrunk');
    const verdict = verifyRemoval({ before: doc, after, heading, catalogue: CATALOGUE });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.problems.filter((p) => p.includes('removed nothing')), []);
    assert.ok(verdict.problems.some((p) => p.includes('still installed')), JSON.stringify(verdict.problems));
  });

  test('verifyRemoval does not demand the presence of conventions that were absent', () => {
    const partial = `# Vault\n\n${snippetBody('source-type').replace(/\s*$/, '')}\n\n${snippetBody('bilingual').replace(/\s*$/, '')}\n`;
    const heading = headingOf('bilingual');
    const after = removeConvention(partial, heading).content;
    const verdict = verifyRemoval({ before: partial, after, heading, catalogue: CATALOGUE });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
  });

  test('verifyRemoval rejects the deletion of a section NOBODY catalogued', () => {
    // Round 2's sharpest finding: the catalogue pass protects conventions, and
    // a user's own prose is not a convention. The splice check is what makes
    // this fail — the result is not `before` minus the located range.
    const before = '## Alpha\nRemove me.\n\n## Personal\nIrreplaceable writing.\n\n## Beta\nKeep me.\n';
    const after = '## Beta\nKeep me.\n';
    const verdict = verifyRemoval({
      before,
      after,
      heading: 'Alpha',
      catalogue: [{ id: 'alpha', heading: 'Alpha' }, { id: 'beta', heading: 'Beta' }],
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => p.includes('outside the cut')), JSON.stringify(verdict.problems));
  });

  test('verifyRemoval accepts a heading written with or without its hashes', () => {
    // Two identity parsers rejected a correct removal: the target was stripped
    // of its hashes and the catalogue entries were not.
    const before = '## Alpha\nRemove.\n\n## Beta\nKeep.\n';
    const after = '## Beta\nKeep.\n';
    const verdict = verifyRemoval({
      before,
      after,
      heading: '## Alpha',
      catalogue: [{ id: 'alpha', heading: '## Alpha' }, { id: 'beta', heading: '## Beta' }],
    });
    assert.deepEqual(verdict, { ok: true, problems: [] });
  });

  test('a cut that removes nothing is reported as a problem', () => {
    const heading = headingOf('bilingual');
    const verdict = verifyRemoval({ before: doc, after: doc, heading, catalogue: CATALOGUE });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => p.includes('removed nothing')));
  });

  test('unchecking an ABSENT convention is a true no-op, not a removal', () => {
    const empty = '# Fresh vault\n\nNothing installed yet.\n';
    const plan = planConventionPicker({
      content: empty,
      catalogue: CATALOGUE,
      selected: ['source-type'],
    });
    assert.equal(plan.remove.length, 0, 'nothing is there to remove');
    assert.deepEqual(plan.install.map((i) => i.id), ['source-type']);
    assert.equal(plan.skip.length, 7);
    assert.equal(plan.keep.length, 0);
  });

  test('a missing conventions file reads as "nothing installed", not as an error', () => {
    const plan = planConventionPicker({ catalogue: CATALOGUE, selected: PICKER_IDS });
    assert.equal(plan.install.length, 8);
    assert.equal(plan.remove.length, 0);
  });

  test('an id nobody ships is reported rather than silently dropped', () => {
    const plan = planConventionPicker({
      content: templateClaudeMd(),
      catalogue: CATALOGUE,
      selected: ['source-type', 'invented-convention'],
    });
    assert.deepEqual(plan.unknown, ['invented-convention']);
  });

  test('detectConventions reports the line, so the user can find it', () => {
    const state = detectConventions(doc, CATALOGUE);
    assert.equal(state.length, 8);
    const bilingual = state.find((s) => s.id === 'bilingual');
    assert.equal(bilingual.installed, true);
    assert.equal(doc.split('\n')[bilingual.line - 1], `## ${headingOf('bilingual')}`);
    for (const s of state) assert.equal(typeof s.installed, 'boolean');
  });
});

describe('resolveClaudeMd — where the conventions file is', () => {
  test('the canonical order is root, wiki-meta, Documentation', () => {
    assert.deepEqual([...CLAUDE_MD_CANDIDATES],
      ['CLAUDE.md', 'wiki-meta/CLAUDE.md', 'Documentation/CLAUDE.md']);
  });

  test('a vault whose only file is under Documentation/ resolves to it', () => {
    // The measured shape of this fleet — and the one a bare `get_file("CLAUDE.md")`
    // reports as 404, concludes "not installed", and answers with a SECOND
    // conventions file at the root.
    const r = resolveClaudeMd(['Documentation/CLAUDE.md']);
    assert.equal(r.path, 'Documentation/CLAUDE.md');
    assert.equal(r.ambiguous, false);
  });

  test('two conventions files are AMBIGUOUS, and there is no path to act on', () => {
    const r = resolveClaudeMd(['Documentation/CLAUDE.md', 'CLAUDE.md']);
    assert.equal(r.path, null, 'a usable path beside ambiguous:true invites the accident');
    assert.equal(r.ambiguous, true);
    assert.deepEqual(r.present, ['CLAUDE.md', 'Documentation/CLAUDE.md']);
  });

  test('none present: no path, and a documented place to create one', () => {
    const r = resolveClaudeMd([]);
    assert.equal(r.path, null);
    assert.equal(r.ambiguous, false);
    assert.equal(r.createAt, 'CLAUDE.md');
  });

  test('separators and `./` prefixes do not hide a candidate', () => {
    assert.equal(resolveClaudeMd(['Documentation\\CLAUDE.md']).path, 'Documentation/CLAUDE.md');
    assert.equal(resolveClaudeMd(['./wiki-meta/CLAUDE.md']).path, 'wiki-meta/CLAUDE.md');
  });

  test('unrelated files are not conventions files', () => {
    assert.equal(resolveClaudeMd(['wiki/CLAUDE.md', 'README.md', null, 7]).path, null);
  });
});

describe('the two definitions of the search order agree', () => {
  test('setup-vault.mjs lists exactly these candidates', () => {
    // NOT a claim of a single source of truth — review was right to say so.
    // `scripts/setup-vault.mjs` still hard-codes its own copy (it was being
    // edited in another session when this shipped). This test is the guard that
    // makes the two copies fail loudly the moment they disagree, which is the
    // sweep this repository has had to run four times for other defect classes.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'setup-vault.mjs'), 'utf8');
    const fn = /function findClaudeMdCandidates[\s\S]*?\n}/.exec(src);
    assert.ok(fn, 'findClaudeMdCandidates must still exist — if it was renamed, re-aim this scan');

    const joined = [...fn[0].matchAll(/path\.join\(vaultPath,\s*([^)]*)\)/g)]
      .map((m) => m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).join('/'));
    assert.equal(joined.length, CLAUDE_MD_CANDIDATES.length,
      `expected ${CLAUDE_MD_CANDIDATES.length} candidates, found ${joined.length}`);
    assert.deepEqual(joined, [...CLAUDE_MD_CANDIDATES]);
  });
});
