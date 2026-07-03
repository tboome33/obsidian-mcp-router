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
import { parseFrontmatter } from '../src/helpers/llms-txt-exporter.mjs';

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

  test('SECURITY: embedded newlines are collapsed, never emitted as a multi-line YAML block scalar', () => {
    // A literal \n in a value would otherwise produce a single-quoted YAML
    // BLOCK scalar (valid YAML — single-quoted scalars allow literal
    // newlines) that can itself contain a bare `---` line. Our own
    // frontmatter reader (parseFrontmatter, a line/colon parser, not a real
    // YAML parser) then misreads that line as a second frontmatter fence
    // and silently corrupts the rest of the document. Regression for a
    // /review+ BLOCKER finding.
    const evil = 'end of doc\n---\ntype: hacked';
    const yaml = serializeOkfFrontmatter({ type: 'note', notes: evil });
    assert.ok(!yaml.includes('\n---\n'), 'no bare --- line must appear inside the frontmatter block');
    // Reparsing must NOT let the corrupted body forge a second document —
    // the notes value must round-trip as a single sanitized line.
    const full = `${yaml}\n\nBody.\n`;
    const { frontmatter, body } = parseFrontmatter(full);
    assert.equal(frontmatter.type, 'note');
    assert.equal(frontmatter.notes, 'end of doc --- type: hacked');
    assert.equal(body.trim(), 'Body.');
  });

  test('CRLF values are also collapsed to a single space', () => {
    const yaml = serializeOkfFrontmatter({ title: 'Line one\r\nLine two' });
    // The collapsed value has no trigger character left, so it's emitted
    // unquoted — a bare scalar is still valid, unambiguous YAML.
    assert.match(yaml, /title: Line one Line two$/m);
    assert.ok(!yaml.includes('\r'));
  });
});

// ---------------------------------------------------------------------------
// rewriteWikilinks
// ---------------------------------------------------------------------------

function makeResolver(map) {
  return (target) => map[target] ?? map[target.split('/').pop()] ?? null;
}

