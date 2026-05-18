/**
 * Tests for src/helpers/wiki-fingerprint.mjs — canonicalisation + hashing
 * primitives behind the wiki-fold short-circuit and the hot-cache hook
 * dedup logic. Run with `npm test`.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  canonicalise,
  canonicalHash,
  contentIsUnchanged,
  computeFingerprint,
  readFingerprint,
  writeFingerprint,
  _internals,
} from '../src/helpers/wiki-fingerprint.mjs';

// ---------------------------------------------------------------------------
// canonicalise
// ---------------------------------------------------------------------------

describe('canonicalise', () => {
  test('non-string returns empty string', () => {
    assert.equal(canonicalise(null), '');
    assert.equal(canonicalise(undefined), '');
    assert.equal(canonicalise(42), '');
  });

  test('preserves a plain string with trailing newline', () => {
    assert.equal(canonicalise('hello\n'), 'hello\n');
  });

  test('adds a trailing newline if missing', () => {
    assert.equal(canonicalise('hello'), 'hello\n');
  });

  test('normalises CRLF to LF', () => {
    assert.equal(canonicalise('a\r\nb\r\nc'), 'a\nb\nc\n');
  });

  test('strips trailing whitespace per line', () => {
    assert.equal(canonicalise('a   \nb\t\nc\n'), 'a\nb\nc\n');
  });

  test('preserves leading whitespace (matters for markdown lists)', () => {
    assert.equal(canonicalise('  - item\n    nested\n'), '  - item\n    nested\n');
  });

  test('collapses multiple trailing blank lines to one', () => {
    assert.equal(canonicalise('a\n\n\n\n'), 'a\n');
  });

  test('preserves internal blank lines', () => {
    assert.equal(canonicalise('para1\n\npara2\n'), 'para1\n\npara2\n');
  });

  test('two semantically-equivalent strings canonicalise to the same value', () => {
    const a = 'line1\r\nline2  \r\n\r\n\r\n';
    const b = 'line1\nline2\n';
    assert.equal(canonicalise(a), canonicalise(b));
  });
});

// ---------------------------------------------------------------------------
// canonicalHash
// ---------------------------------------------------------------------------

describe('canonicalHash', () => {
  test('returns a 32-hex-char string', () => {
    const hash = canonicalHash('hello');
    assert.match(hash, /^[0-9a-f]{32}$/);
    assert.equal(hash.length, _internals.HASH_HEX_LEN);
  });

  test('deterministic — same input yields same hash', () => {
    assert.equal(canonicalHash('hello\n'), canonicalHash('hello\n'));
  });

  test('semantically equivalent inputs hash identically', () => {
    const a = 'line  \r\nbody\n\n\n';
    const b = 'line\nbody\n';
    assert.equal(canonicalHash(a), canonicalHash(b));
  });

  test('different inputs hash differently', () => {
    assert.notEqual(canonicalHash('hello'), canonicalHash('world'));
  });

  test('whitespace inside a line is NOT canonicalised (different hashes)', () => {
    assert.notEqual(canonicalHash('a b'), canonicalHash('a  b'));
  });
});

// ---------------------------------------------------------------------------
// contentIsUnchanged
// ---------------------------------------------------------------------------

describe('contentIsUnchanged', () => {
  let tempDir;
  let tempFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-fingerprint-test-'));
    tempFile = path.join(tempDir, 'fold.md');
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('returns false when file does not exist', () => {
    const missing = path.join(tempDir, 'nope.md');
    assert.equal(contentIsUnchanged(missing, 'whatever'), false);
  });

  test('returns true when content matches byte-for-byte', () => {
    fs.writeFileSync(tempFile, 'identical content\n', 'utf8');
    assert.equal(contentIsUnchanged(tempFile, 'identical content\n'), true);
  });

  test('returns true when content matches after canonicalisation', () => {
    fs.writeFileSync(tempFile, 'line1\r\nline2  \r\n\r\n\r\n', 'utf8');
    assert.equal(contentIsUnchanged(tempFile, 'line1\nline2\n'), true);
  });

  test('returns false when content genuinely differs', () => {
    fs.writeFileSync(tempFile, 'original\n', 'utf8');
    assert.equal(contentIsUnchanged(tempFile, 'changed\n'), false);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

describe('computeFingerprint', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-fingerprint-test-'));
    fs.mkdirSync(path.join(tempDir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'wiki', 'a.md'), 'content A\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'wiki', 'b.md'), 'content B\n', 'utf8');
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('returns 32-hex fingerprint', () => {
    const fp = computeFingerprint(tempDir, ['wiki/a.md', 'wiki/b.md']);
    assert.match(fp, /^[0-9a-f]{32}$/);
  });

  test('deterministic across runs', () => {
    const a = computeFingerprint(tempDir, ['wiki/a.md', 'wiki/b.md']);
    const b = computeFingerprint(tempDir, ['wiki/a.md', 'wiki/b.md']);
    assert.equal(a, b);
  });

  test('order-independent (sorted internally)', () => {
    const a = computeFingerprint(tempDir, ['wiki/a.md', 'wiki/b.md']);
    const b = computeFingerprint(tempDir, ['wiki/b.md', 'wiki/a.md']);
    assert.equal(a, b);
  });

  test('deduplicates input path list', () => {
    const a = computeFingerprint(tempDir, ['wiki/a.md']);
    const b = computeFingerprint(tempDir, ['wiki/a.md', 'wiki/a.md', 'wiki/a.md']);
    assert.equal(a, b);
  });

  test('changes when a file content changes', () => {
    const before = computeFingerprint(tempDir, ['wiki/a.md']);
    fs.writeFileSync(path.join(tempDir, 'wiki', 'a.md'), 'modified\n', 'utf8');
    const after = computeFingerprint(tempDir, ['wiki/a.md']);
    assert.notEqual(before, after);
  });

  test('changes when a file is added to the set', () => {
    const justA = computeFingerprint(tempDir, ['wiki/a.md']);
    const both = computeFingerprint(tempDir, ['wiki/a.md', 'wiki/b.md']);
    assert.notEqual(justA, both);
  });

  test('changes when a file is removed from disk (treated as empty)', () => {
    const before = computeFingerprint(tempDir, ['wiki/a.md']);
    fs.rmSync(path.join(tempDir, 'wiki', 'a.md'));
    const after = computeFingerprint(tempDir, ['wiki/a.md']);
    assert.notEqual(before, after);
  });

  test('missing files do not throw', () => {
    assert.doesNotThrow(() => {
      computeFingerprint(tempDir, ['wiki/does-not-exist.md']);
    });
  });

  test('whitespace-only changes (canonical equivalence) do NOT change fingerprint', () => {
    fs.writeFileSync(path.join(tempDir, 'wiki', 'a.md'), 'content A\n', 'utf8');
    const before = computeFingerprint(tempDir, ['wiki/a.md']);
    fs.writeFileSync(path.join(tempDir, 'wiki', 'a.md'), 'content A   \r\n\r\n\r\n', 'utf8');
    const after = computeFingerprint(tempDir, ['wiki/a.md']);
    assert.equal(before, after,
      'canonical equivalence should suppress whitespace-only diffs');
  });
});

// ---------------------------------------------------------------------------
// readFingerprint + writeFingerprint
// ---------------------------------------------------------------------------

describe('readFingerprint / writeFingerprint', () => {
  let tempDir;
  let fpFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-fingerprint-test-'));
    fpFile = path.join(tempDir, '.vault-meta', 'fp');
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('readFingerprint returns null when file does not exist', () => {
    assert.equal(readFingerprint(fpFile), null);
  });

  test('writeFingerprint creates parent directory', () => {
    writeFingerprint(fpFile, 'abc12345abc12345abc12345abc12345');
    assert.ok(fs.existsSync(fpFile));
  });

  test('readFingerprint reads what writeFingerprint wrote', () => {
    const fp = 'abc12345abc12345abc12345abc12345';
    writeFingerprint(fpFile, fp);
    assert.equal(readFingerprint(fpFile), fp);
  });

  test('readFingerprint rejects malformed content (returns null)', () => {
    fs.mkdirSync(path.dirname(fpFile), { recursive: true });
    fs.writeFileSync(fpFile, 'not a valid fingerprint!!!', 'utf8');
    assert.equal(readFingerprint(fpFile), null);
  });

  test('readFingerprint tolerates trailing newline', () => {
    fs.mkdirSync(path.dirname(fpFile), { recursive: true });
    fs.writeFileSync(fpFile, 'abc12345abc12345abc12345abc12345\n', 'utf8');
    assert.equal(readFingerprint(fpFile), 'abc12345abc12345abc12345abc12345');
  });

  test('writeFingerprint silently swallows errors', () => {
    // Write to a path inside a path that's not a directory — should not throw.
    const bogusFile = path.join(tempDir, 'a-file.txt');
    fs.writeFileSync(bogusFile, 'I am a file, not a directory\n', 'utf8');
    const bogusFp = path.join(bogusFile, 'fp'); // can't make subdir of a file
    assert.doesNotThrow(() => {
      writeFingerprint(bogusFp, 'abc12345abc12345abc12345abc12345');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration scenario — full dedup loop
// ---------------------------------------------------------------------------

describe('integration — hot-cache hook dedup scenario', () => {
  let tempDir;
  let fpFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-fingerprint-test-'));
    fs.mkdirSync(path.join(tempDir, 'wiki'), { recursive: true });
    fpFile = path.join(tempDir, '.vault-meta', 'hot-prompt-fingerprint');
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('first run: no fingerprint, emit prompt, store new fingerprint', () => {
    fs.writeFileSync(path.join(tempDir, 'wiki', 'log.md'), 'initial\n', 'utf8');
    const stored = readFingerprint(fpFile);
    const current = computeFingerprint(tempDir, ['wiki/log.md']);
    assert.equal(stored, null);
    assert.notEqual(stored, current);
    // Simulate firing: write the new fingerprint.
    writeFingerprint(fpFile, current);
    assert.equal(readFingerprint(fpFile), current);
  });

  test('second run, no change: stored == current → skip prompt', () => {
    fs.writeFileSync(path.join(tempDir, 'wiki', 'log.md'), 'initial\n', 'utf8');
    const fp = computeFingerprint(tempDir, ['wiki/log.md']);
    writeFingerprint(fpFile, fp);
    // Simulate another Stop hook with no wiki change since.
    const stored = readFingerprint(fpFile);
    const current = computeFingerprint(tempDir, ['wiki/log.md']);
    assert.equal(stored, current);
  });

  test('second run, real change: stored != current → emit prompt again', () => {
    fs.writeFileSync(path.join(tempDir, 'wiki', 'log.md'), 'v1\n', 'utf8');
    writeFingerprint(fpFile, computeFingerprint(tempDir, ['wiki/log.md']));
    // Now a substantive change.
    fs.writeFileSync(path.join(tempDir, 'wiki', 'log.md'), 'v2\n', 'utf8');
    const stored = readFingerprint(fpFile);
    const current = computeFingerprint(tempDir, ['wiki/log.md']);
    assert.notEqual(stored, current);
  });

  test('whitespace-only edit to wiki file: stored == current → skip prompt', () => {
    fs.writeFileSync(path.join(tempDir, 'wiki', 'log.md'), 'content\n', 'utf8');
    writeFingerprint(fpFile, computeFingerprint(tempDir, ['wiki/log.md']));
    // CRLF normalisation / trailing whitespace shouldn't trigger a re-prompt.
    fs.writeFileSync(path.join(tempDir, 'wiki', 'log.md'), 'content  \r\n\r\n', 'utf8');
    assert.equal(
      readFingerprint(fpFile),
      computeFingerprint(tempDir, ['wiki/log.md']),
    );
  });
});
