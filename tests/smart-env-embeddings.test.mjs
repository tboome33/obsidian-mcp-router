/**
 * smart-env-embeddings — the reader for Smart Connections' on-disk vector
 * store. The format is an APPEND LOG written by a third-party plugin, and each
 * test here pins one of the ways that bites.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAjsonSources,
  parseAjsonRecordEvents,
  reconcileSmartEnvStore,
  readSmartEnvEmbeddings,
  SOURCE_KEY_PREFIX,
} from '../src/helpers/smart-env-embeddings.mjs';

const MODEL = 'TaylorAI/bge-micro-v2';

/** One append-log line, in the plugin's exact shape: `"<key>": {…},` */
function line(key, value) {
  return `${JSON.stringify(key)}: ${JSON.stringify(value)},`;
}
function sourceRecord(path, vec, model = MODEL) {
  return { path, class_name: 'SmartSource', embeddings: { [model]: { vec } } };
}
/** A block record — bulky, carries raw note text, and must never be parsed. */
function blockRecord(path, vec) {
  return {
    key: `${path}#Heading`, class_name: 'SmartBlock', text: 'x'.repeat(400),
    embeddings: { [MODEL]: { vec } },
  };
}

describe('parseAjsonSources — the append log', () => {
  test('reads a whole-note vector', () => {
    const { records, lines, malformed } = parseAjsonSources(
      line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 2, 3])),
    );
    assert.equal(lines, 1);
    assert.equal(malformed, 0);
    assert.deepEqual(records.get('wiki/a.md'), { vec: [1, 2, 3], model: MODEL });
  });

  test('LAST WINS — a rewritten page must not return its superseded vector', () => {
    const text = [
      line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 0, 0])),
      line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [0, 1, 0])),
      line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [0, 0, 1])),
    ].join('\n');
    const { records } = parseAjsonSources(text);
    assert.deepEqual(
      records.get('wiki/a.md').vec, [0, 0, 1],
      'the append log updates by appending; first-wins would compare a page against its own past',
    );
  });

  test('`null` is a TOMBSTONE, not "a record without embeddings"', () => {
    const text = [
      line(`${SOURCE_KEY_PREFIX}wiki/gone.md`, sourceRecord('wiki/gone.md', [1, 2, 3])),
      `${JSON.stringify(`${SOURCE_KEY_PREFIX}wiki/gone.md`)}: null,`,
    ].join('\n');
    const { records } = parseAjsonSources(text);
    assert.ok(records.has('wiki/gone.md'), 'the retraction must be visible to the merger');
    assert.equal(records.get('wiki/gone.md'), null);
  });

  test('block records are skipped BY PREFIX — never parsed', () => {
    // Blocks are ~96% of the lines and all of the bulk. A block line that
    // reached the parser would also overwrite nothing, but it would cost the
    // 54% the prefix filter buys.
    const text = [
      line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 2, 3])),
      line('smart_blocks:wiki/a.md#H', blockRecord('wiki/a.md', [9, 9, 9])),
    ].join('\n');
    const { records, lines } = parseAjsonSources(text);
    assert.equal(lines, 1, 'only the source line may be counted as read');
    assert.equal(records.size, 1);
    assert.deepEqual(records.get('wiki/a.md').vec, [1, 2, 3]);
  });

  test('a block line MENTIONING the source prefix is still skipped', () => {
    // The real files put `"key":"smart_sources:…"` inside block records; a
    // substring test rather than a line-start test would re-admit every block.
    const text = line('smart_blocks:wiki/a.md#H', {
      class_name: 'SmartBlock', key: `${SOURCE_KEY_PREFIX}wiki/a.md`,
      embeddings: { [MODEL]: { vec: [7, 7, 7] } },
    });
    const { records, lines } = parseAjsonSources(text);
    assert.equal(lines, 0);
    assert.equal(records.size, 0);
  });

  test('a malformed line is counted and skipped, never thrown on', () => {
    const text = [
      line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 2, 3])),
      `"${SOURCE_KEY_PREFIX}wiki/b.md": {"embeddings": {truncated`,
      line(`${SOURCE_KEY_PREFIX}wiki/c.md`, sourceRecord('wiki/c.md', [4, 5, 6])),
    ].join('\n');
    const { records, malformed } = parseAjsonSources(text);
    assert.equal(malformed, 1);
    assert.equal(records.size, 2, 'one truncated write must not cost the other 63 000 lines');
  });

  test('a vector with a non-finite component is refused, not admitted as NaN', () => {
    // NaN compares false against every threshold, so such a page would vanish
    // from the ranking WITHOUT being counted anywhere.
    const text = line(`${SOURCE_KEY_PREFIX}wiki/a.md`, {
      class_name: 'SmartSource', embeddings: { [MODEL]: { vec: [1, null, 3] } },
    });
    assert.equal(parseAjsonSources(text).records.size, 0);
  });

  test('a page keyed `__proto__` lands in ordinary data', () => {
    const text = line(`${SOURCE_KEY_PREFIX}__proto__`, sourceRecord('__proto__', [1, 2, 3]));
    const { records } = parseAjsonSources(text);
    assert.deepEqual(records.get('__proto__'), { vec: [1, 2, 3], model: MODEL });
    assert.equal(Object.prototype.polluted, undefined);
  });

  test('EVERY rejected record is counted, not only the unparseable ones', () => {
    // Seven deliberately faulty records used to be reported as ONE. The six
    // silent ones are all VALID JSON — an array value, a string value, an empty
    // page path, `vec` that is not an array, `embeddings` that is not an object,
    // no `embeddings` key — so they sailed past the parse guard and left through
    // an uncounted `continue`. The per-page arithmetic stayed right; the STORE
    // DIAGNOSTIC lied about how much of the store it had failed to read.
    const faulty = [
      line(`${SOURCE_KEY_PREFIX}wiki/ok.md`, sourceRecord('wiki/ok.md', [1, 2, 3])),
      `"${SOURCE_KEY_PREFIX}wiki/b.md": {"embeddings": {truncated`,
      line(`${SOURCE_KEY_PREFIX}wiki/c.md`, [1, 2, 3]),
      line(`${SOURCE_KEY_PREFIX}wiki/d.md`, 'a string'),
      line(SOURCE_KEY_PREFIX, { embeddings: { [MODEL]: { vec: [1, 2, 3] } } }),
      line(`${SOURCE_KEY_PREFIX}wiki/e.md`, { embeddings: { [MODEL]: { vec: 'notanarray' } } }),
      line(`${SOURCE_KEY_PREFIX}wiki/f.md`, { embeddings: 'nope' }),
      line(`${SOURCE_KEY_PREFIX}wiki/g.md`, { noEmbeddings: true }),
    ].join('\n');
    const r = parseAjsonSources(faulty);
    assert.equal(r.records.size, 1, 'only the good record survives');
    assert.equal(r.malformed, 1, 'exactly one line is unparseable JSON');
    assert.equal(r.unusable, 6, 'the other six are valid JSON and structurally unusable');
    assert.equal(r.malformed + r.unusable, 7, 'seven faulty records in, seven counted');

    // A healthy record must not be counted as unusable.
    assert.equal(parseAjsonSources(line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1]))).unusable, 0);
    // …nor a tombstone, which is a legitimate instruction, not a defect.
    assert.equal(parseAjsonSources(`${JSON.stringify(`${SOURCE_KEY_PREFIX}wiki/a.md`)}: null,`).unusable, 0);
  });

  test('a file that could not be OPENED is counted, not silently treated as empty', () => {
    // Reachable without anything being broken: ERR_STRING_TOO_LONG on a store
    // past V8's string cap, or Obsidian holding the file while it writes. The
    // uncounted `continue` reported `files: 2, vectors: 1, malformed: 0` for a
    // run that had opened exactly one of them.
    const good = line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 2, 3]));
    const r = readSmartEnvEmbeddings('/vault', {
      fs: {
        readdirSync: () => ['a.ajson', 'b.ajson'],
        readFileSync: (p) => {
          if (String(p).endsWith('b.ajson')) throw new Error('EACCES');
          return good;
        },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.files, 2, 'two files were seen');
    assert.equal(r.unreadableFiles, 1, 'and one of them was never opened');
    assert.equal(r.vectors.size, 1);
  });

  test('a ZERO-NORM vector is held out as incompatible, not passed on as comparable', () => {
    // Its cosine with every page — including a byte-identical copy — is 0, so it
    // can never match; but it IS a vector, so it must not be reported as absent.
    const r = readSmartEnvEmbeddings('/vault', {
      fs: fakeFs({
        'a.ajson': [
          line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 0, 0])),
          line(`${SOURCE_KEY_PREFIX}wiki/b.md`, sourceRecord('wiki/b.md', [0, 1, 0])),
          line(`${SOURCE_KEY_PREFIX}wiki/z.md`, sourceRecord('wiki/z.md', [0, 0, 0])),
        ].join('\n'),
      }),
    });
    assert.equal(r.zeroNorm, 1);
    assert.equal(r.vectors.has('wiki/z.md'), false);
    assert.equal(r.incompatible.get('wiki/z.md'), 'zero-norm');
  });

  test('every held-out page is recoverable WITH ITS REASON, not just as a total', () => {
    // Aggregate counts were not enough: the caller has to tell "no vector" from
    // "a vector we could not use" to describe its own coverage truthfully.
    const r = readSmartEnvEmbeddings('/vault', {
      fs: fakeFs({
        'a.ajson': [
          line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 0, 0])),
          line(`${SOURCE_KEY_PREFIX}wiki/b.md`, sourceRecord('wiki/b.md', [0, 1, 0])),
          line(`${SOURCE_KEY_PREFIX}wiki/short.md`, sourceRecord('wiki/short.md', [1, 1])),
          line(`${SOURCE_KEY_PREFIX}wiki/other.md`, sourceRecord('wiki/other.md', [1, 2, 3], 'OTHER-MODEL')),
        ].join('\n'),
      }),
    });
    assert.deepEqual(
      Object.fromEntries([...r.incompatible.entries()].sort()),
      { 'wiki/other.md': 'minority-model', 'wiki/short.md': 'minority-dimension' },
    );
    assert.equal(r.mixedDimensions, 1);
    // No page is both compared and held out.
    for (const p of r.incompatible.keys()) assert.equal(r.vectors.has(p), false);
  });

  test('non-string input yields an empty read, not a throw', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      assert.equal(parseAjsonSources(bad).records.size, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// The store walk — driven through an injected fs, so no disk is touched.
// ---------------------------------------------------------------------------

function fakeFs(files) {
  return {
    readdirSync: (dir) => {
      const d = String(dir).replace(/\\/g, '/');
      if (!d.endsWith('.smart-env/multi')) throw new Error('ENOENT');
      return Object.keys(files);
    },
    readFileSync: (p) => {
      const name = String(p).replace(/\\/g, '/').split('/').pop();
      if (!(name in files)) throw new Error('ENOENT');
      return files[name];
    },
  };
}

describe('readSmartEnvEmbeddings — the store', () => {
  test('an absent store is a reason, not a throw', () => {
    const r = readSmartEnvEmbeddings('/vault', {
      fs: { readdirSync: () => { throw new Error('ENOENT'); }, readFileSync: () => '' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'store-missing');
    assert.equal(r.storePath, '.smart-env/multi');
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'vectors'), false);
  });

  test('an empty store is its own reason', () => {
    const r = readSmartEnvEmbeddings('/vault', { fs: fakeFs({}) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'store-empty');
  });

  test('a store with records but no vectors is its own reason', () => {
    const r = readSmartEnvEmbeddings('/vault', {
      fs: fakeFs({ 'a.ajson': line(`${SOURCE_KEY_PREFIX}wiki/a.md`, { class_name: 'SmartSource' }) }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-vectors');
  });

  test('collects vectors across files and honours cross-file tombstones', () => {
    const r = readSmartEnvEmbeddings('/vault', {
      fs: fakeFs({
        'a.ajson': line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 0])),
        'b.ajson': line(`${SOURCE_KEY_PREFIX}wiki/b.md`, sourceRecord('wiki/b.md', [0, 1])),
        'c.ajson': `${JSON.stringify(`${SOURCE_KEY_PREFIX}wiki/a.md`)}: null,`,
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.model, MODEL);
    assert.equal(r.dimensions, 2);
    assert.equal(r.files, 3);
    assert.equal(r.tombstones, 1);
    assert.deepEqual([...r.vectors.keys()], ['wiki/b.md'], 'the retracted page must be gone');
  });

  test('two models are NEVER blended — the widest wins and the other is reported', () => {
    // A cosine between vectors of two different embedding models is a number
    // without a meaning. Same rule search_smart applies to its two tiers.
    const r = readSmartEnvEmbeddings('/vault', {
      fs: fakeFs({
        'a.ajson': [
          line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 0], 'big-model')),
          line(`${SOURCE_KEY_PREFIX}wiki/b.md`, sourceRecord('wiki/b.md', [0, 1], 'big-model')),
          line(`${SOURCE_KEY_PREFIX}wiki/c.md`, sourceRecord('wiki/c.md', [1, 1], 'other-model')),
        ].join('\n'),
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.model, 'big-model');
    assert.equal(r.vectors.size, 2, 'the losing model contributes no vector to the comparison');
    assert.deepEqual(r.otherModels, [{ model: 'other-model', pages: 1 }]);
  });

  test('one model at two dimensionalities keeps the majority and counts the rest', () => {
    const r = readSmartEnvEmbeddings('/vault', {
      fs: fakeFs({
        'a.ajson': [
          line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 0, 0])),
          line(`${SOURCE_KEY_PREFIX}wiki/b.md`, sourceRecord('wiki/b.md', [0, 1, 0])),
          line(`${SOURCE_KEY_PREFIX}wiki/old.md`, sourceRecord('wiki/old.md', [1, 1])),
        ].join('\n'),
      }),
    });
    assert.equal(r.dimensions, 3);
    assert.equal(r.mixedDimensions, 1);
    assert.equal(r.vectors.has('wiki/old.md'), false);
  });

  test('files are read in a stable order, so the answer is machine-independent', () => {
    const files = {
      'z.ajson': line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [0, 1])),
      'a.ajson': line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 0])),
    };
    const forward = readSmartEnvEmbeddings('/vault', { fs: fakeFs(files) });
    const reversed = readSmartEnvEmbeddings('/vault', {
      fs: {
        readdirSync: () => Object.keys(files).reverse(),
        readFileSync: (p) => files[String(p).replace(/\\/g, '/').split('/').pop()],
      },
    });
    assert.deepEqual(forward.vectors.get('wiki/a.md'), reversed.vectors.get('wiki/a.md'));
  });

  test('a Windows-style vault path is joined with Windows separators on any runtime', () => {
    let seen = '';
    readSmartEnvEmbeddings('C:\\VAULTS\\x', {
      fs: { readdirSync: (d) => { seen = String(d); throw new Error('ENOENT'); }, readFileSync: () => '' },
    });
    assert.match(seen, /^C:\\VAULTS\\x\\\.smart-env\\multi$/);
  });
});

