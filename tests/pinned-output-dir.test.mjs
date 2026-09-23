/**
 * helpers/pinned-output-dir.mjs — the output directory cannot be swapped from
 * under the writer, and no file is ever placed by opening its destination
 * name. Every test here works in its own temporary directory.
 *
 * Platform-specific witnesses SKIP, and say why, where the mechanism they
 * witness does not exist: the Windows pin on Linux, the /proc pin on Windows.
 * CI runs both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { openPinnedOutputDir, assertChildName, defaultPinStrategy, loadWindowsNativeHelper } from '../src/helpers/pinned-output-dir.mjs';

const isWin = process.platform === 'win32';
const STRATEGIES = [defaultPinStrategy(), ...(defaultPinStrategy() === 'unpinned' ? [] : ['unpinned'])];

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-out-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpathSync.native(dir);
}

/** A directory link that needs no privilege: a junction on Windows. */
function dirLink(target, at) {
  fs.symlinkSync(target, at, isWin ? 'junction' : 'dir');
}

/** A FILE link — may need a privilege on Windows; null when refused. */
function fileLink(target, at) {
  try {
    fs.symlinkSync(target, at, 'file');
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return null;
    throw err;
  }
}

/** Another PROCESS tries the rename, the way an attacker would. */
function otherProcessRename(from, to) {
  const code = `try{require('fs').renameSync(${JSON.stringify(from)},${JSON.stringify(to)});console.log('RENAMED')}`
    + `catch(e){console.log('REFUSED '+e.code)}`;
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }).stdout.trim();
}

const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.router-'));

