// W0.1 — cloneRootDocs must clone the reference vault's Documentation/ folder.
// The reference (`C:\VAULTS\.template`) reorganized its human docs (quick-
// reference PDFs, SETUP.md, the vault-facing CLAUDE.md) from the vault root
// into Documentation/, so the old per-PDF root-level entries in
// ROOT_FILES_TO_CLONE found nothing and silently cloned only `.claude`.
//
// cloneRootDocs() is not exported (importing setup-vault.mjs runs its CLI), so
// this asserts the shipped constant's contract, then proves the dir-aware copy
// semantics cloneRootDocs relies on still recurse into a Documentation/ folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(process.cwd(), 'scripts', 'setup-vault.mjs');

test('ROOT_FILES_TO_CLONE includes Documentation and drops stale root PDFs', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const m = src.match(/const ROOT_FILES_TO_CLONE = (\[[^\]]*\]);/);
  assert.ok(m, 'ROOT_FILES_TO_CLONE constant found');
  const list = JSON.parse(m[1].replace(/'/g, '"'));
  assert.ok(list.includes('Documentation'), 'Documentation/ folder is cloned');
  assert.ok(list.includes('README.md'), 'README.md still cloned (shipped skeleton keeps it at root)');
  assert.ok(list.includes('.claude'), '.claude still cloned');
  assert.ok(!list.includes('quick-reference-fr.pdf'),
    'stale root-level PDF entry removed (now inside Documentation/)');
  assert.ok(!list.includes('quick-reference-en.pdf'),
    'stale root-level PDF entry removed (now inside Documentation/)');
});

test('the dir-aware copy semantics recurse into a Documentation/ folder', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rootdocs-'));
  try {
    const ref = path.join(tmp, 'ref');
    const tgt = path.join(tmp, 'tgt');
    fs.mkdirSync(path.join(ref, 'Documentation'), { recursive: true });
    fs.writeFileSync(path.join(ref, 'Documentation', 'SETUP.md'), '# setup');
    fs.writeFileSync(path.join(ref, 'Documentation', 'quick-reference-en.pdf'), '%PDF-fake');
    fs.writeFileSync(path.join(ref, 'README.md'), '# readme');
    fs.mkdirSync(path.join(ref, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ref, '.claude', 'settings.json'), '{}');
    fs.mkdirSync(tgt, { recursive: true });

    // Mirror cloneRootDocs()'s per-item, dir-aware copy for the shipped list.
    const ROOT_FILES_TO_CLONE = ['README.md', 'Documentation', '.claude'];
    for (const item of ROOT_FILES_TO_CLONE) {
      const s = path.join(ref, item);
      const d = path.join(tgt, item);
      if (!fs.existsSync(s)) continue;
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(d), { recursive: true });
      if (fs.statSync(s).isDirectory()) fs.cpSync(s, d, { recursive: true });
      else fs.copyFileSync(s, d);
    }

    assert.ok(fs.existsSync(path.join(tgt, 'Documentation', 'SETUP.md')), 'SETUP.md cloned');
    assert.ok(fs.existsSync(path.join(tgt, 'Documentation', 'quick-reference-en.pdf')), 'PDF cloned');
    assert.ok(fs.existsSync(path.join(tgt, 'README.md')), 'README cloned');
    assert.ok(fs.existsSync(path.join(tgt, '.claude', 'settings.json')), '.claude cloned');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
