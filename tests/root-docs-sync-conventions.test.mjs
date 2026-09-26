/**
 * A template sync carries the reference vault's docs — never its conventions
 * file into a vault that has one, never its backups anywhere.
 *
 * EXECUTION test: spawns the real `scripts/setup-vault.mjs --sync-plugins`
 * against a fixture reference vault in a temp directory, with its own config
 * and a throwaway HOME, then inspects what landed on disk.
 *
 * The incident it pins (2026-09-22, measured 2026-09-26): one sync copied the
 * reference vault's `Documentation/` — its conventions file and three
 * `CLAUDE.md.bak-*` backups of it — into every vault. 13 of 27 local vaults
 * ended with two conventions files (their own, plus the template's), which the
 * router refuses to choose between; all of them carry backups that are the
 * template's history, and a later diagnosis read those as the vault's own.
 * Under `--force`, the same function first DELETED the target's Documentation/
 * — its own conventions file and backups included.
 *
 * The reference vault's conventions file and backups are the real ones
 * (tests/fixtures/kiviri-os-documentation/), so the shape is production's.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnSyncHomeSafe } from './_home-safe-spawn.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'setup-vault.mjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'kiviri-os-documentation');
const BAKS = fs.readdirSync(FIXTURE).filter((f) => f.startsWith('CLAUDE.md.bak'));

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function buildReference(ref) {
  const plugin = path.join(ref, '.obsidian', 'plugins', 'fixture-plugin');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'manifest.json'), JSON.stringify({ id: 'fixture-plugin', version: '1.0.0' }));
  fs.writeFileSync(path.join(plugin, 'main.js'), '// fixture');
  fs.writeFileSync(path.join(ref, '.obsidian', 'community-plugins.json'), JSON.stringify(['fixture-plugin']));
  const docs = path.join(ref, 'Documentation');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'SETUP.md'), '# fixture setup');
  for (const f of ['CLAUDE.md', ...BAKS]) fs.copyFileSync(path.join(FIXTURE, f), path.join(docs, f));
}

function makeVault(root, files) {
  fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function sync(work, vault, extra = []) {
  return spawnSyncHomeSafe(process.execPath, [SCRIPT, vault, '--sync-plugins', ...extra], {
    homeDir: path.join(work, 'home'),
    env: { OBSIDIAN_ROUTER_CONFIG: path.join(work, 'config.json') },
  });
}

describe('a template sync into existing vaults', () => {
  let work;
  let ref;
  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'rootdocs-sync-'));
    fs.mkdirSync(path.join(work, 'home'));
    ref = path.join(work, '.template');
    buildReference(ref);
    fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify({ referenceVault: ref, portRegistry: {}, portStart: 27400 }, null, 2));
  });
  after(() => fs.rmSync(work, { recursive: true, force: true }));

  test('a vault with its conventions at the root gets the docs, and no second conventions file', () => {
    const v = path.join(work, 'root-conv');
    makeVault(v, { 'CLAUDE.md': '# my own conventions\n' });
    const before = sha(path.join(v, 'CLAUDE.md'));
    const r = sync(work, v);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(fs.existsSync(path.join(v, 'Documentation', 'SETUP.md')), 'the docs still travel');
    assert.equal(fs.existsSync(path.join(v, 'Documentation', 'CLAUDE.md')), false, 'a second conventions file makes the vault ambiguous');
    for (const b of BAKS) assert.equal(fs.existsSync(path.join(v, 'Documentation', b)), false, `${b} is the template's history`);
    assert.equal(sha(path.join(v, 'CLAUDE.md')), before, 'the vault\'s own file is untouched');
    assert.match(r.stdout + r.stderr, /left out Documentation\/CLAUDE\.md/, 'what was left out is said');
  });

  test('under --force, a vault keeps its own Documentation/ conventions file and backups', () => {
    const v = path.join(work, 'doc-conv');
    makeVault(v, {
      'Documentation/CLAUDE.md': '# my own, in Documentation\n',
      'Documentation/CLAUDE.md.bak-mine-2026-09-01': '# my own history\n',
      'Documentation/notes.md': 'mine',
    });
    const own = sha(path.join(v, 'Documentation', 'CLAUDE.md'));
    const r = sync(work, v, ['--force']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(sha(path.join(v, 'Documentation', 'CLAUDE.md')), own, 'never overwritten by a docs sync');
    assert.ok(fs.existsSync(path.join(v, 'Documentation', 'CLAUDE.md.bak-mine-2026-09-01')), 'its own backup survives --force');
    assert.ok(fs.existsSync(path.join(v, 'Documentation', 'notes.md')), '--force merges, it does not wipe the folder first');
    assert.ok(fs.existsSync(path.join(v, 'Documentation', 'SETUP.md')));
    for (const b of BAKS) assert.equal(fs.existsSync(path.join(v, 'Documentation', b)), false);
  });

  test('a folder whose every entry is left out does not read "Cloned"', () => {
    // A reference whose Documentation/ holds only a conventions file and its
    // backups, synced with --force into a vault that has its own conventions.
    const ref2 = path.join(work, '.template-only-conv');
    buildReference(ref2);
    fs.rmSync(path.join(ref2, 'Documentation', 'SETUP.md'));
    fs.writeFileSync(path.join(work, 'config-only-conv.json'), JSON.stringify({ referenceVault: ref2, portRegistry: {}, portStart: 27420 }, null, 2));
    const v = path.join(work, 'only-conv');
    makeVault(v, { 'CLAUDE.md': '# mine\n' });
    const r = spawnSyncHomeSafe(process.execPath, [SCRIPT, v, '--sync-plugins', '--force'], {
      homeDir: path.join(work, 'home'),
      env: { OBSIDIAN_ROUTER_CONFIG: path.join(work, 'config-only-conv.json') },
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const out = r.stdout + r.stderr;
    assert.doesNotMatch(out, /Cloned Documentation/);
    assert.match(out, /Nothing to clone from Documentation/);
  });

  test('a vault with no conventions file at all still receives the template\'s — without its backups', () => {
    const v = path.join(work, 'bare');
    makeVault(v, { 'wiki/a.md': 'x' });
    const r = sync(work, v);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(sha(path.join(v, 'Documentation', 'CLAUDE.md')), sha(path.join(ref, 'Documentation', 'CLAUDE.md')));
    for (const b of BAKS) assert.equal(fs.existsSync(path.join(v, 'Documentation', b)), false);
  });
});
