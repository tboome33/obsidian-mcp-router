/**
 * Tests for the release plumbing added when the v0.8.2→v0.47.0 tag drift
 * was discovered (40 versions shipped, 0 tags, 0 GitHub releases):
 *
 *   - `extractChangelogSection()` (scripts/create-release.mjs) — the pure
 *     CHANGELOG parser that release notes are built from.
 *   - `ensureHooksPath()` (scripts/bump-version.mjs) — the self-healing
 *     `core.hooksPath = .githooks` wiring that arms the post-commit
 *     auto-tag hook on every bump.
 *
 * The push / gh-release side of create-release.mjs is deliberately NOT
 * exercised here (network + auth); its preconditions are pure functions
 * tested below.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  extractChangelogSection,
  isStubEntry,
  parseChangelogVersions,
  selectPendingReleases,
  highestVersion,
} from '../scripts/create-release.mjs';
import { ensureHooksPath } from '../scripts/bump-version.mjs';

const SAMPLE = `# Changelog

## [Unreleased]

Nothing pending.

## [0.48.0] — 2026-07-26 — docs refresh + release automation

Docs caught up with reality; tags stop drifting.

### Added

- Post-commit auto-tag hook.

## [0.47.0] — 2026-07-17 — BM25 relevance filter

Second-pass filtering.

## [0.8.2] — 2026-05-06 — Wiki auto-enrichment Phase 1

Oldest entry, ends at EOF.
`;

describe('extractChangelogSection', () => {
  test('extracts heading, title and body of a middle entry', () => {
    const s = extractChangelogSection(SAMPLE, '0.47.0');
    assert.ok(s);
    assert.equal(s.heading, '## [0.47.0] — 2026-07-17 — BM25 relevance filter');
    assert.equal(s.title, 'BM25 relevance filter');
    assert.equal(s.body, 'Second-pass filtering.');
  });

  test('body runs to the next ## [ heading, subsections included', () => {
    const s = extractChangelogSection(SAMPLE, '0.48.0');
    assert.ok(s.body.includes('### Added'));
    assert.ok(s.body.includes('Post-commit auto-tag hook.'));
    assert.ok(!s.body.includes('BM25'), 'must stop before the next version entry');
  });

  test('last entry extends to EOF', () => {
    const s = extractChangelogSection(SAMPLE, '0.8.2');
    assert.equal(s.body, 'Oldest entry, ends at EOF.');
  });

  test('title parses multi-em-dash headings after the date', () => {
    const raw = '# Changelog\n\n## [1.0.0] — 2026-01-01 — big one — with a twist\n\nBody.\n';
    const s = extractChangelogSection(raw, '1.0.0');
    assert.equal(s.title, 'big one — with a twist');
  });

  test('falls back to the heading remainder when the — date — title shape is absent', () => {
    const raw = '# Changelog\n\n## [1.0.0] hotfix\n\nBody.\n';
    const s = extractChangelogSection(raw, '1.0.0');
    assert.equal(s.title, 'hotfix');
  });

  test('returns null for a version without an entry', () => {
    assert.equal(extractChangelogSection(SAMPLE, '9.9.9'), null);
  });

  test('version string is treated literally, not as a regex', () => {
    // "0.4x.0" as a regex would match "0.47.0" via the dot — must not.
    assert.equal(extractChangelogSection(SAMPLE, '0.4..0'), null);
  });
});

describe('parseChangelogVersions', () => {
  test('lists every versioned heading, ignoring [Unreleased]', () => {
    const raw = '# Changelog\n\n## [Unreleased]\n\n## [0.52.1] — d — t\n\nx\n\n## [0.51.0] — d — t\n\ny\n';
    assert.deepEqual(parseChangelogVersions(raw), ['0.52.1', '0.51.0']);
  });

  test('an empty changelog yields no versions', () => {
    assert.deepEqual(parseChangelogVersions('# Changelog\n'), []);
  });
});

describe('selectPendingReleases', () => {
  const changelogVersions = ['0.52.1', '0.52.0', '0.51.0', '0.8.2'];

  test('returns the backlog ascending, newest last', () => {
    const pending = selectPendingReleases({
      changelogVersions,
      localTags: ['v0.52.1', 'v0.52.0', 'v0.51.0', 'v0.8.2'],
      publishedTags: ['v0.8.2'],
    });
    assert.deepEqual(pending, ['0.51.0', '0.52.0', '0.52.1'], 'oldest first, so GitHub chronology matches');
  });

  test('a version documented but never tagged is NOT resurrected', () => {
    // The 40 pre-v0.48.0 versions: CHANGELOG entries, no tags, no commit to
    // release. Requiring a tag is what keeps them out.
    const pending = selectPendingReleases({
      changelogVersions: ['0.52.1', '0.9.0'],
      localTags: ['v0.52.1'],
      publishedTags: [],
    });
    assert.deepEqual(pending, ['0.52.1']);
  });

  test('an already-published version is skipped', () => {
    const pending = selectPendingReleases({
      changelogVersions,
      localTags: ['v0.52.1', 'v0.52.0'],
      publishedTags: ['v0.52.1', 'v0.52.0'],
    });
    assert.deepEqual(pending, []);
  });

  test('a tag with no CHANGELOG entry has no notes, so no release', () => {
    const pending = selectPendingReleases({
      changelogVersions: ['0.52.1'],
      localTags: ['v0.52.1', 'v0.99.0'],
      publishedTags: [],
    });
    assert.deepEqual(pending, ['0.52.1']);
  });

  test('tolerates tags given with or without the v prefix', () => {
    const pending = selectPendingReleases({
      changelogVersions: ['0.52.1'],
      localTags: ['0.52.1'],
      publishedTags: [],
    });
    assert.deepEqual(pending, ['0.52.1']);
  });
});

describe('highestVersion', () => {
  test('compares by semver, not lexicographically', () => {
    assert.equal(highestVersion(['0.9.0', '0.52.1', '0.10.0']), '0.52.1');
  });

  test('handles patch ordering', () => {
    assert.equal(highestVersion(['0.52.0', '0.52.1']), '0.52.1');
  });

  test('returns null on an empty list', () => {
    assert.equal(highestVersion([]), null);
  });
});

describe('isStubEntry', () => {
  test('flags the untouched bump stub', () => {
    const raw = '# Changelog\n\n## [1.0.0] — 2026-01-01 — TODO: one-line title\n\nTODO: short description of the change.\n\n### Added / Changed / Fixed\n\n- TODO\n';
    assert.equal(isStubEntry(extractChangelogSection(raw, '1.0.0')), true);
  });

  test('flags a partially-filled stub that kept a "- TODO" bullet', () => {
    const raw = '# Changelog\n\n## [1.0.0] — 2026-01-01 — real title\n\nReal intro.\n\n- TODO\n';
    assert.equal(isStubEntry(extractChangelogSection(raw, '1.0.0')), true);
  });

  test('does NOT flag a real entry that mentions TODO in prose', () => {
    // The v0.48.0 entry describes the guard itself ("refuses while the
    // entry still contains the bump TODO stub") — that must pass.
    const raw = '# Changelog\n\n## [1.0.0] — 2026-01-01 — guard shipped\n\nRefuses while the entry still contains the bump `TODO` stub; also tracks TODO comments in code.\n';
    assert.equal(isStubEntry(extractChangelogSection(raw, '1.0.0')), false);
  });
});

describe('ensureHooksPath', () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookspath-'));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function makeGitRepo() {
    const root = fs.mkdtempSync(path.join(workDir, 'repo-'));
    const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
    return root;
  }

  function readHooksPath(root) {
    const r = spawnSync('git', ['config', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
    return r.stdout.trim();
  }

  test('sets core.hooksPath on a repo where it is unset', () => {
    const root = makeGitRepo();
    const result = ensureHooksPath(root);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(readHooksPath(root), '.githooks');
  });

  test('is a no-op when already wired', () => {
    const root = makeGitRepo();
    ensureHooksPath(root);
    const again = ensureHooksPath(root);
    assert.deepEqual(again, { ok: true, changed: false });
  });

  test('rewires a repo pointing somewhere else, reporting the previous value', () => {
    const root = makeGitRepo();
    spawnSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: root, encoding: 'utf8' });
    const result = ensureHooksPath(root);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.before, '.husky');
    assert.equal(readHooksPath(root), '.githooks');
  });

  test('fails open (ok: false, no throw) outside a git repo', () => {
    const root = fs.mkdtempSync(path.join(workDir, 'not-a-repo-'));
    const result = ensureHooksPath(root);
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});