/**
 * WHERE THE TEXT WAS CUT MUST NOT CHANGE THE ANSWER.
 *
 * The disk backend hands the reconciler one text per file (803 on this fleet's
 * largest vault); the REST backend hands it the whole store as ONE blob. If
 * anything collapsed per chunk, those two would answer differently for the same
 * store — and "parity by construction" would be a slogan, not a property.
 *
 * Found by adversarial review, 2026-08-31: it WAS a slogan. `parseAjsonSources`
 * collapses to a last-wins Map per chunk, so a page re-indexed under a second
 * model in a LATER FILE stayed alive under both models when read file-by-file,
 * and under only the newer one when read as a blob. No measurement on this fleet
 * could have caught it: every vault here carries a single model.
 */
describe('the reconciler is chunk-independent — one blob or N files, same answer', () => {
  const OLD = 'model-old';
  const NEW = 'model-new';
  // Two pages that keep the old model alive, so it is a real contender…
  const fileA = [
    line(`${SOURCE_KEY_PREFIX}wiki/a.md`, sourceRecord('wiki/a.md', [1, 0, 0], OLD)),
    line(`${SOURCE_KEY_PREFIX}wiki/b.md`, sourceRecord('wiki/b.md', [0, 1, 0], OLD)),
    // …and `p`, first indexed under the OLD model.
    line(`${SOURCE_KEY_PREFIX}wiki/p.md`, sourceRecord('wiki/p.md', [0, 0, 1], OLD)),
  ].join('\n');
  // A LATER file re-indexes `p` under the NEW model. The store is saying "p is
  // now a NEW-model page" — it is not saying "p is in both".
  const fileB = [
    line(`${SOURCE_KEY_PREFIX}wiki/p.md`, sourceRecord('wiki/p.md', [0.5, 0.5, 0], NEW)),
    line(`${SOURCE_KEY_PREFIX}wiki/q.md`, sourceRecord('wiki/q.md', [0, 0.5, 0.5], NEW)),
  ].join('\n');

  const asFiles = () => reconcileSmartEnvStore([fileA, fileB], { files: 2 });
  const asBlob = () => reconcileSmartEnvStore([`${fileA}\n${fileB}`], { files: 2 });

  test('the winning model, the vectors and the tallies are identical either way', () => {
    const many = asFiles();
    const one = asBlob();
    assert.equal(many.model, one.model);
    assert.deepEqual([...many.vectors.entries()].sort(), [...one.vectors.entries()].sort());
    assert.deepEqual(many.otherModels, one.otherModels);
    assert.deepEqual([...many.incompatible.entries()].sort(), [...one.incompatible.entries()].sort());
  });

  test('the DIAGNOSTIC counts are identical too — they are read, so they must agree', () => {
    const many = asFiles();
    const one = asBlob();
    for (const k of ['records', 'tombstones', 'malformed', 'unusable', 'dimensions', 'zeroNorm', 'mixedDimensions']) {
      assert.equal(many[k], one[k], `${k} depends on where the text was cut`);
    }
  });

  test('a re-indexed page belongs to its NEWEST model only, not to both', () => {
    // The substance under the parity: OLD covers a and b, NEW covers p and q.
    // Before the fix, reading two files left `p` counted under OLD as well —
    // 3 pages vs 2 — which hands OLD the win and puts every NEW page in
    // `incompatible` as a minority model.
    const r = asFiles();
    assert.equal(r.model, NEW, 'NEW covers p and q; OLD covers only a and b');
    assert.deepEqual(r.otherModels, [{ model: OLD, pages: 2 }]);
    assert.ok(r.vectors.has('wiki/p.md'));
    assert.deepEqual(r.vectors.get('wiki/p.md'), [0.5, 0.5, 0]);
  });

  test('a tombstone in a LATER file retracts the page, whichever way it is cut', () => {
    const dead = line(`${SOURCE_KEY_PREFIX}wiki/p.md`, null);
    const many = reconcileSmartEnvStore([fileA, fileB, dead], { files: 3 });
    const one = reconcileSmartEnvStore([`${fileA}\n${fileB}\n${dead}`], { files: 3 });
    assert.ok(!many.vectors.has('wiki/p.md'));
    assert.ok(!one.vectors.has('wiki/p.md'));
    assert.equal(many.tombstones, one.tombstones);
  });
});