for (const strategy of STRATEGIES) {
  test(`[${strategy}] createNoReplace creates once, then says "exists" and leaves the bytes alone`, (t) => {
    const dir = scratch(t);
    const out = openPinnedOutputDir(path.join(dir, 'a', 'b'), { strategy });
    try {
      assert.equal(out.path, path.join(dir, 'a', 'b'));
      assert.equal(out.createNoReplace('x.png', Buffer.from('first')), 'created');
      assert.equal(out.createNoReplace('x.png', Buffer.from('second')), 'exists');
      assert.equal(fs.readFileSync(path.join(dir, 'a', 'b', 'x.png'), 'utf8'), 'first');
      assert.equal(out.holdsSameBytes('x.png', Buffer.from('first')), true);
      assert.equal(out.holdsSameBytes('x.png', Buffer.from('other')), false);
      assert.equal(out.holdsSameBytes('absent.png', Buffer.from('first')), false);
    } finally {
      out.close();
    }
    assert.deepEqual(leftovers(path.join(dir, 'a', 'b')), [], 'no anchor or temporary left behind');
  });

  test(`[${strategy}] a DANGLING directory link at the name counts as taken — nothing is created where it points`, (t) => {
    const dir = scratch(t);
    const out = openPinnedOutputDir(path.join(dir, 'out'), { strategy });
    const nowhere = path.join(dir, 'nowhere');
    dirLink(nowhere, path.join(dir, 'out', 'x.png'));
    try {
      assert.equal(out.createNoReplace('x.png', Buffer.from('bytes')), 'exists');
      assert.equal(fs.existsSync(nowhere), false, 'the link target was not created');
      assert.equal(out.holdsSameBytes('x.png', Buffer.from('bytes')), false, 'a link is never a match');
    } finally {
      out.close();
    }
  });

  test(`[${strategy}] a DANGLING file link at the name counts as taken — the measured wx hole`, (t) => {
    const dir = scratch(t);
    const out = openPinnedOutputDir(path.join(dir, 'out'), { strategy });
    const target = path.join(dir, 'created-through-link.txt');
    try {
      if (fileLink(target, path.join(dir, 'out', 'x.png')) === null) {
        t.skip('file symlinks need a privilege this account does not hold');
        return;
      }
      assert.equal(out.createNoReplace('x.png', Buffer.from('bytes')), 'exists');
      assert.equal(fs.existsSync(target), false, 'the link target was not created');
    } finally {
      out.close();
    }
  });

  test(`[${strategy}] replace swaps a LIVE file link for a regular file; the link's target keeps its bytes`, (t) => {
    const dir = scratch(t);
    const out = openPinnedOutputDir(path.join(dir, 'out'), { strategy });
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'VICTIM');
    try {
      if (fileLink(victim, path.join(dir, 'out', 'x.png')) === null) {
        t.skip('file symlinks need a privilege this account does not hold');
        return;
      }
      out.replace('x.png', Buffer.from('NEW'));
      assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM');
      const st = fs.lstatSync(path.join(dir, 'out', 'x.png'));
      assert.ok(st.isFile() && !st.isSymbolicLink());
      assert.equal(fs.readFileSync(path.join(dir, 'out', 'x.png'), 'utf8'), 'NEW');
    } finally {
      out.close();
    }
  });

  test(`[${strategy}] replace refuses a directory at the name and leaves no temporary`, (t) => {
    const dir = scratch(t);
    const out = openPinnedOutputDir(path.join(dir, 'out'), { strategy });
    fs.mkdirSync(path.join(dir, 'out', 'x.png'));
    fs.writeFileSync(path.join(dir, 'out', 'x.png', 'inner'), 'kept');
    try {
      assert.throws(() => out.replace('x.png', Buffer.from('NEW')));
      assert.equal(fs.readFileSync(path.join(dir, 'out', 'x.png', 'inner'), 'utf8'), 'kept');
    } finally {
      out.close();
    }
    assert.deepEqual(leftovers(path.join(dir, 'out')), []);
  });

  test(`[${strategy}] holdsSameBytes: a link to a file holding the SAME bytes is not a match`, (t) => {
    const dir = scratch(t);
    const out = openPinnedOutputDir(path.join(dir, 'out'), { strategy });
    const twin = path.join(dir, 'twin.png');
    fs.writeFileSync(twin, 'same');
    try {
      if (fileLink(twin, path.join(dir, 'out', 'x.png')) === null) {
        t.skip('file symlinks need a privilege this account does not hold');
        return;
      }
      assert.equal(out.holdsSameBytes('x.png', Buffer.from('same')), false);
    } finally {
      out.close();
    }
  });

  test(`[${strategy}] authorize is asked about the REAL path, before anything is created; a refusal creates nothing`, (t) => {
    const dir = scratch(t);
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    dirLink(real, path.join(dir, 'alias'));
    const seen = [];
    const out = openPinnedOutputDir(path.join(dir, 'alias', 'new'), { strategy, authorize: (p) => seen.push(p) });
    out.close();
    assert.deepEqual(seen, [path.join(real, 'new')]);
    assert.equal(out.path, path.join(real, 'new'));

    assert.throws(
      () => openPinnedOutputDir(path.join(dir, 'alias', 'refused', 'deeper'), { strategy, authorize: () => { throw new Error('NO'); } }),
      /NO/,
    );
    assert.equal(fs.existsSync(path.join(real, 'refused')), false);
  });

  test(`[${strategy}] createMissing:false refuses a missing directory; an existing FILE is never a directory`, (t) => {
    const dir = scratch(t);
    assert.throws(() => openPinnedOutputDir(path.join(dir, 'missing'), { strategy, createMissing: false }), /does not exist/);
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    assert.throws(() => openPinnedOutputDir(path.join(dir, 'file'), { strategy }));
    assert.throws(() => openPinnedOutputDir(path.join(dir, 'file', 'below'), { strategy }));
  });

  test(`[${strategy}] a closed pin refuses further writes; close is idempotent`, (t) => {
    const dir = scratch(t);
    const out = openPinnedOutputDir(path.join(dir, 'out'), { strategy });
    out.close();
    out.close();
    assert.throws(() => out.createNoReplace('x.png', Buffer.from('x')), /already released/);
  });
}

