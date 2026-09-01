/**
 * A1 — embedding staleness. Every case below was chosen because the FLEET
 * MEASUREMENT produced it, not because it was easy to fabricate:
 *   - the case-drifted store filename (25 records fleet-wide, 21 on one vault)
 *   - `last_import.mtime: 0` (4 records fleet-wide)
 *   - stale-but-same-size (61 of 244 stale pages, clustered on Drive vaults)
 *   - a record whose page is gone from disk (828 of 2915 fleet-wide)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessEmbeddingFreshness,
  freshnessFor,
  freshnessNote,
  parseFreshnessRecords,
  storeFileNameFor,
  isDoubtful,
  FRESH,
  CHANGED,
  TOUCHED,
  NOT_INDEXED,
  PAGE_MISSING,
  UNKNOWN,
  MTIME_TOLERANCE_MS,
  MAX_PAGES_ASSESSED,
  MAX_STORE_FILE_BYTES,
} from '../src/helpers/embedding-staleness.mjs';

// --------------------------------------------------------------------------
// A fake store, shaped exactly like the real `.ajson` append log.
// --------------------------------------------------------------------------

const INDEXED_AT = 1_700_000_000_000;

function sourceLine(pagePath, { mtime, size, at } = {}) {
  const rec = {
    path: pagePath,
    last_embed: { hash: 'abc', at: at ?? INDEXED_AT + 13_000 },
    last_import: { mtime: mtime ?? INDEXED_AT, size: size ?? 100, at: INDEXED_AT + 1, hash: 'abc' },
    embeddings: { 'TaylorAI/bge-micro-v2': { vec: [0.1, 0.2] } },
    class_name: 'SmartSource',
  };
  return `"smart_sources:${pagePath}": ${JSON.stringify(rec)},`;
}

/** A block line — 96% of a real store, and it must never be parsed. */
function blockLine(pagePath, heading) {
  return `"smart_blocks:${pagePath}#${heading}": {"key":"${pagePath}#${heading}","path":null},`;
}

/**
 * @param {object} spec { files: {name: text}, notes: {path: {mtimeMs, size}} }
 */
const enoent = (what) => Object.assign(new Error(`ENOENT ${what}`), { code: 'ENOENT' });