function emptyReport() {
  return { anchorsDropped: [], dangling: [], embeds: [], ambiguousLinks: [] };
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

  test('REGRESSION (codex): self-document heading link is demoted to plain text, not a broken link', () => {
    // [[#Details]] has an EMPTY target (a same-document heading reference).
    // Before the fix, this fell into the dangling-link branch and slugified
    // the empty string into a nonsensical `page.md` target.
    const report = emptyReport();
    const out = rewriteWikilinks('See [[#Details]] below.', 'here.md', makeResolver({}), report);
    assert.equal(out, 'See Details below.');
    assert.equal(report.dangling.length, 0);
    assert.equal(report.anchorsDropped.length, 1);
    assert.match(report.anchorsDropped[0], /self-document reference/);
  });

  test('REGRESSION (codex): self-document block-ref link uses the alias when present', () => {
    // Obsidian's same-document block-reference syntax is `[[#^block-id]]`
    // (the `#` before `^` is what marks it same-document — `[[^id]]` alone
    // would be a same-document link to a DIFFERENT page literally named "^id").
    const out = rewriteWikilinks(
      '[[#^my-block|jump here]]', 'here.md', makeResolver({}), emptyReport(),
    );
    assert.equal(out, 'jump here');
  });

  test('REGRESSION (codex): a pre-existing markdown link to an exported page is repointed at the new slugified path', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      'See [the other page](reseau-vital-original.md) for details.',
      'concepts/foo-bar.md',
      makeResolver({ 'reseau-vital-original.md': 'refs/reseau-vital.md' }),
      report,
    );
    assert.equal(out, 'See [the other page](../refs/reseau-vital.md) for details.');
  });

  test('REGRESSION (codex): a percent-encoded markdown link target (spaces/accents) is decoded before resolution', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      'See [the other page](R%C3%A9seau%20Vital.md) for details.',
      'concepts/foo-bar.md',
      makeResolver({ 'Réseau Vital.md': 'refs/reseau-vital.md' }),
      report,
    );
    assert.equal(out, 'See [the other page](../refs/reseau-vital.md) for details.');
  });

  test('markdown link left untouched when it does not resolve to an exported page', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      'See [external](https://example.com/x.md) and [unrelated](not-exported.md).',
      'here.md', makeResolver({}), report,
    );
    assert.equal(out, 'See [external](https://example.com/x.md) and [unrelated](not-exported.md).');
  });

  test('markdown link already pointing at the correct path is left as-is (no report noise)', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      '[Other](other.md)', 'here.md', makeResolver({ 'other.md': 'other.md' }), report,
    );
    assert.equal(out, '[Other](other.md)');
    assert.equal(report.anchorsDropped.length, 0);
  });

  test('markdown link anchor is dropped and reported like a wikilink anchor', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      '[Other](other.md#Section)', 'here.md', makeResolver({ 'other.md': 'other.md' }), report,
    );
    assert.equal(out, '[Other](other.md)');
    assert.equal(report.anchorsDropped.length, 1);
  });

  test('REGRESSION (codex pass 2): a wikilink inside a fenced code block is NOT rewritten', () => {
    const report = emptyReport();
    const body = [
      'Here is an example:',
      '',
      '```',
      'See [[Other Page]] for the syntax.',
      '```',
      '',
      'And a real reference: [[Other Page]].',
    ].join('\n');
    const out = rewriteWikilinks(body, 'here.md', makeResolver({ 'Other Page': 'other-page.md' }), report);
    assert.match(out, /```\nSee \[\[Other Page\]\] for the syntax\.\n```/);
    assert.match(out, /And a real reference: \[Other Page\]\(other-page\.md\)\./);
  });

  test('REGRESSION (codex pass 2): a markdown link inside inline code is NOT rewritten', () => {
    const report = emptyReport();
    const out = rewriteWikilinks(
      'Write it like `[label](other.md)` — see [the real one](other.md) below.',
      'here.md', makeResolver({ 'other.md': 'renamed.md' }), report,
    );
    assert.equal(
      out,
      'Write it like `[label](other.md)` — see [the real one](renamed.md) below.',
    );
  });

  test('REGRESSION (codex pass 2): a fenced code block documenting markdown-link syntax survives untouched', () => {
    const body = [
      '# How to link pages',
      '',
      '```markdown',
      '[Customers table](/tables/customers.md)',
      '```',
    ].join('\n');
    const out = rewriteWikilinks(body, 'here.md', makeResolver({}), emptyReport());
    assert.equal(out, body);
  });

  test('code-span protection does not affect bodies with no code at all', () => {
    const out = rewriteWikilinks(
      'See [[Other Page]].', 'here.md',
      makeResolver({ 'Other Page': 'other-page.md' }), emptyReport(),
    );
    assert.equal(out, 'See [Other Page](other-page.md).');
  });
});

// ---------------------------------------------------------------------------
// rewriteWikilinks — ambiguous basename resolution (makeTargetResolver via buildOkfBundle)
// ---------------------------------------------------------------------------

