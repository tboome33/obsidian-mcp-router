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
