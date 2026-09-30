/**
 * `scripts/conventions-audit.mjs` — the fleet report, run for real on a
 * fixture fleet: the three states measured on 2026-09-26 (a template-born
 * vault, a vault with two conventions files, a remote vault with no disk
 * here), plus the exit codes that keep "never ran" apart from "no findings".
 *
 * Read-only by contract: the test hashes every file of the fleet before and
 * after the run and requires them equal.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { homeSafeEnv } from './_home-safe-spawn.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'conventions-audit.mjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'kiviri-os-documentation');
const BAKS = fs.readdirSync(FIXTURE).filter((f) => f.startsWith('CLAUDE.md.bak'));

function copyDocs(dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['CLAUDE.md', ...BAKS]) fs.copyFileSync(path.join(FIXTURE, f), path.join(dst, f));
}

function treeHash(root) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(`${path.relative(root, p)}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root);
  return h.digest('hex');
}

describe('the conventions fleet audit', () => {
  let work;
  let configPath;
  let run;
  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-audit-'));
    fs.mkdirSync(path.join(work, 'home'));
    const ref = path.join(work, 'fleet', '.template');
    const born = path.join(work, 'fleet', 'Born');
    const dual = path.join(work, 'fleet', 'Dual');
    copyDocs(path.join(ref, 'Documentation'));
    copyDocs(path.join(born, 'Documentation'));
    copyDocs(path.join(dual, 'Documentation'));
    // The vault's OWN file: the eight-convention text, edited — as every real
    // vault's is. Byte-identical to an old template version, it would itself
    // count as a template copy and the audit would (rightly) refuse to guess.
    fs.writeFileSync(path.join(dual, 'CLAUDE.md'), `<!-- dual's own -->\n${fs.readFileSync(path.join(FIXTURE, BAKS.find((b) => b.includes('decision-conventions'))), 'utf8')}`);
    configPath = path.join(work, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      referenceVault: ref,
      portRegistry: { [born]: { https: 27401 }, [dual]: { https: 27403 } },
      vaultNames: { [ref]: 'template', [born]: 'born', [dual]: 'dual' },
      // The shape the router config really has — an ARRAY of records. The first
      // version of this test used a name → record object, and the script, built
      // to match it, reported the real fleet's remote vaults as "0", "1", "2".
      remoteVaults: [{ name: 'Kiviri-OS', baseUrl: 'http://192.0.2.1:27181' }],
    }, null, 2));
    run = (args) => spawnSync(process.execPath, [SCRIPT, '--config', configPath, ...args], {
      encoding: 'utf8', env: homeSafeEnv(path.join(work, 'home')),
    });
  });
  after(() => fs.rmSync(work, { recursive: true, force: true }));

  test('each vault gets the verdict its files support, and nothing is written', () => {
    const before = treeHash(path.join(work, 'fleet'));
    const r = run(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const by = Object.fromEntries(out.vaults.map((v) => [v.vault, v]));

    assert.equal(by.born.verdict, 'attention');
    assert.equal(by.born.candidates[0].templateCopy, true);
    assert.deepEqual(by.born.backups.map((b) => b.inherited), [true, true, true]);
    assert.deepEqual(by.born.findings.map((f) => f.kind).sort(), ['inherited-backups', 'missing-recommended'], 'the template-born vault: inherited backups and never-installed conventions, nothing else');

    assert.equal(by.dual.verdict, 'broken');
    assert.equal(by.dual.ambiguous, true);
    assert.equal(by.dual.findings.find((f) => f.kind === 'ambiguous-conventions-file').repair.steps[0].args.from, 'Documentation/CLAUDE.md');

    assert.equal(by.template.reference, true);
    assert.equal(by['Kiviri-OS'].verdict, 'skipped', 'a remote vault is SKIPPED, not clean');
    assert.match(by['Kiviri-OS'].skipped, /audit_vault_conventions/);

    assert.equal(out.total, 4);
    assert.equal(treeHash(path.join(work, 'fleet')), before, 'read-only');
  });

  test('a reference vault that cannot be read in full makes "template copy" UNKNOWN, not false', () => {
    // A conventions file of the reference that cannot be read (here: a
    // directory where the file should be) would make every copy of it look
    // like a vault's own file. A partial reference is an unknown one.
    const partialRef = path.join(work, 'fleet-partial', '.template');
    const born = path.join(work, 'fleet-partial', 'Born');
    fs.mkdirSync(path.join(partialRef, 'Documentation', 'CLAUDE.md'), { recursive: true });
    copyDocs(path.join(born, 'Documentation'));
    const cfg2 = path.join(work, 'config-partial.json');
    fs.writeFileSync(cfg2, JSON.stringify({ referenceVault: partialRef, portRegistry: { [born]: { https: 27405 } }, vaultNames: { [born]: 'born' } }));
    const r = spawnSync(process.execPath, [SCRIPT, '--config', cfg2, '--json', '--vault', 'born'], { encoding: 'utf8', env: homeSafeEnv(path.join(work, 'home')) });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.referenceKnown, false);
    assert.equal(out.vaults[0].candidates[0].templateCopy, null);
    assert.ok(out.vaults[0].backups.every((b) => b.inherited === null));
  });

  test('a reference path that is a regular FILE is unknown, not an empty known reference', () => {
    const fileRef = path.join(work, 'not-a-vault.txt');
    fs.writeFileSync(fileRef, 'x');
    const born = path.join(work, 'fleet-fileref', 'Born');
    copyDocs(path.join(born, 'Documentation'));
    const cfg3 = path.join(work, 'config-fileref.json');
    fs.writeFileSync(cfg3, JSON.stringify({ referenceVault: fileRef, portRegistry: { [born]: { https: 27407 } }, vaultNames: { [born]: 'born' } }));
    const r = spawnSync(process.execPath, [SCRIPT, '--config', cfg3, '--json', '--vault', 'born'], { encoding: 'utf8', env: homeSafeEnv(path.join(work, 'home')) });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.referenceKnown, false);
    assert.equal(out.vaults[0].candidates[0].templateCopy, null);
  });

  test('--vault narrows to one; an unknown one fails the run', () => {
    const one = run(['--json', '--vault', 'dual']);
    assert.equal(one.status, 0, one.stderr);
    assert.deepEqual(JSON.parse(one.stdout).vaults.map((v) => v.vault), ['dual']);
    const none = run(['--vault', 'nope']);
    assert.equal(none.status, 1);
  });

  test('an unreadable config or an empty library is a failed run, not a clean fleet', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--config', path.join(work, 'missing.json')], { encoding: 'utf8', env: homeSafeEnv(path.join(work, 'home')) });
    assert.equal(r.status, 1);
    const empty = path.join(work, 'empty-lib');
    fs.mkdirSync(empty, { recursive: true });
    const r2 = run(['--snippets', empty]);
    assert.equal(r2.status, 1);
  });
});
