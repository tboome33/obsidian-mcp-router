import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isOkfSafeSegment,
  buildRenamePlan,
  buildRenamePlanFromTable,
  buildRewriteContext,
  rewriteNoteContent,
  rewriteExactPaths,
  buildExactPathMap,
  orderRenameOps,
  okfSafePathSuggestion,
  retitleScaffold,
  RENAME_PRESETS,
} from '../src/helpers/okf-safe-rename.mjs';

// ---------------------------------------------------------------------------
// isOkfSafeSegment
// ---------------------------------------------------------------------------

test('isOkfSafeSegment accepts the reference charset', () => {
  assert.equal(isOkfSafeSegment('foo-bar_2.v1'), true);
  assert.equal(isOkfSafeSegment('2026-07-29-note'), true);
  assert.equal(isOkfSafeSegment('README'), true);
});

test('isOkfSafeSegment rejects spaces, accents and bad first chars', () => {
  assert.equal(isOkfSafeSegment("Vue d'ensemble"), false);
  assert.equal(isOkfSafeSegment('été'), false);
  assert.equal(isOkfSafeSegment('-leading'), false);
  assert.equal(isOkfSafeSegment('.hidden'), false);
  assert.equal(isOkfSafeSegment(''), false);
});

// ---------------------------------------------------------------------------
// buildRenamePlan
// ---------------------------------------------------------------------------

test('plan renames a non-conformant md stem and leaves safe files alone', () => {
  const plan = buildRenamePlan(["wiki/Cours/Vue d'ensemble.md", 'wiki/Cours/ok.md']);
  assert.deepEqual(
    plan.renameOps.map((r) => [r.oldPath, r.newPath, r.isDir]),
    [["wiki/Cours/Vue d'ensemble.md", 'wiki/Cours/vue-d-ensemble.md', false]],
  );
  assert.equal(plan.fileMap.get("wiki/Cours/Vue d'ensemble.md"), 'wiki/Cours/vue-d-ensemble.md');
  assert.equal(plan.fileMap.has('wiki/Cours/ok.md'), false);
  assert.deepEqual(plan.stemRenames[0], {
    oldStem: "Vue d'ensemble",
    newStem: 'vue-d-ensemble',
    oldPath: "wiki/Cours/Vue d'ensemble.md",
    newPath: 'wiki/Cours/vue-d-ensemble.md',
  });
});

test('plan renames non-conformant directories and composes child paths', () => {
  const plan = buildRenamePlan(['Formations/Trend Follower/Money Management.md']);
  const dirOp = plan.renameOps.find((r) => r.isDir);
  assert.deepEqual([dirOp.oldPath, dirOp.newPath], [
    'Formations/Trend Follower',
    'Formations/trend-follower',
  ]);
  assert.equal(
    plan.fileMap.get('Formations/Trend Follower/Money Management.md'),
    'Formations/trend-follower/money-management.md',
  );
});

test('plan suffixes on collision with an existing safe sibling (case-insensitive)', () => {
  const plan = buildRenamePlan(['a/Café.md', 'a/cafe.md']);
  assert.equal(plan.fileMap.get('a/Café.md'), 'a/cafe-2.md');
  assert.equal(plan.collisionsResolved.length, 1);
});

test('plan suffixes deterministically when two renamed siblings collide', () => {
  const plan = buildRenamePlan(['a/Été.md', 'a/ete .md']);
  const news = [plan.fileMap.get('a/Été.md'), plan.fileMap.get('a/ete .md')].sort();
  assert.deepEqual(news, ['a/ete-2.md', 'a/ete.md']);
});

test('plan never renames non-md files but tracks their path change through dir renames', () => {
  const plan = buildRenamePlan(['Dossier X/img.png']);
  assert.equal(plan.fileMap.get('Dossier X/img.png'), 'dossier-x/img.png');
  assert.equal(plan.renameOps.filter((r) => !r.isDir).length, 0);
  assert.equal(plan.renameOps.filter((r) => r.isDir).length, 1);
});

test('plan reports old stems whose copies diverge into different new stems', () => {
  const plan = buildRenamePlan(['a/Le Plan.md', 'b/Le Plan.md', 'b/le-plan.md']);
  assert.deepEqual(plan.ambiguousStems, ['le plan']);
});