function makeIo(spec) {
  const files = spec.files || {};
  const notes = spec.notes || {};
  const reads = [];
  return {
    reads,
    io: {
      readdirSync(dir) {
        if (spec.readdirThrows) throw new Error('EACCES');
        if (spec.readdirReturnsGarbage) return spec.readdirReturnsGarbage;
        assert.match(String(dir), /\.smart-env[\\/]multi$/);
        return Object.keys(files);
      },
      readFileSync(p) {
        const name = String(p).split(/[\\/]/).pop();
        reads.push(name);
        if (!(name in files)) throw enoent(name);
        const v = files[name];
        if (v instanceof Error) throw v;
        return v;
      },
      statSync(p) {
        // Normalise both separators, then strip the vault root prefix.
        const norm = String(p).replace(/\\/g, '/');
        const name = norm.split('/').pop();
        // A store file (the byte-cap check) — reachable only under `multi/`.
        if (/\.smart-env\/multi\//.test(norm)) {
          if (!(name in files)) throw enoent(name);
          const v = files[name];
          if (v instanceof Error) throw v;
          return { size: spec.storeFileSize ?? String(v).length };
        }
        const rel = norm.replace(/^.*?vault\//, '');
        if (!(rel in notes)) throw enoent(rel);
        if (notes[rel] instanceof Error) throw notes[rel];
        return notes[rel];
      },
    },
  };
}

const LOCAL_VAULT = { name: 'v', type: 'local', path: '/vault' };

// --------------------------------------------------------------------------

describe('parseFreshnessRecords — the format, read once', () => {
  test('pulls last_import.mtime/size and last_embed.at from a whole-note record', () => {
    const recs = parseFreshnessRecords(sourceLine('wiki/a.md', { mtime: 5, size: 42, at: 9 }));
    assert.deepEqual(recs.get('wiki/a.md'), { importMtime: 5, importSize: 42, embeddedAt: 9, rawKey: 'wiki/a.md' });
  });

  test('LAST WINS — a page rewritten on re-index reports its newest record', () => {
    const text = [
      sourceLine('wiki/a.md', { mtime: 100 }),
      sourceLine('wiki/a.md', { mtime: 900 }),
    ].join('\n');
    assert.equal(parseFreshnessRecords(text).get('wiki/a.md').importMtime, 900);
  });

  test('null is a TOMBSTONE, not a record with no data', () => {
    const text = [sourceLine('wiki/a.md'), '"smart_sources:wiki/a.md": null,'].join('\n');
    const recs = parseFreshnessRecords(text);
    assert.equal(recs.has('wiki/a.md'), true);
    // A tombstone keeps its RAW key: without it the fold-ambiguity guard was
    // blind to a POSIX record literally named with a backslash.
    assert.deepEqual(recs.get('wiki/a.md'), { tombstoned: true, rawKey: 'wiki/a.md' });
  });

  test('block lines are skipped — they are 96% of a real store', () => {
    const text = [blockLine('wiki/a.md', 'Intro'), sourceLine('wiki/a.md')].join('\n');
    const recs = parseFreshnessRecords(text);
    assert.deepEqual([...recs.keys()], ['wiki/a.md']);
  });

  test('mtime 0 is NOT a date — it reads as absent, so 1970 is never reported', () => {
    // Measured: 4 records fleet-wide carry `last_import.mtime: 0`. Read as a
    // timestamp it makes every such page ~20 000 days stale.
    const recs = parseFreshnessRecords(sourceLine('wiki/a.md', { mtime: 0 }));
    assert.equal(recs.get('wiki/a.md').importMtime, null);
  });

  test('a malformed line costs its own line, never the file', () => {
    const text = ['"smart_sources:broken": {not json,', sourceLine('wiki/a.md')].join('\n');
    assert.equal(parseFreshnessRecords(text).has('wiki/a.md'), true);
  });

  test('backslash-keyed records fold onto forward slashes', () => {
    const line = `"smart_sources:wiki\\\\Ident\\\\x.md": ${JSON.stringify({
      last_import: { mtime: 7, size: 1 }, last_embed: { at: 8 },
    })},`;
    assert.equal(parseFreshnessRecords(line).has('wiki/Ident/x.md'), true);
  });

  test('a page literally named __proto__ lands in the Map, not on the prototype', () => {
    const recs = parseFreshnessRecords(sourceLine('__proto__', { mtime: 3 }));
    assert.equal(recs.get('__proto__').importMtime, 3);
    assert.equal(Object.getPrototypeOf({}).importMtime, undefined);
  });

  test('non-string input is total, not a throw', () => {
    assert.equal(parseFreshnessRecords(null).size, 0);
    assert.equal(parseFreshnessRecords(undefined).size, 0);
    assert.equal(parseFreshnessRecords(42).size, 0);
  });
});

describe('storeFileNameFor — a hint, and it is known to be lossy', () => {
  test('flattens slash, dot and space to underscore', () => {
    assert.equal(storeFileNameFor('wiki/a b.md'), 'wiki_a_b_md.ajson');
    assert.equal(storeFileNameFor('CLAUDE.md'), 'CLAUDE_md.ajson');
  });

  test('THREE DIFFERENT PAGES COLLIDE on one filename — which is why the record key is verified', () => {
    assert.equal(storeFileNameFor('a/b.md'), storeFileNameFor('a.b.md'));
    assert.equal(storeFileNameFor('a/b.md'), storeFileNameFor('a b.md'));
  });
});

describe('assessEmbeddingFreshness — the verdicts', () => {
  test('a note untouched since import is fresh', () => {
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }) },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.checkable, true);
    assert.equal(r.pages[0].state, FRESH);
    assert.equal(r.summary.doubtful, 0);
  });

  test('edited since import, and the size moved too → changed', () => {
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }) },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 500 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, CHANGED);
    assert.equal(r.summary.changed, 1);
    assert.equal(r.summary.doubtful, 1);
    assert.equal(r.pages[0].sizeAtImport, 100);
    assert.equal(r.pages[0].sizeNow, 500);
  });

  test('mtime moved but the size did not → touched, NOT changed', () => {
    // Measured: 61 of 244 stale pages fleet-wide, 21 of 30 on one Drive vault.
    // Collapsing this into "changed" makes a quarter of the warnings unearned.
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }) },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, TOUCHED);
    assert.equal(r.summary.touched, 1);
    assert.equal(r.summary.changed, 0);
    // …but it still counts as doubt: a same-length edit is a real thing.
    assert.equal(r.summary.doubtful, 1);
  });

  test('an identical size never SUPPRESSES the finding — only lowers its confidence', () => {
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }) },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 999_999, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(isDoubtful(r.pages[0].state), true);
  });

  test('the tolerance absorbs filesystem granularity and nothing more', () => {
    // Sizes are held EQUAL here on purpose: the tolerance governs the mtime
    // axis, and a differing size now outranks the clock entirely (see below).
    const mk = (delta) => {
      const { io } = makeIo({
        files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }) },
        notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + delta, size: 100 } },
      });
      return assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io }).pages[0].state;
    };
    assert.equal(mk(MTIME_TOLERANCE_MS), FRESH, 'exactly at the tolerance is still fresh');
    assert.equal(mk(MTIME_TOLERANCE_MS + 1), TOUCHED, 'one ms past it is not');
  });

  test('A DIFFERING SIZE OUTRANKS AN UNMOVED CLOCK — proof beats the absence of a signal', () => {
    // Found in adversarial review round 2: a page whose byte size went 100 → 999
    // under an unchanged mtime (a restored timestamp, a sync client, `touch -r`)
    // was reported `fresh` — a positive claim of currency against proof to the
    // contrary. Size is the stronger evidence and is now ranked first.
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }) },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 999 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, CHANGED);
    assert.equal(r.pages[0].sizeEvidence, 'differs');
    assert.equal(r.summary.doubtful, 1);
  });

  test('a note OLDER than its import reads fresh — the conservative direction', () => {
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }) },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT - 999_999_999, size: 100 } },
    });
    assert.equal(assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io }).pages[0].state, FRESH);
  });

  test('a store file whose NAME drifted in case is still found', () => {
    // Measured on SchoolMouv: 21 records whose store file kept a directory's
    // pre-rename casing. Without the case-folded index they read `not-indexed`.
    const { io } = makeIo({
      files: { 'wiki_DIVERS_a_md.ajson': sourceLine('wiki/divers/a.md', { mtime: INDEXED_AT, size: 100 }) },
      notes: { 'wiki/divers/a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 700 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/divers/a.md'], { fs: io });
    assert.equal(r.pages[0].state, CHANGED);
  });

  test('a file that flattens alike but speaks about ANOTHER page is refused', () => {
    // `a/b.md` and `a b.md` share one filename. The record key is the proof.
    const { io } = makeIo({
      files: { 'a_b_md.ajson': sourceLine('a b.md', { mtime: INDEXED_AT, size: 100 }) },
      notes: { 'a/b.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['a/b.md'], { fs: io });
    // CORRECTED after adversarial review. This assertion used to read
    // NOT_INDEXED, which is a claim about the VAULT built out of our own
    // ambiguity: a candidate file exists, it simply speaks about another page.
    // For a hit that came back FROM the index, "not indexed" also contradicts
    // the hit's own existence.
    assert.equal(r.pages[0].state, UNKNOWN, 'never borrow another page\'s freshness');
    assert.equal(r.pages[0].reason, 'filename-collision');
  });

  test('a page with no record at all is not-indexed', () => {
    const { io } = makeIo({
      files: { 'wiki_other_md.ajson': sourceLine('wiki/other.md') },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, NOT_INDEXED);
    assert.equal(r.summary.notIndexed, 1);
  });

  test('a tombstoned page is not-indexed, not fresh', () => {
    const { io } = makeIo({
      files: {
        'wiki_a_md.ajson': [sourceLine('wiki/a.md'), '"smart_sources:wiki/a.md": null,'].join('\n'),
      },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    assert.equal(assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io }).pages[0].state, NOT_INDEXED);
  });

  test('indexed but gone from disk → page-missing', () => {
    // 828 of 2915 records fleet-wide point at a page that no longer exists.
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: {},
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, PAGE_MISSING);
    assert.equal(r.summary.pageMissing, 1);
    assert.equal(r.summary.doubtful, 0, 'a vanished page is a different fact from a stale one');
  });

  test('no usable basis at all → unknown, never a guess', () => {
    const line = `"smart_sources:wiki/a.md": ${JSON.stringify({
      last_import: { mtime: 0, size: 100 }, last_embed: { hash: 'x' },
    })},`;
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': line },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 999_999_999, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, UNKNOWN);
    assert.equal(r.summary.unknown, 1);
  });

  test('embeddedAt is the fallback basis when the import mtime is unusable', () => {
    const line = `"smart_sources:wiki/a.md": ${JSON.stringify({
      last_import: { mtime: 0, size: 100 }, last_embed: { at: INDEXED_AT },
    })},`;
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': line },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 100 } },
    });
    assert.equal(assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io }).pages[0].state, TOUCHED);
  });

  test('a page hit by several chunks is read ONCE', () => {
    const { io, reads } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md', 'wiki/a.md', 'wiki/a.md'], { fs: io });
    assert.equal(r.pages.length, 1);
    assert.equal(reads.filter((n) => n === 'wiki_a_md.ajson').length, 1);
  });

  test('a block-anchored path falls back to its page, rather than claiming not-indexed', () => {
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }) },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 800 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md#Some heading'], { fs: io });
    assert.equal(r.pages[0].state, CHANGED);
  });

  test('the page cap truncates and SAYS SO', () => {
    const files = {};
    const notes = {};
    const paths = [];
    for (let i = 0; i < MAX_PAGES_ASSESSED + 5; i++) {
      const p = `wiki/p${i}.md`;
      paths.push(p);
      files[storeFileNameFor(p)] = sourceLine(p);
      notes[p] = { mtimeMs: INDEXED_AT, size: 100 };
    }
    const { io } = makeIo({ files, notes });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, paths, { fs: io });
    assert.equal(r.pages.length, MAX_PAGES_ASSESSED);
    assert.equal(r.pagesTruncated, true);
    // BOTH denominators: paths given, and pages those resolved to. Reporting
    // only the first is what let fifty anchors of one note read as fifty pages.
    assert.equal(r.pagesFound, MAX_PAGES_ASSESSED + 5);
    assert.equal(r.pathsTruncated, undefined, '55 paths is under the path bound — only PAGES were cut');
  });

  test('results are deterministic and follow the order asked for', () => {
    const files = {}; const notes = {};
    for (const p of ['wiki/b.md', 'wiki/a.md', 'wiki/c.md']) {
      files[storeFileNameFor(p)] = sourceLine(p);
      notes[p] = { mtimeMs: INDEXED_AT, size: 100 };
    }
    const { io } = makeIo({ files, notes });
    const order = ['wiki/c.md', 'wiki/a.md', 'wiki/b.md'];
    const r = assessEmbeddingFreshness(LOCAL_VAULT, order, { fs: io });
    assert.deepEqual(r.pages.map((p) => p.path), order);
  });
});