describe('a record declaring SEVERAL models is one statement, not several', () => {
  // Round-2 review, 2026-08-31: the first repair split a record into one event
  // per model, and the reconciler's cross-model retraction then ate the
  // record's own siblings — the second model deleted the page from the first.
  // Which vector survived depended on JSON key order, which is not a fact about
  // the store at all.
  const rec = (path, models) => line(`${SOURCE_KEY_PREFIX}${path}`, {
    path, class_name: 'SmartSource', embeddings: models,
  });

  test('every model the record lists keeps the page, whatever order they are in', () => {
    const forward = rec('wiki/p.md', { X: { vec: [1, 0] }, Y: { vec: [0, 1] } });
    const reversed = rec('wiki/p.md', { Y: { vec: [0, 1] }, X: { vec: [1, 0] } });
    // A second page under each model, so neither is a one-page model that the
    // coverage tie-break would decide by name alone.
    const ballast = [
      rec('wiki/x.md', { X: { vec: [1, 1] } }),
      rec('wiki/y.md', { Y: { vec: [1, 1] } }),
    ].join('\n');

    for (const [label, text] of [['forward', forward], ['reversed', reversed]]) {
      const r = reconcileSmartEnvStore([`${ballast}\n${text}`], { files: 1 });
      const models = new Set([r.model, ...r.otherModels.map((m) => m.model)]);
      assert.deepEqual([...models].sort(), ['X', 'Y'], `${label}: both models survive`);
      assert.deepEqual(
        r.otherModels, [{ model: r.model === 'X' ? 'Y' : 'X', pages: 2 }],
        `${label}: the page counts under BOTH models, so each has two pages`,
      );
      assert.equal(r.records, 3, `${label}: three records in, three counted — not four`);
    }
  });

  test('a later record RETRACTS the models it no longer lists', () => {
    // The substance the retraction exists for: re-indexing under one model must
    // not leave the page claimed by the model it was moved off.
    const text = [
      rec('wiki/p.md', { X: { vec: [1, 0] }, Y: { vec: [0, 1] } }),
      rec('wiki/p.md', { Y: { vec: [0, 2] } }),
      rec('wiki/y.md', { Y: { vec: [1, 1] } }),
    ].join('\n');
    const r = reconcileSmartEnvStore([text], { files: 1 });
    assert.equal(r.model, 'Y');
    assert.deepEqual(r.vectors.get('wiki/p.md'), [0, 2]);
    // X ended up with no pages at all, so it is not a competitor to report.
    assert.deepEqual(r.otherModels, []);
  });
});