// ---------------------------------------------------------------------------
// rewriteNoteContent — wikilinks
// ---------------------------------------------------------------------------

function ctxFor(paths) {
  return buildRewriteContext(buildRenamePlan(paths));
}

test('wikilink without alias gets the old text as alias (display preserved)', () => {
  const ctx = ctxFor(["wiki/Vue d'ensemble.md"]);
  const r = rewriteNoteContent("voir [[Vue d'ensemble]]", 'wiki/note.md', ctx);
  assert.equal(r.content, "voir [[vue-d-ensemble|Vue d'ensemble]]");
  assert.equal(r.edits, 1);
});

test('wikilink with alias keeps its alias', () => {
  const ctx = ctxFor(["wiki/Vue d'ensemble.md"]);
  const r = rewriteNoteContent("voir [[Vue d'ensemble|La vue]]", 'wiki/note.md', ctx);
  assert.equal(r.content, 'voir [[vue-d-ensemble|La vue]]');
});

test('wikilink anchor survives the rewrite', () => {
  const ctx = ctxFor(["wiki/Vue d'ensemble.md"]);
  const r = rewriteNoteContent("voir [[Vue d'ensemble#Section]]", 'wiki/note.md', ctx);
  assert.equal(r.content, "voir [[vue-d-ensemble#Section|Vue d'ensemble]]");
});

test('embeds are rewritten without gaining an alias', () => {
  const ctx = ctxFor(["wiki/Vue d'ensemble.md"]);
  const r = rewriteNoteContent("![[Vue d'ensemble]]", 'wiki/note.md', ctx);
  assert.equal(r.content, '![[vue-d-ensemble]]');
});

test('path-form wikilinks and asset embeds follow directory renames', () => {
  const ctx = ctxFor(['Formations/Trend Follower/Money Management.md', 'Dossier X/img.png']);
  const links = rewriteNoteContent(
    '[[Formations/Trend Follower/Money Management]]',
    'note.md',
    ctx,
  );
  assert.equal(
    links.content,
    '[[Formations/trend-follower/money-management|Formations/Trend Follower/Money Management]]',
  );
  const asset = rewriteNoteContent('![[Dossier X/img.png|300]]', 'note.md', ctx);
  assert.equal(asset.content, '![[dossier-x/img.png|300]]');
});

test('links to untouched pages and ambiguous stems are left alone', () => {
  const ctx = ctxFor(['a/Le Plan.md', 'b/Le Plan.md', 'b/le-plan.md', 'c/ok.md']);
  const r = rewriteNoteContent('[[ok]] et [[Le Plan]]', 'note.md', ctx);
  assert.equal(r.content, '[[ok]] et [[Le Plan]]');
  assert.equal(r.skippedAmbiguous, 1);
});

// ---------------------------------------------------------------------------
// rewriteNoteContent — markdown links
// ---------------------------------------------------------------------------

test('relative markdown links are decoded, resolved and rebuilt', () => {
  const ctx = ctxFor(["wiki/Cours/Vue d'ensemble.md", 'wiki/notes/page.md']);
  const r = rewriteNoteContent(
    "cf [la vue](../Cours/Vue%20d%27ensemble.md)",
    'wiki/notes/page.md',
    ctx,
  );
  assert.equal(r.content, 'cf [la vue](../Cours/vue-d-ensemble.md)');
});

test('root-relative markdown links keep their root-relative form', () => {
  const ctx = ctxFor(["wiki/Cours/Vue d'ensemble.md"]);
  const r = rewriteNoteContent(
    'cf [la vue](/wiki/Cours/Vue%20d%27ensemble.md)',
    'wiki/notes/page.md',
    ctx,
  );
  assert.equal(r.content, 'cf [la vue](/wiki/Cours/vue-d-ensemble.md)');
});

test('external links are never touched', () => {
  const ctx = ctxFor(["wiki/Vue d'ensemble.md"]);
  const src = '[site](https://example.com/Vue%20d%27ensemble.md) [m](mailto:a@b.c)';
  const r = rewriteNoteContent(src, 'wiki/note.md', ctx);
  assert.equal(r.content, src);
});

// ---------------------------------------------------------------------------
// rewriteExactPaths (.canvas / .base)
// ---------------------------------------------------------------------------

