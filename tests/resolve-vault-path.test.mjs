/**
 * Tests for src/helpers/resolve-vault-path.mjs — the on-disk path verifier /
 * basename repairer behind build_open_link's determinism guarantee.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveVaultPathOnDisk } from '../src/helpers/resolve-vault-path.mjs';

let vaultPath;
let vault;

before(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rvp-vault-'));
  for (const rel of [
    'wiki/Projects/secrets.md', // unique basename
    'wiki/a/dup.md', // dup basename #1
    'wiki/b/dup.md', // dup basename #2
    '.obsidian/plugins/x/dup.md', // dot-dir → must be ignored by the walk
  ]) {
    const abs = path.join(vaultPath, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '# ' + rel);
  }
  vault = { type: 'local', path: vaultPath, name: 'test' };
});

after(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

describe('resolveVaultPathOnDisk', () => {
  test('exact path → ok', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki/Projects/secrets.md'), {
      status: 'ok',
      path: 'wiki/Projects/secrets.md',
    });
  });

  test('wrong folder, unique basename → corrected to the real path', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki/WRONG/secrets.md'), {
      status: 'corrected',
      path: 'wiki/Projects/secrets.md',
      from: 'wiki/WRONG/secrets.md',
    });
  });

  test('ambiguous basename → ambiguous with both real paths (dot-dir excluded)', () => {
    const r = resolveVaultPathOnDisk(vault, 'anywhere/dup.md');
    assert.equal(r.status, 'ambiguous');
    assert.deepEqual(r.matches.slice().sort(), ['wiki/a/dup.md', 'wiki/b/dup.md']);
    // the .obsidian copy must NOT count (walk skips dot-dirs)
    assert.ok(!r.matches.some((m) => m.includes('.obsidian')));
  });

  test('no such basename → not_found', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki/ghost.md'), { status: 'not_found' });
  });

  test('folder exact path → ok (folders are openable)', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki/Projects'), {
      status: 'ok',
      path: 'wiki/Projects',
    });
  });

  test('remote vault → unverifiable (skip, cannot stat)', () => {
    assert.deepEqual(resolveVaultPathOnDisk({ type: 'remote', name: 'r' }, 'x.md'), {
      status: 'unverifiable',
    });
  });

  test('missing path arg → unverifiable', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, ''), { status: 'unverifiable' });
  });

  test('backslash separators are normalised before lookup', () => {
    assert.deepEqual(resolveVaultPathOnDisk(vault, 'wiki\\Projects\\secrets.md'), {
      status: 'ok',
      path: 'wiki/Projects/secrets.md',
    });
  });
});