test('names: one plain component only', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(256), 42, null]) {
    assert.throws(() => assertChildName(bad), /one plain path component/, String(bad));
  }
  if (isWin) assert.throws(() => assertChildName('a.png:stream'), /one plain path component/);
  assert.equal(assertChildName('slide1-1.png'), 'slide1-1.png');
});

/** `fs.linkSync` refusing as a filesystem without hard links does, for the duration of `fn`. */
function withoutHardLinks(fn, onAttempt = () => {}) {
  const saved = fs.linkSync;
  let calls = 0;
  fs.linkSync = (from, to) => {
    calls += 1;
    onAttempt(to);
    const e = new Error('no hard links here');
    e.code = 'EPERM';
    throw e;
  };
  try {
    return fn();
  } finally {
    fs.linkSync = saved;
    assert.ok(calls >= 1, 'the hard link was attempted first');
  }
}

test('no hard links: create-only falls back to an exclusive create, and never overwrites', (t) => {
  const dir = scratch(t);
  const out = openPinnedOutputDir(path.join(dir, 'out'), {});
  try {
    withoutHardLinks(() => {
      assert.equal(out.createNoReplace('x.png', Buffer.from('one')), 'created');
      assert.equal(out.createNoReplace('x.png', Buffer.from('two')), 'exists');
    });
  } finally {
    out.close();
  }
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'x.png'), 'utf8'), 'one');
  assert.deepEqual(leftovers(path.join(dir, 'out')), []);
});

test('no hard links: a file another writer creates at the name in the meantime is NOT overwritten (the old check-then-rename did)', (t) => {
  const dir = scratch(t);
  const out = openPinnedOutputDir(path.join(dir, 'out'), {});
  try {
    const result = withoutHardLinks(
      () => out.createNoReplace('x.png', Buffer.from('mine')),
      // The concurrent writer lands between the refused link and our create.
      (to) => fs.writeFileSync(path.join(dir, 'out', path.basename(String(to))), 'theirs'),
    );
    assert.equal(result, 'exists');
  } finally {
    out.close();
  }
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'x.png'), 'utf8'), 'theirs');
});

test('no hard links: a write that fails half-way leaves no half image under the final name', (t) => {
  const dir = scratch(t);
  const out = openPinnedOutputDir(path.join(dir, 'out'), {});
  const savedWrite = fs.writeSync;
  let armed = false;
  let calls = 0;
  fs.writeSync = function patched(fd, buf, off, len, ...rest) {
    if (!armed) return savedWrite.call(this, fd, buf, off, len, ...rest);
    calls += 1;
    if (calls === 1) return savedWrite.call(this, fd, buf, off, Math.max(1, Math.floor(len / 2)), ...rest);
    const e = new Error('disk failed');
    e.code = 'EIO';
    throw e;
  };
  try {
    withoutHardLinks(
      () => assert.throws(() => out.createNoReplace('x.png', Buffer.alloc(64, 9)), /EMPTY file may remain/),
      () => { armed = true; }, // armed once the temporary is written and the link refused
    );
  } finally {
    fs.writeSync = savedWrite;
    out.close();
  }
  assert.ok(calls >= 2, 'the partial write and the failure both happened');
  assert.equal(fs.statSync(path.join(dir, 'out', 'x.png')).size, 0, 'emptied, not half-written');
});

test('no hard links: a dangling link at the name gets no byte written through it', (t) => {
  const dir = scratch(t);
  const out = openPinnedOutputDir(path.join(dir, 'out'), {});
  const nowhere = path.join(dir, 'nowhere');
  dirLink(nowhere, path.join(dir, 'out', 'l.png'));
  let outcome;
  try {
    outcome = withoutHardLinks(() => {
      try { return out.createNoReplace('l.png', Buffer.from('three')); } catch (err) { return err; }
    });
  } finally {
    out.close();
  }
  // POSIX: O_EXCL never follows a link -> "exists". Windows: the create follows
  // it (measured), the check after the create sees the link, nothing is written.
  if (outcome instanceof Error) assert.match(outcome.message, /is a link/);
  else assert.equal(outcome, 'exists');
  assert.ok(!fs.existsSync(nowhere) || fs.statSync(nowhere).size === 0, 'no byte reached the link target');
});