test('canvas file fields are rewritten by exact path replacement', () => {
  const plan = buildRenamePlan(['Dossier X/img.png', "wiki/Vue d'ensemble.md"]);
  const canvas = '{"nodes":[{"file":"Dossier X/img.png"},{"file":"wiki/Vue d\'ensemble.md"}]}';
  const r = rewriteExactPaths(canvas, buildExactPathMap(plan));
  assert.equal(
    r.content,
    '{"nodes":[{"file":"dossier-x/img.png"},{"file":"wiki/vue-d-ensemble.md"}]}',
  );
  assert.equal(r.edits, 2);
});

test('exact-path map also carries bare directory paths for raw-text mentions', () => {
  const plan = buildRenamePlan(['Dossier X/sub/img.png']);
  const map = buildExactPathMap(plan);
  const r = rewriteExactPaths('voir le dossier Dossier X/sub et Dossier X/sub/img.png', map);
  assert.equal(r.content, 'voir le dossier dossier-x/sub et dossier-x/sub/img.png');
});

// ---------------------------------------------------------------------------
// okfSafePathSuggestion (ingestion-time guard)
// ---------------------------------------------------------------------------

test('okfSafePathSuggestion suggests a conformant path for offending segments', () => {
  assert.equal(okfSafePathSuggestion('wiki/Divers/Ma Page été.md'), 'wiki/Divers/ma-page-ete.md');
  assert.equal(okfSafePathSuggestion('VM Hermes/note.md'), 'vm-hermes/note.md');
});

test('okfSafePathSuggestion returns null for conformant, non-md and hidden paths', () => {
  assert.equal(okfSafePathSuggestion('wiki/Divers/okf/okf-interop.md'), null);
  assert.equal(okfSafePathSuggestion('assets/Photo é.png'), null);
  assert.equal(okfSafePathSuggestion('.obsidian/plugins/Thème é.md'), null);
});

// ---------------------------------------------------------------------------
// orderRenameOps
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildRenamePlanFromTable — explicit rename-table mode
// ---------------------------------------------------------------------------

const SCAFFOLDS = RENAME_PRESETS['okf-reserved-scaffolds'].renames;

test('table mode renames the listed files and records their stem change', () => {
  const plan = buildRenamePlanFromTable(
    ['wiki-meta/index.md', 'wiki-meta/log.md', 'wiki-meta/hot.md', 'wiki/note.md'],
    SCAFFOLDS,
  );
  assert.deepEqual(
    plan.renameOps.map((r) => [r.oldPath, r.newPath, r.isDir]),
    [
      ['wiki-meta/index.md', 'wiki-meta/catalog.md', false],
      ['wiki-meta/log.md', 'wiki-meta/journal.md', false],
    ],
  );
  assert.equal(plan.fileMap.get('wiki-meta/log.md'), 'wiki-meta/journal.md');
  assert.deepEqual(
    plan.stemRenames.map((r) => [r.oldStem, r.newStem]),
    [['index', 'catalog'], ['log', 'journal']],
  );
  assert.deepEqual(plan.collisions, []);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.ambiguousStems, []);
  assert.deepEqual(plan.collisionsResolved, []); // never auto-suffixes
});

test('table mode reports absent entries as missing, not as errors', () => {
  const plan = buildRenamePlanFromTable(['wiki-meta/log.md'], SCAFFOLDS);
  assert.deepEqual(plan.missing, ['wiki-meta/index.md']);
  assert.equal(plan.renameOps.length, 1);
  assert.deepEqual(plan.collisions, []);
});

test('table mode refuses to overwrite an existing target instead of suffixing', () => {
  const plan = buildRenamePlanFromTable(
    ['wiki-meta/index.md', 'wiki-meta/catalog.md', 'wiki-meta/log.md'],
    SCAFFOLDS,
  );
  assert.equal(plan.collisions.length, 1);
  assert.equal(plan.collisions[0].oldPath, 'wiki-meta/index.md');
  assert.match(plan.collisions[0].reason, /already exists/);
  // The non-colliding entry is still planned — the CLI is what blocks apply.
  assert.deepEqual(plan.renameOps.map((r) => r.oldPath), ['wiki-meta/log.md']);
});

