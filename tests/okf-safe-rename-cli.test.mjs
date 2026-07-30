/**
 * End-to-end tests for `scripts/okf-safe-rename-vault.mjs` in TABLE mode —
 * the safety properties live in the CLI, not the pure planner: dry-run never
 * touches the disk, a collision BLOCKS the apply instead of auto-suffixing,
 * fleet mode reports per-vault and exits non-zero when any vault is blocked,
 * and a re-run is a no-op.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'okf-safe-rename-vault.mjs');

let tmpRoot;
before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-rename-cli-'));
});
after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

let seq = 0;
/** Build a throwaway vault. `extra` maps relative path → content. */
function makeVault(extra = {}, opts = {}) {
  const vp = path.join(tmpRoot, `v${seq++}`);
  const write = (rel, content) => {
    const abs = path.join(vp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };
  if (opts.scaffolds !== false) {
    write('wiki-meta/index.md', '---\ntype: wiki-index\ntitle: "Wiki Index"\n---\n\n# Wiki Index\n\n- [[log]] — journal\n');
    write('wiki-meta/log.md', '---\ntype: wiki-log\ntitle: "Wiki Log"\n---\n\n# Wiki Log\n\n⟵ [[index]]\n');
    write('wiki-meta/hot.md', '# Hot\n\nCf `wiki-meta/index.md` et wiki-meta/log.md.\n\n⟵ [[index]] · [[log]]\n');
    write('wiki/Divers/page.md', '# P\n\n[[index|le catalogue]]\n\n⟵ [[index]] · [[log]]\n');
  }
  for (const [rel, content] of Object.entries(extra)) write(rel, content);
  return vp;
}

function run(...argv) {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const PRESET = ['--preset', 'okf-reserved-scaffolds'];
const read = (vp, rel) => fs.readFileSync(path.join(vp, rel), 'utf8');
const exists = (vp, rel) => fs.existsSync(path.join(vp, rel));

describe('okf-safe-rename-vault CLI — table mode', () => {
  test('dry-run reports the plan and touches nothing', () => {
    const vp = makeVault();
    const r = run(...PRESET, '--vault', vp);
    assert.equal(r.code, 0);
    assert.match(r.out, /mode:\s+table \(preset okf-reserved-scaffolds\)/);
    assert.match(r.out, /display preserved:\s+no/);
    assert.match(r.out, /wiki-meta\/index\.md\s+→\s+wiki-meta\/catalog\.md/);
    assert.match(r.out, /Dry-run only/);
    assert.equal(exists(vp, 'wiki-meta/index.md'), true);
    assert.equal(exists(vp, 'wiki-meta/catalog.md'), false);
    assert.match(read(vp, 'wiki-meta/hot.md'), /\[\[index\]\]/);
  });

  test('--apply renames, rewrites links without aliases, retitles and verifies', () => {
    const vp = makeVault();
    const r = run(...PRESET, '--vault', vp, '--apply');
    assert.equal(r.code, 0);
    assert.match(r.out, /VERIFY ✅/);
    assert.match(r.out, /scaffolds retitled:\s+2/);

    assert.equal(exists(vp, 'wiki-meta/index.md'), false);
    assert.equal(exists(vp, 'wiki-meta/log.md'), false);
    assert.equal(exists(vp, 'wiki-meta/catalog.md'), true);
    assert.equal(exists(vp, 'wiki-meta/journal.md'), true);

    // No display-preserving alias — the whole point of the decision.
    assert.match(read(vp, 'wiki-meta/hot.md'), /⟵ \[\[catalog\]\] · \[\[journal\]\]/);
    assert.doesNotMatch(read(vp, 'wiki-meta/hot.md'), /\|index\]\]|\|log\]\]/);
    // Plain-text path mentions follow.
    assert.match(read(vp, 'wiki-meta/hot.md'), /`wiki-meta\/catalog\.md` et wiki-meta\/journal\.md/);
    // An alias the author wrote survives.
    assert.match(read(vp, 'wiki/Divers/page.md'), /\[\[catalog\|le catalogue\]\]/);
    // The scaffold no longer calls itself Index/Log.
    assert.match(read(vp, 'wiki-meta/catalog.md'), /^# Wiki Catalog$/m);
    assert.match(read(vp, 'wiki-meta/journal.md'), /^# Wiki Journal$/m);
    assert.match(read(vp, 'wiki-meta/catalog.md'), /^type: wiki-index$/m);
  });

  test('--apply leaves a reversible backup + manifest describing the mode', () => {
    const vp = makeVault();
    assert.equal(run(...PRESET, '--vault', vp, '--apply').code, 0);
    const stamps = fs.readdirSync(path.join(vp, '.okf-rename-backup'));
    assert.equal(stamps.length, 1);
    const backup = path.join(vp, '.okf-rename-backup', stamps[0]);
    // Original bytes, original relative paths.
    assert.match(fs.readFileSync(path.join(backup, 'wiki-meta/index.md'), 'utf8'), /^# Wiki Index$/m);
    assert.match(fs.readFileSync(path.join(backup, 'wiki-meta/hot.md'), 'utf8'), /\[\[index\]\]/);
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
    assert.equal(manifest.mode, 'table');
    assert.equal(manifest.preset, 'okf-reserved-scaffolds');
    assert.equal(manifest.preserveDisplay, false);
    assert.deepEqual(manifest.renames.map((r) => r.newPath).sort(), [
      'wiki-meta/catalog.md',
      'wiki-meta/journal.md',
    ]);
    assert.deepEqual(manifest.retitled.map((r) => r.relPath).sort(), [
      'wiki-meta/catalog.md',
      'wiki-meta/journal.md',
    ]);
  });

  test('re-running after a successful apply is a clean no-op', () => {
    const vp = makeVault();
    assert.equal(run(...PRESET, '--vault', vp, '--apply').code, 0);
    const before = read(vp, 'wiki-meta/catalog.md');
    const second = run(...PRESET, '--vault', vp, '--apply');
    assert.equal(second.code, 0);
    assert.match(second.out, /Nothing from the table is present/);
    assert.equal(read(vp, 'wiki-meta/catalog.md'), before);
    assert.equal(fs.readdirSync(path.join(vp, '.okf-rename-backup')).length, 1);
  });

  test('a pre-existing target BLOCKS the apply — nothing is renamed or suffixed', () => {
    const vp = makeVault({ 'wiki-meta/catalog.md': '# mine\n' });
    const r = run(...PRESET, '--vault', vp, '--apply');
    assert.equal(r.code, 1);
    assert.match(r.out, /BLOCKED — 1 collision/);
    assert.match(r.out, /target already exists/);
    // Refused wholesale: even the non-colliding half is untouched.
    assert.equal(exists(vp, 'wiki-meta/index.md'), true);
    assert.equal(exists(vp, 'wiki-meta/log.md'), true);
    assert.equal(exists(vp, 'wiki-meta/journal.md'), false);
    assert.equal(read(vp, 'wiki-meta/catalog.md'), '# mine\n');
    assert.equal(exists(vp, '.okf-rename-backup'), false);
    assert.doesNotMatch(r.out, /catalog-2/);
  });

  test('a vault without the scaffolds is skipped, not failed', () => {
    const vp = makeVault({ 'wiki/only.md': '# only\n' }, { scaffolds: false });
    const r = run(...PRESET, '--vault', vp, '--apply');
    assert.equal(r.code, 0);
    assert.match(r.out, /not present here:\s+wiki-meta\/index\.md, wiki-meta\/log\.md/);
    assert.match(r.out, /Nothing from the table is present/);
  });

  test('an ambiguous basename is reported and its links are left untouched', () => {
    const vp = makeVault({ 'dev-dashboard/Index.md': '# Dev\n' });
    const r = run(...PRESET, '--vault', vp, '--apply');
    assert.equal(r.code, 0);
    assert.match(r.out, /ambiguous old stems:\s+1 → index/);
    assert.match(r.out, /also: dev-dashboard\/Index\.md/);
    assert.match(r.out, /links left untouched/);
    assert.match(r.out, /VERIFY ✅/);
    // The file still moved and `log` was clean; only `[[index]]` stayed put.
    assert.equal(exists(vp, 'wiki-meta/catalog.md'), true);
    assert.match(read(vp, 'wiki-meta/hot.md'), /⟵ \[\[index\]\] · \[\[journal\]\]/);
    // Path-form and plain-text mentions are unambiguous, so they follow.
    assert.match(read(vp, 'wiki-meta/hot.md'), /`wiki-meta\/catalog\.md`/);
  });

  test('--preserve-display overrides the preset back to aliased rewrites', () => {
    const vp = makeVault();
    assert.equal(run(...PRESET, '--vault', vp, '--preserve-display', '--apply').code, 0);
    assert.match(read(vp, 'wiki-meta/hot.md'), /\[\[catalog\|index\]\] · \[\[journal\|log\]\]/);
  });

  test('fleet mode prints a per-vault summary and fails on the worst outcome', () => {
    const ok1 = makeVault();
    const ok2 = makeVault();
    const blocked = makeVault({ 'wiki-meta/journal.md': '# mine\n' });
    const r = run(...PRESET, '--vault', ok1, '--vault', ok2, '--vault', blocked, '--apply');
    assert.equal(r.code, 1);
    assert.match(r.out, /=== fleet summary — 3 vault\(s\) ===/);
    assert.match(r.out, /ok: 2/);
    assert.match(r.out, /blocked: 1/);
    // The healthy vaults still migrated — one bad vault does not stop the run.
    assert.equal(exists(ok1, 'wiki-meta/catalog.md'), true);
    assert.equal(exists(ok2, 'wiki-meta/catalog.md'), true);
    assert.equal(exists(blocked, 'wiki-meta/index.md'), true);
  });

  test('a stale config path is reported as unreachable, not crashed on', () => {
    const vp = makeVault();
    const ghost = path.join(tmpRoot, 'does-not-exist');
    const r = run(...PRESET, '--vault', vp, '--vault', ghost, '--apply');
    assert.equal(r.code, 0);
    assert.match(r.out, /SKIPPED — not an existing directory/);
    assert.match(r.out, /unreachable: 1/);
  });

  test('--all-vaults reads portRegistry from the router config', () => {
    const vp = makeVault();
    const cfg = path.join(tmpRoot, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [vp]: 27124 } }), 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT, ...PRESET, '--all-vaults', '--apply'], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /VERIFY ✅/);
    assert.equal(exists(vp, 'wiki-meta/catalog.md'), true);
  });

  test('an explicit --vault duplicate of a registered vault is migrated once', () => {
    const vp = makeVault();
    const cfg = path.join(tmpRoot, 'config-dup.json');
    fs.writeFileSync(cfg, JSON.stringify({ portRegistry: { [vp]: 27124 } }), 'utf8');
    const r = spawnSync(
      process.execPath,
      [SCRIPT, ...PRESET, '--all-vaults', '--vault', vp, '--apply'],
      { encoding: 'utf8', env: { ...process.env, OBSIDIAN_ROUTER_CONFIG: cfg } },
    );
    assert.equal(r.status, 0);
    assert.equal((r.stdout.match(/VERIFY ✅/g) ?? []).length, 1);
    assert.doesNotMatch(r.stdout, /fleet summary/); // one vault, not two
  });

  test('--table drives an arbitrary rename from a JSON file', () => {
    const vp = makeVault({ 'wiki/old-name.md': '# Old\n', 'wiki/cite.md': 'cf [[old-name]]\n' });
    const tableFile = path.join(tmpRoot, 'table.json');
    fs.writeFileSync(
      tableFile,
      JSON.stringify({
        preserveDisplay: false,
        renames: [{ oldPath: 'wiki/old-name.md', newPath: 'wiki/new-name.md' }],
      }),
      'utf8',
    );
    const r = run('--table', tableFile, '--vault', vp, '--apply');
    assert.equal(r.code, 0);
    assert.match(r.out, /mode:\s+table$/m);
    assert.equal(read(vp, 'wiki/cite.md'), 'cf [[new-name]]\n');
    // The scaffolds were not in this table, so they stayed put.
    assert.equal(exists(vp, 'wiki-meta/index.md'), true);
  });

  test('bad usage exits 1 with the preset list', () => {
    assert.equal(run('--preset', 'nope', '--vault', tmpRoot).code, 1);
    assert.match(run('--preset', 'nope', '--vault', tmpRoot).out, /okf-reserved-scaffolds/);
    assert.equal(run(...PRESET).code, 1); // no vault
    assert.equal(run('--preset', 'okf-reserved-scaffolds', '--table', 'x.json', '--vault', tmpRoot).code, 1);
  });
});

describe('okf-safe-rename-vault CLI — charset mode is unchanged', () => {
  test('charset mode still slugifies and keeps the display-preserving alias', () => {
    const vp = makeVault({
      "wiki/Vue d'ensemble.md": '# Vue\n',
      'wiki/cite.md': "cf [[Vue d'ensemble]]\n",
    });
    const r = run('--vault', vp, '--apply');
    assert.equal(r.code, 0);
    assert.match(r.out, /mode:\s+charset/);
    assert.match(r.out, /VERIFY ✅/);
    assert.equal(exists(vp, 'wiki/vue-d-ensemble.md'), true);
    assert.equal(read(vp, 'wiki/cite.md'), "cf [[vue-d-ensemble|Vue d'ensemble]]\n");
    // Charset mode does not know about the scaffold table.
    assert.equal(exists(vp, 'wiki-meta/index.md'), true);
  });
});