describe('one page has ONE spelling, whatever separator the plugin wrote', () => {
  // The store is written by a plugin running on Windows and really does key
  // records `wiki\Ident\x.md` — measured on this vault. Two spellings meant two
  // pages to every Map in the reader (review round 3, 2026-08-31).
  test('a tombstone retracts its page even when the record spelt it with backslashes', () => {
    const text = [
      line(`${SOURCE_KEY_PREFIX}wiki\\p.md`, sourceRecord('wiki\\p.md', [1, 0])),
      line(`${SOURCE_KEY_PREFIX}wiki/q.md`, sourceRecord('wiki/q.md', [0, 1])),
      `${JSON.stringify(`${SOURCE_KEY_PREFIX}wiki/p.md`)}: null,`,
    ].join('\n');
    const r = reconcileSmartEnvStore([text], { files: 1 });
    assert.ok(!r.vectors.has('wiki/p.md'), 'the retraction must land on the page it names');
    assert.ok(!r.vectors.has('wiki\\p.md'), 'and no backslash twin may survive it');
    assert.deepEqual([...r.vectors.keys()], ['wiki/q.md']);
  });

  test('a backslash-keyed vector is reachable by the forward-slash path every caller uses', () => {
    const text = [
      line(`${SOURCE_KEY_PREFIX}wiki\\a\\b.md`, sourceRecord('wiki\\a\\b.md', [1, 0])),
      line(`${SOURCE_KEY_PREFIX}wiki/c.md`, sourceRecord('wiki/c.md', [0, 1])),
    ].join('\n');
    const r = reconcileSmartEnvStore([text], { files: 1 });
    assert.deepEqual(r.vectors.get('wiki/a/b.md'), [1, 0]);
  });
});

