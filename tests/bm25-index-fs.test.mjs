/**
 * Tests for src/helpers/bm25-index-fs.mjs — the DISK-side BM25 index builder
 * that gives a newly-provisioned vault its `wiki-meta/search-index.json` before
 * Obsidian has ever opened it.
 *
 * Behavioural, not textual: every case builds a real vault tree under a temp
 * directory, runs the builder, and inspects the bytes it produced (or did not
 * produce). Nothing here touches a real vault or the user's router config.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateSearchIndexOnDisk } from '../src/helpers/bm25-index-fs.mjs';
import {
  automaticIndexAction,
  indexProblem,
  looksLikeSearchIndex,
  queryIndex,
  SEARCH_INDEX_PATH,
  INDEX_VERSION,
} from '../src/helpers/bm25-index.mjs';
import { generateProjectionsOnDisk } from '../src/helpers/okf-projections-fs.mjs';

let vaultDir;

const PAGE = (title, body) =>
  `---\ntype: note\ntitle: "${title}"\ndescription: "About ${title}"\ncreated: 2026-07-01\n---\n\n${body}\n`;

function writePage(rel, content) {
  const abs = path.join(vaultDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function readIndex() {
  return JSON.parse(fs.readFileSync(path.join(vaultDir, ...SEARCH_INDEX_PATH.split('/')), 'utf8'));
}

function indexExists() {
  return fs.existsSync(path.join(vaultDir, ...SEARCH_INDEX_PATH.split('/')));
}

/** A genuine, self-consistent index of the CURRENT version (built, not faked). */
function buildValidIndex() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-fixture-'));
  try {
    fs.mkdirSync(path.join(scratch, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'wiki', 'x.md'), PAGE('X', 'Corps.'), 'utf8');
    generateSearchIndexOnDisk(scratch, { apply: true });
    return JSON.parse(fs.readFileSync(path.join(scratch, ...SEARCH_INDEX_PATH.split('/')), 'utf8'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-fs-'));
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe('generateSearchIndexOnDisk — construction', () => {
  test('builds a queryable index from a wiki tree on disk', () => {
    writePage('wiki/concepts/marmotte.md', PAGE('Marmotte', 'La marmotte hiberne dans un terrier alpin.'));
    writePage('wiki/concepts/chamois.md', PAGE('Chamois', 'Le chamois grimpe les parois calcaires.'));

    const result = generateSearchIndexOnDisk(vaultDir, { apply: true, vaultName: 'temp-vault' });

    assert.equal(result.written, true, 'should have written the index');
    assert.equal(result.indexState, 'absent', 'nothing was there before');
    assert.equal(result.pagesScanned, 2);
    assert.ok(indexExists(), `${SEARCH_INDEX_PATH} should exist on disk`);

    const index = readIndex();
    assert.equal(index.version, INDEX_VERSION);
    assert.equal(indexProblem(index), null, 'the written index must be usable as-is');
    assert.equal(index.vault, 'temp-vault');

    // The real proof: it answers a query about content that only exists on disk.
    const { hits } = queryIndex({ index, query: 'marmotte terrier' });
    assert.ok(hits.length > 0, 'a term from the corpus must score');
    assert.equal(hits[0].path, 'wiki/concepts/marmotte.md');
  });

  test('plan mode (apply:false) writes nothing', () => {
    writePage('wiki/a.md', PAGE('A', 'Contenu.'));
    const result = generateSearchIndexOnDisk(vaultDir, { apply: false });
    assert.equal(result.written, false);
    assert.equal(indexExists(), false, 'plan mode must not create the file');
    assert.ok(result.stats.chunks > 0, 'it still reports what it WOULD build');
  });

  test('a vault with no wiki/ is skipped, not failed', () => {
    fs.mkdirSync(path.join(vaultDir, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'Notes', 'x.md'), '# x\n');
    const result = generateSearchIndexOnDisk(vaultDir, { apply: true });
    assert.equal(result.skipped, 'no-wiki');
    assert.equal(result.written, false);
    assert.equal(indexExists(), false);
  });

  test('a newborn wiki (projections only, no content) still gets a valid empty index', () => {
    fs.mkdirSync(path.join(vaultDir, 'wiki'), { recursive: true });
    generateProjectionsOnDisk(vaultDir, { apply: true, now: '2026-08-08' });

    const result = generateSearchIndexOnDisk(vaultDir, { apply: true });
    assert.equal(result.written, true);
    const index = readIndex();
    assert.equal(indexProblem(index), null, 'an empty index must still be a VALID index');
    assert.equal(index.stats.chunks, 0, 'generated projections are not content and must not be indexed');
  });

  test('generated projections are excluded from the corpus', () => {
    writePage('wiki/notes/page.md', PAGE('Page', 'Corps unique zwiebelkuchen.'));
    generateProjectionsOnDisk(vaultDir, { apply: true, now: '2026-08-08' });
    assert.ok(fs.existsSync(path.join(vaultDir, 'wiki', 'notes', 'index.md')), 'fixture sanity');

    const result = generateSearchIndexOnDisk(vaultDir, { apply: true });
    assert.equal(result.pagesScanned, 1, 'only the content page counts');
    const index = readIndex();
    for (const chunk of index.chunks) {
      assert.notEqual(chunk.path, 'wiki/index.md');
      assert.notEqual(chunk.path, 'wiki/log.md');
      assert.notEqual(chunk.path, 'wiki/notes/index.md');
    }
  });
});

describe('generateSearchIndexOnDisk — idempotence by fingerprint', () => {
  test('an unchanged corpus rebuilds to upToDate and does NOT rewrite the file', () => {
    writePage('wiki/a.md', PAGE('A', 'Contenu stable.'));
    const first = generateSearchIndexOnDisk(vaultDir, { apply: true });
    assert.equal(first.written, true);

    const abs = path.join(vaultDir, ...SEARCH_INDEX_PATH.split('/'));
    const bytesBefore = fs.readFileSync(abs);
    // Poison the file with a byte-detectable marker OUTSIDE the JSON semantics
    // is not possible without breaking the parse, so compare bytes directly.
    const second = generateSearchIndexOnDisk(vaultDir, { apply: true });

    assert.equal(second.upToDate, true, 'second pass must report upToDate');
    assert.equal(second.written, false, 'second pass must not write');
    assert.equal(second.indexState, 'current');
    assert.deepEqual(fs.readFileSync(abs), bytesBefore, 'the file must be byte-identical');
  });

  test('editing a page makes the stored index stale and triggers a rewrite', () => {
    writePage('wiki/a.md', PAGE('A', 'Premier contenu.'));
    generateSearchIndexOnDisk(vaultDir, { apply: true });
    const fingerprintBefore = readIndex().fingerprint;

    writePage('wiki/a.md', PAGE('A', 'Second contenu, totalement different.'));
    const result = generateSearchIndexOnDisk(vaultDir, { apply: true });

    assert.equal(result.indexState, 'stale');
    assert.equal(result.written, true);
    assert.notEqual(readIndex().fingerprint, fingerprintBefore);
  });

  test('a corrupted index OF OURS is repaired (it claims to be ours)', () => {
    writePage('wiki/a.md', PAGE('A', 'Contenu.'));
    generateSearchIndexOnDisk(vaultDir, { apply: true });

    const abs = path.join(vaultDir, ...SEARCH_INDEX_PATH.split('/'));
    const broken = readIndex();
    broken.integrity = 'deadbeef';
    fs.writeFileSync(abs, JSON.stringify(broken), 'utf8');
    assert.equal(looksLikeSearchIndex(broken), true, 'fixture sanity: it still claims to be an index');

    const result = generateSearchIndexOnDisk(vaultDir, { apply: true });
    assert.equal(result.indexState, 'integrity-failed');
    assert.equal(result.written, true, 'our own corrupted index must be rebuilt, not preserved');
    assert.equal(indexProblem(readIndex()), null);
  });
});

describe('generateSearchIndexOnDisk — squatters are never overwritten', () => {
  test("someone else's JSON at the index path is preserved and reported", () => {
    writePage('wiki/a.md', PAGE('A', 'Contenu.'));
    const abs = path.join(vaultDir, ...SEARCH_INDEX_PATH.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const squatter = JSON.stringify({ mine: true, notes: ['do not clobber'] });
    fs.writeFileSync(abs, squatter, 'utf8');

    const result = generateSearchIndexOnDisk(vaultDir, { apply: true });

    assert.equal(result.indexState, 'foreign-file');
    assert.equal(result.written, false);
    assert.deepEqual(result.conflicts, [SEARCH_INDEX_PATH]);
    assert.equal(fs.readFileSync(abs, 'utf8'), squatter, 'the file must be byte-intact');
  });

  test('unparseable content at the index path is preserved too (we cannot tell whose it is)', () => {
    writePage('wiki/a.md', PAGE('A', 'Contenu.'));
    const abs = path.join(vaultDir, ...SEARCH_INDEX_PATH.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'not json at all', 'utf8');

    const result = generateSearchIndexOnDisk(vaultDir, { apply: true });
    // Distinct from 'foreign-file': we could not even parse it, so we cannot say
    // whose it is — but the answer is the same, preserve it.
    assert.equal(result.indexState, 'unparseable');
    assert.deepEqual(result.conflicts, [SEARCH_INDEX_PATH]);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'not json at all');
  });

  test('an index from ANOTHER router generation is preserved, not re-written', async () => {
    // Two routers on one synced vault, each with a different INDEX_VERSION, each
    // correctly judging the other's index unusable. If both rebuilt, the file
    // would ping-pong forever and never be right for whoever read it next.
    writePage('wiki/a.md', PAGE('A', 'Contenu.'));
    const abs = path.join(vaultDir, ...SEARCH_INDEX_PATH.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const foreign = JSON.stringify({ version: INDEX_VERSION + 5, postings: {}, chunks: [], fingerprint: 'zz' });
    fs.writeFileSync(abs, foreign, 'utf8');

    const result = generateSearchIndexOnDisk(vaultDir, { apply: true });

    assert.equal(result.indexState, 'foreign-version');
    assert.equal(result.written, false);
    assert.deepEqual(result.conflicts, [SEARCH_INDEX_PATH]);
    assert.equal(fs.readFileSync(abs, 'utf8'), foreign, 'the other generation’s index must be byte-intact');
    assert.match(result.warnings.join(' '), /Migrate deliberately/);
  });

  test('preserveForeignIndexFile:false restores the blunt overwrite (the explicit-tool posture)', () => {
    writePage('wiki/a.md', PAGE('A', 'Contenu.'));
    const abs = path.join(vaultDir, ...SEARCH_INDEX_PATH.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'not json at all', 'utf8');

    const result = generateSearchIndexOnDisk(vaultDir, { apply: true, preserveForeignIndexFile: false });
    assert.equal(result.written, true);
    assert.equal(indexProblem(readIndex()), null);
  });
});

describe('automaticIndexAction — what an UNATTENDED rebuild may do', () => {
  const FP = 'fingerprint-of-the-current-corpus';
  const ours = (extra = {}) => ({ version: INDEX_VERSION, postings: {}, chunks: [], fingerprint: FP, ...extra });

  test('absent → build', () => {
    assert.deepEqual(automaticIndexAction(null, FP), { action: 'build', state: 'absent' });
  });

  test('unparseable → foreign (preserve)', () => {
    assert.equal(automaticIndexAction({ __unparseable: true }, FP).action, 'foreign');
  });

  test('parsed but not an index → foreign (preserve)', () => {
    assert.deepEqual(automaticIndexAction({ notes: ['mine'] }, FP), { action: 'foreign', state: 'foreign-file' });
  });

  test('another router generation → incompatible (preserve, never ping-pong)', () => {
    const other = { version: INDEX_VERSION + 1, postings: {}, chunks: [] };
    assert.deepEqual(automaticIndexAction(other, FP), { action: 'incompatible', state: 'foreign-version' });
  });

  test('our version, integrity broken → rebuild', () => {
    // A real index of ours whose self-digest no longer matches.
    const broken = ours({ integrity: 'deadbeef', idf: {}, avgdl: 0 });
    assert.equal(automaticIndexAction(broken, FP).action, 'rebuild');
  });

  test('our version, shape broken → rebuild (it is still ours)', () => {
    assert.equal(automaticIndexAction({ version: INDEX_VERSION, chunks: 'not an array' }, FP).action, 'rebuild');
  });

  test('our version, fingerprint differs → rebuild (stale)', () => {
    const stale = { ...buildValidIndex(), fingerprint: 'something-else' };
    const decision = automaticIndexAction(stale, FP);
    assert.equal(decision.action, 'rebuild');
  });

  test('our version, current → skip', () => {
    const index = buildValidIndex();
    assert.deepEqual(automaticIndexAction(index, index.fingerprint), { action: 'skip', state: 'current' });
  });
});

describe('looksLikeSearchIndex — "is this ours to rewrite"', () => {
  test('accepts anything that claims the shape', () => {
    assert.equal(looksLikeSearchIndex({ version: 2, postings: {} }), true);
    assert.equal(looksLikeSearchIndex({ version: 1, chunks: [] }), true, 'a foreign VERSION is still ours');
    assert.equal(looksLikeSearchIndex({ version: 2, fingerprint: 'abc' }), true);
  });

  test('rejects anything that does not', () => {
    assert.equal(looksLikeSearchIndex(null), false);
    assert.equal(looksLikeSearchIndex([]), false);
    assert.equal(looksLikeSearchIndex('a string'), false);
    assert.equal(looksLikeSearchIndex({ notes: [] }), false);
    assert.equal(looksLikeSearchIndex({ version: '2', postings: {} }), false, 'version must be a number');
    assert.equal(looksLikeSearchIndex({ version: 2 }), false, 'version alone is not enough');
  });

  test('does not answer for inherited properties', () => {
    const poisoned = JSON.parse('{"__proto__": {"version": 2, "postings": {}}}');
    assert.equal(looksLikeSearchIndex(poisoned), false);
  });
});
