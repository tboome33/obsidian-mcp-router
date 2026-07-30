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

  test('a cross-directory table entry blocks the apply and touches nothing', () => {
    // review+ pass 1, convergent BLOCKER (Reviewer A + codex P1).
    const vp = makeVault({ 'wiki/Divers/old-name.md': '# Old\n', 'wiki/cite.md': 'cf [[old-name]]\n' });
    fs.mkdirSync(path.join(vp, 'wiki/Archive'), { recursive: true });
    fs.writeFileSync(path.join(vp, 'wiki/Archive/keep.md'), '# keep\n', 'utf8');
    const tableFile = path.join(tmpRoot, `cross-${seq}.json`);
    fs.writeFileSync(tableFile, JSON.stringify({
      renames: [{ oldPath: 'wiki/Divers/old-name.md', newPath: 'wiki/Archive/new-name.md' }],
    }), 'utf8');

    const r = run('--table', tableFile, '--vault', vp, '--apply');
    assert.equal(r.code, 1);
    assert.match(r.out, /BLOCKED — 1 collision/);
    assert.match(r.out, /cross-directory move is not supported/);
    // The file stayed put, the citing note was NOT rewritten to a path that
    // would never exist, and no backup was opened.
    assert.equal(exists(vp, 'wiki/Divers/old-name.md'), true);
    assert.equal(exists(vp, 'wiki/Archive/new-name.md'), false);
    assert.equal(read(vp, 'wiki/cite.md'), 'cf [[old-name]]\n');
    assert.equal(exists(vp, '.okf-rename-backup'), false);
  });

  test('a table entry escaping the vault is refused and writes nothing outside', () => {
    const vp = makeVault();
    const outside = path.join(tmpRoot, 'outside-target.md');
    fs.writeFileSync(outside, '# Wiki Index\nOUTSIDE\n', 'utf8');
    const tableFile = path.join(tmpRoot, `escape-${seq}.json`);
    fs.writeFileSync(tableFile, JSON.stringify({
      renames: [{ oldPath: 'wiki-meta/index.md', newPath: '../outside-target.md' }],
      retitle: [{ path: '../outside-target.md', words: [['Index', 'PWNED']] }],
    }), 'utf8');

    const r = run('--table', tableFile, '--vault', vp, '--apply');
    assert.equal(r.code, 1);
    assert.match(r.out, /escapes the vault/);
    assert.equal(fs.readFileSync(outside, 'utf8'), '# Wiki Index\nOUTSIDE\n');
    assert.equal(exists(vp, 'wiki-meta/index.md'), true);
  });

  test('a successful apply leaves the manifest marked applied', () => {
    const vp = makeVault();
    assert.equal(run(...PRESET, '--vault', vp, '--apply').code, 0);
    const stamps = fs.readdirSync(path.join(vp, '.okf-rename-backup'));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(vp, '.okf-rename-backup', stamps[0], 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.status, 'applied');
    assert.equal(manifest.retitled.length, 2);
  });

  test('an apply that throws mid-way still leaves a manifest and names the backup', () => {
    // This is what the manifest-before-mutation ordering buys: a rename can
    // fail on a vault Obsidian holds open (EBUSY/EPERM), and the operator must
    // still get a record of what was attempted and where the backup is.
    //
    // Forced without mocking: mark one of the files the apply must REWRITE as
    // read-only, so `writeFileSync` throws after the backup + manifest are on
    // disk but before any rename runs.
    const vp = makeVault();
    const victim = path.join(vp, 'wiki-meta/hot.md');
    fs.chmodSync(victim, 0o444);
    let r;
    try {
      r = run(...PRESET, '--vault', vp, '--apply');
    } finally {
      fs.chmodSync(victim, 0o644);
    }
    assert.equal(r.code, 1, 'a failed apply must exit non-zero');
    assert.match(r.out, /partial apply; backup \+ manifest:/, 'the error must point at the backup');
    assert.doesNotMatch(r.out, /undefined — partial apply/, 'the error detail must not be undefined');

    const stamps = fs.readdirSync(path.join(vp, '.okf-rename-backup'));
    assert.equal(stamps.length, 1, 'the backup dir must exist even though the apply failed');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(vp, '.okf-rename-backup', stamps[0], 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.status, 'failed');
    assert.ok(manifest.error, 'the manifest must carry the cause');
    assert.deepEqual(manifest.renames.map((x) => x.newPath).sort(), [
      'wiki-meta/catalog.md',
      'wiki-meta/journal.md',
    ], 'the manifest must record the FULL intended plan, not just what got done');
    // Nothing was renamed — the failure happened during the content pass.
    assert.equal(exists(vp, 'wiki-meta/index.md'), true);
    assert.equal(exists(vp, 'wiki-meta/catalog.md'), false);
  });

  test('an empty directory squatting the destination is refused, not hit mid-apply', () => {
    // The planner reasons over a FILE list, so a directory with no files in it
    // is invisible to it; without the CLI pre-flight this threw EPERM halfway
    // through the renames.
    const vp = makeVault();
    fs.mkdirSync(path.join(vp, 'wiki-meta/journal.md'), { recursive: true });
    const r = run(...PRESET, '--vault', vp, '--apply');
    assert.equal(r.code, 1);
    assert.match(r.out, /BLOCKED/);
    assert.match(r.out, /not in the scanned file list/);
    assert.equal(exists(vp, 'wiki-meta/index.md'), true, 'nothing may be renamed');
    assert.equal(exists(vp, 'wiki-meta/catalog.md'), false);
    assert.equal(exists(vp, '.okf-rename-backup'), false, 'no backup — we never started');
  });

  test('bad usage exits 1 with the preset list', () => {
    assert.equal(run('--preset', 'nope', '--vault', tmpRoot).code, 1);
    assert.match(run('--preset', 'nope', '--vault', tmpRoot).out, /okf-reserved-scaffolds/);
    assert.equal(run(...PRESET).code, 1); // no vault
    assert.equal(run('--preset', 'okf-reserved-scaffolds', '--table', 'x.json', '--vault', tmpRoot).code, 1);
    // A value-taking flag in last position must print usage, not a stack trace.
    for (const flag of ['--vault', '--preset', '--table']) {
      const r = run(flag);
      assert.equal(r.code, 1, `${flag} alone should exit 1`);
      assert.match(r.out, /requires a value/, `${flag} alone should say so`);
      assert.doesNotMatch(r.out, /at Object\.|node:internal/, `${flag} alone must not print a stack trace`);
    }
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
