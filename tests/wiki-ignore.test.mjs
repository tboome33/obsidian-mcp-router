/**
 * Tests for src/helpers/wiki-ignore.mjs — the .wikiignore matcher
 * (gitignore subset) and the starter generator.
 * Run with `npm test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWikiIgnore,
  generateStarter,
  DEFAULT_WIKIIGNORE_PATTERNS,
  _internals,
} from '../src/helpers/wiki-ignore.mjs';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('default patterns', () => {
  const ig = createWikiIgnore();

  test('excludes the derived dashboard copy directory', () => {
    assert.equal(ig.isIgnored('.understand-anything/knowledge-graph.json'), true);
  });
  test('excludes derived wiki-meta sidecar dirs (anchored)', () => {
    assert.equal(ig.isIgnored('wiki-meta/digests/wiki/Refs/oauth.md'), true);
    assert.equal(ig.isIgnored('wiki-meta/graph/knowledge-graph.json'), true);
    assert.equal(ig.isIgnored('wiki-meta/exports/llms.txt'), true);
  });
  test('keeps wiki-meta/index.md and overview (NOT excluded)', () => {
    assert.equal(ig.isIgnored('wiki-meta/index.md'), false);
    assert.equal(ig.isIgnored('wiki-meta/overview.md'), false);
  });
  test('excludes binary attachments at any depth', () => {
    assert.equal(ig.isIgnored('wiki/a/b/diagram.png'), true);
    assert.equal(ig.isIgnored('cover.pdf'), true);
    assert.equal(ig.isIgnored('wiki/notes.excalidraw'), true);
  });
  test('keeps markdown content', () => {
    assert.equal(ig.isIgnored('wiki/Refs/oauth.md'), false);
    assert.equal(ig.isIgnored('wiki/Divers/llm-wiki-compiler/llm-wiki-compiler.md'), false);
  });
  test('excludes .obsidian and .trash at any depth', () => {
    assert.equal(ig.isIgnored('.obsidian/app.json'), true);
    assert.equal(ig.isIgnored('.trash/old.md'), true);
  });
});

// ---------------------------------------------------------------------------
// Pattern semantics
// ---------------------------------------------------------------------------

describe('pattern semantics', () => {
  test('dir pattern matches the dir and its contents', () => {
    const ig = createWikiIgnore(['Archive/'], { useDefaults: false });
    assert.equal(ig.isIgnored('Archive/old.md'), true);
    assert.equal(ig.isIgnored('Archive'), true);
    assert.equal(ig.isIgnored('wiki/Archive/old.md'), true); // any depth (unanchored)
    assert.equal(ig.isIgnored('Archived.md'), false); // not a prefix match
  });
  test('anchored pattern (internal slash) only matches from root', () => {
    const ig = createWikiIgnore(['wiki/Drafts/'], { useDefaults: false });
    assert.equal(ig.isIgnored('wiki/Drafts/x.md'), true);
    assert.equal(ig.isIgnored('other/wiki/Drafts/x.md'), false);
  });
  test('glob *.draft.md at any depth', () => {
    const ig = createWikiIgnore(['*.draft.md'], { useDefaults: false });
    assert.equal(ig.isIgnored('wiki/a.draft.md'), true);
    assert.equal(ig.isIgnored('a.draft.md'), true);
    assert.equal(ig.isIgnored('wiki/a.md'), false);
  });
  test('leading-slash anchors to root', () => {
    const ig = createWikiIgnore(['/TODO.md'], { useDefaults: false });
    assert.equal(ig.isIgnored('TODO.md'), true);
    assert.equal(ig.isIgnored('wiki/TODO.md'), false);
  });
  test('negation re-includes (last match wins)', () => {
    const ig = createWikiIgnore(['Archive/', '!Archive/keep.md'], { useDefaults: false });
    assert.equal(ig.isIgnored('Archive/old.md'), true);
    assert.equal(ig.isIgnored('Archive/keep.md'), false);
  });
  test('user negation can re-include a default-excluded file', () => {
    const ig = createWikiIgnore(['!cover.pdf']);
    assert.equal(ig.isIgnored('cover.pdf'), false); // default *.pdf overridden
    assert.equal(ig.isIgnored('other.pdf'), true); // still excluded
  });
  test('** crosses segments', () => {
    const ig = createWikiIgnore(['build/**/tmp'], { useDefaults: false });
    assert.equal(ig.isIgnored('build/a/b/tmp'), true);
    assert.equal(ig.isIgnored('build/tmp'), true);
  });
  test('comments and blank lines are ignored', () => {
    const ig = createWikiIgnore('# a comment\n\n   \nDrafts/', { useDefaults: false });
    assert.deepEqual(ig.patterns, ['Drafts/']);
    assert.equal(ig.isIgnored('Drafts/x.md'), true);
  });
  test('accepts a newline string OR an array', () => {
    const a = createWikiIgnore('Foo/\nBar/', { useDefaults: false });
    const b = createWikiIgnore(['Foo/', 'Bar/'], { useDefaults: false });
    assert.deepEqual(a.patterns, b.patterns);
  });
  test('empty path / non-string → not ignored', () => {
    const ig = createWikiIgnore();
    assert.equal(ig.isIgnored(''), false);
    assert.equal(ig.isIgnored(null), false);
  });
});