/* ------------------------------------------------- races, injected on cue -- */
//
// A race cannot be won by timing in a test. These put the swap exactly where
// it hurts: `fs.openSync` is wrapped (the module calls it through the same
// `fs` object) and the swap happens just BEFORE the real open.

test('holdsSameBytes: a file swapped between lstat and open is not a match, even with identical bytes', (t) => {
  const dir = scratch(t);
  const out = openPinnedOutputDir(path.join(dir, 'out'), {});
  const bytes = Buffer.from('identical');
  fs.writeFileSync(path.join(dir, 'out', 'x.png'), bytes);
  const twin = path.join(dir, 'out', 'twin.png'); // same directory: a rename, no link, no privilege
  fs.writeFileSync(twin, bytes);
  const saved = fs.openSync;
  let swapped = 0;
  fs.openSync = function patched(p, ...rest) {
    if (!swapped && String(p).endsWith('x.png')) {
      swapped += 1;
      fs.renameSync(twin, path.join(dir, 'out', 'x.png'));
    }
    return saved.call(this, p, ...rest);
  };
  try {
    assert.equal(out.holdsSameBytes('x.png', bytes), false);
    assert.equal(swapped, 1, 'the swap was injected');
    // Control: with nothing swapped, the same bytes ARE a match.
    assert.equal(out.holdsSameBytes('x.png', bytes), true);
  } finally {
    fs.openSync = saved;
    out.close();
  }
});

/**
 * Run `swap` at the instant the pin takes hold of the EXISTING directory at
 * `existingPath`, on this platform's mechanism: on Windows just before the
 * probe directory is created in it, on Linux just before it is opened.
 */
function injectAtPin(existingPath, swap) {
  const state = { swapped: 0 };
  if (defaultPinStrategy() === 'win-probe') {
    const saved = fs.mkdirSync;
    fs.mkdirSync = function patched(p, ...rest) {
      if (!state.swapped && path.basename(String(p)).startsWith('.router-pin-') && path.dirname(String(p)) === existingPath) {
        state.swapped += 1;
        swap();
      }
      return saved.call(this, p, ...rest);
    };
    state.restore = () => { fs.mkdirSync = saved; };
  } else {
    const saved = fs.openSync;
    fs.openSync = function patched(p, ...rest) {
      if (!state.swapped && String(p) === existingPath) {
        state.swapped += 1;
        swap();
      }
      return saved.call(this, p, ...rest);
    };
    state.restore = () => { fs.openSync = saved; };
  }
  return state;
}

test('a directory swapped for a link at the moment it is pinned is refused, and nothing is left in the link target', (t) => {
  if (defaultPinStrategy() === 'unpinned') { t.skip('no pin on this platform'); return; }
  const dir = scratch(t);
  const leaf = path.join(dir, 'leaf');
  fs.mkdirSync(leaf);
  const other = path.join(dir, 'other');
  fs.mkdirSync(other);
  const inj = injectAtPin(leaf, () => { fs.renameSync(leaf, `${leaf}-moved`); dirLink(other, leaf); });
  try {
    assert.throws(() => openPinnedOutputDir(leaf, {}));
    assert.equal(inj.swapped, 1, 'the swap was injected');
  } finally {
    inj.restore();
  }
  assert.deepEqual(fs.readdirSync(other), [], 'no probe, no file left in the link target');
});

