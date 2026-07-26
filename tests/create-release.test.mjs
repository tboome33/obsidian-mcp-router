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

import { extractChangelogSection } from '../scripts/create-release.mjs';
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
