/**
 * helpers/pin-provision-target.mjs — provision_vault's target is pinned,
 * judged on its REAL path against the known roots, and refused when the
 * existing tree holds a link. Every test works in its own temporary directory;
 * nothing here runs the provisioning engine (tests/provision-vault.test.mjs
 * does, end to end).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { pinProvisionTarget, assertNoLinksBelow, releaseHeldPinsForTests } from '../src/helpers/pin-provision-target.mjs';
import { defaultPinStrategy, openPinnedOutputDir } from '../src/helpers/pinned-output-dir.mjs';

const isWin = process.platform === 'win32';

function scratch(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pin-provision-')));
  t.after(() => {
    releaseHeldPinsForTests();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'OUTSIDE');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  return { dir, root, outside };
}

const dirLink = (target, at) => fs.symlinkSync(target, at, isWin ? 'junction' : 'dir');

function fileLink(target, at) {
  try { fs.symlinkSync(target, at, 'file'); return true; } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return false;
    throw err;
  }
}

test('a target under a known root is created, pinned, and its REAL path returned', (t) => {
  const { root } = scratch(t);
  const real = pinProvisionTarget(path.join(root, 'New', 'Vault'), { roots: [root] });
  assert.equal(real, path.join(root, 'New', 'Vault'));
  assert.ok(fs.statSync(real).isDirectory());
});

test('win32: while pinned, another process can rename neither the vault directory nor its parent', (t) => {
  if (defaultPinStrategy() !== 'win-probe') { t.skip('the rename block is the Windows pin'); return; }
  const { root } = scratch(t);
  const real = pinProvisionTarget(path.join(root, 'Held'), { roots: [root] });
  const rename = (from) => spawnSync(process.execPath, ['-e',
    `try{require('fs').renameSync(${JSON.stringify(from)},${JSON.stringify(`${from}-x`)});console.log('RENAMED')}catch(e){console.log('REFUSED '+e.code)}`],
  { encoding: 'utf8' }).stdout.trim();
  assert.match(rename(real), /^REFUSED /);
  assert.match(rename(root), /^REFUSED /);
});

test('outside every known root: refused, nothing created — and with NO roots at all too (fail-closed)', (t) => {
  const { root, outside } = scratch(t);
  assert.throws(() => pinProvisionTarget(path.join(outside, 'V'), { roots: [root] }), /outside all known vault roots/);
  assert.throws(() => pinProvisionTarget(path.join(outside, 'W'), { roots: [] }), /outside all known vault roots/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('allowOutsideRoots lets an outside target through', (t) => {
  const { root, outside } = scratch(t);
  assert.equal(pinProvisionTarget(path.join(outside, 'V'), { roots: [root], allowOutsideRoots: true }), path.join(outside, 'V'));
});

test('a JUNCTION under a known root pointing outside is judged on the real path: refused, nothing created there', (t) => {
  const { root, outside } = scratch(t);
  dirLink(outside, path.join(root, 'alias'));
  assert.throws(() => pinProvisionTarget(path.join(root, 'alias', 'V'), { roots: [root] }), /outside all known vault roots/);
  assert.deepEqual(fs.readdirSync(outside), [], 'no level, no probe left where the junction points');
});

test('an existing target holding a DANGLING `.env` link is refused before anything is written through it', (t) => {
  const { root, outside } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(target);
  if (!fileLink(path.join(outside, 'leaked.env'), path.join(target, '.env'))) { t.skip('file symlinks need a privilege here'); return; }
  assert.throws(() => pinProvisionTarget(target, { roots: [root] }), /\.env is a link/);
  assert.equal(fs.existsSync(path.join(outside, 'leaked.env')), false);
});

test('an existing target whose `.obsidian` is a junction is refused', (t) => {
  const { root, outside } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(target);
  dirLink(outside, path.join(target, '.obsidian'));
  assert.throws(() => pinProvisionTarget(target, { roots: [root] }), /\.obsidian is a link/);
});

test('a link DEEP in the existing tree is refused too (the engine writes an index into every wiki directory)', (t) => {
  const { root, outside } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(path.join(target, 'wiki', 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(target, 'wiki', 'a', 'note.md'), '# note');
  dirLink(outside, path.join(target, 'wiki', 'a', 'b', 'elsewhere'));
  assert.throws(() => pinProvisionTarget(target, { roots: [root] }), /elsewhere is a link/);
});

test('a LINK named like a probe is not mistaken for the probe: refused', (t) => {
  const { root, outside } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(target);
  dirLink(outside, path.join(target, '.router-pin-0123456789abcdef'));
  assert.throws(() => pinProvisionTarget(target, { roots: [root] }), /\.router-pin-0123456789abcdef is a link/);
});

test('an existing tree with no link, the probe included, passes; a tree over the entry cap is refused', (t) => {
  const { root } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(path.join(target, 'wiki'), { recursive: true });
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(target, 'wiki', `n${i}.md`), 'x');
  assert.equal(pinProvisionTarget(target, { roots: [root] }), target);
  assert.throws(() => assertNoLinksBelow(target, { maxEntries: 3 }), /more than 3 entries/);
});

test('POSIX: a directory the walk cannot list is refused, not skipped', (t) => {
  if (isWin) { t.skip('the Windows case is the foreign probe, below'); return; }
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root lists a mode-000 directory anyway'); return; }
  const { root } = scratch(t);
  const target = path.join(root, 'Existing');
  const locked = path.join(target, 'wiki', 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.chmodSync(locked, 0o000);
  try {
    assert.throws(() => pinProvisionTarget(target, { roots: [root] }), /locked could not be listed/);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('a directory nobody can list is refused — only the pin\'s OWN probe is exempt, by exact path (Codex review)', (t) => {
  if (defaultPinStrategy() !== 'win-probe') { t.skip('an exclusively held directory is the Windows probe'); return; }
  const { root } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(path.join(target, 'wiki'), { recursive: true });
  // Another holder's probe, named exactly like ours and just as unlistable:
  // it must not hide what is below it from the walk.
  const other = openPinnedOutputDir(path.join(target, 'wiki'));
  try {
    assert.equal(fs.readdirSync(path.join(target, 'wiki')).some((n) => n.startsWith('.router-pin-')), true, 'the foreign probe is there');
    assert.throws(() => pinProvisionTarget(target, { roots: [root] }), /could not be listed/);
  } finally {
    other.close();
  }
});

test('a file with a second name (a hard link) is refused: an in-place write would change the other name too', (t) => {
  const { root, outside } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(target);
  const elsewhere = path.join(outside, 'secret.env');
  fs.writeFileSync(elsewhere, 'KEEP=1');
  fs.linkSync(elsewhere, path.join(target, '.env'));
  assert.throws(() => pinProvisionTarget(target, { roots: [root] }), /\.env has 2 names/);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'KEEP=1');
  assert.deepEqual(fs.readdirSync(target).filter((n) => n.startsWith('.router-pin-')), [], 'a refusal releases the pin at once');
});

test('win32: a file that cannot be opened to count its names is refused (the count is asked of a handle)', (t) => {
  if (!isWin) { t.skip('the handle count is the Windows path; POSIX lstat counts names itself'); return; }
  const { root } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(target);
  const locked = path.join(target, 'locked.md');
  fs.writeFileSync(locked, 'x');
  const who = spawnSync('whoami', { encoding: 'utf8' }).stdout.trim();
  const deny = spawnSync('icacls', [locked, '/deny', `${who}:(R)`], { encoding: 'utf8' });
  if (deny.status !== 0) { t.skip(`icacls could not deny read here: ${deny.stderr || deny.stdout}`); return; }
  try {
    // The deny must actually bite for THIS token before it can prove anything:
    // on an elevated runner (GitHub's windows-latest runs as an administrator
    // with backup privileges) the ACL is not a lock, and the file opens. That
    // is a measurement that could not be made, said as such — not a pass.
    let opened = null;
    try { opened = fs.openSync(locked, 'r'); } catch { opened = null; }
    if (opened !== null) {
      fs.closeSync(opened);
      t.skip('the read deny did not take effect for this account (elevated / backup-privileged token) — the handle-count refusal cannot be measured here');
      return;
    }
    assert.throws(() => pinProvisionTarget(target, { roots: [root] }), /locked\.md could not be opened/);
  } finally {
    spawnSync('icacls', [locked, '/remove:d', who]);
  }
});

test('win32, SIMULATED libuv fallback: lstat forced to say one name, the handle count still refuses a real two-name file', (t) => {
  // Not a native reproduction (the fallback did not reproduce on the machine
  // that wrote this): lstat is patched to report nlink 1, the way libuv's
  // directory-enumeration fallback would, and the refusal must come from the
  // count asked of the open handle.
  if (!isWin) { t.skip('the handle count is the Windows path'); return; }
  const { root, outside } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(target);
  const elsewhere = path.join(outside, 'secret.env');
  fs.writeFileSync(elsewhere, 'KEEP=1');
  const inside = path.join(target, 'twin.md');
  fs.linkSync(elsewhere, inside);
  const savedLstat = fs.lstatSync;
  let forced = 0;
  fs.lstatSync = function patched(p, ...rest) {
    const st = savedLstat.call(this, p, ...rest);
    if (String(p) === inside) { forced += 1; return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { nlink: 1 }); }
    return st;
  };
  try {
    assert.throws(() => pinProvisionTarget(target, { roots: [root] }), /twin\.md has 2 names/);
  } finally {
    fs.lstatSync = savedLstat;
  }
  assert.equal(forced, 1, 'the walk saw the forced single-name stat');
});

test('frozenRoots: a target inside the CURRENT roots but outside the roots the plan was judged on is refused, before anything is created', (t) => {
  const { root, outside } = scratch(t);
  const target = path.join(outside, 'V');
  assert.throws(() => pinProvisionTarget(target, { roots: [root, outside], frozenRoots: [root] }), /outside the vault roots the plan was judged against/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(pinProvisionTarget(path.join(root, 'W'), { roots: [root, outside], frozenRoots: [root] }), path.join(root, 'W'));
});

test('expectedTarget: a pin landing anywhere else than the approved path is refused, before anything is created', (t) => {
  const { root } = scratch(t);
  const approved = path.join(root, 'Approved');
  const other = path.join(root, 'Recomposed');
  assert.throws(() => pinProvisionTarget(other, { roots: [root], expectedTarget: approved }), /the one the plan approved/);
  assert.equal(fs.existsSync(other), false);
  assert.equal(pinProvisionTarget(approved, { roots: [root], expectedTarget: approved }), approved);
});

test('gitInit: a `.git` already in the target is refused (a .git FILE sends git elsewhere); without gitInit it is left alone', (t) => {
  const { root, outside } = scratch(t);
  const target = path.join(root, 'Existing');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, '.git'), `gitdir: ${path.join(outside, 'repo')}\n`);
  assert.throws(() => pinProvisionTarget(target, { roots: [root], gitInit: true }), /\.git already exists/);
  assert.equal(pinProvisionTarget(target, { roots: [root] }), target);
});

test('the target\'s parent swapped for a junction at the moment of the pin: refused, nothing left where it points', (t) => {
  if (defaultPinStrategy() === 'unpinned') { t.skip('no pin on this platform'); return; }
  const { root, outside } = scratch(t);
  const parent = path.join(root, 'parent');
  fs.mkdirSync(parent);
  const swapped = path.join(outside, 'parent');
  fs.mkdirSync(swapped);
  // Swap on cue: just before the pin takes hold of the existing `parent`
  // (Windows: before the probe is created in it; Linux: before it is opened).
  const state = { swapped: 0 };
  const swap = () => { state.swapped += 1; fs.renameSync(parent, `${parent}-moved`); dirLink(swapped, parent); };
  const savedMkdir = fs.mkdirSync;
  const savedOpen = fs.openSync;
  if (defaultPinStrategy() === 'win-probe') {
    fs.mkdirSync = function patched(p, ...rest) {
      if (!state.swapped && path.basename(String(p)).startsWith('.router-pin-') && path.dirname(String(p)) === parent) swap();
      return savedMkdir.call(this, p, ...rest);
    };
  } else {
    fs.openSync = function patched(p, ...rest) {
      if (!state.swapped && String(p) === parent) swap();
      return savedOpen.call(this, p, ...rest);
    };
  }
  try {
    assert.throws(() => pinProvisionTarget(path.join(parent, 'V'), { roots: [root] }));
    assert.equal(state.swapped, 1, 'the swap was injected');
  } finally {
    fs.mkdirSync = savedMkdir;
    fs.openSync = savedOpen;
  }
  assert.deepEqual(fs.readdirSync(swapped), [], 'no level, no probe left where the junction points');
});