test('table mode refuses a target already occupied by a directory', () => {
  const plan = buildRenamePlanFromTable(
    ['wiki-meta/index.md', 'wiki-meta/catalog/keep.md'],
    [{ oldPath: 'wiki-meta/index.md', newPath: 'wiki-meta/catalog' }],
  );
  assert.equal(plan.collisions.length, 1);
  assert.match(plan.collisions[0].reason, /directory/);
});

test('table mode refuses two entries claiming the same target', () => {
  const plan = buildRenamePlanFromTable(
    ['a/one.md', 'a/two.md'],
    [
      { oldPath: 'a/one.md', newPath: 'a/merged.md' },
      { oldPath: 'a/two.md', newPath: 'a/merged.md' },
    ],
  );
  assert.equal(plan.collisions.length, 1);
  assert.match(plan.collisions[0].reason, /two table entries/);
  assert.equal(plan.renameOps.length, 1);
});

test('table mode does not call a target occupied when the table vacates it', () => {
  // Chained rename a → b while b → c: `b` is not a collision.
  const plan = buildRenamePlanFromTable(
    ['x/a.md', 'x/b.md'],
    [
      { oldPath: 'x/a.md', newPath: 'x/b.md' },
      { oldPath: 'x/b.md', newPath: 'x/c.md' },
    ],
  );
  assert.deepEqual(plan.collisions, []);
  assert.equal(plan.renameOps.length, 2);
});

test('table mode treats an identity entry as a no-op (re-runs are idempotent)', () => {
  const plan = buildRenamePlanFromTable(
    ['wiki-meta/catalog.md', 'wiki-meta/journal.md'],
    [
      { oldPath: 'wiki-meta/catalog.md', newPath: 'wiki-meta/catalog.md' },
      ...SCAFFOLDS,
    ],
  );
  assert.deepEqual(plan.renameOps, []);
  assert.deepEqual(plan.collisions, []);
  assert.deepEqual(plan.missing, ['wiki-meta/index.md', 'wiki-meta/log.md']);
});

test('table mode renames a directory and remaps its descendants without stem churn', () => {
  const plan = buildRenamePlanFromTable(
    ['old/deep/page.md', 'old/img.png', 'keep.md'],
    [{ oldPath: 'old', newPath: 'new' }],
  );
  assert.deepEqual(plan.renameOps, [{ oldPath: 'old', newPath: 'new', isDir: true }]);
  assert.equal(plan.fileMap.get('old/deep/page.md'), 'new/deep/page.md');
  assert.equal(plan.fileMap.get('old/img.png'), 'new/img.png');
  assert.equal(plan.fileMap.has('keep.md'), false);
  assert.deepEqual(plan.stemRenames, []); // basenames unchanged → [[page]] still resolves
});

test('table mode accepts Map and tuple tables and normalizes separators', () => {
  const fromMap = buildRenamePlanFromTable(
    ['wiki-meta/index.md'],
    new Map([['wiki-meta\\index.md', './wiki-meta/catalog.md']]),
  );
  assert.equal(fromMap.fileMap.get('wiki-meta/index.md'), 'wiki-meta/catalog.md');
  const fromTuples = buildRenamePlanFromTable(
    ['wiki-meta/log.md'],
    [['wiki-meta/log.md', 'wiki-meta/journal.md']],
  );
  assert.equal(fromTuples.fileMap.get('wiki-meta/log.md'), 'wiki-meta/journal.md');
});

test('table mode flags a stem shared with a file it does not rename', () => {
  // The SCI vault case: dev-dashboard/Index.md stays put, so [[index]] cannot
  // be retargeted to [[catalog]] without guessing what the author meant.
  const plan = buildRenamePlanFromTable(
    ['wiki-meta/index.md', 'wiki-meta/log.md', 'dev-dashboard/Index.md'],
    SCAFFOLDS,
  );
  assert.deepEqual(plan.ambiguousStems, ['index']);
  assert.equal(plan.ambiguityDetail.length, 1);
  assert.deepEqual(plan.ambiguityDetail[0].conflicting, ['dev-dashboard/Index.md']);
  assert.match(plan.ambiguityDetail[0].reason, /shares this basename/);
  // …and the plan still renames the file itself, plus `log` stays clean.
  assert.equal(plan.fileMap.get('wiki-meta/index.md'), 'wiki-meta/catalog.md');
  assert.equal(plan.ambiguousStems.includes('log'), false);
});

