/**
 * The shape grid, replayed offline.
 *
 * 225 frontmatter documents — every key form × every value form, then every
 * value form × every surrounding context — judged against what Obsidian
 * actually made of the same bytes. The capture needed a live vault; this
 * replay does not, which is what makes the coverage permanent.
 *
 * THE ASYMMETRY IS THE WHOLE CONTRACT. The raw reader has three outcomes, not
 * two, and only one direction of disagreement is a defect:
 *
 *   SAFE    it REFUSES a shape (`undetermined`), by name. A refused bound is
 *           reported, never treated as absent.
 *   SAFE    both it and Obsidian are silent.
 *   DEFECT  Obsidian holds a bound and the reader is silent → invariant 2, an
 *           unreadable window reported as absent, which is the failure this
 *           whole lot exists to prevent.
 *   DEFECT  Obsidian holds nothing and the reader claims a window → invariant 1.
 *   DEFECT  both hold one and they differ → the wrong window, and under a
 *           filter, a page removed for a date that is not its own.
 *
 * AND A REFUSAL IS SAFE, NOT FREE. "Refusing is always allowed" would let a
 * reader that refuses everything pass all 225 comparisons, so the counts below
 * are pinned: the number of refusals, and the number of them that decline a
 * shape Obsidian read as a clean calendar date. Those are a cost, measured, and
 * a change to either is a behaviour change somebody has to argue for.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyValidity, windowFieldsFromFrontmatterText } from '../src/helpers/temporal-validity.mjs';
import { SHAPE_GRID_ASOF, generateShapeCases } from './fixtures/frontmatter-shape-grid.mjs';
import { SHAPE_ORACLE, SHAPE_ORACLE_CAPTURED_ON } from './fixtures/frontmatter-shape-oracle.mjs';

const CASES = generateShapeCases();
const shape = (r) => (r === null ? null : { state: r.state, from: r.from ?? null, through: r.through ?? null });

/** What Obsidian saw, judged by the same helper that judges the reader. */
function obsidianVerdict(id) {
  const fm = SHAPE_ORACLE[id];
  assert.ok(fm !== undefined, `${id} has no captured verdict — re-capture the oracle`);
  return shape(classifyValidity(fm, { asOf: SHAPE_GRID_ASOF }));
}

/** What the raw reader says, with its third outcome kept apart. */
function readerVerdict(markdown) {
  const { fields, undetermined } = windowFieldsFromFrontmatterText(markdown);
  if (undetermined.length > 0) return { refused: undetermined };
  return shape(classifyValidity(fields, { asOf: SHAPE_GRID_ASOF }));
}
const isRefusal = (v) => v !== null && Array.isArray(v.refused);

describe('the shape grid — 225 assemblies of the forms this lot had to learn', () => {
  test('the generator and the captured oracle describe the same set', () => {
    // Change a brick and the ids move. That must fail loudly here rather than
    // silently skip half the grid, because the oracle cannot be re-derived by
    // thinking — it has to be re-measured against a live Obsidian.
    const generated = CASES.map((c) => c.id).sort();
    const captured = Object.keys(SHAPE_ORACLE).sort();
    assert.deepEqual(captured, generated);
    assert.match(SHAPE_ORACLE_CAPTURED_ON, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(CASES.length, 225, 'the grid is 6×15 + 15×9');
  });

  test('no document makes the reader contradict Obsidian', () => {
    // The one assertion that is about correctness. Every failure is named with
    // its document, because a count alone cannot be acted on.
    const defects = [];
    for (const c of CASES) {
      const obsidian = obsidianVerdict(c.id);
      const reader = readerVerdict(c.markdown);
      if (isRefusal(reader)) continue;

      if (obsidian === null && reader === null) continue;
      if (obsidian !== null && reader === null) {
        defects.push(`${c.id}: Obsidian holds ${JSON.stringify(obsidian)} and the reader is SILENT (invariant 2)`);
      } else if (obsidian === null && reader !== null) {
        defects.push(`${c.id}: the reader claims ${JSON.stringify(reader)} where Obsidian sees nothing (invariant 1)`);
      } else if (obsidian.state !== reader.state || obsidian.from !== reader.from || obsidian.through !== reader.through) {
        defects.push(`${c.id}: Obsidian ${JSON.stringify(obsidian)} vs reader ${JSON.stringify(reader)}`);
      }
    }
    assert.deepEqual(defects, [], `${defects.length} shape(s) where the reader and Obsidian disagree`);
  });

  test('the reader agrees outright on 72 shapes, and refuses 153', () => {
    // Pinned so a reader that starts refusing more cannot hide behind "refusing
    // is allowed". Both numbers moving is a behaviour change; one moving
    // without the other is arithmetic that does not add up.
    let agrees = 0;
    let refuses = 0;
    for (const c of CASES) {
      if (isRefusal(readerVerdict(c.markdown))) refuses += 1;
      else agrees += 1;
    }
    assert.equal(agrees, 72);
    assert.equal(refuses, 153);
    assert.equal(agrees + refuses, CASES.length);
  });

  test('54 of those refusals decline a shape Obsidian read as a clean date — the measured cost', () => {
    // NOT a defect: a refusal says "I do not decode this", and nothing is ever
    // reported as absent. It IS a false alarm on a well-formed page, so the
    // number is written down rather than left to be rediscovered.
    //
    // Two families, and they are independent. Roughly three quarters are a
    // bound written as a BLOCK SCALAR (`valid_from: |` then the date on the
    // line below): reading those means tracking indentation and chomping,
    // which is the "implement YAML" slope this reader exists to stay off. The
    // rest are an ordinary date under a key that is not plain — quoted,
    // escaped, explicit or indented.
    const costly = CASES.filter((c) => {
      if (!isRefusal(readerVerdict(c.markdown))) return false;
      const obsidian = obsidianVerdict(c.id);
      return obsidian !== null && obsidian.state !== 'unreadable';
    });
    assert.equal(costly.length, 54);

    const blockScalar = costly.filter((c) => /v\.block-scalar/.test(c.id));
    assert.equal(blockScalar.length, 39, 'the block-scalar family');
    assert.equal(costly.length - blockScalar.length, 15, 'an ordinary date under a non-plain key');
  });

  test('and every refusal names the field it declined', () => {
    // A refusal that did not say WHICH bound it refused would be
    // indistinguishable from a page that declares nothing — the exact collapse
    // invariant 2 forbids.
    for (const c of CASES) {
      const v = readerVerdict(c.markdown);
      if (!isRefusal(v)) continue;
      assert.ok(v.refused.length > 0, `${c.id}: refused with an empty field list`);
      for (const field of v.refused) {
        assert.ok(['valid_from', 'valid_through'].includes(field), `${c.id}: refused an unknown field ${field}`);
      }
    }
  });
});
