import test from 'node:test';
import assert from 'node:assert/strict';

import { hitPagePath, hitPathCandidates, isAmbiguousHitPath } from '../src/helpers/hit-page-path.mjs';

// The shapes below are not invented: they were copied from what the TradingView
// vault's `/search/smart` returned on 2026-09-15, which is the measurement that
// found the defect this module repairs.
const REAL_BLOCK = "Indicators/analyse-technique-pro/Modules.md#Modules — comment l'indicateur fonctionne#L'idée en une phrase#{1}";
const REAL_HEADING = "Indicators/analyse-technique-pro/Modules.md#Modules — comment l'indicateur fonctionne";
const REAL_PAGE = 'Indicators/analyse-technique-pro/Modules.md';

/**
 * THE TABLE IS THE TEST.
 *
 * Every expectation below is written out as a literal, never derived from the
 * helper under test. The first version of this file asserted that each
 * candidate "could be a note" with `endsWith('.md') || candidate ===
 * hitPagePath(raw)` — and the second half of that disjunction admitted exactly
 * the candidates the property claimed to forbid, so the witness stayed green
 * with the rule removed. Caught by the adversarial review of 2026-09-16, and
 * the lesson is not "fix the assertion": it is that a property checked against
 * the implementation is not a property.
 */
const CASES = [
  // [ raw path, page, candidates, ambiguous? , why ]
  [REAL_BLOCK, REAL_PAGE, [REAL_PAGE], false, 'a real block key from a real vault'],
  [REAL_HEADING, REAL_PAGE, [REAL_PAGE], false, 'the same page, addressed by heading'],
  [REAL_PAGE, REAL_PAGE, [REAL_PAGE], false, 'a plain page addresses itself'],
  ['wiki/a.md', 'wiki/a.md', ['wiki/a.md'], false, 'the simplest path there is'],
  ['wiki/a.md#H', 'wiki/a.md', ['wiki/a.md'], false, 'one anchor, one reading'],
  ['wiki/a.md#H#{3}', 'wiki/a.md', ['wiki/a.md'], false, 'two anchors, still one reading'],

  // `#` before the extension is part of the FILENAME. Cutting at the first `#`
  // would answer `wiki/note`, a page that does not exist.
  ['wiki/note#2.md', 'wiki/note#2.md', ['wiki/note#2.md'], false, 'a `#` inside the filename'],
  ['wiki/note#2.md#H', 'wiki/note#2.md', ['wiki/note#2.md'], false, 'and the same file with an anchor'],

  // THE UNDECIDABLE ONES. Both readings are real files as far as the string is
  // concerned, so the helper refuses rather than picking.
  ['wiki/a.md#b.md', '', [], true, 'file `a.md#b.md`, or heading `b.md` in `a.md`'],
  ['wiki/a.md#b.md#H', '', [], true, 'the same doubt, one anchor deeper'],
  ['wiki/a.md#voir b.md', '', [], true, 'a heading that ends in `.md`'],

  // `.md` that is not an extension must not be cut at.
  ['wiki/a.mdx#H', 'wiki/a.mdx#H', ['wiki/a.mdx#H'], false, '`.mdx` is not `.md`'],
  ['wiki/a.mdown', 'wiki/a.mdown', ['wiki/a.mdown'], false, 'nor is `.mdown`'],

  // Paths that name no note at all are handed back untouched: the reader will
  // say what it makes of them, and inventing a page here would be worse.
  ['assets/diagram.png', 'assets/diagram.png', ['assets/diagram.png'], false, 'an attachment'],
  ['.md#H', '.md#H', ['.md#H'], false, 'no filename before the extension'],
];

for (const [raw, page, candidates, ambiguous, why] of CASES) {
  test(`${JSON.stringify(raw)} — ${why}`, () => {
    assert.equal(hitPagePath(raw), page, 'page');
    assert.deepEqual(hitPathCandidates(raw), candidates, 'candidates');
    assert.equal(isAmbiguousHitPath(raw), ambiguous, 'ambiguity');
  });
}

test('an ambiguous path yields NO candidate, so nothing is read on a guess', () => {
  // The consequence that matters, stated on its own rather than left inside the
  // table: the annotator turns an empty candidate list into `no-path`, which
  // marks the entry `validityUnverified`. An unverified entry is never
  // excluded, so an undecidable path costs an annotation and never a page.
  for (const raw of ['wiki/a.md#b.md', 'wiki/a.md#b.md#H', 'wiki/a.md#voir b.md']) {
    assert.deepEqual(hitPathCandidates(raw), [], raw);
  }
});

test('a decidable path yields exactly ONE candidate — the module never hedges', () => {
  // A candidate LIST was the first repair, and the list is how a wrong window
  // got through: whichever spelling happened to answer won, including the
  // wrong one. At most one reading is ever offered now.
  for (const [raw] of CASES) {
    assert.ok(hitPathCandidates(raw).length <= 1, `${raw} offers at most one spelling`);
  }
});

test('whitespace is trimmed, and a blank path names nothing', () => {
  assert.equal(hitPagePath(`  ${REAL_BLOCK}  `), REAL_PAGE);
  assert.deepEqual(hitPathCandidates(`  ${REAL_BLOCK}  `), [REAL_PAGE]);
  assert.equal(hitPagePath('   '), '');
  assert.equal(hitPagePath(''), '');
  assert.deepEqual(hitPathCandidates('   '), []);
});

test('a non-string names nothing, and is not ambiguous either', () => {
  // A hit arrives from a bridge payload nobody here controls. One malformed
  // entry must mark itself unverified, never abort the operation — and the two
  // kinds of silence stay distinguishable.
  for (const value of [undefined, null, 42, {}, [], { path: 'x' }]) {
    assert.equal(hitPagePath(value), '', `${JSON.stringify(value)} names nothing`);
    assert.deepEqual(hitPathCandidates(value), []);
    assert.equal(isAmbiguousHitPath(value), false, 'absence is not ambiguity');
  }
});

test('"names nothing" and "cannot be named" are told apart', () => {
  // Both give `''` and `[]`, because both leave the entry unverified — but they
  // are different facts about the hit, and collapsing them would make the empty
  // path and the undecidable one impossible to diagnose.
  assert.equal(hitPagePath(''), '');
  assert.equal(isAmbiguousHitPath(''), false);

  assert.equal(hitPagePath('wiki/a.md#b.md'), '');
  assert.equal(isAmbiguousHitPath('wiki/a.md#b.md'), true);
});
