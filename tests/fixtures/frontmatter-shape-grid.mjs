/**
 * The shape grid — every frontmatter form this lot has paid to learn about,
 * recombined.
 *
 * Seven adversarial rounds found sixteen shapes the raw frontmatter reader got
 * wrong. Each was found alone, repaired alone, and pinned alone. What nobody
 * explored is their COMBINATORICS: a quoted key holding a block scalar that
 * carries a comment, under a parent whose sequence sits at column zero.
 *
 * This is deliberately NOT a YAML fuzzer. Random bytes produce documents no
 * author would write and failures nobody can read; a cross-product of known
 * bricks produces plausible frontmatter, and every failure names the two or
 * three bricks that caused it. The bricks are the vocabulary this project
 * already had to learn.
 *
 * DETERMINISTIC ON PURPOSE. `generateShapeCases()` returns the same documents
 * in the same order every run, so the captured oracle in
 * `frontmatter-shape-oracle.mjs` can be keyed by id. Change a brick and the
 * ids stop matching — which is a loud failure, and the right one: the oracle
 * has to be re-captured against a live Obsidian, not guessed.
 *
 * SPECIAL CHARACTERS ARE BUILT, NEVER TYPED. A backslash-u escape typed into a
 * source file becomes the character itself — this repo has shipped two of them
 * and its own guard now rejects them — so the non-breaking space, the
 * backslash and the quotes are assembled from char codes.
 */

const NBSP = String.fromCharCode(160);
const BACKSLASH = String.fromCharCode(92);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);

/**
 * How the bound's KEY is written. `lines(value)` returns the lines declaring
 * `valid_from` with that value — some forms span two lines by nature.
 */
const KEYS = [
  { id: 'plain', lines: (v) => [`valid_from:${v.inline}`, ...v.below] },
  { id: 'double-quoted', lines: (v) => [`${DQ}valid_from${DQ}:${v.inline}`, ...v.below] },
  { id: 'single-quoted', lines: (v) => [`${SQ}valid_from${SQ}:${v.inline}`, ...v.below] },
  // `f` is `f`: the key IS `valid_from`, spelled so a text search misses
  // it. The shape that proved a text predicate could not guard this reader.
  { id: 'escaped', lines: (v) => [`${DQ}valid_${BACKSLASH}u0066rom${DQ}:${v.inline}`, ...v.below] },
  { id: 'explicit', lines: (v) => ['? valid_from', `:${v.inline}`, ...v.below] },
  { id: 'indented', lines: (v) => [`  valid_from:${v.inline}`, ...v.below] },
];

/** What the VALUE is. `inline` follows the colon; `below` are the lines under it. */
const VALUES = [
  { id: 'date', inline: ' 2026-01-01', below: [] },
  { id: 'date-quoted', inline: ` ${DQ}2026-01-01${DQ}`, below: [] },
  { id: 'empty', inline: '', below: [] },
  { id: 'null', inline: ' null', below: [] },
  { id: 'block-map', inline: '', below: ['  date: 2026-01-01'] },
  { id: 'list-indented', inline: '', below: ['  - 2026-01-01'] },
  { id: 'list-column-zero', inline: '', below: ['- 2026-01-01'] },
  { id: 'block-scalar', inline: ' |', below: ['  2026-01-01'] },
  { id: 'block-scalar-comment', inline: ' | # note', below: ['  2026-01-01'] },
  { id: 'block-scalar-anchor', inline: ' &a |', below: ['  2026-01-01'] },
  { id: 'flow-map', inline: ' {date: 2026-01-01}', below: [] },
  { id: 'comment-after', inline: ' 2026-01-01 # note', below: [] },
  // U+00A0 is not YAML white space, so the `#` belongs to the value.
  { id: 'comment-after-nbsp', inline: ` 2026-01-01${NBSP}#note`, below: [] },
  { id: 'not-a-date', inline: ' 2026-13-45', below: [] },
  { id: 'folded-continuation', inline: ' 2026-01-01', below: ['  suite'] },
];

/** What surrounds the declaration, inside the same frontmatter block. */
const CONTEXTS = [
  { id: 'alone', before: [], after: [] },
  { id: 'after-a-key', before: ['type: fact'], after: [] },
  { id: 'before-a-key', before: [], after: ['type: fact'] },
  { id: 'after-a-nested-block', before: ['metadata:', '  owner: Alice'], after: [] },
  { id: 'after-a-column-zero-sequence', before: ['tags:', '- doc', '- autre'], after: [] },
  { id: 'after-a-comment', before: ['# un commentaire'], after: [] },
  { id: 'after-a-blank-line', before: ['type: fact', ''], after: [] },
  { id: 'after-a-block-scalar', before: ['note: |', '  du texte', '  ? pas une cle'], after: [] },
  { id: 'with-a-second-bound', before: [], after: ['valid_through: 2026-12-31'] },
  { id: 'indented-document', before: ['  type: fact'], after: [] },
];

const BODY = '\n# Une page\n\nDu corps, pour que le document ne soit pas que du frontmatter.\n';

/** The reference day every captured verdict was classified against. */
export const SHAPE_GRID_ASOF = '2026-06-15';

/**
 * Every key × every value in the plainest context, then every value × every
 * context under the plainest key.
 *
 * The full triple product is 900 documents for little extra signal — the
 * interactions this hunts are key×value and value×context, and 900 pages
 * written into somebody's vault is not a free measurement.
 *
 * @returns {{id: string, markdown: string}[]}
 */
export function generateShapeCases() {
  const cases = [];
  const push = (id, lines) => {
    cases.push({ id, markdown: `---\n${lines.join('\n')}\n---\n${BODY}` });
  };

  for (const key of KEYS) {
    for (const value of VALUES) push(`k.${key.id}__v.${value.id}`, key.lines(value));
  }
  const plainKey = KEYS[0];
  for (const value of VALUES) {
    for (const context of CONTEXTS) {
      if (context.id === 'alone') continue; // already covered above
      push(`v.${value.id}__c.${context.id}`, [...context.before, ...plainKey.lines(value), ...context.after]);
    }
  }
  return cases;
}
