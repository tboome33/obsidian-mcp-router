/**
 * smart-env-embeddings — the reader for Smart Connections' on-disk vector
 * store. The format is an APPEND LOG written by a third-party plugin, and each
 * test here pins one of the ways that bites.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAjsonSources,
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
