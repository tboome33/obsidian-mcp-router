/**
 * Tests for the OKF at-rest projections (volet ② — v0.59.0):
 * `wiki/index.md` (root, `okf_version` only), one `index.md` per content
 * directory, `wiki/log.md` newest-first — pure functions of the tree's
 * frontmatter, marked as generated, safe against hand-written homonyms.
 *
 * The decisive property is the LAST suite: the generated projections, laid
 * over the content pages as a bundle, must pass `checkOkfConformance` with
 * zero errors AND zero warnings — the façade is conformant by construction,
 * not by convention.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECTION_MARKER,
  projectionMarkerLine,
  isProjectionPath,
  isWikiContentPath,
  hasProjectionMarker,
  buildProjections,
  planProjectionWrites,
} from '../src/helpers/okf-projections.mjs';
import { checkOkfConformance } from '../src/helpers/okf-conformance-checker.mjs';

const NOW = '2026-07-30';

function page(path, frontmatter, body = 'Un paragraphe descriptif suffisant pour la synthèse.') {
  return { path, frontmatter, body };
}

const PAGES = [
  page('wiki/obsidian-mcp-router/router-changelog.md', {
    type: 'reference', title: 'Router changelog', description: 'Toutes les versions.',
    created: '2026-05-22', updated: '2026-07-30',
  }),
  page('wiki/obsidian-mcp-router/decisions/okf-decision.md', {
    type: 'decision', title: 'Décision OKF', created: '2026-07-30', updated: '2026-07-30',
  }),
  page('wiki/Divers/note-sans-dates.md', { type: 'note', title: 'Note sans dates' }),
  page('wiki/racine.md', { type: 'concept', title: 'Page racine', created: '2026-06-01' }),
];

function build(pages = PAGES) {
  return buildProjections({ pages, vaultName: 'test-vault', now: NOW });
}

// ---------------------------------------------------------------------------
// Path + marker classification
// ---------------------------------------------------------------------------

describe('projection path/marker classification', () => {
  test('reserved paths: root + per-directory index.md + wiki/log.md', () => {
    assert.equal(isProjectionPath('wiki/index.md'), true);
    assert.equal(isProjectionPath('wiki/log.md'), true);
    assert.equal(isProjectionPath('wiki/a/b/index.md'), true);
    assert.equal(isProjectionPath('wiki\\a\\index.md'), true); // windows seps
  });

  test('near-misses are NOT projections', () => {
    assert.equal(isProjectionPath('wiki/Index.md'), false, 'exact lowercase only');
    assert.equal(isProjectionPath('wiki/a/log.md'), false, 'log is root-only');
    assert.equal(isProjectionPath('wiki-meta/catalog.md'), false);
    assert.equal(isProjectionPath('index.md'), false, 'outside wiki/');
    assert.equal(isProjectionPath('wiki/indexes.md'), false);
  });

  test('wiki content = under wiki/, .md, and not a projection', () => {
    assert.equal(isWikiContentPath('wiki/a/page.md'), true);
    assert.equal(isWikiContentPath('wiki/index.md'), false);
    assert.equal(isWikiContentPath('wiki/log.md'), false);
    assert.equal(isWikiContentPath('wiki-meta/hot.md'), false);
    assert.equal(isWikiContentPath('wiki/img.png'), false);
  });

  test('marker detection is head-scoped — quoting the marker deep in a page is not a match', () => {
    assert.equal(hasProjectionMarker(`# X\n\n${projectionMarkerLine()}\n`), true);
    const deepQuote = `# X\n${'\n'.repeat(30)}> ${PROJECTION_MARKER} cited in prose\n`;
    assert.equal(hasProjectionMarker(deepQuote), false);
    assert.equal(hasProjectionMarker(''), false);
    assert.equal(hasProjectionMarker(null), false);
  });
});

// ---------------------------------------------------------------------------
// buildProjections — structure
// ---------------------------------------------------------------------------

describe('buildProjections', () => {
  test('produces root index, one index per directory, and the log', () => {
    const { files } = build();
    assert.deepEqual(files.map((f) => f.path), [
      'wiki/Divers/index.md',
      'wiki/index.md',
      'wiki/log.md',
      'wiki/obsidian-mcp-router/decisions/index.md',
      'wiki/obsidian-mcp-router/index.md',
    ]);
  });

  test('root index: okf_version frontmatter ONLY, vault heading, marker, entries', () => {
    const root = build().files.find((f) => f.path === 'wiki/index.md');
    assert.match(root.content, /^---\nokf_version: '0\.1'\n---\n/);
    assert.match(root.content, /^# test-vault$/m);
    assert.match(root.content, new RegExp(`^> ${PROJECTION_MARKER}`, 'm'));
    // Root-level page listed by title; subdirectory linked to its index.
    assert.match(root.content, /^\* \[Page racine\]\(racine\.md\)/m);
    assert.match(root.content, /^\* \[Divers\]\(Divers\/index\.md\)/m);
    assert.match(root.content, /^\* \[obsidian-mcp-router\]\(obsidian-mcp-router\/index\.md\)/m);
  });

  test('per-directory index: NO frontmatter, marker, typed sections, entries with descriptions', () => {
    const dir = build().files.find((f) => f.path === 'wiki/obsidian-mcp-router/index.md');
    assert.doesNotMatch(dir.content, /^---/, 'non-root indexes must not carry frontmatter (§6)');
    assert.match(dir.content, new RegExp(`^> ${PROJECTION_MARKER}`, 'm'));
    assert.match(dir.content, /^# Reference$/m, 'sections are typed, capitalised');
    assert.match(dir.content, /^\* \[Router changelog\]\(router-changelog\.md\) - Toutes les versions\.$/m);
    assert.match(dir.content, /^\* \[decisions\]\(decisions\/index\.md\) - Contains 1 document/m);
  });

  test('log: newest-first date sections, Created vs Updated, undated pages last', () => {
    const log = build().files.find((f) => f.path === 'wiki/log.md');
    assert.match(log.content, /^# Update Log$/m);
    const d1 = log.content.indexOf('## 2026-07-30');
    const d2 = log.content.indexOf('## 2026-06-01');
    const und = log.content.indexOf('## Undated');
    assert.ok(d1 > 0 && d2 > d1 && und > d2, 'sections ordered newest → oldest → undated');
    // created === newest ⇒ Created; created < updated ⇒ Updated.
    assert.match(log.content, /\* \*\*Created\*\*: \[Décision OKF\]\(obsidian-mcp-router\/decisions\/okf-decision\.md\)/);
    assert.match(log.content, /\* \*\*Updated\*\*: \[Router changelog\]\(obsidian-mcp-router\/router-changelog\.md\)/);
    assert.match(log.content, /\* \[Note sans dates\]\(Divers\/note-sans-dates\.md\)/);
  });

  test('deterministic: same tree, same now → identical bytes; page order does not matter', () => {
    const a = build(PAGES);
    const b = build([...PAGES].reverse());
    assert.deepEqual(a, b);
  });

  test('undated pages do NOT inherit `now` in the log (no daily churn)', () => {
    const log1 = buildProjections({ pages: PAGES, vaultName: 'v', now: '2026-07-30' })
      .files.find((f) => f.path === 'wiki/log.md');
    const log2 = buildProjections({ pages: PAGES, vaultName: 'v', now: '2026-08-15' })
      .files.find((f) => f.path === 'wiki/log.md');
    assert.equal(log1.content, log2.content);
  });

  test('projection paths in the input are ignored — a refresh never feeds on itself', () => {
    const withStale = [...PAGES,
      page('wiki/index.md', { title: 'stale' }),
      page('wiki/Divers/index.md', { title: 'stale' }),
      page('wiki/log.md', { title: 'stale' }),
    ];
    assert.deepEqual(build(withStale), build(PAGES));
  });

  test('empty wiki still yields a valid root index + empty log (scaffold state)', () => {
    const { files } = build([]);
    assert.deepEqual(files.map((f) => f.path), ['wiki/index.md', 'wiki/log.md']);
    const root = files[0];
    assert.match(root.content, /okf_version: '0\.1'/);
    assert.match(root.content, /^# test-vault$/m);
    assert.match(root.content, new RegExp(`^> ${PROJECTION_MARKER}`, 'm'));
  });

  test('title falls back to basename, description synthesised from the body', () => {
    const { files } = build([page('wiki/sans-titre.md', {}, 'Première phrase utile. Deuxième.')]);
    const root = files.find((f) => f.path === 'wiki/index.md');
    assert.match(root.content, /^\* \[sans-titre\]\(sans-titre\.md\) - Première phrase utile\.$/m);
  });
});

// ---------------------------------------------------------------------------
// planProjectionWrites — write/skip/delete/conflict
// ---------------------------------------------------------------------------

describe('planProjectionWrites', () => {
  const generated = build().files;

  test('everything is a write on a virgin tree', () => {
    const plan = planProjectionWrites({ generated, current: new Map() });
    assert.equal(plan.writes.length, generated.length);
    assert.deepEqual(plan.deletes, []);
    assert.deepEqual(plan.conflicts, []);
  });

  test('identical content is skipped — a refresh over a clean tree writes nothing', () => {
    const current = new Map(generated.map((f) => [f.path, f.content]));
    const plan = planProjectionWrites({ generated, current });
    assert.deepEqual(plan.writes, []);
    assert.equal(plan.unchanged.length, generated.length);
  });

  test('a MARKED projection at a path no longer generated is deleted', () => {
    const current = new Map(generated.map((f) => [f.path, f.content]));
    current.set('wiki/vieux-dossier/index.md', `# Note\n\n${projectionMarkerLine()}\n`);
    const plan = planProjectionWrites({ generated, current });
    assert.deepEqual(plan.deletes, ['wiki/vieux-dossier/index.md']);
  });

  test('an UNMARKED file is never overwritten nor deleted — reported as conflict', () => {
    const current = new Map();
    current.set('wiki/index.md', '# Mon index à moi\n\nContenu écrit main.\n');
    current.set('wiki/vieux/index.md', '# Une vraie page\n');
    const plan = planProjectionWrites({ generated, current });
    assert.deepEqual(plan.conflicts, ['wiki/index.md']);
    assert.deepEqual(plan.deletes, [], 'unmarked stray must survive');
    assert.equal(plan.writes.some((w) => w.path === 'wiki/index.md'), false);
  });

  test('drift in a marked projection is rewritten', () => {
    const current = new Map(generated.map((f) => [f.path, f.content]));
    current.set('wiki/log.md', `# Update Log\n\n${projectionMarkerLine()}\n\n## 2020-01-01\n`);
    const plan = planProjectionWrites({ generated, current });
    assert.deepEqual(plan.writes.map((w) => w.path), ['wiki/log.md']);
  });
});

// ---------------------------------------------------------------------------
// THE property: projections + content = a conformant OKF bundle
// ---------------------------------------------------------------------------

describe('conformance round-trip', () => {
  test('generated projections lint clean: zero errors, zero warnings', () => {
    const { files } = build();
    // Assemble the bundle as the checker sees it: content pages (paths
    // relative to the bundle root = wiki/) + our projections.
    const bundle = [
      ...PAGES.map((p) => ({
        path: p.path.replace(/^wiki\//, ''),
        content: `---\ntype: ${p.frontmatter.type ?? 'note'}\ntitle: "${p.frontmatter.title ?? 'x'}"\ndescription: "d"\ntimestamp: '2026-07-30'\n---\n\n${p.body}\n`,
      })),
      ...files.map((f) => ({ path: f.path.replace(/^wiki\//, ''), content: f.content })),
    ];
    const result = checkOkfConformance(bundle);
    assert.deepEqual(result.errors ?? [], [], JSON.stringify(result.errors, null, 2));
    const projectionWarnings = (result.warnings ?? []).filter((w) =>
      w.path === 'index.md' || w.path === 'log.md' || w.path.endsWith('/index.md'));
    assert.deepEqual(projectionWarnings, [], JSON.stringify(projectionWarnings, null, 2));
  });

  test('the empty-wiki scaffold state also lints clean', () => {
    const { files } = build([]);
    const result = checkOkfConformance(
      files.map((f) => ({ path: f.path.replace(/^wiki\//, ''), content: f.content })),
    );
    assert.deepEqual(result.errors ?? [], []);
    assert.deepEqual(result.warnings ?? [], [], JSON.stringify(result.warnings, null, 2));
  });
});
