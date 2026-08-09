/**
 * Tests for src/helpers/write-file-atomic.mjs — temp-file + rename, so a reader
 * never sees a half-written derived artefact.
 *
 * Behavioural: the interruption is simulated by making the WRITE step fail, and
 * the assertion is on what is left on disk afterwards — the old bytes, intact,
 * and no orphan temp file beside them.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomicSync } from '../src/helpers/write-file-atomic.mjs';

let dir;
let target;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
  target = path.join(dir, 'artefact.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomicSync', () => {
  test('creates the file with the exact content', () => {
    writeFileAtomicSync(target, '{"a":1}');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}');
  });

  test('replaces an existing file', () => {
    fs.writeFileSync(target, 'old', 'utf8');
    writeFileAtomicSync(target, 'new');
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  });

  test('leaves no temp file behind on success', () => {
    writeFileAtomicSync(target, 'x');
    assert.deepEqual(fs.readdirSync(dir), ['artefact.json']);
  });

  test('an interrupted write leaves the OLD file byte-intact', () => {
    fs.writeFileSync(target, 'the previous, valid artefact', 'utf8');

    // A REALISTIC interruption, not a no-op failure: `fs.writeFileSync`
    // truncates the target and THEN streams, so a disk filling up mid-stream
    // leaves a prefix on disk and only then throws. A mock that throws before
    // touching anything would pass whether or not the write was atomic — it is
    // the truncation that has to be aimed somewhere harmless.
    const fsMod = {
      writeFileSync: (p, c) => {
        fs.writeFileSync(p, String(c).slice(0, 8), 'utf8'); // truncate + partial
        throw new Error('disk full');
      },
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    };

    assert.throws(() => writeFileAtomicSync(target, 'half of the new artefact', { fsMod }), /disk full/);
    assert.equal(
      fs.readFileSync(target, 'utf8'),
      'the previous, valid artefact',
      'the partial write must have landed on the temp file, never on the target',
    );
    assert.deepEqual(fs.readdirSync(dir), ['artefact.json'], 'and the partial temp file must be cleaned up');
  });

  test('a failure removes the temp file rather than littering the directory', () => {
    fs.writeFileSync(target, 'old', 'utf8');
    let tmpPath = null;
    const fsMod = {
      writeFileSync: (p, c) => { tmpPath = p; fs.writeFileSync(p, c, 'utf8'); },
      renameSync: () => { throw new Error('rename failed'); },
      unlinkSync: fs.unlinkSync,
    };

    assert.throws(() => writeFileAtomicSync(target, 'new', { fsMod }), /rename failed/);
    assert.ok(tmpPath, 'the temp file was created');
    assert.equal(fs.existsSync(tmpPath), false, 'and cleaned up');
    assert.deepEqual(fs.readdirSync(dir), ['artefact.json']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  });

  test('the temp file is a SIBLING (rename is only atomic within one filesystem)', () => {
    let tmpPath = null;
    const fsMod = {
      writeFileSync: (p, c) => { tmpPath = p; fs.writeFileSync(p, c, 'utf8'); },
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    };
    writeFileAtomicSync(target, 'x', { fsMod });
    assert.equal(path.dirname(tmpPath), dir, 'a temp dir on another volume would silently become a copy');
  });
});
