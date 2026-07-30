/**
 * Disk-side projections (helper + fleet CLI) — volet ② v0.59.0.
 * The pure grammar is covered by okf-projections.test.mjs; here we pin the
 * FILESYSTEM behaviours: idempotence on disk, conflict preservation, ghost
 * `wiki/sessions/` tidying, and the CLI's dry-run/apply/exit-code contract.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { generateProjectionsOnDisk } from '../src/helpers/okf-projections-fs.mjs';
import { projectionMarkerLine } from '../src/helpers/okf-projections.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'okf-projections.mjs');

let tmpRoot;
before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-proj-fs-')); });
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ } });

let seq = 0;
function makeVault(files = {}) {
  const vp = path.join(tmpRoot, `v${seq++}`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return vp;
}

const PAGE = (title) =>
  `---\ntype: note\ntitle: "${title}"\ndescription: "Desc"\ncreated: 2026-07-01\n---\n\nCorps.\n`;

describe('generateProjectionsOnDisk', () => {
  test('dry-run plans but writes nothing; apply writes; re-apply is a no-op', () => {
    const vp = makeVault({ 'wiki/a/page.md': PAGE('Page') });
    const dry = generateProjectionsOnDisk(vp, { now: '2026-07-30' });
    assert.equal(dry.written.length, 3);
    assert.equal(fs.existsSync(path.join(vp, 'wiki', 'index.md')), false, 'dry-run must not write');

    const applied = generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });
    assert.equal(applied.written.length, 3);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'index.md')));
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'a', 'index.md')));
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'log.md')));

    const again = generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });
    assert.equal(again.written.length, 0, 'idempotent');
    assert.equal(again.unchanged, 3);
  });

  test('an unmarked homonym on disk is preserved and reported', () => {
    const vp = makeVault({
      'wiki/a/page.md': PAGE('Page'),
      'wiki/a/index.md': '# Le mien\n',
    });
    const r = generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });
    assert.deepEqual(r.conflicts, ['wiki/a/index.md']);
    assert.equal(fs.readFileSync(path.join(vp, 'wiki', 'a', 'index.md'), 'utf8'), '# Le mien\n');
  });

  test('a stale marked index on disk is deleted when its directory empties', () => {
    const vp = makeVault({
      'wiki/a/page.md': PAGE('Page'),
      'wiki/vieux/index.md': `# Vieux\n\n${projectionMarkerLine()}\n`,
    });
    const r = generateProjectionsOnDisk(vp, { apply: true, now: '2026-07-30' });
    assert.deepEqual(r.deleted, ['wiki/vieux/index.md']);
    assert.equal(fs.existsSync(path.join(vp, 'wiki', 'vieux', 'index.md')), false);
  });
});

describe('okf-projections CLI', () => {
  const run = (...argv) => {
    const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  test('dry-run reports and touches nothing; apply initialises; exit 0', () => {
    const vp = makeVault({ 'wiki/a/page.md': PAGE('Page'), 'wiki/sessions/.gitkeep': '' });
    // remove the .gitkeep so the ghost dir is truly empty
    fs.unlinkSync(path.join(vp, 'wiki', 'sessions', '.gitkeep'));

    const dry = run('--vault', vp);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /3 written/);
    assert.match(dry.out, /Dry-run only/);
    assert.equal(fs.existsSync(path.join(vp, 'wiki', 'index.md')), false);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'sessions')), 'dry-run must not tidy the ghost');

    const apply = run('--vault', vp, '--apply');
    assert.equal(apply.code, 0);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'index.md')));
    assert.equal(fs.existsSync(path.join(vp, 'wiki', 'sessions')), false, 'empty ghost dir removed');
  });

  test('a NON-empty wiki/sessions/ is never removed', () => {
    const vp = makeVault({
      'wiki/a/page.md': PAGE('Page'),
      'wiki/sessions/note.md': '# une vraie note\n',
    });
    assert.equal(run('--vault', vp, '--apply').code, 0);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'sessions', 'note.md')));
  });

  test('conflicts drive a non-zero exit and name the file', () => {
    const vp = makeVault({
      'wiki/a/page.md': PAGE('Page'),
      'wiki/index.md': '# Index écrit main\n',
    });
    const r = run('--vault', vp, '--apply');
    assert.equal(r.code, 1);
    assert.match(r.out, /conflict \(unmarked file, untouched\): wiki\/index\.md/);
    assert.equal(fs.readFileSync(path.join(vp, 'wiki', 'index.md'), 'utf8'), '# Index écrit main\n');
  });

  test('a vault without wiki/ is reported no-wiki, not failed', () => {
    const vp = makeVault({ 'notes/x.md': '# x\n' });
    const r = run('--vault', vp, '--apply');
    assert.equal(r.code, 0);
    assert.match(r.out, /no-wiki/);
  });

  test('--all-vaults reads portRegistry; bad usage exits 1', () => {
    const vp = makeVault({ 'wiki/a/page.md': PAGE('Page') });
    const cfg = path.join(tmpRoot, `cfg-${seq}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [vp]: 27124 } }), 'utf8');
    const r = spawnSync(process.execPath, [CLI, '--all-vaults', '--apply'], {
      encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(vp, 'wiki', 'index.md')));

    assert.equal(run().code, 1);
    assert.equal(run('--vault').code, 1);
  });
});