test('a PARENT swapped for a link at the moment the directory is pinned is refused, and nothing is left there', (t) => {
  // The leaf itself is not a link — O_NOFOLLOW sees nothing. What catches it
  // is the proof of where the pinned object really is.
  if (defaultPinStrategy() === 'unpinned') { t.skip('no pin on this platform'); return; }
  const dir = scratch(t);
  const parent = path.join(dir, 'parent');
  const leaf = path.join(parent, 'leaf');
  fs.mkdirSync(leaf, { recursive: true });
  const other = path.join(dir, 'other');
  fs.mkdirSync(path.join(other, 'leaf'), { recursive: true });
  const inj = injectAtPin(leaf, () => { fs.renameSync(parent, `${parent}-moved`); dirLink(other, parent); });
  try {
    assert.throws(() => openPinnedOutputDir(leaf, {}));
    assert.equal(inj.swapped, 1, 'the swap was injected');
  } finally {
    inj.restore();
  }
  assert.deepEqual(fs.readdirSync(path.join(other, 'leaf')), [], 'no probe, no file where the link points');
});

test('a PARENT swapped at the pin, with a level still to create: refused BEFORE the level is created where the link points', (t) => {
  if (defaultPinStrategy() === 'unpinned') { t.skip('no pin on this platform'); return; }
  const dir = scratch(t);
  const parent = path.join(dir, 'parent');
  const leaf = path.join(parent, 'leaf');
  fs.mkdirSync(leaf, { recursive: true });
  const other = path.join(dir, 'other');
  fs.mkdirSync(path.join(other, 'leaf'), { recursive: true });
  const seen = [];
  const inj = injectAtPin(leaf, () => { fs.renameSync(parent, `${parent}-moved`); dirLink(other, parent); });
  try {
    assert.throws(() => openPinnedOutputDir(path.join(leaf, 'new'), { authorize: (p) => seen.push(p) }));
    assert.equal(inj.swapped, 1, 'the swap was injected');
  } finally {
    inj.restore();
  }
  assert.deepEqual(fs.readdirSync(path.join(other, 'leaf')), [], 'the new level was not created where the link points');
  assert.deepEqual(seen, [], 'nothing was authorised: the proof failed first');
});

test('win32: swap, then swap BACK with a counterfeit probe in place — the handle\'s own location refuses it', (t) => {
  // Codex round P2's schedule: the probe is created and held through a
  // junction (so in the attacker's tree), then the original is put back and
  // a counterfeit probe of the same name planted in it, before the proof.
  // Any path lookup would now find the counterfeit, at the right path. The
  // question asked of the HANDLE answers where the held probe really is.
  if (defaultPinStrategy() !== 'win-probe') { t.skip('the probe is the Windows mechanism'); return; }
  const dir = scratch(t);
  const parent = path.join(dir, 'parent');
  const leaf = path.join(parent, 'leaf');
  fs.mkdirSync(leaf, { recursive: true });
  const other = path.join(dir, 'other');
  fs.mkdirSync(path.join(other, 'leaf'), { recursive: true });
  const inj = injectAtPin(leaf, () => { fs.renameSync(parent, `${parent}-moved`); dirLink(other, parent); });
  const savedOpen = fs.openSync;
  let counterfeit = null;
  fs.openSync = function patched(p, ...rest) {
    const fd = savedOpen.call(this, p, ...rest);
    if (counterfeit === null && inj.swapped && path.basename(String(p)).startsWith('.router-pin-')) {
      fs.rmdirSync(parent); // the junction
      fs.renameSync(`${parent}-moved`, parent);
      counterfeit = path.join(leaf, path.basename(String(p)));
      fs.mkdirSync(counterfeit);
    }
    return fd;
  };
  try {
    assert.throws(() => openPinnedOutputDir(leaf, {}), /probe is held at/);
    assert.equal(inj.swapped, 1, 'the swap was injected');
    assert.ok(counterfeit, 'and the counterfeit planted before the proof');
  } finally {
    inj.restore();
    fs.openSync = savedOpen;
  }
  assert.deepEqual(fs.readdirSync(path.join(other, 'leaf')), [], 'the held probe deleted itself where it was');
  fs.rmdirSync(counterfeit);
});

