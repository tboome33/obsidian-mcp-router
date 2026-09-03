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

  test('the TARGET\'S PERMISSIONS are carried onto the temp file before the rename', () => {
    // `rename` replaces the target wholesale, its mode included — so a 0600
    // file rewritten through here came back 0644 under the usual umask. That
    // was harmless while this helper only wrote derived artefacts; the
    // `registre de liaisons` lot pointed it at the router's config.json, which
    // holds every vault's API key. Codex flagged it on 2026-09-03.
    //
    // Asserted through a fake `fsMod` so it holds on every platform: Windows
    // does almost nothing with POSIX modes, and a real-filesystem assertion
    // would only ever run on half the CI matrix. The real-mode check below
    // runs where modes are real.
    const calls = [];
    const fsMod = {
      statSync: (p) => { calls.push(['stat', p]); return { mode: 0o100600 }; },
      writeFileSync: (p, c) => { calls.push(['write', p]); fs.writeFileSync(p, c, 'utf8'); },
      chmodSync: (p, m) => { calls.push(['chmod', p, m]); },
      renameSync: (a, b) => { calls.push(['rename', a, b]); fs.renameSync(a, b); },
      unlinkSync: fs.unlinkSync,
    };
    writeFileAtomicSync(target, 'secret', { fsMod });

    const order = calls.map((c) => c[0]);
    assert.deepEqual(order, ['stat', 'write', 'chmod', 'rename'],
      'the mode is read from the TARGET and applied to the TEMP before it replaces it');
    assert.equal(calls[2][2], 0o600, 'the file type bits are masked off; the permission bits are not');
    assert.equal(calls[2][1], calls[1][1], 'chmod applies to the temp file, not the target');
  });

  test('a chmod that FAILS aborts the write — the target is never silently widened', () => {
    // Round 2 of the Codex review: the first version swallowed the chmod
    // error and went on to rename, so on a filesystem where writing works but
    // chmod returns EPERM the default-mode temp file replaced the 0600 config.
    // The fallback meant to be harmless was the widening.
    fs.writeFileSync(target, 'old', 'utf8');
    let tmpPath = null;
    const fsMod = {
      statSync: () => ({ mode: 0o100600 }),
      writeFileSync: (p, c) => { tmpPath = p; fs.writeFileSync(p, c, 'utf8'); },
      chmodSync: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; },
      renameSync: () => { throw new Error('rename must not be reached'); },
      unlinkSync: fs.unlinkSync,
    };
    assert.throws(() => writeFileAtomicSync(target, 'new', { fsMod }), /EPERM/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old', 'the old file stays as it was');
    assert.equal(fs.existsSync(tmpPath), false, 'and the temp file is cleaned up');
  });

  test('a file that does not exist yet is created without inventing a mode', () => {
    const fresh = path.join(dir, 'brand-new.json');
    let chmodded = false;
    const fsMod = {
      statSync: fs.statSync,
      writeFileSync: (p, c) => fs.writeFileSync(p, c, 'utf8'),
      chmodSync: () => { chmodded = true; },
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    };
    writeFileAtomicSync(fresh, 'hello', { fsMod });
    assert.equal(fs.readFileSync(fresh, 'utf8'), 'hello');
    assert.equal(chmodded, false, 'nothing to copy from, so nothing is forced');
  });

  test('on a platform with real modes, a 0600 file stays 0600 across a rewrite', { skip: process.platform === 'win32' }, () => {
    const secret = path.join(dir, 'config.json');
    fs.writeFileSync(secret, '{"apiKey":"x"}', 'utf8');
    fs.chmodSync(secret, 0o600);
    writeFileAtomicSync(secret, '{"apiKey":"y"}');
    assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
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