describe('buildOkfBundle — ambiguous basename resolution (codex regression)', () => {
  test('two exported pages sharing a basename: same-folder candidate wins, reported', () => {
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/concepts/Foo.md', ['type: concept', 'title: Foo in concepts'], 'x'),
        page('wiki/refs/Foo.md', ['type: reference', 'title: Foo in refs'], 'y'),
        page(
          'wiki/concepts/Bar.md',
          ['type: concept', 'title: Bar'],
          'See [[Foo]] for details.',
        ),
      ],
    });
    const bar = fileByPath(files, 'concepts/bar.md');
    // Bar.md lives in concepts/ — the same-folder Foo (concepts/foo.md) must win.
    assert.match(bar.content, /\[Foo\]\(foo\.md\)/);
    assert.equal(report.ambiguousLinks.length, 1);
    assert.match(report.ambiguousLinks[0], /matches 2 pages/);
  });

  test('ambiguous basename, both candidates equally exact-case, no same-folder: falls back to alphabetical, still reported', () => {
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/b-folder/Foo.md', ['type: concept', 'title: Foo B'], 'x'),
        page('wiki/a-folder/Foo.md', ['type: concept', 'title: Foo A'], 'y'),
        page('wiki/notes/Bar.md', ['type: concept', 'title: Bar'], 'See [[Foo]].'),
      ],
    });
    const bar = fileByPath(files, 'notes/bar.md');
    assert.match(bar.content, /\[Foo\]\(\.\.\/a-folder\/foo\.md\)/);
    assert.equal(report.ambiguousLinks.length, 1);
  });

  test('REGRESSION (codex pass 2): a case-differing twin is detected even when the exact-case lookup alone would find a single match', () => {
    // Before the fix: byBasename.get('foo') found exactly 1 candidate
    // (concepts/foo.md) and returned immediately, NEVER consulting
    // byBasenameLower — so the existence of refs/FOO.md (a different file,
    // realistically coexistable across two folders even on a
    // case-insensitive filesystem) went completely undetected/unreported.
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/concepts/foo.md', ['type: concept', 'title: foo lowercase'], 'x'),
        page('wiki/refs/FOO.md', ['type: reference', 'title: FOO uppercase'], 'y'),
        page('wiki/notes/Bar.md', ['type: concept', 'title: Bar'], 'See [[foo]].'),
      ],
    });
    assert.equal(report.ambiguousLinks.length, 1);
    assert.match(report.ambiguousLinks[0], /matches 2 pages/);
    // The link text matched the LOWERCASE candidate exactly — exact-case
    // preference must still pick it over the uppercase twin.
    const bar = fileByPath(files, 'notes/bar.md');
    assert.match(bar.content, /\[foo\]\(\.\.\/concepts\/foo\.md\)/);
    assert.match(report.ambiguousLinks[0], /exact-case preference/);
  });

  test('REGRESSION (codex pass 2): an explicit relative markdown link is resolved against its OWN target, not redirected by same-folder tie-break', () => {
    // The citing page's own folder (concepts/) also contains a DIFFERENT
    // page named Other.md. Before the fix, the raw `../refs/Other.md`
    // target was passed straight to basename resolution (losing the
    // relative-path information), and the same-folder-preference
    // tie-break silently redirected the link to concepts/other.md instead
    // of the explicitly-linked refs/other.md.
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/refs/Other.md', ['type: reference', 'title: The real target'], 'refs body'),
        page('wiki/concepts/Other.md', ['type: concept', 'title: Unrelated same-name page'], 'decoy body'),
        page(
          'wiki/concepts/Foo Bar.md',
          ['type: concept', 'title: Foo Bar'],
          'See [ref](../refs/Other.md) for details.',
        ),
      ],
    });
    const fooBar = fileByPath(files, 'concepts/foo-bar.md');
    assert.match(fooBar.content, /\[ref\]\(\.\.\/refs\/other\.md\)/);
    // Exact vault-path resolution — never ambiguous, nothing to report.
    assert.equal(report.ambiguousLinks.length, 0);
  });

  test('BLOCKER REGRESSION (codex pass 3): a broken relative markdown link stays dangling, never "accidentally" repointed via basename fallback', () => {
    // Confirmed by direct reproduction: `../nonexistent/Target.md` doesn't
    // resolve to ANY real page, but before the fix, the resolve() cascade
    // let the joined-but-nonexistent path fall through to basename
    // matching (its basename "Target" coincidentally matched two OTHER
    // unrelated pages elsewhere), silently repointing the link at a random
    // one of them instead of leaving it dangling — the exact failure mode
    // the pass-1 fix was meant to eliminate, reintroduced by the two-step
    // resolve cascade.
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/other/Target.md', ['type: note', 'title: Other Target'], 'x'),
        page('wiki/deep/Target.md', ['type: note', 'title: Deep Target'], 'y'),
        page(
          'wiki/concepts/Foo Bar.md',
          ['type: note', 'title: Foo Bar'],
          'See [ref](../nonexistent/Target.md) for details.',
        ),
      ],
    });
    const fooBar = fileByPath(files, 'concepts/foo-bar.md');
    // Left EXACTLY as authored — a path-shaped target that doesn't
    // resolve is untouched, not silently redirected.
    assert.match(fooBar.content, /\[ref\]\(\.\.\/nonexistent\/Target\.md\)/);
    assert.equal(report.ambiguousLinks.length, 0);
  });

  test('REGRESSION (codex pass 3): a root-relative markdown link (/path.md) resolves against the vault root, ignoring the citing page folder', () => {
    const { files } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/refs/Other.md', ['type: reference', 'title: Root Target'], 'z'),
        page(
          'wiki/concepts/Foo Bar.md',
          ['type: note', 'title: Foo Bar'],
          'Root link: [r2](/refs/Other.md).',
        ),
      ],
    });
    const fooBar = fileByPath(files, 'concepts/foo-bar.md');
    assert.match(fooBar.content, /\[r2\]\(\.\.\/refs\/other\.md\)/);
  });

  test('a bare-filename markdown link (no "/" at all) still uses basename resolution as before', () => {
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/refs/Other.md', ['type: reference', 'title: The target'], 'z'),
        page(
          'wiki/concepts/Foo Bar.md',
          ['type: note', 'title: Foo Bar'],
          'See [ref](Other.md) for details.',
        ),
      ],
    });
    const fooBar = fileByPath(files, 'concepts/foo-bar.md');
    assert.match(fooBar.content, /\[ref\]\(\.\.\/refs\/other\.md\)/);
    assert.equal(report.ambiguousLinks.length, 0);
  });

  test('REGRESSION (codex pass 3): when ALL candidates equally match exact-case, that tier is a no-op and same-folder still wins', () => {
    // a-folder/Foo.md and b-folder/Foo.md have the IDENTICAL case — the
    // exact-case tier doesn't discriminate anything here (both equally
    // match the target's written case). Before the fix, `.find()` picked
    // whichever candidate happened to iterate first (array/insertion
    // order, i.e. alphabetical-by-SOURCE-path) as "the" exact-case match
    // and returned it immediately — even when the CITING page lived in
    // the OTHER (later-sorted) folder, silently overriding the more
    // meaningful same-folder tie-break.
    const { files, report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/a-folder/Foo.md', ['type: concept', 'title: Foo A'], 'x'),
        page('wiki/b-folder/Foo.md', ['type: concept', 'title: Foo B'], 'y'),
        // Citing page lives in b-folder — the LATER-sorted candidate.
        page('wiki/b-folder/Bar.md', ['type: concept', 'title: Bar'], 'See [[Foo]].'),
      ],
    });
    const bar = fileByPath(files, 'b-folder/bar.md');
    assert.match(bar.content, /\[Foo\]\(foo\.md\)/); // same folder → b-folder/foo.md
    assert.equal(report.ambiguousLinks.length, 1);
    assert.match(report.ambiguousLinks[0], /same-folder preference/);
  });

  test('unambiguous basename resolution produces no ambiguousLinks entries', () => {
    const { report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        page('wiki/refs/Baz.md', ['type: reference', 'title: Baz'], 'x'),
        page('wiki/concepts/Foo.md', ['type: concept', 'title: Foo'], 'See [[Baz]].'),
      ],
    });
    assert.equal(report.ambiguousLinks.length, 0);
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

  test('REGRESSION: wiki-meta/ exclusion survives backslash and leading-./ paths', () => {
    // The wiki-meta/ filter is a prefix check on `p.path` — this is the
    // ONLY enforcement point keeping private working data out of a shared
    // bundle, so it must not silently stop working if a caller passes a
    // non-canonical path (backslashes, leading ./). Regression for a
    // /review+ IMPORTANT finding.
    const { report } = buildOkfBundle({
      vaultName: 'V',
      now: NOW,
      pages: [
        { path: 'wiki-meta\\hot.md', content: '---\ntype: hot\n---\n\nHot.' },
        { path: './wiki-meta/log.md', content: '---\ntype: log\n---\n\nLog.' },
        page('wiki/notes/a.md', ['type: note', 'title: A', 'description: d'], 'A.'),
      ],
    });
    assert.equal(report.documentCount, 1);
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