describe('assessEmbeddingFreshness — when it must decline', () => {
  test('a vault with no local disk is NOT checkable, and emits no verdicts', () => {
    const r = assessEmbeddingFreshness({ name: 'r', type: 'remote' }, ['wiki/a.md'], { fs: makeIo({}).io });
    assert.equal(r.checkable, false);
    assert.equal(r.reason, 'no-local-disk');
    assert.equal(r.pages, undefined, 'no pages key at all — "could not look" is not "looked and found none"');
  });

  test('a local vault with no store declines with store-missing', () => {
    const { io } = makeIo({ readdirThrows: true });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.checkable, false);
    assert.equal(r.reason, 'store-missing');
  });

  test('an empty store declines rather than reporting every page not-indexed', () => {
    const { io } = makeIo({ files: {} });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.checkable, false);
    assert.equal(r.reason, 'store-empty');
  });

  test('a readdir that answers a non-array is not an empty store', () => {
    const { io } = makeIo({ readdirReturnsGarbage: { nope: true } });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.checkable, false);
    assert.equal(r.reason, 'store-missing');
  });

  test('no paths to assess declines without pretending to have looked', () => {
    const { io } = makeIo({ files: { 'x.ajson': sourceLine('wiki/a.md') } });
    assert.equal(assessEmbeddingFreshness(LOCAL_VAULT, [], { fs: io }).reason, 'no-paths');
    assert.equal(assessEmbeddingFreshness(LOCAL_VAULT, null, { fs: io }).reason, 'no-paths');
  });

  test('an unreadable store file degrades that page, not the call', () => {
    const { io } = makeIo({
      files: {
        'wiki_a_md.ajson': new Error('EBUSY'),
        'wiki_b_md.ajson': sourceLine('wiki/b.md'),
      },
      notes: {
        'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 },
        'wiki/b.md': { mtimeMs: INDEXED_AT, size: 100 },
      },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md', 'wiki/b.md'], { fs: io });
    assert.equal(r.checkable, true);
    // CORRECTED after adversarial review. This assertion used to read
    // NOT_INDEXED — it pinned this codebase's own recurring defect, reading
    // "I could not read it" as "it is not there". Only a COMPLETE, successful
    // search of every candidate licenses `not-indexed`.
    assert.equal(r.pages[0].state, UNKNOWN);
    assert.equal(r.pages[0].reason, 'store-file-unreadable');
    assert.equal(r.pages[1].state, FRESH);
  });
});

