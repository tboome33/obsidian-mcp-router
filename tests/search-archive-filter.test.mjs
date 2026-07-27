/**
 * Tests for src/helpers/archive-filter.mjs — the default exclusion of
 * archived deliberation (`archives/` folders, `type: decision-archive`)
 * from search_smart results. Contract: meta-vault decision
 * `consolidation-sans-amnesie` (accepted 2026-07-28).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isArchivePath, filterArchiveResults } from '../src/helpers/archive-filter.mjs';

describe('isArchivePath', () => {
  test('matches an archives directory segment at any depth', () => {
    assert.equal(isArchivePath('archives/x.md'), true);
    assert.equal(isArchivePath('wiki/decisions/archives/x-deliberation.md'), true);
    assert.equal(isArchivePath('wiki/Divers/ADR/archives/adr-modes-ecriture-deliberation.md'), true);
  });

  test('tolerates case and backslash separators', () => {
    assert.equal(isArchivePath('wiki\\Archives\\x.md'), true);
    assert.equal(isArchivePath('Wiki/ARCHIVES/x.md'), true);
  });

  test('keeps chunk paths carrying heading anchors', () => {
    assert.equal(isArchivePath('wiki/decisions/archives/x.md#Contexte#{1}'), true);
  });

  test('a page or folder merely NAMED archives is not an archive folder', () => {
    assert.equal(isArchivePath('wiki/archives.md'), false);
    assert.equal(isArchivePath('wiki/mes-archives/x.md'), false);
    assert.equal(isArchivePath('wiki/archives-2026/x.md'), false);
  });

  test('null-safe', () => {
    assert.equal(isArchivePath(undefined), false);
    assert.equal(isArchivePath(null), false);
  });
});

describe('filterArchiveResults', () => {
  const hit = (path) => ({ path, text: '…', score: 0.7 });
  const payload = (paths) => ({ results: paths.map(hit), extra: 'kept' });

  test('drops archive hits and reports the count', () => {
    const raw = payload(['wiki/a.md', 'wiki/decisions/archives/x.md', 'wiki/b.md']);
    const { data, archivesExcluded } = filterArchiveResults(raw);
    assert.equal(archivesExcluded, 1);
    assert.deepEqual(data.results.map((r) => r.path), ['wiki/a.md', 'wiki/b.md']);
    assert.equal(data.extra, 'kept', 'the rest of the payload is preserved');
  });

  test('trims the overfetch back to limit after filtering', () => {
    const raw = payload(['a.md', 'archives/x.md', 'b.md', 'c.md', 'd.md']);
    const { data, archivesExcluded } = filterArchiveResults(raw, { limit: 2 });
    assert.equal(archivesExcluded, 1);
    assert.deepEqual(data.results.map((r) => r.path), ['a.md', 'b.md']);
  });

  test('includeArchives passes everything through untouched', () => {
    const raw = payload(['a.md', 'archives/x.md']);
    const { data, archivesExcluded } = filterArchiveResults(raw, { includeArchives: true, limit: 1 });
    assert.equal(archivesExcluded, 0);
    assert.equal(data, raw, 'no overfetch happened, so no trim either');
  });

  test('payload without a results array is untouched (bridge error shape)', () => {
    const raw = { error: 'Smart Connections plugin is not available' };
    const { data, archivesExcluded } = filterArchiveResults(raw);
    assert.equal(archivesExcluded, 0);
    assert.equal(data, raw);
  });

  test('nothing dropped, nothing trimmed → same object, count 0', () => {
    const raw = payload(['wiki/a.md', 'wiki/b.md']);
    const { data, archivesExcluded } = filterArchiveResults(raw, { limit: 10 });
    assert.equal(archivesExcluded, 0);
    assert.equal(data, raw);
  });

  test('a page in the top ranking made ONLY of archive chunks empties honestly', () => {
    const raw = payload(['archives/x.md#A', 'archives/x.md#B']);
    const { data, archivesExcluded } = filterArchiveResults(raw, { limit: 2 });
    assert.equal(archivesExcluded, 2);
    assert.deepEqual(data.results, []);
  });
});
