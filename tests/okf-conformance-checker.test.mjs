/**
 * Tests for src/helpers/okf-conformance-checker.mjs — OKF v0.1 conformance
 * validation (SPEC.md §9 rules 1-3 as errors, softer deviations as
 * warnings/info). Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkOkfConformance } from '../src/helpers/okf-conformance-checker.mjs';

const DOC = (path, extra = '') => ({
  path,
  content: `---\ntype: concept\ntitle: T\ndescription: D\ntimestamp: '2026-07-03'\n${extra}---\n\nBody.\n`,
});

const ROOT_INDEX = {
  path: 'index.md',
  content: "---\nokf_version: '0.1'\n---\n\n# Bundle\n\n* [T](doc.md) - D\n",
};

function rules(findings) {
  return findings.map((f) => f.rule);
}

describe('checkOkfConformance — input validation', () => {
  test('throws on non-array input', () => {
    assert.throws(() => checkOkfConformance('nope'), TypeError);
  });

  test('ignores non-markdown files', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      DOC('doc.md'),
      { path: 'okf-cli.py', content: 'print("hi")' },
    ]);
    assert.equal(result.conformant, true);
    assert.equal(result.stats.documents, 1);
  });

  test('normalizes windows backslash paths', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      { ...DOC('doc.md'), path: 'sub\\doc.md' },
    ]);
    assert.equal(result.conformant, true);
    assert.equal(result.stats.documents, 1);
  });
});

describe('rule 1 — frontmatter block required on concept documents', () => {
  test('document without frontmatter is an error', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: '# Just a body\n' },
    ]);
    assert.equal(result.conformant, false);
    assert.ok(rules(result.errors).includes('frontmatter-missing'));
  });

  test('README.md without frontmatter is info, not an error', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      DOC('doc.md'),
      { path: 'README.md', content: '# Onboarding\n\nClone me.\n' },
    ]);
    assert.equal(result.conformant, true);
    assert.ok(rules(result.info).includes('readme-without-frontmatter'));
  });
});

describe('rule 2 — non-empty type', () => {
  test('empty type is an error', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: '---\ntype: \ntitle: T\n---\n\nBody.\n' },
    ]);
    assert.equal(result.conformant, false);
    assert.ok(rules(result.errors).includes('type-missing'));
  });

  test('unknown type values are perfectly legal', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: "---\ntype: BigQuery Table\ntitle: T\ndescription: D\ntimestamp: '2026-01-01'\n---\n\nBody.\n" },
    ]);
    assert.equal(result.conformant, true);
  });

  test('REGRESSION (codex): unclosed bracket in a scalar value is caught even though a lenient parser reads it as non-empty', () => {
    // `type: [concept` (missing closing bracket) is invalid YAML, but our
    // minimal line/colon parseFrontmatter reads it as the plain string
    // "[concept" — a non-empty value that would otherwise pass rule 2
    // despite the frontmatter not actually being parseable YAML.
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: '---\ntype: [concept\ntitle: T\n---\n\nBody.\n' },
    ]);
    assert.equal(result.conformant, false);
    assert.ok(rules(result.errors).includes('frontmatter-not-parseable'));
  });

  test('unbalanced brace is also caught', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: '---\ntype: concept\ntitle: {oops\n---\n\nBody.\n' },
    ]);
    assert.ok(rules(result.errors).includes('frontmatter-not-parseable'));
  });

  test('balanced inline arrays and legitimate brackets in prose do not false-positive', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      {
        path: 'doc.md',
        content: "---\ntype: concept\ntitle: T\ndescription: 'Contains [brackets] and {braces} in prose.'\ntags: [a, b, c]\n---\n\nBody.\n",
      },
    ]);
    assert.equal(result.conformant, true);
    assert.ok(!rules(result.errors).includes('frontmatter-not-parseable'));
  });

  test('an unescaped apostrophe in prose does NOT false-positive (no quote-parity check)', () => {
    // A naive quote-parity heuristic would flag this (1 unmatched '), which
    // is exactly why the checker only balances brackets/braces, not quotes.
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: '---\ntype: concept\ntitle: "Cole\'s loop"\n---\n\nBody.\n' },
    ]);
    assert.equal(result.conformant, true);
  });

  test('REGRESSION (codex pass 2): a bracket INSIDE a quoted scalar does not false-positive — our own exporter can produce this', () => {
    // Confirmed empirically: buildOkfFrontmatter({ title: 'Model [draft' })
    // emits `title: 'Model [draft'` (single-quoted, since the value
    // contains a trigger char) — perfectly valid YAML, since quoting makes
    // the bracket inert. The naive (pre-fix) per-line bracket count flagged
    // this as frontmatter-not-parseable despite it being conformant,
    // meaning our OWN exporter's self-check could reject its own output.
    const result = checkOkfConformance([
      ROOT_INDEX,
      {
        path: 'doc.md',
        content: "---\ntype: concept\ntitle: 'Model [draft'\ndescription: D\ntimestamp: '2026-07-03'\n---\n\nBody.\n",
      },
    ]);
    assert.equal(result.conformant, true);
    assert.ok(!rules(result.errors).includes('frontmatter-not-parseable'));
  });

  test('a genuinely unbalanced bracket OUTSIDE any quotes on the same line is still caught', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: "---\ntype: concept\ntitle: 'ok' extra ]\n---\n\nBody.\n" },
    ]);
    assert.ok(rules(result.errors).includes('frontmatter-not-parseable'));
  });

  test('a doubled single-quote (YAML escape for a literal quote) does not confuse the scanner', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: "---\ntype: concept\ntitle: 'It''s [fine]'\n---\n\nBody.\n" },
    ]);
    assert.equal(result.conformant, true);
  });

  test('REGRESSION (codex pass 3, confirmed independently by 2 reviewers): a quote that never closes is caught, not silently absorbed', () => {
    // `type: '[concept` opens a single-quote that never closes anywhere in
    // the frontmatter block — genuinely invalid YAML. Before this fix, the
    // quote-tracking reset per line meant the never-closed quote silently
    // absorbed the rest of the line (including the `[`), and nothing
    // downstream ever flagged the fact that a quote was left open —
    // exactly the failure mode the quote-awareness fix (pass 2) risked
    // introducing when taken to its logical conclusion.
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: "---\ntype: '[concept\ntitle: T\n---\n\nBody.\n" },
    ]);
    assert.equal(result.conformant, false);
    assert.ok(rules(result.errors).includes('frontmatter-not-parseable'));
  });

  test('a legitimate multi-line single-quoted scalar (quote opens on one line, closes on the next) does NOT false-positive', () => {
    // Valid YAML flow-scalar folding — third-party bundles may use this
    // even though our own exporter never emits it (always single-line).
    const result = checkOkfConformance([
      ROOT_INDEX,
      {
        path: 'doc.md',
        content: "---\ntype: concept\ntitle: 'A folded\n  title with [a bracket]'\n---\n\nBody.\n",
      },
    ]);
    assert.equal(result.conformant, true);
  });

  test("REGRESSION (codex pass 4): an apostrophe mid-scalar in a PLAIN (unquoted) YAML value is never mistaken for an opening quote", () => {
    // `title: John's loop` is a valid plain scalar (no outer quotes at
    // all) — the apostrophe is just a literal character. Cross-line quote
    // tracking (pass 3) treated ANY `'` anywhere as opening a quoted span
    // regardless of position, so this apostrophe was misread as "opens a
    // quote that never closes" and the whole document was wrongly flagged
    // frontmatter-not-parseable. A quote can now only open a new span at
    // the VALUE-START position of a line (right after `key: ` or `- `).
    const result = checkOkfConformance([
      ROOT_INDEX,
      {
        path: 'doc.md',
        content: "---\ntype: concept\ntitle: John's loop\ndescription: D\ntimestamp: '2026-07-03'\n---\n\nBody.\n",
      },
    ]);
    assert.equal(result.conformant, true);
    assert.ok(!rules(result.errors).includes('frontmatter-not-parseable'));
  });

  test('an apostrophe mid-scalar in a block-sequence item is also tolerated', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      {
        path: 'doc.md',
        content: "---\ntype: concept\ntitle: T\ndescription: D\ntimestamp: '2026-07-03'\ntags:\n- Cole's tag\n- another\n---\n\nBody.\n",
      },
    ]);
    assert.equal(result.conformant, true);
  });

  test('a value that legitimately STARTS with a quote is still recognized as opening a quoted scalar', () => {
    // Guards against an overcorrection: value-start gating must not
    // disable quote-opening entirely — only mid-scalar quotes are inert.
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: "---\ntype: '[still-unclosed\ntitle: T\n---\n\nBody.\n" },
    ]);
    assert.equal(result.conformant, false);
    assert.ok(rules(result.errors).includes('frontmatter-not-parseable'));
  });
});

describe('rule 3 — reserved index.md structure', () => {
  test('non-root index with frontmatter is an error', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      DOC('sub/doc.md'),
      { path: 'sub/index.md', content: '---\ntype: index\n---\n\n# Sub\n\n* [T](doc.md) - D\n' },
    ]);
    assert.ok(rules(result.errors).includes('index-frontmatter-forbidden'));
  });

  test('root index frontmatter may only declare okf_version', () => {
    const result = checkOkfConformance([
      { path: 'index.md', content: "---\nokf_version: '0.1'\ntype: index\n---\n\n# B\n" },
    ]);
    assert.ok(rules(result.errors).includes('index-frontmatter-extra-keys'));
  });

  test('root index with only okf_version is clean', () => {
    const result = checkOkfConformance([ROOT_INDEX, DOC('doc.md')]);
    assert.equal(result.conformant, true);
    assert.ok(!rules(result.info).includes('okf-version-missing'));
  });

  test('missing okf_version on root index is info-level', () => {
    const result = checkOkfConformance([
      { path: 'index.md', content: '# B\n\n* [T](doc.md) - D\n' },
      DOC('doc.md'),
    ]);
    assert.equal(result.conformant, true);
    assert.ok(rules(result.info).includes('okf-version-missing'));
  });

  test('H2 section headings and dash bullets are warnings, not errors', () => {
    const result = checkOkfConformance([
      {
        path: 'index.md',
        content: '## Sections\n\n- [T](doc.md) - D\n',
      },
      DOC('doc.md'),
    ]);
    assert.equal(result.conformant, true);
    assert.ok(rules(result.warnings).includes('index-heading-level'));
    assert.ok(rules(result.warnings).includes('index-bullet-marker'));
  });

  test('bullets that are not [Title](url) - desc are warned', () => {
    const result = checkOkfConformance([
      { path: 'index.md', content: '# B\n\n* just some text\n' },
    ]);
    assert.ok(rules(result.warnings).includes('index-bullet-form'));
  });

  test('blockquotes and blank lines are tolerated silently', () => {
    const result = checkOkfConformance([
      { path: 'index.md', content: '# B\n\n> A perfectly fine blurb.\n\n* [T](doc.md) - D\n' },
      DOC('doc.md'),
    ]);
    assert.equal(result.warnings.length, 0);
  });
});

describe('rule 3 — reserved log.md structure', () => {
  test('non-ISO date heading is an error', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'log.md', content: '# Update Log\n\n## 03/07/2026\n* **Creation**: x\n' },
    ]);
    assert.ok(rules(result.errors).includes('log-date-not-iso'));
  });

  test('ISO newest-first log is clean; title heading tolerated', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      {
        path: 'log.md',
        content: '# Update Log\n\n## 2026-07-03\n* **Update**: y\n\n## 2026-06-01\n* **Creation**: x\n',
      },
    ]);
    assert.equal(result.conformant, true);
    assert.equal(result.warnings.length, 0);
  });

  test('oldest-first ordering is a warning', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      {
        path: 'log.md',
        content: '## 2026-06-01\n* **Creation**: x\n\n## 2026-07-03\n* **Update**: y\n',
      },
    ]);
    assert.equal(result.conformant, true);
    assert.ok(rules(result.warnings).includes('log-not-newest-first'));
  });
});

describe('compatibility signals (warnings / info)', () => {
  test('accented or spaced filenames warn about Google tooling compat', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      DOC('Dossier Été/Ma Note.md'),
    ]);
    assert.equal(result.conformant, true);
    assert.ok(rules(result.warnings).includes('filename-charset'));
  });

  test('wikilinks in bodies are flagged as non-OKF link syntax', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      {
        path: 'doc.md',
        content: "---\ntype: concept\ntitle: T\ndescription: D\ntimestamp: '2026-01-01'\n---\n\nSee [[Other]].\n",
      },
    ]);
    assert.ok(rules(result.warnings).includes('wikilink-syntax'));
  });

  test('missing reference-implementation keys are info-level', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      { path: 'doc.md', content: '---\ntype: concept\n---\n\nBody.\n' },
    ]);
    assert.equal(result.conformant, true);
    assert.ok(rules(result.info).includes('reference-impl-keys'));
  });

  test('missing root index is info-level', () => {
    const result = checkOkfConformance([DOC('doc.md')]);
    assert.equal(result.conformant, true);
    assert.ok(rules(result.info).includes('root-index-missing'));
  });

  test('stats count documents, indexes and logs separately', () => {
    const result = checkOkfConformance([
      ROOT_INDEX,
      DOC('a.md'),
      DOC('sub/b.md'),
      { path: 'sub/index.md', content: '# Sub\n\n* [T](b.md) - D\n' },
      { path: 'log.md', content: '## 2026-07-03\n* **Creation**: x\n' },
    ]);
    assert.deepEqual(result.stats, { documents: 2, indexes: 2, logs: 1, skipped: 0 });
  });
});