// ---------------------------------------------------------------------------
// normalisePath
// ---------------------------------------------------------------------------

describe('normalisePath', () => {
  test('backslashes, leading ./ and /, collapse //', () => {
    assert.equal(_internals.normalisePath('.\\wiki\\\\a.md'), 'wiki/a.md');
    assert.equal(_internals.normalisePath('/wiki/a.md'), 'wiki/a.md');
    assert.equal(_internals.normalisePath('./a.md'), 'a.md');
  });
});

// ---------------------------------------------------------------------------
// generateStarter
// ---------------------------------------------------------------------------

describe('generateStarter', () => {
  test('lists defaults as comments + documents the source-node invariant', () => {
    const s = generateStarter();
    assert.match(s, /# \.wikiignore/);
    for (const p of DEFAULT_WIKIIGNORE_PATTERNS) {
      assert.ok(s.includes(`#   ${p}`), `documents default ${p}`);
    }
    assert.match(s, /source. node/i);
    // The starter itself must not introduce active (uncommented) patterns.
    const active = s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.deepEqual(active, []);
  });
});

// ---------------------------------------------------------------------------
// ReDoS guards (review CRITICAL) — an attacker-influenced .wikiignore must
// not compile to a catastrophically-backtracking regex.
// ---------------------------------------------------------------------------

describe('ReDoS guards', () => {
  test('a long run of consecutive stars collapses to ONE quantifier (no hang)', () => {
    const pattern = `a${'*'.repeat(40)}b`; // 40 stars — the measured 80s case pre-fix
    const ig = createWikiIgnore([pattern], { useDefaults: false });
    assert.deepEqual(ig.patterns, [pattern]); // 1 wildcard run → kept
    const start = process.hrtime.bigint();
    assert.equal(ig.isIgnored(`a${'x'.repeat(120)}`), false); // no trailing b → no match
    assert.equal(ig.isIgnored(`a${'x'.repeat(60)}b`), true);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 100, `matching took ${ms}ms (expected < 100ms — would be ~80s pre-fix)`);
  });

  test('too many "**" runs → pattern dropped with a warning', () => {
    const pattern = '**a'.repeat(5); // 5 '**' runs > MAX_DOUBLE_STAR_RUNS (2)
    const ig = createWikiIgnore([pattern], { useDefaults: false });
    assert.deepEqual(ig.patterns, []);
    assert.ok(ig.warnings.some((w) => /too many wildcards/.test(w)));
  });

  test('over-long pattern → dropped with a warning', () => {
    const ig = createWikiIgnore(['a'.repeat(600)], { useDefaults: false });
    assert.deepEqual(ig.patterns, []);
    assert.ok(ig.warnings.some((w) => /too long/.test(w)));
  });
});