describe('a model whose slot is CORRUPT is not a model the record dropped', () => {
  test('an unreadable sibling slot does not retract that model', () => {
    // Round-3 review: retracting on "absent from `models`" turned one corrupt
    // slot into a deliberate-looking removal, changing model coverage — and
    // possibly the winning model — because of a byte the store got wrong.
    const good = line(`${SOURCE_KEY_PREFIX}wiki/p.md`, {
      path: 'wiki/p.md', embeddings: { A: { vec: [1, 0] }, B: { vec: [0, 1] } },
    });
    const partly = line(`${SOURCE_KEY_PREFIX}wiki/p.md`, {
      path: 'wiki/p.md', embeddings: { A: { vec: [2, 0] }, B: { vec: 'corrupt' } },
    });
    const r = reconcileSmartEnvStore([`${good}\n${partly}`], { files: 1 });
    assert.deepEqual(r.vectors.get('wiki/p.md'), r.model === 'A' ? [2, 0] : [0, 1]);
    const models = new Set([r.model, ...r.otherModels.map((m) => m.model)]);
    assert.deepEqual([...models].sort(), ['A', 'B'], 'B still claims the page');
  });

  test('a record whose ONLY model is corrupt still retracts the models it dropped', () => {
    // Round-4 review: such a record used to be discarded outright, so a model
    // the store had just stopped listing kept claiming the page — and could win
    // the coverage tie with a claim the store no longer made.
    const both = line(`${SOURCE_KEY_PREFIX}wiki/p.md`, {
      path: 'wiki/p.md', embeddings: { A: { vec: [1, 0] }, B: { vec: [0, 1] } },
    });
    const onlyCorruptA = line(`${SOURCE_KEY_PREFIX}wiki/p.md`, {
      path: 'wiki/p.md', embeddings: { A: { vec: 'corrupt' } },
    });
    const ballast = line(`${SOURCE_KEY_PREFIX}wiki/b2.md`, {
      path: 'wiki/b2.md', embeddings: { B: { vec: [1, 1] } },
    });
    const r = reconcileSmartEnvStore([`${both}\n${ballast}\n${onlyCorruptA}`], { files: 1 });
    // B was NOT mentioned by the last record → it no longer claims p…
    const bPages = r.model === 'B' ? r.vectors.size : (r.otherModels.find((m) => m.model === 'B')?.pages ?? 0);
    assert.equal(bPages, 1, 'B keeps only its own page, not p');
    // …and A keeps the vector it had, because A WAS mentioned — just unreadably.
    const aPages = r.model === 'A' ? r.vectors.size : (r.otherModels.find((m) => m.model === 'A')?.pages ?? 0);
    assert.equal(aPages, 1, 'A still claims p with its last good vector');
  });

  test('…but a model the record genuinely stops listing IS retracted', () => {
    const both = line(`${SOURCE_KEY_PREFIX}wiki/p.md`, {
      path: 'wiki/p.md', embeddings: { A: { vec: [1, 0] }, B: { vec: [0, 1] } },
    });
    const onlyA = line(`${SOURCE_KEY_PREFIX}wiki/p.md`, {
      path: 'wiki/p.md', embeddings: { A: { vec: [2, 0] } },
    });
    const r = reconcileSmartEnvStore([`${both}\n${onlyA}`], { files: 1 });
    assert.equal(r.model, 'A');
    assert.deepEqual(r.otherModels, [], 'B held nothing else, so it is not a competitor');
  });
});

describe('parseAjsonRecordEvents keeps the order the log was written in', () => {
  test('repeats are EMITTED, not collapsed — the reconciler decides, not the parser', () => {
    const text = [
      line(`${SOURCE_KEY_PREFIX}wiki/p.md`, sourceRecord('wiki/p.md', [1, 0])),
      line(`${SOURCE_KEY_PREFIX}wiki/p.md`, sourceRecord('wiki/p.md', [2, 0])),
      line(`${SOURCE_KEY_PREFIX}wiki/p.md`, null),
    ].join('\n');
    const { events } = parseAjsonRecordEvents(text);
    assert.equal(events.length, 3, 'three writes to one page are three events');
    assert.deepEqual(events.map((e) => e.path), ['wiki/p.md', 'wiki/p.md', 'wiki/p.md']);
    assert.deepEqual([...events[0].models.values()], [[1, 0]]);
    assert.equal(events[2].models, null);
    // …and the Map view still collapses them, for callers that want one file's
    // final state.
    assert.equal(parseAjsonSources(text).records.get('wiki/p.md'), null);
  });
});