describe('the defects an adversarial review found — each pinned', () => {
  test('a traversing path is REFUSED, never statted outside the vault', () => {
    // These paths arrive in a search hit, i.e. off the wire. Without the guard,
    // `../outside.md` was statted outside the vault root and its mtime and size
    // came back in the response.
    const statted = [];
    const io = {
      readdirSync: () => ['wiki_a_md.ajson'],
      readFileSync: () => sourceLine('wiki/a.md'),
      statSync: (p) => { statted.push(String(p)); return { size: 10, mtimeMs: INDEXED_AT }; },
    };
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['../outside.md'], { fs: io });
    assert.equal(r.checkable, false);
    assert.equal(r.reason, 'no-usable-paths');
    assert.equal(r.refusedPaths, 1);
    assert.equal(statted.some((p) => /outside/.test(p)), false, 'nothing outside the vault was statted');
  });

  test('a refused path never costs a good one its assessment, and is counted', () => {
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['../evil.md', 'wiki/a.md'], { fs: io });
    assert.equal(r.checkable, true);
    assert.equal(r.pages.length, 1);
    assert.equal(r.pages[0].state, FRESH);
    assert.equal(r.refusedPaths, 1);
  });

  test('FIFTY ANCHORS OF ONE NOTE ARE ONE PAGE, and the counts say so', () => {
    // Before the fix: 55 anchor paths of a single note produced
    // `summary.changed: 50` and `truncated: true` — one changed page reported
    // as fifty, with a per-path cap presented as a per-page cap.
    const { io, reads } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { size: 100 }) },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 900 } },
    });
    const paths = Array.from({ length: 55 }, (_, i) => `wiki/a.md#H${i}`);
    const r = assessEmbeddingFreshness(LOCAL_VAULT, paths, { fs: io });
    assert.equal(r.pages.length, 1, 'one PAGE');
    assert.equal(r.summary.checked, 1);
    assert.equal(r.summary.changed, 1);
    assert.equal(r.truncated, undefined, 'one page is not a truncated answer');
    assert.equal(reads.filter((n) => n === 'wiki_a_md.ajson').length, 1, 'and one read');
  });

  test('`changed` is never claimed off a size that was never known', () => {
    // `changed` used to be the default for any moved mtime, including when the
    // record carried no size at all — asserting a byte difference never shown.
    const line = `"smart_sources:wiki/a.md": ${JSON.stringify({
      last_import: { mtime: INDEXED_AT }, last_embed: { at: INDEXED_AT + 1 },
    })},`;
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': line },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 900 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, CHANGED);
    assert.equal(r.pages[0].sizeEvidence, 'unknown', 'the claim is mtime-only, and says so');
  });

  test('size evidence is reported on every verdict, and matches the numbers', () => {
    const { io } = makeIo({
      files: {
        'a_md.ajson': sourceLine('a.md', { size: 100 }),
        'b_md.ajson': sourceLine('b.md', { size: 100 }),
      },
      notes: {
        'a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 900 },
        'b.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 100 },
      },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['a.md', 'b.md'], { fs: io });
    assert.equal(r.pages[0].sizeEvidence, 'differs');
    assert.equal(r.pages[1].sizeEvidence, 'identical');
  });

  test('a stat failure that is NOT ENOENT is unknown, never "page-missing"', () => {
    // EACCES on a parent directory used to be reported as a vanished page — a
    // fabricated fact about the vault, built from our own inability to look.
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: { 'wiki/a.md': Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, UNKNOWN);
    assert.equal(r.pages[0].reason, 'page-unreadable');
  });

  test('ENOENT still proves absence — the distinction is kept, not flattened', () => {
    const { io } = makeIo({ files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') }, notes: {} });
    assert.equal(assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io }).pages[0].state, PAGE_MISSING);
  });

  test('two store files differing only in case give ONE answer, whatever the readdir order', () => {
    // On a case-sensitive filesystem, taking candidates in enumeration order
    // made the same store answer differently on two machines.
    const build = (order) => {
      const files = {};
      for (const n of order) {
        files[n] = n === 'WIKI_A_MD.ajson'
          ? sourceLine('wiki/a.md', { mtime: INDEXED_AT + 500_000, size: 100 })
          : sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 });
      }
      const { io } = makeIo({ files, notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 200_000, size: 100 } } });
      return assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io }).pages[0].state;
    };
    assert.equal(
      build(['WIKI_A_MD.ajson', 'Wiki_A_MD.ajson']),
      build(['Wiki_A_MD.ajson', 'WIKI_A_MD.ajson']),
      'the verdict is a function of the data, not of directory order',
    );
  });

  test('a store file past the byte cap is unknown — never an unbounded synchronous read', () => {
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
      storeFileSize: MAX_STORE_FILE_BYTES + 1,
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, UNKNOWN);
    assert.equal(r.pages[0].reason, 'store-file-too-large');
  });

  test('a TRAVERSING FRAGMENT is refused too — the guard covers both halves', () => {
    // Round 2: only the part before `#` was validated, yet the FULL string is
    // also tried as a store key — so a record for `safe.md#../../../outside.md`
    // got statted outside the vault.
    const statted = [];
    const io = {
      readdirSync: () => ['safe_md#___________outside_md.ajson'],
      readFileSync: () => sourceLine('safe.md#../../../outside.md'),
      statSync: (p) => { statted.push(String(p)); return { size: 1, mtimeMs: INDEXED_AT }; },
    };
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['safe.md#../../../outside.md'], { fs: io });
    assert.equal(r.checkable, false);
    assert.equal(r.refusedPaths, 1);
    assert.equal(statted.some((p) => /outside/.test(p)), false);
  });

  test('two spellings of one page are ONE page — the canonical form is used, not discarded', () => {
    // Round 2: `canonicalVaultPath`'s return value was thrown away, so
    // `wiki/a.md` and `wiki//a.md` produced two rows — one of them a fabricated
    // `not-indexed` — and `checked: 2` for a single page.
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md', 'wiki//a.md'], { fs: io });
    assert.equal(r.pages.length, 1);
    assert.equal(r.summary.checked, 1);
    assert.equal(r.pages[0].state, FRESH);
  });

  test('a blank or non-string entry is COUNTED as refused, not silently dropped', () => {
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, [null, '   ', 42, 'wiki/a.md'], { fs: io });
    assert.equal(r.refusedPaths, 3);
    assert.equal(r.pages.length, 1);
  });

  test('a refusal is still reported when the STORE then declines', () => {
    const { io } = makeIo({ readdirThrows: true });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['../bad.md', 'good.md'], { fs: io });
    assert.equal(r.checkable, false);
    assert.equal(r.reason, 'store-missing');
    assert.equal(r.refusedPaths, 1, 'the refusal does not vanish because something else went wrong');
  });

  test('two case-variant files DISAGREEING about one page is unknown, not a tidy pick', () => {
    // Round 2: sorting the candidates made the guess repeatable, not right.
    const { io } = makeIo({
      files: {
        'WIKI_A_MD.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT + 500_000, size: 100 }),
        'Wiki_A_MD.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }),
      },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 200_000, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, UNKNOWN);
    assert.equal(r.pages[0].reason, 'fold-ambiguous');
  });

  test('a DELETED page is page-missing even when the store file cannot be read', () => {
    // Round 2: checking the record first buried a proven fact behind a doubt.
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': new Error('EBUSY') },
      notes: {},
    });
    assert.equal(
      assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io }).pages[0].state,
      PAGE_MISSING,
    );
  });

  test('one page under a path cap is NOT a truncated answer', () => {
    // Round 2: 201 anchors of a single note reported `truncated: true` although
    // no page row was missing. The two truncations are now named apart.
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const paths = Array.from({ length: 250 }, (_, i) => `wiki/a.md#H${i}`);
    const r = assessEmbeddingFreshness(LOCAL_VAULT, paths, { fs: io });
    assert.equal(r.pages.length, 1);
    assert.equal(r.pagesTruncated, undefined, 'no page row was dropped');
    assert.equal(r.pathsTruncated, true, 'but paths WERE cut, and it says so');
    assert.equal(r.pathsGiven, 250);
    assert.equal(r.pathsResolved, 200);
  });

  test('a NaN mtime is unknown — never a positive claim of freshness', () => {
    // Round 3: `typeof === "number"` admits NaN, every `>` against it is false,
    // so the page came back `fresh` — currency claimed off a measurement that
    // does not exist, and the serialiser then printed `noteMtime: null`.
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md', { size: 100 }) },
      notes: { 'wiki/a.md': { mtimeMs: NaN, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, UNKNOWN);
    assert.equal(r.pages[0].reason, 'page-unreadable');
  });

  test('a single readable match is NOT conclusive while a competing file is unreadable', () => {
    // Round 3: the exact candidate matched and was returned as a clean verdict
    // even though a case-variant file could not be opened at all.
    const { io } = makeIo({
      files: {
        'wiki_a_md.ajson': sourceLine('wiki/a.md'),
        'WIKI_A_MD.ajson': new Error('EBUSY'),
      },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, UNKNOWN);
    assert.equal(r.pages[0].reason, 'store-file-unreadable');
  });

  test('two candidates that AGREE are not a disagreement', () => {
    // Round 3: refusing on candidate count alone turned two identical records
    // into a doubt nothing warranted.
    const { io } = makeIo({
      files: {
        'wiki_a_md.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }),
        'WIKI_A_MD.ajson': sourceLine('wiki/a.md', { mtime: INDEXED_AT, size: 100 }),
      },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    assert.equal(assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io }).pages[0].state, FRESH);
  });

  test('an ambiguity on the anchored key is NOT silently swapped for the base page', () => {
    // Round 3: ambiguity on `a.md#H` fell through to the fallback key `a.md`,
    // so the answer described a different page than the one asked about.
    const { io } = makeIo({
      files: {
        'wiki_a_md#H_ajson_x': '',
        'wiki_a_md#H.ajson': sourceLine('wiki/a.md#H'),
        'WIKI_A_MD#H.ajson': sourceLine('wiki/a.md#H', { mtime: INDEXED_AT + 900_000 }),
        'wiki_a_md.ajson': sourceLine('wiki/a.md'),
      },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md#H'], { fs: io });
    assert.equal(r.pages[0].state, UNKNOWN);
    assert.equal(r.pages[0].reason, 'fold-ambiguous');
  });

  test('a size-decided verdict is NOT labelled with a clock it never consulted', () => {
    // Round 3: `basis` was emitted whenever the fallback existed, including when
    // the differing size alone had settled the verdict.
    const line = `"smart_sources:wiki/a.md": ${JSON.stringify({
      last_import: { mtime: 0, size: 100 }, last_embed: { at: INDEXED_AT },
    })},`;
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': line },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT - 500, size: 900 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].state, CHANGED);
    assert.equal(r.pages[0].basis, undefined, 'no timestamp comparison happened');
  });

  test('every requested spelling that reached a row is listed on it', () => {
    // Round 3: rows are keyed by the resolved PAGE, so a caller could not join
    // its own anchored/non-canonical results back onto them by string.
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki//a.md', 'wiki/a.md#H1'], { fs: io });
    assert.equal(r.pages.length, 1);
    // THE ORIGINAL SPELLINGS, not the canonical ones. A caller joining its own
    // results onto these rows holds what it sent, not what we normalised it to —
    // recording only the canonical form silently dropped the annotation from
    // every hit whose path needed normalising (found in the A3 review).
    assert.ok(r.pages[0].requested.includes('wiki//a.md'), 'the spelling as it arrived');
    assert.ok(r.pages[0].requested.includes('wiki/a.md#H1'), 'and the anchored one');
  });

  test('the last_embed.at fallback is LABELLED, not passed off as the note\'s own mtime', () => {
    const line = `"smart_sources:wiki/a.md": ${JSON.stringify({
      last_import: { mtime: 0, size: 100 }, last_embed: { at: INDEXED_AT },
    })},`;
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': line },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 100 } },
    });
    const r = assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io });
    assert.equal(r.pages[0].basis, 'last-embed-at', 'a different clock — the reader must be able to tell');
  });
});