test('table mode flags one old stem sent to two different new stems', () => {
  const plan = buildRenamePlanFromTable(
    ['a/dup.md', 'b/dup.md'],
    [
      { oldPath: 'a/dup.md', newPath: 'a/one.md' },
      { oldPath: 'b/dup.md', newPath: 'b/two.md' },
    ],
  );
  assert.deepEqual(plan.ambiguousStems, ['dup']);
  assert.match(plan.ambiguityDetail[0].reason, /several different new stems/);
});

test('ambiguous stems keep their basename wikilinks untouched in table mode', () => {
  const plan = buildRenamePlanFromTable(
    ['wiki-meta/index.md', 'wiki-meta/log.md', 'dev-dashboard/Index.md'],
    SCAFFOLDS,
  );
  const ctx = buildRewriteContext(plan, { preserveDisplay: false });
  const r = rewriteNoteContent('⟵ [[index]] · [[log]]', 'wiki/note.md', ctx);
  assert.equal(r.content, '⟵ [[index]] · [[journal]]');
  assert.equal(r.skippedAmbiguous, 1);
  // Path-form links are unaffected by stem ambiguity — the path is explicit.
  const p = rewriteNoteContent('[[wiki-meta/index]]', 'wiki/note.md', ctx);
  assert.equal(p.content, '[[wiki-meta/catalog]]');
});

// ---------------------------------------------------------------------------
// preserveDisplay: false — the visible text follows the target
// ---------------------------------------------------------------------------

function scaffoldCtx(opts) {
  return buildRewriteContext(
    buildRenamePlanFromTable(['wiki-meta/index.md', 'wiki-meta/log.md'], SCAFFOLDS),
    opts,
  );
}

test('preserveDisplay:false rewrites the footer without a display alias', () => {
  const r = rewriteNoteContent('⟵ [[index]] · [[log]]', 'wiki/note.md', scaffoldCtx({ preserveDisplay: false }));
  assert.equal(r.content, '⟵ [[catalog]] · [[journal]]');
  assert.equal(r.edits, 2);
});

test('preserveDisplay:false still keeps an alias the author wrote', () => {
  const r = rewriteNoteContent('[[log|le journal]] et [[index#Sections]]', 'wiki/n.md', scaffoldCtx({ preserveDisplay: false }));
  assert.equal(r.content, '[[journal|le journal]] et [[catalog#Sections]]');
});

test('preserveDisplay defaults to true — the 2026-07-29 behaviour is unchanged', () => {
  assert.equal(scaffoldCtx().preserveDisplay, true);
  assert.equal(scaffoldCtx({}).preserveDisplay, true);
  const r = rewriteNoteContent('⟵ [[index]]', 'wiki/note.md', scaffoldCtx());
  assert.equal(r.content, '⟵ [[catalog|index]]');
});

test('preserveDisplay:false leaves embeds alias-free as before', () => {
  const r = rewriteNoteContent('![[log]]', 'wiki/note.md', scaffoldCtx({ preserveDisplay: false }));
  assert.equal(r.content, '![[journal]]');
});

test('the scaffold preset carries the no-alias decision and the exact pair list', () => {
  const preset = RENAME_PRESETS['okf-reserved-scaffolds'];
  assert.equal(preset.preserveDisplay, false);
  assert.deepEqual(preset.renames, [
    { oldPath: 'wiki-meta/index.md', newPath: 'wiki-meta/catalog.md' },
    { oldPath: 'wiki-meta/log.md', newPath: 'wiki-meta/journal.md' },
  ]);
});

test('table mode rewrites plain-text scaffold path mentions too', () => {
  const plan = buildRenamePlanFromTable(['wiki-meta/index.md', 'wiki-meta/log.md'], SCAFFOLDS);
  const r = rewriteExactPaths(
    'Le catalogue vit dans `wiki-meta/index.md`, le journal dans wiki-meta/log.md.',
    buildExactPathMap(plan),
  );
  assert.equal(
    r.content,
    'Le catalogue vit dans `wiki-meta/catalog.md`, le journal dans wiki-meta/journal.md.',
  );
  assert.equal(r.edits, 2);
});

