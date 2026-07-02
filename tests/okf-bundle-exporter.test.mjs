/**
 * Tests for src/helpers/okf-bundle-exporter.mjs — OKF v0.1 bundle export.
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  slugifyOkfSegment,
  slugifyOkfPath,
  relativeLink,
  rewriteWikilinks,
  buildOkfFrontmatter,
  serializeOkfFrontmatter,
  buildOkfBundle,
  OKF_VERSION,
} from '../src/helpers/okf-bundle-exporter.mjs';
import { checkOkfConformance } from '../src/helpers/okf-conformance-checker.mjs';

const NOW = '2026-07-03T10:00:00+00:00';

function page(path, frontmatterLines, body) {
  return {
    path,
    content: `---\n${frontmatterLines.join('\n')}\n---\n\n${body}`,
  };
}

function fileByPath(files, path) {
  return files.find((f) => f.path === path);
}

// ---------------------------------------------------------------------------
// slugifyOkfSegment / slugifyOkfPath
// ---------------------------------------------------------------------------

describe('slugifyOkfSegment', () => {
  test('transliterates accents and replaces spaces', () => {
    assert.equal(
      slugifyOkfSegment('Cours 2 - Réseaux de neurones'),
      'cours-2-reseaux-de-neurones',
    );
  });

  test('collapses runs of invalid characters into one dash', () => {
    assert.equal(slugifyOkfSegment('a  &  b'), 'a-b');
  });

  test('strips leading dots and dashes (first char must be [A-Za-z0-9_])', () => {
    assert.equal(slugifyOkfSegment('...hidden'), 'hidden');
    assert.equal(slugifyOkfSegment('--x'), 'x');
  });

  test('keeps underscores and inner dots', () => {
    assert.equal(slugifyOkfSegment('my_file.v2'), 'my_file.v2');
  });

  test('falls back to "page" when nothing survives', () => {
    assert.equal(slugifyOkfSegment('¿¡'), 'page');
  });
});

describe('slugifyOkfPath', () => {
  test('strips the leading wiki/ segment', () => {
    assert.equal(slugifyOkfPath('wiki/Divers/Ma Page.md'), 'divers/ma-page.md');
  });

  test('slugifies every segment independently', () => {
    assert.equal(
      slugifyOkfPath('wiki/Dossier Été/Note à moi.md'),
      'dossier-ete/note-a-moi.md',
    );
  });

  test('keeps non-wiki roots as folders', () => {
    assert.equal(slugifyOkfPath('Concepts/Foo.md'), 'concepts/foo.md');
  });
});

// ---------------------------------------------------------------------------
// relativeLink
// ---------------------------------------------------------------------------

describe('relativeLink', () => {
  test('same directory', () => {
    assert.equal(relativeLink('a/x.md', 'a/y.md'), 'y.md');
  });

  test('down into a subdirectory from root', () => {
    assert.equal(relativeLink('x.md', 'a/b.md'), 'a/b.md');
  });

  test('up and across', () => {
    assert.equal(relativeLink('a/b/x.md', 'a/y.md'), '../y.md');
    assert.equal(relativeLink('a/x.md', 'b/y.md'), '../b/y.md');
  });

  test('nested file up to root', () => {
    assert.equal(relativeLink('a/x.md', 'y.md'), '../y.md');
  });
});

// ---------------------------------------------------------------------------
// buildOkfFrontmatter
// ---------------------------------------------------------------------------

describe('buildOkfFrontmatter', () => {
  test('emits the four reference-implementation keys', () => {
    const fm = buildOkfFrontmatter(
      { type: 'concept', title: 'Foo', description: 'A thing.' },
      'Body.', 'foo', NOW,
    );
    assert.equal(fm.type, 'concept');
    assert.equal(fm.title, 'Foo');
    assert.equal(fm.description, 'A thing.');
    assert.equal(fm.timestamp, NOW);
  });

  test('missing type defaults to note and warns', () => {
    const warnings = [];
    const fm = buildOkfFrontmatter({}, 'Body.', 'foo', NOW, warnings);
    assert.equal(fm.type, 'note');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing `type`/);
  });

  test('url is mapped to resource', () => {
    const fm = buildOkfFrontmatter(
      { type: 'source', url: 'https://example.com/a' },
      '', 'foo', NOW,
    );
    assert.equal(fm.resource, 'https://example.com/a');
    assert.equal(fm.url, undefined);
  });

  test('description is synthesized from the first body paragraph', () => {
    const fm = buildOkfFrontmatter(
      { type: 'concept' },
      '# Title\n\nThis explains the concept in one sentence. And more after.',
      'foo', NOW,
    );
    assert.equal(fm.description, 'This explains the concept in one sentence.');
  });

  test('description synthesis strips wikilinks and markdown links', () => {
    const fm = buildOkfFrontmatter(
      { type: 'concept' },
      'See [[Other Page|the other]] and [docs](https://x.y) for details on many many things.',
      'foo', NOW,
    );
    assert.ok(!fm.description.includes('[['));
    assert.ok(!fm.description.includes(']('));
    assert.match(fm.description, /the other/);
  });

  test('timestamp picks the most recent known date field', () => {
    const fm = buildOkfFrontmatter(
      { type: 'source', ingested_at: '2026-01-01', updated: '2026-06-15', created: '2025-12-01' },
      '', 'foo', NOW,
    );
    assert.equal(fm.timestamp, '2026-06-15');
  });

  test('unmapped keys are preserved; wikilink arrays flattened to slugs', () => {
    const fm = buildOkfFrontmatter(
      {
        type: 'concept',
        source_type: 'inferred',
        related: ['[[page-a]]', '[[page-b|B]]'],
      },
      '', 'foo', NOW,
    );
    assert.equal(fm.source_type, 'inferred');
    assert.deepEqual(fm.related, ['page-a', 'page-b']);
  });
});

// ---------------------------------------------------------------------------
// serializeOkfFrontmatter
// ---------------------------------------------------------------------------

describe('serializeOkfFrontmatter', () => {
  test('scalars inline, arrays as block lists, timestamp quoted', () => {
    const yaml = serializeOkfFrontmatter({
      type: 'concept',
      title: 'Foo',
      tags: ['a', 'b'],
      timestamp: '2026-07-03',
    });
    assert.equal(
      yaml,
      "---\ntype: concept\ntitle: Foo\ntags:\n- a\n- b\ntimestamp: '2026-07-03'\n---",
    );
  });

  test('values containing colons are quoted', () => {
    const yaml = serializeOkfFrontmatter({ title: 'Foo: bar' });
    assert.match(yaml, /title: 'Foo: bar'/);
  });

  test('single quotes inside values are doubled', () => {
    const yaml = serializeOkfFrontmatter({ description: "Cole's loop: x" });
    assert.match(yaml, /description: 'Cole''s loop: x'/);
  });
});

// ---------------------------------------------------------------------------
// rewriteWikilinks
// ---------------------------------------------------------------------------

function makeResolver(map) {
  return (target) => map[target] ?? map[target.split('/').pop()] ?? null;
}

function emptyReport() {
  return { anchorsDropped: [], dangling: [], embeds: [] };
}

describe('rewriteWikilinks', () => {
  test('resolved wikilink becomes a relative markdown link', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      'See [[Other Page]].', 'concepts/here.md',
      makeResolver({ 'Other Page': 'refs/other-page.md' }), report,
    );
    assert.equal(out, 'See [Other Page](../refs/other-page.md).');
    assert.equal(report.dangling.length, 0);
  });

  test('alias is kept as the label', () => {
    const out = rewriteWikilinks(
      '[[Other Page|see this]]', 'here.md',
      makeResolver({ 'Other Page': 'other-page.md' }), emptyReport(),
    );
    assert.equal(out, '[see this](other-page.md)');
  });

  test('heading anchors are dropped and reported', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      '[[Other Page#Section 2]]', 'here.md',
      makeResolver({ 'Other Page': 'other-page.md' }), report,
    );
    assert.equal(out, '[Other Page](other-page.md)');
    assert.equal(report.anchorsDropped.length, 1);
  });

  test('unresolved target becomes a dangling slugified link and is reported', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      '[[Page Absente]]', 'divers/here.md', makeResolver({}), report,
    );
    assert.equal(out, '[Page Absente](../page-absente.md)');
    assert.equal(report.dangling.length, 1);
  });

  test('markdown page embed is demoted to a plain link', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      '![[Other Page]]', 'here.md',
      makeResolver({ 'Other Page': 'other-page.md' }), report,
    );
    assert.equal(out, '[Other Page](other-page.md)');
    assert.equal(report.embeds.length, 1);
  });

  test('asset embed keeps image syntax with a slugified name', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      '![[Schéma Final.PNG]]', 'here.md', makeResolver({}), report,
    );
    assert.equal(out, '![Schéma Final.PNG](schema-final.png)');
    assert.equal(report.embeds.length, 1);
  });
});

// ---------------------------------------------------------------------------
// buildOkfBundle — end to end
// ---------------------------------------------------------------------------

describe('buildOkfBundle', () => {
  test('validates its inputs', () => {
    assert.throws(() => buildOkfBundle({ pages: [], now: NOW }), TypeError);
    assert.throws(() => buildOkfBundle({ vaultName: 'V', now: NOW }), TypeError);
    assert.throws(
      () => buildOkfBundle({ vaultName: 'V', pages: [], now: 'not-a-date' }),
      TypeError,
    );
  });

  test('excludes wiki-meta/ pages defensively', () => {
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki-meta/hot.md', ['type: hot'], 'Hot.'),
        page('wiki/notes/a.md', ['type: note', 'title: A', 'description: d'], 'A.'),
      ],
    });
    assert.equal(report.documentCount, 1);
    assert.ok(!files.some((f) => f.path.includes('hot')));
  });

  test('is deterministic — same input, byte-identical output', () => {
    const pages = [
      page('wiki/concepts/Foo Bar.md', ['type: concept', 'title: Foo Bar'], 'See [[Baz]].'),
      page('wiki/refs/Baz.md', ['type: reference', 'title: Baz'], 'Baz body.'),
    ];
    const a = buildOkfBundle({ vaultName: 'V', pages, now: NOW });
    const b = buildOkfBundle({ vaultName: 'V', pages, now: NOW });
    assert.deepEqual(a.files, b.files);
  });

  test('rewrites cross-folder wikilinks between slugified paths', () => {
    const { files } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/concepts/Foo Bar.md', ['type: concept', 'title: Foo Bar'], 'See [[Réseau Vital]].'),
        page('wiki/refs/Réseau Vital.md', ['type: reference', 'title: Réseau Vital'], 'Body.'),
      ],
    });
    const foo = fileByPath(files, 'concepts/foo-bar.md');
    assert.match(foo.content, /\[Réseau Vital\]\(\.\.\/refs\/reseau-vital\.md\)/);
  });

  test('renames content pages that collide with reserved filenames', () => {
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [page('wiki/notes/index.md', ['type: note', 'title: Fake Index'], 'Body.')],
    });
    assert.ok(fileByPath(files, 'notes/index-page.md'));
    assert.equal(report.renamed.length, 1);
    // notes/index.md still exists — but as the GENERATED directory index.
    const generated = fileByPath(files, 'notes/index.md');
    assert.match(generated.content, /\[Fake Index\]\(index-page\.md\)/);
  });

  test('resolves slug collisions deterministically with -2 suffix', () => {
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/A B.md', ['type: note', 'title: One'], 'x'),
        page('wiki/a-b.md', ['type: note', 'title: Two'], 'y'),
      ],
    });
    assert.ok(fileByPath(files, 'a-b.md'));
    assert.ok(fileByPath(files, 'a-b-2.md'));
    assert.equal(report.renamed.length, 1);
  });

  test('root index carries only okf_version frontmatter + title + summary', () => {
    const { files } = buildOkfBundle({
      vaultName: 'Mon Vault',
      now: NOW,
      summary: 'Une base de test.',
      pages: [page('wiki/concepts/A.md', ['type: concept', 'title: A', 'description: d'], 'x')],
    });
    const root = fileByPath(files, 'index.md');
    assert.match(root.content, /^---\nokf_version: '0\.1'\n---\n/);
    assert.match(root.content, /# Mon Vault/);
    assert.match(root.content, /> Une base de test\./);
    assert.match(root.content, /# Subdirectories/);
    assert.match(root.content, /\* \[concepts\]\(concepts\/index\.md\) - Contains 1 document/);
  });

  test('per-folder index groups by type with canonical bullet shape', () => {
    const { files } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/refs/B.md', ['type: reference', 'title: Bravo', 'description: About B.'], 'x'),
        page('wiki/refs/A.md', ['type: reference', 'title: Alpha', 'description: About A.'], 'x'),
        page('wiki/refs/C.md', ['type: concept', 'title: Charlie', 'description: About C.'], 'x'),
      ],
    });
    const idx = fileByPath(files, 'refs/index.md');
    // Sections sorted by type, entries sorted by title, `* [Title](file) - desc`
    const conceptPos = idx.content.indexOf('# Concept');
    const referencePos = idx.content.indexOf('# Reference');
    assert.ok(conceptPos >= 0 && referencePos > conceptPos);
    assert.match(idx.content, /\* \[Alpha\]\(a\.md\) - About A\./);
    assert.ok(idx.content.indexOf('[Alpha]') < idx.content.indexOf('[Bravo]'));
    // No frontmatter on non-root indexes.
    assert.ok(!idx.content.startsWith('---'));
  });

  test('log.md is newest-first with a Creation entry dated from now', () => {
    const { files } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [page('wiki/a.md', ['type: note', 'title: A'], 'x')],
    });
    const log = fileByPath(files, 'log.md');
    assert.match(log.content, /# Update Log/);
    assert.match(log.content, /## 2026-07-03/);
    assert.match(log.content, /\*\*Creation\*\*: Exported 1 document /);
  });

  test('includeAgentReadme emits README.md and protects the name', () => {
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      includeAgentReadme: true,
      pages: [
        page('wiki/a.md', ['type: note', 'title: A'], 'x'),
        page('wiki/README.md', ['type: note', 'title: My Readme'], 'y'),
      ],
    });
    const readme = fileByPath(files, 'README.md');
    assert.match(readme.content, /Open Knowledge Format/);
    assert.match(readme.content, /progressive disclosure/);
    assert.ok(fileByPath(files, 'readme-page.md'));
    assert.equal(report.renamed.length, 1);
  });

  test('exported bundle passes the OKF conformance checker with zero errors', () => {
    const { files } = buildOkfBundle({
      vaultName: 'Vault Complet',
      now: NOW,
      summary: 'Cross-check bundle.',
      includeAgentReadme: true,
      pages: [
        page(
          'wiki/concepts/Économie Circulaire.md',
          ['type: concept', 'title: Économie circulaire', 'tags: [eco, cycle]'],
          'Voir [[Références Utiles#Section|les refs]] et ![[graphique.png]].\n\nUn paragraphe descriptif suffisant pour la synthèse.',
        ),
        page(
          'wiki/refs/Références Utiles.md',
          ['type: reference', 'title: Références utiles', 'url: https://example.com'],
          'Contenu avec [[Page Inconnue]] pendante.',
        ),
        page('wiki/notes/log.md', ['type: note', 'title: Journal perso'], 'Réservé!'),
      ],
    });
    const result = checkOkfConformance(files);
    assert.deepEqual(result.errors, []);
    assert.equal(result.conformant, true);
  });
});