describe('freshnessFor — the wrapper a response path can rely on', () => {
  test('never throws, whatever the filesystem does', () => {
    const io = {
      readdirSync() { throw new TypeError('boom'); },
      readFileSync() { throw new TypeError('boom'); },
      statSync() { throw new TypeError('boom'); },
    };
    assert.doesNotThrow(() => freshnessFor(LOCAL_VAULT, ['wiki/a.md'], { fs: io }));
  });

  test('an internal failure DECLINES — it does not vanish into the same silence as "nothing to assess"', () => {
    // Round 2: the safety net returned `null`, so the field disappeared from the
    // response exactly as it does when there was nothing to check. The reader
    // could not tell "I could not look" from "there was nothing to look at" —
    // the rule this module exists to enforce, broken by its own catch.
    // The throw must land OUTSIDE the module's own fs guards, or the test only
    // exercises `store-missing` and the catch it claims to cover never runs.
    // An array whose element access throws does exactly that.
    const paths = ['wiki/a.md'];
    Object.defineProperty(paths, 0, { get() { throw new Error('hostile input'); } });
    const { io } = makeIo({ files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') } });
    const out = freshnessFor(LOCAL_VAULT, paths, { fs: io });
    assert.equal(typeof out, 'object');
    assert.equal(out.checkable, false);
    assert.equal(out.reason, 'assessment-failed');
    assert.match(out.detail, /NOT evidence that the results are current/);
  });

  test('"nothing to assess" is null, but "could not look" is reported', () => {
    const { io } = makeIo({ files: { 'x.ajson': sourceLine('wiki/a.md') } });
    assert.equal(freshnessFor(LOCAL_VAULT, [], { fs: io }), null);
    assert.equal(freshnessFor({ type: 'remote' }, ['wiki/a.md'], { fs: io }).reason, 'no-local-disk');
  });
});

describe('freshnessNote — one wording, or silence', () => {
  test('silent when nothing is doubtful', () => {
    const { io } = makeIo({
      files: { 'wiki_a_md.ajson': sourceLine('wiki/a.md') },
      notes: { 'wiki/a.md': { mtimeMs: INDEXED_AT, size: 100 } },
    });
    assert.equal(freshnessNote(assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md'], { fs: io })), null);
  });

  test('names the counts and what to do, and never claims more than it measured', () => {
    const { io } = makeIo({
      files: {
        'wiki_a_md.ajson': sourceLine('wiki/a.md', { size: 100 }),
        'wiki_b_md.ajson': sourceLine('wiki/b.md', { size: 100 }),
      },
      notes: {
        'wiki/a.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 900 },
        'wiki/b.md': { mtimeMs: INDEXED_AT + 86_400_000, size: 100 },
      },
    });
    const note = freshnessNote(assessEmbeddingFreshness(LOCAL_VAULT, ['wiki/a.md', 'wiki/b.md'], { fs: io }));
    assert.match(note, /1 modified since indexing/);
    assert.match(note, /size did not/);
    assert.match(note, /re-index/i);
  });

  test('declines on a non-checkable assessment instead of inventing a summary', () => {
    assert.equal(freshnessNote({ checkable: false, reason: 'no-local-disk' }), null);
    assert.equal(freshnessNote(null), null);
  });
});