test('win32: in a CASE-SENSITIVE directory, `out` swapped for a junction to its sibling `OUT` is refused (no case folding)', (t) => {
  if (defaultPinStrategy() !== 'win-probe') { t.skip('the probe is the Windows mechanism'); return; }
  const dir = scratch(t);
  const cs = path.join(dir, 'cs');
  fs.mkdirSync(cs);
  const set = spawnSync('fsutil', ['file', 'setCaseSensitiveInfo', cs, 'enable'], { encoding: 'utf8' });
  if (set.status !== 0) { t.skip(`cannot enable per-directory case sensitivity here: ${(set.stdout || set.stderr).trim()}`); return; }
  const lower = path.join(cs, 'out');
  const upper = path.join(cs, 'OUT');
  fs.mkdirSync(lower);
  fs.mkdirSync(upper);
  assert.notEqual(fs.statSync(lower, { bigint: true }).ino, fs.statSync(upper, { bigint: true }).ino, 'precondition: two directories');
  const inj = injectAtPin(lower, () => { fs.renameSync(lower, `${lower}-moved`); dirLink(upper, lower); });
  try {
    assert.throws(() => openPinnedOutputDir(lower, {}), /probe is held at/);
    assert.equal(inj.swapped, 1, 'the swap was injected');
  } finally {
    inj.restore();
  }
  assert.deepEqual(fs.readdirSync(upper), [], 'nothing left in the sibling');
});

test('win32: the probe\'s volume must be NTFS — the only filesystem the pin\'s guarantees were measured on', (t) => {
  if (defaultPinStrategy() !== 'win-probe') { t.skip('the probe is the Windows mechanism'); return; }
  const dir = scratch(t);
  const real = loadWindowsNativeHelper();
  // Control: the real helper, on this (NTFS) temp volume, says NTFS and pins.
  const ok = openPinnedOutputDir(path.join(dir, 'ntfs'), {});
  ok.close();
  // The same probe, reported on another filesystem: refused, nothing created.
  const seen = [];
  const fat = { finalPath: real.finalPath, fileSystem: (fd) => { seen.push(real.fileSystem(fd)); return 'FAT32'; } };
  assert.throws(() => openPinnedOutputDir(path.join(dir, 'out'), { nativeHelper: fat }), /is on a FAT32 volume/);
  assert.deepEqual(seen, ['NTFS'], 'the real answer on this volume was NTFS');
  assert.equal(fs.existsSync(path.join(dir, 'out')), false, 'no level created');
});

test('no hard links: a failed CLOSE after a full write is not retried, and the descriptor is left alone', (t) => {
  const dir = scratch(t);
  const out = openPinnedOutputDir(path.join(dir, 'out'), {});
  const savedClose = fs.closeSync;
  const savedTrunc = fs.ftruncateSync;
  let armed = false;
  const closes = [];
  let truncs = 0;
  fs.closeSync = function patched(fd, ...rest) {
    if (!armed) return savedClose.call(this, fd, ...rest);
    closes.push(fd);
    savedClose.call(this, fd, ...rest); // really released...
    if (closes.length === 1) { const e = new Error('close reported a failure'); e.code = 'EIO'; throw e; } // ...then reported as failed
    return undefined;
  };
  fs.ftruncateSync = function patched(...args) { if (armed) truncs += 1; return savedTrunc.apply(this, args); };
  try {
    withoutHardLinks(
      () => assert.throws(() => out.createNoReplace('x.png', Buffer.from('full')), /written in full, but closing it failed/),
      () => { armed = true; },
    );
  } finally {
    fs.closeSync = savedClose;
    fs.ftruncateSync = savedTrunc;
    out.close();
  }
  assert.equal(closes.length, 1, 'closed exactly once — never retried on a descriptor number that may be reused');
  assert.equal(truncs, 0, 'nothing truncated after the close');
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'x.png'), 'utf8'), 'full');
});

