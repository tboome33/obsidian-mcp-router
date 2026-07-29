import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isOkfSafeSegment,
  buildRenamePlan,
  buildRewriteContext,
  rewriteNoteContent,
  rewriteExactPaths,
  buildExactPathMap,
  orderRenameOps,
  okfSafePathSuggestion,
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