test('table mode rewrites markdown links to the renamed scaffolds', () => {
  const plan = buildRenamePlanFromTable(
    ['wiki-meta/index.md', 'wiki-meta/log.md', 'wiki/Divers/page.md'],
    SCAFFOLDS,
  );
  const ctx = buildRewriteContext(plan, { preserveDisplay: false });
  const r = rewriteNoteContent('cf [le log](../../wiki-meta/log.md)', 'wiki/Divers/page.md', ctx);
  assert.equal(r.content, 'cf [le log](../../wiki-meta/journal.md)');
});

// ---------------------------------------------------------------------------
// retitleScaffold — the renamed scaffold stops calling itself "Index"/"Log"
// ---------------------------------------------------------------------------

const RETITLE = RENAME_PRESETS['okf-reserved-scaffolds'].retitle;
const catalogWords = RETITLE.find((r) => r.path.endsWith('catalog.md')).words;
const journalWords = RETITLE.find((r) => r.path.endsWith('journal.md')).words;

test('retitle rewrites the H1 and the title: frontmatter, nothing else', () => {
  const src = [
    '---',
    'type: wiki-index',
    'title: "vault_tribu — Wiki Index"',
    '---',
    '',
    '# vault_tribu — Wiki Index',
    '',
    'Le mot Index dans le corps ne bouge pas.',
    '',
    '## Index des sections',
    '',
    '- [[journal]]',
    '',
  ].join('\n');
  const r = retitleScaffold(src, catalogWords);
  assert.match(r.content, /^title: "vault_tribu — Wiki Catalog"$/m);
  assert.match(r.content, /^# vault_tribu — Wiki Catalog$/m);
  // `type:` is a semantic key for lint/graph/context-pack — never renamed.
  assert.match(r.content, /^type: wiki-index$/m);
  assert.match(r.content, /^## Index des sections$/m);
  assert.match(r.content, /^Le mot Index dans le corps ne bouge pas\.$/m);
  assert.equal(r.edits, 2);
  assert.equal(r.changed, true);
});

test('retitle only touches the FIRST h1', () => {
  const r = retitleScaffold('# Log\n\ntexte\n\n# Log bis\n', journalWords);
  assert.equal(r.content, '# Journal\n\ntexte\n\n# Log bis\n');
});

test('retitle is a whole-word substitution', () => {
  const r = retitleScaffold('# Logbook and Log\n', journalWords);
  assert.equal(r.content, '# Logbook and Journal\n');
});

test('retitle is idempotent and a no-op on an already-renamed scaffold', () => {
  const once = retitleScaffold('---\ntitle: "Wiki Log"\n---\n\n# Wiki Log\n', journalWords);
  const twice = retitleScaffold(once.content, journalWords);
  assert.equal(twice.content, once.content);
  assert.equal(twice.changed, false);
  assert.equal(twice.edits, 0);
});

test('retitle handles a file with no frontmatter and no title key', () => {
  const r = retitleScaffold('# Index\n\nbody\n', catalogWords);
  assert.equal(r.content, '# Catalog\n\nbody\n');
  const noTitle = retitleScaffold('---\ntype: log\n---\n\n# Log\n', journalWords);
  assert.equal(noTitle.content, '---\ntype: log\n---\n\n# Journal\n');
});

test('the scaffold preset retitles both renamed files and leaves type: alone', () => {
  assert.deepEqual(
    RETITLE.map((r) => [r.path, r.words]),
    [
      ['wiki-meta/catalog.md', [['Index', 'Catalog']]],
      ['wiki-meta/journal.md', [['Log', 'Journal']]],
    ],
  );
});

// ---------------------------------------------------------------------------
// orderRenameOps
// ---------------------------------------------------------------------------

test('rename ops apply files first, then directories deepest-first', () => {
  const plan = buildRenamePlan(['Aa Bb/Cc Dd/Ee Ff.md']);
  const ordered = orderRenameOps(plan.renameOps);
  assert.deepEqual(
    ordered.map((r) => [r.oldPath, r.isDir]),
    [
      ['Aa Bb/Cc Dd/Ee Ff.md', false],
      ['Aa Bb/Cc Dd', true],
      ['Aa Bb', true],
    ],
  );
});