test('without the Windows native helper, nothing is pinned and nothing is created', (t) => {
  // Fail closed: the proof needs the handle's own location; no helper, no write.
  const dir = scratch(t);
  assert.throws(
    () => openPinnedOutputDir(path.join(dir, 'a', 'b'), { strategy: 'win-probe', nativeHelper: null }),
    /no native helper. Refusing to write/,
  );
  assert.deepEqual(fs.readdirSync(dir), [], 'not even a probe or a level');
});

/* ------------------------------------------------------------ Windows pin -- */

test('win32: while pinned, ANOTHER process can rename neither the directory nor its parent, and can still list it; after close it can rename', (t) => {
  if (!isWin) { t.skip('the probe is the Windows mechanism'); return; }
  const dir = scratch(t);
  const parent = path.join(dir, 'parent');
  const leaf = path.join(parent, 'leaf');
  const out = openPinnedOutputDir(leaf, {});
  let closed = false;
  try {
    assert.equal(out.strategy, 'win-probe');
    assert.match(otherProcessRename(leaf, `${leaf}-moved`), /^REFUSED /);
    assert.match(otherProcessRename(parent, `${parent}-moved`), /^REFUSED /);
    const listed = spawnSync(process.execPath, ['-e', `console.log(require('fs').readdirSync(${JSON.stringify(leaf)}).length)`], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    out.close();
    closed = true;
    assert.deepEqual(leftovers(leaf), [], 'the probe deleted itself on close');
    assert.equal(otherProcessRename(leaf, `${leaf}-moved`), 'RENAMED');
  } finally {
    if (!closed) out.close();
  }
});

test('win32: while pinned, ANOTHER process can neither rename nor remove the probe — the pin cannot be dropped from outside', (t) => {
  if (!isWin) { t.skip('the probe is the Windows mechanism'); return; }
  const dir = scratch(t);
  const leaf = path.join(dir, 'leaf');
  const out = openPinnedOutputDir(leaf, {});
  try {
    const probes = leftovers(leaf);
    assert.equal(probes.length, 1, 'one probe directory while pinned');
    const probe = path.join(leaf, probes[0]);
    assert.match(otherProcessRename(probe, `${probe}-x`), /^REFUSED /);
    const removed = spawnSync(process.execPath, ['-e', `try{require('fs').rmdirSync(${JSON.stringify(probe)});console.log('REMOVED')}catch(e){console.log('REFUSED '+e.code)}`], { encoding: 'utf8' }).stdout.trim();
    assert.match(removed, /^REFUSED /);
  } finally {
    out.close();
  }
});

test('win32: a directory another program HOLDS OPEN (a working directory, a vault root) can be pinned — no exclusive access to it is needed', (t) => {
  if (!isWin) { t.skip('share modes are the Windows mechanism'); return; }
  const dir = scratch(t);
  const busy = path.join(dir, 'busy');
  fs.mkdirSync(busy);
  const holder = fs.openSync(busy, fs.constants.O_RDONLY | 0x10000000); // exclusive, like nothing else could be
  try {
    const out = openPinnedOutputDir(path.join(busy, 'assets'), {});
    try {
      assert.equal(out.createNoReplace('x.png', Buffer.from('x')), 'created');
    } finally {
      out.close();
    }
  } finally {
    fs.closeSync(holder);
  }
  assert.equal(fs.readFileSync(path.join(busy, 'assets', 'x.png'), 'utf8'), 'x');
});

test('win32: a probe another program holds for an instant is retried; one it never releases is refused', (t) => {
  if (!isWin) { t.skip('share modes are the Windows mechanism'); return; }
  const dir = scratch(t);
  const saved = fs.openSync;
  let busyLeft = 2;
  const attempts = new Map(); // probe path -> opens tried
  fs.openSync = function patched(p, ...rest) {
    if (path.basename(String(p)).startsWith('.router-pin-')) {
      attempts.set(String(p), (attempts.get(String(p)) ?? 0) + 1);
      if (busyLeft > 0) { busyLeft -= 1; const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    }
    return saved.call(this, p, ...rest);
  };
  try {
    const out = openPinnedOutputDir(path.join(dir, 'a'), {});
    out.close();
    // Two probes (the existing parent, then `a`): the first met two refusals.
    assert.deepEqual([...attempts.values()], [3, 1], 'two refusals, then the hold');
    busyLeft = Infinity;
    assert.throws(() => openPinnedOutputDir(path.join(dir, 'b'), {}), /stayed open in another program/);
  } finally {
    fs.openSync = saved;
  }
  assert.deepEqual(leftovers(path.join(dir, 'a')), []);
});

/* ---------------------------------------------------------------- /proc pin -- */

test('linux: handing the pin from level to level never closes a descriptor number twice, even when a close reports failure', (t) => {
  if (defaultPinStrategy() !== 'proc-fd') { t.skip('the /proc/self/fd pin is the Linux mechanism'); return; }
  const dir = scratch(t);
  const saved = fs.closeSync;
  const closed = [];
  fs.closeSync = function patched(fd, ...rest) {
    closed.push(fd);
    saved.call(this, fd, ...rest); // released...
    if (closed.length === 1) { const e = new Error('close reported a failure'); e.code = 'EIO'; throw e; } // ...then reported as failed
    return undefined;
  };
  let out = null;
  try {
    out = openPinnedOutputDir(path.join(dir, 'a', 'b'), {});
  } finally {
    fs.closeSync = saved;
    if (out) out.close();
  }
  assert.ok(closed.length >= 2, 'the hand-off closed the previous levels');
  assert.equal(new Set(closed).size, closed.length, `no descriptor number closed twice: ${closed.join(',')}`);
});

test('linux: a new level swapped for a link right after its mkdir is refused, and nothing is created where the link points', (t) => {
  // The final kernel-name check would refuse too — but only after the next
  // level had been created INSIDE the link target. Opening each new level
  // through its parent's descriptor, with O_NOFOLLOW, stops at the link.
  if (defaultPinStrategy() !== 'proc-fd') { t.skip('the /proc/self/fd pin is the Linux mechanism'); return; }
  const dir = scratch(t);
  const other = path.join(dir, 'other');
  fs.mkdirSync(other);
  const saved = fs.mkdirSync;
  let swapped = 0;
  fs.mkdirSync = function patched(p, ...rest) {
    const r = saved.call(this, p, ...rest);
    if (!swapped && String(p).startsWith('/proc/self/fd/') && String(p).endsWith('/a')) {
      swapped += 1;
      fs.renameSync(path.join(dir, 'a'), path.join(dir, 'a-moved'));
      fs.symlinkSync(other, path.join(dir, 'a'), 'dir');
    }
    return r;
  };
  try {
    assert.throws(() => openPinnedOutputDir(path.join(dir, 'a', 'b'), {}));
    assert.equal(swapped, 1, 'the swap was injected');
  } finally {
    fs.mkdirSync = saved;
  }
  assert.deepEqual(fs.readdirSync(other), [], 'nothing was created through the link');
});

test('linux: after the pin, swapping the directory for a link does not move the writes', (t) => {
  if (defaultPinStrategy() !== 'proc-fd') { t.skip('the /proc/self/fd pin is the Linux mechanism'); return; }
  const dir = scratch(t);
  const leaf = path.join(dir, 'leaf');
  const elsewhere = path.join(dir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const out = openPinnedOutputDir(leaf, {});
  try {
    fs.renameSync(leaf, `${leaf}-moved`);
    dirLink(elsewhere, leaf);
    assert.equal(out.createNoReplace('x.png', Buffer.from('pinned')), 'created');
    out.replace('y.png', Buffer.from('pinned too'));
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing went through the link');
    assert.equal(fs.readFileSync(path.join(`${leaf}-moved`, 'x.png'), 'utf8'), 'pinned');
    assert.equal(fs.readFileSync(path.join(`${leaf}-moved`, 'y.png'), 'utf8'), 'pinned too');
  } finally {
    out.close();
  }
});
